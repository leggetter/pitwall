// Recaps (M5, W111, W121; docs/design-system.md, 4: Recap strip): the strip between the session view's
// header and its tabs, on every tab, with its summary and its to-dos in order, each with its owner's
// tag; collapsed, the summary's first line and how many are yours, and kept so after a reload; a stale recap, and a session with none, asking for one
// once as the view opens, an ended session's included (D26); Refresh, busy until the new one comes,
// and off while the day's budget is spent; Claude Code's recap; the rows' recap reasons on line 2,
// and an outline Waiting on you on an ended one; the app strip's recap lines; the picture (W150):
// Refresh right after the age, Goal, Working on, on one line when collapsed, only your to-dos, and a
// quiet line for what else it waits on; its Plan section (W172): collapsed by default, its toggle on
// one row with its label and the plan's line, open to the items, each tagged, and the changes, none
// when the plan didn't change, nothing wider than the strip, and no section with no plan; and, with
// recaps off, no strip and nothing asked.

import { NAMES, RECAP_CALL_MS, RECAP_PICTURE, RECAP_PICTURE_STEADY, RECAPPED, RECAPS_ERROR } from '../fixtures.js';
import type { Part } from '../runner.js';
import { attachStatus, openFinished, openFromRow, row, VIEW, viewClose, viewName } from './_dom.js';

const STRIP = `${VIEW}?.querySelector('.session-recap')`;
const strip = `(() => {
  const view = ${VIEW};
  const strip = view?.querySelector('.session-recap');
  if (!strip) return null;
  const head = view.querySelector('header.session-view-head').getBoundingClientRect();
  const tabs = view.querySelector('[role="tablist"]').getBoundingClientRect();
  const frame = view.getBoundingClientRect();
  const box = strip.getBoundingClientRect();
  const toggle = strip.querySelector('.recap-toggle');
  const body = strip.querySelector('.recap-body');
  const refresh = strip.querySelector('[data-recap-refresh]');
  const text = strip.querySelector('.recap-summary-text');
  const forYou = strip.querySelector('.recap-for-you');
  const line = (name) => strip.querySelector('.recap-line[data-line="' + name + '"]');
  const lineText = (name) => {
    const each = line(name);
    return each && !each.closest('[hidden]') ? each.querySelector('.recap-line-text')?.textContent ?? null : null;
  };
  const working = line('working-on')?.querySelector('.recap-line-text');
  return {
    picture: strip.dataset.picture !== undefined,
    goal: lineText('goal'),
    workingOn: lineText('working-on'),
    workingOnOneLine: working ? working.getBoundingClientRect().height <= 21 : null,
    plan: (() => {
      const section = strip.querySelector('.recap-plan');
      return section && !section.closest('[hidden]') ? section.querySelector('.recap-plan-line')?.textContent ?? null : null;
    })(),
    planSection: !!strip.querySelector('.recap-plan'),
    forYouLabel: line('for-you')?.querySelector('.recap-label')?.textContent ?? null,
    waiting: strip.querySelector('.recap-waiting')?.textContent ?? null,
    refreshAfterAge: !!strip.querySelector('.recap-head .recap-age + .recap-refresh'),
    kind: strip.dataset.recap,
    title: strip.querySelector('h3')?.textContent ?? null,
    expanded: toggle?.getAttribute('aria-expanded') ?? null,
    summary: text?.textContent ?? null,
    forYou: forYou?.textContent ?? null,
    forYouInside: forYou ? forYou.getBoundingClientRect().right <= box.right + 0.5 : null,
    todos: [...strip.querySelectorAll('.recap-todo')].map((li) => [li.querySelector('.recap-todo-text')?.textContent ?? '', li.querySelector('.recap-owner')?.textContent ?? '']),
    bodyHidden: body ? body.hidden : null,
    stale: !!strip.querySelector('.recap-stale'),
    staleOnLine1: !!strip.querySelector('.recap-head .recap-age + .recap-refresh + .recap-stale'),
    busy: refresh?.getAttribute('aria-busy') === 'true',
    off: refresh?.getAttribute('aria-disabled') === 'true',
    age: strip.querySelector('.recap-age')?.textContent ?? null,
    note: strip.querySelector('.recap-note')?.textContent ?? null,
    between: box.top >= head.bottom - 0.5 && box.bottom <= tabs.top + 0.5,
    inside: box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5,
    share: box.height / frame.height,
    oneLine: text ? text.getBoundingClientRect().height <= 21 : null,
  };
})()`;
type Strip = {
  picture: boolean;
  goal: string | null;
  workingOn: string | null;
  workingOnOneLine: boolean | null;
  plan: string | null;
  planSection: boolean;
  forYouLabel: string | null;
  waiting: string | null;
  refreshAfterAge: boolean;
  kind: string;
  title: string | null;
  expanded: string | null;
  summary: string | null;
  forYou: string | null;
  forYouInside: boolean | null;
  todos: [string, string][];
  bodyHidden: boolean | null;
  stale: boolean;
  staleOnLine1: boolean;
  busy: boolean;
  off: boolean;
  age: string | null;
  note: string | null;
  between: boolean;
  inside: boolean;
  share: number;
  oneLine: boolean | null;
};
/**
 * The Plan section (W172): its toggle, the plan's line beside it, and, open, its items and changes.
 * `offset` is how far the toggle's centre is from the line text's first line's, and `labelOffset` the
 * label's, in px: on one visual row, both are about 0. `tagsInside`: every item's tag ends inside
 * the strip; `pageScroll`: the page itself scrolls sideways.
 */
const plan = `(() => {
  const strip = ${VIEW}?.querySelector('.session-recap');
  const section = strip?.querySelector('.recap-plan');
  if (!section) return null;
  const toggle = section.querySelector('.recap-plan-toggle');
  const text = section.querySelector('.recap-plan-line bdi');
  const body = section.querySelector('.recap-plan-body');
  const box = strip.getBoundingClientRect();
  const centre = (r) => r.top + r.height / 2;
  const t = toggle?.getBoundingClientRect();
  // The line's first line: open, it may wrap, and the toggle lines up with its first.
  const l = text?.getClientRects()[0];
  const whole = text?.getBoundingClientRect();
  const label = (() => {
    const node = toggle && [...toggle.childNodes].find((each) => each.nodeType === 3 && each.textContent.trim() !== '');
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect();
  })();
  const visible = body && !body.hidden;
  return {
    label: toggle?.textContent ?? null,
    expanded: toggle?.getAttribute('aria-expanded') ?? null,
    line: text?.textContent ?? null,
    lineOneLine: whole ? whole.height <= 21 : null,
    offset: t && l ? Math.abs(centre(t) - centre(l)) : null,
    labelOffset: label && l ? Math.abs(centre(label) - centre(l)) : null,
    items: visible ? [...section.querySelectorAll('.recap-plan-item')].map((li) => [li.querySelector('.recap-plan-item-text')?.textContent ?? '', li.querySelector('.recap-plan-state')?.textContent ?? '']) : [],
    changes: visible ? section.querySelector('.recap-plan-changes')?.textContent ?? null : null,
    tagsInside: [...section.querySelectorAll('.recap-plan-state')].every((tag) => tag.getBoundingClientRect().right <= box.right + 0.5),
    noOverflow: strip.scrollWidth <= strip.clientWidth + 1,
    pageScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
})()`;
type Plan = {
  label: string | null;
  expanded: string | null;
  line: string | null;
  lineOneLine: boolean | null;
  offset: number | null;
  labelOffset: number | null;
  items: [string, string][];
  changes: string | null;
  tagsInside: boolean;
  noOverflow: boolean;
  pageScroll: boolean;
};
const PLAN_TOGGLE = `${STRIP}?.querySelector('.recap-plan-toggle')`;
const PLAN_STATE_TEXT = { done: 'Done', now: 'Now', next: 'Next', dropped: 'Dropped' } as const;

const APP_STRIP = `document.querySelector('.app-strips [data-strip="recaps"]')?.textContent ?? null`;
const lineTwo = (name: string) => `(${row(name)})?.closest('li.session')?.querySelector('.session-what-text')?.textContent ?? null`;
const badge = (name: string) => `(${row(name)})?.closest('li.session')?.querySelector('.session-badges [data-status]')?.textContent ?? null`;

const part: Part = {
  name: 'recaps',
  title: 'Recaps: the strip between the header and the tabs, its summary and to-dos, collapsed, its Plan section, asking once, Refresh, the budget, Claude Code’s recap, the rows’ reasons and the app strip',
  async run(t) {
    const { page, server } = t;
    const asked = (name: string) => server.records.recapRefreshes.filter((each) => each.name === name);
    /** Below three columns the view covers the list: it closes first, so the next row can be clicked. */
    const closeView = async () => {
      if (t.layout === 'three-columns' || !(await page.evaluate<boolean>(`!!${VIEW}?.querySelector('h2')`))) return;
      await page.click('Close', viewClose);
      await page.waitFor('the view to close', `!${VIEW}?.querySelector('h2')`);
    };
    const open = async (name: string, kind = 'shown') => {
      await closeView();
      await openFromRow(t, name);
      return page.waitFor<Strip>(`its recap strip, ${kind}`, `(() => { const s = ${strip}; return s && s.kind === ${JSON.stringify(kind)} ? s : null; })()`);
    };

    await t.step('the strip: the picture, the goal, what it is working on, the plan and only your to-dos, between the header and the tabs (W150)', async () => {
      await t.fresh({ search: '?view=all', recaps: 'ok' });
      const shown = await open(NAMES.conversation);
      t.expectEqual(shown.title, 'Recap', 'its title');
      t.expectEqual(shown.refreshAfterAge, true, 'line 1: Refresh right after the age');
      t.expectEqual(shown.picture, true, 'the picture');
      t.expectEqual(shown.goal, RECAP_PICTURE.goal, 'Goal: why it was started');
      t.expectEqual(shown.workingOn, RECAP_PICTURE.workingOn, 'Working on: the item and why');
      t.expectEqual(shown.plan, RECAP_PICTURE.plan, "Plan: the plan's line");
      t.expectEqual(shown.forYouLabel, 'For you (2):', 'For you, with how many');
      t.expectEqual(
        shown.todos,
        [
          ['Say whether to fix the lint errors on #51 now, or leave them for the made-up follow-up', ''],
          ['Say whether to mark #51 ready', ''],
        ],
        "only your to-dos, in order, with no tags; the session's own is the conversation's",
      );
      t.expectEqual(shown.summary, null, 'no summary beside the picture');
      t.expectEqual(shown.waiting, null, 'no quiet line: it waits on you');
      t.expectEqual(shown.forYou, null, 'no count while it is open: the list shows them');
      t.expectEqual(shown.expanded, 'true', 'open, by default');
      t.expect(shown.between && shown.inside, 'between the header and the tabs, inside the view', shown);
      t.expect(shown.share <= 0.36, 'at most 35% of the view', shown.share);
      t.expect(/^\d+m ago$/.test(shown.age ?? ''), 'its age', shown.age);
      t.expectEqual(asked(NAMES.conversation).length, 0, 'a current recap asks for nothing');
      t.expectEqual(
        server.records.recapFetches.filter((each) => each.name === NAMES.conversation),
        [{ name: NAMES.conversation, status: 200 }],
        'fetched once, as the view opened',
      );
      await t.shot('strip');
    });

    await t.step("the Plan section: collapsed by default, its toggle on one row with its label and the plan's line, open to the items and the changes (W172)", async () => {
      const collapsed = await page.evaluate<Plan>(plan);
      t.expectEqual(collapsed.label, 'Plan', 'a disclosure named Plan');
      t.expectEqual(collapsed.expanded, 'false', 'collapsed by default');
      t.expectEqual(collapsed.line, RECAP_PICTURE.plan, "the plan's line, while it's collapsed");
      t.expectEqual(collapsed.lineOneLine, true, 'on one line while collapsed');
      t.expect(collapsed.offset !== null && collapsed.offset <= 2, "the toggle centred on the line's row, no vertical offset", collapsed);
      t.expect(collapsed.labelOffset !== null && collapsed.labelOffset <= 2, "its label on the line's row", collapsed);
      t.expectEqual(collapsed.items, [], 'no items while collapsed');
      await page.click('the Plan toggle', PLAN_TOGGLE);
      const opened = await page.waitFor<Plan>('the Plan section to open', `(() => { const p = ${plan}; return p && p.expanded === 'true' ? p : null; })()`);
      t.expectEqual(
        opened.items,
        RECAP_PICTURE.planItems.map((item) => [item.text, PLAN_STATE_TEXT[item.state]]),
        'its items, in order, each with its state',
      );
      t.expectEqual(opened.changes, `Changes: ${RECAP_PICTURE.planChanges}`, 'how the plan changed');
      t.expect(opened.offset !== null && opened.offset <= 2, 'the toggle still on the first line’s row while the line wraps', opened);
      t.expect(opened.tagsInside && opened.noOverflow && !opened.pageScroll, 'every tag inside the strip, nothing wider than it, and no sideways page scroll', opened);
      t.expectEqual(await page.evaluate(`localStorage.getItem('pitwall.recap-plan-collapsed.v1')`), 'false', 'its choice kept as a boolean');
      await t.shot('plan');
      await page.click('the Plan toggle', PLAN_TOGGLE);
      await page.waitFor('the Plan section to collapse', `${plan}?.expanded === 'false'`);
    });

    await t.step('collapsed, it keeps Working on’s first line and how many to-dos are yours, and stays collapsed after a reload', async () => {
      await page.click('the Recap toggle', `${STRIP}?.querySelector('.recap-toggle')`);
      const collapsed = await page.waitFor<Strip>('the strip to collapse', `(() => { const s = ${strip}; return s && s.expanded === 'false' ? s : null; })()`);
      t.expect(collapsed.bodyHidden === true && collapsed.goal === null && collapsed.plan === null && collapsed.workingOn === RECAP_PICTURE.workingOn, 'the goal, the plan and the to-dos hidden, Working on kept', collapsed);
      t.expectEqual(collapsed.workingOnOneLine, true, 'Working on, on one line');
      t.expectEqual(collapsed.forYou, '2 for you', 'how many to-dos are yours');
      t.expectEqual(collapsed.forYouInside, true, 'the count inside the strip, however narrow');
      t.expectEqual(await page.evaluate(`localStorage.getItem('pitwall.recap-collapsed.v1')`), 'true', 'kept as a boolean');
      await t.shot('collapsed');
      await page.reload();
      await page.waitFor('the view again', `${viewName} === ${JSON.stringify(NAMES.conversation)}`, 15_000);
      const reloaded = await page.waitFor<Strip>('its strip', `(() => { const s = ${strip}; return s && s.kind === 'shown' ? s : null; })()`);
      t.expectEqual(reloaded.expanded, 'false', 'still collapsed');
      await page.click('the Recap toggle', `${STRIP}?.querySelector('.recap-toggle')`);
      await page.waitFor('the strip to open', `${strip}?.expanded === 'true'`);
    });

    await t.step('on the Terminal tab too, waiting on CI', async () => {
      await page.navigate(`/?view=all`);
      await page.waitFor('the list', `!!${row(NAMES.running2)}`, 15_000);
      const shown = await open(RECAPPED.ci);
      await page.waitFor('the terminal to attach', `${attachStatus} === 'attached'`);
      const onTerminal = await page.evaluate<Strip>(strip);
      t.expectEqual(
        onTerminal.todos,
        [
          ['Finish the made-up CI run on its branch', 'CI'],
          ['Say whether to open the PR once it passes', 'You'],
        ],
        'CI’s to-do first, then yours',
      );
      t.expect(onTerminal.between, 'still between the header and the tabs', onTerminal);
      t.expect(shown.summary?.startsWith('You asked it to make the made-up retry worker back off.') ?? false, 'its summary', shown.summary);
      t.expect(!onTerminal.picture && !onTerminal.planSection, 'a recap without the picture: its summary and to-dos, and no plan (W172)', onTerminal);
      await t.shot('terminal');
    });

    await t.step('the picture with no plan, waiting on someone else: no Plan section, and a quiet line (W150, W172)', async () => {
      const shown = await open(RECAPPED.someoneElse);
      t.expectEqual(shown.planSection, false, 'no Plan section');
      t.expectEqual(shown.forYouLabel, null, 'nothing for you');
      t.expectEqual(shown.todos, [], "someone else's to-do isn't shown");
      t.expectEqual(shown.waiting, 'Waiting on someone else.', 'a quiet line says what it waits on');
      t.expect(shown.inside, 'inside the view', shown);
      await t.shot('picture-someone-else');
    });

    await t.step('a plan that has not changed: open, its items and no Changes line (W172)', async () => {
      await open(RECAPPED.anotherSession);
      await page.click('the Plan toggle', PLAN_TOGGLE);
      const opened = await page.waitFor<Plan>('the Plan section to open', `(() => { const p = ${plan}; return p && p.expanded === 'true' ? p : null; })()`);
      t.expectEqual(opened.line, RECAP_PICTURE_STEADY.plan, "the plan's line");
      t.expectEqual(
        opened.items,
        RECAP_PICTURE_STEADY.planItems.map((item) => [item.text, PLAN_STATE_TEXT[item.state]]),
        'its items, in order',
      );
      t.expectEqual(opened.changes, null, 'no Changes line');
      t.expect(opened.tagsInside && opened.noOverflow && !opened.pageScroll, 'inside the strip', opened);
      await t.shot('plan-steady');
      await page.click('the Plan toggle', PLAN_TOGGLE);
      await page.waitFor('the Plan section to collapse', `${plan}?.expanded === 'false'`);
    });

    await t.step('Claude Code’s recap: a summary only, with nothing to open', async () => {
      const shown = await open(RECAPPED.claudeCode);
      t.expectEqual(shown.title, "Claude Code's recap", 'its title says whose it is');
      t.expect(shown.expanded === null && shown.todos.length === 0 && shown.note === null, 'no disclosure button, no to-dos and no note', shown);
      t.expect(shown.summary?.startsWith('The made-up index rebuild') ?? false, 'the summary: where it is', shown.summary);
    });

    await t.step('a stale recap: the view asks for a new one once, and shows it', async () => {
      await open(RECAPPED.stale);
      await page.waitFor('the new recap', `(() => { const s = ${strip}; return s && s.kind === 'shown' && !s.stale && !s.busy; })()`, 8_000);
      await page.settle(RECAP_CALL_MS + 1_500);
      t.expectEqual(asked(RECAPPED.stale), [{ name: RECAPPED.stale, status: 200 }], 'asked once, never again');
    });

    await t.step('a session with none: the strip says one is coming, asks once, and shows it', async () => {
      await open(NAMES.waiting, 'loading');
      const shown = await page.waitFor<Strip>('its first recap', `(() => { const s = ${strip}; return s && s.kind === 'shown' ? s : null; })()`, 8_000);
      t.expectEqual(shown.todos, [['Answer its permission prompt to run the made-up docs build', 'You']], 'its to-do');
      await page.settle(1_000);
      t.expectEqual(asked(NAMES.waiting).length, 1, 'asked once');
    });

    await t.step('an ended session: its view asks once, its recap shows, and it waits on you, outlined', async () => {
      await closeView();
      await page.navigate('/?view=all');
      await page.waitFor('All sessions', `!!document.querySelector('.session-list .finished-toggle')`, 15_000);
      await openFinished(t);
      const shown = await open(NAMES.ended);
      t.expect(shown.summary?.startsWith('You asked it to tidy the made-up release notes.') ?? false, 'its first recap', shown.summary);
      await page.settle(1_000);
      t.expectEqual(asked(NAMES.ended), [{ name: NAMES.ended, status: 200 }], 'asked once, as it opened');
      t.expectEqual(await page.evaluate(`${VIEW}?.querySelector('.session-view-meta .badge-outline')?.textContent ?? null`), 'Waiting on you', 'an outline Waiting on you in its header, as a finished Asked you is');
      t.expectEqual(
        await page.evaluate(`(${row(NAMES.ended)})?.closest('li.session')?.querySelector('.badge-outline')?.textContent ?? null`),
        'Waiting on you',
        'and on its row, which never needs you',
      );
      t.expectEqual(await page.evaluate(`(${row(NAMES.ended)})?.closest('li.session')?.dataset.attention ?? null`), null, 'no bar');
      await t.shot('ended');
    });

    await t.step('a finished session with nothing left to do: the summary, then a note', async () => {
      const shown = await open(RECAPPED.done);
      t.expectEqual(shown.todos, [], 'no to-dos');
      t.expectEqual(shown.note, 'Nothing left to do.', 'a note says so');
    });

    await t.step('Refresh: busy until the new recap comes', async () => {
      await open(NAMES.conversation);
      await page.click('Refresh the recap', `${STRIP}?.querySelector('[data-recap-refresh]')`);
      await page.waitFor('Refresh to be busy', `${strip}?.busy === true`);
      await t.shot('refreshing');
      const after = await page.waitFor<Strip>('the new recap', `(() => { const s = ${strip}; return s && !s.busy ? s : null; })()`, 8_000);
      t.expectEqual(after.age, 'just now', 'the new one, just now');
      t.expectEqual(asked(NAMES.conversation), [{ name: NAMES.conversation, status: 200 }], 'one request');
    });

    await t.step('rows: Waiting on you on line 2 in Needs you, and what an idle session waits on otherwise', async () => {
      await closeView();
      await page.navigate('/?view=needs-you');
      await page.waitFor('Needs you', `!!${row(NAMES.conversation)}`, 15_000);
      const needs = await page.evaluate<string | null>(lineTwo(NAMES.conversation));
      t.expect(needs?.includes('Next: Say whether to fix the lint errors on #51') ?? false, "Needs you's 'recap' reason on line 2, after Next:", needs);
      t.expectEqual(await page.evaluate(badge(NAMES.conversation)), 'Waiting on you', 'its badge');
      await t.shot('needs-you');
      await page.navigate('/?view=all');
      await page.waitFor('All sessions', `!!${row(RECAPPED.someoneElse)}`, 15_000);
      const quiet = await page.evaluate<string | null>(lineTwo(RECAPPED.someoneElse));
      t.expect(quiet?.includes('Waiting on someone else · You:') ?? false, 'a quiet reason first on line 2', quiet);
      t.expectEqual(await page.evaluate(`(${row(RECAPPED.someoneElse)})?.closest('li.session')?.dataset.attention ?? null`), null, 'never needing you');
      t.expect(!((await page.evaluate<string | null>(lineTwo(RECAPPED.ci))) ?? '').includes('Waiting on'), 'not while it works');
    });

    await t.step('the day’s budget spent: the app strip says so, Refresh is off, and nothing is asked for', async () => {
      await t.fresh({ search: '?view=all', recaps: 'spent' });
      t.expect((await page.evaluate<string | null>(APP_STRIP))?.startsWith("Today's 500 recaps are used up") ?? false, 'the app strip', await page.evaluate(APP_STRIP));
      const shown = await open(RECAPPED.stale);
      t.expect(shown.stale && shown.staleOnLine1 && shown.summary?.startsWith('You asked it to review the made-up retry change.') === true, 'its stale recap, which says so on line 1, beside its age', shown);
      t.expectEqual(shown.off, true, 'Refresh is off');
      await page.click('Refresh the recap', `${STRIP}?.querySelector('[data-recap-refresh]')`);
      await page.settle(1_000);
      t.expectEqual(server.records.recapRefreshes.length, 0, 'nothing asked for');
      await t.shot('budget');
    });

    await t.step('the latest recap failed: the app strip says so, and a session with none says none came', async () => {
      await t.fresh({ search: '?view=all', recaps: 'failing' });
      t.expect((await page.evaluate<string | null>(APP_STRIP))?.includes(RECAPS_ERROR) ?? false, 'the app strip, in pitwall’s words', await page.evaluate(APP_STRIP));
      await open(NAMES.waiting, 'loading');
      const none = await page.waitFor<Strip>('none, after the call failed', `(() => { const s = ${strip}; return s && s.kind === 'none' ? s : null; })()`, 8_000);
      t.expect(none.note?.startsWith('No recap yet. The latest recap failed:') ?? false, 'why', none.note);
      await t.shot('failing');
    });

    await t.step('recaps off: no strip, nothing fetched or asked for, and no app strip', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.conversation);
      await page.settle(1_000);
      t.expectEqual(await page.evaluate(`!!${STRIP}`), false, 'no strip');
      t.expect(server.records.recapFetches.length === 0 && server.records.recapRefreshes.length === 0, 'nothing fetched or asked for', server.records);
      t.expectEqual(await page.evaluate(APP_STRIP), null, 'no app strip');
    });
  },
};

export default part;
