// A box that scrolls inside itself, such as the page alerts past half the session list or a long
// relayed reply above the message box (docs/design-system.md, 6.1 rule 3). Safari and Firefox
// scroll a box from the keyboard only once it has focus, and a box that isn't a control can't take
// any, so while its content overflows it's a Tab stop: a named region, with the inset focus ring.
// While everything fits, it's a plain element, so Tab doesn't stop at something with nothing to do.

import { createElement, useCallback, useEffect, useState, type HTMLAttributes, type ReactNode, type Ref } from 'react';

/** Whether `element`'s content is taller than its box, kept up to date as either changes. */
export function useOverflowing(element: HTMLElement | null): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    if (!element) return;
    const check = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    check();
    // The box changing size, its content changing, or the window: any can start or end an overflow.
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : undefined;
    resized?.observe(element);
    const changed = typeof MutationObserver === 'function' ? new MutationObserver(check) : undefined;
    changed?.observe(element, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', check);
    return () => {
      resized?.disconnect();
      changed?.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [element]);
  return overflowing;
}

export interface ScrollBoxProps extends HTMLAttributes<HTMLElement> {
  /** The element: a div by default. */
  as?: 'div' | 'p';
  /** Its accessible name while it's a Tab stop, such as "Alerts". */
  label: string;
  ref?: Ref<HTMLElement> | undefined;
  children: ReactNode;
}

export function ScrollBox({ as = 'div', label, ref, className, children, ...rest }: ScrollBoxProps) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const overflowing = useOverflowing(element);
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      setElement(node);
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: HTMLElement | null }).current = node;
    },
    [ref],
  );
  const focusable = overflowing ? { tabIndex: 0, role: 'region', 'aria-label': label } : {};
  return createElement(as, { ...rest, ...focusable, ref: setRef, className: [className, 'scroll-box'].filter(Boolean).join(' ') }, children);
}
