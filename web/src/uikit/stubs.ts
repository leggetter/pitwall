// Stand-ins for everything the gallery's components would ask pitwall for (W19): an ApiClient that
// answers from the fixtures, storage that lasts as long as the page, attach sockets that play a
// scripted server, and a clipboard. None of them touches the network, the WebSocket, the token or
// the real clipboard.

import {
  PROTOCOL_VERSION,
  SPAWN_PATH,
  WS_CLOSE_TOO_MANY,
  type AttachClientMessage,
  type AttachServerMessage,
  type ConversationEntry,
  type RelayResult,
} from '../../../src/shared/protocol.js';
import type { ApiClient, ApiResult } from '../api.js';
import type { AttachEnv } from '../attach.js';
import type { ClipboardLike } from '../copy.js';
import type { SocketLike } from '../connection.js';
import type { StorageSource } from '../groupState.js';
import { writeHidden, type HiddenGroup } from '../hidden.js';
import { createShortcutsStore, SHORTCUTS_KEY, type ShortcutsStore } from '../shortcuts.js';
import { CONVERSATION, NEWER_CONVERSATION, OLDER_CONVERSATION, TERMINAL_OUTPUT, TRUST_HINT } from './fixtures.js';

/** Never settles: the component stays in its busy state. */
const forever = () => new Promise<ApiResult>(() => {});
const ok = (body: unknown): ApiResult => ({ kind: 'ok', status: 200, body });
const failed = (status?: number, body?: unknown): ApiResult =>
  status === undefined ? { kind: 'failed' } : body === undefined ? { kind: 'failed', status } : { kind: 'failed', status, body };

export interface StubOptions {
  /**
   * The conversation's newest page. `older` adds a page behind "Load earlier", which `older-loading`
   * never answers; `growing` answers every fetch after the first with newer entries too, for "Jump to
   * latest"; `loading` never answers; `missing` is a 404, as for a session with no transcript.
   *
   * Failures (W28): `failed` is a 500 every time, and `failed-retrying` a 500, then no answer, so Try
   * again stays busy. `older-failed` and `older-failed-retrying` do the same to "Load earlier", and
   * `stale` answers it 410, as when the transcript changed. `refresh-failed` and
   * `refresh-failed-retrying` answer the first fetch, then fail every refresh (then never answer
   * Try again); `gone` answers the first, then 404s, as when the transcript has gone.
   */
  conversation?:
    | 'ok'
    | 'older'
    | 'older-loading'
    | 'growing'
    | 'empty'
    | 'loading'
    | 'failed'
    | 'failed-retrying'
    | 'missing'
    | 'older-failed'
    | 'older-failed-retrying'
    | 'stale'
    | 'refresh-failed'
    | 'refresh-failed-retrying'
    | 'gone';
  /** The newest page's entries, in place of the fixtures' conversation, for 'ok' (W36). */
  entries?: ConversationEntry[];
  /** What the relay answers a message with. `sending` never answers; `unreachable` is a network error; `refused-request` is pitwall refusing the request, as its API checks would. */
  relay?: RelayResult | 'sending' | 'unreachable' | 'refused-request';
  /** What starting a session gets. `trust` is Claude Code refusing an untrusted directory. */
  spawn?: 'started' | 'trust' | 'failed' | 'starting';
  /** What Stop and Remove get. `busy` never answers. */
  stop?: 'done' | 'refused' | 'busy';
  remove?: 'done' | 'refused' | 'busy';
}

const SESSION_PATH = /^\/api\/sessions\/([^/?]+)\/([a-z-]+)(?:\?before=(.*))?$/;

/** An ApiClient that answers from the fixtures, as `options` say, and never calls fetch. */
export function stubApi(options: StubOptions = {}): ApiClient {
  // How many times each session's newest page, and each one's older page, has been asked for.
  const fetched = new Map<string, number>();
  const fetchedOlder = new Map<string, number>();
  const answer = (method: 'GET' | 'POST', path: string): Promise<ApiResult> => {
    if (method === 'POST' && path === SPAWN_PATH) return spawn(options.spawn ?? 'started');
    const match = SESSION_PATH.exec(path);
    if (!match) return Promise.resolve(failed(404));
    const sessionId = decodeURIComponent(match[1] ?? '');
    const route = match[2];
    if (method === 'GET' && route === 'conversation') {
      const older = match[3] !== undefined;
      const counts = older ? fetchedOlder : fetched;
      const times = counts.get(sessionId) ?? 0;
      counts.set(sessionId, times + 1);
      if (options.entries && (options.conversation ?? 'ok') === 'ok') return Promise.resolve(ok({ sessionId, entries: options.entries }));
      return conversation(sessionId, options.conversation ?? 'ok', older, times);
    }
    if (method === 'POST' && route === 'relay') return relay(options.relay ?? { status: 'delivered' });
    if (method === 'POST' && (route === 'stop' || route === 'remove')) return action(route, options[route] ?? 'done');
    return Promise.resolve(failed(404));
  };
  return {
    get: (path) => answer('GET', path),
    post: (path) => answer('POST', path),
  };
}

/** `older` is a "Load earlier" request; `times` is how often that page, the newest or the older one, was asked for before this. */
function conversation(sessionId: string, kind: NonNullable<StubOptions['conversation']>, older: boolean, times: number): Promise<ApiResult> {
  const newest = (before?: string) => Promise.resolve(ok(before === undefined ? { sessionId, entries: CONVERSATION } : { sessionId, entries: CONVERSATION, before }));
  switch (kind) {
    case 'loading':
      return forever();
    case 'failed':
      return Promise.resolve(failed(500));
    case 'failed-retrying':
      return times === 0 ? Promise.resolve(failed(500)) : forever();
    case 'older-failed':
      return older ? Promise.resolve(failed(500)) : newest('pitwall-test-cursor');
    case 'older-failed-retrying':
      return older ? (times === 0 ? Promise.resolve(failed(500)) : forever()) : newest('pitwall-test-cursor');
    case 'stale':
      return older ? Promise.resolve(failed(410)) : newest(times === 0 ? 'pitwall-test-cursor' : 'pitwall-test-cursor-2');
    case 'refresh-failed':
      return times === 0 ? newest() : Promise.resolve(failed(500));
    case 'refresh-failed-retrying':
      return times === 0 ? newest() : times === 1 ? Promise.resolve(failed(500)) : forever();
    case 'gone':
      return times === 0 ? newest() : Promise.resolve(failed(404));
    case 'missing':
      return Promise.resolve(failed(404));
    case 'empty':
      return Promise.resolve(ok({ sessionId, entries: [] }));
    case 'older':
      return Promise.resolve(ok(older ? { sessionId, entries: OLDER_CONVERSATION } : { sessionId, entries: CONVERSATION, before: 'pitwall-test-cursor' }));
    case 'older-loading':
      return older ? forever() : Promise.resolve(ok({ sessionId, entries: CONVERSATION, before: 'pitwall-test-cursor' }));
    case 'growing':
      return Promise.resolve(ok({ sessionId, entries: times === 0 ? CONVERSATION : [...CONVERSATION, ...NEWER_CONVERSATION] }));
    case 'ok':
      return Promise.resolve(ok({ sessionId, entries: CONVERSATION }));
  }
}

function relay(result: NonNullable<StubOptions['relay']>): Promise<ApiResult> {
  if (result === 'sending') return forever();
  if (result === 'unreachable') return Promise.resolve(failed());
  if (result === 'refused-request') return Promise.resolve(failed(403));
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

/**
 * A clipboard for ClipboardContext (copy.ts) that never touches the real one: it takes the text, or
 * refuses it, as a browser that hasn't allowed the page to write does.
 */
export function stubClipboard(result: 'copied' | 'refused' = 'copied'): ClipboardLike {
  return {
    writeText: () => (result === 'copied' ? Promise.resolve() : Promise.reject(new Error('made up: the clipboard refused'))),
  };
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
 * What a page's storage holds with `groups` hidden from its repo list (W35), under each one's root's
 * key, and the Hidden section open or closed: for memoryStorage(), so the gallery never writes the app's keys.
 */
export function storedHidden(groups: readonly HiddenGroup[], open: boolean): Record<string, string> {
  const values: Record<string, string> = {};
  const into: StorageSource = () => ({ getItem: () => null, setItem: (key, value) => void (values[key] = value) });
  for (const root of new Set(groups.map((group) => group.root))) writeHidden(root, groups, open, into);
  return values;
}

/**
 * A single-key shortcuts setting of its own, in memory, on or off: the gallery never reads or writes
 * the app's pitwall.shortcuts.v1, and a specimen's checkbox changes only that specimen.
 */
export function memoryShortcuts(on = true): ShortcutsStore {
  return createShortcutsStore({ storage: memoryStorage(on ? {} : { [SHORTCUTS_KEY]: 'off' }), events: { addEventListener: () => {} } });
}

/**
 * How the scripted attach server behaves after the handshake.
 * - `connecting`: never sends its challenge, so the terminal stays at "Attaching…".
 * - `restart`: says the session needs a restart, then attaches once that's confirmed.
 * - `restart-pending`: says the session needs a restart, then never answers the confirmed open, so
 *   "Restart and attach" stays busy.
 * - `exit`: attaches, prints, then `claude attach` exits.
 */
export type AttachScript = 'connecting' | 'attached' | 'restart' | 'restart-pending' | 'exit' | 'error' | 'too-many';

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
      case 'restart-pending':
        if (!message.restart) {
          this.later(() => this.message({ type: 'needs-restart' }));
          return;
        }
        if (this.script === 'restart') this.attach();
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
