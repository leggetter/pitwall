// Not needed now (W88; docs/design-system.md, 4: Not needed now): the toggle on the row of a session
// that needs you, at the end of line 2, under the star; marking a row in Needs you takes it out at once, with a toast and
// Undo, the badges and the title counting one fewer, and focus on the next row's toggle; Undo puts it
// back, with focus on its toggle; marked, it's quiet in All sessions; when what it needs changes it
// comes back to Needs you by itself, and the mark goes from storage; the session view's actions menu marks
// it and puts it back; and a mark lasts through a reload. pitwall.not-needed.v1 holds ids and hashes,
// never what a session needed.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { chooseInRepoList, focused, listHeading, openFromRow, openRepoList, repoItem, row, rowNames, toasts, VIEW } from './_dom.js';

const q = JSON.stringify;
const KEY = 'pitwall.not-needed.v1';
const toggle = (name: string) => `document.querySelector(${q(`.session-list button.not-needed-toggle[aria-label="Mark ${name} not needed now"]`)})`;
const rowOf = (name: string) => `${row(name)}?.closest('li.session')`;
const marked = (name: string) => `Marked ${name} not needed now. It comes back to Needs you when what it needs changes.`;
const undoButton = (name: string) => `[...document.querySelectorAll('.toasts .toast:not(.leaving)')].find((toast) => toast.querySelector('.toast-message')?.textContent === ${q(marked(name))})?.querySelector('.toast-action')`;
const badgeOf = (label: string) => `${repoItem(label)}?.querySelector('.badge-attention')?.textContent ?? null`;
const entries = `JSON.parse(localStorage.getItem(${q(KEY)}) ?? '{"v":1,"entries":[]}').entries`;
const MENU_BUTTON = `${VIEW}?.querySelector('button[aria-label="Session actions"]')`;
const ITEMS = `[...(${VIEW}?.querySelectorAll('[role="menu"] [role="menuitem"]') ?? [])].map((item) => item.textContent.trim())`;
const menuItem = (label: string) => `[...(${VIEW}?.querySelectorAll('[role="menuitem"]') ?? [])].find((item) => item.textContent.trim() === ${q(label)})`;
const NEEDING = [NAMES.waiting, NAMES.asked, NAMES.prompting];

const part: Part = {
  name: 'not-needed',
  title: "Not needed now: the row's toggle, marking and undoing from Needs you, the quiet row in All sessions, back by itself when what it needs changes, the actions menu, and a reload",
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

    await t.step("each row that needs you has a Not needed now toggle, at the end of line 2, under the star, not pressed; a row that needs nothing has none", async () => {
      await t.fresh({ search: '?view=all' });
      for (const name of NEEDING) {
        const state = await page.evaluate<{ pressed: string | null; last: boolean; under: number } | null>(
          `(() => {
            const b = ${toggle(name)};
            if (!b) return null;
            const star = b.closest('li.session').querySelector('.session-star').getBoundingClientRect();
            const own = b.getBoundingClientRect();
            return { pressed: b.getAttribute('aria-pressed'), last: b.parentElement.classList.contains('session-line-2') && b.parentElement.lastElementChild === b, under: Math.round(Math.abs(own.right - star.right)) };
          })()`,
        );
        t.expectEqual(state, { pressed: 'false', last: true, under: 0 }, `${name}'s toggle, its right edge under the star's`);
      }
      for (const name of [NAMES.running, NAMES.conversation]) t.expect(!(await page.evaluate<boolean>(`!!${rowOf(name)}?.querySelector('.not-needed-toggle')`)), `${name} needs nothing, so it has none`);
    });

    await t.step("marking a row in Needs you takes it out at once, with a toast and Undo, one fewer in the counts, and focus on the next row's toggle", async () => {
      await chooseInRepoList(t, 'Needs you');
      t.expectEqual(await page.evaluate(rowNames), [NAMES.waiting, NAMES.asked, NAMES.prompting], 'the sessions that need you');
      t.expectEqual(await badges(), { needsYou: '3 need you', demoApp: '3 need you' }, 'the badges before');
      await page.click(`the toggle on ${NAMES.asked}`, toggle(NAMES.asked));
      await page.waitFor('the row to leave', `${rowNames}.length === 2`);
      t.expectEqual(await page.evaluate(rowNames), [NAMES.waiting, NAMES.prompting], 'the others');
      t.expectEqual(await page.evaluate(`document.activeElement?.dataset.notNeededSession ?? null`), id(NAMES.prompting), "focus on the toggle of the row that took its place");
      await page.waitFor('the toast', `${toasts}.includes(${q(marked(NAMES.asked))})`);
      t.expect(await page.evaluate<boolean>(`${undoButton(NAMES.asked)}?.textContent === 'Undo'`), 'with Undo');
      t.expectEqual(await page.evaluate('document.title'), '(2) pitwall', 'the title counts one fewer');
      const stored = await page.evaluate<Array<{ id: string; hash: string }>>(entries);
      t.expect(stored.length === 1 && stored[0]?.id === id(NAMES.asked) && /^[0-9a-f]{16}$/.test(stored[0]?.hash ?? ''), 'kept in localStorage: its id and a hash', stored);
      const raw = await page.evaluate<string>(`localStorage.getItem(${q(KEY)}) ?? ''`);
      t.expect(!raw.includes('retry') && !raw.includes(NAMES.asked), 'never what it asked, or its name', raw);
      await t.shot('marked');
      t.expectEqual(await badges(), { needsYou: '2 need you', demoApp: '2 need you' }, 'the badges after');
    });

    await t.step('Undo puts it back in Needs you, with focus on its toggle', async () => {
      await page.click('Undo', undoButton(NAMES.asked));
      await page.waitFor('the row to come back', `${rowNames}.length === 3`);
      t.expectEqual(await page.evaluate(rowNames), [NAMES.waiting, NAMES.asked, NAMES.prompting], 'in its place');
      t.expectEqual(await page.evaluate(`document.activeElement?.dataset.notNeededSession ?? null`), id(NAMES.asked), `focus on its toggle (on ${await page.evaluate<string>(focused)})`);
      t.expectEqual(await page.evaluate(`${toggle(NAMES.asked)}?.getAttribute('aria-pressed')`), 'false', 'not pressed');
      t.expectEqual(await page.evaluate(entries), [], 'the mark gone from storage');
      t.expectEqual(await page.evaluate('document.title'), '(3) pitwall', 'the title counts it again');
    });

    await t.step('marked, it stays in All sessions, quietly: no bar, the badge outlined, Not needed now on line 2, the toggle pressed', async () => {
      await page.click(`the toggle on ${NAMES.asked}`, toggle(NAMES.asked));
      await page.waitFor('the row to leave', `${rowNames}.length === 2`);
      await chooseInRepoList(t, 'All sessions');
      const look = await page.evaluate<Record<string, unknown>>(`(() => {
        const li = ${rowOf(NAMES.asked)};
        const badge = li.querySelector('.badge[data-status]');
        const style = getComputedStyle(badge);
        const button = li.querySelector('.not-needed-toggle');
        return { attention: li.dataset.attention ?? null, bar: getComputedStyle(li).boxShadow.includes('inset 3px'), badge: badge.textContent, status: badge.dataset.status, quiet: badge.classList.contains('state-not-needed'), outline: style.outlineStyle, fill: style.backgroundColor, line2: li.querySelector('.session-what')?.textContent ?? '', pressed: button?.getAttribute('aria-pressed'), shown: getComputedStyle(button).opacity };
      })()`);
      t.expectEqual(look.attention, null, 'no attention mark');
      t.expectEqual(look.bar, false, 'no bar');
      t.expectEqual([look.badge, look.status, look.quiet, look.outline], ['Asked you', 'asked', true, 'dashed'], 'its badge, outlined');
      t.expect(look.fill === 'rgba(0, 0, 0, 0)' || look.fill === 'transparent', 'with no fill', look.fill);
      t.expect(String(look.line2).startsWith('demo-app · Not needed now · Asked: '), 'line 2: the group, Not needed now, then what it asked', look.line2);
      t.expectEqual([look.pressed, look.shown], ['true', '1'], 'the toggle pressed, and shown');
      await t.shot('quiet');
    });

    await t.step('when what it needs changes, it comes back to Needs you by itself, and the mark goes', async () => {
      server.world.need(id(NAMES.asked), { askedYou: { reason: 'question', excerpt: 'The made-up batch failed again: retry it now?' } });
      server.broadcast();
      await page.waitFor('the row to need you again', `${rowOf(NAMES.asked)}?.dataset.attention === 'true'`);
      t.expectEqual(await page.evaluate(`${toggle(NAMES.asked)}?.getAttribute('aria-pressed')`), 'false', 'its toggle no longer pressed');
      t.expectEqual(await page.evaluate(entries), [], 'the mark gone from storage');
      t.expectEqual(await page.evaluate('document.title'), '(3) pitwall', 'the title counts it');
      await chooseInRepoList(t, 'Needs you');
      t.expectEqual(await page.evaluate(rowNames), [NAMES.waiting, NAMES.asked, NAMES.prompting], 'back in Needs you');
    });

    await t.step("the session view's actions menu marks it, with a toast, and puts it back", async () => {
      await openFromRow(t, NAMES.prompting);
      await page.click('Session actions', MENU_BUTTON);
      await page.waitFor('the menu', `!!${VIEW}?.querySelector('[role="menu"]')`);
      const items = await page.evaluate<string[]>(ITEMS);
      t.expect(items.indexOf('Mark not needed now') === items.indexOf('Copy attach command') + 1, 'Mark not needed now, after the copies', items);
      await page.click('Mark not needed now', menuItem('Mark not needed now'));
      await page.waitFor('the toast', `${toasts}.includes(${q(marked(NAMES.prompting))})`);
      t.expectEqual(await page.evaluate(focused), 'Session actions', 'focus back on the menu button');
      const meta = await page.evaluate<{ quiet: boolean; text: string }>(`(() => { const m = ${VIEW}.querySelector('.session-view-meta'); return { quiet: !!m.querySelector('.badge[data-status="waiting"].state-not-needed'), text: m.textContent }; })()`);
      t.expect(meta.quiet && meta.text.includes('Not needed now'), 'its badge outlined, with Not needed now after it', meta);
      await t.shot('view-marked');

      await page.click('Session actions', MENU_BUTTON);
      await page.waitFor('the menu', `!!${VIEW}?.querySelector('[role="menu"]')`);
      t.expect((await page.evaluate<string[]>(ITEMS)).includes('Put back in Needs you'), 'Put back in Needs you, in its place');
      await page.click('Put back in Needs you', menuItem('Put back in Needs you'));
      await page.waitFor('the toast', `${toasts}.includes(${q(`Put ${NAMES.prompting} back in Needs you.`)})`);
      t.expect(!(await page.evaluate<boolean>(`!!${VIEW}.querySelector('.session-view-meta .state-not-needed')`)), 'its badge solid again');
      t.expectEqual(await page.evaluate(entries), [], 'no mark in storage');
    });

    await t.step('a mark lasts through a reload', async () => {
      await t.fresh({ search: '?view=needs-you' });
      await page.click(`the toggle on ${NAMES.waiting}`, toggle(NAMES.waiting));
      await page.waitFor('the row to leave', `${rowNames}.length === 2`);
      await page.reload();
      await page.waitFor('Needs you', `${listHeading} === 'Needs you' && ${rowNames}.length > 0`);
      t.expectEqual(await page.evaluate(rowNames), [NAMES.asked, NAMES.prompting], 'still out of Needs you');
      t.expectEqual(await page.evaluate('document.title'), '(2) pitwall', 'and out of the count');
    });
  },
};

export default part;
