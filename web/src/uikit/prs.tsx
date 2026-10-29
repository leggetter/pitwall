// Pull requests (M4, W95; docs/design-system.md, 4: Pull requests): the real RepoList, PrList,
// PrView, SessionRow and SessionView, with made-up PRs in public-looking repos and invented titles,
// in each state: the repo list's item and its badge, the list with its headings, rows and badges, a
// heading collapsed, Show older, the filter matching nothing, before the first fetch, off, gh missing
// and not logged in, a failed fetch with and without a list, Refresh busy and off; the PR view with
// its details and sessions, and its other states; the session row's badge; the session view's links;
// and the whole page with a PR open. Refresh here asks nothing: its stub does nothing.

import { useState } from 'react';
import type { PullRequestList, PullRequestSummary, SessionSummary } from '../../../src/shared/protocol.js';
import { Dashboard } from '../components/Dashboard.js';
import { PrList } from '../components/PrList.js';
import { PrView, UnlistedPrView, WaitingPrView } from '../components/PrView.js';
import { RepoList } from '../components/RepoList.js';
import { SessionRow } from '../components/SessionRow.js';
import { SessionView } from '../components/SessionView.js';
import type { PrRefresh } from '../prRefresh.js';
import { prKey, prsFor, sessionPrBadge, sessionsFor } from '../prs.js';
import { ALL_SESSIONS, memoryNavigation, viewIn, type Selection } from '../selection.js';
import { ago, APP_DIR, background, endedSession, group, JOBS_DIR, ROOT, session, snapshot } from './fixtures.js';
import { Specimen } from './kit.js';
import { memoryStorage } from './stubs.js';
import { Stubbed } from './views.js';

const noop = () => {};
const DAY = 24 * 60;

/** A made-up PR, in a public-looking repo, with an invented title: passing and mergeable unless `extra` says otherwise. */
function pr(repoLabel: string, number: number, title: string, minutes: number, extra: Partial<PullRequestSummary> = {}): PullRequestSummary {
  const repo = repoLabel.toLowerCase();
  return {
    url: `https://github.com/${repoLabel}/pull/${number}`,
    repo,
    repoLabel,
    number,
    title,
    draft: false,
    createdAt: ago(minutes + 3 * DAY),
    updatedAt: ago(minutes),
    head: { repo, branch: `pitwall-test/${number}` },
    checks: 'passing',
    mergeable: 'clean',
    ...extra,
  };
}

const FAILING = pr('example/demo-app', 51, 'Add a made-up health route', 25, {
  checks: 'failing',
  failingChecks: ['test (22.x)', 'lint', 'e2e (chrome)'],
  failingCount: 5,
  review: 'review-required',
});
const CONFLICTS = pr('example/event-relay', 612, 'Retry made-up deliveries with backoff, and say so in the delivery log', 70, { mergeable: 'conflicts', review: 'changes-requested' });
const QUIET = pr('example/api-server', 19, 'Add a made-up rate limit to the API', 3 * 60);
const APPROVED = pr('example/demo-app', 48, 'Tidy the made-up export job', 9 * 60, { review: 'approved' });
const DRAFT = pr('example/event-relay', 605, 'Document the made-up retry headers', 4 * DAY, { draft: true, checks: 'pending', mergeable: 'unknown' });
const OLDER = pr('example/docs-site', 7, 'Move the made-up guide to its own page', 120 * DAY, { review: 'review-required' });
const FORK = pr('example/event-relay', 590, 'Fix a made-up typo in the README', 6 * DAY, { head: { repo: 'pitwall-test/event-relay', branch: 'fix-typo' }, review: 'approved' });
const PRS = [FAILING, CONFLICTS, QUIET, APPROVED, DRAFT, OLDER];

const link = (kind: 'opened' | 'pushed' | 'prompted' | 'mentioned', target: PullRequestSummary, minutes: number) =>
  kind === 'pushed'
    ? { kind, repo: target.head?.repo ?? target.repo, branch: target.head?.branch ?? 'main', lastAt: ago(minutes) }
    : { kind, repo: target.repo, number: target.number, lastAt: ago(minutes) };

const OPENER = session('health-route', { title: 'Add a made-up health route', prLinks: [link('opened', FAILING, 26)] });
const REVIEWER = session('retry-review', { title: 'Answer the made-up review', needsYou: { reason: 'asked' }, askedYou: { reason: 'question', excerpt: 'Should I rebase onto main now?' }, prLinks: [link('opened', CONFLICTS, 70), link('opened', APPROVED, 9 * 60)] });
const PUSHER = background('export-job', { cwd: JOBS_DIR, state: 'working', prLinks: [link('pushed', APPROVED, 9 * 60)] });
const MENTIONER = session('docs-pass', { status: 'waiting', waitingFor: 'permission prompt', needsYou: { reason: 'prompt' }, prLinks: [link('mentioned', FAILING, 20)] });
const ENDED = endedSession('rate-limit', { prLinks: [link('prompted', QUIET, 2 * DAY)] });
const SESSIONS: SessionSummary[] = [OPENER, REVIEWER, PUSHER, MENTIONER, ENDED];

const fetchedAt = ago(2);
const list = (overrides: Partial<PullRequestList> = {}): PullRequestList => ({ fetchedAt, source: { ok: true }, refreshing: false, prs: PRS, ...overrides });

const IDLE: PrRefresh = { refresh: noop, sending: false, offUntil: 0 };
/** Refresh off for an hour, as it is for 15 s after a refresh. */
const OFF: PrRefresh = { refresh: noop, sending: false, offUntil: Date.now() + 3600_000 };

/** The PR list as the session list's column shows it, with state of its own: its filter, Show older, collapsed repos and the open PR. */
function LivePrList({ prs, refresh = IDLE, filter: startFilter = '', older = false, collapsed: startCollapsed = [] }: { prs: PullRequestList | undefined; refresh?: PrRefresh; filter?: string; older?: boolean; collapsed?: string[] }) {
  const [filter, setFilter] = useState(startFilter);
  const [showOlder, setShowOlder] = useState(older);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(startCollapsed));
  const [open, setOpen] = useState<string>();
  return (
    <PrList
      list={prs}
      sessions={SESSIONS}
      filter={filter}
      onFilter={setFilter}
      showOlder={showOlder}
      onToggleOlder={() => setShowOlder(!showOlder)}
      collapsed={collapsed}
      onToggleRepo={(repo) =>
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(repo)) next.delete(repo);
          else next.add(repo);
          return next;
        })
      }
      openPrKey={open}
      onOpen={setOpen}
      refresh={refresh}
      onShowAll={noop}
    />
  );
}

/** The repo list with the Pull requests item, its own selection. */
function LiveRepoList({ prs, start = ALL_SESSIONS }: { prs: { attention: number; count: number | undefined } | undefined; start?: Selection }) {
  const [selection, setSelection] = useState(start);
  const groups = [group('pitwall-test-app', [OPENER, REVIEWER, MENTIONER], { key: APP_DIR }), group('pitwall-test-jobs', [PUSHER], { key: JOBS_DIR })];
  return <RepoList groups={groups} roots={[ROOT]} selection={selection} onSelect={setSelection} prs={prs} />;
}

/** Rows as the session list shows them, each with its PR badge. */
function Rows({ sessions }: { sessions: SessionSummary[] }) {
  const shown = group('pitwall-test-app', sessions, { key: APP_DIR });
  return (
    <div className="session-list uikit-rows">
      <div className="session-list-body">
        <ul className="sessions">
          {sessions.map((each) => (
            <SessionRow key={each.sessionId} session={each} group={shown} pr={sessionPrBadge(prsFor(each, PRS))} onOpen={noop} />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The whole page with Pull requests selected and a PR open, its own storage and address bar. */
function Page({ search }: { search: string }) {
  const [own] = useState(() => ({ storage: memoryStorage(), navigation: memoryNavigation(search) }));
  const snap = snapshot([group('pitwall-test-app', [OPENER, REVIEWER, MENTIONER, ENDED], { key: APP_DIR }), group('pitwall-test-jobs', [PUSHER], { key: JOBS_DIR })]);
  return (
    <Stubbed>
      <Dashboard view={{ state: 'live', snapshot: snap, prs: list() }} storage={own.storage} navigation={own.navigation} />
    </Stubbed>
  );
}

const linked = (target: PullRequestSummary) => sessionsFor(target, SESSIONS);

export function PullRequestSpecimens() {
  return (
    <>
      <Specimen
        title="The repo list's item"
        note="Pull requests, under Starred: a subtle danger badge with how many of the last 90 days' PRs need attention, failing checks, conflicts or changes requested. Solid is for sessions that need you."
        width={240}
      >
        <LiveRepoList prs={{ attention: 2, count: 5 }} />
      </Specimen>
      <Specimen title="Selected, nothing needing attention" note="How many there are, as Starred counts, while none needs attention." width={240}>
        <LiveRepoList prs={{ attention: 0, count: 5 }} start={viewIn('prs', undefined)} />
      </Specimen>
      <Specimen title="Before the first fetch" note="The item, with no count. It's there once the server has sent a list, and never while pull requests are off." width={240}>
        <LiveRepoList prs={{ attention: 0, count: undefined }} />
      </Specimen>

      <Specimen
        title="The PR list"
        note="One heading per repo, ordered by its newest update, each collapsible; in each, the PRs that need attention first. A row: its title in <bdi>, its state badges, highlighted then quieter, when it was updated, its number and the sessions strongly linked to it. Click a row to mark it open."
        frame="view"
      >
        <LivePrList prs={list()} />
      </Specimen>
      <Specimen title="A heading collapsed" note="Its count and its badge stay in sight. The page remembers it by a hash of the repo." frame="short">
        <LivePrList prs={list()} collapsed={['example/event-relay']} />
      </Specimen>
      <Specimen title="Show older, on" note="The PRs updated more than 90 days ago, listed and counted, with Hide older pull requests." frame="view">
        <LivePrList prs={list()} older />
      </Specimen>
      <Specimen title="The filter, matching" note="Title, repo, number and branch. A filter that finds something under a collapsed heading shows it." frame="short">
        <LivePrList prs={list()} filter="retry" collapsed={['example/event-relay']} />
      </Specimen>
      <Specimen title="The filter, matching nothing" frame="short">
        <LivePrList prs={list()} filter="nothing like it" />
      </Specimen>
      <Specimen title="Refreshing" note="A fetch running, a poll's or a refresh's: Refresh's spinner, aria-busy." frame="short">
        <LivePrList prs={list({ refreshing: true })} />
      </Specimen>
      <Specimen title="Refresh, off for 15 s" note="After a refresh, or a 429, its tooltip says why. Hover it." frame="short">
        <LivePrList prs={list()} refresh={OFF} />
      </Specimen>
      <Specimen title="A failed fetch, with the last list" note="The list kept, under a warning that says what failed and when the list is from." frame="view">
        <LivePrList prs={list({ fetchedAt: ago(125), source: { ok: false, reason: 'error', error: 'gh took longer than 30 seconds.' } })} />
      </Specimen>
      <Specimen title="No open pull requests" frame="short">
        <LivePrList prs={list({ prs: [] })} />
      </Specimen>
      <Specimen title="Only older ones" note="Every open PR was updated more than 90 days ago." frame="short">
        <LivePrList prs={list({ prs: [OLDER] })} />
      </Specimen>
      <Specimen title="Before the first fetch" note="Skeleton rows after half a second, and Refresh busy." frame="short" waited="shown">
        <LivePrList prs={list({ fetchedAt: undefined, refreshing: true, prs: [] })} />
      </Specimen>
      <Specimen title="Off" note="pitwall was started with --no-prs. The repo list has no item, so only a URL gets here." frame="short">
        <LivePrList prs={list({ fetchedAt: undefined, source: { ok: false, reason: 'off', error: 'Off.' }, prs: [] })} />
      </Specimen>
      <Specimen title="gh missing" frame="short">
        <LivePrList prs={list({ fetchedAt: undefined, source: { ok: false, reason: 'gh-missing', error: "gh isn't on pitwall's PATH." }, prs: [] })} />
      </Specimen>
      <Specimen title="gh not logged in" frame="short">
        <LivePrList prs={list({ fetchedAt: undefined, source: { ok: false, reason: 'gh-auth', error: "gh isn't logged in to github.com." }, prs: [] })} />
      </Specimen>
      <Specimen title="A failed fetch, with no list" frame="short">
        <LivePrList prs={list({ fetchedAt: undefined, source: { ok: false, reason: 'error', error: 'gh took longer than 30 seconds.' }, prs: [] })} />
      </Specimen>

      <Specimen
        title="The PR view"
        note="In the session view's place. Open on GitHub, a link to the PR's own page in a new tab, Copy link and Close; its repo, number and badges; its details, with the failing checks' names and how many more; then the sessions strongly linked to it, and Mentioned in, each opening that session."
        frame="view"
      >
        <PrView pr={FAILING} sessions={linked(FAILING)} onOpenSession={noop} onClose={noop} />
      </Specimen>
      <Specimen title="Conflicts and changes requested" note="A long title wraps, where a session's name gives way." frame="short">
        <PrView pr={CONFLICTS} sessions={linked(CONFLICTS)} onOpenSession={noop} onClose={noop} />
      </Specimen>
      <Specimen title="A draft, GitHub still checking for conflicts, and no session" frame="short">
        <PrView pr={DRAFT} sessions={linked(DRAFT)} onOpenSession={noop} onClose={noop} />
      </Specimen>
      <Specimen title="From a fork, with an ended session" frame="short">
        <PrView pr={FORK} sessions={{ strong: [{ session: ENDED, link: link('opened', FORK, 3 * DAY) }], mentioned: [] }} onOpenSession={noop} onClose={noop} />
      </Specimen>
      <Specimen title="No longer listed" note="Merged or closed while it was open: what it showed last, with an alert. Only from a list fetched since: not while a restart's first fetch runs." frame="short">
        <PrView pr={QUIET} missing="gone" sessions={linked(QUIET)} onOpenSession={noop} onClose={noop} />
      </Specimen>
      <Specimen title="Pull requests off since" note="Restarted with --no-prs while it was open." frame="short">
        <PrView pr={QUIET} missing="off" sessions={linked(QUIET)} onOpenSession={noop} onClose={noop} />
      </Specimen>
      <Specimen title="Not one of your open PRs" note="A ?pr= that isn't in the list." frame="short">
        <UnlistedPrView prKey="example/demo-app/999" onClose={noop} />
      </Specimen>
      <Specimen title="Waiting for the list" note="A ?pr= before the first fetch." frame="short" waited="shown">
        <WaitingPrView waiting={{ shown: true, long: false }} onClose={noop} />
      </Specimen>
      <Specimen title="At 600 px and narrower" note="Back to pull requests, in Close's place." frame="short" width={375}>
        <PrView pr={FAILING} sessions={linked(FAILING)} onOpenSession={noop} onClose={noop} compact backLabel="Back to pull requests" />
      </Specimen>

      <Specimen
        title="Session rows' PR badges"
        note="Each row's most urgent strongly linked open PR, before its status badge, so the status badges still line up: subtle danger while it needs attention, neutral otherwise, with +n for more. Not a control: its tooltip names each. A session that only named one has none."
      >
        <Rows sessions={[REVIEWER, OPENER, PUSHER, MENTIONER, ENDED]} />
      </Specimen>
      <Specimen title="The session view's PR links" note="Under where it worked: each strongly linked open PR, most urgent first, with its highlighted states. Each opens its PR view." frame="short">
        <Stubbed>
          <SessionView session={REVIEWER} listed onClose={noop} prs={{ linked: prsFor(REVIEWER, PRS), onOpen: noop }} />
        </Stubbed>
      </Specimen>

      <Specimen title="The page, with a PR open" note="Pull requests selected, and a PR's view in the third column." frame="page" width={1440}>
        <Page search={`?view=prs&pr=${prKey(FAILING)}`} />
      </Specimen>
    </>
  );
}
