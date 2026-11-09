// The context gauge (W133; docs/design-system.md, 4: Context gauge): a row shows a subtle badge,
// "245K" in warning over 200K and "612K" in danger over 400K, first among its badges, whole, with
// its level in hidden text, and nothing at or below 200K or when the size is unknown; line 1 stays
// one line. The session view's line 2 has "Context 85K" quietly, the badge over 200K with a note
// under line 2 on what to do, or "Context unavailable", each with an info button.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { openFromRow, row, VIEW, viewClose } from './_dom.js';

const q = JSON.stringify;

/** A row's context badge and line 1, by the session's name. */
const rowGauge = (name: string) => `(() => {
  const li = ${row(name)}?.closest('li.session');
  if (!li) return undefined;
  const badge = li.querySelector('.context-badge');
  const line = li.querySelector('.session-line');
  const badges = [...li.querySelectorAll('.session-badges > .badge')];
  return {
    text: badge?.textContent ?? null,
    shown: badge ? [...badge.querySelector('.badge-label').childNodes].filter((n) => !(n instanceof Element && n.matches('.visually-hidden'))).map((n) => n.textContent).join('') : null,
    prefix: badge ? getComputedStyle(badge, '::before').content : null,
    look: badge ? [...badge.classList].find((c) => c.startsWith('badge-subtle-')) ?? null : null,
    first: badge ? badges[0] === badge : null,
    whole: badge ? badge.scrollWidth <= badge.clientWidth + 1 : null,
    oneLine: line.getBoundingClientRect().height <= 24.5,
  };
})()`;
type RowGauge = { text: string | null; shown: string | null; prefix: string | null; look: string | null; first: boolean | null; whole: boolean | null; oneLine: boolean };

const viewGauge = `(() => {
  const meta = ${VIEW}?.querySelector('.session-view-context');
  if (!meta) return undefined;
  const note = ${VIEW}.querySelector('.session-view-context-note');
  const badge = meta.querySelector('.context-badge');
  return {
    text: meta.textContent,
    look: badge ? [...badge.classList].find((c) => c.startsWith('badge-subtle-')) ?? null : null,
    info: !!meta.querySelector('button.info-tip'),
    note: note?.textContent ?? null,
    noteFits: note ? note.getBoundingClientRect().right <= ${VIEW}.getBoundingClientRect().right + 0.5 : null,
  };
})()`;
type ViewGauge = { text: string; look: string | null; info: boolean; note: string | null; noteFits: boolean | null };

const part: Part = {
  name: 'context-gauge',
  title: "The context gauge: a row's badge over 200K and 400K, nothing below, and the session view's number, badge, note and unavailable",
  async run(t) {
    const { page } = t;
    /** Below three columns the view covers the list: it closes first, so the next row can be clicked. */
    const closeView = async () => {
      if (t.layout === 'three-columns' || !(await page.evaluate<boolean>(`!!${VIEW}?.querySelector('h2')`))) return;
      await page.click('Close', viewClose);
      await page.waitFor('the view to close', `!${VIEW}?.querySelector('h2')`);
    };

    await t.step('rows: a warning badge over 200K, danger over 400K, first and whole; nothing below or when unknown', async () => {
      await t.fresh({ search: '?view=all' });
      await page.waitFor('the rows', `!!${row(NAMES.running3)}`);
      const between = await page.evaluate<RowGauge | undefined>(rowGauge(NAMES.running2));
      t.expectEqual(between?.text, 'Context 245K, over 200K', 'the badge says its level in text, not colour alone');
      t.expectEqual(between?.shown, '245K', 'on screen, the number');
      t.expectEqual(between?.look, 'badge-subtle-warning', 'subtle warning over 200K');
      const over = await page.evaluate<RowGauge | undefined>(rowGauge(NAMES.running3));
      t.expectEqual(over?.text, 'Context 612K, over 400K', 'its level in text');
      t.expectEqual(over?.look, 'badge-subtle-danger', 'subtle danger over 400K');
      for (const [name, each] of [[NAMES.running2, between], [NAMES.running3, over]] as const) {
        t.expect(each?.first === true, `${name}: first among its badges, so the status badges still line up`, each);
        t.expect(each?.whole === true, `${name}: the badge is whole`, each);
        t.expect(each?.oneLine === true, `${name}: line 1 stays one line`, each);
        t.expect(each?.prefix?.includes('ctx') === true, `${name}: "ctx" before the number, so it isn't read as a PR number`, each);
      }
      const below = await page.evaluate<RowGauge | undefined>(rowGauge(NAMES.conversation));
      t.expectEqual(below?.text, null, 'no badge at 85K');
      const unknown = await page.evaluate<RowGauge | undefined>(rowGauge(NAMES.waiting));
      t.expectEqual(unknown?.text, null, 'no badge when the size is unknown');
      await t.shot('rows');
    });

    await t.step("rows: the badges stay in their share, clipped rather than running over the row's time", async () => {
      const bad = await page.evaluate<string[]>(`[...document.querySelectorAll('li.session')].flatMap((li) => {
        const badges = li.querySelector('.session-badges');
        const time = li.querySelector('.session-line > .activity');
        if (!badges || !time) return [];
        const clipped = getComputedStyle(badges).overflow === 'hidden';
        const apart = badges.getBoundingClientRect().right <= time.getBoundingClientRect().left + 0.5;
        return clipped && apart ? [] : [li.querySelector('h3')?.textContent ?? '?'];
      })`);
      t.expectEqual(bad.length, 0, `every row's badges clip inside their share, before its time: ${bad.join(', ')}`);
    });

    await t.step('the session view: Context 85K quietly, with its info button and no note', async () => {
      await openFromRow(t, NAMES.conversation);
      await page.waitFor('the context', `!!${VIEW}?.querySelector('.session-view-context')`);
      const view = await page.evaluate<ViewGauge | undefined>(viewGauge);
      t.expectEqual(view?.text, 'Context 85K', 'the number, as meta text');
      t.expectEqual(view?.look, null, 'no badge');
      t.expect(view?.info === true, 'an info button says what it is', view);
      t.expectEqual(view?.note, null, 'no note');
    });

    await t.step('over 400K: the danger badge and a note on what to do, which fits', async () => {
      await closeView();
      await openFromRow(t, NAMES.running3);
      await page.waitFor('the note', `!!${VIEW}?.querySelector('.session-view-context-note')`);
      const view = await page.evaluate<ViewGauge | undefined>(viewGauge);
      t.expectEqual(view?.text, 'Context 612K, over 400K', 'the badge, with its level in text');
      t.expectEqual(view?.look, 'badge-subtle-danger', 'subtle danger');
      t.expect(view?.note?.includes('Hand it off to a new session now') === true && view.note.includes('/compact'), 'the note says what to do', view?.note);
      t.expect(view?.noteFits === true, 'the note wraps inside the view', view);
      await t.shot('view-over');
    });

    await t.step('unknown: Context unavailable, with its info button and no note', async () => {
      await closeView();
      await openFromRow(t, NAMES.waiting);
      await page.waitFor('the view', `${VIEW}?.querySelector('.session-view-name')?.textContent === ${q(NAMES.waiting)}`);
      const view = await page.evaluate<ViewGauge | undefined>(viewGauge);
      t.expectEqual(view?.text, 'Context unavailable', 'says unavailable');
      t.expect(view?.info === true, 'an info button says why', view);
      t.expectEqual(view?.note, null, 'no note');
    });
  },
};

export default part;
