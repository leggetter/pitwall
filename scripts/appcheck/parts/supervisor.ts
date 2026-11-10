// The supervisor (M5, W114; docs/design-system.md, 4: Supervisor): the repo list's item, first, above
// Needs you, with its status and its drafts' count, which Needs you and the page title count too; its
// view in the third column as ?supervisor, one history entry, in a session's place and back; a new
// conversation's questions, which fill the box; a message that starts it, the working line, and its
// reply as markdown; its limit, 100,000 characters (W134); Load earlier; the draft cards, Edit and Send edit, Don't send, and where focus
// goes; what it sent and started, with each session's state, Needs you's notice and Open (W124); a
// resume draft for a finished session and its "Resumed" row (W127); Open from another root's tab, which
// selects the session's tab and group in one history entry (W144); the sessions and PRs its replies name, which open them (W125); Stop; held, with the stop command and the app strip's line; failed, with Start; a reload that
// starts nothing; its context in the header, New conversation with its confirmation, cancelled,
// confirmed and refused, and a draft's text up to half the window (W136), with its buttons in the band
// at 600 to 1000 px tall (W143); pitwall's line under a
// message draft and its editor, and a session's reply to the supervisor, To pitwall-supervisor, with
// Claude Code's refusal in pitwall's words (W138); Attach file, a text file read in the page into the
// box under its name, then sent, and a file that isn't UTF-8, has a NUL or is too big refused (W135);
// and none with --no-supervisor. Made-up example/* content only.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { REFUSED_TO_SUPERVISOR_NOTICE } from '../../../src/index/conversation.js';
import { SUPERVISOR_MESSAGE_FOOTER } from '../../../src/shared/protocol.js';
import { CODE, DEMO_APP, NAMES, OSS, SUPERVISOR_APPROVALS, SUPERVISOR_RACE_REFUSAL } from '../fixtures.js';
import type { Case, Part } from '../runner.js';
import { focused, listHeading, openFromRow, openRepoList, repoLabels, selectedRepo, VIEW, viewClose, viewName } from './_dom.js';

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
/** The open root tab's label, with two roots. */
const OPEN_TAB = `(document.querySelector('header .root-tab[aria-selected="true"] .root-tab-label')?.textContent ?? null)`;
const HANDOFFS = `[...(${SVIEW}?.querySelectorAll('[data-supervisor-handoffs] li.supervisor-handoff') ?? [])]`;
/** A card's line pitwall adds (W138): its label, its text, and whether it's inside the card and the window. */
const footerOf = (index: number) =>
  `(() => { const c = ${CARDS}[${index}]; const f = c?.querySelector('.approval-footer'); if (!f) return null; const r = f.getBoundingClientRect(); const cr = c.getBoundingClientRect(); return { label: f.querySelector('.approval-label').textContent, text: f.querySelector('.approval-footer-text').textContent, named: f.getAttribute('role') === 'group' && document.getElementById(f.getAttribute('aria-labelledby'))?.textContent === f.querySelector('.approval-label').textContent, inside: r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5 && r.right <= innerWidth + 0.5 }; })()`;
const FOOTER = { label: 'Then pitwall adds, after a blank line', text: SUPERVISOR_MESSAGE_FOOTER, named: true, inside: true };
const cardButton = (index: number, label: string) => `[...(${CARDS}[${index}]?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${q(label)})`;
const NEEDS_YOU = `Number([...document.querySelectorAll('nav[aria-label="Repos"] a[data-repo-item]')].find((a) => a.querySelector('.repo-item-label')?.textContent === 'Needs you')?.querySelector('.badge')?.firstChild?.textContent ?? 0)`;
const TITLE_COUNT = `Number(/^\\((\\d+)\\)/.exec(document.title)?.[1] ?? 0)`;
/** The view's box against the window's: inside it, and full width at 600 px and narrower. */
const placed = `(() => { const r = ${SVIEW}.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom }; })()`;

/** Attach file's made-up files (W135): a brief with a fence of its own and some non-ASCII, and three it refuses. */
const BRIEF = `# Made-up brief\n\nRun:\n\`\`\`sh\nnpm test\n\`\`\`\n\nCafé ✓\n${'A line of made-up text for the app check.\n'.repeat(1_000)}`;
const ATTACH_FILES = {
  brief: { name: 'pitwall-test-brief.md', bytes: Buffer.from(BRIEF, 'utf8') },
  latin1: { name: 'pitwall-test-latin1.txt', bytes: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) },
  nul: { name: 'pitwall-test-nul.txt', bytes: Buffer.from('made\u0000up\n', 'utf8') },
  huge: { name: 'pitwall-test-huge.log', bytes: Buffer.alloc(400_000, 0x78) },
};

/** Writes `file` into the run's output folder and chooses it in Attach file's input, as the system's picker would (DOM.setFileInputFiles). */
async function attach(t: Case, file: { name: string; bytes: Buffer }): Promise<void> {
  const dir = resolve(join(t.out, 'files', 'supervisor'));
  await mkdir(dir, { recursive: true });
  const path = join(dir, file.name);
  await writeFile(path, file.bytes);
  const { result } = await t.page.send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: `${SVIEW}?.querySelector('.supervisor-box input[type="file"]')` });
  if (!result.objectId) throw new Error('the message box has no file input for Attach file');
  await t.page.send('DOM.setFileInputFiles', { files: [path], objectId: result.objectId });
  await t.page.settle();
}

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

    await t.step('Attach file (W135): a text file read into the box under its name, after what’s typed, then sent; one not UTF-8, with a NUL, or too big, refused', async () => {
      const ATTACH = `${SVIEW}.querySelector('.supervisor-box .supervisor-attach')`;
      const ALERT = `(${SVIEW}.querySelector('.supervisor-box [role="alert"]')?.textContent ?? null)`;
      const SAID = `(${SVIEW}.querySelector('.supervisor-box p[role="status"]')?.textContent ?? null)`;
      t.expectEqual(await page.evaluate(`${ATTACH}?.textContent.trim() ?? null`), 'Attach file', 'Attach file, on the help line');
      t.expect(
        await page.evaluate<boolean>(`(() => { const a = ${ATTACH}.getBoundingClientRect(); const b = ${BOX}.getBoundingClientRect(); return a.top >= b.bottom && a.left >= b.left - 0.5 && a.right <= innerWidth; })()`),
        'under the text box, inside the window',
      );
      const prefix = 'What do you make of this brief?';
      await page.evaluate(`(() => {
        const box = ${BOX};
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${q(prefix)});
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await attach(t, ATTACH_FILES.brief);
      const expected = `${prefix}\n\nFile: pitwall-test-brief.md\n\`\`\`\`\n${BRIEF.slice(0, -1)}\n\`\`\`\`\n\n`;
      await page.waitFor('the file in the box', `${BOX}.value.includes('File: pitwall-test-brief.md')`);
      t.expect(await page.evaluate<boolean>(`${BOX}.value === ${q(expected)}`), 'after what’s typed, under its name, in a fence longer than its own', await page.evaluate(`${BOX}.value.slice(0, 120)`));
      t.expect(await page.evaluate<boolean>(`document.activeElement === ${BOX} && ${BOX}.selectionStart === ${BOX}.value.length`), 'focus in the box, the caret after the file', await page.evaluate(focused));
      t.expect(await page.evaluate<boolean>(`${BOX}.scrollTop + ${BOX}.clientHeight >= ${BOX}.scrollHeight - 1`), 'the box scrolled to its end, where the caret is');
      t.expectEqual(await page.evaluate(SAID), 'Attached pitwall-test-brief.md to your message.', 'said to a screen reader');
      await t.shot('attached');

      const typed = await page.evaluate<string>(`${BOX}.value`);
      await attach(t, ATTACH_FILES.latin1);
      await page.waitFor('the refusal', `${ALERT} !== null`);
      t.expectEqual(await page.evaluate(ALERT), "Couldn't attach pitwall-test-latin1.txt. It isn't UTF-8 text: only text files can be attached.", 'not UTF-8: refused, in pitwall’s words');
      await t.shot('attach-refused');
      await attach(t, ATTACH_FILES.nul);
      await page.waitFor('the NUL refusal', `${ALERT}?.includes('pitwall-test-nul.txt') ?? false`);
      t.expectEqual(await page.evaluate(ALERT), "Couldn't attach pitwall-test-nul.txt. It has NUL bytes, so it isn't text: only text files can be attached.", 'a NUL: refused');
      await attach(t, ATTACH_FILES.huge);
      await page.waitFor('the size refusal', `${ALERT}?.includes('pitwall-test-huge.log') ?? false`);
      t.expect((await page.evaluate<string>(ALERT)).includes('characters left in this message: the limit is 100,000.'), 'too big with what’s in the box: refused by its size', await page.evaluate(ALERT));
      t.expectEqual(await page.evaluate<string>(`${BOX}.value`), typed, 'the box as it was');

      const before = records.supervisorMessages.length;
      await page.click('Send', SEND);
      await page.waitFor('the message sent', `${BOX}.value === ''`, 8_000);
      t.expectEqual(records.supervisorMessages.slice(before), [{ length: expected.trimEnd().length, status: 200 }], 'sent whole, as the box had it');
      await page.waitFor('it to be idle', `${STATUS} === 'idle' && !${SVIEW}.querySelector('.working-line')`, 15_000);
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
      // pitwall's line under the message, apart from its text, and none under a new session's prompt (W138).
      t.expectEqual(await page.evaluate(footerOf(0)), FOOTER, "pitwall's line under the message, inside the card");
      t.expect(!(await page.evaluate<string>(`${CARDS}[0].querySelector('.approval-text').textContent`)).includes(SUPERVISOR_MESSAGE_FOOTER), 'not in the text');
      t.expectEqual(await page.evaluate(footerOf(1)), null, 'none under the new session');
      await t.shot('cards');
    });

    await t.step('a new session’s Profile (W156): the supervisor’s pick, what it starts on, inside the card, and another pick changes it', async () => {
      const card = `${CARDS}[1]`;
      const SELECT = `${card}.querySelector('.approval-profile select')`;
      const read = `(() => { const s = ${SELECT}; const c = ${card}.getBoundingClientRect(); const p = ${card}.querySelector('.approval-profile'); const r = p.getBoundingClientRect(); const sr = s.getBoundingClientRect(); return { label: p.querySelector('label')?.textContent ?? null, named: p.querySelector('label')?.htmlFor === s.id, value: s.value, hint: document.getElementById(s.getAttribute('aria-describedby'))?.textContent ?? null, inside: r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && sr.right <= c.right + 0.5 && sr.height >= 24 }; })()`;
      t.expectEqual(
        await page.evaluate(read),
        {
          label: 'Profile',
          named: true,
          value: 'Review',
          hint: 'Starts on model sonnet, effort high, sub-agents sonnet. Its first prompt starts with /agent-roles:role-reviewer, which must be installed where the session runs.',
          inside: true,
        },
        'the supervisor’s pick, labelled, with what it starts on, inside the card',
      );
      await t.shot('profile');
      // A pick, as the select's own change would make it: no key presses in the browser (W64).
      await page.evaluate(`(() => { const s = ${SELECT}; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'Docs'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await page.waitFor('the Docs line', `document.getElementById(${SELECT}.getAttribute('aria-describedby'))?.textContent === 'Starts on model sonnet, effort medium, sub-agents sonnet.'`);
    });

    await t.step('Edit, then Send edit: the edit sent, the card gone, and focus on the next card’s heading', async () => {
      await page.click('Edit', cardButton(0, 'Edit'));
      await page.waitFor('the editor, with focus', `document.activeElement?.matches('.approval-editor') === true`);
      const before = await page.evaluate<number>(`document.activeElement.value.length`);
      // The line stays under the editor, never in it, so an edit can't remove it (W138).
      t.expectEqual(await page.evaluate(footerOf(0)), FOOTER, "pitwall's line under the editor");
      t.expect(!(await page.evaluate<string>(`document.activeElement.value`)).includes(SUPERVISOR_MESSAGE_FOOTER), 'not in the editor');
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

    await t.step('Needs you’s notice: its button under the text when the session list column is 600 px or narrower, however wide the app', async () => {
      await t.fresh({ search: '?view=needs-you', supervisor: 'idle', approvals: true });
      await page.waitFor('the notice', `!!document.querySelector('.supervisor-notice .inline-alert-actions')`);
      const box = await page.evaluate<{ width: number; textWidth: number; textBottom: number; actionsTop: number; actionsRight: number }>(
        `(() => { const n = document.querySelector('.supervisor-notice'); const r = (s) => n.querySelector(s).getBoundingClientRect(); return { width: parseFloat(getComputedStyle(n).width) - parseFloat(getComputedStyle(n).paddingLeft) - parseFloat(getComputedStyle(n).paddingRight), textWidth: r('.inline-alert-text').width, textBottom: r('.inline-alert-text').bottom, actionsTop: r('.inline-alert-actions').top, actionsRight: r('.inline-alert-actions').right }; })()`,
      );
      if (box.width <= 600) {
        t.expect(box.actionsTop >= box.textBottom - 0.5, 'the button under the text', box);
        // The text takes the alert's width but the 16 px icon, its 8 px gap and the 12 px padding at each side.
        t.expect(box.textWidth >= box.width - 16 - 8 - 24 - 1, 'the text across the alert, not a strip beside the button', box);
      } else {
        t.expect(box.actionsTop < box.textBottom, 'the button beside the text', box);
      }
      await t.shot('needs-you-notice');
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
      // The new session's Send carries the profile its card showed, the supervisor's pick (W156).
      t.expectEqual(records.decisions.at(-1), { id: SUPERVISOR_APPROVALS.spawn, decision: 'send', profile: 'Review', status: 200 }, 'the new session sent with its card’s profile');
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

    await t.step('Open from the other root’s tab (W144): the session’s tab and group come with it, in one entry, and Back returns', async () => {
      const start = `?view=all&root=${OSS}`;
      await t.fresh({ search: start, supervisor: 'idle', approvals: true, roots: 2 });
      await openRepoList(t);
      await page.click('the Supervisor item', ITEM);
      await page.waitFor('two cards', `${CARDS}.length === 2`);
      await page.click('Send', cardButton(0, 'Send'));
      await page.waitFor('the message’s row', `${HANDOFFS}.length === 1`);
      await page.click('Send', cardButton(0, 'Send'));
      await page.waitFor('both rows', `${HANDOFFS}.length === 2 && ${CARDS}.length === 0`);
      // The new session's Send carries the profile its card showed, the supervisor's pick (W156).
      t.expectEqual(records.decisions.at(-1), { id: SUPERVISOR_APPROVALS.spawn, decision: 'send', profile: 'Review', status: 200 }, 'the new session sent with its card’s profile');
      t.expectEqual(await page.evaluate(OPEN_TAB), '~/oss', 'in ~/oss’s tab');
      await page.click('Open pr-57', `${HANDOFFS}[0].querySelector('[data-handoff-open]')`);
      await page.waitFor('its session view, in the supervisor’s place', `!${SVIEW} && ${viewName} === 'pr-57'`);
      const search = await page.evaluate<string>('location.search');
      t.expect(search.startsWith(`?repo=${DEMO_APP}&root=${CODE}&session=`), 'its group and root in the URL, with the session', search);
      t.expectEqual(await page.evaluate(OPEN_TAB), '~/code', 'its root’s tab open');
      t.expectEqual(await page.evaluate(focused), 'the view heading', 'focus on its heading');
      if (t.layout !== 'drawer') t.expectEqual(await page.evaluate(selectedRepo), 'demo-app', 'demo-app selected in the repo list');
      t.expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.session-list [data-open-session]')].some((el) => el.textContent.trim() === 'pr-57')`), 'its row in the session list');
      await t.shot('handoff-other-root');
      await page.evaluate('history.back()');
      await page.waitFor('the supervisor again, in ~/oss’s tab', `!!${SVIEW}?.querySelector('h2') && ${OPEN_TAB} === '~/oss'`);
      t.expectEqual(await page.evaluate('location.search'), `${start}&supervisor`, 'one Back returns to where it was, so it was one entry');
    });

    await t.step('a reply to the supervisor (W138): To pitwall-supervisor in its session, and the refusal in pitwall’s words', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.asked);
      const ENTRIES = `[...document.querySelectorAll('#session-view ol.conversation > li.entry')]`;
      await page.waitFor('its conversation', `${ENTRIES}.some((li) => li.classList.contains('entry-to-pitwall'))`);
      const shown = await page.evaluate<Array<{ kind: string | undefined; speaker: string | null; text: string }>>(
        `${ENTRIES}.slice(-4).map((li) => ({ kind: [...li.classList].find((c) => c.startsWith('entry-')), speaker: li.querySelector(':scope > .entry-speaker')?.childNodes[0]?.textContent ?? null, text: li.querySelector('.entry-text')?.textContent ?? '' }))`,
      );
      t.expectEqual(
        shown.map((each) => [each.kind, each.speaker]),
        [
          ['entry-cross-session', 'From pitwall-supervisor'],
          ['entry-to-pitwall', 'To pitwall-supervisor'],
          ['entry-notice', null],
          ['entry-assistant', 'Claude'],
        ],
        'the message, the reply, the refusal and the question, in order',
      );
      t.expect(shown[0]!.text.endsWith(SUPERVISOR_MESSAGE_FOOTER), "the supervisor's message ends with pitwall's line", shown[0]?.text);
      t.expectEqual(shown[1]!.text, 'Checked: the made-up CI run is green.', 'the reply in full, as markdown');
      t.expectEqual(shown[2]!.text, REFUSED_TO_SUPERVISOR_NOTICE, "the refusal in pitwall's words");
      t.expect(!shown.some((each) => each.text.includes('Cross-session')), "never Claude Code's own words");
      const inside = await page.evaluate<{ right: number; width: number }>(
        `(() => { const r = ${ENTRIES}.find((li) => li.classList.contains('entry-notice') && li.textContent.includes('supervisor')).getBoundingClientRect(); return { right: r.right, width: innerWidth }; })()`,
      );
      t.expect(inside.right <= inside.width + 0.5, 'the notice inside the window', inside);
      await page.evaluate(`${ENTRIES}.find((li) => li.classList.contains('entry-to-pitwall')).scrollIntoView({ block: 'center' })`);
      await t.shot('reply-refused');
    });

    await t.step('long drafts (W120, W136): the exact text, up to half the window, its length said only when it scrolls, and a no-break space drawn as its code', async () => {
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'idle', approvals: 'long' });
      await page.waitFor('two cards', `${CARDS}.length === 2`);
      const [card, longer] = [`${CARDS}[0]`, `${CARDS}[1]`];
      /**
       * A card's text box: its height, what it holds, eight lines' height, half the window, and the room
       * the band leaves it, when that's less (W143).
       */
      const measure = (which: string, box = '.approval-text') =>
        page.evaluate<{ height: number; content: number; eight: number; half: number; room: number | null }>(
          `(() => { const card = ${which}; const box = card.querySelector(${q(box)}); const s = getComputedStyle(box); const eight = 8 * parseFloat(s.lineHeight) + parseFloat(s.paddingTop) + parseFloat(s.paddingBottom); const room = parseFloat(box.style.maxHeight) || null; return { height: box.getBoundingClientRect().height, content: box.scrollHeight, eight, half: innerHeight / 2, room }; })()`,
        );
      // 14 lines: taller than the 8 lines a box had before W136. Where they fit, as at 1,440 px, no length
      // note; where they wrap past half the window, as at 375 px, or the band leaves them less room, as at
      // 1,200 px, whose narrower column wraps pitwall's line (W138) to three lines, the note: exactly when
      // it scrolls.
      const first = await measure(card);
      const scrolls = first.content > first.height + 1;
      t.expect(first.height > first.eight + 1 || first.height >= (first.room ?? Infinity) - 1, 'the box taller than 8 lines, or as tall as the band leaves it room for', first);
      if (!t.compact) t.expect(Math.abs(first.height - Math.min(first.content, first.half, first.room ?? Infinity)) <= 2, 'the box as tall as its 14 lines, or as half the window or the band’s room where those are less', first);
      if (t.viewport.width >= 1440) t.expect(!scrolls, '14 lines shown whole on a wide, tall window', first);
      const codeNote = "Drawn as their codes, since they don't show as themselves: U+00A0 NO-BREAK SPACE.";
      t.expectEqual(
        await page.evaluate(`${card}.querySelector('.approval-length')?.textContent ?? null`),
        scrolls ? `14 lines, 679 characters: scroll to read it all before you send it. ${codeNote}` : codeNote,
        'its length said exactly when it scrolls, and the code',
      );
      t.expectEqual(await page.evaluate(`[...${card}.querySelectorAll('.approval-hidden')].map((each) => each.textContent)`), ['U+00A0'], 'the no-break space as its code');
      // 60 lines: the box at half the window, or the room the band leaves it (W143), then it scrolls, saying how long it is.
      const second = await measure(longer);
      t.expect(Math.abs(second.height - Math.min(second.half, second.room ?? Infinity)) <= 2 && second.content > second.height + 1, 'the box at half the window or the band’s room, the text scrolling in it', second);
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
      await page.settle(50);
      const editor = await measure(longer, '.approval-editor');
      t.expect(Math.abs(editor.height - Math.min(editor.half, editor.room ?? Infinity)) <= 2, 'the editor as tall as half the window, or the band’s room', editor);
      await page.click('Cancel', cardButton(1, 'Cancel'));
      t.expectEqual(records.decisions, [], 'nothing decided');
    });

    await t.step('a long draft’s buttons in reach (W143): at 600 to 1000 px tall, a card first in the band shows Send, and Send edit while editing, inside the band and above the message box', async () => {
      // Before W143, the text box was half the window whatever room the band had, so a long card was
      // taller than the band: its buttons sat under the message box, and the wheel over the text
      // scrolled the text, not the band.
      await t.fresh({ search: '?view=all&supervisor', supervisor: 'idle', approvals: 'long' });
      await page.waitFor('two cards', `${CARDS}.length === 2`);
      const LIST = `${SVIEW}.querySelector('.supervisor-approvals-scroll')`;
      /** Scrolls the band's list so card `index` is the first in view, then where its button `label` is against the list and the message box. */
      const reach = (index: number, label: string) =>
        page.evaluate<{ inBand: boolean; whole: boolean; aboveBox: boolean; readable: boolean; twoLines: boolean; button: number[]; band: number[]; box: number; card: number[]; cramped: boolean; fitsAtTwo: boolean }>(`(() => {
          const list = ${LIST}; const card = ${CARDS}[${index}];
          list.scrollTop += card.getBoundingClientRect().top - list.getBoundingClientRect().top - parseFloat(getComputedStyle(list).paddingTop);
          const b = ${cardButton(index, label)}.getBoundingClientRect(); const l = list.getBoundingClientRect();
          const f = ${SVIEW}.querySelector('.supervisor-foot').getBoundingClientRect();
          const text = card.querySelector('.approval-editor') ?? card.querySelector('.approval-text'); const s = getComputedStyle(text);
          const scrolls = text.scrollHeight > text.clientHeight + 1;
          // Whether the card fits the list's room with its text at two lines, measured here, apart from
          // the page's own fit: its height less the text box's, plus two lines and the box's padding and edges.
          const ls = getComputedStyle(list); const px = (v) => parseFloat(v) || 0;
          const two = 2 * px(s.lineHeight) + px(s.paddingTop) + px(s.paddingBottom) + px(s.borderTopWidth) + px(s.borderBottomWidth);
          const fitsAtTwo = card.getBoundingClientRect().height - text.getBoundingClientRect().height + two <= list.clientHeight - px(ls.paddingTop) - px(ls.paddingBottom) + 0.5;
          return {
            inBand: b.top >= l.top - 0.5 && b.bottom <= l.bottom + 0.5,
            whole: card.getBoundingClientRect().bottom <= l.bottom + 0.5,
            aboveBox: b.bottom <= f.top + 0.5,
            // All of it can be read: it fits, or it scrolls as a Tab stop (the editor is one anyway).
            readable: !scrolls || text.tagName === 'TEXTAREA' || text.getAttribute('role') === 'region',
            twoLines: text.clientHeight >= Math.min(text.scrollHeight, 2 * parseFloat(s.lineHeight)) - 1,
            button: [Math.round(b.top), Math.round(b.bottom)], band: [Math.round(l.top), Math.round(l.bottom)], box: Math.round(f.top),
            card: [Math.round(card.getBoundingClientRect().top), Math.round(card.getBoundingClientRect().bottom)], cramped: card.hasAttribute('data-cramped'),
            fitsAtTwo,
          };
        })()`);
      for (const height of [600, 680, 760, 800, 900, 1000]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: t.viewport.width, height, deviceScaleFactor: 1, mobile: false });
        await page.settle(50);
        for (const index of [0, 1]) {
          const shown = await reach(index, 'Send');
          t.expect(shown.inBand && shown.aboveBox && shown.readable && shown.twoLines, `at ${height} px, card ${index + 1}'s Send inside the band, above the box, and its text readable`, shown);
          // Where the card fits at two lines, the whole card is in the band, its notes and pitwall's line
          // too, the text giving way; at 1,440 px the whole card is always in the band. Where it doesn't, as at 375 px, or 1,200 px
          // and 600 px tall, whose narrower column wraps pitwall's line (W138) to three lines, its buttons
          // stick to the band's bottom edge over the rest (data-cramped), which the check above covers.
          if (!t.compact) t.expect(shown.whole || !shown.fitsAtTwo, `at ${height} px, card ${index + 1} whole in the band, where it fits at two lines`, shown);
          t.expectEqual(shown.cramped, !shown.fitsAtTwo, `at ${height} px, card ${index + 1}'s buttons stick to the band's bottom only where it can't fit at two lines`);
          if (t.viewport.width >= 1440) t.expect(shown.whole, `at ${height} px on a wide window, card ${index + 1} whole in the band`, shown);
          if (index === 1 && (height === 600 || height === 1000)) await t.shot(`draft-in-reach-${height}`);
          await page.click('Edit', cardButton(index, 'Edit'));
          await page.waitFor('the editor', `!!${CARDS}[${index}].querySelector('.approval-editor')`);
          await page.settle(50);
          const editing = await reach(index, 'Send edit');
          t.expect(editing.inBand && editing.aboveBox && editing.twoLines, `at ${height} px, card ${index + 1}'s Send edit inside the band and above the box`, editing);
          if (!t.compact) t.expect(editing.whole || !editing.fitsAtTwo, `at ${height} px, card ${index + 1} whole in the band while editing, where it fits at two lines`, editing);
          if (t.viewport.width >= 1440) t.expect(editing.whole, `at ${height} px on a wide window, card ${index + 1} whole in the band while editing`, editing);
          await page.click('Cancel', cardButton(index, 'Cancel'));
          await page.waitFor('the text again', `!!${CARDS}[${index}].querySelector('.approval-text')`);
        }
      }
      await page.send('Emulation.setDeviceMetricsOverride', { width: t.viewport.width, height: t.viewport.height, deviceScaleFactor: 1, mobile: false });
      await page.settle(50);
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
      // W156: its Profile, As it started first, naming the profile it was started on, and what it resumes on.
      const profile = await page.evaluate<{ options: string[]; value: string; hint: string | null }>(
        `(() => { const s = ${card}.querySelector('.approval-profile select'); return { options: [...s.options].map((o) => o.textContent), value: s.selectedOptions[0]?.textContent ?? '', hint: document.getElementById(s.getAttribute('aria-describedby'))?.textContent ?? null }; })()`,
      );
      t.expectEqual(
        profile,
        {
          options: ['As it started (Build)', 'Build', 'Review', 'Security review', 'Docs'],
          value: 'As it started (Build)',
          hint: 'pitwall resumes it on what it started it with, from the Build profile: model claude-opus-5-5, effort high, sub-agents sonnet.',
        },
        'its Profile, on As it started, and what it resumes on',
      );
      const buttons = await page.evaluate<string[]>(`[...${card}.querySelectorAll('button')].map((b) => b.textContent.trim())`);
      t.expectEqual(buttons, ['Send', 'Edit', "Don't send"], 'Send, Edit and Don’t send');
      const box = await page.evaluate<{ right: number }>(`(() => { const r = ${card}.getBoundingClientRect(); return { right: r.right }; })()`);
      t.expect(box.right <= t.viewport.width + 0.5, 'the card inside the window', box);
      await t.shot('resume-card');
      await page.click('Send', cardButton(0, 'Send'));
      await page.waitFor('its row, once the index lists it running', `${HANDOFFS}.length === 1 && !!${HANDOFFS}[0].querySelector('[data-handoff-open]')`);
      // As it started, the card's own choice with no profile from the supervisor (W156): null.
      t.expectEqual(records.decisions.at(-1), { id: SUPERVISOR_APPROVALS.resume, decision: 'send', profile: null, status: 200 }, 'sent once');
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
