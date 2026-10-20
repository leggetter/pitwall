// Which columns the app shows (docs/design-system.md, 2.12 and 3), from the app's own width rather
// than the window's. The app spans the window, so it's the same thing there, and in the #uikit
// gallery a page specimen gets the layout of its frame's width.
//
// The CSS reads the result from data-layout on the app, so the two can't disagree. The header's
// compact rule, which only moves things around, is a container query in styles.css.

import { useLayoutEffect, useState, type RefObject } from 'react';

/** The session view is the third column from here. Below it, it overlays the session list. */
export const THREE_COLUMNS_MIN = 1200;
/** The repo list sits beside the session list from here. Below it, it's a drawer. */
export const SIDEBAR_MIN = 900;

export type Layout = 'three-columns' | 'sidebar' | 'drawer';

export function layoutFor(width: number): Layout {
  if (width >= THREE_COLUMNS_MIN) return 'three-columns';
  return width >= SIDEBAR_MIN ? 'sidebar' : 'drawer';
}

/** The element's width, or the window's when it has none yet, as before it's laid out. */
function widthOf(element: HTMLElement | null): number {
  const width = element?.getBoundingClientRect().width ?? 0;
  return width > 0 ? width : window.innerWidth;
}

/** The layout for `ref`'s width, kept up to date as it's resized. */
export function useLayout(ref: RefObject<HTMLElement | null>): Layout {
  const [layout, setLayout] = useState<Layout>(() => layoutFor(window.innerWidth));
  useLayoutEffect(() => {
    const element = ref.current;
    const update = () => setLayout(layoutFor(widthOf(element)));
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
