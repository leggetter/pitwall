// Not for me (W188; docs/design-system.md, 4: Pull requests): a PR row's toggle at the end of line 2,
// under its start action, as a session row's snooze menu is under its star; dismissing a PR that asks
// your review takes it out of Needs you, the Pull requests badge and the title, with a toast and
// Undo, and moves its row to a muted, collapsed Dismissed section, where its toggle is pressed and
// pressing it again brings it back; the PR view's Not for me and Undo; and a PR whose dismissal ended
// because something new happened, back with a line that says so. The server keeps dismissals, so
// this fake server does, as the real one would. Made-up PRs only (fixtures.ts, PRS).

import { PRS } from '../fixtures.js';
import type { Part } from '../runner.js';
import { focused, openRepoList, repoItem, toasts } from './_dom.js';

const q = JSON.stringify;
const MAIN = `document.querySelector('main.session-list')`;
const READY = `!!document.querySelector('main.pr-list [data-open-pr], main.pr-list [data-open-session]')`;
const prRow = (key: string) => `${MAIN}?.querySelector(${q(`li[data-pr="${key}"]`)})`;
const toggleOf = (key: string) => `${prRow(key)}?.querySelector('[data-dismiss-pr]')`;
const startOf = (key: string) => `${prRow(key)}?.querySelector('[data-start-pr]')`;
/** The PR rows shown, by key, outside a collapsed section. */
const shownPrs = `[...${MAIN}.querySelectorAll('[data-open-pr]')].filter((el) => !el.closest('[hidden]')).map((el) => el.dataset.openPr)`;
const SECTION = `${MAIN}?.querySelector('[data-dismissed-toggle]')`;
const PR_VIEW = `document.getElementById('pr-view')`;
const viewButton = (text: string) => `[...(${PR_VIEW}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${q(text)})`;
const number = (key: string) => Number(key.split('/').pop());
const DISMISSED_TOAST = (key: string) => `#${number(key)} is out of Needs you, under Dismissed, until something new happens.`;
const undoIn = (key: string) => `[...document.querySelectorAll('.toasts .toast:not(.leaving)')].find((toast) => toast.querySelector('.toast-message')?.textContent === ${q(DISMISSED_TOAST(key))})?.querySelector('.toast-action')`;

const part: Part = {
  name: 'pr-dismiss',
  title: 'Not for me: the PR row’s toggle, out of Needs you and the counts with a toast and Undo, the Dismissed section, Undo from its row and the PR view, and back when something new happens',
  async run(t) {
    const { page, server } = t;
    const fresh = () => t.fresh({ search: '?view=prs', ready: READY });
    const prBadge = async (): Promise<string | null> => {
      await openRepoList(t);
      const text = await page.evaluate<string | null>(`${repoItem('Pull requests')}?.querySelector('.badge')?.textContent ?? null`);
      if (t.layout === 'drawer') {
        await page.key('Escape');
        await page.waitFor('the drawer to close', `!document.querySelector('.repo-drawer')`);
      }
      return text;
    };

    await t.step('each PR row it can dismiss ends line 2 with Not for me, off, its right edge under the start action’s', async () => {
      await fresh();
      for (const key of [PRS.review, PRS.teamReview, PRS.mentioned, PRS.draft]) {
        const state = await page.evaluate<{ name: string | null; pressed: string | null; last: boolean; under: number } | null>(`(() => {
          const b = ${toggleOf(key)};
          const start = ${startOf(key)};
          if (!b || !start) return null;
          const name = b.getAttribute('aria-label') ?? document.getElementById(b.getAttribute('aria-labelledby') ?? '')?.textContent ?? null;
          return { name, pressed: b.getAttribute('aria-pressed'), last: b.parentElement.classList.contains('session-line-2') && b.parentElement.lastElementChild === b, under: Math.round(Math.abs(b.getBoundingClientRect().right - start.getBoundingClientRect().right)) };
        })()`);
        t.expectEqual(state, { name: `Not for me: #${number(key)}`, pressed: 'false', last: true, under: 0 }, `#${number(key)}'s toggle`);
      }
    });

    await t.step('Undo on the toast brings it straight back', async () => {
      server.clearRecords();
      await page.click(`Not for me on #${number(PRS.review)}`, toggleOf(PRS.review));
      await page.waitFor('the toast', `${toasts}.includes(${q(DISMISSED_TOAST(PRS.review))})`);
      await page.click('Undo', undoIn(PRS.review));
      await page.waitFor('the row back', `${shownPrs}.includes(${q(PRS.review)})`);
      t.expectEqual(
        server.records.prDismissals.map((each) => each.action),
        ['dismiss', 'undismiss'],
        'a dismissal and its Undo',
      );
      await fresh();
    });

    await t.step('Not for me takes a review request out of Needs you, the badge and the title, with a toast and Undo, and the row into a collapsed Dismissed section', async () => {
      t.expectEqual(await prBadge(), '4 need you', "Pull requests' badge before");
      t.expectEqual(await page.evaluate('document.title'), '(5) pitwall', 'the title before');
      server.clearRecords();
      await page.click(`Not for me on #${number(PRS.review)}`, toggleOf(PRS.review));
      await page.waitFor('the row to leave', `!${shownPrs}.includes(${q(PRS.review)})`);
      t.expectEqual(server.records.prDismissals, [{ action: 'dismiss', key: PRS.review, status: 200 }], 'one dismissal, of the state the page showed');
      await page.waitFor('the toast', `${toasts}.includes(${q(DISMISSED_TOAST(PRS.review))})`);
      t.expect(await page.evaluate<boolean>(`${undoIn(PRS.review)}?.textContent === 'Undo'`), 'with Undo');
      t.expectEqual(await page.evaluate(`${SECTION}?.textContent`), 'Dismissed (1)', 'the Dismissed section, with its count');
      t.expectEqual(await page.evaluate(`${SECTION}?.getAttribute('aria-expanded')`), 'false', 'collapsed');
      t.expect(await page.evaluate<boolean>(`!!document.activeElement?.closest('main.session-list li.session:not([data-dismissed])')`), 'focus on the row that took its place', await page.evaluate<string>(focused));
      t.expectEqual(await page.evaluate('document.title'), '(4) pitwall', 'the title counts one fewer');
      await t.shot('dismissed');
      t.expectEqual(await prBadge(), '3 need you', "Pull requests' badge after");
    });

    await t.step('the Dismissed section opens to its row, muted, its toggle pressed and shown; pressing it is Undo', async () => {
      // The toast can sit over the section's toggle in a short list: closed first, as a reader would.
      await page.click("the toast's close", `document.querySelector('.toasts .toast:not(.leaving) .toast-dismiss')`);
      await page.waitFor('the toast to go', `${toasts}.length === 0`);
      await page.click('Dismissed', SECTION);
      await page.waitFor('its row', `${shownPrs}.includes(${q(PRS.review)})`);
      const look = await page.evaluate<Record<string, unknown>>(`(() => {
        const li = ${prRow(PRS.review)};
        const b = li.querySelector('[data-dismiss-pr]');
        const title = li.querySelector('.session-name');
        return { attention: li.dataset.attention ?? null, dismissed: li.dataset.dismissed ?? null, weight: getComputedStyle(title).fontWeight, pressed: b?.getAttribute('aria-pressed'), shown: getComputedStyle(b).opacity, inSection: !!li.closest('.dismissed-sessions') };
      })()`);
      t.expectEqual(look, { attention: null, dismissed: 'true', weight: '400', pressed: 'true', shown: '1', inSection: true }, 'its row, quiet, in the section');
      await t.shot('dismissed-open');
      server.clearRecords();
      await page.click(`Not for me, pressed, on #${number(PRS.review)}`, toggleOf(PRS.review));
      await page.waitFor('the section to go', `!${SECTION}`);
      t.expectEqual(server.records.prDismissals, [{ action: 'undismiss', key: PRS.review, status: 200 }], 'one Undo');
      t.expect(await page.evaluate<boolean>(`${prRow(PRS.review)}?.dataset.attention === 'true'`), 'back, needing you');
      t.expectEqual(await page.evaluate('document.title'), '(5) pitwall', 'the title counts it again');
    });

    await t.step('the PR view offers Not for me, then says it’s dismissed with Undo, which brings it back with a toast', async () => {
      await page.click(`#${number(PRS.teamReview)}`, `${prRow(PRS.teamReview)}?.querySelector('[data-open-pr]')`);
      await page.waitFor('its view', `!!${viewButton('Not for me')}`);
      server.clearRecords();
      await page.click('Not for me', viewButton('Not for me'));
      await page.waitFor('the dismissed note', `!!${PR_VIEW}?.querySelector('.pr-view-dismissed')`);
      t.expectEqual(server.records.prDismissals, [{ action: 'dismiss', key: PRS.teamReview, status: 200 }], 'one dismissal');
      await page.waitFor('focus on Undo', `document.activeElement === ${viewButton('Undo')}`);
      await t.shot('view-dismissed');
      await page.click('Undo', viewButton('Undo'));
      await page.waitFor('Not for me again', `!!${viewButton('Not for me')}`);
      await page.waitFor('the toast', `${toasts}.includes(${q(`#${number(PRS.teamReview)} is back with your pull requests.`)})`);
    });

    await t.step('a dismissed PR comes back when something new happens, and its row says so', async () => {
      await fresh();
      await page.click(`Not for me on #${number(PRS.review)}`, toggleOf(PRS.review));
      await page.waitFor('the row to leave', `!${shownPrs}.includes(${q(PRS.review)})`);
      server.world.somethingNew(PRS.review);
      server.broadcastPrs();
      await page.waitFor('the row back', `${prRow(PRS.review)}?.dataset.attention === 'true'`);
      t.expectEqual(await page.evaluate(`${prRow(PRS.review)}?.querySelector('.pr-back')?.textContent`), 'Back: something new', 'line 2 says why');
      await page.waitFor('its toast to go, as Undo would do nothing', `!${toasts}.includes(${q(DISMISSED_TOAST(PRS.review))})`);
      t.expect(!(await page.evaluate<boolean>(`!!${SECTION}`)), 'no Dismissed section left');
      await t.shot('back');
    });
  },
};

export default part;
