// The transcript side of session lineage (W167), from made-up transcripts in a temporary config directory.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanBranch, cleanCwd, findTranscript, OPENING_BYTES, parseDerivedFrom, parseOpening, readDerivedFrom, readOpening } from './lineageSources.js';

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

describe('parseDerivedFrom and readDerivedFrom (W218)', () => {
  const LAUNCHER = '22222222-2222-4222-8222-222222222222';
  const BEFORE = '33333333-3333-4333-8333-333333333333';
  const derived = (sessions: unknown[], overrides: Record<string, unknown> = {}) =>
    entry({ type: 'derived-from', v: 1, sessionId: ID, sessions, ...overrides });
  const launch = (id: string) => ({ type: 'claude_code_session', id, via: 'launch', started: ID });
  const clear = (id: string) => ({ type: 'claude_code_session', id, via: 'clear', started: ID });

  it('reads the launcher and the session before /clear, ids only', () => {
    expect(parseDerivedFrom(derived([launch(LAUNCHER)]), ID)).toEqual({ launchedBy: LAUNCHER });
    expect(parseDerivedFrom(derived([clear(BEFORE)]), ID)).toEqual({ clearedFrom: BEFORE });
    expect(parseDerivedFrom(entry({ type: 'user', message: { content: 'hi' } }) + derived([clear(BEFORE), launch(LAUNCHER)]), ID)).toEqual({ launchedBy: LAUNCHER, clearedFrom: BEFORE });
    // The first of each kind wins.
    expect(parseDerivedFrom(derived([launch(LAUNCHER), launch(BEFORE)]), ID)).toEqual({ launchedBy: LAUNCHER });
  });

  it('skips an entry for another session, another version, or with no sessions', () => {
    expect(parseDerivedFrom(derived([launch(LAUNCHER)], { sessionId: BEFORE }), ID)).toBeUndefined();
    expect(parseDerivedFrom(derived([launch(LAUNCHER)], { v: 2 }), ID)).toBeUndefined();
    expect(parseDerivedFrom(derived([launch(LAUNCHER)], { v: '1' }), ID)).toBeUndefined();
    expect(parseDerivedFrom(derived([launch(LAUNCHER)], { type: 'derived' }), ID)).toBeUndefined();
    expect(parseDerivedFrom(entry({ type: 'derived-from', v: 1, sessionId: ID, sessions: { 0: launch(LAUNCHER) } }), ID)).toBeUndefined();
    // A wrong entry first doesn't hide the right one after it.
    expect(parseDerivedFrom(derived([launch(BEFORE)], { sessionId: BEFORE }) + derived([launch(LAUNCHER)]), ID)).toEqual({ launchedBy: LAUNCHER });
  });

  it('takes only canonical UUIDs other than its own, of the session type and a known via', () => {
    const odd = [
      { ...launch(LAUNCHER), id: '../../etc/passwd' },
      { ...launch(LAUNCHER), id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
      { ...launch(LAUNCHER), id: `${LAUNCHER} ` },
      { ...launch(LAUNCHER), id: 42 },
      { ...launch(LAUNCHER), id: ID },
      { ...launch(LAUNCHER), type: 'other' },
      { ...launch(LAUNCHER), via: 'fork' },
      null,
      'x',
    ];
    for (const each of odd) expect(parseDerivedFrom(derived([each]), ID), JSON.stringify(each)).toEqual({});
    expect(parseDerivedFrom(derived([launch(LAUNCHER)]), 'not-a-uuid')).toBeUndefined();
  });

  it('looks at the first four sessions only', () => {
    const filler = { type: 'claude_code_session', id: BEFORE, via: 'fork' };
    expect(parseDerivedFrom(derived([filler, filler, filler, launch(LAUNCHER)]), ID)).toEqual({ launchedBy: LAUNCHER });
    expect(parseDerivedFrom(derived([filler, filler, filler, filler, launch(LAUNCHER)]), ID)).toEqual({});
  });

  it('skips malformed JSON and a cut last line', () => {
    expect(parseDerivedFrom('{"type":"derived-from",\n' + derived([launch(LAUNCHER)]), ID)).toEqual({ launchedBy: LAUNCHER });
    expect(parseDerivedFrom(derived([launch(LAUNCHER)]).trimEnd(), ID)).toBeUndefined();
    expect(parseDerivedFrom('', ID)).toBeUndefined();
  });

  describe('from a file', () => {
    let configDir: string;
    beforeEach(() => {
      configDir = mkdtempSync(path.join(tmpdir(), 'pitwall-test-derived-from-'));
    });
    afterEach(() => rmSync(configDir, { recursive: true, force: true }));
    const put = (name: string, text: string) => {
      const file = path.join(configDir, name);
      writeFileSync(file, text);
      return file;
    };

    it('reads the entry in the first OPENING_BYTES, {} without one, and undefined for no file', async () => {
      expect(await readDerivedFrom(put('a.jsonl', derived([launch(LAUNCHER)])), ID)).toEqual({ launchedBy: LAUNCHER });
      expect(await readDerivedFrom(put('b.jsonl', entry({ type: 'user', message: { content: 'hi' } })), ID)).toEqual({});
      expect(await readDerivedFrom(path.join(configDir, 'nope.jsonl'), ID)).toBeUndefined();
      expect(await readDerivedFrom(configDir, ID)).toBeUndefined();
    });

    it('never reads past OPENING_BYTES: a huge first line hides an entry after it', async () => {
      const huge = entry({ type: 'file-history-snapshot', snapshot: 'x'.repeat(OPENING_BYTES) });
      expect(await readDerivedFrom(put('huge.jsonl', huge + derived([launch(LAUNCHER)])), ID)).toEqual({});
      const nearly = entry({ type: 'file-history-snapshot', snapshot: 'x'.repeat(OPENING_BYTES - 200) });
      expect(await readDerivedFrom(put('near.jsonl', nearly + derived([launch(LAUNCHER)])), ID)).toEqual({});
    });

    it('does not follow a symlink', async () => {
      const real = put('real.jsonl', derived([launch(LAUNCHER)]));
      const link = path.join(configDir, 'link.jsonl');
      symlinkSync(real, link);
      expect(await readDerivedFrom(link, ID)).toBeUndefined();
    });
  });
});
