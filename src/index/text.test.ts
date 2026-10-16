import { describe, expect, it } from 'vitest';
import { cap, markFences, stripMarkdown, truncate } from './text.js';

// Synthetic text only.

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

  it('strips a typical end-of-turn message', () => {
    const message = [
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
    expect(stripMarkdown(message)).toBe(
      [
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
      ].join('\n'),
    );
  });
});
