// Sub-agents in the session view (W77; docs/design-system.md, 4: Sub-agents and Session rows): a
// session with none keeps its two tabs, after asking once; the row of one with some running ends line
// 2 with the count, quietly, on one line; its view's third tab, "Sub-agents (5)", lists them running
// first, then the newest started first, each with its badge, its time in the row's fixed slot, and
// "Started by" for a nested one, with no message box; a row opens the sub-agent's transcript,
// read-only, with Load earlier, and Back returns to its row; ↓ and ↑, Enter, Shift+Tab to Back; and
// a link in the conversation opens a transcript in the tab. Focus never drops to the page. And, from
// the 375 px case, a 320 px window with a long count, where the tab row scrolls rather than the page.

import { NAMES, SUBAGENTS } from '../fixtures.js';
import type { Part } from '../runner.js';
import { focused, openFromRow, row, VIEW, viewClose, viewName, viewTab, viewTabButton } from './_dom.js';

const q = JSON.stringify;
const TABS = `[...${VIEW}.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.replace(', attached', '').trim())`;
const PANEL = `${VIEW}?.querySelector('.session-view-subagents:not([hidden])')`;
const ROWS = `[...(${PANEL}?.querySelectorAll('li.subagent') ?? [])]`;
const rowButton = (description: string) => `${ROWS}.map((li) => li.querySelector('.subagent-open')).find((b) => b.textContent === ${q(description)})`;
const TRANSCRIPT = `${PANEL}?.querySelector('.subagent-transcript')`;
const BACK = `${TRANSCRIPT}?.querySelector('.subagent-back')`;
const ON_PAGE = `(document.activeElement === null || document.activeElement === document.body)`;
/** The focused element is the row button for `description`. */
const onRow = (description: string) => `document.activeElement?.matches('.subagent-open') && document.activeElement.textContent === ${q(description)}`;
/** Who the transcript's first 'user' entry is from, without its time. */
const TASK_FROM = `${TRANSCRIPT}?.querySelector('li.entry-user .entry-speaker')?.textContent.replace(/ · .*$/, '')`;
const onHeading = (description: string) => `document.activeElement?.matches('.subagent-title') && document.activeElement.textContent === ${q(description)}`;

/** The order the tab shows them in: running ones first, the newest started first. */
const ORDER = [SUBAGENTS.checking, SUBAGENTS.reading, SUBAGENTS.drafting, SUBAGENTS.failed, SUBAGENTS.stopped].map((each) => each.description);

const part: Part = {
  name: 'sub-agents',
  title: "Sub-agents: the row's running count, the session view's Sub-agents tab, a sub-agent's transcript, Back, the keys, and the conversation's links",
  async run(t) {
    const { page, server } = t;
    const id = (name: string) => server.world.byName(name).sessionId;
    const asked = (name: string) => server.records.requests.filter((request) => request === `GET /api/sessions/${encodeURIComponent(id(name))}/subagents 200`).length;
    const noPage = async (what: string) => t.expect(!(await page.evaluate<boolean>(ON_PAGE)), `focus isn't on the page ${what}`, await page.evaluate(focused));

    await t.step('a session with none keeps its two tabs, after asking once', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.conversation);
      await page.waitFor('the conversation', `${VIEW}.querySelectorAll('ol.conversation > li.entry').length > 0`);
      // After its conversation's first page; and then a moment, for any second request to show.
      for (let i = 0; i < 50 && asked(NAMES.conversation) === 0; i++) await page.settle(100);
      await page.settle(300);
      t.expectEqual(asked(NAMES.conversation), 1, 'its sub-agents were asked for once');
      t.expectEqual(await page.evaluate(TABS), ['Conversation', 'Terminal'], 'no Sub-agents tab');
      await page.click('Close', viewClose);
      await page.waitFor('the view to close', `!${viewName}`);
    });

    await t.step("the row of a session with some running ends line 2 with the count, quietly, on one line", async () => {
      const line = await page.evaluate<{ text: string; count: string; lines: number; whole: boolean; colour: boolean } | undefined>(`(() => {
        const li = ${row(NAMES.inApi)}?.closest('li.session');
        const what = li?.querySelector('.session-what'), count = li?.querySelector('.session-running');
        if (!what || !count) return undefined;
        const group = what.querySelector('.session-group');
        return {
          text: what.textContent,
          count: count.textContent,
          lines: Math.round(what.getBoundingClientRect().height / parseFloat(getComputedStyle(what).lineHeight)),
          whole: count.scrollWidth <= count.clientWidth + 1 && count.getBoundingClientRect().right <= what.getBoundingClientRect().right + 1,
          colour: getComputedStyle(count).color === getComputedStyle(group).color,
        };
      })()`);
      t.expect(line !== undefined, 'the row has line 2 and the count', line);
      t.expectEqual(line?.count, ' · 2 sub-agents running', 'the count, after a ·');
      t.expect(line?.text.startsWith('api-server · ') === true, 'after the group label and what it was last asked', line?.text);
      t.expectEqual(line?.lines, 1, 'line 2 stays one line');
      t.expect(line?.whole === true, 'the count is whole, never cut', line);
      t.expect(line?.colour === true, "in the group label's quiet colour", line);
      t.expect(await page.evaluate(`!${row(NAMES.conversation)}?.closest('li.session').querySelector('.session-running')`), 'nothing on the row of a session with none running');
      await t.shot('row');
    });

    await t.step('its view has a third tab, Sub-agents (5), listing them running first, then the newest started first', async () => {
      await openFromRow(t, NAMES.inApi);
      await page.waitFor('the Sub-agents tab with its count', `${TABS}.at(-1) === 'Sub-agents (5)'`);
      t.expectEqual(await page.evaluate(TABS), ['Conversation', 'Terminal', 'Sub-agents (5)'], 'the third tab');
      const fits = await page.evaluate<{ tabs: number; room: number }>(`(() => { const list = ${VIEW}.querySelector('[role="tablist"]'); const last = [...list.querySelectorAll('[role="tab"]')].at(-1); return { tabs: Math.round(last.getBoundingClientRect().right), room: Math.round(list.getBoundingClientRect().right) }; })()`);
      t.expect(fits.tabs <= fits.room, 'the three tabs fit on their row', fits);
      await page.click('Sub-agents (5)', viewTabButton('Sub-agents (5)'));
      await page.waitFor('the rows', `${ROWS}.length === 5`);
      t.expectEqual(await page.evaluate(viewTab), 'Sub-agents (5)', 'the tab is open');
      t.expectEqual(await page.evaluate(`${ROWS}.map((li) => li.querySelector('.subagent-open').textContent)`), ORDER, 'running first, then the newest started first');
      t.expectEqual(await page.evaluate(`${ROWS}.map((li) => li.querySelector('.badge')?.textContent ?? '')`), ['Running', 'Running', 'Done', 'Failed', 'Stopped'], 'each state badge');
      t.expectEqual(
        await page.evaluate(`${ROWS}.map((li) => li.querySelector('.subagent-parent')?.textContent ?? '')`),
        [`Started by ${SUBAGENTS.reading.description}`, '', '', '', ''],
        'the nested one says what started it',
      );
      const slots = await page.evaluate<Array<{ right: number; width: number; min: number; line: number }>>(`${ROWS}.map((li) => { const time = li.querySelector('.subagent-line time.activity'); const r = time.getBoundingClientRect(); return { right: Math.round(r.right), width: r.width, min: parseFloat(getComputedStyle(time).minWidth), line: Math.round(li.querySelector('.subagent-line').getBoundingClientRect().height) }; })`);
      t.expect(new Set(slots.map((slot) => slot.right)).size === 1, 'each time right-aligned in the same place', slots);
      t.expect(slots.every((slot) => slot.min > 0 && slot.width >= slot.min - 0.5), 'in a fixed slot', slots);
      t.expect(slots.every((slot) => slot.line <= 24), "each row's line 1 stays one line", slots);
      t.expect(await page.evaluate(`[...${VIEW}.querySelectorAll('.session-view-foot')].every((foot) => foot.hidden)`), 'no message box while the tab is open');
      t.expectEqual(await page.evaluate(focused), 'Sub-agents (5)', 'focus on the tab');
      await t.shot('list');
    });

    await t.step("a row opens the sub-agent's transcript, read-only, with Load earlier; Back returns to its row", async () => {
      await page.click(SUBAGENTS.drafting.description, rowButton(SUBAGENTS.drafting.description));
      await page.waitFor('its transcript', `!!${TRANSCRIPT}?.querySelector('ol.conversation > li.entry')`);
      t.expect(await page.evaluate(onHeading(SUBAGENTS.drafting.description)), 'its heading has focus', await page.evaluate(focused));
      t.expectEqual(await page.evaluate(`${TRANSCRIPT}.querySelector('.badge')?.textContent`), 'Done', 'its state');
      t.expect(await page.evaluate(`![...${VIEW}.querySelectorAll('textarea')].some((field) => field.offsetParent !== null)`), 'no message box');
      await page.click('Load earlier', `${TRANSCRIPT}.querySelector('.load-earlier')`);
      await page.waitFor('the older page', `[...${TRANSCRIPT}.querySelectorAll('li.entry-user .entry-text')].some((p) => p.textContent.startsWith('The made-up task'))`);
      t.expectEqual(await page.evaluate(TASK_FROM), 'From the session', 'its task is from the session, not you');
      await t.shot('transcript');
      await page.click('Back to sub-agents', BACK);
      await page.waitFor('the list', `${ROWS}.length === 5`);
      t.expect(await page.evaluate(onRow(SUBAGENTS.drafting.description)), 'focus on its row', await page.evaluate(focused));
    });

    await t.step('↓ and ↑ move between rows, Enter opens one, Shift+Tab reaches Back, and Enter there returns to its row', async () => {
      await page.key('ArrowUp');
      t.expect(await page.evaluate(onRow(SUBAGENTS.reading.description)), '↑ moves to the row above', await page.evaluate(focused));
      await page.key('ArrowDown');
      await page.key('ArrowUp');
      await page.key('Enter');
      await page.waitFor('its transcript', `${TRANSCRIPT}?.querySelector('.subagent-title')?.textContent === ${q(SUBAGENTS.reading.description)}`);
      t.expect(await page.evaluate(onHeading(SUBAGENTS.reading.description)), 'Enter opens it, with focus on its heading', await page.evaluate(focused));
      // Its own Agent call links to the sub-agent it started, whose task is from it.
      await page.click(SUBAGENTS.checking.description, `${TRANSCRIPT}.querySelector('li.entry-tool .subagent-link')`);
      await page.waitFor('the nested one', `${TRANSCRIPT}?.querySelector('.subagent-title')?.textContent === ${q(SUBAGENTS.checking.description)}`);
      t.expect(await page.evaluate(onHeading(SUBAGENTS.checking.description)), 'its heading has focus', await page.evaluate(focused));
      t.expectEqual(await page.evaluate(TASK_FROM), `From sub-agent: ${SUBAGENTS.reading.description}`, 'its task is from the sub-agent that started it');
      await page.click('Back to sub-agents', BACK);
      await page.waitFor('the list', `${ROWS}.length === 5`);
      t.expect(await page.evaluate(onRow(SUBAGENTS.checking.description)), 'Back returns to the nested one’s row', await page.evaluate(focused));
      await page.key('ArrowDown');
      await page.key('Enter');
      await page.waitFor('its transcript again', `${TRANSCRIPT}?.querySelector('.subagent-title')?.textContent === ${q(SUBAGENTS.reading.description)}`);
      await page.key('Tab', { shift: true });
      t.expectEqual(await page.evaluate(focused), 'Back to sub-agents', 'Shift+Tab reaches Back');
      await page.key('Enter');
      await page.waitFor('the list', `${ROWS}.length === 5`);
      t.expect(await page.evaluate(onRow(SUBAGENTS.reading.description)), 'Back returns to its row', await page.evaluate(focused));
      await noPage('after Back');
    });

    await t.step('the conversation names them, and a link opens a transcript in the Sub-agents tab', async () => {
      await page.click('Conversation', viewTabButton('Conversation'));
      await page.waitFor('the conversation', `${viewTab} === 'Conversation'`);
      const named = await page.evaluate<{ speaker: string; tool: string }>(`({
        speaker: ${VIEW}.querySelector('li.entry-cross-session .entry-speaker').childNodes[0].textContent + ${VIEW}.querySelector('li.entry-cross-session .entry-speaker .subagent-link').textContent,
        tool: ${VIEW}.querySelector('li.entry-tool .tool-call-text').textContent,
      })`);
      t.expectEqual(named, { speaker: `From sub-agent: ${SUBAGENTS.drafting.description}`, tool: `Agent: ${SUBAGENTS.drafting.description}` }, 'the report and the call, by description');
      await page.click('the report’s link', `${VIEW}.querySelector('li.entry-cross-session .subagent-link')`);
      await page.waitFor('its transcript in the tab', `${viewTab} === 'Sub-agents (5)' && ${TRANSCRIPT}?.querySelector('.subagent-title')?.textContent === ${q(SUBAGENTS.drafting.description)}`);
      t.expect(await page.evaluate(onHeading(SUBAGENTS.drafting.description)), 'its heading has focus', await page.evaluate(focused));
      await t.shot('from-link');
      await page.click('Back to sub-agents', BACK);
      await page.waitFor('the list', `${ROWS}.length === 5`);
      t.expect(await page.evaluate(onRow(SUBAGENTS.drafting.description)), 'Back returns to its row', await page.evaluate(focused));
    });

    // Once per theme, from the 375 px case: a window 320 px wide, the narrowest the design system
    // supports (6.1, rule 12), with a count long enough that the three tabs don't fit.
    if (t.viewport.name !== '375') return;
    await t.step('at 320 px, with a long count, the tab row scrolls rather than the page, keeping the tab you move to in view', async () => {
      await t.fresh({ search: '?view=all' });
      server.world.manySubagents();
      await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
      await page.waitFor('the 320 px window', `window.innerWidth === 320`);
      await openFromRow(t, NAMES.inApi);
      await page.waitFor('the long count', `${TABS}.at(-1) === 'Sub-agents (200+)'`);
      const ROW = `${VIEW}.querySelector('[role="tablist"]')`;
      const row = await page.evaluate<{ overflow: string; scrolls: boolean; icons: number; page: boolean }>(`(() => {
        const list = ${ROW};
        return {
          overflow: getComputedStyle(list).overflowX,
          scrolls: list.scrollWidth > list.clientWidth,
          icons: [...list.querySelectorAll('[role="tab"] > svg')].filter((svg) => getComputedStyle(svg).display !== 'none').length,
          page: document.documentElement.scrollWidth <= window.innerWidth,
        };
      })()`);
      t.expectEqual(row.overflow, 'auto', 'the row can scroll sideways');
      t.expect(row.scrolls, 'and does, with three tabs and a long count', row);
      t.expectEqual(row.icons, 0, 'the tabs have dropped their icons');
      t.expect(row.page, "the page doesn't scroll sideways", row);
      await page.evaluate(`${viewTabButton('Conversation')}.focus()`);
      await page.key('ArrowLeft');
      t.expectEqual(await page.evaluate(focused), 'Sub-agents (200+)', '← wraps to the last tab');
      const inView = await page.evaluate<{ tab: [number, number]; row: [number, number] }>(`(() => { const tab = ${viewTabButton('Sub-agents (200+)')}.getBoundingClientRect(), row = ${ROW}.getBoundingClientRect(); return { tab: [Math.round(tab.left), Math.round(tab.right)], row: [Math.round(row.left), Math.round(row.right)] }; })()`);
      t.expect(inView.tab[0] >= inView.row[0] && inView.tab[1] <= inView.row[1], 'scrolled into view in its row', inView);
      await page.key('Enter');
      await page.waitFor('the rows', `${ROWS}.length === 200`);
      t.expectEqual(await page.evaluate(`${PANEL}.querySelector('.subagents-truncated')?.textContent`), 'This session has more than 200 sub-agents, so the oldest are left out.', 'the note that the oldest are left out');
      await t.shot('320');
    });
  },
};

export default part;
