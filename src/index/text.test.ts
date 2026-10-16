import { describe, expect, it } from 'vitest';
import {
  cap,
  LINE_PIECE_LENGTH,
  markFences,
  MESSAGE_WORK_MAX,
  stripMarkdown,
  stripMarkdownBounded,
  tail,
  truncate,
} from './text.js';

// Synthetic text only.

/** How long `fn` takes, in milliseconds. */
function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/**
 * The most a hostile input may take. The patterns are linear, so these run in
 * a few milliseconds; the margin is for slow CI machines, while the quadratic
 * versions took seconds.
 */
const FAST_MS = 200;

/** The best of three runs of `fn`, in milliseconds, so one slow run on a busy machine doesn't decide. */
function bestOf3(fn: () => unknown): number {
  return Math.min(timed(fn), timed(fn), timed(fn));
}

/** The W6 review's hostile inputs, each about 64 KiB, as stripMarkdown's and detectAskedYou's tests use them. */
const N = 64 * 1024;
const HOSTILE: [string, string][] = [
  ['an image opener and spaces', `![a](${' '.repeat(N - 5)}`],
  ['a link opener and spaces', `[a](${' '.repeat(N - 4)}`],
  ['a run of [', '['.repeat(N)],
  ['a run of ![', '!['.repeat(N / 2)],
  ['a heading with a long run of spaces', `# a${' '.repeat(N)}x`],
  ['link targets with unclosed titles', '[a](x "'.repeat(N / 7)],
  ['spaces before a word', `${' '.repeat(N)}x`],
  ['a label followed by emphasis, spaces and a line separator', `open questions${'* _'.repeat(N / 3)}\u2028`],
];
/** One 64 KiB line of each emphasis shape that never closes, and the shapes that cost most per character. */
const EMPHASIS_LINES: [string, string][] = [
  ['*a', '*a '.repeat(N / 3)],
  ['_a', '_a '.repeat(N / 3)],
  ['**a', '**a '.repeat(N / 4)],
  ['__a', '__a '.repeat(N / 4)],
  ['`a', '`a '.repeat(N / 3)],
  ['*a\\*', '*a\\* '.repeat(N / 5)],
  ['*\\\\', '*\\\\ '.repeat(N / 4)],
  ['a table row of *a', `|${'*a '.repeat(N / 3)}|`],
];

const TYPICAL_MESSAGE = [
  '## Summary',
  '',
  'Fixed the **flaky** test in `src/index.ts`.',
  '',
  '| Check | Result |',
  '|---|---|',
  '| Tests | pass |',
  '',
  '```',
  'npm test',
  '```',
  '',
  '**Open questions:** None',
  '',
  '**Next steps:**',
  '1. You review the [PR](https://example.com/pr/2).',
].join('\n');

const TYPICAL_STRIPPED = [
  'Summary',
  '',
  'Fixed the flaky test in src/index.ts.',
  '',
  'Check · Result',
  'Tests · pass',
  '',
  '[code]',
  '',
  'Open questions: None',
  '',
  'Next steps:',
  '1. You review the PR.',
].join('\n');

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('x'.repeat(10), 10)).toBe('x'.repeat(10));
  });

  it('cuts to the limit with an ellipsis', () => {
    expect(truncate('abcdefghijkl', 5)).toBe('abcd…');
  });

  it('does not split a surrogate pair', () => {
    const result = truncate(`abc🎉${'x'.repeat(10)}`, 5);
    expect(result).toBe('abc…');
    expect(result.length).toBeLessThanOrEqual(5);
  });
});

describe('cap', () => {
  it('keeps at most max code units, without half a surrogate pair', () => {
    expect(cap('abcdef', 10)).toBe('abcdef');
    expect(cap('abcdef', 3)).toBe('abc');
    expect(cap('ab🎉cd', 3)).toBe('ab');
    expect(cap('ab🎉cd', 4)).toBe('ab🎉');
  });
});

describe('tail', () => {
  it('keeps at most the last max code units, without half a surrogate pair', () => {
    expect(tail('abcdef', 10)).toBe('abcdef');
    expect(tail('abcdef', 3)).toBe('def');
    expect(tail('ab🎉cd', 3)).toBe('cd');
    expect(tail('ab🎉cd', 4)).toBe('🎉cd');
  });
});

describe('markFences', () => {
  it('marks fenced lines, fences included, and the opening fence', () => {
    const lines = markFences('before\n```ts\nconst a = 1;\n```\nafter');
    expect(lines.map((l) => [l.text, l.code, l.opensFence])).toEqual([
      ['before', false, false],
      ['```ts', true, true],
      ['const a = 1;', true, false],
      ['```', true, false],
      ['after', false, false],
    ]);
  });

  it('closes a fence only with the same character, at least as long', () => {
    const lines = markFences('````\n```\n~~~\n````\nout');
    expect(lines.map((l) => l.code)).toEqual([true, true, true, true, false]);
  });

  it('accepts tilde fences and indented fences, as in a list item', () => {
    expect(markFences('~~~\nx\n~~~\ny').map((l) => l.code)).toEqual([true, true, true, false]);
    expect(markFences('1. Run:\n   ```sh\n   npm test\n   ```\n2. Done').map((l) => l.code)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it('runs an unclosed fence to the end', () => {
    expect(markFences('a\n```\nb\nc').map((l) => l.code)).toEqual([false, true, true, true]);
  });

  it('does not treat inline triple backticks as a fence', () => {
    expect(markFences('```inline```\nnext').map((l) => l.code)).toEqual([false, false]);
  });

  it('handles CRLF line endings', () => {
    expect(markFences('a\r\n```\r\nb\r\n```\r\nc').map((l) => l.text)).toEqual(['a', '```', 'b', '```', 'c']);
  });
});

describe('stripMarkdown', () => {
  it('turns a fenced code block into [code]', () => {
    expect(stripMarkdown('Run this:\n\n```sh\nnpm test\nnpm run build\n```\n\nThen push.')).toBe(
      'Run this:\n\n[code]\n\nThen push.',
    );
    expect(stripMarkdown('```\nonly code\n```')).toBe('[code]');
  });

  it('removes inline backticks and keeps their content untouched', () => {
    expect(stripMarkdown('Use `npm ci`, not `npm install`.')).toBe('Use npm ci, not npm install.');
    expect(stripMarkdown('Call `__init__` and `a*b*c`.')).toBe('Call __init__ and a*b*c.');
    expect(stripMarkdown('A tick: `` a`b ``.')).toBe('A tick: a`b.');
    expect(stripMarkdown("An unpaired ` backtick stays")).toBe('An unpaired ` backtick stays');
  });

  it('removes paired emphasis', () => {
    expect(stripMarkdown('**bold**, __bold__, *italic*, _italic_')).toBe('bold, bold, italic, italic');
    expect(stripMarkdown('***both*** and **nested *inner* text**')).toBe('both and nested inner text');
    expect(stripMarkdown('**Open questions:** None')).toBe('Open questions: None');
    expect(stripMarkdown('**`npm test`** passes')).toBe('npm test passes');
    expect(stripMarkdown('(**done**)')).toBe('(done)');
  });

  it('leaves emphasis characters inside words and arithmetic alone', () => {
    for (const text of [
      'snake_case_name',
      'a_b and c_d',
      '2*3',
      '2*3*4',
      'a * b * c',
      'glob *.ts and *.tsx',
      'src/**/*.ts',
      'file_name_*.log',
      '**unclosed bold',
      'mid**word**here',
    ]) {
      expect(stripMarkdown(text), text).toBe(text);
    }
  });

  it('removes heading markers, including a closing sequence', () => {
    expect(stripMarkdown('# Title\n## Summary ##\n###### Deep')).toBe('Title\nSummary\nDeep');
    expect(stripMarkdown('#hashtag and #123')).toBe('#hashtag and #123');
    expect(stripMarkdown('# Notes on C#\n# ###\n## Trailing ##   ')).toBe('Notes on C#\n###\nTrailing');
  });

  it('normalizes unordered list markers to "- " and keeps ordered ones', () => {
    expect(stripMarkdown('* one\n+ two\n- three\n  * nested\n1. first\n2) second')).toBe(
      '- one\n- two\n- three\n  - nested\n1. first\n2) second',
    );
    expect(stripMarkdown('* **Bold:** item')).toBe('- Bold: item');
  });

  it('drops table separator rows and joins cells with " · "', () => {
    const table = ['| Option | Cost |', '| --- | :---: |', '| **A** | `low` |', '| B | high |', '', 'After.'].join('\n');
    expect(stripMarkdown(table)).toBe('Option · Cost\nA · low\nB · high\n\nAfter.');
  });

  it('handles a table without edge pipes and an escaped pipe', () => {
    expect(stripMarkdown('a | b\n--- | ---\n1 | 2')).toBe('a · b\n1 · 2');
    expect(stripMarkdown('| x \\| y | z |\n|---|---|')).toBe('x | y · z');
  });

  it('turns links into their text and images into their alt text', () => {
    expect(stripMarkdown('See [the docs](https://example.com/docs "Docs") and ![a chart](chart.png).')).toBe(
      'See the docs and a chart.',
    );
    expect(stripMarkdown('[wiki](https://example.com/Foo_(bar)) here')).toBe('wiki here');
    expect(stripMarkdown('[**PR**](https://example.com/pr/1)')).toBe('PR');
    expect(stripMarkdown('[not a link] (x)')).toBe('[not a link] (x)');
  });

  it('reads links the way CommonMark-ish patterns did: titles, empty parts, brackets in the text', () => {
    expect(stripMarkdown('[a](  "a title")')).toBe('a');
    expect(stripMarkdown("[a](x 'title')")).toBe('a');
    expect(stripMarkdown('[a]()')).toBe('a');
    expect(stripMarkdown('[a](  )')).toBe('a');
    expect(stripMarkdown('![](chart.png) and ![x]()')).toBe(' and x');
    expect(stripMarkdown('[](empty) [a] [b](u)')).toBe('[](empty) [a] b');
    expect(stripMarkdown('[[a](u) and [x [b](v)')).toBe('[a and x [b');
    expect(stripMarkdown('[a](x y) [b](unclosed')).toBe('[a](x y) [b](unclosed');
    expect(stripMarkdown('[a](b) [c](d "t") ![e](f)')).toBe('a c e');
  });

  it('removes blockquote markers', () => {
    expect(stripMarkdown('> quoted\n> > nested\n>no space')).toBe('quoted\nnested\nno space');
  });

  it('drops horizontal rules', () => {
    expect(stripMarkdown('above\n\n---\n\nbelow\n* * *')).toBe('above\n\nbelow');
  });

  it('keeps backslash-escaped characters literally', () => {
    expect(stripMarkdown('\\*not italic\\* and \\_x\\_')).toBe('*not italic* and _x_');
  });

  it('collapses runs of three or more newlines to two', () => {
    expect(stripMarkdown('a\n\n\n\nb\n\n\nc\n\nd')).toBe('a\n\nb\n\nc\n\nd');
  });

  it('leaves HTML as it is', () => {
    expect(stripMarkdown('<b>bold</b> <img src=x onerror="alert(1)"> <details>')).toBe(
      '<b>bold</b> <img src=x onerror="alert(1)"> <details>',
    );
  });

  it('leaves plain text alone', () => {
    const text = 'Done. The tests pass (12 of 12), and the build is clean: ready for review?';
    expect(stripMarkdown(text)).toBe(text);
  });

  describe('maxProse', () => {
    it('stops after that many characters outside code blocks, even mid-line', () => {
      expect(stripMarkdown('one two\nthree', 5)).toBe('one t');
      // Syntax closed after the cut is left as it is.
      expect(stripMarkdown('**one** two', 5)).toBe('**one');
      expect(stripMarkdown('one\ntwo\nthree', 6)).toBe('one\ntwo');
    });

    it('does not count code blocks, so a long one at the start does not hide the prose after it', () => {
      const code = `\`\`\`\n${'x'.repeat(10_000)}\n\`\`\``;
      expect(stripMarkdown(`${code}\n\nShould I apply this?`, 100)).toBe('[code]\n\nShould I apply this?');
    });
  });

  describe('hostile input', () => {
    // The shapes the W6 review measured at about 10 s each, and others found alongside them.
    const N = 64 * 1024;
    it.each([
      ['an image opener and spaces', `![a](${' '.repeat(N - 5)}`],
      ['a link opener and spaces', `[a](${' '.repeat(N - 4)}`],
      ['a run of [', '['.repeat(N)],
      ['a run of ![', '!['.repeat(N / 2)],
      ['a heading with a long run of spaces', `# a${' '.repeat(N)}x`],
      ['link targets with unclosed titles', '[a](x "'.repeat(N / 7)],
    ])('strips %s in linear time', (_name, text) => {
      expect(timed(() => stripMarkdown(text))).toBeLessThan(FAST_MS);
    });

    it('keeps the result of those inputs as it was', () => {
      expect(stripMarkdown(`![a](${' '.repeat(10)}`)).toBe(`![a](${' '.repeat(10)}`);
      expect(stripMarkdown(`# a${' '.repeat(10)}x`)).toBe(`a${' '.repeat(10)}x`);
    });
  });

  it('strips a typical end-of-turn message', () => {
    expect(stripMarkdown(TYPICAL_MESSAGE)).toBe(TYPICAL_STRIPPED);
  });
});

describe('stripMarkdownBounded', () => {
  it('strips a message exactly as stripMarkdown does while the work budget lasts', () => {
    expect(stripMarkdownBounded(TYPICAL_MESSAGE)).toBe(TYPICAL_STRIPPED);
    // About 64 KiB of paragraphs, list items, tables and code, like a long
    // report: several times the busiest message seen in real transcripts
    // (224 Ki units of work, against a budget of 4 Mi), still within budget.
    const paragraph = `The **index** reads \`claude agents --json\`, then [the transcript](https://example.com/t) for _each_ session. ${'More plain detail about it. '.repeat(10)}`;
    const report = Array.from({ length: 60 }, (_, i) =>
      [`### Part ${i}`, '', paragraph, '', `- **item ${i}:** ${paragraph}`, '', '| a | b |', '|---|---|', `| \`x\` | ${paragraph} |`, '', '```ts', 'const a = 1;', '```'].join('\n'),
    ).join('\n\n');
    expect(report.length).toBeGreaterThan(60_000);
    expect(stripMarkdownBounded(report)).toBe(stripMarkdown(report));
  });

  it('keeps fences and tables whole around a line it strips in pieces', () => {
    // A budget of 0 strips every line over the piece length in pieces.
    const long = `**start** ${'word '.repeat(60)}`;
    const text = ['| a | b |', '|---|---|', '| 1 | 2 |', long, '```', `${'code '.repeat(60)}`, '```', '# After'].join('\n');
    expect(stripMarkdownBounded(text, 0)).toBe(['a · b', '1 · 2', stripMarkdown(long), '[code]', 'After'].join('\n'));
  });

  it('strips each piece after the first as the middle of a line, not as a heading, list item or quote', () => {
    const line = `${'x'.repeat(LINE_PIECE_LENGTH)}# not a heading > not a quote`;
    expect(stripMarkdownBounded(line, 0)).toBe(line);
    const list = `${'x'.repeat(LINE_PIECE_LENGTH)}* not a list item, and **bold** inside`;
    expect(stripMarkdownBounded(list, 0)).toBe(`${'x'.repeat(LINE_PIECE_LENGTH)}* not a list item, and bold inside`);
    const rule = `${'x'.repeat(LINE_PIECE_LENGTH)}---`;
    expect(stripMarkdownBounded(rule, 0)).toBe(rule);
  });

  it('does not split a surrogate pair between pieces, and loses no text', () => {
    const line = `${'x'.repeat(LINE_PIECE_LENGTH - 1)}🎉${'y'.repeat(LINE_PIECE_LENGTH)}`;
    expect(stripMarkdownBounded(line, 0)).toBe(line);
    const plain = 'plain words '.repeat(100);
    expect(stripMarkdownBounded(plain, 0, 7)).toBe(plain);
  });

  it('collapses runs of blank lines across the pieces it joins', () => {
    const long = 'z'.repeat(LINE_PIECE_LENGTH * 2);
    expect(stripMarkdownBounded(`a\n\n\n${long}\n\n\n\nb`, 0)).toBe(`a\n\n${long}\n\nb`);
  });

  it('spends a budget of 4 Mi units, in pieces of 128 characters', () => {
    expect(MESSAGE_WORK_MAX).toBe(4 * 1024 * 1024);
    expect(LINE_PIECE_LENGTH).toBe(128);
  });

  describe('hostile input', () => {
    it.each([...HOSTILE, ...EMPHASIS_LINES])('strips %s in under 50 ms', (_name, text) => {
      expect(bestOf3(() => stripMarkdownBounded(text))).toBeLessThan(50);
    });

    it.each([
      ['lines of 1024 characters', 1024],
      ['lines of 200 characters', 200],
      ['lines just over the piece length', LINE_PIECE_LENGTH + 1],
    ])('strips 64 KiB of hostile %s in under 50 ms', (_name, length) => {
      const line = '*\\\\ '.repeat(length / 4).slice(0, length);
      const text = Array.from({ length: Math.floor(N / (length + 1)) }, () => line).join('\n');
      expect(bestOf3(() => stripMarkdownBounded(text))).toBeLessThan(50);
    });

    it.each([
      ['empty lines', `x${'\n'.repeat(N - 2)}x`],
      ['one-character lines', 'a\n'.repeat(N / 2)],
      ['lines and blank lines', 'a\n\n'.repeat(N / 3)],
      ['escaped characters', '\\*\n'.repeat(N / 3)],
      ['unclosed emphasis', '*a\n'.repeat(N / 3)],
      ['code spans', '`a`\n'.repeat(N / 4)],
    ])('strips 64 KiB of %s in under 50 ms', (_name, text) => {
      expect(bestOf3(() => stripMarkdownBounded(text))).toBeLessThan(50);
    });
  });
});

