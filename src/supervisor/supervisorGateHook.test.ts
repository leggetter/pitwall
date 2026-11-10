// The supervisor's recipient gate (M5, W115): the deny-only hook's rules, its files, and the hook run
// as Claude Code runs it, a node process reading its input on stdin. It never prints an allow. Made-up
// names only; no test runs claude.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupervisorGate, supervisorGateScriptPath } from './gate.js';
import { isPreviewOf, readRecipients, refusal, runHook } from './supervisorGateHook.mjs';

const TARGET = 'pitwall-test-target';
const ID = 'a'.repeat(32);

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-gate-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const call = (input: Record<string, unknown>) => ({ hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: input });
const plain = (to: string, extra: Record<string, unknown> = {}) => call({ to, message: 'hello', summary: 'hi', type: 'message', recipient: to, recipient_kind: 'name', content: 'hello', ...extra });

describe('refusal()', () => {
  const names = new Set([TARGET]);
  it('lets a plain message to a name on the list go on to approval, and nothing else', () => {
    expect(refusal(plain(TARGET), names)).toBeUndefined();
    expect(refusal(call({ to: TARGET, message: 'hello' }), names)).toBeUndefined();
  });

  it('denies a name not on the list, another case, pitwall’s own, an address, idle notices, unknown fields and no list at all', () => {
    expect(refusal(plain('pitwall-test-other'), names)).toMatch(/one running session/);
    expect(refusal(plain('Pitwall-Test-Target'), names)).toMatch(/one running session/);
    expect(refusal(plain('pitwall-relay'), new Set(['pitwall-relay']))).toMatch(/pitwall’s own/);
    expect(refusal(plain('PITWALL-SUPERVISOR'), names)).toMatch(/pitwall’s own/);
    // The /usage reader's name too (W180, U-F5).
    expect(refusal(plain('pitwall-usage'), new Set(['pitwall-usage']))).toMatch(/pitwall’s own/);
    expect(refusal(plain('uds:/tmp/cc-socks/1.sock', { recipient_kind: 'address' }), names)).toMatch(/something other than a session’s name/);
    expect(refusal(plain(TARGET, { recipient: 'pitwall-test-other' }), names)).toMatch(/two different/);
    expect(refusal(plain(TARGET, { notify_when_idle: true }), names)).toMatch(/idle/);
    expect(refusal(plain(TARGET, { type: 'broadcast' }), names)).toMatch(/plain message/);
    expect(refusal(plain(TARGET, { extra: 1 }), names)).toMatch(/field/);
    // A preview that isn't the message, or its start, could carry text the card never shows (W115's review).
    expect(refusal(plain(TARGET, { content: 'EVIL' }), names)).toMatch(/preview/);
    expect(refusal(plain(TARGET, { content: 'hello, and more' }), names)).toMatch(/preview/);
    expect(refusal(call({ to: TARGET }), names)).toMatch(/no message/);
    expect(refusal(call({ message: 'x' }), names)).toMatch(/names no session/);
    expect(refusal(plain(TARGET), undefined)).toMatch(/no list/);
    expect(refusal({ hook_event_name: 'Stop' }, names)).toBeDefined();
  });
});

describe('isPreviewOf()', () => {
  it('is the message, or its start cut with an ellipsis, as Claude Code makes it, and nothing else', () => {
    const long = 'Please look at the failing export test and tell me why it fails.';
    expect(isPreviewOf(undefined, 'hi')).toBe(true);
    expect(isPreviewOf('hi', 'hi')).toBe(true);
    expect(isPreviewOf(`${long.slice(0, 49)}…`, long)).toBe(true);
    expect(isPreviewOf(`${long.slice(0, 49)} …`, long)).toBe(true);
    expect(isPreviewOf('EVIL', 'harmless')).toBe(false);
    expect(isPreviewOf('Please look…', 'Please')).toBe(false);
    expect(isPreviewOf('…', long)).toBe(false);
    expect(isPreviewOf(`${long}…`, long)).toBe(false);
    expect(isPreviewOf(`${'x'.repeat(300)}…`, 'x'.repeat(400))).toBe(false);
    expect(isPreviewOf(['hi'], 'hi')).toBe(false);
  });
});

describe('the gate’s files', () => {
  it('writes the list 0600 in its 0700 folder, reads it back, refuses one it can’t trust, and forgets it', () => {
    const dir = path.join(tmp, 'files', 'gate');
    const gate = createSupervisorGate({ dir });
    gate.prepare();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    gate.setRecipients(ID, [TARGET]);
    expect(readRecipients(dir, ID)).toEqual(new Set([TARGET]));
    expect(statSync(path.join(dir, `${ID}.recipients`)).mode & 0o777).toBe(0o600);
    writeFileSync(path.join(dir, `${ID}.recipients`), '{"v":2,"names":["x"]}');
    expect(readRecipients(dir, ID)).toBeUndefined();
    gate.forget(ID);
    expect(readRecipients(dir, ID)).toBeUndefined();
  });

  it('denies every call when its folder isn’t private, and SessionStart marks it ready', () => {
    const dir = path.join(tmp, 'open');
    mkdirSync(dir, { mode: 0o700 });
    const gate = createSupervisorGate({ dir });
    gate.setRecipients(ID, [TARGET]);
    expect(runHook([dir, ID], JSON.stringify({ hook_event_name: 'SessionStart' }))).toEqual({ exitCode: 0 });
    expect(gate.isReady(ID)).toBe(true);
    expect(runHook([dir, ID], JSON.stringify(plain(TARGET)))).toEqual({ exitCode: 0 });
    chmodSync(dir, 0o755);
    expect(runHook([dir, ID], JSON.stringify(plain(TARGET)))).toMatchObject({ exitCode: 2 });
    chmodSync(dir, 0o700);
    expect(runHook([dir, 'not-an-id'], JSON.stringify(plain(TARGET)))).toMatchObject({ exitCode: 2 });
    expect(runHook([dir, ID], undefined)).toMatchObject({ exitCode: 2 });
    expect(runHook([dir, ID], '{not json')).toMatchObject({ exitCode: 2 });
  });
});

describe('the hook, as Claude Code runs it', () => {
  it('passes on a call it lets through with exit 0 and nothing on stdout, never an allow; denies with exit 2 and why on stderr', () => {
    const dir = path.join(tmp, 'run');
    const gate = createSupervisorGate({ dir });
    gate.prepare();
    gate.setRecipients(ID, [TARGET]);
    const hooks = gate.hooks(ID) as { PreToolUse: { matcher: string; hooks: { command: string; args: string[]; onFailure: string }[] }[] };
    const hook = hooks.PreToolUse[0]!.hooks[0]!;
    expect(hooks.PreToolUse[0]!.matcher).toBe('SendMessage');
    expect(hook.onFailure).toBe('block');
    expect(hook.args).toEqual([supervisorGateScriptPath(), path.resolve(dir), ID]);
    const run = (input: unknown) => spawnSync(hook.command, hook.args, { input: JSON.stringify(input), encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    const passed = run(plain(TARGET));
    expect(passed.status).toBe(0);
    expect(passed.stdout).toBe('');
    const denied = run(plain('pitwall-test-other'));
    expect(denied.status).toBe(2);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain("pitwall's supervisor gate denied this SendMessage");
  });
});
