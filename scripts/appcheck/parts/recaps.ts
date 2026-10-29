// Recaps (M5, W111; docs/design-system.md, 4: Recap strip): the strip between the session view's
// header and its tabs, on every tab, with its headline by what the recap waits on, Why and Now or
// Next; collapsed, and kept so after a reload; a stale recap, and a session with none, asking for one
// once as the view opens; Refresh, busy until the new one comes, and off while the day's budget is
// spent; Claude Code's recap; the rows' recap reasons on line 2; the app strip's recap lines; and,
// with recaps off, no strip and nothing asked.

import { NAMES, RECAP_CALL_MS, RECAPPED, RECAPS_ERROR } from '../fixtures.js';
import type { Part } from '../runner.js';
import { attachStatus, openFromRow, row, VIEW, viewClose, viewName } from './_dom.js';

const STRIP = `${VIEW}?.querySelector('.session-recap')`;
const strip = `(() => {
  const view = ${VIEW};
  const strip = view?.querySelector('.session-recap');
  if (!strip) return null;
  const head = view.querySelector('header.session-view-head').getBoundingClientRect();
  const tabs = view.querySelector('[role="tablist"]').getBoundingClientRect();
  const frame = view.getBoundingClientRect();
  const box = strip.getBoundingClientRect();
  const toggle = strip.querySelector('.recap-toggle');
  const body = strip.querySelector('.recap-body');
  const refresh = strip.querySelector('[data-recap-refresh]');
  const text = strip.querySelector('.recap-headline-text');
  return {
    kind: strip.dataset.recap,
    title: strip.querySelector('h3')?.textContent ?? null,
    expanded: toggle?.getAttribute('aria-expanded') ?? null,
    headline: strip.querySelector('.recap-headline')?.textContent ?? null,
    lines: [...strip.querySelectorAll('.recap-line dt')].map((dt) => dt.textContent),
    bodyHidden: body ? body.hidden : null,
    stale: !!strip.querySelector('.recap-stale'),
    busy: refresh?.getAttribute('aria-busy') === 'true',
    off: refresh?.getAttribute('aria-disabled') === 'true',
    age: strip.querySelector('.recap-age')?.textContent ?? null,
    note: strip.querySelector('.recap-note')?.textContent ?? null,
    between: box.top >= head.bottom - 0.5 && box.bottom <= tabs.top + 0.5,
    inside: box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5,
    share: box.height / frame.height,
    oneLine: text ? text.getBoundingClientRect().height <= 21 : null,
  };
})()`;
type Strip = {
  kind: string;
  title: string | null;
  expanded: string | null;
  headline: string | null;
  lines: string[];
  bodyHidden: boolean | null;
  stale: boolean;
  busy: boolean;
  off: boolean;
  age: string | null;
  note: string | null;
  between: boolean;
  inside: boolean;
  share: number;
  oneLine: boolean | null;
};
const APP_STRIP = `document.querySelector('.app-strips [data-strip="recaps"]')?.textContent ?? null`;
const lineTwo = (name: string) => `(${row(name)})?.closest('li.session')?.querySelector('.session-what-text')?.textContent ?? null`;
const badge = (name: string) => `(${row(name)})?.closest('li.session')?.querySelector('.session-badges [data-status]')?.textContent ?? null`;

const part: Part = {
  name: 'recaps',
  title: 'Recaps: the strip between the header and the tabs, its headline, collapsed, asking once, Refresh, the budget, Claude Code’s recap, the rows’ reasons and the app strip',
  async run(t) {
    const { page, server } = t;
    const asked = (name: string) => server.records.recapRefreshes.filter((each) => each.name === name);
    /** Below three columns the view covers the list: it closes first, so the next row can be clicked. */
    const closeView = async () => {
      if (t.layout === 'three-columns' || !(await page.evaluate<boolean>(`!!${VIEW}?.querySelector('h2')`))) return;
      await page.click('Close', viewClose);
      await page.waitFor('the view to close', `!${VIEW}?.querySelector('h2')`);
    };
    const open = async (name: string, kind = 'shown') => {
      await closeView();
      await openFromRow(t, name);
      return page.waitFor<Strip>(`its recap strip, ${kind}`, `(() => { const s = ${strip}; return s && s.kind === ${JSON.stringify(kind)} ? s : null; })()`);
    };

    await t.step('the strip: what you need to do, then why it started and where it is, between the header and the tabs', async () => {
      await t.fresh({ search: '?view=all', recaps: 'ok' });
      const shown = await open(NAMES.conversation);
      t.expectEqual(shown.title, 'Recap', 'its title');
      t.expect(shown.headline?.startsWith('You need to: Say whether it should fix the lint errors on #51') ?? false, 'the headline: what you need to do', shown.headline);
      t.expectEqual(shown.lines, ['Why', 'Now'], 'then Why and Now');
      t.expectEqual(shown.expanded, 'true', 'open, by default');
      t.expect(shown.between && shown.inside, 'between the header and the tabs, inside the view', shown);
      t.expect(shown.share <= 0.36, 'at most 35% of the view', shown.share);
      t.expect(/^\d+m ago$/.test(shown.age ?? ''), 'its age', shown.age);
      t.expectEqual(asked(NAMES.conversation).length, 0, 'a current recap asks for nothing');
      t.expectEqual(
        server.records.recapFetches.filter((each) => each.name === NAMES.conversation),
        [{ name: NAMES.conversation, status: 200 }],
        'fetched once, as the view opened',
      );
      await t.shot('strip');
    });

    await t.step('collapsed, it keeps the headline alone, and stays collapsed after a reload', async () => {
      await page.click('the Recap toggle', `${STRIP}?.querySelector('.recap-toggle')`);
      const collapsed = await page.waitFor<Strip>('the strip to collapse', `(() => { const s = ${strip}; return s && s.expanded === 'false' ? s : null; })()`);
      t.expect(collapsed.bodyHidden === true && collapsed.headline !== null, 'Why and Now hidden, the headline kept', collapsed);
      t.expectEqual(collapsed.oneLine, true, 'the headline on one line');
      t.expectEqual(await page.evaluate(`localStorage.getItem('pitwall.recap-collapsed.v1')`), 'true', 'kept as a boolean');
      await t.shot('collapsed');
      await page.reload();
      await page.waitFor('the view again', `${viewName} === ${JSON.stringify(NAMES.conversation)}`, 15_000);
      const reloaded = await page.waitFor<Strip>('its strip', `(() => { const s = ${strip}; return s && s.kind === 'shown' ? s : null; })()`);
      t.expectEqual(reloaded.expanded, 'false', 'still collapsed');
      await page.click('the Recap toggle', `${STRIP}?.querySelector('.recap-toggle')`);
      await page.waitFor('the strip to open', `${strip}?.expanded === 'true'`);
    });

    await t.step('on the Terminal tab too, waiting on CI', async () => {
      await page.navigate(`/?view=all`);
      await page.waitFor('the list', `!!${row(NAMES.running2)}`, 15_000);
      const shown = await open(RECAPPED.ci);
      await page.waitFor('the terminal to attach', `${attachStatus} === 'attached'`);
      const onTerminal = await page.evaluate<Strip>(strip);
      t.expect(onTerminal.headline?.startsWith("Waiting on CI: It's waiting for the made-up CI run") ?? false, 'the headline: what it waits on', onTerminal.headline);
      t.expect(onTerminal.between, 'still between the header and the tabs', onTerminal);
      t.expectEqual(shown.lines, ['Why', 'Now'], 'then Why and Now');
      await t.shot('terminal');
    });

    await t.step('Claude Code’s recap: where it is, with nothing to open', async () => {
      const shown = await open(RECAPPED.claudeCode);
      t.expectEqual(shown.title, "Claude Code's recap", 'its title says whose it is');
      t.expect(shown.expanded === null && shown.lines.length === 0, 'no disclosure button, and no lines', shown);
      t.expect(shown.headline?.startsWith('Now: The made-up index rebuild') ?? false, 'the headline: where it is', shown.headline);
    });

    await t.step('a stale recap: the view asks for a new one once, and shows it', async () => {
      await open(RECAPPED.stale);
      await page.waitFor('the new recap', `(() => { const s = ${strip}; return s && s.kind === 'shown' && !s.stale && !s.busy; })()`, 8_000);
      await page.settle(RECAP_CALL_MS + 1_500);
      t.expectEqual(asked(RECAPPED.stale), [{ name: RECAPPED.stale, status: 200 }], 'asked once, never again');
    });

    await t.step('a session with none: the strip says one is coming, asks once, and shows it', async () => {
      await open(NAMES.waiting, 'loading');
      const shown = await page.waitFor<Strip>('its first recap', `(() => { const s = ${strip}; return s && s.kind === 'shown' ? s : null; })()`, 8_000);
      t.expect(shown.headline?.startsWith('You need to: Answer its permission prompt') ?? false, 'the headline', shown.headline);
      await page.settle(1_000);
      t.expectEqual(asked(NAMES.waiting).length, 1, 'asked once');
    });

    await t.step('Refresh: busy until the new recap comes', async () => {
      await open(NAMES.conversation);
      await page.click('Refresh the recap', `${STRIP}?.querySelector('[data-recap-refresh]')`);
      await page.waitFor('Refresh to be busy', `${strip}?.busy === true`);
      await t.shot('refreshing');
      const after = await page.waitFor<Strip>('the new recap', `(() => { const s = ${strip}; return s && !s.busy ? s : null; })()`, 8_000);
      t.expectEqual(after.age, 'just now', 'the new one, just now');
      t.expectEqual(asked(NAMES.conversation), [{ name: NAMES.conversation, status: 200 }], 'one request');
    });

    await t.step('rows: Waiting on you on line 2 in Needs you, and what an idle session waits on otherwise', async () => {
      await closeView();
      await page.navigate('/?view=needs-you');
      await page.waitFor('Needs you', `!!${row(NAMES.conversation)}`, 15_000);
      const needs = await page.evaluate<string | null>(lineTwo(NAMES.conversation));
      t.expect(needs?.includes('Waiting on you: Say whether it should fix the lint errors on #51') ?? false, "Needs you's 'recap' reason on line 2", needs);
      t.expectEqual(await page.evaluate(badge(NAMES.conversation)), 'Waiting on you', 'its badge');
      await t.shot('needs-you');
      await page.navigate('/?view=all');
      await page.waitFor('All sessions', `!!${row(RECAPPED.someoneElse)}`, 15_000);
      const quiet = await page.evaluate<string | null>(lineTwo(RECAPPED.someoneElse));
      t.expect(quiet?.includes('Waiting on someone else · You:') ?? false, 'a quiet reason first on line 2', quiet);
      t.expectEqual(await page.evaluate(`(${row(RECAPPED.someoneElse)})?.closest('li.session')?.dataset.attention ?? null`), null, 'never needing you');
      t.expect(!((await page.evaluate<string | null>(lineTwo(RECAPPED.ci))) ?? '').includes('Waiting on'), 'not while it works');
    });

    await t.step('the day’s budget spent: the app strip says so, Refresh is off, and nothing is asked for', async () => {
      await t.fresh({ search: '?view=all', recaps: 'spent' });
      t.expect((await page.evaluate<string | null>(APP_STRIP))?.startsWith("Today's 200 recaps are used up") ?? false, 'the app strip', await page.evaluate(APP_STRIP));
      const shown = await open(RECAPPED.stale);
      t.expect(shown.stale && shown.headline?.startsWith('May be out of date. You need to:') === true, 'its stale recap, which says so first', shown);
      t.expectEqual(shown.off, true, 'Refresh is off');
      await page.click('Refresh the recap', `${STRIP}?.querySelector('[data-recap-refresh]')`);
      await page.settle(1_000);
      t.expectEqual(server.records.recapRefreshes.length, 0, 'nothing asked for');
      await t.shot('budget');
    });

    await t.step('the latest recap failed: the app strip says so, and a session with none says none came', async () => {
      await t.fresh({ search: '?view=all', recaps: 'failing' });
      t.expect((await page.evaluate<string | null>(APP_STRIP))?.includes(RECAPS_ERROR) ?? false, 'the app strip, in pitwall’s words', await page.evaluate(APP_STRIP));
      await open(NAMES.waiting, 'loading');
      const none = await page.waitFor<Strip>('none, after the call failed', `(() => { const s = ${strip}; return s && s.kind === 'none' ? s : null; })()`, 8_000);
      t.expect(none.note?.startsWith('No recap yet. The latest recap failed:') ?? false, 'why', none.note);
      await t.shot('failing');
    });

    await t.step('recaps off: no strip, nothing fetched or asked for, and no app strip', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.conversation);
      await page.settle(1_000);
      t.expectEqual(await page.evaluate(`!!${STRIP}`), false, 'no strip');
      t.expect(server.records.recapFetches.length === 0 && server.records.recapRefreshes.length === 0, 'nothing fetched or asked for', server.records);
      t.expectEqual(await page.evaluate(APP_STRIP), null, 'no app strip');
    });
  },
};

export default part;
