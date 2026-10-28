// End session (W90, spike 005; docs/design-system.md, 4: Session view's actions menu and Inline
// confirmation): a running interactive session's actions menu has End session in Stop session's
// place, and a background one's doesn't; it asks first, naming the session, its running sub-agents
// and what ending costs, with Cancel focused; Cancel and Escape send nothing; confirmed, a success
// toast, and the session is then listed as ended, with Resume in background (W67); a working session
// gets the stronger warning, an alertdialog naming what runs, whose End session anyway sends
// `whileWorking`; and the server's refusals, a 409 and a 429, show inline in its words. The fake
// server answers each session by its name (END_* in server.ts) and signals nothing.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { END_LIMITED, END_LIMITED_ERROR, END_REFUSED, END_REFUSED_ERROR, END_SUBAGENTS, END_WORKING } from '../server.js';
import { focused, toasts, VIEW, viewName } from './_dom.js';

const q = JSON.stringify;
const MENU_BUTTON = `${VIEW}?.querySelector('button[aria-label="Session actions"]')`;
const ITEMS = `[...(${VIEW}?.querySelectorAll('[role="menu"] > *') ?? [])].map((item) => item.getAttribute('role') === 'separator' ? '—' : item.textContent.trim())`;
const menuItem = (label: string) => `[...(${VIEW}?.querySelectorAll('[role="menuitem"]') ?? [])].find((item) => item.textContent.trim() === ${q(label)})`;
const CONFIRM = `${VIEW}?.querySelector('.session-actions .inline-confirm')`;
const QUESTION = `${CONFIRM}?.querySelector('.inline-confirm-question')?.textContent`;
const CONSEQUENCE = `${CONFIRM}?.querySelector('.inline-confirm-consequence')?.textContent`;
const confirmButton = (label: string) => `[...(${CONFIRM}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${q(label)})`;
const ALERT = `${VIEW}?.querySelector('.session-actions [role="alert"]')?.textContent`;

const QUESTION_TEXT = 'End this session?';
const consequence = (name: string, running = '') =>
  `${name}'s Claude Code process ends, and its terminal goes back to the shell. Any reply in progress is lost${running}. Its conversation is kept, so you can resume it afterwards.`;
const WORKING_QUESTION = "It's still working. End this session anyway?";

const part: Part = {
  name: 'end-session',
  title: 'End session: in an interactive session’s actions menu, its confirmation, Cancel and Escape, the toast and Ended, the stronger warning, and the refusals',
  async run(t) {
    const { page, server } = t;
    const id = (name: string) => server.world.byName(name).sessionId;
    const openMenu = async () => {
      await page.click('Session actions', MENU_BUTTON);
      await page.waitFor('the menu', `!!${VIEW}?.querySelector('[role="menu"]')`);
      return page.evaluate<string[]>(ITEMS);
    };
    const closeMenu = async () => {
      await page.key('Escape');
      await page.waitFor('the menu to close', `!${VIEW}?.querySelector('[role="menu"]')`);
    };
    /** Opens `name`'s view from its URL, since below 1,200 px the open view covers the list's rows. */
    const openView = async (name: string) => {
      await page.navigate(`/?view=all&session=${id(name)}`);
      await page.waitFor(`the ${name} view`, `${viewName} === ${q(name)}`, 10_000);
    };
    /** Opens `name`'s view and chooses End session, and waits for its question. */
    const ask = async (name: string) => {
      await openView(name);
      await openMenu();
      await page.click('End session', menuItem('End session'));
      await page.waitFor('the question', `${QUESTION} === ${q(QUESTION_TEXT)}`);
    };

    await t.step("an interactive session's menu ends with End session, after a separator; a background session's has none", async () => {
      await t.fresh({ search: '?view=all' });
      await openView(NAMES.asked);
      const items = await openMenu();
      t.expectEqual(items.slice(-2), ['—', 'End session'], 'a separator, then End session, last');
      t.expect(!items.includes('Stop session') && !items.includes('Remove session'), 'no Stop or Remove', items);
      t.expectEqual(await page.evaluate(`${menuItem('End session')}.getAttribute('aria-disabled')`), null, 'on');
      await t.shot('menu');
      await closeMenu();
      await openView(NAMES.running);
      const background = await openMenu();
      t.expect(!background.includes('End session'), 'a background session has Stop and Remove instead', background);
      await closeMenu();
    });

    await t.step('End session asks first, naming the session and what it costs, with Cancel focused', async () => {
      await ask(NAMES.asked);
      t.expectEqual(await page.evaluate(CONSEQUENCE), consequence(NAMES.asked), 'the consequence');
      t.expectEqual(await page.evaluate(`${CONFIRM}.getAttribute('role')`), 'group', 'a group');
      t.expectEqual(await page.evaluate(`[...${CONFIRM}.querySelectorAll('button')].map((b) => b.textContent.trim())`), ['Cancel', 'End session'], 'Cancel, then End session');
      t.expectEqual(await page.evaluate(focused), 'Cancel', 'Cancel has focus');
      await t.shot('asking');
    });

    await t.step('Cancel, and Escape, send nothing, and put focus back on the menu button', async () => {
      await page.click('Cancel', confirmButton('Cancel'));
      await page.waitFor('the question to go', `!${CONFIRM}`);
      t.expectEqual(await page.evaluate(focused), 'Session actions', 'focus on the menu button after Cancel');
      await openMenu();
      await page.click('End session', menuItem('End session'));
      await page.waitFor('the question', `${QUESTION} === ${q(QUESTION_TEXT)}`);
      await page.key('Escape');
      await page.waitFor('the question to go', `!${CONFIRM}`);
      t.expectEqual(await page.evaluate(focused), 'Session actions', 'focus on the menu button after Escape');
      t.expectEqual(server.records.ends, [], 'nothing sent');
    });

    await t.step('confirmed, it ends: a success toast, focus on the menu button, then the view shows it ended, with Resume in background', async () => {
      await openMenu();
      await page.click('End session', menuItem('End session'));
      await page.waitFor('the question', `${QUESTION} === ${q(QUESTION_TEXT)}`);
      await page.click('End session', confirmButton('End session'));
      const message = `Ended ${NAMES.asked}. Its terminal is back at the shell.`;
      await page.waitFor('the toast', `${toasts}.includes(${q(message)})`);
      t.expect(await page.evaluate<boolean>(`!!document.querySelector('.toasts .toast.success')`), 'a success toast');
      t.expectEqual(server.records.ends, [{ name: NAMES.asked, whileWorking: false, status: 200 }], 'one end, sent with {}');
      t.expect(server.records.requests.includes(`POST /api/sessions/${id(NAMES.asked)}/end 200`), 'POSTed to its end path', server.records.requests);
      t.expect(!(await page.evaluate<boolean>(`!!${CONFIRM}`)), 'the question went');
      t.expectEqual(await page.evaluate(focused), 'Session actions', 'focus is back on the menu button');
      await page.waitFor('its footer to offer Resume in background', `[...(${VIEW}?.querySelectorAll('.ended-actions button') ?? [])].some((b) => b.textContent.trim() === 'Resume in background')`, 10_000);
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('.session-view-meta .badge')?.textContent`), 'Ended', 'its status is Ended');
      const items = await openMenu();
      t.expect(items.includes('Resume in background') && !items.includes('End session'), 'its menu resumes it now, and has no End session', items);
      await closeMenu();
      await t.shot('ended');
    });

    await t.step('a working session gets the stronger warning, an alertdialog naming what runs, and End session anyway sends whileWorking', async () => {
      server.clearRecords();
      t.allow(new RegExp(`/api/sessions/${id(END_WORKING)}/end$`), 'the 409 for a working session this step asks for');
      await ask(END_WORKING);
      await page.click('End session', confirmButton('End session'));
      await page.waitFor('the stronger warning', `${QUESTION} === ${q(WORKING_QUESTION)}`);
      t.expectEqual(await page.evaluate(`${CONFIRM}.getAttribute('role')`), 'alertdialog', 'an alertdialog');
      t.expectEqual(
        await page.evaluate(CONSEQUENCE),
        'Its turn is still running: a reply being written is lost, and its commands are stopped. You can still resume it afterwards.',
        'what runs, and what ending it now loses',
      );
      t.expectEqual(await page.evaluate(focused), 'Cancel', 'Cancel has focus');
      await t.shot('working');
      await page.click('End session anyway', confirmButton('End session anyway'));
      await page.waitFor('the toast', `${toasts}.includes(${q(`Ended ${END_WORKING}. Its terminal is back at the shell.`)})`);
      t.expectEqual(
        server.records.ends,
        [
          { name: END_WORKING, whileWorking: false, status: 409 },
          { name: END_WORKING, whileWorking: true, status: 200 },
        ],
        '{} first, then whileWorking',
      );
    });

    await t.step("running sub-agents: the question names them, the warning says how many, and Cancel ends nothing", async () => {
      server.clearRecords();
      t.allow(new RegExp(`/api/sessions/${id(END_SUBAGENTS)}/end$`), 'the 409 for running sub-agents this step asks for');
      await ask(END_SUBAGENTS);
      t.expectEqual(await page.evaluate(CONSEQUENCE), consequence(END_SUBAGENTS, ', and its 2 running sub-agents are stopped'), 'the sub-agents, from the snapshot');
      await page.click('End session', confirmButton('End session'));
      await page.waitFor('the stronger warning', `${QUESTION} === ${q(WORKING_QUESTION)}`);
      t.expectEqual(await page.evaluate(CONSEQUENCE), '2 sub-agents are running, and they end with it. You can still resume it afterwards.', 'how many');
      await page.click('Cancel', confirmButton('Cancel'));
      await page.waitFor('the warning to go', `!${CONFIRM}`);
      t.expectEqual(await page.evaluate(focused), 'Session actions', 'focus on the menu button');
      t.expectEqual(server.records.ends, [{ name: END_SUBAGENTS, whileWorking: false, status: 409 }], 'nothing more sent');
    });

    await t.step("the server's refusals show inline, in its words: a 409, and a 429 that says when to try again", async () => {
      server.clearRecords();
      t.allow(new RegExp(`/api/sessions/${id(END_REFUSED)}/end$`), 'the 409 this step asks for');
      t.allow(new RegExp(`/api/sessions/${id(END_LIMITED)}/end$`), 'the 429 this step asks for');
      await ask(END_REFUSED);
      await page.click('End session', confirmButton('End session'));
      await page.waitFor('the alert', `${ALERT} === ${q(`Couldn't end the session. ${END_REFUSED_ERROR}`)}`);
      t.expectEqual(await page.evaluate(focused), 'Session actions', 'focus on the menu button');
      await t.shot('refused');
      await ask(END_LIMITED);
      await page.click('End session', confirmButton('End session'));
      await page.waitFor('the alert', `${ALERT} === ${q(`Couldn't end the session. ${END_LIMITED_ERROR}`)}`);
      t.expect(server.records.requests.includes(`POST /api/sessions/${id(END_LIMITED)}/end 429`), 'answered 429', server.records.requests);
      t.expectEqual(
        server.records.ends.map((each) => each.status),
        [409, 429],
        'one each, and nothing ended',
      );
    });
  },
};

export default part;
