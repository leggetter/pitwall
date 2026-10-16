import { describe, expect, it, vi } from 'vitest';
import { lastMessagePath, type LastMessage } from '../../src/shared/protocol.js';
import { createApiClient } from './api.js';
import { createReplyLoader, type FetchLike, type ReplyLoaderOptions } from './lastMessage.js';

const SID = '00000000-0000-4000-8000-0000000000aa';
const AT = '2026-03-02T11:55:00.000Z';

function reply(overrides: Partial<LastMessage> = {}): LastMessage {
  return { sessionId: SID, text: 'The whole reply.\n\nWith a second paragraph.', truncated: false, at: AT, ...overrides };
}

/** A fetch that answers with each response in turn, then the last one again. */
function fakeFetch(...responses: (() => Response | Promise<Response>)[]) {
  let call = 0;
  return vi.fn<FetchLike>(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (!next) throw new Error('no response');
    return next();
  });
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A loader over an API client that already has `apiKey`, as after the handshake. */
function loaderWith(fetch: FetchLike, apiKey = 'the-key', options: Omit<ReplyLoaderOptions, 'api'> = {}) {
  return createReplyLoader({ api: createApiClient({ apiKey, fetch }), ...options });
}

describe('createReplyLoader', () => {
  it('fetches the last-message path with the apiKey as a bearer token, uncached', async () => {
    const fetch = fakeFetch(json(reply()));
    const loader = loaderWith(fetch, 'the-api-key');

    expect(await loader.load(SID, AT)).toEqual({ kind: 'ok', message: reply() });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(lastMessagePath(SID));
    expect(init).toEqual({ headers: { Authorization: 'Bearer the-api-key' }, cache: 'no-store' });
  });

  it('waits for an apiKey while the page is still connecting, then fetches with it', async () => {
    const fetch = fakeFetch(json(reply()));
    const api = createApiClient({ fetch });
    const loader = createReplyLoader({ api });

    const pending = loader.load(SID, AT);
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();

    api.keys.set('arrived-later');
    expect(await pending).toEqual({ kind: 'ok', message: reply() });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: 'Bearer arrived-later' } });
  });

  it('caches by session and activity time, so a session that moved on is fetched again', async () => {
    const fetch = fakeFetch(json(reply()), json(reply({ text: 'A newer reply.' })));
    const loader = loaderWith(fetch);

    expect(loader.cached(SID, AT)).toBeUndefined();
    await loader.load(SID, AT);
    expect(loader.cached(SID, AT)).toEqual(reply());
    expect(await loader.load(SID, AT)).toEqual({ kind: 'ok', message: reply() });
    expect(fetch).toHaveBeenCalledTimes(1);

    const later = '2026-03-02T11:58:00.000Z';
    expect(loader.cached(SID, later)).toBeUndefined();
    expect(await loader.load(SID, later)).toEqual({ kind: 'ok', message: reply({ text: 'A newer reply.' }) });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one request between loads of the same reply in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = fakeFetch(async () => {
      await gate;
      return json(reply())();
    });
    const loader = loaderWith(fetch);
    const both = Promise.all([loader.load(SID, AT), loader.load(SID, AT)]);
    release();
    expect((await both).map((result) => result.kind)).toEqual(['ok', 'ok']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports unauthorized, and caches nothing, once the connection was refused (4401)', async () => {
    const fetch = fakeFetch(json(reply()));
    const api = createApiClient({ fetch });
    const loader = createReplyLoader({ api });
    const pending = loader.load(SID, AT);

    api.keys.reject();
    expect(await pending).toEqual({ kind: 'unauthorized' });
    expect(await loader.load(SID, AT)).toEqual({ kind: 'unauthorized' });
    expect(fetch).not.toHaveBeenCalled();
    expect(loader.cached(SID, AT)).toBeUndefined();
  });

  it.each([
    ['a 401 with no connection to get a new key from', () => new Response(null, { status: 401 })],
    ['a 404', () => new Response(null, { status: 404 })],
    ['a 500', () => new Response(null, { status: 500 })],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['another session', json(reply({ sessionId: 'someone-else' }))],
    ['text that is not a string', json({ ...reply(), text: 42 })],
    ['no truncated flag', json({ sessionId: SID, text: 'x' })],
    ['a time that is not a string', json({ ...reply(), at: 5 })],
    ['JSON null', json(null)],
  ])('reports %s as failed, and tries again next time', async (_name, response) => {
    const fetch = fakeFetch(response, json(reply()));
    const loader = loaderWith(fetch);

    expect(await loader.load(SID, AT)).toEqual({ kind: 'failed' });
    expect(loader.cached(SID, AT)).toBeUndefined();
    expect(await loader.load(SID, AT)).toEqual({ kind: 'ok', message: reply() });
  });

  it('keeps only the most recently used replies', async () => {
    const fetch = vi.fn<FetchLike>(async (url) => {
      const id = decodeURIComponent(url.split('/')[3] ?? '');
      return json(reply({ sessionId: id }))();
    });
    const loader = loaderWith(fetch, 'k', { cacheSize: 2 });
    await loader.load('a', AT);
    await loader.load('b', AT);
    loader.cached('a', AT);
    await loader.load('c', AT);

    expect(loader.cached('a', AT)).toBeDefined();
    expect(loader.cached('b', AT)).toBeUndefined();
    expect(loader.cached('c', AT)).toBeDefined();
  });

  it('keeps a reply without a time as it came', async () => {
    const fetch = fakeFetch(json({ sessionId: SID, text: 'undated', truncated: true }));
    const loader = loaderWith(fetch);
    expect(await loader.load(SID, undefined)).toEqual({ kind: 'ok', message: { sessionId: SID, text: 'undated', truncated: true } });
  });
});
