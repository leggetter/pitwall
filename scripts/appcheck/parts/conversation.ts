// The session view and its conversation (docs/design-system.md, 4: Session view, Conversation,
// Markdown in messages): its header and tabs, and every kind of entry: You, Claude, From another
// session, To pitwall-relay, a question Claude Code asked, a notice, one tool call, and two or more
// folded into one toggle. Markdown shows as pitwall's own elements, a code block's long lines wrap (W137), and the view opens at the newest.

import { fingerprint } from '../../../src/shared/fingerprint.js';
import type { ConversationEntry } from '../../../src/shared/protocol.js';
import { CODE, DEMO_APP_WEB, NAMES, SPIN_OFF, SPIN_OFF_PROMPT } from '../fixtures.js';
import type { Part } from '../runner.js';
import { DIALOG, dialogButton, dialogName, openFromRow, VIEW, viewClose, viewHeading, viewName, viewTab } from './_dom.js';

const q = JSON.stringify;
const CARD = `${VIEW}?.querySelector('.spin-off-block')`;
const PROMPT_FIELD = `[...(${DIALOG}?.querySelectorAll('input, select, textarea') ?? [])].find((el) => el.labels?.[0]?.textContent.trim().startsWith('First prompt'))`;

/** The made-up assistant messages for W209: one with a spin-off block (the fence's body is the fixture's proposal, line for line), then a long one, so the newest isn't the card. */
function blockMessages(link?: string): ConversationEntry[] {
  const body = ['folder: ' + DEMO_APP_WEB, 'name: pitwall-test-spin-off', 'prompt:', ...SPIN_OFF_PROMPT.split('\n')];
  const at = new Date().toISOString();
  return [
    { kind: 'assistant', markdown: true, at, text: ['That settings work is separate from this session, so here is a proposal for a new one.', '', '```spin-off', ...body, '```'].join('\n'), spinOffs: [{ spinOff: SPIN_OFF, lines: body.length, check: fingerprint(body.join('\n')) }] },
    { kind: 'assistant', markdown: true, at, text: ['Meanwhile, the notes for this session:', '', ...(link ? [`Open the card: [the spin-off card](${link})`, ''] : []), ...Array.from({ length: 40 }, (_, index) => `- Note ${index + 1}: a made-up line, so the conversation is taller than the window.`)].join('\n') },
  ];
}

const BODY = `${VIEW}.querySelector('.session-view-body')`;
const entries = `[...${VIEW}.querySelectorAll('ol.conversation > li.entry')].map((li) => ({ kind: [...li.classList].find((c) => c.startsWith('entry-')), speaker: li.querySelector(':scope > .entry-speaker')?.childNodes[0]?.textContent ?? null }))`;
const FOLD = `${VIEW}.querySelector('li.entry-fold button.fold-toggle')`;

const part: Part = {
  name: 'conversation',
  title: 'The session view: its header and tabs, and every kind of conversation entry',
  async run(t) {
    const { page, server } = t;

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

    await t.step('a code block wraps its long lines, indents kept, and never scrolls sideways (W137)', async () => {
      const block = await page.evaluate<{ wraps: boolean; sideways: boolean; indent: false | { offset: number; ch: number; ok: boolean } } | null>(`(() => {
        const pre = ${VIEW}.querySelector('li.entry-assistant pre.md-code-scroll');
        if (!pre) return null;
        pre.scrollIntoView({ block: 'center' });
        const line = parseFloat(getComputedStyle(pre).lineHeight);
        const code = pre.querySelector('code');
        return {
          wraps: code.getBoundingClientRect().height > 2.5 * line,
          sideways: pre.scrollWidth > pre.clientWidth + 1,
          indent: (() => {
            // Drawn indented, not only in the text: the '#' starts its own line two spaces in, between 1.5
            // and 3ch past the box's content edge, which white-space: normal would collapse.
            const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            while (node && !node.textContent.includes('# indented, kept as typed')) node = walker.nextNode();
            if (!node) return false;
            const at = node.textContent.indexOf('# indented');
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + 1);
            const style = getComputedStyle(pre);
            const edge = pre.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
            const ch = range.getBoundingClientRect().width;
            const offset = range.getBoundingClientRect().left - edge;
            return { offset, ch, ok: offset >= 1.5 * ch && offset <= 3 * ch };
          })(),
        };
      })()`);
      t.expect(block !== null, 'a code block in the conversation');
      t.expect(block?.wraps === true, 'its long line wraps onto more lines', block);
      t.expect(block?.sideways === false, 'it doesn’t scroll sideways', block);
      t.expect(block?.indent !== false && block?.indent?.ok === true, 'the indent is drawn, two spaces in', block);
      await t.shot('code-block');
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

    await t.step('a spin-off block is a card with Start; Start checks it by its key and opens New session filled in; nothing starts (W209)', async () => {
      const id = server.world.byName(NAMES.conversation).sessionId;
      await t.fresh({ search: '?view=all' });
      server.world.blockMessages(id, blockMessages());
      await openFromRow(t, NAMES.conversation);
      await page.waitFor('the card', `!!${CARD}`);
      await page.settle(100);
      const card = await page.evaluate<{ title: string; start: boolean; cards: number; code: number; sideways: boolean }>(`(() => {
        const c = ${CARD};
        const r = c.getBoundingClientRect();
        const b = ${VIEW}.querySelector('.session-view-body').getBoundingClientRect();
        return {
          title: c.querySelector('.approval-title').textContent,
          start: [...c.querySelectorAll('.approval-actions button')].map((x) => x.textContent.trim()).join('|') === 'Start…',
          cards: ${VIEW}.querySelectorAll('.spin-off-block').length,
          code: [...${VIEW}.querySelectorAll('pre')].filter((p) => p.textContent.includes('folder: ')).length,
          sideways: r.right > b.right + 1 || r.left < b.left - 1,
        };
      })()`);
      t.expect(card.title.includes(NAMES.conversation), 'its title names the session', card);
      t.expect(card.start, 'Start… is its only button', card);
      t.expect(card.cards === 1 && card.code === 0, 'one card, and the block is not also drawn as code', card);
      t.expect(!card.sideways, 'inside the view', card);
      await page.evaluate(`${CARD}.scrollIntoView({ block: 'center' })`);
      await t.shot('spin-off-card');
      server.clearRecords();
      await page.click('Start…', `[...${CARD}.querySelectorAll('.approval-actions button')].find((b) => b.textContent.trim() === 'Start…')`);
      await page.waitFor('the dialog', `${dialogName} === 'New session'`);
      t.expectEqual(server.records.spinOffChecks, [{ name: NAMES.conversation, key: SPIN_OFF.key, status: 200 }], 'the server checked it, by its key');
      t.expectEqual(await page.evaluate(`${PROMPT_FIELD}.value`), SPIN_OFF_PROMPT, 'New session has its whole prompt');
      t.expectEqual(server.records.spawns, [], 'nothing was started');
      await page.click('Cancel', dialogButton('Cancel'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expect(await page.evaluate(`!!${CARD}`), 'the card stays after Cancel');
    });

    await t.step('a started proposal says "Started as <name>", linked to its session, in place of Start (W209, W212)', async () => {
      const id = server.world.byName(NAMES.conversation).sessionId;
      const other = server.world.byName(NAMES.waiting);
      server.world.spinOff(id, { ...SPIN_OFF, settled: { how: 'started', at: new Date().toISOString(), sessionId: other.sessionId, name: NAMES.waiting } });
      server.broadcast();
      await page.waitFor('Started as', `${CARD}?.textContent.includes('Started as')`);
      const look = await page.evaluate<{ buttons: string[]; link: string | undefined }>(`({ buttons: [...${CARD}.querySelectorAll('.approval-actions button')].map((b) => b.textContent.trim()), link: ${CARD}.querySelector('[data-open-started]')?.textContent })`);
      t.expectEqual(look.link, NAMES.waiting, 'the started session is a link');
      t.expectEqual(look.buttons, [NAMES.waiting], 'and Start is gone');
      await page.evaluate(`${CARD}.scrollIntoView({ block: 'center' })`);
      await t.shot('spin-off-started');
      server.world.spinOff(id, undefined);
      server.broadcast();
    });

    await t.step('?session=<id>&spinoff=latest opens the Conversation tab at the card, then takes the parameter out (W209)', async () => {
      const id = server.world.byName(NAMES.conversation).sessionId;
      await t.fresh({ search: '?view=all' });
      server.world.blockMessages(id, blockMessages());
      await page.evaluate(`(location.search = ${q(`?view=all&session=${id}&spinoff=latest`)}, true)`);
      await page.waitFor('the view and its card', `!!${CARD}`);
      await page.settle(300);
      t.expectEqual(await page.evaluate(viewTab), 'Conversation', 'the Conversation tab');
      const at = await page.evaluate<{ top: number; bodyTop: number; bottom: boolean }>(`(() => {
        const b = ${VIEW}.querySelector('.session-view-body');
        return { top: ${CARD}.getBoundingClientRect().top, bodyTop: b.getBoundingClientRect().top, bottom: b.scrollHeight - b.clientHeight - b.scrollTop < 2 };
      })()`);
      t.expect(!at.bottom && at.top - at.bodyTop < 120 && at.top >= at.bodyTop - 2, 'scrolled to the card, not the newest entry', at);
      t.expect(await page.evaluate<boolean>(`(document.scrollingElement?.scrollTop ?? 0) === 0 && document.querySelector('header')?.getBoundingClientRect().top === 0`), 'the page itself is not scrolled: the header is at the top');
      t.expect(await page.evaluate(`!location.search.includes('spinoff')`), 'the parameter is gone from the address');
      t.expect(await page.evaluate(`location.search.includes(${q('')} + 'session=')`), 'the session stays in it');
      await t.shot('spin-off-link');
    });

    await t.step("a link to pitwall's own address in a message navigates in the same tab: no question, no new tab, the token kept, the card shown (W220)", async () => {
      const id = server.world.byName(NAMES.conversation).sessionId;
      await t.fresh({ search: '?view=all' });
      server.world.blockMessages(id, blockMessages(`${server.origin}/?view=all&session=${id}&spinoff=latest`));
      await openFromRow(t, NAMES.conversation);
      await page.waitFor('the message with the link', `!!${VIEW}.querySelector('a[href*="spinoff=latest"]')`);
      await page.settle(200);
      // A marker on the window: a reload, or a new document, would lose it.
      await page.evaluate(`(window.__ownLinkMarker = 'same page', window.__opened = 0, window.open = () => { window.__opened += 1; return null; }, true)`);
      const tokenBefore = await page.evaluate<string | null>(`sessionStorage.getItem('pitwall.token')`);
      await page.evaluate(`${VIEW}.querySelector('a[href*="spinoff=latest"]').click()`);
      await page.waitFor('the parameter taken out', `!location.search.includes('spinoff')`);
      await page.settle(300);
      t.expectEqual(await page.evaluate(`window.__ownLinkMarker`), 'same page', 'the page was not reloaded');
      t.expectEqual(await page.evaluate(`window.__opened`), 0, 'no new tab');
      t.expect(!(await page.evaluate<boolean>(`!!${VIEW}.querySelector('.inline-confirm')`)), 'no question');
      t.expectEqual(await page.evaluate<string | null>(`sessionStorage.getItem('pitwall.token')`), tokenBefore, 'the token is kept');
      t.expectEqual(await page.evaluate(viewTab), 'Conversation', 'the Conversation tab');
      t.expect(await page.evaluate<boolean>(`!!${CARD}`), 'the card is shown');
    });

    await t.step("the same link from another root tab shows a session's view kept hidden there at its card, with the parameter taken out (W220, Phil 2026-11-27)", async () => {
      const id = server.world.byName(NAMES.conversation).sessionId;
      await t.fresh({ search: `?view=all&root=${CODE}`, roots: 2 });
      server.world.blockMessages(id, blockMessages());
      server.world.blockMessages(server.world.byName(NAMES.blog).sessionId, blockMessages(`${server.origin}/?session=${id}&spinoff=latest`));
      // Its view is opened in ~/code's tab, then kept there, hidden, while ~/oss's tab is open (W38).
      await openFromRow(t, NAMES.conversation);
      await page.click('the ~/oss tab', `[...document.querySelectorAll('header .root-tab')].find((tab) => tab.querySelector('.root-tab-label').textContent === '~/oss')`);
      await page.waitFor('~/oss to open', `document.querySelector('header .root-tab[aria-selected="true"] .root-tab-label')?.textContent === '~/oss'`);
      await openFromRow(t, NAMES.blog);
      await page.waitFor('the message with the link', `!!${VIEW}.querySelector('a[href*="spinoff=latest"]')`);
      await page.settle(200);
      await page.evaluate(`${VIEW}.querySelector('a[href*="spinoff=latest"]').click()`);
      await page.waitFor('the parameter taken out', `!location.search.includes('spinoff')`);
      await page.settle(300);
      t.expectEqual(await page.evaluate(viewName), NAMES.conversation, "the linked session's view");
      t.expectEqual(await page.evaluate(viewTab), 'Conversation', 'the Conversation tab');
      t.expect(await page.evaluate<boolean>(`!!${CARD}`), 'the card is shown');
      t.expect(await page.evaluate<boolean>(`(document.scrollingElement?.scrollTop ?? 0) === 0 && document.querySelector('header')?.getBoundingClientRect().top === 0`), 'the page itself is not scrolled: the header is at the top');
      await t.shot('spin-off-link-other-root');
    });
  },
};

export default part;
