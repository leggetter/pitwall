// Snooze (W154), the page's side: Needs you is right about a session, but not now. A session that
// needs you can be snoozed from its row's snooze menu or its view's actions menu, for 1 hour, 3 hours,
// until tomorrow or next week, at 9:00 in your time zone, or Later, until it's woken. The server keeps
// it (SessionSummary.snoozed), so every page and the supervisor see it, and a timer there ends it with
// no page open. A turn you didn't start, such as another session's message or a background task
// finishing, wakes it sooner (SessionSummary.wokenAt). Its row keeps its badge, outlined, and says
// until when; pressing the toggle again, the menu's Wake now or the toast's Undo takes it off. One
// that ended by itself says why on its row's line 2, for a while (SessionSummary.snoozeEnded).
//
// It replaces W88's Not needed now, which the browser kept under pitwall.not-needed.v1. Those marks
// aren't carried over: the key is removed once, as the page loads (dropOldMarks()), and a session
// that was marked is back in Needs you until you snooze or flag it.
import { snoozePath, unsnoozePath, type SessionSnooze, type SnoozeResult } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { plainText } from './format.js';
import { browserStorage, type StorageSource } from './groupState.js';

/** One of the snooze menu's choices. */
export interface SnoozeChoice {
  id: '1h' | '3h' | 'tomorrow' | 'next-week' | 'later';
  label: string;
  /** Its item in the session view's actions menu, which says what it does there. */
  menuLabel: string;
  /** When it ends, from `now`, in the page's time zone; undefined for Later. */
  until: (now: Date) => Date | undefined;
}

/** The hour a day's snooze ends at, in your time zone: 9:00. */
export const SNOOZE_MORNING_HOUR = 9;

/** `now`'s day plus `days`, at SNOOZE_MORNING_HOUR, in the page's time zone. */
function morning(now: Date, days: number): Date {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, SNOOZE_MORNING_HOUR, 0, 0, 0);
  return at;
}

/** The choices, in the menu's order. Next week is Monday at 9:00, a week on when today is Monday. */
export const SNOOZE_CHOICES: readonly SnoozeChoice[] = [
  { id: '1h', label: 'For 1 hour', menuLabel: 'Snooze for 1 hour', until: (now) => new Date(now.getTime() + 60 * 60 * 1000) },
  { id: '3h', label: 'For 3 hours', menuLabel: 'Snooze for 3 hours', until: (now) => new Date(now.getTime() + 3 * 60 * 60 * 1000) },
  { id: 'tomorrow', label: 'Until tomorrow, 9:00', menuLabel: 'Snooze until tomorrow, 9:00', until: (now) => morning(now, 1) },
  { id: 'next-week', label: 'Until Monday, 9:00', menuLabel: 'Snooze until Monday, 9:00', until: (now) => morning(now, ((8 - now.getDay()) % 7) || 7) },
  { id: 'later', label: "Later, until it's woken", menuLabel: "Snooze until it's woken", until: () => undefined },
];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** A SnoozeResult in `body`, or undefined. */
export function asSnoozeResult(body: unknown): SnoozeResult | undefined {
  if (!isRecord(body)) return undefined;
  if (body.ok === false) return typeof body.error === 'string' ? { ok: false, error: body.error } : undefined;
  if (body.ok !== true) return undefined;
  if (body.snoozed === undefined) return { ok: true };
  const snoozed = body.snoozed;
  if (!isRecord(snoozed) || !isTime(snoozed.at) || (snoozed.until !== undefined && !isTime(snoozed.until))) return undefined;
  return { ok: true, snoozed: { at: snoozed.at, ...(snoozed.until === undefined ? {} : { until: snoozed.until as string }) } };
}

/** What a snooze came to: the snooze, or why not, in pitwall's words. */
export type SnoozeOutcome = { kind: 'snoozed'; snoozed: SessionSnooze } | { kind: 'failed'; error: string };

/** Snoozes `sessionId` until `until`, or Later without it. Never rejects. */
export async function snoozeSession(api: ApiClient, sessionId: string, until: Date | undefined): Promise<SnoozeOutcome> {
  const result = await api.post(snoozePath(sessionId), until === undefined ? {} : { until: until.toISOString() });
  const body = result.kind === 'unauthorized' ? undefined : asSnoozeResult(result.body);
  if (body === undefined) return { kind: 'failed', error: result.kind === 'unauthorized' ? "pitwall didn't accept the page's key. Reload the page." : "pitwall didn't snooze it: it didn't answer as expected." };
  if (!body.ok) return { kind: 'failed', error: body.error };
  if (body.snoozed === undefined) return { kind: 'failed', error: "pitwall didn't snooze it: it didn't answer as expected." };
  return { kind: 'snoozed', snoozed: body.snoozed };
}

/** Takes the snooze off. Resolves to an error in pitwall's words, or undefined. Never rejects. */
export async function unsnoozeSession(api: ApiClient, sessionId: string): Promise<string | undefined> {
  const result = await api.post(unsnoozePath(sessionId), {});
  const body = result.kind === 'unauthorized' ? undefined : asSnoozeResult(result.body);
  if (body?.ok === true) return undefined;
  return body?.ok === false ? body.error : "pitwall didn't take the snooze off: it didn't answer as expected.";
}

/** "14:30", "tomorrow, 9:00" or "Mon 9:00": when `iso` is, from `now`, as briefly as a row has room for. */
export function whenText(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(at) - day(now)) / (24 * 60 * 60 * 1000));
  if (days <= 0) return time;
  if (days === 1) return `tomorrow, ${time}`;
  if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

/** What a snoozed row says on line 2, quietly, as "You flagged this" does: until when. */
export function snoozedText(snooze: SessionSnooze, now: Date): string {
  return snooze.until === undefined ? "Snoozed until it's woken" : `Snoozed until ${whenText(snooze.until, now)}`;
}

/** What a row back from a snooze says on line 2, quietly, before what it needs (W154): why it's back. */
export const SNOOZE_BACK_TEXT: Readonly<Record<'time' | 'woken', string>> = {
  time: 'Snooze ended',
  woken: 'Woken: a new turn',
};

/** The snooze toggle's and menu's name and tooltip, in either state. */
export const snoozeLabel = (name: string) => `Snooze ${plainText(name)}`;

/** The view's actions menu item that takes a snooze off. */
export const WAKE_ITEM = 'Wake now';

/** The toast once it's snoozed, with UNDO_SNOOZE. `stays` is a PR it owns that keeps it in Needs you (W106). */
export function snoozedToast(name: string, snooze: SessionSnooze, now: Date, stays?: number): string {
  const who = plainText(name);
  const until = snooze.until === undefined ? "until it's woken: a turn you didn't start, such as a message or a finished task" : `until ${whenText(snooze.until, now)}, or until it's woken before then`;
  return stays === undefined ? `Snoozed ${who} ${until}.` : `Snoozed ${who} ${until}. It stays in Needs you while #${stays} needs you.`;
}

/** The toast's action: it takes the snooze off. */
export const UNDO_SNOOZE = 'Undo';

/** The toast once the view's Wake now takes a snooze off, since the menu has closed. */
export const wokenText = (name: string) => `Woke ${plainText(name)}: it's back in Needs you.`;

/** W88's key, which this replaces. */
export const OLD_MARKS_KEY = 'pitwall.not-needed.v1';

/** Removes W88's marks, once, as the page loads. Storage that's missing, can't remove, or throws is left alone. */
export function dropOldMarks(storage: StorageSource = browserStorage): void {
  try {
    const store: (Partial<Pick<Storage, 'removeItem'>> & object) | null | undefined = storage();
    store?.removeItem?.(OLD_MARKS_KEY);
  } catch {
    // Blocked: nothing to remove.
  }
}
