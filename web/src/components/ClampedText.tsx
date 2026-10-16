import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface ClampedTextProps {
  /** Clamped to two lines while collapsed. */
  text: string;
  /** Shown instead of `text` while expanded, such as the full reply once it has loaded. */
  expandedText?: string | undefined;
  expanded: boolean;
  onToggle: () => void;
  /** Shown under the text while expanded, such as a loading note. */
  note?: ReactNode;
  /** Marks the text as being updated, for assistive technology. */
  busy?: boolean;
  className?: string;
}

/** Text clamped to two lines, with a toggle when it overflows. Renders text only. */
export function ClampedText({ text, expandedText, expanded, onToggle, note, busy, className }: ClampedTextProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <div className={className}>
      <p ref={ref} id={id} className={expanded ? 'clamp-text expanded' : 'clamp-text'} aria-busy={busy || undefined}>
        {expanded ? (expandedText ?? text) : text}
      </p>
      {expanded && note}
      {(overflows || expanded) && (
        <button type="button" className="link-button" aria-expanded={expanded} aria-controls={id} onClick={onToggle}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
