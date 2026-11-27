// Leads and workers (W218; docs/design-system.md, 4: Leads and workers): a lead's row with "Lead", its
// count and a caret; its workers indented under it with a guide line, one from another repo named; the
// caret closing them, with the most urgent state on the lead's row, and opening them again after a
// reload; the pointer a worker leaves in its own repo group; "under <lead>" in Needs you; the session
// view's menu items and Report to…'s dialog; and a worker's "worker for <lead>" line. Nothing overflows.
// W218 piece 2: the paragraph Start a worker… adds after the prompt, shown above New session's fields;
// Report to…'s second step, Copy message for a background session and Send for an interactive one; and a
// worker's "reported HH:MM" on its row, which opens it on its Conversation tab.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { briefText } from '../server.js';
import { chooseInRepoList, DIALOG, dialogButton, dialogName, openFromRow, row, VIEW, toasts, viewClose, viewName, viewTab } from './_dom.js';

const q = JSON.stringify;
const LEAD = NAMES.conversation;
const CARET = `document.querySelector(${q(`.session-list button[aria-label="Workers of ${LEAD}"]`)})`;
const LEAD_ROW = `${row(LEAD)}?.closest('li.session')`;
const WORKERS = `document.querySelector('.session-list ul.lead-workers')`;
const BRIEF_IN_DIALOG = `${DIALOG}?.querySelector('.worker-brief-text')`;
const POINTER = `document.querySelector('.session-list [data-lead-pointer]')`;
const MENU_BUTTON = `${VIEW}?.querySelector('button[aria-label="Session actions"]')`;
const ITEMS = `[...(${VIEW}?.querySelectorAll('[role="menu"] [role="menuitem"]') ?? [])].map((item) => item.textContent.trim())`;
const menuItem = (label: string) => `[...(${VIEW}?.querySelectorAll('[role="menuitem"]') ?? [])].find((item) => item.textContent.trim() === ${q(label)})`;
/** Whether anything in the list is wider than the list. */
const OVERFLOW = `(() => { const list = document.querySelector('.session-list-body'); return list.scrollWidth > list.clientWidth + 1; })()`;

const part: Part = {
  name: 'leads',
  title: 'Leads and workers: a lead’s workers indented under it, the caret open and closed through a reload, the pointer in a worker’s own repo, under <lead> in Needs you, the menu items, Report to… and worker for <lead>, the worker’s paragraph in Start a worker… and Report to…’s second step, and reported HH:MM',
  async run(t) {
    const { page, server } = t;
    const id = (name: string) => server.world.byName(name).sessionId;
    const setUp = async (search: string) => {
      await t.fresh({ search, prs: 'off' });
      // pitwall-test-api leads three: one in demo-app, one in demo-app that needs you, one in api-server.
      server.world.leads(id(LEAD), [id(NAMES.running2), id(NAMES.waiting), id(NAMES.inApi)]);
      server.broadcast();
    };
    // At 375 the view covers the list, so close it before the next row.
    const closeView = async () => {
      await page.click('Close', viewClose);
      await page.waitFor('the view to close', `!${VIEW}`);
    };

    await t.step('a lead’s workers are indented under it, open, the one from api-server named', async () => {
      await setUp('?view=needs-you');
      await chooseInRepoList(t, 'demo-app');
      await page.waitFor('the lead’s caret', `!!${CARET}`);
      const state = await page.evaluate<Record<string, unknown>>(`(() => ({
        expanded: ${CARET}.getAttribute('aria-expanded'),
        badge: ${LEAD_ROW}.querySelector('.session-lead-badge')?.textContent,
        count: ${LEAD_ROW}.querySelector('.session-lead-workers')?.textContent,
        workers: [...${WORKERS}.querySelectorAll('[data-open-session]')].map((b) => b.textContent.trim()),
        repo: [...${WORKERS}.querySelectorAll('li.session')].map((li) => li.querySelector('.session-group')?.textContent ?? null),
        indented: ${WORKERS}.querySelector('li.session .session-open').getBoundingClientRect().left > ${row(LEAD)}.getBoundingClientRect().left,
        // How far the guide line's middle is from the caret's.
        offset: (() => { const c = ${CARET}.getBoundingClientRect(); const line = ${WORKERS}.getBoundingClientRect().left + parseFloat(getComputedStyle(${WORKERS}, '::before').left) + 0.5; return Math.abs(c.left + c.width / 2 - line); })(),
      }))()`);
      t.expectEqual(state.expanded, 'true', 'open by default');
      t.expectEqual([state.badge, state.count], ['Lead', '3 workers'], 'Lead, and the count first on line 2');
      t.expectEqual(state.workers, [NAMES.running2, NAMES.waiting, NAMES.inApi], 'its workers, oldest link first');
      t.expectEqual(state.repo, [null, null, 'api-server'], 'only the one from another repo is named');
      t.expect(state.indented === true, 'the workers are indented');
      t.expect((state.offset as number) <= 1, 'the guide line is under the caret', String(state.offset));
      t.expect(!(await page.evaluate<boolean>(OVERFLOW)), 'nothing overflows the list');
      await t.shot('open');
    });

    await t.step('the caret closes them, and the lead’s row says one needs you; closed after a reload', async () => {
      await page.click('the caret', CARET);
      await page.waitFor('closed', `${CARET}.getAttribute('aria-expanded') === 'false'`);
      t.expect(await page.evaluate<boolean>(`${WORKERS}.hidden`), 'the workers are hidden');
      t.expectEqual(await page.evaluate(`${LEAD_ROW}.querySelector('.session-lead-workers')?.textContent`), '3 workers, 1 needs you', 'the most urgent state');
      await t.shot('closed');
      await page.reload();
      server.world.leads(id(LEAD), [id(NAMES.running2), id(NAMES.waiting), id(NAMES.inApi)]);
      server.broadcast();
      await page.waitFor('the lead’s caret', `!!${CARET}`);
      t.expectEqual(await page.evaluate(`${CARET}.getAttribute('aria-expanded')`), 'false', 'still closed');
      await page.click('the caret', CARET);
      await page.waitFor('open', `${CARET}.getAttribute('aria-expanded') === 'true'`);
    });

    await t.step('api-server keeps a pointer to the worker under its lead', async () => {
      await chooseInRepoList(t, 'api-server');
      await page.waitFor('the pointer', `!!${POINTER}`);
      t.expectEqual(await page.evaluate(`${POINTER}.textContent`), `${NAMES.inApi}↳ under ${LEAD} (demo-app)`, 'the pointer, in words');
      t.expect(!(await page.evaluate<boolean>(OVERFLOW)), 'nothing overflows the list');
      await t.shot('pointer');
    });

    await t.step('Needs you says which lead a worker is under', async () => {
      await setUp('?view=needs-you');
      const group = `${row(NAMES.waiting)}?.closest('li.session')?.querySelector('.session-group')?.textContent`;
      await page.waitFor('under the lead', `(${group} ?? '').includes('under')`);
      const label = await page.evaluate(group);
      t.expectEqual(label, `demo-app · under ${LEAD}`, 'under the lead');
      t.expect(!(await page.evaluate<boolean>(`!!${POINTER}`)), 'no pointers');
    });

    await t.step('the lead’s menu has Start a worker… and Not a lead; a worker’s view says whose it is', async () => {
      await setUp('?view=all');
      await page.waitFor('the lead’s caret', `!!${CARET}`);
      await openFromRow(t, LEAD);
      await page.click('Session actions', MENU_BUTTON);
      const items = await page.evaluate<string[]>(ITEMS);
      t.expect(items.includes('Start a worker…') && items.includes('Not a lead'), 'the lead’s items', items.join(', '));
      await page.click('Session actions', MENU_BUTTON);
      await closeView();
      await openFromRow(t, NAMES.running2);
      const line = `${VIEW}?.querySelector('[data-worker-for]')`;
      await page.waitFor('worker for', `!!${line}`);
      t.expectEqual(await page.evaluate(`${line}.textContent`), `worker for ${LEAD}`, 'worker for the lead');
      await t.shot('worker-view');
      await page.click('the lead’s link', `${line}.querySelector('button')`);
      await page.waitFor('the lead’s view', `${viewName} === ${q(LEAD)}`);
      await closeView();
    });

    await t.step('Report to… lists the leads in a radio group', async () => {
      await openFromRow(t, NAMES.running);
      await page.click('Session actions', MENU_BUTTON);
      const items = await page.evaluate<string[]>(ITEMS);
      t.expect(items.includes('Make lead') && items.includes('Report to…'), 'Make lead and Report to…', items.join(', '));
      await t.shot('menu');
      await page.click('Report to…', menuItem('Report to…'));
      await page.waitFor('the dialog', `${dialogName} === 'Report to a lead'`);
      const radios = await page.evaluate<string[]>(`[...${DIALOG}.querySelectorAll('.radio-option label')].map((l) => l.textContent)`);
      t.expectEqual(radios, [LEAD], 'the one lead');
      await t.shot('report-to');
      await page.click('Report to lead', dialogButton('Report to lead'));
      await page.waitFor('the second step', `${dialogName} === 'Tell it where to report' && !!${BRIEF_IN_DIALOG}`);
      const step = await page.evaluate<Record<string, unknown>>(`(() => ({
        text: ${BRIEF_IN_DIALOG}.textContent,
        copy: !!${dialogButton('Copy message')},
        send: !!${dialogButton('Send')},
        boxed: getComputedStyle(${BRIEF_IN_DIALOG}).backgroundColor !== getComputedStyle(${DIALOG}).backgroundColor,
        wide: ${DIALOG}.scrollWidth > ${DIALOG}.clientWidth + 1,
      }))()`);
      t.expectEqual(step.text, briefText(LEAD), 'the server’s paragraph, as it is');
      t.expectEqual([step.copy, step.send], [true, false], 'a background session gets Copy message, not Send');
      t.expect(step.boxed === true, 'the paragraph sits in its quiet box');
      t.expect(step.wide === false, 'nothing overflows the dialog');
      await t.shot('tell-worker-copy');
      await page.click('Done', dialogButton('Done'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      await closeView();
    });

    await t.step('Report to… on an interactive session offers Send, which sends the paragraph through the relay', async () => {
      await openFromRow(t, NAMES.asked);
      await page.click('Session actions', MENU_BUTTON);
      await page.click('Report to…', menuItem('Report to…'));
      await page.waitFor('the dialog', `${dialogName} === 'Report to a lead'`);
      await page.click('Report to lead', dialogButton('Report to lead'));
      await page.waitFor('the second step', `${dialogName} === 'Tell it where to report' && !!${dialogButton('Send')}`);
      t.expectEqual(server.records.relays.length, 0, 'nothing sent before Send');
      await t.shot('tell-worker-send');
      await page.click('Send', dialogButton('Send'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expectEqual(server.records.relays, [{ name: NAMES.asked, length: briefText(LEAD).length }], 'the paragraph, sent once');
      await page.waitFor('the toast', `${toasts}.includes(${q(`Sent to ${NAMES.asked}.`)})`);
      // At 375 the toasts cover the dialogs' buttons that follow: Report to…'s and this one.
      await page.evaluate(`document.querySelectorAll('.toasts .toast:not(.leaving) .toast-dismiss').forEach((b) => b.click())`);
      await page.waitFor('the toasts to go', `${toasts}.length === 0`);
      await closeView();
    });

    await t.step('Start a worker… shows the paragraph it adds after the prompt, above New session’s fields', async () => {
      await openFromRow(t, LEAD);
      await page.click('Session actions', MENU_BUTTON);
      await page.click('Start a worker…', menuItem('Start a worker…'));
      await page.waitFor('New session with the paragraph', `${dialogName} === 'New session' && !!${DIALOG}.querySelector('[data-worker-brief="ok"]')`);
      const notice = await page.evaluate<Record<string, unknown>>(`(() => { const n = ${DIALOG}.querySelector('[data-worker-brief="ok"]'); return {
        label: n.querySelector('.field-label')?.textContent,
        text: n.querySelector('.worker-brief-text')?.textContent,
        above: n.getBoundingClientRect().top < ${DIALOG}.querySelector('textarea').getBoundingClientRect().top,
      }; })()`);
      t.expectEqual([notice.label, notice.text], ['Added after your prompt', briefText(LEAD)], 'the label and the paragraph');
      t.expect(notice.above === true, 'above the first prompt');
      await t.shot('start-worker');
      await page.click('Cancel', dialogButton('Cancel'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      await closeView();
    });

    await t.step('a worker’s row says when it last reported, a link to its Conversation tab', async () => {
      server.world.reported(id(NAMES.running2), new Date(Date.now() - 7 * 60_000).toISOString());
      server.broadcast();
      const link = `${row(NAMES.running2)}?.closest('li.session')?.querySelector('[data-reported]')`;
      await page.waitFor('reported', `!!${link}`);
      const shown = await page.evaluate<Record<string, unknown>>(`(() => { const l = ${link}; return {
        text: l.textContent,
        name: l.getAttribute('aria-label'),
      }; })()`);
      t.expect(/^reported \d{1,2}:\d{2}/.test(String(shown.text)), 'reported HH:MM', String(shown.text));
      t.expect(String(shown.name).endsWith(': open its conversation'), 'its name says what it opens', String(shown.name));
      t.expect(!(await page.evaluate<boolean>(OVERFLOW)), 'nothing overflows the list');
      await t.shot('reported');
      await page.click('reported', link);
      await page.waitFor('the worker’s view', `${viewName} === ${q(NAMES.running2)}`);
      t.expectEqual(await page.evaluate(viewTab), 'Conversation', 'on its Conversation tab');
      await closeView();
    });
  },
};

export default part;
