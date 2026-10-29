// Refresh for the PR list (M4, W95; docs/design-system.md, 4: Pull requests): POST PRS_REFRESH_PATH,
// with the apiKey, as every state-changing request is sent. The list itself arrives as a 'prs'
// message, refreshing and then fetched, so the answer only says whether a fetch started.
//
// - ok: a fetch started, or one was already running. Refresh is off for PRS_REFRESH_MIN_MS, 15 s, the
//   server's own limit, so a second press can't be refused.
// - 429: the latest fetch, a poll's or a refresh's, started less than 15 s ago. Off for the server's
//   Retry-After, with an info toast that says when it's on again: nothing failed.
// - 409: pull requests are off (`--no-prs`). An info toast says so; the list says so too.
// - Anything else: an error toast in couldNot()'s words, and Refresh is on again at once.

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { PRS_REFRESH_MIN_MS, PRS_REFRESH_PATH } from '../../src/shared/protocol.js';
import { ApiContext } from './api.js';
import { couldNot } from './format.js';
import type { ShowToast } from './components/Toast.js';

/** The info toast after a 429: nothing failed, and Refresh is on again in `seconds`. */
export const refreshSoonText = (seconds: number) =>
  `pitwall fetched your pull requests moments ago. Refresh again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;

/** The info toast after a 409. */
export const PRS_OFF_TEXT = "Pull requests are off: pitwall was started with --no-prs, so it doesn't run gh.";

/** The error toast after any other failure: couldNot()'s sentence, with the status when there was one. */
export const refreshFailedText = (status: number | undefined) => `${couldNot('refresh your pull requests', status)} Try again in a moment.`;

export interface PrRefresh {
  /** Asks the server to fetch now. Does nothing while a request is out or Refresh is off. */
  refresh: () => void;
  /** The request is out. */
  sending: boolean;
  /** Refresh is off until this time, epoch ms, after a refresh or a 429; 0 when it's on. */
  offUntil: number;
}

/** Refresh, for the PR list's header and its empty states. Its results are toasts, from `toast`. */
export function usePrRefresh(toast: ShowToast): PrRefresh {
  const api = useContext(ApiContext);
  const [sending, setSending] = useState(false);
  const [offUntil, setOffUntil] = useState(0);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Back on once the time is up.
  useEffect(() => {
    if (offUntil === 0) return;
    const timer = setTimeout(() => setOffUntil(0), Math.max(0, offUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [offUntil]);

  const refresh = useCallback(() => {
    if (!api || busy.current || Date.now() < offUntil) return;
    busy.current = true;
    setSending(true);
    void api.post(PRS_REFRESH_PATH, {}).then((result) => {
      busy.current = false;
      if (!alive.current) return;
      setSending(false);
      if (result.kind === 'ok') {
        setOffUntil(Date.now() + PRS_REFRESH_MIN_MS);
        return;
      }
      // The connection was refused, and the page says so in place of the dashboard.
      if (result.kind === 'unauthorized') return;
      if (result.status === 429) {
        const seconds = Math.max(1, result.retryAfter ?? Math.ceil(PRS_REFRESH_MIN_MS / 1000));
        setOffUntil(Date.now() + seconds * 1000);
        toast({ tone: 'info', key: 'prs-refresh', message: refreshSoonText(seconds) });
        return;
      }
      if (result.status === 409) {
        toast({ tone: 'info', key: 'prs-refresh', message: PRS_OFF_TEXT });
        return;
      }
      toast({ tone: 'error', key: 'prs-refresh', message: refreshFailedText(result.status) });
    });
  }, [api, offUntil, toast]);

  return { refresh, sending, offUntil };
}
