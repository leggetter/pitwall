import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_SETTLE_MS, createJobReader, JOB_FILE_MAX_BYTES, NEEDS_MAX, needsText, parseJobState } from './jobs.js';

// Synthetic job folders, shaped like Claude Code 2.1.311's `~/.claude/jobs/<shortId>/state.json`
// (spike 007, finding 1). Made up: never a real job's file.

const SID = '77777777-7777-4777-8777-777777777777';
const SHORT = 'a6f62031';

function state(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ sessionId: SID, state: 'blocked', tempo: 'blocked', detail: 'a made-up detail', ...fields });
}

describe('parseJobState', () => {
  it("takes the job's needs line", () => {
    expect(parseJobState(state({ needs: 'Do you prefer tea or coffee?' }), SID)).toEqual({ kind: 'needs', text: 'Do you prefer tea or coffee?' });
  });

  it('is none for a file with no line, an empty one, or null', () => {
    expect(parseJobState(state(), SID)).toEqual({ kind: 'none' });
    expect(parseJobState(state({ needs: '' }), SID)).toEqual({ kind: 'none' });
    expect(parseJobState(state({ needs: '  \n\t ' }), SID)).toEqual({ kind: 'none' });
    expect(parseJobState(state({ needs: null }), SID)).toEqual({ kind: 'none' });
  });

  it('is none for the start placeholder, trimmed and in any case (spike 006, finding 2)', () => {
    for (const needs of ['send a prompt to start', '  Send a prompt to start\n', 'SEND A PROMPT TO START']) {
      expect(parseJobState(state({ needs }), SID), needs).toEqual({ kind: 'none' });
    }
    // Only the placeholder itself: a line that says more is an ask.
    expect(parseJobState(state({ needs: 'send a prompt to start the migration?' }), SID)).toEqual({
      kind: 'needs',
      text: 'send a prompt to start the migration?',
    });
  });

  it("is unknown for a file written for another session, or that doesn't name one", () => {
    expect(parseJobState(state({ sessionId: '88888888-8888-4888-8888-888888888888', needs: 'Tea?' }), SID)).toEqual({ kind: 'unknown' });
    expect(parseJobState(JSON.stringify({ needs: 'Tea?' }), SID)).toEqual({ kind: 'unknown' });
    expect(parseJobState(state({ sessionId: 42 }), SID)).toEqual({ kind: 'unknown' });
  });

  it("is unknown for a file that isn't a JSON object, or whose line isn't a string", () => {
    for (const text of ['', '{', 'not json', '[]', 'null', '"a string"', '42']) {
      expect(parseJobState(text, SID), text).toEqual({ kind: 'unknown' });
    }
    expect(parseJobState(state({ needs: 42 }), SID)).toEqual({ kind: 'unknown' });
    expect(parseJobState(state({ needs: { text: 'Tea?' } }), SID)).toEqual({ kind: 'unknown' });
  });
});

describe('needsText', () => {
  it('trims, and puts the line on one line', () => {
    expect(needsText('  Which\nbranch,\tmain\r\nor next?  ')).toBe('Which branch, main or next?');
  });

  it('removes control characters and terminal escapes', () => {
    expect(needsText('\u001b[31mRed\u001b[0m alert\u0007 \u0000now\u007f\u0085?')).toBe('Red alert now?');
    expect(needsText('\u001b]0;a title\u0007Pick one?')).toBe('Pick one?');
  });

  it('removes bidi marks, embeddings, overrides and isolates, so the line reads as it is', () => {
    const bidi = ['\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069'];
    expect(needsText(`Run ${bidi.join('')}the made-up check?`)).toBe('Run the made-up check?');
    expect(needsText('Open \u202egnp.exe\u202c?')).toBe('Open gnp.exe?');
  });

  it(`cuts the line to ${NEEDS_MAX} characters`, () => {
    const cut = needsText(`${'word '.repeat(100)}end?`);
    expect(cut.length).toBeLessThanOrEqual(NEEDS_MAX);
    expect(cut.endsWith('…')).toBe(true);
    expect(needsText('x'.repeat(1_000_000)).length).toBe(NEEDS_MAX);
  });
});

describe('createJobReader', () => {
  let jobsDir: string;

  beforeEach(async () => {
    jobsDir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-jobs-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await chmod(path.join(jobsDir, SHORT, 'state.json'), 0o600).catch(() => undefined);
    await rm(jobsDir, { recursive: true, force: true });
  });

  async function writeJob(text: string, shortId = SHORT): Promise<string> {
    const folder = path.join(jobsDir, shortId);
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, 'state.json');
    await writeFile(file, text);
    return file;
  }

  it("reads a job's line from its folder", async () => {
    await writeJob(state({ needs: 'Do you prefer tea or coffee?' }));
    expect(await createJobReader({ jobsDir }).read(SHORT, SID)).toEqual({ kind: 'needs', text: 'Do you prefer tea or coffee?' });
  });

  it('is unknown for a missing file or folder, never throwing', async () => {
    const reader = createJobReader({ jobsDir });
    expect(await reader.read(SHORT, SID)).toEqual({ kind: 'unknown' });
    expect(await createJobReader({ jobsDir: path.join(jobsDir, 'nowhere') }).read(SHORT, SID)).toEqual({ kind: 'unknown' });
  });

  it('is unknown for a file it cannot read, one that is a folder, and one that is too big', async () => {
    const file = await writeJob(state({ needs: 'Tea?' }));
    if (process.getuid?.() !== 0) {
      await chmod(file, 0o000);
      expect(await createJobReader({ jobsDir }).read(SHORT, SID)).toEqual({ kind: 'unknown' });
      await chmod(file, 0o600);
    }
    await mkdir(path.join(jobsDir, 'folder1', 'state.json'), { recursive: true });
    expect(await createJobReader({ jobsDir }).read('folder1', SID)).toEqual({ kind: 'unknown' });
    await writeJob(state({ needs: 'Tea?', padding: 'x'.repeat(JOB_FILE_MAX_BYTES) }), 'big1');
    expect(await createJobReader({ jobsDir }).read('big1', SID)).toEqual({ kind: 'unknown' });
  });

  it('is unknown for a malformed file, or one for another session', async () => {
    await writeJob('{"sessionId": "77777777-');
    expect(await createJobReader({ jobsDir }).read(SHORT, SID)).toEqual({ kind: 'unknown' });
    await writeJob(state({ needs: 'Tea?' }));
    expect(await createJobReader({ jobsDir }).read(SHORT, '88888888-8888-4888-8888-888888888888')).toEqual({ kind: 'unknown' });
  });

  it("never reads outside its directory: a short id that isn't one safe folder name is unknown", async () => {
    await writeFile(path.join(jobsDir, 'state.json'), state({ needs: 'Tea?' }));
    const reader = createJobReader({ jobsDir: path.join(jobsDir, 'jobs') });
    for (const shortId of ['', '.', '..', '../x', 'a/b', '-rf', 'a\u0000b']) {
      expect(await reader.read(shortId, SID), JSON.stringify(shortId)).toEqual({ kind: 'unknown' });
    }
  });

  /** Sets a file's mtime, in ms since the epoch. */
  const touch = (file: string, ms: number) => utimes(file, new Date(ms), new Date(ms));

  it("doesn't parse a file again while its size and mtime are unchanged", async () => {
    const file = await writeJob(state({ needs: 'Tea or coffee?' }));
    const written = Date.parse('2026-10-27T12:00:00.000Z');
    await touch(file, written);
    const reader = createJobReader({ jobsDir, now: () => written + 60_000 });
    const parse = vi.spyOn(JSON, 'parse');
    expect(await reader.read(SHORT, SID)).toEqual({ kind: 'needs', text: 'Tea or coffee?' });
    expect(await reader.read(SHORT, SID)).toEqual({ kind: 'needs', text: 'Tea or coffee?' });
    expect(parse).toHaveBeenCalledTimes(1);

    // The same size, a new mtime: read again.
    await writeFile(file, state({ needs: 'Tea or juice??' }));
    await touch(file, written + 1000);
    expect(await reader.read(SHORT, SID)).toEqual({ kind: 'needs', text: 'Tea or juice??' });
    expect(parse).toHaveBeenCalledTimes(2);

    // A stop clears the line (spike 007, finding 3).
    await writeFile(file, state({ state: 'stopped', detail: 'stopped' }));
    await touch(file, written + 2000);
    expect(await reader.read(SHORT, SID)).toEqual({ kind: 'none' });
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it(`parses a file changed in the last ${CACHE_SETTLE_MS} ms again, so a same-size rewrite in one mtime tick isn't missed`, async () => {
    const file = await writeJob(state({ needs: 'Tea or coffee?' }));
    const written = Date.parse('2026-10-27T12:00:00.000Z');
    await touch(file, written);
    let now = written + 500;
    const reader = createJobReader({ jobsDir, now: () => now });
    expect(await reader.read(SHORT, SID)).toEqual({ kind: 'needs', text: 'Tea or coffee?' });
    // Rewritten at the same size, its mtime the same as before.
    await writeFile(file, state({ needs: 'Tea or juice??' }));
    await touch(file, written);
    expect(await reader.read(SHORT, SID)).toEqual({ kind: 'needs', text: 'Tea or juice??' });
    // Once it has settled, the cache holds: no parse at all.
    now = written + CACHE_SETTLE_MS;
    const parse = vi.spyOn(JSON, 'parse');
    expect(await reader.read(SHORT, SID)).toEqual({ kind: 'needs', text: 'Tea or juice??' });
    expect(await reader.read(SHORT, SID)).toEqual({ kind: 'needs', text: 'Tea or juice??' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('is unknown at once for a FIFO, rather than waiting for a writer that never comes', async () => {
    await mkdir(path.join(jobsDir, SHORT), { recursive: true });
    execFileSync('mkfifo', [path.join(jobsDir, SHORT, 'state.json')]);
    const started = performance.now();
    expect(await createJobReader({ jobsDir }).read(SHORT, SID)).toEqual({ kind: 'unknown' });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('is unknown for a state.json that is a symlink, and for a job folder that is one', async () => {
    const elsewhere = path.join(jobsDir, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, 'state.json'), state({ needs: 'Tea?' }));
    await mkdir(path.join(jobsDir, 'link1'));
    await symlink(path.join(elsewhere, 'state.json'), path.join(jobsDir, 'link1', 'state.json'));
    expect(await createJobReader({ jobsDir }).read('link1', SID)).toEqual({ kind: 'unknown' });
    await symlink(elsewhere, path.join(jobsDir, 'link2'));
    expect(await createJobReader({ jobsDir }).read('link2', SID)).toEqual({ kind: 'unknown' });
    // The real folder itself reads.
    expect(await createJobReader({ jobsDir }).read('elsewhere', SID)).toEqual({ kind: 'needs', text: 'Tea?' });
  });

  it('reads through a jobs folder that is itself a symlink, as a linked ~/.claude is', async () => {
    await writeJob(state({ needs: 'Tea?' }));
    const linked = `${jobsDir}-link`;
    await symlink(jobsDir, linked);
    try {
      expect(await createJobReader({ jobsDir: linked }).read(SHORT, SID)).toEqual({ kind: 'needs', text: 'Tea?' });
    } finally {
      await rm(linked, { force: true });
    }
  });

  it('checks the session id on every read, cached or not', async () => {
    await writeJob(state({ needs: 'Tea?' }));
    const reader = createJobReader({ jobsDir });
    expect(await reader.read(SHORT, SID)).toEqual({ kind: 'needs', text: 'Tea?' });
    expect(await reader.read(SHORT, '88888888-8888-4888-8888-888888888888')).toEqual({ kind: 'unknown' });
    expect(await reader.read(SHORT, SID)).toEqual({ kind: 'needs', text: 'Tea?' });
  });

  it('forgets a job not retained, so it is parsed again when it comes back', async () => {
    const file = await writeJob(state({ needs: 'Tea?' }));
    await touch(file, Date.parse('2026-10-27T12:00:00.000Z'));
    const reader = createJobReader({ jobsDir });
    const parse = vi.spyOn(JSON, 'parse');
    await reader.read(SHORT, SID);
    reader.retain(new Set([SHORT]));
    await reader.read(SHORT, SID);
    expect(parse).toHaveBeenCalledTimes(1);
    reader.retain(new Set());
    await reader.read(SHORT, SID);
    expect(parse).toHaveBeenCalledTimes(2);
  });
});
