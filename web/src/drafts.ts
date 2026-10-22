// The message box's unsent drafts (docs/design-system.md, 4: Message box), W44. Each conversation has
// its own, kept in the tab's sessionStorage under pitwall.draft.v1:<sessionId>, the same id the box
// sends to (relayPath) and ?session= opens, so a reload, or opening the session again later in the
// tab, brings it back, and one session's draft never shows in another's box.
//
// sessionStorage, not localStorage (Phil, 2026-10-22): a draft lasts as long as the tab, as the token
// does (D7), and survives reloads and pitwall restarts, and two tabs never overwrite each other's.
// It isn't kept off disk, though (W48 F10): Chrome writes sessionStorage to the browser profile, and
// brings it back with a tab the browser reopens, such as a closed tab reopened or a session restored
// at start. So a draft is on disk in the profile while its tab is open, and stays there with a closed
// tab the browser can still reopen. The text is session content, D14's one exception, so pitwall puts
// it nowhere else: never logged, never in a URL, and sent only by Send, to the relay.
//
// Each key holds a small versioned JSON value:
//
//   {"v":1,"text":"Please run the tests."}
//   {"v":1,"text":"Please run the tests.","send":{"at":"2026-10-22T10:41:00.000Z","state":"out"}}
//
// - text: the draft as typed, never empty: an empty box has no key.
// - send: a send of this text that pitwall never heard the end of, so it may have reached the
//   session. "out" from the moment it goes until its answer, which is what a reload, or the view
//   closing, leaves behind. "uncertain" once its answer said pitwall couldn't tell: the relay's
//   uncertain, or no answer, a server error or an unexplained success. `at` is when it went out.
//   Either way the box warns before the text is sent again, until it's edited or sent.
//
// Written as the text changes, in the same event, so a reload straight after a keystroke keeps it.
// Removed when the box empties, and when a send is delivered, held or refused, as the box clears
// then; kept, without `send`, when it wasn't sent. Never pruned for a session missing from a
// snapshot, since a failed poll can empty the list: drafts go with the tab's sessionStorage.
//
// Storage can be missing, throw or be full, in a private window, with site data blocked or over its
// quota. The box then works from memory, as before W44, with no notice. A write that fails removes
// the key, so a reload never brings back an older copy than the one that was on screen.

import { createContext } from 'react';

/** Every draft's key starts with this; the session's id follows it. */
export const DRAFT_KEY_PREFIX = 'pitwall.draft.v1:';

/** The key that holds `sessionId`'s draft. */
export function draftKey(sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}`;
}

/**
 * The storage drafts are kept in. A function, because in some browsers reading
 * `window.sessionStorage` itself throws when site data is blocked.
 */
export type DraftStorageSource = () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null | undefined;

/** The tab's own: sessionStorage. */
export const tabStorage: DraftStorageSource = () => window.sessionStorage;

/** Where the message box keeps drafts: the tab's sessionStorage, or the gallery's memory, so it never writes the app's keys. */
export const DraftStorageContext = createContext<DraftStorageSource>(tabStorage);

/** A send whose outcome pitwall never learned: still out when the page went, or answered "can't tell". */
export interface UnsureSend {
  /** When it went out, as an ISO time. */
  at: string;
  state: 'out' | 'uncertain';
}

export interface StoredDraft {
  /** Never empty. */
  text: string;
  send?: UnsureSend | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function asSend(value: unknown): UnsureSend | undefined {
  if (!isRecord(value)) return undefined;
  const { at, state } = value;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || (state !== 'out' && state !== 'uncertain')) return undefined;
  return { at, state };
}

/**
 * `sessionId`'s draft: nothing when none is stored, storage is missing or throws, or the value isn't
 * version 1's shape. A `send` that isn't one is left out, and the text kept.
 */
export function readDraft(sessionId: string, storage: DraftStorageSource = tabStorage): StoredDraft | undefined {
  try {
    const raw = storage()?.getItem(draftKey(sessionId));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.text !== 'string' || parsed.text === '') return undefined;
    const send = asSend(parsed.send);
    return send ? { text: parsed.text, send } : { text: parsed.text };
  } catch {
    return undefined;
  }
}

/** Whether `sessionId` has a draft stored, for a view that must keep its footer for it. */
export function hasStoredDraft(sessionId: string, storage: DraftStorageSource = tabStorage): boolean {
  return readDraft(sessionId, storage) !== undefined;
}

/**
 * Stores `sessionId`'s draft, or removes it for none or empty text. A write that fails, blocked or
 * over quota, removes what was stored instead, so it's never older than the box; that failing too is ignored.
 */
export function writeDraft(sessionId: string, draft: StoredDraft | undefined, storage: DraftStorageSource = tabStorage): void {
  const key = draftKey(sessionId);
  try {
    const target = storage();
    if (!target) return;
    if (draft === undefined || draft.text === '') {
      target.removeItem(key);
      return;
    }
    target.setItem(key, JSON.stringify(draft.send ? { v: 1, text: draft.text, send: draft.send } : { v: 1, text: draft.text }));
  } catch {
    try {
      storage()?.removeItem(key);
    } catch {
      // Blocked: the draft lasts until the page reloads, as before W44.
    }
  }
}
