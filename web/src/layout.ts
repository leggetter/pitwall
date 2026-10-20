// Which columns the app shows (docs/design-system.md, 2.12 and 3), from the app's own width rather
// than the window's. The app spans the window, so it's the same thing there, and in the #uikit
// gallery a page specimen gets the layout of its frame's width.
//
// The CSS reads the result from data-layout on the app, so the two can't disagree. The header's
// compact rule, which only moves things around, is a container query in styles.css; the session view
// also needs it in its markup, for Back in place of Close, so it's measured here too.

import { useLayoutEffect, useState, type RefObject } from 'react';

/** The session view is the third column from here. Below it, it overlays the session list. */
export const THREE_COLUMNS_MIN = 1200;
/** The repo list sits beside the session list from here. Below it, it's a drawer. */
export const SIDEBAR_MIN = 900;

/** Compact from here down: the session view is full width, with Back in place of Close. */
export const COMPACT_MAX = 600;

export type Layout = 'three-columns' | 'sidebar' | 'drawer';

export interface AppLayout {
  layout: Layout;
  /** At most COMPACT_MAX wide, the compact breakpoint (2.12). */
  compact: boolean;
}

export function layoutFor(width: number): Layout {
  if (width >= THREE_COLUMNS_MIN) return 'three-columns';
  return width >= SIDEBAR_MIN ? 'sidebar' : 'drawer';
}

/** The element's width, or the window's when it has none yet, as before it's laid out. */
export function widthOf(element: HTMLElement | null): number {
  const width = element?.getBoundingClientRect().width ?? 0;
  return width > 0 ? width : window.innerWidth;
}

function appLayoutFor(width: number): AppLayout {
  return { layout: layoutFor(width), compact: width <= COMPACT_MAX };
}

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
      setLayout((current) => (current.layout === next.layout && current.compact === next.compact ? current : next));
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
