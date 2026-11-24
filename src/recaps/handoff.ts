// A hand-off written by hand (W210, a hand-off shows as Handed off): a session ended its newest reply by
// handing itself over to free up context, without the handoff skill, so it has no `spin-off` block (W163,
// W168). The recap quotes the prompt the next session starts from (SessionRecap.handoff). The quote is the
// model's, so it is only text to check: it becomes a proposal, and so a Clear and continue card, only while
//
//   - the recap is pitwall's own and current: nothing newer than the transcript it covers (not `stale`);
//   - the session is running or finished but not stale or ended, has no spin-off block of its own, and its
//     turn has ended;
//   - the quote appears word for word in the end of the session's newest assistant message, which only
//     the server reads (SessionFacts.assistantEnding, with no prompt after it); and
//   - it passes typedPromptProblem(), the rule Clear and continue types by: not blank, under the length
//     cap, no leading / or !, no hidden, control, zero-width or bidi character, no trailing backslash.
//
// A newer message or a prompt of yours changes the transcript, so the check fails and the card goes. The
// route that types it works this out again from the current facts (RecapEngine.handoffOf()).
import { createHash } from 'node:crypto';
import { typedPromptProblem } from '../shared/handoff.js';
import type { SessionRecap, SessionSummary, SpinOff } from '../shared/protocol.js';

/** The proposal for `session`'s recap-quoted hand-off, or undefined while any condition above fails. Never throws. */
export function recapHandoff(session: SessionSummary, recap: SessionRecap | undefined, assistantEnding: string | undefined): SpinOff | undefined {
  const quoted = recap?.handoff;
  if (recap === undefined || quoted === undefined || assistantEnding === undefined) return undefined;
  if (recap.source !== 'pitwall' || recap.stale === true) return undefined;
  if (session.spinOff !== undefined || session.stale || session.ended === true) return undefined;
  if (!(session.turnEnded === true || session.state === 'done')) return undefined;
  if (quoted.trim() === '' || typedPromptProblem(quoted) !== undefined) return undefined;
  if (!assistantEnding.includes(quoted)) return undefined;
  const key = createHash('sha256').update(`recap-handoff\n${quoted}`).digest('hex').slice(0, 16);
  return { kind: 'proposal', key, folder: session.cwd, prompt: quoted, source: 'recap' };
}
