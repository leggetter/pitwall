// A started session is selected once it's listed (W63, docs/design-system.md, 4: Dialogs): its group
// in the repo list, its row and its view, in one history entry, with its terminal attached but taking
// no keyboard; held, with an "is listed now" toast and Open, while the view open has a draft; and,
// started in a root tab you've left, it switches you back to that tab. Each time, focus is back on New
// session as the dialog goes, before anything that runs after (W83).

import { API_SERVER, CODE, DEMO_APP, NAMES } from '../fixtures.js';
import type { Case, Part } from '../runner.js';
import {
  attachStatus,
  chooseOption,
  DIALOG,
  dialogButton,
  dialogName,
  focused,
  headerButton,
  inTerminal,
  listHeading,
  openFromRow,
  openRepoList,
  selectedRepo,
  shownHint,
  toasts,
  VIEW,
  viewName,
} from './_dom.js';

const q = JSON.stringify;
const field = (label: string) => `[...(${DIALOG}?.querySelectorAll('input, select, textarea') ?? [])].find((el) => el.labels?.[0]?.textContent.trim().startsWith(${q(label)}))`;
const OPEN_ROW = `document.querySelector('.session-list [data-open-session][aria-current="true"]')?.textContent.trim()`;
const OPEN_TAB = `document.querySelector('header .root-tab[aria-selected="true"] .root-tab-label')?.textContent`;
const rootTab = (label: string) => `[...document.querySelectorAll('header .root-tab')].find((el) => el.querySelector('.root-tab-label')?.textContent === ${q(label)})`;
const toastSaying = (message: string) => `[...document.querySelectorAll('.toasts .toast:not(.leaving)')].find((el) => el.querySelector('.toast-message')?.textContent === ${q(message)})`;
const startedText = (name: string) => `Started ${name}. Its view opens when it shows up in the list.`;
const listedText = (name: string) => `${name} is listed now. It didn't open, so you keep your place.`;
/** The ids the fake server gives the sessions it starts. */
const STARTED_ID = '00000000-0000-4000-8000-000000064';
const MESSAGE_BOX = `${VIEW}?.querySelector('.relay-box textarea')`;

/**
 * Watches for the dialog leaving the page, and keeps what had focus at that moment in
 * window.__pwFocusAsDialogWent: a mutation observer's callback runs before React's next task, where a
 * passive effect's clean-up would have put focus back (W83). In this Chrome, a build without W83's fix
 * passes too: focus was already back by then, in the same task, so happy-dom is where the gap showed.
 * Dialog.test.tsx is the check that fails without the fix.
 */
const watchFocusAsDialogGoes = `(() => {
  const dialog = ${DIALOG};
  window.__pwFocusAsDialogWent = undefined;
  const observer = new MutationObserver(() => {
    if (dialog?.isConnected) return;
    observer.disconnect();
    window.__pwFocusAsDialogWent = ${focused};
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return true;
})()`;

/** New session from the header: a directory, a name and a first prompt, then Start session. */
async function start(t: Case, name: string, dir: string): Promise<void> {
  const { page } = t;
  await page.click('New session', headerButton('New session'));
  await page.waitFor('the New session dialog', `${dialogName} === 'New session'`);
  t.expectEqual(await page.evaluate(chooseOption(field('Directory'), dir)), dir, 'the directory chosen');
  await page.click('Name', field('Name'));
  await page.type(name);
  await page.click('First prompt', field('First prompt'));
  await page.type('A made-up first prompt for the app check.');
  await page.evaluate(watchFocusAsDialogGoes);
  await page.click('Start session', dialogButton('Start session'));
  await page.waitFor('the dialog to close', `!${DIALOG}`);
  t.expectEqual(await page.evaluate('window.__pwFocusAsDialogWent'), 'New session', 'focus is back on New session as the dialog goes (W83)');
}

/** The repo list's selected item: in the columns, or below 900 px in the drawer, opened and shut again. */
async function selectedInRepoList(t: Case): Promise<string | undefined> {
  if (t.layout !== 'drawer') return t.page.evaluate(selectedRepo);
  await openRepoList(t);
  const selected = await t.page.evaluate<string | undefined>(selectedRepo);
  await t.page.key('Escape');
  await t.page.waitFor('the drawer to close', `!document.querySelector('.repo-drawer')`);
  return selected;
}

/** Its terminal attached, without the keyboard, saying how to type to it. */
async function attachedQuietly(t: Case, name: string): Promise<void> {
  await t.page.waitFor('the attach', `${attachStatus} === 'attached'`, 5000);
  await t.page.settle(200);
  t.expect(t.server.records.attaches.some((each) => each.name === name), 'its view opened on Terminal and attached');
  t.expect(!(await t.page.evaluate(inTerminal)), 'its terminal took no keyboard', await t.page.evaluate(focused));
  t.expectEqual(await t.page.evaluate(shownHint), 'type', 'the bar says how to type to it');
}

const part: Part = {
  name: 'new-session-selected',
  title: "A started session selected once it's listed: its group and view; held with a draft; back in its root tab",
  async run(t) {
    const { page, server } = t;

    const switched = `pitwall-test-w64-${t.at}`;
    await t.step('from Needs you, it selects the started session, its group and its view', async () => {
      await t.fresh({ search: '?view=needs-you' });
      await start(t, switched, API_SERVER);
      t.expect((await page.evaluate<string[]>(toasts)).includes(startedText(switched)), 'the toast says it started', await page.evaluate(toasts));
      await page.waitFor('its view', `${viewName} === ${q(switched)}`, 8000);
      await page.settle(200);
      t.expect((await page.evaluate<string>('location.search')).startsWith(`?repo=${API_SERVER}&session=${STARTED_ID}`), 'the URL selects its group and opens it', await page.evaluate('location.search'));
      t.expectEqual(await page.evaluate(listHeading), 'api-server', 'the session list shows its group');
      t.expectEqual(await page.evaluate(OPEN_ROW), switched, 'its row is the open one');
      t.expectEqual(await page.evaluate(focused), 'New session', 'focus stays on New session, where the dialog gave it back');
      await attachedQuietly(t, switched);
      await t.shot('switched');
      t.expectEqual(await selectedInRepoList(t), 'api-server', 'the repo list selects its group');
    });

    const held = `pitwall-test-w64-held-${t.at}`;
    await t.step('with a draft in the open view, it holds, and a toast says it is listed, with Open', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.conversation);
      const before = await page.evaluate<string>('location.search');
      await page.click('the message box', MESSAGE_BOX);
      await page.type('A made-up draft, kept.');
      await start(t, held, DEMO_APP);
      await page.waitFor('the listed toast', `!!${toastSaying(listedText(held))}`, 8000);
      await page.settle(200);
      t.expectEqual(await page.evaluate(viewName), NAMES.conversation, 'the view with the draft stays');
      t.expectEqual(await page.evaluate(`${MESSAGE_BOX}.value`), 'A made-up draft, kept.', 'and keeps its draft');
      t.expectEqual(await page.evaluate('location.search'), before, 'the URL stays');
      t.expectEqual(await page.evaluate(listHeading), 'All sessions', 'the selection stays');
      t.expect(await page.evaluate(`[...${toastSaying(listedText(held))}.querySelectorAll('button')].some((el) => el.textContent.trim() === 'Open')`), 'the toast has Open');
      t.expect(!(await page.evaluate<string[]>(toasts)).includes(startedText(held)), 'it replaced the toast that said it started', await page.evaluate(toasts));
      await t.shot('held');
    });

    await t.step("the toast's Open selects it, its group and its view", async () => {
      await page.click('Open', `[...${toastSaying(listedText(held))}.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Open')`);
      await page.waitFor('its view', `${viewName} === ${q(held)}`);
      await page.settle(200);
      t.expect((await page.evaluate<string>('location.search')).startsWith(`?repo=${DEMO_APP}&session=${STARTED_ID}`), 'the URL selects its group and opens it', await page.evaluate('location.search'));
      t.expectEqual(await page.evaluate(listHeading), 'demo-app', 'the session list shows its group');
      t.expectEqual(await page.evaluate(OPEN_ROW), held, 'its row is the open one');
      t.expectEqual(await page.evaluate(focused), 'the view heading', "focus is on the view's heading");
      t.expect(!(await page.evaluate<string[]>(toasts)).includes(listedText(held)), 'the toast went');
      await attachedQuietly(t, held);
    });

    const tabbed = `pitwall-test-w64-tab-${t.at}`;
    await t.step('started in a root tab you have left, it switches back to that tab', async () => {
      await t.fresh({ search: `?view=all&root=${CODE}`, roots: 2 });
      await start(t, tabbed, API_SERVER);
      await page.click('the ~/oss tab', rootTab('~/oss'));
      t.expectEqual(await page.evaluate(OPEN_TAB), '~/oss', '~/oss is open while it starts');
      t.expect(server.records.spawns.length === 1, 'the start was sent');
      await page.waitFor('the switch back', `${OPEN_TAB} === '~/code' && ${viewName} === ${q(tabbed)}`, 8000);
      await page.settle(200);
      t.expect((await page.evaluate<string>('location.search')).startsWith(`?repo=${API_SERVER}&root=${CODE}&session=${STARTED_ID}`), 'the URL names its tab, group and session', await page.evaluate('location.search'));
      t.expectEqual(await page.evaluate(listHeading), 'api-server', 'the session list shows its group');
      t.expectEqual(await page.evaluate(OPEN_ROW), tabbed, 'its row is the open one');
      await attachedQuietly(t, tabbed);
      await t.shot('back-in-its-tab');
    });
  },
};

export default part;
