// Pull requests (M4, W95, W106; docs/design-system.md, 4: Pull requests): the real RepoList,
// SessionList's rows, PrRow, PrView, SessionView and the Dashboard, with made-up PRs in public-looking
// repos and invented titles. A row is a piece of work (W106): the repo list's counts, with a cloned
// repo of PR rows alone and one that isn't cloned; session rows with the PRs they own and PR rows with
// none; the Pull requests view in each state, with its hidden line and Show older; the PR view with
// its details and sessions, a review requested of you or a team and a mention (W101), and its other
// states; the session view's links and its Pull requests tab; and the whole page with a PR open.
// Refresh here asks nothing: the page's stubbed API answers nothing.

import { useState } from 'react';
import type { PullRequestList, PullRequestPlace, PullRequestSummary, SessionSummary } from '../../../src/shared/protocol.js';
import { Dashboard } from '../components/Dashboard.js';
import { PrRow } from '../components/PrRow.js';
import { PrView, UnlistedPrView, WaitingPrView } from '../components/PrView.js';
import { RepoList } from '../components/RepoList.js';
import { SessionPrsPanel } from '../components/SessionPrs.js';
import { SessionRow } from '../components/SessionRow.js';
import { SessionView } from '../components/SessionView.js';
import { prKey, sessionsFor, strongPrsOf } from '../prs.js';
import { ALL_SESSIONS, memoryNavigation, type Selection } from '../selection.js';
import { composeWork, prRowCounts, withPrRows } from '../work.js';
import { ago, APP_DIR, background, endedSession, group, JOBS_DIR, ROOT, session, snapshot } from './fixtures.js';
import { Specimen } from './kit.js';
import { memoryStorage } from './stubs.js';
import { Stubbed } from './views.js';

const noop = () => {};
const DAY = 24 * 60;
const APP = { kind: 'cloned', root: ROOT, key: APP_DIR, label: 'pitwall-test-app' } as const satisfies PullRequestPlace;
const ELSEWHERE = { kind: 'not-cloned', root: ROOT } as const satisfies PullRequestPlace;

/** A made-up PR, in a public-looking repo, with an invented title: yours, passing and mergeable unless `extra` says otherwise. */
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
    relation: 'authored',
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
const DRAFT = pr('example/event-relay', 605, 'Document the made-up retry headers', 4 * DAY, { draft: true, checks: 'pending', mergeable: 'unknown', place: ELSEWHERE });
const OLDER = pr('example/docs-site', 7, 'Move the made-up guide to its own page', 120 * DAY, { review: 'review-required', place: APP });
const FORK = pr('example/event-relay', 590, 'Fix a made-up typo in the README', 6 * DAY, { head: { repo: 'pitwall-test/event-relay', branch: 'fix-typo' }, review: 'approved' });
// Not yours (W101): your review asked of you, and of a team you're on, with another author's failing checks; and a mention.
const REVIEW = pr('example/demo-app', 57, 'Add a made-up retry budget', 40, { relation: 'review-requested', reviewRequest: { via: 'direct' }, review: 'review-required', place: APP });
const TEAM_REVIEW = pr('example/event-relay', 618, 'Rename the made-up delivery states', 2 * 60, {
  relation: 'review-requested',
  reviewRequest: { via: 'team', team: 'example/reviewers' },
  checks: 'failing',
  failingChecks: ['lint'],
  review: 'review-required',
  place: ELSEWHERE,
});
const MENTION = pr('example/api-server', 23, 'Ask about the made-up rate limit headers', 5 * 60, { relation: 'mentioned', review: 'review-required', place: APP });
// No root claims its owner (W106): counted, never listed.
const UNCLAIMED = pr('other-org/tool', 3, 'A made-up fix elsewhere', 6 * 60, { place: { kind: 'unclaimed' } });
const PRS = [FAILING, CONFLICTS, QUIET, APPROVED, DRAFT, OLDER, REVIEW, TEAM_REVIEW, MENTION, UNCLAIMED];

const link = (kind: 'opened' | 'pushed' | 'prompted' | 'mentioned', target: PullRequestSummary, minutes: number) =>
  kind === 'pushed'
    ? { kind, repo: target.head?.repo ?? target.repo, branch: target.head?.branch ?? 'main', lastAt: ago(minutes) }
    : { kind, repo: target.repo, number: target.number, lastAt: ago(minutes) };

const OPENER = session('health-route', { title: 'Add a made-up health route', prLinks: [link('opened', FAILING, 26)] });
const REVIEWER = session('retry-review', { title: 'Answer the made-up review', needsYou: { reason: 'asked' }, askedYou: { reason: 'question', excerpt: 'Should I rebase onto main now?' }, prLinks: [link('opened', CONFLICTS, 70), link('opened', APPROVED, 9 * 60)] });
// It pushed #48's branch after the reviewer opened it, so it owns #48 (W106).
const PUSHER = background('export-job', { cwd: JOBS_DIR, state: 'working', prLinks: [link('pushed', APPROVED, 8 * 60)] });
const MENTIONER = session('docs-pass', { status: 'waiting', waitingFor: 'permission prompt', needsYou: { reason: 'prompt' }, prLinks: [link('mentioned', FAILING, 20)] });
// Ended, and given #19, which no session acted on: it owns it, so it's listed with the rest (W106).
const ENDED = endedSession('rate-limit', { prLinks: [link('prompted', QUIET, 2 * DAY)] });
const SESSIONS: SessionSummary[] = [OPENER, REVIEWER, PUSHER, MENTIONER, ENDED];

const fetchedAt = ago(2);
const list = (overrides: Partial<PullRequestList> = {}): PullRequestList => ({ fetchedAt, source: { ok: true }, refreshing: false, prs: PRS, ...overrides });

const GROUPS = [group('pitwall-test-app', [OPENER, REVIEWER, MENTIONER, ENDED], { key: APP_DIR }), group('pitwall-test-jobs', [PUSHER], { key: JOBS_DIR })];
const WORK = composeWork(SESSIONS, PRS, { now: Date.parse(fetchedAt) });
const LISTED = withPrRows(GROUPS, WORK);

/** The repo list with the Pull requests item, its own selection. */
function LiveRepoList({ prs, start = ALL_SESSIONS }: { prs: { attention: number; count: number | undefined } | undefined; start?: Selection }) {
  const [selection, setSelection] = useState(start);
  return <RepoList groups={LISTED} roots={[ROOT]} selection={selection} onSelect={setSelection} prs={prs} work={WORK} />;
}

/** Rows as the session list shows them: sessions with the PRs they own, then PR rows with none (W106). */
function Rows() {
  const [shown] = GROUPS;
  const placed = LISTED.flatMap((each) => (each.prs ?? []).map((one) => ({ pr: one, group: each })));
  return (
    <div className="session-list uikit-rows">
      <div className="session-list-body">
        <ul className="sessions">
          {[REVIEWER, OPENER, PUSHER, MENTIONER, ENDED].map((each) => (
            <SessionRow key={each.sessionId} session={each} group={shown!} showGroup owned={WORK.owned.get(each.sessionId)} onOpen={noop} />
          ))}
          {placed.map(({ pr: one, group: each }) => (
            <PrRow key={prKey(one)} pr={one} group={each} showGroup onOpen={noop} />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The whole page, its own storage and address bar, with `prs` as the latest list. */
function Page({ search, prs = list() }: { search: string; prs?: PullRequestList }) {
  const [own] = useState(() => ({ storage: memoryStorage(), navigation: memoryNavigation(search) }));
  return (
    <Stubbed>
      <Dashboard view={{ state: 'live', snapshot: snapshot(GROUPS), prs }} storage={own.storage} navigation={own.navigation} />
    </Stubbed>
  );
}

const linked = (target: PullRequestSummary) => sessionsFor(target, SESSIONS);

/** A session view's PRs: those it owns, and those it's strongly linked to that another session owns. */
const sessionPrs = (each: SessionSummary) => ({
  owned: WORK.owned.get(each.sessionId) ?? [],
  linked: strongPrsOf(each, PRS)
    .filter((one) => WORK.ownerOf.get(prKey(one))?.sessionId !== each.sessionId)
    .map((one) => ({ pr: one, owner: WORK.ownerOf.get(prKey(one)) })),
  onOpen: noop,
});

export function PullRequestSpecimens() {
  return (
    <>
      <Specimen
        title="The repo list, with pull requests"
        note="A row is a piece of work (W106): a group counts its sessions and the PRs no session owns placed under it, and Needs you counts a session that needs you through a PR it owns and a PR row that does. Pull requests, under Starred, counts the rows with an open PR, with a need-you badge while any need you through one. example/event-relay isn't cloned under the root, which claims its owner: its own icon, and 'not cloned' in its name and tooltip."
        width={240}
      >
        <LiveRepoList prs={{ ...prRowCounts(LISTED, WORK) }} />
      </Specimen>
      <Specimen title="Before the first fetch" note="The item, with no count. It's there once the server has sent a list, and never while pull requests are off." width={240}>
        <LiveRepoList prs={{ attention: 0, count: undefined }} />
      </Specimen>

      <Specimen
        title="Rows"
        note="Session rows carry the open PRs they own: the most urgent as a badge, '#51', in subtle danger while it needs attention, with +n for more, before the status badge; line 2 says why while a PR needs you and the session doesn't. A session that only named one, or whose PR another session took over, has none. An ended session that owns an open PR is listed with the rest, not muted. Then PR rows, for the PRs no session owns: '#57' and the title, the badges and when it was updated, then line 2: its group, why it needs you or how it's yours, and 'No session listed' or 'Not cloned'."
      >
        <Rows />
      </Specimen>

      <Specimen
        title="The Pull requests view"
        note="The session list, showing every row with an open PR across the root tab's groups, those that need you first. Yours, Review requested and Mentioned filter it, as OR. At its foot, Show older for PR rows not updated in 90 days, and how many PRs are hidden because no root claims their owner, with a link to the README's Configuration."
        frame="page"
        width={1440}
      >
        <Page search="?view=prs" />
      </Specimen>
      <Specimen title="A failed fetch, with the last list" note="The list kept, under a warning that says what failed and when the list is from." frame="page" width={1200}>
        <Page search="?view=prs" prs={list({ fetchedAt: ago(125), source: { ok: false, reason: 'error', error: 'gh took longer than 30 seconds.' } })} />
      </Specimen>
      <Specimen
        title="A search failed, the others worked"
        note="Each search is its own call (W101's review): the list is kept, a failed search's PRs are its last good ones, and the notice names each one with when it's from, or that it isn't listed."
        frame="page"
        width={1200}
      >
        <Page
          search="?view=prs"
          prs={list({
            prs: PRS.filter((each) => each.relation !== 'mentioned'),
            searches: {
              authored: { fetchedAt },
              'review-requested': { fetchedAt: ago(125), failed: { reason: 'error', error: 'GitHub ended the request after 10 seconds.' } },
              mentioned: { failed: { reason: 'error', error: 'gh api failed with exit code 1.' } },
            },
          })}
        />
      </Specimen>
      <Specimen title="No open pull requests" note="With the hidden line, when no root claims some." frame="page" width={1200}>
        <Page search="?view=prs" prs={list({ prs: [UNCLAIMED] })} />
      </Specimen>
      <Specimen title="Before the first fetch" note="Skeleton rows after half a second, and Refresh busy." frame="page" width={1200} waited="shown">
        <Page search="?view=prs" prs={list({ fetchedAt: undefined, refreshing: true, prs: [] })} />
      </Specimen>
      <Specimen title="gh missing" frame="page" width={1200}>
        <Page search="?view=prs" prs={list({ fetchedAt: undefined, source: { ok: false, reason: 'gh-missing', error: "gh isn't on pitwall's PATH." }, prs: [] })} />
      </Specimen>
      <Specimen title="gh not logged in" frame="page" width={1200}>
        <Page search="?view=prs" prs={list({ fetchedAt: undefined, source: { ok: false, reason: 'gh-auth', error: "gh isn't logged in to github.com." }, prs: [] })} />
      </Specimen>
      <Specimen title="A failed fetch, with no list" frame="page" width={1200}>
        <Page search="?view=prs" prs={list({ fetchedAt: undefined, source: { ok: false, reason: 'error', error: 'gh took longer than 30 seconds.' }, prs: [] })} />
      </Specimen>
      <Specimen title="A repo that isn't cloned" note="Its PR rows, under the root that claims its owner, with 'Not cloned' in the heading and no Hide." frame="page" width={1200}>
        <Page search="?repo=github.com/example/event-relay" />
      </Specimen>

      <Specimen
        title="The PR view"
        note="In the session view's place. Open on GitHub, a link to the PR's own page in a new tab, Copy link and Close; its repo, number and badges; its details, with the failing checks' names and how many more; then the sessions strongly linked to it, and Mentioned in, each opening that session."
        frame="view"
      >
        <PrView pr={FAILING} sessions={linked(FAILING)} ownerId={WORK.ownerOf.get(prKey(FAILING))?.sessionId} onOpenSession={noop} onClose={noop} />
      </Specimen>
      <Specimen title="Your review requested, through a team" note="It says how it's yours under its badges: of you, or of a team you're on, named when it's the one team asked." frame="short">
        <PrView pr={TEAM_REVIEW} sessions={linked(TEAM_REVIEW)} onOpenSession={noop} onClose={noop} />
      </Specimen>
      <Specimen title="A mention" note="You're mentioned in it: not yours, and your review isn't asked. It never needs attention." frame="short">
        <PrView pr={MENTION} sessions={linked(MENTION)} onOpenSession={noop} onClose={noop} />
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
        title="The session view's PR links and its Pull requests tab"
        note="Under where it worked: each open PR it owns, most urgent first, with its highlighted states, each opening its PR view; and the Pull requests tab, after Sub-agents, while it owns one or is strongly linked to one."
        frame="short"
      >
        <Stubbed>
          <SessionView session={REVIEWER} listed onClose={noop} prs={sessionPrs(REVIEWER)} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="The Pull requests tab"
        note="The open PRs the session owns, each with the PR view's details and Open on GitHub, then those it worked on that another session owns, saying which."
        frame="view"
      >
        <div className="session-view">
          <SessionPrsPanel {...sessionPrs(REVIEWER)} id="uikit-session-prs" labelledBy="uikit-session-prs" hidden={false} />
        </div>
      </Specimen>

      <Specimen title="The page, with a PR open" note="Pull requests selected, and a PR's view in the third column." frame="page" width={1440}>
        <Page search={`?view=prs&pr=${prKey(FAILING)}`} />
      </Specimen>
    </>
  );
}
