// A hand-off written by hand (W210, a hand-off shows as Handed off): a session ended its newest reply by
// handing itself over to free up context, without the handoff skill, so it has no `spin-off` block (W163,
// W168). The recap quotes the prompt the next session starts from (SessionRecap.handoff). The quote is the
// model's, so it is only text to check: it becomes a proposal, and so a Clear and continue card, only while
//
//   - the recap is pitwall's own and current: nothing newer than the transcript it covers (not `stale`);
//   - the session is running or finished but not stale or ended, has no spin-off block of its own, and its
//     turn has ended;
//   - the quote is the whole of an inline code span or a fenced code block that ends within the last
//     RECAP_HANDOFF_TAIL characters of the session's newest assistant message, which only the server reads
//     (SessionFacts.assistantEnding, with no prompt after it). The hand-off ends the message, as W163's
//     block must: a quote earlier in it, or text quoted as prose (a fetched page's line in a blockquote,
//     say), never counts (W210's security review, F1); and
//   - it is at most RECAP_HANDOFF_MAX characters and passes typedPromptProblem(), the rule Clear and
//     continue types by: not blank, no leading / or !, no hidden, control, zero-width or bidi character,
//     no trailing backslash.
//
// A newer message or a prompt of yours changes the transcript, so the check fails and the card goes. The
// route that types it works this out again from the current facts (RecapEngine.handoffOf()).
import { createHash } from 'node:crypto';
import { typedPromptProblem } from '../shared/handoff.js';
import type { SessionRecap, SessionSummary, SpinOff } from '../shared/protocol.js';

/** The longest recap-quoted hand-off pitwall offers. Real ones, such as `Read <path>/NOW.md`, are short. */
export const RECAP_HANDOFF_MAX = 4_096;
/** How near the end of the message the quote's code span or block must end. */
export const RECAP_HANDOFF_TAIL = 1_500;

const FENCE_BEFORE = /(?:^|\n)[ ]{0,3}(?:`{3,}|~{3,})[^\n`]*\n$/;
const FENCE_AFTER = /^\n[ ]{0,3}(?:`{3,}|~{3,})[ \t]*(?:\n|$)/;

/**
 * Whether `quoted` is the whole of an inline code span (`` `quoted` ``) or of a fenced code block in
 * `message`, ending within its last RECAP_HANDOFF_TAIL characters. Linear in the tail it searches.
 */
export function endsAsCode(message: string, quoted: string): boolean {
  const text = message.trimEnd();
  const from = Math.max(0, text.length - RECAP_HANDOFF_TAIL - quoted.length - 1);
  for (let at = text.indexOf(quoted, from); at !== -1; at = text.indexOf(quoted, at + 1)) {
    const end = at + quoted.length;
    if (end < text.length - RECAP_HANDOFF_TAIL) continue;
    const before = text.slice(Math.max(0, at - 200), at);
    const after = text.slice(end, end + 200);
    const inline = !quoted.includes('`') && !quoted.includes('\n') && before.endsWith('`') && !before.endsWith('``') && after.startsWith('`') && !after.startsWith('``');
    if (inline || (FENCE_BEFORE.test(before) && FENCE_AFTER.test(after))) return true;
  }
  return false;
}

/** The proposal for `session`'s recap-quoted hand-off, or undefined while any condition above fails. Never throws. */
export function recapHandoff(session: SessionSummary, recap: SessionRecap | undefined, assistantEnding: string | undefined): SpinOff | undefined {
  const quoted = recap?.handoff;
  if (recap === undefined || quoted === undefined || assistantEnding === undefined) return undefined;
  if (recap.source !== 'pitwall' || recap.stale === true) return undefined;
  if (session.spinOff !== undefined || session.stale || session.ended === true) return undefined;
  // A failed or stopped job isn't handed off, and Clear and continue would refuse it (F6).
  if (session.state === 'failed' || session.state === 'stopped') return undefined;
  // As a spin-off block holds (askedHolds(), src/index/summaries.ts): not while a dialog waits (F5).
  if (session.status === 'waiting' || !(session.turnEnded === true || session.state === 'done')) return undefined;
  if (quoted.trim() === '' || quoted.length > RECAP_HANDOFF_MAX || typedPromptProblem(quoted) !== undefined) return undefined;
  if (!endsAsCode(assistantEnding, quoted)) return undefined;
  const key = createHash('sha256').update(`recap-handoff\n${quoted}`).digest('hex').slice(0, 16);
  return { kind: 'proposal', key, folder: session.cwd, prompt: quoted, source: 'recap' };
}
