// A session's context (W133): how many tokens its newest call carried (SessionSummary.contextTokens),
// and how loud to be about it. Every call sends the whole context again, so a big one costs on every
// turn; over CONTEXT_WARN_TOKENS it's time to hand off or compact, and over CONTEXT_HIGH_TOKENS it's
// overdue. The thresholds are the protocol's, so the server and the page agree.

import { CONTEXT_HIGH_TOKENS, CONTEXT_WARN_TOKENS } from '../../src/shared/protocol.js';
import type { BadgeLook } from './sessions.js';

export type ContextLevel = 'ok' | 'warn' | 'high';

export function contextLevel(tokens: number): ContextLevel {
  if (tokens > CONTEXT_HIGH_TOKENS) return 'high';
  if (tokens > CONTEXT_WARN_TOKENS) return 'warn';
  return 'ok';
}

/** The badge's look at each level: warning, then danger. Below the first, no badge. */
export const CONTEXT_LOOKS: Record<Exclude<ContextLevel, 'ok'>, BadgeLook> = {
  warn: 'subtle-warning',
  high: 'subtle-danger',
};

/**
 * Tokens, short: "850", "85K", "412K", "1.2M". Rounded down, so a number over a threshold never
 * shows below it, and one under it never shows above it.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.floor(tokens)));
  if (tokens < 1_000_000) return `${Math.floor(tokens / 1000)}K`;
  return `${(Math.floor(tokens / 100_000) / 10).toFixed(1)}M`;
}

/** What the level means, after the number, for screen readers and tooltips: ", over 200K". Empty below it. */
export function levelText(level: ContextLevel): string {
  if (level === 'high') return `, over ${formatTokens(CONTEXT_HIGH_TOKENS)}`;
  if (level === 'warn') return `, over ${formatTokens(CONTEXT_WARN_TOKENS)}`;
  return '';
}

/** The row badge's tooltip, on hover: the number in full and what to do. */
export function contextHint(tokens: number): string {
  return `Its last call carried ${tokens.toLocaleString('en-US')} tokens of context${levelText(contextLevel(tokens))}. Every call sends all of it again: hand it off to a new session, or compact it.`;
}

/** The session view's info button: what the number is, and when it's flagged. */
export const CONTEXT_INFO = `The tokens of context its last call carried, from its transcript: everything the model read again, cached or not. Flagged over ${formatTokens(CONTEXT_WARN_TOKENS)}, and in red over ${formatTokens(CONTEXT_HIGH_TOKENS)}.`;

/** The same, when it can't be read. */
export const CONTEXT_UNAVAILABLE_INFO =
  "pitwall couldn't read its last call's usage from its transcript, as before its first reply, or when the transcript isn't found.";
