import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  browserCommand,
  claimOpenMarker,
  currentDirectory,
  fallbackPortMessage,
  parseCliArgs,
  resolveRoots,
  resolveToken,
  resolveWebRoot,
  USAGE,
  UsageError,
} from './cli.js';
import { DEFAULT_POLL_INTERVAL_MS, WS_PATH } from './shared/protocol.js';
import { pitwallOrigin, proofFor } from './test/proof.js';

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
    expect(USAGE).toMatch(/--interval <seconds> +How often to poll claude agents, in whole seconds\n +from 1 to 300\. Default 5\./);
  });

  it('warns in the help that reusing PITWALL_TOKEN keeps one token alive across runs', () => {
    expect(USAGE.replace(/\s+/g, ' ')).toContain('Reusing it keeps one token alive across runs');
  });

  it('rejects unknown options', () => {
    expect(() => parseCliArgs(['--host', '0.0.0.0'], {})).toThrow(UsageError);
    expect(() => parseCliArgs(['--token', 'x'], {})).toThrow(UsageError);
  });
});

describe('fallbackPortMessage', () => {
  it('says the port changes every run, and that --port keeps a pinned tab working', () => {
    expect(fallbackPortMessage(4517, 53122)).toBe(
      'pitwall: port 4517 is busy, so this run uses port 53122, which changes every time. ' +
        'A pinned pitwall tab needs the same port every run, so start pitwall with --port <n> to keep one working.',
    );
    expect(USAGE.replace(/\s+/g, ' ')).toContain('A pinned tab needs the same port every run, so give one with --port if 4517 is often busy.');
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

/** An error shaped like the one process.cwd() throws, from libuv's uv_cwd. */
function cwdError(code: string, errno: number, syscall = 'uv_cwd'): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: no such file or directory, ${syscall}`), { code, errno, syscall });
}

describe('currentDirectory', () => {
  it('returns the current directory when it exists', () => {
    expect(currentDirectory(() => '/home/someone/project')).toBe('/home/someone/project');
    expect(currentDirectory()).toBe(process.cwd());
  });

  it('returns undefined when the current directory has been deleted: ENOENT from uv_cwd', () => {
    expect(
      currentDirectory(() => {
        throw cwdError('ENOENT', -2);
      }),
    ).toBeUndefined();
  });

  it('throws any other failure as it was', () => {
    const denied = cwdError('EACCES', -13);
    expect(() =>
      currentDirectory(() => {
        throw denied;
      }),
    ).toThrow(denied);
    // ENOENT from another call isn't the current directory going away.
    const stat = cwdError('ENOENT', -2, 'stat');
    expect(() =>
      currentDirectory(() => {
        throw stat;
      }),
    ).toThrow(stat);
    expect(() =>
      currentDirectory(() => {
        throw 'not an error';
      }),
    ).toThrow('not an error');
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
  const file = '/home/someone/.pitwall/launch-4517-0123456789abcdef01234567.html';

  it('opens a file with open, xdg-open or cmd /c start', () => {
    expect(browserCommand(file, 'darwin')).toEqual(['open', [file]]);
    expect(browserCommand(file, 'linux')).toEqual(['xdg-open', [file]]);
    expect(browserCommand(file, 'win32')).toEqual(['cmd', ['/c', 'start', '', file]]);
  });
});

describe('claimOpenMarker', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('creates the marker once: the first call claims it, later calls do not', () => {
    const marker = join(tmp, 'opened');
    expect(claimOpenMarker(marker)).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(claimOpenMarker(marker)).toBe(false);
  });

  it('does not claim a marker it cannot create', () => {
    expect(claimOpenMarker(join(tmp, 'missing', 'opened'))).toBe(false);
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

/**
 * Stand-ins for `open` (macOS) and `xdg-open` (Linux), first on the CLI's PATH
 * so no test ever opens a real browser. Each call appends its argument count
 * and then each argument, one per line, to $PITWALL_TEST_OPEN_LOG.
 */
const FAKE_OPENER = `#!/bin/sh
printf '%s\\n' "$#" "$@" >> "\${PITWALL_TEST_OPEN_LOG:?}"
`;

/** Each recorded call of the fake opener, as its list of arguments. */
async function openerCalls(log: string): Promise<string[][]> {
  const lines = (await readFile(log, 'utf8').catch(() => '')).split('\n');
  const calls: string[][] = [];
  for (let i = 0; i < lines.length && lines[i] !== ''; ) {
    const count = Number(lines[i]);
    calls.push(lines.slice(i + 1, i + 1 + count));
    i += 1 + count;
  }
  return calls;
}

async function waitUntil(condition: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Holds a free port on 127.0.0.1, as a process squatting on pitwall's port would. */
async function squat(): Promise<{ port: number; close(): Promise<void> }> {
  const squatter = createNetServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'));
  squatter.listen(0, '127.0.0.1');
  await once(squatter, 'listening');
  return {
    port: (squatter.address() as AddressInfo).port,
    close: () => new Promise((resolve) => squatter.close(() => resolve())),
  };
}

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  const probe = await squat();
  await probe.close();
  return probe.port;
}

describe('pitwall (the process)', () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const token = 'pitwall-test-token-0123456789abcdefghij';
  let tmp: string;
  let bin: string;

  let n = 0;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    bin = join(tmp, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    await writeFile(join(bin, 'open'), FAKE_OPENER, { mode: 0o755 });
    await writeFile(join(bin, 'xdg-open'), FAKE_OPENER, { mode: 0o755 });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** A fresh path under the temp directory, for a PITWALL_HOME, an opener log or a marker. */
  const fresh = (name: string) => join(tmp, `${name}-${++n}`);

  /**
   * Runs the CLI with the fake claude and the fake openers first on PATH. It
   * doesn't open a browser unless the test sets PITWALL_NO_OPEN to 0, and its
   * PITWALL_HOME is always a temp directory, never the real ~/.pitwall.
   */
  function run(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      env: {
        ...process.env,
        PITWALL_NO_OPEN: '1',
        PITWALL_HOME: fresh('home'),
        PITWALL_TEST_OPEN_LOG: fresh('opened'),
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        ...env,
      },
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
  async function start(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
    const child = run(['--port', '0', ...args, tmp], { PITWALL_TOKEN: token, ...env });
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

  describe('opening the browser through a launch file', () => {
    /** Starts the CLI with opening on, and waits for the fake opener's first call. */
    async function startOpening(env: NodeJS.ProcessEnv = {}) {
      const home = fresh('home');
      const log = fresh('opened');
      const started = await start([], { PITWALL_NO_OPEN: '0', PITWALL_HOME: home, PITWALL_TEST_OPEN_LOG: log, ...env });
      await waitUntil(async () => (await openerCalls(log)).length > 0);
      return { ...started, home, log };
    }

    it('gives the opener a launch file path with no token in it, and the file sends the browser on', async () => {
      const { child, result, url, home, log, stdout } = await startOpening();
      const calls = await openerCalls(log);
      expect(calls).toHaveLength(1);
      const [args] = calls;
      expect(args).toHaveLength(1);
      const file = args![0]!;
      const port = new URL(url).port;
      expect(file).toMatch(new RegExp(`^${home}/launch-${port}-[0-9a-f]{24}\\.html$`));
      expect(file).not.toContain(token);

      // Only this user can read it, in a directory only this user can enter.
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const page = await readFile(file, 'utf8');
      expect(page).toContain(`location.replace("${url}/#token=${token}")`);
      expect(page).toContain(`<meta http-equiv="refresh" content="0; url=${url}/#token=${token}">`);
      // stdout, the user's own terminal, still has the URL.
      expect(stdout).toContain(`running at ${url}/#token=${token}`);

      child.kill('SIGTERM');
      expect((await result).code).toBe(0);
      expect(existsSync(file)).toBe(false);
    }, 30_000);

    it('deletes the launch file on SIGINT too', async () => {
      const { child, result, log } = await startOpening();
      const file = (await openerCalls(log))[0]![0]!;
      expect(existsSync(file)).toBe(true);
      child.kill('SIGINT');
      expect((await result).code).toBe(0);
      expect(existsSync(file)).toBe(false);
    }, 30_000);

    it('deletes the launch file on SIGHUP, when the terminal closes', async () => {
      const { child, result, log } = await startOpening();
      const file = (await openerCalls(log))[0]![0]!;
      expect(existsSync(file)).toBe(true);
      child.kill('SIGHUP');
      expect((await result).code).toBe(0);
      expect(existsSync(file)).toBe(false);
    }, 30_000);

    it('deletes the launch file as soon as a page authenticates, while it keeps running', async () => {
      const { child, result, log, url } = await startOpening();
      const file = (await openerCalls(log))[0]![0]!;
      expect(existsSync(file)).toBe(true);

      // What the page does once the launch file has sent it on.
      const port = Number(new URL(url).port);
      const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: pitwallOrigin(port) });
      const replies: { type: string; nonce?: string }[] = [];
      ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as { type: string; nonce?: string };
        replies.push(message);
        if (message.type === 'challenge') ws.send(JSON.stringify({ type: 'auth', proof: proofFor(token, message.nonce!, pitwallOrigin(port)) }));
      });
      await waitUntil(() => replies.some((message) => message.type === 'authenticated'));
      await waitUntil(() => !existsSync(file));
      ws.close();

      expect(child.exitCode).toBeNull();
      child.kill('SIGTERM');
      expect((await result).code).toBe(0);
    }, 30_000);

    it('deletes launch files more than 24 hours old when it starts, and keeps newer ones', async () => {
      const home = fresh('home');
      await mkdir(home, { mode: 0o700 });
      const old = join(home, 'launch-4517-aaaaaaaaaaaaaaaaaaaaaaaa.html');
      const recent = join(home, 'launch-4517-bbbbbbbbbbbbbbbbbbbbbbbb.html');
      await writeFile(old, 'old');
      await writeFile(recent, 'recent');
      const twoDaysAgo = (Date.now() - 48 * 3600_000) / 1000;
      await utimes(old, twoDaysAgo, twoDaysAgo);

      const { child, result } = await startOpening({ PITWALL_HOME: home });
      expect(existsSync(old)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      child.kill('SIGTERM');
      await result;
    }, 30_000);

    it.skipIf(process.platform === 'win32')('refuses a symlinked PITWALL_HOME: exit 1 before listening, nothing opened', async () => {
      const target = fresh('target');
      await mkdir(target, { mode: 0o700 });
      const link = fresh('link');
      await symlink(target, link);
      const log = fresh('opened');
      const result = await exited(run(['--port', '0', tmp], { PITWALL_NO_OPEN: '0', PITWALL_HOME: link, PITWALL_TEST_OPEN_LOG: log }));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`pitwall: ${link} is a symbolic link.`);
      expect(result.stdout).not.toContain('running at');
      expect(await openerCalls(log)).toEqual([]);
    }, 30_000);

    it.skipIf(process.platform === 'win32')('refuses a PITWALL_HOME with mode 0755, and leaves its mode alone', async () => {
      const home = fresh('home');
      await mkdir(home);
      await chmod(home, 0o755);
      const log = fresh('opened');
      const result = await exited(run(['--port', '0', tmp], { PITWALL_NO_OPEN: '0', PITWALL_HOME: home, PITWALL_TEST_OPEN_LOG: log }));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`pitwall: ${home} can be read or entered by other users (mode 755). Run chmod 700 ${home}`);
      expect(result.stdout).not.toContain('running at');
      expect(statSync(home).mode & 0o777).toBe(0o755);
      expect(await openerCalls(log)).toEqual([]);
    }, 30_000);

    it('leaves PITWALL_HOME alone with --no-open', async () => {
      const home = fresh('home');
      const { child, result } = await start(['--no-open'], { PITWALL_NO_OPEN: '0', PITWALL_HOME: home });
      expect(existsSync(home)).toBe(false);
      child.kill('SIGTERM');
      expect((await result).code).toBe(0);
    }, 30_000);
  });

  describe('dev readiness: PITWALL_OPEN_MARKER', () => {
    it('opens once per marker: a restart with the same marker opens nothing', async () => {
      const marker = fresh('marker');
      const log = fresh('opened');
      const home = fresh('home');
      const env = { PITWALL_NO_OPEN: '0', PITWALL_HOME: home, PITWALL_TEST_OPEN_LOG: log, PITWALL_OPEN_MARKER: marker };

      const first = await start([], env);
      await waitUntil(async () => (await openerCalls(log)).length > 0);
      expect(existsSync(marker)).toBe(true);
      first.child.kill('SIGTERM');
      expect((await first.result).code).toBe(0);

      // What tsx watch does on a change: the same command and environment, a new process.
      const second = await start([], env);
      expect((await firstSnapshot(second.url)).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 300));
      second.child.kill('SIGTERM');
      expect((await second.result).code).toBe(0);

      const calls = await openerCalls(log);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(1);
      expect(calls[0]![0]).not.toContain(token);
    }, 30_000);

    it('opens nothing when a squatter holds the port: the CLI exits 1 and leaves the marker for a real start', async () => {
      const squatter = await squat();
      try {
        const marker = fresh('marker');
        const log = fresh('opened');
        const result = await exited(
          run(['--port', String(squatter.port), tmp], {
            PITWALL_TOKEN: token,
            PITWALL_NO_OPEN: '0',
            PITWALL_TEST_OPEN_LOG: log,
            PITWALL_OPEN_MARKER: marker,
          }),
        );
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`port ${squatter.port} on 127.0.0.1 is already in use`);
        expect(existsSync(marker)).toBe(false);
        expect(await openerCalls(log)).toEqual([]);
      } finally {
        await squatter.close();
      }
    }, 30_000);
  });
});

/**
 * Stand-ins for the two watchers `npm run dev` starts, first on its PATH.
 * - `vite` waits to be stopped.
 * - `tsx` does what `tsx watch src/cli.ts ...` does on one file change: runs
 *   the real CLI, then stops it and runs it again. It logs to
 *   $PITWALL_TEST_DEV_LOG its arguments, the marker it was given, and when the
 *   restarted CLI is up.
 * Both also stop if dev.ts goes away without stopping them, so a failed test
 * leaves nothing running.
 */
const FAKE_VITE = `#!${process.execPath}
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 200);
`;

const FAKE_TSX = `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync, existsSync } = require('node:fs');
const log = (line) => appendFileSync(process.env.PITWALL_TEST_DEV_LOG, line + '\\n');
const args = process.argv.slice(2);
log('args ' + JSON.stringify(args));
log('marker ' + process.env.PITWALL_OPEN_MARKER);
const cliArgs = args.filter((arg) => arg !== 'watch' && !arg.startsWith('--clear-screen'));
let child;
function startCli() {
  child = spawn(process.execPath, ['--import', 'tsx', ...cliArgs], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('Watching')) resolve();
    });
    child.on('exit', (code) => reject(new Error('the CLI exited with ' + code + ': ' + out)));
  });
}
const stopCli = () => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.removeAllListeners('exit');
  child.once('exit', resolve);
  child.kill('SIGTERM');
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stopCli().then(() => process.exit(0)));
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) stopCli().then(() => process.exit(0)); }, 200);
(async () => {
  await startCli();
  for (let i = 0; i < 200 && !existsSync(process.env.PITWALL_OPEN_MARKER); i++) await sleep(25);
  await stopCli();
  log('restarting');
  await startCli();
  log('restarted');
})().catch((error) => {
  log('failed ' + error.message);
  process.exit(1);
});
`;

describe('npm run dev (scripts/dev.ts)', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const devScript = join(repo, 'scripts', 'dev.ts');
  let tmp: string;
  let bin: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    bin = join(tmp, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    await writeFile(join(bin, 'open'), FAKE_OPENER, { mode: 0o755 });
    await writeFile(join(bin, 'xdg-open'), FAKE_OPENER, { mode: 0o755 });
    await writeFile(join(bin, 'vite'), FAKE_VITE, { mode: 0o755 });
    await writeFile(join(bin, 'tsx'), FAKE_TSX, { mode: 0o755 });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function dev(port: number, files: { log: string; devLog: string; home: string }): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, ['--import', 'tsx', devScript, tmp], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        PITWALL_DEV_PORT: String(port),
        PITWALL_NO_OPEN: '0',
        PITWALL_HOME: files.home,
        PITWALL_TEST_OPEN_LOG: files.log,
        PITWALL_TEST_DEV_LOG: files.devLog,
      },
    });
  }

  const files = (name: string) => ({ log: join(tmp, `${name}-opened`), devLog: join(tmp, `${name}-dev.log`), home: join(tmp, `${name}-home`) });

  it('with a squatter already on the port, exits 1 and opens nothing', async () => {
    const squatter = await squat();
    try {
      const paths = files('squatted');
      const child = dev(squatter.port, paths);
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const [code] = (await once(child, 'exit')) as [number | null];
      expect(code).toBe(1);
      expect(stderr).toContain(`pitwall dev: port ${squatter.port} on 127.0.0.1 is already in use`);
      // Neither watcher started, so no CLI ran, and nothing was opened.
      expect(existsSync(paths.devLog)).toBe(false);
      expect(await openerCalls(paths.log)).toEqual([]);
    } finally {
      await squatter.close();
    }
  }, 30_000);

  it('opens the browser exactly once across a restart, through a launch file, with the token kept off the command line', async () => {
    const port = await freePort();
    const paths = files('normal');
    const child = dev(port, paths);
    const devLog = async () => readFile(paths.devLog, 'utf8').catch(() => '');
    try {
      await waitUntil(async () => /^(restarted|failed)/m.test(await devLog()), 45_000);
      expect(await devLog()).not.toMatch(/^failed/m);
      // Give the restarted CLI time to open a second tab, if it were going to.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const calls = await openerCalls(paths.log);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(1);
      expect(calls[0]![0]).toMatch(new RegExp(`^${paths.home}/launch-${port}-[0-9a-f]{24}\\.html$`));

      const log = await devLog();
      const args = JSON.parse(/^args (.*)$/m.exec(log)![1]!) as string[];
      expect(args).toEqual(['watch', '--clear-screen=false', 'src/cli.ts', '--port', String(port), tmp]);
      const marker = /^marker (.*)$/m.exec(log)![1]!;
      expect(existsSync(marker)).toBe(true);

      child.kill('SIGTERM');
      const [code] = (await once(child, 'exit')) as [number | null];
      expect(code).toBe(0);
      // The marker's private directory goes with the dev run.
      expect(existsSync(marker)).toBe(false);
    } finally {
      // On a failure, stop it the way Ctrl-C would, so it still removes its temp directory.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        await once(child, 'exit');
        clearTimeout(killer);
      }
    }
  }, 60_000);
});
