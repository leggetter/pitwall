// The Terminal tab (docs/design-system.md, 4: Terminal; D9, W54, W57): a running background session
// opens on it and attaches; a click on its row gives the terminal the keyboard, but a reload, or
// passing through with j, never does, and keys then reach no session; a click on the screen, or Tab,
// gives it the keyboard and F6 takes it back; a finished session opens on Conversation and asks
// before attaching restarts it. The screen's last row and column are inside its visible box, at the
// window's height and at shorter ones, and the session is drawn at the terminal's size (W74). The
// fake server plays the attach socket with a made-up screen that fills the terminal at the size it's
// given, and records every key, resize and size it's sent.

import { FOOTER_END, NAMES } from '../fixtures.js';
import type { Case, Part } from '../runner.js';
import { attachStatus, focused, inTerminal, openFinished, openFromRow, row, shownHint, terminalText, VIEW, viewName, viewTab, viewTabButton } from './_dom.js';

const q = JSON.stringify;
const TYPE_HINT = 'Click the terminal, or Tab to it, to type to the session';
const SCREEN = `${VIEW}?.querySelector('.attach-terminal')`;

/** Where the screen's last row and column are, and the box they must be inside (FIT). */
interface Fit {
  /** The terminal's rows, as xterm.js draws them. */
  rows: number;
  /** One cell's height and width, in px. */
  cell: { height: number; width: number };
  /** The screen's content box, inside its 6 px padding, less the scrollbar's track at its right. */
  visible: { top: number; right: number; bottom: number; left: number };
  /** The scrollbar track's width, 0 when xterm.js draws none where FIT looks for it. */
  track: number;
  /** The last row's bottom and the last column's right edge. */
  last: { bottom: number; right: number };
  /** The last row's text, and the right edge of FOOTER_END in it, when it's there. */
  lastRow: string;
  footerEnd: number | undefined;
}

/**
 * The screen's fit (W74). The box its text must be inside is the screen's content box, inside the
 * 6 px padding that the design keeps clear (4: Terminal), less the track xterm.js keeps at the right
 * of its element for its scrollbar, which covers what's under it once there's scrollback. xterm.js
 * sizes .xterm-screen to its rows and columns of cells, so its right edge is the last column's; the
 * last row's own box gives the last row's bottom. FOOTER_END is the made-up footer's end, drawn in
 * the session's last column, so where it ends says what width the session was drawn at.
 */
const FIT = `(() => {
  const outer = ${SCREEN};
  const screen = outer?.querySelector('.xterm-screen');
  const rows = outer ? [...outer.querySelectorAll('.xterm-rows > div')] : [];
  if (!outer || !screen || rows.length === 0) return null;
  const style = getComputedStyle(outer);
  const box = outer.getBoundingClientRect();
  const visible = {
    top: box.top + parseFloat(style.paddingTop),
    right: box.right - parseFloat(style.paddingRight),
    bottom: box.bottom - parseFloat(style.paddingBottom),
    left: box.left + parseFloat(style.paddingLeft),
  };
  const track = outer.querySelector('.xterm .scrollbar.vertical')?.getBoundingClientRect();
  const trackWidth = track?.width ?? 0;
  if (track && trackWidth > 0) visible.right = Math.min(visible.right, track.left);
  const drawn = screen.getBoundingClientRect();
  const last = rows[rows.length - 1];
  const end = [...last.querySelectorAll('span')].find((span) => span.textContent === ${q(FOOTER_END)});
  const width = end ? end.getBoundingClientRect().width / ${FOOTER_END.length} : 0;
  return {
    rows: rows.length,
    cell: { height: drawn.height / rows.length, width },
    visible,
    track: trackWidth,
    last: { bottom: last.getBoundingClientRect().bottom, right: drawn.right },
    lastRow: last.textContent,
    footerEnd: end ? end.getBoundingClientRect().right : undefined,
  };
})()`;

/** How far apart two edges may be and still be the same, for subpixel layout. */
const SUBPIXEL = 0.5;

/** Whether the session's size, the last one the page gave it, is the terminal's, and its screen is drawn at it. */
function drawnAtSize(fit: Fit | null, size: { cols: number; rows: number } | undefined): boolean {
  return (
    fit !== null &&
    size !== undefined &&
    size.rows === fit.rows &&
    fit.lastRow.trimEnd().endsWith(FOOTER_END) &&
    fit.footerEnd !== undefined &&
    Math.abs(fit.footerEnd - fit.last.right) < fit.cell.width / 2
  );
}

/**
 * Checks the screen's fit as it is now (W74): the last row and column are inside the visible box,
 * the last row is the made-up footer, and the session has the terminal's size, as the footer's end
 * in the last column shows. It waits up to a second for a resize and its redraw to land.
 */
async function expectFits(t: Case, name: string, where: string): Promise<Fit | null> {
  const size = () => t.server.records.sizes.filter((each) => each.name === name).at(-1);
  let fit: Fit | null = null;
  for (let tries = 0; tries < 10; tries += 1) {
    await t.page.settle(100);
    fit = await t.page.evaluate<Fit | null>(FIT);
    if (drawnAtSize(fit, size())) break;
  }
  if (!fit) {
    t.expect(false, `${where}: the screen is there`);
    return null;
  }
  const { visible, last } = fit;
  const px = (value: number) => `${Math.round(value * 10) / 10} px`;
  // Without the track, the column check would measure against the content box alone, which the
  // last column never ran past: it would pass on the code it was written to fail (W74).
  t.expect(fit.track > 0, `${where}: xterm.js's scrollbar track is there, for the last column to be clear of`, 'no .xterm .scrollbar.vertical with a width: has xterm.js changed how it draws its scrollbar?');
  t.expect(last.bottom <= visible.bottom + SUBPIXEL, `${where}: the last row is inside the visible box`, `its bottom is ${px(last.bottom - visible.bottom)} below the box's, at ${fit.rows} rows of ${px(fit.cell.height)}`);
  t.expect(last.right <= visible.right + SUBPIXEL, `${where}: the last column is inside the visible box, clear of the scrollbar's track`, `its right edge is ${px(last.right - visible.right)} past the box's`);
  t.expect(fit.lastRow.trimEnd().endsWith(FOOTER_END), `${where}: the last row has the made-up footer`, fit.lastRow.trimEnd().slice(-40));
  const sent = size();
  t.expectEqual(sent?.rows, fit.rows, `${where}: the session has the terminal's rows`);
  t.expect(
    fit.footerEnd !== undefined && Math.abs(fit.footerEnd - last.right) < fit.cell.width / 2,
    `${where}: the session has the terminal's columns, its footer ending in the last column`,
    `the session has ${sent?.cols} columns, and the footer ends ${fit.footerEnd === undefined ? 'nowhere' : px(last.right - fit.footerEnd)} short of the last column's right edge`,
  );
  return fit;
}

/** The window heights the fit is checked at: the case's own, and five shorter ones 3 px apart, so a row's 17 px goes through most of its remainders. */
const HEIGHT_STEPS = [0, 3, 6, 9, 12, 15];

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

    await t.step("the screen's last row and column are inside its visible box, at this height and at shorter ones, and the session has its size", async () => {
      await expectFits(t, NAMES.running, 'on attach');
      for (const less of HEIGHT_STEPS.slice(1)) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: t.viewport.width, height: t.viewport.height - less, deviceScaleFactor: 1, mobile: false });
        await expectFits(t, NAMES.running, `${less} px shorter`);
      }
      await page.send('Emulation.setDeviceMetricsOverride', { width: t.viewport.width, height: t.viewport.height, deviceScaleFactor: 1, mobile: false });
      await expectFits(t, NAMES.running, 'back at the window height');
      await t.shot('fits');
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
      await expectFits(t, NAMES.prompting, 'after the reload');
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

    await t.step('F6 takes the keyboard back to the Terminal tab, without resizing it', async () => {
      const before = resizes();
      await page.key('F6');
      t.expect(await page.evaluate(`document.activeElement?.getAttribute('role') === 'tab'`), 'focus is on the tab', await page.evaluate(focused));
      t.expectEqual(await page.evaluate(shownHint), 'type', 'the type hint is back');
      await page.key('z');
      await page.settle(100);
      t.expectEqual(keys(), [`${NAMES.prompting}: "y"`], 'the next key reaches nothing');
      t.expectEqual(resizes(), before, 'focus going out resized nothing');
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
      await expectFits(t, NAMES.running3, 'stepped onto');
    });

    await t.step('a finished session opens on Conversation, and its Terminal asks before restarting it', async () => {
      await t.fresh({ search: '?view=all' });
      await openFinished(t);
      await openFromRow(t, NAMES.finished);
      await page.settle(200);
      t.expectEqual(await page.evaluate(viewTab), 'Conversation', 'it opens on Conversation');
      // Since W107 it can be resumed in the background too, beside how to message it.
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('.session-view-note')?.textContent`), 'To message it, open its Terminal tab, which asks before restarting it, or resume it here in the background.', 'its note');
      t.expect(await page.evaluate<boolean>(`[...${VIEW}.querySelectorAll('.ended-actions button')].some((b) => b.textContent.trim() === 'Resume in background')`), 'Resume in background beside it');
      await page.click('the Terminal tab', viewTabButton('Terminal'));
      await page.waitFor('the question', `!!${VIEW}.querySelector('.attach .inline-confirm[role="alertdialog"]')`);
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('.attach .inline-confirm-question').textContent`), 'Restart and attach?', 'it asks first');
      t.expectEqual(server.records.attaches, [], 'nothing attached before the answer');
      await t.shot('restart-asks');
      await page.click('Restart and attach', `[...${VIEW}.querySelectorAll('.attach .inline-confirm button')].find((b) => b.textContent.trim() === 'Restart and attach')`);
      await page.waitFor('the attach', `${attachStatus} === 'attached'`, 3000);
      t.expectEqual(server.records.attaches, [{ sessionId: server.world.byName(NAMES.finished).sessionId, name: NAMES.finished, restart: true }], 'attached once, as a restart');
      await expectFits(t, NAMES.finished, 'after the restart');
    });
  },
};

export default part;
