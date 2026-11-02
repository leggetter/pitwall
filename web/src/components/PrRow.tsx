// A pull request's row (W106; docs/design-system.md, 4: Pull requests, PR rows): an open PR no
// session owns, in the session list beside the session rows, under the repo the server placed it in.
// Two lines, as a session row has (D12):
//
// 1. "#128" and its title, in <bdi>, a button that opens the PR view in the third column, as ?pr=;
//    then its badges, Review requested or Mentioned first on one that isn't yours (W101), then its
//    own states; then when it was updated, in the time's fixed slot, as a session row has its last
//    activity there; then, where a session row has its star, its action (W107, PrStartButton): New
//    session in a cloned repo, or Clone and start in one that isn't, shown on hover and focus as an
//    unpressed star is.
// 2. Its group's label in the views that list every group; then why it needs you, "CI is failing",
//    or else how it's yours, "Yours"; and, never cut, "No session listed", which is true whether or
//    not a session worked on it that pitwall no longer lists, or "Not cloned" for a repo with no clone
//    under the root.
//
// It needs you when its PR needs attention (prNeedsAttention()), and then it has a session row's bar;
// never one older than PRS_SHOWN_DAYS, which only the Pull requests view's Show older lists.
// A click anywhere on the row that isn't a control opens it, as on a session row.

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { prNeedsAttention, type PullRequestSummary } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { prKey, prReason, RELATION_PHRASES } from '../prs.js';
import { groupLabel } from '../sessions.js';
import type { ListGroup } from '../work.js';
import { Highlight } from './Highlight.js';
import { Icon } from './Icon.js';
import { PrStateBadges } from './PrBadges.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';
import './PullRequests.css';

/** The id of the PR view, which every PR row's title controls. */
export const PR_VIEW_ID = 'pr-view';

/** The end of a PR row's line 2: no listed session owns it, or its repo has no clone under the root. */
export const NO_SESSION = 'No session listed';
export const NOT_CLONED = 'Not cloned';

/** The PR row's action's name and tooltip (W107): "New session for #57", or "Clone example/sdk-docs and start a session for #9". */
export function startLabel(pr: Pick<PullRequestSummary, 'number' | 'repoLabel' | 'place'>): string {
  return pr.place?.kind === 'not-cloned' ? `Clone ${plainText(pr.repoLabel)} and start a session for #${pr.number}` : `New session for #${pr.number}`;
}

/**
 * A PR row's action (W107): a ghost sm `add` icon button, named by its tooltip, that starts a session
 * for the PR, through Clone and start's confirmation when its repo isn't cloned. It never opens the PR.
 */
export function PrStartButton({ pr, onStart }: { pr: PullRequestSummary; onStart: (pr: PullRequestSummary) => void }) {
  return (
    <Tooltip content={startLabel(pr)} relation="label">
      <button type="button" className="icon-button ghost sm pr-start" data-start-pr={prKey(pr)} aria-haspopup="dialog" onClick={() => onStart(pr)}>
        <Icon name="add" />
      </button>
    </Tooltip>
  );
}

/** Clicks on these inside a row do their own thing, rather than opening the PR. */
const OWN_CLICK = 'a, button, input, select, textarea, label, summary, [role="button"]';

export interface PrRowProps {
  pr: PullRequestSummary;
  /** The group it's listed under: a cloned repo's, or a not-cloned repo's own. */
  group: Pick<ListGroup, 'root' | 'key' | 'label' | 'notCloned'>;
  /** Start line 2 with the group's label, as a session row does in the views that list every group. */
  showGroup?: boolean;
  isOpen?: boolean;
  /** Opens the PR view, from the title's button or a click on the row. */
  onOpen?: ((key: string) => void) | undefined;
  /** ↑ or ↓ on the title's button: the next or previous row in the list as shown. */
  onStep?: ((key: string, by: 1 | -1) => void) | undefined;
  /** W107's actions, in the slot at the end of line 1 where a session row has its star. */
  actions?: ReactNode;
  /** Older than PRS_SHOWN_DAYS, listed by the Pull requests view's Show older: it never needs you. */
  older?: boolean;
}

export function PrRow({ pr, group, showGroup = false, isOpen = false, onOpen, onStep, actions, older = false }: PrRowProps) {
  const key = prKey(pr);
  const title = plainText(pr.title);
  const attention = !older && prNeedsAttention(pr);
  const reason = prReason(pr);
  const label = showGroup ? plainText(groupLabel(group)) : undefined;
  const what = reason ?? RELATION_PHRASES[pr.relation];
  const end = group.notCloned ? NOT_CLONED : NO_SESSION;
  const openFromRow = (event: MouseEvent<HTMLLIElement>) => {
    if (!onOpen) return;
    if (event.target instanceof Element && event.target.closest(OWN_CLICK)) return;
    // Selecting text to copy it isn't a click on the row.
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    onOpen(key);
  };
  const onTitleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!onStep || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    onStep(key, event.key === 'ArrowDown' ? 1 : -1);
  };
  const className = ['session', 'pr-row', attention && 'attention', onOpen && 'openable', isOpen && 'open', pr.draft && 'pr-draft'].filter(Boolean).join(' ');
  const number = (
    <span className="pr-row-number">
      <Highlight text={`#${pr.number}`} />
    </span>
  );
  const named = (
    <>
      {number} <bdi>
        <Highlight text={title} />
      </bdi>
    </>
  );
  return (
    <li className={className} data-pr={key} data-attention={attention || undefined} onClick={openFromRow}>
      <div className="session-line">
        <div className="session-ident">
          {/* The whole title, when it's cut short: on hover, as a session row's name has its tooltip. */}
          <Tooltip content={`#${pr.number} ${title}`} relation="none" onlyIfCut>
            <h3 className="session-name pr-title">
              {onOpen ? (
                <button
                  type="button"
                  className="session-open"
                  data-open-pr={key}
                  aria-controls={PR_VIEW_ID}
                  aria-current={isOpen || undefined}
                  onClick={() => onOpen(key)}
                  onKeyDown={onTitleKey}
                >
                  {named}
                </button>
              ) : (
                named
              )}
            </h3>
          </Tooltip>
        </div>
        <span className="session-badges pr-badges">
          <PrStateBadges pr={pr} />
        </span>
        {/* When it was updated, in the time's fixed slot, so the badges line up with the session rows'. */}
        <Timestamp className="activity" at={pr.updatedAt} />
        <span className="pr-row-actions">{actions}</span>
      </div>
      <p className="session-what pr-what">
        <span className="session-what-text">
          {label !== undefined && (
            <>
              <span className="session-group">
                <Highlight text={label} />
              </span>
              <span className="session-what-sep" aria-hidden="true">
                {' · '}
              </span>
            </>
          )}
          <span className={reason === undefined ? 'pr-relation' : 'asked pr-reason'}>{what}</span>
        </span>
        {/* Quiet, and never cut, as a session row's sub-agents count is. */}
        <span className="pr-row-end">
          <span className="session-what-sep" aria-hidden="true">
            {' · '}
          </span>
          {end}
        </span>
      </p>
    </li>
  );
}
