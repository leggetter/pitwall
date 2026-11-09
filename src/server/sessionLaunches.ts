// The settings pitwall started each session with from a work profile (W155; Phil, 2026-11-09), so a
// resume from pitwall brings it back on them: a Review session resumes on Sonnet with its sub-agents
// on Sonnet, not on the defaults for sessions with no CLAUDE_CODE_SUBAGENT_MODEL. Before this, resume
// used only the defaults (W119), and only for a session started in the same run.
//
// What's kept, for each session pitwall started with a profile: the short id `claude --bg` reported,
// its session id once the index lists it with that short id, when it was started or last resumed, and
// the SessionLaunch: the profile's name, whether you changed its model, effort or sub-agents' model
// in the dialog (Customized), and the model, effort and sub-agents' model actually used, WORK_DEFAULT for none. Never
// the skill: it was the first prompt's prefix, and must not run again on a resume. Never a prompt,
// name, directory, token or other session content. A session started with no profile (New session
// before its profiles have loaded, the supervisor's spawn_session until W156) has no record, and resumes as before: the defaults
// for sessions this pitwall started in this run, else no flags.
//
// Kept in $PITWALL_HOME/session-launches.json, 0600, written whole by rename on each change, at most
// SESSION_LAUNCHES_MAX records, the least recently used dropped first. Read back at start as
// untrusted, since anything running as the user can write it, as the snoozes file is: a regular file
// of this user's, not a link, not writable by group or others, at most SESSION_LAUNCHES_FILE_MAX_BYTES,
// each record checked; and every value checked again with the profiles' and W119's own checks as it's
// looked up for a resume, so a model, effort or sub-agents' model that fails them is dropped, never
// used, and the resume takes the defaults for that field instead. Any problem reading or writing fails
// soft: the records hold in memory for this run, or there are none, and resume behaves as before.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../index/guards.js';
import { isSessionUuid } from '../index/transcripts.js';
import {
  isEffortLevel,
  isWorkModel,
  WORK_DEFAULT,
  WORK_PROFILE_NAME_PATTERN,
  type IndexSnapshot,
  type SessionLaunch,
  type SessionSummary,
  type WorkChoice,
} from '../shared/protocol.js';
import { ensureLaunchDir } from './launch.js';

/** The file's name in pitwall's home. */
export const SESSION_LAUNCHES_FILE_NAME = 'session-launches.json';
/** The most records kept; past it the least recently started or resumed goes. */
export const SESSION_LAUNCHES_MAX = 500;
/** About 250 bytes a record, so 500 fit with room. */
export const SESSION_LAUNCHES_FILE_MAX_BYTES = 256 * 1024;

/** A short id as `claude --bg` reports it, and as actions.ts's SHORT_ID_PATTERN allows. */
const SHORT_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

interface LaunchRecord {
  shortId: string;
  /** Set once the index lists a session with `shortId`, or once it's resumed by its id. */
  sessionId?: string;
  /** When it was started, or last resumed from pitwall: the order records are dropped in. */
  at: string;
  launch: SessionLaunch;
}

/** What a resume uses: `launch`'s model and effort, and its sub-agents' model, as W119's choices. */
export interface LaunchWork {
  launch: SessionLaunch;
  session: WorkChoice;
  subagents: WorkChoice;
}

export interface SessionLaunchesOptions {
  /** pitwall's home. Without one, records are held in memory only. */
  home?: string;
  now?: () => Date;
}

/**
 * `value` as a SessionLaunch with only the fields that pass the profiles' checks (profiles.ts, W119's
 * isWorkModel() and isEffortLevel()); anything else dropped. Undefined when nothing's left.
 */
export function checkedLaunch(value: unknown): SessionLaunch | undefined {
  if (!isRecord(value)) return undefined;
  const launch: SessionLaunch = {};
  if (typeof value.profile === 'string' && WORK_PROFILE_NAME_PATTERN.test(value.profile)) launch.profile = value.profile;
  if (value.custom === true) launch.custom = true;
  if (value.model === WORK_DEFAULT || isWorkModel(value.model, 'session')) launch.model = value.model as string;
  if (value.effort === WORK_DEFAULT || isEffortLevel(value.effort)) launch.effort = value.effort as SessionLaunch['effort'];
  if (value.subagentModel === WORK_DEFAULT || isWorkModel(value.subagentModel, 'subagents')) launch.subagentModel = value.subagentModel as string;
  return launch.model === undefined && launch.effort === undefined && launch.subagentModel === undefined ? undefined : launch;
}

const isTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));

/** The records, their file and the link from a short id to its session id. */
export class SessionLaunches {
  readonly #file: string | undefined;
  readonly #home: string | undefined;
  readonly #now: () => Date;
  /** By short id, least recently used first. */
  readonly #records = new Map<string, LaunchRecord>();

  constructor(options: SessionLaunchesOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#file = this.#home === undefined ? undefined : path.join(this.#home, SESSION_LAUNCHES_FILE_NAME);
    this.#now = options.now ?? (() => new Date());
    const stored = this.#file === undefined ? [] : readSessionLaunchesFile(this.#file);
    for (const record of stored.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) this.#records.set(record.shortId, record);
    this.#cap();
  }

  /**
   * Keeps what a session pitwall just started with a profile used: `shortId` as `claude --bg`
   * reported it. Nothing for a session started without a profile, or with nothing that checks out.
   */
  record(shortId: string, launch: SessionLaunch): void {
    if (launch.profile === undefined || !SHORT_ID.test(shortId)) return;
    const checked = checkedLaunch(launch);
    if (checked === undefined) return;
    this.#records.delete(shortId);
    this.#records.set(shortId, { shortId, at: this.#now().toISOString(), launch: checked });
    this.#cap();
    this.#write();
  }

  /**
   * The settings `session` was started with, checked again, or undefined: by its session id, else,
   * for a record not yet linked to one, by its short id. A record linked to another session id never
   * matches, so a short id Claude Code used again can't bring another session's settings.
   */
  lookup(session: Pick<SessionSummary, 'sessionId' | 'shortId'>): LaunchWork | undefined {
    const record = this.#find(session);
    const launch = record === undefined ? undefined : checkedLaunch(record.launch);
    if (launch === undefined) return undefined;
    return {
      launch,
      session: { ...(launch.model === undefined ? {} : { model: launch.model }), ...(launch.effort === undefined ? {} : { effort: launch.effort }) },
      subagents: launch.subagentModel === undefined ? {} : { model: launch.subagentModel },
    };
  }

  /**
   * After pitwall resumed `session` under `shortId`: its record linked to its session id, under the
   * short id it now has, and the most recently used, so it's the last dropped.
   */
  resumed(session: Pick<SessionSummary, 'sessionId' | 'shortId'>, shortId: string): void {
    const record = this.#find(session);
    if (record === undefined || !SHORT_ID.test(shortId) || !isSessionUuid(session.sessionId)) return;
    this.#records.delete(record.shortId);
    this.#records.delete(shortId);
    this.#records.set(shortId, { ...record, shortId, sessionId: session.sessionId, at: this.#now().toISOString() });
    this.#write();
  }

  /** Links each record not yet linked to the session id of the listed session with its short id. */
  link(snapshot: IndexSnapshot | undefined): void {
    if (snapshot === undefined) return;
    const waiting = new Map<string, LaunchRecord>();
    for (const record of this.#records.values()) if (record.sessionId === undefined) waiting.set(record.shortId, record);
    if (waiting.size === 0) return;
    let linked = false;
    for (const group of snapshot.groups) {
      for (const session of group.sessions) {
        const record = session.shortId === undefined ? undefined : waiting.get(session.shortId);
        if (record === undefined || !isSessionUuid(session.sessionId)) continue;
        record.sessionId = session.sessionId;
        waiting.delete(session.shortId!);
        linked = true;
      }
    }
    if (linked) this.#write();
  }

  /** How many records are kept, for tests. */
  get size(): number {
    return this.#records.size;
  }

  #find(session: Pick<SessionSummary, 'sessionId' | 'shortId'>): LaunchRecord | undefined {
    for (const record of this.#records.values()) if (record.sessionId === session.sessionId) return record;
    if (session.shortId === undefined) return undefined;
    const byShortId = this.#records.get(session.shortId);
    return byShortId !== undefined && byShortId.sessionId === undefined ? byShortId : undefined;
  }

  #cap(): void {
    while (this.#records.size > SESSION_LAUNCHES_MAX) this.#records.delete(this.#records.keys().next().value!);
  }

  /** The file, written whole by rename. Fails soft. */
  #write(): void {
    if (this.#file === undefined || this.#home === undefined) return;
    const body = { v: 1, launches: [...this.#records.values()] };
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

/**
 * The records in the file at `file` that check out; none when there's no file or it can't be trusted:
 * not a regular file of this user's, a link, writable by group or others, or over
 * SESSION_LAUNCHES_FILE_MAX_BYTES. A record needs a short id, a time and a launch with a model, effort
 * or sub-agents' model that passes checkedLaunch(); a session id that isn't a UUID is left off.
 */
export function readSessionLaunchesFile(file: string): LaunchRecord[] {
  let fd: number | undefined;
  let value: unknown;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > SESSION_LAUNCHES_FILE_MAX_BYTES) return [];
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    value = JSON.parse(buffer.subarray(0, read).toString('utf8'));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.launches)) return [];
  const records: LaunchRecord[] = [];
  const seen = new Set<string>();
  for (const entry of (value.launches as unknown[]).slice(0, SESSION_LAUNCHES_MAX * 2)) {
    if (!isRecord(entry) || typeof entry.shortId !== 'string' || !SHORT_ID.test(entry.shortId) || seen.has(entry.shortId) || !isTime(entry.at)) continue;
    const launch = checkedLaunch(entry.launch);
    if (launch === undefined) continue;
    seen.add(entry.shortId);
    const sessionId = typeof entry.sessionId === 'string' && isSessionUuid(entry.sessionId) ? entry.sessionId : undefined;
    records.push({ shortId: entry.shortId, ...(sessionId === undefined ? {} : { sessionId }), at: entry.at, launch });
  }
  return records;
}
