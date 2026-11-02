// The Preferences dialog (docs/design-system.md, 4: Preferences and Dialogs; W59, W62): from the
// header, 624 px wide where there's room and never over the repo list from 900 px, inside the window
// with its body scrolling on a short one; Tab stays inside it; a choice applies at once; Escape and
// Close close it, with focus back on its button. Then what its Session view settings do, and its
// Models and effort (W119): a Model and an Effort select per kind of work, each from its default, the
// costs, and a change sent to the server at once.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { chooseOption, DIALOG, dialogBox, dialogButton, dialogName, focused, headerButton, inTerminal, openDialog, openFromRow, row, shownHint, VIEW, viewClose, viewTab, attachStatus } from './_dom.js';

const q = JSON.stringify;
const group = (legend: string) => `[...(${DIALOG}?.querySelectorAll('fieldset') ?? [])].find((f) => f.querySelector('legend')?.textContent === ${q(legend)})`;
const radio = (legend: string, label: string) => `[...(${group(legend)}?.querySelectorAll('input[type="radio"]') ?? [])].find((r) => r.labels[0]?.textContent === ${q(label)})`;
const chosen = (legend: string) => `[...(${group(legend)}?.querySelectorAll('input[type="radio"]') ?? [])].find((r) => r.checked)?.labels[0]?.textContent`;
const stored = (key: string) => `localStorage.getItem(${q(key)})`;
/** A Models and effort row's select (W119), by the row's name and the select's label. */
const workSelect = (kind: string, label: 'Model' | 'Effort') =>
  `[...(${DIALOG}?.querySelectorAll('.work-row') ?? [])].find((r) => r.querySelector('.work-row-name')?.textContent === ${q(kind)})?.querySelector('select[id$="-${label === 'Model' ? 'model' : 'effort'}"]')`;
/** The selects in the order Tab reaches them. */
const WORK_SELECTS = ['Sessions/Model', 'Sessions/Effort', "Sessions' sub-agents/Model", 'Supervisor/Model', 'Supervisor/Effort', 'Recaps/Model', 'Recaps/Effort', 'Relay/Model', 'Relay/Effort'];
/** The group line 2 of a row names, in All sessions. */
const rowGroup = (name: string) => `${row(name)}?.closest('li')?.querySelector('.session-group')?.textContent?.replace(/ · $/, '')`;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

const part: Part = {
  name: 'preferences',
  title: 'The Preferences dialog: size, focus, Tab, choices that apply at once, Escape and Close; its Session view settings; and Models and effort',
  async run(t) {
    const { page, server } = t;
    const width = Math.min(624, t.viewport.width - 32, ...(t.viewport.width >= 900 ? [t.viewport.width - 480] : []));

    await t.step('opens from the header, with focus on its first choice', async () => {
      await t.fresh({ search: '?view=all' });
      await openDialog(t, 'Preferences');
      await page.waitFor('Models and effort to load', `!!${workSelect('Relay', 'Effort')}`);
      t.expectEqual(await page.evaluate(`[...${DIALOG}.querySelectorAll('h3')].map((h) => h.textContent)`), ['Repo list', 'Session view', 'Models and effort'], 'three sections');
      t.expectEqual(await page.evaluate(`[...${DIALOG}.querySelectorAll('legend')].map((l) => l.textContent)`), ['Group sessions by', 'Open running background sessions on', 'The terminal takes the keyboard'], 'three settings');
      t.expectEqual(await page.evaluate(focused), 'Group sessions by/Main repo', "focus on the first group's choice");
      const card = await page.evaluate<Box>(dialogBox);
      t.expect(card.left >= 15.5 && card.right <= t.viewport.width - 15.5, 'inside the window, 16 px from its sides at the least', card);
      t.expect(card.top >= 47.5 && card.bottom <= t.viewport.height - 47.5, 'inside the window less 96 px tall', card);
      t.expect(Math.abs(card.width - width) < 1, `${width} px wide`, card.width);
      if (t.viewport.width >= 900) {
        const nav = await page.evaluate<number>(`document.querySelector('nav[aria-label="Repos"]').getBoundingClientRect().right`);
        t.expect(nav <= card.left + 0.5, 'the repo list is in sight beside it', { nav, card: card.left });
      }
      if (t.viewport.height < 600) {
        t.expect(await page.evaluate(`(() => { const b = ${DIALOG}.querySelector('.dialog-body'); return b.scrollHeight > b.clientHeight; })()`), 'on a short window its body scrolls');
      }
      await t.shot('open');
    });

    await t.step('Tab and Shift+Tab go round inside it', async () => {
      const order: string[] = [];
      for (let i = 0; i < 4 + WORK_SELECTS.length; i += 1) {
        await page.key('Tab');
        order.push(await page.evaluate<string>(focused));
        t.expect(await page.evaluate(`(() => { const r = document.activeElement.getBoundingClientRect(); const b = (${DIALOG}.querySelector('.dialog-body').contains(document.activeElement) ? ${DIALOG}.querySelector('.dialog-body') : ${DIALOG}).getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1; })()`), `${order.at(-1)} is in view as it takes focus`);
      }
      t.expectEqual(
        order,
        ['Open running background sessions on/Terminal', 'The terminal takes the keyboard/When you open it', ...WORK_SELECTS, 'Close', 'Group sessions by/Main repo'],
        "Tab goes from one group's choice to the next, then each model and effort, then Close, then round",
      );
      await page.key('Tab', { shift: true });
      t.expectEqual(await page.evaluate(focused), 'Close', 'Shift+Tab from the first choice goes to Close');
      await page.key('Tab', { shift: true });
      t.expectEqual(await page.evaluate(focused), 'Relay/Effort', 'and on back to the last select');
      t.expect(await page.evaluate(`${DIALOG}.contains(document.activeElement)`), 'focus never left the dialog');
    });

    await t.step('↓ chooses the next option, which applies at once', async () => {
      await page.key('Tab');
      await page.key('Tab');
      t.expectEqual(await page.evaluate(focused), 'Group sessions by/Main repo', 'back on the first choice');
      const before = await page.evaluate(rowGroup(NAMES.fromRoot));
      await page.key('ArrowDown');
      t.expectEqual(await page.evaluate(chosen('Group sessions by')), 'Where it started', '↓ chooses Where it started');
      t.expectEqual(await page.evaluate(stored('pitwall.group-by.v1')), 'where-started', 'and stores it');
      const after = await page.evaluate(rowGroup(NAMES.fromRoot));
      t.expect(before === 'api-server' && after !== before, `the page behind regroups: ${NAMES.fromRoot} moves from its main repo to where it started`, { before, after });
      t.expect(await page.evaluate(`!!${DIALOG}`), 'the dialog stays open');
      await page.key('ArrowUp');
      t.expectEqual(await page.evaluate(stored('pitwall.group-by.v1')), 'main-repo', '↑ chooses Main repo again');
    });

    await t.step("Models and effort: each kind from its default, the costs, and a change sent to pitwall's server at once (W119)", async () => {
      // A world with recaps on, for their cost.
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      await t.fresh({ search: '?view=all', recaps: 'ok' });
      await openDialog(t, 'Preferences');
      await page.waitFor('Models and effort to load', `!!${workSelect('Relay', 'Effort')}`);
      const first = (kind: string, label: 'Model' | 'Effort') => page.evaluate<string>(`${workSelect(kind, label)}?.options[0]?.textContent`);
      t.expectEqual(await first('Sessions', 'Model'), 'Default: opus, from the config file', "sessions' model, from the made-up config file");
      t.expectEqual(await first('Sessions', 'Effort'), 'Default: high, from the config file', "sessions' effort");
      t.expectEqual(await first('Recaps', 'Model'), 'Default: claude-haiku-5-5', "recaps' own model");
      t.expectEqual(await first('Supervisor', 'Model'), 'Default: claude-opus-5-5', "the supervisor's own model");
      t.expect(!(await page.evaluate(`!!${workSelect("Sessions' sub-agents", 'Effort')}`)), 'sub-agents have no Effort');
      t.expect(/Today: \$[0-9.]+ for \d+ of \d+ calls, at API list prices\./.test(await page.evaluate<string>(`${DIALOG}.textContent`)), "recaps' cost today");
      // Side by side in a row, or stacked below 480 px.
      const [model, effort] = await page.evaluate<Box[]>(`[${workSelect('Recaps', 'Model')}, ${workSelect('Recaps', 'Effort')}].map((s) => { const r = s.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; })`);
      if (t.viewport.width < 480) t.expect(Math.abs(model!.left - effort!.left) < 1 && effort!.top >= model!.bottom, 'Model and Effort stack below 480 px', { model, effort });
      else t.expect(Math.abs(model!.top - effort!.top) < 1 && effort!.left >= model!.right, 'Model and Effort side by side', { model, effort });
      t.expectEqual(await page.evaluate(chooseOption(workSelect('Recaps', 'Effort'), 'low')), 'low', 'recaps at low effort');
      await page.settle(300);
      t.expectEqual(server.records.workPosts, [{ overrides: { session: {}, subagents: {}, supervisor: {}, recaps: { effort: 'low' }, relay: {} }, status: 200 }], 'the whole set of overrides, sent once');
      t.expect(await page.evaluate(`!${DIALOG}.querySelector('.inline-alert.danger')`), 'no error');
      await page.evaluate(`${workSelect('Recaps', 'Effort')}.scrollIntoView({ block: 'center' })`);
      await t.shot('models-and-effort');
      t.expectEqual(await page.evaluate(chooseOption(workSelect('Recaps', 'Effort'), '')), '', 'back to the default');
      await page.settle(300);
      t.expectEqual(server.records.workPosts.length, 2, 'sent again');
    });

    await t.step('Escape closes it, with focus back on Preferences', async () => {
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expect(await page.evaluate(`document.activeElement === ${headerButton('Preferences')}`), 'focus is back on Preferences', await page.evaluate(focused));
    });

    await t.step('its Close button closes it', async () => {
      await openDialog(t, 'Preferences');
      await page.click('Close', dialogButton('Close'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expect(await page.evaluate(`document.activeElement === ${headerButton('Preferences')}`), 'focus is back on Preferences', await page.evaluate(focused));
    });

    await t.step('Conversation: a running background session opens on Conversation, attaching nothing', async () => {
      await openDialog(t, 'Preferences');
      await page.click('Conversation', `${radio('Open running background sessions on', 'Conversation')}?.labels[0]`);
      t.expectEqual(await page.evaluate(stored('pitwall.background-tab.v1')), 'conversation', 'stored');
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      await openFromRow(t, NAMES.running);
      await page.settle(700);
      t.expectEqual(await page.evaluate(viewTab), 'Conversation', 'it opens on Conversation');
      t.expectEqual(server.records.attaches, [], 'and attaches nothing');
    });

    await t.step('Never: a click on a row attaches, but the terminal takes no keyboard', async () => {
      if (t.layout !== 'three-columns') {
        await page.click('Close', viewClose);
        await page.waitFor('the view to close', `!${VIEW}?.querySelector('h2')`);
      }
      await openDialog(t, 'Preferences');
      await page.click('Terminal', `${radio('Open running background sessions on', 'Terminal')}?.labels[0]`);
      await page.click('Never', `${radio('The terminal takes the keyboard', 'Never')}?.labels[0]`);
      t.expectEqual(await page.evaluate(stored('pitwall.terminal-focus.v1')), 'never', 'stored');
      await t.shot('session-choices');
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${dialogName}`);
      await openFromRow(t, NAMES.running2);
      t.expectEqual(await page.evaluate(viewTab), 'Terminal', 'Terminal again');
      await page.waitFor('the attach', `${attachStatus} === 'attached'`);
      await page.settle(300);
      t.expect(!(await page.evaluate(inTerminal)), 'the terminal takes no keyboard after a click on its row', await page.evaluate(focused));
      t.expectEqual(await page.evaluate(shownHint), 'type', 'the bar says how to type to it');
    });
  },
};

export default part;
