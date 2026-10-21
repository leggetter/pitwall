// Markdown in messages (W36, docs/design-system.md, 4: Markdown in messages): each element of the
// subset as pitwall's own element, everything else as text, links only to absolute http: and https:
// with the URL they open in their tooltip, images never loaded, Copy on a code block with its toast,
// and hostile input rendered in bounded time. All the text is made up.

import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClipboardContext, COPIED, COPY_FAILED, type ClipboardLike } from '../copy.js';
import { toastMessages, toastSaying } from '../test/toasts.js';
import { descriptionOf, hover, pass, tooltipText, unhover } from '../test/tooltips.js';
import { MAX_ELEMENTS } from '../markdown.js';
import { AS_WRITTEN, Markdown } from './Markdown.js';
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

  it('shows raw HTML, entities and unsupported syntax as the text they are', () => {
    const written = '<b>bold</b> <img src=x onerror="alert(1)"> <script>alert(2)</script> <a href="https://example.com">a</a> &amp; [ref][1] [^1] ~one~';
    const { root } = renderMarkdown(written);
    expect(root.querySelector('b, img, script, a, del')).toBeNull();
    expect(root.textContent).toBe(written);
    expect(root.innerHTML).toContain('&lt;script&gt;');
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

describe('Markdown: bounded on hostile input', () => {
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
