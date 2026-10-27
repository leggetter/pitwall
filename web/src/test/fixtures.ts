// Made-up fixtures for the web UI tests. Nothing here comes from a real session.

import { EDITORS_PATH, type IndexSnapshot, type NeedsYou, type SessionGroup, type SessionSummary } from '../../../src/shared/protocol.js';
import type { FetchLike } from '../api.js';
import type { SocketFactory, SocketLike } from '../connection.js';

export const NOW = Date.parse('2026-03-02T12:00:00.000Z');

export function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

let counter = 0;

/**
 * The needsYou the index would set from these fields alone (src/index/summaries.ts, W69), as for a
 * job whose file it couldn't read and a session with no restart: 'prompt' while waiting, 'asked' for
 * askedYou, 'blocked' for a blocked job; never on a stale or finished one.
 */
export function indexNeedsYou(session: Pick<SessionSummary, 'stale' | 'finished' | 'status' | 'state' | 'askedYou'>): NeedsYou | undefined {
  if (session.stale || session.finished) return undefined;
  if (session.status === 'waiting') return { reason: 'prompt' };
  if (session.askedYou !== undefined) return { reason: 'asked' };
  if (session.state === 'blocked') return { reason: 'blocked' };
  return undefined;
}

/**
 * A session. Overrides set to `undefined` remove the field, as JSON would. Without a needsYou of its
 * own, it gets the one the index would set from its other fields (indexNeedsYou); `needsYou:
 * undefined` gives none, as for a blocked job whose file asks nothing.
 */
export function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  counter += 1;
  const merged: SessionSummary = {
    sessionId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    name: `pitwall-test-${counter}`,
    kind: 'interactive',
    cwd: '/Users/example/code/demo-app',
    pid: 40_000 + counter,
    alive: true,
    status: 'idle',
    startedAt: minutesAgo(120),
    stale: false,
    finished: false,
    lastActivityAt: minutesAgo(5),
    lastUserPrompt: 'run the tests',
    transcript: 'ok',
    ...overrides,
  };
  if (!('needsYou' in overrides)) {
    const needsYou = indexNeedsYou(merged);
    if (needsYou !== undefined) merged.needsYou = needsYou;
  }
  for (const key of Object.keys(merged) as (keyof SessionSummary)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged;
}

export function group(overrides: Partial<SessionGroup> & Pick<SessionGroup, 'sessions'>): SessionGroup {
  return {
    key: '/Users/example/code/demo-app',
    label: 'demo-app',
    kind: 'git',
    root: '/Users/example/code',
    ...overrides,
  };
}

export function snapshot(groups: SessionGroup[], overrides: Partial<IndexSnapshot> = {}): IndexSnapshot {
  return {
    generatedAt: new Date(NOW - 3_000).toISOString(),
    roots: ['/Users/example/code'],
    groups,
    source: { ok: true },
    ...overrides,
  };
}

/** Three groups covering the states the screen distinguishes. */
export function mixedSnapshot(): IndexSnapshot {
  return snapshot([
    group({
      key: '/Users/example/code/demo-app',
      label: 'demo-app',
      kind: 'git',
      sessions: [
        session({
          name: 'demo-docs',
          status: 'waiting',
          waitingFor: 'permission prompt',
          lastUserPrompt: 'update the getting started guide',
        }),
        session({
          name: 'demo-worker',
          kind: 'background',
          shortId: 'bg7f3a',
          state: 'blocked',
          status: 'idle',
          cwd: '/Users/example/code/demo-app/packages/worker',
        }),
        session({ name: 'demo-api', status: 'busy', lastActivityAt: minutesAgo(0.5) }),
      ],
    }),
    group({
      key: '/Users/example/code/notes',
      label: 'notes',
      kind: 'directory',
      sessions: [session({ name: 'notes-tidy', cwd: '/Users/example/code/notes', status: 'idle' })],
    }),
    group({
      key: '/Users/example/code/legacy',
      label: 'legacy',
      kind: 'git',
      sessions: [
        session({
          name: 'legacy-migration',
          kind: 'background',
          shortId: 'bg0001',
          cwd: '/Users/example/code/legacy',
          alive: false,
          pid: undefined,
          status: undefined,
          state: 'blocked',
          stale: true,
          startedAt: minutesAgo(60 * 24 * 30),
          lastActivityAt: minutesAgo(60 * 24 * 29),
        }),
      ],
    }),
  ]);
}

/** A WebSocket stand-in the tests drive by hand. */
export class FakeSocket implements SocketLike {
  sent: string[] = [];
  closedByClient = false;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
  }

  /** The server accepted the connection. */
  open(): void {
    this.onopen?.(new Event('open'));
  }

  /** The server sent a message. Objects are JSON-encoded; strings are sent as they are. */
  receive(message: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: typeof message === 'string' ? message : JSON.stringify(message) }));
  }

  /** The server or the network closed the connection. */
  serverClose(code = 1006): void {
    this.onerror?.(new Event('error'));
    this.onclose?.(new CloseEvent('close', { code }));
  }
}

export function fakeSockets() {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  return {
    sockets,
    factory,
    get last(): FakeSocket {
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket opened yet');
      return socket;
    },
  };
}

/**
 * `fetch` behind a server that also answers the editor list (W72), which the app GETs once, as soon
 * as it has an apiKey. That request is answered here, with `body`, none by default, and recorded in
 * `editorCalls`, so a test of the app's other requests counts and checks only its own in `fetch`.
 */
export function withEditorList(fetch: FetchLike, body: unknown = { editors: [] }): FetchLike & { editorCalls: Array<[string, RequestInit]> } {
  const editorCalls: Array<[string, RequestInit]> = [];
  const answer: FetchLike = async (url, init) => {
    if (url !== EDITORS_PATH) return fetch(url, init);
    editorCalls.push([url, init]);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return Object.assign(answer, { editorCalls });
}
