// A hand-off (W168): the `handoff` skill's last step proposes a new session as a spin-off block (W163)
// whose prompt starts with this line, naming the session it carries on from. Pure, no Node or DOM, so
// the server and the web UI use the same rule.

import { describeCodePoint, hiddenCharacter } from './hiddenText.js';
import { SPAWN_PROMPT_MAX, type SpinOff } from './protocol.js';

/** The line a hand-off's prompt starts with. */
export const continuesLine = (sessionId: string): string => `Continues session ${sessionId}.`;

/**
 * Whether `prompt` is the hand-off of session `sessionId`: it starts with that session's own
 * continuesLine(). A proposal that names another session, or none, is an ordinary spin-off and
 * gets Start only.
 */
export function isHandoffOf(sessionId: string, prompt: string): boolean {
  const line = continuesLine(sessionId);
  if (!prompt.startsWith(line)) return false;
  const next = prompt[line.length];
  return next === undefined || next === '\n' || next === ' ';
}

/**
 * Whether the last non-whitespace character of `prompt` is a backslash. Typed into Claude Code's input,
 * backslash then Enter is its newline escape, so such a prompt would sit unsent (W168's review, F2).
 */
export const endsWithBackslash = (prompt: string): boolean => prompt.trimEnd().endsWith('\\');

/**
 * Whether `spinOff` is `sessionId`'s own hand-off (W168, W210): a proposal that starts with its own
 * continuesLine(), or one the server took from the session's recap (source 'recap'), which it only sets
 * for the session's own newest message. A proposal that names another session is an ordinary spin-off.
 */
export function isOwnHandoff(sessionId: string, spinOff: SpinOff | undefined): boolean {
  return spinOff?.kind === 'proposal' && (spinOff.source === 'recap' || isHandoffOf(sessionId, spinOff.prompt));
}

/**
 * Why `prompt` can't be typed into a job, in pitwall's words, or undefined when it can. The hidden
 * character rule is W163's own (hiddenCharacter()), not a second one. Shared by Clear and continue
 * (src/server/clearAndContinue.ts), which checks it again before each run, and by a recap's hand-off
 * (src/recaps/handoff.ts, W210), which keeps nothing that fails it.
 */
export function typedPromptProblem(prompt: string): string | undefined {
  if (prompt.trim() === '') return 'The prompt is empty.';
  if (prompt.length > SPAWN_PROMPT_MAX) return `The prompt is over ${SPAWN_PROMPT_MAX.toLocaleString('en-US')} characters.`;
  const hidden = hiddenCharacter(prompt);
  if (hidden !== undefined) return `The prompt has a character that doesn’t show as itself on screen (${describeCodePoint(hidden.codePoint)}), so pitwall won’t type it.`;
  const first = prompt.trimStart()[0];
  if (first === '/') return 'The prompt starts with /, so Claude Code would run it as a slash command. Start a new session instead.';
  if (first === '!') return 'The prompt starts with !, so Claude Code would run it as a shell line. Start a new session instead.';
  if (endsWithBackslash(prompt)) return 'The prompt ends with \\, which Claude Code reads with Enter as a new line, so it would sit unsent in the input box. Start a new session instead.';
  return undefined;
}
