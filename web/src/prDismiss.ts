// Not for me (W188), the page's side: a pull request you're not taking on, such as a review you won't
// do. From a PR row's toggle or the PR view, it leaves Needs you and every count Needs you feeds, the
// page title and the Pull requests item's badge included (prNeedsAttention()), and its row moves to a
// muted Dismissed section, collapsed, at the end of the list. Undo, the row's toggle pressed again, the
// PR view's Undo or the toast's, brings it back. The server keeps it (PullRequestSummary.dismissed), so every page and the
// supervisor see it, and ends it when something new happens on the PR: a new review request or mention
// of you, or on yours a new review or CI going red. Then its row says so for a while
// (PullRequestSummary.dismissalEnded).
//
// Its words keep clear of a session's: a session is snoozed (W154) or flagged, "It doesn't need me"
// (W153); a PR is "Not for me", and its section "Dismissed". Nothing is sent to GitHub.
import { PR_DISMISS_PATH, PR_UNDISMISS_PATH, type PrDismissal, type PrDismissResult, type PullRequestSummary } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';

/** The action's name, on a PR row and in the PR view. */
export const NOT_FOR_ME = 'Not for me';

/**
 * The row's toggle's tooltip and name, whatever its state, as a toggle's name is: "Not for me: #128".
 * Pressed, it's dismissed, and pressing it is Undo.
 */
export const notForMeLabel = (pr: Pick<PullRequestSummary, 'number'>) => `${NOT_FOR_ME}: #${pr.number}`;

/** Undo's name, on the toast and in the PR view. */
export const UNDO_DISMISS = 'Undo';

/** The section the dismissed PR rows are listed in, collapsed. */
export const DISMISSED_HEADING = 'Dismissed';

/** What brings a dismissed PR back, said once in the PR view and the toast. */
export const COMES_BACK = 'It comes back if something new happens: a new review request or mention of you, or on your own, a new review or failing CI.';

/** The toast once it's dismissed: short, as the PR view says what brings it back. */
export const dismissedToast = (pr: Pick<PullRequestSummary, 'number'>) => `#${pr.number} is out of Needs you, under Dismissed, until something new happens.`;

/** The toast once Undo from the PR view has brought it back. */
export const undismissedToast = (pr: Pick<PullRequestSummary, 'number'>) => `#${pr.number} is back with your pull requests.`;

/** The PR view's line while it's dismissed. */
export const DISMISSED_NOTE = `You said this one is ${NOT_FOR_ME}, so it doesn't need you. ${COMES_BACK}`;

/** A row's line 2, for a while after a dismissal ended by itself. */
export const BACK_TEXT = 'Back: something new';

/** Whether a PR can be dismissed now: listed with a state hash the server can compare, and not already. */
export const canDismiss = (pr: PullRequestSummary): boolean => pr.dismissed === undefined && pr.stateHash !== undefined;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A PrDismissResult in `body`, or undefined. */
export function asPrDismissResult(body: unknown): PrDismissResult | undefined {
  if (!isRecord(body)) return undefined;
  if (body.ok === false) return typeof body.error === 'string' ? { ok: false, error: body.error } : undefined;
  if (body.ok !== true) return undefined;
  if (body.dismissed === undefined) return { ok: true };
  const dismissed = body.dismissed;
  if (!isRecord(dismissed) || typeof dismissed.at !== 'string' || Number.isNaN(Date.parse(dismissed.at))) return undefined;
  return { ok: true, dismissed: { at: dismissed.at } };
}

/** What a dismissal came to: when, or why not, in pitwall's words. */
export type DismissOutcome = { kind: 'dismissed'; dismissed: PrDismissal } | { kind: 'failed'; error: string };

const UNAUTHORIZED = "pitwall didn't accept the page's key. Reload the page.";

/** Dismisses `pr` in the state the page shows. Never rejects. */
export async function dismissPr(api: ApiClient, pr: PullRequestSummary): Promise<DismissOutcome> {
  if (pr.stateHash === undefined) return { kind: 'failed', error: "pitwall can't tell when something new happens on it, so it can't be dismissed." };
  const result = await api.post(PR_DISMISS_PATH, { repo: pr.repo, number: pr.number, seen: pr.stateHash, ...(pr.redHash === undefined ? {} : { seenRed: pr.redHash }) });
  const body = result.kind === 'unauthorized' ? undefined : asPrDismissResult(result.body);
  if (body === undefined) return { kind: 'failed', error: result.kind === 'unauthorized' ? UNAUTHORIZED : "pitwall didn't dismiss it: it didn't answer as expected." };
  if (!body.ok) return { kind: 'failed', error: body.error };
  if (body.dismissed === undefined) return { kind: 'failed', error: "pitwall didn't dismiss it: it didn't answer as expected." };
  return { kind: 'dismissed', dismissed: body.dismissed };
}

/** Undoes a dismissal. Resolves to an error in pitwall's words, or undefined. Never rejects. */
export async function undismissPr(api: ApiClient, pr: Pick<PullRequestSummary, 'repo' | 'number'>): Promise<string | undefined> {
  const result = await api.post(PR_UNDISMISS_PATH, { repo: pr.repo, number: pr.number });
  if (result.kind === 'unauthorized') return UNAUTHORIZED;
  const body = asPrDismissResult(result.body);
  if (body?.ok === true) return undefined;
  return body?.ok === false ? body.error : "pitwall didn't undo it: it didn't answer as expected.";
}
