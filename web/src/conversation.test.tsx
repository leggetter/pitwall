import { describe, expect, it, vi } from 'vitest';
import { conversationPath, type ConversationEntry, type ConversationPage } from '../../src/shared/protocol.js';
import { createApiClient, type FetchLike } from './api.js';
import {
  asConversationPage,
  conversationRows,
  countAdded,
  entryKey,
  entryKeys,
  foldOpen,
  getConversation,
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
});
