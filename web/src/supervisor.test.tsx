// The supervisor's rules in the web UI (M5, W114): its place in the URL beside ?session= and ?pr=, the
// snapshot's state read defensively, the words for its states, its working line, and what each answer
// to a request means. Made-up sessions, ids and text only.

import { describe, expect, it, vi } from 'vitest';
import { SUPERVISOR_MESSAGE_PATH, SUPERVISOR_NEW_CONVERSATION_PATH, supervisorApprovalPath, WORK_PROFILES_TOTAL_MAX, type ConversationEntry, type SupervisorApproval } from '../../src/shared/protocol.js';
import { createApiClient, type FetchLike } from './api.js';
import { supervisorStripText } from './components/AppStrip.js';
import { withPr } from './openPr.js';
import { supervisorLast, withSession } from './openSession.js';
import {
  APPROVAL_GONE,
  approvalTitle,
  asSupervisorState,
  codeParts,
  costText,
  decideApproval,
  heldCommand,
  modelName,
  newConversationBlocked,
  newSupervisorConversation,
  RESUME_BYPASS_WARNING,
  resumeBypassed,
  resumeLaunchText,
  resumePermissionText,
  resumeWhereLead,
  typedPromptNotes,
  parseSupervisor,
  sendOutcome,
  sendToSupervisor,
  STARTING_STEP,
  supervisorWorkingLine,
  withSupervisor,
} from './supervisor.js';
import { THINKING } from './working.js';

const AT = '2026-10-29T10:00:00.000Z';
const LATER = '2026-10-29T10:29:00.000Z';
const message = { id: 'a1', kind: 'message', to: 'pitwall-test-api', text: 'Please rerun the made-up tests.', at: AT, expiresAt: LATER };
const spawn = { id: 'a2', kind: 'spawn', directory: '/Users/example/code/demo-app', name: 'pr-57', prompt: 'Review the made-up PR.', at: AT, expiresAt: LATER };
const resume = {
  id: 'a3',
  kind: 'resume',
  sessionId: '00000000-0000-4000-8000-000000000127',
  name: 'pitwall-test-precision',
  directory: '/Users/example/code/demo-app',
  text: 'The user asked me to pass this on: go on.',
  at: AT,
  expiresAt: LATER,
  lastActivityAt: AT,
  sameName: 2,
  permission: { kind: 'mode', mode: 'plan' },
};

describe('its place in the URL', () => {
  it('is ?supervisor, with no value, after the selection', () => {
    expect(withSupervisor('?view=all', true)).toBe('?view=all&supervisor');
    expect(withSupervisor('', true)).toBe('?supervisor');
    expect(parseSupervisor('?view=all&supervisor')).toBe(true);
    expect(withSupervisor('?view=all&supervisor', false)).toBe('?view=all');
  });

  it('opens beside an open session or PR, which stay, and either opened keeps it, last (W177)', () => {
    expect(withSupervisor('?repo=/Users/example/code&session=abc', true)).toBe('?repo=/Users/example/code&session=abc&supervisor');
    expect(withSupervisor('?view=prs&pr=example/demo-app/57', true)).toBe('?view=prs&pr=example/demo-app/57&supervisor');
    expect(withSession('?view=all&supervisor', 'abc')).toBe('?view=all&session=abc&supervisor');
    expect(withSession('?view=all&session=abc&supervisor', 'def')).toBe('?view=all&session=def&supervisor');
    expect(withPr('?view=all&supervisor', 'example/demo-app/57')).toBe('?view=all&pr=example/demo-app/57&supervisor');
    // A PR opened still takes a session's place, and a session a PR's, the panel kept.
    expect(withPr('?view=all&session=abc&supervisor', 'example/demo-app/57')).toBe('?view=all&pr=example/demo-app/57&supervisor');
    expect(withSession('?view=all&pr=example/demo-app/57&supervisor', 'abc')).toBe('?view=all&session=abc&supervisor');
    // Closing a session or a PR leaves it alone; closing it leaves them.
    expect(withSession('?view=all&session=abc&supervisor', undefined)).toBe('?view=all&supervisor');
    expect(withPr('?view=all&pr=example/demo-app/57&supervisor', undefined)).toBe('?view=all&supervisor');
    expect(withSupervisor('?view=all&session=abc&supervisor', false)).toBe('?view=all&session=abc');
    // Without it, nothing is added.
    expect(supervisorLast('?view=all&session=abc')).toBe('?view=all&session=abc');
    expect(supervisorLast('?supervisor&view=all')).toBe('?view=all&supervisor');
  });

  it('is open whatever else the URL opens beside it', () => {
    expect(parseSupervisor('?supervisor&session=abc')).toBe(true);
    expect(parseSupervisor('?view=all&pr=example/demo-app/57&supervisor')).toBe(true);
    expect(parseSupervisor('?view=all&supervisor=')).toBe(true);
    expect(parseSupervisor('?view=all')).toBe(false);
  });
});

describe('the snapshot’s state, read defensively', () => {
  it('keeps what it knows how to show', () => {
    expect(asSupervisorState({ status: 'idle', sessionId: 's1', approvals: [message, spawn, resume], lastTurnAt: AT, costUsd: 0.04 })).toEqual({
      status: 'idle',
      sessionId: 's1',
      approvals: [message, spawn, resume],
      lastTurnAt: AT,
      costUsd: 0.04,
    });
  });

  it('is no supervisor for anything that isn’t a state, as with --no-supervisor', () => {
    expect(asSupervisorState(undefined)).toBeUndefined();
    expect(asSupervisorState({ status: 'dreaming', approvals: [] })).toBeUndefined();
    expect(asSupervisorState([])).toBeUndefined();
  });

  it('leaves out approvals that aren’t well formed, and each id twice', () => {
    const state = asSupervisorState({
      status: 'working',
      approvals: [message, { ...message, text: 3 }, { ...spawn, id: 'a1' }, { ...spawn, kind: 'delete' }, { ...spawn, id: '' }, { ...spawn, expiresAt: 'soon' }, spawn],
    });
    expect(state?.approvals.map((each) => each.id)).toEqual(['a1', 'a2']);
  });

  it('drops a cost that isn’t one, an empty error, and a time that isn’t one', () => {
    expect(asSupervisorState({ status: 'failed', approvals: 'none', costUsd: -1, error: ' ', lastTurnAt: 'today' })).toEqual({ status: 'failed', approvals: [] });
  });

  it('keeps its context as a whole, positive number of tokens, and drops anything else (W136)', () => {
    expect(asSupervisorState({ status: 'idle', approvals: [], contextTokens: 84_010 })?.contextTokens).toBe(84_010);
    for (const contextTokens of [0, -5, 1.5, '84000', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, null]) {
      expect(asSupervisorState({ status: 'idle', approvals: [], contextTokens }), String(contextTokens)).toEqual({ status: 'idle', approvals: [] });
    }
  });
});

describe('New conversation (W136)', () => {
  it('is off, saying why, while the server would refuse it: held, starting, working, or drafts waiting', () => {
    expect(newConversationBlocked({ status: 'idle', approvals: [] })).toBeUndefined();
    expect(newConversationBlocked({ status: 'off', approvals: [] })).toBeUndefined();
    expect(newConversationBlocked({ status: 'failed', approvals: [] })).toBeUndefined();
    expect(newConversationBlocked({ status: 'held', approvals: [] })).toBe('Another session has its conversation. Free it first.');
    expect(newConversationBlocked({ status: 'starting', approvals: [] })).toBe('It is starting. Wait until it has started.');
    expect(newConversationBlocked({ status: 'working', approvals: [] })).toBe('It is working on a turn. Stop it, or wait for it to end.');
    expect(newConversationBlocked({ status: 'idle', approvals: [message as SupervisorApproval] })).toBe('A draft waits for you from this conversation. Answer it first.');
    expect(newConversationBlocked({ status: 'idle', approvals: [message, spawn] as SupervisorApproval[] })).toBe('2 drafts wait for you from this conversation. Answer them first.');
  });

  it('POSTs SUPERVISOR_NEW_CONVERSATION_PATH with no body of its own, and says why a refusal was, in pitwall’s words', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ ok: false, error: 'A draft from this conversation waits for you.' }), { status: 409 }));
    const api = createApiClient({ apiKey: 'k'.repeat(43), fetch });
    expect(await newSupervisorConversation(api)).toEqual({ kind: 'failed', status: 409, error: "Couldn't start a new conversation. A draft from this conversation waits for you." });
    expect(fetch.mock.calls[0]![0]).toBe(SUPERVISOR_NEW_CONVERSATION_PATH);
    expect(fetch.mock.calls[0]![1].method).toBe('POST');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await newSupervisorConversation(api)).toEqual({ kind: 'done' });
  });
});

describe('its words', () => {
  it('says what this run has cost', () => {
    expect(costText(undefined)).toBeUndefined();
    expect(costText(0.001)).toBe('Under $0.01 this run');
    expect(costText(0.0425)).toBe('$0.04 this run');
    expect(costText(1.5)).toBe('$1.50 this run');
  });

  it('finds the claude stop command a held error names, and nothing else', () => {
    expect(heldCommand('A background session holds its conversation. Stop it with `claude stop 1a2b3c4d`, then start it.')).toBe('claude stop 1a2b3c4d');
    expect(heldCommand('Run claude stop 1a2b3c4d; rm -rf ~ first.')).toBe('claude stop 1a2b3c4d');
    expect(heldCommand('No command here.')).toBeUndefined();
    // As src/supervisor/supervisor.ts's heldError() words it.
    expect(heldCommand("A background session is running the supervisor's conversation, so pitwall can't resume it. Run `claude stop ab_12-cd` to hand it back, then press Start.")).toBe('claude stop ab_12-cd');
    expect(heldCommand(undefined)).toBeUndefined();
  });

  it('names what an approval would do', () => {
    expect(approvalTitle(message as never)).toBe('Message to pitwall-test-api');
    expect(approvalTitle(spawn as never)).toBe('New session in ~/code/demo-app, named pr-57');
    expect(approvalTitle({ ...spawn, name: undefined } as never)).toBe('New session in ~/code/demo-app');
    expect(approvalTitle(resume as never)).toBe('Resume pitwall-test-precision and send');
  });

  it('reads a resume card only with the listed session’s id, name and directory (W127)', () => {
    for (const bad of [{ ...resume, sessionId: '' }, { ...resume, name: ' ' }, { ...resume, directory: '' }, { ...resume, text: 7 }]) {
      expect(asSupervisorState({ status: 'idle', approvals: [bad] })?.approvals).toEqual([]);
    }
  });

  it('reads a resume card’s last activity, same-name count and permission mode, each to the safe side when it isn’t as pitwall sends it (W129)', () => {
    const read = (extra: Record<string, unknown>) => asSupervisorState({ status: 'idle', approvals: [{ ...resume, ...extra }] })?.approvals[0];
    expect(read({})).toEqual(resume);
    const { lastActivityAt: _, ...withoutActivity } = resume;
    expect(read({ lastActivityAt: 'not a time' })).toEqual(withoutActivity);
    for (const sameName of [0, -2, 1.5, '3', undefined]) expect(read({ sameName })).toMatchObject({ sameName: 1 });
    expect(read({ permission: { kind: 'unset' } })).toMatchObject({ permission: { kind: 'unset' } });
    for (const permission of [undefined, 'plan', { kind: 'mode', mode: 'yolo' }, { kind: 'mode' }, { kind: 'other' }]) {
      expect(read({ permission })).toMatchObject({ permission: { kind: 'unknown' } });
    }
  });

  it('reads a resume card’s kept launch settings with only the fields that pass the profiles’ checks (W155)', () => {
    const read = (launch: unknown) => asSupervisorState({ status: 'idle', approvals: [{ ...resume, launch }] })?.approvals[0];
    expect(read({ profile: 'Review', model: 'sonnet', effort: 'high', subagentModel: 'sonnet' })).toMatchObject({ launch: { profile: 'Review', model: 'sonnet', effort: 'high', subagentModel: 'sonnet' } });
    expect(read({ profile: 'Bad\nname', custom: 'yes', model: 'opus --x', effort: 'high', subagentModel: 'opusplan' })).toMatchObject({ launch: { effort: 'high' } });
    for (const launch of [undefined, 'Review', { profile: 'Review' }, { model: 'x y' }]) expect(read(launch)).not.toHaveProperty('launch');
  });

  it('shows a card with as many profiles as the server resolves, the 4 built-ins and 30 of the config file’s, and none past that (W180, F2)', () => {
    const profiles = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Profile ${i}`, model: 'sonnet', effort: 'high', subagentModel: 'sonnet' }));
    const read = (n: number) => asSupervisorState({ status: 'idle', approvals: [{ ...resume, profiles: profiles(n) }] })?.approvals;
    expect(WORK_PROFILES_TOTAL_MAX).toBe(34);
    expect(read(WORK_PROFILES_TOTAL_MAX)?.[0]).toMatchObject({ profiles: profiles(WORK_PROFILES_TOTAL_MAX) });
    expect(read(WORK_PROFILES_TOTAL_MAX + 1)).toEqual([]);
  });
});

describe('a resume card’s lines (W129)', () => {
  it('says how many sessions share the name, only when others do', () => {
    expect(resumeWhereLead(1)).toBe('In ');
    expect(resumeWhereLead(2)).toBe('2 listed sessions have this name; this is the one in ');
  });

  it('says the model, effort and sub-agents a session started with a profile resumes on (W155)', () => {
    expect(resumeLaunchText({ profile: 'Review', model: 'sonnet', effort: 'high', subagentModel: 'sonnet' })).toBe(
      'pitwall resumes it on what it started it with, from the Review profile: model sonnet, effort high, sub-agents sonnet.',
    );
    expect(resumeLaunchText({ profile: 'Build', custom: true, model: 'haiku', effort: 'default', subagentModel: 'default' })).toBe(
      "pitwall resumes it on what it started it with, from the Build profile, customized: model haiku, effort Claude Code's default, sub-agents Claude Code's default.",
    );
  });

  it('says it resumes with its own saved settings, its permission mode included, and what pitwall knows of that mode', () => {
    expect(resumePermissionText({ kind: 'mode', mode: 'plan' })).toBe('Claude Code resumes it with its own saved settings, its permission mode included: plan.');
    expect(resumePermissionText({ kind: 'unset' })).toContain('your Claude Code settings decide it');
    expect(resumePermissionText({ kind: 'unknown' })).toBe("Claude Code resumes it with its own saved settings, its permission mode included, which pitwall can't see for this session.");
    expect(resumeBypassed({ kind: 'mode', mode: 'bypassPermissions' })).toBe(true);
    for (const mode of ['plan', 'acceptEdits', 'auto', 'default'] as const) expect(resumeBypassed({ kind: 'mode', mode })).toBe(false);
    expect(resumeBypassed({ kind: 'unknown' })).toBe(false);
    expect(RESUME_BYPASS_WARNING).toContain('no permission prompts');
  });

  it('notes a typed prompt’s slash command and @ path, and not an email address or a lone @ (I2)', () => {
    expect(typedPromptNotes('/clear then go on')).toEqual(['It starts with /, so Claude Code may run it as a slash command rather than read it.']);
    expect(typedPromptNotes('  /compact')).toHaveLength(1);
    expect(typedPromptNotes('Read @src/server/actions.ts first.')).toEqual(['It has @ before a path, so Claude Code may attach that file.']);
    expect(typedPromptNotes('@~/notes.md')).toHaveLength(1);
    expect(typedPromptNotes('/review @README.md')).toHaveLength(2);
    for (const plain of ['Mail phil@example.com about it.', 'Meet @ 5', 'Use a/b paths.', 'Go on.']) expect(typedPromptNotes(plain), plain).toEqual([]);
  });
});

describe('model names and commands in its words', () => {
  it('says a model as people do', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('something-else')).toBe('something-else');
  });

  it('splits a command in backticks out of a sentence', () => {
    expect(codeParts('Run `claude stop ab12` to hand it back.')).toEqual([
      { code: false, text: 'Run ' },
      { code: true, text: 'claude stop ab12' },
      { code: false, text: ' to hand it back.' },
    ]);
  });
});

describe('the app strip’s line', () => {
  it('says the supervisor once', () => {
    expect(supervisorStripText({ status: 'failed', approvals: [], error: 'The supervisor stopped (exit code 1).' })).toBe('The supervisor stopped (exit code 1).');
    expect(supervisorStripText({ status: 'failed', approvals: [] })).toBe("The supervisor stopped: it exited, or couldn't start.");
    expect(supervisorStripText({ status: 'held', approvals: [] })).toBe("The supervisor can't run: another session has its conversation.");
    expect(supervisorStripText({ status: 'idle', approvals: [] })).toBeUndefined();
  });
});

describe('its working line', () => {
  const entries: ConversationEntry[] = [
    { kind: 'user', text: 'Which sessions need me?', at: AT },
    { kind: 'tool', text: 'mcp__pitwall__list_sessions', toolName: 'mcp__pitwall__list_sessions', at: AT },
  ];

  it('works from the snapshot’s status, with the step from the entries', () => {
    expect(supervisorWorkingLine('working', entries, false)).toEqual({ mode: 'working', step: 'Calling pitwall list_sessions', since: AT });
    expect(supervisorWorkingLine('working', [entries[0]!], false)).toEqual({ mode: 'working', step: THINKING, since: AT });
  });

  it('says it’s starting, with no time, and nothing otherwise', () => {
    expect(supervisorWorkingLine('starting', entries, false)).toEqual({ mode: 'working', step: STARTING_STEP });
    for (const status of ['off', 'idle', 'held', 'failed'] as const) expect(supervisorWorkingLine(status, entries, false)).toEqual({ mode: 'idle' });
  });
});

describe('what a send’s answer means', () => {
  it('is sent with { ok: true }', () => {
    expect(sendOutcome({ kind: 'ok', status: 200, body: { ok: true } })).toEqual({ kind: 'sent' });
  });

  it('is not sent, with the server’s reason, when pitwall refused it', () => {
    expect(sendOutcome({ kind: 'failed', status: 409, body: { ok: false, error: 'Made up: it is held.' } })).toEqual({ kind: 'failed', uncertain: false, error: 'Not sent: Made up: it is held.' });
    expect(sendOutcome({ kind: 'failed', status: 413 })).toEqual({ kind: 'failed', uncertain: false, error: 'Not sent: pitwall refused the request (HTTP 413).' });
    // The real route's 429 and 502 say why, so pitwall knows nothing was written.
    expect(sendOutcome({ kind: 'failed', status: 429, body: { ok: false, error: 'The supervisor has messages waiting already. Send this once it has answered them.' } })).toMatchObject({ uncertain: false });
    expect(sendOutcome({ kind: 'failed', status: 502, body: { ok: false, error: 'The supervisor stopped as it started (exit code 1). Press Start to try again.' } })).toEqual({
      kind: 'failed',
      uncertain: false,
      error: 'Not sent: The supervisor stopped as it started (exit code 1). Press Start to try again.',
    });
  });

  it('may have gone with no answer, a server error, or a success pitwall can’t read', () => {
    for (const result of [{ kind: 'failed' } as const, { kind: 'failed', status: 502 } as const, { kind: 'ok', status: 200, body: {} } as const]) {
      const outcome = sendOutcome(result);
      expect(outcome).toMatchObject({ kind: 'failed', uncertain: true });
      expect(outcome.kind === 'failed' && outcome.error).toContain('Check its conversation before sending again.');
    }
  });

  it('sends the text as typed, without blank lines before it or space after it', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const api = createApiClient({ apiKey: 'k'.repeat(43), fetch });
    expect(await sendToSupervisor(api, '\n\n  What next?  \n')).toEqual({ kind: 'sent' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(SUPERVISOR_MESSAGE_PATH);
    expect(JSON.parse(String(init.body))).toEqual({ text: '  What next?' });
  });
});

describe('what a decision’s answer means', () => {
  const answer = (status: number, body: unknown) => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status }));
    return { fetch, api: createApiClient({ apiKey: 'k'.repeat(43), fetch }) };
  };

  it('POSTs the decision to the approval’s path', async () => {
    const { fetch, api } = answer(200, { ok: true });
    expect(await decideApproval(api, 'a/1', { decision: 'edit', text: 'Rerun them.' })).toEqual({ kind: 'decided' });
    expect(fetch.mock.calls[0]![0]).toBe(supervisorApprovalPath('a/1'));
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual({ decision: 'edit', text: 'Rerun them.' });
  });

  it('is gone with a 404, and a failure in pitwall’s words otherwise', async () => {
    expect(await decideApproval(answer(404, { ok: false, error: 'Gone.' }).api, 'a1', { decision: 'send' })).toEqual({ kind: 'gone' });
    expect(await decideApproval(answer(409, { ok: false, error: 'Made up: the session left.' }).api, 'a1', { decision: 'decline' })).toEqual({
      kind: 'failed',
      error: "Couldn't decline it. Made up: the session left.",
    });
    expect(await decideApproval(answer(500, {}).api, 'a1', { decision: 'send' })).toEqual({ kind: 'failed', error: "Couldn't send it (HTTP 500). If this card is still here, try again." });
    expect(APPROVAL_GONE).toMatch(/no longer waiting/);
  });
});
