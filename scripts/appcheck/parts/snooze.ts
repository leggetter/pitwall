// Snooze (W154; docs/design-system.md, 4: Snooze): the menu on the row of a session that needs you, at
// the end of line 2, after the flag toggle, under the star; snoozing a row in Needs you takes it out
// once the snapshot says so, with a toast and Undo, the badges and the title counting one fewer, and
// focus on the next row's snooze menu; Undo puts it back, with focus on its snooze menu; snoozed, it's
// quiet in All sessions, its toggle pressed; woken, it's back in Needs you saying why; the session
// view's actions menu snoozes it and wakes it; and W88's old marks are removed from storage as the
// page loads. The server keeps snoozes, so this fake server does, as the real one would.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { chooseInRepoList, focused, openFromRow, openRepoList, repoItem, row, rowNames, toasts, VIEW } from './_dom.js';

const q = JSON.stringify;
const OLD_KEY = 'pitwall.not-needed.v1';
const control = (name: string) => `document.querySelector(${q(`.session-list button[data-snooze-session][aria-label="Snooze ${name}"]`)})`;
const rowOf = (name: string) => `${row(name)}?.closest('li.session')`;
const choice = (name: string, label: string) => `[...(${rowOf(name)}?.querySelectorAll('[role="menuitem"]') ?? [])].find((item) => item.textContent.trim().startsWith(${q(label)}))`;
const LATER_TOAST = (name: string) => `Snoozed ${name} until it's woken: a turn you didn't start, such as a message or a finished task.`;
const undoButton = (name: string) => `[...document.querySelectorAll('.toasts .toast:not(.leaving)')].find((toast) => toast.querySelector('.toast-message')?.textContent === ${q(LATER_TOAST(name))})?.querySelector('.toast-action')`;
const badgeOf = (label: string) => `${repoItem(label)}?.querySelector('.badge-attention')?.textContent ?? null`;
const MENU_BUTTON = `${VIEW}?.querySelector('button[aria-label="Session actions"]')`;
const ITEMS = `[...(${VIEW}?.querySelectorAll('[role="menu"] [role="menuitem"]') ?? [])].map((item) => item.textContent.trim())`;
const menuItem = (label: string) => `[...(${VIEW}?.querySelectorAll('[role="menuitem"]') ?? [])].find((item) => item.textContent.trim() === ${q(label)})`;
const NEEDING = [NAMES.waiting, NAMES.asked, NAMES.prompting];

const part: Part = {
  name: 'snooze',
  title: "Snooze: the row's menu, snoozing and undoing from Needs you, the quiet row in All sessions, back when woken, the actions menu, and W88's marks removed",
  async run(t) {
    const { page, server } = t;
    const id = (name: string) => server.world.byName(name).sessionId;

    /** The repo list's Needs you and demo-app badges, through the drawer below 900 px. */
    const badges = async (): Promise<{ needsYou: string | null; demoApp: string | null }> => {
      await openRepoList(t);
      const counts = { needsYou: await page.evaluate<string | null>(badgeOf('Needs you')), demoApp: await page.evaluate<string | null>(badgeOf('demo-app')) };
      if (t.layout === 'drawer') {
        await page.key('Escape');
        await page.waitFor('the drawer to close', `!document.querySelector('.repo-drawer')`);
      }
      return counts;
    };

    /** Opens `name`'s snooze menu and chooses the item starting `label`. */
    const snooze = async (name: string, label: string) => {
      await page.click(`the snooze menu on ${name}`, control(name));
      await page.waitFor('its menu', `!!${rowOf(name)}?.querySelector('[role="menu"]')`);
      await page.click(label, choice(name, label));
    };

    await t.step('each row that needs you has a snooze menu, last on line 2, under the star; a row that needs nothing has none', async () => {
      // Pull requests off, so this part checks snoozes alone: a session that needs you through a PR it
      // owns stays in Needs you whatever its snooze says (W106), which the prs part checks.
      await t.fresh({ search: '?view=all', prs: 'off' });
      for (const name of NEEDING) {
        const state = await page.evaluate<{ popup: string | null; last: boolean; under: number } | null>(
          `(() => {
            const b = ${control(name)};
            if (!b) return null;
            const anchor = b.closest('.snooze-menu');
            const star = b.closest('li.session').querySelector('.session-star').getBoundingClientRect();
            const own = b.getBoundingClientRect();
            return { popup: b.getAttribute('aria-haspopup'), last: anchor.parentElement.classList.contains('session-line-2') && anchor.parentElement.lastElementChild === anchor, under: Math.round(Math.abs(own.right - star.right)) };
          })()`,
        );
        t.expectEqual(state, { popup: 'menu', last: true, under: 0 }, `${name}'s snooze menu, its right edge under the star's`);
      }
      for (const name of [NAMES.running, NAMES.conversation]) t.expect(!(await page.evaluate<boolean>(`!!${rowOf(name)}?.querySelector('[data-snooze-session]')`)), `${name} needs nothing, so it has none`);
      await page.click(`the snooze menu on ${NAMES.asked}`, control(NAMES.asked));
      await page.waitFor('its menu', `!!${rowOf(NAMES.asked)}?.querySelector('[role="menu"]')`);
      t.expectEqual(
        await page.evaluate(`[...${rowOf(NAMES.asked)}.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim())`),
        ['For 1 hour', 'For 3 hours', 'Until tomorrow, 9:00', 'Until Monday, 9:00', "Later, until it's woken"],
        'its choices',
      );
      await t.shot('menu');
      await page.key('Escape');
      await page.waitFor('the menu to close', `!${rowOf(NAMES.asked)}?.querySelector('[role="menu"]')`);
    });

    await t.step("snoozing a row in Needs you takes it out, with a toast and Undo, one fewer in the counts, and focus on the next row's snooze menu", async () => {
      await chooseInRepoList(t, 'Needs you');
      t.expectEqual(await page.evaluate(rowNames), NEEDING, 'the sessions that need you');
      t.expectEqual(await badges(), { needsYou: '3 need you', demoApp: '3 need you' }, 'the badges before');
      server.clearRecords();
      await snooze(NAMES.asked, 'Later');
      await page.waitFor('the row to leave', `${rowNames}.length === 2`);
      t.expectEqual(server.records.snoozes, [{ action: 'snooze', name: NAMES.asked }], 'one snooze, Later, with no time');
      t.expectEqual(await page.evaluate(rowNames), [NAMES.waiting, NAMES.prompting], 'the others');
      t.expectEqual(await page.evaluate(`document.activeElement?.dataset.snoozeSession ?? null`), id(NAMES.prompting), 'focus on the snooze menu of the row that took its place');
      await page.waitFor('the toast', `${toasts}.includes(${q(LATER_TOAST(NAMES.asked))})`);
      t.expect(await page.evaluate<boolean>(`${undoButton(NAMES.asked)}?.textContent === 'Undo'`), 'with Undo');
      t.expectEqual(await page.evaluate('document.title'), '(2) pitwall', 'the title counts one fewer');
      await t.shot('snoozed');
      t.expectEqual(await badges(), { needsYou: '2 need you', demoApp: '2 need you' }, 'the badges after');
    });

    await t.step('Undo wakes it, back in Needs you, with focus on its snooze menu', async () => {
      await page.click('Undo', undoButton(NAMES.asked));
      await page.waitFor('the row to come back', `${rowNames}.length === 3`);
      t.expectEqual(await page.evaluate(rowNames), NEEDING, 'in its place');
      await page.waitFor('focus on its snooze menu', `document.activeElement?.dataset.snoozeSession === ${q(id(NAMES.asked))}`);
      t.expectEqual(await page.evaluate(`${control(NAMES.asked)}?.getAttribute('aria-haspopup')`), 'menu', `a menu again (focus on ${await page.evaluate<string>(focused)})`);
      t.expectEqual(await page.evaluate('document.title'), '(3) pitwall', 'the title counts it again');
    });

    await t.step("snoozed, it stays in All sessions, quietly: no bar, the badge outlined, Snoozed until it's woken on line 2, the toggle pressed", async () => {
      await snooze(NAMES.asked, 'Later');
      await page.waitFor('the row to leave', `${rowNames}.length === 2`);
      await chooseInRepoList(t, 'All sessions');
      const look = await page.evaluate<Record<string, unknown>>(`(() => {
        const li = ${rowOf(NAMES.asked)};
        const badge = li.querySelector('.badge[data-status]');
        const style = getComputedStyle(badge);
        const button = li.querySelector('[data-snooze-session]');
        return { attention: li.dataset.attention ?? null, bar: getComputedStyle(li).boxShadow.includes('inset 3px'), badge: badge.textContent, quiet: badge.classList.contains('state-set-aside'), outline: style.outlineStyle, line2: li.querySelector('.session-what')?.textContent ?? '', pressed: button?.getAttribute('aria-pressed'), shown: getComputedStyle(button).opacity };
      })()`);
      t.expectEqual([look.attention, look.bar], [null, false], 'no attention mark, no bar');
      t.expectEqual([look.badge, look.quiet, look.outline], ['Asked you', true, 'dashed'], 'its badge, outlined');
      t.expect(String(look.line2).startsWith("demo-app · Snoozed until it's woken · Asked: "), "line 2: the group, Snoozed until it's woken, then what it asked", look.line2);
      t.expectEqual([look.pressed, look.shown], ['true', '1'], 'the toggle pressed, and shown');
      await t.shot('quiet');
    });

    await t.step('woken, it comes back to Needs you, saying so', async () => {
      server.world.snooze(id(NAMES.asked), undefined, { at: new Date().toISOString(), why: 'woken' });
      server.broadcast();
      await page.waitFor('the row to need you again', `${rowOf(NAMES.asked)}?.dataset.attention === 'true'`);
      const line2 = await page.evaluate<string>(`${rowOf(NAMES.asked)}.querySelector('.session-what')?.textContent ?? ''`);
      t.expect(line2.startsWith('demo-app · Woken: a new turn · Asked: '), 'line 2 says why it is back', line2);
      t.expectEqual(await page.evaluate('document.title'), '(3) pitwall', 'the title counts it');
      await t.shot('woken');
    });

    await t.step("the session view's actions menu snoozes it and wakes it, with a toast", async () => {
      await openFromRow(t, NAMES.prompting);
      await page.click('Session actions', MENU_BUTTON);
      await page.waitFor('the menu', `!!${VIEW}?.querySelector('[role="menu"]')`);
      const items = await page.evaluate<string[]>(ITEMS);
      t.expect(items.includes('Snooze for 1 hour') && items.includes("Snooze until it's woken"), 'a Snooze item for each choice', items);
      server.clearRecords();
      await page.click('Snooze for 3 hours', menuItem('Snooze for 3 hours'));
      await page.waitFor('the snooze', `${VIEW}?.querySelector('.session-view-set-aside')?.textContent.startsWith('Snoozed until ') === true`);
      const until = server.records.snoozes[0]?.until;
      t.expect(until !== undefined && Math.abs(Date.parse(until) - Date.now() - 3 * 60 * 60 * 1000) < 60_000, 'until 3 hours from now', server.records.snoozes);
      t.expectEqual(await page.evaluate(focused), 'Session actions', 'focus back on the menu button');
      await t.shot('view-snoozed');
      await page.click('Session actions', MENU_BUTTON);
      await page.waitFor('the menu', `!!${VIEW}?.querySelector('[role="menu"]')`);
      t.expect((await page.evaluate<string[]>(ITEMS)).includes('Wake now'), 'Wake now, in their place');
      await page.click('Wake now', menuItem('Wake now'));
      await page.waitFor('the toast', `${toasts}.includes(${q(`Woke ${NAMES.prompting}: it's back in Needs you.`)})`);
      t.expect(!(await page.evaluate<boolean>(`!!${VIEW}.querySelector('.session-view-meta .state-set-aside')`)), 'its badge solid again');
    });

    await t.step("W88's old marks are removed from storage as the page loads, and hide nothing", async () => {
      await page.evaluate(`localStorage.setItem(${q(OLD_KEY)}, ${q(JSON.stringify({ v: 1, entries: [{ id: id(NAMES.waiting), hash: '0123456789abcdef' }] }))})`);
      await page.reload();
      await page.waitFor('the rows', `${rowNames}.length > 0`);
      t.expectEqual(await page.evaluate(`localStorage.getItem(${q(OLD_KEY)})`), null, 'the key gone');
      t.expect((await page.evaluate<string[]>(rowNames)).includes(NAMES.waiting), `${NAMES.waiting} still listed`);
    });
  },
};

export default part;
