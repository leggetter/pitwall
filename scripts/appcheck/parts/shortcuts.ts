// The keyboard shortcuts dialog (docs/design-system.md, 4: Keyboard shortcuts dialog; 6.2): from the
// header or `?`, inside the window, closed by Close or Escape with focus back where it came from; its
// switch turns the single-key shortcuts off and on, and `n` follows it.

import type { Part } from '../runner.js';
import { DIALOG, dialogBox, dialogButton, dialogName, focused, headerButton, openDialog } from './_dom.js';

const SWITCH = `${DIALOG}?.querySelector('input[type="checkbox"]')`;
const blur = `(document.activeElement?.blur(), true)`;

const part: Part = {
  name: 'shortcuts',
  title: 'The keyboard shortcuts dialog: from the header and ?, Close and Escape, and its switch',
  async run(t) {
    const { page } = t;

    await t.step('opens from the header, with the shortcuts on', async () => {
      await t.fresh({ search: '?view=all' });
      await openDialog(t, 'Keyboard shortcuts');
      t.expectEqual(await page.evaluate(`${SWITCH}.labels[0]?.textContent`), 'Single-key shortcuts', "the switch's label");
      t.expect(await page.evaluate(`${SWITCH}.checked`), 'the switch is on');
      t.expectEqual(await page.evaluate(`[...${DIALOG}.querySelectorAll('h3')].map((h) => h.textContent)`), ['Anywhere', 'Lists', 'Session view', 'Menus and dialogs', 'Closing and moving'], 'the groups of shortcuts');
      t.expect(await page.evaluate(`document.activeElement === ${SWITCH}`), 'focus is on the switch, its first control', await page.evaluate(focused));
      const card = await page.evaluate<{ left: number; right: number; top: number; bottom: number }>(dialogBox);
      t.expect(card.left >= 15.5 && card.right <= t.viewport.width - 15.5 && card.top >= 0 && card.bottom <= t.viewport.height, 'inside the window', card);
      await t.shot('open');
    });

    await t.step('its Close button closes it, with focus back on its button', async () => {
      await page.click('Close', dialogButton('Close'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expect(await page.evaluate(`document.activeElement === ${headerButton('Keyboard shortcuts')}`), 'focus is back on Keyboard shortcuts', await page.evaluate(focused));
    });

    await t.step('? opens it, and Escape closes it', async () => {
      await page.evaluate(blur);
      await page.key('?');
      await page.waitFor('the dialog', `${dialogName} === 'Keyboard shortcuts'`);
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${DIALOG}`);
    });

    await t.step('the switch turns the single-key shortcuts off, and n then opens nothing', async () => {
      await openDialog(t, 'Keyboard shortcuts');
      await page.click('the switch', SWITCH);
      t.expect(!(await page.evaluate(`${SWITCH}.checked`)), 'the switch is off');
      t.expectEqual(await page.evaluate(`localStorage.getItem('pitwall.shortcuts.v1')`), 'off', 'stored');
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      await page.evaluate(blur);
      await page.key('n');
      await page.settle(150);
      t.expect(!(await page.evaluate(`!!${DIALOG}`)), "n opens nothing while they're off");
      t.expect(await page.evaluate(`!!${headerButton('Keyboard shortcuts')}`), 'the shortcuts button is still there, to turn them on');
    });

    await t.step('on again, n opens New session', async () => {
      await openDialog(t, 'Keyboard shortcuts');
      await page.click('the switch', SWITCH);
      t.expect(await page.evaluate(`${SWITCH}.checked`), 'the switch is on');
      t.expectEqual(await page.evaluate(`localStorage.getItem('pitwall.shortcuts.v1')`), 'on', 'stored');
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      await page.evaluate(blur);
      await page.key('n');
      await page.waitFor('New session', `${dialogName} === 'New session'`);
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${DIALOG}`);
    });
  },
};

export default part;
