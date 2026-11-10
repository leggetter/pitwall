// The Usage view (W158, docs/design-system.md, 4: Usage): from the header's Usage button, a dialog
// with `?usage` in the URL; the plan's week and the totals, cache reads and writes apart; the tables,
// each scrolling sideways on its own so the page never does; the window's tabs; Escape closing it
// with focus back on the button; and, from the URL, the plan's week unavailable, and a failed read.
// Made-up figures from the fake server (fixtures.ts, World.usage()).

import type { Part } from '../runner.js';
import { DIALOG, dialogBox, dialogName, focused, headerButton, openDialog } from './_dom.js';

const q = JSON.stringify;
/** A table's region in the dialog, by its heading. */
const region = (title: string) => `[...(${DIALOG}?.querySelectorAll('.usage-table-wrap') ?? [])].find((r) => document.getElementById(r.getAttribute('aria-labelledby'))?.textContent === ${q(title)})`;
const headers = (title: string) => `[...(${region(title)}?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent)`;
const bodyRows = (title: string) => `[...(${region(title)}?.querySelectorAll('tbody tr') ?? [])]`;
const tab = (label: string) => `[...(${DIALOG}?.querySelectorAll('[role="tab"]') ?? [])].find((t) => t.textContent === ${q(label)})`;
const openTab = `${DIALOG}?.querySelector('[role="tab"][aria-selected="true"]')?.textContent`;
const text = `${DIALOG}?.textContent ?? ''`;
/** Nothing in the page is wider than the window: each table scrolls in its own box instead. */
const pageFits = `document.documentElement.scrollWidth <= window.innerWidth`;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

const part: Part = {
  name: 'usage',
  title: "The Usage view: from the header as ?usage, the plan's week, cache reads and writes apart, its tables and tabs, Escape, and the plan unavailable or a failed read",
  async run(t) {
    const { page } = t;

    await t.step('opens from the header as ?usage, on This week, with the plan’s week and the totals', async () => {
      await t.fresh({ search: '?view=all' });
      await openDialog(t, 'Usage');
      t.expectEqual(await page.evaluate(`location.search`), '?view=all&usage', '?usage added to the URL');
      await page.waitFor('the figures', `${text}.includes('63% used')`);
      t.expectEqual(await page.evaluate(openTab), 'This week', 'This week is open');
      t.expectEqual(await page.evaluate(focused), 'This week', 'focus on the open tab');
      const card = await page.evaluate<Box>(dialogBox);
      t.expect(card.left >= 15.5 && card.right <= t.viewport.width - 15.5, 'inside the window, 16 px from its sides at the least', card);
      t.expect(Math.abs(card.width - Math.min(840, t.viewport.width - 32)) < 1, 'the lg card, or the window less 32 px', card.width);
      t.expect((await page.evaluate<string>(text)).includes("Since the plan's week started"), 'the window from the reset');
      t.expect((await page.evaluate<string>(text)).includes('Est. cost: API list price, a stand-in'), 'cost labelled as an estimate');
      t.expectEqual(
        await page.evaluate(`[...${DIALOG}.querySelectorAll('.usage-stats dt')].map((dt) => dt.textContent)`),
        ['Est. cost', 'Input', 'Cache writes', 'Cache reads', 'Output', 'Calls'],
        'the totals, cache writes and reads apart',
      );
      t.expect(await page.evaluate(pageFits), 'the page is no wider than the window');
      await t.shot('week');
    });

    await t.step('each table: cost then the four kinds of token, by day with a bar, by session with names', async () => {
      t.expectEqual(await page.evaluate(headers('By day')), ['Day', 'Est. cost', 'Input', 'Cache writes', 'Cache reads', 'Output'], 'by day');
      t.expectEqual(await page.evaluate(headers('By repo')), ['Repo', 'Sessions', 'Est. cost', 'Input', 'Cache writes', 'Cache reads', 'Output'], 'by repo');
      const bars = await page.evaluate<number[]>(`${bodyRows('By day')}.map((r) => r.querySelector('.usage-bar > span')?.getBoundingClientRect().width ?? -1)`);
      t.expect(bars.length >= 4 && bars.every((w) => w >= 0) && Math.max(...bars) > 0, 'a bar on every day', bars);
      const lefts = await page.evaluate<number[]>(`${bodyRows('By day')}.map((r) => r.querySelector('.usage-bar').getBoundingClientRect().left)`);
      t.expect(Math.max(...lefts) - Math.min(...lefts) < 1, 'every bar starts at the same edge', lefts);
      const sessions = await page.evaluate<string[]>(`${bodyRows('By session')}.map((r) => r.querySelector('.usage-session-name')?.textContent)`);
      t.expectEqual(sessions, ['pitwall-test-api', 'pitwall-test-nightly-export', 'Not listed', 'pitwall-test-docs', "pitwall's own"], 'listed sessions by name, ranked by cost');
      // A table wider than its box scrolls inside it, and takes focus so the keyboard can scroll it.
      const wrap = await page.evaluate<{ scroll: number; client: number; tabIndex: number }>(`(() => { const r = ${region('By session')}; return { scroll: r.scrollWidth, client: r.clientWidth, tabIndex: r.tabIndex }; })()`);
      t.expectEqual(wrap.tabIndex, 0, 'the table’s box takes focus');
      if (t.viewport.width < 600) t.expect(wrap.scroll > wrap.client, 'in a narrow card, the session table scrolls sideways in its box', wrap);
      await page.evaluate(`${region('By session')}.scrollIntoView({ block: 'start' })`);
      await t.shot('sessions');
    });

    await t.step('30 days: a kept day says so, the rows left out are summed, and a note says what the kept days add', async () => {
      await page.click('30 days', tab('30 days'));
      await page.waitFor('30 days', `${text}.includes('(kept total)')`);
      t.expectEqual(await page.evaluate(openTab), '30 days', '30 days is open');
      t.expectEqual(await page.evaluate(`${bodyRows('By day')}.length`), 30, 'thirty days');
      t.expect((await page.evaluate<string>(`${bodyRows('By repo')}.at(-1).textContent`)).startsWith('3 more repos'), 'the rest summed');
      t.expect((await page.evaluate<string>(text)).includes('whose transcripts Claude Code has deleted'), 'the kept days’ note');
      t.expect(await page.evaluate(pageFits), 'the page is no wider than the window');
      await t.shot('30-days');
    });

    await t.step('24 hours: by hour', async () => {
      await page.click('24 hours', tab('24 hours'));
      await page.waitFor('24 hours', `${text}.includes('The last 24 hours, by hour.')`);
      t.expectEqual((await page.evaluate<string[]>(headers('By hour')))[0], 'Hour', 'by hour');
      t.expectEqual(await page.evaluate(`${bodyRows('By hour')}.length`), 24, 'twenty-four hours');
    });

    await t.step('Escape closes it, ?usage off the URL, focus back on Usage', async () => {
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expectEqual(await page.evaluate(`location.search`), '?view=all', '?usage off the URL');
      t.expect(await page.evaluate(`document.activeElement === ${headerButton('Usage')}`), 'focus is back on Usage', await page.evaluate(focused));
    });

    await t.step('from the URL, with the plan’s week unavailable: the last 7 days, and why', async () => {
      await t.fresh({ search: '?view=all&usage', usage: 'unavailable' });
      await page.waitFor('the dialog', `${dialogName} === 'Usage'`);
      await page.waitFor('the figures', `${text}.includes('Unavailable')`);
      t.expect((await page.evaluate<string>(text)).includes("the plan's week is unavailable, so it starts at midnight"), 'the window says why it starts at midnight');
      t.expectEqual(await page.evaluate(`${DIALOG}.querySelector('.usage-plan code')?.textContent`), '/usage', 'the command in code style');
      t.expectEqual(await page.evaluate(`${bodyRows('By day')}.length`), 7, 'seven days');
      await t.shot('unavailable');
    });

    await t.step('a failed read says so', async () => {
      t.allow(/\/api\/usage$/, 'the made-up failure this step asks for');
      await t.fresh({ search: '?view=all&usage', usage: 'failing' });
      await page.waitFor('the alert', `${DIALOG}?.querySelector('[role="alert"]')?.textContent === "Couldn't read your usage (HTTP 500)."`);
      await t.shot('failed');
    });
  },
};

export default part;
