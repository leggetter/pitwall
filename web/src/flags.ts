// Flag: "It doesn't need me" (W153), the page's side. A session in Needs you that's running can be
// flagged from its row's flag toggle or its view's actions menu. The server logs it, leaves it out of
// Needs you until what it needs changes (SessionSummary.flagged, which every page and the supervisor
// see), and asks the session through the relay what, if anything, it needs. Its row keeps its badge,
// outlined, and says "You flagged this"; pressing the toggle again, the menu's Undo flag or the
// toast's Undo puts it back. A snooze (W154) is the other action: right, but not now.
import { flagPath, unflagPath, type FlagFrom, type FlagResult, type RelayResult, type SessionSummary } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { plainText } from './format.js';
import { STATUS_TEXT } from './relay.js';

/** What a flag came to. */
export type FlagOutcome =
  /** Flagged. `asked` is the relay's outcome, absent when it was already flagged and nothing was sent. */
  | { kind: 'flagged'; asked?: RelayResult }
  /** Not flagged, with why, in pitwall's words. */
  | { kind: 'failed'; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A FlagResult in `body`, or undefined. */
export function asFlagResult(body: unknown): FlagResult | undefined {
  if (!isRecord(body)) return undefined;
  if (body.ok === false) return typeof body.error === 'string' ? { ok: false, error: body.error } : undefined;
  if (body.ok !== true) return undefined;
  if (body.asked === undefined) return { ok: true };
  if (!isRecord(body.asked) || typeof body.asked.status !== 'string' || !(body.asked.status in STATUS_TEXT)) return undefined;
  const detail = typeof body.asked.detail === 'string' ? body.asked.detail : undefined;
  return { ok: true, asked: { status: body.asked.status as RelayResult['status'], ...(detail === undefined ? {} : { detail }) } };
}

/** Flags `session` for the reason the page shows. Never rejects. */
export async function flagSession(api: ApiClient, session: SessionSummary, from: FlagFrom): Promise<FlagOutcome> {
  const reason = session.needsYou?.reason;
  if (reason === undefined) return { kind: 'failed', error: "It doesn't need you now, so there's nothing to flag." };
  const result = await api.post(flagPath(session.sessionId), { reason, from });
  const body = result.kind === 'unauthorized' ? undefined : asFlagResult(result.body);
  if (body === undefined) return { kind: 'failed', error: result.kind === 'unauthorized' ? "pitwall didn't accept the page's key. Reload the page." : "pitwall didn't flag it: it didn't answer as expected." };
  if (!body.ok) return { kind: 'failed', error: body.error };
  return { kind: 'flagged', ...(body.asked === undefined ? {} : { asked: body.asked }) };
}

/** Takes the flag away. Resolves to an error in pitwall's words, or undefined. Never rejects. */
export async function unflagSession(api: ApiClient, sessionId: string): Promise<string | undefined> {
  const result = await api.post(unflagPath(sessionId), {});
  const body = result.kind === 'unauthorized' ? undefined : asFlagResult(result.body);
  if (body?.ok === true) return undefined;
  return body?.ok === false ? body.error : "pitwall didn't take the flag away: it didn't answer as expected.";
}

/** What a flagged row says on line 2, quietly, after its group's label, as "Not needed now" does. */
export const FLAGGED_TEXT = 'You flagged this';

/** The flag toggle's name and tooltip, in either state. */
export const flagLabel = (name: string) => `Flag ${plainText(name)}: it doesn't need me`;

/** The view's actions menu items. */
export const FLAG_ITEM = "It doesn't need me";
export const UNFLAG_ITEM = 'Undo flag';

/** The toast once it's flagged, by what came of the ask. */
export function flaggedText(name: string, asked: RelayResult | undefined): { tone: 'success' | 'error'; message: string } {
  const who = plainText(name);
  if (asked === undefined) return { tone: 'success', message: `${who} is flagged: it's out of Needs you.` };
  if (asked.status === 'delivered') return { tone: 'success', message: `Flagged ${who}: it's out of Needs you, and pitwall asked it what, if anything, it needs.` };
  if (asked.status === 'held') return { tone: 'success', message: `Flagged ${who}: it's out of Needs you. pitwall's question to it is held for approval in its own terminal.` };
  const why = asked.detail ?? STATUS_TEXT[asked.status];
  return { tone: 'error', message: `Flagged ${who}: it's out of Needs you, but pitwall couldn't ask it what it needs. ${why}` };
}

/** The toast's action: it takes the flag away. */
export const UNDO_FLAG = 'Undo';

/** The toast once a flag is taken away from the menu, which has closed. */
export const unflaggedText = (name: string) => `Took the flag off ${plainText(name)}: it's back in Needs you.`;
