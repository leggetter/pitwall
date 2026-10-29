// The working line at the end of the conversation (W102; docs/design-system.md, 4: Conversation): while
// a session works, the spinner, "Working · 3m 24s" counted from the prompt that began the turn, not
// one typed mid-turn, and the command still out; the newest page fetched every 2 s while it shows, and
// not behind the Terminal tab; the line gone and "Finished" said once the turn ends; a steady dot
// under reduced motion; and, while a session waits on you, what for and where to answer.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { attachStatus, openFromRow, VIEW, viewClose, viewTabButton } from './_dom.js';

const LINE = `${VIEW}?.querySelector('.session-view-body .working-line')`;
const line = `(() => {
  const line = ${LINE};
  if (!line) return null;
  const box = line.getBoundingClientRect();
  const step = line.querySelector('.working-step');
  return {
    status: line.querySelector('.working-status')?.textContent ?? null,
    step: step?.textContent ?? null,
    where: line.querySelector('.working-where')?.textContent ?? null,
    spinner: !!line.querySelector('.spinner'),
    dot: !!line.querySelector('.working-dot'),
    timeHidden: line.querySelector('.working-time')?.getAttribute('aria-hidden') ?? null,
    afterNewest: line.previousElementSibling?.matches('ol.conversation') ?? false,
    oneLine: step ? step.getBoundingClientRect().height <= 21 : null,
    fits: box.right <= line.closest('.session-view-body').getBoundingClientRect().right + 0.5,
  };
})()`;
type Line = { status: string | null; step: string | null; where: string | null; spinner: boolean; dot: boolean; timeHidden: string | null; afterNewest: boolean; oneLine: boolean | null; fits: boolean };
const ANNOUNCER = `${VIEW}?.querySelector('.session-view-body .working-announcer')?.textContent`;
const AT_BOTTOM = `(() => { const b = ${VIEW}.querySelector('.session-view-body'); return b.scrollHeight - b.clientHeight - b.scrollTop < 2; })()`;

const part: Part = {
  name: 'working-line',
  title: 'The working line: Working, the time and the step while a session works, its 2 s fetches, the turn ending, reduced motion, and waiting on you',
  async run(t) {
    const { page, server } = t;
    const id = (name: string) => server.world.byName(name).sessionId;
    const fetches = (name: string) => server.records.requests.filter((each) => each === `GET /api/sessions/${id(name)}/conversation 200`).length;
    /** Below three columns the view covers the list: it closes first, so the next row can be clicked. */
    const closeView = async () => {
      if (t.layout === 'three-columns' || !(await page.evaluate<boolean>(`!!${VIEW}?.querySelector('h2')`))) return;
      await page.click('Close', viewClose);
      await page.waitFor('the view to close', `!${VIEW}?.querySelector('h2')`);
    };
    /**
     * A running background session opens on Terminal (W54): Conversation shows its working line. Its
     * terminal attaches first, so leaving the tab doesn't close the socket before it's open, which
     * the browser reports as a problem (a race #109's app check runs found, on the base branch too).
     */
    const openConversation = async (name: string) => {
      await closeView();
      await openFromRow(t, name);
      await page.waitFor('the terminal to attach', `${attachStatus} === 'attached'`);
      await page.click('the Conversation tab', viewTabButton('Conversation'));
      await page.waitFor('the working line', `!!${LINE}`);
    };

    await t.step('while it works: the spinner, Working and the time since its prompt, and the command still out, after the newest entry', async () => {
      await t.fresh({ search: '?view=all', motion: true });
      await openConversation(NAMES.running);
      const shown = await page.evaluate<Line>(line);
      t.expect(/^Working · 3m 2\d+s$/.test(shown.status ?? ''), 'counted from the prompt that began the turn, 3m 24s ago, not the one typed mid-turn 1m 30s ago', shown.status);
      t.expectEqual(shown.step, 'Running Bash: npm test -- export --skip-slow', 'the step: the command still waiting on its result');
      t.expect(shown.spinner && !shown.dot, 'the spinner, with motion on', shown);
      t.expectEqual(shown.timeHidden, 'true', 'the time is hidden from screen readers');
      t.expect(shown.afterNewest, 'after the newest entry', shown);
      t.expect(shown.oneLine === true && shown.fits, 'the step on one line, inside the body', shown);
      t.expect(await page.evaluate<boolean>(AT_BOTTOM), 'the conversation is at the bottom, with the line in view');
      t.expectEqual(await page.evaluate(ANNOUNCER), '', 'nothing said for the state it opened in');
      await page.settle(1_100);
      const later = await page.evaluate<Line>(line);
      t.expect(later.status !== shown.status, 'the time ticks', { before: shown.status, after: later.status });
      await t.shot('working');
    });

    if (t.viewport.name === '1440') {
      await t.step('the newest page every 2 s while it shows, and none behind the Terminal tab', async () => {
        const before = fetches(NAMES.running);
        await page.settle(4_500);
        const polled = fetches(NAMES.running) - before;
        t.expect(polled >= 2 && polled <= 3, 'two fetches, or three, in 4.5 s', { polled, requests: server.records.requests.slice(-8) });
        await page.click('the Terminal tab', viewTabButton('Terminal'));
        await page.settle(300);
        const hidden = fetches(NAMES.running);
        await page.settle(4_500);
        t.expectEqual(fetches(NAMES.running) - hidden, 0, 'none while the Conversation tab is hidden');
        await page.click('the Conversation tab', viewTabButton('Conversation'));
        await page.waitFor('the working line', `!!${LINE}`);
      });
    }

    await t.step('the turn ends: the line goes, and the status region says Finished', async () => {
      server.world.endTurn(id(NAMES.running));
      server.broadcast();
      await page.waitFor('the line to go', `!${LINE}`);
      t.expectEqual(await page.evaluate(ANNOUNCER), 'Finished', 'said once the turn ends');
      // The line goes with the snapshot; the reply comes with the conversation's next fetch, a moment later.
      await page.waitFor('its reply in the conversation', `[...${VIEW}.querySelectorAll('li.entry-assistant')].some((li) => li.textContent.includes('The made-up export tests pass now.'))`);
      t.expect(await page.evaluate<boolean>(AT_BOTTOM), 'still at the bottom');
      const after = fetches(NAMES.running);
      await page.settle(2_500);
      t.expectEqual(fetches(NAMES.running) - after, 0, 'and nothing more is fetched by itself');
    });

    await t.step('under reduced motion: a steady dot in the spinner’s place, so nothing spins', async () => {
      await t.fresh({ search: '?view=all' });
      await openConversation(NAMES.running);
      const shown = await page.evaluate<Line>(line);
      t.expect(shown.dot && !shown.spinner, 'the dot, no spinner', shown);
      t.expect(/^Working · /.test(shown.status ?? ''), 'still Working and the time', shown.status);
      await t.shot('reduced-motion');
    });

    await t.step('waiting on you: what for and where to answer, with no time and no spinner', async () => {
      await closeView();
      await openFromRow(t, NAMES.waiting);
      await page.waitFor('the waiting line', `!!${LINE}`);
      const interactive = await page.evaluate<Line>(line);
      t.expectEqual(interactive.status, 'Waiting for you: permission prompt', 'what it waits for, as Claude Code says');
      t.expectEqual(interactive.where, 'Answer it in its terminal.', 'an interactive session: in its terminal');
      t.expect(!interactive.spinner && !interactive.dot && interactive.timeHidden === null && interactive.step === null, 'no time, no step, nothing that moves', interactive);
      await t.shot('waiting');
      await openConversation(NAMES.prompting);
      t.expectEqual((await page.evaluate<Line>(line)).where, 'Answer it in its Terminal tab.', 'a background session: in its Terminal tab');
    });
  },
};

export default part;
