import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ensureLaunchDir,
  LAUNCH_FILE_MAX_AGE_MS,
  LAUNCH_FILE_TTL_MS,
  LaunchDirError,
  launchPage,
  pitwallHome,
  prepareLaunchDir,
  removeStaleLaunchFiles,
  removeWhenUsed,
  writeLaunchFile,
} from './launch.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const URL_WITH_TOKEN = `http://127.0.0.1:4517/#token=${TOKEN}`;
const isWindows = process.platform === 'win32';

let tmp: string;
let n = 0;
/** A fresh path under the test's temp directory. */
const fresh = (name = 'dir') => join(tmp, `${name}-${++n}`);

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pitwall-test-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('pitwallHome', () => {
  it('is ~/.pitwall, or PITWALL_HOME resolved to an absolute path', () => {
    expect(pitwallHome({}, '/home/someone')).toBe('/home/someone/.pitwall');
    expect(pitwallHome({ PITWALL_HOME: '/elsewhere/pw' }, '/home/someone')).toBe('/elsewhere/pw');
    expect(pitwallHome({ PITWALL_HOME: '' }, '/home/someone')).toBe('/home/someone/.pitwall');
  });
});

describe.skipIf(isWindows)('ensureLaunchDir', () => {
  it('creates a missing directory with mode 0700', () => {
    const dir = fresh();
    ensureLaunchDir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('accepts an existing 0700 directory owned by this user', () => {
    const dir = fresh();
    mkdirSync(dir, { mode: 0o700 });
    expect(() => ensureLaunchDir(dir)).not.toThrow();
  });

  it('refuses a symlink, even to a private directory of ours', () => {
    const target = fresh('target');
    mkdirSync(target, { mode: 0o700 });
    const link = fresh('link');
    symlinkSync(target, link);
    expect(() => ensureLaunchDir(link)).toThrow(LaunchDirError);
    expect(() => ensureLaunchDir(link)).toThrow(/is a symbolic link/);
  });

  it.each([0o755, 0o750, 0o705, 0o701, 0o710, 0o777])('refuses a directory with mode %s, and leaves its mode alone', (mode) => {
    const dir = fresh();
    mkdirSync(dir);
    chmodSync(dir, mode);
    expect(() => ensureLaunchDir(dir)).toThrow(LaunchDirError);
    expect(() => ensureLaunchDir(dir)).toThrow(`(mode ${mode.toString(8)}). Run chmod 700 ${dir}`);
    expect(statSync(dir).mode & 0o777).toBe(mode);
  });

  it("refuses a directory owned by someone else", () => {
    const dir = fresh();
    mkdirSync(dir, { mode: 0o700 });
    const uid = statSync(dir).uid;
    expect(() => ensureLaunchDir(dir, { uid: uid + 1 })).toThrow(`belongs to another user (uid ${uid})`);
  });

  it('refuses a file where the directory should be', () => {
    const file = fresh('file');
    writeFileSync(file, '');
    expect(() => ensureLaunchDir(file)).toThrow(/is not a directory/);
  });

  it('refuses to create a missing parent', () => {
    const dir = join(fresh('missing-parent'), '.pitwall');
    expect(() => ensureLaunchDir(dir)).toThrow(LaunchDirError);
    expect(existsSync(dir)).toBe(false);
  });

  it('checks only symlinks and directories on Windows, which has no POSIX modes', () => {
    const dir = fresh();
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(() => ensureLaunchDir(dir, { platform: 'win32', uid: undefined })).not.toThrow();
    const link = fresh('link');
    symlinkSync(dir, link);
    expect(() => ensureLaunchDir(link, { platform: 'win32', uid: undefined })).toThrow(/is a symbolic link/);
  });
});

describe('launchPage', () => {
  const page = launchPage(URL_WITH_TOKEN);

  it('sends the browser on with location.replace, and with a meta refresh as the fallback', () => {
    expect(page).toContain(`<script>location.replace("${URL_WITH_TOKEN}");</script>`);
    expect(page).toContain(`<meta http-equiv="refresh" content="0; url=${URL_WITH_TOKEN}">`);
    expect(page.indexOf('location.replace')).toBeLessThan(page.indexOf('http-equiv="refresh"'));
    expect(page).toMatch(/^<!doctype html>/);
  });

  it('loads nothing: no external script, style, image or frame, and no URL but the token one', () => {
    expect(page).not.toMatch(/\bsrc=|<link|<img|<iframe|@import|url\(/i);
    const urls = page.match(/https?:\/\/[^\s"<>)]+/g) ?? [];
    expect(new Set(urls)).toEqual(new Set([URL_WITH_TOKEN]));
  });

  it.each([
    ['another host', `http://evil.example:4517/#token=${TOKEN}`],
    ['localhost', `http://localhost:4517/#token=${TOKEN}`],
    ['https', `https://127.0.0.1:4517/#token=${TOKEN}`],
    ['a path', `http://127.0.0.1:4517/x#token=${TOKEN}`],
    ['a quote in the token', `http://127.0.0.1:4517/#token=${TOKEN}"`],
    ['markup in the token', `http://127.0.0.1:4517/#token=</script><script>alert(1)`],
    ['a script URL', 'javascript:alert(1)'],
    ['no token', 'http://127.0.0.1:4517/'],
  ])('refuses %s', (_name, url) => {
    expect(() => launchPage(url)).toThrow(/not a pitwall URL/);
  });
});

describe('writeLaunchFile', () => {
  it('writes launch-<port>-<random>.html with mode 0600 and the launch page', () => {
    const dir = fresh();
    ensureLaunchDir(dir);
    const file = writeLaunchFile(dir, 4517, URL_WITH_TOKEN);
    expect(file.startsWith(`${dir}/`)).toBe(true);
    expect(file.slice(dir.length + 1)).toMatch(/^launch-4517-[0-9a-f]{24}\.html$/);
    expect(file).not.toContain(TOKEN);
    if (!isWindows) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(launchPage(URL_WITH_TOKEN));
  });

  it('gives each file its own name', () => {
    const dir = fresh();
    ensureLaunchDir(dir);
    expect(writeLaunchFile(dir, 4517, URL_WITH_TOKEN)).not.toBe(writeLaunchFile(dir, 4517, URL_WITH_TOKEN));
  });

  it('refuses to write over an existing file (O_EXCL), and leaves it as it was', () => {
    const dir = fresh();
    ensureLaunchDir(dir);
    const existing = join(dir, 'launch-4517-fixed.html');
    writeFileSync(existing, 'already here');
    expect(() => writeLaunchFile(dir, 4517, URL_WITH_TOKEN, () => 'fixed')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(readFileSync(existing, 'utf8')).toBe('already here');
  });

  it.skipIf(isWindows)('refuses to write through a planted symlink, so the token never reaches its target', () => {
    const dir = fresh();
    ensureLaunchDir(dir);
    const target = fresh('readable-by-others');
    symlinkSync(target, join(dir, 'launch-4517-fixed.html'));
    expect(() => writeLaunchFile(dir, 4517, URL_WITH_TOKEN, () => 'fixed')).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it('writes nothing for a URL that is not a pitwall URL', () => {
    const dir = fresh();
    ensureLaunchDir(dir);
    expect(() => writeLaunchFile(dir, 4517, 'javascript:alert(1)', () => 'fixed')).toThrow(/not a pitwall URL/);
    expect(existsSync(join(dir, 'launch-4517-fixed.html'))).toBe(false);
  });
});

describe('removeStaleLaunchFiles', () => {
  it('deletes launch files older than 24 hours, and nothing else', () => {
    const dir = fresh();
    ensureLaunchDir(dir);
    const now = Date.now();
    const age = (name: string, ms: number) => {
      const path = join(dir, name);
      writeFileSync(path, 'x');
      const when = (now - ms) / 1000;
      utimesSync(path, when, when);
      return path;
    };
    const old = age('launch-4517-aaaa.html', LAUNCH_FILE_MAX_AGE_MS + 60_000);
    const older = age('launch-1-bbbb.html', 7 * LAUNCH_FILE_MAX_AGE_MS);
    const recent = age('launch-4517-cccc.html', LAUNCH_FILE_MAX_AGE_MS - 60_000);
    const otherName = age('notes.html', 7 * LAUNCH_FILE_MAX_AGE_MS);
    const otherExt = age('launch-4517-dddd.txt', 7 * LAUNCH_FILE_MAX_AGE_MS);
    mkdirSync(join(dir, 'launch-dir.html'));

    expect(removeStaleLaunchFiles(dir, now).sort()).toEqual(['launch-1-bbbb.html', 'launch-4517-aaaa.html']);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(older)).toBe(false);
    for (const kept of [recent, otherName, otherExt, join(dir, 'launch-dir.html')]) expect(existsSync(kept)).toBe(true);
  });

  it('returns nothing for a directory it cannot read', () => {
    expect(removeStaleLaunchFiles(fresh('missing'))).toEqual([]);
  });

  it('runs as part of prepareLaunchDir', () => {
    const dir = fresh();
    ensureLaunchDir(dir);
    const path = join(dir, 'launch-4517-eeee.html');
    writeFileSync(path, 'x');
    const when = (Date.now() - 2 * LAUNCH_FILE_MAX_AGE_MS) / 1000;
    utimesSync(path, when, when);
    prepareLaunchDir(dir);
    expect(existsSync(path)).toBe(false);
  });
});

describe('removeOnExit', () => {
  const launch = fileURLToPath(new URL('./launch.ts', import.meta.url));

  /**
   * Runs a Node process that writes a launch file, registers removeOnExit,
   * prints the path and then ends the way `how` says. Resolves with the path
   * once the process has gone.
   */
  async function endsBy(how: 'return' | 'exit' | 'sigterm' | 'sigint' | 'sighup' | 'throw'): Promise<string> {
    const dir = fresh();
    mkdirSync(dir, { mode: 0o700 });
    const script = `
      import { removeOnExit, writeLaunchFile } from ${JSON.stringify(launch)};
      const file = writeLaunchFile(${JSON.stringify(dir)}, 4517, ${JSON.stringify(URL_WITH_TOKEN)});
      removeOnExit(file);
      const how = ${JSON.stringify(how)};
      // As the CLI does: a signal handler that calls process.exit().
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
      console.log(file);
      if (how === 'exit') process.exit(3);
      if (how === 'throw') setTimeout(() => { throw new Error('boom'); }, 10);
      if (how.startsWith('sig')) setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const file = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes('\n')) resolve(out.trim());
      });
      child.on('exit', () => reject(new Error(`exited before printing: ${out}`)));
    });
    // Printed after the write, so it existed. A process waiting for a signal still has it.
    if (how === 'sigterm' || how === 'sigint' || how === 'sighup') {
      expect(existsSync(file)).toBe(true);
      child.kill(how.toUpperCase() as NodeJS.Signals);
    }
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    return file;
  }

  it.each(['return', 'exit', 'sigterm', 'sigint', 'sighup', 'throw'] as const)('deletes the file when the process ends by %s', async (how) => {
    const file = await endsBy(how);
    expect(lstatSync(file, { throwIfNoEntry: false })).toBeUndefined();
  }, 20_000);
});

describe('removeWhenUsed', () => {
  function launchFile(): string {
    const dir = fresh();
    mkdirSync(dir, { mode: 0o700 });
    return writeLaunchFile(dir, 4517, URL_WITH_TOKEN);
  }

  it('keeps the file for 60 seconds by default', () => {
    expect(LAUNCH_FILE_TTL_MS).toBe(60_000);
  });

  it('deletes the file when it has been used, and drops the timer and the exit hook', () => {
    vi.useFakeTimers();
    try {
      const file = launchFile();
      const exitHooks = process.listenerCount('exit');
      const used = removeWhenUsed(file, 60_000);
      expect(process.listenerCount('exit')).toBe(exitHooks + 1);
      expect(existsSync(file)).toBe(true);
      used();
      expect(existsSync(file)).toBe(false);
      expect(process.listenerCount('exit')).toBe(exitHooks);
      expect(vi.getTimerCount()).toBe(0);
      // Using it again does nothing.
      used();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes the file once the time is up, if nothing used it first', () => {
    vi.useFakeTimers();
    try {
      const file = launchFile();
      const exitHooks = process.listenerCount('exit');
      removeWhenUsed(file, 60_000);
      vi.advanceTimersByTime(59_999);
      expect(existsSync(file)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(existsSync(file)).toBe(false);
      expect(process.listenerCount('exit')).toBe(exitHooks);
    } finally {
      vi.useRealTimers();
    }
  });
});
