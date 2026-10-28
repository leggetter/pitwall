// The session view and its conversation (docs/design-system.md, 4: Session view, Conversation,
// Markdown in messages): its header and tabs, and every kind of entry: You, Claude, From another
// session, To pitwall-relay, a question Claude Code asked, a notice, one tool call, and two or more
// folded into one toggle. Markdown shows as pitwall's own elements, and the view opens at the newest.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { openFromRow, VIEW, viewClose, viewHeading, viewTab } from './_dom.js';

const BODY = `${VIEW}.querySelector('.session-view-body')`;
const entries = `[...${VIEW}.querySelectorAll('ol.conversation > li.entry')].map((li) => ({ kind: [...li.classList].find((c) => c.startsWith('entry-')), speaker: li.querySelector(':scope > .entry-speaker')?.childNodes[0]?.textContent ?? null }))`;
const FOLD = `${VIEW}.querySelector('li.entry-fold button.fold-toggle')`;

const part: Part = {
  name: 'conversation',
  title: 'The session view: its header and tabs, and every kind of conversation entry',
  async run(t) {
    const { page } = t;

    await t.step('opens from its row, on Conversation, at the newest entry', async () => {
      await t.fresh({ search: '?view=all' });
      await openFromRow(t, NAMES.conversation);
      await page.waitFor('the conversation', `${VIEW}.querySelectorAll('ol.conversation > li.entry').length > 0`);
      await page.settle(100);
      t.expectEqual(await page.evaluate(`${viewHeading}.textContent`), `${NAMES.conversation} · Add a made-up health route`, 'the heading: name · title');
      t.expectEqual(await page.evaluate(viewTab), 'Conversation', 'an interactive session opens on Conversation');
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('.session-view-meta .badge')?.textContent`), 'Idle', 'its status badge');
      t.expect(await page.evaluate(`${VIEW}.querySelector('.session-view-kind')?.textContent.includes('Interactive')`), 'its kind');
      t.expect(await page.evaluate(`(() => { const b = ${BODY}; return b.scrollHeight - b.clientHeight - b.scrollTop < 2; })()`), 'scrolled to the newest entry');
      t.expect(await page.evaluate(`!!${VIEW}.querySelector('.relay-box textarea')`), 'an interactive session has the message box');
      await t.shot('open');
    });

    await t.step('every kind of entry, each with its speaker', async () => {
      const shown = await page.evaluate<Array<{ kind: string; speaker: string | null }>>(entries);
      t.expectEqual(
        shown.map((each) => `${each.kind}${each.speaker ? `: ${each.speaker}` : ''}`),
        [
          'entry-user: You',
          'entry-assistant: Claude',
          'entry-tool',
          'entry-assistant: Claude',
          'entry-fold',
          'entry-question: Claude asked',
          'entry-cross-session: From pitwall-test-reviewer',
          'entry-to-pitwall: To pitwall-relay',
          'entry-notice',
          'entry-assistant: Claude',
        ],
        'the entries, oldest first',
      );
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('li.entry-tool .tool-call-text')?.textContent`), 'Read: src/routes.ts', 'one tool call stands alone, as its summary');
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('li.entry-notice')?.textContent`), 'Conversation compacted.', 'the notice');
    });

    await t.step("Claude's message is markdown, as pitwall's own elements", async () => {
      const markdown = await page.evaluate<{ items: string[]; code: string[]; html: number }>(`(() => {
        const entry = ${VIEW}.querySelectorAll('li.entry-assistant')[0];
        return {
          items: [...entry.querySelectorAll('ul.md-list > li')].map((li) => li.textContent),
          code: [...entry.querySelectorAll('code')].map((c) => c.textContent),
          html: entry.querySelectorAll('script, iframe, img, style').length,
        };
      })()`);
      t.expectEqual(markdown.items, ['read src/routes.ts', 'add GET /health', 'add a test'], 'a list, as list items');
      t.expectEqual(markdown.code, ['src/routes.ts', 'GET /health'], 'inline code, as code');
      t.expect(markdown.html === 0, 'nothing but text and pitwall elements', markdown);
      t.expect(await page.evaluate(`${VIEW}.querySelector('li.entry-user .entry-text').textContent === 'Add a made-up health route to the API, with a test.' && !${VIEW}.querySelector('li.entry-user .entry-markdown')`), 'your prompt is plain text');
    });

    await t.step('a question shows its options, with the answer marked', async () => {
      const question = await page.evaluate<{ header: string; text: string; options: Array<{ label: string; chosen: boolean }> }>(`(() => {
        const entry = ${VIEW}.querySelector('li.entry-question');
        return {
          header: entry.querySelector('.question-header')?.textContent,
          text: entry.querySelector('.question-text')?.textContent,
          options: [...entry.querySelectorAll('.question-option')].map((o) => ({ label: o.querySelector('.question-option-label').childNodes[0].textContent, chosen: o.classList.contains('chosen') && o.textContent.includes('Your answer') })),
        };
      })()`);
      t.expectEqual(question, { header: 'Status', text: 'Which status should the health route return?', options: [{ label: '200 OK', chosen: true }, { label: '204 No Content', chosen: false }] }, 'the question, its options and its answer');
    });

    await t.step('two or more tool calls fold into one toggle, which opens and shuts', async () => {
      t.expectEqual(await page.evaluate(`${FOLD}.getAttribute('aria-label')`), '3 tool calls, 1 error', "the toggle's name counts the calls and the errors");
      t.expectEqual(await page.evaluate(`${FOLD}.getAttribute('aria-expanded')`), 'false', 'folded to begin with');
      t.expect(await page.evaluate(`${VIEW}.querySelector('li.entry-fold ol.tool-calls').hidden`), 'its calls are hidden');
      await page.click('the fold', FOLD);
      t.expectEqual(await page.evaluate(`${FOLD}.getAttribute('aria-expanded')`), 'true', 'open after a click');
      const calls = await page.evaluate<Array<{ text: string; error: boolean }>>(`[...${VIEW}.querySelectorAll('li.entry-fold ol.tool-calls > li')].filter((li) => li.offsetParent !== null).map((li) => ({ text: li.querySelector('.tool-call-text').textContent, error: li.classList.contains('has-error') && !!li.querySelector('.tool-call-error') }))`);
      t.expectEqual(calls, [{ text: 'Bash: npm test', error: true }, { text: 'Edit: src/routes.test.ts', error: false }, { text: 'Bash: npm test', error: false }], 'its calls, the failed one marked');
      await t.shot('fold-open');
      await page.click('the fold', FOLD);
      t.expectEqual(await page.evaluate(`${FOLD}.getAttribute('aria-expanded')`), 'false', 'shut again after a second click');
    });

    await t.step('Escape closes the view', async () => {
      await page.evaluate(`${viewHeading}.focus()`);
      await page.key('Escape');
      await page.waitFor('the view to close', `!${VIEW} || !${viewHeading}`);
      t.expect(!(await page.evaluate(`location.search.includes('session=')`)), 'the URL has no session');
      t.expect(await page.evaluate(`!!${viewClose} === false`), 'no view left to close');
    });
  },
};

export default part;
