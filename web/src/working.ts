// The working line at the end of the conversation (W102; docs/design-system.md, 4: Conversation). While
// a session works: "Working", how long its turn has run, and its current step, from the newest page.
// While it waits on you: that, and where to answer. Everything here is what the snapshot and the
// conversation already carry: Claude Code's status and Needs you, and the entries on screen. Nothing
// is stored, and nothing new goes into the snapshot (D14).

import type { ConversationEntry, SessionSummary } from '../../src/shared/protocol.js';
import { plainText, shortenHome } from './format.js';
import { statusBadge } from './sessions.js';

/**
 * How often the Conversation tab fetches its newest page while the session works (W102), as well as
 * whenever its activity time moves. The snapshot polls every 5 s, and nothing is written to the
 * transcript during a long tool call or a long think, so without this the step would be up to 5 s
 * old. 2 s keeps a new step within about two seconds, while the timer ticks every second on its own.
 * The server reads a page backwards from the end of the transcript, until 50 entries or 8 MiB: on
 * the 12 largest transcripts on the Mac it was measured on (40 to 172 MiB), 0.5 to 5.8 MiB and 2 to
 * 25 ms a page, so one open view of a working session costs the server at most about 1.3% of a core
 * (25 ms every 2 s), and mostly under 0.2%.
 * One request at a time: the next waits until the last has answered.
 */
export const WORKING_POLL_MS = 2_000;

/** The longest step shown, in characters, before it's cut with an ellipsis. CSS cuts it to one line too. */
export const STEP_MAX = 120;

/** What the screen reader hears as a turn starts, and as it ends (6.1, item 9). */
export const WORKING_ANNOUNCEMENT = 'Claude is working';
export const FINISHED_ANNOUNCEMENT = 'Finished';

/** The step while no tool call is waiting on its result: Claude is writing, or thinking. */
export const THINKING = 'Thinking';

/**
 * Where the session is in its turn, for the working line:
 * - `working`: Claude Code says it's busy, or a background job is working, and the newest page doesn't
 *   say its turn has ended. A plugin's monitor can keep Claude Code's status at busy with no turn
 *   running (spike 007, finding 6), so the transcript's own mark of a turn's end wins (turnEnded).
 * - `waiting`: it's waiting on you: the solid Waiting or Blocked badge (statusBadge(), needsYou).
 * - `idle`: anything else, and always for a session that isn't running, has ended, or is no longer
 *   listed, whose state is what it showed last.
 */
export type TurnMode = 'idle' | 'working' | 'waiting';

export function turnMode(session: SessionSummary, listed: boolean, turnEnded: boolean | undefined): TurnMode {
  if (!listed || session.ended === true || !session.alive) return 'idle';
  const { status } = statusBadge(session);
  if (status === 'waiting' || status === 'blocked') return 'waiting';
  if ((status === 'busy' || status === 'working') && turnEnded !== true) return 'working';
  return 'idle';
}

/** What the working line shows. */
export type WorkingLineState =
  | { mode: 'idle' }
  | {
      mode: 'working';
      /** When the turn started, an ISO time, or undefined when that isn't known: then there's no timer. */
      since?: string;
      /**
       * True when what began the turn is further back than the entries shown: `since` is then the
       * oldest entry's time, and the turn has run at least that long ("12m+").
       */
      atLeast?: boolean;
      /** The current step, a short phrase on one line. */
      step: string;
    }
  | {
      mode: 'waiting';
      /** "Waiting for you", with what for, as Claude Code says: "Waiting for you: permission prompt". */
      text: string;
      /** Where to answer, or undefined where pitwall can't say, as for a background session it can't attach. */
      where?: string;
    };

/** Claude's own entries in a turn: its text, its tool calls, its messages to pitwall and a question it asked. */
const CLAUDE_SIDE: ReadonlySet<ConversationEntry['kind']> = new Set(['assistant', 'tool', 'to-pitwall', 'question']);

/**
 * The index of the entry that began the newest turn: the newest one before the run of Claude's own
 * entries at the end, skipping what came mid-turn (`midTurn`, W99's prompts typed while Claude
 * worked, messages, reports and notifications, a compaction, an API error), which don't start a turn.
 * So it's your prompt, a message from another session, or a notice that started one, such as a task
 * notification or a slash command. -1 when every entry shown is part of the turn.
 */
export function turnStartIndex(entries: readonly ConversationEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as ConversationEntry;
    if (CLAUDE_SIDE.has(entry.kind) || entry.midTurn === true) continue;
    return i;
  }
  return -1;
}

const isTime = (at: string | undefined): at is string => at !== undefined && Number.isFinite(Date.parse(at));

/**
 * When the newest turn started: the time of the entry that began it. When that's further back than
 * what's shown, the oldest entry's time, as at least how long it's run, while there's more before it
 * (`more`, a Load earlier cursor); at the transcript's start, the oldest entry is where it began.
 */
export function turnStarted(entries: readonly ConversationEntry[], more: boolean): { since?: string; atLeast: boolean } {
  const index = turnStartIndex(entries);
  if (index >= 0) {
    const at = entries[index]?.at;
    return isTime(at) ? { since: at, atLeast: false } : { atLeast: false };
  }
  const oldest = entries.find((entry) => isTime(entry.at))?.at;
  return oldest === undefined ? { atLeast: false } : { since: oldest, atLeast: more };
}

const isOpen = (entry: ConversationEntry) => entry.kind === 'tool' && entry.toolError === undefined;
const isAgentCall = (entry: ConversationEntry) => entry.toolName === 'Agent' || entry.toolName === 'Task';

/** A tool's MCP server and tool, from Claude Code's `mcp__<server>__<tool>`. */
const MCP_NAME = /^mcp__(.+?)__(.+)$/;

/** A file's path as the step shows it: from the session's directory when it's inside it, else with home as ~. */
function shownPath(path: string, cwd: string): string {
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(base) && path.length > base.length ? path.slice(base.length) : shortenHome(path);
}

/** On one line, without control characters, at most STEP_MAX characters. */
function oneLine(text: string): string {
  const line = plainText(text).replace(/\s+/g, ' ').trim();
  return line.length <= STEP_MAX ? line : `${line.slice(0, STEP_MAX - 1).trimEnd()}…`;
}

/**
 * The phrase for a tool call that's waiting on its result, from the line the conversation shows for
 * it (the server's one-line summary, `Bash: npm test`): "Running Bash: npm test"; "Editing
 * src/app.ts", "Writing …" and "Reading …", from the session's directory; "Waiting for 2 sub-agents"
 * for Agent or Task calls, counting each one still out; "Calling <server> <tool>" for an MCP tool.
 */
export function stepPhrase(call: ConversationEntry, open: readonly ConversationEntry[], cwd: string): string {
  const name = call.toolName ?? '';
  if (isAgentCall(call)) {
    const count = open.filter(isAgentCall).length;
    return `Waiting for ${count} ${count === 1 ? 'sub-agent' : 'sub-agents'}`;
  }
  const mcp = MCP_NAME.exec(name);
  if (mcp) return oneLine(`Calling ${mcp[1]} ${mcp[2]}`);
  const lead = `${name}: `;
  const detail = name !== '' && call.text.startsWith(lead) ? call.text.slice(lead.length).trim() : '';
  if (detail !== '') {
    if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return oneLine(`Editing ${shownPath(detail, cwd)}`);
    if (name === 'Write') return oneLine(`Writing ${shownPath(detail, cwd)}`);
    if (name === 'Read') return oneLine(`Reading ${shownPath(detail, cwd)}`);
  }
  return oneLine(`Running ${call.text}`);
}

/**
 * The current step of the turn that began at `start` (turnStartIndex()): the newest tool call since
 * then with no result yet, as a phrase (stepPhrase()), or "Thinking" with none. A call from an
 * earlier turn that never got a result, as an interrupted one, doesn't count.
 */
export function currentStep(entries: readonly ConversationEntry[], start: number, cwd: string): string {
  const open = entries.slice(start + 1).filter(isOpen);
  const last = open[open.length - 1];
  return last === undefined ? THINKING : stepPhrase(last, open, cwd);
}

/**
 * What waiting says: "Waiting for you", with Claude Code's own words on what for, and where to answer:
 * an interactive session in its terminal, a background one in its Terminal tab, which attaches.
 */
export function waitingLine(session: SessionSummary, canAttach: boolean): Extract<WorkingLineState, { mode: 'waiting' }> {
  const what = session.waitingFor === undefined ? '' : plainText(session.waitingFor).trim();
  const line: Extract<WorkingLineState, { mode: 'waiting' }> = { mode: 'waiting', text: what === '' ? 'Waiting for you' : `Waiting for you: ${what}` };
  if (session.kind === 'interactive') line.where = 'Answer it in its terminal.';
  else if (canAttach) line.where = 'Answer it in its Terminal tab.';
  return line;
}

/** What the screen reader hears for a waiting line: its two lines as one. */
export function waitingAnnouncement(line: Extract<WorkingLineState, { mode: 'waiting' }>): string {
  return line.where === undefined ? `${line.text}.` : `${line.text}. ${line.where}`;
}

/**
 * The working line for a session in `mode`, from the entries shown (`entries`, oldest first, and `more`
 * when Load earlier has more before them).
 */
export function workingLineState(
  mode: TurnMode,
  session: SessionSummary,
  canAttach: boolean,
  entries: readonly ConversationEntry[],
  more: boolean,
): WorkingLineState {
  if (mode === 'idle') return { mode: 'idle' };
  if (mode === 'waiting') return waitingLine(session, canAttach);
  const start = turnStartIndex(entries);
  const { since, atLeast } = turnStarted(entries, more);
  const line: WorkingLineState = { mode: 'working', step: currentStep(entries, start, session.cwd) };
  if (since !== undefined) line.since = since;
  if (atLeast) line.atLeast = true;
  return line;
}

/**
 * How long the turn has run: "45s", "2m 14s", "1h 5m". At least that long (`atLeast`), as when the
 * turn began before the entries shown: "45s+", "12m+", "1h 5m+", whole minutes, since the bound isn't
 * exact. A time in the future, from a clock that's off, is "0s".
 */
export function elapsedText(ms: number, atLeast = false): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m${atLeast ? '+' : ''}`;
  if (minutes > 0) return atLeast ? `${minutes}m+` : `${minutes}m ${seconds}s`;
  return `${seconds}s${atLeast ? '+' : ''}`;
}
