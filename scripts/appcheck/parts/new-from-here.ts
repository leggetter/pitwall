// New session from here (W118; docs/design-system.md, 4: Session view: header, tabs and footer, the
// actions menu, and 4: Dialogs, the New session dialog): first in a session's actions menu, it opens
// New session in that session's directory with a blank prompt; text selected in the conversation
// survives a real click on the menu's button, and Draft from this session puts it in the prompt,
// quoted, after a line with the session's id; with nothing selected the button is off and says to select
// text first; the start sends the directory and the prompt as shown, which names the session by its
// id, never its name; an ended session's works, and one whose directory has gone, or that's no longer
// listed, has it off, saying why; and the keyboard reaches and uses it.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { DIALOG, dialogBox, dialogButton, dialogName, focused, openFromRow, VIEW, viewName } from './_dom.js';

const q = JSON.stringify;
const LABEL = 'New session from here';
const DRAFT = 'Draft from this session';
const MENU_BUTTON = `${VIEW}?.querySelector('button[aria-label="Session actions"]')`;
const menuItem = (label: string) => `[...(${VIEW}?.querySelectorAll('[role="menuitem"]') ?? [])].find((item) => item.textContent.trim() === ${q(label)})`;
const field = (label: string) => `[...(${DIALOG}?.querySelectorAll('input, select, textarea') ?? [])].find((el) => el.labels?.[0]?.textContent.trim().startsWith(${q(label)}))`;
const DIRECTORY = field('Directory');
const PROMPT = field('First prompt');
const DRAFT_BUTTON = dialogButton(DRAFT);
const described = (element: string) => `((${element})?.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ')`;
const SELECTED = 'The route is in. Running the tests now.';
/** Selects SELECTED in the open view's conversation, as a drag over it would. */
const SELECT_REPLY = `(() => {
  const walker = document.createTreeWalker(${VIEW}.querySelector('.conversation'), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf(${q(SELECTED)});
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + ${SELECTED.length});
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return getSelection().toString();
  }
  return '';
})()`;

const part: Part = {
  name: 'new-from-here',
  title: "New session from here: the actions menu's item, the dialog in the session's directory, Draft from this session, the start, and its off states",
  async run(t) {
    const { page, server } = t;
    const openMenu = async () => {
      await page.click('Session actions', MENU_BUTTON);
      await page.waitFor('the menu', `!!${VIEW}?.querySelector('[role="menu"]')`);
    };

    await t.step('is first in the actions menu, and opens New session in the session’s directory, with a blank prompt and Draft from this session off', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.conversation);
      await openMenu();
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('[role="menu"]').children[0]?.textContent.trim()`), LABEL, 'first in the menu');
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('[role="menu"]').children[1]?.getAttribute('role')`), 'separator', 'then a separator');
      await t.shot('menu');
      await page.click(LABEL, menuItem(LABEL));
      await page.waitFor('the dialog', `${dialogName} === 'New session'`);
      t.expectEqual(await page.evaluate(`${DIRECTORY}.value`), server.world.byName(NAMES.conversation).cwd, 'its directory chosen');
      t.expectEqual(await page.evaluate(`${PROMPT}.value`), '', 'a blank prompt');
      t.expectEqual(await page.evaluate(`${DRAFT_BUTTON}?.getAttribute('aria-disabled')`), 'true', 'Draft from this session is off with nothing selected');
      t.expect((await page.evaluate<string>(described(DRAFT_BUTTON))).startsWith('To quote it, select text in its conversation'), 'and says to select text first', await page.evaluate(described(DRAFT_BUTTON)));
      const card = await page.evaluate<{ left: number; right: number; top: number; bottom: number }>(dialogBox);
      t.expect(card.left >= 15.5 && card.right <= t.viewport.width - 15.5 && card.top >= 0 && card.bottom <= t.viewport.height, 'inside the window', card);
      await t.shot('blank');
      await page.click('Cancel', dialogButton('Cancel'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
    });

    await t.step('text selected in the conversation survives a click on the menu’s button, and Draft from this session quotes it after a line naming the session', async () => {
      t.expectEqual(await page.evaluate(SELECT_REPLY), SELECTED, 'the reply selected');
      await openMenu();
      await page.click(LABEL, menuItem(LABEL));
      await page.waitFor('the dialog', `${dialogName} === 'New session'`);
      t.expectEqual(await page.evaluate(`${DRAFT_BUTTON}?.getAttribute('aria-disabled')`), null, 'Draft from this session is on');
      await page.click(DRAFT, DRAFT_BUTTON);
      // The session by its id, never its name (#120's review), which the subtitle shows and isn't sent.
      const draft = `From my session ${server.world.byName(NAMES.conversation).sessionId}:\n\n> ${SELECTED}\n\n`;
      await page.waitFor('the draft in the prompt', `${PROMPT}.value === ${q(draft)}`);
      t.expect(await page.evaluate(`document.activeElement === ${PROMPT}`), 'focus is in the prompt', await page.evaluate(focused));
      t.expectEqual(await page.evaluate(`${PROMPT}.selectionStart === ${PROMPT}.value.length`), true, 'at its end');
      t.expectEqual(await page.evaluate(`${DRAFT_BUTTON}?.getAttribute('aria-disabled')`), 'true', 'off while the draft is there');
      await page.type('Write the made-up follow-up.');
      await t.shot('drafted');
      await page.click('Start session', dialogButton('Start session'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expectEqual(
        server.records.spawns,
        [{ cwd: server.world.byName(NAMES.conversation).cwd, promptLength: `${draft}Write the made-up follow-up.`.length }],
        'one start, in its directory, with the prompt as shown',
      );
    });

    await t.step('is reached from the keyboard: Enter on the menu’s button lands on it, and Enter opens the dialog', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.conversation);
      await page.evaluate(`${MENU_BUTTON}.focus()`);
      await page.key('Enter');
      await page.waitFor('the menu', `!!${VIEW}?.querySelector('[role="menu"]')`);
      t.expectEqual(await page.evaluate(focused), LABEL, 'focus is on New session from here');
      await page.key('Enter');
      await page.waitFor('the dialog', `${dialogName} === 'New session'`);
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expectEqual(await page.evaluate(focused), 'Session actions', 'focus is back on the menu’s button');
    });

    await t.step('an ended session’s is on; one whose directory has gone has it off, saying why', async () => {
      await page.navigate(`/?view=all&session=${server.world.byName(NAMES.ended).sessionId}`);
      await page.waitFor(`the ${NAMES.ended} view`, `${viewName} === ${q(NAMES.ended)}`, 10_000);
      await openMenu();
      t.expectEqual(await page.evaluate(`${menuItem(LABEL)}?.getAttribute('aria-disabled')`), null, 'on for an ended session');
      await page.key('Escape');
      await page.waitFor('the menu to close', `!${VIEW}?.querySelector('[role="menu"]')`);
      await page.navigate(`/?view=all&session=${server.world.byName(NAMES.endedGone).sessionId}`);
      await page.waitFor(`the ${NAMES.endedGone} view`, `${viewName} === ${q(NAMES.endedGone)}`, 10_000);
      await openMenu();
      t.expectEqual(await page.evaluate(`${menuItem(LABEL)}?.getAttribute('aria-disabled')`), 'true', 'off where the directory has gone');
      t.expect((await page.evaluate<string>(described(menuItem(LABEL)))).includes('no longer exists'), 'saying why', await page.evaluate(described(menuItem(LABEL))));
      await t.shot('gone');
      await page.click(LABEL, menuItem(LABEL));
      await page.settle();
      t.expect(!(await page.evaluate<boolean>(`!!${DIALOG}`)), 'and it opens nothing');
    });

    await t.step('one no longer listed has it off, saying why', async () => {
      const { sessionId } = server.world.byName(NAMES.asked);
      await page.navigate(`/?view=all&session=${sessionId}`);
      await page.waitFor(`the ${NAMES.asked} view`, `${viewName} === ${q(NAMES.asked)}`, 10_000);
      server.world.unlist(sessionId);
      server.broadcast();
      await page.waitFor('the view to say it’s no longer listed', `${VIEW}?.textContent.includes('no longer listed')`);
      await openMenu();
      t.expectEqual(await page.evaluate(`${menuItem(LABEL)}?.getAttribute('aria-disabled')`), 'true', 'off once it has left the list');
      t.expect((await page.evaluate<string>(described(menuItem(LABEL)))).includes("It's no longer listed"), 'saying why', await page.evaluate(described(menuItem(LABEL))));
      await t.shot('unlisted');
      await page.click(LABEL, menuItem(LABEL));
      await page.settle();
      t.expect(!(await page.evaluate<boolean>(`!!${DIALOG}`)), 'and it opens nothing');
    });
  },
};

export default part;
