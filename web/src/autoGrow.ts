// A text box that grows with what's typed in it (docs/design-system.md, 4: Inputs): from one line to
// the most its CSS allows, then it scrolls. Its height follows its content, and is measured again
// when its width changes, since the text wraps differently. The message box's (W24), the
// supervisor's and an approval's editor (W114) share it.

import { useEffect, useLayoutEffect, type RefObject } from 'react';

/** Grows `field` to fit `text`; `shown` is whether it's on the page, so it's measured again when it comes back. */
export function useAutoGrow(field: RefObject<HTMLTextAreaElement | null>, text: string, shown = true): void {
  const grow = () => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  };
  useLayoutEffect(grow, [text, shown]);
  useEffect(() => {
    const element = field.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      // In the next frame: changing its height inside the callback would notify it again in this one.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(grow);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [shown]);
}
