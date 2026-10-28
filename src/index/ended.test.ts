// The ended-session scanner (W66, spike 006) over made-up transcripts in a temporary config
// directory. Nothing here reads the real ~/.claude or runs `claude`.
import { appendFile, chmod, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENDED_LISTED_DAYS, ENDED_LISTED_MAX } from '../shared/protocol.js';
import { createEndedScanner, endedDefaultName, ENDED_LISTED_MS, ENDED_RESCAN_MS, type EndedScanner, type EndedScannerOptions } from './ended.js';
import { encodeProjectDir } from './transcripts.js';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const NONE: ReadonlySet<string> = new Set();

let tmp: string;
let configDir: string;
let work: string;
let oss: string;
let app: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-ended-')));
  configDir = path.join(tmp, 'claude');
  work = path.join(tmp, 'work');
  oss = path.join(tmp, 'oss');
  app = path.join(work, 'app');
  await mkdir(path.join(configDir, 'projects'), { recursive: true });
  await mkdir(path.join(app, 'packages', 'ui'), { recursive: true });
  await mkdir(path.join(oss, 'lib'), { recursive: true });
  await mkdir(path.join(tmp, 'elsewhere'), { recursive: true });
});

afterEach(async () => {
  await chmod(path.join(configDir, 'projects'), 0o755).catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- made-up transcripts

type Entry = Record<string, unknown>;

/** A prompt the user typed, as Claude Code writes one for an interactive session. */
function typed(cwd: string, at: string, text: string, extra: Entry = {}): Entry {
  return { type: 'user', timestamp: at, cwd, entrypoint: 'cli', promptSource: 'typed', userType: 'external', message: { role: 'user', content: text }, ...extra };
}

function reply(cwd: string, at: string, text: string, extra: Entry = {}): Entry {
  return {
    type: 'assistant',
    timestamp: at,
    cwd,
    entrypoint: 'cli',
    message: { id: `msg-${at}`, role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  };
}

const names = (name: string): Entry[] => [
  { type: 'custom-title', customTitle: name },
  { type: 'agent-name', agentName: name },
];

interface Written {
  sessionId: string;
  file: string;
}

let counter = 0;
/** A session id like Claude Code's: a UUID, made up. */
function newId(): string {
  counter += 1;
  return `${counter.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

/**
 * Writes a transcript where Claude Code would: projects/<encodeProjectDir(cwd)>/<id>.jsonl, or in
 * `folder`. Its mtime is its newest entry's time, or `mtime`.
 */
async function write(cwd: string, entries: (Entry | string)[], options: { id?: string; folder?: string; mtime?: string } = {}): Promise<Written> {
  const sessionId = options.id ?? newId();
  const dir = path.join(configDir, 'projects', options.folder ?? encodeProjectDir(cwd));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n') + '\n');
  const times = entries.flatMap((entry) => (typeof entry === 'object' && typeof entry.timestamp === 'string' ? [Date.parse(entry.timestamp)] : []));
  const mtime = options.mtime ? Date.parse(options.mtime) : times.length > 0 ? Math.max(...times) : NOW - 60_000;
  await utimes(file, mtime / 1000, mtime / 1000);
  return { sessionId, file };
}

/** A plain interactive session in `cwd` that has ended: one typed prompt, one reply. */
function plain(cwd: string, minutes = 10, options: { id?: string } = {}): Promise<Written> {
  return write(cwd, [typed(cwd, ago(minutes + 1), 'Fix the flaky test'), reply(cwd, ago(minutes), 'Fixed it.')], options);
}

const scanners: EndedScanner[] = [];
afterEach(() => {
  for (const scanner of scanners.splice(0)) scanner.stop();
});

function scanner(options: EndedScannerOptions = {}): EndedScanner {
  const created = createEndedScanner({ configDir, now: () => NOW, ...options });
  scanners.push(created);
  return created;
}

/** One scan, waited for. */
async function scan(s: EndedScanner, listed: ReadonlySet<string> = NONE, roots: string[] = [work, oss]): Promise<void> {
  s.track(listed, roots);
  await s.settled();
}

const ids = (s: EndedScanner, listed: ReadonlySet<string> = NONE) => s.sessions(listed, NOW).map((session) => session.sessionId);

// ---------------------------------------------------------------- the rule

describe('the ended-session scanner: the rule (spike 006, finding 7)', () => {
  it('lists an interactive session whose process has gone, from its transcript, as the listed sessions are read', async () => {
    const ended = await write(app, [
      { type: 'queue-operation', operation: 'enqueue', timestamp: ago(31) },
      typed(app, ago(30), 'Fix the flaky test in the scheduler'),
      reply(app, ago(29), 'I found the race. Shall I push the fix?'),
      { type: 'ai-title', aiTitle: 'Fix the scheduler race' },
    ]);
    const s = scanner();
    await scan(s);
    expect(s.sessions(NONE, NOW)).toEqual([
      {
        sessionId: ended.sessionId,
        file: ended.file,
        cwd: app,
        name: `app-${ended.sessionId.slice(0, 8)}`,
        // Its first entry's time, whatever the entry.
        startedAt: ago(31),
        transcript: {
          transcript: 'ok',
          lastActivityAt: ago(29),
          lastUserPrompt: 'Fix the flaky test in the scheduler',
          lastPromptMs: Date.parse(ago(30)),
          aiTitle: 'Fix the scheduler race',
          askedYou: { reason: 'question', excerpt: 'I found the race. Shall I push the fix?' },
        },
      },
    ]);
    expect(s.file(ended.sessionId)).toBe(ended.file);
    expect(s.file('never-seen')).toBeUndefined();
  });

  it('takes the start directory from the first entry with a cwd, not from where a later cd took it', async () => {
    const ui = path.join(app, 'packages', 'ui');
    await write(app, [{ type: 'file-history-snapshot', snapshot: {} }, typed(app, ago(20), 'Start here'), reply(ui, ago(19), 'Moved into ui.'), typed(ui, ago(18), 'Now the tests')]);
    const s = scanner();
    await scan(s);
    expect(s.sessions(NONE, NOW).map((session) => session.cwd)).toEqual([app]);
  });

  it("leaves out claude -p, the Agent SDK and any other entrypoint, reading no further than the first entry", async () => {
    for (const entrypoint of ['sdk-cli', 'sdk-ts', 'claude-vscode']) {
      await write(app, [typed(app, ago(5), 'A prompt', { entrypoint }), reply(app, ago(4), 'Done.', { entrypoint })]);
    }
    await write(app, [typed(app, ago(5), 'No entrypoint', { entrypoint: undefined })]);
    const s = scanner();
    await scan(s);
    expect(ids(s)).toEqual([]);
    expect(s.stats().tailReads).toBe(0);
  });

  it('leaves out a session claude agents lists, reading nothing of it, and drops one it lists after the scan', async () => {
    const listedNow = await plain(app, 5);
    const listedLater = await plain(app, 6);
    const s = scanner();
    await scan(s, new Set([listedNow.sessionId]));
    expect(ids(s, new Set([listedNow.sessionId]))).toEqual([listedLater.sessionId]);
    expect(s.stats().tailReads).toBe(1);
    // A session resumed since the scan is listed: it's never in both.
    expect(ids(s, new Set([listedLater.sessionId]))).toEqual([]);
  });

  it('leaves out one that last ran in the background, which claude rm leaves, but not one that ran there before its terminal session', async () => {
    const removed = await write(app, [typed(app, ago(30), 'Start'), reply(app, ago(29), 'Working in the background.', { sessionKind: 'bg' }), typed(app, ago(28), 'Next', { sessionKind: 'bg' })]);
    const backAgain = await write(app, [typed(app, ago(20), 'Start', { sessionKind: 'bg' }), reply(app, ago(19), 'Done in the background.', { sessionKind: 'bg' }), typed(app, ago(18), 'Back in a terminal'), reply(app, ago(17), 'Here.')]);
    const s = scanner();
    await scan(s);
    expect(ids(s)).toEqual([backAgain.sessionId]);
    expect(ids(s)).not.toContain(removed.sessionId);
  });

  it('leaves out one whose conversation continued in another session after its last turn, as /bg does, without following the target', async () => {
    const continued = (extra: Entry = {}) => ({ type: 'continued-in', continuedInSessionId: newId(), sessionId: 'x', timestamp: ago(17), ...extra });
    await write(app, [typed(app, ago(20), 'Start'), reply(app, ago(19), 'Moving to the background.'), continued()]);
    // No usable target still counts: it isn't followed or checked.
    await write(app, [typed(app, ago(20), 'Start'), reply(app, ago(19), 'Moving on.'), continued({ continuedInSessionId: undefined })]);
    await write(app, [typed(app, ago(20), 'Start'), reply(app, ago(19), 'Moving on.'), continued({ continuedInSessionId: 42 }), { type: 'ai-title', aiTitle: 'Later metadata' }]);
    const s = scanner();
    await scan(s);
    expect(ids(s)).toEqual([]);
  });

  it('lists one with a turn after its continued-in entry: the conversation came back to it', async () => {
    const back = await write(app, [
      typed(app, ago(20), 'Start'),
      { type: 'continued-in', continuedInSessionId: newId(), sessionId: 'x', timestamp: ago(19) },
      typed(app, ago(18), 'Back here in a terminal'),
      reply(app, ago(17), 'Here.'),
    ]);
    const s = scanner();
    await scan(s);
    expect(ids(s)).toEqual([back.sessionId]);
  });

  it('leaves out one with no typed prompt, and finds a typed prompt anywhere in the file, reading it in full only then', async () => {
    // Each filler is over 400 bytes, so 20 of them are more than the 1 KiB chunk and the 4 KiB window
    // below, however short the temp directory's path, which every entry's cwd repeats.
    const filler = (n: number, minutes: number) => Array.from({ length: n }, (_, i) => reply(app, ago(minutes), `${'x'.repeat(400)} ${i}`));
    // No typed prompt anywhere, and longer than one chunk: read on to its end.
    await write(app, [
      typed(app, ago(9), 'From the SDK', { promptSource: 'sdk' }),
      ...filler(20, 8),
      typed(app, ago(8), 'Queued', { promptSource: 'queued' }),
      typed(app, ago(7), 'Meta', { isMeta: true }),
      reply(app, ago(6), 'Nothing typed.'),
    ]);
    // A typed prompt only in the middle: past the first chunk of the start, and before the end's window.
    const middle = await write(app, [
      typed(app, ago(50), 'Not typed', { promptSource: 'system' }),
      ...filler(20, 49),
      typed(app, ago(40), 'The one typed prompt'),
      ...filler(20, 39),
    ]);
    const s = scanner({ chunkBytes: 1024, initialWindowBytes: 2048, maxWindowBytes: 4096 });
    await scan(s);
    expect(ids(s)).toEqual([middle.sessionId]);
    expect(s.stats().fullReads).toBe(2);
  });

  it("leaves out one outside the roots, one whose folder isn't its start directory's, and one whose start directory has a control character", async () => {
    const elsewhere = path.join(tmp, 'elsewhere');
    await plain(elsewhere);
    await write(app, [typed(app, ago(5), 'Moved'), reply(app, ago(4), 'Done.')], { folder: encodeProjectDir(path.join(work, 'other')) });
    const odd = path.join(work, 'a\nb');
    await write(odd, [typed(odd, ago(5), 'Odd'), reply(odd, ago(4), 'Done.')]);
    const inOss = await plain(path.join(oss, 'lib'));
    const s = scanner();
    await scan(s);
    expect(ids(s)).toEqual([inOss.sessionId]);
    // None of the others got as far as its end.
    expect(s.stats().tailReads).toBe(1);
  });

  it('leaves out one whose start directory has a C1 control or a bidi character, reading no further than its start (W81)', async () => {
    for (const character of ['\u0085', '\u009b', '\u061c', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069']) {
      const odd = path.join(work, `safe${character}exe.txt`);
      await write(odd, [typed(odd, ago(5), 'Odd'), reply(odd, ago(4), 'Done.')]);
    }
    const inOss = await plain(path.join(oss, 'lib'));
    const s = scanner();
    await scan(s);
    expect(ids(s)).toEqual([inOss.sessionId]);
    expect(s.stats().tailReads).toBe(1);
  });

  it("lists only a transcript named for a canonical UUID: `claude --resume` takes a name too, so deploy.jsonl isn't one (W81)", async () => {
    for (const id of ['deploy', 'ABCDEF01-0000-4000-8000-000000000000', '00000001000040008000000000000000', '00000001-0000-4000-8000-00000000000', 'g0000001-0000-4000-8000-000000000000']) {
      await plain(app, 5, { id });
    }
    const valid = await plain(app, 6);
    const s = scanner();
    await scan(s);
    expect(ids(s)).toEqual([valid.sessionId]);
    // Nothing of the others was read, or even statted.
    expect(s.stats().statted).toBe(1);
  });

  it('matches the roots by the start directory’s realpath, and keeps the directory as recorded', async () => {
    const link = path.join(tmp, 'link-to-work');
    await symlink(work, link);
    const viaLink = path.join(link, 'app');
    const ended = await plain(viaLink);
    const s = scanner();
    await scan(s);
    expect(s.sessions(NONE, NOW).map((session) => [session.sessionId, session.cwd])).toEqual([[ended.sessionId, viaLink]]);
  });

  it(`leaves out one whose newest entry is over ${ENDED_LISTED_DAYS} days old, without reading a file whose mtime is too`, async () => {
    const old = NOW - ENDED_LISTED_MS - 60_000;
    const oldAt = new Date(old).toISOString();
    // Touched since, but its entries are old.
    await write(app, [typed(app, oldAt, 'Old'), reply(app, oldAt, 'Old.')], { mtime: ago(5) });
    await write(app, [typed(app, oldAt, 'Old and untouched'), reply(app, oldAt, 'Old.')], { mtime: oldAt });
    const recent = await plain(app, 60);
    const s = scanner();
    await scan(s);
    expect(ids(s)).toEqual([recent.sessionId]);
    expect(s.stats().tailReads).toBe(2);
    // It ages out by the poll's clock, with no new scan.
    expect(s.sessions(NONE, NOW + ENDED_LISTED_MS)).toEqual([]);
  });
});

describe('the ended-session scanner: names', () => {
  it('names a session by its newest --name, in file order, from its end', async () => {
    const renamed = await write(app, [...names('first-name'), typed(app, ago(9), 'Go'), reply(app, ago(8), 'Done.'), ...names('second  name\n')]);
    const s = scanner();
    await scan(s);
    expect(s.sessions(NONE, NOW).find((x) => x.sessionId === renamed.sessionId)?.name).toBe('second name');
  });

  it('falls back to a name from its start when its end has none', async () => {
    const filler = Array.from({ length: 30 }, (_, i) => reply(app, ago(8), `${'y'.repeat(400)} ${i}`));
    const named = await write(app, [...names('named-at-start'), typed(app, ago(9), 'Go'), ...filler]);
    const s = scanner({ chunkBytes: 1024, initialWindowBytes: 2048, maxWindowBytes: 4096 });
    await scan(s);
    expect(s.sessions(NONE, NOW).map((x) => [x.sessionId, x.name])).toEqual([[named.sessionId, 'named-at-start']]);
  });

  it("otherwise uses the directory's basename and the session id's first 8 characters", () => {
    expect(endedDefaultName('/Users/someone/work/pitwall', '5e66fcb3-0000-4000-8000-000000000000')).toBe('pitwall-5e66fcb3');
    expect(endedDefaultName('/', '5e66fcb3-0000-4000-8000-000000000000')).toBe('5e66fcb3');
  });
});

describe('the ended-session scanner: how much it lists and reads', () => {
  it(`lists at most ${ENDED_LISTED_MAX}, newest first, and stops reading once no older file could make the list`, async () => {
    const written: Written[] = [];
    for (let i = 0; i < ENDED_LISTED_MAX + 5; i++) written.push(await plain(app, 10 + 2 * i));
    const s = scanner();
    await scan(s);
    expect(ids(s)).toEqual(written.slice(0, ENDED_LISTED_MAX).map((w) => w.sessionId));
    expect(s.stats().tailReads).toBe(ENDED_LISTED_MAX);
  });

  it('reads an unchanged transcript once, and a changed one again, from where its start was left', async () => {
    let now = NOW;
    // The default 64 KiB chunk, so each small file is one chunk, whatever the temp directory's path.
    const s = scanner({ now: () => now });
    const quick = await plain(app, 30);
    const untyped = await write(app, [typed(app, ago(29), 'Not typed', { promptSource: 'sdk' }), reply(app, ago(28), 'Done.')]);
    await scan(s);
    const first = s.stats();
    // Both are well under one chunk, so the first read of their start was all of them.
    expect(first).toMatchObject({ scans: 1, tailReads: 2, fullReads: 0 });

    now += ENDED_RESCAN_MS;
    await scan(s);
    expect(s.stats()).toMatchObject({ scans: 2, tailReads: 2, fullReads: 0, bytesRead: first.bytesRead });

    // Both grow, as when a session is resumed and ends again. Of the start, only what was added is read,
    // and only for the one still with no typed prompt.
    const more = `${JSON.stringify(typed(app, ago(20), 'Still not typed', { promptSource: 'sdk' }))}\n`;
    await appendFile(untyped.file, more);
    await appendFile(quick.file, `${JSON.stringify(reply(app, ago(19), 'More.'))}\n`);
    for (const file of [untyped.file, quick.file]) await utimes(file, (NOW - 10_000) / 1000, (NOW - 10_000) / 1000);
    now += ENDED_RESCAN_MS;
    await scan(s);
    expect(s.stats()).toMatchObject({ scans: 3, tailReads: 4, fullReads: 1, bytesRead: first.bytesRead + Buffer.byteLength(more) });
    expect(ids(s)).toEqual([quick.sessionId]);
    expect(s.sessions(NONE, NOW)[0]?.transcript.lastActivityAt).toBe(ago(19));
  });

  it('lists one once a typed prompt is added to it', async () => {
    let now = NOW;
    const s = scanner({ now: () => now });
    const untyped = await write(app, [typed(app, ago(29), 'Not typed', { promptSource: 'sdk' }), reply(app, ago(28), 'Done.')]);
    await scan(s);
    expect(ids(s)).toEqual([]);
    await appendFile(untyped.file, `${JSON.stringify(typed(app, ago(20), 'Typed at last'))}\n`);
    await utimes(untyped.file, (NOW - 10_000) / 1000, (NOW - 10_000) / 1000);
    now += ENDED_RESCAN_MS;
    await scan(s);
    expect(ids(s)).toEqual([untyped.sessionId]);
  });

  it('scans again when the listing or the roots change, or after 30 s, and not otherwise', async () => {
    let now = NOW;
    const s = scanner({ now: () => now });
    await plain(app);
    await scan(s, new Set(['a']));
    await scan(s, new Set(['a']));
    expect(s.stats().scans).toBe(1);
    await scan(s, new Set(['a', 'b']));
    expect(s.stats().scans).toBe(2);
    await scan(s, new Set(['b', 'a']));
    expect(s.stats().scans).toBe(2);
    await scan(s, new Set(['a', 'b']), [work]);
    expect(s.stats().scans).toBe(3);
    now += ENDED_RESCAN_MS - 1;
    await scan(s, new Set(['a', 'b']), [work]);
    expect(s.stats().scans).toBe(3);
    now += 1;
    await scan(s, new Set(['a', 'b']), [work]);
    expect(s.stats().scans).toBe(4);
  });

  it('runs one scan at a time, and one more after it for a listing that changed meanwhile', async () => {
    const s = scanner();
    const ended = await plain(app);
    s.track(NONE, [work]);
    // While the first runs, its session is listed: the second scan sees that.
    s.track(new Set([ended.sessionId]), [work]);
    await s.settled();
    expect(s.stats().scans).toBe(2);
    expect(ids(s)).toEqual([]);
  });

  it('tells subscribers when a scan finds a different set, and not when it finds the same', async () => {
    let now = NOW;
    const s = scanner({ now: () => now });
    let calls = 0;
    const unsubscribe = s.subscribe(() => (calls += 1));
    await plain(app);
    await scan(s);
    expect(calls).toBe(1);
    now += ENDED_RESCAN_MS;
    await scan(s);
    expect(calls).toBe(1);
    await plain(path.join(oss, 'lib'));
    now += ENDED_RESCAN_MS;
    await scan(s);
    expect(calls).toBe(2);
    unsubscribe();
    await plain(app, 3);
    now += ENDED_RESCAN_MS;
    await scan(s);
    expect(calls).toBe(2);
  });
});

describe('the ended-session scanner: failing soft', () => {
  it('skips lines it can’t parse, sub-agent transcripts, and file names that aren’t safe session ids', async () => {
    const ended = await write(app, ['{not json', typed(app, ago(9), 'Go'), '', '[1,2]', reply(app, ago(8), 'Done.'), '{"type":"assistant"']);
    const folder = path.dirname(ended.file);
    await mkdir(path.join(folder, ended.sessionId, 'subagents'), { recursive: true });
    await writeFile(path.join(folder, ended.sessionId, 'subagents', 'agent-1.jsonl'), `${JSON.stringify(typed(app, ago(7), 'Sub-agent'))}\n`);
    await plain(app, 5, { id: '-not-safe' });
    await mkdir(path.join(folder, 'a-directory.jsonl'));
    const s = scanner();
    await scan(s);
    expect(ids(s)).toEqual([ended.sessionId]);
  });

  it('lists nothing when there is no projects directory, and never throws', async () => {
    const s = createEndedScanner({ configDir: path.join(tmp, 'no-such-dir'), now: () => NOW });
    scanners.push(s);
    await scan(s);
    expect(ids(s)).toEqual([]);
    expect(() => s.track(NONE, [work])).not.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)('skips a transcript it can’t read, and keeps the last result when the projects directory can’t be listed', async () => {
    let now = NOW;
    const s = scanner({ now: () => now });
    const readable = await plain(app);
    const locked = await plain(app, 3);
    await chmod(locked.file, 0o000);
    await scan(s);
    expect(ids(s)).toEqual([readable.sessionId]);
    await chmod(path.join(configDir, 'projects'), 0o000);
    now += ENDED_RESCAN_MS;
    await scan(s);
    expect(ids(s)).toEqual([readable.sessionId]);
  });

  it('stops: nothing more is scanned or listed', async () => {
    const s = scanner();
    await plain(app);
    await scan(s);
    s.stop();
    expect(ids(s)).toEqual([]);
    await scan(s);
    expect(s.stats().scans).toBe(1);
  });
});
