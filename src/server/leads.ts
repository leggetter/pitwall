// Leads and workers (W218, spike 021, option B). Phil, 2026-11-26: "it's not clear if either of them is
// the coordinator or the lead." A lead is one of your sessions that hands work to other sessions, its
// workers. pitwall records which is which, ids only, and the snapshot carries it: `lead` on a lead,
// `workerOf` on a worker. Nothing is ever sent to a session from here.
//
// Where a link comes from:
//   - Make lead on a session's actions menu: a lead with no workers yet (a mark).
//   - Start a worker… on a lead's actions menu: New session, then POST workerStartedPath() with the
//     short id `claude --bg` reported; the link is written when the snapshot lists that job's session
//     (expectWorker(), as W168's `continue` waits for a started session).
//   - Report to… on a session's actions menu: a link to a lead you pick.
//   - Claude Code's `derived-from` entry with `via: "launch"` in a session's transcript (undocumented,
//     spike 021 finding 2, read behind src/index/lineageSources.ts): the session was started with
//     `claude --bg` from the launcher's shell. It counts only when the launcher is a lead already, by a
//     mark or a link of yours, and you haven't said Not a worker for that pair: an undocumented entry
//     never makes a lead by itself, so a spike's throwaway `claude --bg` doesn't turn the session that
//     ran it into a lead.
//   Not a lead takes the mark off and unlinks its workers; Not a worker unlinks a worker. Both are
//   kept as an `on: false` entry, so a second pitwall's copy or a `derived-from` entry doesn't bring
//   the link back.
//
// The tree (treeOf()):
//   - Every id is read as the newest session in its chain: lineage's `clear` and `continue` (W167), and
//     a `derived-from` entry's `via: "clear"`. So a lead that runs /clear, or hands off to a session
//     that continues it, keeps its workers under its newest session; a worker that does, stays one.
//   - One level: a lead isn't a worker, and a worker isn't a lead. A worker has one lead.
//   - Your links, newest first, then the launches. A link is taken unless its worker has a lead
//     already, its worker is a lead, or its lead is a worker. A launch only when its lead is a lead.
//   - Decorated only on sessions the snapshot lists: a lead's `workers` are those listed, and a
//     worker's `workerOf` is set only while its lead is listed.
//
// Kept in $PITWALL_HOME/leads.json, 0600, written whole by rename, after reading the file again and
// merging it, the newer entry of each key winning, so a second pitwall on the same home keeps the
// first's:
//
//   {"v":1,"marks":[{"id":"<session id>","at":"<ISO time>","on":true|false}],
//          "links":[{"lead":"<session id>","worker":"<session id>","at":"<ISO time>","on":true|false,
//                    "how"?:"started"|"reported"}]}
//
// Session ids and times only: never a name, prompt, path or any other session content. Read back as
// untrusted: opened without following a link or blocking on a FIFO, a regular file of this user's, not
// writable by group or others, at most LEADS_FILE_MAX_BYTES; each entry checked field by field and made
// again, anything else skipped; at most LEADS_HELD_MAX marks and links each, the oldest dropped. Writing
// fails soft: what changed holds in memory for this run.
//
// The report target (W218 piece 2, the review's F2): the lead a worker is told to report to, by the
// paragraph pitwall adds to its first prompt or the message Report to… offers, and the lead whose name
// its `SendMessage` reports are matched against for "reported HH:MM", is read from trustedTree(): your
// marks and links, Claude Code's launches, and lineage where a session has exactly one successor
// by the lines pitwall saw happen (LineageStore.soleSuccessorOf() with `inferred: false`, the review's
// F1), never a `derived-from` `clear` and never lineage's backfilled `inferred` lines, which come from a
// job's state.json and a transcript's opening. A session can append that line to its own transcript,
// and with it the display tree above moves a lead's workers to that session; it can't move where they
// report. A launch counts in both trees for its own session only, under a lead by your mark or link,
// so a line one session writes changes nothing about another's reports.
//
// So a lead the display tree shows only by such a line isn't trusted (the review's F2, server part):
// the snapshot's `lead` carries `trusted: true` only for a lead in trustedTree(), Report to… (link())
// refuses a lead that isn't one there, and Make lead (mark()) writes a mark of the session's own when
// the display tree has it marked but the trusted tree doesn't, so Make lead is how such a session
// becomes a trusted lead.
// The paragraph's text is src/server/leadBrief.ts'; the report reads are src/server/leadReports.ts'.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../index/guards.js';
import { findTranscript, readDerivedFrom, type DerivedFrom } from '../index/lineageSources.js';
import { isSessionUuid } from '../index/transcripts.js';
import type { IndexSnapshot, SessionLead, SessionSummary, SessionWorkerOf, WorkerHow } from '../shared/protocol.js';
import { ensureLaunchDir } from './launch.js';
import { CHAIN_MAX, type LineageStore } from './lineage.js';
import type { SnapshotView } from './snapshotLinks.js';
import { createDecoratedView } from './snapshotRecaps.js';
import { LeadReports, type ReadReport } from './leadReports.js';

/** The file's name in pitwall's home. */
export const LEADS_FILE_NAME = 'leads.json';
/** The most marks, and links, held; past it the oldest go. At about 150 bytes a link, the file stays under 160 KB. */
export const LEADS_HELD_MAX = 500;
export const LEADS_FILE_MAX_BYTES = 256 * 1024;
/** How long a session started from Start a worker… is waited for in the listing (W168's wait). */
export const WORKER_WAIT_MS = 10 * 60 * 1000;
/** The most started sessions waited for at once; spawns are rate-limited, so a handful. */
export const WORKER_EXPECTED_MAX = 20;
/** The most sessions whose `derived-from` entry is remembered; a run lists a few hundred at most. */
export const DERIVED_HELD_MAX = 2000;

/** A session started this recently is read again while its entry isn't found, up to DERIVED_TRIES_MAX times. */
export const DERIVED_RETRY_MS = 2 * 60 * 1000;
export const DERIVED_TRIES_MAX = 5;

/** The trusted tree follows only the lineage lines pitwall saw happen, never backfill()'s inferred ones (the review's F1). */
const OBSERVED = { inferred: false } as const;
const SHORT_ID = /^[0-9a-f]{8}$/;
/** A time as toISOString() writes it, so no free text rides in `at`. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isTime = (value: unknown): value is string => typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const isId = (value: unknown): value is string => typeof value === 'string' && isSessionUuid(value);

/** Make lead (on) or Not a lead (off) on a session. */
export interface LeadMark {
  id: string;
  at: string;
  on: boolean;
}

/** A link from a lead to a worker, or with `on: false` its undoing. */
export interface LeadLink {
  lead: string;
  worker: string;
  at: string;
  on: boolean;
  /** How an `on` link was made. */
  how?: 'started' | 'reported';
}

const linkKey = (link: Pick<LeadLink, 'lead' | 'worker'>) => `${link.lead}>${link.worker}`;

/** What a session's transcript says it came from, for the tree. */
export interface DerivedLinks {
  /** Each session's launcher, by `derived-from` `via: "launch"`. */
  launchedBy: ReadonlyMap<string, string>;
  /** Each session's predecessor after /clear, by `derived-from` `via: "clear"`. */
  clearedFrom: ReadonlyMap<string, string>;
}

export interface TreeInput {
  marks: readonly LeadMark[];
  links: readonly LeadLink[];
  derived: DerivedLinks;
  /** The session that continues `id`, nearest only (lineage), or undefined. */
  successorOf: (id: string) => string | undefined;
}

/** The leads and workers, every id the newest in its chain. */
export interface LeadTree {
  /** Every lead, marked or with a worker. */
  leads: ReadonlySet<string>;
  /** Those you marked. */
  marked: ReadonlySet<string>;
  /** Each worker's lead and how it was linked. */
  leadOf: ReadonlyMap<string, { lead: string; how: WorkerHow }>;
  /** Each lead's workers, in the order they were taken (oldest link first). */
  workersOf: ReadonlyMap<string, readonly string[]>;
}

/** `id`, or the newest session after it along lineage and `derived-from` clears. Stops at CHAIN_MAX steps or a loop. */
export function newestOf(id: string, successorOf: (id: string) => string | undefined, clearedTo: ReadonlyMap<string, string>): string {
  const seen = new Set<string>([id]);
  let current = id;
  for (let steps = 0; steps < CHAIN_MAX; steps++) {
    const next = successorOf(current) ?? clearedTo.get(current);
    if (next === undefined || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

/** The newest entry of each key in `entries`, in order of time. Equal times keep the later one in the list. */
function newestByKey<T extends { at: string }>(entries: readonly T[], key: (entry: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    const held = byKey.get(key(entry));
    if (held === undefined || Date.parse(entry.at) >= Date.parse(held.at)) byKey.set(key(entry), entry);
  }
  return [...byKey.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The tree from what's held. See the top of this file. Pure. */
export function treeOf(input: TreeInput): LeadTree {
  const clearedTo = new Map<string, string>();
  for (const [to, from] of input.derived.clearedFrom) if (!clearedTo.has(from)) clearedTo.set(from, to);
  const newest = (id: string) => newestOf(id, input.successorOf, clearedTo);
  const marked = new Set<string>();
  for (const mark of newestByKey(input.marks, (each) => each.id)) {
    const id = newest(mark.id);
    if (mark.on) marked.add(id);
    else marked.delete(id);
  }
  const leads = new Set<string>(marked);
  const leadOf = new Map<string, { lead: string; how: WorkerHow }>();
  const order: { lead: string; worker: string; at: number }[] = [];
  const take = (lead: string, worker: string, how: WorkerHow, at: number): void => {
    if (lead === worker || leadOf.has(worker) || leads.has(worker) || leadOf.has(lead)) return;
    leadOf.set(worker, { lead, how });
    leads.add(lead);
    order.push({ lead, worker, at });
  };
  const newestLinks = newestByKey(input.links, linkKey);
  // An undone pair, by the ids as written: a launch it names stays undone.
  const off = new Set(newestLinks.filter((link) => !link.on).map(linkKey));
  // Your links, newest first, so a later Report to… wins over an earlier one.
  for (const link of [...newestLinks].reverse()) if (link.on) take(newest(link.lead), newest(link.worker), link.how ?? 'reported', Date.parse(link.at));
  // Then the launches, only under a lead already.
  for (const [worker, launcher] of input.derived.launchedBy) {
    if (off.has(linkKey({ lead: launcher, worker }))) continue;
    const lead = newest(launcher);
    if (!leads.has(lead)) continue;
    take(lead, newest(worker), 'launched', 0);
  }
  const workersOf = new Map<string, string[]>();
  for (const { lead, worker } of order.sort((a, b) => a.at - b.at)) workersOf.set(lead, [...(workersOf.get(lead) ?? []), worker]);
  return { leads, marked, leadOf, workersOf };
}

export interface LeadStoreOptions {
  /** pitwall's home. Without one, marks and links are held in memory only. */
  home?: string;
  now?: () => Date;
  /** Lineage (W167), for each session's successor; the report target follows only a sole one. */
  lineage?: Pick<LineageStore, 'linksOf' | 'soleSuccessorOf' | 'subscribe'>;
  /**
   * Reads a session's `derived-from` entry. Default: its transcript's first 64 KiB, found by its id
   * under Claude Code's projects folder (src/index/lineageSources.ts). For tests.
   */
  readDerived?: (sessionId: string, cwd: string) => Promise<DerivedFrom | undefined>;
  /** Claude Code's config directory, for the default reader. */
  configDir?: string;
  /**
   * Reads a worker's newest report to its lead (W218 piece 2). Default: its transcript's tail, found by
   * its id (src/index/reportSources.ts). For tests.
   */
  readReport?: ReadReport;
}

/** Why a change to the links was refused, in pitwall's words, for a 409. */
export type LeadRefusal = { ok: false; error: string };
export type LeadChange = { ok: true } | LeadRefusal;

/** The marks and links held, their file, the `derived-from` reads and the snapshot's decoration. */
export class LeadStore {
  readonly #file: string | undefined;
  readonly #home: string | undefined;
  readonly #now: () => Date;
  readonly #lineage: LeadStoreOptions['lineage'];
  readonly #readDerived: NonNullable<LeadStoreOptions['readDerived']>;
  #marks = new Map<string, LeadMark>();
  #links = new Map<string, LeadLink>();
  readonly #launchedBy = new Map<string, string>();
  readonly #clearedFrom = new Map<string, string>();
  /** Sessions whose transcript was read, or is being read, this run, with how many times. */
  readonly #read = new Map<string, number>();
  #reading = false;
  /** Young sessions read again, with how many times so far. */
  readonly #retry = new Map<string, number>();
  /** Sessions started from Start a worker…, by short id, waiting for the listing (expectWorker()). */
  readonly #expected = new Map<string, { lead: string; at: number }>();
  readonly #listeners = new Set<() => void>();
  #version = 0;
  #tree: { version: number; tree: LeadTree } | undefined;
  #trusted: { version: number; tree: LeadTree } | undefined;
  readonly #reports: LeadReports;
  #offLineage: (() => void) | undefined;

  constructor(options: LeadStoreOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#file = this.#home === undefined ? undefined : path.join(this.#home, LEADS_FILE_NAME);
    this.#now = options.now ?? (() => new Date());
    this.#lineage = options.lineage;
    const configDir = options.configDir;
    this.#readDerived =
      options.readDerived ??
      (async (sessionId, cwd) => {
        const file = await findTranscript(sessionId, [cwd], configDir === undefined ? {} : { configDir });
        return file === undefined ? undefined : readDerivedFrom(file, sessionId);
      });
    this.#reports = new LeadReports({ ...(options.readReport === undefined ? {} : { read: options.readReport }), ...(configDir === undefined ? {} : { configDir }), onChange: () => this.#changed() });
    if (this.#file !== undefined) {
      const stored = readLeadsFile(this.#file, this.#now());
      for (const mark of stored.marks) this.#marks.set(mark.id, mark);
      for (const link of stored.links) this.#links.set(linkKey(link), link);
    }
    // A new lineage link can move a lead to its newest session.
    this.#offLineage = this.#lineage?.subscribe(() => this.#changed());
  }

  /** The tree now. */
  tree(): LeadTree {
    if (this.#tree === undefined || this.#tree.version !== this.#version) {
      const successorOf = (id: string) => this.#lineage?.linksOf(id).to;
      this.#tree = {
        version: this.#version,
        tree: treeOf({ marks: [...this.#marks.values()], links: [...this.#links.values()], derived: { launchedBy: this.#launchedBy, clearedFrom: this.#clearedFrom }, successorOf }),
      };
    }
    return this.#tree.tree;
  }

  /**
   * The tree a report target is read from (the review's F2): the same marks, links and launches, with
   * every id read as the newest in its chain along lineage only, and only where a session has one
   * successor. Never a `derived-from` `clear`. See the top of this file.
   */
  trustedTree(): LeadTree {
    if (this.#trusted === undefined || this.#trusted.version !== this.#version) {
      const successorOf = (id: string) => this.#lineage?.soleSuccessorOf(id, OBSERVED);
      this.#trusted = {
        version: this.#version,
        tree: treeOf({ marks: [...this.#marks.values()], links: [...this.#links.values()], derived: { launchedBy: this.#launchedBy, clearedFrom: new Map() }, successorOf }),
      };
    }
    return this.#trusted.tree;
  }

  /** `leadId`, read as the newest in its chain along lineage only, when that is a lead in trustedTree(); else undefined. */
  trustedLead(leadId: string): string | undefined {
    if (!isId(leadId)) return undefined;
    const id = this.#trustedNewest(leadId);
    return this.trustedTree().leads.has(id) ? id : undefined;
  }

  /** The lead `workerId` reports to, by trustedTree(): its own id, as listed, is looked up, never a chain a transcript claims. */
  reportTarget(workerId: string): string | undefined {
    return isId(workerId) ? this.trustedTree().leadOf.get(workerId)?.lead : undefined;
  }

  /** Make lead, or with `on` false Not a lead, which also unlinks its workers. `sessionId` is read as the newest in its chain. */
  mark(sessionId: string, on: boolean): LeadChange {
    if (!isId(sessionId)) return { ok: false, error: 'That is not a valid session id.' };
    const id = this.#newest(sessionId);
    const tree = this.tree();
    // Marked in the trusted tree, not only the display tree (the review's F2): a session that holds a
    // mark only by a `derived-from` `clear` it wrote gets one of its own, so Make lead makes it trusted.
    const trustedId = this.#trustedNewest(sessionId);
    if (on) {
      if (tree.leadOf.has(id)) return { ok: false, error: 'It’s a worker. Choose Not a worker first, then Make lead.' };
      if (tree.marked.has(id) && this.trustedTree().marked.has(trustedId)) return { ok: true };
    } else {
      // A Start a worker… still waited for would make it a lead again (W218 review, F3).
      for (const [shortId, entry] of this.#expected) if (this.#newest(entry.lead) === id) this.#expected.delete(shortId);
      if (!tree.leads.has(id)) return { ok: true };
    }
    const at = this.#now().toISOString();
    const changes: { marks: LeadMark[]; links: LeadLink[] } = { marks: [{ id: sessionId, at, on }], links: [] };
    if (!on) {
      // An older or newer session in its chain may hold the mark.
      for (const mark of this.#marks.values()) if (mark.on && mark.id !== sessionId && this.#newest(mark.id) === id) changes.marks.push({ id: mark.id, at, on: false });
      changes.links.push(...this.#unlinks(at, (lead) => lead === id));
    }
    this.#apply(changes, at);
    return this.#took(on ? (tree) => tree.marked.has(id) && this.trustedTree().marked.has(trustedId) : (tree) => !tree.leads.has(id));
  }

  /** Report to…: `worker` works for `lead`, which must be a lead now. Replaces any lead it had. Both read as the newest in their chains. */
  link(worker: string, lead: string, how: 'started' | 'reported'): LeadChange {
    if (!isId(worker) || !isId(lead)) return { ok: false, error: 'That is not a valid session id.' };
    const newestWorker = this.#newest(worker);
    const newestLead = this.#newest(lead);
    if (newestWorker === newestLead) return { ok: false, error: 'A session can’t report to itself.' };
    const tree = this.tree();
    if (!tree.leads.has(newestLead)) return { ok: false, error: 'That session isn’t a lead. Choose Make lead on it first.' };
    // A lead only by a `derived-from` `clear` in its own transcript isn't one to report to (the review's F2).
    if (this.trustedLead(lead) === undefined) return { ok: false, error: 'That session is a lead only by its own transcript’s word. Choose Confirm as lead on it first.' };
    if (tree.leads.has(newestWorker)) return { ok: false, error: 'It’s a lead itself. Choose Not a lead on it first.' };
    if (tree.leadOf.get(newestWorker)?.lead === newestLead) return { ok: true };
    const at = this.#now().toISOString();
    const links = this.#unlinks(at, (_, each) => each === newestWorker);
    links.push({ lead, worker, at, on: true, how });
    this.#apply({ marks: [], links }, at);
    return this.#took((tree) => tree.leadOf.get(newestWorker)?.lead === newestLead);
  }

  /** Not a worker: `worker`, read as the newest in its chain, no longer works for its lead. */
  unlink(worker: string): LeadChange {
    if (!isId(worker)) return { ok: false, error: 'That is not a valid session id.' };
    const id = this.#newest(worker);
    if (!this.tree().leadOf.has(id)) return { ok: true };
    const at = this.#now().toISOString();
    this.#apply({ marks: [], links: this.#unlinks(at, (_, each) => each === id) }, at);
    return this.#took((tree) => !tree.leadOf.has(id));
  }

  /** Whether `sessionId`, read as the newest in its chain, is a worker now: one can't have workers. */
  isWorker(sessionId: string): boolean {
    return isId(sessionId) && this.tree().leadOf.has(this.#newest(sessionId));
  }

  /**
   * Remembers that the background job `shortId`, just started from lead `lead`'s Start a worker…, works
   * for it, and links it once a snapshot lists the job. Held for WORKER_WAIT_MS, at most
   * WORKER_EXPECTED_MAX at once. False when either id isn't valid, or the table is full. Never throws.
   */
  expectWorker(shortId: string, lead: string): boolean {
    if (!SHORT_ID.test(shortId) || !isId(lead)) return false;
    const now = this.#now().getTime();
    for (const [key, entry] of this.#expected) if (now - entry.at >= WORKER_WAIT_MS) this.#expected.delete(key);
    if (!this.#expected.has(shortId) && this.#expected.size >= WORKER_EXPECTED_MAX) return false;
    this.#expected.set(shortId, { lead, at: now });
    return true;
  }

  /** `on: false` entries for every link held, and every launch read, whose ids are `match`'s in the tree now. */
  #unlinks(at: string, match: (lead: string, worker: string) => boolean): LeadLink[] {
    const offs: LeadLink[] = [];
    for (const link of this.#links.values()) if (link.on && match(this.#newest(link.lead), this.#newest(link.worker))) offs.push({ lead: link.lead, worker: link.worker, at, on: false });
    for (const [worker, launcher] of this.#launchedBy) if (match(this.#newest(launcher), this.#newest(worker))) offs.push({ lead: launcher, worker, at, on: false });
    return offs;
  }

  /** `id` read as the newest in its chain along lineage only, by the lines pitwall saw happen: the trusted tree's reading. */
  #trustedNewest(id: string): string {
    return newestOf(id, (each) => this.#lineage?.soleSuccessorOf(each, OBSERVED), new Map());
  }

  #newest(id: string): string {
    const clearedTo = new Map<string, string>();
    for (const [to, from] of this.#clearedFrom) if (!clearedTo.has(from)) clearedTo.set(from, to);
    return newestOf(id, (each) => this.#lineage?.linksOf(each).to, clearedTo);
  }

  /** `changes`, made at `at`, held and written. */
  #apply(changes: { marks: readonly LeadMark[]; links: readonly LeadLink[] }, at: string): void {
    if (changes.marks.length === 0 && changes.links.length === 0) return;
    for (const mark of changes.marks) this.#marks.set(mark.id, mark);
    for (const link of changes.links) this.#links.set(linkKey(link), link);
    this.#write(at);
    this.#changed();
  }

  /**
   * OK when the tree shows the change just made, else a refusal for a 409, so a 200 always means it took
   * (W218 review, F1). An entry held with a newer time, such as after the clock went back, would hide it.
   */
  #took(shows: (tree: LeadTree) => boolean): LeadChange {
    return shows(this.tree()) ? { ok: true } : { ok: false, error: 'That change didn’t take: pitwall holds a newer one. Reload and try again.' };
  }

  /** `snapshot` with `lead` and `workerOf` on each listed lead and worker. Also starts the reads it needs. A copy when any session changed. */
  decorate(snapshot: IndexSnapshot): IndexSnapshot {
    const listed = new Map<string, SessionSummary>();
    for (const group of snapshot.groups) for (const session of group.sessions) listed.set(session.sessionId, session);
    this.#takeStarted(listed);
    this.#readNew(listed);
    const tree = this.tree();
    if (tree.leads.size === 0) return snapshot;
    const trusted = this.trustedTree();
    let changed = false;
    const groups = snapshot.groups.map((group) => {
      let groupChanged = false;
      const sessions = group.sessions.map((session) => {
        const id = session.sessionId;
        let lead: SessionLead | undefined;
        if (tree.leads.has(id)) {
          const workers = (tree.workersOf.get(id) ?? []).filter((worker) => listed.has(worker));
          if (workers.length > 0 || tree.marked.has(id)) lead = { workers, ...(tree.marked.has(id) ? { marked: true as const } : {}), ...(trusted.leads.has(id) ? { trusted: true as const } : {}) };
        }
        const of = tree.leadOf.get(id);
        let workerOf: SessionWorkerOf | undefined = of !== undefined && listed.has(of.lead) ? { lead: of.lead, how: of.how } : undefined;
        // Its newest report, to the name of the lead it reports to by the trusted tree, while that lead is
        // listed, and only when that is the lead it shows (the review's F6), so a time never sits beside another lead's name.
        const trustedLead = workerOf === undefined ? undefined : trusted.leadOf.get(id)?.lead;
        const target = trustedLead === workerOf?.lead ? trustedLead : undefined;
        const targetName = target === undefined ? undefined : listed.get(target)?.name;
        const reportedAt = targetName === undefined ? undefined : this.#reports.reportedAt(session, targetName);
        if (workerOf !== undefined && reportedAt !== undefined) workerOf = { ...workerOf, reportedAt };
        if (lead === undefined && workerOf === undefined) return session;
        groupChanged = true;
        return { ...session, ...(lead === undefined ? {} : { lead }), ...(workerOf === undefined ? {} : { workerOf }) };
      });
      if (!groupChanged) return group;
      changed = true;
      return { ...group, sessions };
    });
    return changed ? { ...snapshot, groups } : snapshot;
  }

  /** Links the started workers the listing now has. */
  #takeStarted(listed: ReadonlyMap<string, SessionSummary>): void {
    if (this.#expected.size === 0) return;
    const now = this.#now().getTime();
    for (const [shortId, entry] of [...this.#expected]) {
      if (now - entry.at >= WORKER_WAIT_MS) {
        this.#expected.delete(shortId);
        continue;
      }
      const rows = [...listed.values()].filter((session) => session.shortId === shortId);
      if (rows.length !== 1 || rows[0]!.sessionId === entry.lead) continue;
      this.#expected.delete(shortId);
      const worker = rows[0]!.sessionId;
      const lead = this.#newest(entry.lead);
      const tree = this.tree();
      if (worker === lead || tree.leads.has(worker) || tree.leadOf.has(worker)) continue;
      const at = this.#now().toISOString();
      // Not through link(): the lead may have been unmarked since, and its started worker makes it one again.
      this.#links.set(linkKey({ lead: entry.lead, worker }), { lead: entry.lead, worker, at, on: true, how: 'started' });
      this.#write(at);
      // Told after this decoration, which already has it.
      this.#version += 1;
      queueMicrotask(() => this.#tell());
    }
  }

  /** Reads the `derived-from` entry of each listed session not read yet this run, one at a time, in the background. Never throws. */
  #readNew(listed: ReadonlyMap<string, SessionSummary>): void {
    if (this.#reading) return;
    const now = this.#now().getTime();
    const todo = [...listed.values()].filter((session) => !this.#read.has(session.sessionId) && isId(session.sessionId));
    if (todo.length === 0) return;
    this.#reading = true;
    void (async () => {
      let found = false;
      try {
        for (const session of todo) {
          if (this.#read.size >= DERIVED_HELD_MAX) break;
          const tries = (this.#retry.get(session.sessionId) ?? 0) + 1;
          this.#read.set(session.sessionId, tries);
          let derived: DerivedFrom | undefined;
          try {
            derived = await this.#readDerived(session.sessionId, session.cwd);
          } catch {
            derived = undefined;
          }
          // A session that has only just started may have no transcript yet, or not the entry yet: read again at a later snapshot, a few times.
          const young = now - Date.parse(session.startedAt) < DERIVED_RETRY_MS;
          const none = derived === undefined || (derived.launchedBy === undefined && derived.clearedFrom === undefined);
          if (none && young && tries < DERIVED_TRIES_MAX) {
            this.#read.delete(session.sessionId);
            this.#retry.set(session.sessionId, tries);
          } else {
            this.#retry.delete(session.sessionId);
          }
          if (derived?.launchedBy !== undefined && isId(derived.launchedBy) && derived.launchedBy !== session.sessionId) {
            this.#launchedBy.set(session.sessionId, derived.launchedBy);
            found = true;
          }
          if (derived?.clearedFrom !== undefined && isId(derived.clearedFrom) && derived.clearedFrom !== session.sessionId) {
            this.#clearedFrom.set(session.sessionId, derived.clearedFrom);
            found = true;
          }
        }
      } catch {
        // Fails soft.
      } finally {
        this.#reading = false;
        if (found) this.#changed();
      }
    })();
  }

  /** Changes whenever decorate() could answer differently for the same snapshot. */
  version(): number {
    return this.#version;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#offLineage?.();
    this.#offLineage = undefined;
  }

  #changed(): void {
    this.#version += 1;
    this.#tell();
  }

  #tell(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * The file, after merging what another pitwall wrote, written whole by rename. Fails soft. The file's
   * times after `at`, the change's own, are read as `at`, so a time in the future can't beat it.
   */
  #write(at: string): void {
    if (this.#file === undefined || this.#home === undefined) return;
    const disk = readLeadsFile(this.#file, new Date(at));
    const merge = <T extends { at: string }>(mine: Map<string, T>, theirs: readonly T[], key: (entry: T) => string) => {
      for (const entry of theirs) {
        const held = mine.get(key(entry));
        if (held === undefined || Date.parse(entry.at) > Date.parse(held.at)) mine.set(key(entry), entry);
      }
      const kept = [...mine.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-LEADS_HELD_MAX);
      return new Map(kept.map((entry) => [key(entry), entry]));
    };
    this.#marks = merge(this.#marks, disk.marks, (mark) => mark.id);
    this.#links = merge(this.#links, disk.links, linkKey);
    const body = { v: 1, marks: [...this.#marks.values()], links: [...this.#links.values()] };
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
 * The marks and links in the file at `file` that check out; none when there's no file or it can't be
 * trusted: not a regular file of this user's, a link, writable by group or others, or over
 * LEADS_FILE_MAX_BYTES. Each entry is made again from the fields that check out, with a time after
 * `now` read as `now` (as W188's PR dismissals do), so a planted future time can't win every merge or
 * push every new entry out; the newest LEADS_HELD_MAX of each are kept.
 */
export function readLeadsFile(file: string, now: Date = new Date()): { marks: LeadMark[]; links: LeadLink[] } {
  const none = { marks: [], links: [] };
  let fd: number | undefined;
  let value: unknown;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > LEADS_FILE_MAX_BYTES) return none;
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
  if (!isRecord(value) || value.v !== 1) return none;
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const timeOf = (at: string) => (Date.parse(at) > nowMs ? nowIso : at);
  const marks: LeadMark[] = [];
  for (const entry of Array.isArray(value.marks) ? (value.marks as unknown[]) : []) {
    if (!isRecord(entry) || !isId(entry.id) || !isTime(entry.at) || typeof entry.on !== 'boolean') continue;
    marks.push({ id: entry.id, at: timeOf(entry.at), on: entry.on });
  }
  const links: LeadLink[] = [];
  for (const entry of Array.isArray(value.links) ? (value.links as unknown[]) : []) {
    if (!isRecord(entry) || !isId(entry.lead) || !isId(entry.worker) || entry.lead === entry.worker || !isTime(entry.at) || typeof entry.on !== 'boolean') continue;
    if (entry.how !== undefined && entry.how !== 'started' && entry.how !== 'reported') continue;
    links.push({ lead: entry.lead, worker: entry.worker, at: timeOf(entry.at), on: entry.on, ...(entry.on && entry.how !== undefined ? { how: entry.how as 'started' | 'reported' } : {}) });
  }
  const newest = <T extends { at: string }>(entries: T[]) => entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-LEADS_HELD_MAX);
  return { marks: newest(marks), links: newest(links) };
}

/** `source`'s snapshots with each lead's `lead` and each worker's `workerOf`. */
export function createLeadsView(source: Pick<SnapshotView, 'latest' | 'subscribe'>, store: LeadStore): SnapshotView {
  return createDecoratedView(source, { decorate: (snapshot) => store.decorate(snapshot), version: () => store.version(), subscribe: (listener) => store.subscribe(listener) });
}
