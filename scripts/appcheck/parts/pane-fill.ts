// The session pane filling the browser window (W224, docs/design-system.md, 3: Session pane; docs/ui-map.md): from
// 1,200 px, a control in the view header collapses the repo list and the session list to rails, so the session
// pane takes the window under the header, with the view header, recap strip, tabs and message box all still there.
//
// - below 1,200 px the control isn't offered;
// - the control collapses both columns, the pane fills the window, and the Terminal tab's columns grow to fit;
// - each rail opens its column again on its own, and the control then collapses both again;
// - `f` does what the control does, and `/` opens a collapsed session list and focuses its filter field;
// - the choice is remembered over a reload, and a stored value that isn't this shape collapses nothing;
// - focus is never lost to the page: `f` from a row moves it to the control, and Escape while filled to the list's rail.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { openFromRow, VIEW, viewName } from './_dom.js';

const q = JSON.stringify;
const KEY = 'pitwall.pane-fill.v1';
const FILL = `document.querySelector('.session-view-top .pane-fill-button')`;
const LIST = `document.querySelector('.session-list')`;
const REPOS = `document.querySelector('.columns > nav.repo-list')`;
const rail = (column: 'repos' | 'list') => `document.querySelector('.pane-rail[data-rail=${q(column)}] button')`;

interface Box {
  left: number;
  right: number;
  width: number;
}
const box = (expression: string) => `(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; })()`;
const shown = (expression: string) => `(() => { const el = ${expression}; return !!el && el.getClientRects().length > 0; })()`;

const part: Part = {
  name: 'pane-fill',
  title: 'The session pane fills the window: the control collapses the repo list and session list, each rail opens its own again, the Terminal refits',
  viewports: ['900', '1200', '1440'],
  async run(t) {
    const { page, server } = t;
    const three = t.layout === 'three-columns';
    const open = async (name: string) => {
      await openFromRow(t, name);
      await page.waitFor(`the ${name} view`, `${viewName} === ${q(name)}`);
      await page.settle(200);
    };

    if (!three) {
      await t.step('below 1,200 px the control is not offered', async () => {
        await t.fresh({ search: '?view=all' });
        await open(NAMES.conversation);
        t.expect(!(await page.evaluate(`!!${FILL}`)), 'no Fill the window in the view header');
        t.expect(!(await page.evaluate(`!!document.querySelector('.pane-rail')`)), 'no rails');
        await t.shot('not-offered');
      });
      return;
    }

    await t.step('the view header has the control, with the lists beside the pane', async () => {
      await t.fresh({ search: '?view=all' });
      await open(NAMES.conversation);
      t.expectEqual(await page.evaluate(`${FILL}?.getAttribute('aria-label')`), 'Fill the window', 'it is named Fill the window');
      t.expect(await page.evaluate(shown(REPOS)) && (await page.evaluate(shown(LIST))), 'both columns are shown');
      await t.shot('open');
    });

    await t.step('the control collapses both columns, and the session pane fills the window under the header', async () => {
      const before = await page.evaluate<Box>(box(VIEW));
      await page.click('Fill the window', FILL);
      await page.waitFor('the rails', `document.querySelectorAll('.pane-rail').length === 2`);
      await page.settle(200);
      t.expect(!(await page.evaluate(shown(LIST))), 'the session list is not shown');
      t.expect(!(await page.evaluate(`!!${REPOS}`)), 'the repo list is not there');
      const rails = await page.evaluate<Box[]>(`[...document.querySelectorAll('.pane-rail')].map((el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; })`);
      t.expectEqual(
        rails.map((each) => each.width),
        [40, 40],
        'each rail is 40 px wide',
      );
      const view = await page.evaluate<Box>(box(VIEW));
      t.expect(Math.abs(view.left - 80) <= 1 && view.right === t.viewport.width, 'the session view takes the window from the rails to the right edge', { view });
      t.expect(view.width > before.width, 'it is wider than it was', { before, view });
      t.expect(await page.evaluate(`!document.querySelector('.session-pane [role="separator"]')`), 'no divider while the list is collapsed');
      for (const [what, expression] of [
        ['the view header', `${VIEW}.querySelector('.session-view-head')`],
        ['the session tabs', `${VIEW}.querySelector('.session-tabs')`],
        ['the message box', `${VIEW}.querySelector('.session-view-foot')`],
      ] as const) {
        t.expect(await page.evaluate(shown(expression)), `${what} is still shown`);
      }
      t.expectEqual(await page.evaluate(`${FILL}?.getAttribute('aria-label')`), 'Show the lists', 'the control now says Show the lists');
      await t.shot('filled');
    });

    await t.step('the Terminal tab refits to the new width', async () => {
      await page.click('Show the lists', FILL);
      await page.waitFor('the columns back', `${shown(LIST)}`);
      await open(NAMES.running);
      await page.waitFor('the attach', `${VIEW}?.querySelector('.attach-status')?.dataset.status === 'attached'`);
      await page.settle(300);
      const cols = () => server.records.sizes.filter((each) => each.name === NAMES.running).at(-1)?.cols ?? 0;
      const narrow = cols();
      await page.click('Fill the window', FILL);
      await page.waitFor('the rails', `document.querySelectorAll('.pane-rail').length === 2`);
      for (let tries = 0; tries < 20 && cols() <= narrow; tries += 1) await page.settle(100);
      t.expect(cols() > narrow, 'the session was given more columns once the pane filled the window', { narrow, filled: cols() });
      await t.shot('terminal-filled');
    });

    await t.step('each rail opens its column again on its own, and focus goes into it', async () => {
      await page.click('the repo list rail', rail('repos'));
      await page.waitFor('the repo list', `${shown(REPOS)}`);
      t.expect(!(await page.evaluate(shown(LIST))), 'the session list is still collapsed');
      t.expectEqual(await page.evaluate(`document.querySelectorAll('.pane-rail').length`), 1, 'one rail is left');
      t.expect(await page.evaluate(`!!document.activeElement?.closest('nav.repo-list')`), 'focus is in the repo list');
      await t.shot('repos-open');
      await page.click('the session list rail', rail('list'));
      await page.waitFor('the session list', `${shown(LIST)}`);
      t.expectEqual(await page.evaluate(`document.querySelectorAll('.pane-rail').length`), 0, 'no rails');
      t.expect(await page.evaluate(`!!document.activeElement?.closest('.session-list')`), 'focus is in the session list');
      const view = await page.evaluate<Box>(box(VIEW));
      t.expect(view.width < t.viewport.width - 240 - 360 + 2, 'the session pane is back to its own width', { view });
      t.expectEqual(await page.evaluate(`!!document.querySelector('.session-pane [role="separator"]')`), true, 'the divider is back');
    });

    await t.step('f collapses and opens both, and / opens the session list and focuses its filter field', async () => {
      await page.click('the page', `document.querySelector('.session-view-head')`);
      await page.key('f');
      await page.waitFor('the rails', `document.querySelectorAll('.pane-rail').length === 2`);
      await page.key('/');
      await page.waitFor('the session list', `${shown(LIST)}`);
      t.expect(await page.evaluate(`document.activeElement === document.querySelector('.session-list input[type="search"], .session-list input')`), 'the filter field has focus');
      t.expectEqual(await page.evaluate(`document.querySelectorAll('.pane-rail').length`), 1, 'only the repo list is still a rail');
      await page.click('Fill the window', FILL);
      await page.waitFor('both collapsed', `document.querySelectorAll('.pane-rail').length === 2`);
      await page.click('the page', `document.querySelector('.session-view-head')`);
      await page.key('f');
      await page.waitFor('both open', `document.querySelectorAll('.pane-rail').length === 0`);
    });

    await t.step('the choice is remembered over a reload, and a value of another shape collapses nothing', async () => {
      await page.click('Fill the window', FILL);
      await page.waitFor('the rails', `document.querySelectorAll('.pane-rail').length === 2`);
      t.expectEqual(JSON.parse(await page.evaluate<string>(`localStorage.getItem(${q(KEY)})`)), { v: 1, repos: true, list: true }, 'it is stored as booleans only');
      await page.reload();
      await page.waitFor('the rails', `document.querySelectorAll('.pane-rail').length === 2`);
      t.expect(!(await page.evaluate(shown(LIST))), 'still filled after a reload');
      await t.fresh({ search: '?view=all', storage: { [KEY]: '{"v":2,"repos":true,"list":true}' } });
      t.expectEqual(await page.evaluate(`document.querySelectorAll('.pane-rail').length`), 0, 'a value of another version collapses nothing');
      await t.fresh({ search: '?view=all', storage: { [KEY]: 'not json' } });
      t.expectEqual(await page.evaluate(`document.querySelectorAll('.pane-rail').length`), 0, 'a value that is not JSON collapses nothing');
    });

    await t.step('with no session open, Select a session fills the window too', async () => {
      await t.fresh({ search: '?view=all', storage: { [KEY]: '{"v":1,"repos":true,"list":true}' } });
      const empty = await page.evaluate<Box>(box(`document.querySelector('.session-view-empty')`));
      t.expect(Math.abs(empty.left - 80) <= 1 && empty.right === t.viewport.width, 'the empty state fills the window with nothing open', { empty });
      await t.shot('empty-filled');
    });

    await t.step('focus is never lost to the page: f from a row of the list it hides, then Escape while filled', async () => {
      await t.fresh({ search: '?view=all' });
      await open(NAMES.conversation);
      await page.evaluate(`document.querySelector('.session-list [data-open-session]')?.focus()`);
      t.expect(await page.evaluate(`!!document.activeElement?.closest('.session-list')`), 'focus starts on a row');
      await page.key('f');
      await page.waitFor('the rails', `document.querySelectorAll('.pane-rail').length === 2`);
      await page.waitFor('focus on the control', `document.activeElement === ${FILL}`);
      // The control's tooltip can show while it has focus, and then the first Escape closes that, as everywhere in pitwall.
      const tip = await page.evaluate<boolean>(`!!document.querySelector('[role="tooltip"]')`);
      await page.key('Escape');
      if (tip) {
        await page.settle(150);
        await page.key('Escape');
      }
      await page.waitFor('focus on the session list rail', `document.activeElement === ${rail('list')}`);
      t.expect(await page.evaluate(`!${VIEW}`), 'the view closed');
    });
  },
};

export default part;
