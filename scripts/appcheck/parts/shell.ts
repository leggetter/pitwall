// The shell and its layouts (docs/design-system.md, 2.12 and 3): the header; the repo list as a
// drawer below 900 px; the session view over the list below 1,200 px, with what it covers inert, and
// full width with Back to sessions at 600 px and narrower; three columns from 1,200 px.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { DIALOG, headerButton, openFromRow, VIEW, viewClose, viewHeading } from './_dom.js';

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

const box = (expression: string) =>
  `(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) }; })()`;
const REPOS_COLUMN = `document.querySelector('.columns > nav.repo-list')`;
const LIST = `document.querySelector('.session-list')`;
const isInert = (expression: string) => `!!(${expression})?.closest('[inert]')`;

const part: Part = {
  name: 'shell',
  title: 'The header, and the layouts: the drawer below 900 px, the view over the list below 1,200 px, three columns above',
  async run(t) {
    const { page } = t;

    await t.step('loads, and takes the token out of the address bar', async () => {
      await t.fresh({ search: '?view=all' });
      const where = await page.evaluate<{ hash: string; href: string }>(`({ hash: location.hash, href: location.href })`);
      t.expect(where.hash === '' && !where.href.includes('token'), 'the token is out of the address bar');
      t.expectEqual(await page.evaluate(`document.querySelector('.app').dataset.layout`), t.layout, 'the layout for the width');
      t.expectEqual(await page.evaluate(`document.documentElement.dataset.theme`), t.theme, 'the theme, from the system');
      t.expectEqual(await page.evaluate(`document.querySelector('header .connection')?.textContent`), 'Live', 'the connection badge');
      for (const label of ['New session', 'Preferences', 'Keyboard shortcuts']) t.expect(await page.evaluate(`!!${headerButton(label)}`), `the header has ${label}`);
      t.expect(await page.evaluate(`!!document.querySelector('header [role="group"][aria-label="Theme"]')`), 'the header has the theme switch');
      await t.shot('loaded');
    });

    await t.step('the columns', async () => {
      const repos = await page.evaluate<Box | null>(box(REPOS_COLUMN));
      const list = await page.evaluate<Box>(box(LIST));
      if (t.layout === 'drawer') {
        t.expect(repos === null, 'no repo list column below 900 px');
        t.expect(await page.evaluate(`!!${headerButton('Repos')}`), 'the header has Repos');
        t.expect(list.left === 0 && list.width === t.viewport.width, 'the session list takes the width', list);
      } else {
        t.expect(repos !== null && repos.left === 0 && repos.width === 240, 'the repo list is a 240 px column at the left from 900 px', repos);
        t.expect(!(await page.evaluate(`!!${headerButton('Repos')}`)), 'no Repos button from 900 px');
        t.expect(repos !== null && list.left >= repos.right - 1, 'the session list is after the repo list', { repos, list });
      }
      const empty = await page.evaluate<boolean>(`!!document.querySelector('.session-view-empty')`);
      t.expectEqual(empty, t.layout === 'three-columns', 'the third column says "Select a session" from 1,200 px, and is absent below');
    });

    if (t.layout === 'drawer') {
      await t.step('the repo drawer opens from Repos, and Escape closes it', async () => {
        await page.click('Repos', headerButton('Repos'));
        await page.waitFor('the drawer', `!!document.querySelector('.repo-drawer[role="dialog"] nav[aria-label="Repos"]')`);
        t.expectEqual(await page.evaluate(`${headerButton('Repos')}.getAttribute('aria-expanded')`), 'true', 'Repos says the drawer is expanded');
        t.expect(await page.evaluate(`document.querySelector('.repo-drawer').contains(document.activeElement)`), 'focus is in the drawer');
        await page.settle(300);
        const drawer = await page.evaluate<Box>(box(`document.querySelector('.repo-drawer')`));
        t.expect(drawer.left === 0 && drawer.right <= t.viewport.width, 'the drawer is at the left, inside the window', drawer);
        await t.shot('drawer');
        await page.key('Escape');
        await page.waitFor('the drawer to close', `!document.querySelector('.repo-drawer')`);
        t.expect(await page.evaluate(`document.activeElement === ${headerButton('Repos')}`), 'focus is back on Repos');
      });

      await t.step('choosing in the drawer closes it', async () => {
        await page.click('Repos', headerButton('Repos'));
        await page.waitFor('the drawer', `!!document.querySelector('.repo-drawer nav')`);
        await page.click('Needs you', `[...document.querySelectorAll('.repo-drawer a[data-repo-item]')].find((a) => a.querySelector('.repo-item-label')?.textContent === 'Needs you')`);
        await page.waitFor('the drawer to close', `!document.querySelector('.repo-drawer')`);
        t.expectEqual(await page.evaluate(`location.search`), '?view=needs-you', 'the URL says Needs you');
      });
    }

    await t.step(t.layout === 'three-columns' ? 'a session opens in the third column' : 'a session opens over the list', async () => {
      if (t.layout === 'drawer') await page.navigate('/?view=all');
      await page.waitFor('the rows', `document.querySelectorAll('.session-list [data-open-session]').length > 0`);
      await openFromRow(t, NAMES.conversation);
      await page.settle(250);
      const view = await page.evaluate<Box>(box(VIEW));
      const listBox = await page.evaluate<Box>(box(LIST));
      if (t.layout === 'three-columns') {
        t.expect(await page.evaluate(`${VIEW}.classList.contains('in-column') && !${VIEW}.hasAttribute('role')`), 'the view is a column, not a dialog');
        t.expect(!(await page.evaluate(isInert(LIST))), 'the session list stays usable');
        t.expect(Math.abs(view.left - listBox.right) <= 1 && view.right === t.viewport.width, 'the view is the third column, at the right', { view, list: listBox });
        t.expect(await page.evaluate(`!!document.querySelector('.session-pane [role="separator"][aria-label="Resize the session view"]')`), 'the divider is there to resize it');
      } else {
        t.expect(
          await page.evaluate(`${VIEW}.classList.contains('overlay') && ${VIEW}.getAttribute('role') === 'dialog' && ${VIEW}.getAttribute('aria-modal') === 'false'`),
          'the view is a non-modal dialog over the list',
        );
        t.expect(await page.evaluate(isInert(LIST)), 'the session list it covers is inert');
        if (t.layout === 'sidebar') t.expectEqual(await page.evaluate(isInert(REPOS_COLUMN)), t.viewport.width < 1000, 'the repo list is inert where the view reaches into it, below 1,000 px');
        t.expect(view.right === t.viewport.width && view.width === Math.min(760, t.viewport.width), 'the view is 760 px or the window, at the right', view);
        t.expect(!(await page.evaluate(`!!${DIALOG}`)), 'nothing modal is open');
        t.expect(
          await page.evaluate(`(() => { const b = ${headerButton('New session')}.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!hit && !!hit.closest('header'); })()`),
          'the header stays in sight above it',
        );
      }
      const back = await page.evaluate<string | null>(`${VIEW}.querySelector('.session-view-back')?.textContent.trim() ?? null`);
      t.expectEqual(back, t.compact ? 'Back to sessions' : null, t.compact ? 'Back to sessions in place of Close at 600 px and narrower' : 'Close, not Back to sessions, wider than 600 px');
      await t.shot('session-open');
    });

    await t.step(t.compact ? 'Back to sessions closes it' : 'Close closes it', async () => {
      await page.click(t.compact ? 'Back to sessions' : 'Close', viewClose);
      await page.waitFor('the view to close', `!${VIEW} || !${viewHeading}`);
      t.expect(!(await page.evaluate(isInert(LIST))), 'the session list is usable again');
      t.expect(!(await page.evaluate(`location.search.includes('session=')`)), 'the URL has no session');
    });
  },
};

export default part;
