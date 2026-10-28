// The command runner, on real child processes. They're `node -e` scripts,
// never `claude`.
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { childEnvironment, MAX_OUTPUT_BYTES, runCommand } from './command.js';
import { allowSignalsTo } from '../test/noClaude.js';

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
          // The child's own child, which noClaude.ts never saw started.
          allowSignalsTo(pid);
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  });
});

describe('childEnvironment', () => {
  const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
  const KEPT_BASE = { PATH: '/usr/bin', HOME: '/Users/example' };

  /** Every variable dropped by prefix, with a few spellings each. */
  const BY_PREFIX = {
    PITWALL_TOKEN: 'secret',
    PITWALL_HOME: '/tmp/x',
    PITWALL_OPEN_MARKER: '/tmp/marker',
    PITWALL_ANYTHING_LATER: '1',
    pitwall_lowercase: 'x',
    npm_config_save_exact: 'true',
    npm_lifecycle_event: 'start',
    npm_package_name: '@leggetter/pitwall',
    NPM_CONFIG_UPPER: 'x',
    CLAUDE_CODE_MESSAGING_SOCKET: 'uds:/tmp/cc-socks/1.sock',
    CLAUDE_CODE_MESSAGING_TOKEN: 'inbox-secret',
  };

  /** Every variable dropped by exact name: npm's INIT_CWD, and the identity of the session pitwall runs inside. */
  const BY_NAME = {
    INIT_CWD: '/Users/example/pitwall',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: '99999999-9999-4999-8999-999999999999',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_PID: '4242',
    CLAUDE_EFFORT: 'xhigh',
    AI_AGENT: 'claude-code',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_EXECPATH: '/Users/example/.local/share/claude/versions/2.1.303',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge-1',
    CLAUDE_JOB_DIR: '/Users/example/.claude/jobs/abc',
    TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    TRACESTATE: 'vendor=value',
  };

  /** The user's own configuration, which every child keeps. */
  const USER_CONFIG = {
    ANTHROPIC_MODEL: 'claude-haiku',
    ANTHROPIC_BASE_URL: 'https://gateway.example',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CONFIG_DIR: '/Users/example/.claude-work',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
    CLAUDE_CODE_SAFE_MODE: '1',
  };

  it('drops every variable with a dropped prefix, in any case', () => {
    for (const [name, value] of Object.entries(BY_PREFIX)) {
      expect(childEnvironment({ ...KEPT_BASE, [name]: value }), name).toEqual(KEPT_BASE);
    }
  });

  it('drops each dropped name, exactly, in any case', () => {
    for (const [name, value] of Object.entries(BY_NAME)) {
      expect(childEnvironment({ ...KEPT_BASE, [name]: value }), name).toEqual(KEPT_BASE);
      expect(childEnvironment({ ...KEPT_BASE, [name.toLowerCase()]: value }), name.toLowerCase()).toEqual(KEPT_BASE);
    }
  });

  it('drops only the exact names, not others that start the same way', () => {
    const lookalikes = Object.fromEntries(Object.keys(BY_NAME).map((name) => [`${name}_OTHER`, 'kept']));
    expect(childEnvironment({ ...KEPT_BASE, ...lookalikes })).toEqual({ ...KEPT_BASE, ...lookalikes });
  });

  it("keeps the user's own configuration, CLAUDE_CODE_SAFE_MODE included", () => {
    expect(childEnvironment({ ...KEPT_BASE, ...USER_CONFIG, ...BY_PREFIX, ...BY_NAME }, TOKEN)).toEqual({ ...KEPT_BASE, ...USER_CONFIG });
  });

  it('drops any variable whose value contains the token, whatever its name', () => {
    const env = {
      ...KEPT_BASE,
      COPIED: TOKEN,
      HEADER: `Bearer ${TOKEN}`,
      ANTHROPIC_CUSTOM_HEADERS: `x-pitwall: ${TOKEN}`,
      ALMOST: TOKEN.slice(1),
    };
    expect(childEnvironment(env, TOKEN)).toEqual({ ...KEPT_BASE, ALMOST: TOKEN.slice(1) });
  });

  it('has no token check without a token, and an empty token matches nothing', () => {
    expect(childEnvironment({ ...KEPT_BASE, COPIED: TOKEN })).toEqual({ ...KEPT_BASE, COPIED: TOKEN });
    expect(childEnvironment({ ...KEPT_BASE, COPIED: TOKEN }, '')).toEqual({ ...KEPT_BASE, COPIED: TOKEN });
  });

  it('drops undefined values and keeps the rest exactly as they are', () => {
    expect(childEnvironment({ ...KEPT_BASE, UNSET: undefined, SPACED: ' a b ', EMPTY: '' })).toEqual({ ...KEPT_BASE, SPACED: ' a b ', EMPTY: '' });
  });
});
