// The Pull requests view's own parts (M4, W95, W101, W106; docs/design-system.md, 4: Pull requests).
// Since W106 the view is the session list (SessionList.tsx) showing every row with an open PR across
// the root tab's groups: the sessions that own one and the PR rows no session owns, each under its
// group, as the other views list them. W95's list, with a heading per repo, went with it. What it adds
// to the session list is here:
//
// - The header's filters: the field, which matches sessions as the session list's does and PRs by
//   title, repo, number and branch; W101's chips, Yours, Review requested and Mentioned, which keep
//   the rows with a PR of those kinds and combine as OR; and a line with when the list was fetched,
//   Clear filters while a filter is on, and Refresh.
// - Notices over the rows: the last list, when a fetch failed after one worked, and each search that
//   failed while the others worked (W101).
// - Its foot: Show older, for the PR rows last updated more than PRS_SHOWN_DAYS ago, which a session
//   doesn't own; how many PRs are hidden because no root claims their owner, with a link to the
//   README's Configuration section; and GitHub's PRS_MAX.
// - The body in place of the rows before the first fetch, with pull requests off, and when gh is
//   missing, isn't logged in or failed with no list, each saying how to fix it (prSourceBody()).

import type { ReactNode, RefObject } from 'react';
import { PR_RELATIONS, PRS_MAX, type PullRequestList, type PullRequestRelation } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import type { PrRefresh } from '../prRefresh.js';
import { OLDER_PRS_NOTE, olderPrsText, prListState, RELATION_CHIPS, SEARCH_NAMES, type PrListState } from '../prs.js';
import { Alert, Detail } from './Alert.js';
import { Button } from './Button.js';
import { EmptyState } from './EmptyState.js';
import { ClearFilters, FilterChips, FilterField } from './Filters.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';
import { SkeletonRows, WaitingStatus, type Waiting } from './Waiting.js';
import './PullRequests.css';

export { PR_VIEW_ID } from './PrRow.js';

/** The filter field's label and placeholder in the Pull requests view. */
export const PR_FILTER_LABEL = 'Filter pull requests';
export const PR_FILTER_PLACEHOLDER = 'Filter by session, title, repo or number';

/** Refresh's name and tooltip, and its tooltip while it's off or busy, which describes it. */
export const REFRESH_LABEL = 'Refresh pull requests';
export const REFRESH_BUSY = 'Fetching your pull requests from GitHub…';
export const REFRESH_OFF = 'pitwall fetches your pull requests at most once a minute, so Refresh is off for a moment.';

/** Where the README says how to give a root its GitHub owners (W103's Configuration section). */
export const CONFIGURATION_URL = 'https://github.com/leggetter/pitwall#configuration';

/** The hidden line's link, to CONFIGURATION_URL. */
export const SHOW_HIDDEN = 'How to show them';

/** The empty state for one chip on with none of its kind (W101): what's missing, and how one gets here. */
export const NO_RELATION: Readonly<Record<PullRequestRelation, { title: string; sentence: string }>> = {
  authored: { title: 'No open pull requests of yours', sentence: 'Pull requests you open on github.com show here, with the sessions that worked on them.' },
  'review-requested': {
    title: 'No reviews requested',
    sentence: "Open pull requests that ask your review, or a team's you're on, show here. One asked of you leaves once you've reviewed it.",
  },
  mentioned: { title: 'No mentions', sentence: "Open pull requests that mention you show here, when they aren't yours and don't ask your review." },
};

/** Owners in a sentence: "example", "example or other", "a, b or c", or the first three "and 2 more". */
export function ownersText(owners: readonly string[]): string {
  const named = owners.slice(0, 3).map(plainText);
  const more = owners.length - named.length;
  if (more > 0) return `${named.join(', ')} and ${more} more`;
  if (named.length <= 1) return named[0] ?? '';
  return `${named.slice(0, -1).join(', ')} or ${named.at(-1)}`;
}

/**
 * The hidden line (W106): "3 pull requests are hidden: no root claims example or other." A PR no
 * session owns whose repo no root has cloned and whose owner no root claims isn't listed.
 */
export function hiddenText(count: number, owners: readonly string[]): string {
  const what = count === 1 ? '1 pull request is' : `${count} pull requests are`;
  return owners.length > 0 ? `${what} hidden: no root claims ${ownersText(owners)}.` : `${what} hidden: no root claims them.`;
}

/** Refresh: a ghost sm icon button, its spinner while a fetch runs, and off for a minute after a refresh (prRefresh.ts, W100). */
export function PrRefreshButton({ refresh, refreshing }: { refresh: PrRefresh; refreshing: boolean }) {
  const busy = refresh.sending || refreshing;
  const off = !busy && refresh.offUntil > Date.now();
  const tip = busy ? REFRESH_BUSY : off ? REFRESH_OFF : REFRESH_LABEL;
  return (
    // Its name, always; while it's off or busy, the tooltip says why, and describes it.
    <Tooltip content={tip} relation={busy || off ? 'description' : 'label'}>
      <button
        type="button"
        className="icon-button ghost sm pr-refresh"
        aria-label={REFRESH_LABEL}
        aria-disabled={busy || off || undefined}
        aria-busy={busy || undefined}
        data-pr-refresh=""
        onClick={() => {
          if (!busy && !off) refresh.refresh();
        }}
      >
        {busy ? <Spinner size="button" /> : <Icon name="retry" />}
      </button>
    </Tooltip>
  );
}

/** The empty states' Refresh: an outline button, busy while the request is out or a fetch runs. */
export function RefreshAction({ refresh, refreshing }: { refresh: PrRefresh; refreshing: boolean }) {
  const busy = refresh.sending || refreshing;
  const off = !busy && refresh.offUntil > Date.now();
  return (
    <Tooltip content={off ? REFRESH_OFF : undefined} relation="description">
      <Button icon="retry" busy={busy} busyLabel="Refreshing…" disabled={off} onClick={refresh.refresh}>
        Refresh
      </Button>
    </Tooltip>
  );
}

export interface PrListFiltersProps {
  list: PullRequestList | undefined;
  /** Whether the view has rows to filter: the field and the chips show only then. */
  hasRows: boolean;
  filter: string;
  onFilter: (text: string) => void;
  /** The chips that are on (W101): Yours, Review requested and Mentioned. None is All. */
  relations: ReadonlySet<PullRequestRelation>;
  onRelations: (relations: ReadonlySet<PullRequestRelation>) => void;
  /** The filter field, for the `/` shortcut. */
  fieldRef?: RefObject<HTMLInputElement | null>;
  refresh: PrRefresh;
  /** Clear filters: the text and the chips, with focus in the field, since the button goes. */
  onClear: () => void;
}

/**
 * The header's lines after line 1: the field, the chips, then when the list was fetched, Clear filters
 * while a filter is on, and Refresh. Clear filters sits before Refresh, not after the chips: the three
 * chips and its room don't fit one line of a 360 px list (W101).
 */
export function PrListFilters({ list, hasRows, filter, onFilter, relations, onRelations, fieldRef, refresh, onClear }: PrListFiltersProps) {
  const state = prListState(list);
  const refreshing = list?.refreshing ?? false;
  const filtering = filter.trim() !== '' || relations.size > 0;
  return (
    <>
      {state.kind === 'list' && hasRows && (
        <form className="filter-controls pr-filter" role="search" onSubmit={(event) => event.preventDefault()}>
          <FilterField value={filter} onChange={onFilter} inputRef={fieldRef} label={PR_FILTER_LABEL} placeholder={PR_FILTER_PLACEHOLDER} />
          <FilterChips chips={relations} onChange={onRelations} options={PR_RELATIONS} labels={RELATION_CHIPS} />
        </form>
      )}
      {state.kind !== 'off' && (
        <div className="pr-list-fetched">
          <span className="pr-list-updated">
            {list?.fetchedAt !== undefined ? (
              <Timestamp at={list.fetchedAt} prefix="Updated " />
            ) : refreshing || state.kind === 'loading' ? (
              'Fetching from GitHub…'
            ) : (
              'Not fetched yet'
            )}
          </span>
          <span className="pr-list-actions">
            {state.kind === 'list' && hasRows && filtering && <ClearFilters on onClear={onClear} />}
            <PrRefreshButton refresh={refresh} refreshing={refreshing} />
          </span>
        </div>
      )}
    </>
  );
}

/**
 * The notices over the rows: each search that failed while another worked, with when its PRs are
 * from (W101); or the last list, when the latest fetch failed after one worked.
 */
export function PrNotices({ list }: { list: PullRequestList | undefined }): ReactNode {
  const state = prListState(list);
  if (state.kind !== 'list') return null;
  const failed = state.failed ?? [];
  const { stale } = state;
  if (failed.length === 0 && !stale) return null;
  return (
    <>
      {failed.length > 0 && (
        <div className="pr-stale">
          <Alert tone="warning" role="status" title="Couldn't refresh part of your pull requests">
            {failed.map((each) => (
              <p key={each.relation} className="pr-stale-search" data-search={each.relation}>
                {SEARCH_NAMES[each.relation]}{' '}
                {each.fetchedAt === undefined ? (
                  "aren't listed."
                ) : (
                  <>
                    are from <Timestamp at={each.fetchedAt} />.
                  </>
                )}{' '}
                <Detail>{plainText(each.error)}</Detail>
              </p>
            ))}
          </Alert>
        </div>
      )}
      {stale && (
        <div className="pr-stale">
          <Alert tone="warning" role="status" title="Couldn't refresh your pull requests">
            {stale.reason === 'gh-missing' ? (
              <>
                <code>gh</code> isn't on pitwall's <code>PATH</code> any more.
              </>
            ) : stale.reason === 'gh-auth' ? (
              <>
                <code>gh</code> isn't logged in to GitHub: run <code>gh auth login</code>, then Refresh.
              </>
            ) : (
              <Detail>{plainText(stale.error)}</Detail>
            )}{' '}
            This list is from <Timestamp at={state.fetchedAt} />.
          </Alert>
        </div>
      )}
    </>
  );
}

export interface PrListFootProps {
  list: PullRequestList | undefined;
  /** PR rows left out as older than PRS_SHOWN_DAYS, while Show older is off. */
  older: number;
  showOlder: boolean;
  onToggleOlder: () => void;
  /** How many PRs no root claims, and their owners. */
  hidden: number;
  hiddenOwners: readonly string[];
  /** The id of Show older's describing line. */
  olderNoteId: string;
}

/** Show older, while there are older PR rows or they're shown. Its button keeps focus as Hide older, the same button. */
export function OlderPrs({ older, showOlder, onToggleOlder, olderNoteId }: Pick<PrListFootProps, 'older' | 'showOlder' | 'onToggleOlder' | 'olderNoteId'>) {
  if (older === 0 && !showOlder) return null;
  return (
    <div className="finished-older pr-older">
      <Button size="sm" aria-describedby={olderNoteId} onClick={onToggleOlder} data-older-prs-toggle="">
        {olderPrsText(older, showOlder)}
      </Button>
      <span className="finished-older-note" id={olderNoteId}>
        {OLDER_PRS_NOTE}
      </span>
    </div>
  );
}

/** The hidden line, with its link to the README's Configuration section, in a new tab with no opener or referrer. */
export function HiddenPrs({ hidden, hiddenOwners }: Pick<PrListFootProps, 'hidden' | 'hiddenOwners'>) {
  if (hidden === 0) return null;
  return (
    <p className="pr-hidden" data-hidden-prs={hidden}>
      {hiddenText(hidden, hiddenOwners)}{' '}
      <a href={CONFIGURATION_URL} target="_blank" rel="noopener noreferrer">
        {SHOW_HIDDEN}
      </a>
    </p>
  );
}

/** The foot of the Pull requests view's rows: Show older, the hidden line and GitHub's PRS_MAX. */
export function PrListFoot(props: PrListFootProps) {
  const { list } = props;
  const truncated = list?.truncated === true;
  if (props.older === 0 && !props.showOlder && props.hidden === 0 && !truncated) return null;
  return (
    <div className="pr-list-foot">
      <OlderPrs {...props} />
      <HiddenPrs {...props} />
      {truncated && (
        <p className="pr-truncated">GitHub found more than {PRS_MAX} pull requests for one of its searches, so the {PRS_MAX} of them updated most recently are listed.</p>
      )}
    </div>
  );
}

/**
 * The body in place of the rows while the source has no list (docs/design-system.md, 4: Pull
 * requests, States): skeletons before the first fetch, off, and gh missing, not logged in or failed,
 * each with how to fix it. Undefined once there's a list.
 */
export function prSourceBody(state: PrListState, { refresh, refreshing, waiting, onShowAll }: { refresh: PrRefresh; refreshing: boolean; waiting: Waiting; onShowAll?: (() => void) | undefined }): ReactNode {
  if (state.kind === 'loading') {
    return (
      <div className="list-waiting">
        {waiting.shown && <SkeletonRows />}
        <WaitingStatus
          waiting={waiting}
          label="Loading pull requests"
          slow={
            <>
              Still waiting for <code>gh</code>…
            </>
          }
        />
      </div>
    );
  }
  if (state.kind === 'off') {
    return (
      <EmptyState
        icon="info"
        title="Pull requests are off"
        sentence={
          <>
            pitwall was started with <code>--no-prs</code>, so it doesn't run <code>gh</code>. Start it without <code>--no-prs</code> to list your open pull
            requests here.
          </>
        }
        actions={onShowAll && <Button onClick={onShowAll}>Show all sessions</Button>}
      />
    );
  }
  if (state.kind === 'failed') {
    return (
      <EmptyState
        icon={state.reason === 'error' ? 'error' : 'warning'}
        title={state.reason === 'gh-missing' ? "gh isn't installed" : state.reason === 'gh-auth' ? "gh isn't logged in to GitHub" : "Couldn't list your pull requests"}
        sentence={
          state.reason === 'gh-missing' ? (
            <>
              pitwall lists them with GitHub's CLI, <code>gh</code>, which isn't on its <code>PATH</code>. Install it from cli.github.com, run{' '}
              <code>gh auth login</code>, then Refresh.
            </>
          ) : state.reason === 'gh-auth' ? (
            <>
              pitwall lists them with <code>gh</code>. Run <code>gh auth login</code> in a terminal, then Refresh.
            </>
          ) : (
            <>
              <Detail>{plainText(state.error)}</Detail> Refresh to try again.
            </>
          )
        }
        actions={<RefreshAction refresh={refresh} refreshing={refreshing} />}
      />
    );
  }
  return undefined;
}
