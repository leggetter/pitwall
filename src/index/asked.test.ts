import { describe, expect, it } from 'vitest';
import { detectAskedYou, EXCERPT_MAX } from './asked.js';

// Synthetic messages only, written in the shapes Claude Code sessions end turns with.

const lines = (...parts: string[]) => parts.join('\n');

describe('detectAskedYou: an "Open questions" section', () => {
  it('is not asked when the section says None or N/A, in any of the usual spellings', () => {
    for (const text of [
      '**Open questions:** None',
      '**Open questions:** None.',
      'Open questions: none',
      '**Open questions**: None',
      '**Open question:** N/A',
      '- **Open questions:** None',
      '## Open questions\n\nNone.',
      '**Open questions:**\n- None',
      '**Open questions:** _None_',
      '**Open questions:**',
    ]) {
      expect(detectAskedYou(lines('Pushed the fix.', '', text)), text).toBeUndefined();
    }
  });

  it('is not asked for the house style: None, then next steps', () => {
    const text = lines(
      'Merged the branch and the build is green.',
      '',
      '**Open questions:** None',
      '',
      '**Next steps:**',
      '1. Coordinator merges the PR.',
      '2. Phil tries it.',
    );
    expect(detectAskedYou(text)).toBeUndefined();
  });

  it('lets the section decide, even when a later line ends with a question mark', () => {
    const text = lines('**Open questions:** None', '', '**Next steps:**', '1. Want me to open the PR?');
    expect(detectAskedYou(text)).toBeUndefined();
  });

  it('is asked when the section lists a question, with the first item as the excerpt', () => {
    const text = lines(
      'The fix is on the branch.',
      '',
      '**Open questions:**',
      '- Should I push it?',
      '- Which reviewer?',
      '',
      '**Next steps:**',
      '1. I push once you say so.',
    );
    expect(detectAskedYou(text)).toEqual({ reason: 'open-questions', excerpt: 'Should I push it?' });
  });

  it('is asked for an inline question', () => {
    expect(detectAskedYou('**Open questions:** Do you want X? Or should I wait for Y?')).toEqual({
      reason: 'open-questions',
      excerpt: 'Do you want X?',
    });
  });

  it('takes the first sentence of prose content', () => {
    const text = lines('## Open questions', '', 'I can merge now or after the release. Which do you prefer?');
    expect(detectAskedYou(text)).toEqual({ reason: 'open-questions', excerpt: 'I can merge now or after the release.' });
  });

  it('takes the first list item after a line that introduces the list', () => {
    const text = lines('**Open questions:** Two things:', '', '1. **Branch:** main or `release`?', '2. Squash?');
    expect(detectAskedYou(text)).toEqual({ reason: 'open-questions', excerpt: 'Branch: main or release?' });
  });

  it('keeps list items after a blank line, and stops at a blank line followed by prose', () => {
    const text = lines('**Open questions:**', '', '- Rename the flag?', '', 'Everything else is done.');
    expect(detectAskedYou(text)).toEqual({ reason: 'open-questions', excerpt: 'Rename the flag?' });

    const endsBeforeProse = lines('**Open questions:**', '', 'None', '', 'Should not be read as a question?');
    expect(detectAskedYou(endsBeforeProse)).toBeUndefined();
  });

  it('stops at a heading or a horizontal rule', () => {
    expect(detectAskedYou(lines('## Open questions', '## Next steps', '- Ask Phil?'))).toBeUndefined();
    expect(detectAskedYou(lines('**Open questions:**', '---', 'Anything else?'))).toBeUndefined();
  });

  it('treats a heading with more words as the label, not as content', () => {
    expect(detectAskedYou(lines('## Open questions for review', '', '- Keep the old flag?'))).toEqual({
      reason: 'open-questions',
      excerpt: 'Keep the old flag?',
    });
    expect(detectAskedYou(lines('## Open questions for review', '', 'None'))).toBeUndefined();
  });

  it('does not take prose that starts with the words as a label', () => {
    const text = lines('Open questions about the API remain, but I have answered them in the doc.', '', 'Done.');
    expect(detectAskedYou(text)).toBeUndefined();
  });

  it('uses the last section when there are several', () => {
    const text = lines('**Open questions:** Should I A?', '', 'Update: resolved.', '', '**Open questions:** None');
    expect(detectAskedYou(text)).toBeUndefined();
  });

  it('ignores a section inside a code block', () => {
    const text = lines('Here is the template:', '```md', '**Open questions:** Should I push?', '```', 'Done.');
    expect(detectAskedYou(text)).toBeUndefined();
  });

  it('is asked when the content is something other than None, even if it starts with it', () => {
    expect(detectAskedYou('**Open questions:** None that block the merge, but is v2 still planned?')?.reason).toBe(
      'open-questions',
    );
  });
});

describe('detectAskedYou: a question at the end', () => {
  it('is asked when the last line ends with a question mark', () => {
    expect(detectAskedYou(lines('All 12 tests pass.', '', 'Want me to open the PR?'))).toEqual({
      reason: 'question',
      excerpt: 'Want me to open the PR?',
    });
  });

  it('strips markdown from the excerpt', () => {
    expect(detectAskedYou('Shall I run **`npm publish`** now?')).toEqual({
      reason: 'question',
      excerpt: 'Shall I run npm publish now?',
    });
    expect(detectAskedYou('- Should I also update the [docs](https://example.com)?')).toEqual({
      reason: 'question',
      excerpt: 'Should I also update the docs?',
    });
  });

  it('allows closing quotes and brackets after the question mark', () => {
    for (const end of ['(or should I wait?)', 'Ask: "keep it?"', 'Ask: “keep it?”', '[merge now?]', '**Merge now?**']) {
      expect(detectAskedYou(lines('Done.', end))?.reason, end).toBe('question');
    }
  });

  it('is not asked when a statement comes after the question', () => {
    expect(detectAskedYou(lines('Should I push it?', '', 'I pushed it anyway; the PR is open.'))).toBeUndefined();
    expect(detectAskedYou('Is it fast? Yes: 20 ms.')).toBeUndefined();
  });

  it('ignores a question inside a code block', () => {
    expect(detectAskedYou(lines('Added the prompt:', '```', 'What is your name?', '```'))).toBeUndefined();
    expect(detectAskedYou(lines('Done.', '```', 'unclosed?'))).toBeUndefined();
  });

  it('reads the last line before a trailing code block', () => {
    expect(detectAskedYou(lines('Shall I run this?', '', '```sh', 'npm run release', '```'))).toEqual({
      reason: 'question',
      excerpt: 'Shall I run this?',
    });
  });

  it('skips trailing blank lines and lines that are only syntax', () => {
    expect(detectAskedYou('Ready to merge?\n\n---\n\n')?.excerpt).toBe('Ready to merge?');
  });

  it('is not asked for a statement, empty text or a question in a table cell', () => {
    expect(detectAskedYou('Done. The tests pass.')).toBeUndefined();
    expect(detectAskedYou('')).toBeUndefined();
    expect(detectAskedYou('| Q | A |\n|---|---|\n| Why? | Because |')).toBeUndefined();
  });

  it('caps the excerpt at 200 characters, on one line', () => {
    const asked = detectAskedYou(`${'word '.repeat(80)}ok?`);
    expect(asked?.excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(asked?.excerpt.endsWith('…')).toBe(true);

    const multi = detectAskedYou(lines('**Open questions:** Should I', 'keep   the old flag? Or drop it?'));
    expect(multi?.excerpt).toBe('Should I keep the old flag?');
  });

  it('leaves HTML in the excerpt as text', () => {
    expect(detectAskedYou('Render <b>this</b>?')?.excerpt).toBe('Render <b>this</b>?');
  });
});
