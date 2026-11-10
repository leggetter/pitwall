// The run rate on the header's Usage button (W159, docs/design-system.md, 4: Usage): the week's figure
// in its level's tone, normal, amber and red, the five hours only when sent, Ahead of pace over the
// reserve's line, a reading's age past 10 minutes, the icon alone when it's unavailable or off, the
// header still fitting the window, and the pace beside the plan's week in the Usage view. Made-up
// readings from the fake server (fixtures.ts, World.runRate()), worked out by pitwall's runRate.ts.

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
  title: 'The run rate on the header’s Usage button: normal, amber and red, Ahead of pace, the reading’s age, unavailable and off, and the pace in the Usage view',
  async run(t) {
    const { page } = t;

    async function shown(state: RunRateWorldState): Promise<Figure[]> {
      await t.fresh({ search: '?view=all', runRate: state });
      await page.waitFor('the run rate', `${BUTTON}?.querySelector('.usage-meter-figure') !== null`);
      t.expect(await page.evaluate(fits), 'the header fits the window, the button inside it');
      return page.evaluate<Figure[]>(figures);
    }

    await t.step('normal: the week in neutral, under the line, so no badge', async () => {
      const [week, ...rest] = await shown('normal');
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
      t.expectEqual(await page.evaluate(ahead), 'Ahead of pace', 'the badge');
      t.expect(await page.evaluate<boolean>(`${BUTTON}.querySelector('.usage-meter-ahead').classList.contains('badge-subtle-warning')`), 'in subtle warning');
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
      await t.shot('amber');
    });

    await t.step('red at 93%', async () => {
      const [week] = await shown('red');
      t.expectEqual([week?.text, week?.look], ['Week 93%', 'badge-subtle-danger'], 'the week red');
      await t.shot('red');
    });

    await t.step('a reading 25 minutes old says so', async () => {
      await shown('old');
      t.expectEqual(await page.evaluate(age), '25m ago', 'its age');
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
      t.expect(text.startsWith('Pace for 80% by Fri 18:00'), 'its label', text);
      t.expect(/\d+ points ahead of pace/.test(text), 'how far ahead', text);
      t.expect(text.includes('The line for 80% by Fri 18:00 is at') || text.includes('the line runs from 80%'), 'the line', text);
      t.expect(text.includes('At this rate') || text.includes('Not enough readings'), 'the projection, or why there’s none', text);
      const boxes = await page.evaluate<{ plan: number; pace: number; summary: number }>(
        `(() => { const d = ${DIALOG}; const r = (s) => d.querySelector(s).getBoundingClientRect(); return { plan: r('.usage-plan').right, pace: r('.usage-pace').right, summary: r('.usage-summary').right }; })()`,
      );
      t.expect(boxes.pace <= boxes.summary + 0.5, 'inside the summary', boxes);
      t.expect(await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), 'the page is no wider than the window');
      await t.shot('usage-view');
    });
  },
};

export default part;
