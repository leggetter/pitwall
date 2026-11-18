// The diagnostics log (W165): why a row is in Needs you, kept where it can be read after the fact.
// Phil, 2026-11-09: a session whose work was done was still in Needs you, "how can we improve it if
// we can't look at logs and determine what's working and what's not?" The reason was worked out in
// memory and in the page and thrown away.
//
//   $PITWALL_HOME/diagnostics.jsonl, 0600, one JSON line each time:
//     enter / change / leave   a session enters Needs you, its reason changes while it is in, or it
//                              leaves: the time, the session id, its own reason (NeedsYou['reason']),
//                              whether a flag or snooze set it aside, the PR need that put it there
//                              (a fixed word, and the PR as owner/repo#123) and which won. Transitions
//                              only: a state that doesn't change never writes a line. The reason is
//                              the page's own (needsYouReason(), src/shared/needsYou.ts), so the two
//                              can't disagree. W178's why_state tool reads the same function.
//     start                    the recorder's first look after pitwall started, so the report can
//                              close what was open when pitwall stopped instead of counting the gap.
//     poll                     the PR poller's outcome, per search: PRs listed, skipped as reviewed
//                              already (W101), and whether the search failed. Only when the counts
//                              change from the poll before, so a steady list doesn't fill the log.
//
//   Ids and fixed words only: never a transcript, a session's name or title, a recap, a PR's title,
//   a branch, a path or a token. Every field is an enum, a number, a time, a session id or a
//   repo#number. Every line goes through parseDiagnosticsLine() before it's written, and again when
//   it's read, so a field that isn't one of those shapes is never written and the file can be read
//   as untrusted.
//
// No off switch (Phil, 2026-11-09): it holds ids and reasons only, and a log that can be turned off is
// missing when it's needed. Writing fails soft: a failed write is dropped, never thrown. Past
// DIAGNOSTICS_LOG_MAX_BYTES a write keeps the newest half. scripts/diagnostics-report.ts reads it.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../index/guards.js';
import { isSafeSessionId } from '../index/index.js';
import { needsYouReason, ownedPrsBySession, type NeedsYouReason, type PrNeedKind } from '../shared/needsYou.js';
import { PR_RELATIONS, type IndexSnapshot, type NeedsYou, type PullRequestList, type PullRequestRelation, type SessionSummary } from '../shared/protocol.js';
import { ensureLaunchDir } from './launch.js';

/** The log's name in pitwall's home. */
export const DIAGNOSTICS_LOG_NAME = 'diagnostics.jsonl';
/** Past this, a write keeps the newest half: about 10,000 typical lines (about 210 bytes), 4,500 at their longest. */
export const DIAGNOSTICS_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** How often the server looks for a change in who is in Needs you, as often as the index polls by default. */
export const DIAGNOSTICS_INTERVAL_MS = 5000;
/** The most sessions whose last state is remembered; past it the oldest is forgotten. */
export const DIAGNOSTICS_SESSIONS_MAX = 5000;

const OWN_REASONS: readonly NeedsYou['reason'][] = ['prompt', 'claude-code', 'asked', 'recap', 'restarted', 'blocked'];
const PR_NEEDS: readonly PrNeedKind[] = ['review-requested', 'checks-failing', 'conflicts', 'changes-requested'];
const SET_ASIDE = ['flagged', 'snoozed'] as const;
const OVERS = ['finished', 'ended', 'stale'] as const;
const WONS = ['own', 'pr'] as const;
const VIAS = ['direct', 'team'] as const;
/** A session id as the index gives it, with a length cap the index's check doesn't have. */
const SESSION_ID_MAX = 128;
const PR_REF = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}#[0-9]{1,9}$/;

export type SessionTransition = 'enter' | 'change' | 'leave';

/** A session's state at one line. All fixed words and ids. */
export interface SessionStateLine {
  v: 1;
  kind: SessionTransition;
  at: string;
  sessionId: string;
  /** The session's own reason, while it needs you itself. */
  own?: NeedsYou['reason'];
  /** The index says it needs you, but a flag or snooze set it aside. */
  setAside?: (typeof SET_ASIDE)[number];
  /** The PR need that puts it here while it isn't busy. */
  prNeed?: PrNeedKind;
  /** That PR, as `owner/repo#123`. */
  prRef?: string;
  /** How a review was asked: of you, or of a team you're on. */
  prVia?: (typeof VIAS)[number];
  /** Which one the row's second line explains when both hold. */
  won?: (typeof WONS)[number];
  /** On a leave: it has finished, ended or gone stale, which takes it out of Needs you whatever it asked. */
  over?: (typeof OVERS)[number];
  /** On an enter: seen in the first snapshot after pitwall started, so it was in Needs you before the log began. */
  atStart?: true;
}

/** What one search found in one poll. */
export interface PollCounts {
  listed: number;
  /** Review-requested PRs left out because the request had moved on from you (W101). */
  skipped: number;
  failed: boolean;
}

export interface PollLine {
  v: 1;
  kind: 'poll';
  at: string;
  searches: Partial<Record<PullRequestRelation, PollCounts>>;
}

/** The recorder's first look after pitwall started. */
export interface StartLine {
  v: 1;
  kind: 'start';
  at: string;
}

export type DiagnosticsLine = SessionStateLine | PollLine | StartLine;

export interface DiagnosticsLogOptions {
  /** pitwall's home. Without one nothing is written. */
  home?: string;
  now?: () => Date;
}

/** The log's writer. Fails soft. */
export class DiagnosticsLog {
  readonly #file: string | undefined;
  readonly #home: string | undefined;
  readonly #now: () => Date;
  #lastPoll: string | undefined;

  constructor(options: DiagnosticsLogOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#file = this.#home === undefined ? undefined : path.join(this.#home, DIAGNOSTICS_LOG_NAME);
    this.#now = options.now ?? (() => new Date());
  }

  /** Writes that pitwall's recorder has started. */
  start(): void {
    this.#append({ v: 1, kind: 'start', at: this.#now().toISOString() });
  }

  /** Writes a session's transition. */
  session(line: Omit<SessionStateLine, 'v' | 'at'>): void {
    this.#append({ v: 1, at: this.#now().toISOString(), ...line });
  }

  /** Writes the PR poller's outcome, unless its counts are those of the poll before. */
  poll(searches: Partial<Record<PullRequestRelation, PollCounts>>): void {
    const key = JSON.stringify(PR_RELATIONS.map((relation) => searches[relation] ?? null));
    if (key === this.#lastPoll) return;
    this.#lastPoll = key;
    this.#append({ v: 1, kind: 'poll', at: this.#now().toISOString(), searches });
  }

  /**
   * Appends `line`, as parseDiagnosticsLine() reads it back: a field that isn't one of the fixed shapes
   * is left out, and a line that doesn't check out is dropped, so only ids, fixed words and counts are
   * ever written, whatever a caller passes. Past DIAGNOSTICS_LOG_MAX_BYTES, rewrites the log with its
   * newest half first. Fails soft.
   */
  #append(line: DiagnosticsLine): void {
    if (this.#file === undefined || this.#home === undefined) return;
    let fd: number | undefined;
    try {
      const checked = parseDiagnosticsLine(JSON.stringify(line));
      if (checked === undefined) return;
      const text = `${JSON.stringify(checked)}\n`;
      ensureLaunchDir(this.#home);
      fd = openSync(this.#file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stat = fstatSync(fd);
      const uid = process.getuid?.();
      if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return;
      if (stat.size + Buffer.byteLength(text) <= DIAGNOSTICS_LOG_MAX_BYTES) {
        writeSync(fd, text);
        return;
      }
      closeSync(fd);
      fd = undefined;
      this.#rewrite(text);
    } catch {
      // Dropped: the log is for finding out, and never worth a crash.
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Already closed.
        }
      }
    }
  }

  /** The newest lines, up to half of DIAGNOSTICS_LOG_MAX_BYTES, then `text`, written by rename. */
  #rewrite(text: string): void {
    const file = this.#file!;
    const kept: string[] = [];
    let size = Buffer.byteLength(text);
    const lines = readDiagnosticsLog(file).map((line) => `${JSON.stringify(line)}\n`);
    for (let i = lines.length - 1; i >= 0; i--) {
      const bytes = Buffer.byteLength(lines[i]!);
      if (size + bytes > DIAGNOSTICS_LOG_MAX_BYTES / 2) break;
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

/** What a session's state is, for telling a change from no change. */
function keyOf(reason: NeedsYouReason): string {
  return JSON.stringify([reason.own ?? null, reason.pr?.need ?? null, reason.pr?.ref ?? null, reason.pr?.via ?? null, reason.won ?? null]);
}

/**
 * Watches the snapshot and the PR list and writes a line when a session enters or leaves Needs you, or
 * its reason changes while it is in. Remembers each session's last state, so a repeat writes nothing.
 * A session no longer listed keeps its state, since a failed poll can empty the list.
 */
export class NeedsYouRecorder {
  readonly #log: DiagnosticsLog;
  /** Each session's last key, or undefined while it is out of Needs you. */
  readonly #state = new Map<string, string | undefined>();
  #started = false;
  /** Until the first snapshot that worked and listed a session: an enter then was in Needs you before pitwall started. */
  #sessionsAtStart = true;
  /** Until the first PR list that a fetch made: an enter for a PR's need then was there before pitwall started. */
  #prsAtStart = true;

  constructor(log: DiagnosticsLog) {
    this.#log = log;
  }

  /** Records the transitions between the last state and `snapshot` with `prs`. Never throws. */
  observe(snapshot: IndexSnapshot, prs: Pick<PullRequestList, 'prs'> & Partial<Pick<PullRequestList, 'fetchedAt' | 'searches'>>): void {
    try {
      if (!this.#started) {
        this.#started = true;
        this.#log.start();
      }
      const sessions = new Map<string, SessionSummary>();
      for (const group of snapshot.groups) for (const session of group.sessions) if (!sessions.has(session.sessionId)) sessions.set(session.sessionId, session);
      const owned = ownedPrsBySession([...sessions.values()], prs.prs);
      // A failed or empty first snapshot (claude agents not answering yet) doesn't use up the at-start mark.
      const sessionsAtStart = this.#sessionsAtStart;
      if (snapshot.source.ok && sessions.size > 0) this.#sessionsAtStart = false;
      const prsAtStart = this.#prsAtStart;
      if (prs.fetchedAt !== undefined || prs.searches !== undefined) this.#prsAtStart = false;
      for (const session of sessions.values()) {
        if (!isSafeSessionId(session.sessionId)) continue;
        const reason = needsYouReason(session, owned.get(session.sessionId));
        const key = reason.attention ? keyOf(reason) : undefined;
        const before = this.#state.get(session.sessionId);
        // Forget the oldest when full, then remember this one as the newest.
        this.#state.delete(session.sessionId);
        this.#state.set(session.sessionId, key);
        while (this.#state.size > DIAGNOSTICS_SESSIONS_MAX) this.#state.delete(this.#state.keys().next().value!);
        if (before === key) continue;
        const kind: SessionTransition = before === undefined ? 'enter' : key === undefined ? 'leave' : 'change';
        this.#log.session({
          kind,
          sessionId: session.sessionId,
          ...(reason.own === undefined ? {} : { own: reason.own }),
          ...(reason.setAside === undefined ? {} : { setAside: reason.setAside }),
          ...(reason.pr === undefined ? {} : { prNeed: reason.pr.need, ...(PR_REF.test(reason.pr.ref) ? { prRef: reason.pr.ref } : {}), ...(reason.pr.via === undefined ? {} : { prVia: reason.pr.via }) }),
          ...(reason.won === undefined ? {} : { won: reason.won }),
          ...(kind === 'leave' ? overOf(session) : {}),
          ...(kind === 'enter' && (sessionsAtStart || (prsAtStart && reason.won === 'pr')) ? { atStart: true as const } : {}),
        });
      }
    } catch {
      // Diagnostics never break the page's snapshot.
    }
  }
}

function overOf(session: SessionSummary): { over?: (typeof OVERS)[number] } {
  if (session.finished) return { over: 'finished' };
  if (session.ended) return { over: 'ended' };
  if (session.stale) return { over: 'stale' };
  return {};
}

/**
 * The lines of the log at `file` that check out, oldest first; none when there's no log or it can't
 * be trusted: not a regular file of this user's, a link, writable by group or others, or over
 * DIAGNOSTICS_LOG_MAX_BYTES * 2. For the writer's rotation, and scripts/diagnostics-report.ts.
 */
export function readDiagnosticsLog(file: string): DiagnosticsLine[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > DIAGNOSTICS_LOG_MAX_BYTES * 2) return [];
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
      .map(parseDiagnosticsLine)
      .filter((line): line is DiagnosticsLine => line !== undefined);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const isTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;

/** One line of the log, checked field by field: a field that isn't one of the fixed shapes is dropped. */
export function parseDiagnosticsLine(raw: string): DiagnosticsLine | undefined {
  if (raw.trim() === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.v !== 1 || !isTime(value.at)) return undefined;
  if (value.kind === 'start') return { v: 1, kind: 'start', at: value.at };
  if (value.kind === 'poll') {
    if (!isRecord(value.searches)) return undefined;
    const searches: PollLine['searches'] = {};
    for (const relation of PR_RELATIONS) {
      const each = value.searches[relation];
      if (isRecord(each) && count(each.listed) && count(each.skipped) && typeof each.failed === 'boolean') {
        searches[relation] = { listed: each.listed, skipped: each.skipped, failed: each.failed };
      }
    }
    return { v: 1, kind: 'poll', at: value.at, searches };
  }
  if (!oneOf(['enter', 'change', 'leave'] as const, value.kind)) return undefined;
  if (typeof value.sessionId !== 'string' || value.sessionId.length > SESSION_ID_MAX || !isSafeSessionId(value.sessionId)) return undefined;
  const line: SessionStateLine = { v: 1, kind: value.kind, at: value.at, sessionId: value.sessionId };
  if (oneOf(OWN_REASONS, value.own)) line.own = value.own;
  if (oneOf(SET_ASIDE, value.setAside)) line.setAside = value.setAside;
  if (oneOf(PR_NEEDS, value.prNeed)) line.prNeed = value.prNeed;
  if (typeof value.prRef === 'string' && PR_REF.test(value.prRef)) line.prRef = value.prRef;
  if (oneOf(VIAS, value.prVia)) line.prVia = value.prVia;
  if (oneOf(WONS, value.won)) line.won = value.won;
  if (oneOf(OVERS, value.over)) line.over = value.over;
  if (value.atStart === true) line.atStart = true;
  return line;
}
