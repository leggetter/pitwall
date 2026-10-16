// The command runner, on real child processes. They're `node -e` scripts,
// never `claude`.
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { childEnvironment, MAX_OUTPUT_BYTES, runCommand } from './command.js';

const node = process.execPath;
const base = { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' }, timeoutMs: 10_000 };

describe('runCommand', () => {
  it('resolves with the exit code, stdout and stderr, even for a non-zero exit', async () => {
    const result = await runCommand(node, ['-e', 'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(3)'], base);
    expect(result).toEqual({ kind: 'exited', code: 3, stdout: 'out\n', stderr: 'err\n' });
  });

  it('passes the arguments as given, with no shell to expand them', async () => {
    const args = ['$HOME', '`id`', '; echo hi', "it's", '-- --version'];
    const result = await runCommand(node, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args], base);
    expect(result.kind === 'exited' && JSON.parse(result.stdout)).toEqual(args);
  });

  it('runs in the given directory, with exactly the given environment', async () => {
    const cwd = await realpath(tmpdir());
    const result = await runCommand(node, ['-e', 'process.stdout.write(JSON.stringify([process.cwd(), process.env.ONLY, process.env.PITWALL_TOKEN]))'], {
      ...base,
      cwd,
      env: { ONLY: 'this' },
    });
    expect(result.kind === 'exited' && JSON.parse(result.stdout)).toEqual([cwd, 'this', null]);
  });

  it('closes stdin, so a child that reads it sees the end straight away', async () => {
    const script = 'let n = 0; process.stdin.on("data", (d) => (n += d.length)); process.stdin.on("end", () => process.stdout.write("eof " + n));';
    const result = await runCommand(node, ['-e', script], { ...base, timeoutMs: 5_000 });
    expect(result).toEqual({ kind: 'exited', code: 0, stdout: 'eof 0', stderr: '' });
  });

  it('keeps only the first 64 KiB of each stream', async () => {
    const script = `process.stdout.write("x".repeat(${MAX_OUTPUT_BYTES * 2})); process.stderr.write("y".repeat(${MAX_OUTPUT_BYTES + 10}))`;
    const result = await runCommand(node, ['-e', script], base);
    expect(result.kind === 'exited' && [result.stdout.length, result.stderr.length]).toEqual([MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES]);
  });

  it("reports a program that doesn't exist", async () => {
    const result = await runCommand('pitwall-test-no-such-program', [], base);
    expect(result).toEqual({ kind: 'failed', reason: 'not-found', message: 'pitwall-test-no-such-program was not found' });
  });

  it('kills a child that runs too long, and says so', async () => {
    const started = Date.now();
    const result = await runCommand(node, ['-e', 'setTimeout(() => {}, 20000)'], { ...base, timeoutMs: 200 });
    expect(result).toEqual({ kind: 'failed', reason: 'timeout', message: "didn't finish within 200ms" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports a child killed by a signal', async () => {
    const result = await runCommand(node, ['-e', 'process.kill(process.pid, "SIGKILL")'], base);
    expect(result).toEqual({ kind: 'failed', reason: 'signal', message: 'was killed by SIGKILL' });
  });

  it("doesn't wait for a process the child left behind holding its pipes", async () => {
    // The child starts a grandchild that inherits stdout and stderr and lives
    // for 20 seconds, prints the grandchild's pid, and exits.
    const script = [
      'const { spawn } = require("node:child_process");',
      'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true });',
      'g.unref();',
      'process.stdout.write("grandchild " + g.pid + "\\n");',
    ].join(' ');
    const started = Date.now();
    const result = await runCommand(node, ['-e', script], base);
    const elapsed = Date.now() - started;
    const pid = Number(/grandchild (\d+)/.exec(result.kind === 'exited' ? result.stdout : '')?.[1]);
    try {
      expect(result).toMatchObject({ kind: 'exited', code: 0 });
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  });
});

describe('childEnvironment', () => {
  it("drops pitwall's own variables and npm's, and keeps everything else", () => {
    const env = childEnvironment({
      PATH: '/usr/bin',
      HOME: '/Users/example',
      PITWALL_TOKEN: 'secret',
      PITWALL_HOME: '/tmp/x',
      PITWALL_OPEN_MARKER: '/tmp/marker',
      pitwall_lowercase: 'x',
      npm_config_save_exact: 'true',
      npm_lifecycle_event: 'start',
      npm_package_name: '@leggetter/pitwall',
      INIT_CWD: '/Users/example/pitwall',
      ANTHROPIC_MODEL: 'kept',
      CLAUDE_CODE_MESSAGING_SOCKET: 'uds:/tmp/cc-socks/1.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'inbox-secret',
      CLAUDE_JOB_DIR: '/Users/example/.claude/jobs/abc',
      UNSET: undefined,
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/example', ANTHROPIC_MODEL: 'kept' });
  });
});
