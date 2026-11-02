// The supervisor's rules in the web UI (M5, W114): its place in the URL beside ?session= and ?pr=, the
// snapshot's state read defensively, the words for its states, its working line, and what each answer
// to a request means. Made-up sessions, ids and text only.

import { describe, expect, it, vi } from 'vitest';
import { SUPERVISOR_MESSAGE_PATH, supervisorApprovalPath, type ConversationEntry } from '../../src/shared/protocol.js';
import { createApiClient, type FetchLike } from './api.js';
import { supervisorStripText } from './components/AppStrip.js';
import { withPr } from './openPr.js';
import { withSession } from './openSession.js';
import {
  APPROVAL_GONE,
  approvalTitle,
  asSupervisorState,
  codeParts,
  costText,
  decideApproval,
  heldCommand,
  modelName,
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
const resume = { id: 'a3', kind: 'resume', sessionId: '00000000-0000-4000-8000-000000000127', name: 'pitwall-test-precision', directory: '/Users/example/code/demo-app', text: 'The user asked me to pass this on: go on.', at: AT, expiresAt: LATER };

describe('its place in the URL', () => {
  it('is ?supervisor, with no value, after the selection', () => {
    expect(withSupervisor('?view=all', true)).toBe('?view=all&supervisor');
    expect(withSupervisor('', true)).toBe('?supervisor');
    expect(parseSupervisor('?view=all&supervisor')).toBe(true);
    expect(withSupervisor('?view=all&supervisor', false)).toBe('?view=all');
  });

  it('takes the place of an open session or PR, and either takes its place', () => {
    expect(withSupervisor('?repo=/Users/example/code&session=abc', true)).toBe('?repo=/Users/example/code&supervisor');
    expect(withSupervisor('?view=prs&pr=example/demo-app/57', true)).toBe('?view=prs&supervisor');
    expect(withSession('?view=all&supervisor', 'abc')).toBe('?view=all&session=abc');
    expect(withPr('?view=all&supervisor', 'example/demo-app/57')).toBe('?view=all&pr=example/demo-app/57');
    // Closing a session or a PR leaves it alone.
    expect(withSession('?view=all&supervisor', undefined)).toBe('?view=all&supervisor');
  });

  it("isn't open when a session or a PR is in the URL too, as only one typed by hand can be", () => {
    expect(parseSupervisor('?supervisor&session=abc')).toBe(false);
    expect(parseSupervisor('?supervisor&pr=example/demo-app/57')).toBe(false);
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
