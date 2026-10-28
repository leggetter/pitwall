// The lists (docs/design-system.md, 3: Repo list, Root tabs, Session list; 4: Session rows): the repo
// list's Needs you, All sessions and Starred, then its groups; two-line rows; the session list's
// filter, chips and sort, and a filter bar that turning a filter on or off never moves (W75); and,
// with two roots, a tab per root.

import { API_SERVER, CODE, DEMO_APP, NAMES, OSS } from '../fixtures.js';
import type { Part } from '../runner.js';
import { chooseInRepoList, chooseOption, listHeading, openRepoList, repoItem, repoLabels, row, rowNames, selectedRepo } from './_dom.js';

const q = JSON.stringify;
const FIELD = `document.querySelector('.session-list input.filter-input')`;
const SUMMARY = `document.querySelector('.session-list .summary-count')?.textContent`;
const chip = (label: string) => `[...document.querySelectorAll('.session-list .filter-chips .chip')].find((b) => b.textContent.trim() === ${q(label)})`;
const SORT = `document.querySelector('.session-list .sort select')`;
const star = (name: string) => `document.querySelector(${q(`.session-list button.star-toggle[aria-label="Star ${name}"]`)})`;
const BACKGROUND = [NAMES.prompting, NAMES.running, NAMES.running2, NAMES.running3];
/**
 * For each window, a group name that just fits beside the summary on line 1, so that before W75,
 * "7 sessions" becoming "4 of 7 sessions" as a filter went on wrapped the line and moved everything
 * below it. Each sits about mid-way in the widths that did, measured in the window's font.
 */
const EDGE_LABELS: Readonly<Record<string, string>> = {
  '375': 'demo-app-js',
  '375x540': 'demo-app-js',
  '900': 'demo-app-customer-portal-and-admin-consoles',
  '1200': 'demo-apps',
  '1440': 'demo-app-storefront',
};
const CLEAR_FILTERS = `[...document.querySelectorAll('.session-list .filter-chips button')].find((b) => b.textContent.trim() === 'Clear filters')`;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
type Boxes = Record<string, Box | null>;

/**
 * The session list header's boxes, in the window, by name: line 1 and the summary's count, the bar
 * (its role="search" form), the field, each chip by its label, Clear filters, and Sort, then the rows'
 * box under them. Clear filters is the button while a filter is on, and the room kept for it while
 * none is, under the same name, so the two are measured against each other.
 */
const headBoxes = `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
  const list = document.querySelector('.session-list');
  const bar = list?.querySelector('form[role="search"]');
  const boxes = { 'line 1': box(list?.querySelector('.session-list-title-row')), 'the count': box(list?.querySelector('.summary-count')), 'the bar': box(bar), 'the field': box(bar?.querySelector('.filter-field')) };
  for (const chip of bar?.querySelectorAll('.filter-chips .chip') ?? []) boxes[chip.textContent.trim()] = box(chip);
  boxes['Clear filters'] = box(${CLEAR_FILTERS} ?? bar?.querySelector('.filter-clear-room'));
  boxes.Sort = box(bar?.querySelector('.sort'));
  boxes['the rows'] = box(list?.querySelector('.session-list-body'));
  return boxes;
})()`;

/** What moved more than 0.5 px from `before` to `after`: each box's edge or size, in words. */
function moved(before: Boxes, after: Boxes): string[] {
  const out: string[] = [];
  for (const [name, was] of Object.entries(before)) {
    const now = after[name];
    if (!was || !now) {
      out.push(`${name}: ${was ? 'gone' : 'missing before'}`);
      continue;
    }
    for (const side of ['left', 'top', 'width', 'height'] as const) {
      const by = now[side] - was[side];
      if (Math.abs(by) > 0.5) out.push(`${name}: ${side} ${was[side].toFixed(1)} to ${now[side].toFixed(1)}`);
    }
  }
  return out;
}

const part: Part = {
  name: 'lists',
  title: 'The repo list (Needs you, All sessions, Starred, groups), root tabs, two-line rows, the filter and sort, and a filter bar that filtering never moves',
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

    await t.step("a row's time has a fixed slot, right-aligned, so the badges beside it line up whatever the time's width", async () => {
      await chooseInRepoList(t, 'All sessions');
      // Each shown row with a status badge: its badge's right edge, its time's text and the box of its slot and its text.
      const rows = await page.evaluate<Array<{ name: string; time: string; badgeRight: number; slotLeft: number; slotRight: number; slotWidth: number; textRight: number; textWidth: number }>>(`[...document.querySelectorAll('.session-list .sessions > li.session')].filter((li) => !li.closest('[hidden]') && li.querySelector('.session-line .badge[data-status]') && li.querySelector('time.activity')).map((li) => {
        const badge = li.querySelector('.session-line .badge[data-status]').getBoundingClientRect();
        const time = li.querySelector('time.activity');
        const slot = time.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(time);
        const text = range.getBoundingClientRect();
        return { name: li.querySelector('.session-name').textContent.trim(), time: time.textContent, badgeRight: Math.round(badge.right), slotLeft: Math.round(slot.left), slotRight: Math.round(slot.right), slotWidth: Math.round(slot.width), textRight: Math.round(text.right), textWidth: Math.round(text.width) };
      })`);
      t.expect(rows.length >= 4, 'rows with a badge and a time', rows);
      const widths = new Set(rows.map((each) => each.textWidth));
      t.expect(widths.size >= 2, 'times of different widths, such as "3m ago" and "12m ago"', rows.map(({ time, textWidth }) => ({ time, textWidth })));
      t.expectEqual([...new Set(rows.map((each) => each.badgeRight))].length, 1, "every badge's right edge at the same x");
      t.expectEqual([...new Set(rows.map((each) => each.slotWidth))].length, 1, 'every time in a slot of the same width');
      const unaligned = rows.filter((each) => Math.abs(each.textRight - each.slotRight) > 1);
      t.expect(unaligned.length === 0, 'each time right-aligned in its slot', unaligned);
      const header = await page.evaluate<{ width: number; min: number; textRight: number; right: number } | null>(`(() => {
        const el = document.querySelector('header time.updated');
        if (!el) return null;
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        return { width: Math.round(box.width), min: Math.round(parseFloat(getComputedStyle(el).minWidth)), textRight: Math.round(range.getBoundingClientRect().right), right: Math.round(box.right) };
      })()`);
      t.expect(header !== null && header.width === header.min && Math.abs(header.textRight - header.right) <= 1, 'the header\'s "updated" time in its own fixed slot, right-aligned', header);
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

    // W75: the field on a line of its own, then the chips, Clear filters and Sort, at every width, and
    // turning a filter on or off moves none of it, nor line 1 above it, nor the rows below (Phil,
    // 2026-10-27: "selecting a filter changes the alignment/rows").
    let unfiltered: Boxes = {};

    /** Turns Interactive on, adds text, then presses Clear filters, and checks at each that nothing moved from `before`. */
    const filterThenClear = async (before: Boxes, shot?: string): Promise<void> => {
      await page.click('Interactive', chip('Interactive'));
      await page.waitFor('Interactive on, and Clear filters', `${chip('Interactive')}.getAttribute('aria-pressed') === 'true' && !!${CLEAR_FILTERS}`);
      t.expectEqual(moved(before, await page.evaluate<Boxes>(headBoxes)), [], "with Interactive on, nothing moved, Clear filters in its room's place");
      if (shot) await t.shot(shot);

      await page.click('the filter field', FIELD);
      await page.type('pitwall');
      await page.waitFor("the text, and the field's clear button", `${FIELD}.value === 'pitwall' && !!document.querySelector('.session-list .filter-clear')`);
      t.expectEqual(moved(before, await page.evaluate<Boxes>(headBoxes)), [], 'with text as well, nothing moved');

      await page.click('Clear filters', CLEAR_FILTERS);
      await page.waitFor('the filters to clear', `${FIELD}.value === '' && ${chip('Interactive')}.getAttribute('aria-pressed') === 'false' && !${CLEAR_FILTERS}`);
      t.expectEqual(moved(before, await page.evaluate<Boxes>(headBoxes)), [], 'with the filters cleared, everything is where it started');
    };

    await t.step('the filter bar: the field on a line of its own, its placeholder whole, then the chips and Sort at the right', async () => {
      unfiltered = await page.evaluate<Boxes>(headBoxes);
      const { 'the bar': bar, 'the field': field, Interactive, Background, Sort } = unfiltered;
      t.expect(bar && field && Interactive && Background && Sort, 'the bar, the field, both chips and Sort', unfiltered);
      if (!bar || !field || !Interactive || !Background || !Sort) return;
      t.expect(Math.abs(field.width - bar.width) <= 0.5, "the field is the bar's whole width", { field: field.width, bar: bar.width });
      const others = { Interactive, Background, Sort };
      const beside = Object.entries(others).filter(([, box]) => box.top < field.top + field.height);
      t.expect(beside.length === 0, "nothing shares the field's line", beside);
      t.expect(Math.abs(Interactive.top - Background.top) <= 0.5 && Background.left > Interactive.left, 'the chips share the next line, in order', { Interactive, Background });
      t.expect(Math.abs(Sort.left + Sort.width - (bar.left + bar.width)) <= 0.5, "Sort ends at the bar's right edge", { Sort, bar });
      t.expect(Sort.top >= Interactive.top - 4, "Sort is on the chips' line or after it", { Sort, Interactive });
      const placeholder = await page.evaluate<{ text: number; room: number }>(`(() => {
        const input = ${FIELD};
        const style = getComputedStyle(input);
        const context = document.createElement('canvas').getContext('2d');
        context.font = style.font;
        return { text: context.measureText(input.placeholder).width, room: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
      })()`);
      t.expect(placeholder.text <= placeholder.room, 'the placeholder shows whole, with no ellipsis', placeholder);
      await t.shot('filter-bar');
    });

    await t.step('turning a chip on, then text, then Clear filters moves nothing in the header or the rows', async () => {
      await filterThenClear(unfiltered, 'filter-bar-chip-on');
    });

    await t.step('text alone, then both chips, move nothing either, and Clear filters shows in the same place', async () => {
      await page.click('the filter field', FIELD);
      await page.type('export');
      await page.waitFor('the text, and Clear filters', `${FIELD}.value === 'export' && !!${CLEAR_FILTERS}`);
      t.expectEqual(moved(unfiltered, await page.evaluate<Boxes>(headBoxes)), [], 'with text alone, nothing moved');
      await page.key('Escape');
      await page.waitFor('the text to clear', `${FIELD}.value === '' && !${CLEAR_FILTERS}`);

      await page.click('Interactive', chip('Interactive'));
      await page.click('Background', chip('Background'));
      await page.waitFor('both chips on', `${chip('Interactive')}.getAttribute('aria-pressed') === 'true' && ${chip('Background')}.getAttribute('aria-pressed') === 'true'`);
      t.expectEqual(moved(unfiltered, await page.evaluate<Boxes>(headBoxes)), [], 'with both chips on, nothing moved');
      await page.click('Interactive', chip('Interactive'));
      await page.click('Background', chip('Background'));
      await page.waitFor('both chips off', `!${CLEAR_FILTERS}`);
      t.expectEqual(moved(unfiltered, await page.evaluate<Boxes>(headBoxes)), [], 'with both off again, everything is where it started');
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

    await t.step('in forced colours, as a Windows contrast theme sets them, turning a filter on or off moves nothing either', async () => {
      await t.fresh({ search: '?view=all', forcedColors: true });
      t.expect(await page.evaluate(`matchMedia('(forced-colors: active)').matches`), 'forced colours are on');
      const before = await page.evaluate<Boxes>(headBoxes);
      await filterThenClear(before, 'filter-bar-forced-colors');
      await page.click('Interactive', chip('Interactive'));
      await page.click('Background', chip('Background'));
      await page.waitFor('both chips on', `${chip('Background')}.getAttribute('aria-pressed') === 'true' && !!${CLEAR_FILTERS}`);
      t.expectEqual(moved(before, await page.evaluate<Boxes>(headBoxes)), [], 'with both chips on, nothing moved');
    });

    await t.step("a group name that just fits beside the summary: the count keeps its filtered width, so line 1 doesn't wrap as a filter goes on", async () => {
      const label = EDGE_LABELS[t.viewport.name] ?? 'demo-app';
      await t.fresh({ search: `?repo=${DEMO_APP}`, labels: { [DEMO_APP]: label } });
      await page.waitFor('the name as the heading', `${listHeading} === ${q(label)}`);
      const before = await page.evaluate<Boxes>(headBoxes);
      const total = await page.evaluate<string>(SUMMARY);
      await page.click('Interactive', chip('Interactive'));
      await page.waitFor('the summary to count what the chip shows', `${SUMMARY} !== ${q(total)}`);
      t.expect(/^\d+ of \d+ sessions?$/.test(await page.evaluate<string>(SUMMARY)), 'the summary says what the filter hides', await page.evaluate(SUMMARY));
      t.expectEqual(moved(before, await page.evaluate<Boxes>(headBoxes)), [], 'with Interactive on, nothing moved: not line 1, the bar or the rows');
      await t.shot('long-group-chip-on');
      await page.click('Clear filters', CLEAR_FILTERS);
      await page.waitFor('the filters to clear', `!${CLEAR_FILTERS}`);
      t.expectEqual(moved(before, await page.evaluate<Boxes>(headBoxes)), [], 'with the filters cleared, everything is where it started');
    });
  },
};

export default part;
