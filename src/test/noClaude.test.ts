// The guard in noClaude.ts, which vitest.config.ts loads before every server
// test file. Every command here names a claude that doesn't exist, so even a
// broken guard couldn't start Claude Code.
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentsSource } from '../index/agents.js';
import { spawnPty } from '../server/pty.js';

// Read before this file loads the guard itself, so it shows the setup file did.
const installedBySetup =
  (globalThis as Record<symbol, { installed?: boolean } | undefined>)[Symbol.for('pitwall.noClaude')]?.installed === true;
const { failOnRefusals, takeRefusals } = await import('./noClaude.js');

const CLAUDE = '/nonexistent/pitwall-test/claude';
const REFUSED = /would run claude without PITWALL_LIVE=1/;
/** Editors that don't exist either (W72): even a broken guard couldn't open one. */
const CODE = '/nonexistent/pitwall-test/code';
const CURSOR = '/nonexistent/pitwall-test/cursor';
const OPEN = '/nonexistent/pitwall-test/open';
const XDG_OPEN = '/nonexistent/pitwall-test/xdg-open';
const ENV = '/nonexistent/pitwall-test/env';
const EDITOR_REFUSED = /would open an editor/;
const SIGNAL_REFUSED = /would signal another process to end without PITWALL_LIVE=1/;

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

  it('lets claude through with PITWALL_LIVE=1, as the live checks need', () => {
    process.env.PITWALL_LIVE = '1';
    expect(spawnSync(CLAUDE, ['--help']).error).toMatchObject({ code: 'ENOENT' });
    expect(takeRefusals()).toEqual([]);
  });

  // W90: End session's default signaller is process.kill. Only a child this test starts is ever signalled.
  it('refuses process.kill with SIGTERM, SIGINT, SIGHUP or no signal to another process, and lets 0, SIGKILL and PITWALL_LIVE=1 through', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    const pid = child.pid as number;
    try {
      expect(() => process.kill(pid, 'SIGTERM')).toThrow(SIGNAL_REFUSED);
      expect(() => process.kill(pid, 'SIGINT')).toThrow(SIGNAL_REFUSED);
      expect(() => process.kill(pid, 'SIGHUP')).toThrow(SIGNAL_REFUSED);
      expect(() => process.kill(pid, 15)).toThrow(SIGNAL_REFUSED);
      expect(() => process.kill(pid)).toThrow(SIGNAL_REFUSED);
      expect(takeRefusals()).toHaveLength(5);
      // Refused before it was sent: the child is still running.
      expect(process.kill(pid, 0)).toBe(true);
      expect(child.exitCode).toBeNull();
      process.env.PITWALL_LIVE = '1';
      expect(process.kill(pid, 'SIGTERM')).toBe(true);
      expect(await exited).toBe('SIGTERM');
      expect(takeRefusals()).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
