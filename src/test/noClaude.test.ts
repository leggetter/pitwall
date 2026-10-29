// The guard in noClaude.ts, which vitest.config.ts loads before every server
// test file. Every command here names a claude or a gh that doesn't exist, so
// even a broken guard couldn't start Claude Code or reach GitHub.
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentsSource } from '../index/agents.js';
import { runFile } from '../index/exec.js';
import { fetchPullRequests } from '../prs/fetch.js';
import { spawnPty } from '../server/pty.js';

// Read before this file loads the guard itself, so it shows the setup file did.
const installedBySetup =
  (globalThis as Record<symbol, { installed?: boolean } | undefined>)[Symbol.for('pitwall.noClaude')]?.installed === true;
const { allowSignalsTo, failOnGhCalls, failOnRefusals, GH_NO_LOGIN, ghStandIn, takeGhCalls, takeRefusals } = await import('./noClaude.js');

const CLAUDE = '/nonexistent/pitwall-test/claude';
const REFUSED = /would run claude without PITWALL_LIVE=1/;
/** Editors that don't exist either (W72): even a broken guard couldn't open one. */
const CODE = '/nonexistent/pitwall-test/code';
const CURSOR = '/nonexistent/pitwall-test/cursor';
const OPEN = '/nonexistent/pitwall-test/open';
const XDG_OPEN = '/nonexistent/pitwall-test/xdg-open';
const ENV = '/nonexistent/pitwall-test/env';
const EDITOR_REFUSED = /would open an editor/;
const SIGNAL_REFUSED = /would signal a process this test didn't start without PITWALL_LIVE=1/;
/** GitHub's CLI, which doesn't exist here either (M4, W93). */
const GH = '/nonexistent/pitwall-test/gh';
const GH_REFUSED = /would run gh without PITWALL_LIVE=1/;

describe('the no-claude guard', () => {
  let saved: string | undefined;

  // A live run sets PITWALL_LIVE; these tests need it unset, except where one sets it.
  beforeEach(() => {
    saved = process.env.PITWALL_LIVE;
    delete process.env.PITWALL_LIVE;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.PITWALL_LIVE;
    else process.env.PITWALL_LIVE = saved;
  });

  it('is installed by the vitest setup, before a test file loads', () => {
    expect(installedBySetup).toBe(true);
  });

  it('refuses every child_process API that would run claude, before it runs', () => {
    expect(() => spawn(CLAUDE, ['--help'])).toThrow(REFUSED);
    expect(() => spawnSync(CLAUDE, ['--help'])).toThrow(REFUSED);
    expect(() => execFile(CLAUDE, ['--help'], () => {})).toThrow(REFUSED);
    expect(() => execFileSync(CLAUDE)).toThrow(REFUSED);
    expect(() => promisify(execFile)(CLAUDE, ['--help'])).toThrow(REFUSED);
    expect(() => exec(`${CLAUDE} --help`, () => {})).toThrow(REFUSED);
    expect(() => execSync(`true && ${CLAUDE} --help`)).toThrow(REFUSED);
    expect(() => promisify(exec)(`${CLAUDE} --help`)).toThrow(REFUSED);
    expect(takeRefusals()).toHaveLength(8);
  });

  it('refuses claude through a shell, with shell: true or sh -c', () => {
    expect(() => spawnSync(CLAUDE, ['--help'], { shell: true })).toThrow(REFUSED);
    expect(() => spawnSync('/bin/sh', ['-c', `${CLAUDE} --help`])).toThrow(REFUSED);
    expect(() => execFileSync('bash', ['-c', `cd / && ${CLAUDE}`])).toThrow(REFUSED);
    expect(takeRefusals()).toHaveLength(3);
  });

  it("refuses node-pty's spawn of claude", () => {
    expect(() => spawnPty(CLAUDE, [], { cols: 80, rows: 24, cwd: '/', env: {}, name: 'xterm-256color' })).toThrow(REFUSED);
    expect(takeRefusals()).toHaveLength(1);
  });

  it('records a refusal the code under test catches, so the test still fails', async () => {
    // The agents source fails soft, so only the recorded refusal shows it tried.
    const result = await createAgentsSource({ claudeBin: CLAUDE }).list();
    expect(result.ok).toBe(false);
    expect(() => failOnRefusals()).toThrow(REFUSED);
    // failOnRefusals took them, so the guard's own afterEach finds none.
    expect(takeRefusals()).toEqual([]);
  });

  it('lets everything else through: other programs, and names that only contain claude', async () => {
    expect(spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' }).stdout).toBe('ok');
    await expect(promisify(execFile)(process.execPath, ['-e', 'process.stdout.write("ok")'])).resolves.toEqual({ stdout: 'ok', stderr: '' });
    expect(spawnSync('/nonexistent/pitwall-test-no-such-claude').error).toMatchObject({ code: 'ENOENT' });
    expect(spawnSync('/nonexistent/claude-test').error).toMatchObject({ code: 'ENOENT' });
    expect(execSync('echo ~/.claude/projects CLAUDE_CONFIG_DIR claude-code', { encoding: 'utf8' })).toContain('claude-code');
    expect(takeRefusals()).toEqual([]);
  });

  it('refuses to open an editor (W72): code, cursor, or open -a or -b, by any API or a shell', () => {
    expect(() => spawn(CODE, ['/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(CURSOR, ['/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => execFile(OPEN, ['-a', '/Applications/Cursor.app', '/tmp'], () => {})).toThrow(EDITOR_REFUSED);
    expect(() => execFileSync(OPEN, ['-b', 'com.microsoft.VSCode', '/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => promisify(execFile)(CODE, ['/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => exec(`${CURSOR} /tmp`, () => {})).toThrow(EDITOR_REFUSED);
    expect(() => execSync(`true && ${OPEN} -a Cursor /tmp`)).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync('/bin/sh', ['-c', `${CODE} /tmp`])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(CODE, ['/tmp'], { shell: true })).toThrow(EDITOR_REFUSED);
    expect(takeRefusals()).toHaveLength(9);
  });

  it('refuses open with a flag group that names an app, such as -na or -ga, and an editor’s URL through open or xdg-open', () => {
    expect(() => spawnSync(OPEN, ['-na', 'Cursor', '/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(OPEN, ['-ga', '/Applications/Cursor.app', '/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(OPEN, ['-nb', 'com.todesktop.230313mzl4w4u92', '/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(OPEN, ['vscode://file/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(OPEN, ['-g', 'cursor://file/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(XDG_OPEN, ['vscode-insiders://file/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => execSync(`${OPEN} -na Cursor /tmp`)).toThrow(EDITOR_REFUSED);
    expect(() => execSync(`${OPEN} -ga Cursor /tmp`)).toThrow(EDITOR_REFUSED);
    expect(() => execSync(`${OPEN} 'vscode://file/tmp'`)).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync('/bin/sh', ['-c', `${XDG_OPEN} cursor://file/tmp`])).toThrow(EDITOR_REFUSED);
    expect(takeRefusals()).toHaveLength(10);
  });

  it('refuses an editor behind env, after its options and assignments, and in a string -S splits', () => {
    expect(() => spawnSync(ENV, ['code', '/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(ENV, ['-i', 'HOME=/tmp', 'PATH=/usr/bin', CURSOR, '/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(ENV, ['-u', 'HOME', '-C', '/tmp', '--', CODE, '.'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(ENV, ['-S', 'FOO=1 code /tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(ENV, ['-Scursor /tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(ENV, ['FOO=1', OPEN, '-na', 'Cursor', '/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => spawnSync(ENV, [ENV, 'code', '/tmp'])).toThrow(EDITOR_REFUSED);
    expect(() => execFile(ENV, ['code', '/tmp'], () => {})).toThrow(EDITOR_REFUSED);
    expect(() => execSync(`${ENV} FOO=1 code /tmp`)).toThrow(EDITOR_REFUSED);
    expect(takeRefusals()).toHaveLength(9);
  });

  it('lets env run anything else, and open its other flags, such as -n, -g or --args', () => {
    expect(spawnSync(ENV, ['-u', 'code', 'FOO=1', '/nonexistent/pitwall-test/node', '-e', '1']).error).toMatchObject({ code: 'ENOENT' });
    expect(spawnSync(OPEN, ['-n', '-g', '/nonexistent/pitwall-test/launch.html', '--args', '--flag']).error).toMatchObject({ code: 'ENOENT' });
    expect(spawnSync(XDG_OPEN, ['https://example.com/vscode:']).error).toMatchObject({ code: 'ENOENT' });
    expect(takeRefusals()).toEqual([]);
  });

  it('refuses to open an editor with PITWALL_LIVE=1 too, and lets a plain open <file> through, as the CLI opens the browser', () => {
    process.env.PITWALL_LIVE = '1';
    expect(() => spawnSync(CODE, ['/tmp'])).toThrow(EDITOR_REFUSED);
    expect(takeRefusals()).toHaveLength(1);
    delete process.env.PITWALL_LIVE;
    expect(spawnSync(OPEN, ['/nonexistent/pitwall-test/launch.html']).error).toMatchObject({ code: 'ENOENT' });
    expect(spawnSync('/nonexistent/pitwall-test/vscode-cli').error).toMatchObject({ code: 'ENOENT' });
    expect(execSync('echo claude-code pitwall-test-cursor-row', { encoding: 'utf8' })).toContain('cursor-row');
    expect(takeRefusals()).toEqual([]);
  });

  // M4, W93: the PR poller runs `gh api graphql` with the user's own login.
  it('refuses gh by every child_process API, through a shell and through node-pty, before it runs', () => {
    expect(() => spawn(GH, ['api', 'graphql'])).toThrow(GH_REFUSED);
    expect(() => spawnSync(GH, ['api', 'graphql'])).toThrow(GH_REFUSED);
    expect(() => execFile(GH, ['api', 'graphql'], () => {})).toThrow(GH_REFUSED);
    expect(() => execFileSync(GH)).toThrow(GH_REFUSED);
    expect(() => promisify(execFile)(GH, ['auth', 'status'])).toThrow(GH_REFUSED);
    expect(() => exec(`${GH} api graphql`, () => {})).toThrow(GH_REFUSED);
    expect(() => execSync(`true && ${GH} api graphql`)).toThrow(GH_REFUSED);
    expect(() => promisify(exec)(`${GH} auth status`)).toThrow(GH_REFUSED);
    expect(() => spawnSync(GH, ['api'], { shell: true })).toThrow(GH_REFUSED);
    expect(() => spawnSync('/bin/sh', ['-c', `${GH} api graphql`])).toThrow(GH_REFUSED);
    expect(() => execFileSync('bash', ['-c', `cd / && ${GH} pr list`])).toThrow(GH_REFUSED);
    expect(() => spawnPty(GH, [], { cols: 80, rows: 24, cwd: '/', env: {}, name: 'xterm-256color' })).toThrow(GH_REFUSED);
    expect(takeRefusals()).toHaveLength(12);
  });

  it("records a refusal of the PR fetch's gh, which fails soft, so the test still fails", async () => {
    const result = await fetchPullRequests({ runFile, ghBin: GH });
    // Each search its own call (W101's review), each refused.
    expect(result).toMatchObject({ authored: { ok: false, reason: 'error' }, 'review-requested': { ok: false, reason: 'error' }, mentioned: { ok: false, reason: 'error' } });
    expect(() => failOnRefusals()).toThrow(GH_REFUSED);
    expect(takeRefusals()).toEqual([]);
  });

  it('lets through names that only contain gh, and gh with PITWALL_LIVE=1', () => {
    expect(spawnSync('/nonexistent/pitwall-test/ghost').error).toMatchObject({ code: 'ENOENT' });
    expect(spawnSync('/nonexistent/pitwall-test/gh-test').error).toMatchObject({ code: 'ENOENT' });
    expect(spawnSync('/nonexistent/pitwall-test/github').error).toMatchObject({ code: 'ENOENT' });
    expect(execSync('echo gh-pages ghq high .gh', { encoding: 'utf8' })).toContain('gh-pages');
    expect(takeRefusals()).toEqual([]);
    process.env.PITWALL_LIVE = '1';
    expect(spawnSync(GH, ['api', 'graphql']).error).toMatchObject({ code: 'ENOENT' });
    expect(takeRefusals()).toEqual([]);
  });

  // W93's review: a second layer for gh, which a process at any depth finds first on PATH.
  describe('the refusing gh first on PATH', () => {
    /** A grandchild of this test, which the in-process wrapper can't see: node, running `gh <args>` by name. */
    const grandchildRuns = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
      spawnSync(
        process.execPath,
        ['-e', `process.exit(require('node:child_process').spawnSync('gh', ${JSON.stringify(args)}, { stdio: 'ignore' }).status ?? 99)`],
        { env },
      ).status;

    it('is first on PATH, with an empty GH_CONFIG_DIR and only the placeholder as a GitHub token in the environment', () => {
      const standIn = ghStandIn();
      expect(standIn).toBeDefined();
      expect(process.env.PATH?.split(delimiter)[0]).toBe(standIn?.bin);
      expect(statSync(join(standIn!.bin, 'gh')).mode & 0o111).not.toBe(0);
      expect(readdirSync(process.env.GH_CONFIG_DIR!)).toEqual([]);
      // W96's finding (W98): gh reads these before its config and the keychain, so they're set, not only removed.
      expect(GH_NO_LOGIN).toBe('pitwall-test-no-login');
      expect(process.env.GH_TOKEN).toBe(GH_NO_LOGIN);
      expect(process.env.GH_ENTERPRISE_TOKEN).toBe(GH_NO_LOGIN);
      for (const name of ['GITHUB_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) expect(process.env[name], name).toBeUndefined();
    });

    // A made-up gh at an absolute path, which the stand-in on PATH can't catch: what it sees is all a real one would have.
    it('gives a gh run by an absolute path, two levels down, the placeholder token and the empty config, so no login', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pitwall-test-fake-gh-'));
      try {
        const gh = join(dir, 'gh');
        const seen = join(dir, 'seen');
        writeFileSync(
          gh,
          `#!/bin/sh\nprintf '%s\\n' "GH_TOKEN=\${GH_TOKEN-unset}" "GH_ENTERPRISE_TOKEN=\${GH_ENTERPRISE_TOKEN-unset}" "GITHUB_TOKEN=\${GITHUB_TOKEN-unset}" "GITHUB_ENTERPRISE_TOKEN=\${GITHUB_ENTERPRISE_TOKEN-unset}" "GH_CONFIG_DIR=\${GH_CONFIG_DIR-unset}" > '${seen}'\n`,
          { mode: 0o755 },
        );
        const status = spawnSync(process.execPath, ['-e', `process.exit(require('node:child_process').spawnSync(${JSON.stringify(gh)}, ['api', 'graphql'], { stdio: 'ignore' }).status ?? 99)`]).status;
        expect(status).toBe(0);
        expect(readFileSync(seen, 'utf8').split('\n')).toEqual([
          `GH_TOKEN=${GH_NO_LOGIN}`,
          `GH_ENTERPRISE_TOKEN=${GH_NO_LOGIN}`,
          'GITHUB_TOKEN=unset',
          'GITHUB_ENTERPRISE_TOKEN=unset',
          `GH_CONFIG_DIR=${process.env.GH_CONFIG_DIR}`,
          '',
        ]);
        // Not the stand-in: nothing was written down.
        expect(takeGhCalls()).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // The positive control: --version, so even a broken guard that reached a real gh would ask GitHub nothing.
    it('catches gh run by a grandchild, which exits 1, and fails the test that started it', () => {
      expect(grandchildRuns(['--version'])).toBe(1);
      expect(() => failOnGhCalls()).toThrow(/a process a test started ran gh without PITWALL_LIVE=1, 1 time/);
      expect(takeGhCalls()).toEqual([]);
    });

    it('catches gh through a shell two levels down, and writes down each call', () => {
      const status = spawnSync(process.execPath, ['-e', "process.exit(require('node:child_process').spawnSync('/bin/sh', ['-c', 'gh --version; gh --help'], { stdio: 'ignore' }).status ?? 99)"]).status;
      expect(status).toBe(1);
      const calls = takeGhCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatch(/^gh --version {2}\(pid \d+, parent \d+\)$/);
      expect(calls[1]).toMatch(/^gh --help /);
    });

    it('lets a test’s own fake gh win, when the test puts it first on the PATH it passes', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pitwall-test-fake-gh-'));
      try {
        writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        expect(grandchildRuns(['--version'], { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` })).toBe(0);
        expect(takeGhCalls()).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('lets claude through with PITWALL_LIVE=1, as the live checks need', () => {
    process.env.PITWALL_LIVE = '1';
    expect(spawnSync(CLAUDE, ['--help']).error).toMatchObject({ code: 'ENOENT' });
    expect(takeRefusals()).toEqual([]);
  });

  // W90 and its review: End session's default signaller is process.kill. Only processes this test starts are signalled.
  it("refuses process.kill with any signal but 0 to a pid it didn't see started, '', null, false, NaN, SIGQUIT and SIGUSR1 included", async () => {
    // A shell that starts a sleep in the background and says its pid: the wrapper sees the shell, never the sleep.
    const shell = spawn('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = await new Promise<number>((resolve) => shell.stdout.once('data', (data: Buffer) => resolve(Number(String(data).trim()))));
    expect(grandchild).toBeGreaterThan(0);
    try {
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGKILL', 9, 15, '', null, false, Number.NaN, undefined] as unknown[]) {
        expect(() => process.kill(grandchild, signal as NodeJS.Signals), String(signal)).toThrow(SIGNAL_REFUSED);
      }
      expect(takeRefusals()).toHaveLength(13);
      // Refused before it was sent: still running. Signal 0 only asks.
      expect(process.kill(grandchild, 0)).toBe(true);
      expect(takeRefusals()).toEqual([]);
      // Named by the test that cleans it up, it goes through.
      allowSignalsTo(grandchild);
      expect(process.kill(grandchild, 'SIGKILL')).toBe(true);
      expect(takeRefusals()).toEqual([]);
    } finally {
      try {
        allowSignalsTo(grandchild);
        process.kill(grandchild, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  it('lets a test signal a child it started, while it runs, forgets it once it has exited, and lets anything through with PITWALL_LIVE=1', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    const pid = child.pid as number;
    try {
      expect(process.kill(pid, 'SIGTERM')).toBe(true);
      expect(await exited).toBe('SIGTERM');
      // Exited: its pid may belong to another process now.
      expect(() => process.kill(pid, 'SIGTERM')).toThrow(SIGNAL_REFUSED);
      expect(takeRefusals()).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    const live = spawn('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = await new Promise<number>((resolve) => live.stdout.once('data', (data: Buffer) => resolve(Number(String(data).trim()))));
    process.env.PITWALL_LIVE = '1';
    expect(process.kill(grandchild, 'SIGKILL')).toBe(true);
    expect(takeRefusals()).toEqual([]);
  });
});
