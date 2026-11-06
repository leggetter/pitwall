// Flag: "It doesn't need me" (W153; docs/design-system.md, 4: Flag): the flag toggle on the row of a
// running session that needs you, before the Not needed now toggle, which stays under the star; flagging
// a row in Needs you takes it out, with a toast and Undo, the title counting one fewer; flagged, it's
// quiet in All sessions with "You flagged this" and the toggle pressed; the toggle takes the flag away;
// and the session view's actions menu flags it and undoes it.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { chooseInRepoList, openFromRow, row, rowNames, toasts, VIEW } from './_dom.js';

const q = JSON.stringify;
const flagToggle = (name: string) => `document.querySelector(${q(`.session-list button.flag-toggle[aria-label="Flag ${name}: it doesn't need me"]`)})`;
const rowOf = (name: string) => `${row(name)}?.closest('li.session')`;
const flagged = (name: string) => `Flagged ${name}: it's out of Needs you, and pitwall asked it what, if anything, it needs.`;
const MENU_BUTTON = `${VIEW}?.querySelector('button[aria-label="Session actions"]')`;
const ITEMS = `[...(${VIEW}?.querySelectorAll('[role="menu"] [role="menuitem"]') ?? [])].map((item) => item.textContent.trim())`;
const menuItem = (label: string) => `[...(${VIEW}?.querySelectorAll('[role="menuitem"]') ?? [])].find((item) => item.textContent.trim() === ${q(label)})`;
const NEEDING = [NAMES.waiting, NAMES.asked, NAMES.prompting];

const part: Part = {
  name: 'flag',
  title: "Flag, It doesn't need me: the row's toggle beside Not needed now's, flagging from Needs you, the quiet row in All sessions, undoing from the row, and the actions menu",
  async run(t) {
    const { page, server } = t;

    await t.step("each running row that needs you has a flag toggle before the Not needed now toggle, which stays under the star; a row that needs nothing has none", async () => {
      await t.fresh({ search: '?view=all', prs: 'off' });
      for (const name of NEEDING) {
        const state = await page.evaluate<Record<string, unknown> | null>(
          `(() => {
            const flag = ${flagToggle(name)};
            if (!flag) return null;
            const li = flag.closest('li.session');
            const line2 = li.querySelector('.session-line-2');
            const mark = line2.querySelector('.not-needed-toggle');
            const star = li.querySelector('.session-star').getBoundingClientRect();
            const f = flag.getBoundingClientRect();
            const m = mark.getBoundingClientRect();
            const l = line2.getBoundingClientRect();
            return { pressed: flag.getAttribute('aria-pressed'), next: flag.nextElementSibling === mark, markLast: line2.lastElementChild === mark, under: Math.round(Math.abs(m.right - star.right)), apart: f.right <= m.left, inside: f.left >= l.left && m.right <= Math.ceil(star.right) + 1 };
          })()`,
        );
        t.expectEqual(state, { pressed: 'false', next: true, markLast: true, under: 0, apart: true, inside: true }, `${name}'s flag toggle, before Not needed now's`);
      }
      for (const name of [NAMES.running, NAMES.conversation]) t.expect(!(await page.evaluate<boolean>(`!!${rowOf(name)}?.querySelector('.flag-toggle')`)), `${name} needs nothing, so it has none`);
      // Focus in the row shows both toggles, as hover does.
      await page.evaluate(`${flagToggle(NAMES.asked)}.focus()`);
      await t.shot('toggles');
    });

    await t.step('flagging a row in Needs you takes it out, with a toast and Undo, and the title counts one fewer', async () => {
      await chooseInRepoList(t, 'Needs you');
      t.expectEqual(await page.evaluate(rowNames), [NAMES.waiting, NAMES.asked, NAMES.prompting], 'the sessions that need you');
      await page.click(`the flag on ${NAMES.asked}`, flagToggle(NAMES.asked));
      await page.waitFor('the row to leave', `${rowNames}.length === 2`);
      await page.waitFor('the toast', `${toasts}.includes(${q(flagged(NAMES.asked))})`);
      t.expectEqual(server.records.flags, [{ action: 'flag', name: NAMES.asked, reason: 'asked', from: 'row' }], 'one flag, with the reason the page showed');
      t.expectEqual(await page.evaluate('document.title'), '(2) pitwall', 'the title counts one fewer');
      await t.shot('flagged');
    });

    await t.step('flagged, it stays in All sessions, quietly: the badge outlined, "You flagged this" on line 2, the flag toggle pressed and shown', async () => {
      await chooseInRepoList(t, 'All sessions');
      const look = await page.evaluate<Record<string, unknown>>(`(() => {
        const li = ${rowOf(NAMES.asked)};
        const badge = li.querySelector('.badge[data-status]');
        const flag = li.querySelector('.flag-toggle');
        return { attention: li.dataset.attention ?? null, quiet: badge.classList.contains('state-not-needed'), outline: getComputedStyle(badge).outlineStyle, line2: li.querySelector('.session-what')?.textContent ?? '', pressed: flag?.getAttribute('aria-pressed'), shown: getComputedStyle(flag).opacity, mark: !!li.querySelector('.not-needed-toggle') };
      })()`);
      t.expectEqual([look.attention, look.quiet, look.outline], [null, true, 'dashed'], 'no attention, its badge outlined');
      t.expect(String(look.line2).startsWith('demo-app · You flagged this · Asked: '), 'line 2: the group, You flagged this, then what it asked', look.line2);
      t.expectEqual([look.pressed, look.shown, look.mark], ['true', '1', false], 'the flag pressed and shown, and no Not needed now toggle');
      await t.shot('quiet');
    });

    await t.step("the row's toggle takes the flag away, with no toast: back in Needs you", async () => {
      await page.click(`the flag on ${NAMES.asked}`, flagToggle(NAMES.asked));
      await page.waitFor('the row to need you again', `${rowOf(NAMES.asked)}?.dataset.attention === 'true'`);
      t.expectEqual(server.records.flags.at(-1), { action: 'unflag', name: NAMES.asked }, 'unflagged');
      t.expect(!(await page.evaluate<string[]>(toasts)).some((text) => text.startsWith('Took the flag off')), 'no toast for it');
      t.expectEqual(await page.evaluate('document.title'), '(3) pitwall', 'the title counts it');
    });

    await t.step("the session view's actions menu flags it after Mark not needed now, and Undo flag takes it away", async () => {
      await openFromRow(t, NAMES.prompting);
      await page.click('Session actions', MENU_BUTTON);
      await page.waitFor('the menu', `!!${VIEW}?.querySelector('[role="menu"]')`);
      const items = await page.evaluate<string[]>(ITEMS);
      t.expect(items.indexOf("It doesn't need me") === items.indexOf('Mark not needed now') + 1, "It doesn't need me, after Mark not needed now", items);
      await page.click("It doesn't need me", menuItem("It doesn't need me"));
      await page.waitFor('the toast', `${toasts}.includes(${q(flagged(NAMES.prompting))})`);
      const meta = await page.evaluate<string>(`${VIEW}.querySelector('.session-view-meta').textContent`);
      t.expect(meta.includes('You flagged this'), 'You flagged this after the badge', meta);
      await t.shot('view-flagged');
      await page.click('Session actions', MENU_BUTTON);
      await page.waitFor('the menu', `!!${VIEW}?.querySelector('[role="menu"]')`);
      await page.click('Undo flag', menuItem('Undo flag'));
      await page.waitFor('the toast', `${toasts}.includes(${q(`Took the flag off ${NAMES.prompting}: it's back in Needs you.`)})`);
      t.expectEqual(server.records.flags.map((each) => each.action), ['flag', 'unflag', 'flag', 'unflag'], 'flagged and unflagged twice');
    });
  },
};

export default part;
