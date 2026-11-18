// The transcript side of session lineage (W167), from made-up transcripts in a temporary config directory.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanBranch, cleanCwd, findTranscript, OPENING_BYTES, parseOpening, readOpening } from './lineageSources.js';

const ID = '11111111-1111-4111-8111-111111111111';
const CLEAR = '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';

const entry = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;

describe('parseOpening', () => {
  it('sees /clear in one of the first user entries, and takes the cwd and branch', () => {
    const text =
      entry({ type: 'mode', mode: 'normal' }) +
      entry({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: local commands' }, cwd: '/tmp/pitwall-test-root/repo', gitBranch: 'feat/x' }) +
      entry({ type: 'user', message: { role: 'user', content: CLEAR } });
    expect(parseOpening(text)).toEqual({ clear: true, cwd: '/tmp/pitwall-test-root/repo', branch: 'feat/x' });
  });

  it('reads a content array, and a system entry', () => {
    expect(parseOpening(entry({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: CLEAR }] } })).clear).toBe(true);
    expect(parseOpening(entry({ type: 'system', subtype: 'local_command', content: CLEAR })).clear).toBe(true);
  });

  it('does not take a transcript that mentions /clear later, or one that opens with a prompt', () => {
    const prompts = Array.from({ length: 4 }, (_, i) => entry({ type: 'user', message: { role: 'user', content: i === 3 ? CLEAR : `prompt ${i}` } })).join('');
    expect(parseOpening(prompts).clear).toBe(false);
    expect(parseOpening(entry({ type: 'user', message: { role: 'user', content: 'Please explain /clear' } })).clear).toBe(false);
  });

  it('drops a cut last line, and skips lines that are not JSON', () => {
    const text = `not json\n${entry({ type: 'user', message: { role: 'user', content: 'hello' } })}{"type":"user","message":{"content":"${CLEAR.slice(0, 20)}`;
    expect(parseOpening(text)).toEqual({ clear: false });
  });

  it('leaves out a cwd or branch that is not clean', () => {
    expect(cleanCwd('relative/path')).toBeUndefined();
    expect(cleanCwd('/tmp/a‮b')).toBeUndefined();
    expect(cleanCwd(`/${'a'.repeat(600)}`)).toBeUndefined();
    expect(cleanBranch('feat/ok')).toBe('feat/ok');
    expect(cleanBranch('bad\nbranch')).toBeUndefined();
    expect(cleanBranch('')).toBeUndefined();
  });
});

describe('findTranscript and readOpening', () => {
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), 'pitwall-test-lineage-sources-'));
  });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  const put = (folder: string, id: string, text: string) => {
    mkdirSync(path.join(configDir, 'projects', folder), { recursive: true });
    const file = path.join(configDir, 'projects', folder, `${id}.jsonl`);
    writeFileSync(file, text);
    return file;
  };

  it('finds a transcript by the cwd it encodes to, then by searching every project folder', async () => {
    const file = put('-tmp-pitwall-test-root-repo', ID, entry({ type: 'user', message: { content: CLEAR } }));
    expect(await findTranscript(ID, ['/tmp/pitwall-test-root/repo'], { configDir })).toBe(file);
    expect(await findTranscript(ID, ['/somewhere/else'], { configDir })).toBe(file);
    expect(await findTranscript(ID, [], { configDir })).toBe(file);
  });

  it('only looks for a canonical UUID, so an id never becomes a path', async () => {
    put('-tmp-x', 'deploy', '');
    expect(await findTranscript('deploy', [], { configDir })).toBeUndefined();
    expect(await findTranscript('../../etc/passwd', [], { configDir })).toBeUndefined();
    expect(await findTranscript('22222222-2222-4222-8222-222222222222', [], { configDir })).toBeUndefined();
  });

  it('reads the opening of a file, within OPENING_BYTES, and fails soft', async () => {
    const big = entry({ type: 'file-history-snapshot', snapshot: 'x'.repeat(OPENING_BYTES) }) + entry({ type: 'user', message: { content: CLEAR } });
    expect((await readOpening(put('-a', ID, big)))?.clear).toBe(false);
    expect((await readOpening(put('-b', '33333333-3333-4333-8333-333333333333', entry({ type: 'user', message: { content: CLEAR } }))))?.clear).toBe(true);
    expect(await readOpening(path.join(configDir, 'nope.jsonl'))).toBeUndefined();
    expect(await readOpening(configDir)).toBeUndefined();
  });
});
