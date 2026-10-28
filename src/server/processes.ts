// What End session (W90, end.ts) needs to know about a process before it signals one: when it
// started, what command it is, and which process is whose parent. From `ps`, a POSIX tool, run as
// /bin/ps through runFile: no shell, the scrubbed environment, a timeout.
//
// ps's output isn't Claude Code's, but its format for these fields is fixed by POSIX and by both
// BSD and procps ps: `lstart` is `Wed Oct 28 15:48:55 2026`, to the whole second, printed here in
// UTC (TZ=UTC0) and the C locale, so it parses the same on every machine and through a change of
// daylight saving time. Anything it can't read fails soft: the lookup says it couldn't check, and
// End session signals nothing.
//
// Only a pid's start time and command name are read, and the table of pids and parent pids: never a
// command line, which can carry another process's secrets, such as an API key in an MCP server's
// URL (spike 005).
//
// Not subagents.ts' processStartTime(), which works a start out from `etime` and the clock, so two
// reads of one process can differ by a second. End session compares two reads for equality, and
// `lstart` is the start time the kernel keeps, the same on every read.
import path from 'node:path';
import { RunError, runFile, type RunFile } from '../index/exec.js';

/** Where ps is on macOS and Linux, merged-/usr distributions included. */
export const PS = '/bin/ps';

/** How long one ps may take. */
export const PS_TIMEOUT_MS = 5000;

/** The environment ps runs in, before childEnvironment() scrubs it: UTC, the C locale, and a short PATH. */
const PS_ENV: NodeJS.ProcessEnv = { TZ: 'UTC0', LC_ALL: 'C', PATH: '/usr/bin:/bin' };

/** One process, as ps describes it. */
export interface ProcessInfo {
  /** When it started, in milliseconds since the epoch, to the whole second ps gives. */
  startedAtMs: number;
  /** Its command's name, as ps's `comm` gives it: a name, or a path as it was started. */
  command: string;
}

export type ProcessLookup =
  /** `process` is undefined when there's no process with that pid. */
  | { ok: true; process?: ProcessInfo }
  | { ok: false; error: string };

export type ProcessParents = { ok: true; parents: ReadonlyMap<number, number> } | { ok: false; error: string };

export interface Processes {
  /** The process with this pid, or none. Never rejects. */
  lookup(pid: number): Promise<ProcessLookup>;
  /** Every process's parent pid, by pid. Never rejects. */
  parents(): Promise<ProcessParents>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `lstart` then `comm`: `Wed Oct 28 15:48:55 2026     /bin/zsh`. The command may have spaces in it. */
const LOOKUP_LINE = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\S.*?)\s*$/;

/**
 * ps's line for one process, as `ps -o lstart= -o comm=` prints it in UTC, or undefined when it isn't
 * that shape: a start time and a command.
 */
export function parseLookupLine(line: string): ProcessInfo | undefined {
  const match = LOOKUP_LINE.exec(line);
  if (!match) return undefined;
  const [, month, day, hours, minutes, seconds, year, command] = match as unknown as [string, string, string, string, string, string, string, string];
  const monthIndex = MONTHS.indexOf(month);
  if (monthIndex === -1) return undefined;
  const ms = Date.UTC(Number(year), monthIndex, Number(day), Number(hours), Number(minutes), Number(seconds));
  if (!Number.isFinite(ms)) return undefined;
  // Date.UTC rolls an impossible date over, such as Feb 31: refuse one rather than read it as another.
  const date = new Date(ms);
  if (date.getUTCMonth() !== monthIndex || date.getUTCDate() !== Number(day)) return undefined;
  return { startedAtMs: ms, command };
}

/** `pid ppid` lines, as `ps -A -o pid= -o ppid=` prints them. Lines of any other shape are skipped. */
export function parseParents(stdout: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/** True when ps's command is Claude Code's: `claude`, by name or as the last part of a path. */
export function isClaudeCommand(command: string): boolean {
  return path.posix.basename(command) === 'claude';
}

export interface ProcessesOptions {
  /** Default runFile. Tests pass a fake, so nothing depends on this machine's processes. */
  run?: RunFile;
  /** Default PS. */
  ps?: string;
  /** Default PS_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** The real Processes, from ps. */
export function createProcesses(options: ProcessesOptions = {}): Processes {
  const run = options.run ?? runFile;
  const ps = options.ps ?? PS;
  const timeoutMs = options.timeoutMs ?? PS_TIMEOUT_MS;
  const runPs = (args: readonly string[]) => run(ps, args, { cwd: '/', env: PS_ENV, timeoutMs });

  return {
    async lookup(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: true };
      let stdout: string;
      try {
        stdout = await runPs(['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)]);
      } catch (error) {
        // ps exits 1, printing nothing, when there's no such process.
        if (error instanceof RunError && error.reason === 'exit' && error.exitCode === 1) return { ok: true };
        return { ok: false, error: `ps ${error instanceof Error ? error.message : 'failed'}` };
      }
      const lines = stdout.split('\n').filter((line) => line.trim() !== '');
      if (lines.length === 0) return { ok: true };
      const info = lines.length === 1 ? parseLookupLine(lines[0] as string) : undefined;
      return info === undefined ? { ok: false, error: "ps printed a line pitwall can't read" } : { ok: true, process: info };
    },
    async parents() {
      try {
        const parents = parseParents(await runPs(['-A', '-o', 'pid=', '-o', 'ppid=']));
        return parents.size === 0 ? { ok: false, error: 'ps listed no processes' } : { ok: true, parents };
      } catch (error) {
        return { ok: false, error: `ps ${error instanceof Error ? error.message : 'failed'}` };
      }
    },
  };
}

/**
 * The pids from `pid` up to the first process, `pid` first, by `parents`: its parent, its parent's, and
 * so on. It stops at pid 1 or 0, at a pid with no parent listed, and at a loop.
 */
export function ancestry(pid: number, parents: ReadonlyMap<number, number>): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let current: number | undefined = pid;
  while (current !== undefined && current > 0 && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    if (current === 1) break;
    current = parents.get(current);
  }
  return chain;
}
