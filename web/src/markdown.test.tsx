// The markdown parser (W36, docs/design-system.md, 4: Markdown in messages): the subset it reads,
// everything else as the literal text it is, only absolute http: and https: links, and bounded time on
// hostile input. All the text is made up.

import { describe, expect, it } from 'vitest';
import {
  asksFirst,
  elementCount,
  httpUrl,
  isOwnAddress,
  linkify,
  linkText,
  MAX_BLOCK_DEPTH,
  MAX_ELEMENTS,
  MAX_INLINE_DEPTH,
  MAX_TABLE_COLUMNS,
  parseInline,
  parseMarkdown,
  type Block,
  type Inline,
} from './markdown.js';

const text = (value: string): Inline => ({ type: 'text', text: value });
const para = (...children: Inline[]): Block => ({ type: 'paragraph', children });
const link = (href: string, ...children: Inline[]): Inline => ({ type: 'link', href, children });

/** The text an inline tree shows, with line breaks as newlines. */
function shown(inlines: Inline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.type) {
        case 'text':
        case 'code':
          return inline.text;
        case 'break':
          return '\n';
        default:
          return shown(inline.children);
      }
    })
    .join('');
}

/** Every link anywhere in the blocks. */
function linksIn(blocks: Block[]): Inline[] {
  const found: Inline[] = [];
  const walk = (inlines: Inline[]) => {
    for (const inline of inlines) {
      if (inline.type === 'link') found.push(inline);
      if ('children' in inline) walk(inline.children);
    }
  };
  const blockWalk = (list: Block[]) => {
    for (const block of list) {
      if (block.type === 'paragraph' || block.type === 'heading') walk(block.children);
      else if (block.type === 'quote') blockWalk(block.children);
      else if (block.type === 'list') block.items.forEach(blockWalk);
      else if (block.type === 'table') [...block.head, ...block.rows.flat()].forEach(walk);
    }
  };
  blockWalk(blocks);
  return found;
}

describe('paragraphs and line breaks', () => {
  it('keeps single newlines as line breaks, as the terminal shows them, and splits paragraphs on blank lines', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([para(text('one'), { type: 'break' }, text('two')), para(text('three'))]);
  });

  it('drops the spaces around a break, and a backslash before one', () => {
    expect(parseMarkdown('one  \n   two\\\nthree')).toEqual([para(text('one'), { type: 'break' }, text('two'), { type: 'break' }, text('three'))]);
  });

  it('gives nothing for empty or blank text', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown(' \n\t\n')).toEqual([]);
  });

  it('reads Windows line endings as newlines', () => {
    expect(parseMarkdown('a\r\nb\r\n\r\nc')).toEqual([para(text('a'), { type: 'break' }, text('b')), para(text('c'))]);
  });
});

describe('headings', () => {
  it('reads ATX headings 1 to 6, without their closing hashes', () => {
    expect(parseMarkdown('# One\n## Two ##\n### Three\n#### Four\n##### Five\n###### Six #')).toEqual(
      [1, 2, 3, 4, 5, 6].map((level, i) => ({ type: 'heading', level, children: [text(['One', 'Two', 'Three', 'Four', 'Five', 'Six'][i] as string)] })),
    );
  });

  it('keeps a # that is part of the text, and reads inline markdown inside', () => {
    expect(parseMarkdown('## Notes on C#')).toEqual([{ type: 'heading', level: 2, children: [text('Notes on C#')] }]);
    expect(parseMarkdown('# A **bold** `step`')).toEqual([
      { type: 'heading', level: 1, children: [text('A '), { type: 'strong', children: [text('bold')] }, text(' '), { type: 'code', text: 'step' }] },
    ]);
  });

  it('leaves #hashtags, seven hashes and setext underlines as text', () => {
    expect(parseMarkdown('#hashtag')).toEqual([para(text('#hashtag'))]);
    expect(parseMarkdown('####### seven')).toEqual([para(text('####### seven'))]);
    expect(parseMarkdown('Title\n===')).toEqual([para(text('Title'), { type: 'break' }, text('==='))]);
  });
});

describe('fenced code', () => {
  it('keeps the code exactly as written, markdown and HTML included, with the info string as its language', () => {
    const code = 'const a = **1**; // <b>not bold</b>\n\n  indented\n# not a heading';
    expect(parseMarkdown(`\`\`\`ts title="x.ts"\n${code}\n\`\`\``)).toEqual([{ type: 'code', language: 'ts', text: code, closed: true }]);
  });

  it('reads ~~~ fences, and a fence closes only with the same character, at least as long', () => {
    expect(parseMarkdown('~~~\n```\nstill code\n~~~~')).toEqual([{ type: 'code', language: '', text: '```\nstill code', closed: true }]);
    expect(parseMarkdown('````\n```\n````')).toEqual([{ type: 'code', language: '', text: '```', closed: true }]);
  });

  it('runs a fence that never closes to the end, as in a message cut short', () => {
    expect(parseMarkdown('Draft:\n\n```text\nHi all,\nthe export')).toEqual([para(text('Draft:')), { type: 'code', language: 'text', text: 'Hi all,\nthe export', closed: false }]);
  });

  it('takes the fence\'s indent off its lines, and interrupts a paragraph', () => {
    expect(parseMarkdown('Run:\n  ```sh\n  npm test\n    -- export\n  ```')).toEqual([
      para(text('Run:')),
      { type: 'code', language: 'sh', text: 'npm test\n  -- export', closed: true },
    ]);
  });

  it('is a code span, not a fence, when the info string holds a backtick', () => {
    expect(parseMarkdown('```a```')).toEqual([para({ type: 'code', text: 'a' })]);
  });
});

describe('lists', () => {
  it('reads bullet lists with -, * and +, each its own list', () => {
    expect(parseMarkdown('- a\n- b\n* c\n+ d')).toEqual([
      { type: 'list', ordered: false, start: 1, items: [[para(text('a'))], [para(text('b'))]] },
      { type: 'list', ordered: false, start: 1, items: [[para(text('c'))]] },
      { type: 'list', ordered: false, start: 1, items: [[para(text('d'))]] },
    ]);
  });

  it('reads ordered lists with their start, and nests lists by indent', () => {
    expect(parseMarkdown('3. three\n4. four\n   - nested\n     1) deeper\n5. five')).toEqual([
      {
        type: 'list',
        ordered: true,
        start: 3,
        items: [
          [para(text('three'))],
          [
            para(text('four')),
            {
              type: 'list',
              ordered: false,
              start: 1,
              items: [[para(text('nested')), { type: 'list', ordered: true, start: 1, items: [[para(text('deeper'))]] }]],
            },
          ],
          [para(text('five'))],
        ],
      },
    ]);
  });

  it('keeps task-list markers as text', () => {
    expect(parseMarkdown('- [ ] todo\n- [x] done')).toEqual([{ type: 'list', ordered: false, start: 1, items: [[para(text('[ ] todo'))], [para(text('[x] done'))]] }]);
  });

  it('continues an item with a lazy line, and holds code and more paragraphs inside an item', () => {
    expect(parseMarkdown('- one\ncontinued\n\n  more\n\n  ```\n  code\n  ```\n- two')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [[para(text('one'), { type: 'break' }, text('continued')), para(text('more')), { type: 'code', language: '', text: 'code', closed: true }], [para(text('two'))]],
      },
    ]);
  });

  it('ends at a line that is not in it, and a paragraph line starting with a number is still the paragraph', () => {
    expect(parseMarkdown('- a\n\nafter')).toEqual([{ type: 'list', ordered: false, start: 1, items: [[para(text('a'))]] }, para(text('after'))]);
    expect(parseMarkdown('The year was\n1986. A good year.')).toEqual([para(text('The year was'), { type: 'break' }, text('1986. A good year.'))]);
  });

  it('reads "- - -" and "* * *" as rules, not lists', () => {
    expect(parseMarkdown('- - -\n* * *\n___\n---')).toEqual([{ type: 'rule' }, { type: 'rule' }, { type: 'rule' }, { type: 'rule' }]);
  });
});

describe('quotes and rules', () => {
  it('reads quotes, nested, with blocks inside', () => {
    expect(parseMarkdown('> one\n> > two\n>\n> - item')).toEqual([
      {
        type: 'quote',
        children: [para(text('one')), { type: 'quote', children: [para(text('two'))] }, { type: 'list', ordered: false, start: 1, items: [[para(text('item'))]] }],
      },
    ]);
  });

  it('puts a rule between paragraphs', () => {
    expect(parseMarkdown('above\n\n---\n\nbelow')).toEqual([para(text('above')), { type: 'rule' }, para(text('below'))]);
  });
});

describe('tables', () => {
  it('reads a GFM table, with its alignments, inline markdown in cells, and escaped pipes', () => {
    expect(parseMarkdown('| a | b | c | d |\n|:--|:-:|--:|---|\n| **1** | `x\\|y` | 3 | 4 |')).toEqual([
      {
        type: 'table',
        align: ['left', 'center', 'right', undefined],
        head: [[text('a')], [text('b')], [text('c')], [text('d')]],
        rows: [[[{ type: 'strong', children: [text('1')] }], [{ type: 'code', text: 'x|y' }], [text('3')], [text('4')]]],
      },
    ]);
  });

  it('pads short rows, drops extra cells, and ends at a blank line', () => {
    expect(parseMarkdown('a | b\n--- | ---\n1\n1 | 2 | 3\n\nafter')).toEqual([
      { type: 'table', align: [undefined, undefined], head: [[text('a')], [text('b')]], rows: [[[text('1')], []], [[text('1')], [text('2')]]] },
      para(text('after')),
    ]);
  });

  it('interrupts a paragraph, as in GFM', () => {
    expect(parseMarkdown('Results:\n| a |\n|---|\n| 1 |')).toEqual([para(text('Results:')), { type: 'table', align: [undefined], head: [[text('a')]], rows: [[[text('1')]]] }]);
  });

  it('is text when the delimiter row does not match the header, or has more columns than the limit', () => {
    expect(parseMarkdown('| a | b |\n|---|')[0]?.type).toBe('paragraph');
    expect(parseMarkdown('| a |\n| x |')[0]?.type).toBe('paragraph');
    const wide = MAX_TABLE_COLUMNS + 1;
    expect(parseMarkdown(`${'| a '.repeat(wide)}|\n${'|---'.repeat(wide)}|`)[0]?.type).toBe('paragraph');
    expect(parseMarkdown(`${'| a '.repeat(MAX_TABLE_COLUMNS)}|\n${'|---'.repeat(MAX_TABLE_COLUMNS)}|`)[0]?.type).toBe('table');
  });
});

describe('inline', () => {
  it('reads bold, italic, both and strikethrough', () => {
    expect(parseInline('**b** __b__ *i* _i_ ***both*** ~~gone~~')).toEqual([
      { type: 'strong', children: [text('b')] },
      text(' '),
      { type: 'strong', children: [text('b')] },
      text(' '),
      { type: 'em', children: [text('i')] },
      text(' '),
      { type: 'em', children: [text('i')] },
      text(' '),
      { type: 'em', children: [{ type: 'strong', children: [text('both')] }] },
      text(' '),
      { type: 'del', children: [text('gone')] },
    ]);
  });

  it('leaves snake_case, a single ~ and unclosed delimiters as text', () => {
    expect(parseInline('snake_case_name ~5 min ~~~a~~~ **open')).toEqual([text('snake_case_name ~5 min ~~~a~~~ **open')]);
  });

  it('reads code spans of any backtick-run length, with nothing inside them read', () => {
    expect(parseInline('`a` ``b`c`` ```**d**``` ` e `')).toEqual([
      { type: 'code', text: 'a' },
      text(' '),
      { type: 'code', text: 'b`c' },
      text(' '),
      { type: 'code', text: '**d**' },
      text(' '),
      { type: 'code', text: 'e' },
    ]);
    expect(parseInline('an unclosed ` backtick, and ``one`` `` that never closes')).toEqual([text('an unclosed ` backtick, and '), { type: 'code', text: 'one' }, text(' `` that never closes')]);
  });

  it('reads backslash escapes, and keeps a backslash before anything else', () => {
    expect(parseInline('\\*not em\\* \\` \\[x\\] C:\\path')).toEqual([text('*not em* ` [x] C:\\path')]);
  });

  it('shows raw HTML and entities as the text they are', () => {
    const html = '<b>bold</b> <img src=x onerror="alert(1)"> <script>alert(2)</script> &amp; &lt;';
    expect(parseInline(html)).toEqual([text(html)]);
  });
});

describe('links', () => {
  it('makes links of [text](url), <url> and bare URLs, each to the URL as the browser parses it', () => {
    expect(parseInline('[the docs](https://Example.com/a_(b) "Title") <https://example.com> see https://example.com/x?y=1.')).toEqual([
      link('https://example.com/a_(b)', text('the docs')),
      text(' '),
      link('https://example.com/', text('https://example.com')),
      text(' see '),
      link('https://example.com/x?y=1', text('https://example.com/x?y=1')),
      text('.'),
    ]);
  });

  it('shows an internationalised host as the browser parsed it, in punycode', () => {
    expect(parseInline('[bank](https://exämple.com/login)')).toEqual([link('https://xn--exmple-cua.com/login', text('bank'))]);
  });

  it("keeps a link to anything but absolute http: and https: as the text it was written as", () => {
    for (const written of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](src/a.ts)', '[x](/abs)', '[x](#top)', '[x](mailto:a@example.com)', '[x]()', '<javascript:alert(1)>', '<mailto:a@example.com>', 'javascript:alert(1)', 'www.example.com']) {
      expect(parseInline(written), written).toEqual([text(written)]);
    }
  });

  it('keeps text before and after a bare URL, without the punctuation that ends a sentence or a ) it did not open', () => {
    expect(linkify('(see https://example.com/a), or "https://example.com/b".')).toEqual([
      text('(see '),
      link('https://example.com/a', text('https://example.com/a')),
      text('), or "'),
      link('https://example.com/b', text('https://example.com/b')),
      text('".'),
    ]);
    expect(linkify('https://en.example.org/wiki/A_(b)')).toEqual([link('https://en.example.org/wiki/A_(b)', text('https://en.example.org/wiki/A_(b)'))]);
    expect(linkify('xhttps://example.com and 2https://example.com and https://')).toEqual([text('xhttps://example.com and 2https://example.com and https://')]);
  });

  it('reads formatting in link text, and no link inside a link', () => {
    expect(parseInline('[**bold** and https://inner.example](https://outer.example)')).toEqual([
      link('https://outer.example/', { type: 'strong', children: [text('bold')] }, text(' and https://inner.example')),
    ]);
    // The outer brackets can't make a link once the inner one has; its URL is then a bare one, as in GFM.
    expect(parseInline('[a [b](https://inner.example) c](https://outer.example)')).toEqual([
      text('[a '),
      link('https://inner.example/', text('b')),
      text(' c]('),
      link('https://outer.example/', text('https://outer.example')),
      text(')'),
    ]);
  });

  it('turns an image into its alt text, linked only under the link rule, and never anything that loads', () => {
    expect(parseInline('![a chart](https://example.com/c.png)')).toEqual([link('https://example.com/c.png', text('a chart'))]);
    expect(parseInline('![a chart](chart.png) ![](data:image/png;base64,AAAA)')).toEqual([text('a chart data:image/png;base64,AAAA')]);
    expect(parseInline('![](https://example.com/c.png)')).toEqual([link('https://example.com/c.png', text('https://example.com/c.png'))]);
    // A badge linking somewhere: the outer link, with the image's alt text.
    expect(parseInline('[![build](https://example.com/b.svg)](https://example.com/ci)')).toEqual([link('https://example.com/ci', text('build'))]);
  });

  it("checks a URL as the browser does", () => {
    expect(httpUrl('https://example.com')?.href).toBe('https://example.com/');
    expect(httpUrl('HTTP://EXAMPLE.COM/A')?.href).toBe('http://example.com/A');
    for (const other of ['javascript:alert(1)', 'data:,x', 'file:///etc/hosts', 'ftp://example.com', '/relative', 'example.com', '']) expect(httpUrl(other), other).toBeUndefined();
  });

  it('leaves reference links and footnotes as text', () => {
    expect(parseInline('[ref][1] [shortcut] [^1]')).toEqual([text('[ref][1] [shortcut] [^1]')]);
  });
});

describe('nesting caps', () => {
  it('reads quotes and lists only as deep as the limit, and the rest as text', () => {
    const quotes = parseMarkdown('>'.repeat(MAX_BLOCK_DEPTH + 5) + ' deep');
    let depth = 0;
    let block: Block | undefined = quotes[0];
    while (block?.type === 'quote') {
      depth++;
      block = block.children[0];
    }
    expect(depth).toBe(MAX_BLOCK_DEPTH);
    expect(block).toEqual(para(text(`${'>'.repeat(5)} deep`)));

    const lists = parseMarkdown('* 1. '.repeat(MAX_BLOCK_DEPTH) + 'deep');
    let listDepth = 0;
    let at: Block | undefined = lists[0];
    while (at?.type === 'list') {
      listDepth++;
      at = at.items[0]?.[0];
    }
    expect(listDepth).toBe(MAX_BLOCK_DEPTH);
  });

  it('nests emphasis and links only as deep as the limit, and the rest as text', () => {
    const deep = MAX_INLINE_DEPTH + 4;
    const inlines = parseInline(`${'*a '.repeat(deep)}x${' a*'.repeat(deep)}`);
    let depth = 0;
    let level: Inline[] = inlines;
    for (;;) {
      const em = level.find((inline) => inline.type === 'em');
      if (!em || em.type !== 'em') break;
      depth++;
      level = em.children;
    }
    expect(depth).toBeLessThanOrEqual(MAX_INLINE_DEPTH);
    expect(shown(inlines).replace(/\s+/g, ' ')).toContain('x');
  });
});

describe('bounded on hostile input', () => {
  /** The best of five runs, so a pause elsewhere doesn't count. */
  function bestOf5(fn: () => unknown): number {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      fn();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  /** A frame at 60 Hz. Each input parses in well under it (5 ms or less on a 2026 laptop). */
  const FRAME_MS = 16;
  const N = 32 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const ticks: string[] = [];
  for (let n = 1, total = 0; total < N; n++, total += n + 1) ticks.push('`'.repeat(n));

  it.each([
    ['deep quotes', '>'.repeat(N)],
    ['deep lists on one line', fill('* 1. ')],
    ['deep lists, a line each', Array.from({ length: 2000 }, (_, i) => `${' '.repeat(2 * (i % 40))}- item`).join('\n').slice(0, N)],
    ['a run of backticks', '`'.repeat(N)],
    ['backtick runs of every length', ticks.join(' ').slice(0, N)],
    ['a run of *', '*'.repeat(N)],
    ['thousands of * openers', fill('*a ')],
    ['thousands of ** openers', fill('**a ')],
    ['nested emphasis', `${fill('*a ').slice(0, N / 2)}${fill('a* ').slice(0, N / 2)}`],
    ['thousands of _ and ~~', fill('_a ~~b ')],
    ['a run of |', '|'.repeat(N)],
    ['thousands of table rows', fill('|a|b|\n|-|-|\n')],
    ['a table as wide as allowed', `${'|a'.repeat(MAX_TABLE_COLUMNS)}|\n${'|-'.repeat(MAX_TABLE_COLUMNS)}|\n${fill(`${'|x'.repeat(MAX_TABLE_COLUMNS)}|\n`)}`.slice(0, N)],
    ['a run of [', '['.repeat(N)],
    ['[ then link targets', `${'['.repeat(N / 2)}${fill('](a').slice(0, N / 2)}`],
    ['a link opener and spaces', `[a](${' '.repeat(N - 4)}`],
    ['titles that never close', fill('[a](b "')],
    ['a run of <', '<'.repeat(N)],
    ['autolinks that never close', fill('<ab:')],
    ['bare URLs that are only schemes', fill('http://')],
    ['thousands of bare URLs', fill('https://a.example/x ')],
    ['a run of backslashes', '\\'.repeat(N)],
    ['images that never close', fill('![')],
    ['spaces before a break', `${' '.repeat(N - 2)}x\n`],
    ['fences', fill('```\n')],
  ])('parses 32 KiB of %s within a frame', (_name, hostile) => {
    expect(hostile.length).toBeLessThanOrEqual(N);
    expect(bestOf5(() => parseMarkdown(hostile))).toBeLessThan(FRAME_MS);
  });

  it('shows hostile text as text: nothing is lost', () => {
    // After an x, so a line of * isn't a rule and a line of backticks isn't a fence.
    for (const run of ['['.repeat(1000), `x${'*'.repeat(1000)}`, `x${'`'.repeat(1000)}`, `x${'_'.repeat(1000)}`, `x${'<'.repeat(1000)}`, `x${'~'.repeat(1000)}`]) {
      const [block] = parseMarkdown(run);
      expect(block?.type === 'paragraph' ? shown(block.children) : block, run.slice(0, 5)).toBe(run);
    }
  });

  it('counts the elements a message takes, so the page can show one with too many as text', () => {
    expect(elementCount(parseMarkdown('plain words'))).toBe(1);
    // A paragraph, a strong, a code span and a link with its tooltip.
    expect(elementCount(parseMarkdown('**a** `b` [c](https://example.com)'))).toBe(1 + 1 + 1 + 4);
    expect(elementCount(parseMarkdown('```\ncode\n```'))).toBe(10);
    expect(elementCount(parseMarkdown('- a\n- b'))).toBe(1 + 2 + 2);
    // 32 KiB of dense everyday markdown fits; 32 KiB of hostile input doesn't.
    const everyday = 'A **made-up** reply with `code`, a [link](https://example.com/a) and *emphasis*.\n\n- one item\n- two items\n\n';
    expect(elementCount(parseMarkdown(everyday.repeat(Math.ceil(N / everyday.length)).slice(0, N)))).toBeLessThanOrEqual(MAX_ELEMENTS);
    for (const hostile of [fill('*a* '), fill('- a\n'), fill('```\na\n```\n'), `${'|a'.repeat(16)}|\n${'|-'.repeat(16)}|\n${fill(`${'|x'.repeat(16)}|\n`)}`]) {
      expect(elementCount(parseMarkdown(hostile.slice(0, N)), MAX_ELEMENTS)).toBeGreaterThan(MAX_ELEMENTS);
    }
  });

  it('never makes a link of anything but http: and https:, whatever the input', () => {
    const tricky = '[a](javascript:alert(1)) <javascript:alert(1)> ![x](javascript:alert(1)) [b](  javascript:alert(1)  ) [c](<javascript:alert(1)>) [d](JaVaScRiPt:alert(1)) [e](\\javascript:alert(1)) https://ok.example';
    const links = linksIn(parseMarkdown(tricky));
    expect(links.map((found) => (found.type === 'link' ? found.href : ''))).toEqual(['https://ok.example/']);
  });
});

describe('links in code (W37)', () => {
  /** A code span, with its bare URLs as links when it has any. */
  const span = (written: string, ...linked: Inline[]): Inline => (linked.length > 0 ? { type: 'code', text: written, linked } : { type: 'code', text: written });
  const url = (href: string, written = href): Inline => link(href, text(written));
  /** The code block a fence of `code` parses to. */
  const block = (code: string): Block | undefined => parseMarkdown(`\`\`\`\n${code}\n\`\`\``)[0];
  /** What a code node shows: its linked parts joined, or its text. */
  const codeShown = (node: Block | Inline | undefined): string =>
    node?.type === 'code' ? (node.linked ? shown(node.linked) : node.text) : `not code: ${JSON.stringify(node)}`;

  it('makes links of bare URLs in a code span: several, at its start and its end', () => {
    expect(parseInline('`https://example.com/a and https://example.com/b`')).toEqual([
      span('https://example.com/a and https://example.com/b', url('https://example.com/a'), text(' and '), url('https://example.com/b')),
    ]);
    expect(parseInline('Run `gh pr view https://github.com/example/app/pull/41 --web` now.')).toEqual([
      text('Run '),
      span('gh pr view https://github.com/example/app/pull/41 --web', text('gh pr view '), url('https://github.com/example/app/pull/41'), text(' --web')),
      text(' now.'),
    ]);
  });

  it('makes links of bare URLs in a code block: at the start and end of a line, several on one, after a bracket or a quote', () => {
    const code = [
      'https://example.com/start of a line',
      'the end of one: https://example.com/end',
      'two: https://example.com/one https://example.com/two',
      '(https://example.com/paren) [https://example.com/square] "https://example.com/double" \'https://example.com/single\'',
    ].join('\n');
    expect(block(code)).toEqual({
      type: 'code',
      language: '',
      text: code,
      closed: true,
      linked: [
        url('https://example.com/start'),
        text(' of a line\nthe end of one: '),
        url('https://example.com/end'),
        text('\ntwo: '),
        url('https://example.com/one'),
        text(' '),
        url('https://example.com/two'),
        text('\n('),
        url('https://example.com/paren'),
        text(') ['),
        url('https://example.com/square'),
        text('] "'),
        url('https://example.com/double'),
        text('" \''),
        url('https://example.com/single'),
        text("'"),
      ],
    });
  });

  it('leaves trailing punctuation and a bracket the URL did not open out of the link, as in text', () => {
    const code = 'See https://example.com/a. Or https://example.com/b, https://example.com/c; (https://example.com/d), https://example.com/e?! https://en.example.org/wiki/A_(b)';
    expect(block(code)).toEqual({
      type: 'code',
      language: '',
      text: code,
      closed: true,
      linked: [
        text('See '),
        url('https://example.com/a'),
        text('. Or '),
        url('https://example.com/b'),
        text(', '),
        url('https://example.com/c'),
        text('; ('),
        url('https://example.com/d'),
        text('), '),
        url('https://example.com/e'),
        text('?! '),
        url('https://en.example.org/wiki/A_(b)'),
      ],
    });
  });

  it('links to the URL as the browser parsed it, an internationalised host in punycode', () => {
    expect(parseInline('`https://EXÄMPLE.com/login`')).toEqual([span('https://EXÄMPLE.com/login', url('https://xn--exmple-cua.com/login', 'https://EXÄMPLE.com/login'))]);
  });

  it('keeps javascript:, data:, file:, relative and other URLs in code as text', () => {
    for (const written of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/hosts', './src/a.ts', '/abs/path', '../up', '#top', 'www.example.com', 'ftp://example.com/a', 'mailto:a@example.com', 'xhttps://example.com', '2https://example.com', 'https://', 'http://']) {
      expect(parseInline(`\`${written}\``), written).toEqual([span(written)]);
      expect(block(written), written).toEqual({ type: 'code', language: '', text: written, closed: true });
    }
  });

  it("keeps markdown's own link syntax in code as text, as the rest of code is", () => {
    for (const written of [
      '[the notes](https://example.com/notes)',
      '[the notes](https://example.com/notes "Notes")',
      '<https://example.com/changelog>',
      '[a](<https://example.com/a>)',
      '![a chart](https://example.com/c.png)',
      '[https://example.com/same](https://example.com/same)',
      '[see https://example.com/a](https://example.com/b)',
    ]) {
      expect(parseInline(`\`${written}\``), written).toEqual([span(written)]);
      expect(block(written), written).toEqual({ type: 'code', language: '', text: written, closed: true });
    }
    // A bare URL beside it is still a link.
    expect(parseInline('`[x](https://example.com/x) or https://example.com/y`')).toEqual([
      span('[x](https://example.com/x) or https://example.com/y', text('[x](https://example.com/x) or '), url('https://example.com/y')),
    ]);
  });

  it('keeps a code span inside a link plain code, so links never nest', () => {
    expect(parseInline('[`https://example.com/a`](https://example.com/b)')).toEqual([link('https://example.com/b', span('https://example.com/a'))]);
    expect(parseInline('[**`https://example.com/a`** and `https://example.com/c`](https://example.com/b)')).toEqual([
      link('https://example.com/b', { type: 'strong', children: [span('https://example.com/a')] }, text(' and '), span('https://example.com/c')),
    ]);
  });

  it("keeps the code's text exactly as written, beside the links", () => {
    const code = '\t$ curl -s "https://example.com/api?q=1&r=2"   \n\n  # then https://example.com/next.\n<b>https://example.com/html</b> **https://example.com/bold**';
    const parsed = block(code);
    expect(parsed?.type === 'code' && parsed.text).toBe(code);
    expect(codeShown(parsed)).toBe(code);
    expect(parsed?.type === 'code' && parsed.linked?.filter((part) => part.type === 'link').map((part) => (part.type === 'link' ? part.href : ''))).toEqual([
      'https://example.com/api?q=1&r=2',
      'https://example.com/next',
      'https://example.com/html',
      'https://example.com/bold',
    ]);
    // In a code span, as written too, and in a fence that never closes, as in a message cut short.
    const cut = parseMarkdown('Draft:\n\n```text\nReview https://example.com/pull/1\nand');
    expect(cut[1]).toEqual({ type: 'code', language: 'text', text: 'Review https://example.com/pull/1\nand', closed: false, linked: [text('Review '), url('https://example.com/pull/1'), text('\nand')] });
  });

  it('reads links in code wherever code is: lists, quotes, tables and headings', () => {
    const blocks = parseMarkdown('- `https://example.com/item`\n\n> ```\n> https://example.com/quote\n> ```\n\n| a |\n|---|\n| `https://example.com/cell` |\n\n# `https://example.com/heading`');
    const hrefs: string[] = [];
    const walkInline = (inlines: Inline[]) => {
      for (const inline of inlines) {
        if (inline.type === 'code' && inline.linked) walkInline(inline.linked);
        if (inline.type === 'link') hrefs.push(inline.href);
        if ('children' in inline) walkInline(inline.children);
      }
    };
    const walk = (list: Block[]) => {
      for (const item of list) {
        if (item.type === 'paragraph' || item.type === 'heading') walkInline(item.children);
        else if (item.type === 'code' && item.linked) walkInline(item.linked);
        else if (item.type === 'quote') walk(item.children);
        else if (item.type === 'list') item.items.forEach(walk);
        else if (item.type === 'table') [...item.head, ...item.rows.flat()].forEach(walkInline);
      }
    };
    walk(blocks);
    expect(hrefs).toEqual(['https://example.com/item', 'https://example.com/quote', 'https://example.com/cell', 'https://example.com/heading']);
  });

  it('counts the links in code towards the element cap, as links in text are counted', () => {
    expect(elementCount(parseMarkdown('`https://example.com/a`'))).toBe(1 + 1 + 4);
    expect(elementCount(parseMarkdown('```\nhttps://example.com/a https://example.com/b\n```'))).toBe(10 + 4 + 4);
    expect(elementCount(parseMarkdown('```\nhttps://example.com/a\n```'))).toBe(elementCount(parseMarkdown('```\na\n```')) + elementCount(parseMarkdown('https://example.com/a')) - 1);
    // A code block with one URL a line: past the cap it shows as written.
    const lines = (count: number) => `\`\`\`\n${Array.from({ length: count }, (_, i) => `https://example.com/${i}`).join('\n')}\n\`\`\``;
    const under = Math.floor((MAX_ELEMENTS - 10) / 4);
    expect(elementCount(parseMarkdown(lines(under)), MAX_ELEMENTS)).toBeLessThanOrEqual(MAX_ELEMENTS);
    expect(elementCount(parseMarkdown(lines(under + 1)), MAX_ELEMENTS)).toBeGreaterThan(MAX_ELEMENTS);
  });
});

describe('links in code, bounded on hostile input (W37)', () => {
  function bestOf5(fn: () => unknown): number {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      fn();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }
  const FRAME_MS = 16;
  const N = 32 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const fence = (body: string) => `\`\`\`\n${body.slice(0, N - 8)}\n\`\`\``;

  it.each([
    ['a code block packed with URLs', fence(fill('https://a.example/x '))],
    ['a code block of URLs, one a line', fence(fill('https://a.example/x\n'))],
    ['a code block of long URLs, under the cap', fence(fill(`https://example.com/${'a'.repeat(60)}\n`))],
    ['a code block of schemes only', fence(fill('https://'))],
    ['a code block of URLs in link syntax', fence(fill('[a](https://a.example/x) <https://b.example/y> '))],
    ['a code block of one URL with thousands of brackets', fence(`https://a.example/${fill('(]')}`)],
    ['a code block of URLs after letters', fence(fill('xhttps://a.example/'))],
    ['thousands of code spans holding URLs', fill('`https://a.example/x` ')],
    ['a code span holding thousands of URLs', `\`${fill('https://a.example/x ').slice(0, N - 2)}\``],
  ])('parses 32 KiB of %s within a frame', (_name, hostile) => {
    expect(hostile.length).toBeLessThanOrEqual(N);
    expect(bestOf5(() => parseMarkdown(hostile))).toBeLessThan(FRAME_MS);
  });

  it('shows a code block packed with URLs as written, and formats one of long URLs, under the cap', () => {
    expect(elementCount(parseMarkdown(fence(fill('https://a.example/x '))), MAX_ELEMENTS)).toBeGreaterThan(MAX_ELEMENTS);
    expect(elementCount(parseMarkdown(fill('`https://a.example/x` ')), MAX_ELEMENTS)).toBeGreaterThan(MAX_ELEMENTS);
    expect(elementCount(parseMarkdown(fence(fill(`https://example.com/${'a'.repeat(60)}\n`))), MAX_ELEMENTS)).toBeLessThanOrEqual(MAX_ELEMENTS);
  });
});

describe('where a bare URL ends, in text and code (W37)', () => {
  const url = (href: string, written = href): Inline => link(href, text(written));
  /** A code block's text with its links, from linkify as the parser runs it on code. */
  const inCode = (code: string): Inline[] => {
    const [parsed] = parseMarkdown(`\`\`\`\n${code}\n\`\`\``);
    return parsed?.type === 'code' ? (parsed.linked ?? [text(parsed.text)]) : [];
  };

  it.each([
    ['an HTML attribute', '<a href="https://example.com/docs">Docs</a>', [text('<a href="'), url('https://example.com/docs'), text('">Docs</a>')]],
    ['an HTML attribute that closes the tag', '<img src="https://example.com/a.png">', [text('<img src="'), url('https://example.com/a.png'), text('">')]],
    ['minified JSON', '{"url":"https://example.com/a"}', [text('{"url":"'), url('https://example.com/a'), text('"}')]],
    ["a Python dict, its ' trailing punctuation and its } unopened", "{'url': 'https://example.com/a'}", [text("{'url': '"), url('https://example.com/a'), text("'}")]],
    ['a } the URL did not open', 'see https://example.com/a})', [text('see '), url('https://example.com/a'), text('})')]],
    ['a { the URL opened, which keeps its }', 'GET https://example.com/users/{id}', [text('GET '), url('https://example.com/users/%7Bid%7D', 'https://example.com/users/{id}')]],
    ['a > straight after it', 'curl https://example.com/a>out.txt', [text('curl '), url('https://example.com/a'), text('>out.txt')]],
  ])('ends a URL in %s, in text and in code', (_name, written, expected) => {
    expect(linkify(written)).toEqual(expected);
    expect(inCode(written)).toEqual(expected);
  });

  it('ends a backticked URL inside a code block, as in a markdown draft, at its backtick', () => {
    expect(inCode('Merged in `https://github.com/example/app/pull/41`, see `https://example.com/a`.')).toEqual([
      text('Merged in `'),
      url('https://github.com/example/app/pull/41'),
      text('`, see `'),
      url('https://example.com/a'),
      text('`.'),
    ]);
  });

  it('ends a URL at the end of its line, and of the text', () => {
    expect(inCode('see https://example.com/end\nhttps://example.com/next.')).toEqual([text('see '), url('https://example.com/end'), text('\n'), url('https://example.com/next'), text('.')]);
    expect(parseMarkdown('see https://example.com/end\nand on')).toEqual([para(text('see '), url('https://example.com/end'), { type: 'break' }, text('and on'))]);
    expect(linkify('the end: https://example.com/end')).toEqual([text('the end: '), url('https://example.com/end')]);
  });

  it('still reads <url> as an autolink in text, and as text in code', () => {
    expect(parseInline('<https://example.com/a>')).toEqual([url('https://example.com/a')]);
    expect(inCode('<https://example.com/a> and <https://example.com/b>,')).toEqual([text('<https://example.com/a> and <https://example.com/b>,')]);
    // A < before it with no > after it isn't an autolink: the URL is a bare one.
    expect(inCode('<https://example.com/c d')).toEqual([text('<'), url('https://example.com/c'), text(' d')]);
  });
});

describe('a username or password before the host (W55, W48\'s F6)', () => {
  /** github.com is only the username here: the host is evil.example. */
  const USERINFO = 'https://github.com@evil.example/x';

  it('is never an http URL, whatever the username or password', () => {
    for (const written of [USERINFO, 'https://user:secret@example.com/', 'https://:secret@example.com/', 'https://github.com:@evil.example/', 'https://:@github.com@evil.example/', 'HTTP://GITHUB.COM@EVIL.EXAMPLE/']) {
      expect(httpUrl(written), written).toBeUndefined();
    }
    // An @ in the path, and an empty userinfo, which the parser drops, are no username.
    expect(httpUrl('https://example.com/@example')?.href).toBe('https://example.com/@example');
    expect(httpUrl('https://@example.com/a')?.href).toBe('https://example.com/a');
  });

  it('is the text it was written as in a link, an autolink, a bare URL, an image and code', () => {
    for (const written of [`[the pull request](${USERINFO})`, `[${USERINFO}](${USERINFO})`, `<${USERINFO}>`, USERINFO, `see ${USERINFO}.`, `\`${USERINFO}\``]) {
      const blocks = parseMarkdown(written);
      expect(linksIn(blocks), written).toEqual([]);
      expect(blocks, written).toEqual([para(written.startsWith('`') ? { type: 'code', text: USERINFO } : text(written))]);
    }
    expect(parseMarkdown(`\`\`\`\ngh pr view ${USERINFO}\n\`\`\``)).toEqual([{ type: 'code', language: '', text: `gh pr view ${USERINFO}`, closed: true }]);
    // An image is its alt text, with no link.
    expect(parseInline(`![a chart](${USERINFO})`)).toEqual([text('a chart')]);
    // A bare URL beside one is still a link.
    expect(linkify(`${USERINFO} or https://example.com/y`)).toEqual([text(`${USERINFO} or `), link('https://example.com/y', text('https://example.com/y'))]);
  });
});

describe('links that ask first (W55, W48\'s F6)', () => {
  it.each([
    ['the same URL', 'https://example.com/docs', 'https://example.com/docs'],
    ['a / added at the end of the path', 'https://example.com/docs/', 'https://example.com/docs'],
    ['a / left off the end of the path', 'https://example.com/docs', 'https://example.com/docs/'],
    ['a bare host', 'https://example.com', 'https://example.com/'],
    ['the scheme left off', 'example.com/docs', 'https://example.com/docs'],
    ['the scheme left off an http: link', 'example.com/docs', 'http://example.com/docs'],
    ['the scheme and a trailing / left off', 'github.com/example/app/pull/51', 'https://github.com/example/app/pull/51/'],
    ['the scheme and host in capitals', 'HTTPS://EXAMPLE.COM/docs', 'https://example.com/docs'],
    ['an internationalised host, which the link has in punycode', 'https://exämple.com/login', 'https://xn--exmple-cua.com/login'],
    ['the default port', 'https://example.com:443/a', 'https://example.com/a'],
    ['characters the parser percent-encodes', 'https://example.com/users/{id}', 'https://example.com/users/%7Bid%7D'],
    ['spaces at either end', '  https://example.com/a ', 'https://example.com/a'],
    ['an empty query or fragment', 'https://example.com/a?#', 'https://example.com/a'],
    ['the same query and fragment', 'https://example.com/a?b=1&c=2#d', 'https://example.com/a?b=1&c=2#d'],
  ])('counts as its own address: %s', (_name, written, href) => {
    expect(isOwnAddress(written, href)).toBe(true);
  });

  it.each([
    ['words', 'the docs', 'https://example.com/docs'],
    ['one word', 'docs', 'https://example.com/docs'],
    ['another URL', 'https://github.com/example/repo/pull/51', 'https://evil.example/pull/51'],
    ['another path on the same host', 'https://example.com/docs', 'https://example.com/login'],
    ['the other scheme', 'http://example.com/a', 'https://example.com/a'],
    ['https: text on an http: link', 'https://example.com/a', 'http://example.com/a'],
    ['another query', 'https://example.com/a', 'https://example.com/a?next=https://evil.example'],
    ['another fragment', 'https://example.com/a', 'https://example.com/a#b'],
    ['www. added', 'www.example.com', 'https://example.com/'],
    ['www. left off', 'example.com', 'https://www.example.com/'],
    ['another port', 'https://example.com/a', 'https://example.com:8443/a'],
    ['two slashes at the end', 'https://example.com/a//', 'https://example.com/a'],
    ['a look-alike host, which the link has in punycode', 'https://example.com', 'https://xn--xample-2of.com/'],
    ['a username in the text', 'https://github.com@evil.example/x', 'https://evil.example/x'],
    ['a tab the parser would drop unseen', 'https://exa\tmple.com/', 'https://example.com/'],
    ['a line break', 'https://example.com/\na', 'https://example.com/a'],
    ['a space inside', 'https://example.com /a', 'https://example.com/a'],
    ['nothing', '', 'https://example.com/'],
    ['a link to anything but http: and https:', 'javascript:alert(1)', 'javascript:alert(1)'],
  ])("isn't its own address: %s", (_name, written, href) => {
    expect(isOwnAddress(written, href)).toBe(false);
  });

  it("reads a link's text through its formatting and code, with a line break as a line feed", () => {
    expect(linkText([text('a '), { type: 'strong', children: [text('b'), { type: 'em', children: [{ type: 'code', text: 'c' }] }] }, { type: 'break' }, { type: 'del', children: [text('d')] }])).toBe('a bc\nd');
  });

  it('asks for a link whose text is words, another URL or an image, and not for one whose text is its address, formatted or in code', () => {
    const asks = (written: string) => linksIn(parseMarkdown(written)).map((found) => (found.type === 'link' ? asksFirst(found) : 'not a link'));
    expect(asks('[the pull request](https://github.com/example/app/pull/51)')).toEqual([true]);
    expect(asks('[https://github.com/example/app/pull/51](https://example.com/pull/51)')).toEqual([true]);
    expect(asks('[![build](https://example.com/b.svg)](https://example.com/ci)')).toEqual([true]);
    expect(asks('[https://example.com/a\nb](https://example.com/ab)')).toEqual([true]);
    expect(asks('[https://example.com/a](https://example.com/a) [**https://example.com/b**](https://example.com/b) [`https://example.com/c`](https://example.com/c) [example.com/d](https://example.com/d/)')).toEqual([false, false, false, false]);
  });

  it('never asks for a bare URL or an autolink, in text or code, however it is written', () => {
    const written = [
      '<https://example.com/a> <HTTP://EXAMPLE.COM/A> <http:example.com> <https:/example.com/b> <https://example.com/c d> <https://exämple.com/login>',
      'https://example.com/plain https://EXAMPLE.com/caps https://example.com/users/{id} https://example.com/a\u0001 https://en.example.org/wiki/A_(b) https://example.com/x?y=1#z.',
      '`https://example.com/span` and `gh pr view https://github.com/example/app/pull/41 --web`',
      '```\n- the loop: https://github.com/example/app/pull/41\n  - its tests (https://github.com/example/app/pull/42)\n{"url":"https://example.com/json"} <a href="https://example.com/docs">\n```',
      '| a |\n|---|\n| https://example.com/cell |\n\n# https://example.com/heading\n\n> https://example.com/quote',
    ].join('\n\n');
    const found: Inline[] = [];
    const walkInline = (inlines: Inline[]) => {
      for (const inline of inlines) {
        if (inline.type === 'link') found.push(inline);
        if (inline.type === 'code' && inline.linked) walkInline(inline.linked);
        if ('children' in inline) walkInline(inline.children);
      }
    };
    const walk = (list: Block[]) => {
      for (const item of list) {
        if (item.type === 'paragraph' || item.type === 'heading') walkInline(item.children);
        else if (item.type === 'code' && item.linked) walkInline(item.linked);
        else if (item.type === 'quote') walk(item.children);
        else if (item.type === 'list') item.items.forEach(walk);
        else if (item.type === 'table') [...item.head, ...item.rows.flat()].forEach(walkInline);
      }
    };
    walk(parseMarkdown(written));
    expect(found).toHaveLength(21);
    expect(found.filter((item) => item.type === 'link' && asksFirst(item)).map((item) => (item.type === 'link' ? item.href : ''))).toEqual([]);
  });
});
