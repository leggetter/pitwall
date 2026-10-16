import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_CLOSE_UNAUTHORIZED } from '../../src/shared/protocol.js';
import { backoffDelay, createConnection, parseServerMessage, socketUrl, type ConnectionView } from './connection.js';
import { fakeSockets, mixedSnapshot } from './test/fixtures.js';

function start() {
  const fake = fakeSockets();
  const views: ConnectionView[] = [];
  const connection = createConnection({
    url: socketUrl('127.0.0.1:4517'),
    token: 'test-token',
    createSocket: fake.factory,
    onChange: (view) => views.push(view),
  });
  return { fake, views, connection, latest: () => views.at(-1)! };
}

describe('backoffDelay', () => {
  it('doubles from 1 second and caps at 10', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
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

  it('connects to the WebSocket path and sends auth as the first message', () => {
    const { fake, latest } = start();

    expect(fake.sockets).toHaveLength(1);
    expect(fake.last.url).toBe('ws://127.0.0.1:4517/ws');
    expect(latest().state).toBe('connecting');
    expect(fake.last.sent).toEqual([]);

    fake.last.open();

    expect(fake.last.sent).toHaveLength(1);
    expect(JSON.parse(fake.last.sent[0]!)).toEqual({ type: 'auth', token: 'test-token' });
  });

  it('goes live on the first snapshot and keeps the latest one', () => {
    const { fake, latest } = start();
    fake.last.open();
    const first = mixedSnapshot();
    const second = { ...mixedSnapshot(), generatedAt: '2026-03-02T12:00:05.000Z' };

    fake.last.receive({ type: 'snapshot', snapshot: first });
    expect(latest()).toMatchObject({ state: 'live', snapshot: first });

    fake.last.receive({ type: 'snapshot', snapshot: second });
    expect(latest().snapshot).toEqual(second);
  });

  it('records the poll time and source of each snapshot', () => {
    const { fake, latest } = start();
    fake.last.open();
    const snapshot = { ...mixedSnapshot(), source: { ok: false as const, error: 'timed out' } };
    fake.last.receive({ type: 'snapshot', snapshot });
    expect(latest().lastPoll).toEqual({ generatedAt: snapshot.generatedAt, source: snapshot.source });
  });

  it('takes a heartbeat as a newer poll time and source, without replacing the snapshot', () => {
    const { fake, latest } = start();
    fake.last.open();
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

  it('counts a heartbeat as live, and starts the backoff again from 1 second', () => {
    const { fake, latest } = start();
    fake.last.open();
    fake.last.receive({ type: 'snapshot', snapshot: mixedSnapshot() });
    fake.last.serverClose();
    vi.advanceTimersByTime(1_000);
    fake.last.serverClose();
    vi.advanceTimersByTime(2_000);
    expect(fake.sockets).toHaveLength(3);
    expect(latest().state).toBe('reconnecting');

    fake.last.open();
    fake.last.receive({ type: 'heartbeat', generatedAt: '2026-03-02T12:00:05.000Z', source: { ok: true } });
    expect(latest().state).toBe('live');
    fake.last.serverClose();
    vi.advanceTimersByTime(1_000);
    expect(fake.sockets).toHaveLength(4);
  });

  it('surfaces error messages and ignores malformed ones', () => {
    const { fake, latest } = start();
    fake.last.open();
    fake.last.receive({ type: 'snapshot', snapshot: mixedSnapshot() });

    fake.last.receive({ type: 'error', error: 'index unavailable' });
    expect(latest()).toMatchObject({ state: 'live', serverError: 'index unavailable' });

    fake.last.receive('{not json');
    expect(latest()).toMatchObject({ state: 'live', serverError: 'index unavailable' });
  });

  it('reconnects with backoff from 1 second up to 10', () => {
    const { fake, latest } = start();
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

    fake.last.open();
    expect(JSON.parse(fake.last.sent[0]!)).toEqual({ type: 'auth', token: 'test-token' });
    fake.last.receive({ type: 'snapshot', snapshot: mixedSnapshot() });
    expect(latest().state).toBe('live');
  });

  it('starts the backoff again from 1 second after a connection goes live', () => {
    const { fake } = start();
    fake.last.serverClose();
    vi.advanceTimersByTime(1_000);
    fake.last.serverClose();
    vi.advanceTimersByTime(2_000);
    expect(fake.sockets).toHaveLength(3);

    fake.last.open();
    fake.last.receive({ type: 'snapshot', snapshot: mixedSnapshot() });
    fake.last.serverClose();

    vi.advanceTimersByTime(1_000);
    expect(fake.sockets).toHaveLength(4);
  });

  it('keeps the last snapshot while reconnecting', () => {
    const { fake, latest } = start();
    const snapshot = mixedSnapshot();
    fake.last.open();
    fake.last.receive({ type: 'snapshot', snapshot });

    fake.last.serverClose();

    expect(latest()).toMatchObject({ state: 'reconnecting', snapshot });
  });

  it('stops for good when the server closes with 4401', () => {
    const { fake, latest } = start();
    fake.last.open();

    fake.last.serverClose(WS_CLOSE_UNAUTHORIZED);

    expect(latest().state).toBe('unauthorized');
    vi.advanceTimersByTime(120_000);
    expect(fake.sockets).toHaveLength(1);
  });

  it('stops 4401 even after earlier reconnects', () => {
    const { fake, latest } = start();
    fake.last.serverClose(1006);
    vi.advanceTimersByTime(1_000);
    expect(fake.sockets).toHaveLength(2);

    fake.last.serverClose(WS_CLOSE_UNAUTHORIZED);

    expect(latest().state).toBe('unauthorized');
    vi.advanceTimersByTime(120_000);
    expect(fake.sockets).toHaveLength(2);
  });

  it('close() closes the socket and cancels a pending reconnect', () => {
    const { fake, connection } = start();
    fake.last.serverClose();

    connection.close();
    vi.advanceTimersByTime(60_000);
    expect(fake.sockets).toHaveLength(1);

    const second = start();
    second.connection.close();
    expect(second.fake.last.closedByClient).toBe(true);
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
