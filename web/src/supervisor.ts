// The supervisor in the web UI (M5, W114; docs/design-system.md, 4: Supervisor): what the page reads
// of the snapshot's SupervisorState, the words for each of its states, its view's place in the URL,
// and the requests its view makes, all through the app's ApiClient (api.ts), which sends the apiKey,
// never the token. The server is the authority on every check, and on what the supervisor does: the
// page never starts it by itself, only when you press Start or send it a message.
//
// - The view's place: `?supervisor`, with no value, beside the selection, as ?session= and ?pr= are
//   (openSession.ts, openPr.ts). The third column shows one thing, so opening the supervisor drops
//   ?session= and ?pr=, and opening either drops ?supervisor, each in one pushed history entry. With
//   more than one in a URL, as only one typed by hand can have, the session shows, then the PR.
// - The state is read defensively, as the 'prs' message is: an approval that isn't well formed is
//   left out, and a state that isn't one at all is no supervisor, so the page shows no item for it.
// - Approvals' text is the model's: shown as plain text, never markdown, and sent as you leave it.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SUPERVISOR_INTERRUPT_PATH,
  SUPERVISOR_MESSAGE_MAX,
  SUPERVISOR_MESSAGE_PATH,
  SUPERVISOR_START_PATH,
  supervisorApprovalPath,
  type ConversationEntry,
  type SessionSummary,
  type SupervisorApproval,
  type SupervisorDecision,
  type SupervisorHandoff,
  type SupervisorState,
  type SupervisorStatus,
} from '../../src/shared/protocol.js';
import type { ApiClient, ApiResult } from './api.js';
import { couldNot, plainText, shortenHome } from './format.js';
import { visibleString } from '../../src/shared/hiddenText.js';
import { PR_PARAM, SESSION_PARAM, SUPERVISOR_PARAM, withoutParams, type HistoryMode } from './openSession.js';
import { outgoingText } from './relay.js';
import { browserNavigation, type NavigationEnv } from './selection.js';
import { needsAttention, needsText, recapNeedsText, statusBadge, type BadgeLook, type StatusBadge } from './sessions.js';
import type { NotNeeded } from './notNeeded.js';
import { currentStep, turnStartIndex, turnStarted, type WorkingLineState } from './working.js';

export { SUPERVISOR_PARAM };

/**
 * A model id as people say it: `claude-opus-5-5` is "Opus 5.5". Anything else is shown as it is.
 */
export function modelName(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model);
  return match ? `${match[1]!.charAt(0).toUpperCase()}${match[1]!.slice(1)} ${match[2]}.${match[3]}` : model;
}

/**
 * Text in pitwall's words that may name a command in backticks, as W113's errors do, split into its
 * plain parts and its code parts, so the page shows the command in code style, never the backticks.
 */
export function codeParts(text: string): Array<{ code: boolean; text: string }> {
  return plainText(text)
    .split(/(`[^`\n]+`)/)
    .filter((part) => part !== '')
    .map((part) => (/^`[^`\n]+`$/.test(part) ? { code: true, text: part.slice(1, -1) } : { code: false, text: part }));
}

/** The supervisor's name, as the repo list's item and its view's heading say it. */
export const SUPERVISOR_NAME = 'Supervisor';

/** Its view's region id, which the repo list's item controls while it's open. */
export const SUPERVISOR_VIEW_ID = 'supervisor-view';

/** The key its message box's draft is kept under in the tab's sessionStorage (drafts.ts, D14): `pitwall.draft.v1:supervisor`. */
export const SUPERVISOR_DRAFT_ID = 'supervisor';

// --- Its place in the URL -------------------------------------------------------------------------

/** Whether a query string opens the supervisor's view: `?supervisor`, unless a session or a PR shows instead. */
export function parseSupervisor(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has(SUPERVISOR_PARAM) && !params.has(SESSION_PARAM) && !params.has(PR_PARAM);
}

/**
 * `search` with `?supervisor` added, in place of any ?session= or ?pr=, or removed, every other
 * parameter kept, in order, with it last.
 */
export function withSupervisor(search: string, open: boolean): string {
  const kept = withoutParams(search, open ? [SUPERVISOR_PARAM, SESSION_PARAM, PR_PARAM] : [SUPERVISOR_PARAM]);
  if (!open) return kept;
  return `${kept === '' ? '?' : `${kept}&`}${SUPERVISOR_PARAM}`;
}

export interface OpenSupervisor {
  /** Whether the URL opens the supervisor's view. */
  open: boolean;
  /** Opens it, in place of a session's or a PR's view: one pushed entry, or none when it's open already. */
  show: (mode?: HistoryMode) => void;
  /** Closes it, pushing an entry without ?supervisor. */
  close: () => void;
  /** Matches the URL again, after something else changed it, as opening a session does. */
  follow: () => void;
}

/** The supervisor's view, from the URL, as useOpenPr() has the open PR. Reading it starts nothing. */
export function useOpenSupervisor(navigation: NavigationEnv = browserNavigation): OpenSupervisor {
  const [open, setOpen] = useState(() => parseSupervisor(navigation.location.search));
  const current = useRef(open);
  current.current = open;

  const follow = useCallback(() => {
    const next = parseSupervisor(navigation.location.search);
    current.current = next;
    setOpen(next);
  }, [navigation]);

  useEffect(() => {
    navigation.addEventListener('popstate', follow);
    return () => navigation.removeEventListener('popstate', follow);
  }, [navigation, follow]);

  const write = useCallback(
    (next: boolean, mode: HistoryMode) => {
      const { pathname, search, hash } = navigation.location;
      const url = `${pathname}${withSupervisor(search, next)}${hash}`;
      if (mode === 'push') navigation.history.pushState(navigation.history.state, '', url);
      else navigation.history.replaceState(navigation.history.state, '', url);
    },
    [navigation],
  );

  const show = useCallback(
    (mode: HistoryMode = 'push') => {
      // Open already adds no entry, unless a session or a PR is in the URL too, which it takes the place of.
      if (!current.current || !parseSupervisor(navigation.location.search)) write(true, mode);
      current.current = true;
      setOpen(true);
    },
    [write, navigation],
  );

  const close = useCallback(() => {
    if (!current.current) return;
    write(false, 'push');
    current.current = false;
    setOpen(false);
  }, [write]);

  return { open, show, close, follow };
}

// --- Reading the snapshot's state -----------------------------------------------------------------

const STATUSES: readonly SupervisorStatus[] = ['off', 'starting', 'idle', 'working', 'held', 'failed'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isText = (value: unknown): value is string => typeof value === 'string';
/** An approval's id, as it goes into its path: something short, never empty. */
const isId = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= 200;

/** One approval, or undefined when it isn't one this page knows how to show. */
function asApproval(value: unknown): SupervisorApproval | undefined {
  if (!isRecord(value)) return undefined;
  const { id, kind, at, expiresAt } = value;
  if (!isId(id) || !isTime(at) || !isTime(expiresAt)) return undefined;
  if (kind === 'message') {
    const { to, text } = value;
    return isText(to) && to.trim() !== '' && isText(text) ? { id, kind, to, text, at, expiresAt } : undefined;
  }
  if (kind === 'spawn') {
    const { directory, name, prompt } = value;
    if (!isText(directory) || directory === '' || !isText(prompt)) return undefined;
    if (name !== undefined && !isText(name)) return undefined;
    return name === undefined || name.trim() === '' ? { id, kind, directory, prompt, at, expiresAt } : { id, kind, directory, name, prompt, at, expiresAt };
  }
  return undefined;
}

/** The most hand-offs the page reads: the server keeps SUPERVISOR_HANDOFFS_MAX. */
const HANDOFFS_READ_MAX = 50;

/** One hand-off (W124), or undefined when it isn't one this page knows how to show. */
function asHandoff(value: unknown): SupervisorHandoff | undefined {
  if (!isRecord(value)) return undefined;
  const { id, kind, name, at, sessionId, shortId } = value;
  if (!isId(id) || (kind !== 'message' && kind !== 'spawn') || !isText(name) || name.trim() === '' || !isTime(at)) return undefined;
  const handoff: SupervisorHandoff = { id, kind, name, at };
  if (isId(sessionId)) handoff.sessionId = sessionId;
  if (isId(shortId)) handoff.shortId = shortId;
  return handoff;
}

/**
 * The snapshot's `supervisor`, as the page reads it: undefined with `--no-supervisor`, or for
 * anything that isn't a state, as from a newer pitwall's; approvals that aren't well formed left out,
 * each id once, oldest first as the server sends them.
 */
export function asSupervisorState(value: unknown): SupervisorState | undefined {
  if (!isRecord(value)) return undefined;
  const { status, sessionId, error, approvals, lastTurnAt, costUsd, handoffs } = value;
  if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) return undefined;
  const seen = new Set<string>();
  const kept = (Array.isArray(approvals) ? approvals : []).flatMap((each) => {
    const approval = asApproval(each);
    if (!approval || seen.has(approval.id)) return [];
    seen.add(approval.id);
    return [approval];
  });
  const state: SupervisorState = { status: status as SupervisorStatus, approvals: kept };
  if (isText(sessionId) && sessionId !== '') state.sessionId = sessionId;
  if (isText(error) && error.trim() !== '') state.error = error;
  if (isTime(lastTurnAt)) state.lastTurnAt = lastTurnAt;
  if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0) state.costUsd = costUsd;
  const done = (Array.isArray(handoffs) ? handoffs.slice(-HANDOFFS_READ_MAX) : []).flatMap((each) => asHandoff(each) ?? []);
  if (done.length > 0) state.handoffs = done;
  return state;
}

// --- What it sent and started (W124) ---------------------------------------------------------------
// The supervisor never sees a session's reply (Phil, 2026-11-02): you carry on in the session, which
// the panel opens, as clicking it in the list does. Only sessions pitwall lists are opened: a hand-off
// is matched to one by the session id pitwall checked a message's recipient was, or by the short id
// `claude --bg` reported for a session it started, never by a name or a URL the model wrote.

/** One session the panel lists under "Sent and started": the newest hand-off to it, and the session once the index lists it. */
export interface HandoffRow {
  handoff: SupervisorHandoff;
  /** The session it went to, or started, as the snapshot lists it: undefined until the index has it. */
  session?: SessionSummary;
  /** "<name> needs you: <reason>", while pitwall's own Needs you says so. */
  needs?: string;
}

/** The listed session a hand-off went to: by its session id, or a started one by its short id. */
export function handoffSession(handoff: SupervisorHandoff, sessions: readonly SessionSummary[]): SessionSummary | undefined {
  if (handoff.sessionId !== undefined) {
    const found = sessions.find((session) => session.sessionId === handoff.sessionId);
    if (found !== undefined) return found;
  }
  if (handoff.shortId === undefined) return undefined;
  return sessions.find((session) => session.shortId === handoff.shortId);
}

/** Why a session needs you, as a short line: Claude Code's own line, the recap's, its question, or its badge. */
export function needsReason(session: SessionSummary, badge: StatusBadge = statusBadge(session)): string {
  const text = needsText(session) ?? recapNeedsText(session) ?? (session.needsYou?.reason === 'asked' ? session.askedYou?.excerpt : undefined);
  const line = text === undefined ? '' : plainText(text).replace(/\s+/g, ' ').trim();
  if (line !== '') return line.length > NEEDS_REASON_MAX ? `${line.slice(0, NEEDS_REASON_MAX - 1).trimEnd()}…` : line;
  return `${badge.label.charAt(0).toLowerCase()}${badge.label.slice(1)}`;
}

/** The longest reason a needs-you notice gives, in characters. */
export const NEEDS_REASON_MAX = 160;

/** The name a row shows: the session's own, once listed, else the one the hand-off has. */
export const handoffName = (row: HandoffRow) => visibleString(row.session?.name ?? row.handoff.name);

/**
 * The rows: one per session, its newest hand-off, those that need you first, then newest first. A
 * session started and then messaged is one row, "Started", since that's where it came from.
 */
export function handoffRows(handoffs: readonly SupervisorHandoff[] | undefined, sessions: readonly SessionSummary[], notNeeded?: NotNeeded): HandoffRow[] {
  const byKey = new Map<string, { row: HandoffRow; order: number; started: boolean }>();
  (handoffs ?? []).forEach((handoff, order) => {
    const session = handoffSession(handoff, sessions);
    const key = session !== undefined ? `s:${session.sessionId}` : handoff.shortId !== undefined ? `b:${handoff.shortId}` : `h:${handoff.id}`;
    const before = byKey.get(key);
    const started = (before?.started ?? false) || handoff.kind === 'spawn';
    const kept = started && handoff.kind === 'message' && before !== undefined ? before.row.handoff : handoff;
    const row: HandoffRow = { handoff: kept };
    if (session !== undefined) {
      row.session = session;
      if (needsAttention(session, notNeeded)) row.needs = `${visibleString(session.name)} needs you: ${needsReason(session)}`;
    }
    byKey.set(key, { row, order, started });
  });
  return [...byKey.values()]
    .sort((a, b) => Number(b.row.needs !== undefined) - Number(a.row.needs !== undefined) || b.order - a.order)
    .map((each) => each.row);
}

/** What a row says it did. */
export const handoffVerb = (handoff: SupervisorHandoff) => (handoff.kind === 'spawn' ? 'Started' : 'Message sent to');

/** How many approvals wait on you: each counts in Needs you's total and the page title (SupervisorState.approvals). */
export function approvalsWaiting(state: SupervisorState | undefined): number {
  return state?.approvals.length ?? 0;
}

// --- Words ------------------------------------------------------------------------------------------

/** Its status, as its badge says it. */
export const STATUS_LABELS: Readonly<Record<SupervisorStatus, string>> = {
  off: 'Off',
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  held: 'Held',
  failed: 'Failed',
};

/**
 * Its status badge's look (4: Badges), as a session's for the same words: Working subtle info with
 * its dot, and Starting with the spinner; Idle subtle neutral; Failed subtle danger; Off outline, as
 * Not running. Held is subtle warning: it waits on something you do outside pitwall, but never solid,
 * which is for Needs you alone.
 */
export const STATUS_LOOKS: Readonly<Record<SupervisorStatus, { look: BadgeLook; lead?: 'dot' | 'spinner' }>> = {
  off: { look: 'outline' },
  starting: { look: 'subtle-info', lead: 'spinner' },
  idle: { look: 'subtle-neutral' },
  working: { look: 'subtle-info', lead: 'dot' },
  held: { look: 'subtle-warning' },
  failed: { look: 'subtle-danger' },
};

/** What each status says under the header, in a sentence: what it means for you. */
export const STATUS_NOTES: Readonly<Record<SupervisorStatus, string>> = {
  off: "It isn't running. Start it, or send it a message, which starts it.",
  starting: 'pitwall is starting it.',
  idle: 'It waits for your next message.',
  working: "It's working on a turn. A message you send now waits until the turn ends.",
  held: "Another session has its conversation, so pitwall can't run it.",
  failed: "It stopped, or couldn't start.",
};

/** The repo list's item's status, visually hidden after its name: nothing for idle and off, which show nothing. */
export function itemStatusText(status: SupervisorStatus): string | undefined {
  return status === 'working' || status === 'starting' || status === 'held' || status === 'failed' ? STATUS_LABELS[status].toLowerCase() : undefined;
}

/**
 * What this run's turns have cost, at API list prices, as `claude -p` reports them: "$0.04 this run",
 * "Under $0.01 this run" for less than a cent, or undefined before a turn has reported any.
 */
export function costText(costUsd: number | undefined): string | undefined {
  if (costUsd === undefined) return undefined;
  if (costUsd < 0.005) return 'Under $0.01 this run';
  return `$${costUsd.toFixed(2)} this run`;
}

/** The cost's tooltip: what it counts, and that it's on your plan's usage, not a bill. */
export const COST_HINT =
  "What this run's turns would cost at API list prices, as Claude Code reports them. On a Claude subscription it counts against your plan's usage limits instead.";

/** A `claude stop` command, as a held supervisor's error names it (heldError() in src/supervisor/supervisor.ts): a short id of letters, digits, `_` and `-`. */
const STOP_COMMAND = /claude stop ([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?![A-Za-z0-9_-])/;

/**
 * The `claude stop` command a held supervisor's error names, for its copy button, or undefined when
 * it names none, as for an interactive session or another pitwall's supervisor. pitwall never runs it: the session it stops is yours (D2).
 */
export function heldCommand(error: string | undefined): string | undefined {
  const match = error === undefined ? null : STOP_COMMAND.exec(plainText(error));
  return match ? `claude stop ${match[1]}` : undefined;
}

/** A spawn approval's directory as the card shows it: home as ~. */
export const approvalDirectory = (approval: Extract<SupervisorApproval, { kind: 'spawn' }>) => shortenHome(visibleString(approval.directory));

/** What an approval would send or start, as its card's heading says it, in plain text. */
export function approvalTitle(approval: SupervisorApproval): string {
  // As they are, with anything that wouldn't show as its code (W120): never a filter that removes text.
  if (approval.kind === 'message') return `Message to ${visibleString(approval.to)}`;
  const named = approval.name === undefined ? '' : `, named ${visibleString(approval.name)}`;
  return `New session in ${approvalDirectory(approval)}${named}`;
}

/** The text an approval would send: a message's, or a new session's first prompt. */
export const approvalText = (approval: SupervisorApproval) => (approval.kind === 'message' ? approval.text : approval.prompt);

// --- The working line ------------------------------------------------------------------------------

/** The step while it starts, before a turn is running: the working line's second line. */
export const STARTING_STEP = 'Starting the supervisor';

/**
 * The working line at the end of its conversation (W102's line, 4: Conversation): while it works, the
 * time since the turn began and its step, from the entries shown, as a session's; while it starts, the
 * step alone, with no time; otherwise none. From the snapshot's status, which pitwall has from the
 * process it runs, so the transcript's own mark of a turn's end isn't needed to hide it. The supervisor
 * never waits on you in the conversation: what waits on you are its approvals, which have cards.
 */
export function supervisorWorkingLine(status: SupervisorStatus | undefined, entries: readonly ConversationEntry[], more: boolean): WorkingLineState {
  if (status === 'starting') return { mode: 'working', step: STARTING_STEP };
  if (status !== 'working') return { mode: 'idle' };
  const start = turnStartIndex(entries);
  const { since, atLeast } = turnStarted(entries, more);
  // Its directory is pitwall's own, and it has no file tools, so no path in a step is under it.
  const line: WorkingLineState = { mode: 'working', step: currentStep(entries, start, '') };
  if (since !== undefined) line.since = since;
  if (atLeast) line.atLeast = true;
  return line;
}

// --- Requests ----------------------------------------------------------------------------------------

/** pitwall's last sentence when it can't say whether a message reached the supervisor (5: Errors). */
export const CHECK_ITS_CONVERSATION = 'Check its conversation before sending again.';

export type SupervisorSend =
  /** pitwall took the message: it's in the supervisor's queue, or its turn has started. */
  | { kind: 'sent' }
  /** The connection was refused (WebSocket 4401). The app is already showing that the token was rejected. */
  | { kind: 'unauthorized' }
  /** Not taken, or may not have been: `uncertain` when it may have gone, as with no answer or a server error. */
  | { kind: 'failed'; error: string; uncertain: boolean };

/** The reason in an error body, `{ error: "…" }`, as text, at most 500 characters. */
function reasonOf(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const { error } = body;
  return isText(error) && error.trim() !== '' ? plainText(error.trim()).slice(0, 500) : undefined;
}

/** Whether an answer is the contract's success: a 2xx with `{ ok: true }`. */
const isOk = (result: ApiResult) => result.kind === 'ok' && isRecord(result.body) && result.body.ok === true;

/**
 * What a send's answer means (5: Errors, D13): taken; refused before anything was sent, with the
 * server's reason, as a 409 while it's held or with `--no-supervisor`, or a 413 over the limit; or,
 * with no answer, a server error or a success pitwall can't read, may have gone, so the page asks you
 * to check before sending it again, rather than inviting a resend that would start another turn.
 */
export function sendOutcome(result: ApiResult): SupervisorSend {
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (isOk(result)) return { kind: 'sent' };
  const status = result.status;
  // pitwall's own refusal, with its reason, whatever the status: 409 while it's held or off, 413 over
  // the limit, 429 with messages already waiting, and the 502 and 503 it gives when the supervisor
  // couldn't start or pitwall is closing, before anything was written (src/server/supervisorRoutes.ts).
  const own = result.kind === 'failed' && status !== undefined && (status < 200 || status >= 300) ? reasonOf(result.body) : undefined;
  if (own !== undefined) return { kind: 'failed', uncertain: false, error: `Not sent: ${own}` };
  if (status === undefined) return { kind: 'failed', uncertain: true, error: `pitwall didn't answer, so it may have reached the supervisor. ${CHECK_ITS_CONVERSATION}` };
  if (status >= 500 || (status >= 200 && status < 300)) {
    const what = status >= 500 ? `with an error (HTTP ${status})` : `without saying what happened (HTTP ${status})`;
    return { kind: 'failed', uncertain: true, error: `pitwall answered ${what}, so it may have reached the supervisor. ${CHECK_ITS_CONVERSATION}` };
  }
  return { kind: 'failed', uncertain: false, error: `Not sent: pitwall refused the request (HTTP ${status}).` };
}

/** Sends `text` to the supervisor, as you, with POST SUPERVISOR_MESSAGE_PATH, as outgoingText() makes it. Never rejects. */
export async function sendToSupervisor(api: ApiClient, text: string, signal?: AbortSignal): Promise<SupervisorSend> {
  return sendOutcome(await api.post(SUPERVISOR_MESSAGE_PATH, { text: outgoingText(text) }, signal ? { signal } : {}));
}

/** Whether an action pitwall was asked for went: done, or why not, in pitwall's words with the server's reason. */
export type SupervisorAction = { kind: 'done' } | { kind: 'unauthorized' } | { kind: 'failed'; status?: number; error: string };

/** An action's answer as `what` failed: "Couldn't start the supervisor (HTTP 502).", or with the server's reason after it. */
function actionOutcome(result: ApiResult, what: string): SupervisorAction {
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (isOk(result)) return { kind: 'done' };
  const reason = result.kind === 'failed' ? reasonOf(result.body) : undefined;
  const status = result.status !== undefined && (result.status < 200 || result.status >= 300) ? result.status : undefined;
  const sentence = couldNot(what, reason === undefined ? status : undefined);
  const error = reason === undefined ? sentence : `${sentence} ${reason}`;
  return status === undefined ? { kind: 'failed', error } : { kind: 'failed', status, error };
}

/** Starts or resumes the supervisor, with no message: POST SUPERVISOR_START_PATH. Never rejects. */
export async function startSupervisor(api: ApiClient, signal?: AbortSignal): Promise<SupervisorAction> {
  return actionOutcome(await api.post(SUPERVISOR_START_PATH, {}, signal ? { signal } : {}), 'start the supervisor');
}

/**
 * Stops its running turn: POST SUPERVISOR_INTERRUPT_PATH. A 409 is done too: no turn is running,
 * since it ended as you pressed Stop (src/server/supervisorRoutes.ts). Never rejects.
 */
export async function interruptSupervisor(api: ApiClient, signal?: AbortSignal): Promise<SupervisorAction> {
  const result = await api.post(SUPERVISOR_INTERRUPT_PATH, {}, signal ? { signal } : {});
  if (result.kind === 'failed' && result.status === 409) return { kind: 'done' };
  return actionOutcome(result, 'stop its turn');
}

/** What each decision is, in the sentence a failure says. */
const DECISION_VERBS: Readonly<Record<SupervisorDecision['decision'], string>> = { send: 'send it', edit: 'send your edit', decline: 'decline it' };

export type DecisionOutcome =
  /** pitwall took the decision: the card goes once the snapshot drops it. */
  | { kind: 'decided' }
  | { kind: 'unauthorized' }
  /** It's no longer waiting: answered elsewhere, as in another tab, withdrawn, or past its time (404). */
  | { kind: 'gone' }
  | { kind: 'failed'; error: string };

/** The 404's words: the card goes with the next snapshot. */
export const APPROVAL_GONE = "It's no longer waiting: it was answered in another tab, withdrawn, or ran out of time.";

/**
 * Answers one approval: POST a SupervisorDecision to supervisorApprovalPath(). A failure says what
 * pitwall knows. With no answer or a server error, whether it went is the snapshot's to say: the card
 * stays until it drops it, and a decision sent again for an approval that's gone gets the 404. Never rejects.
 */
export async function decideApproval(api: ApiClient, id: string, decision: SupervisorDecision, signal?: AbortSignal): Promise<DecisionOutcome> {
  const result = await api.post(supervisorApprovalPath(id), decision, signal ? { signal } : {});
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (isOk(result)) return { kind: 'decided' };
  if (result.status === 404) return { kind: 'gone' };
  const verb = DECISION_VERBS[decision.decision];
  if (result.status === undefined) return { kind: 'failed', error: `pitwall didn't answer, so it may not have been told. If this card is still here, try again.` };
  if (result.status >= 500 || (result.status >= 200 && result.status < 300)) {
    return { kind: 'failed', error: `${couldNot(verb, result.status)} If this card is still here, try again.` };
  }
  const reason = result.kind === 'failed' ? reasonOf(result.body) : undefined;
  return { kind: 'failed', error: reason === undefined ? couldNot(verb, result.status) : `${couldNot(verb, undefined)} ${reason}` };
}

/** The longest message, and the longest edit, again here so the box and the editor can say so before sending. */
export const SUPERVISOR_TEXT_MAX = SUPERVISOR_MESSAGE_MAX;
