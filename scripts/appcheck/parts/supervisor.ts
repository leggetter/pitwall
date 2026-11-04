// The supervisor (M5, W114; docs/design-system.md, 4: Supervisor): the repo list's item, first, above
// Needs you, with its status and its drafts' count, which Needs you and the page title count too; its
// view in the third column as ?supervisor, one history entry, in a session's place and back; a new
// conversation's questions, which fill the box; a message that starts it, the working line, and its
// reply as markdown; its limit, 100,000 characters (W134); Load earlier; the draft cards, Edit and Send edit, Don't send, and where focus
// goes; what it sent and started, with each session's state, Needs you's notice and Open (W124); a
// resume draft for a finished session and its "Resumed" row (W127); the sessions and PRs its replies name, which open them (W125); Stop; held, with the stop command and the app strip's line; failed, with Start; a reload that
// starts nothing; its context in the header, New conversation with its confirmation, cancelled,
// confirmed and refused, and a draft's text up to half the window (W136); and none with
// --no-supervisor. Made-up example/* content only.

import { NAMES, SUPERVISOR_APPROVALS, SUPERVISOR_RACE_REFUSAL } from '../fixtures.js';
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
const NEW = `${SVIEW}?.querySelector('[data-supervisor-new]')`;
const CONFIRM_BOX = `${SVIEW}?.querySelector('[data-supervisor-new-confirm] .inline-confirm')`;
const confirmButton = (label: string) => `[...(${CONFIRM_BOX}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${q(label)})`;
const CONTEXT = `(${SVIEW}?.querySelector('[data-supervisor-context]')?.textContent?.trim() ?? null)`;
const CARDS = `[...(${SVIEW}?.querySelectorAll('li.approval-card') ?? [])]`;
const HANDOFFS = `[...(${SVIEW}?.querySelectorAll('[data-supervisor-handoffs] li.supervisor-handoff') ?? [])]`;
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
      get newConversations() {
        return server.records.supervisorNewConversations;
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
      // W136: its first call of the run says how big its context is.
      await page.waitFor('its context in the header', `${CONTEXT} === 'Context 21K'`);
      await t.shot('reply');
    });

    await t.step('its limit (W134): Send is on at 100,000 characters and off at one more, saying so; nothing sent', async () => {
      const fill = (length: number) =>
        page.evaluate(`(() => {
          const box = ${BOX};
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'x'.repeat(${length}));
          box.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
      const COUNT = `(${SVIEW}.querySelector('.supervisor-box .relay-count')?.textContent ?? null)`;
      const SEND_OFF = `${SEND}.getAttribute('aria-disabled') === 'true'`;
      await fill(100_000);
      await page.waitFor('the count at the limit', `${COUNT} === '100,000 / 100,000'`);
      t.expect(!(await page.evaluate<boolean>(SEND_OFF)), 'Send is on at the limit');
      await fill(100_001);
      await page.waitFor('the count over the limit', `${COUNT} === '1 character over the 100,000 limit'`);
      t.expect(await page.evaluate<boolean>(SEND_OFF), 'Send is off over it');
      await t.shot('over-limit');
      await fill(0);
      await page.waitFor('the box empty', `${BOX}.value === '' && ${COUNT} === null`);
      t.expectEqual(records.supervisorMessages.length, 1, 'nothing more sent');
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

    await t.step('sent and started (W124): each session with its state, Needs you’s notice, and Open, which opens it', async () => {
      await t.fresh({ search: '?view=all', supervisor: 'idle', approvals: true });
      await openRepoList(t);
      await page.click('the Supervisor item', ITEM);
      await page.waitFor('two cards', `${CARDS}.length === 2`);
      await page.click('Send', cardButton(0, 'Send'));
      await page.waitFor('the message’s row', `${HANDOFFS}.length === 1`);
      await page.waitFor('focus on the next card’s heading', `document.activeElement === ${CARDS}[0]?.querySelector('h4')`);
      await page.click('Send', cardButton(0, 'Send'));
      await page.waitFor('both rows', `${HANDOFFS}.length === 2 && ${CARDS}.length === 0`);
      const rows = await page.evaluate<{ what: string; needs: string | null; open: string | null }[]>(
        `${HANDOFFS}.map((li) => ({ what: li.querySelector('.supervisor-handoff-what').textContent, needs: li.querySelector('[data-handoff-needs]')?.textContent ?? null, open: li.querySelector('[data-handoff-open]')?.textContent ?? null }))`,
      );
      t.expectEqual(
        rows,
        [
          { what: 'Started pr-57', needs: 'pr-57 needs you: Which base branch should the made-up review compare against?', open: 'Open pr-57 →' },
          { what: `Message approved for ${NAMES.asked}`, needs: rows[1]?.needs ?? null, open: `Open ${NAMES.asked} →` },
        ],
        'needs you first, each with its Open',
      );
      t.expectEqual(await page.evaluate(`${SVIEW}.querySelector('[data-supervisor-handoffs] h3')?.textContent`), 'Sent and started (2)', 'under their heading');
      const box = await page.evaluate<{ right: number }>(`(() => { const r = ${HANDOFFS}[0].querySelector('[data-handoff-open]').getBoundingClientRect(); return { right: r.right }; })()`);
      t.expect(box.right <= t.viewport.width + 0.5, 'Open inside the window', box);
      await t.shot('handoffs');
      await page.click('Open pr-57', `${HANDOFFS}[0].querySelector('[data-handoff-open]')`);
      await page.waitFor('its session view, in the supervisor’s place', `!${SVIEW} && !!document.querySelector('#session-view')`);
      t.expect((await page.evaluate<string>('location.search')).includes('session='), 'the session in the URL', await page.evaluate('location.search'));
      t.expectEqual(await page.evaluate(`document.querySelector('#session-view h2 .session-view-name')?.textContent ?? null`), 'pr-57', 'the session it started');
    });

    await t.step('long drafts (W120, W136): the exact text, up to half the window, its length said only when it scrolls, and a no-break space drawn as its code', async () => {
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'idle', approvals: 'long' });
      await page.waitFor('two cards', `${CARDS}.length === 2`);
      const [card, longer] = [`${CARDS}[0]`, `${CARDS}[1]`];
      /** A card's text box: its height, what it holds, eight lines' height, and half the window. */
      const measure = (which: string) =>
        page.evaluate<{ height: number; content: number; eight: number; half: number }>(
          `(() => { const box = ${which}.querySelector('.approval-text'); const s = getComputedStyle(box); const eight = 8 * parseFloat(s.lineHeight) + parseFloat(s.paddingTop) + parseFloat(s.paddingBottom); return { height: box.clientHeight, content: box.scrollHeight, eight, half: innerHeight / 2 }; })()`,
        );
      // 14 lines: taller than the 8 lines a box had before W136. Where they fit, as at 1,200 px, no length
      // note; where they wrap past half the window, as at 375 px, the note: exactly when it scrolls.
      const first = await measure(card);
      const scrolls = first.content > first.height + 1;
      t.expect(first.height > first.eight + 1, 'the box taller than 8 lines', first);
      if (!t.compact) t.expect(!scrolls, '14 lines shown whole on a wide, tall window', first);
      const codeNote = "Drawn as their codes, since they don't show as themselves: U+00A0 NO-BREAK SPACE.";
      t.expectEqual(
        await page.evaluate(`${card}.querySelector('.approval-length')?.textContent ?? null`),
        scrolls ? `14 lines, 679 characters: scroll to read it all before you send it. ${codeNote}` : codeNote,
        'its length said exactly when it scrolls, and the code',
      );
      t.expectEqual(await page.evaluate(`[...${card}.querySelectorAll('.approval-hidden')].map((each) => each.textContent)`), ['U+00A0'], 'the no-break space as its code');
      // 60 lines: the box at half the window, then it scrolls, saying how long it is.
      const second = await measure(longer);
      t.expect(Math.abs(second.height - second.half) <= 2 && second.content > second.height + 1, 'the box at half the window, the text scrolling in it', second);
      t.expect(/^60 lines, [\d,]+ characters: scroll to read it all before you send it\.$/.test(await page.evaluate<string>(`${longer}.querySelector('.approval-length')?.textContent ?? ''`)), 'its length said under it');
      t.expect(await page.evaluate<boolean>(`${longer}.querySelector('.approval-text').getAttribute('role') === 'region'`), 'a Tab stop while it scrolls');
      // The band grows past the 40% it was, up to 70% of the view, so the long card is read in it; and
      // the message box stays whole under it.
      const band = await page.evaluate<{ band: number; view: number; footBottom: number; viewBottom: number }>(
        `(() => { const v = ${SVIEW}.getBoundingClientRect(); const b = ${SVIEW}.querySelector('.supervisor-approvals').getBoundingClientRect(); const f = ${SVIEW}.querySelector('.supervisor-foot').getBoundingClientRect(); return { band: b.height, view: v.height, footBottom: f.bottom, viewBottom: v.bottom }; })()`,
      );
      t.expect(band.band > 0.4 * band.view + 1 && band.band <= 0.7 * band.view + 1, 'the band past 40% of the view, and within 70%', band);
      t.expect(band.footBottom <= band.viewBottom + 0.5, 'the message box whole under it', band);
      // A long conversation behind it doesn't squeeze the band (W141): before, the conversation and
      // the band shrank in proportion to their content, so a long one left the band only its heading.
      const tall = await page.evaluate<{ band: number; view: number }>(
        `(() => { const body = ${SVIEW}.querySelector('.session-view-body'); const pad = document.createElement('div'); pad.className = 'appcheck-tall'; pad.style.height = '20000px'; body.append(pad); const v = ${SVIEW}.getBoundingClientRect(); const b = ${SVIEW}.querySelector('.supervisor-approvals').getBoundingClientRect(); const out = { band: b.height, view: v.height }; pad.remove(); return out; })()`,
      );
      t.expect(Math.abs(tall.band - band.band) <= 1, 'the band as tall with a long conversation behind it', { tall, band });
      await page.evaluate(`${SVIEW}.querySelector('.supervisor-approvals-scroll')?.scrollTo(0, 0)`);
      await t.shot('long-draft');
      // Its editor grows as far, then scrolls.
      await page.click('Edit', cardButton(1, 'Edit'));
      await page.waitFor('the editor', `!!${longer}.querySelector('.approval-editor')`);
      const editor = await page.evaluate<{ height: number; half: number }>(`(() => { const e = ${longer}.querySelector('.approval-editor'); return { height: e.getBoundingClientRect().height, half: innerHeight / 2 }; })()`);
      t.expect(Math.abs(editor.height - editor.half) <= 2, 'the editor as tall as half the window', editor);
      await page.click('Cancel', cardButton(1, 'Cancel'));
      t.expectEqual(records.decisions, [], 'nothing decided');
    });

    await t.step('its context and New conversation (W136): the gauge, then the confirmation in the page, cancelled, then confirmed', async () => {
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'idle' });
      await page.waitFor('its conversation', `[...${SVIEW}.querySelectorAll('li.entry-assistant')].length > 0`);
      t.expectEqual(await page.evaluate(CONTEXT), 'Context 84K', 'its context, as the session view says one');
      const line = await page.evaluate<{ fits: boolean; right: number }>(
        `(() => { const meta = ${SVIEW}.querySelector('.session-view-meta').getBoundingClientRect(); const b = ${NEW}.getBoundingClientRect(); return { fits: b.right <= meta.right + 0.5 && b.left >= meta.left - 0.5, right: b.right }; })()`,
      );
      t.expect(line.fits, 'New conversation inside the header', line);
      await t.shot('context');
      await page.click('New conversation', NEW);
      await page.waitFor('the confirmation, with focus on Cancel', `!!${CONFIRM_BOX} && document.activeElement === ${confirmButton('Cancel')}`);
      t.expectEqual(await page.evaluate(`${CONFIRM_BOX}.querySelector('.inline-confirm-question').textContent`), 'Start a new conversation?', 'what it asks');
      await t.shot('new-confirm');
      await page.click('Cancel', confirmButton('Cancel'));
      await page.waitFor('the confirmation gone, focus back on the button', `!${CONFIRM_BOX} && document.activeElement === ${NEW}`);
      t.expectEqual(records.newConversations, [], 'nothing asked of the server');
      await page.click('New conversation', NEW);
      await page.waitFor('the confirmation', `!!${CONFIRM_BOX}`);
      allowNew();
      await page.click('Start new conversation', confirmButton('Start new conversation'));
      await page.waitFor('the new conversation’s empty state', `!${CONFIRM_BOX} && !!${SVIEW}.querySelector('.supervisor-empty') && ${STATUS} === 'off'`);
      t.expectEqual(records.newConversations, [200], 'asked once');
      t.expectEqual(await page.evaluate(CONTEXT), null, 'no context until its next call');
      t.expect(await page.evaluate<boolean>(`[...${SVIEW}.querySelectorAll('li.entry-assistant')].length === 0`), 'nothing of the old conversation');
      t.expect(await page.evaluate<boolean>(`(document.querySelector('.toast-message')?.textContent ?? '').includes('New conversation.')`), 'a toast says so');
      await page.waitFor('focus in the message box', `document.activeElement === ${BOX}`);
      t.expectEqual([records.supervisorStarts.length, records.supervisorMessages.length], [0, 0], 'nothing started or sent');
      await t.shot('new-done');
    });

    await t.step('New conversation refused (W136): off while drafts wait, and the server’s reason when another tab started it', async () => {
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'idle', approvals: true });
      await page.waitFor('two cards', `${CARDS}.length === 2`);
      t.expectEqual(await page.evaluate(`${NEW}.getAttribute('aria-disabled')`), 'true', 'off while drafts wait');
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'failed', supervisorRaced: true });
      await page.waitFor('the failed alert', `!!${SVIEW}?.querySelector('.supervisor-alert')`);
      await page.click('New conversation', NEW);
      await page.waitFor('the confirmation', `!!${CONFIRM_BOX}`);
      t.allow(/\/api\/supervisor\/new-conversation$/, 'the 409 New conversation gets once another tab started it');
      await page.click('Start new conversation', confirmButton('Start new conversation'));
      await page.waitFor('its refusal', `!${CONFIRM_BOX} && !!${SVIEW}.querySelector('[data-supervisor-new-confirm] [role="alert"]')`);
      t.expectEqual(records.newConversations, [409], 'asked once, and refused');
      t.expectEqual(await page.evaluate(`${SVIEW}.querySelector('[data-supervisor-new-confirm] [role="alert"]').textContent`), `Couldn't start a new conversation. ${SUPERVISOR_RACE_REFUSAL}`, 'saying why, in pitwall’s words');
      t.expect(await page.evaluate<boolean>(`document.activeElement === ${NEW}`), 'focus back on the button');
      await t.shot('new-refused');
    });

    await t.step('a resume draft (W127, W129): the finished session by its own name, its folder and last activity, a shared name, its saved mode, the note, Send, then “Resumed” with Open', async () => {
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'idle', approvals: 'resume' });
      await page.waitFor('one card', `${CARDS}.length === 1`);
      const card = `${CARDS}[0]`;
      t.expectEqual(
        await page.evaluate(`({ kind: ${card}.dataset.kind, title: ${card}.querySelector('h4').textContent, note: ${card}.querySelector('.approval-note')?.textContent ?? null, label: ${card}.querySelector('.approval-label')?.textContent ?? null })`),
        {
          kind: 'resume',
          title: `Resume ${NAMES.ended} and send`,
          note: 'Resumes this finished session in the background with claude --resume, in its own folder, and sends the message below as its next turn.',
          label: 'Message',
        },
        'the card says what it resumes and that the message is its next turn',
      );
      // W129: which session, in text, since names aren't unique (M2); its own saved settings, and a warning for a bypassed mode (L1).
      const lines = await page.evaluate<{ where: string | null; permission: string | null; bypass: string | null; bypassShown: boolean; fits: boolean }>(
        `(() => { const c = ${card}; const where = c.querySelector('.approval-where'); const bypass = c.querySelector('.approval-bypass'); const r = c.getBoundingClientRect(); return { where: where?.textContent ?? null, permission: c.querySelector('.approval-permission')?.textContent ?? null, bypass: bypass?.textContent ?? null, bypassShown: !!bypass && bypass.getBoundingClientRect().height > 0, fits: [where, bypass].every((el) => !el || (el.getBoundingClientRect().right <= r.right + 0.5 && el.scrollWidth <= el.clientWidth + 1)) }; })()`,
      );
      t.expect(/^2 listed sessions have this name; this is the one in \/\S+, last active .+ ago\.$/.test(lines.where ?? ''), 'the folder as its whole path, its last activity and the shared name, as text', lines.where);
      t.expectEqual(lines.permission, 'Claude Code resumes it with its own saved settings, its permission mode included: bypassPermissions.', 'its own saved settings, permission mode included');
      t.expect(lines.bypassShown && (lines.bypass ?? '').includes('no permission prompts'), 'a visible warning for bypassPermissions', lines.bypass);
      t.expect(lines.fits, 'the new lines wrap inside the card', lines);
      const buttons = await page.evaluate<string[]>(`[...${card}.querySelectorAll('button')].map((b) => b.textContent.trim())`);
      t.expectEqual(buttons, ['Send', 'Edit', "Don't send"], 'Send, Edit and Don’t send');
      const box = await page.evaluate<{ right: number }>(`(() => { const r = ${card}.getBoundingClientRect(); return { right: r.right }; })()`);
      t.expect(box.right <= t.viewport.width + 0.5, 'the card inside the window', box);
      await t.shot('resume-card');
      await page.click('Send', cardButton(0, 'Send'));
      await page.waitFor('its row, once the index lists it running', `${HANDOFFS}.length === 1 && !!${HANDOFFS}[0].querySelector('[data-handoff-open]')`);
      t.expectEqual(records.decisions.at(-1), { id: SUPERVISOR_APPROVALS.resume, decision: 'send', status: 200 }, 'sent once');
      const row = await page.evaluate<{ kind: string; what: string; open: string | null }>(
        `(() => { const li = ${HANDOFFS}[0]; return { kind: li.dataset.handoff, what: li.querySelector('.supervisor-handoff-what').textContent, open: li.querySelector('[data-handoff-open]')?.textContent ?? null }; })()`,
      );
      t.expectEqual(row, { kind: 'resume', what: `Resumed ${NAMES.ended}`, open: `Open ${NAMES.ended} →` }, '“Resumed <name>” with Open');
      await t.shot('resume-handoff');
      await page.click(`Open ${NAMES.ended}`, `${HANDOFFS}[0].querySelector('[data-handoff-open]')`);
      await page.waitFor('its session view, in the supervisor’s place', `!${SVIEW} && !!document.querySelector('#session-view')`);
      t.expectEqual(await page.evaluate(`document.querySelector('#session-view h2 .session-view-name')?.textContent ?? null`), NAMES.ended, 'the session it resumed');
    });

    await t.step('Load earlier: its older turns', async () => {
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'idle' });
      await page.waitFor('Load earlier', `!!${SVIEW}.querySelector('.load-earlier')`);
      await page.click('Load earlier', `${SVIEW}.querySelector('.load-earlier')`);
      await page.waitFor('the older turns', `[...${SVIEW}.querySelectorAll('li.entry-user')].some((li) => li.textContent.includes('Which sessions need me, and why?'))`);
    });

    await t.step('names in its replies (W125): a session or PR it names is a link button that opens it, never in code', async () => {
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'idle' });
      const reply = `[...${SVIEW}.querySelectorAll('li.entry-assistant')].find((li) => li.textContent.includes("I've drafted both"))`;
      await page.waitFor('the reply that names them', `!!${reply}?.querySelector('button.md-mention')`);
      const mentions = await page.evaluate<{ label: string | null; text: string | null; parent: string; tab: number }[]>(
        `[...${reply}.querySelectorAll('button.md-mention')].map((b) => ({ label: b.getAttribute('aria-label'), text: b.textContent, parent: b.parentElement.tagName, tab: b.tabIndex }))`,
      );
      t.expectEqual(
        mentions,
        [
          { label: 'Open session pitwall-test-review', text: 'pitwall-test-review', parent: 'STRONG', tab: 0 },
          { label: 'Open pull request example/demo-app#57', text: 'example/demo-app#57', parent: 'P', tab: 0 },
        ],
        'the session, in bold as written, and the PR, each a Tab stop',
      );
      t.expectEqual(await page.evaluate(`${reply}.querySelector('code')?.querySelector('button') ?? null`), null, 'nothing in code');
      // A link's look: the link colour, underlined, the text's own weight, and no chip.
      const look = await page.evaluate<{ color: string; link: string; underline: string; weight: string; strong: string; background: string; border: string }>(
        `(() => { const b = ${reply}.querySelector('button.md-mention'); const s = getComputedStyle(b); const probe = document.createElement('span'); probe.style.color = 'var(--pw-link)'; b.parentElement.append(probe); const link = getComputedStyle(probe).color; probe.remove(); return { color: s.color, link, underline: s.textDecorationLine, weight: s.fontWeight, strong: getComputedStyle(b.parentElement).fontWeight, background: s.backgroundColor, border: s.borderTopWidth }; })()`,
      );
      t.expectEqual([look.color, look.underline, look.weight, look.background, look.border], [look.link, 'underline', look.strong, 'rgba(0, 0, 0, 0)', '0px'], 'a link’s look, not a button chip');
      await t.shot('mentions');
      await page.click('pitwall-test-review', `${reply}.querySelector('button.md-mention')`);
      await page.waitFor('its session view, in the supervisor’s place', `!${SVIEW} && !!document.querySelector('#session-view')`);
      t.expectEqual(await page.evaluate(`document.querySelector('#session-view h2 .session-view-name')?.textContent ?? null`), NAMES.asked, 'the session it named');
      t.expect((await page.evaluate<string>('location.search')).includes('session='), 'the session in the URL', await page.evaluate('location.search'));
      await page.evaluate('history.back()');
      await page.waitFor('back to the supervisor', `!!${reply}?.querySelector('[data-mention="pr"]')`);
      await page.click('example/demo-app#57', `${reply}.querySelector('[data-mention="pr"]')`);
      await page.waitFor('its PR view', `!${SVIEW} && new URLSearchParams(location.search).get('pr') === 'example/demo-app/57'`);
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
