// Snooze (W154): Needs you is right about a session, but not now. Phil, 2026-11-06: "'later' means I
// actually don't want to prioritize this now, which is really a snooze." It replaces W88's Not needed
// now, which the browser kept (web/src/notNeeded.ts, gone). A flag (W153, flags.ts) is the other
// action: Needs you is wrong.
//
// A snooze is for a time, 1 hour, 3 hours, tomorrow or next week, which the page works out in your
// time zone and sends as `until`, or Later, with no `until`. While it holds, the snapshot carries
// `snoozed` on the session and the web UI leaves it out of Needs you and every count, as it does a
// flagged one. It ends:
//
//   - when `until` passes ('time'): a timer here, so it ends with no page open;
//   - when the session is woken ('woken'): its `wokenAt`, the newest turn something other than you
//     started (a message from another session, a sub-agent's report, a background task's
//     notification; never one you typed or pitwall's relay sent), is after the snooze. Not W88's rule,
//     where a change in what it needs brought it back, since a recap rewording the same to-do would
//     wake every Later (settled with Phil, 2026-11-06);
//   - when you take it off. Then nothing is said.
//
// One that ended by itself leaves `snoozeEnded` on the session for SNOOZE_ENDED_SHOWN_MS, so its row
// can say "Snooze ended" or "Woken: a new turn". A snooze on a session listed as ended or finished is
// dropped: it can't need you again without a resume, which is a turn you start.
//
//   POST snoozePath(id)    body: SnoozeRequest as JSON                answers: SnoozeResult
//     200  { ok: true, snoozed }
//     400, 404, 503  from resolveSession(); 400 also when the body isn't a SnoozeRequest, or `until`
//          isn't in the future or is more than SNOOZE_MAX_MS away
//     409  it doesn't need you now, or has ended or finished
//     413  the body is over SNOOZE_BODY_MAX_BYTES
//     415  the body isn't `Content-Type: application/json`
//
//   POST unsnoozePath(id)  no body                                    answers: SnoozeResult
//     200  { ok: true }: the snooze is gone, if there was one
//     400, 404, 503  from resolveSession()
//
// Both are POSTs, so the /api/* middleware in server.ts has already required the apiKey and this
// server's Origin. Nothing is sent to the session.
//
// Kept in $PITWALL_HOME/snoozes.json, 0600, written whole by rename on each change: each session's id,
// when it was snoozed, until when, and the ends still shown. Never session content. Read back at start
// as untrusted: a regular file of this user's, not a link, not writable by group or others, at most
// SNOOZE_FILE_MAX_BYTES; each entry checked, anything else skipped. Writing fails soft: the snooze
// holds in memory for this run.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isRecord } from '../index/guards.js';
import { isSafeSessionId } from '../index/index.js';
import {
  SNOOZE_ENDED_SHOWN_MS,
  SNOOZE_MAX_MS,
  snoozePath,
  unsnoozePath,
  type IndexSnapshot,
  type SessionSnooze,
  type SessionSummary,
  type SnoozeEnded,
  type SnoozeResult,
} from '../shared/protocol.js';
import { ensureLaunchDir } from './launch.js';
import type { SnapshotView } from './snapshotLinks.js';
import { createDecoratedView } from './snapshotRecaps.js';
import { resolveSession } from './sessions.js';

/** The file's name in pitwall's home. */
export const SNOOZE_FILE_NAME = 'snoozes.json';
/** The most snoozes held at once, and ends shown; past it the oldest goes, as flags do. */
export const SNOOZES_HELD_MAX = 500;
/** About 120 bytes an entry, so 1,000 entries fit with room. */
export const SNOOZE_FILE_MAX_BYTES = 256 * 1024;
/** A SnoozeRequest is a few dozen bytes. */
export const SNOOZE_BODY_MAX_BYTES = 4 * 1024;
/** setTimeout's longest delay; a longer wait is made in steps. */
const TIMER_MAX_MS = 2 ** 31 - 1;

interface StoredSnooze extends SessionSnooze {
  id: string;
}

interface StoredEnd extends SnoozeEnded {
  id: string;
}

export interface SnoozeStoreOptions {
  /** pitwall's home. Without one, snoozes are held in memory only. */
  home?: string;
  now?: () => Date;
  /** For tests: a stand-in for setTimeout and clearTimeout. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
}

const DEFAULT_TIMERS = {
  set: (fn: () => void, ms: number): unknown => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
};

const ms = (iso: string | undefined): number => (iso === undefined ? NaN : Date.parse(iso));

/** The snoozes held, their file, their timer and the snapshot's decoration. */
export class SnoozeStore {
  readonly #file: string | undefined;
  readonly #home: string | undefined;
  readonly #now: () => Date;
  readonly #timers: NonNullable<SnoozeStoreOptions['timers']>;
  readonly #snoozes = new Map<string, SessionSnooze>();
  readonly #ended = new Map<string, SnoozeEnded>();
  readonly #listeners = new Set<() => void>();
  #version = 0;
  #timer: unknown;
  #closed = false;

  constructor(options: SnoozeStoreOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#file = this.#home === undefined ? undefined : path.join(this.#home, SNOOZE_FILE_NAME);
    this.#now = options.now ?? (() => new Date());
    this.#timers = options.timers ?? DEFAULT_TIMERS;
    const stored = this.#file === undefined ? { snoozes: [], ended: [] } : readSnoozeFile(this.#file);
    for (const { id, ...snooze } of stored.snoozes) this.#snoozes.set(id, snooze);
    for (const { id, ...end } of stored.ended) if (!this.#snoozes.has(id)) this.#ended.set(id, end);
    this.#cap();
    this.#schedule();
  }

  /** Snoozes `sessionId` until `until`, or, without it, until it's woken. Replaces a snooze it had. */
  snooze(sessionId: string, until?: Date): SessionSnooze {
    const snooze: SessionSnooze = { at: this.#now().toISOString(), ...(until === undefined ? {} : { until: until.toISOString() }) };
    this.#snoozes.delete(sessionId);
    this.#snoozes.set(sessionId, snooze);
    this.#ended.delete(sessionId);
    this.#cap();
    this.#saved();
    return snooze;
  }

  /** Takes `sessionId`'s snooze off, and any end still shown. False when it had neither. */
  unsnooze(sessionId: string): boolean {
    const had = this.#snoozes.delete(sessionId);
    const shown = this.#ended.delete(sessionId);
    if (!had && !shown) return false;
    this.#saved();
    return true;
  }

  /**
   * `snapshot` with `snoozed` on each snoozed session, and `snoozeEnded` on each whose snooze ended by
   * itself in the last SNOOZE_ENDED_SHOWN_MS. A snooze whose time is up, or whose session was woken
   * after it, ends here; one whose session is listed as ended or finished is dropped. One whose
   * session isn't listed stays, since a failed poll can empty the list. A copy when any session changed.
   */
  decorate(snapshot: IndexSnapshot): IndexSnapshot {
    if (this.#snoozes.size === 0 && this.#ended.size === 0) return snapshot;
    const now = this.#now().getTime();
    let dirty = this.#expire(now);
    let changed = false;
    const groups = snapshot.groups.map((group) => {
      let groupChanged = false;
      const sessions = group.sessions.map((session) => {
        const id = session.sessionId;
        const snooze = this.#snoozes.get(id);
        if (snooze !== undefined) {
          if (session.finished || session.ended === true) {
            this.#snoozes.delete(id);
            dirty = true;
            return session;
          }
          const why = endOf(snooze, session, now);
          if (why === undefined) {
            groupChanged = true;
            return { ...session, snoozed: { ...snooze } };
          }
          // Not #changed(): this view already says so, and the next one has nothing to add.
          this.#snoozes.delete(id);
          this.#ended.set(id, { at: new Date(now).toISOString(), why });
          dirty = true;
        }
        const end = this.#ended.get(id);
        if (end === undefined) return session;
        groupChanged = true;
        return { ...session, snoozeEnded: { ...end } };
      });
      if (!groupChanged) return group;
      changed = true;
      return { ...group, sessions };
    });
    if (dirty) {
      this.#cap();
      this.#write();
      this.#schedule();
    }
    return changed ? { ...snapshot, groups } : snapshot;
  }

  /** Changes whenever decorate() could answer differently for the same snapshot. */
  version(): number {
    return this.#version;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Stops the timer. The snoozes stay on disk for the next run. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
  }

  /** Drops the ends shown long enough. True when one went. */
  #expire(now: number): boolean {
    let dropped = false;
    for (const [id, end] of this.#ended) {
      if (ms(end.at) + SNOOZE_ENDED_SHOWN_MS <= now) {
        this.#ended.delete(id);
        dropped = true;
      }
    }
    return dropped;
  }

  #cap(): void {
    while (this.#snoozes.size > SNOOZES_HELD_MAX) this.#snoozes.delete(this.#snoozes.keys().next().value!);
    while (this.#ended.size > SNOOZES_HELD_MAX) this.#ended.delete(this.#ended.keys().next().value!);
  }

  /** After a change of yours: written, the timer set again, and every view told. */
  #saved(): void {
    this.#write();
    this.#schedule();
    this.#changed();
  }

  #changed(): void {
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * The timer, set for the next snooze's time or the next end to stop showing, whichever comes first,
   * of those still ahead. One already due ends at the next decorate(), which every poll makes while a
   * page or the supervisor reads the snapshot, so the timer never spins on it.
   */
  #schedule(): void {
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
    if (this.#closed) return;
    const now = this.#now().getTime();
    let next = Infinity;
    const consider = (at: number) => {
      if (at > now) next = Math.min(next, at);
    };
    for (const snooze of this.#snoozes.values()) if (snooze.until !== undefined) consider(ms(snooze.until));
    for (const end of this.#ended.values()) consider(ms(end.at) + SNOOZE_ENDED_SHOWN_MS);
    if (!Number.isFinite(next)) return;
    this.#timer = this.#timers.set(() => {
      this.#timer = undefined;
      // The views decorate again with the new time, which ends what's due; then the next one's timer.
      this.#changed();
      this.#schedule();
    }, Math.min(next - now, TIMER_MAX_MS));
  }

  /** The file, written whole by rename. Fails soft. */
  #write(): void {
    if (this.#file === undefined || this.#home === undefined) return;
    const body = {
      v: 1,
      snoozes: [...this.#snoozes].map(([id, snooze]) => ({ id, ...snooze })),
      ended: [...this.#ended].map(([id, end]) => ({ id, ...end })),
    };
    const temporary = `${this.#file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      ensureLaunchDir(this.#home);
      writeFileSync(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.#file);
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        // Never written.
      }
    }
  }
}

/** Why `snooze` has ended at `now` for `session`, or undefined while it holds. */
function endOf(snooze: SessionSnooze, session: SessionSummary, now: number): SnoozeEnded['why'] | undefined {
  if (ms(session.wokenAt) > ms(snooze.at)) return 'woken';
  if (snooze.until !== undefined && ms(snooze.until) <= now) return 'time';
  return undefined;
}

const isTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));

/**
 * The snoozes and ends in the file at `file` that check out; none when there's no file or it can't be
 * trusted: not a regular file of this user's, a link, writable by group or others, or over
 * SNOOZE_FILE_MAX_BYTES.
 */
export function readSnoozeFile(file: string): { snoozes: StoredSnooze[]; ended: StoredEnd[] } {
  const none = { snoozes: [], ended: [] };
  let fd: number | undefined;
  let value: unknown;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > SNOOZE_FILE_MAX_BYTES) return none;
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    value = JSON.parse(buffer.subarray(0, read).toString('utf8'));
  } catch {
    return none;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!isRecord(value) || value.v !== 1) return none;
  const snoozes: StoredSnooze[] = [];
  const ended: StoredEnd[] = [];
  for (const entry of Array.isArray(value.snoozes) ? (value.snoozes as unknown[]) : []) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !isSafeSessionId(entry.id) || !isTime(entry.at)) continue;
    if (entry.until !== undefined && !isTime(entry.until)) continue;
    snoozes.push({ id: entry.id, at: entry.at, ...(entry.until === undefined ? {} : { until: entry.until }) });
  }
  for (const entry of Array.isArray(value.ended) ? (value.ended as unknown[]) : []) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !isSafeSessionId(entry.id) || !isTime(entry.at)) continue;
    if (entry.why !== 'time' && entry.why !== 'woken') continue;
    ended.push({ id: entry.id, at: entry.at, why: entry.why });
  }
  return { snoozes, ended };
}

/** `source`'s snapshots with each snoozed session's `snoozed`, and `snoozeEnded` while it's shown. */
export function createSnoozeView(source: Pick<SnapshotView, 'latest' | 'subscribe'>, store: SnoozeStore): SnapshotView {
  return createDecoratedView(source, { decorate: (snapshot) => store.decorate(snapshot), version: () => store.version(), subscribe: (listener) => store.subscribe(listener) });
}

/** The SnoozeRequest in `body`, or why it isn't one. `until` checked against `now`. */
export function validateSnoozeRequest(body: unknown, now: Date): { ok: true; until?: Date } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'The body must be a JSON object.' };
  for (const key of Object.keys(body)) if (key !== 'until') return { ok: false, error: 'The body has a field pitwall doesn’t know.' };
  if (body.until === undefined) return { ok: true };
  if (!isTime(body.until)) return { ok: false, error: 'Say when the snooze ends as a time, or leave it out for Later.' };
  const until = new Date(body.until);
  if (until.getTime() <= now.getTime()) return { ok: false, error: 'That time has passed. Choose a later one.' };
  if (until.getTime() - now.getTime() > SNOOZE_MAX_MS) return { ok: false, error: 'A snooze can last at most 31 days.' };
  return { ok: true, until };
}

const SNOOZE_ROUTE = decodeURIComponent(snoozePath(':sessionId'));
const UNSNOOZE_ROUTE = decodeURIComponent(unsnoozePath(':sessionId'));

const LOOKUP_ERRORS = {
  400: 'That is not a valid session id.',
  404: "That session isn't in pitwall's list.",
  503: "pitwall hasn't listed the sessions yet. Try again in a moment.",
} as const;

export interface SnoozeRouteSources {
  /** The snapshot the page sees, or one under it with `needsYou`, `ended` and `finished`. */
  snapshots: Pick<SnapshotView, 'latest'>;
  store: SnoozeStore;
  now?: () => Date;
}

/** Adds the snooze routes. Call it after the /api/* checks and before the /api/* catch-all. */
export function registerSnoozes(app: Hono, sources: SnoozeRouteSources): void {
  const now = sources.now ?? (() => new Date());
  const answer = (c: Context, result: SnoozeResult, status: 200 | 400 | 404 | 409 | 413 | 415 | 503) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };

  app.post(
    SNOOZE_ROUTE,
    bodyLimit({ maxSize: SNOOZE_BODY_MAX_BYTES, onError: (c) => answer(c, { ok: false, error: 'The request is too large.' }, 413) }),
    async (c) => {
      const lookup = resolveSession(sources.snapshots, c.req.param('sessionId'));
      if (!lookup.ok) return answer(c, { ok: false, error: LOOKUP_ERRORS[lookup.status] }, lookup.status);
      const type = c.req.header('content-type') ?? '';
      if (!/^application\/json\s*(;|$)/i.test(type)) return answer(c, { ok: false, error: 'Send the request as application/json.' }, 415);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return answer(c, { ok: false, error: "The body isn't valid JSON." }, 400);
      }
      const request = validateSnoozeRequest(body, now());
      if (!request.ok) return answer(c, { ok: false, error: request.error }, 400);
      const { session } = lookup;
      if (session.finished || session.ended === true) return answer(c, { ok: false, error: "It has finished, so there's nothing to snooze." }, 409);
      if (session.needsYou === undefined) return answer(c, { ok: false, error: "It doesn't need you now, so there's nothing to snooze." }, 409);
      const snoozed = sources.store.snooze(session.sessionId, request.until);
      return answer(c, { ok: true, snoozed }, 200);
    },
  );

  app.post(UNSNOOZE_ROUTE, (c) => {
    const lookup = resolveSession(sources.snapshots, c.req.param('sessionId'));
    if (!lookup.ok) return answer(c, { ok: false, error: LOOKUP_ERRORS[lookup.status] }, lookup.status);
    sources.store.unsnooze(lookup.session.sessionId);
    return answer(c, { ok: true }, 200);
  });
}
