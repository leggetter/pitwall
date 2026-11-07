import { describe, expect, it } from 'vitest';
import { SPAWN_PROMPT_MAX, SPIN_OFF_FOLDER_MAX, SPIN_OFF_NAME_MAX } from '../shared/protocol.js';
import { detectSpinOff } from './spinOff.js';

// Made-up messages only, in the shape the spin-off skill (skills/spin-off/SKILL.md) asks for.

const HOME = '/home/dev';
const lines = (...parts: string[]) => parts.join('\n');
const block = (...body: string[]) => lines('```spin-off', ...body, '```');
const read = (text: string) => detectSpinOff(text, HOME);

describe('detectSpinOff', () => {
  it('reads the folder, the name and the prompt of a block that ends the message', () => {
    const text = lines('Done with the export.', '', block('folder: /home/dev/oss/demo-app', 'name: fix-export-test', 'prompt:', 'Fix the flaky export test.', '', 'Run npm test after.'));
    expect(read(text)).toEqual({
      kind: 'proposal',
      key: expect.stringMatching(/^[0-9a-f]{16}$/),
      folder: '/home/dev/oss/demo-app',
      name: 'fix-export-test',
      prompt: 'Fix the flaky export test.\n\nRun npm test after.',
    });
  });

  it('expands ~ to the home folder, and leaves the name out when there is none', () => {
    expect(read(block('folder: ~/oss/demo-app', 'prompt: Tidy the README.'))).toEqual({ kind: 'proposal', key: expect.any(String), folder: '/home/dev/oss/demo-app', prompt: 'Tidy the README.' });
    expect(read(block('folder: ~', 'name:', 'prompt:', 'Hi there.'))).toMatchObject({ folder: HOME, prompt: 'Hi there.' });
    expect(read(block('folder: ~', 'prompt:', 'Hi there.'))).not.toHaveProperty('name');
  });

  it('reads fields in any case and order, with blank lines between them', () => {
    expect(read(block('', 'Name: x', '', 'FOLDER: /tmp/x', 'Prompt:', '  indented line', ''))).toMatchObject({ folder: '/tmp/x', name: 'x', prompt: '  indented line' });
  });

  it('keeps a fence inside the prompt when the block uses a longer one', () => {
    const prompt = lines('Run this:', '```sh', 'npm test', '```', 'Then report.');
    expect(read(lines('````spin-off', 'folder: /tmp/x', 'prompt:', prompt, '````'))).toMatchObject({ prompt });
  });

  it('takes the fence’s own indent off each line', () => {
    expect(read(lines('- Next:', '  ```spin-off', '  folder: /tmp/x', '  prompt:', '  Line one.', '    Line two.', '  ```'))).toMatchObject({ prompt: 'Line one.\n  Line two.' });
  });

  it('accepts tildes and an info string in any case', () => {
    expect(read(lines('~~~Spin-Off', 'folder: /tmp/x', 'prompt: Go.', '~~~'))).toMatchObject({ kind: 'proposal', prompt: 'Go.' });
  });

  it('finds nothing without a block, or with one that doesn’t end the message', () => {
    expect(read('All done.')).toBeUndefined();
    expect(read(lines(block('folder: /tmp/x', 'prompt: Go.'), '', 'Start it from pitwall.'))).toBeUndefined();
    expect(read(lines('```sh', 'npm test', '```'))).toBeUndefined();
    // Only blank lines after it is still the end.
    expect(read(lines(block('folder: /tmp/x', 'prompt: Go.'), '', '  '))).toMatchObject({ kind: 'proposal' });
  });

  it('never reads a block quoted inside another fence', () => {
    const quoted = lines('````markdown', block('folder: /tmp/x', 'prompt: Go.'), '````');
    expect(read(quoted)).toBeUndefined();
  });

  it('reads the last block when there are two', () => {
    const text = lines(block('folder: /tmp/a', 'prompt: First.'), '', block('folder: /tmp/b', 'prompt: Second.'));
    expect(read(text)).toMatchObject({ folder: '/tmp/b', prompt: 'Second.' });
  });

  it('keys a proposal by its text', () => {
    const a = read(block('folder: /tmp/x', 'prompt: Go.'));
    expect(read(lines('Other words.', block('folder: /tmp/x', 'prompt: Go.')))?.key).toBe(a?.key);
    expect(read(block('folder: /tmp/x', 'prompt: Go now.'))?.key).not.toBe(a?.key);
  });

  describe('unreadable, with why in pitwall’s words and none of the block’s text', () => {
    const problem = (text: string) => {
      const found = read(text);
      expect(found?.kind).toBe('unreadable');
      return found?.kind === 'unreadable' ? found.problem : undefined;
    };

    it('a block with no closing fence', () => {
      expect(problem(lines('```spin-off', 'folder: /tmp/x', 'prompt: Go.'))).toMatch(/closing fence/);
    });

    it('a fence in the prompt that closed the block early, three backticks around three', () => {
      const early = lines('Done.', '', '```spin-off', 'folder: /tmp/x', 'prompt:', 'Run this:', '```bash', 'npm test', '```', 'Then fix it.', '```', '');
      expect(problem(early)).toMatch(/close early/);
      expect(problem(early.replace(/\n/g, '\r\n'))).toMatch(/close early/);
      // A block quoted earlier, then a stray fence of another kind with text in it, isn't this case.
      expect(read(lines(block('folder: /tmp/x', 'prompt: Go.'), 'More text.', '```', 'code'))).toBeUndefined();
    });

    it('no folder, no prompt line, an empty prompt', () => {
      expect(problem(block('prompt: Go.'))).toMatch(/no folder/);
      expect(problem(block('folder: /tmp/x', 'Go.'))).toMatch(/before prompt:/);
      expect(problem(block('folder: /tmp/x'))).toMatch(/no prompt: line/);
      expect(problem(block('folder: /tmp/x', 'prompt:', '', '  '))).toMatch(/empty/);
    });

    it('a line it doesn’t know, or a field twice', () => {
      expect(problem(block('folder: /tmp/x', 'model: opus', 'prompt: Go.'))).toMatch(/isn’t folder: or name:/);
      expect(problem(block('folder: /tmp/x', 'folder: /tmp/y', 'prompt: Go.'))).toMatch(/folder: twice/);
    });

    it('a relative folder', () => {
      expect(problem(block('folder: oss/demo-app', 'prompt: Go.'))).toMatch(/absolute/);
      expect(problem(block('folder: ~other/x', 'prompt: Go.'))).toMatch(/absolute/);
    });

    it('a field over its limit', () => {
      expect(problem(block(`folder: /${'a'.repeat(SPIN_OFF_FOLDER_MAX)}`, 'prompt: Go.'))).toMatch(/folder is over 1,024/);
      expect(problem(block('folder: /tmp/x', `name: ${'n'.repeat(SPIN_OFF_NAME_MAX + 1)}`, 'prompt: Go.'))).toMatch(/name is over 64/);
      expect(problem(block('folder: /tmp/x', 'prompt:', 'p'.repeat(SPAWN_PROMPT_MAX + 1)))).toMatch(/prompt is over 16,384/);
      expect(read(block('folder: /tmp/x', 'prompt:', 'p'.repeat(SPAWN_PROMPT_MAX)))).toMatchObject({ kind: 'proposal' });
    });

    it.each([
      ['a zero-width space in the prompt', block('folder: /tmp/x', 'prompt: Go​ now.')],
      ['a tag character in the prompt', block('folder: /tmp/x', 'prompt: Go \u{e0041}now.')],
      ['a bidi override in the folder', block('folder: /tmp/‮x', 'prompt: Go.')],
      ['an escape in the name', block('folder: /tmp/x', 'name: a\u001b[31mb', 'prompt: Go.')],
      ['a NUL in the prompt', block('folder: /tmp/x', 'prompt: Go\u0000.')],
    ])('%s', (_label, text) => {
      const found = problem(text);
      expect(found).toMatch(/doesn’t show as itself/);
      // Never the block's own text.
      expect(found).not.toMatch(/Go|tmp/);
    });
  });

  it('reads a hostile message quickly', () => {
    const many = '```spin-off\n'.repeat(5000) + '`'.repeat(60_000);
    const started = performance.now();
    read(many);
    read(block('folder: /tmp/x', 'prompt:', `${' '.repeat(60_000)}x`));
    // A fence line of 64 KiB of spaces with two words after them: seconds with the old opening regex (W164, F2).
    read(`\`\`\`${' '.repeat(65_000)}a b`);
    read(`\`\`\`spin-off${' '.repeat(65_000)}a b`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
