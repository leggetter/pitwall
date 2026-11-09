// What the supervisor can do, behind your click (M5, W115; spike 009, finding 6; D4): its messages
// to sessions (Claude Code's SendMessage), new sessions (spawn_session, on pitwall's MCP server) and
// finished sessions resumed with a message (resume_session, W127; spike 011), each held by Claude
// Code until the permission prompt tool, approve, answers.
//
//   approve         Claude Code calls it itself (`--permission-prompt-tool mcp__pitwall__approve`),
//                   with `{ tool_name, input, tool_use_id }`, and leaves it out of the model's tools.
//                   For SendMessage or spawn_session whose input passes the checks below, it adds a
//                   card (SupervisorApproval) and holds the call until you decide, the card runs out
//                   (SUPERVISOR_APPROVAL_TIMEOUT_MS), the call is cancelled or pitwall closes. Any
//                   other tool, or input that fails a check, is denied at once, and no card is shown.
//                   Its answer is the documented JSON: `{ behavior: 'allow', updatedInput }` or
//                   `{ behavior: 'deny', message }`
//   decide          POST supervisorApprovalPath(id), from your card: Send allows what the card showed;
//                   Edit allows it with your text in place of the message or the prompt, checked
//                   again; Don't send denies it. A message is allowed as `{ to, message }` alone,
//                   rebuilt from what was checked, never the model's `summary` or `content`. Each is checked again first, against the list as it
//                   is then: a recipient that has ended since denies it, saying why
//   spawn_session   runs pitwall's own spawn (actions.ts, the New session dialog's checks and limits)
//                   only on a one-time pass for exactly the input an approval just allowed, within a
//                   minute, and, when Claude Code gives the call's tool_use_id, only on that call's own
//                   approval's pass (approvals.ts' passes). A call that skipped approval starts nothing
//   resume_session  runs pitwall's own resume (actions.ts' ResumeRunner, the Resume route's checks and
//                   limits) with your message as the resumed session's next turn, on the same kind of
//                   pass (W127). A copy Claude Code started instead is reported, never hidden
//
// The checks, before a card shows and again on Send or Edit:
//
//   a message       to: exactly the name of one running session pitwall lists, never an ended one,
//                   one whose name another running one shares, or pitwall's own (relay, recap
//                   calls, the supervisor); a name the relay could address (isAddressable()), with
//                   no `:` or `/`, which would make it an address rather than a name; and, by a
//                   fresh `claude agents --json --all`, unfiltered, as the relay checks (W120, W116's
//                   F2), the one live session of that name, ignoring case, wherever it runs, so a
//                   name shared with a session outside the roots is refused; only the fields pitwall
//                   knows; a plain message, no idle notices; a `content` preview that is the message
//                   or its start, never other text; text not blank, at most SUPERVISOR_PROPOSAL_MAX
//   a new session   directory: an existing directory under a root, by its real path, as New session
//                   requires (checkDirectory()); name: NAME_PATTERN, never one of pitwall's own
//                   (OWN_NAMES); prompt: not blank, at most MAX_PROMPT_LENGTH, not just a claude
//                   command; no other field
//   a resume        id: a listed session's, resolved from the index's snapshot, and only its own
//                   UUID, directory and name used after, never the input (W66's rule); not one of
//                   pitwall's own; not running, which takes a message instead; an interactive session
//                   that has ended or a background one that isn't running, not stale, with a UUID
//                   (resumeProblem()); its directory still at or under a root by its real path
//                   (checkDirectory()). The runner checks a fresh `claude agents` and the directory
//                   again just before it runs, and Claude Code refuses a workspace it doesn't trust.
//                   message: as a message's, and not just a claude command, as a new session's
//                   prompt (W129, the re-review's M1): `claude --resume <id> --bg -- purge` could run
//                   `claude purge`; no other field
//   all text        no character that doesn't show as itself (hiddenTextProblem(), W120, W116's
//                   F1): no C0 or C1 control but tab and newline, so no terminal escape; no bidi
//                   control, zero-width or tag character, or other format or default-ignorable
//                   character. In the message, the prompt, the recipient, the name and the directory
//
// The recipient gate (src/supervisor/gate.ts) checks a message's `to` again before Claude Code asks,
// against recipientNames(), as defence in depth.
//
// What goes is exactly what the card showed, or your edit (D25's rule: a prompt pitwall fills in goes
// as typed by you, and here you read it, whole, before it goes), with one exception, which the card
// shows too: a message to a session ends with pitwall's own fixed line, SUPERVISOR_MESSAGE_FOOTER
// (W138), after a blank line, saying it's from the supervisor, with your approval, and that a reply to
// it will be refused. It's added after the checks, to the allowed input only (sentMessageInput()), so
// the card's text, your edit and SUPERVISOR_PROPOSAL_MAX are about what you read and write, never the
// line; it's plain ASCII, so it can't carry a character the checks would refuse. The card
// shows the string itself, never through a filter that removes text, and since the checks above
// refuse every character that wouldn't show, there is nothing on it you can't read; anything unusual
// left, such as a no-break space, it draws as its code (web/src/components/ApprovalCards.tsx).
import type { AgentRow, AgentsSource } from '../index/agents.js';
import { isRecord } from '../index/guards.js';
import { hiddenTextProblem } from '../shared/hiddenText.js';
import { MCP_TOOLS, SUPERVISOR_PROPOSAL_MAX, withSupervisorFooter, type IndexSnapshot, type SavedPermission, type SessionLaunch, type SessionSummary, type SupervisorDecision } from '../shared/protocol.js';
import { DECLINED_MESSAGE, type ApprovalDraft, type ApprovalQueue, type PermissionAnswer } from '../supervisor/approvals.js';
import { isPreviewOf, KNOWN_INPUT_FIELDS, OWN_NAMES } from '../supervisor/supervisorGateHook.mjs';
import { mcpToolName } from '../supervisor/prompt.js';
import { checkDirectory, MAX_PROMPT_LENGTH, resumeProblem, validateSpawnRequest, type ResumeRunner, type SpawnRunner, type ValidSpawn } from './actions.js';
import type { SessionLaunches } from './sessionLaunches.js';
import { isClaudeCommand } from './claudeCommands.js';
import type { McpTool, McpToolResult } from './mcp.js';
import { NAME_MAX, plainField, UNTRUSTED_NOTE } from './mcpTools.js';
import { isAddressable, nameKey } from './relayPrompt.js';
import { findSession } from './sessions.js';
import { isSafeSessionId } from '../index/index.js';

/** The tools approve may allow, as Claude Code names them. */
export const MESSAGE_TOOL = 'SendMessage';
export const SPAWN_TOOL = mcpToolName(MCP_TOOLS.spawnSession);
export const RESUME_TOOL = mcpToolName(MCP_TOOLS.resumeSession);

/**
 * The `_meta` key Claude Code puts a call's tool_use_id under, in tools/call. Not documented, so
 * spawn_session doesn't rely on it alone: a call runs on a pass for exactly the input you allowed,
 * and when this is present, only on that call's own approval's pass.
 */
export const TOOL_USE_ID_META = 'claudecode/toolUseId';

/** A tool_use_id as Claude Code makes them. */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface SupervisorActionSources {
  /** The snapshot as clients get it. */
  snapshots: { latest(): IndexSnapshot | undefined };
  /** The supervisor's own session ids, which it never messages. */
  ownSessionIds?: () => ReadonlySet<string>;
  approvals: ApprovalQueue;
  /** pitwall's spawn, with the spawn route's limits. */
  spawner: Pick<SpawnRunner, 'start'>;
  /** Called after spawn_session started a session, so the list picks it up. */
  onSpawned?: () => void;
  /** pitwall's resume, with the Resume route's checks and limits (W127). Without one, resume_session is refused. */
  resumer?: Pick<ResumeRunner, 'resume'>;
  /**
   * A fresh `claude agents --json --all`, unfiltered, for the recipient check (W120): the snapshot
   * leaves out sessions outside the roots and pitwall's own. The server passes the index's source.
   */
  agents: Pick<AgentsSource, 'list'>;
  /**
   * The permission mode a finished session resumes in, for its card (W129, the re-review's L1): a
   * background job's saved flags, read by the job-file adapter (src/index/jobs.ts). Without one, or
   * for an ended interactive session, which has no saved flags pitwall reads, it's 'unknown'.
   */
  savedPermission?: (shortId: string, sessionId: string) => Promise<SavedPermission>;
  /** What a session started with a work profile used, which its resume reuses (W155), for the card. */
  launches?: Pick<SessionLaunches, 'lookup'>;
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** Whether a listed session can be messaged: running, not ended or finished, not pitwall's own. */
function messageable(session: SessionSummary, own: ReadonlySet<string>): boolean {
  if (own.has(session.sessionId) || OWN_NAMES.has(nameKey(session.name.trim()))) return false;
  return session.alive && session.ended !== true && !session.finished;
}

/**
 * The names the supervisor may message, for the recipient gate: each running, listed session's
 * name that no other running one shares, ignoring case, never pitwall's own. With `rows`, the
 * index's last `claude agents --json --all`, unfiltered (Indexer.liveRows()), a name that another
 * live session shares, one outside the roots included, is left out too (W120, W116's F2).
 */
export function recipientNames(snapshot: IndexSnapshot | undefined, own: ReadonlySet<string> = new Set(), rows?: readonly Pick<AgentRow, 'name' | 'pid'>[]): string[] {
  if (snapshot === undefined) return [];
  const liveByKey = new Map<string, number>();
  for (const row of rows ?? []) if (row.pid !== undefined) liveByKey.set(nameKey(row.name), (liveByKey.get(nameKey(row.name)) ?? 0) + 1);
  const byKey = new Map<string, string[]>();
  for (const group of snapshot.groups) {
    for (const session of group.sessions) {
      if (!messageable(session, own)) continue;
      const key = nameKey(session.name);
      byKey.set(key, [...(byKey.get(key) ?? []), session.name]);
    }
  }
  return [...byKey.entries()]
    .filter(([key, names]) => names.length === 1 && (rows === undefined || liveByKey.get(key) === 1))
    .map(([, names]) => names[0]!)
    .sort();
}

/** The text of a message or a prompt, or why it isn't one. */
function checkText(text: unknown, max: number, what: string): Checked<string> {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: `The ${what} is empty.` };
  if (text.length > max) return { ok: false, error: `The ${what} can be at most ${max.toLocaleString('en-US')} characters.` };
  const hidden = hiddenTextProblem(text, what);
  if (hidden !== undefined) return { ok: false, error: hidden };
  return { ok: true, value: text };
}

/**
 * A resume's message (W129, the re-review's M1): a message's text, and never just the name of a
 * claude command, since `claude --resume <id> --bg -- <message>` could run that command instead, as
 * a new session's prompt could (claudeCommands.ts, validateSpawnRequest()).
 */
export function checkResumeText(text: unknown): Checked<string> {
  const checked = checkText(text, SUPERVISOR_PROPOSAL_MAX, 'message');
  if (!checked.ok) return checked;
  if (isClaudeCommand(checked.value)) {
    return {
      ok: false,
      error: `The message can't be just "${checked.value.trim().toLowerCase()}": that's the name of a claude command, which claude --resume could run instead of resuming the session. Add a few words.`,
    };
  }
  return checked;
}

/** Whether `to` could be a session's name, as the relay addresses one, and nothing that reads as an address. */
function checkTo(to: string): Checked<string> {
  const hidden = hiddenTextProblem(to, 'recipient');
  if (hidden !== undefined) return { ok: false, error: hidden };
  if (!isAddressable(to)) return { ok: false, error: 'pitwall can’t address a session by that name: it has line breaks, < or >, a space at either end, or is too long.' };
  if (/[:/]/.test(to)) return { ok: false, error: 'Send a message to a session by its name alone: a name with “:” or “/” reads as an address, which pitwall doesn’t send to.' };
  return { ok: true, value: to };
}

/** A SendMessage call's input, checked against the list as it is now. */
export function checkMessage(input: unknown, snapshot: IndexSnapshot | undefined, own: ReadonlySet<string> = new Set()): Checked<{ to: string; text: string }> {
  if (!isRecord(input)) return { ok: false, error: 'The call has no arguments.' };
  if (Object.keys(input).some((field) => !KNOWN_INPUT_FIELDS.has(field))) return { ok: false, error: 'The call has a field pitwall doesn’t check.' };
  if (input.type !== undefined && input.type !== 'message') return { ok: false, error: 'pitwall sends only plain messages.' };
  if (input.notify_when_idle !== undefined && input.notify_when_idle !== false) return { ok: false, error: 'pitwall doesn’t ask to be told when a session goes idle: status comes from pitwall.' };
  const { to } = input;
  if (typeof to !== 'string' || to === '') return { ok: false, error: 'The message names no session.' };
  if (input.recipient !== undefined && input.recipient !== to) return { ok: false, error: 'The message names two different recipients.' };
  if (input.recipient_kind !== undefined && input.recipient_kind !== 'name') return { ok: false, error: 'Send a message to a session by its name, as list_sessions gives it.' };
  if (OWN_NAMES.has(nameKey(to.trim()))) return { ok: false, error: 'pitwall’s own sessions can’t be messaged.' };
  const addressable = checkTo(to);
  if (!addressable.ok) return addressable;
  const text = checkText(input.message, SUPERVISOR_PROPOSAL_MAX, 'message');
  if (!text.ok) return text;
  // Claude Code's preview of the message: anything but the message or its start could carry text
  // the card never shows (W115's review).
  if (!isPreviewOf(input.content, text.value)) return { ok: false, error: 'The call’s preview (content) isn’t its message.' };
  if (snapshot === undefined) return { ok: false, error: 'pitwall hasn’t listed the sessions yet.' };
  if (!recipientNames(snapshot, own).includes(to)) {
    const named = snapshot.groups.flatMap((group) => group.sessions).filter((session) => nameKey(session.name) === nameKey(to) && !own.has(session.sessionId));
    const running = named.filter((session) => messageable(session, own));
    if (running.length > 1) return { ok: false, error: 'More than one running session has that name, so pitwall can’t tell which you mean. Ask the user to rename one.' };
    if (running.length === 1) return { ok: false, error: `No running session is named exactly that: did you mean ${JSON.stringify(running[0]!.name)}?` };
    if (named.length > 0) return { ok: false, error: 'That session isn’t running: it has ended or finished, so it can’t take a message. Propose a new session instead, if it helps.' };
    return { ok: false, error: 'No session pitwall lists has that name. Call list_sessions for the names.' };
  }
  return { ok: true, value: { to, text: text.value } };
}

/**
 * A message's recipient checked again by a fresh `claude agents --json --all`, unfiltered, as the
 * relay checks a name (relay.ts' checkName()): exactly one live session, wherever it runs, has the
 * name, ignoring case, and it's the listed session `to` named. A name a session outside the roots
 * shares, which the snapshot never shows, is refused (W120, W116's F2).
 */
export async function checkLiveRecipient(to: string, snapshot: IndexSnapshot | undefined, agents: Pick<AgentsSource, 'list'>, own: ReadonlySet<string> = new Set()): Promise<Checked<true>> {
  const listedSession = snapshot?.groups.flatMap((group) => group.sessions).find((session) => session.name === to && messageable(session, own));
  if (listedSession === undefined) return { ok: false, error: 'No running session pitwall lists has that name now.' };
  const listed = await agents.list();
  if (!listed.ok) return { ok: false, error: `pitwall couldn’t check that no other session has that name, so it won’t send it: ${listed.error}` };
  const key = nameKey(to);
  const live = listed.rows.filter((row) => row.pid !== undefined && nameKey(row.name) === key);
  if (live.length === 0) return { ok: false, error: 'No running session has that name now.' };
  if (live.length > 1) {
    return { ok: false, error: 'More than one running session has that name, counting sessions outside the user’s roots, which pitwall doesn’t list, so a message could reach the wrong one. Ask the user to rename one.' };
  }
  const row = live[0]!;
  if (row.sessionId !== listedSession.sessionId || own.has(row.sessionId)) return { ok: false, error: 'That name now belongs to another session.' };
  if (row.name !== to) return { ok: false, error: 'That session’s name has just changed.' };
  return { ok: true, value: true };
}

/** spawn_session's arguments, checked as New session checks a request: the directory by its real path under a root. */
export async function checkSpawn(input: unknown, snapshot: IndexSnapshot | undefined): Promise<Checked<ValidSpawn>> {
  if (!isRecord(input)) return { ok: false, error: 'The call has no arguments.' };
  for (const key of Object.keys(input)) {
    if (key !== 'directory' && key !== 'prompt' && key !== 'name') return { ok: false, error: `Unknown argument: ${key.slice(0, 40)}.` };
  }
  const prompt = checkText(input.prompt, MAX_PROMPT_LENGTH, 'first prompt');
  if (!prompt.ok) return prompt;
  for (const [field, what] of [['directory', 'directory'], ['name', 'name']] as const) {
    const value = input[field];
    const hidden = typeof value === 'string' ? hiddenTextProblem(value, what) : undefined;
    if (hidden !== undefined) return { ok: false, error: hidden };
  }
  if (snapshot === undefined) return { ok: false, error: 'pitwall hasn’t listed the sessions yet, so it doesn’t know the roots.' };
  const validation = await validateSpawnRequest({ cwd: input.directory, prompt: prompt.value, ...(input.name === undefined ? {} : { name: input.name }) }, snapshot.roots);
  if (!validation.ok) return { ok: false, error: validation.error };
  return { ok: true, value: validation.spawn };
}

/** A resume, checked: the listed session, by the index's own summary, and the message. */
export interface CheckedResume {
  session: SessionSummary;
  /** The session's directory by its real path, as checkDirectory() found it now. */
  directory: string;
  text: string;
}

/**
 * resume_session's arguments, checked against the list as it is now (W127): `id` must be a listed
 * session's, and from here on only that session's own summary is used, its UUID, name and directory,
 * never the input, as the Resume route uses the resolved summary (W66). Not pitwall's own; not
 * running, since a running session takes a message (SendMessage) and a resume would start a copy;
 * one resumeProblem() allows, not stale; its directory still under a root by its real path; and the
 * message as a message's. The runner checks a fresh `claude agents` and the directory again just
 * before it runs.
 */
export async function checkResume(input: unknown, snapshot: IndexSnapshot | undefined, own: ReadonlySet<string> = new Set()): Promise<Checked<CheckedResume>> {
  if (!isRecord(input)) return { ok: false, error: 'The call has no arguments.' };
  for (const key of Object.keys(input)) {
    if (key !== 'id' && key !== 'message') return { ok: false, error: `Unknown argument: ${key.slice(0, 40)}.` };
  }
  const { id } = input;
  if (typeof id !== 'string' || id === '') return { ok: false, error: 'The call names no session: pass its id from list_sessions.' };
  const hidden = hiddenTextProblem(id, 'id');
  if (hidden !== undefined) return { ok: false, error: hidden };
  if (!isSafeSessionId(id)) return { ok: false, error: 'That isn’t a session id: pass the id list_sessions gives.' };
  const text = checkResumeText(input.message);
  if (!text.ok) return text;
  if (snapshot === undefined) return { ok: false, error: 'pitwall hasn’t listed the sessions yet.' };
  const session = findSession(snapshot, id);
  if (session === undefined) return { ok: false, error: 'No session pitwall lists has that id. Call list_sessions with finished: true for the ids of finished ones.' };
  if (own.has(session.sessionId) || OWN_NAMES.has(nameKey(session.name.trim()))) return { ok: false, error: 'pitwall’s own sessions can’t be resumed.' };
  if (session.alive || session.pid !== undefined) {
    // Not the name, which is untrusted, in pitwall's own words (W129, the re-review's L3).
    return { ok: false, error: 'That session is running, so it takes a message instead: propose it with SendMessage, to its name from list_sessions.' };
  }
  if (session.stale) return { ok: false, error: 'That session has been blocked for over a week, so pitwall won’t resume it for you. The user can open it from the list.' };
  const problem = resumeProblem(session);
  if (problem !== undefined) return { ok: false, error: problem };
  const dir = await checkDirectory(session.cwd, snapshot.roots);
  if (!dir.ok) return { ok: false, error: dir.error };
  return { ok: true, value: { session, directory: dir.path, text: text.value } };
}

/** How many listed sessions have `session`'s name, ignoring case, itself included, each counted once (W129, M2). */
export function sameNameCount(snapshot: IndexSnapshot, session: SessionSummary): number {
  const key = nameKey(session.name);
  const ids = new Set<string>([session.sessionId]);
  // A session can be under more than one group (D6), so by id.
  for (const group of snapshot.groups) for (const each of group.sessions) if (nameKey(each.name) === key) ids.add(each.sessionId);
  return ids.size;
}

/** The permission mode `session` resumes in, as far as pitwall can tell (W129, L1): only a background job has saved flags it reads. */
export async function resumePermission(session: SessionSummary, read: SupervisorActionSources['savedPermission']): Promise<SavedPermission> {
  if (read === undefined || session.kind !== 'background' || session.shortId === undefined) return { kind: 'unknown' };
  try {
    return await read(session.shortId, session.sessionId);
  } catch {
    return { kind: 'unknown' };
  }
}

/** The card's `launch`: what pitwall resumes `session` on, when it started it with a profile (W155). Fails soft. */
function launchFor(session: SessionSummary, launches: SupervisorActionSources['launches']): { launch?: SessionLaunch } {
  try {
    const kept = launches?.lookup(session);
    return kept === undefined ? {} : { launch: kept.launch };
  } catch {
    return {};
  }
}

/** The input resume_session runs with, once allowed: the listed session's own id, and the message as the card showed it or your edit. */
function resumeInput(sessionId: string, text: string): Record<string, unknown> {
  return { id: sessionId, message: text };
}

/**
 * The input SendMessage runs with, once allowed: `to` and `message`, as the card showed them, and
 * nothing else. Claude Code's schema needs only those; it fills in `type`, `recipient`,
 * `recipient_kind` and the `content` preview from them, and the model's `summary`, a label for its
 * own transcript that the card doesn't show, is left out (W115's review).
 */
export function messageInput(to: string, text: string): Record<string, unknown> {
  return { to, message: text };
}

/**
 * The input a message is allowed with, once checked (W138): `{ to, message }`, the message being the
 * text you approved with pitwall's fixed line after it (withSupervisorFooter()).
 */
export function sentMessageInput(to: string, text: string): Record<string, unknown> {
  return messageInput(to, withSupervisorFooter(text));
}

/** The input spawn_session runs with, once allowed: the real path, the prompt, the name if any. */
function spawnInput(spawn: ValidSpawn): Record<string, unknown> {
  return { directory: spawn.cwd, prompt: spawn.prompt, ...(spawn.name === undefined ? {} : { name: spawn.name }) };
}

function answerText(answer: PermissionAnswer): McpToolResult {
  return { text: JSON.stringify(answer) };
}

function deny(message: string): McpToolResult {
  return answerText({ behavior: 'deny', message: `pitwall: ${message}` });
}

/** The permission prompt tool, approve (`--permission-prompt-tool mcp__pitwall__approve`). */
export function createApproveTool(sources: SupervisorActionSources): McpTool {
  const own = () => sources.ownSessionIds?.() ?? new Set<string>();
  return {
    name: MCP_TOOLS.approve,
    description:
      "pitwall's permission prompt tool. Claude Code calls it before a tool that needs permission runs; the model never does. It asks the user in pitwall and answers with their decision.",
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
        tool_use_id: { type: 'string' },
      },
      required: ['tool_name', 'input'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    holds: true,
    async call(args, context) {
      const toolName = args.tool_name;
      const input = args.input;
      const toolUseId = args.tool_use_id;
      if (typeof toolName !== 'string' || !isRecord(input)) return deny('this permission request isn’t one pitwall can read, so it was denied.');
      if (toolName !== MESSAGE_TOOL && toolName !== SPAWN_TOOL && toolName !== RESUME_TOOL) {
        return deny('the supervisor can only propose messages to sessions, new sessions and resuming finished ones. Nothing else was asked of the user.');
      }
      if (typeof toolUseId !== 'string' || !TOOL_USE_ID.test(toolUseId)) return deny('this permission request has no tool_use_id pitwall can use, so it was denied.');
      let draft: ApprovalDraft;
      let runInput: Record<string, unknown>;
      if (toolName === MESSAGE_TOOL) {
        const checked = checkMessage(input, sources.snapshots.latest(), own());
        if (!checked.ok) return deny(`${checked.error} Nothing was shown to the user.`);
        const live = await checkLiveRecipient(checked.value.to, sources.snapshots.latest(), sources.agents, own());
        if (!live.ok) return deny(`${live.error} Nothing was shown to the user.`);
        draft = { kind: 'message', to: checked.value.to, text: checked.value.text };
        runInput = messageInput(checked.value.to, checked.value.text);
      } else if (toolName === RESUME_TOOL) {
        if (sources.resumer === undefined) return deny('pitwall can’t resume sessions here. Nothing was shown to the user.');
        const checked = await checkResume(input, sources.snapshots.latest(), own());
        if (!checked.ok) return deny(`${checked.error} Nothing was shown to the user.`);
        const { session, directory, text } = checked.value;
        // What the card shows beside the name, which isn't unique (W129, M2, L1): its folder, its last activity, how many share its name, and its saved permission mode.
        const snapshot = sources.snapshots.latest();
        draft = {
          kind: 'resume',
          sessionId: session.sessionId,
          name: session.name,
          directory,
          text,
          ...(session.lastActivityAt === undefined ? {} : { lastActivityAt: session.lastActivityAt }),
          sameName: snapshot === undefined ? 1 : sameNameCount(snapshot, session),
          permission: await resumePermission(session, sources.savedPermission),
          ...launchFor(session, sources.launches),
        };
        runInput = resumeInput(session.sessionId, text);
      } else {
        const checked = await checkSpawn(input, sources.snapshots.latest());
        if (!checked.ok) return deny(`${checked.error} Nothing was shown to the user.`);
        const spawn = checked.value;
        draft = { kind: 'spawn', directory: spawn.cwd, prompt: spawn.prompt, ...(spawn.name === undefined ? {} : { name: spawn.name }) };
        runInput = spawnInput(spawn);
      }
      const added = sources.approvals.add({ draft, toolName, toolUseId, input: runInput }, context?.signal);
      if (!added.ok) return deny(`${added.error} Nothing was shown to the user.`);
      return answerText(await added.answer);
    },
  };
}

/** spawn_session: starts a background session, only for a call approve just allowed. */
export function createSpawnSessionTool(sources: SupervisorActionSources): McpTool {
  return {
    name: MCP_TOOLS.spawnSession,
    description:
      'Proposes a new background Claude Code session to the user: the directory it starts in (an existing directory under one of their roots, such as a session’s directory from list_sessions), its whole first prompt, which the new session reads as the user’s own, and an optional short name. The user sees it as a draft in pitwall and may start it, edit the prompt, or decline; nothing starts until they do. Say in your reply what you propose and why before calling it.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'An absolute path to an existing directory under one of the user’s roots.' },
        prompt: { type: 'string', description: `The whole first prompt, at most ${MAX_PROMPT_LENGTH.toLocaleString('en-US')} characters.` },
        name: { type: 'string', description: 'Optional: a short name for the session (letters, digits, spaces, ".", "_" and "-", at most 64).' },
      },
      required: ['directory', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async call(args, context) {
      const meta = context?.meta?.[TOOL_USE_ID_META];
      const allowed = sources.approvals.takePass(typeof meta === 'string' ? meta : undefined, args);
      if (allowed === undefined) {
        return { text: 'pitwall: this new session wasn’t approved by the user, so nothing was started.', isError: true };
      }
      // Checked once more, now: the directory may have gone since you approved it.
      const checked = await checkSpawn(allowed, sources.snapshots.latest());
      if (!checked.ok) return { text: `pitwall: nothing was started: ${checked.error}`, isError: true };
      const outcome = await sources.spawner.start(checked.value);
      if (!outcome.result.ok) {
        const hint = outcome.result.hint === undefined ? '' : ` The user can run this to fix it: ${outcome.result.hint}`;
        return { text: `pitwall: the session didn't start: ${outcome.result.error}${hint}`, isError: true };
      }
      sources.onSpawned?.();
      // So the panel can open it, and list it with its state (W124).
      sources.approvals.handoff({ kind: 'spawn', name: outcome.result.name, shortId: outcome.result.shortId });
      return { text: JSON.stringify({ started: true, name: outcome.result.name, shortId: outcome.result.shortId, directory: checked.value.cwd }) };
    },
  };
}

/** What resume_session says to the supervisor when it didn't run. */
function notResumed(error: string): McpToolResult {
  return { text: `pitwall: the session wasn't resumed, so the message wasn't sent: ${error}`, isError: true };
}

/**
 * resume_session (W127): resumes a finished session with your message as its next turn, only for a
 * call approve just allowed, through pitwall's own resume (the Resume route's checks and limits).
 */
export function createResumeSessionTool(sources: SupervisorActionSources): McpTool {
  const own = () => sources.ownSessionIds?.() ?? new Set<string>();
  return {
    name: MCP_TOOLS.resumeSession,
    description:
      'Proposes resuming one of the user’s finished sessions, an interactive one that has ended or a background one that isn’t running, with a message it reads as its next turn, so work goes on in the session that has the context. id is its id from list_sessions (finished: true lists them); message is the whole text. A running session takes SendMessage instead. The user sees it as a draft in pitwall and may send it, edit the message, or decline; nothing is resumed until they do. Say in your reply what you propose and why before calling it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The session’s id, as list_sessions gives it.' },
        message: { type: 'string', description: `The whole message, at most ${SUPERVISOR_PROPOSAL_MAX.toLocaleString('en-US')} characters.` },
      },
      required: ['id', 'message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async call(args, context) {
      const meta = context?.meta?.[TOOL_USE_ID_META];
      const allowed = sources.approvals.takePass(typeof meta === 'string' ? meta : undefined, args);
      if (allowed === undefined) {
        return { text: 'pitwall: resuming this session wasn’t approved by the user, so nothing was resumed or sent.', isError: true };
      }
      if (sources.resumer === undefined) return notResumed('pitwall can’t resume sessions here.');
      // Checked once more, now: it may have started again, or its directory gone, since you approved it.
      const checked = await checkResume(allowed, sources.snapshots.latest(), own());
      if (!checked.ok) return notResumed(checked.error);
      const { session, text } = checked.value;
      const outcome = await sources.resumer.resume(session, text);
      const { result } = outcome;
      if (result.ok) {
        sources.approvals.handoff({ kind: 'resume', name: session.name, sessionId: session.sessionId, shortId: result.shortId });
        // The name is the session's, so it's untrusted (W129, the re-review's L3).
        return { text: JSON.stringify({ note: UNTRUSTED_NOTE, resumed: true, shortId: result.shortId, messageSent: true, untrusted: { name: plainField(session.name, NAME_MAX) } }) };
      }
      if (result.copyShortId !== undefined) {
        // Claude Code started a copy, and the message went to it (spike 011): said, never hidden.
        sources.approvals.handoff({ kind: 'resume', name: session.name, shortId: result.copyShortId, copy: true });
        return {
          text: JSON.stringify({
            resumed: false,
            copy: true,
            copyShortId: result.copyShortId,
            note: `The session was open in another Claude Code process, so Claude Code started a copy of its conversation as ${result.copyShortId}, and the message went to the copy, not to the session, which is unchanged. Tell the user, who can stop and remove the copy. ${UNTRUSTED_NOTE}`,
            untrusted: { name: plainField(session.name, NAME_MAX) },
          }),
        };
      }
      // It may have gone: never say it wasn't sent (#131's review).
      if (outcome.uncertain === 'copy') {
        return {
          text: JSON.stringify({
            resumed: false,
            copy: true,
            note: `The session was open in another Claude Code process, so Claude Code started a copy of its conversation, and the message went to the copy, not to the session, which is unchanged. pitwall didn't get the copy's id, so it can't link to it. Tell the user, who can find it in the list as a background session with no name, and stop and remove it. ${UNTRUSTED_NOTE}`,
            untrusted: { name: plainField(session.name, NAME_MAX) },
          }),
        };
      }
      if (outcome.uncertain === 'unknown') {
        return { text: `pitwall couldn't confirm the resume, so the message may or may not have been sent: ${result.error} Tell the user to check the session in the list before anything is tried again.`, isError: true };
      }
      if (outcome.running === true) return notResumed(`${result.error} It's running now: propose a message to it with SendMessage instead.`);
      const hint = result.hint === undefined ? '' : ` The user can run this to fix it: ${result.hint}`;
      return notResumed(`${result.error}${hint}`);
    },
  };
}

/** The id of the one running, listed session named `to`, ignoring case, as checkMessage() checked it. */
function recipientOf(to: string, snapshot: IndexSnapshot | undefined, own: ReadonlySet<string>): string | undefined {
  const key = nameKey(to);
  const found = (snapshot?.groups ?? []).flatMap((group) => group.sessions).filter((session) => messageable(session, own) && nameKey(session.name) === key);
  return found.length === 1 ? found[0]!.sessionId : undefined;
}

/** A decision's answer for the route, with its status. */
export type DecisionAnswer = { status: 200 } | { status: 400 | 404 | 409; error: string };

/** The note the supervisor reads before your next message, after you edited what it proposed. */
export function editNote(draft: ApprovalDraft, sent: string): string {
  if (draft.kind === 'message') return `the user edited your message to ${JSON.stringify(draft.to)} before it was sent. What was sent, before pitwall's line: ${JSON.stringify(sent)}`;
  // By its id, not its name, which is untrusted (W129, L3).
  if (draft.kind === 'resume') return `the user edited your message to the session ${draft.sessionId}, which pitwall resumed with it, before it was sent. What was sent: ${JSON.stringify(sent)}`;
  return `the user edited the first prompt of your new session in ${JSON.stringify(draft.directory)} before it started. What was sent: ${JSON.stringify(sent)}`;
}

/** The body of POST supervisorApprovalPath(id), checked: a SupervisorDecision and nothing else. */
export function parseDecision(body: unknown): SupervisorDecision | undefined {
  if (!isRecord(body)) return undefined;
  const keys = Object.keys(body).sort().join(',');
  if (body.decision === 'send' && keys === 'decision') return { decision: 'send' };
  if (body.decision === 'decline' && keys === 'decision') return { decision: 'decline' };
  if (body.decision === 'edit' && keys === 'decision,text' && typeof body.text === 'string') return { decision: 'edit', text: body.text };
  return undefined;
}

/**
 * Your decision on one card. Send and Edit check the call again, against the list as it is now: an
 * edit that isn't valid text is refused (400) and the card stays, for you to fix or decline; a call
 * that's no longer valid, such as to a session that has ended, is denied, saying why, and its card goes
 * (409). Nothing is allowed but what passed.
 */
export async function decide(sources: SupervisorActionSources, id: string, decision: SupervisorDecision): Promise<DecisionAnswer> {
  const pending = sources.approvals.begin(id);
  if (pending === undefined) return { status: 404, error: 'There is no such approval: it was answered, withdrawn or ran out of time.' };
  if (pending === 'busy') return { status: 409, error: 'This approval is being answered already.' };
  const { approval, input } = pending;
  const gone = (): DecisionAnswer => ({ status: 404, error: 'There is no such approval: it was answered, withdrawn or ran out of time.' });
  try {
    if (decision.decision === 'decline') {
      return sources.approvals.settle(id, { behavior: 'deny', message: DECLINED_MESSAGE }) ? { status: 200 } : gone();
    }
    const own = sources.ownSessionIds?.() ?? new Set<string>();
    if (approval.kind === 'message') {
      // Rebuilt from what the card showed, or your edit: never a field the card didn't show.
      const next = messageInput(approval.to, decision.decision === 'edit' ? decision.text : approval.text);
      if (decision.decision === 'edit') {
        const text = checkText(decision.text, SUPERVISOR_PROPOSAL_MAX, 'message');
        if (!text.ok) return { status: 400, error: text.error };
      }
      const message = checkMessage(next, sources.snapshots.latest(), own);
      const live = message.ok ? await checkLiveRecipient(message.value.to, sources.snapshots.latest(), sources.agents, own) : undefined;
      const checked = live !== undefined && !live.ok ? live : message;
      if (!checked.ok || (message.ok && message.value.to !== approval.to)) {
        const why = checked.ok ? 'it no longer names the same session' : checked.error;
        sources.approvals.settle(id, { behavior: 'deny', message: `pitwall checked this again when the user answered, and didn't send it: ${why}` });
        return { status: 409, error: `pitwall didn't send it: ${checked.ok ? 'it no longer names the same session.' : checked.error}` };
      }
      // What you approved, with pitwall's line after it (W138), added only now, after every check.
      if (!sources.approvals.settle(id, { behavior: 'allow', updatedInput: sentMessageInput(approval.to, decision.decision === 'edit' ? decision.text : approval.text) })) return gone();
      if (decision.decision === 'edit' && decision.text !== approval.text) sources.approvals.note(editNote(approval, decision.text));
      // So the panel can open the session it went to (W124): the one running session of that name, as checked.
      const recipient = recipientOf(approval.to, sources.snapshots.latest(), own);
      sources.approvals.handoff({ kind: 'message', name: approval.to, ...(recipient === undefined ? {} : { sessionId: recipient }) });
      return { status: 200 };
    }
    if (approval.kind === 'resume') {
      const text = decision.decision === 'edit' ? decision.text : approval.text;
      if (decision.decision === 'edit') {
        // An edit you can fix stays: a claude command's name too (W129, M1).
        const checkedText = checkResumeText(text);
        if (!checkedText.ok) return { status: 400, error: checkedText.error };
      }
      // Rebuilt from the card's own session, never a field the card didn't show.
      const checked = await checkResume(resumeInput(approval.sessionId, text), sources.snapshots.latest(), own);
      if (!checked.ok) {
        sources.approvals.settle(id, { behavior: 'deny', message: `pitwall checked this again when the user answered, and didn't resume it: ${checked.error}` });
        return { status: 409, error: `pitwall didn't resume it: ${checked.error}` };
      }
      const updatedInput = resumeInput(checked.value.session.sessionId, checked.value.text);
      // The pass first, so the call Claude Code makes once it reads the allow finds it.
      const pass = sources.approvals.grantPass(pending.toolUseId, updatedInput);
      if (!sources.approvals.settle(id, { behavior: 'allow', updatedInput })) {
        sources.approvals.revokePass(pass);
        return gone();
      }
      if (decision.decision === 'edit' && decision.text !== approval.text) sources.approvals.note(editNote(approval, decision.text));
      return { status: 200 };
    }
    // A new session.
    const prompt = decision.decision === 'edit' ? decision.text : approval.prompt;
    if (decision.decision === 'edit') {
      const text = checkText(prompt, MAX_PROMPT_LENGTH, 'first prompt');
      if (!text.ok) return { status: 400, error: text.error };
    }
    const checked = await checkSpawn({ ...input, prompt }, sources.snapshots.latest());
    if (!checked.ok) {
      // A prompt you can fix stays; a directory that has gone, or left the roots, can't be.
      if (decision.decision === 'edit' && (await checkSpawn(input, sources.snapshots.latest())).ok) return { status: 400, error: checked.error };
      sources.approvals.settle(id, { behavior: 'deny', message: `pitwall checked this again when the user answered, and didn't start it: ${checked.error}` });
      return { status: 409, error: `pitwall didn't start it: ${checked.error}` };
    }
    const updatedInput = spawnInput(checked.value);
    // The pass first, so the call Claude Code makes once it reads the allow finds it.
    const pass = sources.approvals.grantPass(pending.toolUseId, updatedInput);
    if (!sources.approvals.settle(id, { behavior: 'allow', updatedInput })) {
      sources.approvals.revokePass(pass);
      return gone();
    }
    if (decision.decision === 'edit' && decision.text !== approval.prompt) sources.approvals.note(editNote(approval, decision.text));
    return { status: 200 };
  } finally {
    sources.approvals.end(id);
  }
}
