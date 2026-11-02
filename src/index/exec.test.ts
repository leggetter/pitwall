import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowSignalsTo } from '../test/noClaude.js';
import { absoluteSearchPath, RunError, oneLine, runFile } from './exec.js';

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
      // Only its absolute directories, with a leading `~` expanded, as this Mac's literal `~/.dotnet/tools` is.
      expect(seen.PATH).toBe(absoluteSearchPath(process.env.PATH ?? ''));
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

  // W96's finding (W98): an empty or relative PATH entry finds a bare command in the working
  // directory, where on Linux's shared /tmp another user could have planted it. A made-up program.
  describe.skipIf(process.platform === 'win32')('a bare command planted in the working directory', () => {
    const PLANTED = 'pitwall-test-planted';
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-planted-'));
      await writeFile(path.join(dir, PLANTED), '#!/bin/sh\necho planted\n', { mode: 0o755 });
      await mkdir(path.join(dir, 'bin'));
      await writeFile(path.join(dir, 'bin', PLANTED), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    /** Each PATH, and the directory under `dir` it finds the planted program in, without the filter. */
    const entries = (): [string, string][] => [
      ['.', '.'],
      ['/usr/bin::/bin', 'an empty entry'],
      [':/usr/bin', 'a leading :'],
      ['/usr/bin:', 'a trailing :'],
      ['bin', 'a relative directory'],
      ['', 'an empty PATH'],
    ];

    it('is found there without the filter: the hazard is real on this platform', () => {
      for (const [PATH, what] of entries()) {
        const result = spawnSync(PLANTED, [], { cwd: dir, env: { PATH }, encoding: 'utf8' });
        expect(result.stdout, what).toBe('planted\n');
      }
    });

    it('is not found through any of them, since runFile keeps only the absolute directories', async () => {
      for (const [PATH, what] of entries()) {
        const err = await failure(runFile(PLANTED, [], { cwd: dir, env: { PATH }, timeoutMs: 10_000 }));
        expect(err.reason, what).toBe('not-found');
      }
    });

    // The coordinator's call (2026-10-29): `~/bin` is the home directory's bin, as bash reads it, never <cwd>/~/bin.
    it('is found in the home directory through a ~/ entry, not in a directory named ~ in the working directory', async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-home-'));
      const saved = process.env.HOME;
      try {
        await mkdir(path.join(home, 'bin'));
        await writeFile(path.join(home, 'bin', PLANTED), '#!/bin/sh\necho home\n', { mode: 0o755 });
        await mkdir(path.join(dir, '~', 'bin'), { recursive: true });
        await writeFile(path.join(dir, '~', 'bin', PLANTED), '#!/bin/sh\necho cwd\n', { mode: 0o755 });
        // The child's own HOME first (W98's review).
        expect(await runFile(PLANTED, [], { cwd: dir, env: { PATH: '~/bin', HOME: home }, timeoutMs: 10_000 })).toBe('home\n');
        // Without one, os.homedir(), which reads this process's HOME on macOS and Linux.
        process.env.HOME = home;
        expect(await runFile(PLANTED, [], { cwd: dir, env: { PATH: '~/bin' }, timeoutMs: 10_000 })).toBe('home\n');
        // `~user/...` isn't expanded, and is dropped like any relative entry.
        const err = await failure(runFile(PLANTED, [], { cwd: dir, env: { PATH: `~${path.basename(home)}/bin` }, timeoutMs: 10_000 }));
        expect(err.reason).toBe('not-found');
      } finally {
        if (saved === undefined) delete process.env.HOME;
        else process.env.HOME = saved;
        await rm(home, { recursive: true, force: true });
        await rm(path.join(dir, '~'), { recursive: true, force: true });
      }
    });

    it('is still found through an absolute entry, so the program itself runs', async () => {
      expect(await runFile(PLANTED, [], { cwd: dir, env: { PATH: `.:${path.join(dir, 'bin')}:` }, timeoutMs: 10_000 })).toBe('planted\n');
    });
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

  it.skipIf(process.platform === 'win32')('with processGroup, a timeout stops what the child started too, as gh starts git (W107)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-exec-'));
    const pidFile = path.join(dir, 'pid');
    try {
      // The child starts a grandchild in its own group, as gh runs git, writes its pid, and both wait.
      const script = [
        'const { spawn } = require("node:child_process");',
        'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'require("node:fs").writeFileSync(process.argv[1], String(g.pid));',
        'setInterval(() => {}, 1000);',
      ].join(' ');
      const err = await failure(runFile(node, ['-e', script, pidFile], { timeoutMs: 1_000, processGroup: true }));
      expect(err.reason).toBe('timeout');
      const grandchild = Number(await readFile(pidFile, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isRunning(grandchild)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it.skipIf(process.platform === 'win32')('with signal, an abort stops the child and its group, and rejects once the child has exited (W107)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-exec-'));
    const pidFile = path.join(dir, 'pid');
    try {
      const script = [
        'const { spawn } = require("node:child_process");',
        'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid) + " " + String(g.pid));',
        'setInterval(() => {}, 1000);',
      ].join(' ');
      const controller = new AbortController();
      const run = failure(runFile(node, ['-e', script, pidFile], { timeoutMs: 60_000, processGroup: true, signal: controller.signal }));
      let pids = '';
      for (let tries = 0; tries < 100 && pids === ''; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        pids = await readFile(pidFile, 'utf8').catch(() => '');
      }
      const [child, grandchild] = pids.split(' ').map(Number) as [number, number];
      const started = Date.now();
      controller.abort();
      const err = await run;
      expect(err.reason).toBe('aborted');
      // Rejected only once the child had gone, well within the 2.5 s it waits at most.
      expect(isRunning(child)).toBe(false);
      expect(Date.now() - started).toBeLessThan(2_400);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(isRunning(grandchild)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

  describe.skipIf(process.platform === 'win32')('with processGroup, what ignores SIGTERM in the group gets SIGKILL, though the child itself exited on the SIGTERM (W108)', () => {
    // The child exits on SIGTERM, as gh does; the grandchild it started ignores it, as a git might.
    // The grandchild writes its pid once its handler is on, and gives up by itself after 20 s.
    const script = [
      'const { spawn } = require("node:child_process");',
      'spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); require(\\"node:fs\\").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 20000); setInterval(() => {}, 1000);", process.argv[1]], { stdio: "ignore" });',
      'setInterval(() => {}, 1000);',
    ].join(' ');

    async function grandchildOf(pidFile: string): Promise<number> {
      for (let tries = 0; tries < 200; tries++) {
        const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
        if (pid > 0) return pid;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the grandchild never started');
    }

    const kill = (pid: number | undefined) => {
      if (pid === undefined) return;
      try {
        // A process the test's own child started, which the test guard never saw: named so it may go.
        allowSignalsTo(pid);
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone, as it should be.
      }
    };

    it('after a timeout', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-exec-'));
      const pidFile = path.join(dir, 'pid');
      let grandchild: number | undefined;
      try {
        const run = failure(runFile(node, ['-e', script, pidFile], { timeoutMs: 2_000, processGroup: true }));
        grandchild = await grandchildOf(pidFile);
        const err = await run;
        expect(err.reason).toBe('timeout');
        // The child has gone on the SIGTERM, and the grandchild ignored it: the reviewer's probe.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(isRunning(grandchild)).toBe(true);
        // The SIGKILL, 2 s after the SIGTERM, reaches it though its group's leader has gone.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        expect(isRunning(grandchild)).toBe(false);
      } finally {
        kill(grandchild);
        await rm(dir, { recursive: true, force: true });
      }
    }, 15_000);

    it('after an abort, which rejects only once nothing in the group is left', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-exec-'));
      const pidFile = path.join(dir, 'pid');
      let grandchild: number | undefined;
      try {
        const controller = new AbortController();
        const run = failure(runFile(node, ['-e', script, pidFile], { timeoutMs: 60_000, processGroup: true, signal: controller.signal }));
        grandchild = await grandchildOf(pidFile);
        const started = Date.now();
        controller.abort();
        const err = await run;
        expect(err.reason).toBe('aborted');
        // Not at the child's exit, a moment after the SIGTERM, but once the SIGKILL had removed the grandchild.
        expect(isRunning(grandchild)).toBe(false);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
        expect(Date.now() - started).toBeLessThan(2_600);
      } finally {
        kill(grandchild);
        await rm(dir, { recursive: true, force: true });
      }
    }, 15_000);
  });

  it('runs nothing with a signal that has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await failure(runFile(node, ['-e', 'require("node:fs").writeFileSync("/nonexistent-dir/x", "")'], { timeoutMs: 10_000, signal: controller.signal }));
    expect(err.reason).toBe('aborted');
  });

  it.skipIf(process.platform === 'win32')('with processGroup, the child has no controlling terminal', async () => {
    // Opening /dev/tty fails with no controlling terminal, so nothing it runs can prompt in pitwall's.
    const stdout = await runFile(node, ['-e', 'try { require("node:fs").openSync("/dev/tty", "r"); process.stdout.write("tty") } catch { process.stdout.write("none") }'], {
      timeoutMs: 10_000,
      processGroup: true,
    });
    expect(stdout).toBe('none');
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
