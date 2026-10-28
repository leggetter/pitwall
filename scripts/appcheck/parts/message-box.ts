// The message box (docs/design-system.md, 4: Message box): at the foot of an interactive session's
// view, Send waits for text, Enter adds a line and ⌘↵ sends, a draft survives a reload in the tab,
// and a delivered message shows its result, clears the draft, keeps focus in the box, and shows on
// the box's exchange line once the next snapshot says so. The fake server answers the relay with
// "delivered" after a moment, and records what it was sent.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { openFromRow, VIEW, viewName } from './_dom.js';

const q = JSON.stringify;
const BOX = `${VIEW}?.querySelector('.relay-box textarea')`;
const SEND = `${VIEW}?.querySelector('.relay-box button[type="submit"]')`;
const RESULT = `${VIEW}?.querySelector('.relay-box .relay-result')`;
const DELIVERED = "Delivered. It's in the session's inbox: it reads it at its next step, or starts a turn if it's idle.";
const DRAFT = ['A made-up message for the app check.', 'On a second line.'];

const part: Part = {
  name: 'message-box',
  title: 'The message box: a draft that survives a reload, and a message sent with ⌘↵ and delivered',
  async run(t) {
    const { page, server } = t;

    await t.step('Send waits for something to send', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.conversation);
      await page.waitFor('the message box', `!!${BOX}`);
      t.expectEqual(await page.evaluate(`${BOX}.labels[0]?.textContent`), `Message to ${NAMES.conversation}`, "the box's label names the session");
      t.expectEqual(await page.evaluate(`${SEND}.getAttribute('aria-disabled')`), 'true', 'Send is aria-disabled while the box is empty');
      t.expectEqual(await page.evaluate(`${SEND}.textContent.trim()`), 'Send', "Send's label");
    });

    await t.step('a draft: Enter adds a line, and a reload keeps it', async () => {
      await page.click('the message box', BOX);
      await page.type(DRAFT[0]!);
      await page.key('Enter');
      await page.type(DRAFT[1]!);
      t.expectEqual(await page.evaluate(`${BOX}.value`), DRAFT.join('\n'), 'the draft, on two lines');
      t.expect((await page.evaluate(`${SEND}.getAttribute('aria-disabled')`)) !== 'true', 'Send can send it');
      t.expect(server.records.relays.length === 0, 'nothing sent yet', server.records.relays);
      await t.shot('draft');
      await page.reload();
      await page.waitFor('the view after the reload', `${viewName} === ${q(NAMES.conversation)} && !!${BOX}`, 10_000);
      t.expectEqual(await page.evaluate(`${BOX}.value`), DRAFT.join('\n'), 'the draft is back after the reload');
      t.expect(server.records.relays.length === 0, 'and still nothing sent', server.records.relays);
    });

    await t.step('⌘↵ sends it, and it is delivered', async () => {
      await page.click('the message box', BOX);
      await page.key('Enter', { meta: true });
      await page.waitFor('Send to say it is sending', `${SEND}?.textContent.includes('Sending')`, 2000);
      await page.waitFor('the result', `${RESULT}?.textContent.includes('Delivered')`, 5000);
      t.expectEqual(await page.evaluate(`${RESULT}.textContent.trim()`), DELIVERED, 'the result says it was delivered');
      t.expectEqual(await page.evaluate(`${RESULT}.getAttribute('role')`), 'status', 'a delivered result is a status, not an alert');
      t.expectEqual(await page.evaluate(`${BOX}.value`), '', 'the draft is cleared');
      t.expect(await page.evaluate(`document.activeElement === ${BOX}`), 'focus stays in the box');
      t.expectEqual(server.records.relays, [{ name: NAMES.conversation, length: DRAFT.join('\n').length }], 'the fake server got it, once, for this session');
      t.expectEqual(await page.evaluate(`${SEND}.getAttribute('aria-disabled')`), 'true', 'Send waits again');
    });

    await t.step('the exchange line shows it once the snapshot does', async () => {
      await page.waitFor('the exchange line', `${VIEW}.querySelector('.relay-exchange-line')?.textContent.includes('delivered')`, 5000);
      t.expect(await page.evaluate(`${VIEW}.querySelector('.relay-exchange-line').textContent.startsWith('Message from pitwall')`), 'it says it was a message from pitwall');
      await t.shot('delivered');
    });
  },
};

export default part;
