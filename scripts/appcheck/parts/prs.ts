// Pull requests (M4, W95; docs/design-system.md, 4: Pull requests): the repo list's item and its
// count; the PR list's repo headings, collapsed and remembered through a reload, its rows and their
// badges, Show older and the filter; the PR view, with its details, its sessions, Open on GitHub,
// which leaves for the PR's own page, and Copy link; a session opened from it and the PR from the
// session's header, with the back button; the session rows' badges; Refresh, its spinner, its 15 s
// and a 429; each source state; a ?pr= link; and `j` and `k`. Made-up PRs only (fixtures.ts, PRS).

import { NAMES, PRS, PRS_ERRORS, type PrsState } from '../fixtures.js';
import type { PageRecords } from '../page.js';
import type { Part } from '../runner.js';
import { chooseInRepoList, focused, openRepoList, repoItem, repoLabels, row, toasts } from './_dom.js';

const q = JSON.stringify;
const LIST = `document.querySelector('main.pr-list')`;
const READY = `!!document.querySelector('main.pr-list [data-open-pr], main.pr-list .empty-state, main.pr-list .list-waiting')`;
/** The PR rows shown, by key, without those under a collapsed heading. */
const prRows = `[...(${LIST}?.querySelectorAll('[data-open-pr]') ?? [])].filter((b) => !b.closest('[hidden]')).map((b) => b.dataset.openPr)`;
const prRow = (key: string) => `${LIST}?.querySelector(${q(`li[data-pr="${key}"]`)})`;
const prTitle = (key: string) => `${LIST}?.querySelector(${q(`[data-open-pr="${key}"]`)})`;
const headings = `[...(${LIST}?.querySelectorAll('.pr-repo-label') ?? [])].map((el) => el.textContent)`;
const repoToggle = (repo: string) => `${LIST}?.querySelector(${q(`li[data-pr-repo="${repo}"] .pr-repo-toggle`)})`;
const summary = `${LIST}?.querySelector('.summary')?.textContent`;
const FIELD = `${LIST}?.querySelector('input[type="search"]')`;
const REFRESH = `${LIST}?.querySelector('[data-pr-refresh]')`;
const PR_VIEW = `document.getElementById('pr-view')`;
const prViewTitle = `${PR_VIEW}?.querySelector('h2 bdi')?.textContent`;
const SESSION_VIEW = `document.getElementById('session-view')`;
const sessionViewName = `${SESSION_VIEW}?.querySelector('.session-view-name')?.textContent`;
const button = (scope: string, label: string) => `[...(${scope}?.querySelectorAll('button') ?? [])].find((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${q(label)})`;
const emptyTitle = `${LIST}?.querySelector('.empty-state-title')?.textContent`;
const STORE = 'pitwall.pr-repos.v1';

const part: Part = {
  name: 'prs',
  title: "Pull requests: the repo list's item, the PR list, its headings, rows, Show older and filter, the PR view, links both ways, the session badges, Refresh and each source state",
  async run(t) {
    const { page, server } = t;
    const records = () => page.records() as Promise<PageRecords>;
    // Ready once the PR list shows rows, an empty state or its skeletons, or for another view, its sessions.
    const freshList = (search = '?view=prs', state?: PrsState) => t.fresh({ search, ...(search.startsWith('?view=prs') ? { ready: READY } : {}), ...(state ? { prs: state } : {}) });
    /** Closes the open view, as Close or Back does. */
    const closeView = async () => {
      await page.key('Escape');
      await page.waitFor('the view to close', `!${PR_VIEW} && !${SESSION_VIEW}`);
    };
    const switchTo = async (state: PrsState, what: string, ready: string) => {
      server.world.setPrs(state);
      server.broadcastPrs();
      await page.waitFor(what, ready);
    };

    await t.step('the repo list has Pull requests under Starred, with how many need attention in subtle danger', async () => {
      await freshList('?view=all');
      await openRepoList(t);
      t.expectEqual((await page.evaluate<string[]>(repoLabels)).slice(0, 4), ['Needs you', 'All sessions', 'Starred', 'Pull requests'], 'the views, in order');
      const badge = await page.evaluate<{ text: string; danger: boolean } | null>(`(() => { const b = ${repoItem('Pull requests')}?.querySelector('.badge'); return b ? { text: b.textContent, danger: b.classList.contains('badge-subtle-danger') } : null; })()`);
      // #51's failing checks and #612's conflicts; not #540's, which is older than 90 days.
      t.expectEqual(badge, { text: '2 need attention', danger: true }, 'its badge');
      await t.shot('repo-list');
    });

    await t.step('it lists the PRs under a heading per repo, the newest first, those that need attention first in each', async () => {
      await chooseInRepoList(t, 'Pull requests');
      await page.waitFor('the rows', `${prRows}.length > 0`);
      t.expect((await page.evaluate<string>('location.search')).startsWith('?view=prs'), 'the URL says so');
      t.expectEqual(await page.evaluate(headings), ['example/demo-app', 'hookdeck/outpost', 'example/api-server'], 'the headings, by their newest update');
      t.expectEqual(await page.evaluate(prRows), [PRS.failing, PRS.approved, PRS.conflicts, PRS.draft, PRS.quiet], 'the rows');
      t.expectEqual(await page.evaluate(summary), '5 open2 need attention', 'the summary');
      const failing = await page.evaluate<{ badges: string[]; line2: string; inside: boolean }>(`(() => {
        const li = ${prRow(PRS.failing)};
        const box = li.getBoundingClientRect();
        const time = li.querySelector('.activity').getBoundingClientRect();
        return { badges: [...li.querySelectorAll('.badge')].map((b) => b.textContent), line2: li.querySelector('.pr-what').textContent, inside: time.right <= box.right + 0.5 && time.left >= box.left };
      })()`);
      t.expectEqual(failing.badges, ['Checks failing'], "#51's badge");
      t.expect(failing.line2.startsWith('#51') && failing.line2.includes(NAMES.conversation) && !failing.line2.includes(NAMES.waiting), "its line 2: its number, and the session that opened it, not the one that only named it", failing.line2);
      t.expect(failing.inside, 'its time inside the row');
      t.expectEqual(await page.evaluate(`[...${prRow(PRS.conflicts)}.querySelectorAll('.badge')].map((b) => b.textContent)`), ['Conflicts', 'Changes requested'], "#612's badges");
      t.expectEqual(await page.evaluate(`[...${prRow(PRS.draft)}.querySelectorAll('.badge')].map((b) => b.textContent)`), ['Draft', 'Checks pending'], "#605's badges");
      await t.shot('list');
    });

    await t.step('a heading collapses, with its counts in sight, and stays collapsed through a reload, by a hash of its name', async () => {
      await page.click('the hookdeck/outpost heading', repoToggle('hookdeck/outpost'));
      t.expectEqual(await page.evaluate(`${repoToggle('hookdeck/outpost')}.getAttribute('aria-expanded')`), 'false', 'collapsed');
      t.expectEqual(await page.evaluate(prRows), [PRS.failing, PRS.approved, PRS.quiet], 'its rows hidden');
      t.expect((await page.evaluate<string>(`${repoToggle('hookdeck/outpost')}.textContent`)).includes('1 needs attention'), 'its badge still there');
      const stored = await page.evaluate<string>(`localStorage.getItem(${q(STORE)}) ?? ''`);
      t.expect(/^\{"v":1,"collapsed":\["[0-9a-f]{16}"\]\}$/.test(stored) && !stored.includes('outpost'), 'kept as a hash, never the name', stored);
      await t.shot('collapsed');
      await page.reload();
      await page.waitFor('the list after the reload', `${prRows}.length > 0`);
      t.expectEqual(await page.evaluate(`${repoToggle('hookdeck/outpost')}.getAttribute('aria-expanded')`), 'false', 'still collapsed');
      await page.click('the heading again', repoToggle('hookdeck/outpost'));
      t.expectEqual(await page.evaluate(prRows), [PRS.failing, PRS.approved, PRS.conflicts, PRS.draft, PRS.quiet], 'expanded again');
    });

    await t.step('Show older lists the PRs updated more than 90 days ago, and keeps focus as Hide older', async () => {
      const show = button(LIST, 'Show 2 older pull requests');
      await page.click('Show 2 older pull requests', show);
      await page.waitFor('the older PRs', `${prRows}.includes(${q(PRS.older)})`);
      t.expect((await page.evaluate<string[]>(prRows)).includes(PRS.olderFailing), 'both of them');
      t.expectEqual(await page.evaluate(summary), '7 open3 need attention', 'counted while shown');
      t.expectEqual(await page.evaluate(focused), 'Hide older pull requests', 'focus on the same button');
      await t.shot('older');
      await page.click('Hide older pull requests', button(LIST, 'Hide older pull requests'));
      await page.waitFor('the older PRs to go', `!${prRows}.includes(${q(PRS.older)})`);
    });

    await t.step('the filter finds a PR by its number and its branch, and says when nothing matches', async () => {
      await page.click('the filter field', FIELD);
      await page.type('#612');
      await page.waitFor('one row', `${prRows}.length === 1`);
      t.expectEqual(await page.evaluate(prRows), [PRS.conflicts], 'by its number');
      t.expectEqual(await page.evaluate(`${prRow(PRS.conflicts)}.querySelector('mark')?.textContent`), '#612', 'highlighted');
      await page.key('Escape');
      await page.type('api-server-19');
      await page.waitFor('one row', `${prRows}.length === 1`);
      t.expectEqual(await page.evaluate(prRows), [PRS.quiet], 'by its branch');
      await page.key('Escape');
      await page.type('nothing like it');
      await page.waitFor('the empty state', `${emptyTitle} === 'No pull requests match'`);
      await t.shot('no-match');
      await page.click('Clear filter', button(LIST, 'Clear filter'));
      await page.waitFor('every row', `${prRows}.length === 5`);
      t.expectEqual(await page.evaluate('document.activeElement?.type'), 'search', 'focus in the field');
    });

    await t.step("a PR opens in the session view's place: its details, its sessions, Open on GitHub and Copy link", async () => {
      await page.click('#51', prTitle(PRS.failing));
      await page.waitFor('its view', `${prViewTitle} === 'Add a made-up health route'`);
      t.expectEqual(await page.evaluate('location.search'), `?view=prs&pr=${PRS.failing}`, 'the URL');
      t.expectEqual(await page.evaluate(`${prRow(PRS.failing)}.classList.contains('open')`), true, 'its row marked open');
      t.expectEqual(await page.evaluate(focused), 'the view heading', 'focus on its heading');
      const view = await page.evaluate<{ details: Record<string, string>; sessions: string[]; mentioned: string[]; link: { href: string; target: string; rel: string } | null; copy: boolean; back: string | null }>(`(() => {
        const view = ${PR_VIEW};
        const sections = [...view.querySelectorAll('.pr-view-section')];
        const names = (title) => [...(sections.find((s) => s.querySelector('h3').textContent === title)?.querySelectorAll('.pr-view-session-open') ?? [])].map((b) => b.textContent);
        const a = view.querySelector('a.pr-view-github');
        return {
          details: Object.fromEntries([...view.querySelectorAll('.pr-view-detail')].map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent])),
          sessions: names('Sessions'),
          mentioned: names('Mentioned in'),
          link: a ? { href: a.getAttribute('href'), target: a.target, rel: a.rel } : null,
          copy: !!view.querySelector('button[aria-label="Copy link"]'),
          back: view.querySelector('.session-view-back')?.textContent ?? null,
        };
      })()`);
      t.expectEqual(view.details.Checks, 'Failingtest (22.x)linte2e (chrome)+2 more', 'the failing checks, and how many more');
      t.expectEqual(view.details.Review, 'Review required', 'the review');
      t.expectEqual(view.sessions, [NAMES.conversation], 'the session that opened it');
      t.expectEqual(view.mentioned, [NAMES.waiting], 'and the one that named it');
      t.expectEqual(view.link, { href: 'https://github.com/example/demo-app/pull/51', target: '_blank', rel: 'noopener noreferrer' }, 'Open on GitHub');
      t.expect(view.copy, 'Copy link');
      t.expectEqual(view.back, t.compact ? 'Back to pull requests' : null, 'Back at 600 px and narrower');
      await t.shot('view');
    });

    await t.step("Open on GitHub leaves for the PR's own page, in a new tab with no opener or referrer", async () => {
      await page.click('Open on GitHub', `${PR_VIEW}.querySelector('a.pr-view-github')`);
      t.expectEqual((await records()).clicks.at(-1), { href: 'https://github.com/example/demo-app/pull/51', target: '_blank', rel: 'noopener noreferrer', prevented: false }, 'pitwall let it open');
    });

    await t.step("a session from the PR view opens in its place, and its header links back to the PR, with the back button", async () => {
      await page.click(NAMES.conversation, `${PR_VIEW}.querySelector(${q(`[data-open-linked-session="${server.world.byName(NAMES.conversation).sessionId}"]`)})`);
      await page.waitFor('its view', `${sessionViewName} === ${q(NAMES.conversation)}`);
      t.expect(!(await page.evaluate<boolean>(`!!${PR_VIEW}`)), 'in the PR view’s place');
      t.expectEqual(await page.evaluate('location.search'), `?view=prs&session=${server.world.byName(NAMES.conversation).sessionId}`, 'the URL');
      t.expectEqual(await page.evaluate(`${SESSION_VIEW}.querySelector('.session-view-back')?.textContent ?? null`), t.compact ? 'Back to pull requests' : null, 'Back over the PR list');
      t.expectEqual(await page.evaluate(`[...${SESSION_VIEW}.querySelectorAll('[data-pr-link]')].map((b) => b.getAttribute('aria-label'))`), ['Pull request example/demo-app #51'], 'its PR link');
      await t.shot('session-links');
      await page.click('#51', `${SESSION_VIEW}.querySelector(${q(`[data-pr-link="${PRS.failing}"]`)})`);
      await page.waitFor('the PR view', `${prViewTitle} === 'Add a made-up health route'`);
      await page.evaluate('history.back()');
      await page.waitFor('the session view again', `${sessionViewName} === ${q(NAMES.conversation)}`);
      await page.evaluate('history.back()');
      await page.waitFor('the PR view again', `${prViewTitle} === 'Add a made-up health route'`);
      await closeView();
    });

    await t.step('the session rows have badges for their most urgent strongly linked open PR, those that need attention in danger', async () => {
      await chooseInRepoList(t, 'All sessions');
      const badge = (name: string) => `(() => { const b = ${row(name)}?.closest('li').querySelector('.pr-badge'); return b ? { text: b.textContent, danger: b.classList.contains('badge-subtle-danger') } : null; })()`;
      t.expectEqual(await page.evaluate(badge(NAMES.asked)), { text: 'Pull request #612, needs attention+1, and 1 more', danger: true }, `${NAMES.asked}'s: #612, and one more`);
      t.expectEqual(await page.evaluate(badge(NAMES.running)), { text: 'Pull request #48', danger: false }, `${NAMES.running}'s, neutral`);
      t.expectEqual(await page.evaluate(badge(NAMES.waiting)), null, `${NAMES.waiting} only named one, so none`);
      await t.shot('session-badges');
    });

    await t.step('Refresh fetches once, with its spinner, then is off for 15 seconds', async () => {
      await chooseInRepoList(t, 'Pull requests');
      await page.waitFor('the rows', `${prRows}.length > 0`);
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

    await t.step('a refresh within 15 seconds of the last fetch gets an info toast with when, not an error', async () => {
      // A reload forgets the page's own 15 s; the server's are still running.
      await page.reload();
      await page.waitFor('the list after the reload', `${prRows}.length > 0`);
      t.allow(/\/api\/prs\/refresh/, 'the 429 the step brings about');
      await page.click('Refresh', REFRESH);
      await page.waitFor('the toast', `${toasts}.some((text) => /^pitwall fetched your pull requests moments ago\\. Refresh again in \\d+ seconds?\\.$/.test(text))`);
      t.expect(await page.evaluate<boolean>(`!!document.querySelector('.toasts .toast.info')`), 'an info toast');
      t.expectEqual(server.records.refreshes, [200, 429], 'the 429');
      t.expectEqual(await page.evaluate(`${REFRESH}.getAttribute('aria-disabled')`), 'true', 'off until then');
    });

    await t.step('each source state says what it is and how to fix it, and an ok fetch brings the list back', async () => {
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
      t.expectEqual((await page.evaluate<string[]>(prRows)).length, 5, 'the last list kept');
      await t.shot('stale');
      await switchTo('off', 'off', `${emptyTitle} === 'Pull requests are off'`);
      await openRepoList(t);
      t.expect(!(await page.evaluate<string[]>(repoLabels)).includes('Pull requests'), 'no item in the repo list');
      if (t.layout === 'drawer') {
        await page.key('Escape');
        await page.waitFor('the drawer to close', `!document.querySelector('.repo-drawer')`);
      }
      await t.shot('off');
      await switchTo('ok', 'the list', `${prRows}.length === 5`);
    });

    await t.step("a ?pr= link opens that PR's view as the page loads, and one that isn't open says so", async () => {
      await t.fresh({ search: `?view=prs&pr=${PRS.conflicts}`, ready: `!!${PR_VIEW}?.querySelector('h2 bdi')` });
      t.expectEqual(await page.evaluate(prViewTitle), 'Retry made-up deliveries with backoff', 'its view');
      t.expectEqual(await page.evaluate(`${PR_VIEW}.querySelector('.pr-view-detail:nth-child(3) dd')?.textContent`), 'Conflicts with its base branch', 'its conflicts');
      await t.fresh({ search: '?view=prs&pr=example/demo-app/999', ready: `!!${PR_VIEW}?.querySelector('.empty-state')` });
      t.expectEqual(await page.evaluate(`${PR_VIEW}.querySelector('h2')?.textContent`), "This pull request isn't listed", 'says so');
      await t.shot('unlisted');
    });

    await t.step('j and k step through the PR list, and show each PR once its view is open', async () => {
      await freshList();
      await page.key('j');
      t.expectEqual(await page.evaluate('document.activeElement?.dataset.openPr ?? null'), PRS.failing, 'j: the first row');
      await page.key('j');
      t.expectEqual(await page.evaluate('document.activeElement?.dataset.openPr ?? null'), PRS.approved, 'j: the next');
      await page.key('Enter');
      await page.waitFor('its view', `${prViewTitle} === 'Tidy the made-up export job'`);
      await page.key('j');
      await page.waitFor('the next PR', `${prViewTitle} === 'Retry made-up deliveries with backoff'`);
      t.expectEqual(await page.evaluate('location.search'), `?view=prs&pr=${PRS.conflicts}`, 'replacing the URL');
      await page.key('k');
      await page.waitFor('the one before', `${prViewTitle} === 'Tidy the made-up export job'`);
    });
  },
};

export default part;
