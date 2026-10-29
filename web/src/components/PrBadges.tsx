// A pull request's badges (docs/design-system.md, 4: Pull requests): its state badges, as the PR row
// and the PR view show them, and the session row's PR badge, "#42", with "+2" for more, for the
// session's most urgent strongly linked open PR (M4, W95). Badges aren't focusable, so a badge's
// tooltip is hover-only; what it says is in the DOM, or in the PR view, too.

import type { PullRequestSummary } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { prKey, prName, prStateBadges, type SessionPrBadge } from '../prs.js';
import { Badge } from './Badge.js';
import { Tooltip } from './Tooltip.js';

/** A PR's state badges: how it's yours when you didn't open it, then the highlighted ones, then the quieter ones (prStateBadges()). Nothing for a healthy PR of yours. */
export function PrStateBadges({ pr }: { pr: PullRequestSummary }) {
  return (
    <>
      {prStateBadges(pr).map((badge) => (
        <Badge key={badge.state} look={badge.look} hint={badge.hint} className={`pr-state pr-state-${badge.state}`}>
          {badge.label}
        </Badge>
      ))}
    </>
  );
}

/**
 * The session row's PR badge: "#42", then "+2" when the session is strongly linked to more open PRs.
 * Subtle danger while the PR it names needs attention, subtle neutral otherwise. Not a control: its
 * tooltip, on hover, names each PR, and the session view links to each.
 */
export function SessionPrBadgeView({ badge }: { badge: SessionPrBadge }) {
  return (
    <Badge look={badge.attention ? 'subtle-danger' : 'subtle-neutral'} hint={badge.hint} className="pr-badge">
      <span className="visually-hidden">Pull request </span>#{badge.pr.number}
      {badge.attention && <span className="visually-hidden">, needs attention</span>}
      {badge.more > 0 && (
        <>
          <span className="pr-badge-more" aria-hidden="true">
            +{badge.more}
          </span>
          <span className="visually-hidden">, and {badge.more} more</span>
        </>
      )}
    </Badge>
  );
}

/** A PR link's name: "Pull request example/demo-app #42". */
export const prLinkLabel = (pr: Pick<PullRequestSummary, 'repoLabel' | 'number'>) => `Pull request ${prName(pr)}`;

/**
 * The session view's line of PR links (W95): "Pull requests", then each open PR the session is
 * strongly linked to, most urgent first, as "#42", a link button that opens its PR view, with its
 * highlighted states after it. Its name says the repo too, and its tooltip, which describes it, the
 * title. It wraps; nothing in it is cut.
 */
export function SessionPrLinks({ linked, onOpen }: { linked: readonly PullRequestSummary[]; onOpen: (pr: PullRequestSummary) => void }) {
  return (
    <div className="session-view-prs" role="group" aria-label="Pull requests">
      <span className="session-view-prs-label" aria-hidden="true">
        Pull requests
      </span>
      {linked.map((pr) => (
        <span key={prKey(pr)} className="session-view-pr">
          <Tooltip content={`${prName(pr)}: ${plainText(pr.title)}`} relation="description">
            <button type="button" className="link-button pr-link" aria-label={prLinkLabel(pr)} data-pr-link={prKey(pr)} onClick={() => onOpen(pr)}>
              #{pr.number}
            </button>
          </Tooltip>
          {prStateBadges(pr)
            .filter((badge) => badge.attention)
            .map((badge) => (
              <Badge key={badge.state} look={badge.look} hint={badge.hint} className={`pr-state pr-state-${badge.state}`}>
                {badge.label}
              </Badge>
            ))}
        </span>
      ))}
    </div>
  );
}
