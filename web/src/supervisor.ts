// The supervisor in the web UI (M5, W114; docs/design-system.md, 4: Supervisor): what the page reads
// of the snapshot's SupervisorState, the words for each of its states, its view's place in the URL,
// and the requests its view makes, all through the app's ApiClient (api.ts), which sends the apiKey,
// never the token. The server is the authority on every check, and on what the supervisor does: the
// page never starts it by itself, only when you press Start or send it a message.
//
// - The panel's place: `?supervisor`, with no value, last, after the selection and any ?session= or
//   ?pr= (openSession.ts, openPr.ts). It opens over the page, beside the open session's or PR's view,
//   which stays (W177): opening it keeps ?session= and ?pr=, and opening either keeps ?supervisor,
//   each in one pushed history entry.
// - The state is read defensively, as the 'prs' message is: an approval that isn't well formed is
//   left out, and a state that isn't one at all is no supervisor, so the page shows no item for it.
// - Approvals' text is the model's: shown as plain text, never markdown, and sent as you leave it.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONTEXT_HIGH_TOKENS,
  CONTEXT_WARN_TOKENS,
  isEffortLevel,
  isSkillName,
  isWorkModel,
  PERMISSION_MODES,
  SUPERVISOR_INTERRUPT_PATH,
  SUPERVISOR_MESSAGE_MAX,
  SUPERVISOR_PROPOSAL_MAX,
  SUPERVISOR_MESSAGE_PATH,
  SUPERVISOR_NEW_CONVERSATION_PATH,
  SUPERVISOR_START_PATH,
  supervisorApprovalPath,
  WORK_DEFAULT,
  WORK_PROFILE_NAME_PATTERN,
  WORK_PROFILES_TOTAL_MAX,
  type ApprovalProfile,
  type ConversationEntry,
  type SavedPermission,
  type SessionLaunch,
  type SessionSummary,
  type SupervisorApproval,
  type SupervisorDecision,
  type SupervisorHandoff,
  type SupervisorState,
  type SupervisorStatus,
} from '../../src/shared/protocol.js';
import type { ApiClient, ApiResult } from './api.js';
import { formatTokens } from './context.js';
import { couldNot, plainText, shortenHome } from './format.js';
import { visibleString } from '../../src/shared/hiddenText.js';
import { SUPERVISOR_PARAM, withoutParams, type HistoryMode } from './openSession.js';
import { outgoingText } from './relay.js';
import { browserNavigation, type NavigationEnv } from './selection.js';
import { needsAttention, needsText, recapNeedsText, statusBadge, type BadgeLook, type StatusBadge } from './sessions.js';
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

/** Whether a query string opens the supervisor's panel: `?supervisor`, whatever else is open beside it (W177). */
export function parseSupervisor(search: string): boolean {
  return new URLSearchParams(search).has(SUPERVISOR_PARAM);
}

/**
 * `search` with `?supervisor` added, beside any ?session= or ?pr=, which stay (W177), or removed,
 * every other parameter kept, in order, with it last.
 */
export function withSupervisor(search: string, open: boolean): string {
  const kept = withoutParams(search, [SUPERVISOR_PARAM]);
  if (!open) return kept;
  return `${kept === '' ? '?' : `${kept}&`}${SUPERVISOR_PARAM}`;
}

export interface OpenSupervisor {
  /** Whether the URL opens the supervisor's panel. */
  open: boolean;
  /** Opens it, beside a session's or a PR's view: one pushed entry, or none when it's open already. */
  show: (mode?: HistoryMode) => void;
  /** Closes it, pushing an entry without ?supervisor. */
  close: () => void;
  /** Matches the URL again, after something else changed it, as opening a session does. */
  follow: () => void;
}

/** The supervisor's panel, from the URL, as useOpenPr() has the open PR. Reading it starts nothing. */
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
      // Open already adds no entry.
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
    // W156: a card offers its profiles whole, or isn't shown, and a new session's always names one of them.
    const profiles = asCardProfiles(value);
    if (profiles === false || (profiles.profiles !== undefined && profiles.profile === undefined)) return undefined;
    const approval: SupervisorApproval = name === undefined || name.trim() === '' ? { id, kind, directory, prompt, at, expiresAt } : { id, kind, directory, name, prompt, at, expiresAt };
    return { ...approval, ...profiles };
  }
  if (kind === 'resume') {
    const { sessionId, name, directory, text } = value;
    if (!isId(sessionId) || !isText(name) || name.trim() === '' || !isText(directory) || directory === '' || !isText(text)) return undefined;
    // W129: anything here that isn't as pitwall sends it reads as the safe side: one name, a mode it can't see.
    const { lastActivityAt, sameName } = value;
    const approval: SupervisorApproval = {
      id,
      kind,
      sessionId,
      name,
      directory,
      text,
      at,
      expiresAt,
      sameName: typeof sameName === 'number' && Number.isSafeInteger(sameName) && sameName > 1 ? sameName : 1,
      permission: asPermission(value.permission),
    };
    if (isTime(lastActivityAt)) approval.lastActivityAt = lastActivityAt;
    const launch = asLaunch(value.launch);
    if (launch !== undefined) approval.launch = launch;
    const profiles = asCardProfiles(value);
    if (profiles === false) return undefined;
    return { ...approval, ...profiles };
  }
  return undefined;
}

/**
 * A card's `profiles` and `profile` (W156), read whole: every profile well formed, as the server
 * resolves them, each name once, at most WORK_PROFILES_TOTAL_MAX (the built-ins and the config file's), and `profile` one of them. False when any
 * of it isn't, so the card isn't shown, since what it shows must be what goes; nothing when it has none.
 */
function asCardProfiles(value: Record<string, unknown>): { profiles?: ApprovalProfile[]; profile?: string } | false {
  if (value.profiles === undefined) return value.profile === undefined ? {} : false;
  if (!Array.isArray(value.profiles) || value.profiles.length === 0 || value.profiles.length > WORK_PROFILES_TOTAL_MAX) return false;
  const profiles: ApprovalProfile[] = [];
  for (const entry of value.profiles) {
    const profile = asApprovalProfile(entry);
    if (profile === undefined || profiles.some((each) => each.name === profile.name)) return false;
    profiles.push(profile);
  }
  if (value.profile === undefined) return { profiles };
  if (typeof value.profile !== 'string' || !profiles.some((each) => each.name === value.profile)) return false;
  return { profiles, profile: value.profile };
}

function asApprovalProfile(value: unknown): ApprovalProfile | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || !WORK_PROFILE_NAME_PATTERN.test(value.name)) return undefined;
  const { model, effort, subagentModel, skill } = value;
  if (model !== WORK_DEFAULT && !isWorkModel(model, 'session')) return undefined;
  if (effort !== WORK_DEFAULT && !isEffortLevel(effort)) return undefined;
  if (subagentModel !== WORK_DEFAULT && !isWorkModel(subagentModel, 'subagents')) return undefined;
  if (skill !== undefined && !isSkillName(skill)) return undefined;
  return { name: value.name, model: model as string, effort: effort as ApprovalProfile['effort'], subagentModel: subagentModel as string, ...(skill === undefined ? {} : { skill: skill as string }) };
}

/**
 * A resume's kept launch settings (W155), only the fields that pass the profiles' checks; undefined
 * when none does, so the card says nothing of them.
 */
function asLaunch(value: unknown): SessionLaunch | undefined {
  if (!isRecord(value)) return undefined;
  const launch: SessionLaunch = {};
  if (typeof value.profile === 'string' && WORK_PROFILE_NAME_PATTERN.test(value.profile)) launch.profile = value.profile;
  if (value.custom === true) launch.custom = true;
  if (value.model === WORK_DEFAULT || isWorkModel(value.model, 'session')) launch.model = value.model as string;
  if (value.effort === WORK_DEFAULT || isEffortLevel(value.effort)) launch.effort = value.effort as SessionLaunch['effort'];
  if (value.subagentModel === WORK_DEFAULT || isWorkModel(value.subagentModel, 'subagents')) launch.subagentModel = value.subagentModel as string;
  return launch.model === undefined && launch.effort === undefined && launch.subagentModel === undefined ? undefined : launch;
}

/** A resume's saved permission mode, or 'unknown' when it isn't one this page knows (W129). */
function asPermission(value: unknown): SavedPermission {
  if (!isRecord(value)) return { kind: 'unknown' };
  if (value.kind === 'unset') return { kind: 'unset' };
  const mode = PERMISSION_MODES.find((each) => each === value.mode);
  return value.kind === 'mode' && mode !== undefined ? { kind: 'mode', mode } : { kind: 'unknown' };
}

/** The most hand-offs the page reads: the server keeps SUPERVISOR_HANDOFFS_MAX. */
const HANDOFFS_READ_MAX = 50;

/** One hand-off (W124), or undefined when it isn't one this page knows how to show. */
function asHandoff(value: unknown): SupervisorHandoff | undefined {
  if (!isRecord(value)) return undefined;
  const { id, kind, name, at, sessionId, shortId, copy } = value;
  if (!isId(id) || (kind !== 'message' && kind !== 'spawn' && kind !== 'resume') || !isText(name) || name.trim() === '' || !isTime(at)) return undefined;
  const handoff: SupervisorHandoff = { id, kind, name, at };
  // A copy (W127) is matched by its own short id alone, never the original's session id.
  if (copy === true && kind === 'resume') handoff.copy = true;
  else if (isId(sessionId)) handoff.sessionId = sessionId;
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
  const { status, sessionId, error, approvals, lastTurnAt, costUsd, handoffs, contextTokens } = value;
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
  // Its context (W136): a whole number of tokens, or not shown.
  if (typeof contextTokens === 'number' && Number.isSafeInteger(contextTokens) && contextTokens > 0) state.contextTokens = contextTokens;
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

/** The listed session a hand-off went to: by its session id, or a started one, or a copy (W127), by its short id. */
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
  const line = text === undefined ? '' : visibleString(plainText(text)).replace(/\s+/g, ' ').trim();
  if (line !== '') return line.length > NEEDS_REASON_MAX ? `${line.slice(0, NEEDS_REASON_MAX - 1).trimEnd()}…` : line;
  return `${badge.label.charAt(0).toLowerCase()}${badge.label.slice(1)}`;
}

/** The longest reason a needs-you notice gives, in characters. */
export const NEEDS_REASON_MAX = 160;

/**
 * The name a row shows: the session's own, once listed, else the one the hand-off has. A copy's row
 * names the session it copied (W127), since Claude Code gives the copy a name of its own.
 */
export const handoffName = (row: HandoffRow) => visibleString(row.handoff.copy === true ? row.handoff.name : (row.session?.name ?? row.handoff.name));

/**
 * The rows: one per session, its newest hand-off, those that need you first, then newest first. A
 * session started and then messaged is one row, "Started", since that's where it came from, and so is
 * one resumed and then messaged, "Resumed" (W127).
 */
export function handoffRows(handoffs: readonly SupervisorHandoff[] | undefined, sessions: readonly SessionSummary[]): HandoffRow[] {
  const byKey = new Map<string, { row: HandoffRow; order: number; started: boolean }>();
  (handoffs ?? []).forEach((handoff, order) => {
    const session = handoffSession(handoff, sessions);
    const key = session !== undefined ? `s:${session.sessionId}` : handoff.shortId !== undefined ? `b:${handoff.shortId}` : `h:${handoff.id}`;
    const before = byKey.get(key);
    // Started, or resumed (W127): that's where it came from, so a message after keeps the row's verb.
    const started = (before?.started ?? false) || handoff.kind === 'spawn' || handoff.kind === 'resume';
    const kept = started && handoff.kind === 'message' && before !== undefined ? before.row.handoff : handoff;
    const row: HandoffRow = { handoff: kept };
    if (session !== undefined) {
      row.session = session;
      if (needsAttention(session)) row.needs = `${visibleString(session.name)} needs you: ${needsReason(session)}`;
    }
    byKey.set(key, { row, order, started });
  });
  return [...byKey.values()]
    .sort((a, b) => Number(b.row.needs !== undefined) - Number(a.row.needs !== undefined) || b.order - a.order)
    .map((each) => each.row);
}

/** What a row says it did. */
export function handoffVerb(handoff: SupervisorHandoff): string {
  if (handoff.kind === 'spawn') return 'Started';
  if (handoff.kind === 'resume') return handoff.copy === true ? 'Resumed a copy of' : 'Resumed';
  return 'Message approved for';
}

/** What a copy's row says under it (W127): where the message went, and what's left to do. */
export const HANDOFF_COPY_NOTE = 'It was open in another Claude Code process, so Claude Code started a copy of its conversation and the message went to the copy. The original is unchanged; stop and remove the copy if you don’t need it.';

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

// --- New conversation (W136) ------------------------------------------------------------------------

/** The header's button. */
export const NEW_CONVERSATION_LABEL = 'New conversation';

/** Its confirmation, in the page (4: Inline confirmation). */
export const NEW_CONVERSATION_CONFIRM = {
  question: 'Start a new conversation?',
  consequence:
    "The supervisor stops, if it's running, and forgets this conversation, with any message of yours still waiting to be sent to it: your next message or Start begins a new one, without what was said here. Its transcript stays on disk.",
  confirm: 'Start new conversation',
  busy: 'Clearing…',
} as const;

/** What a toast says once it's done: the view's empty state says the rest. */
export const NEW_CONVERSATION_DONE = 'New conversation. Your next message, or Start, begins it.';

/**
 * Why New conversation is off, from the snapshot, for its tooltip, as the server would refuse it
 * (src/supervisor/supervisor.ts); undefined while it can be pressed. The server checks again, and
 * says why when the page couldn't know, as for your messages waiting for a start.
 */
export function newConversationBlocked(state: SupervisorState): string | undefined {
  if (state.status === 'held') return 'Another session has its conversation. Free it first.';
  if (state.status === 'starting') return 'It is starting. Wait until it has started.';
  if (state.status === 'working') return 'It is working on a turn. Stop it, or wait for it to end.';
  const cards = state.approvals.length;
  if (cards > 0) return `${cards === 1 ? 'A draft waits' : `${cards} drafts wait`} for you from this conversation. Answer ${cards === 1 ? 'it' : 'them'} first.`;
  return undefined;
}

/** The context gauge's info button (W136): what the number is, and what to do about it. */
export const SUPERVISOR_CONTEXT_INFO = `The tokens of context its last call carried in this run, from what Claude Code reported: everything the model read again, cached or not. Every message sends all of it again. Flagged over ${formatTokens(CONTEXT_WARN_TOKENS)}, and in red over ${formatTokens(CONTEXT_HIGH_TOKENS)}: start a new conversation when you're done with this one.`;

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

/** A spawn or resume approval's directory as the card shows it: home as ~. */
export const approvalDirectory = (approval: Extract<SupervisorApproval, { kind: 'spawn' | 'resume' }>) => shortenHome(visibleString(approval.directory));

/** What an approval would send or start, as its card's heading says it, in plain text. */
export function approvalTitle(approval: SupervisorApproval): string {
  // As they are, with anything that wouldn't show as its code (W120): never a filter that removes text.
  if (approval.kind === 'message') return `Message to ${visibleString(approval.to)}`;
  // W127: the listed session's own name, as pitwall resolved its id.
  if (approval.kind === 'resume') return `Resume ${visibleString(approval.name)} and send`;
  const named = approval.name === undefined ? '' : `, named ${visibleString(approval.name)}`;
  return `New session in ${approvalDirectory(approval)}${named}`;
}

/**
 * What a resume card says before the session's folder (W129, the re-review's M2): names aren't
 * unique, so when another listed session has this one's name, it says how many do and which this is.
 */
export function resumeWhereLead(sameName: number): string {
  return sameName > 1 ? `${sameName.toLocaleString('en')} listed sessions have this name; this is the one in ` : 'In ';
}

/**
 * What a resume card says about the settings it resumes with (W129, the re-review's L1): Claude Code
 * wakes a session with its own saved options, its permission mode included, and what pitwall knows of
 * that mode, from a background job's saved flags.
 */
export function resumePermissionText(permission: SavedPermission): string {
  const lead = 'Claude Code resumes it with its own saved settings, its permission mode included';
  if (permission.kind === 'mode') return `${lead}: ${permission.mode}.`;
  if (permission.kind === 'unset') return `${lead}. Its saved flags set no permission mode, so your Claude Code settings decide it.`;
  return `${lead}, which pitwall can't see for this session.`;
}

/**
 * What a resume card says of the model it resumes on, for a session pitwall started with a work
 * profile (W155): pitwall passes what it started with again, never the profile's skill.
 */
export function resumeLaunchText(launch: SessionLaunch): string {
  const shown = (value: string) => (value === WORK_DEFAULT ? "Claude Code's default" : value);
  const parts = [
    ...(launch.model === undefined ? [] : [`model ${shown(launch.model)}`]),
    ...(launch.effort === undefined ? [] : [`effort ${shown(launch.effort)}`]),
    ...(launch.subagentModel === undefined ? [] : [`sub-agents ${shown(launch.subagentModel)}`]),
  ];
  const from = launch.profile === undefined ? 'a profile' : `the ${launch.profile} profile${launch.custom === true ? ', customized' : ''}`;
  return `pitwall resumes it on what it started it with, from ${from}: ${parts.join(', ')}.`;
}

/**
 * A resume card's Profile choice for resuming as it started (W156): a NUL-prefixed value, as New
 * session's Customized is, so no profile's name can be it. It sends `profile: null`.
 */
export const AS_STARTED = '\u0000as-started';

/** That choice's words: as it started, naming the profile pitwall kept for it, if any (W155). */
export function asStartedText(launch: SessionLaunch | undefined): string {
  if (launch?.profile === undefined) return 'As it started';
  return `As it started (${launch.profile}${launch.custom === true ? ', customized' : ''})`;
}

/** A profile's model, effort and sub-agents' model, as a card says them (W156). */
function profileSettings(profile: ApprovalProfile): string {
  const shown = (value: string) => (value === WORK_DEFAULT ? "Claude Code's default" : value);
  return `model ${shown(profile.model)}, effort ${shown(profile.effort)}, sub-agents ${shown(profile.subagentModel)}`;
}

/**
 * What a new session's card says under its Profile (W156): exactly what the session starts with, and
 * the skill its first prompt starts with, which must be installed where it runs, as New session says.
 */
export function spawnProfileText(profile: ApprovalProfile): string {
  const skill = profile.skill === undefined ? '' : ` Its first prompt starts with /${profile.skill}, which must be installed where the session runs.`;
  return `Starts on ${profileSettings(profile)}.${skill}`;
}

/** What a resume card says under its Profile when one is picked (W156): what it resumes on, never the skill, which runs once. */
export function resumeProfileText(profile: ApprovalProfile): string {
  const skill = profile.skill === undefined ? '' : ` Not its skill, /${profile.skill}, which runs only when a session starts.`;
  return `pitwall resumes it on the ${profile.name} profile: ${profileSettings(profile)}.${skill}`;
}

/** The warning on a resume card whose saved permission mode skips the prompts (W129, L1). */
export const RESUME_BYPASS_WARNING =
  'Its saved permission mode is bypassPermissions: once you send it, the message runs with no permission prompts, whatever it asks for.';

/** Whether a resume runs with its permission prompts skipped, as far as pitwall can tell. */
export const resumeBypassed = (permission: SavedPermission) => permission.kind === 'mode' && permission.mode === 'bypassPermissions';

/** `@` at the start or after a space, then a word that could be a path: `@src/a.ts`, `@~/notes`, `@README.md`. */
const AT_PATH = /(?:^|\s)@[\w~./-]+/u;

/**
 * What a new session's first prompt or a resume's message may do besides being read (W129, the
 * re-review's I2): it reaches Claude Code as a typed prompt, so a leading `/` may run a slash command
 * and an `@` before a path may attach that file (D20).
 */
export function typedPromptNotes(text: string): string[] {
  const notes: string[] = [];
  if (text.trimStart().startsWith('/')) notes.push('It starts with /, so Claude Code may run it as a slash command rather than read it.');
  if (AT_PATH.test(text)) notes.push('It has @ before a path, so Claude Code may attach that file.');
  return notes;
}

/** The text an approval would send: a message's, or a new session's first prompt. */
export const approvalText = (approval: SupervisorApproval) => (approval.kind === 'spawn' ? approval.prompt : approval.text);

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

/**
 * New conversation (W136): POST SUPERVISOR_NEW_CONVERSATION_PATH. The server stops it if it runs and
 * forgets the conversation on file; a 409 says why not, in pitwall's words. Never rejects.
 */
export async function newSupervisorConversation(api: ApiClient, signal?: AbortSignal): Promise<SupervisorAction> {
  return actionOutcome(await api.post(SUPERVISOR_NEW_CONVERSATION_PATH, {}, signal ? { signal } : {}), 'start a new conversation');
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

/** The longest message you send it (W134), again here so the box can say so before sending. */
export const SUPERVISOR_TEXT_MAX = SUPERVISOR_MESSAGE_MAX;

/** The longest edit of a message it proposes, a resume's included, again here so the card's editor can say so. */
export const SUPERVISOR_EDIT_MAX = SUPERVISOR_PROPOSAL_MAX;
