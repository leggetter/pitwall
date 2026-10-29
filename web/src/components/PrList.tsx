// The PR list (M4, W95; docs/design-system.md, 4: Pull requests): your open pull requests, in the
// session list's column while the repo list's Pull requests is selected: yours, those whose review
// is requested of you and those that mention you (W101). The page alerts, then a header that stays
// put, with "Pull requests", "12 open · 2 need attention", the filter field, the chips Yours, Review
// requested and Mentioned, when the list was fetched, Clear filters while a filter is on, and
// Refresh; then one heading per repo, each collapsible and remembered (prRepos.ts), its PRs under
// it, those that need attention first; then Show older, for the PRs last updated more than
// PRS_SHOWN_DAYS ago. Before the first fetch, skeleton rows; with pull requests off, gh missing or
// not logged in, or a fetch that failed with no list, an empty state that says how to fix it; with a
// fetch that failed after one worked, the last list, under a notice saying when it's from; with a
// search that failed while the others worked, the list, under a notice naming that part and when
// it's from; with a chip on and none of its kind, an empty state that says what's missing, or that
// its search couldn't be listed (W101).
//
// A row is two lines, as a session row is: its title, in <bdi>, its state badges, Review requested
// or Mentioned first on one that isn't yours, and when it was updated; then its number and the
// sessions strongly linked to it, two named and "+n".
// Its title is a button that opens the PR view, and so is a click anywhere on the row that isn't a
// control. While the pointer is over the list or focus is inside it, a fetch that would reorder the
// repos or their rows waits until both have left, as the session list waits for a snapshot.

import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { PR_RELATIONS, PRS_MAX, PRS_SHOWN_DAYS, type PullRequestList, type PullRequestRelation, type PullRequestSummary, type SessionSummary } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import type { PrRefresh } from '../prRefresh.js';
import {
  countPrAttention,
  filterPrs,
  filterPrsByRelation,
  groupPrs,
  listNow,
  needAttention,
  OLDER_PRS_NOTE,
  olderPrsText,
  openCount,
  prKey,
  prListState,
  RELATION_CHIPS,
  SEARCH_NAMES,
  sessionsFor,
  splitPrs,
  type LinkedSession,
  type PrListState,
  type PrRepo,
} from '../prs.js';
import { filterNeedle, holdOrder } from '../sessions.js';
import { Alert, Detail } from './Alert.js';
import { Button } from './Button.js';
import { EmptyState } from './EmptyState.js';
import { ClearFilters, FilterChips, FilterField } from './Filters.js';
import { Highlight, HighlightContext } from './Highlight.js';
import { Icon } from './Icon.js';
import { PrStateBadges } from './PrBadges.js';
import { ScrollBox } from './ScrollBox.js';
import { Spinner } from './Spinner.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';
import { SkeletonRows, useWaiting, WaitingStatus } from './Waiting.js';
import './PullRequests.css';

/** The id of the PR view, which every PR row's title controls. */
export const PR_VIEW_ID = 'pr-view';

/** The filter field's label and placeholder in the PR list. */
export const PR_FILTER_LABEL = 'Filter pull requests';
export const PR_FILTER_PLACEHOLDER = 'Filter by title, repo, number or branch';

/** Refresh's name and tooltip, and its tooltip while it's off or busy, which describes it. */
export const REFRESH_LABEL = 'Refresh pull requests';
export const REFRESH_BUSY = 'Fetching your pull requests from GitHub…';
export const REFRESH_OFF = 'pitwall fetches your pull requests at most once a minute, so Refresh is off for a moment.';

/** The empty state for one chip on with none of its kind (W101): what's missing, and how one gets here. */
export const NO_RELATION: Readonly<Record<PullRequestRelation, { title: string; sentence: string }>> = {
  authored: { title: 'No open pull requests of yours', sentence: 'Pull requests you open on github.com show here, with their checks, reviews and the sessions that worked on them.' },
  'review-requested': {
    title: 'No reviews requested',
    sentence: "Open pull requests that ask your review, or a team's you're on, show here. One asked of you leaves once you've reviewed it.",
  },
  mentioned: { title: 'No mentions', sentence: "Open pull requests that mention you show here, when they aren't yours and don't ask your review." },
};

/** How many linked sessions a row names before "+n". */
const NAMED_SESSIONS = 2;

/** Clicks on these inside a row do their own thing, rather than opening the PR. */
const OWN_CLICK = 'a, button, input, select, textarea, label, summary, [role="button"]';

export interface PrListProps {
  /** The page alerts, above the header, as the session list has them. */
  alerts?: ReactNode;
  /** The column's heading, which takes focus as the drawer closes or a view over the list does. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** The latest 'prs' message's list. Undefined until one has arrived. */
  list: PullRequestList | undefined;
  /** Every listed session, each once, for each row's strongly linked ones. */
  sessions: readonly SessionSummary[];
  filter: string;
  onFilter: (text: string) => void;
  /** The chips that are on (W101): Yours, Review requested and Mentioned. None is All. */
  relations: ReadonlySet<PullRequestRelation>;
  onRelations: (relations: ReadonlySet<PullRequestRelation>) => void;
  /** The filter field, for the `/` shortcut. */
  fieldRef?: RefObject<HTMLInputElement | null>;
  /** Show older: the PRs updated more than PRS_SHOWN_DAYS ago are listed too. */
  showOlder: boolean;
  onToggleOlder: () => void;
  /** The repos whose headings are collapsed, by PullRequestSummary.repo. */
  collapsed: ReadonlySet<string>;
  onToggleRepo: (repo: string) => void;
  /** The open PR's key (prKey()), whose row is marked open. */
  openPrKey?: string | undefined;
  onOpen?: ((key: string) => void) | undefined;
  /** ↑ or ↓ on a row's title: the next or previous row in the list as shown. */
  onStep?: ((key: string, by: 1 | -1) => void) | undefined;
  refresh: PrRefresh;
  /** Covered by a view over the list: nothing in it can take focus or a click (Dashboard.tsx). */
  inert?: boolean;
  /** Pull requests are off: the empty state's Show all sessions. */
  onShowAll?: (() => void) | undefined;
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
function RefreshAction({ refresh, refreshing }: { refresh: PrRefresh; refreshing: boolean }) {
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

/**
 * Line 2 of a PR row: "#42", then " · alpha, beta +1", the sessions strongly linked to it. Its branch
 * isn't shown, though the filter matches it: the view has it.
 */
function RowLine2({ pr, linked }: { pr: PullRequestSummary; linked: readonly LinkedSession[] }) {
  const named = linked.slice(0, NAMED_SESSIONS).map(({ session }) => plainText(session.name));
  const more = linked.length - named.length;
  return (
    <p className="session-what pr-what">
      <span className="pr-number">
        <Highlight text={`#${pr.number}`} />
      </span>
      {named.length > 0 && (
        <span className="pr-sessions">
          <span className="session-what-sep" aria-hidden="true">
            {' · '}
          </span>
          <span className="visually-hidden">, {linked.length === 1 ? 'session' : 'sessions'} </span>
          {named.map((name, index) => (
            // By place as well as name: two sessions can share a name. Each in <bdi>, so a right-to-left name can't reorder the commas.
            <span key={`${index}:${name}`}>
              {index > 0 && ', '}
              <bdi>{name}</bdi>
            </span>
          ))}
          {more > 0 && (
            <>
              <span aria-hidden="true"> +{more}</span>
              <span className="visually-hidden">, and {more} more</span>
            </>
          )}
        </span>
      )}
    </p>
  );
}

interface PrRowProps {
  pr: PullRequestSummary;
  linked: readonly LinkedSession[];
  isOpen: boolean;
  onOpen?: ((key: string) => void) | undefined;
  onStep?: ((key: string, by: 1 | -1) => void) | undefined;
}

/** A PR's row: two lines, as a session row has them (docs/design-system.md, 4: Pull requests, Rows). */
export function PrRow({ pr, linked, isOpen, onOpen, onStep }: PrRowProps) {
  const key = prKey(pr);
  const title = plainText(pr.title);
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
  const className = ['session', 'pr-row', onOpen && 'openable', isOpen && 'open', pr.draft && 'pr-draft'].filter(Boolean).join(' ');
  return (
    <li className={className} data-pr={key} onClick={openFromRow}>
      <div className="session-line">
        <div className="session-ident">
          {/* The whole title, when it's cut short: on hover, as a session row's name has its tooltip. */}
          <Tooltip content={title} relation="none" onlyIfCut>
            <h4 className="session-name pr-title">
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
                  <bdi>
                    <Highlight text={title} />
                  </bdi>
                </button>
              ) : (
                <bdi>
                  <Highlight text={title} />
                </bdi>
              )}
            </h4>
          </Tooltip>
        </div>
        <span className="session-badges pr-badges">
          <PrStateBadges pr={pr} />
        </span>
        <Timestamp className="activity" at={pr.updatedAt} />
      </div>
      <RowLine2 pr={pr} linked={linked} />
    </li>
  );
}

/** One repo's heading, collapsible, and its rows. The heading keeps its counts while collapsed, so nothing that needs attention is out of sight. */
function RepoSection({ group, collapsed, onToggle, linked, openPrKey, onOpen, onStep }: {
  group: PrRepo;
  collapsed: boolean;
  onToggle: () => void;
  linked: ReadonlyMap<string, readonly LinkedSession[]>;
  openPrKey: string | undefined;
  onOpen?: ((key: string) => void) | undefined;
  onStep?: ((key: string, by: 1 | -1) => void) | undefined;
}) {
  const listId = useId();
  const label = plainText(group.label);
  return (
    <li className="pr-repo" data-pr-repo={group.repo}>
      <h3 className="pr-repo-heading">
        <button type="button" className="pr-repo-toggle" aria-expanded={!collapsed} aria-controls={listId} onClick={onToggle}>
          <Icon name="expand" className="chevron" />
          <Icon name="repo" className="pr-repo-icon" />
          <span className="pr-repo-label">
            <Highlight text={label} />
          </span>
          <span className="pr-repo-count">
            {group.prs.length}
            <span className="visually-hidden"> open</span>
          </span>
          {group.attention > 0 && (
            <span className="badge badge-subtle-danger">
              {group.attention}
              <span className="visually-hidden"> {group.attention === 1 ? 'needs' : 'need'} attention</span>
            </span>
          )}
        </button>
      </h3>
      <ul className="sessions prs" id={listId} hidden={collapsed}>
        {group.prs.map((pr) => (
          <PrRow key={prKey(pr)} pr={pr} linked={linked.get(prKey(pr)) ?? []} isOpen={prKey(pr) === openPrKey} onOpen={onOpen} onStep={onStep} />
        ))}
      </ul>
    </li>
  );
}

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, index) => key === b[index]);

/**
 * The repos and their rows in the order last shown while `holding`, with any that have gone left out
 * and any new ones in their place (holdOrder()); otherwise, or when `key` changes, as given.
 */
function useHeldPrOrder(groups: readonly PrRepo[], holding: boolean, key: string): readonly PrRepo[] {
  const [shown, setShown] = useState(() => ({ key, repos: groups.map((group) => group.repo), rows: new Map(groups.map((group) => [group.repo, group.prs.map(prKey)])) }));
  const hold = holding && shown.key === key;
  const repos = hold ? holdOrder(shown.repos, groups.map((group) => group.repo)) : groups.map((group) => group.repo);
  const byRepo = new Map(groups.map((group) => [group.repo, group]));
  const held = repos.flatMap((repo) => {
    const group = byRepo.get(repo);
    if (!group) return [];
    const ids = group.prs.map(prKey);
    const rows = hold ? holdOrder(shown.rows.get(repo) ?? ids, ids) : ids;
    if (sameKeys(rows, ids)) return [group];
    const byKey = new Map(group.prs.map((pr) => [prKey(pr), pr]));
    return [{ ...group, prs: rows.flatMap((id) => byKey.get(id) ?? []) }];
  });
  const rowsNow = new Map(held.map((group) => [group.repo, group.prs.map(prKey)]));
  const changed = shown.key !== key || !sameKeys(shown.repos, repos) || held.some((group) => !sameKeys(shown.rows.get(group.repo) ?? [], rowsNow.get(group.repo) ?? []));
  // Remembered from this render for the next one, as the session list's order is.
  if (changed) setShown({ key, repos, rows: rowsNow });
  return held.length === groups.length && held.every((group, index) => group === groups[index]) ? groups : held;
}

export function PrList({
  alerts,
  headingRef,
  list,
  sessions,
  filter,
  onFilter,
  relations,
  onRelations,
  fieldRef,
  showOlder,
  onToggleOlder,
  collapsed,
  onToggleRepo,
  openPrKey,
  onOpen,
  onStep,
  refresh,
  inert = false,
  onShowAll,
}: PrListProps) {
  const headingId = useId();
  const olderNoteId = useId();
  const main = useRef<HTMLElement>(null);
  const state: PrListState = prListState(list);
  const waiting = useWaiting(main, state.kind === 'loading');
  const refreshing = list?.refreshing ?? false;

  // The list's own time, so what's older changes only with a fetch; none before the first, which hides nothing.
  const now = listNow(list, Number.NaN);
  const all = useMemo(() => list?.prs ?? [], [list]);
  const { recent, older } = useMemo(() => splitPrs(all, now), [all, now]);
  const listed = showOlder ? all : recent;
  // The chips first, then the text, as the session list filters.
  const ofRelations = useMemo(() => filterPrsByRelation(listed, relations), [listed, relations]);
  const shown = useMemo(() => filterPrs(ofRelations, filter), [ofRelations, filter]);
  const olderOfRelations = useMemo(() => filterPrsByRelation(older, relations), [older, relations]);
  const olderShown = useMemo(() => filterPrs(olderOfRelations, filter).length, [olderOfRelations, filter]);
  const groups = useMemo(() => groupPrs(shown), [shown]);
  // Each PR's strongly linked sessions, for its row.
  const linked = useMemo(() => new Map(all.map((pr) => [prKey(pr), sessionsFor(pr, sessions).strong])), [all, sessions]);

  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const heldGroups = useHeldPrOrder(groups, pointerInside || focusInside, `${filter}|${showOlder}|${PR_RELATIONS.filter((relation) => relations.has(relation)).join(',')}`);

  // A focused row that a fetch takes away, as one merged or closed is, takes focus with it, and no
  // blur says so: focus goes to the row that took its place, or the one before, or the heading.
  const focused = useRef<{ key: string; index: number } | undefined>(undefined);
  const rowButtons = () => [...(main.current?.querySelectorAll<HTMLElement>('[data-open-pr]') ?? [])].filter((button) => !button.closest('[hidden]'));
  useEffect(() => {
    if (!focusInside || main.current?.contains(document.activeElement)) return;
    const was = focused.current;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    const rows = rowButtons();
    if (lost && was !== undefined && !rows.some((row) => row.dataset.openPr === was.key)) {
      const next = rows[Math.min(was.index, rows.length - 1)] ?? headingRef?.current ?? undefined;
      if (next) {
        next.focus();
        return;
      }
    }
    setFocusInside(false);
  });
  const onFocusIn = (event: FocusEvent<HTMLElement>) => {
    setFocusInside(true);
    const key = event.target instanceof HTMLElement ? event.target.dataset.openPr : undefined;
    const index = key === undefined ? -1 : rowButtons().findIndex((button) => button.dataset.openPr === key);
    focused.current = key !== undefined && index >= 0 ? { key, index } : undefined;
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocusInside(false);
  };

  const hasList = state.kind === 'list';
  const total = listed.length;
  const attention = countPrAttention(listed);
  const hasText = filter.trim() !== '';
  const filtering = hasText || relations.size > 0;
  // Clear filters, from its button or an empty state's: the text and the chips, and focus in the field, since the button goes.
  const clearFilters = () => {
    onFilter('');
    onRelations(new Set());
    fieldRef?.current?.focus();
  };
  const [onlyRelation] = relations.size === 1 ? relations : [];
  // Searches whose latest try failed while another worked (W101), and of those, the ones that have never worked.
  const failedSearches = state.kind === 'list' ? (state.failed ?? []) : [];
  const unlisted = (relation: PullRequestRelation) => failedSearches.find((each) => each.relation === relation && each.fetchedAt === undefined);

  const olderButton = (
    <Button size="sm" aria-describedby={olderNoteId} onClick={onToggleOlder} data-older-prs-toggle="">
      {olderPrsText(olderShown, showOlder)}
    </Button>
  );

  let body: ReactNode;
  if (state.kind === 'loading') {
    body = (
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
  } else if (state.kind === 'off') {
    body = (
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
  } else if (state.kind === 'failed') {
    body = (
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
  } else if (all.length === 0) {
    body = (
      <EmptyState
        icon="success"
        title="No open pull requests"
        sentence="Pull requests you open, that ask your review or that mention you on github.com show here, with their checks, reviews and the sessions that worked on them."
      />
    );
  } else if (ofRelations.length === 0 && !hasText && onlyRelation !== undefined && olderShown === 0 && unlisted(onlyRelation)) {
    // One chip on, and its search has failed every time: not none of its kind, but none known.
    const failure = unlisted(onlyRelation)!;
    body = (
      <EmptyState
        icon="warning"
        title={`Couldn't list ${SEARCH_NAMES[onlyRelation].charAt(0).toLowerCase()}${SEARCH_NAMES[onlyRelation].slice(1)}`}
        sentence={
          <>
            <Detail>{plainText(failure.error)}</Detail> Refresh to try again.
          </>
        }
        actions={
          <>
            <Button onClick={clearFilters}>Clear filters</Button>
            <RefreshAction refresh={refresh} refreshing={refreshing} />
          </>
        }
      />
    );
  } else if (ofRelations.length === 0 && !hasText && onlyRelation !== undefined && olderShown === 0) {
    // One chip on, and none of its kind, older ones included.
    body = (
      <EmptyState
        icon="success"
        title={NO_RELATION[onlyRelation].title}
        sentence={NO_RELATION[onlyRelation].sentence}
        actions={<Button onClick={clearFilters}>Clear filters</Button>}
      />
    );
  } else if (total === 0 || (ofRelations.length === 0 && !hasText && olderShown > 0)) {
    // Every open PR, or every one the chips find, is older than the window.
    body = (
      <EmptyState
        icon="success"
        title={`No pull requests updated in the last ${PRS_SHOWN_DAYS} days`}
        sentence={total === 0 ? 'Your older open pull requests are behind Show older.' : 'The older ones these filters find are behind Show older.'}
        actions={
          <>
            {total > 0 && <Button onClick={clearFilters}>Clear filters</Button>}
            {olderButton}
          </>
        }
      />
    );
  } else if (shown.length === 0) {
    body = (
      <EmptyState
        icon="search"
        title="No pull requests match"
        sentence={
          hasText
            ? `Nothing in Pull requests matches "${filter.trim()}"${relations.size > 0 ? ' with these filters' : ''}.`
            : 'Nothing in Pull requests matches these filters.'
        }
        actions={
          <>
            <Button onClick={clearFilters}>{relations.size > 0 ? 'Clear filters' : 'Clear filter'}</Button>
            {/* What the filter finds is all older PRs. */}
            {!showOlder && olderShown > 0 && olderButton}
          </>
        }
      />
    );
  } else {
    body = (
      <ul className="pr-repos">
        {heldGroups.map((group) => (
          <RepoSection
            key={group.repo}
            group={group}
            // A filter, the text or a chip, that finds something in a collapsed repo shows it.
            collapsed={collapsed.has(group.repo) && !filtering}
            onToggle={() => onToggleRepo(group.repo)}
            linked={linked}
            openPrKey={openPrKey}
            onOpen={onOpen}
            onStep={onStep}
          />
        ))}
        {olderShown > 0 && (
          <li className="finished-older pr-older">
            {olderButton}
            <span className="finished-older-note" id={olderNoteId}>
              {OLDER_PRS_NOTE}
            </span>
          </li>
        )}
        {list?.truncated && (
          <li className="pr-truncated">
            GitHub found more than {PRS_MAX} pull requests for one of its searches, so the {PRS_MAX} of them updated most recently are listed.
          </li>
        )}
      </ul>
    );
  }

  const stale = state.kind === 'list' ? state.stale : undefined;

  return (
    <main
      ref={main}
      className="session-list pr-list"
      aria-labelledby={headingId}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onFocus={onFocusIn}
      onBlur={onBlur}
      inert={inert || undefined}
    >
      {alerts && (
        <ScrollBox className="session-list-alerts" label="Alerts">
          {alerts}
        </ScrollBox>
      )}
      <div className="session-list-head">
        <div className="session-list-title-row">
          <h2 className="session-list-title" id={headingId} ref={headingRef} tabIndex={-1}>
            <span className="session-list-label">Pull requests</span>
          </h2>
          {hasList && all.length > 0 && (
            <p className="summary">
              <span className="summary-count" data-room={`${total} of ${total} open`}>
                <span>{openCount(filtering ? shown.length : total, total)}</span>
              </span>
              {attention > 0 ? (
                <span className="badge badge-subtle-danger">{needAttention(attention)}</span>
              ) : (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="summary-calm">Nothing needs attention</span>
                </>
              )}
            </p>
          )}
        </div>
        {hasList && all.length > 0 && (
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
              {/* Here, not after the chips: the three chips and it don't fit one line of a 360 px list, and its kept room would be a blank line. */}
              {hasList && all.length > 0 && filtering && <ClearFilters on onClear={clearFilters} />}
              <PrRefreshButton refresh={refresh} refreshing={refreshing} />
            </span>
          </div>
        )}
      </div>
      <HighlightContext.Provider value={filterNeedle(filter)}>
        <div className="session-list-body">
          {failedSearches.length > 0 && (
            <div className="pr-stale">
              <Alert tone="warning" role="status" title="Couldn't refresh part of your pull requests">
                {failedSearches.map((each) => (
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
                This list is from <Timestamp at={state.kind === 'list' ? state.fetchedAt : ''} />.
              </Alert>
            </div>
          )}
          {body}
        </div>
      </HighlightContext.Provider>
    </main>
  );
}
