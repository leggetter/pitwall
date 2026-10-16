import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserCommand, parseCliArgs, resolveRoots, resolveToken, resolveWebRoot, UsageError } from './cli.js';

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

describe('pitwall (the process)', () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function run(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      env: { ...process.env, PITWALL_NO_OPEN: '1', ...env },
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
  });

  it('starts, prints the URL with the token and the roots, serves, and exits 0 on SIGTERM', async () => {
    const token = 'pitwall-test-token-0123456789abcdefghij';
    const child = run(['--port', '0', tmp], { PITWALL_TOKEN: token });
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
    expect(printedToken).toBe(token);
    expect(stdout).toContain(`Watching root: ${tmp}`);

    const snapshotUrl = `${url}/api/snapshot`;
    expect((await fetch(snapshotUrl)).status).toBe(401);
    let res = await fetch(snapshotUrl, { headers: { authorization: `Bearer ${token}` } });
    // The W1 stub indexer emits its empty snapshot on the next tick.
    for (let i = 0; res.status === 503 && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 25));
      res = await fetch(snapshotUrl, { headers: { authorization: `Bearer ${token}` } });
    }
    expect(res.status).toBe(200);

    child.kill('SIGTERM');
    expect((await result).code).toBe(0);
  });
});
