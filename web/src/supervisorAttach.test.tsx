// Attach a file in the supervisor's message box (W135): what goes in the box, where, and what's refused.
// Made-up file names and text only.

import { describe, expect, it, vi } from 'vitest';
import { SUPERVISOR_TEXT_MAX } from './supervisor.js';
import { ATTACH_FILE_TEXT, attachFile, fewestCharacters, fileBlock, fileLabel, insertBlock } from './supervisorAttach.js';

const file = (parts: BlobPart[], name = 'notes.md') => new File(parts, name, { type: 'text/markdown' });

describe('fileBlock', () => {
  it('puts the name above the text, in a fence, without one trailing line break', () => {
    expect(fileBlock('notes.md', 'Line one\nLine two\n')).toBe('File: notes.md\n```\nLine one\nLine two\n```');
  });

  it('uses a fence longer than any run of backticks in the file', () => {
    expect(fileBlock('README.md', 'Run:\n```sh\nnpm test\n```\n')).toBe('File: README.md\n````\nRun:\n```sh\nnpm test\n```\n````');
    expect(fileBlock('a.md', 'x `````y')).toBe('File: a.md\n``````\nx `````y\n``````');
  });

  it('shows control characters in a name as spaces', () => {
    expect(fileLabel('two\nlines\u0007.txt')).toBe('two lines .txt');
    expect(fileLabel('\n')).toBe('file');
  });

  it('shows the characters that reorder text in a name as spaces', () => {
    expect(fileLabel('report\u202etxt.exe')).toBe('report txt.exe');
    expect(fileLabel('a\u2066b\u2069.md')).toBe('a b .md');
  });

  it('copes with more runs of backticks than a call takes arguments', () => {
    const text = '`a'.repeat(150_000);
    expect(fileBlock('many.md', text)).toBe(`File: many.md\n\`\`\`\n${text}\n\`\`\``);
  });
});

describe('insertBlock', () => {
  it('fills an empty box, with the caret on a new line below the file', () => {
    expect(insertBlock('', 'B')).toEqual({ text: 'B\n\n', caret: 3 });
  });

  it('goes at the end when there’s no caret, a blank line after the text', () => {
    expect(insertBlock('What do you make of this?', 'B')).toEqual({ text: 'What do you make of this?\n\nB\n\n', caret: 30 });
  });

  it('goes at the caret, keeping the text on either side, with a blank line between', () => {
    expect(insertBlock('Before.After.', 'B', 7)).toEqual({ text: 'Before.\n\nB\n\nAfter.', caret: 12 });
    expect(insertBlock('Before.\n\nAfter.', 'B', 9)).toEqual({ text: 'Before.\n\nB\n\nAfter.', caret: 12 });
    expect(insertBlock('Before.\nAfter.', 'B', 8)).toEqual({ text: 'Before.\n\nB\n\nAfter.', caret: 12 });
  });

  it('takes a caret past the end as the end', () => {
    expect(insertBlock('Hi', 'B', 99).text).toBe('Hi\n\nB\n\n');
  });
});

describe('attachFile', () => {
  it('reads a text file into the box, a byte-order mark dropped and Windows line breaks made \\n', async () => {
    const outcome = await attachFile(file([new Uint8Array([0xef, 0xbb, 0xbf]), 'One\r\nTwo – ✓\r\n']), 'Read this:', undefined);
    expect(outcome).toEqual({ ok: true, text: 'Read this:\n\nFile: notes.md\n```\nOne\nTwo – ✓\n```\n\n', caret: 48 });
  });

  it('refuses a file that isn’t UTF-8', async () => {
    const outcome = await attachFile(file([new Uint8Array([0x68, 0x69, 0xff, 0xfe])], 'latin1.txt'), '');
    expect(outcome).toEqual({ ok: false, error: `Couldn't attach latin1.txt. ${ATTACH_FILE_TEXT.notText}` });
  });

  it('refuses a file with a NUL byte, though it decodes', async () => {
    const outcome = await attachFile(file(['text\u0000more'], 'odd.txt'), '');
    expect(outcome).toEqual({ ok: false, error: `Couldn't attach odd.txt. ${ATTACH_FILE_TEXT.nul}` });
  });

  it('refuses an empty file, and one of blank space', async () => {
    expect(await attachFile(file([]), '')).toEqual({ ok: false, error: `Couldn't attach notes.md. ${ATTACH_FILE_TEXT.empty}` });
    expect(await attachFile(file([' \n\n']), '')).toEqual({ ok: false, error: `Couldn't attach notes.md. ${ATTACH_FILE_TEXT.blank}` });
  });

  it('refuses one too big for the limit by its size, without reading it', async () => {
    const big = file(['x'.repeat(3 * SUPERVISOR_TEXT_MAX + 6)], 'huge.log');
    const read = vi.spyOn(big, 'arrayBuffer');
    const outcome = await attachFile(big, '');
    expect(read).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, error: "Couldn't attach huge.log. At 293 KB, it's longer than a message can be: the limit is 100,000 characters." });
    const inFull = await attachFile(file(['x'.repeat(10)], 'small.txt'), 'y'.repeat(SUPERVISOR_TEXT_MAX - 2));
    expect(inFull).toEqual({ ok: false, error: "Couldn't attach small.txt. At 10 B, it's longer than the 2 characters left in this message: the limit is 100,000." });
  });

  it('refuses one that, read, would take the message over the limit with what’s in the box', async () => {
    const outcome = await attachFile(file(['x'.repeat(1_000)]), 'y'.repeat(SUPERVISOR_TEXT_MAX - 1_000));
    // The name's line, the fences and the blank line between: 2 + 15 + 4 + 4 characters, plus the file's 1,000.
    expect(outcome).toEqual({ ok: false, error: "Couldn't attach notes.md. With it, the message would be 25 characters over the 100,000 limit." });
  });

  it('takes a file that fits the limit exactly', async () => {
    const outcome = await attachFile(file(['x'.repeat(SUPERVISOR_TEXT_MAX - 'File: notes.md\n```\n\n```'.length)]), '');
    expect(outcome.ok).toBe(true);
  });

  it('says so when the browser can’t read it', async () => {
    const broken = file(['text'], 'gone.txt');
    vi.spyOn(broken, 'arrayBuffer').mockRejectedValue(new DOMException('Gone', 'NotFoundError'));
    expect(await attachFile(broken, '')).toEqual({ ok: false, error: `Couldn't attach gone.txt. ${ATTACH_FILE_TEXT.unreadable}` });
  });

  it('counts at least a third of the bytes as characters, less a byte-order mark', () => {
    expect(fewestCharacters(0)).toBe(0);
    expect(fewestCharacters(3)).toBe(0);
    expect(fewestCharacters(4)).toBe(1);
    expect(fewestCharacters(300_003)).toBe(100_000);
  });
});
