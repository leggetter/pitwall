// The supervisor's approvals in memory (M5, W115): cards, their one answer, expiry, withdrawal, limits,
// spawn_session's one-time passes and the notes for its next message. Made-up text only.
import { describe, expect, it } from 'vitest';
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

  it('lets one spawn_session call through per pass, by tool_use_id and exactly the input allowed, within PASS_MS', () => {
    let now = NOW;
    const queue = createApprovalQueue({ now: () => now });
    queue.grantPass('toolu_a', { directory: '/made-up/work/repo', prompt: 'Go.' });
    expect(queue.takePass(undefined, { directory: '/made-up/work/repo', prompt: 'Go.' })).toBeUndefined();
    expect(queue.takePass('toolu_b', { directory: '/made-up/work/repo', prompt: 'Go.' })).toBeUndefined();
    // Keys in another order are the same input.
    expect(queue.takePass('toolu_a', { prompt: 'Go.', directory: '/made-up/work/repo' })).toEqual({ directory: '/made-up/work/repo', prompt: 'Go.' });
    expect(queue.takePass('toolu_a', { directory: '/made-up/work/repo', prompt: 'Go.' })).toBeUndefined();
    queue.grantPass('toolu_c', { directory: '/x', prompt: 'Go.' });
    expect(queue.takePass('toolu_c', { directory: '/x', prompt: 'Other.' })).toBeUndefined();
    expect(queue.takePass('toolu_c', { directory: '/x', prompt: 'Go.' })).toBeUndefined();
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
