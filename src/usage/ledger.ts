// The Usage view's transcript reads (W158): every transcript the usage report reads (W131,
// scan.ts), followed across requests, so each one is read on from where the last read stopped
// rather than read whole on each request. Internal and undocumented, so it fails soft as scan.ts
// does: a file that can't be read is counted, never fatal.
//
// Each file is read from its last complete line's end to its size at the time; a last line without
// its newline yet waits for the next read. A file that shrank or was replaced (another inode) is read
// again from the start, and one that's gone is dropped: the days it counted stay in the kept totals
// (days.ts). Calls older than `keepMs` are dropped from memory as they age.
//
// Lines are split as bytes, and a line is decoded and parsed only when it holds one of scan.ts's
// markers, so a transcript's large request lines are skipped without being decoded.
import { createHash } from 'node:crypto';
import { agentTypeOf, createTranscriptState, findTranscripts, MARKERS, openRegular, type FileScan, type FoundFile, type TranscriptState } from './scan.js';

/** The longest window the view asks for, 30 days, and a day's slack for the time zone. */
export const LEDGER_KEEP_MS = 31 * 86_400_000;

/** Bytes read at a time. */
const CHUNK = 1024 * 1024;

const MARKER_BYTES = MARKERS.map((marker) => Buffer.from(marker, 'utf8'));

/** The bytes at the file's start that are hashed, to tell a file cut short and grown again in place. */
const HEAD_BYTES = 512;

interface Followed {
  found: FoundFile;
  ino: number | undefined;
  /** Where the next read starts: just after the last newline read. */
  offset: number;
  /** Its mtime at the last read: one that moves back means the file was rewritten. */
  mtimeMs: number;
  /** A hash of its first `headLength` bytes as last read. */
  head?: { length: number; hash: string };
  state: TranscriptState;
}

const hashOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface LedgerStats {
  /** Files followed now. */
  files: number;
  /** Directories or files that couldn't be listed, stat'ed or read at the last refresh. */
  unreadable: number;
  /** Bytes read at the last refresh. */
  bytesRead: number;
}

export interface UsageLedger {
  /**
   * Reads what's new in every transcript written to since `since`, and in every one already
   * followed. Calls at once share one read. Never rejects.
   */
  refresh(since: number): Promise<LedgerStats>;
  /** What's been read, one FileScan a file, for the view's totals. */
  scans(): FileScan[];
}

export interface LedgerOptions {
  /** Claude Code's `projects` folder. */
  projectsDir: string;
  now?: () => number;
  keepMs?: number;
  /** Files read at once. */
  concurrency?: number;
}

export function createUsageLedger(options: LedgerOptions): UsageLedger {
  const now = options.now ?? Date.now;
  const keepMs = options.keepMs ?? LEDGER_KEEP_MS;
  const concurrency = options.concurrency ?? 4;
  const followed = new Map<string, Followed>();
  let pending: { since: number; done: Promise<LedgerStats> } | undefined;

  async function start(found: FoundFile, cutoff: number): Promise<Followed> {
    const agentType = found.subagent ? await agentTypeOf(found.file) : undefined;
    return { found, ino: found.ino, offset: 0, mtimeMs: found.mtimeMs, state: createTranscriptState(found, cutoff, Number.POSITIVE_INFINITY, agentType) };
  }

  /**
   * Reads `entry` from its offset to `size`, feeding each complete line. Returns the bytes read, -1
   * when it couldn't, or 'changed' when the file's first bytes aren't those read before: it was cut
   * short and written again in place, so it's to be read from the start.
   */
  async function readOn(entry: Followed, size: number): Promise<number | 'changed'> {
    // Only a regular file: never through a link, never waiting on a FIFO (W158's review).
    const handle = await openRegular(entry.found.file);
    if (handle === undefined) return -1;
    let read = 0;
    try {
      if (entry.head !== undefined) {
        const head = Buffer.alloc(entry.head.length);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        if (bytesRead !== head.length || hashOf(head) !== entry.head.hash) return 'changed';
      }
      const buffer = Buffer.alloc(CHUNK);
      let position = entry.offset;
      // The current line's parts, before its newline.
      let parts: Buffer[] = [];
      while (position < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - position), position);
        if (bytesRead === 0) break;
        read += bytesRead;
        let from = 0;
        for (let at = buffer.indexOf(0x0a, 0); at !== -1 && at < bytesRead; at = buffer.indexOf(0x0a, from)) {
          parts.push(buffer.subarray(from, at));
          feed(entry.state, parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts));
          parts = [];
          from = at + 1;
          entry.offset = position + from;
        }
        // Copied: the buffer is read into again.
        if (from < bytesRead) parts.push(Buffer.from(buffer.subarray(from, bytesRead)));
        position += bytesRead;
      }
      if ((entry.head?.length ?? 0) < HEAD_BYTES && entry.offset > (entry.head?.length ?? 0)) {
        const head = Buffer.alloc(Math.min(entry.offset, HEAD_BYTES));
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        entry.head = { length: bytesRead, hash: hashOf(head.subarray(0, bytesRead)) };
      }
    } catch {
      entry.state.scan.unreadable = true;
      return -1;
    } finally {
      await handle.close().catch(() => undefined);
    }
    entry.mtimeMs = entry.found.mtimeMs;
    entry.state.scan.unreadable = false;
    return read;
  }

  /** Reads `file` from the start, as a file followed afresh. */
  async function readFresh(file: FoundFile, size: number, cutoff: number, stats: LedgerStats): Promise<void> {
    const fresh = await start(file, cutoff);
    followed.set(file.file, fresh);
    const bytes = await readOn(fresh, size);
    if (typeof bytes !== 'number' || bytes < 0) stats.unreadable++;
    else stats.bytesRead += bytes;
  }

  async function run(since: number): Promise<LedgerStats> {
    const cutoff = now() - keepMs;
    const stats: LedgerStats = { files: 0, unreadable: 0, bytesRead: 0 };
    // Every file, whatever its age, so one followed and since gone is known to be gone.
    const found = await findTranscripts(options.projectsDir, 0);
    stats.unreadable += found.unreadable;
    const present = new Set<string>();
    const work: Array<() => Promise<void>> = [];
    for (const file of found.files) {
      present.add(file.file);
      let entry = followed.get(file.file);
      const size = file.size ?? 0;
      if (entry !== undefined && (entry.ino !== file.ino || size < entry.offset || file.mtimeMs < entry.mtimeMs)) {
        // Replaced, cut short, or written with an older time: read again from the start.
        followed.delete(file.file);
        entry = undefined;
      }
      if (entry === undefined) {
        if (file.mtimeMs < Math.max(since, cutoff)) continue;
        work.push(() => readFresh(file, size, cutoff, stats));
      } else if (size > entry.offset || file.mtimeMs !== entry.mtimeMs) {
        // Grown, or written to at the same size: its first bytes say whether it's still the file read before.
        const known = entry;
        known.found = file;
        work.push(async () => {
          const bytes = await readOn(known, size);
          if (bytes === 'changed') await readFresh(file, size, cutoff, stats);
          else if (bytes < 0) stats.unreadable++;
          else stats.bytesRead += bytes;
        });
      }
    }
    for (const [file, entry] of followed) {
      if (!present.has(file)) followed.delete(file);
      else entry.state.prune(cutoff);
    }
    const queue = [...work];
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) await next();
      }),
    );
    // A file no longer written to, whose calls have all aged out, isn't followed any more.
    for (const [file, entry] of followed) {
      if (entry.found.mtimeMs < cutoff && entry.state.scan.calls.length === 0) followed.delete(file);
    }
    stats.files = followed.size;
    return stats;
  }

  return {
    refresh(since) {
      if (pending !== undefined && pending.since <= since) return pending.done;
      // A longer window than the read in flight asks for: another read after it, for the older files.
      const before = pending?.done ?? Promise.resolve();
      const entry = {
        since,
        done: before
          .then(() => run(since))
          .catch((): LedgerStats => ({ files: followed.size, unreadable: 1, bytesRead: 0 }))
          .finally(() => {
            if (pending === entry) pending = undefined;
          }),
      };
      pending = entry;
      return entry.done;
    },
    scans: () => [...followed.values()].map((entry) => entry.state.scan),
  };
}

function feed(state: TranscriptState, line: Buffer): void {
  if (!MARKER_BYTES.some((marker) => line.includes(marker))) {
    // Counted as read, as scanTranscript() counts every line.
    state.scan.lines++;
    return;
  }
  state.feed(line.toString('utf8'));
}
