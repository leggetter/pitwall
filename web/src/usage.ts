// The Usage view (W158, docs/design-system.md, 4: Usage): its place in the URL, reading the server's
// answer defensively, and the words and numbers it shows.
//
// It opens from the header's Usage button as a dialog over the page, as Preferences does, and it's in
// the URL as `?usage`, added to whatever else is there and taken off on close, so a reload or the back
// button keeps or closes it and nothing else in the URL changes. No other parameter's rule knows of it.
//
// Its figures come from GET USAGE_PATH (src/server/usageRoutes.ts), only while it's open, for the
// window chosen, and again on Refresh. Nothing is fetched on a timer.

import { useCallback, useEffect, useRef, useState } from 'react';
import { USAGE_PATH, USAGE_WINDOWS, type UsageTokens, type UsageView, type UsageWindowKey } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { couldNot, tryAgainIn } from './format.js';
import { withoutParams, type HistoryMode } from './openSession.js';
import { browserNavigation, type NavigationEnv } from './selection.js';

export const USAGE_PARAM = 'usage';

/** The header button's name and the dialog's title. */
export const USAGE_LABEL = 'Usage';

// --- Its place in the URL -------------------------------------------------------------------------

/** Whether a query string opens the Usage view: `?usage`, whatever else is there. */
export function parseUsage(search: string): boolean {
  return new URLSearchParams(search).has(USAGE_PARAM);
}

/** `search` with `?usage` added last, or taken off, every other parameter kept as written, in order. */
export function withUsage(search: string, open: boolean): string {
  const kept = withoutParams(search, [USAGE_PARAM]);
  if (!open) return kept;
  return `${kept === '' ? '?' : `${kept}&`}${USAGE_PARAM}`;
}

export interface OpenUsage {
  open: boolean;
  /** Opens it: one pushed entry, or none when it's open already. */
  show: (mode?: HistoryMode) => void;
  /** Closes it, pushing an entry without ?usage. */
  close: () => void;
}

/** The Usage view's open state, from the URL. Reading it fetches nothing. */
export function useOpenUsage(navigation: NavigationEnv = browserNavigation): OpenUsage {
  const [open, setOpen] = useState(() => parseUsage(navigation.location.search));
  const current = useRef(open);
  current.current = open;

  useEffect(() => {
    const follow = () => {
      const next = parseUsage(navigation.location.search);
      current.current = next;
      setOpen(next);
    };
    navigation.addEventListener('popstate', follow);
    return () => navigation.removeEventListener('popstate', follow);
  }, [navigation]);

  const write = useCallback(
    (next: boolean, mode: HistoryMode) => {
      const { pathname, search, hash } = navigation.location;
      const url = `${pathname}${withUsage(search, next)}${hash}`;
      if (mode === 'push') navigation.history.pushState(navigation.history.state, '', url);
      else navigation.history.replaceState(navigation.history.state, '', url);
    },
    [navigation],
  );

  const show = useCallback(
    (mode: HistoryMode = 'push') => {
      if (current.current && parseUsage(navigation.location.search)) return;
      write(true, mode);
      current.current = true;
      setOpen(true);
    },
    [write, navigation],
  );

  const close = useCallback(() => {
    if (!current.current) return;
    if (parseUsage(navigation.location.search)) write(false, 'push');
    current.current = false;
    setOpen(false);
  }, [write, navigation]);

  return { open, show, close };
}

// --- Reading the answer ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFigure = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const FIELDS = ['calls', 'input', 'cacheWrite', 'cacheRead', 'output', 'cost'] as const;
const isTokens = (value: unknown): value is UsageTokens => isRecord(value) && FIELDS.every((field) => isFigure(value[field]));
/** A row: its figures, and `key` as a string. */
const isRow = (value: unknown, key: string): boolean => isTokens(value) && typeof (value as unknown as Record<string, unknown>)[key] === 'string';
const isRows = (value: unknown, key: string): boolean =>
  isRecord(value) && Array.isArray(value.rows) && value.rows.every((row) => isRow(row, key)) && (value.rest === undefined || isTokens(value.rest));

/** The server's answer, when it has the shape this page reads; undefined otherwise. */
export function asUsageView(value: unknown): UsageView | undefined {
  if (!isRecord(value) || !isRecord(value.window) || !isRecord(value.plan) || !isRecord(value.split) || !isRecord(value.scan)) return undefined;
  const window = value.window;
  if (!USAGE_WINDOWS.includes(window.key as UsageWindowKey) || !isTime(window.since) || !isTime(window.until)) return undefined;
  if (window.bucket !== 'day' && window.bucket !== 'hour') return undefined;
  if (!isTokens(value.totals) || typeof value.costLabel !== 'string') return undefined;
  if (!Array.isArray(value.buckets) || !value.buckets.every((bucket) => isTokens(bucket) && isRecord(bucket) && isTime(bucket.start))) return undefined;
  if (!isRows(value.byRepo, 'repo') || !isRows(value.bySession, 'sessionId')) return undefined;
  if (!Array.isArray(value.byModel) || !value.byModel.every((row) => isRow(row, 'model'))) return undefined;
  if (!isTokens(value.split.main) || !isTokens(value.split.subagent)) return undefined;
  if (value.history !== undefined && !isTokens(value.history)) return undefined;
  if (value.plan.status !== 'available' && value.plan.status !== 'unavailable') return undefined;
  return value as unknown as UsageView;
}

export type UsageState =
  | { kind: 'loading'; view?: UsageView }
  | { kind: 'ready'; view: UsageView }
  | { kind: 'failed'; message: string; view?: UsageView };

/** The figures shown for `window`: only a view of that window, so a switch never shows another's under its tab. */
function keptFor(state: UsageState, window: UsageWindowKey): { view?: UsageView } {
  return state.view !== undefined && state.view.window.key === window ? { view: state.view } : {};
}

/**
 * The window's figures, fetched when the window changes and on refresh(). On a refresh, the figures
 * shown stay while the next load, so the page doesn't jump; on a window change, and when a read
 * fails, only figures of the window chosen are kept, never another window's (W158's review).
 */
export function useUsage(api: ApiClient | undefined, windowKey: UsageWindowKey): { state: UsageState; refresh: () => void } {
  const [state, setState] = useState<UsageState>({ kind: 'loading' });
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (api === undefined) return;
    const abort = new AbortController();
    setState((current) => ({ kind: 'loading', ...keptFor(current, windowKey) }));
    void api.get(`${USAGE_PATH}?window=${windowKey}`, { signal: abort.signal }).then((result) => {
      if (abort.signal.aborted) return;
      setState((current) => {
        const kept = keptFor(current, windowKey);
        if (result.kind !== 'ok') {
          const status = result.kind === 'failed' ? result.status : undefined;
          const message =
            status === 429
              ? `pitwall is still reading your transcripts.${tryAgainIn(result.kind === 'failed' ? result.retryAfter : undefined)}`
              : status === 404
                ? 'Usage is unavailable: this pitwall has no usage source.'
                : couldNot('read your usage', status);
          return { kind: 'failed', message, ...kept };
        }
        const view = asUsageView(result.body);
        if (view === undefined) return { kind: 'failed', message: "Couldn't read your usage: pitwall's answer wasn't as expected.", ...kept };
        return view.window.key === windowKey ? { kind: 'ready', view } : { kind: 'failed', message: "Couldn't read your usage: pitwall answered for another window.", ...kept };
      });
    });
    return () => abort.abort();
  }, [api, windowKey, asked]);
  return { state, refresh: () => setAsked((n) => n + 1) };
}

// --- Words and numbers ----------------------------------------------------------------------------

export const WINDOW_LABELS: Readonly<Record<UsageWindowKey, string>> = {
  week: 'This week',
  '24h': '24 hours',
  '14d': '14 days',
  '30d': '30 days',
};

/** A token count, short: 512, 34.5K, 120K, 1.2M, 3.4B; one decimal under 100 of a unit, and a count that rounds to 1,000 of one is 1.0 of the next. */
export function tokenText(count: number): string {
  if (Math.round(count) < 1000) return String(Math.round(count));
  const units = [
    [1e3, 'K'],
    [1e6, 'M'],
    [1e9, 'B'],
  ] as const;
  for (const [size, unit] of units) {
    const value = count / size;
    const text = value < 99.95 ? value.toFixed(1) : String(Math.round(value));
    if (Number(text) < 1000 || unit === 'B') return `${text}${unit}`;
  }
  return String(count);
}

/** The stand-in cost: "$12.34", "$0.04", "under $0.01", "$0". */
export function costText(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.005) return 'under $0.01';
  return usd >= 1000 ? `$${Math.round(usd).toLocaleString('en-US')}` : `$${usd.toFixed(2)}`;
}

/** Why the plan's week couldn't be read, in a few words. */
export function planReasonText(reason: string): string {
  switch (reason) {
    case 'not-found':
      return "pitwall couldn't find `claude`";
    case 'no-report':
      return "Claude Code's `/usage` gave no plan figures. It does on a Claude subscription, not with an API key";
    case 'no-limits':
      return "Claude Code's `/usage` had no limits in its report";
    case 'timeout':
      return "Claude Code's `/usage` didn't answer in time";
    default:
      return "Claude Code's `/usage` failed";
  }
}

/** A bucket's label: "Mon 10 Nov" for a day, "14:00" for an hour. */
export function bucketText(start: string, bucket: 'day' | 'hour'): string {
  const date = new Date(start);
  if (bucket === 'hour') return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** When the week resets: "Thu 13 Nov, 14:00". */
export function resetText(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

/** The window in words, for the dialog's line under the tabs. */
export function windowText(view: UsageView): string {
  const since = bucketText(view.window.since, 'day');
  if (view.window.from === 'reset') return `Since the plan's week started, ${since} at ${bucketText(view.window.since, 'hour')}.`;
  if (view.window.key === '24h') return 'The last 24 hours, by hour.';
  if (view.window.key === 'week') return `The last 7 days, from ${since}: the plan's week is unavailable, so it starts at midnight.`;
  return `The last ${view.window.key === '14d' ? 14 : 30} days, from ${since}.`;
}
