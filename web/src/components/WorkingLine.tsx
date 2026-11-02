// The working line (W102; docs/design-system.md, 4: Conversation): at the end of the Conversation tab,
// after the newest entry, while the session works or waits on you (working.ts says which, and what).
//
// - Working: the spinner, or under reduced motion a steady dot, since nothing should spin then; then
//   "Working · 2m 14s", the time since the turn started, ticking on the page's one clock; and under it
//   the current step, "Running Bash: npm test", on one line, cut with an ellipsis and whole in a
//   tooltip. The time is hidden from screen readers, which would otherwise hear it change.
// - Waiting: the warning icon, "Waiting for you: permission prompt", and where to answer. No time.
//
// Announcements: one visually hidden status region, always in the panel, says "Claude is working" as a
// turn starts, "Finished" as it ends, or the waiting text, once each, never at a tick of the timer or a
// change of step (6.1, item 9). Nothing is said for the state the view opened in, as when j or k steps
// onto a working session, nor before the conversation's first page has said whether its turn has ended.

import { useEffect, useRef, useState } from 'react';
import { useNow } from '../clock.js';
import { elapsedText, FINISHED_ANNOUNCEMENT, waitingAnnouncement, WORKING_ANNOUNCEMENT, type WorkingLineState } from '../working.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';
import { Tooltip } from './Tooltip.js';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Whether the reader asks for less motion now (2.13). */
function reducedMotion(): boolean {
  try {
    return window.matchMedia(REDUCED_MOTION).matches;
  } catch {
    return false;
  }
}

/** Whether the reader asks for less motion (2.13), and again whenever that changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedMotion);
  useEffect(() => {
    let query: MediaQueryList | undefined;
    try {
      query = window.matchMedia(REDUCED_MOTION);
    } catch {
      return undefined;
    }
    if (typeof query?.addEventListener !== 'function') return undefined;
    const media = query;
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** " · 2m 14s", ticking on the shared clock; hidden from screen readers. */
function Elapsed({ since, atLeast }: { since: string; atLeast: boolean }) {
  const now = useNow();
  return (
    <span className="working-time" aria-hidden="true">
      {' · '}
      {elapsedText(now - Date.parse(since), atLeast)}
    </span>
  );
}

export interface WorkingLineProps {
  line: Exclude<WorkingLineState, { mode: 'idle' }>;
  /** Draws the steady dot in the spinner's place, as reduced motion does, for the gallery. By default, the reader's setting. */
  steady?: boolean;
}

/** The line itself, for a session that's working or waiting on you. */
export function WorkingLine({ line, steady }: WorkingLineProps) {
  const reduced = useReducedMotion();
  if (line.mode === 'waiting') {
    return (
      <div className="working-line waiting">
        <span className="working-indicator">
          <Icon name="warning" />
        </span>
        <div className="working-body">
          <p className="working-status">{line.text}</p>
          {line.where !== undefined && <p className="working-where">{line.where}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="working-line">
      <span className="working-indicator">{(steady ?? reduced) ? <span className="status-dot working-dot" aria-hidden="true" /> : <Spinner />}</span>
      <div className="working-body">
        <p className="working-status">
          Working
          {line.since !== undefined && <Elapsed since={line.since} atLeast={line.atLeast === true} />}
        </p>
        {/* Never focusable, so it opens on hover; the whole step is in the DOM for screen readers and find. */}
        <Tooltip content={line.step} relation="none" onlyIfCut>
          <p className="working-step">{line.step}</p>
        </Tooltip>
      </div>
    </div>
  );
}

/** What a state says when it's arrived at: undefined for idle, which says "Finished" only after another. */
function announcementOf(line: WorkingLineState): string | undefined {
  if (line.mode === 'working') return WORKING_ANNOUNCEMENT;
  if (line.mode === 'waiting') return waitingAnnouncement(line);
  return undefined;
}

/**
 * The status region's text: what the latest change of state said, once. `ready` is false until the
 * conversation's first page has come back, which can say the turn has ended though Claude Code says
 * it's busy; until then, and for the state it then finds, nothing is said.
 */
export function useWorkingAnnouncement(line: WorkingLineState, ready: boolean): string {
  const [said, setSaid] = useState('');
  // What the last state would say, or 'idle', once the first page is in; undefined before.
  const last = useRef<string | undefined>(undefined);
  const now = announcementOf(line) ?? 'idle';
  useEffect(() => {
    if (!ready) return;
    const before = last.current;
    last.current = now;
    if (before === undefined || before === now) return;
    setSaid(now === 'idle' ? FINISHED_ANNOUNCEMENT : now);
  }, [now, ready]);
  return said;
}

/** The status region, always in the session's Conversation panel: polite, visually hidden. */
export function WorkingAnnouncer({ line, ready }: { line: WorkingLineState; ready: boolean }) {
  const said = useWorkingAnnouncement(line, ready);
  return (
    <p className="visually-hidden working-announcer" role="status">
      {said}
    </p>
  );
}
