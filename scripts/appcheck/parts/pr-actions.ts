// Starting a session for a pull request (W107; docs/design-system.md, 4: Pull requests): a PR row's
// action in a cloned repo, New session prefilled in its clone, started, and the PR row going into the
// new session's at once; Clone and start for a repo that isn't cloned, its confirmation, the made-up
// clone, New session in the new folder with how to trust it, and the repo list then listing the clone;
// a clone that fails; the PR view's own action; the row's action reached with Tab, which shows it; and
// Resume on the row of an ended session that owns an open PR. Made-up PRs only (fixtures.ts, PRS);
// the fake server clones nothing.

import { CODE, DEMO_APP, NAMES, PRS } from '../fixtures.js';
import type { Part } from '../runner.js';
import { DIALOG, dialogButton, dialogName, openRepoList, repoLabels, row, toasts } from './_dom.js';

const q = JSON.stringify;
const MAIN = `document.querySelector('main.session-list')`;
const READY = `!!document.querySelector('main.pr-list [data-open-pr], main.pr-list [data-open-session]')`;
const prRow = (key: string) => `${MAIN}?.querySelector(${q(`li[data-pr="${key}"]`)})`;
const startOf = (key: string) => `${prRow(key)}?.querySelector('[data-start-pr]')`;
/** A control's name: its aria-label, or the tooltip that labels it. */
const nameOf = (el: string) => `(() => { const b = ${el}; return b?.getAttribute('aria-label') ?? document.getElementById(b?.getAttribute('aria-labelledby') ?? '')?.textContent ?? null; })()`;
const field = (label: 'Name' | 'First prompt') => `[...(${DIALOG}?.querySelectorAll('input, textarea') ?? [])].find((el) => el.labels?.[0]?.textContent.startsWith(${q(label)}))`;
const directory = `${DIALOG}?.querySelector('select')?.value`;
const PR_VIEW = `document.getElementById('pr-view')`;
const SDK_DOCS = `${CODE}/sdk-docs`;
const url = (key: string) => `https://github.com/${key.split('/').slice(0, 2).join('/')}/pull/${key.split('/').pop()}`;

const part: Part = {
  name: 'pr-actions',
  title: "Starting a session for a PR: New session prefilled in its clone, the PR going into the new session at once, Clone and start, a failed clone, the PR view's action, and Resume on an ended session's row",
  async run(t) {
    const { page, server } = t;
    const fresh = () => t.fresh({ search: '?view=prs', ready: READY });
    const startNew = async () => {
      await page.click('Start session', dialogButton('Start session'));
      await page.waitFor('the dialog to close', `!${DIALOG}`, 5000);
    };

    await t.step("a PR row's action names what it does: New session in a cloned repo, Clone and start in one that isn't", async () => {
      await fresh();
      t.expectEqual(await page.evaluate(nameOf(startOf(PRS.review))), 'New session for #57', "#57's, in demo-app");
      t.expectEqual(await page.evaluate(nameOf(startOf(PRS.notCloned))), 'Clone example/sdk-docs and start a session for #9', "#9's, in example/sdk-docs");
      t.expectEqual(await page.evaluate(`${startOf(PRS.review)}?.getAttribute('aria-haspopup')`), 'dialog', 'it opens a dialog');
      // In the star's slot, so the badges still line up down the list.
      const edges = await page.evaluate<number[]>(`[...${MAIN}.querySelectorAll('li.session')].filter((li) => !li.closest('[hidden]') && li.querySelector('.session-badges .badge')).map((li) => Math.round(li.querySelector('.session-badges').getBoundingClientRect().right))`);
      t.expect(new Set(edges).size === 1, "every row's badges end at the same x", edges);
    });

    await t.step("Tab from a PR row's title reaches its action, which is hidden until then on a screen that hovers, and shows on focus", async () => {
      // The pointer off the list, at the window's corner, so only focus can show it.
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
      await page.settle();
      const opacity = `getComputedStyle(${startOf(PRS.review)}).opacity`;
      if (await page.evaluate<boolean>(`matchMedia('(hover: hover)').matches`)) t.expectEqual(await page.evaluate(opacity), '0', 'hidden off the row');
      await page.evaluate(`${prRow(PRS.review)}.querySelector('[data-open-pr]').focus()`);
      await page.key('Tab');
      await page.waitFor('focus on the action', `document.activeElement === ${startOf(PRS.review)}`);
      await page.waitFor('it to show', `${opacity} === '1'`);
      t.expectEqual(await page.evaluate(nameOf('document.activeElement')), 'New session for #57', 'named for its PR');
      await t.shot('action-focused');
    });

    await t.step('New session opens prefilled in the clone: its directory, pr-57, and a prompt that asks for the review by its URL', async () => {
      await page.click('New session for #57', startOf(PRS.review));
      await page.waitFor('New session', `${dialogName} === 'New session'`);
      t.expectEqual(await page.evaluate(directory), DEMO_APP, 'the clone');
      t.expectEqual(await page.evaluate(`${field('Name')}?.value`), 'pr-57', 'the name');
      t.expect((await page.evaluate<string>(`${field('First prompt')}?.value`)).startsWith(`Review ${url(PRS.review)}.`), 'the prompt', await page.evaluate(`${field('First prompt')}?.value`));
      t.expect(!(await page.evaluate<boolean>(`!!${PR_VIEW}`)), "the PR's view didn't open");
      await t.shot('new-session-prefilled');
    });

    await t.step('started, the new session owns the PR at once: its row goes, and the session has its badge', async () => {
      await startNew();
      t.expectEqual(server.records.spawns.map(({ cwd, name }) => ({ cwd, name })), [{ cwd: DEMO_APP, name: 'pr-57' }], 'one spawn, in the clone');
      await page.waitFor('pr-57 to be listed', `!!${row('pr-57')}`, 5000);
      t.expect(!(await page.evaluate<boolean>(`!!${prRow(PRS.review)}`)), "#57's own row has gone");
      t.expectEqual(await page.evaluate(`${row('pr-57')}?.closest('li').querySelector('.pr-badge .badge, .pr-badge')?.textContent.replace(/[^#0-9]/g, '').slice(0, 3)`), '#57', "the session's badge");
      await t.shot('owned');
    });

    await t.step('Clone and start says exactly what it will do, then clones, sending only the repo', async () => {
      await fresh();
      await page.click('Clone and start for #9', startOf(PRS.notCloned));
      await page.waitFor('the confirmation', `${dialogName} === 'Clone and start a session'`);
      t.expectEqual(await page.evaluate(`${DIALOG}.querySelector('.clone-what')?.textContent`), 'Clone example/sdk-docs into ~/code/sdk-docs', 'what it does');
      t.expectEqual(server.records.clones, [], 'nothing yet');
      await t.shot('clone-confirm');
      await page.click('Clone', dialogButton('Clone'));
      await page.waitFor('Cloning…', `!!${DIALOG}?.querySelector('button[aria-busy="true"]')`, 2000);
      await page.waitFor('New session', `${dialogName} === 'New session'`, 5000);
      t.expectEqual(server.records.clones, [{ repo: 'example/sdk-docs', status: 201 }], 'one clone, of the repo alone');
    });

    await t.step('then New session opens in the new clone, saying how to trust it, and the repo list lists the clone', async () => {
      t.expectEqual(await page.evaluate(directory), SDK_DOCS, 'the new clone, chosen');
      t.expectEqual(await page.evaluate(`${DIALOG}.querySelector('.cloned-notice .inline-alert-title')?.textContent`), 'Cloned example/sdk-docs into ~/code/sdk-docs.', 'what was cloned');
      t.expectEqual(await page.evaluate(`${DIALOG}.querySelector('.cloned-notice .command-chip')?.textContent`), `cd ${SDK_DOCS} && claude`, 'the command that trusts it');
      t.expectEqual(await page.evaluate(`${field('Name')}?.value`), 'pr-9', 'the name');
      await t.shot('cloned');
      await page.click('Cancel', dialogButton('Cancel'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      await openRepoList(t);
      await page.waitFor('the clone in the repo list', `${repoLabels}.includes('sdk-docs')`, 5000);
      t.expect(!(await page.evaluate<string[]>(repoLabels)).includes('example/sdk-docs'), 'and not the repo that wasn’t cloned');
      if (t.layout === 'drawer') {
        await page.key('Escape');
        await page.waitFor('the drawer to close', `!document.querySelector('.repo-drawer')`);
      }
    });

    await t.step("a clone that fails says why in pitwall's words, and the confirmation stays", async () => {
      await fresh();
      server.world.failClones();
      t.allow(/\/api\/prs\/clone$/, 'the failed clone this step asks for');
      await page.click('Clone and start for #9', startOf(PRS.notCloned));
      await page.waitFor('the confirmation', `${dialogName} === 'Clone and start a session'`);
      await page.click('Clone', dialogButton('Clone'));
      await page.waitFor('the alert', `!!${DIALOG}?.querySelector('.clone-failure')`, 5000);
      t.expectEqual(
        await page.evaluate(`${DIALOG}.querySelector('.clone-failure')?.textContent`),
        "Couldn't clone example/sdk-docs. gh couldn't clone example/sdk-docs (exit code 1). Check that you can open it on GitHub and that gh auth status works, then try again.",
        'what failed',
      );
      await t.shot('clone-failed');
      await page.click('Cancel', dialogButton('Cancel'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
    });

    await t.step("the PR view offers New session while no session owns the PR", async () => {
      await t.fresh({ search: `?view=prs&pr=${PRS.review}`, ready: `!!${PR_VIEW}` });
      const start = `[...${PR_VIEW}.querySelectorAll('[data-start-pr-view]')][0]`;
      t.expectEqual(await page.evaluate(`${start}?.textContent.trim()`), 'New session', 'its action');
      await page.click('New session', start);
      await page.waitFor('New session', `${dialogName} === 'New session'`);
      t.expectEqual(await page.evaluate(`${field('Name')}?.value`), 'pr-57', 'prefilled for the PR');
      await page.click('Cancel', dialogButton('Cancel'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
    });

    await t.step('an ended session that owns an open PR has Resume on its row, which resumes it, with a toast', async () => {
      // A fresh page: the PR view the step before opened lies over the list below 1,200 px.
      await fresh();
      const resume = `${row(NAMES.endedPr)}?.closest('li').querySelector('[data-resume-session]')`;
      t.expectEqual(await page.evaluate(nameOf(resume)), `Resume ${NAMES.endedPr} in the background`, 'its name');
      await page.click('Resume', resume);
      await page.waitFor('the toast', `${toasts}.includes(${q(`Resumed ${NAMES.endedPr} in the background.`)})`, 5000);
      t.expectEqual(server.records.resumes, [NAMES.endedPr], 'one resume');
      // Listed as running a moment later: no longer finished, so no Resume.
      await page.waitFor('it to run', `!(${resume})`, 5000);
    });
  },
};

export default part;
