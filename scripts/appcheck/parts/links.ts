// Links in messages (docs/design-system.md, 4: Markdown in messages; W37, W55, W58): a bare URL, or a
// link whose text is its own address, opens on one click in a new tab with no opener or referrer; a
// link whose text isn't its own address asks first, after its paragraph, naming the real host, in
// punycode for a look-alike one, with focus on Cancel; Cancel and Escape open nothing, and Open link
// opens the real address.
//
// Nothing really opens: the page's init script records each click on a link to another origin after
// pitwall's own handlers, then stops it, and records window.open's calls in place of opening a tab.

import { LINKS, NAMES } from '../fixtures.js';
import type { PageRecords } from '../page.js';
import type { Part } from '../runner.js';
import { focused, openFromRow, VIEW } from './_dom.js';

const q = JSON.stringify;
const link = (text: string) => `[...${VIEW}.querySelectorAll('.entry-markdown a.md-link')].find((a) => a.textContent === ${q(text)})`;
const QUESTION = `${VIEW}?.querySelector('.entry-markdown .inline-confirm[role="alertdialog"]')`;
const button = (label: string) => `[...(${QUESTION}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${q(label)})`;
const NO_OPENER = 'noopener,noreferrer';

const part: Part = {
  name: 'links',
  title: 'Links in messages: a bare URL opens on one click; a link whose text is another address asks first',
  async run(t) {
    const { page } = t;
    const records = () => page.records() as Promise<PageRecords>;
    const lastClick = async () => (await records()).clicks.at(-1);

    await t.step('a bare URL opens on one click, in a new tab with no opener or referrer', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.conversation);
      await page.waitFor('the links', `!!${link(LINKS.bare)}`);
      await page.click('the bare URL', link(LINKS.bare));
      t.expectEqual(await lastClick(), { href: LINKS.bare, target: '_blank', rel: 'noopener noreferrer', prevented: false }, 'pitwall let the click open it, in a new tab with no opener or referrer');
      t.expect(!(await page.evaluate(`!!${QUESTION}`)), 'no question');
      t.expectEqual((await records()).opened, [], 'nothing else opened');
    });

    await t.step('a link whose text is another address asks first, naming the real host', async () => {
      await page.click('the misleading link', link(LINKS.misleadingText));
      await page.waitFor('the question', `!!${QUESTION}`);
      const asked = await page.evaluate<{ question: string; consequence: string; afterItsParagraph: boolean }>(`(() => {
        const box = ${QUESTION};
        return {
          question: box.querySelector('.inline-confirm-question').textContent,
          consequence: box.querySelector('.inline-confirm-consequence').textContent,
          afterItsParagraph: box.previousElementSibling?.contains(${link(LINKS.misleadingText)}) ?? false,
        };
      })()`);
      t.expectEqual(asked.question, 'Open this link to example.com?', 'the question names the real host');
      t.expectEqual(asked.consequence, `Its text doesn't show where it goes: ${LINKS.misleadingHref}`, 'and shows the full address');
      t.expect(asked.afterItsParagraph, 'it comes straight after the paragraph its link is in');
      t.expectEqual(await page.evaluate(focused), 'Cancel', 'focus is on Cancel');
      t.expectEqual((await lastClick())?.prevented, true, 'pitwall stopped the click');
      t.expectEqual((await records()).opened, [], 'nothing opened');
      await t.shot('asks');
    });

    await t.step('Cancel opens nothing, and focus goes back to the link', async () => {
      await page.click('Cancel', button('Cancel'));
      await page.waitFor('the question to go', `!${QUESTION}`);
      t.expect(await page.evaluate(`document.activeElement === ${link(LINKS.misleadingText)}`), 'focus is on the link', await page.evaluate(focused));
      t.expectEqual((await records()).opened, [], 'nothing opened');
    });

    await t.step('from the keyboard: Enter asks, and Open link opens the real address', async () => {
      await page.key('Enter');
      await page.waitFor('the question', `!!${QUESTION}`);
      t.expectEqual(await page.evaluate(focused), 'Cancel', 'Cancel has focus');
      await page.key('Tab');
      t.expectEqual(await page.evaluate(focused), 'Open link', 'Tab reaches Open link');
      await page.key('Enter');
      await page.waitFor('the question to go', `!${QUESTION}`);
      t.expectEqual((await records()).opened, [{ url: LINKS.misleadingHref, target: '_blank', features: NO_OPENER }], 'the real address, in a new tab with no opener or referrer');
      t.expect(await page.evaluate(`document.activeElement === ${link(LINKS.misleadingText)}`), 'focus is back on the link', await page.evaluate(focused));
    });

    await t.step('a look-alike host is named in punycode, and Escape opens nothing', async () => {
      await page.click('the dashboard link', link('the dashboard'));
      await page.waitFor('the question', `!!${QUESTION}`);
      t.expectEqual(await page.evaluate(`${QUESTION}.querySelector('.inline-confirm-question').textContent`), `Open this link to ${LINKS.lookAlikeHost}?`, 'the host, in punycode');
      t.expectEqual(await page.evaluate(`${QUESTION}.querySelector('code')?.textContent`), LINKS.lookAlikePunycode, 'the address, in punycode');
      await t.shot('asks-punycode');
      await page.key('Escape');
      await page.waitFor('the question to go', `!${QUESTION}`);
      t.expect(!!(await page.evaluate(`!!${VIEW}`)), 'the view stays open');
      t.expectEqual((await records()).opened.length, 1, 'nothing more opened');
    });

    await t.step('a link whose text is its own address opens on one click', async () => {
      await page.click('the changelog link', link(LINKS.ownAddress));
      t.expectEqual(await lastClick(), { href: LINKS.ownAddress, target: '_blank', rel: 'noopener noreferrer', prevented: false }, 'pitwall let the click open it');
      t.expect(!(await page.evaluate(`!!${QUESTION}`)), 'no question');
    });
  },
};

export default part;
