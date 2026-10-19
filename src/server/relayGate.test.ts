// The relay's gate (D8): the hook's decision, its one-shot claim, and the
// script as Claude Code runs it, in exec form with JSON on stdin. Temporary
// directories and made-up names and text only. No test runs `claude`.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRelayGate, gateScriptPath, gateSettings, removeStaleGateFiles } from './relayGate.js';
import { claimExpectation, decide, DENIAL_PREFIX, expectationPath, hookOutput, readyPath, runHook, textHash } from './relayGateHook.mjs';

const ID = '0123456789abcdef0123456789abcdef';
const REQUEST = 'fedcba9876543210';
const TO = 'pitwall-test-target';
const TEXT = 'Please run the tests.\n  "quoted" <b>&</b> ✓';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A private home with a private gate directory in it, as pitwall makes them. */
function gateDir(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-gate-'));
  temps.push(home);
  chmodSync(home, 0o700);
  const dir = path.join(home, 'relay-gate');
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

function preToolUse(toolInput: Record<string, unknown>, toolName = 'SendMessage') {
  return { session_id: 'x', hook_event_name: 'PreToolUse', permission_mode: 'dontAsk', tool_name: toolName, tool_input: toolInput, tool_use_id: 'toolu_1' };
}

const call = (overrides: Record<string, unknown> = {}) => ({ to: TO, message: TEXT, summary: 'relay', ...overrides });
const expectation = (overrides: Partial<{ to: string; sha256: string; expiresAt: number }> = {}) => ({
  v: 1,
  request: REQUEST,
  to: TO,
  sha256: textHash(TEXT),
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

describe('decide', () => {
  const now = Date.now();

  it('allows exactly the expected call, also as Claude Code reports it normalized', () => {
    expect(decide(preToolUse(call()), expectation(), now).allow).toBe(true);
    // `content` is a preview of `message`, cut at about 50 characters (v2.1.303), so it isn't compared.
    expect(decide(preToolUse(call({ type: 'message', recipient: TO, recipient_kind: 'name', content: `${TEXT.slice(0, 20)}…`, notify_when_idle: false })), expectation(), now).allow).toBe(true);
  });

  it.each([
    ['no expectation', preToolUse(call()), undefined, /no request waiting/],
    ['an expired one', preToolUse(call()), expectation({ expiresAt: now - 1 }), /expired/],
    ['another target', preToolUse(call({ to: 'pitwall-test-other' })), expectation(), /addressed to a session/],
    ['a ref appended', preToolUse(call({ to: `${TO} [d749a0]` })), expectation(), /addressed to a session/],
    ['a recipient that disagrees', preToolUse(call({ recipient: 'pitwall-test-other' })), expectation(), /addressed to a session/],
    ['a changed text', preToolUse(call({ message: `${TEXT}\n` })), expectation(), /isn’t the text/],
    ['no text', preToolUse(call({ message: undefined })), expectation(), /isn’t the text/],
    ['an idle subscription', preToolUse(call({ notify_when_idle: true })), expectation(), /idle/],
    ['another kind of call', preToolUse(call({ type: 'subscribe' })), expectation(), /plain message/],
    ['another tool', preToolUse({ command: 'ls' }, 'Bash'), expectation(), /only use SendMessage/],
    ['another event', { hook_event_name: 'PostToolUse' }, expectation(), /something other than a tool call/],
    ['nothing', undefined, expectation(), /something other than a tool call/],
  ])('denies %s, with a reason', (_what, input, expected, reason) => {
    const decision = decide(input, expected, now);
    expect(decision.allow).toBe(false);
    expect(decision.reason.startsWith(`${DENIAL_PREFIX} denied this SendMessage: `)).toBe(true);
    expect(decision.reason).toMatch(reason);
  });

  it('compares UTF-16 code units, so texts that differ only in a lone surrogate differ', () => {
    expect(textHash('a\ud800')).not.toBe(textHash('a\udbff'));
    expect(textHash(TEXT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers in the documented PreToolUse output', () => {
    expect(JSON.parse(hookOutput({ allow: false, reason: 'why' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'why' },
    });
    expect(JSON.parse(hookOutput({ allow: true, reason: 'ok' })).hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('the gate’s files', () => {
  it('writes the expectation 0600 with the text’s hash and never the text, and the hook claims it once', () => {
    const dir = gateDir();
    const gate = createRelayGate({ dir });
    gate.prepare();
    expect(gate.pending(ID)).toBe(false);
    gate.expect(ID, { request: REQUEST, to: TO, text: TEXT, expiresAt: 1_900_000_000_000 });
    expect(gate.pending(ID)).toBe(true);
    const file = expectationPath(dir, ID);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const body = readFileSync(file, 'utf8');
    expect(JSON.parse(body)).toEqual({ v: 1, request: REQUEST, to: TO, sha256: textHash(TEXT), expiresAt: 1_900_000_000_000 });
    expect(body).not.toContain('Please run');
    expect(claimExpectation(dir, ID)).toMatchObject({ request: REQUEST, to: TO });
    expect(gate.pending(ID)).toBe(false);
    expect(claimExpectation(dir, ID)).toBeUndefined();
    // Nothing is left behind: no claim file, no temporary file.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('replaces an earlier expectation, and clears and forgets', () => {
    const dir = gateDir();
    const gate = createRelayGate({ dir });
    gate.expect(ID, { request: REQUEST, to: TO, text: 'one', expiresAt: 1 });
    gate.expect(ID, { request: REQUEST, to: TO, text: 'two', expiresAt: 2 });
    expect(claimExpectation(dir, ID)?.sha256).toBe(textHash('two'));
    gate.expect(ID, { request: REQUEST, to: TO, text: 'three', expiresAt: 3 });
    gate.clear(ID);
    expect(gate.pending(ID)).toBe(false);
    writeFileSync(readyPath(dir, ID), '{}');
    expect(gate.isReady(ID)).toBe(true);
    gate.forget(ID);
    expect(gate.isReady(ID)).toBe(false);
  });

  it('doesn’t read an expectation through a symlink, or one that isn’t one', () => {
    const dir = gateDir();
    const elsewhere = path.join(path.dirname(dir), 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify(expectation()));
    symlinkSync(elsewhere, expectationPath(dir, ID));
    expect(claimExpectation(dir, ID)).toBeUndefined();
    writeFileSync(expectationPath(dir, ID), '{"v":1}');
    expect(claimExpectation(dir, ID)).toBeUndefined();
  });

  it('refuses a gate directory other users can open', () => {
    const dir = gateDir();
    chmodSync(dir, 0o755);
    expect(() => createRelayGate({ dir }).prepare()).toThrow(/other users/);
  });

  it('deletes only its own files left by an earlier run', () => {
    const dir = gateDir();
    const now = Date.now();
    const old = (name: string) => {
      writeFileSync(path.join(dir, name), '');
      utimesSync(path.join(dir, name), new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000));
    };
    old(`${ID}.ready`);
    old(`${ID}.claim-abc123`);
    old('someone-elses.txt');
    writeFileSync(path.join(dir, `${'f'.repeat(32)}.expect`), '');
    expect(removeStaleGateFiles(dir, now).sort()).toEqual([`${ID}.claim-abc123`, `${ID}.ready`]);
    expect(readdirSync(dir).sort()).toEqual(['f'.repeat(32) + '.expect', 'someone-elses.txt']);
  });
});

describe('gateSettings', () => {
  it('installs the hook in exec form, with no shell, failing closed, for SendMessage and at SessionStart', () => {
    const settings = JSON.parse(gateSettings({ node: "/opt/my node's/bin/node", script: '/x/relayGateHook.mjs', dir: '/h/relay-gate', id: ID }));
    const hook = { type: 'command', command: "/opt/my node's/bin/node", args: ['/x/relayGateHook.mjs', '/h/relay-gate', ID], timeout: 10 };
    expect(settings).toEqual({
      hooks: {
        SessionStart: [{ hooks: [hook] }],
        PreToolUse: [{ matcher: 'SendMessage', hooks: [{ ...hook, onFailure: 'block' }] }],
      },
    });
  });

  it('points at the hook script next to the gate module', () => {
    expect(path.basename(gateScriptPath())).toBe('relayGateHook.mjs');
    expect(existsSync(gateScriptPath())).toBe(true);
  });
});

describe('the hook, as Claude Code runs it', () => {
  /** Runs the script in exec form, as the relay's settings say, with `input` as JSON on stdin. */
  function hook(dir: string, input: unknown, args: string[] = [dir, ID]) {
    const result = spawnSync(process.execPath, [gateScriptPath(), ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', cwd: os.tmpdir() });
    return { status: result.status, stdout: result.stdout, decision: result.stdout === '' ? undefined : JSON.parse(result.stdout).hookSpecificOutput };
  }

  it('marks the gate ready at SessionStart, and prints nothing', () => {
    const dir = gateDir();
    const result = hook(dir, { hook_event_name: 'SessionStart', source: 'startup' });
    expect(result).toMatchObject({ status: 0, stdout: '' });
    expect(statSync(readyPath(dir, ID)).mode & 0o777).toBe(0o600);
  });

  it('allows the expected call once, then denies the same call again', () => {
    const dir = gateDir();
    createRelayGate({ dir }).expect(ID, { request: REQUEST, to: TO, text: TEXT, expiresAt: Date.now() + 60_000 });
    const first = hook(dir, preToolUse(call()));
    expect(first.status).toBe(0);
    expect(first.decision).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
    const second = hook(dir, preToolUse(call()));
    expect(second.decision).toMatchObject({ permissionDecision: 'deny' });
    expect(second.decision.permissionDecisionReason).toMatch(/no request waiting/);
  });

  it('denies a call that doesn’t match, and that uses up the expectation', () => {
    const dir = gateDir();
    createRelayGate({ dir }).expect(ID, { request: REQUEST, to: TO, text: TEXT, expiresAt: Date.now() + 60_000 });
    expect(hook(dir, preToolUse(call({ message: 'forged' }))).decision).toMatchObject({ permissionDecision: 'deny' });
    expect(hook(dir, preToolUse(call())).decision).toMatchObject({ permissionDecision: 'deny' });
  });

  it('always prints a denial, never nothing, for input it can’t use', () => {
    const dir = gateDir();
    for (const input of ['not json', '', JSON.stringify({ hook_event_name: 'PreToolUse' })]) {
      const result = hook(dir, input);
      expect(result.status).toBe(0);
      expect(result.decision).toMatchObject({ permissionDecision: 'deny' });
    }
    expect(hook(dir, preToolUse(call()), [dir, 'not-an-id']).decision).toMatchObject({ permissionDecision: 'deny' });
    expect(hook(dir, preToolUse(call()), ['relative/dir', ID]).decision).toMatchObject({ permissionDecision: 'deny' });
    expect(hook(dir, 'x'.repeat(1024 * 1024 + 1)).decision.permissionDecisionReason).toMatch(/too large/);
  });

  it('denies when the gate directory isn’t private, and doesn’t mark it ready', () => {
    const dir = gateDir();
    createRelayGate({ dir }).expect(ID, { request: REQUEST, to: TO, text: TEXT, expiresAt: Date.now() + 60_000 });
    chmodSync(dir, 0o750);
    expect(hook(dir, preToolUse(call())).decision).toMatchObject({ permissionDecision: 'deny' });
    expect(hook(dir, { hook_event_name: 'SessionStart' }).status).not.toBe(0);
    expect(existsSync(readyPath(dir, ID))).toBe(false);
  });

  it('runHook decides the same way without a process', () => {
    const dir = gateDir();
    expect(JSON.parse(runHook([dir, ID], JSON.stringify(preToolUse(call())), Date.now())!).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
