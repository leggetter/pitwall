// A spin-off proposal you've started or dismissed (W212, a started spin-off leaves Needs you, however
// you started it). Phil, 2026-11-24: sessions sat in Needs you with a card for work that was already
// running, because a Start or Dismiss was kept in one browser's localStorage (W163), per origin, and
// a session started from another port's page, a terminal or another session left no trace.
//
// The server keeps it, in $PITWALL_HOME/spin-offs.json, 0600:
//
//   {"v":1,"entries":[{"id":"<proposer's session id>:<16-hex key>","how":"started"|"dismissed",
//                      "at":"<ISO time>","session"?:"<started session id>","name"?:"<its name>"}]}
//
// Ids, the block's key (a hash), times and the started session's name: never the prompt or any other
// session text. Read back as untrusted (opened without following a link or blocking on a FIFO, a
// regular file of this user's, not writable by group or others, at most SPIN_OFFS_FILE_MAX_BYTES;
// each entry checked field by field and made again), at most SPIN_OFFS_HELD_MAX entries, the oldest
// dropped. Written whole by rename after reading the file again and merging it, the newer entry of
// each id winning, so a second pitwall on the same home doesn't lose this one's. Fails soft: a missing
// or corrupt file reads as empty, a failed write leaves the entry in memory for this run.
//
// Two ways a proposal is settled, both shown as SpinOff.settled on the snapshot (decorate()):
//   - a click: the page's Start (once New session has started it) or Dismiss, POST spinOffSettlePath();
//   - found: a session whose name equals the proposal's name, in the proposal's folder (each by its real
//     path, as checkSpawn() resolves the folder), began after the proposal's message, however it was
//     started: another page, a terminal's `claude --bg --name`, another session. A job's later sessions
//     after /clear count too (W167's lineage: a session whose predecessors include a match). Found
//     only hides a card, it never starts anything, so a name the session chose is enough. The first
//     time one is found it's recorded, so the card doesn't come back if that session is removed later.
// The proposal's message time is the proposer's lastActivityAt: a proposal holds only while its turn
// has ended and no prompt has come since, so nothing is newer.
// A session's own hand-off (isOwnHandoff(), W210) is never found by name and folder: it's the proposer
// continuing itself, and W210 clears it when the job really continues (a new prompt or session id).
// Only a click settles it.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isRecord } from '../index/guards.js';
import { isOwnHandoff } from '../shared/handoff.js';
import { hiddenCharacter } from '../shared/hiddenText.js';
import {
  SPIN_OFF_MIGRATE_MAX,
  SPIN_OFF_MIGRATE_PATH,
  SPIN_OFF_NAME_MAX,
  spinOffSettlePath,
  type IndexSnapshot,
  type SessionSummary,
  type SpinOff,
  type SpinOffSettled,
  type SpinOffSettleResult,
} from '../shared/protocol.js';
import { LOOKUP_ERRORS } from './actions.js';
import { ensureLaunchDir } from './launch.js';
import { resolveSession } from './sessions.js';
import type { SnapshotView } from './snapshotLinks.js';
import { createDecoratedView } from './snapshotRecaps.js';

/** The file's name in pitwall's home. */
export const SPIN_OFFS_FILE_NAME = 'spin-offs.json';
/** The most entries held; past it the oldest go. At about 200 bytes each, the file stays under 120 KB. */
export const SPIN_OFFS_HELD_MAX = 500;
export const SPIN_OFFS_FILE_MAX_BYTES = 256 * 1024;
/** A settle request is `{ "key": "<16 hex>", "how": "dismissed" }`; a migration is up to 200 ids of about 55 bytes. */
export const SPIN_OFF_SETTLE_BODY_MAX_BYTES = 512;
export const SPIN_OFF_MIGRATE_BODY_MAX_BYTES = 32 * 1024;
/** How far up a lineage chain a match is looked for. */
const LINEAGE_STEPS_MAX = 10;
/** The most real paths remembered. */
const REAL_PATHS_MAX = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[0-9a-f]{16}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** How an entry is stored: the proposer's session id and the proposal's key. */
export const spinOffEntryId = (sessionId: string, key: string): string => `${sessionId}:${key}`;

/** Whether `id` is a stored id: a session id, a colon and a 16-hex key. */
export function isSpinOffEntryId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length !== 36 + 1 + 16) return false;
  return UUID.test(id.slice(0, 36)) && id[36] === ':' && KEY.test(id.slice(37));
}

interface Entry {
  how: 'started' | 'dismissed';
  at: string;
  session?: string;
  name?: string;
}

const ms = (iso: string): number => Date.parse(iso);
const own = (record: Record<string, unknown>, name: string): unknown => (Object.hasOwn(record, name) ? record[name] : undefined);
const isTime = (value: unknown): value is string => typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
/** A name as a session would give one: short, no character that doesn't show as itself. */
const isSafeName = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= SPIN_OFF_NAME_MAX && hiddenCharacter(value) === undefined;

export interface SpinOffStoreOptions {
  /** pitwall's home. Without one, entries are held in memory only. */
  home?: string;
  now?: () => Date;
  /** The session `sessionId` continues, from the lineage log (W167), for a job's sessions after /clear. */
  predecessorOf?: (sessionId: string) => string | undefined;
}

/** What the engine and the snapshot want to know about one proposal. */
export interface StartedSpinOff {
  how: 'started' | 'dismissed';
  at: string;
  sessionId?: string;
  name?: string;
}

/** The settled proposals held, their file and the snapshot's decoration. */
export class SpinOffStore {
  readonly #file: string | undefined;
  readonly #home: string | undefined;
  readonly #now: () => Date;
  readonly #predecessorOf: (sessionId: string) => string | undefined;
  /** By id, oldest first. */
  #entries = new Map<string, Entry>();
  readonly #realPaths = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(options: SpinOffStoreOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#file = this.#home === undefined ? undefined : path.join(this.#home, SPIN_OFFS_FILE_NAME);
    this.#now = options.now ?? (() => new Date());
    this.#predecessorOf = options.predecessorOf ?? (() => undefined);
    if (this.#file !== undefined) for (const [id, entry] of readSpinOffsFile(this.#file, this.#now())) this.#entries.set(id, entry);
  }

  /** Settles `sessionId`'s proposal `key`. A started one keeps the session it was started as, when known. */
  settle(sessionId: string, key: string, how: 'started' | 'dismissed', started?: { sessionId?: string; name?: string }): void {
    const id = spinOffEntryId(sessionId, key);
    const entry: Entry = {
      how,
      at: this.#now().toISOString(),
      ...(started?.sessionId !== undefined && UUID.test(started.sessionId) ? { session: started.sessionId } : {}),
      ...(isSafeName(started?.name) ? { name: started.name } : {}),
    };
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    this.#cap();
    this.#write();
    this.#changed();
  }

  /** The dismissals the browser kept before W212 (`<session id>:<key>`), as dismissed now. Returns how many were new. */
  migrate(ids: readonly unknown[]): number {
    let added = 0;
    const at = this.#now().toISOString();
    for (const id of ids.slice(0, SPIN_OFF_MIGRATE_MAX)) {
      if (!isSpinOffEntryId(id) || this.#entries.has(id)) continue;
      this.#entries.set(id, { how: 'dismissed', at });
      added += 1;
    }
    if (added === 0) return 0;
    this.#cap();
    this.#write();
    this.#changed();
    return added;
  }

  /** What's settled about `sessionId`'s proposal `key`: a click's record, or a started session found now (and then recorded). */
  settledOf(session: SessionSummary, snapshot: IndexSnapshot): SpinOffSettled | undefined {
    const { spinOff } = session;
    if (spinOff === undefined) return undefined;
    const id = spinOffEntryId(session.sessionId, spinOff.key);
    const held = this.#entries.get(id);
    if (held !== undefined) return settledOf(held);
    const found = this.#find(session, spinOff, snapshot);
    if (found === undefined) return undefined;
    const entry: Entry = { how: 'started', at: this.#now().toISOString(), session: found.sessionId, ...(isSafeName(found.name) ? { name: found.name } : {}) };
    this.#entries.set(id, entry);
    this.#cap();
    this.#write();
    // Not told from here, which can be inside a snapshot's decoration; the next view carries it.
    this.#version += 1;
    return settledOf(entry);
  }

  /** `snapshot` with `settled` on each proposal that's started or dismissed. A copy when any changed. */
  decorate(snapshot: IndexSnapshot): IndexSnapshot {
    let changed = false;
    const groups = snapshot.groups.map((group) => {
      let groupChanged = false;
      const sessions = group.sessions.map((session) => {
        if (session.spinOff === undefined) return session;
        let settled: SpinOffSettled | undefined;
        try {
          settled = this.settledOf(session, snapshot);
        } catch {
          settled = undefined;
        }
        if (settled === undefined) return session;
        groupChanged = true;
        return { ...session, spinOff: { ...session.spinOff, settled } as SpinOff };
      });
      if (!groupChanged) return group;
      changed = true;
      return { ...group, sessions };
    });
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

  /** How many entries are held. */
  size(): number {
    return this.#entries.size;
  }

  #find(proposer: SessionSummary, spinOff: SpinOff, snapshot: IndexSnapshot): { sessionId: string; name: string } | undefined {
    if (spinOff.kind !== 'proposal' || spinOff.name === undefined || isOwnHandoff(proposer.sessionId, spinOff)) return undefined;
    const since = ms(proposer.lastActivityAt ?? proposer.startedAt);
    if (Number.isNaN(since)) return undefined;
    const folder = this.#realPath(spinOff.folder);
    const all = new Map<string, SessionSummary>();
    for (const group of snapshot.groups) for (const each of group.sessions) if (!all.has(each.sessionId)) all.set(each.sessionId, each);
    const matches = (each: SessionSummary): boolean =>
      each.sessionId !== proposer.sessionId && each.name === spinOff.name && ms(each.startedAt) >= since && this.#realPath(each.cwd) === folder;
    for (const candidate of all.values()) {
      if (candidate.sessionId === proposer.sessionId) continue;
      let at: SessionSummary | undefined = candidate;
      for (let step = 0; at !== undefined && step <= LINEAGE_STEPS_MAX; step += 1) {
        if (matches(at)) return { sessionId: at.sessionId, name: at.name };
        const before: string | undefined = this.#predecessorOf(at.sessionId) ?? at.lineage?.from;
        at = before === undefined || before === proposer.sessionId ? undefined : all.get(before);
      }
    }
    return undefined;
  }

  /** `folder` by its real path as checkSpawn() resolves it; as written (resolved) when it can't be read. */
  #realPath(folder: string): string {
    const cached = this.#realPaths.get(folder);
    if (cached !== undefined) return cached;
    let resolved = path.resolve(folder);
    let real = false;
    try {
      resolved = realpathSync(resolved);
      real = true;
    } catch {
      // A folder that isn't there: compared as written.
    }
    if (real) {
      if (this.#realPaths.size >= REAL_PATHS_MAX) this.#realPaths.delete(this.#realPaths.keys().next().value!);
      this.#realPaths.set(folder, resolved);
    }
    return resolved;
  }

  #cap(): void {
    while (this.#entries.size > SPIN_OFFS_HELD_MAX) this.#entries.delete(this.#entries.keys().next().value!);
  }

  #changed(): void {
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }

  /** The file read again and merged (the newer entry of each id wins), then written whole by rename. Fails soft. */
  #write(): void {
    if (this.#file === undefined || this.#home === undefined) return;
    for (const [id, entry] of readSpinOffsFile(this.#file, this.#now())) {
      const mine = this.#entries.get(id);
      if (mine === undefined || ms(mine.at) < ms(entry.at)) {
        this.#entries.delete(id);
        this.#entries.set(id, entry);
      }
    }
    this.#entries = new Map([...this.#entries].sort((a, b) => ms(a[1].at) - ms(b[1].at)));
    this.#cap();
    const body = { v: 1, entries: [...this.#entries].map(([id, entry]) => ({ id, ...entry })) };
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

function settledOf(entry: Entry): SpinOffSettled {
  return { how: entry.how, at: entry.at, ...(entry.session === undefined ? {} : { sessionId: entry.session }), ...(entry.name === undefined ? {} : { name: entry.name }) };
}

/**
 * The entries in the file at `file` that check out, oldest first; none when there's no file or it can't
 * be trusted: not a regular file of this user's, a link, a FIFO, writable by group or others, over
 * SPIN_OFFS_FILE_MAX_BYTES, or not JSON of version 1. Each entry is read by own property only and made
 * again from its checked fields; one that fails is skipped, and a time in the future is now.
 */
export function readSpinOffsFile(file: string, now: Date = new Date()): Map<string, Entry> {
  const none = new Map<string, Entry>();
  let fd: number | undefined;
  let value: unknown;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > SPIN_OFFS_FILE_MAX_BYTES) return none;
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
  if (!isRecord(value) || own(value, 'v') !== 1) return none;
  const raw = own(value, 'entries');
  const kept: [string, Entry][] = [];
  for (const item of Array.isArray(raw) ? (raw as unknown[]).slice(0, SPIN_OFFS_HELD_MAX * 2) : []) {
    if (!isRecord(item)) continue;
    const id = own(item, 'id');
    const how = own(item, 'how');
    const at = own(item, 'at');
    const session = own(item, 'session');
    const name = own(item, 'name');
    if (!isSpinOffEntryId(id) || (how !== 'started' && how !== 'dismissed') || !isTime(at)) continue;
    if (session !== undefined && (typeof session !== 'string' || !UUID.test(session))) continue;
    if (name !== undefined && !isSafeName(name)) continue;
    const time = ms(at) > now.getTime() ? now.toISOString() : new Date(ms(at)).toISOString();
    kept.push([id, { how, at: time, ...(session === undefined ? {} : { session }), ...(name === undefined ? {} : { name }) }]);
  }
  kept.sort((a, b) => ms(a[1].at) - ms(b[1].at));
  const map = new Map<string, Entry>();
  for (const [id, entry] of kept) {
    map.delete(id);
    map.set(id, entry);
  }
  while (map.size > SPIN_OFFS_HELD_MAX) map.delete(map.keys().next().value!);
  return map;
}

/** `source`'s snapshots with each settled proposal's `settled` (W212). */
export function createSpinOffView(source: Pick<SnapshotView, 'latest' | 'subscribe'>, store: SpinOffStore): SnapshotView {
  return createDecoratedView(source, { decorate: (snapshot) => store.decorate(snapshot), version: () => store.version(), subscribe: (listener) => store.subscribe(listener) });
}

/** The settle route's SPIN_OFF_ROUTE, as a Hono pattern: spinOffSettlePath() encodes its argument. */
const SETTLE_ROUTE = decodeURIComponent(spinOffSettlePath(':sessionId'));

export interface SpinOffSettleSources {
  snapshots: { latest(): IndexSnapshot | undefined };
  store: SpinOffStore;
}

/**
 * Adds the two routes, after the /api/* checks (the apiKey and this server's Origin, server.ts):
 *
 *   POST spinOffSettlePath(id)   body: { key, how: 'started' | 'dismissed' }   answers: SpinOffSettleResult
 *     200  recorded
 *     400, 404, 503  from resolveSession(); 400 also when the body isn't that
 *     409  the session proposes nothing now, or another proposal than the card showed
 *     413, 415  the body is too large, or isn't `Content-Type: application/json`
 *   POST SPIN_OFF_MIGRATE_PATH   body: { dismissed: ["<session id>:<key>", ...] }   answers: SpinOffSettleResult
 *     200  each well-formed id recorded as dismissed; 400, 413, 415 as above
 *
 * Nothing starts and nothing is sent to a session. The proposal is the snapshot's, never the
 * request's: the request names only which one and what happened to it.
 */
export function registerSpinOffSettle(app: Hono, sources: SpinOffSettleSources): void {
  const answer = (c: Context, result: SpinOffSettleResult, status: 200 | 400 | 404 | 409 | 413 | 415 | 503) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };
  const jsonBody = async (c: Context): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 415; error: string }> => {
    const type = c.req.header('content-type') ?? '';
    if (!/^application\/json\s*(;|$)/i.test(type)) return { ok: false, status: 415, error: 'Send the request as application/json.' };
    try {
      return { ok: true, body: await c.req.json() };
    } catch {
      return { ok: false, status: 400, error: "The body isn't valid JSON." };
    }
  };

  app.post(
    SETTLE_ROUTE,
    bodyLimit({ maxSize: SPIN_OFF_SETTLE_BODY_MAX_BYTES, onError: (c) => answer(c, { ok: false, error: 'The request is too large.' }, 413) }),
    async (c) => {
      const lookup = resolveSession(sources.snapshots, c.req.param('sessionId'));
      if (!lookup.ok) return answer(c, { ok: false, error: LOOKUP_ERRORS[lookup.status] }, lookup.status);
      const read = await jsonBody(c);
      if (!read.ok) return answer(c, { ok: false, error: read.error }, read.status);
      const body = read.body;
      if (!isRecord(body) || Object.keys(body).length !== 2) return answer(c, { ok: false, error: 'The body must be { key, how }.' }, 400);
      const key = own(body, 'key');
      const how = own(body, 'how');
      if (typeof key !== 'string' || !KEY.test(key) || (how !== 'started' && how !== 'dismissed')) return answer(c, { ok: false, error: 'The body must be { key, how }, with how started or dismissed.' }, 400);
      const proposal = lookup.session.spinOff;
      if (proposal === undefined) return answer(c, { ok: false, error: 'That session doesn’t propose a new session now.' }, 409);
      if (proposal.key !== key) return answer(c, { ok: false, error: 'That session has proposed something else since.' }, 409);
      sources.store.settle(lookup.session.sessionId, key, how);
      return answer(c, { ok: true }, 200);
    },
  );

  app.post(
    SPIN_OFF_MIGRATE_PATH,
    bodyLimit({ maxSize: SPIN_OFF_MIGRATE_BODY_MAX_BYTES, onError: (c) => answer(c, { ok: false, error: 'The request is too large.' }, 413) }),
    async (c) => {
      const read = await jsonBody(c);
      if (!read.ok) return answer(c, { ok: false, error: read.error }, read.status);
      const body = read.body;
      const dismissed = isRecord(body) && Object.keys(body).length === 1 ? own(body, 'dismissed') : undefined;
      if (!Array.isArray(dismissed)) return answer(c, { ok: false, error: 'The body must be { dismissed: [ids] }.' }, 400);
      sources.store.migrate(dismissed as unknown[]);
      return answer(c, { ok: true }, 200);
    },
  );
}
