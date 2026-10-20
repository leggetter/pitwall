// Waiting states (docs/design-system.md, 2.13 and 4: Skeletons and spinners): skeletons in the shape
// of what's coming, a status saying what's being waited for, and, after a long wait, a line saying
// what's slow.
//
// - Nothing shows before --pw-delay-spinner (500 ms), so a fast answer never flashes a skeleton or a
//   status line. After --pw-delay-long (10 s), the long-wait line joins. Both delays are read from
//   the tokens on the element the waiting state is in (timing.ts), so a part of the page can set its
//   own, as the #uikit gallery does to show them at once.
// - Skeletons are decorative and aria-hidden; the status, a role="status" region that's there from
//   the start, says what's loading, so it's announced once it shows, never on a fast answer.
// - Skeletons pulse, opacity 1 → 0.6 → 1 over 1.5 s, only without reduced motion (styles.css).

import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { cssTime, LONG_DELAY_MS, SPINNER_DELAY_MS } from '../timing.js';

/**
 * Whether `active` has held for the delay in the custom property `name` on `ref`'s element (or the
 * page's root): false at first, true once that much time has passed, and false again once it stops.
 */
export function useWaited(ref: RefObject<Element | null>, name: string, fallback: number, active: boolean): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setPassed(true), cssTime(ref.current ?? document.documentElement, name, fallback));
    return () => {
      clearTimeout(timer);
      setPassed(false);
    };
  }, [active, ref, name, fallback]);
  return active && passed;
}

export interface Waiting {
  /** --pw-delay-spinner has passed: the skeletons and the status show. */
  shown: boolean;
  /** --pw-delay-long has passed: the line saying what's slow shows too. */
  long: boolean;
}

/** How long `active` has held, against --pw-delay-spinner and --pw-delay-long, read from `ref`'s element. */
export function useWaiting(ref: RefObject<Element | null>, active: boolean): Waiting {
  return {
    shown: useWaited(ref, '--pw-delay-spinner', SPINNER_DELAY_MS, active),
    long: useWaited(ref, '--pw-delay-long', LONG_DELAY_MS, active),
  };
}

/** One 12 px bar. Its width comes from its class: `identity`, `preview` or `title`, or the item it's in. */
function Bar({ kind }: { kind?: 'identity' | 'preview' | 'title' | 'meta' }) {
  return <span className={kind ? `skeleton-bar ${kind}` : 'skeleton-bar'} />;
}

/** Three skeleton rows, each a session row's height: its name line and its second line. */
export function SkeletonRows() {
  return (
    <ul className="skeleton-rows" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <li key={row} className="skeleton-row">
          <span className="skeleton-line">
            <Bar kind="identity" />
          </span>
          <span className="skeleton-line">
            <Bar kind="preview" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Four skeleton items in the repo list, each a repo list item's height. */
export function SkeletonItems() {
  return (
    <ul className="repo-items skeleton-items" aria-hidden="true">
      {[0, 1, 2, 3].map((item) => (
        <li key={item} className="skeleton-item">
          <Bar />
        </li>
      ))}
    </ul>
  );
}

/** The session view's header while it waits: a bar for the name, and one for the line below it. */
export function SkeletonHeading() {
  return (
    <span className="skeleton-heading" aria-hidden="true">
      <Bar kind="title" />
    </span>
  );
}

export function SkeletonMeta() {
  return (
    <span className="skeleton-line skeleton-meta" aria-hidden="true">
      <Bar kind="meta" />
    </span>
  );
}

export interface WaitingStatusProps {
  waiting: Waiting;
  /** What's loading, for screen readers: "Loading sessions". */
  label: string;
  /** What's slow, shown and announced after --pw-delay-long: "Still waiting for `claude agents`…". */
  slow: ReactNode;
}

/**
 * The status of a waiting state: a role="status" region, there from the start so what it comes to
 * say is announced, holding the visually hidden label once --pw-delay-spinner has passed, then the
 * visible long-wait line, a status line, once --pw-delay-long has.
 */
export function WaitingStatus({ waiting, label, slow }: WaitingStatusProps) {
  return (
    <div className="waiting-status" role="status">
      {waiting.shown && <span className="visually-hidden">{label}</span>}
      {waiting.long && <p className="status-line">{slow}</p>}
    </div>
  );
}
