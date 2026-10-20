// Stand-ins for everything the gallery's components would ask pitwall for (W19): an ApiClient that
// answers from the fixtures, storage that lasts as long as the page, and attach sockets that play a
// scripted server. None of them touches the network, the WebSocket or the token.

import {
  PROTOCOL_VERSION,
  SPAWN_PATH,
  WS_CLOSE_TOO_MANY,
  type AttachClientMessage,
  type AttachServerMessage,
  type RelayResult,
} from '../../../src/shared/protocol.js';
import type { ApiClient, ApiResult } from '../api.js';
import type { AttachEnv } from '../attach.js';
import type { SocketLike } from '../connection.js';
import type { StorageSource } from '../groupState.js';
import { CONVERSATION, OLDER_CONVERSATION, TERMINAL_OUTPUT, TRUST_HINT } from './fixtures.js';

/** Never settles: the component stays in its busy state. */
const forever = () => new Promise<ApiResult>(() => {});
const ok = (body: unknown): ApiResult => ({ kind: 'ok', status: 200, body });
const failed = (status?: number, body?: unknown): ApiResult =>
  status === undefined ? { kind: 'failed' } : body === undefined ? { kind: 'failed', status } : { kind: 'failed', status, body };

export interface StubOptions {
  /**
   * The conversation's newest page. `older` adds a page behind "Load earlier"; `loading` never
   * answers; `missing` is a 404, as for a session with no transcript.
   */
  conversation?: 'ok' | 'older' | 'empty' | 'loading' | 'failed' | 'missing';
  /** What the relay answers a message with. `sending` never answers; `unreachable` is a network error. */
  relay?: RelayResult | 'sending' | 'unreachable';
  /** What starting a session gets. `trust` is Claude Code refusing an untrusted directory. */
  spawn?: 'started' | 'trust' | 'failed' | 'starting';
  /** What Stop and Remove get. `busy` never answers. */
  stop?: 'done' | 'refused' | 'busy';
  remove?: 'done' | 'refused' | 'busy';
}

const SESSION_PATH = /^\/api\/sessions\/([^/?]+)\/([a-z-]+)(?:\?before=(.*))?$/;

/** An ApiClient that answers from the fixtures, as `options` say, and never calls fetch. */
export function stubApi(options: StubOptions = {}): ApiClient {
  const answer = (method: 'GET' | 'POST', path: string): Promise<ApiResult> => {
    if (method === 'POST' && path === SPAWN_PATH) return spawn(options.spawn ?? 'started');
    const match = SESSION_PATH.exec(path);
    if (!match) return Promise.resolve(failed(404));
    const sessionId = decodeURIComponent(match[1] ?? '');
    const route = match[2];
    if (method === 'GET' && route === 'conversation') return conversation(sessionId, options.conversation ?? 'ok', match[3] !== undefined);
    if (method === 'POST' && route === 'relay') return relay(options.relay ?? { status: 'delivered' });
    if (method === 'POST' && (route === 'stop' || route === 'remove')) return action(route, options[route] ?? 'done');
    return Promise.resolve(failed(404));
  };
  return {
    get: (path) => answer('GET', path),
    post: (path) => answer('POST', path),
  };
}

function conversation(sessionId: string, kind: NonNullable<StubOptions['conversation']>, older: boolean): Promise<ApiResult> {
  switch (kind) {
    case 'loading':
      return forever();
    case 'failed':
      return Promise.resolve(failed(500));
    case 'missing':
      return Promise.resolve(failed(404));
    case 'empty':
      return Promise.resolve(ok({ sessionId, entries: [] }));
    case 'older':
      return Promise.resolve(ok(older ? { sessionId, entries: OLDER_CONVERSATION } : { sessionId, entries: CONVERSATION, before: 'pitwall-test-cursor' }));
    case 'ok':
      return Promise.resolve(ok({ sessionId, entries: CONVERSATION }));
  }
}

function relay(result: NonNullable<StubOptions['relay']>): Promise<ApiResult> {
  if (result === 'sending') return forever();
  if (result === 'unreachable') return Promise.resolve(failed());
  return Promise.resolve(ok(result));
}

function spawn(result: NonNullable<StubOptions['spawn']>): Promise<ApiResult> {
  switch (result) {
    case 'starting':
      return forever();
    case 'failed':
      return Promise.resolve(failed(500));
    case 'trust':
      return Promise.resolve(
        failed(400, { ok: false, error: "Claude Code hasn't trusted ~/code/pitwall-test-app yet, so it can't start a session there.", hint: TRUST_HINT }),
      );
    case 'started':
      return Promise.resolve(ok({ ok: true, shortId: 'pt999999', name: 'pitwall-test-started' }));
  }
}

function action(route: 'stop' | 'remove', result: 'done' | 'refused' | 'busy'): Promise<ApiResult> {
  if (result === 'busy') return forever();
  if (result === 'done') return Promise.resolve(ok({ ok: true }));
  const error =
    route === 'remove'
      ? 'claude rm kept the worktree ~/code/pitwall-test-app/.claude/worktrees/pitwall-test-export-fix, because it has unpushed commits.'
      : 'claude stop failed: the session had already exited.';
  return Promise.resolve(failed(409, { ok: false, error }));
}

/** Storage for the dashboard's open groups that lasts as long as the page, so the gallery never writes pitwall's keys. */
export function memoryStorage(entries: Record<string, string> = {}): StorageSource {
  const values = new Map(Object.entries(entries));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  return () => storage;
}

/**
 * How the scripted attach server behaves after the handshake.
 * - `connecting`: never sends its challenge, so the terminal stays at "Attaching…".
 * - `restart`: says the session needs a restart, then attaches once that's confirmed.
 * - `exit`: attaches, prints, then `claude attach` exits.
 */
export type AttachScript = 'connecting' | 'attached' | 'restart' | 'exit' | 'error' | 'too-many';

/** A nonce in the contract's shape: 43 base64url characters. */
const NONCE = 'pitwalltestnonce'.padEnd(43, '0');

/** Plays the attach server's side of src/shared/protocol.ts, on a timer, with no network. */
class ScriptedAttachSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  private closed = false;

  constructor(private readonly script: AttachScript) {
    if (script !== 'connecting') this.later(() => this.message({ type: 'challenge', version: PROTOCOL_VERSION, nonce: NONCE }));
  }

  send(data: string): void {
    const message = JSON.parse(data) as AttachClientMessage;
    if (message.type === 'auth') {
      this.later(() => this.message({ type: 'ready' }));
      return;
    }
    if (message.type !== 'open') return;
    switch (this.script) {
      case 'restart':
        if (!message.restart) {
          this.later(() => this.message({ type: 'needs-restart' }));
          return;
        }
        this.attach();
        return;
      case 'attached':
        this.attach();
        return;
      case 'exit':
        this.attach();
        this.later(() => this.message({ type: 'exit', code: 0 }), 50);
        return;
      case 'error':
        this.later(() => this.message({ type: 'error', error: 'the session is still starting. Try again in a moment.' }));
        return;
      case 'too-many':
        this.later(() => this.onclose?.(new CloseEvent('close', { code: WS_CLOSE_TOO_MANY })));
        return;
      case 'connecting':
        return;
    }
  }

  close(): void {
    this.closed = true;
  }

  private attach(): void {
    this.later(() => {
      this.message({ type: 'attached' });
      this.later(() => this.onmessage?.(new MessageEvent('message', { data: new TextEncoder().encode(TERMINAL_OUTPUT).buffer })));
    });
  }

  private message(message: AttachServerMessage): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  private later(run: () => void, ms = 0): void {
    setTimeout(() => {
      if (!this.closed) run();
    }, ms);
  }
}

/** What the session view needs to attach, with sockets that follow `script`. Its token is a placeholder, never a real one. */
export function scriptedAttach(script: AttachScript): AttachEnv {
  return { token: 'pitwall-test-placeholder', host: 'pitwall-test.invalid', createSocket: () => new ScriptedAttachSocket(script) };
}
