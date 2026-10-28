// Stand-ins for everything the gallery's components would ask pitwall for (W19): an ApiClient that
// answers from the fixtures, storage that lasts as long as the page, attach sockets that play a
// scripted server, and a clipboard. None of them touches the network, the WebSocket, the token or
// the real clipboard.

import {
  DIRECTORIES_PATH,
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
import { writeDraft, type DraftStorageSource, type StoredDraft } from '../drafts.js';
import type { SocketLike } from '../connection.js';
import type { StorageSource } from '../groupState.js';
import { writeHidden, type HiddenGroup } from '../hidden.js';
import { createShortcutsStore, SHORTCUTS_KEY, type ShortcutsStore } from '../shortcuts.js';
import { writeStarred } from '../starred.js';
import {
  APP_DIR,
  CONVERSATION,
  DIALOG_DIRECTORIES,
  MANY_DIRECTORIES,
  MANY_SUBAGENTS,
  NEWER_CONVERSATION,
  OLDER_CONVERSATION,
  SUBAGENT_OLDER,
  SUBAGENT_TRANSCRIPT,
  SUBAGENTS,
  TERMINAL_OUTPUT,
  TRUNCATED_SUBAGENTS,
  TRUST_HINT,
} from './fixtures.js';

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
  /**
   * The directory list for New session's "Another directory under a root…" (W70). `loading` never
   * answers; `empty` has none under the root; `many` has 312; `truncated` says the walk stopped early;
   * `failed` is a 500.
   */
  directories?: 'ok' | 'loading' | 'empty' | 'many' | 'truncated' | 'failed';
  /** What Stop and Remove get. `busy` never answers. */
  stop?: 'done' | 'refused' | 'busy';
  remove?: 'done' | 'refused' | 'busy';
  /**
   * What Resume in background gets (W67), in W66's words. `resuming` never answers; `refused` is a
   * session that's running again; `hint` is Claude Code refusing an untrusted directory, with the
   * command that trusts it; `copied` is Claude Code starting a copy instead; `busy` is pitwall already
   * running four commands; `timeout` is `claude --resume` not finishing; `failed` is no answer at all.
   */
  resume?: 'resumed' | 'resuming' | 'refused' | 'hint' | 'copied' | 'busy' | 'timeout' | 'failed';
  /**
   * What Open in an editor gets (W72), in the server's words (src/server/editors.ts). `opening` never
   * answers; `refused` is `open -a` exiting non-zero, as when the app has moved since pitwall started.
   */
  open?: 'opened' | 'opening' | 'refused';
  /**
   * A session's sub-agents (W77). Left out, the route is a 404, as before W76, so a view shows no
   * Sub-agents tab. `ok` is one of each state and a nested one; `many` is 72; `truncated` is twelve
   * the server cut short; `empty` has none; `loading` never answers; `failed` is a 500 every time, and
   * `failed-retrying` a 500, then no answer, so Try again stays busy; `refresh-failed` answers the
   * first, then 502s. A sub-agent's transcript has a page behind Load earlier.
   */
  subagents?: 'ok' | 'many' | 'truncated' | 'empty' | 'loading' | 'failed' | 'failed-retrying' | 'refresh-failed';
}

const SESSION_PATH = /^\/api\/sessions\/([^/?]+)\/([a-z-]+)(?:\?before=(.*))?$/;
/** A session's sub-agents, or one's transcript, with its cursor. */
const SUBAGENTS_PATH = /^\/api\/sessions\/([^/?]+)\/subagents(?:\/([A-Za-z0-9]+)\/conversation(?:\?before=(.*))?)?$/;

/** An ApiClient that answers from the fixtures, as `options` say, and never calls fetch. */
export function stubApi(options: StubOptions = {}): ApiClient {
  // How many times each session's newest page, and each one's older page, has been asked for.
  const fetched = new Map<string, number>();
  const fetchedOlder = new Map<string, number>();
  let listed = 0;
  const answer = (method: 'GET' | 'POST', path: string): Promise<ApiResult> => {
    if (method === 'POST' && path === SPAWN_PATH) return spawn(options.spawn ?? 'started');
    if (method === 'GET' && path === DIRECTORIES_PATH) return directories(options.directories ?? 'ok');
    const agents = method === 'GET' ? SUBAGENTS_PATH.exec(path) : null;
    if (agents) {
      if (options.subagents === undefined) return Promise.resolve(failed(404));
      const sessionId = decodeURIComponent(agents[1] ?? '');
      if (agents[2] !== undefined) {
        const older = agents[3] !== undefined;
        return Promise.resolve(ok(older ? { sessionId, entries: SUBAGENT_OLDER } : { sessionId, entries: SUBAGENT_TRANSCRIPT, before: 'pitwall-test-agent-cursor' }));
      }
      listed += 1;
      return subagents(sessionId, options.subagents, listed - 1);
    }
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
    if (method === 'POST' && route === 'resume') return resume(options.resume ?? 'resumed');
    if (method === 'POST' && route === 'open') return openEditor(options.open ?? 'opened');
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

/** `times` is how often the list was asked for before this. */
function subagents(sessionId: string, kind: NonNullable<StubOptions['subagents']>, times: number): Promise<ApiResult> {
  const list = (entries: typeof SUBAGENTS, truncated = false) => Promise.resolve(ok({ sessionId, subagents: entries, truncated }));
  switch (kind) {
    case 'loading':
      return forever();
    case 'failed':
      return Promise.resolve(failed(500));
    case 'failed-retrying':
      return times === 0 ? Promise.resolve(failed(500)) : forever();
    case 'refresh-failed':
      return times === 0 ? list(SUBAGENTS) : Promise.resolve(failed(502));
    case 'empty':
      return list([]);
    case 'many':
      return list(MANY_SUBAGENTS);
    case 'truncated':
      return list(TRUNCATED_SUBAGENTS, true);
    case 'ok':
      return list(SUBAGENTS);
  }
}

function relay(result: NonNullable<StubOptions['relay']>): Promise<ApiResult> {
  if (result === 'sending') return forever();
  if (result === 'unreachable') return Promise.resolve(failed());
  if (result === 'refused-request') return Promise.resolve(failed(403));
  return Promise.resolve(ok(result));
}

function directories(result: NonNullable<StubOptions['directories']>): Promise<ApiResult> {
  const [listed] = DIALOG_DIRECTORIES.roots;
  switch (result) {
    case 'loading':
      return forever();
    case 'failed':
      return Promise.resolve(failed(500));
    case 'empty':
      return Promise.resolve(ok({ roots: DIALOG_DIRECTORIES.roots.map((root) => ({ ...root, dirs: [] })) }));
    case 'many':
      return Promise.resolve(ok(MANY_DIRECTORIES));
    case 'truncated':
      return Promise.resolve(ok({ roots: listed ? [{ ...listed, truncated: true }] : [] }));
    case 'ok':
      return Promise.resolve(ok(DIALOG_DIRECTORIES));
  }
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

function resume(result: NonNullable<StubOptions['resume']>): Promise<ApiResult> {
  switch (result) {
    case 'resuming':
      return forever();
    case 'resumed':
      return Promise.resolve(ok({ ok: true, shortId: 'pt000000' }));
    case 'refused':
      return Promise.resolve(failed(409, { ok: false, error: "It's running again, in a terminal or in the background, so pitwall didn't resume it: that would start a copy." }));
    case 'hint':
      return Promise.resolve(
        failed(422, { ok: false, error: `Workspace not trusted. Run \`claude\` in ${APP_DIR} once and accept the trust prompt, then retry.`, hint: TRUST_HINT }),
      );
    case 'copied':
      return Promise.resolve(
        failed(409, {
          ok: false,
          error:
            'It was open in another Claude Code process after all, so Claude Code started a copy as pt0copy1 instead. The copy is listed as a background session with no name, which you can stop and remove.',
          copyShortId: 'pt0copy1',
        }),
      );
    case 'busy':
      return Promise.resolve(failed(429, { ok: false, error: 'pitwall is already running 4 stop, remove, resume or open commands. Try again in a moment.' }));
    case 'timeout':
      return Promise.resolve(failed(504, { ok: false, error: "claude --resume didn't finish within 30s. The session may still appear in the list." }));
    case 'failed':
      return Promise.resolve(failed());
  }
}

function openEditor(result: NonNullable<StubOptions['open']>): Promise<ApiResult> {
  switch (result) {
    case 'opening':
      return forever();
    case 'refused':
      return Promise.resolve(failed(502, { ok: false, error: "Cursor didn't open. If it has moved, restart pitwall so it looks again." }));
    case 'opened':
      return Promise.resolve(ok({ ok: true }));
  }
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
 * The message box's drafts (W44) in memory, for DraftStorageContext: the gallery never reads or
 * writes the tab's pitwall.draft.v1 keys, so its specimens look the same after a reload.
 */
export function memoryDrafts(entries: Record<string, string> = {}): DraftStorageSource {
  const values = new Map(Object.entries(entries));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  return () => storage;
}

/** What the tab would hold for `sessionId` with `draft` kept: for memoryDrafts(). */
export function storedDraft(sessionId: string, draft: StoredDraft): Record<string, string> {
  const values: Record<string, string> = {};
  writeDraft(sessionId, draft, () => ({ getItem: () => null, setItem: (key, value) => void (values[key] = value), removeItem: () => {} }));
  return values;
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

/** What pitwall.starred.v1 holds with these sessions starred, for a specimen's own storage (W53). */
export function storedStarred(ids: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  writeStarred(ids, () => ({ getItem: () => null, setItem: (key, value) => void (values[key] = value) }));
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
