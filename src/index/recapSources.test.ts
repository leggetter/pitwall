// What a recap reads from a transcript besides its latest turns (M5, W110, spike 010's finding 2):
// the first prompt, the newest away_summary and the newest compaction summary, read forward, read
// backwards, and then only what was appended. Every transcript here is made up.
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compactionOf, createRecapSourceReader, SOURCE_TEXT_MAX } from './recapSources.js';

let tmp: string;
let n = 0;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-recap-sources-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let clock = Date.parse('2026-10-28T10:00:00.000Z');
const time = () => new Date((clock += 1000)).toISOString();
const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;
const user = (content: unknown, extra: Record<string, unknown> = {}) => line({ type: 'user', message: { role: 'user', content }, timestamp: time(), ...extra });
const assistant = (text: string) => line({ type: 'assistant', message: { id: `m${++n}`, role: 'assistant', content: [{ type: 'text', text }] }, timestamp: time() });
const away = (content: string, extra: Record<string, unknown> = {}) => line({ type: 'system', subtype: 'away_summary', content, timestamp: time(), ...extra });
const compaction = (content: string) => line({ type: 'user', isCompactSummary: true, message: { role: 'user', content }, timestamp: time() });
const filler = (bytes: number) => line({ type: 'progress', data: 'f'.repeat(bytes) });

async function transcript(...lines: string[]): Promise<string> {
  const file = join(tmp, `t-${++n}.jsonl`);
  await writeFile(file, lines.join(''));
  return file;
}

describe('createRecapSourceReader', () => {
  it('finds the first prompt the user typed, past meta entries, tool results and messages from other sessions', async () => {
    const file = await transcript(
      user('<command-name>/model</command-name>'),
      user('a reminder', { isMeta: true }),
      user([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]),
      user('Another Claude session sent a message: hi', { origin: { kind: 'peer' } }),
      user('  Fix the nightly export.  '),
      assistant('On it.'),
      user('a later prompt'),
    );
    expect(await createRecapSourceReader().read(file)).toEqual({ firstPrompt: 'Fix the nightly export.' });
  });

  it('takes a prompt queued mid-turn as the first (W99)', async () => {
    const queued = line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: 'Queued first' }, timestamp: time() });
    expect((await createRecapSourceReader().read(await transcript(queued, user('second')))).firstPrompt).toBe('Queued first');
  });

  it('finds the newest away_summary and compaction summary, reading back from the end', async () => {
    const file = await transcript(
      user('go'),
      compaction('1. Primary Request and Intent:\nold'),
      away('An older recap.'),
      assistant('work'),
      compaction('1. Primary Request and Intent:\nnewer<system-reminder>hidden</system-reminder>'),
      away('The newest recap.'),
      away('A sub-agent’s', { isSidechain: true }),
      assistant('more work'),
    );
    const read = await createRecapSourceReader().read(file);
    expect(read.awaySummary?.text).toBe('The newest recap.');
    expect(read.awaySummary?.at).toMatch(/^2026-10-28T/);
    expect(read.compaction?.text).toBe('1. Primary Request and Intent:\nnewer');
    expect(read.compaction?.at).toMatch(/^2026-10-28T/);
  });

  it('reads only what was appended since, and newer entries replace what it kept', async () => {
    const file = await transcript(user('first'), away('one'), assistant('a'));
    const reader = createRecapSourceReader({ chunkBytes: 64 });
    expect((await reader.read(file)).awaySummary?.text).toBe('one');
    await appendFile(file, away('two') + compaction('summary'));
    const read = await reader.read(file);
    expect(read).toMatchObject({ firstPrompt: 'first', awaySummary: { text: 'two' }, compaction: { text: 'summary' } });
    // An incomplete last line is read once it's finished.
    const half = away('three');
    await appendFile(file, half.slice(0, 20));
    expect((await reader.read(file)).awaySummary?.text).toBe('two');
    await appendFile(file, half.slice(20));
    expect((await reader.read(file)).awaySummary?.text).toBe('three');
  });

  it('reads a file afresh once it was replaced or shrank', async () => {
    const file = await transcript(user('first'), away('one'), filler(200));
    const reader = createRecapSourceReader();
    expect((await reader.read(file)).awaySummary?.text).toBe('one');
    await writeFile(file, user('another') + away('replaced'));
    expect(await reader.read(file)).toMatchObject({ firstPrompt: 'another', awaySummary: { text: 'replaced' } });
  });

  it('looks back only so far for the newest entries, and forward only so far for the first prompt', async () => {
    const file = await transcript(filler(5000), user('late first prompt'), away('far back'), filler(5000));
    const read = await createRecapSourceReader({ newestBudget: 2000, firstPromptBudget: 2000, chunkBytes: 512 }).read(file);
    expect(read).toEqual({});
    expect(await createRecapSourceReader({ chunkBytes: 512 }).read(file)).toMatchObject({ firstPrompt: 'late first prompt', awaySummary: { text: 'far back' } });
  });

  it('finds entries across chunk boundaries, and on the first line', async () => {
    const file = await transcript(away('on the first line'), filler(3000), user('p'), filler(3000));
    for (const chunkBytes of [1, 7, 100, 4096]) {
      expect(await createRecapSourceReader({ chunkBytes }).read(file), String(chunkBytes)).toMatchObject({ firstPrompt: 'p', awaySummary: { text: 'on the first line' } });
    }
  });

  it('fails soft: a missing file, a directory, or lines that are not JSON give nothing', async () => {
    const reader = createRecapSourceReader();
    expect(await reader.read(join(tmp, 'missing.jsonl'))).toEqual({});
    const dir = join(tmp, 'a-directory');
    await mkdir(dir);
    expect(await reader.read(dir)).toEqual({});
    expect(await reader.read(await transcript('{not json\n', '"away_summary" but broken\n', line({ type: 'system', subtype: 'away_summary', content: 7 })))).toEqual({});
  });

  it('keeps a long first prompt or compaction summary to SOURCE_TEXT_MAX, its start and end', async () => {
    const long = `BEGIN ${'x'.repeat(SOURCE_TEXT_MAX * 2)} FINISH`;
    const read = await createRecapSourceReader().read(await transcript(user(long), compaction(long)));
    for (const text of [read.firstPrompt!, read.compaction!.text]) {
      expect(text.length).toBeLessThanOrEqual(SOURCE_TEXT_MAX);
      expect(text.startsWith('BEGIN')).toBe(true);
      expect(text.endsWith('FINISH')).toBe(true);
    }
  });

  it("forgets files it's no longer told to keep", async () => {
    const file = await transcript(user('first'), away('one'));
    const reader = createRecapSourceReader();
    await reader.read(file);
    reader.retain(new Set());
    await writeFile(file, user('first') + away('rewritten in place'));
    expect((await reader.read(file)).awaySummary?.text).toBe('rewritten in place');
  });
});

describe('compactionOf', () => {
  it("reads a compaction summary's entry, and nothing else", () => {
    expect(compactionOf({ type: 'user', isCompactSummary: true, message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } })).toEqual({ text: 'a\nb' });
    expect(compactionOf({ type: 'user', message: { content: 'a' } })).toBeUndefined();
    expect(compactionOf({ type: 'user', isCompactSummary: true, isSidechain: true, message: { content: 'a' } })).toBeUndefined();
    expect(compactionOf({ type: 'assistant', isCompactSummary: true, message: { content: 'a' } })).toBeUndefined();
    expect(compactionOf({ type: 'user', isCompactSummary: true, message: { content: '   ' } })).toBeUndefined();
  });
});
