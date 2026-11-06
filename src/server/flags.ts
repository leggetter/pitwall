// Flag: "It doesn't need me" (W153). Phil, 2026-11-06, after W152's case: a way to say a session in
// Needs you doesn't need him, counted so the false flags can be analysed, and told to the session "in
// case there is something it just hasn't correctly called out". A flag says Needs you's assessment is
// wrong; a snooze (W154) will say it's right, but not now.
//
// A click does three things:
//
//   1. Hides: the snapshot carries `flagged` on the session while it still needs what it needed when
//      you flagged it (needKey()), and the web UI leaves it out of Needs you and every count, as it
//      does one marked not needed now (W88). Kept here, not in the browser, so every page sees it and
//      the supervisor's tools do too. Once a snapshot lists the session needing something else, or
//      nothing, the flag has done its job and goes. For Needs you's 'recap' reason, a new recap is
//      something else, even with the same to-do: the session's reply to the ask (3) starts a turn,
//      and the recap after it is its answer.
//   2. Logs: one JSON line in $PITWALL_HOME/flags.jsonl, 0600: when, the session id, the reason, its
//      text (the to-do, Claude Code's line, the question or the prompt), the recap's `at`, `throughAt`
//      and source, where you clicked, and what came of the ask. An undo is a line too. Only here,
//      since the browser keeps no session content (D14). Past FLAG_LOG_MAX_BYTES the newest half is
//      kept. scripts/flag-report.ts reads it.
//   3. Asks: a fixed message to the session through the relay (D8), so it reads as yours, with what
//      pitwall says it needs filled in, asking for "Open questions: None" if nothing is, or what
//      exactly is. A busy session gets it mid-turn. Each one starts a turn, which re-reads the
//      session's context, so it's sent only on the click, and only once per need: a second click,
//      or a second page, finds it flagged and sends nothing.
//
//   POST flagPath(id)    body: FlagRequest as JSON                      answers: FlagResult
//     200  flagged: { ok: true, asked }, `asked` the relay's outcome; without `asked` when it was
//          already flagged for this need, and nothing was sent
//     400, 404, 503  from resolveSession(); 400 also when the body isn't a FlagRequest
//     409  it doesn't need you now, needs you for another reason than the page showed, or isn't
//          running (an ended or finished session would need a resume, which is the approval path's)
//     413  the body is over FLAG_BODY_MAX_BYTES
//     415  the body isn't `Content-Type: application/json`
//
//   POST unflagPath(id)  no body                                        answers: FlagResult
//     200  { ok: true }: the flag is gone, and an undo logged if there was one. Nothing is sent
//     400, 404, 503  from resolveSession()
//
// Both are POSTs, so the /api/* middleware in server.ts has already required the apiKey and this
// server's Origin. The target and the text come from the resolved summary, never the request.
//
// The log is read back at start, as untrusted: a regular file of this user's, not a link, not
// writable by group or others, at most FLAG_LOG_MAX_BYTES * 2; each line checked, anything else
// skipped. So a flag outlives a restart. Writing fails soft: the flag holds in memory for this run.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isRecord } from '../index/guards.js';
import { isSafeSessionId } from '../index/index.js';
import type { RecapEngine } from '../recaps/engine.js';
import {
  flagPath,
  unflagPath,
  type FlagFrom,
  type FlagResult,
  type IndexSnapshot,
  type NeedsYou,
  type RelayStatus,
  type SessionFlag,
  type SessionSummary,
} from '../shared/protocol.js';
import { ensureLaunchDir } from './launch.js';
import type { RelayManager } from './relay.js';
import type { SnapshotView } from './snapshotLinks.js';
import { createDecoratedView } from './snapshotRecaps.js';
import { resolveSession } from './sessions.js';

/** The log's name in pitwall's home. */
export const FLAG_LOG_NAME = 'flags.jsonl';
/** Past this, a write keeps the newest half. About 700 flags at their longest. */
export const FLAG_LOG_MAX_BYTES = 1024 * 1024;
/** The most flags held at once; past it the oldest goes, as W88's marks do. */
export const FLAGS_HELD_MAX = 500;
/** A FlagRequest is a few dozen bytes. */
export const FLAG_BODY_MAX_BYTES = 4 * 1024;

const REASONS: readonly NeedsYou['reason'][] = ['prompt', 'claude-code', 'asked', 'recap', 'restarted', 'blocked'];
const FROMS: readonly FlagFrom[] = ['row', 'view'];
const RELAY_STATUSES: readonly RelayStatus[] = ['delivered', 'held', 'refused', 'failed', 'uncertain'];

/** One line of the log. */
export interface FlagLogLine {
  v: 1;
  kind: 'flag' | 'undo';
  at: string;
  sessionId: string;
  /** For a flag: needKey() when it was flagged. */
  need?: string;
  reason?: NeedsYou['reason'];
  /** What it needed, in pitwall's words or the session's: the to-do, Claude Code's line, the question or the prompt. */
  text?: string;
  recapAt?: string;
  recapThroughAt?: string;
  recapSource?: 'pitwall' | 'claude-code';
  from?: FlagFrom;
  /** The relay's outcome for the ask. */
  asked?: RelayStatus;
}

/**
 * What a session needs, as a key: its NeedsYou reason and text, its question, its prompt, and for
 * 'recap', the recap's time. The same need gives the same key; any change to one of them changes it.
 * Undefined when it doesn't need you.
 */
export function needKey(session: SessionSummary): string | undefined {
  const need = session.needsYou;
  if (need === undefined) return undefined;
  const parts = [need.reason, need.text ?? null, session.askedYou?.excerpt ?? null, session.waitingFor ?? null, need.reason === 'recap' ? (session.recap?.at ?? null) : null];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** What it needs, for the log and the ask: the reason's own text, or the question or prompt behind it. */
export function needText(session: SessionSummary): string | undefined {
  const need = session.needsYou;
  if (need === undefined) return undefined;
  if (need.text !== undefined && need.text !== '') return need.text;
  if (need.reason === 'asked') return session.askedYou?.excerpt;
  if (need.reason === 'prompt') return session.waitingFor;
  return undefined;
}

/** What pitwall says the session needs, in the ask's words. */
function askedFor(session: SessionSummary): string {
  const reason = session.needsYou?.reason;
  const text = needText(session)?.replace(/\s+/g, ' ').trim();
  switch (reason) {
    case 'prompt':
      return `a prompt on your screen${text === undefined ? '' : ` (${text})`}`;
    case 'restarted':
      return 'my next prompt, since I resumed or restarted you';
    case 'blocked':
      return 'you, since Claude Code says you are blocked';
    default:
      return text === undefined || text === '' ? 'something it could not name' : `"${text}"`;
  }
}

/** The fixed message a flag sends the session, with what pitwall says it needs filled in. Written as yours, since the relay sends it as yours. */
export function askText(session: SessionSummary): string {
  return [
    `pitwall lists you as needing me for: ${askedFor(session)}. I don't think you need me for that.`,
    'If nothing is needed from me, reply with exactly "Open questions: None".',
    'If something is, say exactly what you need from me, and why.',
  ].join(' ');
}

interface Held {
  need: string;
  at: string;
}

export interface FlagStoreOptions {
  /** pitwall's home. Without one, flags are held in memory only and nothing is logged. */
  home?: string;
  now?: () => Date;
}

/** Facts about the recap behind a 'recap' flag, which the snapshot doesn't carry. */
export interface FlagRecapFacts {
  at?: string;
  throughAt?: string;
  source?: 'pitwall' | 'claude-code';
}

/** The flags held, their log, and the snapshot's decoration. */
export class FlagStore {
  readonly #file: string | undefined;
  readonly #home: string | undefined;
  readonly #now: () => Date;
  readonly #held = new Map<string, Held>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(options: FlagStoreOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#file = this.#home === undefined ? undefined : path.join(this.#home, FLAG_LOG_NAME);
    this.#now = options.now ?? (() => new Date());
    for (const line of this.#read()) {
      if (line.kind === 'undo') this.#held.delete(line.sessionId);
      else if (line.need !== undefined) this.#hold(line.sessionId, { need: line.need, at: line.at });
    }
  }

  /** The flag on `session`, while it needs what it needed when it was flagged. */
  flagOf(session: SessionSummary): SessionFlag | undefined {
    const held = this.#held.get(session.sessionId);
    return held !== undefined && held.need === needKey(session) ? { at: held.at } : undefined;
  }

  /**
   * Flags `session` for what it needs now, and logs it once the ask's outcome is known (logAsk()).
   * Undefined when it doesn't need you, or is already flagged for this need: then nothing changes.
   */
  flag(session: SessionSummary): Held | undefined {
    const need = needKey(session);
    if (need === undefined || this.flagOf(session) !== undefined) return undefined;
    const held = { need, at: this.#now().toISOString() };
    this.#hold(session.sessionId, held);
    this.#changed();
    return held;
  }

  /** Logs a flag made by flag(), with the ask's outcome. */
  logFlag(session: SessionSummary, held: Held, from: FlagFrom, recap: FlagRecapFacts | undefined, asked: RelayStatus | undefined): void {
    const text = needText(session);
    const reason = session.needsYou?.reason;
    this.#append({
      v: 1,
      kind: 'flag',
      at: held.at,
      sessionId: session.sessionId,
      need: held.need,
      ...(reason === undefined ? {} : { reason }),
      ...(text === undefined ? {} : { text }),
      ...(recap?.at === undefined ? {} : { recapAt: recap.at }),
      ...(recap?.throughAt === undefined ? {} : { recapThroughAt: recap.throughAt }),
      ...(recap?.source === undefined ? {} : { recapSource: recap.source }),
      from,
      ...(asked === undefined ? {} : { asked }),
    });
  }

  /** Takes `sessionId`'s flag away, and logs the undo. False when it had none. */
  unflag(sessionId: string): boolean {
    if (!this.#held.delete(sessionId)) return false;
    this.#append({ v: 1, kind: 'undo', at: this.#now().toISOString(), sessionId });
    this.#changed();
    return true;
  }

  /**
   * `snapshot` with `flagged` on each session still flagged for what it needs. A flag whose session
   * is listed needing something else, or nothing, has done its job and goes; one whose session
   * isn't listed stays, since a failed poll can empty the list. A copy when any session changed.
   */
  decorate(snapshot: IndexSnapshot): IndexSnapshot {
    if (this.#held.size === 0) return snapshot;
    let changed = false;
    const groups = snapshot.groups.map((group) => {
      let groupChanged = false;
      const sessions = group.sessions.map((session) => {
        const held = this.#held.get(session.sessionId);
        if (held === undefined) return session;
        if (held.need !== needKey(session)) {
          // Not #changed(): this view already leaves it out, and the next one has nothing to add.
          this.#held.delete(session.sessionId);
          return session;
        }
        groupChanged = true;
        return { ...session, flagged: { at: held.at } };
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

  #hold(sessionId: string, held: Held): void {
    this.#held.delete(sessionId);
    this.#held.set(sessionId, held);
    while (this.#held.size > FLAGS_HELD_MAX) this.#held.delete(this.#held.keys().next().value!);
  }

  #changed(): void {
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }

  /** The log's lines that check out, oldest first. */
  #read(): FlagLogLine[] {
    return this.#file === undefined ? [] : readFlagLog(this.#file);
  }

  /** Appends `line`; past FLAG_LOG_MAX_BYTES, rewrites the log with its newest half first. Fails soft. */
  #append(line: FlagLogLine): void {
    if (this.#file === undefined || this.#home === undefined) return;
    const text = `${JSON.stringify(line)}\n`;
    let fd: number | undefined;
    try {
      ensureLaunchDir(this.#home);
      fd = openSync(this.#file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(fd);
      const uid = process.getuid?.();
      if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return;
      if (stat.size + Buffer.byteLength(text) <= FLAG_LOG_MAX_BYTES) {
        writeSync(fd, text);
        return;
      }
      closeSync(fd);
      fd = undefined;
      this.#rewrite(text);
    } catch {
      // The flag holds in memory for this run.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** The log's newest lines, up to half of FLAG_LOG_MAX_BYTES, then `text`, written by rename. */
  #rewrite(text: string): void {
    const file = this.#file!;
    const kept: string[] = [];
    let size = Buffer.byteLength(text);
    const lines = this.#read().map((line) => `${JSON.stringify(line)}\n`);
    for (let i = lines.length - 1; i >= 0; i--) {
      const bytes = Buffer.byteLength(lines[i]!);
      if (size + bytes > FLAG_LOG_MAX_BYTES / 2) break;
      kept.unshift(lines[i]!);
      size += bytes;
    }
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, kept.join('') + text, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Never written.
      }
      throw error;
    }
  }
}

/**
 * The lines of the log at `file` that check out, oldest first; none when there's no log or it can't
 * be trusted: not a regular file of this user's, a link, writable by group or others, or over
 * FLAG_LOG_MAX_BYTES * 2. For the store, and scripts/flag-report.ts.
 */
export function readFlagLog(file: string): FlagLogLine[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > FLAG_LOG_MAX_BYTES * 2) return [];
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    return buffer
      .subarray(0, read)
      .toString('utf8')
      .split('\n')
      .map(parseLine)
      .filter((line): line is FlagLogLine => line !== undefined);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const isTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isShortText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

/** One line of the log, checked field by field, or undefined. */
export function parseLine(raw: string): FlagLogLine | undefined {
  if (raw.trim() === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.v !== 1 || (value.kind !== 'flag' && value.kind !== 'undo')) return undefined;
  if (!isTime(value.at) || typeof value.sessionId !== 'string' || !isSafeSessionId(value.sessionId)) return undefined;
  const line: FlagLogLine = { v: 1, kind: value.kind, at: value.at, sessionId: value.sessionId };
  if (value.kind === 'undo') return line;
  if (typeof value.need !== 'string' || !/^[0-9a-f]{32}$/.test(value.need)) return undefined;
  line.need = value.need;
  if (REASONS.includes(value.reason as NeedsYou['reason'])) line.reason = value.reason as NeedsYou['reason'];
  if (isShortText(value.text, 1000)) line.text = value.text;
  if (isTime(value.recapAt)) line.recapAt = value.recapAt;
  if (isTime(value.recapThroughAt)) line.recapThroughAt = value.recapThroughAt;
  if (value.recapSource === 'pitwall' || value.recapSource === 'claude-code') line.recapSource = value.recapSource;
  if (FROMS.includes(value.from as FlagFrom)) line.from = value.from as FlagFrom;
  if (RELAY_STATUSES.includes(value.asked as RelayStatus)) line.asked = value.asked as RelayStatus;
  return line;
}

/** `source`'s snapshots with each flagged session's `flagged`. */
export function createFlagView(source: Pick<SnapshotView, 'latest' | 'subscribe'>, store: FlagStore): SnapshotView {
  return createDecoratedView(source, { decorate: (snapshot) => store.decorate(snapshot), version: () => store.version(), subscribe: (listener) => store.subscribe(listener) });
}

const FLAG_ROUTE = decodeURIComponent(flagPath(':sessionId'));
const UNFLAG_ROUTE = decodeURIComponent(unflagPath(':sessionId'));

const LOOKUP_ERRORS = {
  400: 'That is not a valid session id.',
  404: "That session isn't in pitwall's list.",
  503: "pitwall hasn't listed the sessions yet. Try again in a moment.",
} as const;

/** The FlagRequest in `body`, or why it isn't one. */
export function validateFlagRequest(body: unknown): { ok: true; reason: NeedsYou['reason']; from: FlagFrom } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'The body must be a JSON object.' };
  for (const key of Object.keys(body)) if (key !== 'reason' && key !== 'from') return { ok: false, error: 'The body has a field pitwall doesn’t know.' };
  if (!REASONS.includes(body.reason as NeedsYou['reason'])) return { ok: false, error: 'Say why the page showed it as needing you.' };
  if (!FROMS.includes(body.from as FlagFrom)) return { ok: false, error: 'Say where the flag came from.' };
  return { ok: true, reason: body.reason as NeedsYou['reason'], from: body.from as FlagFrom };
}

export interface FlagRouteSources {
  /** The snapshot with recaps and flags: the session as the page sees it. */
  snapshots: Pick<SnapshotView, 'latest'>;
  store: FlagStore;
  relay: Pick<RelayManager, 'send'>;
  /** For a 'recap' flag's log line: the recap's `throughAt` and source. */
  recaps?: Pick<RecapEngine, 'recap'> | undefined;
}

/** Adds the flag routes. Call it after the /api/* checks and before the /api/* catch-all. */
export function registerFlags(app: Hono, sources: FlagRouteSources): void {
  const answer = (c: Context, result: FlagResult, status: 200 | 400 | 404 | 409 | 413 | 415 | 503) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };

  app.post(
    FLAG_ROUTE,
    bodyLimit({ maxSize: FLAG_BODY_MAX_BYTES, onError: (c) => answer(c, { ok: false, error: 'The request is too large.' }, 413) }),
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
      const request = validateFlagRequest(body);
      if (!request.ok) return answer(c, { ok: false, error: request.error }, 400);

      const { session } = lookup;
      if (session.needsYou === undefined) return answer(c, { ok: false, error: "It doesn't need you now, so there's nothing to flag." }, 409);
      if (session.needsYou.reason !== request.reason) return answer(c, { ok: false, error: 'What it needs you for has just changed. Look again before you flag it.' }, 409);
      if (session.ended === true || session.finished === true || !session.alive || session.pid === undefined) {
        return answer(c, { ok: false, error: "It isn't running, so pitwall can't ask it what it needs." }, 409);
      }

      const held = sources.store.flag(session);
      // Already flagged for this need, by another click or page: nothing more to send.
      if (held === undefined) return answer(c, { ok: true }, 200);

      const recap = session.needsYou.reason === 'recap' ? sources.recaps?.recap(session) : undefined;
      const recapFacts: FlagRecapFacts | undefined =
        session.needsYou.reason !== 'recap' ? undefined : { ...(session.recap === undefined ? {} : { at: session.recap.at, source: session.recap.source }), ...(recap === undefined ? {} : { throughAt: recap.throughAt }) };
      // From the resolved summary, never the request.
      const outcome = await sources.relay.send({ sessionId: session.sessionId, name: session.name, pid: session.pid, cwd: session.cwd }, askText(session));
      sources.store.logFlag(session, held, request.from, recapFacts, outcome.status);
      return answer(c, { ok: true, asked: { status: outcome.status, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) } }, 200);
    },
  );

  app.post(UNFLAG_ROUTE, (c) => {
    const lookup = resolveSession(sources.snapshots, c.req.param('sessionId'));
    if (!lookup.ok) return answer(c, { ok: false, error: LOOKUP_ERRORS[lookup.status] }, lookup.status);
    sources.store.unflag(lookup.session.sessionId);
    return answer(c, { ok: true }, 200);
  });
}
