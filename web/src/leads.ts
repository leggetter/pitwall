// Leads and workers in the session list (W218, spike 021's "The list: workers indented under their
// lead"; docs/design-system.md, 4: Leads and workers). A lead is one of your sessions that hands work to
// other sessions, its workers; the snapshot says which (SessionSummary.lead and .workerOf, ids only).
//
// arrangeLeads() takes a selection's rows, as listWork() and the filters leave them, and arranges them:
//
// - In a repo group's list, each lead's row carries its workers, oldest link first, shown indented under
//   it. A worker listed in another group joins them, with that group's label on its row; one the filters
//   hide doesn't. A worker in this group whose lead is listed elsewhere becomes a one-line pointer,
//   "↳ under <lead> (<repo>)", so a search by repo still finds it. One whose lead is in this group but
//   hidden by the filters stays a row of its own, with "under <lead>" on line 2.
// - In All sessions and Starred, each lead's row carries the workers that list has; there are no
//   pointers. A worker whose lead isn't shown stays a row of its own, with "under <lead>" on line 2.
// - In Needs you, the list stays flat: a worker's card says "under <lead>". Pull requests is untouched.
//
// A finished worker stays under its lead. A finished lead with a worker that is current, one that isn't
// finished or that owns an open pull request (work.ts' isDone()), is listed with the current rows, so a
// worker that needs you is never folded into the collapsed Finished section.
//
// Which leads' workers are closed is the viewer's, in localStorage pitwall.leads.v1: open by default, so
// only closed leads' ids are kept, `{"v":1,"closed":["<session id>", …]}`, at most LEADS_CAP of them,
// the oldest dropped first. Every read and write is in try/catch; without storage every lead is open.

import { leadBriefPath, leadPath, workerBriefPath, workerPath, workerStartedPath, type LeadBriefResult, type LeadResult, type SessionGroup, type SessionSummary } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { groupLabel, needsAttention, isBusy, type Listed } from './sessions.js';
import { isPrRow, type ListRow } from './work.js';
import type { StorageSource } from './groupState.js';

/** A worker's row under its lead. */
export interface WorkerListed extends Listed {
  /** Its own group's label, when that isn't the repo group shown: named on its row. */
  repo?: string;
}

/** A session row as arranged: a lead's carries its workers; a worker's says where its lead is. */
export interface ArrangedListed extends Listed {
  /** This row is a lead's: its workers as shown, oldest link first. */
  workers?: WorkerListed[];
  /** How many workers the lead has in pitwall's list, whatever the filters show. */
  workerTotal?: number;
  /** A one-line pointer in a repo group, in this worker's place: its lead is listed under another group. */
  pointer?: { leadId: string; leadName: string; leadRepo: string };
  /** A worker whose lead isn't shown with it: its lead's name, for line 2's "under <lead>". */
  under?: { leadId: string; leadName: string };
}

export type ArrangedRow = ArrangedListed | Exclude<ListRow, Listed>;

/** Which list it is: a repo group's (with the group shown), All sessions, Starred, Needs you or Pull requests. */
export type LeadScope = { kind: 'group'; group: Pick<SessionGroup, 'root' | 'key' | 'label'> } | { kind: 'all' } | { kind: 'starred' } | { kind: 'needs-you' } | { kind: 'prs' };

export interface ArrangeOptions {
  /** Every listed session, each once, with its home group (sessions.ts' listedOnce()): for leads' names and workers in other groups. */
  every: ReadonlyMap<string, Listed>;
  /** Whether a session from another group passes the list's filters. Everything does without it. */
  matches?: (listed: Listed) => boolean;
  /**
   * Whether a session from another group belongs with the current rows, as the list's own rows are
   * sorted: not finished, or one that owns an open pull request (work.ts' isDone()). Without it, any that
   * isn't finished.
   */
  isCurrent?: (listed: Listed) => boolean;
}

const sameGroup = (a: Pick<SessionGroup, 'root' | 'key'>, b: Pick<SessionGroup, 'root' | 'key'>) => a.root === b.root && a.key === b.key;

/** The rows, arranged for leads and workers as the file's comment says. Rows are new objects; the snapshot's aren't changed. */
export function arrangeLeads(
  rows: { current: readonly ListRow[]; finished: readonly Listed[] },
  scope: LeadScope,
  { every, matches = () => true, isCurrent = (listed) => !listed.session.finished }: ArrangeOptions,
): { current: ArrangedRow[]; finished: ArrangedListed[] } {
  if (scope.kind === 'prs') return { current: [...rows.current], finished: [...rows.finished] };
  const nameOf = (id: string) => every.get(id)?.session.name;
  if (scope.kind === 'needs-you') {
    return { current: rows.current.map((row) => (isPrRow(row) ? row : withUnder(row, nameOf))), finished: rows.finished.map((row) => withUnder(row, nameOf)) };
  }
  const inList = new Map<string, Listed>();
  for (const row of [...rows.current, ...rows.finished]) if (!isPrRow(row)) inList.set(row.session.sessionId, row);
  const group = scope.kind === 'group' ? scope.group : undefined;

  // Each lead's workers, as this list shows them.
  const workersOf = new Map<string, WorkerListed[]>();
  const nested = new Set<string>();
  for (const listed of inList.values()) {
    const lead = listed.session.lead;
    if (lead === undefined) continue;
    const workers: WorkerListed[] = [];
    for (const id of lead.workers) {
      const here = inList.get(id);
      if (here !== undefined) {
        if (here.session.workerOf?.lead !== listed.session.sessionId) continue;
        workers.push(here);
        nested.add(id);
        continue;
      }
      // In a repo group, a worker listed under another group joins its lead here, named by its group.
      const elsewhere = group === undefined ? undefined : every.get(id);
      // One in this group that the list doesn't have, as one the filters hide, stays out.
      if (group === undefined || elsewhere === undefined || sameGroup(elsewhere.group, group)) continue;
      if (elsewhere.session.workerOf?.lead !== listed.session.sessionId || !matches(elsewhere)) continue;
      workers.push({ ...elsewhere, repo: groupLabel(elsewhere.group) });
    }
    workersOf.set(listed.session.sessionId, workers);
  }

  const arrange = (row: Listed): ArrangedListed | undefined => {
    const { session } = row;
    if (nested.has(session.sessionId)) return undefined;
    const workers = workersOf.get(session.sessionId);
    if (workers !== undefined) return { ...row, workers, workerTotal: session.lead?.workers.length ?? workers.length };
    const leadId = session.workerOf?.lead;
    if (leadId === undefined) return row;
    const lead = every.get(leadId);
    if (lead === undefined) return row;
    // A pointer only when its lead is under another group: one in this group that the filters hide
    // would point at a row that isn't there (W218 review, F5).
    if (group !== undefined && !sameGroup(lead.group, group)) return { ...row, pointer: { leadId, leadName: lead.session.name, leadRepo: groupLabel(lead.group) } };
    return { ...row, under: { leadId, leadName: lead.session.name } };
  };

  const current: ArrangedRow[] = [];
  for (const row of rows.current) {
    if (isPrRow(row)) current.push(row);
    else {
      const arranged = arrange(row);
      if (arranged !== undefined) current.push(arranged);
    }
  }
  const currentIds = new Set<string>();
  for (const row of rows.current) if (!isPrRow(row)) currentIds.add(row.session.sessionId);
  const finished: ArrangedListed[] = [];
  for (const row of rows.finished) {
    const arranged = arrange(row);
    if (arranged === undefined) continue;
    // A finished lead stays with the current rows, after the last of them, when a worker of its came from
    // them, such as a finished one that owns an open pull request (W218 review, F4), or when a worker
    // from another group is current there, by the same rule (the fix check's N1).
    const keep = arranged.workers?.some((worker) => currentIds.has(worker.session.sessionId) || (!inList.has(worker.session.sessionId) && isCurrent(worker))) === true;
    if (keep) current.push(arranged);
    else finished.push(arranged);
  }
  return { current, finished };
}

function withUnder(row: Listed, nameOf: (id: string) => string | undefined): ArrangedListed {
  const leadId = row.session.workerOf?.lead;
  const leadName = leadId === undefined ? undefined : nameOf(leadId);
  return leadId === undefined || leadName === undefined ? row : { ...row, under: { leadId, leadName } };
}

/** "3 workers", "1 worker", or "No workers" for a lead you marked that has none yet. */
export function workerCount(count: number): string {
  return count === 0 ? 'No workers' : `${count} ${count === 1 ? 'worker' : 'workers'}`;
}

/**
 * A lead's line 2 while its workers are closed: the count, then the most urgent state among them, so
 * nothing that needs you is hidden: "3 workers, 1 needs you", "3 workers, 2 working", or the count alone.
 */
export function closedWorkersText(total: number, workers: readonly Pick<Listed, 'session'>[]): string {
  const count = workerCount(total);
  const need = workers.filter(({ session }) => needsAttention(session)).length;
  if (need > 0) return `${count}, ${need} ${need === 1 ? 'needs' : 'need'} you`;
  const working = workers.filter(({ session }) => !session.finished && isBusy(session)).length;
  return working > 0 ? `${count}, ${working} working` : count;
}

/** The pointer's words after the worker's name. */
export const pointerText = (leadName: string, leadRepo: string) => `under ${leadName} (${leadRepo})`;

/** A worker's line 2, and its card in Needs you. */
export const underText = (leadName: string) => `under ${leadName}`;

/** The worker's view header: "worker for <lead>". */
export const WORKER_FOR = 'worker for';

// The menu's items and what they say once done.
export const MAKE_LEAD = 'Make lead';
export const NOT_A_LEAD = 'Not a lead';
export const START_WORKER = 'Start a worker…';
export const REPORT_TO = 'Report to…';
export const NOT_A_WORKER = 'Not a worker';
/** New session's subtitle from Start a worker…. */
export const startWorkerSubtitle = (leadName: string) => `For: ${leadName}`;

/**
 * Which sessions you can pick in Report to…: every listed lead but the session itself, by name, and only a
 * lead by your marks, links, launches and the lineage pitwall saw (`lead.trusted`, the review's F2), never
 * one only by its own transcript's word: the server refuses that one until you choose Make lead on it.
 */
export function leadChoices(every: Iterable<Listed>, sessionId: string): Listed[] {
  return [...every].filter(({ session }) => session.lead?.trusted === true && session.sessionId !== sessionId).sort((a, b) => a.session.name.localeCompare(b.session.name));
}

/** The menu items a session's view offers for leads and workers (W218). */
export type LeadAction = 'make-lead' | 'not-lead' | 'start-worker' | 'report-to' | 'not-worker';

/**
 * Which of them `session` offers: a lead can start a worker or stop being a lead; a worker can report
 * to another lead or stop being a worker; any other session can be made a lead or report to one, a
 * finished one included. A lead only by its own transcript's word (no `lead.trusted`) offers Make lead
 * too, which is how it becomes one pitwall names (the review's F2). `leadsToPick` is whether Report to…
 * has a lead to list.
 */
export function leadActions(session: Pick<SessionSummary, 'lead' | 'workerOf'>, leadsToPick: boolean): LeadAction[] {
  if (session.lead !== undefined) return session.lead.trusted === true ? ['start-worker', 'not-lead'] : ['make-lead', 'start-worker', 'not-lead'];
  if (session.workerOf !== undefined) return [...(leadsToPick ? (['report-to'] as const) : []), 'not-worker'];
  return ['make-lead', ...(leadsToPick ? (['report-to'] as const) : [])];
}

// Which leads' workers are closed (pitwall.leads.v1).

export const LEADS_STORAGE_KEY = 'pitwall.leads.v1';
/** At most this many closed leads are remembered; closing one more drops the oldest. */
export const LEADS_CAP = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The closed leads' ids, oldest first; none when storage is missing, throws, or holds anything else. */
export function readClosedLeads(storage: StorageSource): string[] {
  try {
    const raw = storage()?.getItem(LEADS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== 1) return [];
    const closed = (parsed as { closed?: unknown }).closed;
    if (!Array.isArray(closed)) return [];
    return [...new Set(closed.filter((id): id is string => typeof id === 'string' && UUID.test(id)))].slice(-LEADS_CAP);
  } catch {
    return [];
  }
}

/** Stores the closed leads' ids, the newest LEADS_CAP. A failure to write is ignored: the page keeps its state for the visit. */
export function writeClosedLeads(storage: StorageSource, closed: readonly string[]): void {
  try {
    storage()?.setItem(LEADS_STORAGE_KEY, JSON.stringify({ v: 1, closed: closed.slice(-LEADS_CAP) }));
  } catch {
    // Private window, blocked site data or a full quota.
  }
}

/** `closed` with `leadId` opened or closed: a closed one goes last, as the newest. */
export function toggleClosed(closed: readonly string[], leadId: string, open: boolean): string[] {
  const without = closed.filter((id) => id !== leadId);
  return open ? without : [...without, leadId].slice(-LEADS_CAP);
}

// The requests (src/server/leadRoutes.ts). Each answers a LeadResult; a 409's `error` is written to show as it is.

/** What a failed request shows when the server gave no `error` of its own. */
export const LEAD_FAILED = 'pitwall couldn’t change that. Try again.';

/**
 * POSTs one of W218's requests: undefined once done, or the text to show, the server's `error` when it
 * gave one. Never throws.
 */
export async function postLead(api: Pick<ApiClient, 'post'>, path: string, body: Record<string, unknown>): Promise<string | undefined> {
  try {
    const result = await api.post(path, body);
    if (result.kind === 'unauthorized') return "pitwall didn't accept the page's key. Reload the page.";
    const answer = result.body as Partial<LeadResult> | undefined;
    if (result.kind === 'ok' && answer?.ok === true) return undefined;
    if (typeof answer === 'object' && answer !== null && answer.ok === false && typeof answer.error === 'string') return answer.error;
    return LEAD_FAILED;
  } catch {
    return LEAD_FAILED;
  }
}

export const makeLead = (api: Pick<ApiClient, 'post'>, sessionId: string, on: boolean) => postLead(api, leadPath(sessionId), { on });
export const reportTo = (api: Pick<ApiClient, 'post'>, sessionId: string, lead: string | null) => postLead(api, workerPath(sessionId), { lead });
export const workerStarted = (api: Pick<ApiClient, 'post'>, leadId: string, shortId: string) => postLead(api, workerStartedPath(leadId), { shortId });

/** The toast once one is done. */
export function leadDoneText(action: Exclude<LeadAction, 'start-worker' | 'report-to'>, name: string): string {
  if (action === 'make-lead') return `${name} is a lead.`;
  if (action === 'not-lead') return `${name} isn’t a lead. Its workers are no longer linked to it.`;
  return `${name} isn’t a worker.`;
}
export const reportedText = (name: string, leadName: string) => `${name} is a worker for ${leadName}.`;

// The paragraph a worker is given about its lead (W218 piece 2, src/server/leadBrief.ts): shown before New
// session's Start from Start a worker…, and offered after Report to…. The server writes it and, for Start a
// worker…, adds its own copy to the first prompt; the page only shows it, or sends what the server gave.

/** What a paragraph request answers: the paragraph, or why there's none, to show as it is. */
export type BriefOutcome = { kind: 'ok'; leadName: string; text: string } | { kind: 'refused'; error: string };

/** What a failed paragraph request shows when the server gave no `error` of its own. */
export const BRIEF_FAILED = 'pitwall couldn’t get the paragraph about its lead.';

/** GETs a paragraph. Never throws. */
export async function getBrief(api: Pick<ApiClient, 'get'>, path: string, signal?: AbortSignal): Promise<BriefOutcome> {
  try {
    const result = await api.get(path, signal ? { signal } : {});
    if (result.kind === 'unauthorized') return { kind: 'refused', error: "pitwall didn't accept the page's key. Reload the page." };
    const answer = result.body as Partial<LeadBriefResult> | undefined;
    if (typeof answer !== 'object' || answer === null) return { kind: 'refused', error: BRIEF_FAILED };
    if (result.kind === 'ok' && answer.ok === true && typeof answer.text === 'string' && typeof answer.leadName === 'string') return { kind: 'ok', leadName: answer.leadName, text: answer.text };
    if (answer.ok === false && typeof answer.error === 'string') return { kind: 'refused', error: answer.error };
    return { kind: 'refused', error: BRIEF_FAILED };
  } catch {
    return { kind: 'refused', error: BRIEF_FAILED };
  }
}

export const leadBriefOf = (api: Pick<ApiClient, 'get'>, leadId: string, signal?: AbortSignal) => getBrief(api, leadBriefPath(leadId), signal);
export const workerBriefOf = (api: Pick<ApiClient, 'get'>, workerId: string, signal?: AbortSignal) => getBrief(api, workerBriefPath(workerId), signal);

/** New session's label over the paragraph from Start a worker…. */
export const BRIEF_LABEL = 'Added after your prompt';
/** What New session says when there's no paragraph, after the server's reason. */
export const BRIEF_WITHOUT = 'The worker starts without it.';

/** A worker's row (W218 piece 2): "reported", before the time of its newest report to its lead. */
export const REPORTED = 'reported';
/** The row's link's name: what it opens. */
export const reportedLinkLabel = (time: string) => `reported ${time}: open its conversation`;
