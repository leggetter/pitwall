// The divider between the session list and the session view, in three columns only
// (docs/design-system.md, 3: Session view): a 24 px hit area with a 1 px line in it, a focusable
// role="separator" whose value is the view's width in px. Dragging it, ← and → (16 px), Home and End
// (the minimum and maximum) resize the view, and a double-click resets it. The width is stored in
// pitwall.panel-width.v1 (panelWidth.ts).
//
// The width lives in a store the Dashboard makes (createPanelWidthStore), which the session view's
// actions menu also changes, with Make view wider, Make view narrower and Reset view width, so it can
// be resized without dragging (WCAG 2.5.7). The divider sets the width on the third column's pane
// itself, which the stylesheet clamps to what the app's width allows, so dragging re-renders only this.

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import { widthOf } from '../layout.js';
import { PANEL_MIN, PANEL_STEP, panelMax, panelReset, shownPanel, type PanelWidthStore } from '../panelWidth.js';

export interface DividerProps {
  /** The view's width, which pitwall.panel-width.v1 keeps, shared with the actions menu. */
  store: PanelWidthStore;
}

/** The pane the divider sits in, which takes the width: the divider's parent. Its own parent, the columns, is as wide as the app. */
const paneOf = (divider: HTMLElement | null) => divider?.parentElement ?? null;
const appWidthOf = (divider: HTMLElement | null) => widthOf(paneOf(divider)?.parentElement ?? null);

export function Divider({ store }: DividerProps) {
  const self = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(store.subscribe, store.get);
  const { requested, appWidth } = state;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);

  // The app's width, for the maximum, kept up to date as the window or the frame is resized.
  useLayoutEffect(() => {
    const element = paneOf(self.current)?.parentElement ?? null;
    const update = () => store.setAppWidth(widthOf(element));
    update();
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'function' && element ? new ResizeObserver(update) : undefined;
    if (observer && element) observer.observe(element);
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [store]);

  // Before paint, so the first frame already has the stored width. The stylesheet keeps it within
  // what the window allows, so a narrower window shows less without losing the setting.
  useLayoutEffect(() => {
    const element = paneOf(self.current);
    if (!element) return;
    element.style.width = `${requested}px`;
    return () => {
      element.style.width = '';
    };
  }, [requested]);

  const shown = shownPanel(state);

  /** Asks for `width`, against the app's width as it is now. */
  const set = (width: number, save: boolean) => {
    store.setAppWidth(appWidthOf(self.current));
    store.set(width, save);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const max = panelMax(appWidth);
    // The divider is the view's left edge: moving it left widens the view.
    const next =
      event.key === 'ArrowLeft'
        ? shown + PANEL_STEP
        : event.key === 'ArrowRight'
          ? shown - PANEL_STEP
          : event.key === 'Home'
            ? PANEL_MIN
            : event.key === 'End'
              ? max
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    set(next, true);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // No text selection while dragging; focus still moves here, as for any control.
    event.preventDefault();
    event.currentTarget.focus();
    drag.current = { x: event.clientX, width: shown };
    try {
      // So the drag follows the pointer off the divider. A pointer the browser no longer tracks throws.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Without capture, the drag still follows while the pointer is over the divider.
    }
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    set(start.width + (start.x - event.clientX), false);
  };

  const endDrag = () => {
    if (!drag.current) return;
    drag.current = undefined;
    setDragging(false);
    store.set(store.get().requested, true);
  };

  return (
    <div
      ref={self}
      className="session-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the session view"
      aria-valuenow={shown}
      aria-valuemin={PANEL_MIN}
      aria-valuemax={panelMax(appWidth)}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => set(panelReset(appWidthOf(self.current)), true)}
    />
  );
}
