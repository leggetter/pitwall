// The session view's Pull requests tab (W106; docs/design-system.md, 4: Session view, and Pull
// requests): the open PRs the session owns, each with what the PR view says of it, its checks with
// the failing ones named, its review, whether it merges and whether it's a draft, and Open on GitHub;
// then the open PRs it's strongly linked to but doesn't own, each saying which session does, since
// that's where the PR is listed. Each PR's title is a link button that opens its PR view in the
// session view's place, as ?pr= does.
//
// The tab shows once the session owns an open PR or is strongly linked to one, after Sub-agents, and,
// as Sub-agents does, it stays once shown, so the tab row never loses a tab under you: a PR that has
// closed since leaves the panel saying there's none open.

import { useId } from 'react';
import type { PullRequestSummary, SessionSummary } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { githubPrUrl, prKey, prName, prRelationText } from '../prs.js';
import { EmptyState } from './EmptyState.js';
import { Icon } from './Icon.js';
import { PrStateBadges } from './PrBadges.js';
import { OPEN_ON_GITHUB, PrDetails } from './PrDetails.js';
import { Tooltip } from './Tooltip.js';

/** A PR the session is linked to but doesn't own, and the session that owns it, if it's listed. */
export interface LinkedPr {
  pr: PullRequestSummary;
  owner?: SessionSummary | undefined;
}

/** The tab's count, in its label: "Pull requests (3)", every PR it lists. */
export const sessionPrsCount = (owned: readonly unknown[], linked: readonly unknown[]): number => owned.length + linked.length;

/** The second section's note: why these aren't the session's own. */
export const LINKED_NOTE = 'It worked on these too, but another session acted on each one since, so each is listed with that session.';

/** The panel with no open PR, as after the last one closed. */
export const NO_SESSION_PRS = { title: 'No open pull requests', sentence: "The pull requests this session worked on have closed, or aren't among yours on github.com any more." } as const;

/** "Listed with pitwall-test-api." after a linked PR's badges, or why it's listed with no session. */
export const ownedByText = (owner: SessionSummary | undefined) => (owner ? `Listed with ${plainText(owner.name)}.` : 'Listed with another session.');

function SessionPr({ pr, owner, linked, onOpen }: { pr: PullRequestSummary; owner?: SessionSummary | undefined; linked: boolean; onOpen: (pr: PullRequestSummary) => void }) {
  const titleId = useId();
  const title = plainText(pr.title);
  const url = githubPrUrl(pr);
  const relation = prRelationText(pr);
  return (
    <article className="session-pr" data-session-pr={prKey(pr)} aria-labelledby={titleId}>
      <div className="session-pr-head">
        <h4 className="session-pr-title" id={titleId}>
          <button type="button" className="link-button session-pr-open" data-open-session-pr={prKey(pr)} onClick={() => onOpen(pr)}>
            <span className="pr-row-number">#{pr.number}</span> <bdi>{title}</bdi>
          </button>
        </h4>
        {url && (
          <Tooltip content={OPEN_ON_GITHUB} relation="label">
            <a className="icon-button ghost sm pr-view-github" href={url} target="_blank" rel="noopener noreferrer">
              <Icon name="external" />
            </a>
          </Tooltip>
        )}
      </div>
      <div className="session-pr-meta">
        <span className="pr-view-repo">{prName(pr)}</span>
        <PrStateBadges pr={pr} />
      </div>
      {relation !== undefined && <p className="session-pr-note">{relation}</p>}
      {linked && <p className="session-pr-note session-pr-owner">{ownedByText(owner)}</p>}
      <PrDetails pr={pr} />
    </article>
  );
}

export interface SessionPrsPanelProps {
  /** The open PRs the session owns, most urgent first. */
  owned: readonly PullRequestSummary[];
  /** The open PRs it's strongly linked to that another session owns. */
  linked: readonly LinkedPr[];
  /** Opens a PR's view in the session view's place. */
  onOpen: (pr: PullRequestSummary) => void;
  id: string;
  labelledBy: string;
  hidden: boolean;
}

export function SessionPrsPanel({ owned, linked, onOpen, id, labelledBy, hidden }: SessionPrsPanelProps) {
  const ownedId = useId();
  const linkedId = useId();
  const none = owned.length === 0 && linked.length === 0;
  return (
    // A Tab stop, as the conversation is, so the keyboard can scroll it.
    <div className="session-view-body session-prs" role="tabpanel" id={id} aria-labelledby={labelledBy} hidden={hidden} tabIndex={0}>
      {none && <EmptyState icon="info" title={NO_SESSION_PRS.title} sentence={NO_SESSION_PRS.sentence} />}
      {owned.length > 0 && (
        <section className="session-prs-section" aria-labelledby={ownedId}>
          <h3 className="pr-view-heading" id={ownedId}>
            Its pull requests
          </h3>
          {owned.map((pr) => (
            <SessionPr key={prKey(pr)} pr={pr} linked={false} onOpen={onOpen} />
          ))}
        </section>
      )}
      {linked.length > 0 && (
        <section className="session-prs-section" aria-labelledby={linkedId}>
          <h3 className="pr-view-heading" id={linkedId}>
            Also worked on
          </h3>
          <p className="session-prs-intro">{LINKED_NOTE}</p>
          {linked.map(({ pr, owner }) => (
            <SessionPr key={prKey(pr)} pr={pr} owner={owner} linked onOpen={onOpen} />
          ))}
        </section>
      )}
    </div>
  );
}
