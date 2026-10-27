// Open in an editor (W72; docs/design-system.md, 4: Session view: header, tabs and footer, the
// actions menu): the page GETs the editor list once, after it has authenticated; a listed session's
// actions menu has Open in VS Code and Open in Cursor after the copies, one per editor the server
// found; choosing one POSTs that editor alone, and an info toast says it opened; a session whose
// directory has gone has neither. The fake server says it found both, records each open, and opens
// nothing.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { focused, openFromRow, toasts, VIEW, viewName } from './_dom.js';

const q = JSON.stringify;
const MENU_BUTTON = `${VIEW}?.querySelector('button[aria-label="Session actions"]')`;
const ITEMS = `[...(${VIEW}?.querySelectorAll('[role="menu"] [role="menuitem"]') ?? [])].map((item) => item.textContent.trim())`;
const menuItem = (label: string) => `[...(${VIEW}?.querySelectorAll('[role="menuitem"]') ?? [])].find((item) => item.textContent.trim() === ${q(label)})`;

const part: Part = {
  name: 'open-in-editor',
  title: "Open in an editor: the editor list fetched once, the actions menu's Open in VS Code and Open in Cursor, the request and its toast",
  async run(t) {
    const { page, server } = t;
    const id = (name: string) => server.world.byName(name).sessionId;
    const openMenu = async () => {
      await page.click('Session actions', MENU_BUTTON);
      await page.waitFor('the menu', `!!${VIEW}?.querySelector('[role="menu"]')`);
      return page.evaluate<string[]>(ITEMS);
    };

    await t.step('the page GETs the editor list once it has authenticated, and only once', async () => {
      await t.fresh({ search: '?view=all' });
      await page.settle(300);
      const gets = server.records.requests.filter((request) => request.startsWith('GET /api/editors '));
      t.expectEqual(gets, ['GET /api/editors 200'], 'one GET of the list, answered');
      t.expect(server.records.requests.indexOf('UPGRADE /ws 101') < server.records.requests.indexOf('GET /api/editors 200'), 'after the socket, which authenticates', server.records.requests);
    });

    await t.step("a running session's actions menu has Open in VS Code and Open in Cursor, after the copies", async () => {
      await openFromRow(t, NAMES.running);
      const items = await openMenu();
      const after = items.indexOf('Copy attach command');
      t.expect(after >= 0, 'the menu has Copy attach command', items);
      t.expectEqual(items.slice(after + 1, after + 3), ['Open in VS Code', 'Open in Cursor'], 'then one item per editor found, in the list’s order');
      t.expect(
        await page.evaluate<boolean>(`${VIEW}.querySelector('[role="menu"]').children[[...${VIEW}.querySelector('[role="menu"]').children].indexOf(${menuItem('Open in VS Code')}) - 1]?.getAttribute('role') === 'separator'`),
        'a separator before them',
      );
      await t.shot('menu');
    });

    await t.step("choosing Open in Cursor asks the server for that editor alone, and an info toast says it opened", async () => {
      await page.click('Open in Cursor', menuItem('Open in Cursor'));
      const message = `Opened ${NAMES.running}'s directory in Cursor.`;
      await page.waitFor('the toast', `${toasts}.includes(${q(message)})`);
      t.expectEqual(server.records.opens, [{ name: NAMES.running, editor: 'cursor' }], 'one open, of this session, in Cursor');
      t.expect(server.records.requests.includes(`POST /api/sessions/${id(NAMES.running)}/open 200`), 'POSTed to its open path', server.records.requests);
      t.expect(await page.evaluate<boolean>(`!!document.querySelector('.toasts .toast.info')`), 'an info toast');
      t.expect(!(await page.evaluate<boolean>(`!!${VIEW}?.querySelector('[role="menu"]')`)), 'the menu closed');
      t.expectEqual(await page.evaluate(focused), 'Session actions', 'focus is back on the menu button');
      await t.shot('opened');
    });

    await t.step('a session whose directory has gone has neither', async () => {
      await page.navigate(`/?view=all&session=${id(NAMES.endedGone)}`);
      await page.waitFor(`the ${NAMES.endedGone} view`, `${viewName} === ${q(NAMES.endedGone)}`, 10_000);
      const items = await openMenu();
      t.expect(!items.some((item) => item.startsWith('Open in')), 'no Open in items', items);
      await page.key('Escape');
      await page.waitFor('the menu to close', `!${VIEW}?.querySelector('[role="menu"]')`);
      t.expectEqual(server.records.opens, [{ name: NAMES.running, editor: 'cursor' }], 'and nothing more was opened');
    });
  },
};

export default part;
