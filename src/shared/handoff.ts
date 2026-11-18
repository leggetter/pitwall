// A hand-off (W168): the `handoff` skill's last step proposes a new session as a spin-off block (W163)
// whose prompt starts with this line, naming the session it carries on from. Pure, no Node or DOM, so
// the server and the web UI use the same rule.

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
