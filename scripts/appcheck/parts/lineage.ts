// Session lineage (W167; docs/design-system.md, 4: Session view): the view's "Continued from" and
// "Continued in" line. A session pitwall lists is a link button that opens its view; one it doesn't
// list is named in words with no link; a session with no lineage has no line; and the line wraps
// inside the view at every width.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { openFromRow, VIEW, viewName } from './_dom.js';

const q = JSON.stringify;
const LINE = `${VIEW}?.querySelector('[data-session-lineage]')`;
const UNLISTED = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const part: Part = {
  name: 'lineage',
  title: 'Session lineage: Continued from and Continued in under the header, a listed session as a link that opens it, an unlisted one in words, and no line without lineage',
  async run(t) {
    const { page, server } = t;
    const id = (name: string) => server.world.byName(name).sessionId;

    await t.step('a session with no lineage has no line', async () => {
      await t.fresh({ search: '?view=all', prs: 'off' });
      await openFromRow(t, NAMES.running);
      t.expect(!(await page.evaluate<boolean>(`!!${LINE}`)), 'no lineage line');
    });

    await t.step('Continued from a listed session is a link, Continued in one pitwall no longer lists is words, and the line stays inside the view', async () => {
      await t.fresh({ search: '?view=all', prs: 'off' });
      server.world.lineage(id(NAMES.running), { from: id(NAMES.running2), to: UNLISTED });
      server.broadcast();
      await openFromRow(t, NAMES.running);
      await page.waitFor('the lineage line', `!!${LINE}`);
      const state = await page.evaluate<Record<string, unknown>>(`(() => {
        const line = ${LINE};
        const view = ${VIEW}.getBoundingClientRect();
        const box = line.getBoundingClientRect();
        return {
          text: line.textContent,
          links: [...line.querySelectorAll('button.link-button')].map((b) => b.textContent),
          inside: box.left >= view.left - 1 && box.right <= view.right + 1,
          noScroll: line.scrollWidth <= line.clientWidth + 1,
        };
      })()`);
      t.expectEqual(state.text, `Continued from ${NAMES.running2}Continued in a session pitwall no longer lists`, 'the line, in words');
      t.expectEqual(state.links, [NAMES.running2], 'only the listed session is a link');
      t.expectEqual([state.inside, state.noScroll], [true, true], 'inside the view, no overflow');
      await t.shot('line');
    });

    await t.step('the link opens the earlier session’s view', async () => {
      await page.click('the Continued from link', `${LINE}.querySelector('button[data-lineage-link="from"]')`);
      await page.waitFor('the earlier session', `${viewName} === ${q(NAMES.running2)}`);
      t.expect(!(await page.evaluate<boolean>(`!!${LINE}`)), 'the earlier session has no line of its own here');
    });
  },
};

export default part;
