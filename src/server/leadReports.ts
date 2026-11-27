// A worker's newest report to its lead (W218 piece 2, spike 021's "reported 10:42" on the worker's row),
// for LeadStore.decorate(). The lead's name comes from LeadStore's trusted tree (the review's F2), never
// from the transcript; the read is src/index/reportSources.ts', behind the adapter rules.
//
// reportedAt() answers from what it holds and, when the session has been active since the last read or
// its lead's name changed, queues a read, one at a time in the background. A finished read that changes
// the answer calls onChange, so the snapshot is decorated again. A read that fails reads as none: no
// "reported" rather than an error, until the session is active again. Times only, never the message.
import type { SessionSummary } from '../shared/protocol.js';
import { findTranscript } from '../index/lineageSources.js';
import { readNewestReport } from '../index/reportSources.js';

/** Reads `sessionId`'s newest report to `leadName`: `{ at }`, `{}` for none, undefined when unreadable. */
export type ReadReport = (sessionId: string, cwd: string, leadName: string) => Promise<{ at?: string } | undefined>;

/** The most workers whose report is held; past it the oldest goes. */
export const REPORTS_HELD_MAX = 2000;

export interface LeadReportsOptions {
  read?: ReadReport;
  /** Claude Code's config directory, for the default reader. */
  configDir?: string;
  onChange: () => void;
}

interface Held {
  /** What the read was for: the session's lastActivityAt and the lead's name. */
  activity: string;
  leadName: string;
  at?: string;
}

export class LeadReports {
  readonly #read: ReadReport;
  readonly #onChange: () => void;
  readonly #held = new Map<string, Held>();
  readonly #wanted = new Map<string, { cwd: string; activity: string; leadName: string }>();
  #reading = false;

  constructor(options: LeadReportsOptions) {
    const configDir = options.configDir;
    this.#read =
      options.read ??
      (async (sessionId, cwd, leadName) => {
        const file = await findTranscript(sessionId, [cwd], configDir === undefined ? {} : { configDir });
        return file === undefined ? undefined : readNewestReport(file, leadName);
      });
    this.#onChange = options.onChange;
  }

  /** The time of `session`'s newest report to `leadName` that's held, if any. Queues a read when it may be out of date. Never throws. */
  reportedAt(session: Pick<SessionSummary, 'sessionId' | 'cwd' | 'lastActivityAt' | 'startedAt'>, leadName: string): string | undefined {
    const activity = session.lastActivityAt ?? session.startedAt;
    const held = this.#held.get(session.sessionId);
    if (held === undefined || held.activity !== activity || held.leadName !== leadName) {
      this.#wanted.set(session.sessionId, { cwd: session.cwd, activity, leadName });
      this.#drain();
    }
    return held?.leadName === leadName ? held.at : undefined;
  }

  #drain(): void {
    if (this.#reading || this.#wanted.size === 0) return;
    this.#reading = true;
    void (async () => {
      let changed = false;
      try {
        while (this.#wanted.size > 0) {
          const [sessionId, want] = this.#wanted.entries().next().value as [string, { cwd: string; activity: string; leadName: string }];
          this.#wanted.delete(sessionId);
          let found: { at?: string } | undefined;
          try {
            found = await this.#read(sessionId, want.cwd, want.leadName);
          } catch {
            found = undefined;
          }
          const before = this.#held.get(sessionId);
          // Unreadable reads as none, held for this activity, so it's read again only once the session is active again.
          const at = found?.at;
          this.#held.delete(sessionId);
          this.#held.set(sessionId, { activity: want.activity, leadName: want.leadName, ...(at === undefined ? {} : { at }) });
          if (this.#held.size > REPORTS_HELD_MAX) this.#held.delete(this.#held.keys().next().value as string);
          // What reportedAt() answered for this name before: a change to it is what the snapshot shows.
          if ((before?.leadName === want.leadName ? before.at : undefined) !== at) changed = true;
        }
      } finally {
        this.#reading = false;
        if (changed) this.#onChange();
      }
    })();
  }
}
