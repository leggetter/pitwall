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

  it('lets claude through with PITWALL_LIVE=1, as the live checks need', () => {
    process.env.PITWALL_LIVE = '1';
    expect(spawnSync(CLAUDE, ['--help']).error).toMatchObject({ code: 'ENOENT' });
    expect(takeRefusals()).toEqual([]);
  });
});
