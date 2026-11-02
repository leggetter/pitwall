// Markdown in messages (W36, docs/design-system.md, 4: Markdown in messages): each element of the
// subset as pitwall's own element, everything else as text, links only to absolute http: and https:
// with the URL they open in their tooltip, images never loaded, Copy on a code block with its toast,
// and hostile input rendered in bounded time. All the text is made up.

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ClipboardContext, COPIED, COPY_FAILED, type ClipboardLike } from '../copy.js';
import { toastMessages, toastSaying } from '../test/toasts.js';
import { descriptionOf, hover, pass, shownTooltips, tooltipText, unhover } from '../test/tooltips.js';
import { MAX_ELEMENTS } from '../markdown.js';
import { AS_WRITTEN, LINK_CONSEQUENCE, linkQuestion, Markdown, OPEN_LINK } from './Markdown.js';
import { ToastProvider } from './Toast.js';

function renderMarkdown(text: string, clipboard: ClipboardLike = { writeText: vi.fn(async () => {}) }) {
  const result = render(
    <ClipboardContext.Provider value={clipboard}>
      <ToastProvider>
        <div className="entry-text entry-markdown">
          <Markdown text={text} />
        </div>
      </ToastProvider>
    </ClipboardContext.Provider>,
  );
  const root = result.container.querySelector<HTMLElement>('.entry-markdown')!;
  return { ...result, root };
}

const settle = () => act(async () => {});

/** Each element's tag and text, outermost first, for the root's direct children. */
const tags = (root: HTMLElement) => [...root.children].map((child) => child.tagName.toLowerCase());

describe('Markdown: blocks', () => {
  it('renders paragraphs with their line breaks as <br>s', () => {
    const { root } = renderMarkdown('one\ntwo\n\nthree');
    expect(tags(root)).toEqual(['p', 'p']);
    expect(root.querySelector('p')!.innerHTML).toBe('one<br>two');
  });

  it('renders headings as styled text from the type scale, not h1 to h6, so the page keeps its own outline', () => {
    const { root } = renderMarkdown('# One\n## Two\n### Three\n###### Six');
    expect(root.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')).toBeNull();
    expect([...root.querySelectorAll('p.md-heading')].map((p) => [p.className, p.textContent])).toEqual([
      ['md-heading md-h1', 'One'],
      ['md-heading md-h2', 'Two'],
      ['md-heading md-h3', 'Three'],
      ['md-heading md-h6', 'Six'],
    ]);
  });

  it('renders a fenced code block as mono text in its own scroll box, with its language and a Copy button', () => {
    const code = 'const a = 1; // <b>not bold</b>\n  **not bold**';
    const { root } = renderMarkdown(`\`\`\`ts\n${code}\n\`\`\``);
    const block = root.querySelector('.md-code')!;
    expect(block.querySelector('.md-code-language')!.textContent).toBe('ts');
    expect(block.querySelector('pre.md-code-scroll.scroll-box > code')!.textContent).toBe(code);
    expect(block.querySelector('b, strong')).toBeNull();
    expect(block.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
  });

  it('leaves the language out when the fence has none', () => {
    const { root } = renderMarkdown('```\nplain\n```');
    expect(root.querySelector('.md-code-language')).toBeNull();
    expect(root.querySelector('pre code')!.textContent).toBe('plain');
  });

  it('runs a code block that never closes to the end, as in a message cut short', () => {
    const { root } = renderMarkdown('Draft:\n\n```text\nHi all,\nthe export retries are');
    expect(root.querySelector('pre code')!.textContent).toBe('Hi all,\nthe export retries are');
  });

  it('renders nested bullet and ordered lists, with an ordered list\'s start, and task markers as text', () => {
    const { root } = renderMarkdown('3. three\n   - [ ] nested\n4. four');
    const ol = root.querySelector('ol.md-list')!;
    expect(ol.getAttribute('start')).toBe('3');
    expect(ol.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(ol.querySelector('li > ul.md-list > li')!.textContent).toBe('[ ] nested');
    expect(root.querySelector('input')).toBeNull();
    // A list from 1 has no start.
    expect(renderMarkdown('1. a').root.querySelector('ol')!.hasAttribute('start')).toBe(false);
  });

  it('renders quotes, nested, and thematic breaks', () => {
    const { root } = renderMarkdown('> one\n> > two\n\n---');
    expect(tags(root)).toEqual(['blockquote', 'hr']);
    expect(root.querySelector('blockquote.md-quote > blockquote.md-quote > p')!.textContent).toBe('two');
    expect(root.querySelector('hr')!.className).toBe('md-rule');
  });

  it('renders a GFM table with header cells as th and the column alignments, in its own scroll box', () => {
    const { root } = renderMarkdown('| a | b | c | d |\n|:--|:-:|--:|---|\n| **1** | 2 | 3 | 4 |');
    const table = root.querySelector('.md-table-scroll.scroll-box > table.md-table')!;
    const heads = [...table.querySelectorAll('thead th')];
    expect(heads.map((th) => [th.textContent, th.getAttribute('scope'), th.className])).toEqual([
      ['a', 'col', 'md-align-left'],
      ['b', 'col', 'md-align-center'],
      ['c', 'col', 'md-align-right'],
      ['d', 'col', ''],
    ]);
    const cells = [...table.querySelectorAll('tbody td')];
    expect(cells.map((td) => td.className)).toEqual(['md-align-left', 'md-align-center', 'md-align-right', '']);
    expect(cells[0]!.querySelector('strong')!.textContent).toBe('1');
    // No inline styles: the CSP's style-src stays 'self'.
    expect(root.querySelector('[style]')).toBeNull();
  });
});

describe('Markdown: inline', () => {
  it('renders bold, italic, both, strikethrough and code spans', () => {
    const { root } = renderMarkdown('**b** *i* ***both*** ~~gone~~ `` a `tick` ``');
    const p = root.querySelector('p')!;
    expect(p.innerHTML).toBe(
      '<strong>b</strong> <em>i</em> <em><strong>both</strong></em> <del>gone</del> <code class="md-code-span">a `tick`</code>',
    );
  });

  it('renders backslash escapes as the character', () => {
    expect(renderMarkdown('\\*not em\\*').root.querySelector('p')!.innerHTML).toBe('*not em*');
  });

  it('renders a link to a new tab, with no opener or referrer, and the URL as the browser parsed it in its tooltip on hover and focus', async () => {
    const { root } = renderMarkdown('[the docs](https://EXAMPLE.com/docs "Docs") and [a bank](https://exämple.com/login)');
    const [docs, bank] = [...root.querySelectorAll('a')];
    expect(docs!.getAttribute('href')).toBe('https://example.com/docs');
    expect(docs!.getAttribute('target')).toBe('_blank');
    expect(docs!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(docs!.className).toBe('md-link');
    expect(docs!.textContent).toBe('the docs');
    expect(docs!.hasAttribute('title')).toBe(false);
    // Its text can say anything, so the tooltip says where it goes: on hover, and as its description for focus.
    expect(await tooltipText(docs!)).toBe('https://example.com/docs');
    expect(descriptionOf(bank!)).toBe('https://xn--exmple-cua.com/login');
    act(() => bank!.focus());
    await pass(0);
    expect(document.querySelector('[role="tooltip"]:not([hidden]) .tooltip-text')?.textContent).toBe('https://xn--exmple-cua.com/login');
    act(() => bank!.blur());
  });

  it('renders <url> autolinks and bare URLs as links too', async () => {
    const { root } = renderMarkdown('<https://example.com/a> and https://example.com/b.');
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => [a.getAttribute('href'), a.textContent, a.getAttribute('rel')])).toEqual([
      ['https://example.com/a', 'https://example.com/a', 'noopener noreferrer'],
      ['https://example.com/b', 'https://example.com/b', 'noopener noreferrer'],
    ]);
    const tip = await hover(links[1]!);
    expect(tip?.textContent).toContain('https://example.com/b');
    unhover(links[1]!);
  });

  it('keeps javascript:, data:, relative and other links as the text they were written as', () => {
    const written = '[x](javascript:alert(1)) [y](data:text/html,<script>alert(1)</script>) [z](src/a.ts) [w](/abs) <javascript:alert(1)> <mailto:a@example.com>';
    const { root } = renderMarkdown(written);
    expect(root.querySelector('a, script')).toBeNull();
    expect(root.textContent).toBe(written);
  });

  it('never loads an image: it is its alt text, linked only under the link rule', () => {
    const { root } = renderMarkdown('![a chart](https://example.com/c.png) ![local](chart.png) ![](data:image/png;base64,AAAA)');
    expect(root.querySelector('img, picture, source, video, audio, iframe, object, embed')).toBeNull();
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([['https://example.com/c.png', 'a chart']]);
    expect(root.textContent).toBe('a chart local data:image/png;base64,AAAA');
  });

  it('shows raw HTML, entities and unsupported syntax as the text they are', async () => {
    const written = '<b>bold</b> <img src=x onerror="alert(1)"> <script>alert(2)</script> <a href="https://example.com">a</a> &amp; [ref][1] [^1] ~one~';
    const { root } = renderMarkdown(written);
    expect(root.querySelector('b, img, script, del')).toBeNull();
    expect(root.textContent).toBe(written);
    expect(root.innerHTML).toContain('&lt;script&gt;');
    // The raw <a> is text. Its URL is a bare one, which ends at the quote (W37), so the one link is
    // pitwall's own, to just the URL, and the HTML around it is still the text it was written as.
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => [a.getAttribute('href'), a.textContent, a.getAttribute('target'), a.getAttribute('rel'), a.className])).toEqual([
      ['https://example.com/', 'https://example.com', '_blank', 'noopener noreferrer', 'md-link'],
    ]);
    expect(await tooltipText(links[0]!)).toBe('https://example.com/');
    expect(descriptionOf(links[0]!)).toBe('https://example.com/');
  });
});

describe('Markdown: copying a code block', () => {
  it('copies the code exactly, inside the click, and says so with the copied icon and a Copied toast', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const writeText = vi.fn(async () => {});
      const code = '\tindented with a tab\n  <b>raw</b> **as written**\n';
      const { root } = renderMarkdown(`Run this:\n\n\`\`\`sh\n${code}\n\`\`\``, { writeText });
      const button = root.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!;
      fireEvent.click(button);
      // Before any await: in the click, as Safari requires.
      expect(writeText).toHaveBeenCalledWith(code);
      await settle();
      expect(button.dataset.copy).toBe('copied');
      expect(toastMessages()).toEqual([COPIED]);
      expect(toastSaying(COPIED).className).toBe('toast success');
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects the code when the clipboard refuses, with an error toast', async () => {
    const { root } = renderMarkdown('```\nnpm test\n```', { writeText: () => Promise.reject(new Error('made up: refused')) });
    fireEvent.click(root.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!);
    await settle();
    expect(toastMessages()).toEqual([COPY_FAILED]);
    expect(window.getSelection()?.toString()).toBe('npm test');
  });

  it('gives each code block its own button, copying its own code', async () => {
    const writeText = vi.fn(async () => {});
    const { root } = renderMarkdown('```\nfirst\n```\n\n```\nsecond\n```', { writeText });
    const buttons = root.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy code"]');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    expect(writeText).toHaveBeenCalledWith('second');
    await settle();
  });
});

describe('Markdown: scroll boxes', () => {
  it('makes a code block or a table a named Tab stop only while it scrolls sideways', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => 900);
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 300);
    try {
      const { root } = renderMarkdown('```ts\nconst a = 1;\n```\n\n| a |\n|---|\n| 1 |');
      await settle();
      const code = root.querySelector('pre.md-code-scroll')!;
      expect([code.getAttribute('role'), code.getAttribute('aria-label'), code.getAttribute('tabindex')]).toEqual(['region', 'Code, ts', '0']);
      const table = root.querySelector('.md-table-scroll')!;
      expect([table.getAttribute('role'), table.getAttribute('aria-label'), table.getAttribute('tabindex')]).toEqual(['region', 'Table', '0']);
    } finally {
      width.mockRestore();
      client.mockRestore();
    }
    const { root } = renderMarkdown('```\nfits\n```');
    await settle();
    expect(root.querySelector('pre.md-code-scroll')!.hasAttribute('tabindex')).toBe(false);
  });
});

describe('Markdown: too much formatting', () => {
  it('shows a message whose markdown would take more than MAX_ELEMENTS elements as the text it was written in, with a note', () => {
    const many = '*a* '.repeat(MAX_ELEMENTS + 1);
    const { root } = renderMarkdown(many);
    expect(root.querySelector('em')).toBeNull();
    expect(root.querySelector('p.md-as-written')!.textContent).toBe(many);
    expect(root.querySelector('p.md-as-written-note')!.textContent).toBe(AS_WRITTEN);
  });

  it('formats one just under the limit', () => {
    const { root } = renderMarkdown('*a* '.repeat(MAX_ELEMENTS - 10));
    expect(root.querySelectorAll('em')).toHaveLength(MAX_ELEMENTS - 10);
    expect(root.querySelector('.md-as-written')).toBeNull();
  });
});

// Retried: CI's shared runners flaked on these after M4 added test files.
// A slowdown to quadratic time fails every try; a busy moment passes on the next.
describe('Markdown: bounded on hostile input', { retry: 2 }, () => {
  /** The CPU time a render takes, best of three, as the server's hostile tests measure. */
  function bestOf3(fn: () => void): number {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.cpuUsage();
      fn();
      const used = process.cpuUsage(start);
      best = Math.min(best, (used.user + used.system) / 1000);
    }
    return best;
  }

  const N = 32 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  /**
   * The parse is bounded in markdown.test.tsx, within a frame. Rendering here is into happy-dom, whose
   * DOM is several times slower than a browser's, so this limit is looser. W36's headless app check
   * timed each of these in Chrome: at most about 30 ms of main thread, the same as 32 KiB of dense
   * everyday markdown, and most of it laying out the text.
   */
  const RENDER_MS = 500;

  it.each([
    ['deep quotes', '>'.repeat(N)],
    ['deep lists', fill('* 1. ')],
    ['thousands of emphasis', fill('*a* ')],
    ['thousands of code spans', fill('`a` ')],
    ['thousands of links', fill('[a](https://a.example) ')],
    ['thousands of table cells', `${'|a'.repeat(16)}|\n${'|-'.repeat(16)}|\n${fill(`${'|x'.repeat(16)}|\n`)}`.slice(0, N)],
    ['thousands of list items', fill('- a\n')],
    ['thousands of code blocks', fill('```\na\n```\n')],
    ['dense everyday markdown', fill('A **made-up** reply with `code`, a [link](https://example.com/a) and *emphasis*.\n\n- one item\n- two items\n\n')],
  ])('renders 32 KiB of %s', (_name, hostile) => {
    const took = bestOf3(() => {
      const { unmount } = renderMarkdown(hostile);
      unmount();
    });
    expect(took).toBeLessThan(RENDER_MS);
  });
});

describe('Markdown: links in code (W37)', () => {
  /** Claude's draft for a channel, in a code block, with its pull requests' URLs. Made up. */
  const DRAFT = [
    'Export retries are ready for review:',
    '\t- the loop: https://github.com/example/app/pull/41',
    '  - its tests (https://github.com/example/app/pull/42)',
    '',
    '  - the docs, last: https://github.com/example/app/pull/43.',
    'Not links: javascript:alert(1) [notes](https://example.com/notes) <https://example.com/log>',
  ].join('\n');
  const PULLS = ['https://github.com/example/app/pull/41', 'https://github.com/example/app/pull/42', 'https://github.com/example/app/pull/43'];

  it('renders bare URLs in a code block as links, a new tab with no opener or referrer, the URL in their tooltip', async () => {
    const { root } = renderMarkdown(`\`\`\`text\n${DRAFT}\n\`\`\``);
    const links = [...root.querySelectorAll<HTMLAnchorElement>('pre.md-code-scroll > code > a')];
    expect(links.map((a) => [a.getAttribute('href'), a.textContent, a.getAttribute('target'), a.getAttribute('rel'), a.className])).toEqual(
      PULLS.map((href) => [href, href, '_blank', 'noopener noreferrer', 'md-link']),
    );
    expect(links.some((a) => a.hasAttribute('title'))).toBe(false);
    expect(await tooltipText(links[1]!)).toBe(PULLS[1]);
    expect(descriptionOf(links[2]!)).toBe(PULLS[2]);
    act(() => links[0]!.focus());
    await pass(0);
    expect(document.querySelector('[role="tooltip"]:not([hidden]) .tooltip-text')?.textContent).toBe(PULLS[0]);
    act(() => links[0]!.blur());
  });

  it('renders a bare URL in inline code as a link inside the code span', () => {
    const { root } = renderMarkdown('The run is `https://example.com/ci/runs/1234`, and `npm test` runs it here.');
    const p = root.querySelector('p')!;
    expect([...p.querySelectorAll('code.md-code-span')].map((code) => code.innerHTML)).toEqual([
      expect.stringMatching(/^<a class="md-link" href="https:\/\/example\.com\/ci\/runs\/1234" target="_blank" rel="noopener noreferrer" aria-describedby="[^"]+">https:\/\/example\.com\/ci\/runs\/1234<\/a>$/),
      'npm test',
    ]);
    expect(p.textContent).toBe('The run is https://example.com/ci/runs/1234, and npm test runs it here.');
  });

  it('keeps javascript:, data:, file:, relative URLs and markdown link syntax in code as text', () => {
    const written = 'javascript:alert(1) data:text/html,<script>alert(1)</script> file:///etc/hosts ./src/a.ts /abs [x](https://example.com/x) <https://example.com/y> ![i](https://example.com/i.png)';
    const { root } = renderMarkdown(`\`${written}\`\n\n\`\`\`\n${written}\n\`\`\``);
    expect(root.querySelector('a, script, img')).toBeNull();
    expect(root.querySelector('code.md-code-span')!.textContent).toBe(written);
    expect(root.querySelector('pre code')!.textContent).toBe(written);
  });

  it('keeps the code as written: its whitespace, line breaks and language, and a fence that never closes', () => {
    const { root } = renderMarkdown(`\`\`\`text\n${DRAFT}\n\`\`\``);
    const code = root.querySelector('pre.md-code-scroll > code')!;
    expect(code.textContent).toBe(DRAFT);
    expect(root.querySelector('.md-code-language')!.textContent).toBe('text');
    // Only text and the links: nothing else in the code, and no tooltip text in it.
    expect([...code.querySelectorAll('*')].map((el) => el.tagName.toLowerCase())).toEqual(['a', 'a', 'a']);
    expect(root.querySelector('pre [role="tooltip"], pre .tooltip')).toBeNull();
    const cut = renderMarkdown('Draft:\n\n```text\nReview https://example.com/pull/1\nand the').root;
    expect(cut.querySelector('pre code')!.textContent).toBe('Review https://example.com/pull/1\nand the');
    expect(cut.querySelector('pre code a')!.getAttribute('href')).toBe('https://example.com/pull/1');
  });

  it('gives the code exactly as written when its text is selected and copied by hand, with no tooltip in it', async () => {
    const { root } = renderMarkdown(`\`\`\`\n${DRAFT}\n\`\`\``);
    const pre = root.querySelector('pre')!;
    // A tooltip shown on a link is in document.body, outside the code, so a selection can't take it in.
    await hover(pre.querySelector('a')!);
    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe(DRAFT);
    unhover(pre.querySelector('a')!);
    selection.removeAllRanges();
  });

  it('copies the code exactly as written with Copy code, inside the click, with the copied icon and a Copied toast', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const writeText = vi.fn(async () => {});
      const { root } = renderMarkdown(`\`\`\`text\n${DRAFT}\n\`\`\``, { writeText });
      const button = root.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!;
      fireEvent.click(button);
      expect(writeText).toHaveBeenCalledWith(DRAFT);
      await settle();
      expect(button.dataset.copy).toBe('copied');
      expect(toastMessages()).toEqual([COPIED]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects the code, links and all, when the clipboard refuses', async () => {
    const { root } = renderMarkdown(`\`\`\`\n${DRAFT}\n\`\`\``, { writeText: () => Promise.reject(new Error('made up: refused')) });
    fireEvent.click(root.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!);
    await settle();
    expect(toastMessages()).toEqual([COPY_FAILED]);
    expect(window.getSelection()?.toString()).toBe(DRAFT);
  });

  it("puts each link in the Tab order after the code block's Copy button and its scroll box, in the code's order", async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => 900);
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 300);
    try {
      const { root } = renderMarkdown(`\`\`\`text\n${DRAFT}\n\`\`\`\n\nThen \`https://example.com/after\`.`);
      await settle();
      const stops = [...root.querySelectorAll<HTMLElement>('a[href], button, [tabindex]')].filter((el) => el.tabIndex >= 0);
      expect(stops.map((el) => el.getAttribute('aria-label') ?? el.getAttribute('href'))).toEqual(['Copy code', 'Code, text', ...PULLS, 'https://example.com/after']);
    } finally {
      width.mockRestore();
      client.mockRestore();
    }
    // While the code fits, the box isn't a stop: the links follow Copy.
    const { root } = renderMarkdown('```\ngh pr view https://github.com/example/app/pull/41\n```');
    await settle();
    const stops = [...root.querySelectorAll<HTMLElement>('a[href], button, [tabindex]')].filter((el) => el.tabIndex >= 0);
    expect(stops.map((el) => el.getAttribute('aria-label') ?? el.getAttribute('href'))).toEqual(['Copy code', PULLS[0]]);
  });

  it('never puts a link inside a link: a code span in a link\'s text stays plain code', () => {
    const { root } = renderMarkdown('[`https://example.com/a`](https://example.com/b) and [**`https://example.com/c`**](https://example.com/d)');
    expect(root.querySelector('a a')).toBeNull();
    expect([...root.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.querySelector('code.md-code-span')?.textContent])).toEqual([
      ['https://example.com/b', 'https://example.com/a'],
      ['https://example.com/d', 'https://example.com/c'],
    ]);
  });

  it('counts the links in code towards MAX_ELEMENTS: a code block with one too many shows as written', () => {
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `https://a.example/${i}`).join('\n');
    const under = Math.floor((MAX_ELEMENTS - 10) / 4);
    const fits = renderMarkdown(`\`\`\`\n${lines(under)}\n\`\`\``).root;
    expect(fits.querySelectorAll('pre a')).toHaveLength(under);
    expect(fits.querySelector('.md-as-written')).toBeNull();
    const over = `\`\`\`\n${lines(under + 1)}\n\`\`\``;
    const shown = renderMarkdown(over).root;
    expect(shown.querySelector('a, pre')).toBeNull();
    expect(shown.querySelector('p.md-as-written')!.textContent).toBe(over);
    expect(shown.querySelector('p.md-as-written-note')!.textContent).toBe(AS_WRITTEN);
  });
});

// Retried: CI's shared runners flaked on these after M4 added test files.
// A slowdown to quadratic time fails every try; a busy moment passes on the next.
describe('Markdown: links in code, bounded on hostile input (W37)', { retry: 2 }, () => {
  function bestOf3(fn: () => void): number {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.cpuUsage();
      fn();
      const used = process.cpuUsage(start);
      best = Math.min(best, (used.user + used.system) / 1000);
    }
    return best;
  }
  const N = 32 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const fence = (body: string) => `\`\`\`\n${body.slice(0, N - 8)}\n\`\`\``;
  /** As W36's render limit: happy-dom is several times slower than a browser; headless Chrome's times are in the app check. */
  const RENDER_MS = 500;
  const renderTime = (text: string) =>
    bestOf3(() => {
      const { unmount } = renderMarkdown(text);
      unmount();
    });

  it.each([
    ['a code block packed with URLs, shown as written', fence(fill('https://a.example/x '))],
    ['thousands of code spans holding URLs, shown as written', fill('`https://a.example/x` ')],
  ])('renders 32 KiB of %s', (_name, hostile) => {
    expect(renderTime(hostile)).toBeLessThan(RENDER_MS);
  });

  it('renders the most links in code a message can show about as fast as 32 KiB of dense everyday markdown', () => {
    // 1,247 links, 4,998 elements, each link a tooltip of its own. happy-dom builds a portal for each
    // one slowly, so this is measured against W36's dense everyday markdown here, on the same machine,
    // rather than against RENDER_MS. Headless Chrome drew both in about 20 to 36 ms (W37's app check).
    const links = fence(Array.from({ length: 1247 }, (_, i) => `https://a.example/${String(i).padStart(4, '0')}`).join('\n'));
    const everyday = fill('A **made-up** reply with `code`, a [link](https://example.com/a) and *emphasis*.\n\n- one item\n- two items\n\n');
    expect(renderMarkdown(links).root.querySelectorAll('pre a')).toHaveLength(1247);
    expect(renderTime(links)).toBeLessThan(2 * renderTime(everyday));
  });
});

describe("Markdown: links that ask first (W55, W48's F6)", () => {
  /** A link whose text names one site while it goes to another: the security review's example. */
  const MISLEADING = '[https://github.com/example/repo/pull/51](https://evil.example/pull/51)';
  const SHOWN = 'https://github.com/example/repo/pull/51';
  const REAL = 'https://evil.example/pull/51';

  let open: MockInstance<typeof window.open>;
  beforeEach(() => {
    open = vi.spyOn(window, 'open').mockImplementation(() => null);
  });
  afterEach(() => {
    open.mockRestore();
  });

  /**
   * Clicks `link` as a mouse does, or as Enter on a focused link does (a click with `detail: 0`), and
   * says whether pitwall stopped the browser from following it. The browser's own default is stopped
   * afterwards either way, so happy-dom never navigates.
   */
  function follow(link: Element, init: MouseEventInit = {}, type: 'click' | 'auxclick' = 'click'): boolean {
    let prevented = false;
    const after = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener(type, after);
    try {
      act(() => {
        link.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1, ...init }));
      });
    } finally {
      document.removeEventListener(type, after);
    }
    return prevented;
  }

  const linkSaying = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLAnchorElement>('a')].find((a) => a.textContent === text)!;
  const questions = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.inline-confirm')];
  const buttonSaying = (root: HTMLElement, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === label)!;

  it('opens a bare URL, an autolink and a link whose text is its own address on one click, as before, in text and code', () => {
    const { root } = renderMarkdown('https://example.com/bare <https://example.com/auto> [example.com/own](https://example.com/own/) `https://example.com/span`\n\n```\nhttps://example.com/block\n```');
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/bare', 'https://example.com/auto', 'https://example.com/own/', 'https://example.com/span', 'https://example.com/block']);
    for (const a of links) {
      expect(follow(a), a.getAttribute('href')!).toBe(false);
      expect(follow(a, { button: 1 }, 'auxclick'), a.getAttribute('href')!).toBe(false);
    }
    expect(questions(root)).toEqual([]);
    // The browser follows the link itself, as it always has: target _blank, rel noopener noreferrer.
    expect(open).not.toHaveBeenCalled();
  });

  it('asks before opening a link whose text is another address: the real host, then the full address, after the paragraph, with Cancel focused', () => {
    const { root } = renderMarkdown(`Review ${MISLEADING} today.`);
    const link = linkSaying(root, SHOWN);
    expect(follow(link)).toBe(true);
    const [box] = questions(root);
    expect(box!.previousElementSibling).toBe(root.querySelector('p.md-p'));
    expect(box!.querySelector('.inline-confirm-question')!.textContent).toBe('Open this link to evil.example?');
    expect(box!.querySelector('.inline-confirm-consequence')!.textContent).toBe(`${LINK_CONSEQUENCE}${REAL}`);
    expect(box!.querySelector('.inline-confirm-consequence code.link-confirm-address')!.textContent).toBe(REAL);
    expect([...box!.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(['Cancel', OPEN_LINK]);
    expect(document.activeElement).toBe(buttonSaying(box!, 'Cancel'));
    expect(open).not.toHaveBeenCalled();
  });

  it("asks for a look-alike host's own address, in punycode, after the block it is in: a bare URL, an autolink, [same](same), inline code and a code block (W58)", () => {
    // github.com with a Cyrillic і (U+0456): its text shows the look-alike, its host is punycode.
    const lookAlike = 'https://gіthub.com/example/repo/pull/51';
    const punycode = 'https://xn--gthub-n2e.com/example/repo/pull/51';
    const { root } = renderMarkdown(
      [`A bare ${lookAlike} here.`, `An autolink <${lookAlike}> here.`, `[${lookAlike}](${lookAlike})`, `Run \`gh pr view ${lookAlike}\`.`, `\`\`\`sh\n${lookAlike}\n\`\`\``, 'After the code.'].join('\n\n'),
    );
    const links = [...root.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual(Array.from({ length: 5 }, () => [lookAlike, punycode]));
    const blocks = [...root.querySelectorAll<HTMLElement>(':scope > p.md-p')].slice(0, 4).concat(root.querySelector<HTMLElement>(':scope > .md-code')!);
    links.forEach((link, index) => {
      expect(follow(link), String(index)).toBe(true);
      const [box] = questions(root);
      expect(box!.querySelector('.inline-confirm-question')!.textContent, String(index)).toBe('Open this link to xn--gthub-n2e.com?');
      expect(box!.querySelector('code.link-confirm-address')!.textContent, String(index)).toBe(punycode);
      // Straight after its own block: a code block's comes after its box, not after the message.
      expect(box!.previousElementSibling, String(index)).toBe(blocks[index]);
      expect(document.activeElement).toBe(buttonSaying(box!, 'Cancel'));
      act(() => buttonSaying(root, 'Cancel').click());
      expect(document.activeElement).toBe(link);
    });
    expect(questions(root)).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it('asks for a link whose text is words, naming its host', () => {
    const { root } = renderMarkdown('The fix is in [the pull request](https://github.com/example/app/pull/51).');
    expect(follow(linkSaying(root, 'the pull request'))).toBe(true);
    expect(questions(root).map((box) => box.textContent)).toEqual([`Open this link to github.com?${LINK_CONSEQUENCE}https://github.com/example/app/pull/51CancelOpen link`]);
  });

  it('opens nothing on Cancel, and puts focus back on the link, without opening its tooltip', () => {
    const { root } = renderMarkdown(MISLEADING);
    const link = linkSaying(root, SHOWN);
    follow(link);
    act(() => buttonSaying(root, 'Cancel').click());
    expect(questions(root)).toEqual([]);
    expect(document.activeElement).toBe(link);
    expect(shownTooltips()).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens nothing on Escape, which goes no further, and puts focus back on the link', () => {
    const { root } = renderMarkdown(MISLEADING);
    const link = linkSaying(root, SHOWN);
    follow(link);
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    try {
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', outside);
    }
    expect(outside).not.toHaveBeenCalled();
    expect(questions(root)).toEqual([]);
    expect(document.activeElement).toBe(link);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the link on Open link, once, in a new tab with no opener or referrer, and puts focus back on the link', () => {
    const { root } = renderMarkdown(MISLEADING);
    const link = linkSaying(root, SHOWN);
    follow(link);
    act(() => buttonSaying(root, OPEN_LINK).click());
    expect(open.mock.calls).toEqual([[REAL, '_blank', 'noopener,noreferrer']]);
    expect(questions(root)).toEqual([]);
    expect(document.activeElement).toBe(link);
  });

  it('asks on a middle click, and on a click with a modifier, as on any click', () => {
    const { root } = renderMarkdown(MISLEADING);
    const link = linkSaying(root, SHOWN);
    for (const init of [{ button: 1 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
      expect(follow(link, init, init.button === 1 ? 'auxclick' : 'click'), JSON.stringify(init)).toBe(true);
      expect(questions(root), JSON.stringify(init)).toHaveLength(1);
      act(() => buttonSaying(root, 'Cancel').click());
    }
    // A right click is the browser's own menu, which names the real address too.
    expect(follow(link, { button: 2 }, 'auxclick')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('names an internationalised host in punycode, as its tooltip shows it', () => {
    const { root } = renderMarkdown('Sign in at [the bank](https://exämple.com/login).');
    const link = linkSaying(root, 'the bank');
    expect(descriptionOf(link)).toBe('https://xn--exmple-cua.com/login');
    follow(link);
    expect(questions(root)[0]!.querySelector('.inline-confirm-question')!.textContent).toBe('Open this link to xn--exmple-cua.com?');
    expect(questions(root)[0]!.querySelector('code')!.textContent).toBe('https://xn--exmple-cua.com/login');
    expect(linkQuestion(new URL('https://еxample.com/'))).toBe('Open this link to xn--xample-2of.com?');
  });

  it("keeps the link's own name, description, href, target and rel, before and while it asks", () => {
    const { root } = renderMarkdown(MISLEADING);
    const link = linkSaying(root, SHOWN);
    const before = link.outerHTML;
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel'), descriptionOf(link)]).toEqual([REAL, '_blank', 'noopener noreferrer', REAL]);
    expect(['aria-label', 'aria-haspopup', 'aria-expanded', 'role', 'title'].filter((name) => link.hasAttribute(name))).toEqual([]);
    follow(link);
    expect(link.outerHTML).toBe(before);
  });

  it('is announced as an alert dialog, named by its question and described by the address, as Cancel takes focus', () => {
    const { root } = renderMarkdown(MISLEADING);
    follow(linkSaying(root, SHOWN));
    const [box] = questions(root);
    expect(box!.getAttribute('role')).toBe('alertdialog');
    expect(document.getElementById(box!.getAttribute('aria-labelledby')!)!.textContent).toBe('Open this link to evil.example?');
    expect(document.getElementById(box!.getAttribute('aria-describedby')!)!.textContent).toBe(`${LINK_CONSEQUENCE}${REAL}`);
    expect(box!.contains(document.activeElement)).toBe(true);
  });

  it('works without a mouse: Enter asks, Escape cancels, and Enter on Open link opens, each in Tab order after the link', () => {
    const { root } = renderMarkdown(`${MISLEADING} and [the docs](https://example.com/docs)\n\nAfter.`);
    const link = linkSaying(root, SHOWN);
    act(() => link.focus());
    // Enter on a focused link is a click with no pointer: detail 0.
    expect(follow(link, { detail: 0 })).toBe(true);
    expect(document.activeElement).toBe(buttonSaying(root, 'Cancel'));
    // Tab order is document order: the paragraph's links, then the question's buttons, then what follows.
    const stops = [...root.querySelectorAll<HTMLElement>('a[href], button')].map((el) => el.textContent?.trim());
    expect(stops).toEqual([SHOWN, 'the docs', 'Cancel', OPEN_LINK]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(link);
    expect(follow(link, { detail: 0 })).toBe(true);
    act(() => buttonSaying(root, OPEN_LINK).focus());
    // Enter on a focused button is a click too.
    act(() => buttonSaying(root, OPEN_LINK).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })));
    expect(open.mock.calls).toEqual([[REAL, '_blank', 'noopener,noreferrer']]);
    expect(document.activeElement).toBe(link);
  });

  it('shows the question straight after the block its link is in: a heading, a list item, a quote, a table and formatted text', () => {
    const { root } = renderMarkdown(
      [
        '# A [heading link](https://example.com/h)',
        '',
        '- an [item link](https://example.com/i)',
        '- another item',
        '',
        '> a [quoted link](https://example.com/q)',
        '',
        '| a |',
        '|---|',
        '| a [cell link](https://example.com/c) |',
        '',
        'Some ~~**[struck link](https://example.com/s)**~~ text.',
      ].join('\n'),
    );
    const after: [string, (box: HTMLElement) => Element | null][] = [
      ['heading link', () => root.querySelector('p.md-heading')],
      ['item link', () => root.querySelector('ul.md-list > li > p')],
      ['quoted link', () => root.querySelector('blockquote.md-quote > p')],
      ['cell link', () => root.querySelector('.md-table-scroll')],
      ['struck link', () => root.querySelector(':scope > p.md-p')],
    ];
    for (const [text, block] of after) {
      follow(linkSaying(root, text));
      const [box] = questions(root);
      expect(box!.previousElementSibling, text).toBe(block(box!));
      expect(box!.closest('del, strong, em, table, a'), text).toBeNull();
      act(() => buttonSaying(root, 'Cancel').click());
    }
    expect(questions(root)).toEqual([]);
  });

  it('asks one question at a time in a block: a second link replaces the first, with Cancel focused again', () => {
    const { root } = renderMarkdown('[one](https://one.example.com/) or [two](https://two.example.com/)');
    follow(linkSaying(root, 'one'));
    const first = buttonSaying(root, 'Cancel');
    follow(linkSaying(root, 'two'));
    expect(questions(root).map((box) => box.querySelector('.inline-confirm-question')!.textContent)).toEqual(['Open this link to two.example.com?']);
    expect(document.activeElement).toBe(buttonSaying(root, 'Cancel'));
    expect(first.isConnected).toBe(false);
    act(() => buttonSaying(root, 'Cancel').click());
    expect(document.activeElement).toBe(linkSaying(root, 'two'));
  });

  it('renders a URL with a username or password before its host as text, in a link, an autolink, a bare URL and code', () => {
    const userinfo = 'https://github.com@evil.example/x';
    const written = `[the pull request](${userinfo}) <${userinfo}> ${userinfo} \`${userinfo}\``;
    const { root } = renderMarkdown(`${written}\n\n\`\`\`\ngh pr view ${userinfo}\n\`\`\``);
    expect(root.querySelector('a')).toBeNull();
    expect(root.querySelector('p')!.textContent).toBe(written.replace(/`/g, ''));
    expect(root.querySelector('pre code')!.textContent).toBe(`gh pr view ${userinfo}`);
  });
});
