import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunError, oneLine, runFile } from './exec.js';

// Real child processes, using this Node binary as the program.
const node = process.execPath;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function failure(promise: Promise<unknown>): Promise<RunError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RunError) return err;
    throw err;
  }
  throw new Error('expected the run to fail');
}

describe('runFile', () => {
  it('resolves with stdout and ignores stderr', async () => {
    const stdout = await runFile(
      node,
      ['-e', 'process.stderr.write("Starting background service…\\n"); process.stdout.write("[1,2]")'],
      { timeoutMs: 10_000 },
    );
    expect(stdout).toBe('[1,2]');
  });

  it('passes arguments without a shell', async () => {
    const stdout = await runFile(node, ['-e', 'process.stdout.write(process.argv[1])', '$HOME; echo hi'], {
      timeoutMs: 10_000,
    });
    expect(stdout).toBe('$HOME; echo hi');
  });

  // childEnvironment() itself is tested name by name in src/server/command.test.ts.
  it("gives the child its environment through childEnvironment(): without the parent session's identity or pitwall's own", async () => {
    const script = 'process.stdout.write(JSON.stringify(process.env))';
    const given = {
      PATH: process.env.PATH ?? '',
      ANTHROPIC_MODEL: 'kept',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: '99999999-9999-4999-8999-999999999999',
      PITWALL_TOKEN: 'secret',
      npm_config_registry: 'https://example.invalid',
    };
    const seen = JSON.parse(await runFile(node, ['-e', script], { timeoutMs: 10_000, env: given })) as Record<string, string>;
    expect(seen.ANTHROPIC_MODEL).toBe('kept');
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'PITWALL_TOKEN', 'npm_config_registry']) {
      expect(seen[name], name).toBeUndefined();
    }
  });

  it('scrubs process.env the same way when no environment is given', async () => {
    const saved = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_CHILD_SESSION: process.env.CLAUDE_CODE_CHILD_SESSION };
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    try {
      const seen = JSON.parse(await runFile(node, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { timeoutMs: 10_000 })) as Record<string, string>;
      expect(seen.CLAUDECODE).toBeUndefined();
      expect(seen.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
      expect(seen.PATH).toBe(process.env.PATH);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('closes stdin, so a child that reads it sees EOF', async () => {
    const stdout = await runFile(
      node,
      ['-e', 'let n=0; process.stdin.on("data", d => n += d.length).on("end", () => process.stdout.write("eof:" + n))'],
      { timeoutMs: 10_000 },
    );
    expect(stdout).toBe('eof:0');
  });

  it('rejects with the exit code', async () => {
    const err = await failure(runFile(node, ['-e', 'process.exit(3)'], { timeoutMs: 10_000 }));
    expect(err.reason).toBe('exit');
    expect(err.exitCode).toBe(3);
    expect(err.message).toBe('exited with code 3');
  });

  it('rejects when the program is not found', async () => {
    const err = await failure(runFile('pitwall-test-no-such-binary', [], { timeoutMs: 10_000 }));
    expect(err.reason).toBe('not-found');
    expect(err.message).toBe('pitwall-test-no-such-binary was not found');
  });

  it('kills the child and rejects on timeout', async () => {
    const started = Date.now();
    const err = await failure(runFile(node, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 300 }));
    expect(err.reason).toBe('timeout');
    expect(err.message).toBe('timed out after 300ms');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('kills a child that ignores SIGTERM with SIGKILL after a timeout', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-exec-'));
    const pidFile = path.join(dir, 'pid');
    try {
      const script =
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
      const err = await failure(runFile(node, ['-e', script, pidFile], { timeoutMs: 500 }));
      expect(err.reason).toBe('timeout');
      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(isRunning(pid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(isRunning(pid)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('finishes when the child exits, even if a process it started still holds stderr', async () => {
    // The child starts a detached grandchild that inherits stderr and lives for
    // 3 seconds, like `claude` starting its background service. With stderr
    // piped, the run would wait for the grandchild.
    const script = [
      'const { spawn } = require("node:child_process");',
      'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { detached: true, stdio: ["ignore", "ignore", "inherit"] });',
      'g.unref();',
      'process.stdout.write("done");',
    ].join(' ');
    const started = Date.now();
    const stdout = await runFile(node, ['-e', script], { timeoutMs: 10_000 });
    expect(stdout).toBe('done');
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('rejects when stdout is larger than the limit', async () => {
    const err = await failure(
      runFile(node, ['-e', 'process.stdout.write("x".repeat(5000))'], { timeoutMs: 10_000, maxStdoutBytes: 1000 }),
    );
    expect(err.reason).toBe('too-large');
  });
});

describe('oneLine', () => {
  it('collapses whitespace and caps the length', () => {
    expect(oneLine('  a\n  b\tc  ')).toBe('a b c');
    expect(oneLine('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
