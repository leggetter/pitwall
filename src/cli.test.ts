import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserCommand, parseCliArgs, resolveRoots, resolveToken, resolveWebRoot, USAGE, UsageError } from './cli.js';
import { DEFAULT_POLL_INTERVAL_MS } from './shared/protocol.js';

describe('parseCliArgs', () => {
  it('defaults to no roots, the default port and opening the browser', () => {
    expect(parseCliArgs([], {})).toEqual({ kind: 'run', roots: [], open: true });
  });

  it('takes several roots, --port and --no-open in any order', () => {
    expect(parseCliArgs(['a', '--port', '5000', 'b', '--no-open'], {})).toEqual({
      kind: 'run',
      roots: ['a', 'b'],
      port: 5000,
      open: false,
    });
    expect(parseCliArgs(['--port=0', 'a'], {})).toEqual({ kind: 'run', roots: ['a'], port: 0, open: true });
  });

  it('treats everything after -- as a root', () => {
    expect(parseCliArgs(['--', '--port'], {})).toEqual({ kind: 'run', roots: ['--port'], open: true });
  });

  it('skips the browser when PITWALL_NO_OPEN=1', () => {
    expect(parseCliArgs([], { PITWALL_NO_OPEN: '1' })).toMatchObject({ open: false });
    expect(parseCliArgs([], { PITWALL_NO_OPEN: '0' })).toMatchObject({ open: true });
  });

  it('recognises --help, -h, --version and -v', () => {
    expect(parseCliArgs(['--help'], {})).toEqual({ kind: 'help' });
    expect(parseCliArgs(['-h', 'root'], {})).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--version'], {})).toEqual({ kind: 'version' });
    expect(parseCliArgs(['-v'], {})).toEqual({ kind: 'version' });
  });

  it.each([['-1'], ['65536'], ['abc'], ['4517.5'], [''], ['0x10'], ['1e3']])('rejects --port %j', (port) => {
    expect(() => parseCliArgs(['--port', port], {})).toThrow(UsageError);
  });

  it('rejects --port without a value', () => {
    expect(() => parseCliArgs(['--port'], {})).toThrow(UsageError);
  });

  it('takes --interval in whole seconds from 1 to 300, as milliseconds', () => {
    expect(parseCliArgs(['--interval', '2', 'a'], {})).toEqual({ kind: 'run', roots: ['a'], intervalMs: 2000, open: true });
    expect(parseCliArgs(['--interval=1'], {})).toMatchObject({ intervalMs: 1000 });
    expect(parseCliArgs(['--interval', '300'], {})).toMatchObject({ intervalMs: 300_000 });
    expect(parseCliArgs(['--interval', '010'], {})).toMatchObject({ intervalMs: 10_000 });
  });

  it('leaves the interval to the indexer default, 5 seconds, without --interval', () => {
    expect(parseCliArgs(['a'], {})).not.toHaveProperty('intervalMs');
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5000);
  });

  it.each([['0'], ['301'], ['-1'], ['2.5'], ['abc'], [''], ['1e2'], ['0x10'], [' 5'], ['5s'], ['0005']])(
    'rejects --interval %j with a clear message',
    (interval) => {
      expect(() => parseCliArgs(['--interval', interval], {})).toThrow(UsageError);
      if (!interval.startsWith('-')) {
        expect(() => parseCliArgs(['--interval', interval], {})).toThrow(
          `--interval must be a whole number of seconds from 1 to 300, not "${interval}"`,
        );
      }
    },
  );

  it('rejects --interval without a value', () => {
    expect(() => parseCliArgs(['--interval'], {})).toThrow(UsageError);
  });

  it('mentions --interval and its default in the help', () => {
    expect(USAGE).toContain('[--interval <seconds>]');
    expect(USAGE).toMatch(/--interval <seconds> +How often to poll claude agents --json, in whole seconds\n +from 1 to 300\. Default 5\./);
  });

  it('rejects unknown options', () => {
    expect(() => parseCliArgs(['--host', '0.0.0.0'], {})).toThrow(UsageError);
    expect(() => parseCliArgs(['--token', 'x'], {})).toThrow(UsageError);
  });
});

describe('resolveRoots', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    await mkdir(join(tmp, 'a'));
    await mkdir(join(tmp, 'b'));
    await writeFile(join(tmp, 'file'), '');
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('defaults to the current directory', () => {
    expect(resolveRoots([], tmp)).toEqual([tmp]);
  });

  it('resolves relative and absolute roots to absolute paths', () => {
    expect(resolveRoots(['a', join(tmp, 'b'), './a/../b'], tmp)).toEqual([join(tmp, 'a'), join(tmp, 'b'), join(tmp, 'b')]);
  });

  it('fails clearly for a root that does not exist', () => {
    expect(() => resolveRoots(['a', 'missing'], tmp)).toThrow(new UsageError(`root does not exist: ${join(tmp, 'missing')}`));
  });

  it('fails clearly for a root that is a file', () => {
    expect(() => resolveRoots(['file'], tmp)).toThrow(new UsageError(`root is not a directory: ${join(tmp, 'file')}`));
  });
});

describe('resolveToken', () => {
  it('generates 32 random bytes as base64url', () => {
    const a = resolveToken({});
    const b = resolveToken({});
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it('uses PITWALL_TOKEN when it is set and valid', () => {
    const token = 'pitwall-test-token-0123456789abcd';
    expect(resolveToken({ PITWALL_TOKEN: token })).toBe(token);
  });

  it('rejects a PITWALL_TOKEN shorter than 32 characters, including empty', () => {
    expect(() => resolveToken({ PITWALL_TOKEN: 'a'.repeat(31) })).toThrow(/at least 32 characters/);
    expect(() => resolveToken({ PITWALL_TOKEN: '' })).toThrow(/at least 32 characters/);
  });

  it('rejects a PITWALL_TOKEN with characters outside base64url', () => {
    expect(() => resolveToken({ PITWALL_TOKEN: `${'a'.repeat(32)}&calc` })).toThrow(UsageError);
    expect(() => resolveToken({ PITWALL_TOKEN: `${'a'.repeat(32)}\r\nX: y` })).toThrow(UsageError);
  });
});

describe('resolveWebRoot', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    await mkdir(join(tmp, 'dist', 'web'), { recursive: true });
    await mkdir(join(tmp, 'src'));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('uses web/ next to the built cli.js', () => {
    expect(resolveWebRoot(join(tmp, 'dist', 'cli.js'))).toBe(join(tmp, 'dist', 'web'));
  });

  it('falls back to <repo>/dist/web for src/cli.ts', () => {
    expect(resolveWebRoot(join(tmp, 'src', 'cli.ts'))).toBe(join(tmp, 'dist', 'web'));
  });
});

describe('browserCommand', () => {
  const url = 'http://127.0.0.1:4517/#token=abc';

  it('uses open, xdg-open or cmd /c start', () => {
    expect(browserCommand(url, 'darwin')).toEqual(['open', [url]]);
    expect(browserCommand(url, 'linux')).toEqual(['xdg-open', [url]]);
    expect(browserCommand(url, 'win32')).toEqual(['cmd', ['/c', 'start', '', url]]);
  });
});

/**
 * A stand-in for `claude`, put first on the CLI's PATH so the real indexer
 * never runs the real one. It prints an empty session list and records, next
 * to itself, whether PITWALL_TOKEN reached it, and one line per call.
 */
const FAKE_CLAUDE = `#!/bin/sh
if [ -n "\${PITWALL_TOKEN+set}" ]; then echo set; else echo unset; fi > "$(dirname "$0")/token-seen"
echo call >> "$(dirname "$0")/calls"
echo '[]'
`;

describe('pitwall (the process)', () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const token = 'pitwall-test-token-0123456789abcdefghij';
  let tmp: string;
  let bin: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    bin = join(tmp, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function run(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      env: { ...process.env, PITWALL_NO_OPEN: '1', PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, ...env },
    });
  }

  async function exited(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const [code] = (await once(child, 'exit')) as [number | null];
    return { code, stdout, stderr };
  }

  /** Starts the CLI on a free port and waits for it to print its URL and roots. */
  async function start(args: string[] = []) {
    const child = run(['--port', '0', ...args, tmp], { PITWALL_TOKEN: token });
    const result = exited(child);
    let stdout = '';
    const [, url, printedToken] = await new Promise<RegExpExecArray>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = /running at (http:\/\/127\.0\.0\.1:\d+)\/#token=(\S+)/.exec(stdout);
        if (match && stdout.includes('Watching')) resolve(match);
      });
      child.on('exit', () => reject(new Error(`exited early: ${stdout}`)));
    });
    return { child, result, stdout, url: url as string, printedToken };
  }

  /**
   * The snapshot, once the first poll has finished. Until then the server
   * answers 503. Polls until it's ready, so the test doesn't depend on how
   * quickly the fake claude and the indexer run on a loaded machine.
   */
  async function firstSnapshot(url: string): Promise<Response> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const res = await fetch(`${url}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status !== 503 || Date.now() > deadline) return res;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('exits 1 with a clear message for a root that does not exist', async () => {
    const missing = join(tmp, 'missing');
    const result = await exited(run([missing]));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`pitwall: root does not exist: ${missing}`);
  });

  it('exits 1 for a short PITWALL_TOKEN', async () => {
    const result = await exited(run([tmp], { PITWALL_TOKEN: 'short' }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PITWALL_TOKEN must be at least 32 characters');
  });

  it('prints the usage for --help', async () => {
    const result = await exited(run(['--help']));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: pitwall [root...]');
    expect(result.stdout).toContain('--interval <seconds>');
  });

  it('exits 1 with a clear message for an --interval out of range', async () => {
    const result = await exited(run(['--interval', '0', tmp]));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('pitwall: --interval must be a whole number of seconds from 1 to 300, not "0"');
  });

  it('starts, prints the URL with the token and the roots, serves, and exits 0 on SIGTERM', async () => {
    const { child, result, stdout, url, printedToken } = await start();
    expect(printedToken).toBe(token);
    expect(stdout).toContain(`Watching root: ${tmp}`);

    expect((await fetch(`${url}/api/snapshot`)).status).toBe(401);
    const res = await firstSnapshot(url);
    expect(res.status).toBe(200);
    // The fake claude's empty list, not whatever the real one would report.
    expect(await res.json()).toMatchObject({ groups: [], source: { ok: true } });

    child.kill('SIGTERM');
    expect((await result).code).toBe(0);
  }, 30_000);

  it('polls every 5 seconds by default, and says so', async () => {
    const { child, result, stdout } = await start();
    expect(stdout).toContain(`Watching root: ${tmp}, polling every 5s`);
    child.kill('SIGTERM');
    expect((await result).code).toBe(0);
  }, 30_000);

  it('passes --interval to the indexer, which polls that often', async () => {
    const calls = join(bin, 'calls');
    await rm(calls, { force: true });
    const { child, result, stdout, url } = await start(['--interval', '1']);
    expect(stdout).toContain('polling every 1s');
    expect((await firstSnapshot(url)).status).toBe(200);
    // Three polls take about 2 s at 1 s apart. At the 5 s default they would take 10 s.
    const started = Date.now();
    const count = async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    while ((await count()) < 3 && Date.now() - started < 6_000) await new Promise((r) => setTimeout(r, 100));
    expect(await count()).toBeGreaterThanOrEqual(3);
    expect(Date.now() - started).toBeLessThan(6_000);

    child.kill('SIGTERM');
    expect((await result).code).toBe(0);
  }, 30_000);

  it('removes PITWALL_TOKEN from its environment before it runs claude', async () => {
    await rm(join(bin, 'token-seen'), { force: true });
    const { child, result, url } = await start();
    expect((await firstSnapshot(url)).status).toBe(200);
    // The first poll has run the fake claude, which wrote down what it saw.
    expect((await readFile(join(bin, 'token-seen'), 'utf8')).trim()).toBe('unset');

    child.kill('SIGTERM');
    expect((await result).code).toBe(0);
  }, 30_000);
});
