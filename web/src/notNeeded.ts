// Not needed now (docs/design-system.md, 4: Not needed now), W88. Phil, 2026-10-28: a background
// session Claude Code called blocked sat in Needs you though it was waiting on someone else: it had
// posted a request-changes review, and was waiting for the author's fix before it re-ran a check and
// tore down. He read it as done. Until a triage tells the two apart (M6), a session in Needs you can be
// marked not needed now, from its row's toggle or its view's actions menu, and it leaves everything
// needsAttention() drives: Needs you, the repo list's badges, the session list's "N need you", the root
// tabs' badges, the page title's count and the urgency sort. Once what it needs changes, it's back by
// itself.
//
// "What it needs" is `needsYou`'s reason and text, `askedYou`'s excerpt, `state`, `status` and
// `waitingFor`. A mark keeps a hash of them, never the text: needHash(). A session is not needed now
// while its id is marked and its hash is still the one marked, so a new question, a new line from
// Claude Code, or a change of state brings it back at once, before anything is written.
//
// Kept in the browser, as stars are (starred.ts): a viewer's preference, with no server change. One
// localStorage key, pitwall.not-needed.v1, shared across roots and tabs on the origin, holding a small
// versioned JSON value:
//
//   {"v":1,"entries":[{"id":"00000000-0000-4000-8000-000000000001","hash":"a1b2c3d4e5f60718"}]}
//
// - entries: each marked session's id and the hash of what it needed, oldest mark first. Ids and
//   hashes only: never a session's name, title, prompt or what it asked, as with the other
//   pitwall.*.v1 keys.
//
// An entry goes once a snapshot lists its session with a different hash (prune()): what it needed has
// changed, so the mark has done its job. Never because a session is missing from a snapshot, as with
// stars, since a failed poll can empty the list. So that the list can't grow forever, it holds at most
// NOT_NEEDED_CAP entries, and marking past that drops the oldest. A mark made or cleared in another of
// pitwall's tabs arrives with the window's `storage` event.
//
// Storage can be missing or throw, in a private window or with site data blocked, as in
// groupState.ts: then nothing starts marked, marking still works for the page's life, and nothing
// throws. A value that isn't this shape marks nothing; an entry in it that isn't an id and a hash is
// skipped.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../../src/shared/protocol.js';
import { browserStorage, type StorageSource } from './groupState.js';
import { MAX_ID_LENGTH, type StarredEvents } from './starred.js';

export const NOT_NEEDED_KEY = 'pitwall.not-needed.v1';

/**
 * The most entries kept: twice the stars' cap, since a mark goes by itself once what it needed
 * changes, so most are short-lived, and at about 80 bytes an entry, the key stays near 16 KB.
 */
export const NOT_NEEDED_CAP = 200;

/** The sessions marked not needed now: each one's id, with the hash of what it needed then, oldest mark first. */
export type NotNeeded = ReadonlyMap<string, string>;

/** None marked: what the lists use before the page has read storage, and the gallery's rows. */
export const NONE_NOT_NEEDED: NotNeeded = new Map();

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const encoder = new TextEncoder();

/** A 64-bit FNV-1a hash of `text`'s UTF-8 bytes, as 16 hex digits. It says whether the text changed, not what it was. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of encoder.encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * FNV_PRIME);
  return hash.toString(16).padStart(16, '0');
}

/** Session objects are new with each snapshot, so a hash is worked out once for each. */
const hashes = new WeakMap<SessionSummary, string>();

/**
 * The hash of what a session needs: `needsYou`'s reason and text, `askedYou`'s excerpt, `state`,
 * `status` and `waitingFor`, each or null, in that order. Any change to one of them changes it.
 */
export function needHash(session: SessionSummary): string {
  const known = hashes.get(session);
  if (known !== undefined) return known;
  const need = [session.needsYou?.reason, session.needsYou?.text, session.askedYou?.excerpt, session.state, session.status, session.waitingFor].map((part) => part ?? null);
  const hash = fnv1a64(JSON.stringify(need));
  hashes.set(session, hash);
  return hash;
}

/** Whether `session` is marked, and still needs what it needed when it was. Whether it needs you at all is needsAttention()'s. */
export function markedNow(session: SessionSummary, notNeeded: NotNeeded | undefined): boolean {
  if (notNeeded === undefined || notNeeded.size === 0) return false;
  const hash = notNeeded.get(session.sessionId);
  return hash !== undefined && hash === needHash(session);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH;
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

/** At most NOT_NEEDED_CAP of `entries`, the newest marks kept, in order. */
function capped(entries: Iterable<readonly [string, string]>): Map<string, string> {
  const all = [...entries];
  return new Map(all.length > NOT_NEEDED_CAP ? all.slice(all.length - NOT_NEEDED_CAP) : all);
}

/**
 * The marks, oldest first: none when nothing is stored, storage is missing or throws, or the value
 * isn't version 1's shape. An entry that isn't an id and a hash is skipped, an id listed twice keeps
 * its last mark, and past NOT_NEEDED_CAP the oldest go.
 */
export function readNotNeeded(storage: StorageSource = browserStorage): Map<string, string> {
  try {
    const raw = storage()?.getItem(NOT_NEEDED_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.entries)) return new Map();
    const entries = new Map<string, string>();
    for (const entry of parsed.entries as unknown[]) {
      if (!isRecord(entry) || !isId(entry.id) || !isHash(entry.hash)) continue;
      // Last mark wins, in its own place.
      entries.delete(entry.id);
      entries.set(entry.id, entry.hash);
    }
    return capped(entries);
  } catch {
    return new Map();
  }
}

/** Stores the marks, at most NOT_NEEDED_CAP of them. A failure to write is ignored. */
export function writeNotNeeded(notNeeded: NotNeeded, storage: StorageSource = browserStorage): void {
  try {
    const entries = [...capped(notNeeded)].map(([id, hash]) => ({ id, hash }));
    storage()?.setItem(NOT_NEEDED_KEY, JSON.stringify({ v: 1, entries }));
  } catch {
    // Blocked or full: the marks last until the page reloads.
  }
}

/**
 * `notNeeded` with `session` marked, as it needs now: last, as the newest mark, dropping the oldest past
 * NOT_NEEDED_CAP. The same map when it's already marked for what it needs now.
 */
export function withMark(notNeeded: NotNeeded, session: SessionSummary): NotNeeded {
  const hash = needHash(session);
  if (notNeeded.get(session.sessionId) === hash) return notNeeded;
  const next = new Map(notNeeded);
  next.delete(session.sessionId);
  next.set(session.sessionId, hash);
  return capped(next);
}

/** `notNeeded` without `sessionId`'s mark. The same map when it has none. */
export function withoutMark(notNeeded: NotNeeded, sessionId: string): NotNeeded {
  if (!notNeeded.has(sessionId)) return notNeeded;
  const next = new Map(notNeeded);
  next.delete(sessionId);
  return next;
}

/**
 * `notNeeded` without the marks whose session `sessions` lists with a different hash: what it needed
 * has changed. A mark whose session isn't listed stays. The same map when none goes.
 */
export function pruned(notNeeded: NotNeeded, sessions: readonly SessionSummary[]): NotNeeded {
  if (notNeeded.size === 0) return notNeeded;
  let next: Map<string, string> | undefined;
  for (const session of sessions) {
    const hash = notNeeded.get(session.sessionId);
    if (hash === undefined || hash === needHash(session)) continue;
    next ??= new Map(notNeeded);
    next.delete(session.sessionId);
  }
  return next ?? notNeeded;
}

export interface NotNeededMarks {
  /** The marks, oldest first, whether or not their sessions are in the snapshot. */
  entries: NotNeeded;
  /** Marks `session` not needed now, for what it needs now. */
  mark: (session: SessionSummary) => void;
  /** Takes `sessionId`'s mark away, so it's back in Needs you while it needs you. */
  unmark: (sessionId: string) => void;
  /** Drops the marks whose session `sessions` lists with what it needs changed (pruned()). */
  prune: (sessions: readonly SessionSummary[]) => void;
}

/**
 * The marks, read once from storage, and ways to change them. Each change is kept in memory first, so
 * it lasts for the page's life whatever storage does, then written, and only when something changed.
 * A change in another tab, or storage cleared (a null key), is read again; never written back, so two
 * tabs can't echo a change between them.
 */
export function useNotNeeded(storage: StorageSource = browserStorage, events: StarredEvents = window): NotNeededMarks {
  const [entries, setEntries] = useState<NotNeeded>(() => readNotNeeded(storage));
  const latest = useRef(entries);
  latest.current = entries;

  useEffect(() => {
    const onStorage = (event: Pick<StorageEvent, 'key'>) => {
      if (event.key !== NOT_NEEDED_KEY && event.key !== null) return;
      const next = readNotNeeded(storage);
      latest.current = next;
      setEntries(next);
    };
    events.addEventListener('storage', onStorage);
    return () => events.removeEventListener('storage', onStorage);
  }, [storage, events]);

  const change = useCallback(
    (update: (current: NotNeeded) => NotNeeded) => {
      const next = update(latest.current);
      if (next === latest.current) return;
      latest.current = next;
      setEntries(next);
      writeNotNeeded(next, storage);
    },
    [storage],
  );

  const mark = useCallback((session: SessionSummary) => change((current) => withMark(current, session)), [change]);
  const unmark = useCallback((sessionId: string) => change((current) => withoutMark(current, sessionId)), [change]);
  const prune = useCallback((sessions: readonly SessionSummary[]) => change((current) => pruned(current, sessions)), [change]);
  return { entries, mark, unmark, prune };
}
