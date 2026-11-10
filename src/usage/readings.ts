// The run rate's readings (W159): each read of the plan's week, numbers and times only, so the pace
// and the projection (runRate.ts) have the week's history across restarts.
//
// Kept in $PITWALL_HOME/usage-readings.json, 0600, written whole by rename in pitwall's 0700 home,
// only when a new reading came: when it was read, the week's percentage and its reset. Never anything
// else from the report, the account or a session.
//
// Read back as untrusted, as W158's kept days are (days.ts): opened with O_NOFOLLOW and O_NONBLOCK, so
// a link isn't followed and a FIFO never blocks, then fstat: a regular file of this user's, not
// writable by group or others, at most READINGS_FILE_MAX_BYTES. Each reading is checked field by
// field, as whole numbers in bounds (a percentage 0 to 1000, a time no older than READINGS_KEEP_MS
// and no later than READINGS_AHEAD_MS ahead, a reset within the 8 days after it), and copied into a record of
// its own; anything else is skipped. So a planted file can at worst move the pace's projection, which
// the current reading's own percentage bounds, and never adds text to the page.
//
// Each write reads the file again and keeps the union, by time, so two pitwalls on one home don't drop
// each other's readings. Writing fails soft: the readings are kept in memory for this run.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../index/guards.js';
import { ensureLaunchDir } from '../server/launch.js';
import { WEEK_MS, type WeekReading } from './runRate.js';

export const READINGS_FILE_NAME = 'usage-readings.json';
/** About 60 bytes a reading: READINGS_MAX of them fit. */
export const READINGS_FILE_MAX_BYTES = 256 * 1024;
/** Readings older than this go: the week and a day of slack. */
export const READINGS_KEEP_MS = WEEK_MS + 86_400_000;
/** Every 5 minutes for 8 days is 2,304; two pitwalls on one home can add more. Past it the oldest go. */
export const READINGS_MAX = 3000;
const MAX_PERCENT = 1000;
/** A reading's time may be this far ahead of now, for clock jitter between two pitwalls; no more. */
export const READINGS_AHEAD_MS = 5 * 60_000;

function readReading(value: unknown, now: number): WeekReading | undefined {
  if (!isRecord(value)) return undefined;
  const { at, used, resetsAt } = value;
  if (typeof at !== 'number' || !Number.isInteger(at) || at < now - READINGS_KEEP_MS || at > now + READINGS_AHEAD_MS) return undefined;
  if (typeof used !== 'number' || !Number.isInteger(used) || used < 0 || used > MAX_PERCENT) return undefined;
  if (typeof resetsAt !== 'number' || !Number.isInteger(resetsAt) || resetsAt < at || resetsAt > at + WEEK_MS + 86_400_000) return undefined;
  return { at, used, resetsAt };
}

/** The readings in `file`, read as untrusted, oldest first. None when it's missing or fails a check. */
export function readReadingsFile(file: string, now: number = Date.now()): WeekReading[] {
  let fd: number | undefined;
  let value: unknown;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > READINGS_FILE_MAX_BYTES) return [];
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
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.readings)) return [];
  const byTime = new Map<number, WeekReading>();
  for (const entry of value.readings as unknown[]) {
    const reading = readReading(entry, now);
    if (reading !== undefined && !byTime.has(reading.at)) byTime.set(reading.at, reading);
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at).slice(-READINGS_MAX);
}

export interface ReadingStoreOptions {
  /** pitwall's home. Without one, the readings are kept in memory only. */
  home?: string;
  now?: () => number;
}

/** The week's readings, and their file. */
export class ReadingStore {
  readonly #home: string | undefined;
  readonly #file: string | undefined;
  readonly #now: () => number;
  readonly #readings = new Map<number, WeekReading>();

  constructor(options: ReadingStoreOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#file = this.#home === undefined ? undefined : path.join(this.#home, READINGS_FILE_NAME);
    this.#now = options.now ?? Date.now;
    if (this.#file !== undefined) for (const reading of readReadingsFile(this.#file, this.#now())) this.#readings.set(reading.at, reading);
  }

  /** Every reading kept, oldest first. */
  all(): WeekReading[] {
    return [...this.#readings.values()].sort((a, b) => a.at - b.at);
  }

  /** The latest reading, if any. */
  latest(): WeekReading | undefined {
    return this.all().at(-1);
  }

  /** Keeps `reading`, once by its time, and writes the file when it's new. */
  add(reading: WeekReading): void {
    // The server sends whole percentages (spike 013); a fraction is rounded, as the file holds whole numbers.
    const checked = readReading({ ...reading, used: Math.round(reading.used) }, this.#now());
    if (checked === undefined || this.#readings.has(checked.at)) return;
    this.#readings.set(checked.at, { ...checked });
    this.#prune();
    this.#write();
  }

  #prune(): void {
    const now = this.#now();
    for (const [at] of this.#readings) if (at < now - READINGS_KEEP_MS) this.#readings.delete(at);
    const all = this.all();
    for (const old of all.slice(0, Math.max(0, all.length - READINGS_MAX))) this.#readings.delete(old.at);
  }

  /** The file, written whole by rename, after a re-read and merge. Fails soft. */
  #write(): void {
    if (this.#file === undefined || this.#home === undefined) return;
    for (const reading of readReadingsFile(this.#file, this.#now())) if (!this.#readings.has(reading.at)) this.#readings.set(reading.at, reading);
    this.#prune();
    const temporary = `${this.#file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      ensureLaunchDir(this.#home);
      const readings = this.all().map(({ at, used, resetsAt }) => ({ at, used, resetsAt }));
      writeFileSync(temporary, `${JSON.stringify({ v: 1, readings })}\n`, { mode: 0o600, flag: 'wx' });
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
