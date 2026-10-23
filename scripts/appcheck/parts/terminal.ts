// The Terminal tab (docs/design-system.md, 4: Terminal; D9, W54, W57): a running background session
// opens on it and attaches; a click on its row gives the terminal the keyboard, but a reload, or
// passing through with j, never does, and keys then reach no session; a click on the screen, or Tab,
// gives it the keyboard and F6 takes it back; a finished session opens on Conversation and asks
// before attaching restarts it. The fake server plays the attach socket with a made-up screen, and
// records every key and resize it's sent.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { attachStatus, focused, inTerminal, openFinished, openFromRow, row, shownHint, terminalText, VIEW, viewName, viewTab, viewTabButton } from './_dom.js';

const q = JSON.stringify;
const TYPE_HINT = 'Click the terminal, or Tab to it, to type to the session';
const SCREEN = `${VIEW}?.querySelector('.attach-terminal')`;

const part: Part = {
  name: 'terminal',
  title: 'The Terminal tab: attached from a row with the keyboard; no keyboard after a reload or j; restart asks first',
  async run(t) {
    const { page, server } = t;
    const keys = () => server.records.inputs.filter((each) => each.type === 'input').map((each) => `${each.name}: ${JSON.stringify(each.data)}`);
    const resizes = () => server.records.inputs.filter((each) => each.type === 'resize').length;
    const attached = async (name: string) => {
      await page.waitFor(`the ${name} view`, `${viewName} === ${q(name)}`);
      await page.waitFor('the attach', `${attachStatus} === 'attached'`);
      await page.waitFor('the made-up screen', `(${terminalText}).includes('made-up session')`);
      // A moment for anything that would take focus late.
      await page.settle(150);
    };

    await t.step('a click on a running background session opens its Terminal, attached, with the keyboard', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.running);
      t.expectEqual(await page.evaluate(viewTab), 'Terminal', 'it opens on Terminal');
      await attached(NAMES.running);
      t.expectEqual(server.records.attaches.map((each) => each.name), [NAMES.running], 'attached once, to it');
      t.expect(await page.evaluate(`${viewTabButton('Terminal')}.textContent.includes(', attached')`), 'the tab says it is attached');
      t.expect(await page.evaluate(inTerminal), 'the terminal has the keyboard after a click on its row', await page.evaluate(focused));
      t.expectEqual(await page.evaluate(shownHint), 'leave', "the bar shows F6's hint while it has the keyboard");
      await t.shot('row-attached');
    });

    await t.step('a key then reaches the session', async () => {
      await page.key('x');
      await page.settle(100);
      t.expectEqual(keys(), [`${NAMES.running}: "x"`], 'the key, once, to that session');
    });

    let prompting = '';
    await t.step('after a reload it attaches but takes no keyboard, and keys reach nothing', async () => {
      prompting = await page.evaluate<string>(`${row(NAMES.prompting)}?.dataset.openSession ?? ''`);
      await page.navigate(`/?view=all&session=${prompting}`);
      await attached(NAMES.prompting);
      server.clearRecords();
      await page.reload();
      await attached(NAMES.prompting);
      t.expectEqual(server.records.attaches.map((each) => each.name), [NAMES.prompting], 'it attached again after the reload');
      t.expect(!(await page.evaluate(inTerminal)), 'the terminal takes no keyboard', await page.evaluate(focused));
      t.expectEqual(await page.evaluate(focused), 'the page', 'nothing has focus');
      t.expectEqual(await page.evaluate(shownHint), 'type', 'the bar says how to type to it');
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('.attach-type-hint').textContent`), TYPE_HINT, 'the hint');
      await t.shot('reload-no-focus');
      // Enter would approve the prompt's first option; `/compact` and Enter would send a slash command.
      for (const key of ['Enter', 'Enter', '/', 'c', 'Enter']) await page.key(key);
      await page.settle(150);
      t.expectEqual(keys(), [], 'no key reached any session');
    });

    await t.step('a click on the screen gives it the keyboard, without resizing it', async () => {
      // Below 1,200 px the `/` above closed the view over the list, and focused the filter: open it again.
      if ((await page.evaluate(viewName)) !== NAMES.prompting) {
        await page.navigate(`/?view=all&session=${prompting}`);
        await attached(NAMES.prompting);
        server.clearRecords();
      }
      const before = resizes();
      await page.click('the screen', SCREEN);
      await page.settle(100);
      t.expect(await page.evaluate(inTerminal), 'the terminal has the keyboard', await page.evaluate(focused));
      t.expectEqual(await page.evaluate(shownHint), 'leave', "F6's hint now");
      await page.key('y');
      await page.settle(100);
      t.expectEqual(keys(), [`${NAMES.prompting}: "y"`], 'a key reaches the session');
      t.expectEqual(resizes(), before, 'focus coming in resized nothing');
    });

    await t.step('F6 takes the keyboard back to the Terminal tab', async () => {
      await page.key('F6');
      t.expect(await page.evaluate(`document.activeElement?.getAttribute('role') === 'tab'`), 'focus is on the tab', await page.evaluate(focused));
      t.expectEqual(await page.evaluate(shownHint), 'type', 'the type hint is back');
      await page.key('z');
      await page.settle(100);
      t.expectEqual(keys(), [`${NAMES.prompting}: "y"`], 'the next key reaches nothing');
    });

    await t.step('j passing through attaches only the session it rests on, with no keyboard', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.conversation);
      await page.evaluate(`${VIEW}.querySelector('h2').focus()`);
      for (const name of [NAMES.running, NAMES.running2, NAMES.running3]) {
        await page.key('j');
        await page.waitFor(name, `${viewName} === ${q(name)}`, 2000);
      }
      t.expectEqual(server.records.attaches, [], 'nothing attached while passing through');
      await page.waitFor('the attach', `${attachStatus} === 'attached'`, 3000);
      await page.settle(150);
      t.expectEqual(server.records.attaches.map((each) => each.name), [NAMES.running3], 'only the one it rested on attached');
      t.expectEqual(await page.evaluate(focused), 'the view heading', 'focus stays on the view heading');
      t.expectEqual(await page.evaluate(shownHint), 'type', 'the bar says how to type to it');
    });

    await t.step('a finished session opens on Conversation, and its Terminal asks before restarting it', async () => {
      await t.fresh({ search: '?view=all' });
      await openFinished(t);
      await openFromRow(t, NAMES.finished);
      await page.settle(200);
      t.expectEqual(await page.evaluate(viewTab), 'Conversation', 'it opens on Conversation');
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('.session-view-note')?.textContent`), 'To message it, open its Terminal tab, which asks before restarting it.', 'its note');
      await page.click('the Terminal tab', viewTabButton('Terminal'));
      await page.waitFor('the question', `!!${VIEW}.querySelector('.attach .inline-confirm[role="alertdialog"]')`);
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('.attach .inline-confirm-question').textContent`), 'Restart and attach?', 'it asks first');
      t.expectEqual(server.records.attaches, [], 'nothing attached before the answer');
      await t.shot('restart-asks');
      await page.click('Restart and attach', `[...${VIEW}.querySelectorAll('.attach .inline-confirm button')].find((b) => b.textContent.trim() === 'Restart and attach')`);
      await page.waitFor('the attach', `${attachStatus} === 'attached'`, 3000);
      t.expectEqual(server.records.attaches, [{ sessionId: server.world.byName(NAMES.finished).sessionId, name: NAMES.finished, restart: true }], 'attached once, as a restart');
    });
  },
};

export default part;
