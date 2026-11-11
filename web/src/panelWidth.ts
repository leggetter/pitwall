// The session view's width as the third column (docs/design-system.md, 2.12 and 3: Session view):
// 760 px by default, at least 560 px (about 80 terminal columns), and at most what the repo list and
// the session list's 360 px leave. The divider changes it, and it's remembered in localStorage as
// pitwall.panel-width.v1. What's stored is the width asked for; the column shows it clamped to the
// app's width at the time, so a narrower window never loses the setting.

import type { StorageSource } from './groupState.js';

export const PANEL_WIDTH_KEY = 'pitwall.panel-width.v1';

/** --pw-panel-w, --pw-panel-min-w, --pw-sidebar-w and --pw-list-min-w in tokens.css. */
export const PANEL_DEFAULT = 760;
export const PANEL_MIN = 560;
export const SIDEBAR_WIDTH = 240;
export const LIST_MIN = 360;

/** --pw-supervisor-w: the supervisor's panel, as a column of its own from 1,200 px (W187). */
export const SUPERVISOR_WIDTH = 560;
/** The narrowest the supervisor's column gets: the session list's minimum, as W177's panel had it. */
export const SUPERVISOR_MIN = LIST_MIN;

/**
 * From here, the repo list stays beside the supervisor's column: its 240 px, the session list's 360,
 * the session view's 560 and the panel's 360. Narrower, while the panel is open, the repo list folds
 * into the header's Repos drawer, its form below 900 px, so the view keeps its 560 px (W187): 1,520 px.
 */
export const PANEL_KEEPS_REPOS = SIDEBAR_WIDTH + LIST_MIN + PANEL_MIN + SUPERVISOR_MIN;

/**
 * The room the supervisor's column takes in three columns, as styles.css works it out: the repo list's
 * width, or none while it's folded, and the panel's, 560 px, giving way to 360 px before the session
 * view goes under its 560 px. Only from 1,200 to 1,279 px, with the repo list folded and the panel at
 * 360 px, is the view narrower than that: 480 to 559 px.
 */
export function supervisorColumn(appWidth: number): { repos: number; panel: number } {
  const width = Math.floor(appWidth);
  const repos = width >= PANEL_KEEPS_REPOS ? SIDEBAR_WIDTH : 0;
  const panel = Math.min(SUPERVISOR_WIDTH, Math.max(SUPERVISOR_MIN, width - repos - LIST_MIN - PANEL_MIN));
  return { repos, panel };
}

/** One press of ← or → on the divider. */
export const PANEL_STEP = 16;

/**
 * The widest the session view can be in an app this wide: what the repo list and the session list
 * leave, and the supervisor's column, `beside` it (W187).
 */
export function panelMax(appWidth: number, beside = false): number {
  const width = Math.floor(appWidth);
  if (!beside) return Math.max(PANEL_MIN, width - SIDEBAR_WIDTH - LIST_MIN);
  const { repos, panel } = supervisorColumn(width);
  return Math.max(0, width - repos - LIST_MIN - panel);
}

/** The narrowest: 560 px, or less where the supervisor's column leaves less, from 1,200 to 1,279 px (W187). */
export function panelMin(appWidth: number, beside = false): number {
  return Math.min(PANEL_MIN, panelMax(appWidth, beside));
}

/** `width` within the session view's limits in an app `appWidth` wide. */
export function clampPanel(width: number, appWidth: number, beside = false): number {
  return Math.min(panelMax(appWidth, beside), Math.max(panelMin(appWidth, beside), Math.round(width)));
}

/** The width a double-click on the divider goes back to: 760 px, or the maximum if that's less. */
export function panelReset(appWidth: number, beside = false): number {
  return clampPanel(PANEL_DEFAULT, appWidth, beside);
}

/** A stored width: a whole number of px from the minimum up, or the default for anything else. */
export function readPanelWidth(storage: StorageSource): number {
  try {
    const raw = storage()?.getItem(PANEL_WIDTH_KEY);
    if (raw === null || raw === undefined || !/^\d{3,5}$/.test(raw)) return PANEL_DEFAULT;
    const width = Number(raw);
    return width >= PANEL_MIN ? width : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

export function writePanelWidth(width: number, storage: StorageSource): void {
  try {
    storage()?.setItem(PANEL_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Blocked or full: the width lasts until the page reloads.
  }
}

/** One "Make view wider" or "Make view narrower" from the actions menu: five of the divider's key steps. */
export const PANEL_MENU_STEP = 5 * PANEL_STEP;

/** The width asked for, which may be more than the app allows, and the app's width, which together give what's shown. */
export interface PanelWidthState {
  readonly requested: number;
  readonly appWidth: number;
  /** The supervisor's panel open beside the view, as a column of its own (W187), which takes its room. */
  readonly beside?: boolean;
}

/**
 * The session view's width as the third column, for the divider and the actions menu's width items,
 * which both change it. A store rather than the Dashboard's state, so dragging re-renders only what
 * reads it: the divider every pixel, the menu only when what it can do changes (panelLimits).
 */
export interface PanelWidthStore {
  get(): PanelWidthState;
  subscribe(listener: () => void): () => void;
  /** Asks for `width`, clamped to what the app allows now, and stores it when `save`. */
  set(width: number, save: boolean): void;
  /** The app's width, as the divider measures it. */
  setAppWidth(appWidth: number): void;
  /** Whether the supervisor's panel is open beside the view (W187). */
  setBeside(beside: boolean): void;
}

export function createPanelWidthStore(storage: StorageSource, appWidth = typeof window === 'undefined' ? 0 : window.innerWidth): PanelWidthStore {
  let state: PanelWidthState = { requested: readPanelWidth(storage), appWidth };
  const listeners = new Set<() => void>();
  const change = (next: PanelWidthState) => {
    if (next.requested === state.requested && next.appWidth === state.appWidth && (next.beside ?? false) === (state.beside ?? false)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(width, save) {
      const next = clampPanel(width, state.appWidth, state.beside);
      change({ ...state, requested: next });
      if (save) writePanelWidth(next, storage);
    },
    setAppWidth(next) {
      change({ ...state, appWidth: next });
    },
    setBeside(beside) {
      change({ ...state, beside });
    },
  };
}

/** The width shown: what was asked for, within what the app allows. */
export function shownPanel(state: PanelWidthState): number {
  return clampPanel(state.requested, state.appWidth, state.beside);
}

/** What the actions menu's width items can do now, as a string that changes only when one of them does. */
export function panelLimits(state: PanelWidthState): string {
  const shown = shownPanel(state);
  const wider = shown < panelMax(state.appWidth, state.beside);
  const narrower = shown > panelMin(state.appWidth, state.beside);
  const reset = shown !== panelReset(state.appWidth, state.beside);
  return `${wider ? 'wider' : ''}|${narrower ? 'narrower' : ''}|${reset ? 'reset' : ''}`;
}
