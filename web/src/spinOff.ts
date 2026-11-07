// Spin-off proposals (W163; docs/design-system.md, 4: Spin-off proposals): a session proposes a new
// session (SessionSummary.spinOff), and you start it. Each proposal is a card in Needs you, naming the
// session that asked, with its folder, its name and the whole prompt (SpinOffCards.tsx), and counts
// wherever Needs you counts: its item's badge, the root tabs' and the page title.
//
// - Start asks the server to check the proposal (checkSpinOff(), spinOffPath()), by spawn_session's
//   checks, then opens New session filled in with what it checked, to read and change before it runs.
//   Nothing starts without New session's own Start session.
// - Dismiss takes the card away; so does starting it. Both are kept in the browser, as stars are
//   (starred.ts): one localStorage key, pitwall.spinOffs.v1, holding the dismissed proposals as
//   "<session id>:<key>", the key a hash of the block the index read, never its text:
//
//     {"v":1,"dismissed":["00000000-0000-4000-8000-000000000001:0123456789abcdef"]}
//
//   So a new proposal from the same session, with another key, shows again. At most
//   SPIN_OFFS_CAP entries, the oldest dropped. Storage that's missing or throws keeps the dismissals
//   for the page's life.
// - The index clears a proposal when the session's next turn ends without one, or a prompt comes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { spinOffPath, type SessionGroup, type SessionSummary, type SpinOff, type SpinOffCheck } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { browserStorage, type StorageSource } from './groupState.js';
import { activityMs } from './sessions.js';
import type { StarredEvents } from './starred.js';
import { sessionNeedsYou, type Work } from './work.js';

export const SPIN_OFFS_KEY = 'pitwall.spinOffs.v1';

/** The most dismissals kept: a few weeks of proposals, at about 55 bytes each. */
export const SPIN_OFFS_CAP = 200;

/** A session id, a colon and a 16-hex key: longer isn't one. */
const MAX_ENTRY_LENGTH = 300;

/** A proposal and the session that made it, as Needs you lists them. */
export interface ListedSpinOff {
  session: SessionSummary;
  spinOff: SpinOff;
}

/** How a dismissal is stored: the session's id and the proposal's key. */
export const spinOffId = (sessionId: string, key: string): string => `${sessionId}:${key}`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEntry = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= MAX_ENTRY_LENGTH;

function capped(entries: readonly string[]): string[] {
  const unique = [...new Set(entries)];
  return unique.length > SPIN_OFFS_CAP ? unique.slice(unique.length - SPIN_OFFS_CAP) : unique;
}

/** The dismissed proposals, oldest first: none when nothing is stored, storage throws, or the value isn't version 1's shape. */
export function readDismissed(storage: StorageSource = browserStorage): string[] {
  try {
    const raw = storage()?.getItem(SPIN_OFFS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.dismissed)) return [];
    return capped((parsed.dismissed as unknown[]).filter(isEntry));
  } catch {
    return [];
  }
}

function writeDismissed(entries: readonly string[], storage: StorageSource): void {
  try {
    storage()?.setItem(SPIN_OFFS_KEY, JSON.stringify({ v: 1, dismissed: capped(entries) }));
  } catch {
    // Blocked or full: the dismissals last until the page reloads.
  }
}

export interface DismissedSpinOffs {
  set: ReadonlySet<string>;
  dismiss: (sessionId: string, key: string) => void;
}

/** The dismissed proposals, read once from storage, and a way to dismiss one; another tab's change is read again. */
export function useDismissedSpinOffs(storage: StorageSource = browserStorage, events: StarredEvents = window): DismissedSpinOffs {
  const [entries, setEntries] = useState<readonly string[]>(() => readDismissed(storage));
  const latest = useRef(entries);
  latest.current = entries;

  useEffect(() => {
    const onStorage = (event: Pick<StorageEvent, 'key'>) => {
      if (event.key !== SPIN_OFFS_KEY && event.key !== null) return;
      const next = readDismissed(storage);
      latest.current = next;
      setEntries(next);
    };
    events.addEventListener('storage', onStorage);
    return () => events.removeEventListener('storage', onStorage);
  }, [storage, events]);

  const dismiss = useCallback(
    (sessionId: string, key: string) => {
      const entry = spinOffId(sessionId, key);
      if (latest.current.includes(entry)) return;
      const next = capped([...latest.current, entry]);
      latest.current = next;
      setEntries(next);
      writeDismissed(next, storage);
    },
    [storage],
  );

  const set = useMemo(() => new Set(entries), [entries]);
  return { set, dismiss };
}

/**
 * The groups' proposals that wait on you, each session once, newest activity first: not dismissed,
 * and not a stale session's, which the index never gives one anyway.
 */
export function openSpinOffs(groups: readonly Pick<SessionGroup, 'sessions'>[], dismissed: ReadonlySet<string>): ListedSpinOff[] {
  const seen = new Set<string>();
  const listed: ListedSpinOff[] = [];
  for (const group of groups) {
    for (const session of group.sessions) {
      if (seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
      const { spinOff } = session;
      if (spinOff === undefined || session.stale || dismissed.has(spinOffId(session.sessionId, spinOff.key))) continue;
      listed.push({ session, spinOff });
    }
  }
  return listed.sort((a, b) => activityMs(b.session) - activityMs(a.session));
}

/**
 * How many of `listed` add to a Needs you count: not a proposal whose session already counts there
 * as a row that needs you, so each session counts once (W163). Its card still shows.
 */
export function spinOffCount(listed: readonly ListedSpinOff[], work: Work): number {
  return listed.filter(({ session }) => !sessionNeedsYou(session, work)).length;
}

/** What a check came to: New session's prefill, or why not, in pitwall's words. */
export type SpinOffOutcome = { kind: 'checked'; cwd: string; name?: string; prompt: string } | { kind: 'failed'; error: string };

export const SPIN_OFF_UNEXPECTED = "pitwall didn't check the proposal: it didn't answer as expected.";

function asCheck(body: unknown): SpinOffCheck | undefined {
  if (!isRecord(body)) return undefined;
  if (body.ok === false && typeof body.error === 'string') return { ok: false, error: body.error };
  if (body.ok !== true || typeof body.cwd !== 'string' || typeof body.prompt !== 'string') return undefined;
  if (body.name !== undefined && typeof body.name !== 'string') return undefined;
  return { ok: true, cwd: body.cwd, prompt: body.prompt, ...(typeof body.name === 'string' ? { name: body.name } : {}) };
}

/** Asks the server to check `sessionId`'s proposal `key` before New session opens with it. Never rejects. */
export async function checkSpinOff(api: ApiClient, sessionId: string, key: string): Promise<SpinOffOutcome> {
  const result = await api.post(spinOffPath(sessionId), { key });
  if (result.kind === 'unauthorized') return { kind: 'failed', error: "pitwall didn't accept the page's key. Reload the page." };
  const body = asCheck(result.body);
  if (body === undefined) return { kind: 'failed', error: SPIN_OFF_UNEXPECTED };
  if (!body.ok) return { kind: 'failed', error: body.error };
  return { kind: 'checked', cwd: body.cwd, prompt: body.prompt, ...(body.name === undefined ? {} : { name: body.name }) };
}

/** The card's heading: the session that asked, by name. */
export const spinOffTitle = (name: string): string => `${name} proposes a new session`;

/** What Start does, under the heading. */
export const SPIN_OFF_NOTE = 'Start opens New session filled in with this, to read and change before it runs. Nothing starts until you start it there.';

/** Under the heading of one pitwall couldn't read: why, then what to do. */
export const SPIN_OFF_UNREADABLE = "pitwall found a proposal it won't show:";
export const SPIN_OFF_UNREADABLE_NEXT = 'Open the session to read it, or ask it to propose it again.';
