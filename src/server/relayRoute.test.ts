// The relay route, through the real HTTP server and its /api/* checks, with a
// fake relay, so no test ever runs `claude`. Made-up sessions only.
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Indexer } from '../index/index.js';
import { relayPath, WS_PATH, type IndexSnapshot, type RelayResult, type ServerMessage, type SessionSummary } from '../shared/protocol.js';
import type { RunningServer } from './index.js';
import type { RelayManager, RelaySendOutcome, RelayTarget } from './relay.js';
import { MAX_RELAY_TEXT_LENGTH, validateRelayRequest } from './relayRoute.js';
import { startServerWithInternals } from './server.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const INTERACTIVE_ID = '22222222-2222-4222-8222-222222222222';
const BG_ID = '11111111-1111-4111-8111-111111111111';
const NOT_RUNNING_ID = '33333333-3333-4333-8333-333333333333';
const UNLISTED_ID = '99999999-9999-4999-8999-999999999999';

let webRoot: string;
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-relay-route-'));
  webRoot = join(tmp, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function session(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId'>): SessionSummary {
  return {
    name: 'pitwall-test-interactive',
    kind: 'interactive',
    cwd: '/tmp/pitwall-test-root/repo',
    alive: true,
    pid: 4242,
    startedAt: '2026-10-19T00:00:00.000Z',
    stale: false,
    finished: false,
    transcript: 'missing',
    ...overrides,
  };
}

function snapshot(): IndexSnapshot {
  return {
    generatedAt: '2026-10-19T00:00:00.000Z',
    roots: ['/tmp/pitwall-test-root'],
    groups: [
      {
        key: '/tmp/pitwall-test-root/repo',
        label: 'repo',
        kind: 'git',
        root: '/tmp/pitwall-test-root',
        sessions: [
          session({ sessionId: INTERACTIVE_ID }),
          session({ sessionId: BG_ID, kind: 'background', shortId: 'b3899da0', name: 'pitwall-test-bg' }),
          session({ sessionId: NOT_RUNNING_ID, name: 'pitwall-test-gone', alive: false, pid: undefined }),
        ],
      },
    ],
    source: { ok: true },
  };
}

function fakeIndexer(latest: IndexSnapshot | null = snapshot()): Indexer {
  return {
    latest: () => latest ?? undefined,
    subscribe: () => () => {},
    conversation: async () => undefined,
    stop: () => {},
  };
}

/** A relay that records each send and answers `answer`. */
function fakeRelay(answer: RelaySendOutcome = { status: 'delivered' }): RelayManager & { sends: { target: RelayTarget; text: string }[]; closed: boolean } {
  const relay = {
    sends: [] as { target: RelayTarget; text: string }[],
    closed: false,
    async send(target: RelayTarget, text: string) {
      relay.sends.push({ target, text });
      return answer;
    },
    exchange: () => undefined,
    alert: () => undefined,
    off: () => undefined,
    isRelay: () => false,
    async close() {
      relay.closed = true;
    },
  };
  return relay;
}

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

interface Started {
  server: RunningServer;
  apiKey: string;
  relay: ReturnType<typeof fakeRelay>;
}

async function start(relay = fakeRelay(), indexer: Indexer = fakeIndexer()): Promise<Started> {
  const server = await startServerWithInternals({ indexer, token: TOKEN, webRoot, port: 0, relay });
  running.push(server);
  return { server, apiKey: await apiKeyOf(server.port), relay };
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  json: unknown;
}

function post(port: number, path: string, body: string | undefined, headers: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const origin = (port: number) => `http://127.0.0.1:${port}`;

/** POSTs as the web UI does: the apiKey, this server's Origin and a JSON body. */
function postAsPage(started: Started, path: string, body: unknown, extra: Record<string, string> = {}): Promise<HttpResult> {
  return post(started.server.port, path, typeof body === 'string' ? body : JSON.stringify(body), {
    authorization: `Bearer ${started.apiKey}`,
    origin: origin(started.server.port),
    'content-type': 'application/json',
    ...extra,
  });
}

/** The apiKey, from W8's challenge-response handshake. */
async function apiKeyOf(port: number): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: origin(port) });
  const messages: ServerMessage[] = [];
  const waiters: ((message: ServerMessage) => void)[] = [];
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const next = () => {
    const queued = messages.shift();
    return queued ? Promise.resolve(queued) : new Promise<ServerMessage>((resolve) => waiters.push(resolve));
  };
  const challenge = await next();
  if (challenge.type !== 'challenge') throw new Error(`expected a challenge, got ${challenge.type}`);
  const proof = createHmac('sha256', Buffer.from(TOKEN, 'utf8')).update(`${challenge.nonce}\n${origin(port)}`, 'utf8').digest('base64url');
  ws.send(JSON.stringify({ type: 'auth', proof }));
  const reply = await next();
  ws.close();
  if (reply.type !== 'authenticated') throw new Error(`expected authenticated, got ${reply.type}`);
  return reply.apiKey;
}

const failedWith = (json: unknown) => {
  const result = json as RelayResult;
  expect(result.status).toBe('failed');
  expect(typeof result.detail).toBe('string');
  return result.detail;
};

describe('the relay route: credentials', () => {
  it('refuses the raw token, even from this Origin, without relaying anything', async () => {
    const started = await start();
    const res = await post(started.server.port, relayPath(INTERACTIVE_ID), JSON.stringify({ text: 'hi' }), {
      authorization: `Bearer ${TOKEN}`,
      origin: origin(started.server.port),
      'content-type': 'application/json',
    });
    expect(res.status).toBe(403);
    expect(started.relay.sends).toEqual([]);
  });

  it('refuses the apiKey without this Origin, or with another one', async () => {
    const started = await start();
    for (const value of [undefined, 'http://evil.example', `http://localhost:${started.server.port}`]) {
      const headers: Record<string, string> = { authorization: `Bearer ${started.apiKey}`, 'content-type': 'application/json' };
      if (value !== undefined) headers.origin = value;
      expect((await post(started.server.port, relayPath(INTERACTIVE_ID), JSON.stringify({ text: 'hi' }), headers)).status, String(value)).toBe(403);
    }
    expect(started.relay.sends).toEqual([]);
  });

  it('refuses no credential, or a wrong one, with 401', async () => {
    const started = await start();
    for (const authorization of [undefined, 'Bearer not-the-key-0123456789abcdefghijklmnop']) {
      const headers: Record<string, string> = { origin: origin(started.server.port), 'content-type': 'application/json' };
      if (authorization !== undefined) headers.authorization = authorization;
      expect((await post(started.server.port, relayPath(INTERACTIVE_ID), JSON.stringify({ text: 'hi' }), headers)).status).toBe(401);
    }
    expect(started.relay.sends).toEqual([]);
  });

  it('answers a GET with 404, so only a POST relays', async () => {
    const started = await start();
    const res = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: started.server.port, path: relayPath(INTERACTIVE_ID), headers: { authorization: `Bearer ${started.apiKey}` }, agent: false },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res).toBe(404);
  });
});

describe('the relay route: which session', () => {
  it('relays to an interactive session with a live process, built from the resolved summary', async () => {
    const started = await start();
    const res = await postAsPage(started, relayPath(INTERACTIVE_ID), { text: '  Run the tests, please.\n', to: 'someone-else', name: 'x' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'delivered' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(started.relay.sends).toEqual([
      {
        target: { sessionId: INTERACTIVE_ID, name: 'pitwall-test-interactive', pid: 4242, cwd: '/tmp/pitwall-test-root/repo' },
        text: '  Run the tests, please.\n',
      },
    ]);
  });

  it('answers 409 for a background session, or one that isn’t running', async () => {
    const started = await start();
    const bg = await postAsPage(started, relayPath(BG_ID), { text: 'hi' });
    expect(bg.status).toBe(409);
    expect(failedWith(bg.json)).toMatch(/Only interactive sessions/);
    const gone = await postAsPage(started, relayPath(NOT_RUNNING_ID), { text: 'hi' });
    expect(gone.status).toBe(409);
    expect(failedWith(gone.json)).toMatch(/isn't running/);
    expect(started.relay.sends).toEqual([]);
  });

  it('answers 404 for a session not in the snapshot, 400 for an unsafe id, and 503 before the first poll', async () => {
    const started = await start();
    expect((await postAsPage(started, relayPath(UNLISTED_ID), { text: 'hi' })).status).toBe(404);
    expect((await postAsPage(started, relayPath('..%2Fetc'), { text: 'hi' })).status).toBe(400);
    expect((await postAsPage(started, relayPath('-rf'), { text: 'hi' })).status).toBe(400);
    const early = await start(fakeRelay(), fakeIndexer(null));
    expect((await postAsPage(early, relayPath(INTERACTIVE_ID), { text: 'hi' })).status).toBe(503);
    expect(started.relay.sends).toEqual([]);
  });
});

describe('the relay route: the request', () => {
  it.each([
    ['no text', {}],
    ['empty text', { text: '' }],
    ['only whitespace', { text: ' \n\t ' }],
    ['text that isn’t a string', { text: 42 }],
    ['an array', [{ text: 'hi' }]],
    ['text over the limit', { text: 'x'.repeat(MAX_RELAY_TEXT_LENGTH + 1) }],
    ['a NUL', { text: 'a\u0000b' }],
  ])('answers 400 for %s', async (_label, body) => {
    const started = await start();
    const res = await postAsPage(started, relayPath(INTERACTIVE_ID), body);
    expect(res.status).toBe(400);
    failedWith(res.json);
    expect(started.relay.sends).toEqual([]);
  });

  it('takes exactly the limit', async () => {
    const started = await start();
    expect((await postAsPage(started, relayPath(INTERACTIVE_ID), { text: 'x'.repeat(MAX_RELAY_TEXT_LENGTH) })).status).toBe(200);
  });

  it('checks the limit on the text as received, and passes it on as received: the relay makes look-alike spaces plain (W43)', async () => {
    const started = await start();
    // 8,193 characters, which CRLF to LF would bring under the limit, are still too many.
    const over = `${'x\r\n'.repeat(2731)}`;
    expect(over.length).toBe(MAX_RELAY_TEXT_LENGTH + 1);
    expect((await postAsPage(started, relayPath(INTERACTIVE_ID), { text: over })).status).toBe(400);
    const text = `one\u00a0two\r\n${'x'.repeat(MAX_RELAY_TEXT_LENGTH - 9)}`;
    expect(text.length).toBe(MAX_RELAY_TEXT_LENGTH);
    expect((await postAsPage(started, relayPath(INTERACTIVE_ID), { text })).status).toBe(200);
    expect(started.relay.sends.map((send) => send.text)).toEqual([text]);
  });

  it('answers 400 for JSON it can’t parse, 415 for another type, and 413 for a huge body', async () => {
    const started = await start();
    expect((await postAsPage(started, relayPath(INTERACTIVE_ID), '{"text":')).status).toBe(400);
    expect((await postAsPage(started, relayPath(INTERACTIVE_ID), { text: 'hi' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await postAsPage(started, relayPath(INTERACTIVE_ID), { text: 'x'.repeat(70 * 1024) })).status).toBe(413);
    expect(started.relay.sends).toEqual([]);
  });
});

describe('the relay route: outcomes', () => {
  it.each<RelaySendOutcome>([
    { status: 'delivered' },
    { status: 'held', detail: 'Held by that session.' },
    { status: 'refused', detail: 'Refused by that session.' },
    { status: 'failed', detail: 'Ambiguous name: 2 running sessions are named pitwall-test-interactive.' },
  ])('passes $status through with 200', async (answer) => {
    const started = await start(fakeRelay(answer));
    const res = await postAsPage(started, relayPath(INTERACTIVE_ID), { text: 'hi' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual(answer);
  });

  it('answers 429 with Retry-After when the relay is busy, without the internal field', async () => {
    const started = await start(fakeRelay({ status: 'failed', detail: 'The relay is busy.', retryAfterSeconds: 5 }));
    const res = await postAsPage(started, relayPath(INTERACTIVE_ID), { text: 'hi' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json).toEqual({ status: 'failed', detail: 'The relay is busy.' });
  });

  it('stops the relay when the server closes', async () => {
    const started = await start();
    await started.server.close();
    expect(started.relay.closed).toBe(true);
  });
});

describe('validateRelayRequest', () => {
  it('keeps the text exactly as sent', () => {
    expect(validateRelayRequest({ text: '  spaced \n' })).toEqual({ ok: true, text: '  spaced \n' });
  });

  it('refuses anything else', () => {
    expect(validateRelayRequest(null).ok).toBe(false);
    expect(validateRelayRequest('text').ok).toBe(false);
  });
});
