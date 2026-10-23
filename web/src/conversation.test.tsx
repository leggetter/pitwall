import { describe, expect, it, vi } from 'vitest';
import { conversationPath, type ConversationEntry, type ConversationPage } from '../../src/shared/protocol.js';
import { createApiClient, type FetchLike } from './api.js';
import {
  asConversationPage,
  chosenAnswer,
  conversationRows,
  countAdded,
  entryKey,
  entryKeys,
  foldOpen,
  getConversation,
  KEY_TEXT_MAX,
  mergeNewest,
  prependOlder,
  STALE_CURSOR_STATUS,
  toggleFold,
} from './conversation.js';

// Made-up entries only.

const at = (second: number) => `2026-03-02T11:00:${String(second).padStart(2, '0')}.000Z`;
const userEntry = (second: number, text = `prompt ${second}`): ConversationEntry => ({ kind: 'user', at: at(second), text });
const reply = (second: number, text: string): ConversationEntry => ({ kind: 'assistant', at: at(second), text });
const tool = (second: number, toolError?: boolean): ConversationEntry => ({
  kind: 'tool',
  at: at(second),
  text: 'Bash: npm test',
  toolName: 'Bash',
  ...(toolError === undefined ? {} : { toolError }),
});

describe('entryKey', () => {
  it("doesn't count an assistant entry's text, or a tool entry's error, which change as the session goes on", () => {
    expect(entryKey(reply(1, 'Part one.'))).toBe(entryKey(reply(1, 'Part one.\nPart two.')));
    expect(entryKey(tool(2))).toBe(entryKey(tool(2, true)));
    expect(entryKey(userEntry(3, 'a'))).not.toBe(entryKey(userEntry(3, 'b')));
    expect(entryKey(userEntry(3))).not.toBe(entryKey({ ...userEntry(3), kind: 'notice' }));
  });

  it("counts an undated assistant entry's text, so undated entries stay apart", () => {
    expect(entryKey({ kind: 'assistant', text: 'a' })).not.toBe(entryKey({ kind: 'assistant', text: 'b' }));
  });

  it("is the same for an entry sent in full and cut to the server's 512 characters once a page's budget is spent (W36)", () => {
    const full = userEntry(4, `${'a long prompt, '.repeat(300)}end`);
    const cut: ConversationEntry = { ...full, text: full.text.slice(0, 512), truncated: true };
    expect(KEY_TEXT_MAX).toBeLessThan(512);
    expect(entryKey(cut)).toBe(entryKey(full));
    const peer: ConversationEntry = { kind: 'cross-session', at: at(5), from: 'pitwall-test-sup', text: `${'x'.repeat(600)} full`, markdown: true };
    expect(entryKey({ ...peer, text: peer.text.slice(0, 512), truncated: true })).toBe(entryKey(peer));
    // Entries that differ within the start still differ.
    expect(entryKey(userEntry(4, 'b'.repeat(400)))).not.toBe(entryKey(userEntry(4, 'c'.repeat(400))));
  });
});

describe('mergeNewest', () => {
  it('appends new entries without duplicating the ones on screen', () => {
    const current = [userEntry(1), reply(2, 'Done.'), userEntry(3)];
    const newest = [reply(2, 'Done.'), userEntry(3), userEntry(4), reply(5, 'Again.')];
    expect(mergeNewest(current, newest)).toEqual([userEntry(1), reply(2, 'Done.'), userEntry(3), userEntry(4), reply(5, 'Again.')]);
  });

  it("takes the newest copy of an entry that grew or got its tool's result", () => {
    const current = [userEntry(1), reply(2, 'Part one.'), tool(3)];
    const newest = [reply(2, 'Part one.\nPart two.'), tool(3, true)];
    expect(mergeNewest(current, newest)).toEqual([userEntry(1), reply(2, 'Part one.\nPart two.'), tool(3, true)]);
  });

  it('keeps the older pages loaded above the newest page', () => {
    const older = Array.from({ length: 5 }, (_, i) => userEntry(i));
    const current = [...older, userEntry(10), userEntry(11)];
    expect(mergeNewest(current, [userEntry(10), userEntry(11), userEntry(12)])).toEqual([...current, userEntry(12)]);
  });

  it('meets what is shown at an entry the newest page carries cut short, once its budget is spent (W36)', () => {
    const long = userEntry(2, 'p'.repeat(5000));
    const current = [userEntry(1), long, reply(3, 'Done.')];
    const leaner = { ...long, text: long.text.slice(0, 512), truncated: true };
    expect(mergeNewest(current, [leaner, reply(3, 'Done.'), userEntry(4)])).toEqual([userEntry(1), leaner, reply(3, 'Done.'), userEntry(4)]);
  });

  it('says to replace the entries when the newest page does not overlap them', () => {
    expect(mergeNewest([userEntry(1), userEntry(2)], [userEntry(40), userEntry(41)])).toBeUndefined();
    expect(mergeNewest([], [userEntry(1)])).toBeUndefined();
  });

  it('keeps the entries when the newest page is empty', () => {
    expect(mergeNewest([userEntry(1)], [])).toEqual([userEntry(1)]);
  });
});

describe('prependOlder', () => {
  it('puts the older page first, dropping any entry already on screen', () => {
    expect(prependOlder([userEntry(1), userEntry(2)], [userEntry(3)])).toEqual([userEntry(1), userEntry(2), userEntry(3)]);
    expect(prependOlder([userEntry(1), userEntry(2)], [userEntry(2), userEntry(3)])).toEqual([userEntry(1), userEntry(2), userEntry(3)]);
  });
});

describe('entryKeys', () => {
  it('numbers repeated keys, so every key is unique', () => {
    const keys = entryKeys([userEntry(1), userEntry(1), userEntry(2)]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(entryKey(userEntry(1)));
  });
});

describe('countAdded', () => {
  it('counts the entries the newer list has that the shown one does not; a grown reply or a tool result is not new', () => {
    const shown = [userEntry(1), reply(2, 'Part one.'), tool(3)];
    expect(countAdded(shown, [userEntry(1), reply(2, 'Part one.\nPart two.'), tool(3, true)])).toBe(0);
    expect(countAdded(shown, [userEntry(1), reply(2, 'Part one.'), tool(3), tool(4), userEntry(5)])).toBe(2);
    expect(countAdded([], [userEntry(1)])).toBe(1);
  });
});

describe('conversationRows', () => {
  it('folds each run of two or more tool calls, keyed by its first call, and leaves a call on its own as an entry', () => {
    const entries = [tool(1), userEntry(2), tool(3), tool(4, true), tool(5), reply(6, 'Done.'), tool(7)];
    const keys = entryKeys(entries);
    const rows = conversationRows(entries);
    expect(rows.map((row) => (row.kind === 'fold' ? `fold of ${row.calls.length}` : row.entry.kind))).toEqual(['tool', 'user', 'fold of 3', 'assistant', 'tool']);
    const fold = rows[2]!;
    expect(fold.kind === 'fold' && fold.calls.map(({ key }) => key)).toEqual([keys[2], keys[3], keys[4]]);
    expect(fold.key).toBe(`fold\u0000${keys[2]}`);
    expect(rows.map((row) => row.key)).toHaveLength(new Set(rows.map((row) => row.key)).size);
  });

  it('is empty for no entries, and one fold for nothing but calls', () => {
    expect(conversationRows([])).toEqual([]);
    expect(conversationRows([tool(1), tool(2)]).map((row) => row.kind)).toEqual(['fold']);
  });

  it('never folds a message to pitwall with the tool calls around it: it ends their run (W46)', () => {
    const toPitwall: ConversationEntry = { kind: 'to-pitwall', at: at(3), text: 'Both flows.', markdown: true };
    const rows = conversationRows([tool(1), tool(2), toPitwall, tool(4), tool(5)]);
    expect(rows.map((row) => (row.kind === 'fold' ? `fold of ${row.calls.length}` : row.entry.kind))).toEqual(['fold of 2', 'to-pitwall', 'fold of 2']);
    expect(conversationRows([tool(1), toPitwall, tool(4)]).map((row) => (row.kind === 'fold' ? 'fold' : row.entry.kind))).toEqual(['tool', 'to-pitwall', 'tool']);
  });

  it('never folds a question asked in a dialog with the tool calls around it: it ends their run (W49)', () => {
    const asked: ConversationEntry = { kind: 'question', at: at(3), text: 'Which flows?', toolError: false, questions: [{ question: 'Which flows?', options: [{ label: 'Export' }] }] };
    const rows = conversationRows([tool(1), tool(2), asked, tool(4), tool(5)]);
    expect(rows.map((row) => (row.kind === 'fold' ? `fold of ${row.calls.length}` : row.entry.kind))).toEqual(['fold of 2', 'question', 'fold of 2']);
  });
});

describe('chosenAnswer (W49)', () => {
  const options = [{ label: 'Export' }, { label: 'Import' }, { label: 'Yes, retry' }];

  it('chooses the option whose label is the answer, exactly, and none without an answer', () => {
    expect(chosenAnswer({ question: 'Which?', options, answer: 'Import' })).toEqual({ chosen: new Set([1]) });
    expect(chosenAnswer({ question: 'Which?', options, answer: 'Yes, retry' })).toEqual({ chosen: new Set([2]) });
    expect(chosenAnswer({ question: 'Which?', options })).toBeUndefined();
  });

  it('shows an answer that names no label as typed: another case, a part of one, or several on a single choice', () => {
    for (const answer of ['import', 'Exp', 'Only the export job, for now.', 'Export, Import']) {
      expect(chosenAnswer({ question: 'Which?', options, answer }), answer).toEqual({ chosen: new Set(), typed: answer });
    }
    expect(chosenAnswer({ question: 'Anything else?', options: [], answer: 'No.' })).toEqual({ chosen: new Set(), typed: 'No.' });
  });

  it('chooses each label of a multi-select answer that is only labels, joined by a comma, a newline or a semicolon', () => {
    const multi = (answer: string) => chosenAnswer({ question: 'Which?', options, multiSelect: true, answer });
    expect(multi('Export, Import')).toEqual({ chosen: new Set([0, 1]) });
    expect(multi('Import,Export')).toEqual({ chosen: new Set([0, 1]) });
    expect(multi('Export\nYes, retry')).toEqual({ chosen: new Set([0, 2]) });
    expect(multi('Export; Import')).toEqual({ chosen: new Set([0, 1]) });
    expect(multi('Import')).toEqual({ chosen: new Set([1]) });
    // Anything that isn't all labels is shown as it was typed, rather than guessed at.
    expect(multi('Export, and the import job')).toEqual({ chosen: new Set(), typed: 'Export, and the import job' });
    expect(multi('Export and Import')).toEqual({ chosen: new Set(), typed: 'Export and Import' });
  });

  it('marks none for an answer that two or more options share as their label, and shows it as typed (W58)', () => {
    const twins = [{ label: 'Yes', description: 'Retry now.' }, { label: 'No' }, { label: 'Yes', description: 'Retry tonight.' }];
    expect(chosenAnswer({ question: 'Retry?', options: twins, answer: 'Yes' })).toEqual({ chosen: new Set(), typed: 'Yes' });
    // The same once trimmed, as labels are compared.
    expect(chosenAnswer({ question: 'Retry?', options: [{ label: 'Yes' }, { label: ' Yes ' }], answer: 'Yes' })).toEqual({ chosen: new Set(), typed: 'Yes' });
    // A label only one option has is still chosen.
    expect(chosenAnswer({ question: 'Retry?', options: twins, answer: 'No' })).toEqual({ chosen: new Set([1]) });
    // In a multi-select answer too: a shared label in it chooses nothing, so it's all shown as typed.
    const multi = (answer: string) => chosenAnswer({ question: 'Retry?', options: twins, multiSelect: true, answer });
    expect(multi('Yes')).toEqual({ chosen: new Set(), typed: 'Yes' });
    expect(multi('No, Yes')).toEqual({ chosen: new Set(), typed: 'No, Yes' });
    expect(multi('No')).toEqual({ chosen: new Set([1]) });
  });
});

describe('foldOpen and toggleFold', () => {
  const calls = (...seconds: number[]) => seconds.map((second) => ({ key: entryKey(tool(second)), entry: tool(second) }));

  it('opens a fold by its first call, and closes it by all of them', () => {
    const opened = toggleFold(new Set(), calls(1, 2));
    expect([...opened]).toEqual([entryKey(tool(1))]);
    expect(foldOpen(opened, calls(1, 2))).toBe(true);
    expect(toggleFold(opened, calls(1, 2)).size).toBe(0);
  });

  it('keeps a fold open while it has a call that was in an open fold: a call joining at its end or its start', () => {
    const opened = toggleFold(new Set(), calls(2, 3));
    expect(foldOpen(opened, calls(2, 3, 4))).toBe(true);
    expect(foldOpen(opened, calls(1, 2, 3))).toBe(true);
    expect(foldOpen(opened, calls(4, 5))).toBe(false);
    // Closing the grown fold forgets every call in it, so it doesn't open again.
    const closed = toggleFold(opened, calls(1, 2, 3, 4));
    expect(foldOpen(closed, calls(1, 2, 3, 4))).toBe(false);
  });
});

describe('getConversation', () => {
  const SID = '00000000-0000-4000-8000-0000000000c1';
  const API_KEY = 'k'.repeat(43);
  const PAGE: ConversationPage = {
    sessionId: SID,
    entries: [
      { kind: 'user', at: at(1), text: 'run the tests' },
      { kind: 'tool', at: at(2), text: 'Bash: npm test', toolName: 'Bash', toolError: true },
    ],
    before: 'b1',
  };
  const json = (body: unknown, status = 200) => () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  /** The app's API client, already holding an apiKey, over a fake fetch. */
  function client(response: () => Response | Promise<Response>) {
    const fetch = vi.fn<FetchLike>(async () => response());
    return { fetch, api: createApiClient({ apiKey: API_KEY, fetch }) };
  }

  it('fetches the conversation path through the API client, with the apiKey, uncached', async () => {
    const { fetch, api } = client(json(PAGE));
    expect(await getConversation(api, SID)).toEqual({ kind: 'ok', page: PAGE });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(conversationPath(SID));
    expect(init).toMatchObject({ headers: { Authorization: `Bearer ${API_KEY}` }, cache: 'no-store' });
  });

  it('passes the before cursor, encoded', async () => {
    const { fetch, api } = client(json({ sessionId: SID, entries: [] }));
    expect(await getConversation(api, SID, 'a+b/c')).toEqual({ kind: 'ok', page: { sessionId: SID, entries: [] } });
    expect(fetch.mock.calls[0]![0]).toBe(`${conversationPath(SID)}?before=a%2Bb%2Fc`);
  });

  it.each([
    [404, 'not-found'],
    [STALE_CURSOR_STATUS, 'stale'],
  ])('reports a %i as %s', async (status, kind) => {
    const { api } = client(() => new Response(null, { status }));
    expect(await getConversation(api, SID)).toEqual({ kind });
  });

  it.each([400, 500, 503])('reports a %i as failed, with its status for the page to show', async (status) => {
    const { api } = client(() => new Response(null, { status }));
    expect(await getConversation(api, SID)).toEqual({ kind: 'failed', status });
  });

  describe('a 429, too many reads at once (W31)', () => {
    const busy = (retryAfter?: string) => () => new Response(null, { status: 429, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } });
    /** A fetch that answers with each response in turn, then the last one again. */
    function answers(...responses: (() => Response)[]) {
      let call = 0;
      const fetch = vi.fn<FetchLike>(async () => responses[Math.min(call++, responses.length - 1)]!());
      return { fetch, api: createApiClient({ apiKey: API_KEY, fetch }) };
    }
    const flush = () => vi.advanceTimersByTimeAsync(0);

    it('asks once more after the Retry-After the server gave, and gets the page', async () => {
      vi.useFakeTimers();
      try {
        const { fetch, api } = answers(busy('1'), json(PAGE));
        const result = getConversation(api, SID);
        await flush();
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toEqual({ kind: 'ok', page: PAGE });
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails with the 429 when the second ask is busy too, and asks no more', async () => {
      vi.useFakeTimers();
      try {
        const { fetch, api } = answers(busy('1'));
        const result = getConversation(api, SID);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await result).toEqual({ kind: 'failed', status: 429 });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits a second without a Retry-After, and at most five seconds whatever it says', async () => {
      vi.useFakeTimers();
      try {
        const none = answers(busy(), json(PAGE));
        const first = getConversation(none.api, SID);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await first).toEqual({ kind: 'ok', page: PAGE });
        const long = answers(busy('120'), json(PAGE));
        const second = getConversation(long.api, SID);
        await vi.advanceTimersByTimeAsync(4999);
        expect(long.fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await second).toEqual({ kind: 'ok', page: PAGE });
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops waiting, and asks no more, when the view closes meanwhile', async () => {
      vi.useFakeTimers();
      try {
        const { fetch, api } = answers(busy('1'), json(PAGE));
        const closing = new AbortController();
        const result = getConversation(api, SID, undefined, closing.signal);
        await flush();
        closing.abort();
        expect(await result).toEqual({ kind: 'failed', status: 429 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('keeps the reason an error body gives, trimmed, for the page to show after its own sentence', async () => {
    const { api } = client(() => new Response(JSON.stringify({ error: '  A made-up reason.  ' }), { status: 500 }));
    expect(await getConversation(api, SID)).toEqual({ kind: 'failed', status: 500, error: 'A made-up reason.' });
    const long = client(() => new Response(JSON.stringify({ error: 'x'.repeat(900) }), { status: 500 }));
    expect(await getConversation(long.api, SID)).toEqual({ kind: 'failed', status: 500, error: 'x'.repeat(500) });
    const other = client(() => new Response(JSON.stringify({ error: 42 }), { status: 500 }));
    expect(await getConversation(other.api, SID)).toEqual({ kind: 'failed', status: 500 });
  });

  it('answers 410 for a stale cursor, as the server does', () => {
    expect(STALE_CURSOR_STATUS).toBe(410);
  });

  it.each([
    ['a network error', () => Promise.reject(new Error('offline'))],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['another session', json({ ...PAGE, sessionId: 'other' })],
    ['entries that are not a list', json({ sessionId: SID, entries: {} })],
    ['an empty cursor', json({ ...PAGE, before: '' })],
  ])('reports %s as failed, never rejecting', async (_name, response) => {
    const { api } = client(response);
    expect(await getConversation(api, SID)).toEqual({ kind: 'failed' });
  });

  it('reports an aborted request as failed', async () => {
    const api = createApiClient({ fetch: vi.fn<FetchLike>() });
    const controller = new AbortController();
    // No apiKey yet, so the request waits; aborting ends the wait.
    const pending = getConversation(api, SID, undefined, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: 'failed' });
  });
});

describe('asConversationPage', () => {
  const SID = '00000000-0000-4000-8000-0000000000c2';

  it('keeps the markdown flag only when it is true', () => {
    const body = {
      sessionId: SID,
      entries: [
        { kind: 'assistant', text: '**a**', markdown: true },
        { kind: 'assistant', text: '**b**', markdown: 'yes' },
        { kind: 'cross-session', text: '**c**', markdown: false },
        { kind: 'to-pitwall', at: at(4), text: '**d**', markdown: true },
      ],
    };
    expect(asConversationPage(body, SID)?.entries).toEqual([
      { kind: 'assistant', text: '**a**', markdown: true },
      { kind: 'assistant', text: '**b**' },
      { kind: 'cross-session', text: '**c**' },
      { kind: 'to-pitwall', at: at(4), text: '**d**', markdown: true },
    ]);
  });

  it('drops entries that are not well formed, and fields of the wrong type', () => {
    const body = {
      sessionId: SID,
      entries: [
        { kind: 'assistant', text: 'kept', at: 5, truncated: 'yes' },
        { kind: 'html', text: 'unknown kind' },
        { kind: 'user' },
        null,
        'text',
        { kind: 'cross-session', text: 'hi', from: 'pitwall-test-sup', toolError: 'no' },
      ],
    };
    expect(asConversationPage(body, SID)).toEqual({
      sessionId: SID,
      entries: [
        { kind: 'assistant', text: 'kept' },
        { kind: 'cross-session', text: 'hi', from: 'pitwall-test-sup' },
      ],
    });
  });

  it("keeps a question entry's questions, dropping those and the options that aren't well formed, and fields of the wrong type (W49)", () => {
    const body = {
      sessionId: SID,
      entries: [
        {
          kind: 'question',
          at: at(1),
          text: 'Which flows should retry?',
          toolError: false,
          questions: [
            {
              question: 'Which flows should retry?',
              header: 'Flows',
              multiSelect: true,
              options: [{ label: 'Export', description: 'Each batch.' }, { label: 'Import', description: 7 }, { description: 'no label' }, 'Other'],
              answer: 'Export, Import',
              notes: 'Made-up notes.',
            },
            { question: 'Header of the wrong type?', header: 3, multiSelect: 'yes', options: [], answer: ['Export'], notes: {} },
            { question: 'No options' },
            { options: [] },
            null,
          ],
        },
        // Questions only belong to question entries; one without any still shows its text.
        { kind: 'tool', text: 'AskUserQuestion', toolName: 'AskUserQuestion', questions: [{ question: 'Not here.', options: [] }] },
        { kind: 'question', text: 'Its questions went missing.', questions: 'none' },
      ],
    };
    expect(asConversationPage(body, SID)?.entries).toEqual([
      {
        kind: 'question',
        at: at(1),
        text: 'Which flows should retry?',
        toolError: false,
        questions: [
          {
            question: 'Which flows should retry?',
            header: 'Flows',
            multiSelect: true,
            options: [{ label: 'Export', description: 'Each batch.' }, { label: 'Import' }],
            answer: 'Export, Import',
            notes: 'Made-up notes.',
          },
          { question: 'Header of the wrong type?', options: [] },
        ],
      },
      { kind: 'tool', text: 'AskUserQuestion', toolName: 'AskUserQuestion' },
      { kind: 'question', text: 'Its questions went missing.' },
    ]);
  });
});
