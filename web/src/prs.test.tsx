// Your open pull requests in the web UI (M4, W95; prs.ts): the 'prs' message read defensively, the
// PR's link checked, the list's states, the 90-day window, the repo headings and their order, the
// filter, the attention count, which sessions a PR is linked to and a session's most urgent PR, the
// state badges and the session row's badge; and how a PR is yours, its chips, badges and sentence
// (W101). Made-up PRs, sessions and teams only.

import { describe, expect, it } from 'vitest';
import { PR_FAILING_CHECKS_MAX, PR_TITLE_MAX, PRS_LIST_MAX, type PullRequestSummary } from '../../src/shared/protocol.js';
import { parseServerMessage } from './connection.js';
import {
  comparePrs,
  countPrAttention,
  filterPrs,
  filterPrsByRelation,
  githubPrUrl,
  groupPrs,
  isOlderPr,
  listNow,
  needAttention,
  olderPrsText,
  openCount,
  parsePullRequestList,
  prKey,
  prListState,
  prsBySession,
  prsFor,
  prRelationText,
  prsOff,
  prStateBadges,
  sessionPrBadge,
  sessionsFor,
  splitPrs,
} from './prs.js';
import { minutesAgo, NOW, pr, prLink, prList, session } from './test/fixtures.js';

const DAY = 60 * 24;

describe('parsePullRequestList', () => {
  it('reads a list as the contract has it', () => {
    const one = pr({ number: 42, checks: 'failing', failingChecks: ['test (22.x)', 'lint'], failingCount: 3, review: 'changes-requested', mergeable: 'conflicts', draft: true });
    const list = prList([one, pr({ number: 7 })], { truncated: true });
    expect(parsePullRequestList(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });

  it('ignores a list that is not the shape: no source, no refreshing, prs that are not a list', () => {
    const good = prList([pr({ number: 1 })]);
    for (const bad of [
      undefined,
      null,
      'prs',
      [],
      { ...good, source: undefined },
      { ...good, source: { ok: 'yes' } },
      { ...good, source: { ok: false, reason: 'gh-auth' } },
      { ...good, refreshing: 'no' },
      { ...good, prs: 'none' },
      { ...good, prs: undefined },
    ]) {
      expect(parsePullRequestList(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('leaves out a PR that is not the shape, and keeps the rest', () => {
    const good = pr({ number: 1 });
    const bad: unknown[] = [
      null,
      'pr',
      { ...good, number: 2, url: 'https://example.com/example/demo-app/pull/2' },
      { ...good, number: 3, url: 'http://github.com/example/demo-app/pull/3' },
      // Another PR's address, or another repo's.
      { ...good, number: 4, url: 'https://github.com/example/demo-app/pull/5' },
      { ...good, number: 6, url: 'https://github.com/example/other/pull/6' },
      { ...good, number: 8, url: 'https://github.com/example/demo-app/pull/8?x=1' },
      { ...good, number: 9, url: 'https://github.com/example/demo-app/pull/9#top' },
      { ...good, number: 10, repo: 'Example/Demo-App', url: 'https://github.com/example/demo-app/pull/10' },
      { ...good, number: 11, repoLabel: 'example/another', url: 'https://github.com/example/demo-app/pull/11' },
      { ...good, number: 12.5 },
      { ...good, number: -1 },
      { ...good, number: 13, url: 'https://github.com/example/demo-app/pull/13', title: 7 },
      { ...good, number: 14, url: 'https://github.com/example/demo-app/pull/14', draft: 'no' },
      { ...good, number: 15, url: 'https://github.com/example/demo-app/pull/15', updatedAt: 'yesterday' },
      { ...good, number: 16, url: 'https://github.com/example/demo-app/pull/16', checks: 'green' },
      { ...good, number: 17, url: 'https://github.com/example/demo-app/pull/17', mergeable: 'maybe' },
      { ...good, number: 18, url: 'https://github.com/example/demo-app/pull/18', review: 'lgtm' },
    ];
    const parsed = parsePullRequestList({ ...prList([]), prs: [...bad, good] });
    expect(parsed?.prs).toEqual([good]);
  });

  it("keeps every owner W93's reader keeps: an Enterprise Managed User's name_shortcode, a 45-character owner, and an EMU fork's head", () => {
    const emu = pr({ number: 3, repoLabel: 'Pitwall_Test-Shortcode/demo-app' });
    const long = pr({ number: 4, repoLabel: `${'o'.repeat(45)}/demo-app` });
    const fork = pr({ number: 5, head: { repo: 'someone_emu/demo-app', branch: 'fix' } });
    const parsed = parsePullRequestList(JSON.parse(JSON.stringify(prList([emu, long, fork]))));
    expect(parsed?.prs).toEqual([emu, long, fork]);
    expect(parsed?.prs.map((each) => each.repo)).toEqual(['pitwall_test-shortcode/demo-app', `${'o'.repeat(45)}/demo-app`, 'example/demo-app']);
    expect(parsed?.prs[2]?.head).toEqual({ repo: 'someone_emu/demo-app', branch: 'fix' });
    expect(githubPrUrl(emu)).toBe('https://github.com/Pitwall_Test-Shortcode/demo-app/pull/3');
  });

  it("drops what the contract's patterns don't allow: an owner over 100 characters, or starting with _ or -, and . or .. as a name", () => {
    for (const repoLabel of [`${'o'.repeat(101)}/demo-app`, '_owner/demo-app', '-owner/demo-app', 'example/..', 'example/.', 'exa mple/demo-app']) {
      const bad = { ...pr({ number: 9 }), repo: repoLabel.toLowerCase(), repoLabel, url: `https://github.com/${repoLabel}/pull/9` };
      expect(parsePullRequestList(prList([bad]))?.prs, repoLabel).toEqual([]);
    }
  });

  it('keeps one PR per repo and number, at most PRS_LIST_MAX, three searches of PRS_MAX', () => {
    const many = Array.from({ length: PRS_LIST_MAX + 5 }, (_, index) => pr({ number: index + 1 }));
    expect(parsePullRequestList(prList([pr({ number: 1 }), ...many]))?.prs).toHaveLength(PRS_LIST_MAX);
    expect(parsePullRequestList(prList([pr({ number: 1, title: 'first' }), pr({ number: 1, title: 'second' })]))?.prs.map((each) => each.title)).toEqual(['first']);
  });

  it('cuts the title, keeps at most PR_FAILING_CHECKS_MAX names, and a failingCount only above them', () => {
    const names = Array.from({ length: 8 }, (_, index) => `check ${index}`);
    const [parsed] = parsePullRequestList(prList([pr({ number: 1, title: 'x'.repeat(PR_TITLE_MAX + 20), checks: 'failing', failingChecks: names, failingCount: 8 })]))?.prs ?? [];
    expect(parsed?.title).toHaveLength(PR_TITLE_MAX);
    expect(parsed?.failingChecks).toEqual(names.slice(0, PR_FAILING_CHECKS_MAX));
    expect(parsed?.failingCount).toBe(8);
    const [same] = parsePullRequestList(prList([pr({ number: 2, checks: 'failing', failingChecks: ['a', 'b'], failingCount: 2 })]))?.prs ?? [];
    expect(same?.failingCount).toBeUndefined();
    // Failing names on a PR whose checks pass are dropped.
    const [passing] = parsePullRequestList(prList([pr({ number: 3, failingChecks: ['a'], failingCount: 4 })]))?.prs ?? [];
    expect([passing?.failingChecks, passing?.failingCount]).toEqual([undefined, undefined]);
  });

  it('leaves out a head that is not the shape: no repo, or a branch empty, over 255 characters, or with a control or bidi control', () => {
    for (const head of [{ repo: 'Not A Repo', branch: 'x' }, { repo: 'example/demo-app', branch: '' }, { repo: 'example/demo-app', branch: 'b'.repeat(256) }, { repo: 'example/demo-app', branch: 'fix\u202Eevil' }, { repo: 'example/demo-app', branch: 'fix\nx' }]) {
      const [parsed] = parsePullRequestList({ ...prList([]), prs: [{ ...pr({ number: 1 }), head }] })?.prs ?? [];
      expect(parsed, JSON.stringify(head)).toBeDefined();
      expect(parsed?.head, JSON.stringify(head)).toBeUndefined();
    }
    const [long] = parsePullRequestList({ ...prList([]), prs: [{ ...pr({ number: 1 }), head: { repo: 'example/demo-app', branch: 'b'.repeat(255) } }] })?.prs ?? [];
    expect(long?.head?.branch).toHaveLength(255);
  });

  it('keeps each reason a fetch failed for', () => {
    for (const reason of ['off', 'gh-missing', 'gh-auth', 'error'] as const) {
      const list = prList([], { fetchedAt: undefined, source: { ok: false, reason, error: 'Made up.' } });
      expect(parsePullRequestList(JSON.parse(JSON.stringify(list)))?.source, reason).toEqual({ ok: false, reason, error: 'Made up.' });
    }
  });

  it('reads a reason it does not know as an error, and drops a fetchedAt that is not a time', () => {
    const parsed = parsePullRequestList({ source: { ok: false, reason: 'new-thing', error: 'Something new.' }, refreshing: false, prs: [], fetchedAt: 'soon' });
    expect(parsed).toEqual({ source: { ok: false, reason: 'error', error: 'Something new.' }, refreshing: false, prs: [] });
  });

  it("comes through the connection's parser as a 'prs' message, and a malformed one is ignored", () => {
    const list = prList([pr({ number: 42 })]);
    expect(parseServerMessage(JSON.stringify({ type: 'prs', prs: list }))).toEqual({ type: 'prs', prs: list });
    expect(parseServerMessage(JSON.stringify({ type: 'prs', prs: { prs: [] } }))).toBeUndefined();
    expect(parseServerMessage(JSON.stringify({ type: 'prs' }))).toBeUndefined();
    expect(parseServerMessage('{"type":"prs","prs":')).toBeUndefined();
  });
});

describe('how a PR is yours (W101)', () => {
  const review = pr({ number: 7, relation: 'review-requested', reviewRequest: { via: 'direct' } });
  const teamReview = pr({ number: 8, relation: 'review-requested', reviewRequest: { via: 'team', team: 'example/reviewers' }, checks: 'failing', mergeable: 'conflicts' });
  const mention = pr({ number: 9, relation: 'mentioned', checks: 'failing', review: 'changes-requested' });

  it('reads the relation and the review request, and leaves out a PR whose relation it does not know', () => {
    const list = prList([pr({ number: 1 }), review, teamReview, mention, pr({ number: 10, relation: 'review-requested', reviewRequest: { via: 'team' } })]);
    expect(parsePullRequestList(JSON.parse(JSON.stringify(list)))).toEqual(list);
    for (const relation of [undefined, 'assigned', 'constructor', 7]) {
      const bad = { ...pr({ number: 2 }), relation };
      expect(parsePullRequestList(prList([bad as PullRequestSummary]))?.prs, String(relation)).toEqual([]);
    }
  });

  it("keeps a review request only on a review-requested PR, and only in the contract's shape, without a team it can't name", () => {
    const read = (each: unknown) => parsePullRequestList({ ...prList([]), prs: [each] })?.prs[0];
    expect(read({ ...mention, reviewRequest: { via: 'direct' } })).not.toHaveProperty('reviewRequest');
    expect(read({ ...review, reviewRequest: { via: 'someone' } })).not.toHaveProperty('reviewRequest');
    expect(read({ ...review, reviewRequest: 'direct' })).not.toHaveProperty('reviewRequest');
    for (const team of ['reviewers', 'example/', 'example/..', 'example/re viewers', 'example/‮x', 42]) {
      expect(read({ ...review, reviewRequest: { via: 'team', team } })?.reviewRequest, String(team)).toEqual({ via: 'team' });
    }
  });

  it('counts a review request as needing you, never a mention, nor another author’s failing checks or conflicts', () => {
    expect(countPrAttention([review, teamReview, mention])).toBe(2);
    expect(countPrAttention([pr({ number: 1, checks: 'failing' }), mention])).toBe(1);
  });

  it('puts Review requested or Mentioned first in its badges; another author’s failures keep their looks without needing you', () => {
    const states = (each: PullRequestSummary) => prStateBadges(each).map((badge) => [badge.label, badge.look, badge.attention]);
    expect(states(review)).toEqual([['Review requested', 'subtle-warning', true]]);
    expect(states(teamReview)).toEqual([
      ['Review requested', 'subtle-warning', true],
      ['Checks failing', 'subtle-danger', false],
      ['Conflicts', 'subtle-danger', false],
    ]);
    expect(states(mention)).toEqual([
      ['Mentioned', 'subtle-neutral', false],
      ['Checks failing', 'subtle-danger', false],
      ['Changes requested', 'subtle-warning', false],
    ]);
    // A team's request says whose in its hint; one of you needs none.
    expect(prStateBadges(teamReview)[0]?.hint).toBe('Your review is requested through example/reviewers.');
    expect(prStateBadges(review)[0]?.hint).toBeUndefined();
  });

  it('says how it is yours in a sentence, and nothing for one you opened', () => {
    expect(prRelationText(review)).toBe('Your review is requested.');
    expect(prRelationText(teamReview)).toBe('Your review is requested through example/reviewers.');
    expect(prRelationText({ relation: 'review-requested', reviewRequest: { via: 'team' } })).toBe("Your review is requested through a team you're on.");
    expect(prRelationText({ relation: 'review-requested' })).toBe('Your review is requested.');
    expect(prRelationText(mention)).toBe("You're mentioned in it.");
    expect(prRelationText(pr({ number: 1 }))).toBeUndefined();
  });

  it('filters by the chips, which combine as OR, with none on as All', () => {
    const mine = pr({ number: 1 });
    const all = [mine, review, teamReview, mention];
    expect(filterPrsByRelation(all, new Set())).toEqual(all);
    expect(filterPrsByRelation(all, new Set(['review-requested']))).toEqual([review, teamReview]);
    expect(filterPrsByRelation(all, new Set(['authored', 'mentioned']))).toEqual([mine, mention]);
    expect(filterPrsByRelation(all, new Set(['authored', 'review-requested', 'mentioned']))).toEqual(all);
  });

  it('sorts a review request among the PRs that need attention', () => {
    const quiet = pr({ number: 1 }, 5);
    const asked = { ...review, updatedAt: minutesAgo(50) };
    expect(groupPrs([quiet, asked]).flatMap((each) => each.prs.map((p) => p.number))).toEqual([7, 1]);
  });
});

describe("each search's part of the list (W101's review)", () => {
  it('reads each search’s state, leaving out what isn’t the shape', () => {
    const searches = {
      authored: { fetchedAt: minutesAgo(1) },
      'review-requested': { fetchedAt: minutesAgo(120), failed: { reason: 'error' as const, error: 'Made up: slow.' } },
      mentioned: { failed: { reason: 'gh-auth' as const, error: 'Made up: not logged in.' } },
    };
    expect(parsePullRequestList(JSON.parse(JSON.stringify(prList([], { searches }))))?.searches).toEqual(searches);
    const odd = parsePullRequestList({ ...prList([]), searches: { authored: { fetchedAt: 'yesterday', failed: { reason: 'off', error: 'x'.repeat(600) } }, assigned: { fetchedAt: minutesAgo(1) }, mentioned: 'junk' } });
    expect(odd?.searches).toEqual({ authored: { failed: { reason: 'error', error: 'x'.repeat(500) } } });
    expect(parsePullRequestList({ ...prList([]), searches: 'junk' })).not.toHaveProperty('searches');
  });

  it('says which searches failed while another worked, and when each is from', () => {
    const at = minutesAgo(2);
    expect(prListState(prList([], { fetchedAt: at, searches: { authored: { fetchedAt: at }, mentioned: { failed: { reason: 'error', error: 'Made up.' } } } }))).toEqual({
      kind: 'list',
      fetchedAt: at,
      failed: [{ relation: 'mentioned', reason: 'error', error: 'Made up.' }],
    });
    expect(prListState(prList([], { fetchedAt: at, searches: { authored: { fetchedAt: at } } }))).toEqual({ kind: 'list', fetchedAt: at });
  });
});

describe('githubPrUrl', () => {
  it("is the PR's own https://github.com address, and nothing else", () => {
    const base = { repo: 'example/demo-app', number: 42 };
    expect(githubPrUrl({ ...base, url: 'https://github.com/Example/Demo-App/pull/42' })).toBe('https://github.com/Example/Demo-App/pull/42');
    for (const url of [
      'https://github.com/example/demo-app/pull/43',
      'https://github.com/example/other/pull/42',
      'https://github.com.example.com/example/demo-app/pull/42',
      'https://user@github.com/example/demo-app/pull/42',
      'javascript:alert(1)//https://github.com/example/demo-app/pull/42',
      'https://github.com/example/demo-app/pull/42/files',
      ' https://github.com/example/demo-app/pull/42',
    ]) {
      expect(githubPrUrl({ ...base, url }), url).toBeUndefined();
    }
  });
});

describe('prListState', () => {
  it('says what the list shows for each source', () => {
    expect(prListState(undefined)).toEqual({ kind: 'loading' });
    expect(prListState(prList([], { fetchedAt: undefined, refreshing: true }))).toEqual({ kind: 'loading' });
    expect(prListState(prList([], { fetchedAt: undefined, source: { ok: false, reason: 'off', error: 'Off.' } }))).toEqual({ kind: 'off' });
    for (const reason of ['gh-missing', 'gh-auth', 'error'] as const) {
      expect(prListState(prList([], { fetchedAt: undefined, source: { ok: false, reason, error: 'Made up.' } }))).toEqual({ kind: 'failed', reason, error: 'Made up.' });
      const fetchedAt = minutesAgo(120);
      expect(prListState(prList([pr({ number: 1 })], { fetchedAt, source: { ok: false, reason, error: 'Made up.' } }))).toEqual({ kind: 'list', fetchedAt, stale: { reason, error: 'Made up.' } });
    }
    const list = prList([]);
    expect(prListState(list)).toEqual({ kind: 'list', fetchedAt: list.fetchedAt });
    expect(prsOff(prList([], { source: { ok: false, reason: 'off', error: 'Off.' } }))).toBe(true);
    expect(prsOff(undefined)).toBe(false);
  });
});

describe('the 90-day window', () => {
  it("counts from the list's own time, and a now that isn't one hides nothing", () => {
    const list = prList([]);
    expect(listNow(list)).toBe(NOW - 2 * 60_000);
    expect(listNow(undefined, 5)).toBe(5);
    const recent = pr({ number: 1 }, 89 * DAY);
    const older = pr({ number: 2 }, 91 * DAY);
    expect([isOlderPr(recent, NOW), isOlderPr(older, NOW)]).toEqual([false, true]);
    expect(isOlderPr(older, Number.NaN)).toBe(false);
    expect(splitPrs([older, recent], NOW)).toEqual({ recent: [recent], older: [older] });
  });
});

describe('grouping, sorting and the attention count', () => {
  const demoOld = pr({ number: 1 }, 300);
  const demoFailing = pr({ number: 2, checks: 'failing' }, 400);
  const demoNew = pr({ number: 3 }, 10);
  const relayConflict = pr({ number: 9, repoLabel: 'example/event-relay', mergeable: 'conflicts' }, 30);
  const relayReview = pr({ number: 8, repoLabel: 'example/event-relay', review: 'changes-requested' }, 50);
  const blog = pr({ number: 4, repoLabel: 'example/Blog' }, 5);

  it('puts the PRs that need attention first in a repo, then the newest updated', () => {
    expect([demoOld, demoNew, demoFailing].sort(comparePrs).map((each) => each.number)).toEqual([2, 3, 1]);
  });

  it('heads each repo once, ordered by its newest update, with its label as GitHub spells it', () => {
    const groups = groupPrs([demoOld, relayReview, demoFailing, blog, relayConflict, demoNew]);
    expect(groups.map((group) => [group.repo, group.label, group.prs.map((each) => each.number), group.attention])).toEqual([
      ['example/blog', 'example/Blog', [4], 0],
      ['example/demo-app', 'example/demo-app', [2, 3, 1], 1],
      ['example/event-relay', 'example/event-relay', [9, 8], 2],
    ]);
  });

  it('counts failing checks, conflicts and changes requested, drafts included', () => {
    expect(countPrAttention([demoOld, demoFailing, relayConflict, relayReview, pr({ number: 20, draft: true, checks: 'failing' })])).toBe(4);
    expect(needAttention(1)).toBe('1 needs attention');
    expect(needAttention(3)).toBe('3 need attention');
    expect(openCount(12, 12)).toBe('12 open');
    expect(openCount(3, 12)).toBe('3 of 12 open');
    expect(olderPrsText(1, false)).toBe('Show 1 older pull request');
    expect(olderPrsText(17, false)).toBe('Show 17 older pull requests');
    expect(olderPrsText(17, true)).toBe('Hide older pull requests');
  });
});

describe('filterPrs', () => {
  const prs = [
    pr({ number: 42, title: 'Fix the made-up EXPORT job' }),
    pr({ number: 7, repoLabel: 'example/event-relay', head: { repo: 'example/event-relay', branch: 'feat/retry-queue' } }),
    pr({ number: 420 }),
  ];
  const numbers = (text: string) => filterPrs(prs, text).map((each) => each.number);

  it('matches the title, the repo, the number and the branch, case-insensitively, on the trimmed text', () => {
    expect(numbers('  export ')).toEqual([42]);
    expect(numbers('EVENT-RELAY')).toEqual([7]);
    expect(numbers('#42')).toEqual([42, 420]);
    expect(numbers('retry-queue')).toEqual([7]);
    expect(numbers('')).toEqual([42, 7, 420]);
    expect(numbers('nothing like it')).toEqual([]);
  });
});

describe('sessions and PRs', () => {
  const failing = pr({ number: 42, checks: 'failing' });
  const quiet = pr({ number: 7 });
  const other = pr({ number: 9, repoLabel: 'example/event-relay' });

  it('lists the strongly linked sessions apart from those that only mentioned it, finished ones last', () => {
    const opener = session({ name: 'opener', prLinks: [prLink('opened', failing, 30)] });
    const pusher = session({ name: 'pusher', prLinks: [prLink('pushed', failing, 5)] });
    const prompted = session({ name: 'prompted', finished: true, alive: false, prLinks: [prLink('prompted', failing, 1)] });
    const mentioner = session({ name: 'mentioner', prLinks: [prLink('mentioned', failing, 2)] });
    const both = session({ name: 'both', prLinks: [prLink('mentioned', failing, 1), prLink('opened', failing, 40)] });
    const elsewhere = session({ name: 'elsewhere', prLinks: [prLink('opened', other), prLink('pushed', { ...failing, head: { repo: 'example/demo-app', branch: 'another' } })] });
    const linked = sessionsFor(failing, [opener, pusher, prompted, mentioner, both, elsewhere, opener]);
    expect(linked.strong.map(({ session: each, link }) => [each.name, link.kind])).toEqual([
      ['pusher', 'pushed'],
      ['opener', 'opened'],
      ['both', 'opened'],
      ['prompted', 'prompted'],
    ]);
    expect(linked.mentioned.map(({ session: each }) => each.name)).toEqual(['mentioner']);
  });

  it("matches a pushed branch by the PR's head, and nothing for a PR with no head", () => {
    const fork = pr({ number: 5, head: { repo: 'someone/demo-app', branch: 'fix' } });
    const pusher = session({ prLinks: [{ kind: 'pushed', repo: 'someone/demo-app', branch: 'fix', lastAt: minutesAgo(1) }] });
    expect(sessionsFor(fork, [pusher]).strong).toHaveLength(1);
    expect(sessionsFor(pr({ number: 5, head: undefined }), [pusher]).strong).toHaveLength(0);
  });

  it("gives a session its strongly linked open PRs, the ones that need attention first, then the newest link's", () => {
    const worker = session({ prLinks: [prLink('opened', quiet, 1), prLink('pushed', failing, 50), prLink('mentioned', other, 0)] });
    expect(prsFor(worker, [quiet, failing, other]).map((each) => each.number)).toEqual([42, 7]);
    const newest = session({ prLinks: [prLink('opened', quiet, 30), prLink('prompted', other, 2)] });
    expect(prsFor(newest, [quiet, other]).map((each) => each.number)).toEqual([9, 7]);
    // Only mentioned, or linked to a PR that isn't open: none.
    expect(prsFor(session({ prLinks: [prLink('mentioned', quiet)] }), [quiet])).toEqual([]);
    expect(prsFor(session({ prLinks: [prLink('opened', pr({ number: 99 }))] }), [quiet])).toEqual([]);
    const map = prsBySession([worker, session({})], [quiet, failing, other]);
    expect([...map.keys()]).toEqual([worker.sessionId]);
  });

  it("makes the row's badge from the most urgent one, with how many more, and each in its hint", () => {
    expect(sessionPrBadge(undefined)).toBeUndefined();
    expect(sessionPrBadge([])).toBeUndefined();
    const badge = sessionPrBadge([failing, quiet, other]);
    expect([badge?.pr.number, badge?.more, badge?.attention]).toEqual([42, 2, true]);
    expect(badge?.hint.split('\n')).toEqual([
      'example/demo-app #42: A made-up change, number 42 (checks failing)',
      'example/demo-app #7: A made-up change, number 7',
      'example/event-relay #9: A made-up change, number 9',
    ]);
    expect(sessionPrBadge([quiet])?.attention).toBe(false);
  });
});

describe('prStateBadges', () => {
  const states = (each: PullRequestSummary) => prStateBadges(each).map((badge) => [badge.label, badge.look, badge.attention]);

  it('highlights failing checks, conflicts and changes requested, then the quieter ones', () => {
    expect(states(pr({ number: 1, checks: 'failing', mergeable: 'conflicts', review: 'changes-requested', draft: true }))).toEqual([
      ['Checks failing', 'subtle-danger', true],
      ['Conflicts', 'subtle-danger', true],
      ['Changes requested', 'subtle-warning', true],
      ['Draft', 'outline', false],
    ]);
    expect(states(pr({ number: 2, review: 'approved', checks: 'pending' }))).toEqual([
      ['Approved', 'subtle-success', false],
      ['Checks pending', 'subtle-neutral', false],
    ]);
    // Healthy and unknown states stay quiet.
    expect(states(pr({ number: 3, review: 'review-required', mergeable: 'unknown', checks: 'none' }))).toEqual([]);
  });

  it('keys a PR by its repo and number', () => {
    expect(prKey(pr({ number: 42, repoLabel: 'Example/Demo-App' }))).toBe('example/demo-app/42');
  });
});
