// A pull request's details (M4, W95; docs/design-system.md, 4: Pull requests, The PR view), as the PR
// view and the session view's Pull requests tab (W106) show them: the checks, with the failing ones
// named, the review, whether it merges, draft, its branch, and when it was opened and updated. Check
// and branch names are text, never markup, in <bdi>.

import type { ReactNode } from 'react';
import type { PullRequestSummary } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { Timestamp } from './Timestamp.js';

/** Open on GitHub's name and tooltip. */
export const OPEN_ON_GITHUB = 'Open on GitHub';

/** What GitHub's mergeable says, in words. 'unknown' is GitHub still working it out, as it often is just after a push. */
const MERGEABLE: Readonly<Record<PullRequestSummary['mergeable'], string>> = {
  clean: 'No conflicts',
  conflicts: 'Conflicts with its base branch',
  unknown: 'Checking for conflicts',
};

const REVIEW: Readonly<Record<NonNullable<PullRequestSummary['review']>, string>> = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
};

const CHECKS: Readonly<Record<Exclude<PullRequestSummary['checks'], 'failing'>, string>> = {
  passing: 'Passing',
  pending: 'Pending',
  none: 'No checks',
};

/** The checks: "Failing:" and each failing check's name, then "+3 more" when more failed than are named. */
function Checks({ pr }: { pr: PullRequestSummary }) {
  if (pr.checks !== 'failing') return <>{CHECKS[pr.checks]}</>;
  const names = pr.failingChecks ?? [];
  const more = pr.failingCount !== undefined ? pr.failingCount - names.length : 0;
  return (
    <span className="pr-view-failing">
      <span className="pr-view-bad">Failing</span>
      {names.length > 0 && (
        <ul className="pr-view-checks" aria-label="Failing checks">
          {names.map((name, index) => (
            // By place as well as name: two checks can share a name.
            <li key={`${index}:${name}`}>
              <bdi>{plainText(name)}</bdi>
            </li>
          ))}
          {more > 0 && <li className="pr-view-more">+{more} more</li>}
        </ul>
      )}
    </span>
  );
}

/**
 * A PR's details (W95), as the PR view and the session view's Pull requests tab (W106) show them: the
 * checks with the failing ones named, the review, whether it merges, draft, its branch, and when it
 * was opened and updated, in a <dl>.
 */
export function PrDetails({ pr }: { pr: PullRequestSummary }) {
  const fork = pr.head && pr.head.repo !== pr.repo ? pr.head.repo : undefined;
  const rows: [string, ReactNode][] = [
    ['Checks', <Checks pr={pr} />],
    ['Review', pr.review ? REVIEW[pr.review] : 'No review required'],
    [
      'Merge',
      pr.mergeable === 'conflicts' ? <span className="pr-view-bad">{MERGEABLE.conflicts}</span> : pr.mergeable === 'unknown' ? (
        <>
          {MERGEABLE.unknown}
          <span className="pr-view-hint">: GitHub works it out after a push, so the next fetch usually knows.</span>
        </>
      ) : (
        MERGEABLE.clean
      ),
    ],
    ['Draft', pr.draft ? 'Draft' : 'Ready for review'],
    ...(pr.head
      ? ([
          [
            'Branch',
            <>
              <bdi className="pr-view-branch">{plainText(pr.head.branch)}</bdi>
              {fork && <span className="pr-view-hint">, from {plainText(fork)}</span>}
            </>,
          ],
        ] as [string, ReactNode][])
      : []),
    ['Opened', <Timestamp at={pr.createdAt} />],
    ['Updated', <Timestamp at={pr.updatedAt} />],
  ];
  return (
    <dl className="pr-view-details">
      {rows.map(([term, value]) => (
        <div key={term} className="pr-view-detail">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

