// Trust a folder from pitwall (W214, spike 020; docs/design-system.md, Terminal and Dialogs): a start
// in a folder Claude Code doesn't trust gets the "Workspace not trusted" card, with Trust this folder…
// after the command to copy. It opens Claude Code's own trust prompt in the page, a terminal on the
// fake server's TRUST_PATH socket, inside the dialog at every width. Cancel closes it and puts focus
// back on the button; declined says nothing was trusted and leaves the card; trusted sends the start
// again, which the fake server now takes, so the session starts. Resume's card has the same button,
// and once trusted the session resumes. Everything is driven by clicks and the fake server's messages,
// never a key press (W64): the four keys' filter is the unit tests'.

import { DEMO_APP, NAMES, UNTRUSTED_DIR } from '../fixtures.js';
import type { Case, Part } from '../runner.js';
import { chooseDirectory, DIALOG, dialogBox, dialogButton, focused, openDialog, toasts, VIEW, viewName, viewTab } from './_dom.js';

const q = JSON.stringify;
const TRUST_BUTTON = 'Trust this folder…';
const PROMPT_LINE = "Claude Code's own trust prompt. Use ↑ ↓ and Enter.";
const HERE_START = 'Or answer the prompt here, and the session starts once the folder is trusted.';
const HERE_RESUME = 'Or answer the prompt here, and the session resumes once the folder is trusted.';
const DECLINED_START = "Claude Code didn't trust this folder";
const FIRST_PROMPT = 'A made-up first prompt for the trust check.';

const field = (label: string) => `[...(${DIALOG}?.querySelectorAll('input, select, textarea') ?? [])].find((el) => el.labels?.[0]?.textContent.trim().startsWith(${q(label)}))`;
/** The card's trust block, in `scope`: the New session dialog or the session view. */
const block = (scope: string) => `${scope}?.querySelector('.trust-folder')`;
const button = (scope: string) => `[...(${scope}?.querySelectorAll('.trust-folder button') ?? [])].find((b) => b.textContent.trim() === ${q(TRUST_BUTTON)})`;
const cancel = (scope: string) => `[...(${scope}?.querySelectorAll('.trust-folder button') ?? [])].find((b) => b.textContent.trim() === 'Cancel')`;
const isOpen = (scope: string) => `(${block(scope)}?.dataset.state === 'open')`;
const screen = (scope: string) => `${scope}?.querySelector('.trust-folder .attach-terminal.trust-folder-screen')`;
const screenText = (scope: string) => `${screen(scope)}?.querySelector('.xterm-rows')?.textContent ?? ''`;
const lines = (scope: string) => `[...(${scope}?.querySelectorAll('.trust-folder p.spawn-trust') ?? [])].map((p) => p.textContent.trim())`;
const notice = (scope: string) => `${scope}?.querySelector('.trust-folder p.trust-folder-notice')`;
const inScreen = `!!document.activeElement?.closest('.trust-folder-screen')`;

/** Waits for something on the fake server's side, which the page can't see. */
async function until(what: string, ok: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Clicks Trust this folder… in `scope` and waits for the fake server's trust prompt to be drawn in the page. */
async function openTrust(t: Case, scope: string, cwd: string): Promise<void> {
  await t.page.click(TRUST_BUTTON, button(scope));
  await t.page.waitFor('the trust terminal', isOpen(scope));
  await until('the trust terminal to start', () => t.server.trust.running === cwd);
  await t.page.waitFor('the trust prompt on the screen', `${screenText(scope)}.includes('Yes, I trust this folder')`, 5000);
}

/** Checks the open trust terminal's line, screen, Cancel and focus, and that it fits inside `box`. */
async function checkOpen(t: Case, scope: string, box: string): Promise<void> {
  const { page } = t;
  t.expect((await page.evaluate<string[]>(lines(scope))).includes(PROMPT_LINE), 'it says what it is and which keys to use', await page.evaluate(lines(scope)));
  t.expect(await page.evaluate(`!!${cancel(scope)}`), 'with Cancel');
  t.expect(await page.evaluate(inScreen), 'focus is in the trust prompt', await page.evaluate(focused));
  const fits = await page.evaluate<{ ok: boolean; screen: unknown; box: unknown }>(`(() => {
    const s = ${screen(scope)}.getBoundingClientRect(), b = ${box};
    return { ok: s.width > 0 && s.height > 0 && s.left >= b.left - 0.5 && s.right <= b.right + 0.5, screen: { left: s.left, right: s.right, height: s.height }, box: b };
  })()`);
  t.expect(fits.ok, 'the screen fits inside the card', fits);
  // Scrolled into view: the whole block when it fits in what scrolls around it, or else its prompt's top.
  const shown = await page.evaluate<{ ok: boolean }>(`(() => {
    const block = ${block(scope)}, s = ${screen(scope)}.getBoundingClientRect(), b = block.getBoundingClientRect();
    let p = block.parentElement;
    while (p && !['auto', 'scroll'].includes(getComputedStyle(p).overflowY)) p = p.parentElement;
    const v = p ? p.getBoundingClientRect() : { top: 0, bottom: innerHeight, height: innerHeight };
    const top = Math.max(v.top, 0), bottom = Math.min(v.bottom, innerHeight);
    const ok = b.height <= bottom - top ? b.top >= top - 0.5 && b.bottom <= bottom + 0.5 : s.top >= top - 0.5 && s.top < bottom;
    return { ok, block: { top: b.top, bottom: b.bottom }, screenTop: s.top, view: { top, bottom } };
  })()`);
  t.expect(shown.ok, 'the prompt and Cancel are scrolled into view', shown);
  const last = t.server.records.trustOpens.at(-1);
  t.expect(last !== undefined && last.cols >= 20 && last.rows >= 5, 'the page gave the terminal a size', last);
}

const SESSION_BOX = `(() => { const r = ${VIEW}.getBoundingClientRect(); return { left: r.left, right: r.right }; })()`;

const part: Part = {
  name: 'trust',
  title: "Trust this folder… (W214): Claude Code's trust prompt in the page from New session's and resume's untrusted cards; Cancel, declined, and trusted, which starts or resumes",
  async run(t) {
    const { page, server } = t;
    const spawnPath = /\/api\/sessions$/;

    await t.step("a start in a folder Claude Code doesn't trust shows the card, with Trust this folder… after the command to copy", async () => {
      await t.fresh({ search: '?view=all' });
      t.allow(spawnPath, 'the 422 for the untrusted folder this step asks for');
      await openDialog(t, 'New session');
      await chooseDirectory(t, field('Directory'), UNTRUSTED_DIR);
      await page.click('First prompt', field('First prompt'));
      await page.type(FIRST_PROMPT);
      await page.click('Start session', dialogButton('Start session'));
      await page.waitFor('the card', `!!${DIALOG}?.querySelector('.spawn-failure')`, 5000);
      t.expect(await page.evaluate(`!!${button(DIALOG)}`), 'Trust this folder… is on the card');
      t.expect(
        await page.evaluate(`!!(${DIALOG}.querySelector('.spawn-failure .command-chip')?.compareDocumentPosition(${button(DIALOG)}) & Node.DOCUMENT_POSITION_FOLLOWING)`),
        'after the command to copy',
      );
      t.expect((await page.evaluate<string[]>(lines(DIALOG))).includes(HERE_START), 'and says the session starts once the folder is trusted', await page.evaluate(lines(DIALOG)));
      t.expectEqual(server.records.spawns, [], 'nothing was started');
      await t.shot('card');
    });

    await t.step("Trust this folder… opens Claude Code's trust prompt in the page, inside the dialog", async () => {
      await openTrust(t, DIALOG, UNTRUSTED_DIR);
      await checkOpen(t, DIALOG, `(() => { const r = ${dialogBox}; return { left: r.left, right: r.right }; })()`);
      const card = await page.evaluate<{ left: number; right: number; top: number; bottom: number }>(dialogBox);
      t.expect(card.left >= 15.5 && card.right <= t.viewport.width - 15.5, 'the dialog is still inside the window', card);
      t.expectEqual(server.records.trustOpens.map((each) => each.cwd), [UNTRUSTED_DIR], 'one trust terminal, in the folder the start named');
      await t.shot('open');
    });

    await t.step('Cancel closes it, which ends the trust terminal, and puts focus back on Trust this folder…', async () => {
      await page.click('Cancel', cancel(DIALOG));
      await page.waitFor('the trust terminal to close', `!${isOpen(DIALOG)} && !!${button(DIALOG)}`);
      await until('the fake server to see it closed', () => server.records.trustEnds.length === 1);
      t.expectEqual(server.records.trustEnds, [{ cwd: UNTRUSTED_DIR, how: 'closed' }], 'the page closed it');
      t.expectEqual(await page.evaluate(focused), TRUST_BUTTON, 'focus is back on Trust this folder…');
      t.expect(await page.evaluate(`!${notice(DIALOG)}`), 'no notice: Cancel needs none');
      t.expect(await page.evaluate(`!!${DIALOG}`), 'the dialog stays open');
    });

    await t.step("declined: says Claude Code didn't trust the folder, and the card stays, with the button", async () => {
      await openTrust(t, DIALOG, UNTRUSTED_DIR);
      t.expect(server.trust.end('declined'), 'the fake server ended it');
      await page.waitFor('the notice', `!!${notice(DIALOG)}`, 5000);
      t.expectEqual(await page.evaluate(`${notice(DIALOG)}.getAttribute('role')`), 'status', 'announced as a status');
      const said = await page.evaluate<string>(`${notice(DIALOG)}.textContent`);
      t.expect(said.startsWith(DECLINED_START), 'it says nothing was trusted', said);
      t.expect(await page.evaluate(`!!${button(DIALOG)} && !${isOpen(DIALOG)}`), 'Trust this folder… is there to try again');
      t.expectEqual(server.records.spawns, [], 'nothing was started');
      await t.shot('declined');
    });

    await t.step('trusted: the start goes again, the fake server takes it, and the dialog closes for the session', async () => {
      await openTrust(t, DIALOG, UNTRUSTED_DIR);
      t.expect(server.trust.end('trusted'), 'the fake server ended it, trusted');
      await page.waitFor('the dialog to close', `!${DIALOG}`, 5000);
      t.expectEqual(
        server.records.spawns.map((each) => ({ cwd: each.cwd, promptLength: each.promptLength })),
        [{ cwd: UNTRUSTED_DIR, promptLength: FIRST_PROMPT.length }],
        'one start taken, the same request again',
      );
      t.expect((await page.evaluate<string[]>(toasts)).some((each) => each.startsWith('Started')), 'the toast says it started', await page.evaluate(toasts));
      t.expectEqual(server.records.trustEnds.map((each) => each.how), ['closed', 'declined', 'trusted'], 'three trust terminals, each ended once');
      await t.shot('trusted');
    });

    await t.step("resume's card has Trust this folder… too, and once trusted the session resumes", async () => {
      const sessionId = server.world.byName(NAMES.endedAsked).sessionId;
      await t.fresh({ search: `?view=all&session=${sessionId}` });
      t.allow(new RegExp(`/api/sessions/${sessionId}/resume$`), 'the 422 for the untrusted folder this step asks for');
      await page.waitFor('its view', `${viewName} === ${q(NAMES.endedAsked)}`);
      const resume = `[...(${VIEW}?.querySelectorAll('.ended-actions button') ?? [])].find((b) => b.textContent.trim() === 'Resume in background')`;
      await page.click('Resume in background', resume);
      await page.waitFor('the card', `!!${VIEW}?.querySelector('.resume-failure')`, 5000);
      t.expect((await page.evaluate<string[]>(lines(VIEW))).includes(HERE_RESUME), 'it says the session resumes once the folder is trusted', await page.evaluate(lines(VIEW)));
      await openTrust(t, VIEW, DEMO_APP);
      await checkOpen(t, VIEW, SESSION_BOX);
      await t.shot('resume-open');
      t.expect(server.trust.end('trusted'), 'the fake server ended it, trusted');
      await page.waitFor('the Terminal tab', `${viewTab} === 'Terminal'`, 8000);
      t.expectEqual(server.records.resumes, [NAMES.endedAsked, NAMES.endedAsked], 'the resume went again, once');
      t.expect(await page.evaluate(`!${VIEW}?.querySelector('.resume-failure')`), 'the card has gone');
      await t.shot('resumed');
    });
  },
};

export default part;
