// The New session dialog (docs/design-system.md, 4: Dialogs; W12): from the header or `n`, with the
// roots' directories; Start session asks for a first prompt; a start says so in a toast, and the
// session's view opens once the index lists it, as the fake server does a moment later; "Another
// directory under a root…" reveals the directory autocomplete (W70), which narrows as you type, takes
// an option from the keyboard, and starts a session in it; Cancel closes it. W63's switch to the new
// session's group and tab is its own part, new-session-selected.

import { API_SERVER, CODE, DEMO_APP, DEMO_APP_WEB } from '../fixtures.js';
import type { Part } from '../runner.js';
import { chooseOption, DIALOG, dialogBox, dialogButton, dialogName, focused, headerButton, openDialog, toasts, viewName } from './_dom.js';

const q = JSON.stringify;
const field = (label: string) => `[...(${DIALOG}?.querySelectorAll('input, select, textarea') ?? [])].find((el) => el.labels?.[0]?.textContent.trim().startsWith(${q(label)}))`;
const DIRECTORY = field('Directory');
const PROMPT = field('First prompt');
const FIRST_PROMPT = 'A made-up first prompt for the app check.';
/** The select's "Another directory under a root…" choice. */
const OTHER = '\u0000other';
const COMBOBOX = `${DIALOG}?.querySelector('[role="combobox"]')`;
/** The options the list shows, as they read. */
const OPTIONS = `[...(${DIALOG}?.querySelectorAll('[role="listbox"] [role="option"]') ?? [])].filter((el) => !el.closest('[hidden]')).map((el) => el.textContent)`;
const EXPANDED = `${COMBOBOX}?.getAttribute('aria-expanded')`;
const ACTIVE = `document.getElementById(${COMBOBOX}?.getAttribute('aria-activedescendant') ?? '')`;
/** Each request for the directory list, as the fake server recorded it. */
const listRequests = (requests: string[]) => requests.filter((request) => request.startsWith('GET /api/directories '));

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

    await t.step('Another directory under a root… reveals the autocomplete, with focus in it, which narrows as you type', async () => {
      await t.fresh({ search: '?view=all' });
      await openDialog(t, 'New session');
      await page.evaluate(chooseOption(DIRECTORY, OTHER));
      await page.waitFor('the combobox to take focus', `document.activeElement === ${COMBOBOX}`);
      await page.waitFor('its list', `${EXPANDED} === 'true' && ${OPTIONS}.length > 0`);
      t.expectEqual(
        await page.evaluate(OPTIONS),
        ['~/code/api-server, repo', '~/code/demo-app, repo', '~/code/docs-site, repo', '~/code/notes', '~/code/api-server/cmd', '~/code/demo-app/docs', '~/code/demo-app/web', '~/code/api-server/cmd/server'],
        'the directories under the root, shallower first, repos marked',
      );
      t.expectEqual(await page.evaluate(`${COMBOBOX}.getAttribute('aria-controls') === ${DIALOG}.querySelector('[role="listbox"]').id`), true, 'it controls its listbox');
      t.expectEqual(listRequests(server.records.requests), ['GET /api/directories 200'], 'the list was fetched, once');
      await page.type('web');
      await page.waitFor('the list to narrow', `${OPTIONS}.length === 1`);
      t.expectEqual(await page.evaluate(OPTIONS), ['~/code/demo-app/web'], 'only what matches');
      t.expectEqual(listRequests(server.records.requests).length, 1, 'typing asked the server nothing');
      await t.shot('directory-list');
    });

    await t.step('takes an option from the keyboard, and Escape closes only the list', async () => {
      await page.key('ArrowDown');
      t.expectEqual(await page.evaluate(`${ACTIVE}?.textContent`), '~/code/demo-app/web', '↓ highlights the option');
      const box = await page.evaluate<{ top: number; bottom: number; left: number; right: number }>(
        `(() => { const r = ${ACTIVE}.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`,
      );
      t.expect(box.top >= 0 && box.bottom <= t.viewport.height && box.left >= 0 && box.right <= t.viewport.width, 'the highlighted option is in the window', box);
      await page.key('Enter');
      t.expectEqual(await page.evaluate(`${COMBOBOX}.value`), '~/code/demo-app/web', 'Enter puts it in the field');
      t.expectEqual(await page.evaluate(EXPANDED), 'false', 'and closes the list');
      t.expect(await page.evaluate(`document.activeElement === ${COMBOBOX}`), 'focus stays in the field', await page.evaluate(focused));
      t.expectEqual(server.records.spawns, [], 'Enter started nothing');
      await page.key('ArrowDown');
      t.expectEqual(await page.evaluate(EXPANDED), 'true', '↓ opens it again');
      await page.key('Escape');
      t.expectEqual(await page.evaluate(EXPANDED), 'false', 'Escape closes the list');
      t.expectEqual(await page.evaluate(dialogName), 'New session', 'and leaves the dialog open');
    });

    await t.step('starts a session in the chosen directory, sending its absolute path', async () => {
      await page.click('First prompt', PROMPT);
      await page.type(FIRST_PROMPT);
      await page.click('Start session', dialogButton('Start session'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expectEqual(server.records.spawns, [{ cwd: DEMO_APP_WEB, promptLength: FIRST_PROMPT.length }], 'the fake server got the start, in the absolute path');
      t.expectEqual(listRequests(server.records.requests).length, 1, 'one list for the whole opening');
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
