// A session's sub-agents (W77; docs/design-system.md, 4: Sub-agents): fetching their list through the
// app's ApiClient (api.ts), which sends the apiKey, never the token; checking what came back against
// the contract (SubagentList in protocol.ts); and the words the Sub-agents tab, its rows and the
// session's own row use. A sub-agent's transcript comes through conversation.ts, as the session's does.

import { SUBAGENTS_MAX, subagentsPath, type SubagentList, type SubagentState, type SubagentSummary } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { failedResult, getRetryingBusy, isAgentId } from './conversation.js';
import { plainText } from './format.js';
import type { StatusBadge } from './sessions.js';

export type SubagentsResult =
  | { kind: 'ok'; list: SubagentList }
  /** The session isn't listed any more, or the server has no such route. */
  | { kind: 'not-found' }
  /** The connection was refused (WebSocket 4401). The app is already showing that the token was rejected. */
  | { kind: 'unauthorized' }
  /** Anything else, with the HTTP status when the server answered and the reason it gave, as for a conversation page. */
  | { kind: 'failed'; status?: number; error?: string };

/**
 * A session's sub-agents, through the app's ApiClient. A 429 is asked again once, after the wait the
 * server asked for, as a conversation page is: the two routes share the server's limit of four reads
 * at once. Never rejects.
 */
export async function getSubagents(api: ApiClient, sessionId: string, signal?: AbortSignal): Promise<SubagentsResult> {
  const result = await getRetryingBusy(api, subagentsPath(sessionId), signal);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'failed') return result.status === 404 ? { kind: 'not-found' } : failedResult(result);
  const list = asSubagentList(result.body, sessionId);
  return list ? { kind: 'ok', list } : { kind: 'failed' };
}

const STATES: ReadonlySet<SubagentState> = new Set(['running', 'done', 'failed', 'stopped', 'unknown']);

const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * The body as the SubagentList of `sessionId`, sorted as the tab shows it (sortSubagents), or
 * undefined when it isn't one. Entries that aren't well formed are dropped rather than failing the
 * list, and a state it doesn't know reads as 'unknown'.
 */
export function asSubagentList(body: unknown, sessionId: string): SubagentList | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { sessionId: id, subagents, truncated } = body as Record<string, unknown>;
  if (id !== sessionId || !Array.isArray(subagents)) return undefined;
  const entries = subagents.slice(0, SUBAGENTS_MAX).flatMap((entry) => asSubagent(entry) ?? []);
  return { sessionId, subagents: sortSubagents(entries), truncated: truncated === true };
}

function asSubagent(value: unknown): SubagentSummary | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { agentId, description, agentType, background, state, startedBy, startedAt, lastActivityAt, toolCalls } = value as Record<string, unknown>;
  if (!isAgentId(agentId) || typeof description !== 'string' || typeof state !== 'string') return undefined;
  if (typeof toolCalls !== 'number' || !Number.isInteger(toolCalls) || toolCalls < 0) return undefined;
  const subagent: SubagentSummary = { agentId, description, state: STATES.has(state as SubagentState) ? (state as SubagentState) : 'unknown', toolCalls };
  if (typeof agentType === 'string' && agentType.trim() !== '') subagent.agentType = agentType;
  if (typeof background === 'boolean') subagent.background = background;
  if (isAgentId(startedBy) && startedBy !== agentId) subagent.startedBy = startedBy;
  if (isTime(startedAt)) subagent.startedAt = startedAt;
  if (isTime(lastActivityAt)) subagent.lastActivityAt = lastActivityAt;
  return subagent;
}

/**
 * Running ones first, then the newest started first, one with no start time last, as the contract
 * orders them. The server sorts them already; this keeps the tab's order whatever arrives, and keeps
 * the server's order among equals.
 */
export function sortSubagents(subagents: readonly SubagentSummary[]): SubagentSummary[] {
  const started = (subagent: SubagentSummary) => (subagent.startedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(subagent.startedAt));
  return subagents
    .map((subagent, index) => ({ subagent, index }))
    .sort((a, b) => {
      const running = Number(b.subagent.state === 'running') - Number(a.subagent.state === 'running');
      if (running !== 0) return running;
      const newer = started(b.subagent) - started(a.subagent);
      return newer !== 0 && !Number.isNaN(newer) ? newer : a.index - b.index;
    })
    .map(({ subagent }) => subagent);
}

/** The words the contract uses when a sub-agent was started with no description. */
export const NO_DESCRIPTION = 'Sub-agent';

/** A sub-agent's description as text: escapes and control characters out, and "Sub-agent" when nothing is left. */
export function subagentName(description: string): string {
  const text = plainText(description).trim();
  return text === '' ? NO_DESCRIPTION : text;
}

/**
 * A sub-agent's state badge (4: Badges), with the session states' looks: Running as Working is, with
 * its dot; Done, Failed and Stopped as a session's are; and nothing when its state is unknown.
 */
export function subagentBadge(state: SubagentState): StatusBadge | undefined {
  switch (state) {
    case 'running':
      return { status: 'working', label: 'Running', look: 'subtle-info', dot: true };
    case 'done':
      return { status: 'done', label: 'Done', look: 'subtle-success' };
    case 'failed':
      return { status: 'failed', label: 'Failed', look: 'subtle-danger' };
    case 'stopped':
      return { status: 'stopped', label: 'Stopped', look: 'subtle-neutral' };
    case 'unknown':
      return undefined;
  }
}

const count = (n: number) => n.toLocaleString('en-US');

/** "No tool calls", "1 tool call", "14 tool calls" (5: Labels, Counts). */
export function toolCallsText(n: number): string {
  if (n === 0) return 'No tool calls';
  return `${count(n)} ${n === 1 ? 'tool call' : 'tool calls'}`;
}

/** The session row's quiet count while any run (SessionSummary.subagentsRunning): "1 sub-agent running", "2 sub-agents running". */
export function runningText(n: number): string {
  return `${count(n)} ${n === 1 ? 'sub-agent' : 'sub-agents'} running`;
}

/** How many the tab says there are: "6", or "200+" when the oldest were left out. */
export function tabCount(list: SubagentList): string {
  return `${count(list.subagents.length)}${list.truncated ? '+' : ''}`;
}

/** What a nested one's row says started it: the sub-agent's description, or "another sub-agent" when it isn't in the list. */
export function startedByName(list: readonly SubagentSummary[], agentId: string): string {
  const parent = list.find((subagent) => subagent.agentId === agentId);
  return parent ? subagentName(parent.description) : 'another sub-agent';
}
