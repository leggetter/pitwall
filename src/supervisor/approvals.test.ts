// The supervisor's approvals in memory (M5, W115): cards, their one answer, expiry, withdrawal, limits,
// spawn_session's one-time passes and the notes for its next message. Made-up text only.
import { describe, expect, it } from 'vitest';
import { SUPERVISOR_HANDOFFS_MAX } from '../shared/protocol.js';
import { canonicalJson, createApprovalQueue, MAX_PENDING_APPROVALS, PASS_MS, timeoutMessage } from './approvals.js';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const message = (toolUseId: string) => ({ draft: { kind: 'message' as const, to: 'pitwall-test-target', text: 'hello' }, toolName: 'SendMessage', toolUseId, input: { to: 'pitwall-test-target', message: 'hello' } });

describe('the approval queue', () => {
  it('answers each card once, and lets one decision run at a time', async () => {
    const queue = createApprovalQueue({ now: () => NOW });
    const added = queue.add(message('toolu_1'));
    if (!added.ok) throw new Error('not added');
    expect(queue.list()).toEqual([{ id: added.id, kind: 'message', to: 'pitwall-test-target', text: 'hello', at: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 29 * 60_000).toISOString() }]);
    expect(queue.begin(added.id)).toMatchObject({ toolUseId: 'toolu_1', input: { message: 'hello' } });
    expect(queue.begin(added.id)).toBe('busy');
    queue.end(added.id);
    expect(queue.settle(added.id, { behavior: 'deny', message: 'no' })).toBe(true);
    expect(queue.settle(added.id, { behavior: 'allow', updatedInput: {} })).toBe(false);
    expect(await added.answer).toEqual({ behavior: 'deny', message: 'no' });
    expect(queue.begin(added.id)).toBeUndefined();
  });

  it('denies a card that runs out, one withdrawn by its signal, and every card on cancelAll', async () => {
    const queue = createApprovalQueue({ timeoutMs: 20 });
    const late = queue.add(message('toolu_late'));
    const abort = new AbortController();
    const withdrawn = queue.add(message('toolu_gone'), abort.signal);
    const closing = queue.add(message('toolu_close'));
    if (!late.ok || !withdrawn.ok || !closing.ok) throw new Error('not added');
    abort.abort();
    expect(await withdrawn.answer).toMatchObject({ behavior: 'deny' });
    queue.cancelAll('closing');
    expect(await closing.answer).toEqual({ behavior: 'deny', message: 'closing' });
    const timed = createApprovalQueue({ timeoutMs: 20 }).add(message('toolu_t'));
    if (!timed.ok) throw new Error('not added');
    expect(await timed.answer).toEqual({ behavior: 'deny', message: timeoutMessage(20) });
    expect(queue.list()).toEqual([]);
  });

  it('refuses a second card for the same call, more than MAX_PENDING_APPROVALS, and a signal already aborted', () => {
    const queue = createApprovalQueue();
    expect(queue.add(message('toolu_dup')).ok).toBe(true);
    expect(queue.add(message('toolu_dup'))).toMatchObject({ ok: false });
    for (let i = 1; i < MAX_PENDING_APPROVALS; i++) expect(queue.add(message(`toolu_${i}`)).ok).toBe(true);
    expect(queue.add(message('toolu_over'))).toMatchObject({ ok: false, error: expect.stringContaining('drafts are waiting') });
    const abort = new AbortController();
    abort.abort();
    expect(createApprovalQueue().add(message('toolu_x'), abort.signal)).toMatchObject({ ok: false });
    queue.cancelAll('done');
  });

  it('lets one spawn_session call through per pass, keyed on exactly the input allowed, within PASS_MS, and by its tool_use_id when the call has one', () => {
    let now = NOW;
    const queue = createApprovalQueue({ now: () => now });
    const input = { directory: '/made-up/work/repo', prompt: 'Go.' };
    queue.grantPass('toolu_a', input);
    // Another call's id, or other arguments: nothing, and the pass stays.
    expect(queue.takePass('toolu_b', input)).toBeUndefined();
    expect(queue.takePass(undefined, { ...input, prompt: 'Other.' })).toBeUndefined();
    // Keys in another order are the same input; with no id, the arguments alone.
    expect(queue.takePass(undefined, { prompt: 'Go.', directory: '/made-up/work/repo' })).toEqual(input);
    expect(queue.takePass(undefined, input)).toBeUndefined();
    expect(queue.takePass('toolu_a', input)).toBeUndefined();
    // With its id: spent even when the arguments differ.
    queue.grantPass('toolu_c', { directory: '/x', prompt: 'Go.' });
    expect(queue.takePass('toolu_c', { directory: '/x', prompt: 'Other.' })).toBeUndefined();
    expect(queue.takePass(undefined, { directory: '/x', prompt: 'Go.' })).toBeUndefined();
    // Taken back unused, and run out.
    const revoked = queue.grantPass('toolu_e', input);
    queue.revokePass(revoked);
    expect(queue.takePass(undefined, input)).toBeUndefined();
    queue.grantPass('toolu_d', { directory: '/x', prompt: 'Go.' });
    now += PASS_MS;
    expect(queue.takePass('toolu_d', { directory: '/x', prompt: 'Go.' })).toBeUndefined();
  });

  it('keeps the newest notes for the next message, once', () => {
    const queue = createApprovalQueue();
    for (let i = 1; i <= 7; i++) queue.note(`note ${i}`);
    expect(queue.takeNotes()).toEqual(['note 3', 'note 4', 'note 5', 'note 6', 'note 7']);
    expect(queue.takeNotes()).toEqual([]);
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe('{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}');
  });
});

describe('hand-offs (W124)', () => {
  it('records each, oldest first, keeps the newest SUPERVISOR_HANDOFFS_MAX, and tells its listeners', () => {
    let ids = 0;
    const queue = createApprovalQueue({ now: () => Date.parse('2026-11-02T12:00:00.000Z'), randomId: () => `h${++ids}` });
    let told = 0;
    queue.subscribe(() => told++);
    queue.handoff({ kind: 'spawn', name: 'pitwall-test-a', shortId: 'abc12345' });
    expect(queue.handoffs()).toEqual([{ id: 'h1', kind: 'spawn', name: 'pitwall-test-a', shortId: 'abc12345', at: '2026-11-02T12:00:00.000Z' }]);
    expect(told).toBe(1);
    for (let index = 0; index < SUPERVISOR_HANDOFFS_MAX + 5; index++) queue.handoff({ kind: 'message', name: `pitwall-test-${index}` });
    const kept = queue.handoffs();
    expect(kept).toHaveLength(SUPERVISOR_HANDOFFS_MAX);
    expect(kept.at(-1)!.name).toBe(`pitwall-test-${SUPERVISOR_HANDOFFS_MAX + 4}`);
    // A copy: changing it changes nothing.
    kept[0]!.name = 'changed';
    expect(queue.handoffs()[0]!.name).not.toBe('changed');
  });
});

describe('forgetConversation() (W136)', () => {
  it('drops the hand-offs, passes and notes of the conversation that’s left, tells its listeners, and leaves cards alone', () => {
    const queue = createApprovalQueue({ now: () => Date.parse('2026-11-04T12:00:00.000Z') });
    queue.handoff({ kind: 'spawn', name: 'pitwall-test-a', shortId: 'abc12345' });
    queue.note('the user edited your message');
    queue.grantPass('toolu_p', { directory: '/x', prompt: 'Go.' });
    const added = queue.add(message('toolu_c'));
    if (!added.ok) throw new Error('not added');
    let told = 0;
    queue.subscribe(() => told++);
    queue.forgetConversation();
    expect(queue.handoffs()).toEqual([]);
    expect(queue.takeNotes()).toEqual([]);
    expect(queue.takePass('toolu_p', { directory: '/x', prompt: 'Go.' })).toBeUndefined();
    expect(queue.list()).toHaveLength(1);
    expect(told).toBe(1);
    // Nothing left to drop: nothing to tell.
    queue.forgetConversation();
    expect(told).toBe(1);
    queue.cancelAll('made-up end of test');
  });
});
