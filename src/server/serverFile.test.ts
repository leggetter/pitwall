import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { claimServerFile, isAlive, isPid, isServerUrl, readServerFile, SERVER_FILE_MAX_BYTES, SERVER_FILE_NAME } from './serverFile.js';

const posix = process.platform !== 'win32';
let tmp: string;
let n = 0;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-serverfile-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A fresh 0700 home. */
function home(): string {
  const dir = path.join(tmp, `home-${++n}`);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
const fileOf = (dir: string) => path.join(dir, SERVER_FILE_NAME);
const body = (dir: string) => JSON.parse(readFileSync(fileOf(dir), 'utf8')) as unknown;
const URL_A = 'http://127.0.0.1:4601';
const URL_B = 'http://127.0.0.1:4602';
const live = new Set([101, 102, 103]);
const alive = (pid: number) => live.has(pid);

describe('isServerUrl and isPid', () => {
  it('takes only http://127.0.0.1:<port>, and a pid kill(pid, 0) can be asked about', () => {
    expect(isServerUrl('http://127.0.0.1:4517')).toBe(true);
    for (const url of ['http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://localhost:4517', 'http://127.0.0.1:4517/', 'https://127.0.0.1:4517', 'http://127.0.0.1:04517', 'http://evil.example:4517', 'http://127.0.0.1:4517\n', 4517]) {
      expect(isServerUrl(url)).toBe(false);
    }
    expect(isPid(1234)).toBe(true);
    for (const pid of [0, 1, -1, 1.5, 2 ** 31, '1234', Number.NaN]) expect(isPid(pid)).toBe(false);
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(0)).toBe(false);
  });
});

describe('claimServerFile', () => {
  it('writes the URL and the pid only, 0600, and deletes the file on close', () => {
    const dir = home();
    const handle = claimServerFile({ home: dir, url: URL_A, dev: false, pid: 101, alive, reclaimMs: 0 });
    expect(body(dir)).toEqual({ v: 1, url: URL_A, pid: 101 });
    if (posix) expect(statSync(fileOf(dir)).mode & 0o777).toBe(0o600);
    handle.close();
    expect(existsSync(fileOf(dir))).toBe(false);
    handle.close();
  });

  it('marks a dev run, which never replaces a live CLI run’s file, but does a dead one’s', () => {
    const dir = home();
    const cli = claimServerFile({ home: dir, url: URL_A, dev: false, pid: 101, alive, reclaimMs: 0 });
    const dev = claimServerFile({ home: dir, url: URL_B, dev: true, pid: 102, alive, reclaimMs: 0 });
    expect(body(dir)).toEqual({ v: 1, url: URL_A, pid: 101 });
    dev.close();
    expect(body(dir)).toEqual({ v: 1, url: URL_A, pid: 101 });
    cli.close();

    writeFileSync(fileOf(dir), JSON.stringify({ v: 1, url: URL_A, pid: 999 }), { mode: 0o600 });
    claimServerFile({ home: dir, url: URL_B, dev: true, pid: 102, alive, reclaimMs: 0 });
    expect(body(dir)).toEqual({ v: 1, url: URL_B, pid: 102, dev: true });
  });

  it('a CLI run replaces a dev run’s file, and another CLI run’s', () => {
    const dir = home();
    claimServerFile({ home: dir, url: URL_B, dev: true, pid: 102, alive, reclaimMs: 0 });
    claimServerFile({ home: dir, url: URL_A, dev: false, pid: 101, alive, reclaimMs: 0 });
    expect(body(dir)).toEqual({ v: 1, url: URL_A, pid: 101 });
    claimServerFile({ home: dir, url: URL_B, dev: false, pid: 103, alive, reclaimMs: 0 });
    expect(body(dir)).toEqual({ v: 1, url: URL_B, pid: 103 });
  });

  it('two pitwalls on one home: the one still running keeps the file, or takes it back after the other’s close', () => {
    vi.useFakeTimers();
    const dir = home();
    const first = claimServerFile({ home: dir, url: URL_A, dev: false, pid: 101, alive, reclaimMs: 1000 });
    const second = claimServerFile({ home: dir, url: URL_B, dev: false, pid: 102, alive, reclaimMs: 1000 });
    expect(body(dir)).toEqual({ v: 1, url: URL_B, pid: 102 });
    // Neither takes the file from the other while both run.
    vi.advanceTimersByTime(5000);
    expect(body(dir)).toEqual({ v: 1, url: URL_B, pid: 102 });
    // The second closes: its file goes, and the first writes its own at its next look.
    second.close();
    expect(existsSync(fileOf(dir))).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(body(dir)).toEqual({ v: 1, url: URL_A, pid: 101 });
    first.close();
    expect(existsSync(fileOf(dir))).toBe(false);
  });

  it('writes its own file again at each look, so its mtime stays fresh for the hook (F1)', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const dir = home();
    const handle = claimServerFile({ home: dir, url: URL_A, dev: false, pid: 101, alive, reclaimMs: 1000 });
    const old = new Date(Date.now() - 600_000);
    utimesSync(fileOf(dir), old, old);
    vi.advanceTimersByTime(1000);
    expect(statSync(fileOf(dir)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    expect(body(dir)).toEqual({ v: 1, url: URL_A, pid: 101 });
    handle.close();
  });

  it('takes the file back from a crashed pitwall, and from a file it can’t read', () => {
    vi.useFakeTimers();
    const dir = home();
    const handle = claimServerFile({ home: dir, url: URL_A, dev: true, pid: 101, alive, reclaimMs: 1000 });
    writeFileSync(fileOf(dir), JSON.stringify({ v: 1, url: URL_B, pid: 999 }), { mode: 0o600 });
    vi.advanceTimersByTime(1000);
    expect(body(dir)).toEqual({ v: 1, url: URL_A, pid: 101, dev: true });
    writeFileSync(fileOf(dir), 'not json', { mode: 0o600 });
    vi.advanceTimersByTime(1000);
    expect(body(dir)).toEqual({ v: 1, url: URL_A, pid: 101, dev: true });
    handle.close();
  });

  it('leaves another run’s file on close', () => {
    const dir = home();
    const handle = claimServerFile({ home: dir, url: URL_A, dev: false, pid: 101, alive, reclaimMs: 0 });
    writeFileSync(fileOf(dir), JSON.stringify({ v: 1, url: URL_A, pid: 102 }), { mode: 0o600 });
    handle.close();
    expect(body(dir)).toEqual({ v: 1, url: URL_A, pid: 102 });
  });

  it.skipIf(!posix)('writes nothing, and doesn’t throw, in a home others can enter or through a link', () => {
    const open = path.join(tmp, `open-${++n}`);
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    claimServerFile({ home: open, url: URL_A, dev: false, pid: 101, alive, reclaimMs: 0 }).close();
    expect(existsSync(fileOf(open))).toBe(false);
    expect(statSync(open).mode & 0o777).toBe(0o755);

    const link = path.join(tmp, `link-${++n}`);
    symlinkSync(home(), link);
    claimServerFile({ home: link, url: URL_A, dev: false, pid: 101, alive, reclaimMs: 0 });
    expect(existsSync(fileOf(link))).toBe(false);
  });

  it('writes nothing for a URL that isn’t pitwall’s address', () => {
    const dir = home();
    claimServerFile({ home: dir, url: 'http://localhost:4601', dev: false, pid: 101, alive, reclaimMs: 0 });
    expect(existsSync(fileOf(dir))).toBe(false);
  });
});

describe('readServerFile', () => {
  const write = (text: string, mode = 0o600) => {
    const dir = home();
    writeFileSync(fileOf(dir), text, { mode });
    chmodSync(fileOf(dir), mode);
    return fileOf(dir);
  };

  it('reads a good file, and drops fields it doesn’t know', () => {
    expect(readServerFile(write(JSON.stringify({ v: 1, url: URL_A, pid: 4242, token: 'x' })))).toEqual({ v: 1, url: URL_A, pid: 4242 });
  });

  it('reads nothing from a missing, malformed, huge or wrongly shaped file', () => {
    expect(readServerFile(path.join(home(), SERVER_FILE_NAME))).toBeUndefined();
    expect(readServerFile(write('{'))).toBeUndefined();
    expect(readServerFile(write('[]'))).toBeUndefined();
    expect(readServerFile(write('null'))).toBeUndefined();
    expect(readServerFile(write(JSON.stringify({ v: 1, url: URL_A, pid: 4242, pad: 'x'.repeat(SERVER_FILE_MAX_BYTES) })))).toBeUndefined();
    expect(readServerFile(write(JSON.stringify({ v: 1, url: 'http://evil.example:80', pid: 4242 })))).toBeUndefined();
    expect(readServerFile(write(JSON.stringify({ v: 1, url: URL_A, pid: -1 })))).toBeUndefined();
    expect(readServerFile(write(JSON.stringify({ v: 1, url: URL_A })))).toBeUndefined();
  });

  it.skipIf(!posix)('reads nothing through a link, from a FIFO, or from a file others can write', () => {
    const target = write(JSON.stringify({ v: 1, url: URL_A, pid: 4242 }));
    const dir = home();
    symlinkSync(target, fileOf(dir));
    expect(readServerFile(fileOf(dir))).toBeUndefined();

    const fifoHome = home();
    execFileSync('mkfifo', [fileOf(fifoHome)]);
    expect(readServerFile(fileOf(fifoHome))).toBeUndefined();

    expect(readServerFile(write(JSON.stringify({ v: 1, url: URL_A, pid: 4242 }), 0o620))).toBeUndefined();
    expect(readServerFile(write(JSON.stringify({ v: 1, url: URL_A, pid: 4242 }), 0o602))).toBeUndefined();
  });
});
