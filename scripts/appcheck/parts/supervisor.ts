// The supervisor (M5, W114; docs/design-system.md, 4: Supervisor): the repo list's item, first, above
// Needs you, with its status and its drafts' count, which Needs you and the page title count too; its
// view in the third column as ?supervisor, one history entry, in a session's place and back; a new
// conversation's questions, which fill the box; a message that starts it, the working line, and its
// reply as markdown; Load earlier; the draft cards, Edit and Send edit, Don't send, and where focus
// goes; Stop; held, with the stop command and the app strip's line; failed, with Start; a reload that
// starts nothing; and none with --no-supervisor. Made-up example/* content only.

import { NAMES, SUPERVISOR_APPROVALS } from '../fixtures.js';
import type { Part } from '../runner.js';
import { focused, listHeading, openFromRow, openRepoList, repoLabels, VIEW, viewClose } from './_dom.js';

const q = JSON.stringify;
const ITEM = `document.querySelector('nav[aria-label="Repos"] a[data-supervisor-item]')`;
const SVIEW = `document.querySelector('#supervisor-view')`;
const STATUS = `(${SVIEW}?.querySelector('[data-supervisor-status]')?.dataset.supervisorStatus ?? null)`;
const BOX = `${SVIEW}?.querySelector('.supervisor-box textarea')`;
const SEND = `${SVIEW}?.querySelector('.supervisor-box button[type="submit"]')`;
const STOP = `${SVIEW}?.querySelector('[data-supervisor-stop]')`;
const START = `${SVIEW}?.querySelector('[data-supervisor-start]')`;
const CARDS = `[...(${SVIEW}?.querySelectorAll('li.approval-card') ?? [])]`;
const cardButton = (index: number, label: string) => `[...(${CARDS}[${index}]?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${q(label)})`;
const NEEDS_YOU = `Number([...document.querySelectorAll('nav[aria-label="Repos"] a[data-repo-item]')].find((a) => a.querySelector('.repo-item-label')?.textContent === 'Needs you')?.querySelector('.badge')?.firstChild?.textContent ?? 0)`;
const TITLE_COUNT = `Number(/^\\((\\d+)\\)/.exec(document.title)?.[1] ?? 0)`;
/** The view's box against the window's: inside it, and full width at 600 px and narrower. */
const placed = `(() => { const r = ${SVIEW}.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom }; })()`;

const part: Part = {
  name: 'supervisor',
  title: 'The supervisor: its repo list item and counts, its view as ?supervisor, a message, its reply, the draft cards, Stop, held, failed, and no start on load',
  async run(t) {
    const { page, server } = t;
    // A fresh page gives the server new records, so they're read from it each time.
    const records = {
      get supervisorStarts() {
        return server.records.supervisorStarts;
      },
      get supervisorStops() {
        return server.records.supervisorStops;
      },
      get supervisorMessages() {
        return server.records.supervisorMessages;
      },
      get decisions() {
        return server.records.decisions;
      },
    };
    // Needs you's count and the title's, with both drafts waiting, for the steps that answer them.
    const counts = { needs: 0, title: 0 };
    /** A new conversation has no transcript yet: its GET is a 404, which the view shows as its empty state. */
    const allowNew = () => t.allow(/\/api\/supervisor\/conversation$/, 'a new conversation, with no transcript yet: the empty state');
    const closeIt = async () => {
      await page.click('Close', viewClose);
      await page.waitFor('the view to close', `!${SVIEW}`);
    };

    await t.step('the item: first, above Needs you, and nothing starts as the page loads', async () => {
      allowNew();
      await t.fresh({ search: '?view=all', supervisor: 'off' });
      await openRepoList(t);
      const labels = await page.evaluate<string[]>(repoLabels);
      t.expectEqual(labels.slice(0, 2), ['Supervisor', 'Needs you'], 'Supervisor first, then Needs you');
      t.expectEqual(await page.evaluate(`${ITEM}.getAttribute('href')`), '?view=all&supervisor', 'a link to its view');
      t.expectEqual([records.supervisorStarts.length, records.supervisorMessages.length], [0, 0], 'nothing started or sent');
      await t.shot('item');
    });

    await t.step('its view: in the third column as ?supervisor, one history entry, with focus on its heading', async () => {
      allowNew();
      await page.click('the Supervisor item', ITEM);
      await page.waitFor('the supervisor view', `!!${SVIEW}?.querySelector('h2')`);
      t.expectEqual(await page.evaluate('location.search'), '?view=all&supervisor', 'its place in the URL');
      t.expectEqual(await page.evaluate(focused), 'the view heading', 'focus on its heading');
      // One pushed entry: back closes it, and forward opens it again. (Chrome caps history.length at 50.)
      await page.evaluate('history.back()');
      await page.waitFor('back to the list alone', `!${SVIEW} && location.search === '?view=all'`);
      await page.evaluate('history.forward()');
      await page.waitFor('forward to the view again', `!!${SVIEW}?.querySelector('h2')`);
      const box = await page.evaluate<{ left: number; right: number; width: number }>(placed);
      t.expect(box.left >= -0.5 && box.right <= t.viewport.width + 0.5, 'inside the window', box);
      if (t.compact) t.expect(Math.abs(box.width - t.viewport.width) < 1, 'full width at 600 px and narrower', box);
      await page.waitFor('the new conversation', `!!${SVIEW}.querySelector('.supervisor-empty')`);
      t.expectEqual(await page.evaluate(`[...${SVIEW}.querySelectorAll('[data-suggestion]')].length`), 3, 'three questions to ask');
      t.expectEqual(records.supervisorStarts.length, 0, 'opening it started nothing');
      await t.shot('new-conversation');
    });

    await t.step('a question fills the box, and Send starts it: starting, working, then its reply as markdown', async () => {
      allowNew();
      await page.click('the first question', `${SVIEW}.querySelector('[data-suggestion]')`);
      t.expectEqual(await page.evaluate(`${BOX}.value`), 'Which sessions need me, and why?', 'the question, in the box');
      t.expectEqual(records.supervisorMessages.length, 0, 'and not sent');
      await page.click('Send', SEND);
      await page.waitFor('it to start', `${STATUS} === 'starting' || ${STATUS} === 'working'`);
      t.expectEqual(records.supervisorMessages, [{ length: 32, status: 200 }], 'sent once, as typed');
      await page.waitFor('it to work, with the working line', `${STATUS} === 'working' && !!${SVIEW}.querySelector('.working-line')`, 8_000);
      if (t.layout !== 'drawer') t.expectEqual(await page.evaluate(`${ITEM}.querySelector('.supervisor-item-status')?.textContent ?? null`), 'Working', 'the item says it works');
      await t.shot('working');
      await page.waitFor('its reply', `[...${SVIEW}.querySelectorAll('li.entry-assistant')].some((li) => li.querySelector('strong')?.textContent === 'pitwall-test-docs')`, 10_000);
      await page.waitFor('it to be idle', `${STATUS} === 'idle' && !${SVIEW}.querySelector('.working-line')`, 8_000);
      t.expect(await page.evaluate<boolean>(`[...${SVIEW}.querySelectorAll('li.entry-user')].some((li) => li.textContent.includes('Which sessions need me, and why?'))`), 'your message in its conversation');
      t.expectEqual(await page.evaluate(`${BOX}.value`), '', 'the box cleared');
      await t.shot('reply');
    });

    await t.step('Close gives focus back to the item, or the list’s heading where the repo list is a shut drawer', async () => {
      await closeIt();
      await page.settle(50);
      if (t.layout === 'drawer') t.expectEqual(await page.evaluate(focused), await page.evaluate(listHeading), 'the session list’s heading');
      else t.expect(await page.evaluate<boolean>(`document.activeElement === ${ITEM}`), 'the Supervisor item', await page.evaluate(focused));
    });

    await t.step('drafts: in its item’s count, Needs you’s and the title, as cards with headings, oldest first', async () => {
      await t.fresh({ search: '?view=all', supervisor: 'idle', approvals: true });
      await openRepoList(t);
      t.expectEqual(await page.evaluate(`${ITEM}.querySelector('.badge-attention')?.firstChild?.textContent ?? null`), '2', 'the item counts its two drafts');
      const needs = await page.evaluate<number>(NEEDS_YOU);
      t.expect(needs >= 2, 'Needs you counts them', needs);
      t.expectEqual(await page.evaluate<number>(TITLE_COUNT), needs, 'and the page title');
      counts.needs = needs;
      counts.title = needs;
      await page.click('the Supervisor item', ITEM);
      await page.waitFor('two cards', `${CARDS}.length === 2`);
      const headings = await page.evaluate<string[]>(`${CARDS}.map((li) => li.querySelector('h4').textContent)`);
      t.expectEqual(headings, ['Message to pitwall-test-review', 'New session in ~/code/demo-app, named pr-57'], 'what each would do, oldest first');
      t.expectEqual(await page.evaluate(`${SVIEW}.querySelector('.supervisor-approvals h3')?.textContent`), 'Drafts for you (2)', 'under their heading');
      await t.shot('cards');
    });

    await t.step('Edit, then Send edit: the edit sent, the card gone, and focus on the next card’s heading', async () => {
      await page.click('Edit', cardButton(0, 'Edit'));
      await page.waitFor('the editor, with focus', `document.activeElement?.matches('.approval-editor') === true`);
      const before = await page.evaluate<number>(`document.activeElement.value.length`);
      await page.type(' Thanks.');
      await t.shot('editing');
      await page.click('Send edit', cardButton(0, 'Send edit'));
      await page.waitFor('the card to go', `${CARDS}.length === 1`);
      t.expectEqual(records.decisions, [{ id: SUPERVISOR_APPROVALS.message, decision: 'edit', length: before + 8, status: 200 }], 'your edit, sent once');
      await page.waitFor('focus on the next card’s heading', `document.activeElement === ${CARDS}[0]?.querySelector('h4')`);
    });

    await t.step('Don’t send: the last card gone, focus in the message box, and the counts down by two', async () => {
      await page.click("Don't send", cardButton(0, "Don't send"));
      await page.waitFor('the cards to go', `${CARDS}.length === 0 && !${SVIEW}.querySelector('.supervisor-approvals')`);
      t.expectEqual(records.decisions.at(-1), { id: SUPERVISOR_APPROVALS.spawn, decision: 'decline', status: 200 }, 'declined');
      await page.waitFor('focus in the message box', `document.activeElement === ${BOX}`);
      await page.waitFor('what the supervisor was told', `[...${SVIEW}.querySelectorAll('li.entry-notice')].some((li) => li.textContent.includes("You didn't send it."))`);
      t.expectEqual(await page.evaluate<number>(TITLE_COUNT), counts.title - 2, 'the title counts two fewer');
      // Below 900 px the repo list is a drawer, shut now.
      if (t.layout !== 'drawer') t.expectEqual(await page.evaluate<number>(NEEDS_YOU), counts.needs - 2, 'and so does Needs you');
    });

    await t.step('Load earlier: its older turns', async () => {
      await page.waitFor('Load earlier', `!!${SVIEW}.querySelector('.load-earlier')`);
      await page.click('Load earlier', `${SVIEW}.querySelector('.load-earlier')`);
      await page.waitFor('the older turns', `[...${SVIEW}.querySelectorAll('li.entry-user')].some((li) => li.textContent.includes('Which sessions need me, and why?'))`);
    });

    await t.step('Stop: while it works, Stop stops its turn, and focus goes to the box', async () => {
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'working' });
      await page.waitFor('the working line', `!!${SVIEW}?.querySelector('.working-line')`);
      await page.click('Stop', STOP);
      await page.waitFor('it to stop', `${STATUS} === 'idle' && !${STOP}`, 5_000);
      t.expectEqual(records.supervisorStops, [200], 'stopped once');
      await page.waitFor('focus in the box', `document.activeElement === ${BOX}`);
      await page.waitFor('Claude Code’s notice', `[...${SVIEW}.querySelectorAll('li.entry-notice')].some((li) => li.textContent.includes('[Request interrupted by user]'))`);
    });

    await t.step('held: the error, the claude stop command to copy, Send off, and the app strip’s line', async () => {
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'held' });
      await page.waitFor('the held alert', `!!${SVIEW}?.querySelector('.supervisor-alert')`);
      t.expectEqual(await page.evaluate(`${SVIEW}.querySelector('.command-chip')?.textContent`), 'claude stop pt114bg1', 'the command it names');
      t.expect(await page.evaluate<boolean>(`!!${SVIEW}.querySelector('button[aria-label="Copy the stop command"]')`), 'with a copy button');
      t.expect((await page.evaluate<string>(`document.querySelector('[data-strip="supervisor"]')?.textContent ?? ''`)).startsWith("The supervisor can't run:"), 'the app strip says so');
      await page.click('the message box', BOX);
      await page.type('Hello');
      t.expectEqual(await page.evaluate(`${SEND}.getAttribute('aria-disabled')`), 'true', 'Send is off');
      await t.shot('held');
      t.allow(/\/api\/supervisor\/start$/, 'the 409 a held supervisor’s Start gets');
      await page.click('Start', START);
      await page.waitFor('its refusal', `!${SVIEW}.querySelector('[data-supervisor-start]')?.getAttribute('aria-busy')`);
      t.expectEqual(records.supervisorStarts, [409], 'asked once, and refused');
      t.expect(await page.evaluate<boolean>(`!${SVIEW}.querySelector('.supervisor-alert[role="alert"]')`), 'saying nothing the held alert doesn’t already say');
      t.expect(!(await page.evaluate<string>(`document.querySelector('[data-strip="supervisor"]')?.textContent ?? ''`)).includes('`'), 'the strip shows the command without backticks');
    });

    await t.step('failed: the error, and Start, which starts it', async () => {
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'failed' });
      await page.waitFor('the failed alert', `!!${SVIEW}?.querySelector('.supervisor-alert')`);
      await t.shot('failed');
      await page.click('Start', START);
      await page.waitFor('it to be idle', `${STATUS} === 'idle'`, 5_000);
      t.expectEqual(records.supervisorStarts, [200], 'started once');
    });

    await t.step('a reload with ?supervisor opens it, takes no focus and starts nothing', async () => {
      allowNew();
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'off' });
      await page.waitFor('the supervisor view', `!!${SVIEW}?.querySelector('h2')`);
      allowNew();
      await page.reload();
      await page.waitFor('the supervisor view again', `!!${SVIEW}?.querySelector('h2')`, 15_000);
      t.expectEqual(await page.evaluate(focused), 'the page', 'no focus taken');
      t.expectEqual([records.supervisorStarts.length, records.supervisorMessages.length], [0, 0], 'nothing started or sent');
    });

    if (t.layout === 'three-columns') {
      await t.step('a session opened takes its place, and the back button brings it back', async () => {
        allowNew();
        await openFromRow(t, NAMES.conversation);
        t.expect(await page.evaluate<boolean>(`!${SVIEW}`), 'the session view in its place');
        t.expect((await page.evaluate<string>('location.search')).includes('session='), 'the session in the URL', await page.evaluate('location.search'));
        await page.evaluate('history.back()');
        await page.waitFor('the supervisor view again', `!!${SVIEW}?.querySelector('h2')`);
        t.expect(await page.evaluate<boolean>(`!document.querySelector('#session-view')`), 'and the session view gone');
      });
    }

    await t.step('with --no-supervisor: no item, and ?supervisor says it’s off', async () => {
      await t.fresh({ search: '?view=all&supervisor' });
      await page.waitFor('the off view', `${VIEW}?.querySelector('h2')?.textContent === 'The supervisor is off'`);
      await openRepoList(t);
      t.expect(await page.evaluate<boolean>(`!${ITEM}`), 'no Supervisor item');
      t.expectEqual((await page.evaluate<string[]>(repoLabels))[0], 'Needs you', 'Needs you first, as before');
    });
  },
};

export default part;
