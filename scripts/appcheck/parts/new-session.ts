// The New session dialog (docs/design-system.md, 4: Dialogs; W12): from the header or `n`, with the
// roots' directories; Start session asks for a first prompt; a start says so in a toast, and the
// session's view opens once the index lists it, as the fake server does a moment later; Cancel closes
// it. W63's switch to the new session's group and tab is its own part, new-session-selected.

import { API_SERVER, CODE, DEMO_APP } from '../fixtures.js';
import type { Part } from '../runner.js';
import { chooseOption, DIALOG, dialogBox, dialogButton, dialogName, focused, headerButton, openDialog, toasts, viewName } from './_dom.js';

const q = JSON.stringify;
const field = (label: string) => `[...(${DIALOG}?.querySelectorAll('input, select, textarea') ?? [])].find((el) => el.labels?.[0]?.textContent.trim().startsWith(${q(label)}))`;
const DIRECTORY = field('Directory');
const PROMPT = field('First prompt');
const FIRST_PROMPT = 'A made-up first prompt for the app check.';

const part: Part = {
  name: 'new-session',
  title: 'The New session dialog: its fields, a missing prompt, a start that opens the session once listed, and Cancel',
  async run(t) {
    const { page, server } = t;
    const name = `pitwall-test-appcheck-${t.at}`;

    await t.step('opens from the header, with the roots and their directories', async () => {
      await t.fresh({ search: '?view=all' });
      await openDialog(t, 'New session');
      const labels = await page.evaluate<string[]>(`[...${DIALOG}.querySelectorAll('label.field-label')].map((l) => l.textContent.trim())`);
      t.expectEqual(labels, ['Directory', 'Name optional', 'Model optional', 'First prompt'], 'its fields');
      const values = await page.evaluate<string[]>(`[...${DIRECTORY}.options].map((o) => o.value)`);
      for (const dir of [CODE, API_SERVER, DEMO_APP]) t.expect(values.includes(dir), `it offers ${dir}`, values);
      t.expect(await page.evaluate(`document.activeElement === ${DIRECTORY}`), 'focus is on Directory, its first field', await page.evaluate(focused));
      t.expect(await page.evaluate(`!!${dialogButton('Start session')} && !!${dialogButton('Cancel')}`), 'Start session and Cancel');
      const card = await page.evaluate<{ left: number; right: number; top: number; bottom: number }>(dialogBox);
      t.expect(card.left >= 15.5 && card.right <= t.viewport.width - 15.5 && card.top >= 0 && card.bottom <= t.viewport.height, 'inside the window', card);
      await t.shot('open');
    });

    await t.step('Start session asks for a first prompt, and starts nothing', async () => {
      await page.click('Start session', dialogButton('Start session'));
      await page.waitFor('the problem', `!!${DIALOG}.querySelector('.field-problem')`);
      t.expect(await page.evaluate(`document.activeElement === ${PROMPT}`), 'focus goes to the first prompt', await page.evaluate(focused));
      t.expect(await page.evaluate(`(${PROMPT}).getAttribute('aria-describedby')?.split(' ').some((id) => document.getElementById(id)?.classList.contains('field-problem'))`), 'the prompt is described by its problem');
      t.expectEqual(server.records.spawns, [], 'nothing was started');
    });

    await t.step('starts a session, says so, and opens its view once it is listed', async () => {
      t.expectEqual(await page.evaluate(chooseOption(DIRECTORY, API_SERVER)), API_SERVER, 'the directory chosen');
      await page.click('Name', field('Name'));
      await page.type(name);
      await page.click('First prompt', PROMPT);
      await page.type(FIRST_PROMPT);
      await page.click('Start session', dialogButton('Start session'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expect((await page.evaluate<string[]>(toasts)).includes(`Started ${name}. Its view opens when it shows up in the list.`), 'the toast says it started', await page.evaluate(toasts));
      t.expectEqual(server.records.spawns, [{ cwd: API_SERVER, name, promptLength: FIRST_PROMPT.length }], 'the fake server got the start, once');
      await page.waitFor('its view', `${viewName} === ${q(name)}`, 8000);
      t.expect(await page.evaluate(`[...document.querySelectorAll('.session-list [data-open-session]')].some((el) => el.textContent.trim() === ${q(name)})`), 'its row is listed');
      await t.shot('started');
    });

    await t.step('Cancel closes it, with focus back on New session', async () => {
      await t.fresh({ search: '?view=all' });
      await openDialog(t, 'New session');
      await page.click('Cancel', dialogButton('Cancel'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expect(await page.evaluate(`document.activeElement === ${headerButton('New session')}`), 'focus is back on New session', await page.evaluate(focused));
    });

    await t.step('n opens it', async () => {
      await page.evaluate(`(document.activeElement?.blur(), true)`);
      await page.key('n');
      await page.waitFor('the dialog', `${dialogName} === 'New session'`);
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${DIALOG}`);
    });
  },
};

export default part;
