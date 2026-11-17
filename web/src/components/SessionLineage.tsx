// The session view's lineage line (W167; docs/design-system.md, 4: Session view): "Continued from
// <session>" and "Continued in <session>", after a /clear or a hand-off. A session pitwall lists is
// a link button that opens its view; one it doesn't list (ended, or outside the roots) is named in
// words, with no link, since there's no view to open.

import { plainText } from '../format.js';

/** One end of a link: the session's id and, when pitwall lists it, its name. */
export interface LineageTarget {
  sessionId: string;
  /** Set when the session is listed. */
  name?: string | undefined;
}

export interface SessionLineageProps {
  from?: LineageTarget | undefined;
  to?: LineageTarget | undefined;
  onOpen: (sessionId: string) => void;
}

/** What a session pitwall doesn't list is called. */
export const UNLISTED_SESSION = 'a session pitwall no longer lists';

function Target({ target, onOpen, kind }: { target: LineageTarget; onOpen: (sessionId: string) => void; kind: 'from' | 'to' }) {
  if (target.name === undefined) return <span className="session-view-lineage-unlisted">{UNLISTED_SESSION}</span>;
  return (
    <button type="button" className="link-button session-view-lineage-link" data-lineage-link={kind} data-open-lineage={target.sessionId} onClick={() => onOpen(target.sessionId)}>
      <bdi>{plainText(target.name)}</bdi>
    </button>
  );
}

/** Nothing when the session has no lineage. */
export function SessionLineage({ from, to, onOpen }: SessionLineageProps) {
  if (from === undefined && to === undefined) return null;
  return (
    <p className="session-view-lineage" data-session-lineage="">
      {from && (
        <span className="session-view-lineage-item">
          Continued from <Target target={from} onOpen={onOpen} kind="from" />
        </span>
      )}
      {to && (
        <span className="session-view-lineage-item">
          Continued in <Target target={to} onOpen={onOpen} kind="to" />
        </span>
      )}
    </p>
  );
}
