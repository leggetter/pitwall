// Which columns the app shows (docs/design-system.md, 2.12 and 3), from the app's own width rather
// than the window's. The app spans the window, so it's the same thing there, and in the #uikit
// gallery a page specimen gets the layout of its frame's width.
//
// The CSS reads the result from data-layout on the app, so the two can't disagree. The header's
// compact rule, which only moves things around, is a container query in styles.css; the session view
// also needs it in its markup, for Back in place of Close, so it's measured here too. So is where the
// session view over the list starts to cover the repo list, which is inert from there (Dashboard.tsx).

import { useLayoutEffect, useState, type RefObject } from 'react';
import { PANEL_DEFAULT, SIDEBAR_WIDTH } from './panelWidth.js';

/** The session view is the third column from here. Below it, it overlays the session list. */
export const THREE_COLUMNS_MIN = 1200;
/** The repo list sits beside the session list from here. Below it, it's a drawer. */
export const SIDEBAR_MIN = 900;

/** Compact from here down: the session view is full width, with Back in place of Close. */
export const COMPACT_MAX = 600;

/**
 * Below this, the session view over the list, --pw-panel-w wide at the app's right edge, reaches into
 * the repo list beside it, --pw-sidebar-w wide: 1,000 px.
 */
export const OVERLAY_CLEARS_SIDEBAR = SIDEBAR_WIDTH + PANEL_DEFAULT;

export type Layout = 'three-columns' | 'sidebar' | 'drawer';

export interface AppLayout {
  layout: Layout;
  /** At most COMPACT_MAX wide, the compact breakpoint (2.12). */
  compact: boolean;
  /** In the sidebar layout, narrower than OVERLAY_CLEARS_SIDEBAR: the session view over the list covers part of the repo list. */
  overlayCoversRepos: boolean;
}

export function layoutFor(width: number): Layout {
  if (width >= THREE_COLUMNS_MIN) return 'three-columns';
  return width >= SIDEBAR_MIN ? 'sidebar' : 'drawer';
}

/**
 * The element's width as laid out, or the window's when it has none yet, as before it's laid out. Its
 * width on screen, which is exact, unless a transform on an ancestor scales it, as the #uikit gallery
 * scales a window wider than its stage to fit: then its layout width (offsetWidth, which a transform
 * doesn't change, rounded to a whole px), so the layout is the window's, not the scaled size's.
 */
export function widthOf(element: HTMLElement | null): number {
  const width = element?.getBoundingClientRect().width ?? 0;
  if (!(width > 0)) return window.innerWidth;
  const laidOut = element?.offsetWidth ?? 0;
  return laidOut > 0 && Math.abs(laidOut - width) > 1 ? laidOut : width;
}

function appLayoutFor(width: number): AppLayout {
  const layout = layoutFor(width);
  return { layout, compact: width <= COMPACT_MAX, overlayCoversRepos: layout === 'sidebar' && width < OVERLAY_CLEARS_SIDEBAR };
}

const sameLayout = (a: AppLayout, b: AppLayout) => a.layout === b.layout && a.compact === b.compact && a.overlayCoversRepos === b.overlayCoversRepos;

/**
 * The layout for `ref`'s width, kept up to date as it's resized. It changes only at the breakpoints,
 * so resizing the window doesn't re-render the app at every pixel.
 */
export function useLayout(ref: RefObject<HTMLElement | null>): AppLayout {
  const [layout, setLayout] = useState<AppLayout>(() => appLayoutFor(window.innerWidth));
  useLayoutEffect(() => {
    const element = ref.current;
    const update = () => {
      const next = appLayoutFor(widthOf(element));
      setLayout((current) => (sameLayout(current, next) ? current : next));
    };
    update();
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'function' && element ? new ResizeObserver(update) : undefined;
    if (observer && element) observer.observe(element);
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [ref]);
  return layout;
}
