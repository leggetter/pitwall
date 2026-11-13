// The run rate on the header's Usage button (W159, docs/design-system.md, 4: Usage): the week's figure
// in its level's tone, normal, amber and red, the five hours only when sent, Ahead of pace over the
// reserve's line, a reading's age past 10 minutes, the icon alone when it's unavailable or off, the
// header still fitting the window, and the pace beside the plan's week in the Usage view. Made-up
// readings from the fake server (fixtures.ts, World.runRate()), worked out by pitwall's runRate.ts. And
// the run rate as a chart in the Usage view's This week (W181): its states, its labels inside its box
// and apart, and none when the figures are unavailable or off, or on another window.

import type { RunRateWorldState } from '../fixtures.js';
import type { Part } from '../runner.js';
import { DIALOG } from './_dom.js';

const BUTTON = `document.querySelector('header .usage-button')`;
const name = `(() => { const b = ${BUTTON}; return b?.getAttribute('aria-label') ?? b?.textContent ?? null; })()`;
const figures = `[...(${BUTTON}?.querySelectorAll('.usage-meter-figure') ?? [])].map((f) => ({ text: f.textContent, level: f.dataset.level, look: [...f.classList].find((c) => c.startsWith('badge-subtle-')) }))`;
const ahead = `${BUTTON}?.querySelector('.usage-meter-ahead')?.textContent ?? null`;
const age = `${BUTTON}?.querySelector('.usage-meter-age')?.textContent ?? null`;
/** The page is no wider than the window, and the button is inside the header's box. */
const fits = `(() => { const b = ${BUTTON}.getBoundingClientRect(); const h = document.querySelector('header').getBoundingClientRect(); return document.documentElement.scrollWidth <= window.innerWidth && b.left >= h.left && b.right <= h.right + 0.5 && b.bottom <= h.bottom + 0.5; })()`;

interface Figure {
  text: string;
  level: string;
  look: string;
}

const part: Part = {
  name: 'run-rate',
  title: 'The run rate on the header’s Usage button: normal, amber and red, Ahead of pace, the reading’s age, unavailable and off, and the pace and its chart in the Usage view',
  async run(t) {
    const { page } = t;

    async function shown(state: RunRateWorldState): Promise<Figure[]> {
      await t.fresh({ search: '?view=all', runRate: state });
      await page.waitFor('the run rate', `${BUTTON}?.querySelector('.usage-meter-figure') !== null`);
      t.expect(await page.evaluate(fits), 'the header fits the window, the button inside it');
      return page.evaluate<Figure[]>(figures);
    }

    /** The header's height in the normal state, which no other state may change (W159's review). */
    let normalHeight = 0;
    const headerHeight = `document.querySelector('header').getBoundingClientRect().height`;
    const sameHeight = async (state: string) => {
      if (t.viewport.width <= 600) t.expectEqual(await page.evaluate(headerHeight), normalHeight, `${state}: the header keeps its height at 600 px and narrower`);
    };
    const wideShown = `[...${BUTTON}.querySelectorAll('.usage-meter-wide')].filter((e) => e.getBoundingClientRect().width > 1).length`;

    await t.step('normal: the week in neutral, under the line, so no badge', async () => {
      const [week, ...rest] = await shown('normal');
      normalHeight = await page.evaluate<number>(headerHeight);
      t.expect(/^Week \d+%$/.test(week?.text ?? ''), 'the week’s figure', week);
      t.expectEqual([week?.level, week?.look], ['normal', 'badge-subtle-neutral'], 'neutral');
      t.expectEqual(rest.length, 0, 'no five hours when none is sent');
      t.expectEqual(await page.evaluate(ahead), null, 'not ahead of pace');
      t.expectEqual(await page.evaluate(age), null, 'a fresh reading says no age');
      t.expect(((await page.evaluate<string>(name)) ?? '').startsWith('Usage: Week'), 'its name starts with Usage, then what it shows');
      await t.shot('normal');
    });

    await t.step('ahead: Ahead of pace, a subtle warning badge', async () => {
      await shown('ahead');
      t.expectEqual(await page.evaluate(ahead), 'Ahead of pace', 'the badge, in the name at any width');
      t.expect(await page.evaluate<boolean>(`${BUTTON}.querySelector('.usage-meter-ahead').classList.contains('badge-subtle-warning')`), 'in subtle warning');
      const icon = await page.evaluate<number>(`${BUTTON}.querySelector('.usage-meter-ahead-icon').getBoundingClientRect().width`);
      if (t.viewport.width <= 600) {
        t.expect(icon > 0, 'a warning icon in the week’s badge', icon);
        t.expectEqual(await page.evaluate(wideShown), 0, 'the week’s figure alone on screen');
      } else {
        t.expectEqual(icon, 0, 'no icon where the badge shows');
        t.expectEqual(await page.evaluate(wideShown), 1, 'the badge on screen');
      }
      await sameHeight('ahead');
      await t.shot('ahead');
    });

    await t.step('amber at 74%, with the five hours beside it', async () => {
      const list = await shown('amber');
      t.expectEqual(
        list.map((f) => [f.text, f.look]),
        [
          ['Week 74%', 'badge-subtle-warning'],
          ['5h 35%', 'badge-subtle-neutral'],
        ],
        'the week amber and the five hours normal',
      );
      await sameHeight('amber');
      await t.shot('amber');
    });

    await t.step('red at 93%', async () => {
      const [week] = await shown('red');
      t.expectEqual([week?.text, week?.look], ['Week 93%', 'badge-subtle-danger'], 'the week red');
      await sameHeight('red');
      await t.shot('red');
    });

    await t.step('a reading 25 minutes old says so', async () => {
      await shown('old');
      t.expectEqual(await page.evaluate(age), '25m ago', 'its age, in the name at any width');
      await sameHeight('old');
      await t.shot('old');
    });

    await t.step('unavailable and off: the Usage icon alone', async () => {
      for (const state of ['unavailable', 'off'] as const) {
        await t.fresh({ search: '?view=all', runRate: state });
        await page.waitFor('the header', `${BUTTON} !== null`);
        t.expectEqual(await page.evaluate(name), 'Usage', `${state}: named Usage`);
        t.expectEqual(await page.evaluate(`${BUTTON}.textContent`), '', `${state}: no figures`);
        if (state === 'unavailable') await t.shot('unavailable');
      }
    });

    await t.step('the Usage view: the pace beside the plan’s week', async () => {
      await t.fresh({ search: '?view=all&usage', runRate: 'ahead' });
      await page.waitFor('the pace', `${DIALOG}?.querySelector('.usage-pace') !== null`);
      const text = await page.evaluate<string>(`${DIALOG}.querySelector('.usage-pace').textContent`);
      const window = await page.evaluate<string>(`${DIALOG}.querySelector('.usage-window').textContent`);
      const resets = await page.evaluate<string>(`${DIALOG}.querySelector('.usage-plan .field-hint').textContent`);
      t.expect(window.includes(', Sun') || window.includes('Sun,') || window.includes('Sun '), 'the window starts on the Sunday the week resets on', { window, resets });
      t.expect(text.startsWith('Pace for 80% by Fri 18:00'), 'its label', text);
      t.expect(/\d+ points ahead of pace/.test(text), 'how far ahead', text);
      t.expect(text.includes('The line for 80% by Fri 18:00 is at') || text.includes('the line runs from 80%'), 'the line', text);
      t.expect(text.includes('At this rate') || text.includes('Not enough readings'), 'the projection, or why there’s none', text);
      const boxes = await page.evaluate<{ plan: number; pace: number; summary: number }>(
        `(() => { const d = ${DIALOG}; const r = (s) => d.querySelector(s).getBoundingClientRect(); return { plan: r('.usage-plan').right, pace: r('.usage-pace').right, summary: r('.usage-summary').right }; })()`,
      );
      t.expect(boxes.pace <= boxes.summary + 0.5, 'no wider than the summary', boxes);
      t.expect(await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), 'the page is no wider than the window');
      await t.shot('usage-view');
    });

    // --- The run rate as a chart (W181) ---------------------------------------------------------------

    const CHART = `${DIALOG}?.querySelector('.rr-chart svg[role="img"]')`;
    interface ChartFacts {
      name: string;
      labels: string[];
      readings: number;
      band: boolean;
      trend: boolean;
      now: boolean;
      limit: boolean;
      target: boolean;
      /** Text whose box leaves the chart's box, or the chart's the dialog's. */
      outside: string[];
      /** Pairs of labels whose boxes overlap. */
      overlapping: string[];
      paceBeside: boolean;
      summaryPace: boolean;
      fits: boolean;
    }
    const facts = `(() => {
      const svg = ${CHART};
      const box = svg.getBoundingClientRect();
      const dialog = ${DIALOG}.getBoundingClientRect();
      const texts = [...svg.querySelectorAll('text')];
      const boxes = texts.map((t) => ({ text: t.textContent, r: t.getBoundingClientRect() }));
      const outside = boxes.filter(({ r }) => r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1).map((b) => b.text);
      if (box.right > dialog.right + 0.5 || box.left < dialog.left - 0.5) outside.push('the chart leaves the dialog');
      const overlapping = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r, b = boxes[j].r;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlapping.push(boxes[i].text + ' / ' + boxes[j].text);
      }
      const body = svg.closest('.usage-runrate-body');
      return {
        name: svg.getAttribute('aria-label') ?? '',
        labels: texts.map((t) => t.textContent),
        readings: svg.querySelectorAll('.rr-readings').length,
        band: svg.querySelector('.rr-band') !== null,
        trend: svg.querySelector('.rr-trend') !== null,
        now: svg.querySelector('.rr-now') !== null,
        limit: svg.querySelector('.rr-limit') !== null,
        target: svg.querySelector('.rr-target') !== null,
        outside,
        overlapping,
        paceBeside: body?.querySelector('.usage-pace') !== null,
        summaryPace: ${DIALOG}.querySelector('.usage-summary .usage-pace') !== null,
        fits: document.documentElement.scrollWidth <= window.innerWidth,
      };
    })()`;

    async function chartOf(state: RunRateWorldState): Promise<ChartFacts> {
      await t.fresh({ search: '?view=all&usage', runRate: state });
      await page.waitFor('the chart', `${CHART} != null`);
      await page.evaluate(`${DIALOG}.querySelector('.usage-runrate').scrollIntoView({ block: 'start' })`);
      const found = await page.evaluate<ChartFacts>(facts);
      t.expect(found.limit && found.target, 'the 100% line and the reserve’s line', found);
      t.expect(found.labels.includes('100%') && found.labels.includes('0%') && found.labels.includes('50%'), 'the 0, 50 and 100% ticks', found.labels);
      t.expect(found.readings >= 1, 'the readings as a line', found.readings);
      t.expectEqual(found.outside, [], 'every label inside the chart, the chart inside the dialog');
      t.expectEqual(found.overlapping, [], 'no two labels overlap');
      t.expect(found.paceBeside && !found.summaryPace, 'the pace’s sentences beside the chart, not in the summary');
      t.expect(found.fits, 'the page is no wider than the window');
      t.expect(found.name.startsWith("A chart of the plan's week"), 'an image with a full description', found.name);
      return found;
    }

    await t.step('the chart: the readings, broken at night, the trend’s band and middle, the line, 100% and now', async () => {
      const found = await chartOf('normal');
      t.expect(found.readings >= 2, 'the readings broken across a night with no page open', found.readings);
      t.expect(found.band && found.trend && found.now, 'the trend and now', found);
      t.expect(found.labels.some((l) => /^Now \d+%$/.test(l)), 'now, labelled', found.labels);
      t.expect(found.labels.some((l) => l.startsWith('80% ') && l.includes('Fri 18:00')), 'the target, labelled', found.labels);
      await t.shot('chart-normal');
    });

    await t.step('the chart after a burst: the trend reaches 100% within the week, marked and said', async () => {
      const found = await chartOf('burst');
      t.expect(found.band && found.trend, 'the trend', found);
      t.expect(found.name.includes('reaches 100% at'), 'the description says when', found.name);
      await t.shot('chart-burst');
    });

    await t.step('the chart ahead of pace', async () => {
      const found = await chartOf('ahead');
      // The chart leaves a label out where it has no room, as near the target's label at 375 px late in
      // the week; the pace's sentences beside it still say how far ahead.
      const beside = await page.evaluate<string>(`${DIALOG}.querySelector('.usage-pace')?.textContent ?? ''`);
      const narrow = (await page.evaluate<number>('window.innerWidth')) <= 400;
      t.expect(found.labels.some((l) => /ahead/.test(l)) || (narrow && /\d+ points ahead of pace/.test(beside)), 'how far ahead, at now, or beside on a narrow window', { labels: found.labels, beside, narrow });
      await t.shot('chart-ahead');
    });

    await t.step('the chart with too few readings: no trend, and why', async () => {
      const found = await chartOf('thin');
      t.expect(!found.band && !found.trend, 'no trend', found);
      t.expect(found.labels.some((l) => l.startsWith('No trend yet')), 'says why', found.labels);
      await t.shot('chart-thin');
    });

    await t.step('the chart past 100%: the readings at the limit, no trend', async () => {
      const found = await chartOf('past');
      t.expect(!found.band, 'no trend', found);
      await t.shot('chart-past');
    });

    await t.step('a stale reading: the readings with its age, no now and no trend', async () => {
      const found = await chartOf('old');
      t.expect(!found.band && !found.trend && !found.now, 'no now and no trend', found);
      t.expect(found.labels.some((l) => / 25m ago$/.test(l)), 'the reading’s age', found.labels);
      await t.shot('chart-stale');
    });

    await t.step('no chart when the run rate is unavailable or off, nor on another window', async () => {
      for (const state of ['unavailable', 'off'] as const) {
        await t.fresh({ search: '?view=all&usage', runRate: state });
        await page.waitFor('the figures', `${DIALOG}?.querySelector('.usage-summary') != null`);
        t.expectEqual(await page.evaluate(`${CHART} == null`), true, `${state}: no chart`);
      }
      await t.fresh({ search: '?view=all&usage', runRate: 'normal' });
      await page.waitFor('the chart', `${CHART} != null`);
      await page.click('the 24 hours tab', `[...${DIALOG}.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === '24 hours')`);
      await page.waitFor('the 24 hours', `${DIALOG}.querySelector('[role="tab"][aria-selected="true"]')?.textContent === '24 hours' && ${DIALOG}.querySelector('.usage-summary') != null`);
      t.expectEqual(await page.evaluate(`${CHART} == null`), true, '24 hours: no chart, the pace in the summary');
      t.expectEqual(await page.evaluate(`${DIALOG}.querySelector('.usage-summary .usage-pace') != null`), true, 'the pace back in the summary');
    });
  },
};

export default part;
