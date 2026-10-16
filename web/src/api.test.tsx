import { describe, expect, it, vi } from 'vitest';
import { apiGet, apiPost, createApiClient, type FetchLike } from './api.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('apiGet', () => {
  it('sends only the apiKey as a bearer token, uncached, and parses the JSON body', async () => {
    const fetch = fakeFetch(() => json({ hello: 'world' }));
    expect(await apiGet('/api/snapshot', 'the-key', { fetch })).toEqual({ kind: 'ok', status: 200, body: { hello: 'world' } });
    expect(fetch).toHaveBeenCalledWith('/api/snapshot', { headers: { Authorization: 'Bearer the-key' }, cache: 'no-store' });
  });

  it('passes an abort signal through', async () => {
    const fetch = fakeFetch(() => json({}));
    const signal = new AbortController().signal;
    await apiGet('/api/snapshot', 'k', { fetch, signal });
    expect(fetch.mock.calls[0]![1].signal).toBe(signal);
  });

  it.each([
    ['a 401', () => new Response(null, { status: 401 }), { kind: 'unauthorized' }],
    ['a 403', () => new Response(null, { status: 403 }), { kind: 'failed', status: 403 }],
    ['a 404', () => new Response(null, { status: 404 }), { kind: 'failed', status: 404 }],
    ['a 503', () => new Response(null, { status: 503 }), { kind: 'failed', status: 503 }],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 }), { kind: 'failed', status: 200 }],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch')), { kind: 'failed' }],
  ])('reports %s', async (_name, response, expected) => {
    expect(await apiGet('/api/snapshot', 'k', { fetch: fakeFetch(response) })).toEqual(expected);
  });

  it.each(['http://evil.example/api/snapshot', '//evil.example/api/snapshot', '/ws', 'api/snapshot', ''])(
    'refuses to send the key anywhere but /api/ on this origin: %j',
    async (path) => {
      const fetch = fakeFetch(() => json({}));
      await expect(apiGet(path, 'k', { fetch })).rejects.toThrow(/not an API path/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe('apiPost', () => {
  it('sends the body as JSON with only the apiKey as a bearer token, uncached', async () => {
    const fetch = fakeFetch(() => json({ ok: true }));
    expect(await apiPost('/api/sessions', 'the-key', { cwd: '/x', prompt: 'hi' }, { fetch })).toEqual({
      kind: 'ok',
      status: 200,
      body: { ok: true },
    });
    expect(fetch).toHaveBeenCalledWith('/api/sessions', {
      headers: { Authorization: 'Bearer the-key', 'Content-Type': 'application/json' },
      cache: 'no-store',
      method: 'POST',
      body: JSON.stringify({ cwd: '/x', prompt: 'hi' }),
    });
  });

  it('keeps the JSON body of a failed response, such as an error and a hint', async () => {
    const fetch = fakeFetch(() => json({ ok: false, error: 'Workspace not trusted', hint: 'claude' }, 400));
    expect(await apiPost('/api/sessions', 'k', {}, { fetch })).toEqual({
      kind: 'failed',
      status: 400,
      body: { ok: false, error: 'Workspace not trusted', hint: 'claude' },
    });
  });

  it('reports a 401 as unauthorized, and a failure without a JSON body without one', async () => {
    expect(await apiPost('/api/sessions', 'k', {}, { fetch: fakeFetch(() => new Response(null, { status: 401 })) })).toEqual({
      kind: 'unauthorized',
    });
    expect(await apiPost('/api/sessions', 'k', {}, { fetch: fakeFetch(() => new Response(null, { status: 403 })) })).toEqual({
      kind: 'failed',
      status: 403,
    });
  });

  it.each(['http://evil.example/api/sessions', '//evil.example/api/sessions', '/ws', ''])(
    'refuses to send the key anywhere but /api/ on this origin: %j',
    async (path) => {
      const fetch = fakeFetch(() => json({}));
      await expect(apiPost(path, 'k', {}, { fetch })).rejects.toThrow(/not an API path/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe('createApiClient', () => {
  it('posts with the current key, and retries once with the next key after a 401', async () => {
    const fetch = fakeFetch(
      () => new Response(null, { status: 401 }),
      () => json({ ok: true }),
    );
    const api = createApiClient({ fetch });
    const stale = vi.fn();
    api.keys.onStale(stale);
    api.keys.set('old-key');
    const result = api.post('/api/sessions/s/stop', {});
    await vi.waitFor(() => expect(stale).toHaveBeenCalledTimes(1));
    api.keys.set('new-key');
    expect(await result).toEqual({ kind: 'ok', status: 200, body: { ok: true } });
    expect(fetch.mock.calls.map(([, init]) => [init.method, (init.headers as Record<string, string>).Authorization])).toEqual([
      ['POST', 'Bearer old-key'],
      ['POST', 'Bearer new-key'],
    ]);
  });

  it('does not retry a post that failed for any other reason, because the route may have acted', async () => {
    const fetch = fakeFetch(() => json({ ok: false, error: 'boom' }, 500));
    const api = createApiClient({ fetch, apiKey: 'k' });
    expect(await api.post('/api/sessions', {})).toEqual({ kind: 'failed', status: 500, body: { ok: false, error: 'boom' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sends straight away, in the same call, when it already has a key', () => {
    const fetch = fakeFetch(() => json({}));
    const api = createApiClient({ fetch, apiKey: 'ready' });
    void api.get('/api/snapshot');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the current key', async () => {
    const fetch = fakeFetch(() => json({ ok: true }));
    const api = createApiClient({ fetch });
    api.keys.set('key-1');
    expect(await api.get('/api/snapshot')).toEqual({ kind: 'ok', status: 200, body: { ok: true } });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: 'Bearer key-1' } });
  });

  it('waits while there is no key, and while reconnecting, then sends with the new one', async () => {
    const fetch = fakeFetch(() => json({}));
    const api = createApiClient({ fetch });
    const first = api.get('/api/snapshot');
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    api.keys.set('key-1');
    await first;

    api.keys.clear();
    const second = api.get('/api/snapshot');
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    api.keys.set('key-2');
    await second;
    expect(fetch.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization)).toEqual([
      'Bearer key-1',
      'Bearer key-2',
    ]);
  });

  it('on a 401 drops the key, asks for a reconnect, and retries once with the next key', async () => {
    const fetch = fakeFetch(
      () => new Response(null, { status: 401 }),
      () => json({ fresh: true }),
    );
    const api = createApiClient({ fetch });
    const stale = vi.fn();
    api.keys.onStale(stale);
    api.keys.set('old-key');

    const result = api.get('/api/snapshot');
    await vi.waitFor(() => expect(stale).toHaveBeenCalledTimes(1));
    // The connection reconnects and hands over the new server's key.
    api.keys.set('new-key');
    expect(await result).toEqual({ kind: 'ok', status: 200, body: { fresh: true } });
    expect(fetch.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization)).toEqual([
      'Bearer old-key',
      'Bearer new-key',
    ]);
  });

  it('asks for one reconnect when several requests find the same key stale', async () => {
    let calls = 0;
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      calls += 1;
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer old-key' ? new Response(null, { status: 401 }) : json({ calls });
    });
    const api = createApiClient({ fetch });
    const stale = vi.fn();
    api.keys.onStale(stale);
    api.keys.set('old-key');

    const results = Promise.all([api.get('/api/a'), api.get('/api/b'), api.get('/api/c')]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await flush();
    expect(stale).toHaveBeenCalledTimes(1);
    api.keys.set('new-key');
    expect((await results).map((r) => r.kind)).toEqual(['ok', 'ok', 'ok']);
  });

  it('gives up with failed when the new key is refused too', async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 401 }));
    const api = createApiClient({ fetch });
    api.keys.onStale(() => api.keys.set('new-key'));
    api.keys.set('old-key');
    expect(await api.get('/api/snapshot')).toEqual({ kind: 'failed', status: 401 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('resolves waiting and later requests as unauthorized once the connection is refused', async () => {
    const fetch = fakeFetch(() => json({}));
    const api = createApiClient({ fetch });
    const waiting = api.get('/api/snapshot');
    api.keys.reject();
    expect(await waiting).toEqual({ kind: 'unauthorized' });
    expect(await api.get('/api/snapshot')).toEqual({ kind: 'unauthorized' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops waiting when the signal aborts', async () => {
    const fetch = fakeFetch(() => json({}));
    const api = createApiClient({ fetch });
    const controller = new AbortController();
    const waiting = api.get('/api/snapshot', { signal: controller.signal });
    controller.abort();
    expect(await waiting).toEqual({ kind: 'failed' });
    api.keys.set('k');
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops hearing about stale keys after unsubscribing', async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 401 }));
    const api = createApiClient({ fetch, apiKey: 'k' });
    const stale = vi.fn();
    const unsubscribe = api.keys.onStale(stale);
    unsubscribe();
    expect(await api.get('/api/snapshot')).toEqual({ kind: 'failed', status: 401 });
    expect(stale).not.toHaveBeenCalled();
  });
});
