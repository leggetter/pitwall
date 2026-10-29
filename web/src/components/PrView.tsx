// The PR view (M4, W95; docs/design-system.md, 4: Pull requests, The PR view): one pull request, in
// the session view's place, as the third column from 1,200 px or over the list below that, in the
// session view's own frame (Frame and Top in SessionView.tsx). A header with its title, in <bdi>,
// Open on GitHub, Copy link and Close, then its repo and number and its state badges; then its details, the checks with the failing ones' names, the review, whether it merges,
// draft, its branch, and when it was opened and updated; then the sessions strongly linked to it, and
// those that only mentioned it, each opening that session.
//
// Open on GitHub is a link that leaves pitwall, in a new tab, with noopener and noreferrer, and only
// for the PR's own https://github.com/ address (githubPrUrl()); otherwise there's neither it nor Copy
// link. Titles, check names and branch names are text, never markup.
//
// Two more states take its place: waiting, while a ?pr= from the URL waits for the first 'prs'
// message, and unlisted, for one that isn't among your open PRs. One that leaves the list while it's
// open, merged or closed, shows what it showed last, with an alert that says so; so does one whose
// list is off or failed since, but not while the first fetch after a restart runs (PrMissing).

import { useId, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { PrLinkKind, PullRequestSummary } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import type { NotNeeded } from '../notNeeded.js';
import { githubPrUrl, prName, type LinkedSession } from '../prs.js';
import { statusBadge } from '../sessions.js';
import { Alert } from './Alert.js';
import { StatusBadge } from './Badge.js';
import { CopyButton } from './CopyButton.js';
import { EmptyState } from './EmptyState.js';
import { Icon } from './Icon.js';
import { PrStateBadges } from './PrBadges.js';
import { PR_VIEW_ID } from './PrList.js';
import { Frame, Top, type SessionViewLayout } from './SessionView.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';
import { SkeletonHeading, SkeletonMeta, WaitingStatus, type Waiting } from './Waiting.js';

/** Open on GitHub's name and tooltip, and Copy link's. */
export const OPEN_ON_GITHUB = 'Open on GitHub';
export const COPY_LINK = 'Copy link';

/** Why a session is linked to the PR, after its name (PrLinkKind). */
export const LINK_KINDS: Readonly<Record<PrLinkKind, string>> = {
  opened: 'Opened it',
  pushed: 'Pushed its branch',
  prompted: 'Given it in a prompt',
  mentioned: 'Named it in a reply',
};

/** The Sessions section with none: how a session comes to be listed here. */
export const NO_LINKED_SESSIONS = 'No session has opened it, pushed its branch or been given its link in a prompt, as far as pitwall can tell.';

/**
 * Why the view shows what a PR showed last, once the latest list doesn't have it (PrViewProps.missing):
 * - 'gone': a list fetched since doesn't have it, so it may have been merged or closed.
 * - 'off': pull requests are off, as after a restart with `--no-prs`.
 * - 'failed': the latest fetch failed with no list, so pitwall can't say.
 * Not while the first fetch after a restart is still running: that list says nothing yet.
 */
export type PrMissing = 'gone' | 'off' | 'failed';

export const PR_MISSING: Readonly<Record<PrMissing, string>> = {
  gone: "It's no longer among your open pull requests, so it may have been merged or closed. This is what it showed last.",
  off: "Pull requests are off: pitwall was started with --no-prs, so it doesn't run gh. This is what it showed last.",
  failed: "pitwall couldn't list your pull requests just now, so this is what it showed last.",
};

/** The alert once the PR has left a list fetched since it was open. */
export const PR_GONE = PR_MISSING.gone;

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

/** Ignores keys with a modifier, and keys typed into a field. */
function plainKey(event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const target = event.target;
  return !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);
}

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

/** One linked session: its name, a button that opens it, its status badge, its last activity, and why it's linked. */
function LinkedRow({ linked, notNeeded, onOpen }: { linked: LinkedSession; notNeeded: NotNeeded | undefined; onOpen: (sessionId: string) => void }) {
  const { session, link } = linked;
  return (
    <li className={session.finished ? 'pr-view-session finished' : 'pr-view-session'}>
      <button type="button" className="link-button pr-view-session-open" data-open-linked-session={session.sessionId} onClick={() => onOpen(session.sessionId)}>
        <bdi>{plainText(session.name)}</bdi>
      </button>
      <StatusBadge badge={statusBadge(session, notNeeded)} />
      {session.lastActivityAt && <Timestamp className="pr-view-session-activity" at={session.lastActivityAt} prefix="Active " />}
      <span className="pr-view-session-why">{LINK_KINDS[link.kind]}</span>
    </li>
  );
}

export interface PrViewProps {
  pr: PullRequestSummary;
  /**
   * Set once the latest list doesn't have it, and why (PrMissing): the view keeps what it showed,
   * with an alert that says so. Undefined while it's listed, or while the first fetch since a
   * restart runs, whose list says nothing yet.
   */
  missing?: PrMissing | undefined;
  /** The sessions linked to it (sessionsFor() in prs.ts): strongly, and those that only mentioned it. */
  sessions: { strong: readonly LinkedSession[]; mentioned: readonly LinkedSession[] };
  /** The viewer's Not needed now marks (W88), for the sessions' status badges. */
  notNeeded?: NotNeeded | undefined;
  /** Opens a linked session's view, in this view's place. */
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
  layout?: SessionViewLayout;
  compact?: boolean;
  /** The heading, which takes focus when the view is opened from a row or a session's link. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** ↑ and ↓ in the header: the previous or next PR in the PR list. */
  onStep?: ((step: 1 | -1) => void) | undefined;
  /** Slide in when it opens over the list. False when it takes over from another view. */
  animate?: boolean;
  /** At 600 px and narrower, in Close's place: "Back to pull requests", or "Back to sessions" over the session list. */
  backLabel?: string | undefined;
}

export function PrView({ pr, missing, sessions, notNeeded, onOpenSession, onClose, layout = 'overlay', compact = false, headingRef, onStep, animate = true, backLabel }: PrViewProps) {
  const ids = { title: useId(), details: useId(), sessions: useId(), mentioned: useId() };
  const title = plainText(pr.title);
  const url = githubPrUrl(pr);
  const onHeaderKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!onStep || event.defaultPrevented || !plainKey(event)) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    onStep(event.key === 'ArrowDown' ? 1 : -1);
  };
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
    <Frame layout={layout} id={PR_VIEW_ID} className="pr-view" animate={animate} titleId={ids.title} onEscape={onClose}>
      <header className="session-view-head" onKeyDown={onHeaderKey}>
        <Top
          compact={compact}
          onClose={onClose}
          backLabel={backLabel}
          end={
            url && (
              <>
                <Tooltip content={OPEN_ON_GITHUB} relation="label">
                  <a className="icon-button ghost md pr-view-github" href={url} target="_blank" rel="noopener noreferrer">
                    <Icon name="external" />
                  </a>
                </Tooltip>
                <CopyButton text={url} label={COPY_LINK} size="md" />
              </>
            )
          }
        >
          {/* Focused when the view opens from a row or a link, with no ring of its own (6.1, item 8). */}
          <h2 className="session-view-title" id={ids.title} ref={headingRef} tabIndex={-1}>
            <Tooltip content={title} relation="none" onlyIfCut>
              <span className="session-view-name">
                <bdi>{title}</bdi>
              </span>
            </Tooltip>
          </h2>
        </Top>
        <div className="session-view-meta">
          <span className="pr-view-repo">{prName(pr)}</span>
          <PrStateBadges pr={pr} />
        </div>
        {missing !== undefined && (
          <Alert tone="neutral" role="status">
            {PR_MISSING[missing]}
          </Alert>
        )}
      </header>
      <div className="session-view-body pr-view-body">
        <section className="pr-view-section" aria-labelledby={ids.details}>
          <h3 className="pr-view-heading" id={ids.details}>
            Details
          </h3>
          <dl className="pr-view-details">
            {rows.map(([term, value]) => (
              <div key={term} className="pr-view-detail">
                <dt>{term}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="pr-view-section" aria-labelledby={ids.sessions}>
          <h3 className="pr-view-heading" id={ids.sessions}>
            Sessions
          </h3>
          {sessions.strong.length > 0 ? (
            <ul className="pr-view-sessions">
              {sessions.strong.map((linked) => (
                <LinkedRow key={linked.session.sessionId} linked={linked} notNeeded={notNeeded} onOpen={onOpenSession} />
              ))}
            </ul>
          ) : (
            <p className="pr-view-none">{NO_LINKED_SESSIONS}</p>
          )}
        </section>
        {sessions.mentioned.length > 0 && (
          <section className="pr-view-section" aria-labelledby={ids.mentioned}>
            <h3 className="pr-view-heading" id={ids.mentioned}>
              Mentioned in
            </h3>
            <ul className="pr-view-sessions">
              {sessions.mentioned.map((linked) => (
                <LinkedRow key={linked.session.sessionId} linked={linked} notNeeded={notNeeded} onOpen={onOpenSession} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </Frame>
  );
}

interface StateViewProps {
  onClose: () => void;
  layout?: SessionViewLayout;
  compact?: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  animate?: boolean;
  backLabel?: string | undefined;
}

/**
 * A ?pr= that isn't among your open PRs, and wasn't while this page was open: the view says so, as an
 * empty state whose title is its heading, with `why`, and offers Close.
 */
export function UnlistedPrView({ prKey, why, onClose, layout = 'overlay', compact = false, headingRef, animate = true, backLabel }: StateViewProps & { prKey: string; why?: ReactNode }) {
  const titleId = useId();
  const slash = prKey.lastIndexOf('/');
  const named = slash > 0 ? `${prKey.slice(0, slash)} #${prKey.slice(slash + 1)}` : prKey;
  return (
    <Frame layout={layout} id={PR_VIEW_ID} className="pr-view" animate={animate} titleId={titleId} onEscape={onClose}>
      <header className="session-view-head">
        <Top compact={compact} onClose={onClose} backLabel={backLabel}>
          <span className="session-view-spacer" />
        </Top>
      </header>
      <div className="session-view-body session-view-state">
        <EmptyState
          icon="info"
          heading={{ id: titleId, ref: headingRef }}
          title="This pull request isn't listed"
          sentence={
            why ?? (
              <>
                <code>{plainText(named)}</code> isn't among your open pull requests on github.com. It may have been merged or closed, or opened by someone else.
              </>
            )
          }
        />
      </div>
    </Frame>
  );
}

/** A ?pr= before the first 'prs' message, or before the first fetch has finished: the view, with Close, and skeletons. */
export function WaitingPrView({ waiting, onClose, layout = 'overlay', compact = false, headingRef, animate = true, backLabel }: StateViewProps & { waiting: Waiting }) {
  const titleId = useId();
  return (
    <Frame layout={layout} id={PR_VIEW_ID} className="pr-view" animate={animate} titleId={titleId} onEscape={onClose}>
      <header className="session-view-head">
        <Top compact={compact} onClose={onClose} backLabel={backLabel}>
          <h2 className="session-view-title" id={titleId} ref={headingRef} tabIndex={-1}>
            <span className="visually-hidden">Pull request</span>
            {waiting.shown && <SkeletonHeading />}
          </h2>
        </Top>
        {waiting.shown && <SkeletonMeta />}
      </header>
      <div className="session-view-body">
        <WaitingStatus
          waiting={waiting}
          label="Loading the pull request"
          slow={
            <>
              Still waiting for <code>gh</code>…
            </>
          }
        />
      </div>
    </Frame>
  );
}
