import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, WS_CLOSE_UNAUTHORIZED } from '../../src/shared/protocol.js';
import { createApiClient, type FetchLike } from './api.js';
import {
  backoffDelay,
  computeProof,
  createConnection,
  parseServerMessage,
  socketUrl,
  type ConnectionOptions,
  type ConnectionView,
} from './connection.js';
import { fakeSockets, mixedSnapshot, type FakeSocket } from './test/fixtures.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const KEY_A = 'a'.repeat(43);
const KEY_B = 'b'.repeat(43);
/** A nonce shaped like the server's: 43 base64url characters. Different for each `i`. */
const nonce = (i = 0) => `${'n'.repeat(41)}${String(i).padStart(2, '0')}`;

/**
 * The challenge-proof test vectors (PROTOCOL_VERSION 3), computed with
 * openssl, not WebCrypto or node:crypto:
 *   printf '%s\n%s' "$nonce" "$origin" | openssl dgst -sha256 -hmac "$token" -binary | base64 | tr '+/' '-_' | tr -d '='
 * src/server/security.test.ts checks the server's node:crypto implementation
 * against the same three. The first is for this page's own origin: the test
 * environment serves it from http://127.0.0.1:4517 (vitest.config.ts).
 */
const PROOF_VECTORS = [
  {
    token: 'pitwall-test-token-0123456789abcdefghijklmnop',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    origin: 'http://127.0.0.1:4517',
    proof: 'VfgdQHb0QdfmEBEAg8W5N3W6RclVQBVetrxzeG2xnFY',
  },
  // The same token and nonce from another origin, such as a squatter on another port.
  {
    token: 'pitwall-test-token-0123456789abcdefghijklmnop',
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    origin: 'http://127.0.0.1:4518',
    proof: 'Xk3hWH6P6KC1u51qPg77f3JuauFOnETYWqncpr6PLjc',
  },
  // RFC 4231 test case 2's key, with its data split at the line feed the proof puts between nonce and origin.
  { token: 'Jefe', nonce: 'what do ya want', origin: 'for nothing?', proof: 'UP-f1VK6b3166pqI6T8uvuKHC_hgz9eits8su-2SoT4' },
];

const authorization = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

function start(options: Partial<ConnectionOptions> = {}, fetch: FetchLike = vi.fn<FetchLike>()) {
  const fake = fakeSockets();
  const views: ConnectionView[] = [];
  const api = createApiClient({ fetch });
  const keys = {
    set: vi.spyOn(api.keys, 'set'),
    clear: vi.spyOn(api.keys, 'clear'),
    reject: vi.spyOn(api.keys, 'reject'),
  };
  // The real WebCrypto proof, with each promise kept so a test can wait for it.
  const proofs: Promise<string>[] = [];
  const connection = createConnection({
    url: socketUrl('127.0.0.1:4517'),
    token: TOKEN,
    createSocket: fake.factory,
    onChange: (view) => views.push(view),
    keys: api.keys,
    prove: (token, n) => {
      const proof = computeProof(token, n);
      proofs.push(proof);
      return proof;
    },
    ...options,
  });

  /** Sends a challenge on the latest socket and waits until the page has answered it. */
  const challenge = async (n = nonce(), socket: FakeSocket = fake.last) => {
    socket.open();
    socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: n });
    await proofs.at(-1);
    return socket;
  };

  /** The whole handshake on the latest socket: challenge, proof, authenticated. */
  const handshake = async (apiKey = KEY_A, n = nonce()) => {
    const socket = await challenge(n);
    socket.receive({ type: 'authenticated', apiKey });
    return socket;
  };

  /** A handshake, then a first snapshot: the connection is live. */
  const live = async (apiKey = KEY_A, n = nonce()) => {
    const socket = await handshake(apiKey, n);
    socket.receive({ type: 'snapshot', snapshot: mixedSnapshot() });
    return socket;
  };

  return { fake, views, connection, api, keys, challenge, handshake, live, latest: () => views.at(-1)! };
}

describe('backoffDelay', () => {
  it('doubles from 1 second and caps at 10', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
  });
});

describe('computeProof', () => {
  it.each(PROOF_VECTORS)(
    'is base64url(HMAC-SHA256(token, nonce + "\\n" + origin)) with WebCrypto, for origin $origin',
    async ({ token, nonce: n, origin, proof }) => {
      expect(await computeProof(token, n, origin)).toBe(proof);
    },
  );

  it("binds the proof to this page's own origin, location.origin, by default", async () => {
    const [here, elsewhere] = PROOF_VECTORS;
    expect(location.origin).toBe(here!.origin);
    expect(await computeProof(here!.token, here!.nonce)).toBe(here!.proof);
    expect(await computeProof(here!.token, here!.nonce)).not.toBe(elsewhere!.proof);
  });
});

describe('parseServerMessage', () => {
  it('accepts snapshot, heartbeat and error messages', () => {
    const snapshot = mixedSnapshot();
    expect(parseServerMessage(JSON.stringify({ type: 'snapshot', snapshot }))).toEqual({ type: 'snapshot', snapshot });
    expect(parseServerMessage(JSON.stringify({ type: 'error', error: 'boom' }))).toEqual({ type: 'error', error: 'boom' });
    const ok = { type: 'heartbeat', generatedAt: '2026-03-02T12:00:05.000Z', source: { ok: true } };
    expect(parseServerMessage(JSON.stringify(ok))).toEqual(ok);
    const failing = { type: 'heartbeat', generatedAt: '2026-03-02T12:00:05.000Z', source: { ok: false, error: 'timed out' } };
    expect(parseServerMessage(JSON.stringify(failing))).toEqual(failing);
  });

  it('accepts a challenge of any version with a 43-character nonce, and authenticated with a 43-character key', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'challenge', version: 2, nonce: nonce() }))).toEqual({
      type: 'challenge',
      version: 2,
      nonce: nonce(),
    });
    expect(parseServerMessage(JSON.stringify({ type: 'challenge', version: 3, nonce: nonce() }))).toMatchObject({ version: 3 });
    expect(parseServerMessage(JSON.stringify({ type: 'authenticated', apiKey: KEY_A }))).toEqual({ type: 'authenticated', apiKey: KEY_A });
  });

  it('ignores a challenge or authenticated message of the wrong shape', () => {
    for (const message of [
      { type: 'challenge', nonce: nonce() },
      { type: 'challenge', version: '2', nonce: nonce() },
      { type: 'challenge', version: 2, nonce: 'short' },
      { type: 'challenge', version: 2, nonce: `${nonce()}x` },
      { type: 'challenge', version: 2, nonce: `${'n'.repeat(42)}=` },
      { type: 'authenticated' },
      { type: 'authenticated', apiKey: '' },
      { type: 'authenticated', apiKey: 42 },
    ]) {
      expect(parseServerMessage(JSON.stringify(message)), JSON.stringify(message)).toBeUndefined();
    }
  });

  it('ignores a heartbeat without a time or a well-formed source', () => {
    for (const heartbeat of [
      { type: 'heartbeat', source: { ok: true } },
      { type: 'heartbeat', generatedAt: 5, source: { ok: true } },
      { type: 'heartbeat', generatedAt: '2026-03-02T12:00:05.000Z' },
      { type: 'heartbeat', generatedAt: '2026-03-02T12:00:05.000Z', source: { ok: false } },
      { type: 'heartbeat', generatedAt: '2026-03-02T12:00:05.000Z', source: { ok: 'yes' } },
      { type: 'heartbeat', generatedAt: '2026-03-02T12:00:05.000Z', source: null },
    ]) {
      expect(parseServerMessage(JSON.stringify(heartbeat)), JSON.stringify(heartbeat)).toBeUndefined();
    }
  });

  it('ignores malformed messages and types this UI does not know', () => {
    expect(parseServerMessage('not json')).toBeUndefined();
    expect(parseServerMessage('null')).toBeUndefined();
    expect(parseServerMessage(JSON.stringify({ type: 'snapshot' }))).toBeUndefined();
    expect(parseServerMessage(JSON.stringify({ type: 'transcript', lines: [] }))).toBeUndefined();
    expect(parseServerMessage(new ArrayBuffer(4))).toBeUndefined();
  });
});

describe('createConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the handshake', () => {
    it('connects to the WebSocket path, sends nothing until challenged, then answers with the proof', async () => {
      const { fake, latest, challenge } = start();
      expect(fake.sockets).toHaveLength(1);
      expect(fake.last.url).toBe('ws://127.0.0.1:4517/ws');
      expect(latest().state).toBe('connecting');

      fake.last.open();
      expect(fake.last.sent).toEqual([]);

      const vector = PROOF_VECTORS[0]!;
      await challenge(vector.nonce);
      expect(fake.last.sent.map((frame) => JSON.parse(frame))).toEqual([{ type: 'auth', proof: vector.proof }]);
      expect(fake.last.sent.join('')).not.toContain(TOKEN);
    });

    it('hands the apiKey over on authenticated, and only then takes snapshots', async () => {
      const { fake, keys, latest, challenge } = start();
      await challenge();
      // Before the server has accepted the proof, nothing it sends counts.
      fake.last.receive({ type: 'snapshot', snapshot: mixedSnapshot() });
      fake.last.receive({ type: 'heartbeat', generatedAt: '2026-03-02T12:00:05.000Z', source: { ok: true } });
      fake.last.receive({ type: 'error', error: 'from a squatter' });
      expect(latest()).toEqual({ state: 'connecting' });

      fake.last.receive({ type: 'authenticated', apiKey: KEY_A });
      expect(keys.set).toHaveBeenCalledWith(KEY_A);
      const snapshot = mixedSnapshot();
      fake.last.receive({ type: 'snapshot', snapshot });
      expect(latest()).toMatchObject({ state: 'live', snapshot });
    });

    it('ignores authenticated before it has answered a challenge', () => {
      const { fake, keys } = start();
      fake.last.open();
      fake.last.receive({ type: 'authenticated', apiKey: KEY_A });
      expect(keys.set).not.toHaveBeenCalled();
    });

    it('answers only the first challenge on a socket', async () => {
      const { fake, challenge } = start();
      await challenge(nonce(1));
      await challenge(nonce(2));
      expect(fake.last.sent).toHaveLength(1);
    });

    it('does not answer a malformed challenge', async () => {
      const { fake } = start();
      fake.last.open();
      fake.last.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: 'short' });
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.last.sent).toEqual([]);
    });

    it.each([PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1])(
      'does not answer a challenge for protocol version %i: it closes, says to reload, and retries later',
      async (version) => {
        const { fake, latest } = start();
        fake.last.open();
        fake.last.receive({ type: 'challenge', version, nonce: nonce() });
        await vi.advanceTimersByTimeAsync(0);
        expect(fake.last.sent).toEqual([]);
        expect(fake.last.closedByClient).toBe(true);
        expect(latest()).toMatchObject({ state: 'reconnecting', serverError: expect.stringContaining('Reload the page') });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fake.sockets).toHaveLength(2);
      },
    );

    it('retries with backoff when the browser cannot compute a proof', async () => {
      const { fake, latest } = start({ prove: () => Promise.reject(new Error('no WebCrypto')) });
      fake.last.open();
      fake.last.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: nonce() });
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.last.sent).toEqual([]);
      expect(latest()).toMatchObject({ state: 'reconnecting', serverError: expect.stringContaining('WebCrypto') });
    });

    it('does not send a proof that finished after the socket closed', async () => {
      let finish!: (proof: string) => void;
      const { fake } = start({ prove: () => new Promise((resolve) => (finish = resolve)) });
      fake.last.open();
      fake.last.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: nonce() });
      const first = fake.last;
      first.serverClose();
      finish('late-proof');
      await vi.advanceTimersByTimeAsync(0);
      expect(first.sent).toEqual([]);
    });

    it('answers a fresh challenge on every reconnect, and hands over each new apiKey', async () => {
      const { fake, keys, live } = start();
      await live(KEY_A, nonce(1));
      fake.last.serverClose(1001);
      expect(keys.clear).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.sockets).toHaveLength(2);
      await live(KEY_B, nonce(2));
      expect(keys.set.mock.calls).toEqual([[KEY_A], [KEY_B]]);

      const [first, second] = fake.sockets.map((socket) => JSON.parse(socket.sent[0]!).proof as string);
      expect(first).toBe(await computeProof(TOKEN, nonce(1)));
      expect(second).toBe(await computeProof(TOKEN, nonce(2)));
      for (const socket of fake.sockets) expect(socket.sent.join('')).not.toContain(TOKEN);
    });
  });

  describe('reconnect()', () => {
    it('replaces an authenticated socket straight away, for a fresh handshake', async () => {
      const { fake, connection, keys, latest, live } = start();
      const first = await live();
      keys.clear.mockClear();

      connection.reconnect();
      expect(first.closedByClient).toBe(true);
      expect(keys.clear).toHaveBeenCalled();
      expect(latest().state).toBe('reconnecting');
      expect(fake.sockets).toHaveLength(2);

      await live(KEY_B, nonce(2));
      expect(latest().state).toBe('live');
      expect(keys.set).toHaveBeenLastCalledWith(KEY_B);
    });

    it('runs when the API client gets a 401, and the retried request carries the new key', async () => {
      const fetch = vi.fn<FetchLike>(async (_url, init) =>
        authorization(init) === `Bearer ${KEY_A}` ? new Response(null, { status: 401 }) : new Response('{"ok":true}', { status: 200 }),
      );
      const { fake, api, live } = start({}, fetch);
      const first = await live(KEY_A, nonce(1));

      const result = api.get('/api/snapshot');
      await vi.waitFor(() => expect(fake.sockets).toHaveLength(2));
      expect(first.closedByClient).toBe(true);

      await live(KEY_B, nonce(2));
      expect(await result).toEqual({ kind: 'ok', status: 200, body: { ok: true } });
      expect(fetch.mock.calls.map(([, init]) => authorization(init))).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    });

    it('does nothing while a handshake or a retry is already underway', async () => {
      const { fake, connection, challenge } = start();
      await challenge();
      connection.reconnect();
      expect(fake.sockets).toHaveLength(1);
      expect(fake.last.closedByClient).toBe(false);

      fake.last.serverClose();
      connection.reconnect();
      expect(fake.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.sockets).toHaveLength(2);
    });
  });

  it('goes live on the first snapshot and keeps the latest one', async () => {
    const { fake, latest, handshake } = start();
    await handshake();
    const first = mixedSnapshot();
    const second = { ...mixedSnapshot(), generatedAt: '2026-03-02T12:00:05.000Z' };

    fake.last.receive({ type: 'snapshot', snapshot: first });
    expect(latest()).toMatchObject({ state: 'live', snapshot: first });

    fake.last.receive({ type: 'snapshot', snapshot: second });
    expect(latest().snapshot).toEqual(second);
  });

  it('records the poll time and source of each snapshot', async () => {
    const { fake, latest, handshake } = start();
    await handshake();
    const snapshot = { ...mixedSnapshot(), source: { ok: false as const, error: 'timed out' } };
    fake.last.receive({ type: 'snapshot', snapshot });
    expect(latest().lastPoll).toEqual({ generatedAt: snapshot.generatedAt, source: snapshot.source });
  });

  it('takes a heartbeat as a newer poll time and source, without replacing the snapshot', async () => {
    const { fake, latest, handshake } = start();
    await handshake();
    const sent = mixedSnapshot();
    fake.last.receive({ type: 'snapshot', snapshot: sent });
    const snapshot = latest().snapshot;
    expect(snapshot).toEqual(sent);

    fake.last.receive({ type: 'heartbeat', generatedAt: '2026-03-02T12:00:05.000Z', source: { ok: true } });
    // The same object, so nothing that depends on it renders again.
    expect(latest().snapshot).toBe(snapshot);
    expect(latest().lastPoll).toEqual({ generatedAt: '2026-03-02T12:00:05.000Z', source: { ok: true } });

    fake.last.receive({ type: 'heartbeat', generatedAt: '2026-03-02T12:00:10.000Z', source: { ok: false, error: 'timed out' } });
    expect(latest()).toMatchObject({ state: 'live', lastPoll: { source: { ok: false, error: 'timed out' } } });
    expect(latest().snapshot).toBe(snapshot);
  });

  it('counts a heartbeat as live, and starts the backoff again from 1 second', async () => {
    const { fake, latest, live, handshake } = start();
    await live();
    fake.last.serverClose();
    await vi.advanceTimersByTimeAsync(1_000);
    fake.last.serverClose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.sockets).toHaveLength(3);
    expect(latest().state).toBe('reconnecting');

    await handshake();
    fake.last.receive({ type: 'heartbeat', generatedAt: '2026-03-02T12:00:05.000Z', source: { ok: true } });
    expect(latest().state).toBe('live');
    fake.last.serverClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.sockets).toHaveLength(4);
  });

  it('surfaces error messages and ignores malformed ones', async () => {
    const { fake, latest, live } = start();
    await live();

    fake.last.receive({ type: 'error', error: 'index unavailable' });
    expect(latest()).toMatchObject({ state: 'live', serverError: 'index unavailable' });

    fake.last.receive('{not json');
    expect(latest()).toMatchObject({ state: 'live', serverError: 'index unavailable' });
  });

  it('reconnects with backoff from 1 second up to 10', async () => {
    const { fake, latest, live } = start();
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 10_000, 10_000];

    for (const [index, delay] of expectedDelays.entries()) {
      fake.last.serverClose(1006);
      expect(latest().state).toBe('reconnecting');
      expect(fake.sockets).toHaveLength(index + 1);

      vi.advanceTimersByTime(delay - 1);
      expect(fake.sockets).toHaveLength(index + 1);

      vi.advanceTimersByTime(1);
      expect(fake.sockets).toHaveLength(index + 2);
    }

    await live();
    expect(JSON.parse(fake.last.sent[0]!)).toEqual({ type: 'auth', proof: await computeProof(TOKEN, nonce()) });
    expect(latest().state).toBe('live');
  });

  it('starts the backoff again from 1 second after a connection goes live', async () => {
    const { fake, live } = start();
    fake.last.serverClose();
    vi.advanceTimersByTime(1_000);
    fake.last.serverClose();
    vi.advanceTimersByTime(2_000);
    expect(fake.sockets).toHaveLength(3);

    await live();
    fake.last.serverClose();

    vi.advanceTimersByTime(1_000);
    expect(fake.sockets).toHaveLength(4);
  });

  it('keeps the last snapshot while reconnecting', async () => {
    const { fake, latest, handshake } = start();
    await handshake();
    const snapshot = mixedSnapshot();
    fake.last.receive({ type: 'snapshot', snapshot });
    fake.last.serverClose();
    expect(latest()).toMatchObject({ state: 'reconnecting', snapshot });
  });

  it('stops for good when the server closes with 4401, and tells the API client', async () => {
    const { fake, latest, keys, challenge } = start();
    await challenge();

    fake.last.serverClose(WS_CLOSE_UNAUTHORIZED);

    expect(latest().state).toBe('unauthorized');
    expect(keys.reject).toHaveBeenCalled();
    vi.advanceTimersByTime(120_000);
    expect(fake.sockets).toHaveLength(1);
  });

  it('stops on 4401 even after earlier reconnects', () => {
    const { fake, latest } = start();
    fake.last.serverClose(1006);
    vi.advanceTimersByTime(1_000);
    expect(fake.sockets).toHaveLength(2);

    fake.last.serverClose(WS_CLOSE_UNAUTHORIZED);

    expect(latest().state).toBe('unauthorized');
    vi.advanceTimersByTime(120_000);
    expect(fake.sockets).toHaveLength(2);
  });

  it('close() closes the socket, drops the key and cancels a pending reconnect', async () => {
    const { fake, connection } = start();
    fake.last.serverClose();

    connection.close();
    vi.advanceTimersByTime(60_000);
    expect(fake.sockets).toHaveLength(1);

    const second = start();
    await second.live();
    second.keys.clear.mockClear();
    second.connection.close();
    expect(second.fake.last.closedByClient).toBe(true);
    expect(second.keys.clear).toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(second.fake.sockets).toHaveLength(1);
  });

  it('retries when the socket cannot even be created', () => {
    const views: ConnectionView[] = [];
    let calls = 0;
    const fake = fakeSockets();
    createConnection({
      url: 'ws://127.0.0.1:4517/ws',
      token: 't',
      createSocket: (url) => {
        calls += 1;
        if (calls === 1) throw new Error('blocked');
        return fake.factory(url);
      },
      onChange: (view) => views.push(view),
    });

    expect(views.at(-1)?.state).toBe('reconnecting');
    vi.advanceTimersByTime(1_000);
    expect(fake.sockets).toHaveLength(1);
  });
});
