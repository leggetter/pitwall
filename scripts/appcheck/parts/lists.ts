// The lists (docs/design-system.md, 3: Repo list, Root tabs, Session list; 4: Session rows): the repo
// list's Needs you, All sessions and Starred, then its groups; two-line rows; the session list's
// filter, chips and sort; and, with two roots, a tab per root.

import { API_SERVER, CODE, NAMES, OSS } from '../fixtures.js';
import type { Part } from '../runner.js';
import { chooseInRepoList, chooseOption, listHeading, openRepoList, repoItem, repoLabels, row, rowNames, selectedRepo } from './_dom.js';

const q = JSON.stringify;
const FIELD = `document.querySelector('.session-list input.filter-input')`;
const SUMMARY = `document.querySelector('.session-list .summary-count')?.textContent`;
const chip = (label: string) => `[...document.querySelectorAll('.session-list .filter-chips .chip')].find((b) => b.textContent.trim() === ${q(label)})`;
const SORT = `document.querySelector('.session-list .sort select')`;
const star = (name: string) => `document.querySelector(${q(`.session-list button.star-toggle[aria-label="Star ${name}"]`)})`;
const BACKGROUND = [NAMES.prompting, NAMES.running, NAMES.running2, NAMES.running3];

const part: Part = {
  name: 'lists',
  title: 'The repo list (Needs you, All sessions, Starred, groups), root tabs, two-line rows, and the filter and sort',
  async run(t) {
    const { page } = t;

    await t.step('the repo list: three views, then the groups', async () => {
      await t.fresh({ search: '?view=all' });
      await openRepoList(t);
      const labels = await page.evaluate<string[]>(repoLabels);
      t.expectEqual(labels, ['Needs you', 'All sessions', 'Starred', 'api-server', 'demo-app'], 'the items, in order');
      t.expectEqual(await page.evaluate(selectedRepo), 'All sessions', 'All sessions is selected');
      t.expectEqual(await page.evaluate(`${repoItem('Needs you')}.querySelector('.badge-attention')?.textContent`), '3 need you', "Needs you's badge");
      t.expectEqual(await page.evaluate(`${repoItem('demo-app')}.querySelector('.badge-attention')?.textContent`), '3 need you', "demo-app's badge: its sessions that need you");
      t.expectEqual(await page.evaluate(`${repoItem('api-server')}.querySelector('.repo-item-count')?.textContent`), '2 sessions', "api-server's count");
      await t.shot('repo-list');
    });

    await t.step('Needs you lists what needs you, most recently active first, whatever the reason', async () => {
      await chooseInRepoList(t, 'Needs you');
      t.expectEqual(await page.evaluate('location.search'), '?view=needs-you', 'the URL');
      const names = await page.evaluate<string[]>(rowNames);
      t.expectEqual([...names].sort(), [NAMES.prompting, NAMES.waiting, NAMES.asked].sort(), 'the sessions that need you, and no others');
      // W69: every reason ranks alike, so it's by activity: waiting 3 minutes ago, asked 6, the job 21.
      t.expectEqual(names, [NAMES.waiting, NAMES.asked, NAMES.prompting], 'by their last activity');
      t.expect(await page.evaluate(`[...document.querySelectorAll('.session-list li.session')].every((li) => li.dataset.attention === 'true')`), 'each row is marked as needing you');
    });

    await t.step('rows are two lines: name, title and status; then where and what', async () => {
      await chooseInRepoList(t, 'All sessions');
      const rows = await page.evaluate<Array<{ name: string; height: number; line1: number; line2: number; what: string }>>(`[...document.querySelectorAll('.session-list .sessions > li.session')].filter((li) => !li.closest('[hidden]')).map((li) => {
        const lineHeight = (el) => parseFloat(getComputedStyle(el).lineHeight);
        const one = li.querySelector('.session-line'), two = li.querySelector('.session-what');
        return { name: li.querySelector('.session-name').textContent.trim(), height: Math.round(li.getBoundingClientRect().height), line1: Math.round(one.getBoundingClientRect().height / lineHeight(li.querySelector('.session-name'))), line2: two ? Math.round(two.getBoundingClientRect().height / lineHeight(two)) : 0, what: two?.textContent ?? '' };
      })`);
      t.expect(rows.length === 9, 'nine unfinished sessions under ~/code', rows.length);
      const tall = rows.filter((each) => each.line1 > 1 || each.line2 !== 1);
      t.expect(tall.length === 0, 'every row is one line of name and status, and one of where and what', tall);
      const where = rows.filter((each) => !/^(demo-app|api-server) · /.test(each.what));
      t.expect(where.length === 0, "line 2 starts with the row's group in All sessions", where);
      const asked = rows.find((each) => each.name === NAMES.asked);
      t.expect(asked?.what.includes('Asked: Should I retry'), 'a session that asked shows its question on line 2', asked);
    });

    await t.step('the filter narrows the list, and Escape clears it', async () => {
      await page.click('the filter field', FIELD);
      await page.type('export');
      await page.waitFor('the filter to apply', `${rowNames}.length === 1`);
      t.expectEqual(await page.evaluate(rowNames), [NAMES.running], 'only the session whose name matches');
      t.expectEqual(await page.evaluate(SUMMARY), '1 of 18 sessions', 'the summary says what the filter hides');
      t.expect(await page.evaluate(`!!document.querySelector('.session-list .filter-clear')`), 'the field has a clear button');
      await page.key('Escape');
      await page.waitFor('the filter to clear', `${FIELD}.value === '' && ${rowNames}.length === 9`);
      t.expectEqual(await page.evaluate(SUMMARY), '18 sessions', 'the summary is whole again');
    });

    await t.step('the Background chip lists background sessions alone', async () => {
      await page.click('Background', chip('Background'));
      t.expectEqual(await page.evaluate(`${chip('Background')}.getAttribute('aria-pressed')`), 'true', 'the chip is pressed');
      await page.waitFor('the chip to apply', `${rowNames}.length === 4`);
      t.expectEqual([...(await page.evaluate<string[]>(rowNames))].sort(), [...BACKGROUND].sort(), 'the running background sessions');
      await t.shot('chip-background');
      await page.click('Background', chip('Background'));
      await page.waitFor('the chip to clear', `${rowNames}.length === 9`);
    });

    await t.step('Sort by name orders the rows by name, and is kept', async () => {
      t.expectEqual(await page.evaluate(chooseOption(SORT, 'name')), 'name', 'Name chosen');
      await page.settle(50);
      const names = await page.evaluate<string[]>(rowNames);
      t.expectEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), 'the rows are in name order');
      t.expectEqual(await page.evaluate(`localStorage.getItem('pitwall.sort.v1')`), 'name', 'stored');
      t.expectEqual(await page.evaluate(chooseOption(SORT, 'urgency')), 'urgency', 'Urgency again');
      await page.settle(50);
      t.expectEqual((await page.evaluate<string[]>(rowNames)).slice(-1), [NAMES.inApi], 'urgency puts the least recent idle session last');
    });

    await t.step('a star puts a session in Starred', async () => {
      const id = await page.evaluate<string>(`${row(NAMES.running)}.dataset.openSession`);
      await page.click(`the star on ${NAMES.running}`, star(NAMES.running));
      t.expectEqual(await page.evaluate(`${star(NAMES.running)}.getAttribute('aria-pressed')`), 'true', 'the star is pressed');
      t.expect(await page.evaluate(`(localStorage.getItem('pitwall.starred.v1') ?? '').includes(${q(id)})`), 'kept in localStorage, by id');
      t.expect(!(await page.evaluate(`location.search.includes('session=')`)), 'starring opens nothing');
      await chooseInRepoList(t, 'Starred');
      t.expectEqual(await page.evaluate('location.search'), '?view=starred', 'the URL');
      t.expectEqual(await page.evaluate(rowNames), [NAMES.running], 'Starred lists it, alone');
      await t.shot('starred');
    });

    await t.step('unstarred in Starred, it leaves at once', async () => {
      await page.click(`the star on ${NAMES.running}`, star(NAMES.running));
      await page.waitFor('the row to leave', `${rowNames}.length === 0`);
      t.expect(await page.evaluate(`!!document.querySelector('.session-list .empty-state')`), 'Starred shows its empty state');
      t.expect(await page.evaluate(`document.activeElement !== document.body`), 'focus stays in the page, not dropped', await page.evaluate(`document.activeElement?.className`));
    });

    await t.step('a group lists its own sessions', async () => {
      await chooseInRepoList(t, 'api-server');
      t.expectEqual(await page.evaluate('location.search'), `?repo=${API_SERVER}`, 'the URL names the group');
      t.expectEqual(await page.evaluate(listHeading), 'api-server', 'the heading');
      t.expectEqual([...(await page.evaluate<string[]>(rowNames))].sort(), [NAMES.fromRoot, NAMES.inApi].sort(), "its sessions, the one started in the root that worked in it most included (Main repo)");
      t.expect(await page.evaluate(`!!document.querySelector('.session-list button[aria-label="Hide from repo list"]')`), 'a group has Hide from repo list');
    });

    await t.step('two roots: a tab per root, and a badge on the one that needs you', async () => {
      await t.fresh({ search: `?view=all&root=${CODE}`, roots: 2 });
      const tabs = await page.evaluate<Array<{ label: string; selected: string | null; badge: string | null }>>(
        `[...document.querySelectorAll('header [role="tablist"][aria-label="Roots"] [role="tab"]')].map((tab) => ({ label: tab.querySelector('.root-tab-label').textContent, selected: tab.getAttribute('aria-selected'), badge: tab.querySelector('.badge-attention')?.textContent ?? null }))`,
      );
      t.expectEqual(tabs.map((each) => each.label), ['~/code', '~/oss'], 'a tab per root');
      t.expectEqual(tabs.map((each) => each.selected), ['true', 'false'], '~/code is open');
      t.expect(tabs[1]?.badge?.replace(/^, /, '') === '1 needs you', "~/oss's tab says 1 needs you", tabs[1]);
      t.expect(tabs[0]?.badge === null, 'the open tab has no badge');
      await t.shot('root-tabs');
    });

    await t.step('the other tab shows its own root', async () => {
      await page.click('the ~/oss tab', `[...document.querySelectorAll('header .root-tab')].find((tab) => tab.querySelector('.root-tab-label').textContent === '~/oss')`);
      await page.waitFor('~/oss to open', `document.querySelector('header .root-tab[aria-selected="true"] .root-tab-label')?.textContent === '~/oss'`);
      t.expect((await page.evaluate<string>('location.search')).includes(`root=${OSS}`), 'the URL names the root');
      t.expectEqual(await page.evaluate(rowNames), [NAMES.blog], "its sessions alone");
      await openRepoList(t);
      t.expectEqual(await page.evaluate(repoLabels), ['Needs you', 'All sessions', 'Starred', 'blog'], "its repo list");
      if (t.layout === 'drawer') await page.key('Escape');
    });
  },
};

export default part;
