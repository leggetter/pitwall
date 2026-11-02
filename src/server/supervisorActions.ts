// What the supervisor can do, behind your click (M5, W115; spike 009, finding 6; D4): its messages
// to sessions (Claude Code's SendMessage) and new sessions (spawn_session, on pitwall's MCP server),
// each held by Claude Code until the permission prompt tool, approve, answers.
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
//
// The checks, before a card shows and again on Send or Edit:
//
//   a message       to: exactly the name of one running session pitwall lists, never an ended one,
//                   one whose name another running one shares, or pitwall's own (relay, recap
//                   calls, the supervisor); only the fields pitwall knows; a plain message, no idle
//                   notices; a `content` preview that is the message or its start, never other text;
//                   text not blank, no NUL, at most SUPERVISOR_MESSAGE_MAX
//   a new session   directory: an existing directory under a root, by its real path, as New session
//                   requires (checkDirectory()); name: NAME_PATTERN; prompt: not blank, no NUL, at
//                   most MAX_PROMPT_LENGTH, not just a claude command; no other field
//
// The recipient gate (src/supervisor/gate.ts) checks a message's `to` again before Claude Code asks,
// against recipientNames(), as defence in depth.
//
// The text on a card is the model's, so the page shows it as plain text, and what goes is exactly
// what the card showed, or your edit: pitwall adds nothing to it (D25's rule: a prompt pitwall fills
// in goes as typed by you, and here you read it, whole, before it goes).
import { isRecord } from '../index/guards.js';
import { MCP_TOOLS, SUPERVISOR_MESSAGE_MAX, type IndexSnapshot, type SessionSummary, type SupervisorDecision } from '../shared/protocol.js';
import { DECLINED_MESSAGE, type ApprovalDraft, type ApprovalQueue, type PermissionAnswer } from '../supervisor/approvals.js';
import { isPreviewOf, KNOWN_INPUT_FIELDS, OWN_NAMES } from '../supervisor/supervisorGateHook.mjs';
import { mcpToolName } from '../supervisor/prompt.js';
import { MAX_PROMPT_LENGTH, validateSpawnRequest, type SpawnRunner, type ValidSpawn } from './actions.js';
import type { McpTool, McpToolResult } from './mcp.js';
import { nameKey } from './relayPrompt.js';

/** The tools approve may allow, as Claude Code names them. */
export const MESSAGE_TOOL = 'SendMessage';
export const SPAWN_TOOL = mcpToolName(MCP_TOOLS.spawnSession);

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
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** Whether a listed session can be messaged: running, not ended or finished, not pitwall's own. */
function messageable(session: SessionSummary, own: ReadonlySet<string>): boolean {
  if (own.has(session.sessionId) || OWN_NAMES.has(nameKey(session.name.trim()))) return false;
  return session.alive && session.ended !== true && !session.finished;
}

/**
 * The names the supervisor may message, for the recipient gate: each running, listed session's
 * name that no other running one shares, ignoring case, never pitwall's own.
 */
export function recipientNames(snapshot: IndexSnapshot | undefined, own: ReadonlySet<string> = new Set()): string[] {
  if (snapshot === undefined) return [];
  const byKey = new Map<string, string[]>();
  for (const group of snapshot.groups) {
    for (const session of group.sessions) {
      if (!messageable(session, own)) continue;
      const key = nameKey(session.name);
      byKey.set(key, [...(byKey.get(key) ?? []), session.name]);
    }
  }
  return [...byKey.values()].filter((names) => names.length === 1).map((names) => names[0]!).sort();
}

/** The text of a message or a prompt, or why it isn't one. */
function checkText(text: unknown, max: number, what: string): Checked<string> {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: `The ${what} is empty.` };
  if (text.length > max) return { ok: false, error: `The ${what} can be at most ${max.toLocaleString('en-US')} characters.` };
  if (text.includes('\u0000')) return { ok: false, error: `The ${what} contains a NUL character.` };
  return { ok: true, value: text };
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
  const text = checkText(input.message, SUPERVISOR_MESSAGE_MAX, 'message');
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

/** spawn_session's arguments, checked as New session checks a request: the directory by its real path under a root. */
export async function checkSpawn(input: unknown, snapshot: IndexSnapshot | undefined): Promise<Checked<ValidSpawn>> {
  if (!isRecord(input)) return { ok: false, error: 'The call has no arguments.' };
  for (const key of Object.keys(input)) {
    if (key !== 'directory' && key !== 'prompt' && key !== 'name') return { ok: false, error: `Unknown argument: ${key.slice(0, 40)}.` };
  }
  const prompt = checkText(input.prompt, MAX_PROMPT_LENGTH, 'first prompt');
  if (!prompt.ok) return prompt;
  if (snapshot === undefined) return { ok: false, error: 'pitwall hasn’t listed the sessions yet, so it doesn’t know the roots.' };
  const validation = await validateSpawnRequest({ cwd: input.directory, prompt: prompt.value, ...(input.name === undefined ? {} : { name: input.name }) }, snapshot.roots);
  if (!validation.ok) return { ok: false, error: validation.error };
  return { ok: true, value: validation.spawn };
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
      if (toolName !== MESSAGE_TOOL && toolName !== SPAWN_TOOL) {
        return deny('the supervisor can only propose messages to sessions and new sessions. Nothing else was asked of the user.');
      }
      if (typeof toolUseId !== 'string' || !TOOL_USE_ID.test(toolUseId)) return deny('this permission request has no tool_use_id pitwall can use, so it was denied.');
      let draft: ApprovalDraft;
      let runInput: Record<string, unknown>;
      if (toolName === MESSAGE_TOOL) {
        const checked = checkMessage(input, sources.snapshots.latest(), own());
        if (!checked.ok) return deny(`${checked.error} Nothing was shown to the user.`);
        draft = { kind: 'message', to: checked.value.to, text: checked.value.text };
        runInput = messageInput(checked.value.to, checked.value.text);
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
      return { text: JSON.stringify({ started: true, name: outcome.result.name, shortId: outcome.result.shortId, directory: checked.value.cwd }) };
    },
  };
}

/** A decision's answer for the route, with its status. */
export type DecisionAnswer = { status: 200 } | { status: 400 | 404 | 409; error: string };

/** The note the supervisor reads before your next message, after you edited what it proposed. */
export function editNote(draft: ApprovalDraft, sent: string): string {
  if (draft.kind === 'message') return `the user edited your message to ${JSON.stringify(draft.to)} before it was sent. What was sent: ${JSON.stringify(sent)}`;
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
        const text = checkText(decision.text, SUPERVISOR_MESSAGE_MAX, 'message');
        if (!text.ok) return { status: 400, error: text.error };
      }
      const checked = checkMessage(next, sources.snapshots.latest(), own);
      if (!checked.ok || checked.value.to !== approval.to) {
        const why = checked.ok ? 'it no longer names the same session' : checked.error;
        sources.approvals.settle(id, { behavior: 'deny', message: `pitwall checked this again when the user answered, and didn't send it: ${why}` });
        return { status: 409, error: `pitwall didn't send it: ${checked.ok ? 'it no longer names the same session.' : checked.error}` };
      }
      if (!sources.approvals.settle(id, { behavior: 'allow', updatedInput: next })) return gone();
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
