// The day's recap count, kept on disk so a restart, or a second pitwall on the same home, doesn't
// start the budget again (W110's review): `$PITWALL_HOME/recap-budget.json`, beside the `recap/`
// folder, never inside it, which stays empty. It holds the day, how many calls started that day and
// what they cost, and nothing about any session: no ids, names, text or times of their own (D26).
//
//   {"day":"2026-10-29","calls":12,"costUsd":0.0131}
//
// Written as a 0600 file by rename, so a reader sees the old count or the new one, never half of
// one. Read at start and again before each call is counted, so two pitwalls on one home share the
// day's budget; two counting at the same moment can each miss the other's call, which is accepted.
// A file that's missing, a symbolic link, not a regular file, too big or not this shape counts as
// no calls today. Writing fails soft: the count in memory still holds.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../index/guards.js';
import { ensureLaunchDir } from '../server/launch.js';

/** The file's name in pitwall's home. */
export const RECAP_BUDGET_FILE = 'recap-budget.json';

/** The most read of it: a real one is under 100 bytes. */
const MAX_BYTES = 4096;

/** A local day's count of recap calls. */
export interface DayCount {
  /** The local day, as the engine names it: `YYYY-M-D`. */
  day: string;
  calls: number;
  costUsd: number;
}

/** Where the day's count is kept. */
export interface BudgetStore {
  /** The count on file, or undefined when there's none that can be used. Never throws. */
  read(): DayCount | undefined;
  /** Replaces it. Never throws. */
  write(count: DayCount): void;
}

/** A store in memory only, for tests. */
export function memoryBudget(initial?: DayCount): BudgetStore & { current(): DayCount | undefined } {
  let count = initial === undefined ? undefined : { ...initial };
  return {
    read: () => (count === undefined ? undefined : { ...count }),
    write(next) {
      count = { ...next };
    },
    current: () => (count === undefined ? undefined : { ...count }),
  };
}

const DAY = /^\d{4}-\d{1,2}-\d{1,2}$/;

/** A count read from the file, checked: anything else is undefined. */
export function parseDayCount(text: string): DayCount | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { day, calls, costUsd } = parsed;
  if (typeof day !== 'string' || !DAY.test(day)) return undefined;
  if (typeof calls !== 'number' || !Number.isSafeInteger(calls) || calls < 0) return undefined;
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return undefined;
  return { day, calls, costUsd };
}

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * The file in `home`, pitwall's folder. `log` hears about a write that failed, once until one
 * succeeds, in pitwall's words.
 */
export function budgetFile(home: string, log: (message: string) => void = () => undefined): BudgetStore {
  const file = path.join(home, RECAP_BUDGET_FILE);
  let warned = false;
  return {
    read() {
      let fd: number;
      try {
        fd = openSync(file, READ_FLAGS);
      } catch {
        return undefined;
      }
      try {
        const stats = fstatSync(fd);
        if (!stats.isFile() || stats.size > MAX_BYTES) return undefined;
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        if (read > MAX_BYTES) return undefined;
        return parseDayCount(buffer.toString('utf8', 0, read));
      } catch {
        return undefined;
      } finally {
        closeSync(fd);
      }
    },
    write(count) {
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        ensureLaunchDir(home);
        writeFileSync(temporary, `${JSON.stringify({ day: count.day, calls: count.calls, costUsd: count.costUsd })}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, file);
        warned = false;
      } catch (error) {
        try {
          unlinkSync(temporary);
        } catch {
          // It wasn't made.
        }
        if (!warned) log(`couldn't save today's recap count in ${file} (${(error as Error).message}), so a restart may start the count again.`);
        warned = true;
      }
    },
  };
}
