// Spin-off proposals (W163; docs/design-system.md, 4: Spin-off proposals): a session proposes a new
// session (SessionSummary.spinOff), and you start it. Each proposal is a card in Needs you, naming the
// session that asked, with its folder, its name and the whole prompt (SpinOffCards.tsx), and counts
// wherever Needs you counts: its item's badge, the root tabs' and the page title.
//
// - Start asks the server to check the proposal (checkSpinOff(), spinOffPath()), by spawn_session's
//   checks, then opens New session filled in with what it checked, to read and change before it runs.
//   Nothing starts without New session's own Start session.
// - Dismiss takes the card away; so does starting it. Since W212 the server keeps both
//   ($PITWALL_HOME/spin-offs.json, src/server/spinOffs.ts) and marks the proposal `settled` on the
//   snapshot, so every page agrees, and it also settles a proposal when a session with its name and
//   folder began after it, however it was started. A new proposal from the same session, with another
//   key, shows again. The browser's pitwall.spinOffs.v1, "<session id>:<key>" entries (the key a hash
//   of the block, never its text), is read once and sent to the server, then emptied.
// - The index clears a proposal when the session's next turn ends without one, or a prompt comes.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { endsWithBackslash, isOwnHandoff } from '../../src/shared/handoff.js';
import { clearAndContinuePath, continuedPath, SPIN_OFF_MIGRATE_MAX, SPIN_OFF_MIGRATE_PATH, spinOffPath, spinOffSettlePath, type ClearAndContinueResult, type SessionGroup, type SessionSummary, type SpinOff, type SpinOffCheck } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { browserStorage, type StorageSource } from './groupState.js';
import { activityMs } from './sessions.js';
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

export interface DismissedSpinOffs {
  /** Settled in this page since it loaded, ahead of the server's word on the snapshot: "<session id>:<key>". */
  set: ReadonlySet<string>;
  /** Dismiss the proposal: it goes at once, and the server keeps it, so every page agrees (W212). */
  dismiss: (sessionId: string, key: string) => void;
  /** The proposal was started from its card: as dismiss, but kept as started. */
  start: (sessionId: string, key: string) => void;
}

/**
 * The proposals settled from this page, and a way to settle one (W212). The server keeps each Start and
 * Dismiss ($PITWALL_HOME/spin-offs.json) and marks the proposal `settled` on the snapshot, which is what
 * every page, on every port, goes by; `set` only covers the moment before the snapshot says so. The
 * dismissals the browser kept before W212 are sent to the server once, then emptied here.
 */
export function useDismissedSpinOffs(api: ApiClient | undefined, storage: StorageSource = browserStorage): DismissedSpinOffs {
  const [entries, setEntries] = useState<ReadonlySet<string>>(() => new Set(readDismissed(storage)));

  useEffect(() => {
    if (api === undefined) return;
    const old = readDismissed(storage);
    if (old.length === 0) return;
    let live = true;
    void api.post(SPIN_OFF_MIGRATE_PATH, { dismissed: old.slice(-SPIN_OFF_MIGRATE_MAX) }).then(
      (result) => {
        if (!live || result.kind !== 'ok') return;
        try {
          storage()?.setItem(SPIN_OFFS_KEY, JSON.stringify({ v: 1, dismissed: [] }));
        } catch {
          // Blocked: it's sent again next time, which the server takes as nothing new.
        }
      },
    );
    return () => {
      live = false;
    };
  }, [api, storage]);

  const settle = useCallback(
    (sessionId: string, key: string, how: 'started' | 'dismissed') => {
      setEntries((current) => new Set(current).add(spinOffId(sessionId, key)));
      // A dismissal the server didn't take brings the card back; a start stays hidden (the server's matcher is the backstop).
      if (api === undefined) return;
      void api.post(spinOffSettlePath(sessionId), { key, how }).then((result) => {
        if (result.kind === 'ok' || how === 'started') return;
        setEntries((current) => {
          const next = new Set(current);
          next.delete(spinOffId(sessionId, key));
          return next;
        });
      });
    },
    [api],
  );
  const dismiss = useCallback((sessionId: string, key: string) => settle(sessionId, key, 'dismissed'), [settle]);
  const start = useCallback((sessionId: string, key: string) => settle(sessionId, key, 'started'), [settle]);
  return useMemo(() => ({ set: entries, dismiss, start }), [entries, dismiss, start]);
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
      if (spinOff === undefined || spinOff.settled !== undefined || session.stale || dismissed.has(spinOffId(session.sessionId, spinOff.key))) continue;
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

/** A hand-off card's heading (W210): the session that handed off, by name. */
export const handoffTitle = (name: string): string => `${name} handed off to free up context`;

/** What Start does, under the heading. */
export const SPIN_OFF_NOTE = 'Start opens New session filled in with this, to read and change before it runs. Nothing starts until you start it there.';

/** Under the heading of one pitwall couldn't read: why, then what to do. */
export const SPIN_OFF_UNREADABLE = "pitwall found a proposal it won't show:";
export const SPIN_OFF_UNREADABLE_NEXT = 'Open the session to read it, or ask it to propose it again.';

// --- Clear and continue (W168) -----------------------------------------------------------------------

/**
 * Whether the card for `session`'s proposal can offer Clear and continue: it's that session's own
 * hand-off (its prompt starts with "Continues session <its id>."), and the session is a running
 * background job. The server checks all of it again, from its own snapshot and a fresh listing.
 */
export function canClearAndContinue(session: SessionSummary, spinOff: SpinOff): boolean {
  return (
    spinOff.kind === 'proposal' &&
    isOwnHandoff(session.sessionId, spinOff) &&
    !endsWithBackslash(spinOff.prompt) &&
    session.kind === 'background' &&
    session.shortId !== undefined &&
    session.alive &&
    session.ended !== true &&
    !session.stale
  );
}

/** Whether the proposal is `session`'s own hand-off, whatever kind of session it is. */
export const isHandoffProposal = (session: Pick<SessionSummary, 'sessionId'>, spinOff: SpinOff): boolean => isOwnHandoff(session.sessionId, spinOff);

export type ClearOutcome = { kind: 'cleared'; sessionId: string } | { kind: 'failed'; error: string };

export const CLEAR_UNEXPECTED = "pitwall didn't answer Clear and continue as expected.";

/** Asks the server to clear the job and type the hand-off's prompt (clearAndContinuePath()). Never rejects. */
export async function clearAndContinue(api: ApiClient, sessionId: string, key: string): Promise<ClearOutcome> {
  const result = await api.post(clearAndContinuePath(sessionId), { key });
  if (result.kind === 'unauthorized') return { kind: 'failed', error: "pitwall didn't accept the page's key. Reload the page." };
  const body = result.body as ClearAndContinueResult | undefined;
  if (isRecord(body) && body.ok === true && typeof body.sessionId === 'string') return { kind: 'cleared', sessionId: body.sessionId };
  if (isRecord(body) && body.ok === false && typeof body.error === 'string') return { kind: 'failed', error: body.error };
  return { kind: 'failed', error: CLEAR_UNEXPECTED };
}

/** Tells the server which session was just started from `fromSessionId`'s hand-off, for the lineage log. Best effort. */
export async function noteContinued(api: ApiClient, fromSessionId: string, shortId: string): Promise<void> {
  try {
    await api.post(continuedPath(fromSessionId), { shortId });
  } catch {
    // The link is a convenience; the session has started.
  }
}

/** What a hand-off card says Clear and continue does, under the heading. */
export const SPIN_OFF_CLEAR_NOTE =
  'Clear and continue types /clear into this job, then the prompt below as one message. The job, its name and its pull requests stay. Nothing runs until you click it.';
/** Under a hand-off pitwall's recap found in the session's last message (W210), rather than its own block. */
export const SPIN_OFF_RECAP_NOTE =
  "pitwall's recap picked this prompt out of the session's last message. Check it's the hand-off before you click.";
/** What the hand-off card's Start does, beside Clear and continue. */
export const SPIN_OFF_HANDOFF_START_NOTE = 'Start opens New session filled in with this, to start a separate session instead. End session on the old one is yours to do.';
/** The toast once a job is cleared and has its prompt. */
export const clearedText = (name: string) => `Cleared ${name} and sent it the prompt. It carries on as the same job.`;
