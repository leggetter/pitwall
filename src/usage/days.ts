// The Usage view's kept days (W158): each local day's token totals, numbers only, so a day still
// counts after Claude Code deletes its transcripts (`cleanupPeriodDays`, 30 by default).
//
// Kept in $PITWALL_HOME/usage-days.json, 0600, written whole by rename in pitwall's 0700 home, and
// only when a day changed. Each day holds its calls, fresh input, cache writes, cache reads, output
// and stand-in cost, for main sessions and sub-agents apart, and the same by model id. Never a repo,
// a directory, a session id, a name or anything a session said.
//
// A day only grows: what the transcripts show of it replaces what's kept only when it has more calls
// (or as many, and more tokens), so a transcript deleted later never lowers it.
//
// Read back at start as untrusted, as the snoozes are: a regular file of this user's, not a link, not
// writable by group or others, at most DAYS_FILE_MAX_BYTES; each day and each figure checked, a model
// id only as MODEL_ID allows, anything else skipped. Writing fails soft: the days are kept in memory
// for this run.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../index/guards.js';
import { ensureLaunchDir } from '../server/launch.js';
import type { UsageTokens } from '../shared/protocol.js';

export const DAYS_FILE_NAME = 'usage-days.json';
/** About 400 bytes a model a day: 400 days of several models fit. */
export const DAYS_FILE_MAX_BYTES = 1024 * 1024;
/** The most days kept: past it the oldest go. */
export const DAYS_KEPT_MAX = 400;
/** The most models a day keeps; the rest are summed as OTHER_MODEL. */
export const DAY_MODELS_MAX = 12;
export const OTHER_MODEL = '(other models)';

/** A model id as Claude Code records it: `claude-opus-5-5`, `claude-sonnet-4-5-20250929`, `us.anthropic.…`, `…[1m]`. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]{0,79}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Larger than any real day's count, so a planted figure can't overflow a sum into nonsense. */
const MAX_FIGURE = 1e15;

export interface DayTotals {
  /** The local day, YYYY-MM-DD. */
  day: string;
  main: UsageTokens;
  subagent: UsageTokens;
  /** By model id, main and sub-agents together. */
  models: Record<string, UsageTokens>;
}

/**
 * A record of figures by model id with no prototype, so an id from a transcript such as `__proto__`,
 * `constructor` or `toString` is only ever a key of its own (W158's review).
 */
export const modelRecord = (): Record<string, UsageTokens> => Object.create(null) as Record<string, UsageTokens>;

/** A model id as the kept days and the view key it: itself when MODEL_ID allows it, else OTHER_MODEL. */
export const modelKey = (model: string): string => (MODEL_ID.test(model) ? model : OTHER_MODEL);

/** Adds `tokens` to `models`' figures for `model`, under modelKey(). */
export function addModel(models: Record<string, UsageTokens>, model: string, tokens: UsageTokens): void {
  const key = modelKey(model);
  const into = Object.prototype.hasOwnProperty.call(models, key) ? (models[key] as UsageTokens) : (models[key] = emptyTokens());
  addTokens(into, tokens);
}

export const emptyTokens = (): UsageTokens => ({ calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 });

export function addTokens(into: UsageTokens, from: UsageTokens): void {
  into.calls += from.calls;
  into.input += from.input;
  into.cacheWrite += from.cacheWrite;
  into.cacheRead += from.cacheRead;
  into.output += from.output;
  into.cost += from.cost;
}

export const tokensOf = (t: UsageTokens) => t.input + t.cacheWrite + t.cacheRead + t.output;

/** The day's totals, main and sub-agents together. */
export function dayTotal(day: DayTotals): UsageTokens {
  const total = emptyTokens();
  addTokens(total, day.main);
  addTokens(total, day.subagent);
  return total;
}

/** True when `live` shows more of its day than `kept`. */
export function showsMore(live: DayTotals, kept: DayTotals | undefined): boolean {
  if (kept === undefined) return true;
  const a = dayTotal(live);
  const b = dayTotal(kept);
  return a.calls > b.calls || (a.calls === b.calls && tokensOf(a) > tokensOf(b));
}

/** At most DAY_MODELS_MAX models, the rest summed as OTHER_MODEL, so a day's record stays small. */
export function capModels(models: Record<string, UsageTokens>): Record<string, UsageTokens> {
  const entries = Object.entries(models).sort(([, a], [, b]) => b.cost - a.cost || tokensOf(b) - tokensOf(a));
  const capped = modelRecord();
  const kept = entries.length <= DAY_MODELS_MAX ? entries : entries.slice(0, DAY_MODELS_MAX - 1);
  for (const [model, tokens] of kept) addModel(capped, model, tokens);
  for (const [, tokens] of entries.slice(kept.length)) addModel(capped, OTHER_MODEL, tokens);
  return capped;
}

function readTokens(value: unknown): UsageTokens | undefined {
  if (!isRecord(value)) return undefined;
  const tokens = emptyTokens();
  for (const field of ['calls', 'input', 'cacheWrite', 'cacheRead', 'output', 'cost'] as const) {
    const figure = value[field];
    if (typeof figure !== 'number' || !Number.isFinite(figure) || figure < 0 || figure > MAX_FIGURE) return undefined;
    if (field !== 'cost' && !Number.isInteger(figure)) return undefined;
    tokens[field] = figure;
  }
  return tokens;
}

function readDay(value: unknown, today: string): DayTotals | undefined {
  if (!isRecord(value) || typeof value.day !== 'string' || !DAY.test(value.day) || value.day > today) return undefined;
  if (Number.isNaN(Date.parse(`${value.day}T00:00:00Z`))) return undefined;
  const main = readTokens(value.main);
  const subagent = readTokens(value.subagent);
  if (main === undefined || subagent === undefined || !isRecord(value.models)) return undefined;
  const models = modelRecord();
  const entries = Object.entries(value.models);
  if (entries.length > DAY_MODELS_MAX) return undefined;
  for (const [model, figures] of entries) {
    if (model !== OTHER_MODEL && !MODEL_ID.test(model)) return undefined;
    const tokens = readTokens(figures);
    if (tokens === undefined) return undefined;
    models[model] = tokens;
  }
  return { day: value.day, main, subagent, models };
}

/** The local day of `ms`, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The kept days in `file`, read as untrusted. None when it's missing or fails a check. */
export function readDaysFile(file: string, now: number = Date.now()): DayTotals[] {
  let fd: number | undefined;
  let value: unknown;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > DAYS_FILE_MAX_BYTES) return [];
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
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.days)) return [];
  // A day after tomorrow is a clock or a planted file; a day of slack for time zones.
  const latest = localDay(now + 86_400_000);
  const days = new Map<string, DayTotals>();
  for (const entry of value.days as unknown[]) {
    const day = readDay(entry, latest);
    if (day !== undefined && !days.has(day.day)) days.set(day.day, day);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-DAYS_KEPT_MAX);
}

export interface DayStoreOptions {
  /** pitwall's home. Without one, the days are kept in memory only. */
  home?: string;
  now?: () => number;
}

/** The kept days, and their file. */
export class DayStore {
  readonly #home: string | undefined;
  readonly #file: string | undefined;
  readonly #days = new Map<string, DayTotals>();

  constructor(options: DayStoreOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#file = this.#home === undefined ? undefined : path.join(this.#home, DAYS_FILE_NAME);
    if (this.#file !== undefined) for (const day of readDaysFile(this.#file, (options.now ?? Date.now)())) this.#days.set(day.day, day);
  }

  get(day: string): DayTotals | undefined {
    return this.#days.get(day);
  }

  /** Every kept day, oldest first. */
  all(): DayTotals[] {
    return [...this.#days.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  /** Keeps each of `live` that shows more of its day than what's kept; writes the file when one did. */
  update(live: Iterable<DayTotals>): void {
    let changed = false;
    for (const day of live) {
      if (!DAY.test(day.day) || !showsMore(day, this.#days.get(day.day))) continue;
      const models = modelRecord();
      for (const [model, tokens] of Object.entries(day.models)) addModel(models, model, tokens);
      this.#days.set(day.day, { day: day.day, main: { ...day.main }, subagent: { ...day.subagent }, models: capModels(models) });
      changed = true;
    }
    if (!changed) return;
    const days = this.all();
    for (const old of days.slice(0, Math.max(0, days.length - DAYS_KEPT_MAX))) this.#days.delete(old.day);
    this.#write();
  }

  /**
   * The file, written whole by rename. Fails soft. Another pitwall on the same home may have written
   * since this one read it, so the file is read again first and, day by day, whichever shows more is
   * kept, here and in the file: the last writer never drops the other's days.
   */
  #write(): void {
    if (this.#file === undefined || this.#home === undefined) return;
    for (const day of readDaysFile(this.#file)) if (showsMore(day, this.#days.get(day.day))) this.#days.set(day.day, day);
    const all = this.all();
    for (const old of all.slice(0, Math.max(0, all.length - DAYS_KEPT_MAX))) this.#days.delete(old.day);
    const temporary = `${this.#file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      ensureLaunchDir(this.#home);
      writeFileSync(temporary, `${JSON.stringify({ v: 1, days: this.all() })}\n`, { mode: 0o600, flag: 'wx' });
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
