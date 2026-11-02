// Pull requests (M4, W95, W106; docs/design-system.md, 4: Pull requests): a row is a piece of work. The
// repo list's Pull requests item and its count, Needs you with the PR rows that need you, a cloned repo
// with only PR rows and one that isn't cloned; the Pull requests view, its rows, sessions' and PRs'
// alike, the session rows' badges for the PRs they own, a PR row's two lines, the badges' line, the
// hidden line and its link, Show older, the filter and W101's chips; the PR view, its details, its
// sessions with the one that owns it first, Open on GitHub, which leaves for the PR's own page, and
// Copy link; a session opened from it and the PR from the session's header, with the back button; the
// session view's Pull requests tab; Has PR; Refresh, its spinner, its minute (W100) and a 429; each
// source state; a ?pr= link; and `j` and `k` through session and PR rows. Made-up PRs only
// (fixtures.ts, PRS).

import { NAMES, PR_TEAM, PRS, PRS_ERRORS, PRS_SEARCH_ERRORS, type PrsState } from '../fixtures.js';
import type { PageRecords } from '../page.js';
import type { Part } from '../runner.js';
import { chooseInRepoList, focused, listHeading, openFromRow, openRepoList, repoItem, repoLabels, row, toasts, VIEW, viewTabButton } from './_dom.js';

const q = JSON.stringify;
const LIST = `document.querySelector('main.pr-list')`;
const MAIN = `document.querySelector('main.session-list')`;
const READY = `!!document.querySelector('main.pr-list [data-open-pr], main.pr-list [data-open-session], main.pr-list .empty-state, main.pr-list .list-waiting')`;
/** Every row shown in the list, a session's by its name, a PR's as "#n", in order. */
const rows = `[...(${MAIN}?.querySelectorAll('[data-open-session], [data-open-pr]') ?? [])].filter((b) => !b.closest('[hidden]')).map((b) => b.dataset.openPr !== undefined ? '#' + b.dataset.openPr.split('/').pop() : b.textContent.trim())`;
const prRows = `[...(${MAIN}?.querySelectorAll('[data-open-pr]') ?? [])].filter((b) => !b.closest('[hidden]')).map((b) => b.dataset.openPr)`;
const prRow = (key: string) => `${MAIN}?.querySelector(${q(`li[data-pr="${key}"]`)})`;
const prTitle = (key: string) => `${MAIN}?.querySelector(${q(`[data-open-pr="${key}"]`)})`;
const summary = `${MAIN}?.querySelector('.summary')?.textContent`;
const FIELD = `${LIST}?.querySelector('input[type="search"]')`;
const REFRESH = `${LIST}?.querySelector('[data-pr-refresh]')`;
const PR_VIEW = `document.getElementById('pr-view')`;
const prViewTitle = `${PR_VIEW}?.querySelector('h2 bdi')?.textContent`;
const SESSION_VIEW = `document.getElementById('session-view')`;
const sessionViewName = `${SESSION_VIEW}?.querySelector('.session-view-name')?.textContent`;
const button = (scope: string, label: string) => `[...(${scope}?.querySelectorAll('button') ?? [])].find((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${q(label)})`;
const emptyTitle = `${MAIN}?.querySelector('.empty-state-title')?.textContent`;
const chip = (label: string) => `[...(${MAIN}?.querySelectorAll('.filter-chips .chip') ?? [])].find((b) => b.textContent.trim() === ${q(label)})`;
const badgesOf = (key: string) => `[...${prRow(key)}.querySelectorAll('.badge')].map((b) => b.textContent)`;
const prBadgeOf = (name: string) => `${row(name)}?.closest('li').querySelector('.pr-badge')?.textContent ?? null`;
const n = (key: string) => `#${key.split('/').pop()}`;
/**
 * Every row with an open PR (W106): those that need you first, by activity, the sessions that own one
 * and the PR rows no session owns; then the rest. Not the two older than 90 days, behind Show older.
 */
const ALL_ROWS = [NAMES.waiting, NAMES.asked, n(PRS.review), n(PRS.teamReview), NAMES.running, NAMES.fromRoot, n(PRS.notCloned), n(PRS.mentioned), NAMES.endedPr, n(PRS.draft)];
const HIDDEN_LINE = '2 pull requests are hidden: no root claims other-org or third-org. How to show them';

const part: Part = {
  name: 'prs',
  title: "Pull requests: rows of work, the repo list's counts, repos with only PR rows and not cloned, the Pull requests view, the PR view, links both ways, the session view's tab, Has PR, Refresh and each source state",
  async run(t) {
    const { page, server } = t;
    const records = () => page.records() as Promise<PageRecords>;
    // Ready once the Pull requests view shows rows, an empty state or its skeletons, or for another view, its sessions.
    const freshList = (search = '?view=prs', state?: PrsState) => t.fresh({ search, ...(search.startsWith('?view=prs') ? { ready: READY } : {}), ...(state ? { prs: state } : {}) });
    /** Closes the open view, as Close or Back does. */
    const closeView = async () => {
      await page.key('Escape');
      await page.waitFor('the view to close', `!${PR_VIEW} && !${SESSION_VIEW}`);
    };
    const closeDrawer = async () => {
      if (t.layout !== 'drawer') return;
      await page.key('Escape');
      await page.waitFor('the drawer to close', `!document.querySelector('.repo-drawer')`);
    };
    const switchTo = async (state: PrsState, what: string, ready: string) => {
      server.world.setPrs(state);
      server.broadcastPrs();
      await page.waitFor(what, ready);
    };

    await t.step('the repo list counts PR rows, Needs you and Pull requests count what needs you through a PR, and lists repos with only PR rows', async () => {
      await freshList('?view=all');
      await openRepoList(t);
      t.expectEqual((await page.evaluate<string[]>(repoLabels)).slice(0, 4), ['Needs you', 'All sessions', 'Starred', 'Pull requests'], 'the views, in order');
      const badge = await page.evaluate<{ text: string; solid: boolean } | null>(`(() => { const b = ${repoItem('Pull requests')}?.querySelector('.badge'); return b ? { text: b.textContent, solid: b.classList.contains('badge-attention') } : null; })()`);
      // #51 (pitwall-test-docs's) and #612 (pitwall-test-review's), and #57 and #618, which ask your review.
      t.expectEqual(badge, { text: '4 need you', solid: true }, "Pull requests' badge: the rows that need you through a PR");
      t.expectEqual(await page.evaluate(`${repoItem('Needs you')}?.querySelector('.badge')?.textContent`), '5 need you', 'Needs you counts the PR rows that need you');
      const notCloned = await page.evaluate<{ text: string; marked: boolean; count: string } | null>(`(() => {
        const a = ${repoItem('example/sdk-docs')};
        return a ? { text: a.textContent, marked: a.classList.contains('not-cloned'), count: a.querySelector('.repo-item-count')?.textContent ?? '' } : null;
      })()`);
      t.expectEqual(notCloned, { text: 'example/sdk-docs, not cloned1 session', marked: true, count: '1 session' }, 'a repo that isn’t cloned, for its PR row');
      t.expectEqual(await page.evaluate(`${repoItem('event-relay')}?.querySelector('.badge')?.textContent`), '1 needs you', 'a cloned repo with no session, for its PR rows: #618 needs you');
      t.expectEqual(await page.evaluate(`document.title`), '(5) pitwall', 'the page title counts them too');
      await t.shot('repo-list');
      await closeDrawer();
    });

    await t.step('a repo that isn’t cloned lists its PR row, says so in its heading, and has no Hide', async () => {
      await chooseInRepoList(t, 'example/sdk-docs');
      t.expectEqual(await page.evaluate(rows), [n(PRS.notCloned)], 'its PR row');
      t.expectEqual(await page.evaluate(`${MAIN}.querySelector('.session-list-not-cloned')?.textContent`), 'Not cloned', 'its heading says so');
      t.expect(!(await page.evaluate<boolean>(`!!${MAIN}.querySelector('.session-list-end button')`)), 'no Hide from repo list');
      t.expect(!(await page.evaluate<string>(`localStorage.getItem('pitwall.view.v1') ?? ''`)).includes('sdk-docs'), "its name isn't stored");
      await t.shot('not-cloned');
    });

    await t.step('Pull requests lists every row with an open PR, those that need you first, sessions and PR rows alike', async () => {
      await chooseInRepoList(t, 'Pull requests');
      t.expect((await page.evaluate<string>('location.search')).startsWith('?view=prs'), 'the URL says so');
      t.expectEqual(await page.evaluate(rows), ALL_ROWS, 'the rows');
      t.expectEqual(await page.evaluate(summary), '10 sessions4 need you', 'the summary');
      // Each session's most urgent PR it owns; #48 is pitwall-test-nightly-export's since it pushed to it, after pitwall-test-review opened it.
      t.expectEqual(await page.evaluate(prBadgeOf(NAMES.waiting)), 'Pull request #51, CI failing, needs attention', `${NAMES.waiting}'s`);
      t.expectEqual(await page.evaluate(prBadgeOf(NAMES.asked)), 'Pull request #612, conflicts, needs attention', `${NAMES.asked}'s: #48 is no longer its`);
      t.expectEqual(await page.evaluate(prBadgeOf(NAMES.running)), 'Pull request #48', `${NAMES.running}'s, neutral`);
      await t.shot('list');
    });

    await t.step("a PR row is two lines: its number, title, badges and when it was updated, then its group, why it needs you and 'No session listed'", async () => {
      const shape = await page.evaluate<{ title: string; badges: string[]; line2: string; lines: number[]; attention: boolean; inside: boolean }>(`(() => {
        const li = ${prRow(PRS.teamReview)};
        const box = li.getBoundingClientRect();
        const end = li.querySelector('.pr-row-end').getBoundingClientRect();
        const lineOf = (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
        return {
          title: li.querySelector('h3 button').textContent,
          badges: [...li.querySelectorAll('.badge')].map((b) => b.textContent),
          line2: li.querySelector('.pr-what').textContent,
          lines: [lineOf(li.querySelector('.session-name')), lineOf(li.querySelector('.pr-what'))],
          attention: li.dataset.attention === 'true',
          inside: end.right <= box.right + 0.5,
        };
      })()`);
      t.expectEqual(shape.title, '#618 Rename the made-up delivery states', 'line 1: its number and title');
      t.expectEqual(shape.badges, ['Review requested', 'Checks failing'], 'its badges');
      t.expectEqual(shape.line2, 'event-relay · Your review is requested · No session listed', 'line 2');
      t.expect(await page.evaluate<boolean>(`${prRow(PRS.teamReview)}.querySelector('.session-line > time.activity')?.textContent.endsWith(' ago') === true`), 'when it was updated, in the time slot');
      t.expectEqual(shape.lines, [1, 1], 'one line each');
      t.expect(shape.attention && shape.inside, 'it needs you, and its end is whole, inside the row', shape);
      t.expect((await page.evaluate<string>(`${prRow(PRS.notCloned)}.querySelector('.pr-what').textContent`)).endsWith(' · Not cloned'), "a not-cloned repo's row says so");
      // The badges line up with the session rows', against the time's slot, which a PR row keeps empty.
      const edges = await page.evaluate<number[]>(`[...${MAIN}.querySelectorAll('li.session')].filter((li) => !li.closest('[hidden]') && li.querySelector('.session-badges .badge')).map((li) => Math.round(li.querySelector('.session-badges').getBoundingClientRect().right))`);
      t.expect(new Set(edges).size === 1, "every row's badges end at the same x", edges);
      await t.shot('pr-row');
    });

    await t.step('the foot says how many PRs no root claims, with a link to the README, and Show older lists the older PR rows, keeping focus', async () => {
      t.expectEqual(await page.evaluate(`${LIST}.querySelector('.pr-hidden')?.textContent`), HIDDEN_LINE, 'the hidden line');
      const link = await page.evaluate<{ href: string; target: string; rel: string }>(`(() => { const a = ${LIST}.querySelector('.pr-hidden a'); return { href: a.getAttribute('href'), target: a.target, rel: a.rel }; })()`);
      t.expectEqual(link, { href: 'https://github.com/leggetter/pitwall#configuration', target: '_blank', rel: 'noopener noreferrer' }, 'its link');
      await page.click('Show 2 older pull requests', button(LIST, 'Show 2 older pull requests'));
      await page.waitFor('the older PRs', `${prRows}.includes(${q(PRS.older)}) && ${prRows}.includes(${q(PRS.olderFailing)})`);
      t.expectEqual(await page.evaluate(focused), 'Hide older pull requests', 'focus on the same button');
      // Listed here alone: #41's failing checks are in no need-you count, and it has no bar.
      t.expectEqual(await page.evaluate(summary), '12 sessions4 need you', 'listed while shown, never needing you');
      t.expect(!(await page.evaluate<boolean>(`${prRow(PRS.olderFailing)}.classList.contains('attention')`)), 'no bar on #41');
      t.expectEqual(await page.evaluate('document.title'), '(5) pitwall', 'the page title counts no more');
      t.expect(!(await page.evaluate<string[]>(repoLabels)).includes('example/docs-site'), 'no repo for them in the repo list');
      await t.shot('older');
      await page.click('Hide older pull requests', button(LIST, 'Hide older pull requests'));
      await page.waitFor('the older PRs to go', `!${prRows}.includes(${q(PRS.older)})`);
    });

    await t.step('the filter finds a session by a PR it owns and a PR row by its number or title, and says when nothing matches', async () => {
      await page.click('the filter field', FIELD);
      await page.type('#612');
      await page.waitFor('one row', `${rows}.length === 1`);
      t.expectEqual(await page.evaluate(rows), [NAMES.asked], 'the session that owns #612');
      await page.key('Escape');
      await page.type('retry budget');
      await page.waitFor('one row', `${rows}.length === 1`);
      t.expectEqual(await page.evaluate(rows), [n(PRS.review)], 'a PR row by its title');
      t.expectEqual(await page.evaluate(`${prRow(PRS.review)}.querySelector('mark')?.textContent`), 'retry budget', 'highlighted');
      await page.key('Escape');
      await page.type('nothing like it');
      await page.waitFor('the empty state', `${emptyTitle} === 'No sessions match'`);
      await t.shot('no-match');
      await page.click('Clear filter', button(LIST, 'Clear filter'));
      await page.waitFor('every row', `${rows}.length === ${ALL_ROWS.length}`);
      t.expectEqual(await page.evaluate('document.activeElement?.type'), 'search', 'focus in the field');
    });

    await t.step('a PR row that asks your review or mentions you says so first among its badges, a team’s naming the team (W101)', async () => {
      t.expectEqual(await page.evaluate(badgesOf(PRS.review)), ['Review requested'], "#57's badge");
      t.expectEqual(await page.evaluate(badgesOf(PRS.teamReview)), ['Review requested', 'Checks failing'], "#618's: its review, then its author's failing checks");
      t.expectEqual(await page.evaluate(badgesOf(PRS.mentioned)), ['Mentioned'], "#23's");
      const looks = await page.evaluate<{ review: boolean; mention: boolean; hint: boolean }>(`({
        review: ${prRow(PRS.review)}.querySelector('.pr-state-review-requested').classList.contains('badge-subtle-warning'),
        mention: ${prRow(PRS.mentioned)}.querySelector('.pr-state-mentioned').classList.contains('badge-subtle-neutral'),
        hint: ${prRow(PRS.teamReview)}.querySelector('.pr-state-review-requested').classList.contains('has-hint'),
      })`);
      t.expectEqual(looks, { review: true, mention: true, hint: true }, 'Review requested in subtle warning, with a hint for a team’s; Mentioned in subtle neutral');
      await t.shot('relations');
    });

    await t.step('the chips Yours, Review requested and Mentioned filter the rows, combine as OR, move nothing in the header, and Clear filters clears them', async () => {
      t.expectEqual(await page.evaluate(`[...${LIST}.querySelectorAll('.filter-chips .chip')].map((b) => b.textContent)`), ['Yours', 'Review requested', 'Mentioned'], 'the chips');
      t.expectEqual(await page.evaluate(`new Set([...${LIST}.querySelectorAll('.filter-chips .chip')].map((b) => Math.round(b.getBoundingClientRect().top))).size`), 1, 'the chips on one line');
      const head = `${LIST}.querySelector('.session-list-head').getBoundingClientRect().height`;
      const before = await page.evaluate<number>(head);
      await page.click('Review requested', chip('Review requested'));
      await page.waitFor('the review requests', `${rows}.length === 2`);
      t.expectEqual(await page.evaluate(rows), [n(PRS.review), n(PRS.teamReview)], 'only those that ask your review');
      t.expectEqual(await page.evaluate(summary), '2 of 10 sessions4 need you', 'the summary says what it hides');
      t.expectEqual(await page.evaluate<number>(head), before, 'the header as tall');
      const line = await page.evaluate<{ clear: number; refresh: number; top: boolean }>(`(() => {
        const clear = ${LIST}.querySelector('.pr-list-fetched [data-clear-filters]').getBoundingClientRect();
        const refresh = ${REFRESH}.getBoundingClientRect();
        return { clear: Math.round(clear.right), refresh: Math.round(refresh.left), top: Math.abs(clear.top - refresh.top) < 1 };
      })()`);
      t.expect(line.top && line.clear <= line.refresh, 'Clear filters just before Refresh', line);
      await t.shot('chip-review');
      await page.click('Mentioned', chip('Mentioned'));
      await page.waitFor('the mention too', `${rows}.length === 3`);
      t.expectEqual(await page.evaluate(rows), [n(PRS.review), n(PRS.teamReview), n(PRS.mentioned)], 'review requests or mentions');
      await page.click('Clear filters', `${LIST}.querySelector('.pr-list-fetched [data-clear-filters]')`);
      await page.waitFor('every row', `${rows}.length === ${ALL_ROWS.length}`);
      t.expectEqual(await page.evaluate('document.activeElement?.type'), 'search', 'focus in the field');
    });

    await t.step("a PR row opens its PR view, which says your review is requested through the team (W101)", async () => {
      await page.click('#618', prTitle(PRS.teamReview));
      await page.waitFor('its view', `${prViewTitle} === 'Rename the made-up delivery states'`);
      t.expectEqual(await page.evaluate('location.search'), `?view=prs&pr=${PRS.teamReview}`, 'the URL');
      t.expectEqual(await page.evaluate(`${prRow(PRS.teamReview)}.classList.contains('open')`), true, 'its row marked open');
      t.expectEqual(await page.evaluate(focused), 'the view heading', 'focus on its heading');
      t.expectEqual(await page.evaluate(`${PR_VIEW}.querySelector('.pr-view-relation')?.textContent`), `Your review is requested through ${PR_TEAM}.`, 'through the team');
      t.expectEqual(await page.evaluate(`${PR_VIEW}.querySelector('.pr-view-none')?.textContent ?? ''`) !== '', true, 'no session has worked on it');
      await t.shot('view-team-review');
      await closeView();
    });

    await t.step("a session's header links to the PRs it owns; the PR view lists its sessions, the owner first, with Open on GitHub and Copy link", async () => {
      await openFromRow(t, NAMES.waiting);
      t.expectEqual(await page.evaluate(`[...${SESSION_VIEW}.querySelectorAll('[data-pr-link]')].map((b) => b.getAttribute('aria-label'))`), ['Pull request example/demo-app #51'], 'its PR link');
      await page.click('#51', `${SESSION_VIEW}.querySelector(${q(`[data-pr-link="${PRS.failing}"]`)})`);
      await page.waitFor('its view', `${prViewTitle} === 'Add a made-up health route'`);
      t.expectEqual(await page.evaluate('location.search'), `?view=prs&pr=${PRS.failing}`, 'the URL');
      const view = await page.evaluate<{ details: Record<string, string>; sessions: string[]; why: string[]; mentioned: string[]; link: { href: string; target: string; rel: string } | null; copy: boolean; back: string | null }>(`(() => {
        const view = ${PR_VIEW};
        const sections = [...view.querySelectorAll('.pr-view-section')];
        const section = (title) => sections.find((s) => s.querySelector('h3').textContent === title);
        const names = (title) => [...(section(title)?.querySelectorAll('.pr-view-session-open') ?? [])].map((b) => b.textContent);
        const a = view.querySelector('a.pr-view-github');
        return {
          details: Object.fromEntries([...view.querySelectorAll('.pr-view-detail')].map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent])),
          sessions: names('Sessions'),
          why: [...(section('Sessions')?.querySelectorAll('.pr-view-session-why') ?? [])].map((s) => s.textContent),
          mentioned: names('Mentioned in'),
          link: a ? { href: a.getAttribute('href'), target: a.target, rel: a.rel } : null,
          copy: !!view.querySelector('button[aria-label="Copy link"]'),
          back: view.querySelector('.session-view-back')?.textContent ?? null,
        };
      })()`);
      t.expectEqual(view.details.Checks, 'Failingtest (22.x)linte2e (chrome)+2 more', 'the failing checks, and how many more');
      t.expectEqual(view.sessions, [NAMES.waiting, NAMES.conversation], 'the session that owns it first, then the one that opened it');
      t.expectEqual(view.why, ['Pushed its branch · Its session', 'Opened it'], 'why each is linked, and which owns it');
      t.expectEqual(view.mentioned, [NAMES.asked], 'and the one that named it');
      t.expectEqual(view.link, { href: 'https://github.com/example/demo-app/pull/51', target: '_blank', rel: 'noopener noreferrer' }, 'Open on GitHub');
      t.expect(view.copy, 'Copy link');
      t.expectEqual(view.back, t.compact ? 'Back to pull requests' : null, 'Back at 600 px and narrower');
      await t.shot('view');
    });

    await t.step("Open on GitHub leaves for the PR's own page, in a new tab with no opener or referrer", async () => {
      await page.click('Open on GitHub', `${PR_VIEW}.querySelector('a.pr-view-github')`);
      t.expectEqual((await records()).clicks.at(-1), { href: 'https://github.com/example/demo-app/pull/51', target: '_blank', rel: 'noopener noreferrer', prevented: false }, 'pitwall let it open');
    });

    await t.step('a session from the PR view opens in its place, with the back button between them', async () => {
      await page.click(NAMES.conversation, `${PR_VIEW}.querySelector(${q(`[data-open-linked-session="${server.world.byName(NAMES.conversation).sessionId}"]`)})`);
      await page.waitFor('its view', `${sessionViewName} === ${q(NAMES.conversation)}`);
      t.expect(!(await page.evaluate<boolean>(`!!${PR_VIEW}`)), 'in the PR view’s place');
      t.expectEqual(await page.evaluate('location.search'), `?view=prs&session=${server.world.byName(NAMES.conversation).sessionId}`, 'the URL');
      // It opened #51, but pitwall-test-docs pushed to it since: no link in its header, and its tab lists it.
      t.expectEqual(await page.evaluate(`${SESSION_VIEW}.querySelectorAll('[data-pr-link]').length`), 0, 'no PR link: it owns none');
      await page.evaluate('history.back()');
      await page.waitFor('the PR view again', `${prViewTitle} === 'Add a made-up health route'`);
      await page.evaluate('history.forward()');
      await page.waitFor('the session view again', `${sessionViewName} === ${q(NAMES.conversation)}`);
      await closeView();
    });

    await t.step("the session view's Pull requests tab lists the PRs it owns, with their details, then those another session owns", async () => {
      await openFromRow(t, NAMES.asked);
      await page.click('Pull requests (2)', viewTabButton('Pull requests (2)'));
      await page.waitFor('the panel', `!!${VIEW}?.querySelector('.session-prs:not([hidden]) .session-pr')`);
      const panel = await page.evaluate<{ headings: string[]; titles: string[]; owner: string; checks: string; github: string | null }>(`(() => {
        const panel = ${VIEW}.querySelector('.session-prs');
        return {
          headings: [...panel.querySelectorAll('h3')].map((h) => h.textContent),
          titles: [...panel.querySelectorAll('.session-pr-open')].map((b) => b.textContent),
          owner: panel.querySelector('.session-pr-owner')?.textContent ?? '',
          checks: panel.querySelector('.session-pr .pr-view-detail dd')?.textContent ?? '',
          github: panel.querySelector('.session-pr a.pr-view-github')?.getAttribute('href') ?? null,
        };
      })()`);
      t.expectEqual(panel.headings, ['Its pull requests', 'Also worked on'], 'its own, then the others');
      t.expectEqual(panel.titles, ['#612 Retry made-up deliveries with backoff', '#48 Tidy the made-up export job'], 'each by its number and title');
      t.expectEqual(panel.owner, `Listed with ${NAMES.running}.`, 'which session #48 is listed with');
      t.expectEqual(panel.checks, 'Passing', "#612's checks");
      t.expectEqual(panel.github, 'https://github.com/example/event-relay/pull/612', 'Open on GitHub');
      t.expect(await page.evaluate(`!${VIEW}.querySelector('.session-view-foot')?.hidden`), 'the message box stays: it is the session’s');
      await t.shot('session-tab');
      await page.click('#612', `${VIEW}.querySelector(${q(`[data-open-session-pr="${PRS.conflicts}"]`)})`);
      await page.waitFor('its PR view', `${prViewTitle} === 'Retry made-up deliveries with backoff'`);
      await closeView();
    });

    await t.step('Has PR keeps the rows with an open PR in any list, and a kind chip keeps PR rows out', async () => {
      await chooseInRepoList(t, 'All sessions');
      await page.click('Has PR', chip('Has PR'));
      await page.waitFor('the rows with a PR', `${rows}.length === ${ALL_ROWS.length}`);
      t.expectEqual([...(await page.evaluate<string[]>(rows))].sort(), [...ALL_ROWS].sort(), 'the rows with an open PR, as Pull requests lists them');
      await page.click('Interactive', chip('Interactive'));
      await page.waitFor('the interactive ones', `${rows}.length === 4`);
      t.expectEqual(await page.evaluate(rows), [NAMES.waiting, NAMES.asked, NAMES.fromRoot, NAMES.endedPr], 'interactive sessions with an open PR, the ended one among them');
      await t.shot('has-pr');
      await page.click('Clear filters', `${MAIN}.querySelector('.filter-chips [data-clear-filters]')`);
      await page.waitFor('the filters to clear', `!${MAIN}.querySelector('.filter-chips .chip[aria-pressed="true"]')`);
    });

    await t.step('Needs you lists the PR rows that need you, with the sessions; one marked not needed now stays while its PR needs you, and says why', async () => {
      await chooseInRepoList(t, 'Needs you');
      t.expectEqual(await page.evaluate(rows), [NAMES.waiting, NAMES.asked, NAMES.prompting, n(PRS.review), n(PRS.teamReview)], 'the sessions, then the PR rows, by activity');
      const toggle = `${row(NAMES.asked)}?.closest('li').querySelector('[data-not-needed-session]')`;
      await page.click(`the toggle on ${NAMES.asked}`, toggle);
      await page.waitFor('it marked', `${toggle}?.getAttribute('aria-pressed') === 'true'`);
      await page.settle(150);
      t.expect((await page.evaluate<string[]>(rows)).includes(NAMES.asked), '#612 still needs you, so it stays');
      t.expectEqual(await page.evaluate(`${row(NAMES.asked)}?.closest('li').querySelector('.session-what-text')?.textContent`), 'demo-app · Not needed now · #612 has merge conflicts', 'line 2 says why');
      t.expect(await page.evaluate<boolean>(`${toasts}.includes(${q(`Marked ${NAMES.asked} not needed now. It stays in Needs you while #612 needs you.`)})`), 'the toast says it stays, and why');
      const colours = await page.evaluate<{ reason: string; muted: string }>(`(() => { const li = ${row(NAMES.asked)}.closest('li'); return { reason: getComputedStyle(li.querySelector('.pr-reason')).color, muted: getComputedStyle(li.querySelector('.session-not-needed')).color }; })()`);
      t.expect(colours.reason !== colours.muted, "the PR's reason isn't muted: it still holds", colours);
      await t.shot('marked-with-pr');
      await page.click(`the toggle on ${NAMES.asked} again`, toggle);
      await page.waitFor('the mark gone', `${toggle}?.getAttribute('aria-pressed') === 'false'`);
    });

    await t.step('Refresh fetches once, with its spinner, then is off for a minute', async () => {
      await chooseInRepoList(t, 'Pull requests');
      await page.waitFor('the rows', `${rows}.length > 0`);
      server.clearRecords();
      await page.click('Refresh', REFRESH);
      await page.waitFor('the spinner', `${REFRESH}?.getAttribute('aria-busy') === 'true'`);
      await page.waitFor('the fetch to finish', `${REFRESH}?.getAttribute('aria-busy') === null`);
      t.expectEqual(server.records.refreshes, [200], 'one refresh');
      t.expectEqual(await page.evaluate(`${REFRESH}.getAttribute('aria-disabled')`), 'true', 'off for a moment');
      t.expectEqual(await page.evaluate(`${LIST}.querySelector('.pr-list-updated')?.textContent`), 'Updated just now', 'fetched just now');
      await page.click('Refresh again', REFRESH);
      await page.settle(200);
      t.expectEqual(server.records.refreshes, [200], 'nothing more asked');
      await t.shot('refreshed');
    });

    await t.step('a refresh within a minute of the last fetch gets an info toast with when, not an error', async () => {
      // A reload forgets the page's own minute; the server's is still running.
      await page.reload();
      await page.waitFor('the list after the reload', `${rows}.length > 0`);
      t.allow(/\/api\/prs\/refresh/, 'the 429 the step brings about');
      await page.click('Refresh', REFRESH);
      await page.waitFor('the toast', `${toasts}.some((text) => /^pitwall checked GitHub moments ago\\. Refresh again in \\d+ seconds?\\.$/.test(text))`);
      t.expect(await page.evaluate<boolean>(`!!document.querySelector('.toasts .toast.info')`), 'an info toast');
      t.expectEqual(server.records.refreshes, [200, 429], 'the 429');
      t.expectEqual(await page.evaluate(`${REFRESH}.getAttribute('aria-disabled')`), 'true', 'off until then');
    });

    await t.step('each source state says what it is and how to fix it, off gives way to All sessions, and an ok fetch brings the rows back', async () => {
      await switchTo('loading', 'the skeletons', `!!${LIST}?.querySelector('.skeleton-rows')`);
      await t.shot('loading');
      await switchTo('gh-missing', 'gh missing', `${emptyTitle} === "gh isn't installed"`);
      t.expect((await page.evaluate<string>(`${LIST}.querySelector('.empty-state-sentence').textContent`)).includes('run gh auth login, then Refresh.'), 'how to install it and log in');
      await t.shot('gh-missing');
      await switchTo('gh-auth', 'gh not logged in', `${emptyTitle} === "gh isn't logged in to GitHub"`);
      await t.shot('gh-auth');
      await switchTo('error', 'the failure', `${emptyTitle} === "Couldn't list your pull requests"`);
      t.expect((await page.evaluate<string>(`${LIST}.querySelector('.empty-state-sentence').textContent`)).startsWith(PRS_ERRORS.error), "pitwall's words");
      await t.shot('error');
      await switchTo('stale', 'the notice', `!!${LIST}?.querySelector('.pr-stale .inline-alert')`);
      t.expect((await page.evaluate<string>(`${LIST}.querySelector('.pr-stale').textContent`)).endsWith('This list is from 2h ago.'), 'when the list is from');
      t.expectEqual((await page.evaluate<string[]>(rows)).length, ALL_ROWS.length, 'the last list kept');
      await t.shot('stale');
      // W101's review: one search that failed while another worked is named, with when its PRs are from.
      await switchTo('partial', 'the notice naming each search', `${LIST}?.querySelectorAll('.pr-stale-search').length === 2`);
      t.expectEqual(await page.evaluate(`${LIST}.querySelector('.pr-stale .inline-alert-title')?.textContent`), "Couldn't refresh part of your pull requests", 'its title');
      t.expectEqual(
        await page.evaluate(`[...${LIST}.querySelectorAll('.pr-stale-search')].map((p) => p.textContent)`),
        [`The pull requests that ask your review are from 2h ago. ${PRS_SEARCH_ERRORS['review-requested']}`, `The pull requests that mention you aren't listed. ${PRS_SEARCH_ERRORS.mentioned}`],
        'each failed search, and when its PRs are from',
      );
      t.expectEqual(await page.evaluate(rows), ALL_ROWS.filter((each) => each !== n(PRS.mentioned)), 'yours new, the review requests kept, no mention');
      await t.shot('partial');
      // Off, as after a restart with --no-prs: no item, so All sessions takes Pull requests' place.
      await switchTo('off', 'All sessions in its place', `${listHeading} === 'All sessions'`);
      t.expectEqual(await page.evaluate('location.search'), '?view=all', 'the URL replaced');
      t.expectEqual(await page.evaluate(`localStorage.getItem('pitwall.view.v1')`), 'view=all', 'and remembered');
      await openRepoList(t);
      t.expect(!(await page.evaluate<string[]>(repoLabels)).includes('Pull requests'), 'no item in the repo list');
      t.expect(!(await page.evaluate<string[]>(repoLabels)).includes('example/sdk-docs'), 'and no repo for PR rows alone');
      await closeDrawer();
      await t.shot('off');
      server.world.setPrs('ok');
      server.broadcastPrs();
      await chooseInRepoList(t, 'Pull requests');
      await page.waitFor('the rows', `${rows}.length === ${ALL_ROWS.length}`);
    });

    await t.step("once you've reviewed each one asked, they leave the rows and the counts, and a chip with none of its kind says so (W101)", async () => {
      await switchTo('mine', 'only yours', `${rows}.length === ${ALL_ROWS.length - 3}`);
      await openRepoList(t);
      t.expectEqual(await page.evaluate(`${repoItem('Pull requests')}?.querySelector('.badge')?.textContent`), '2 need you', 'the count without them');
      await closeDrawer();
      await page.click('Review requested', chip('Review requested'));
      await page.waitFor('the empty state', `${emptyTitle} === 'No reviews requested'`);
      t.expect((await page.evaluate<string>(`${LIST}.querySelector('.empty-state-sentence').textContent`)).includes("One asked of you leaves once you've reviewed it."), 'says how they come and go');
      await t.shot('no-reviews');
      // The 429's info toast, from two steps back, covers the empty state in a short window: dismissed, as you would.
      while (await page.evaluate<boolean>(`!!document.querySelector('.toasts .toast:not(.leaving) .toast-dismiss')`)) {
        await page.click('Dismiss', `document.querySelector('.toasts .toast:not(.leaving) .toast-dismiss')`);
        await page.settle(100);
      }
      await page.click('Clear filters', button(`${LIST}.querySelector('.empty-state')`, 'Clear filters'));
      await page.waitFor('the rows', `${rows}.length === ${ALL_ROWS.length - 3}`);
      server.world.setPrs('ok');
      server.broadcastPrs();
      await page.waitFor('the rows', `${rows}.length === ${ALL_ROWS.length}`);
    });

    await t.step("a ?pr= link opens that PR's view as the page loads, a restart's first list doesn't call it gone, and one that isn't open says so", async () => {
      await t.fresh({ search: `?view=prs&pr=${PRS.conflicts}`, ready: `!!${PR_VIEW}?.querySelector('h2 bdi')` });
      t.expectEqual(await page.evaluate(prViewTitle), 'Retry made-up deliveries with backoff', 'its view');
      t.expectEqual(await page.evaluate(`${PR_VIEW}.querySelector('.pr-view-detail:nth-child(3) dd')?.textContent`), 'Conflicts with its base branch', 'its conflicts');
      // A restart: the poller's first list, before its first fetch, has no PRs yet. Not "gone".
      await switchTo('loading', 'the list waiting', `!!${LIST}?.querySelector('.list-waiting')`);
      await page.settle(300);
      t.expectEqual(await page.evaluate(prViewTitle), 'Retry made-up deliveries with backoff', 'still its view');
      t.expect(!(await page.evaluate<boolean>(`!!${PR_VIEW}.querySelector('.inline-alert')`)), 'and no alert that it may have been merged or closed');
      await t.fresh({ search: '?view=prs&pr=example/demo-app/999', ready: `!!${PR_VIEW}?.querySelector('.empty-state')` });
      t.expectEqual(await page.evaluate(`${PR_VIEW}.querySelector('h2')?.textContent`), "This pull request isn't listed", 'says so');
      await t.shot('unlisted');
    });

    await t.step("j and k step through session and PR rows alike, and show each in the view once one's open", async () => {
      await freshList();
      await page.key('j');
      t.expectEqual(await page.evaluate('document.activeElement?.textContent'), NAMES.waiting, 'j: the first row');
      await page.key('j');
      await page.key('j');
      t.expectEqual(await page.evaluate('document.activeElement?.dataset.openPr ?? null'), PRS.review, 'j: on to a PR row');
      await page.key('Enter');
      await page.waitFor('its view', `${prViewTitle} === 'Add a made-up retry budget'`);
      t.expectEqual(await page.evaluate(`${PR_VIEW}.querySelector('.pr-view-relation')?.textContent`), 'Your review is requested.', 'of you');
      await page.key('j');
      await page.waitFor('the next PR', `${prViewTitle} === 'Rename the made-up delivery states'`);
      t.expectEqual(await page.evaluate('location.search'), `?view=prs&pr=${PRS.teamReview}`, 'replacing the URL');
      await page.key('k');
      await page.key('k');
      await page.waitFor('the session before', `${sessionViewName} === ${q(NAMES.asked)}`);
      t.expectEqual(await page.evaluate('location.search'), `?view=prs&session=${server.world.byName(NAMES.asked).sessionId}`, 'a session in the PR’s place');
    });
  },
};

export default part;
