import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLL_INTERVAL_MS, type IndexSnapshot, type RelayAlert, type RelayOff } from '../shared/protocol.js';
import type { AgentRow, AgentsResult } from './agents.js';
import { createGroupResolver } from './grouping.js';
import { createIndexer, startIndexer, type IndexerDeps } from './index.js';
import { createTranscriptReader, encodeProjectDir, type TranscriptInfo } from './transcripts.js';
import { createWorkedInScanner, type RepoWorkedIn, type TrackedSession, type WorkedInScanner } from './workedIn.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');

function row(id: string, cwd: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    sessionId: id,
    name: `pitwall-test-${id}`,
    kind: 'interactive',
    cwd,
    pid: 1000,
    status: 'idle',
    startedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

/** Fake dependencies: no processes, no files. */
function harness() {
  const state = {
    result: { ok: true, rows: [] } as AgentsResult,
    now: NOW,
    listCalls: 0,
    reads: [] as string[],
    retained: [] as string[][],
    transcripts: new Map<string, TranscriptInfo>(),
    /** What transcriptFile() answers, by session id. */
    files: new Map<string, string>(),
    /** When set, list() waits for this before answering. */
    gate: undefined as Promise<void> | undefined,
  };
  const deps: IndexerDeps = {
    agents: {
      async list() {
        state.listCalls++;
        if (state.gate) await state.gate;
        return state.result;
      },
    },
    groups: {
      async resolve(cwd) {
        return { key: path.dirname(cwd), kind: 'git' };
      },
      prune() {},
    },
    transcripts: {
      async read(sessionId) {
        state.reads.push(sessionId);
        return state.transcripts.get(sessionId) ?? { transcript: 'missing' };
      },
      transcriptFile(sessionId) {
        return state.files.get(sessionId);
      },
      retain(ids) {
        state.retained.push([...ids].sort());
      },
    },
    realpath: async (p) => p,
    now: () => state.now,
    home: '/home/someone',
    concurrency: 4,
  };
  return { state, deps };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('createIndexer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls straight away and gives a listener subscribed after start the first snapshot', async () => {
    const { state, deps } = harness();
    state.result = { ok: true, rows: [row('a', '/work/repo/a')] };
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    const received: IndexSnapshot[] = [];
    indexer.subscribe((s) => received.push(s));
    expect(indexer.latest()).toBeUndefined();

    await flush();

    expect(received).toHaveLength(1);
    expect(indexer.latest()).toBe(received[0]);
    expect(received[0]).toMatchObject({
      generatedAt: new Date(NOW).toISOString(),
      roots: ['/work'],
      source: { ok: true },
      groups: [
        { key: '/work/repo', label: 'repo', kind: 'git', root: '/work', sessions: [{ sessionId: 'a', transcript: 'missing' }] },
      ],
    });
    indexer.stop();
  });

  it('polls every intervalMs', async () => {
    const { state, deps } = harness();
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 500 }, deps);
    await flush();
    expect(state.listCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(state.listCalls).toBe(4);
    indexer.stop();
  });

  it('defaults to a 5 second interval, the contract default', async () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5000);
    const { state, deps } = harness();
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    await vi.advanceTimersByTimeAsync(4999);
    expect(state.listCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.listCalls).toBe(2);
    indexer.stop();
  });

  it('stops answering conversation for a session that leaves the snapshot, but not after a failed poll', async () => {
    // Only the poll interval is faked: the page is read from a real file.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-index-snapshot-'));
    try {
      const { state, deps } = harness();
      const file = path.join(dir, 'prompt.jsonl');
      await writeFile(file, `${JSON.stringify({ type: 'user', timestamp: new Date(NOW).toISOString(), message: { content: 'a prompt' } })}\n`);
      for (const id of ['in', 'later-gone']) state.files.set(id, file);
      state.result = { ok: true, rows: [row('in', '/work/repo/a'), row('later-gone', '/work/repo/c')] };
      const indexer = createIndexer({ roots: ['/work'], intervalMs: 1000 }, deps);
      await flush();
      expect(await indexer.conversation('in')).toBeDefined();
      expect(await indexer.conversation('later-gone')).toBeDefined();

      state.result = { ok: true, rows: [row('in', '/work/repo/a')] };
      await vi.advanceTimersByTimeAsync(1000);
      expect(await indexer.conversation('later-gone')).toBeUndefined();
      expect(await indexer.conversation('in')).toBeDefined();

      // A failed poll keeps the last sessions, so it keeps answering for them.
      state.result = { ok: false, error: 'claude agents --json timed out after 10s' };
      await vi.advanceTimersByTimeAsync(1000);
      expect(indexer.latest()?.source.ok).toBe(false);
      expect(await indexer.conversation('in')).toBeDefined();
      indexer.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers conversation only for sessions in the latest snapshot that have a transcript', async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-index-conversation-'));
    try {
      const { state, deps } = harness();
      const file = path.join(dir, 'in.jsonl');
      await writeFile(file, `${JSON.stringify({ type: 'user', timestamp: new Date(NOW).toISOString(), message: { content: 'a prompt' } })}\n`);
      for (const id of ['in', 'out']) state.files.set(id, file);
      state.result = { ok: true, rows: [row('in', '/work/repo/a'), row('out', '/elsewhere/b'), row('no-file', '/work/repo/c')] };
      const indexer = createIndexer({ roots: ['/work'], intervalMs: 60_000 }, deps);
      expect(await indexer.conversation('in')).toBeUndefined();
      await new Promise<IndexSnapshot>((resolve) => indexer.subscribe(resolve));

      expect(await indexer.conversation('in')).toEqual({
        sessionId: 'in',
        entries: [{ kind: 'user', at: new Date(NOW).toISOString(), text: 'a prompt' }],
      });
      // Outside the roots: the reader knows its file, but the index never serves it.
      expect(await indexer.conversation('out')).toBeUndefined();
      expect(await indexer.conversation('no-file')).toBeUndefined();
      expect(await indexer.conversation('never-listed')).toBeUndefined();
      await expect(indexer.conversation('in', 'not a cursor')).rejects.toMatchObject({ reason: 'invalid' });
      // A file that has gone is no transcript.
      await rm(file);
      expect(await indexer.conversation('in')).toBeUndefined();
      indexer.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('notifies after every completed poll, changed or not, with a fresh generatedAt', async () => {
    const { state, deps } = harness();
    state.result = { ok: true, rows: [row('a', '/work/repo/a')] };
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 1000 }, deps);
    const received: IndexSnapshot[] = [];
    indexer.subscribe((s) => received.push(s));
    await flush();
    expect(received).toHaveLength(1);

    // Nothing changed but the clock: still a notification, so the UI can tell
    // a quiet index from a stuck one.
    state.now += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(2);
    expect(received[1]?.generatedAt).toBe(new Date(NOW + 1000).toISOString());
    expect(received[1]?.groups).toEqual(received[0]?.groups);
    expect(indexer.latest()).toBe(received[1]);

    state.now += 1000;
    state.transcripts.set('a', { transcript: 'ok', lastActivityAt: new Date(NOW).toISOString(), lastUserPrompt: 'go' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(3);
    expect(received[2]?.groups[0]?.sessions[0]?.lastUserPrompt).toBe('go');
    expect(indexer.latest()).toBe(received[2]);
    indexer.stop();
  });

  it('notifies after every failed poll too', async () => {
    const { state, deps } = harness();
    state.result = { ok: false, error: 'claude agents --json timed out after 10s' };
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 1000 }, deps);
    const received: IndexSnapshot[] = [];
    indexer.subscribe((s) => received.push(s));
    await flush();
    state.now += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(2);
    expect(received.map((s) => s.source.ok)).toEqual([false, false]);
    expect(received[1]?.generatedAt).toBe(new Date(NOW + 1000).toISOString());
    indexer.stop();
  });

  it('never overlaps polls: a tick during a running poll is skipped and notifies nobody', async () => {
    const { state, deps } = harness();
    let release!: () => void;
    state.gate = new Promise((resolve) => (release = resolve));
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 100 }, deps);
    const listener = vi.fn();
    indexer.subscribe(listener);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.listCalls).toBe(1);
    expect(indexer.latest()).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    state.gate = undefined;
    release();
    await flush();
    expect(indexer.latest()).toBeDefined();
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.listCalls).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
    indexer.stop();
  });

  it('marks a session whose cwd no longer exists, and still groups it', async () => {
    const { state, deps } = harness();
    deps.realpath = async (p) => {
      if (p === '/work/repo/gone') throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
      return p;
    };
    state.result = { ok: true, rows: [row('gone', '/work/repo/gone'), row('here', '/work/repo/here')] };
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    const sessions = indexer.latest()?.groups.flatMap((g) => g.sessions) ?? [];
    expect(sessions.find((s) => s.sessionId === 'gone')?.cwdMissing).toBe(true);
    expect(sessions.find((s) => s.sessionId === 'here')).not.toHaveProperty('cwdMissing');
    indexer.stop();
  });

  it('keeps askedYou only for sessions that have finished their turn, and sorts them after waiting', async () => {
    const { state, deps } = harness();
    const asked = { reason: 'question' as const, excerpt: 'Ship it?' };
    const at = (s: number) => new Date(NOW - s * 1000).toISOString();
    state.result = {
      ok: true,
      rows: [
        row('idle-asked', '/work/repo/a', { status: 'idle' }),
        row('busy-asked', '/work/repo/b', { status: 'busy' }),
        row('waiting', '/work/repo/c', { status: 'waiting', waitingFor: 'permission prompt' }),
        row('idle', '/work/repo/d', { status: 'idle' }),
      ],
    };
    state.transcripts.set('idle-asked', { transcript: 'ok', lastActivityAt: at(600), askedYou: asked });
    state.transcripts.set('busy-asked', { transcript: 'ok', lastActivityAt: at(1), askedYou: asked });
    state.transcripts.set('waiting', { transcript: 'ok', lastActivityAt: at(900) });
    state.transcripts.set('idle', { transcript: 'ok', lastActivityAt: at(2) });
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    const sessions = indexer.latest()?.groups[0]?.sessions ?? [];
    expect(sessions.map((s) => [s.sessionId, s.askedYou?.excerpt])).toEqual([
      ['waiting', undefined],
      ['idle-asked', 'Ship it?'],
      ['busy-asked', undefined],
      ['idle', undefined],
    ]);
    indexer.stop();
  });

  it('drops sessions outside the roots, without reading their transcripts', async () => {
    const { state, deps } = harness();
    state.result = {
      ok: true,
      rows: [row('in', '/work/repo/x'), row('out', '/workshop/repo/y'), row('nested', '/work/projects/site/z')],
    };
    const indexer = createIndexer({ roots: ['/work', '/work/projects'] }, deps);
    await flush();
    const snapshot = indexer.latest();
    expect(snapshot?.groups.map((g) => [g.root, g.label]).sort()).toEqual([
      ['/work', 'repo'],
      ['/work/projects', 'site'],
    ]);
    expect(snapshot?.groups.flatMap((g) => g.sessions.map((s) => s.sessionId)).sort()).toEqual(['in', 'nested']);
    expect(state.reads.sort()).toEqual(['in', 'nested']);
    expect(state.retained).toEqual([['in', 'nested']]);
    indexer.stop();
  });

  it('leaves out the rows the exclude hook names, such as the relay, without reading their transcripts', async () => {
    const { state, deps } = harness();
    state.result = { ok: true, rows: [row('kept', '/work/repo/x'), row('relay', '/work/.pitwall/relay', { pid: 4321 })] };
    const seen: string[] = [];
    const indexer = createIndexer(
      {
        roots: ['/work'],
        exclude: (agent) => {
          seen.push(agent.sessionId);
          return agent.pid === 4321;
        },
      },
      deps,
    );
    await flush();
    expect(indexer.latest()?.groups.flatMap((g) => g.sessions.map((s) => s.sessionId))).toEqual(['kept']);
    expect(seen.sort()).toEqual(['kept', 'relay']);
    expect(state.reads).toEqual(['kept']);
    indexer.stop();
  });

  it('keeps a row when the exclude hook throws', async () => {
    const { state, deps } = harness();
    state.result = { ok: true, rows: [row('kept', '/work/repo/x')] };
    const indexer = createIndexer(
      {
        roots: ['/work'],
        exclude: () => {
          throw new Error('broken hook');
        },
      },
      deps,
    );
    await flush();
    expect(indexer.latest()?.source).toEqual({ ok: true });
    expect(indexer.latest()?.groups.flatMap((g) => g.sessions.map((s) => s.sessionId))).toEqual(['kept']);
    indexer.stop();
  });

  it('adds the relay exchange for a session, and nothing when the hook has none or throws', async () => {
    const { state, deps } = harness();
    state.result = { ok: true, rows: [row('messaged', '/work/repo/x'), row('quiet', '/work/repo/y'), row('broken', '/work/repo/z')] };
    const exchange = { sentAt: '2026-10-16T11:59:00.000Z', status: 'delivered' as const, reply: { at: '2026-10-16T11:59:30.000Z', text: 'done' } };
    const indexer = createIndexer(
      {
        roots: ['/work'],
        relayExchange: (sessionId) => {
          if (sessionId === 'broken') throw new Error('broken hook');
          return sessionId === 'messaged' ? exchange : undefined;
        },
      },
      deps,
    );
    await flush();
    const sessions = new Map(indexer.latest()?.groups.flatMap((g) => g.sessions.map((s) => [s.sessionId, s] as const)));
    expect(sessions.get('messaged')?.relay).toEqual(exchange);
    expect(sessions.get('quiet')).not.toHaveProperty('relay');
    expect(sessions.get('broken')).not.toHaveProperty('relay');
    indexer.stop();
  });

  it('adds the relay’s alert to the snapshot, also when the source fails, and nothing when the hook has none or throws', async () => {
    const { state, deps } = harness();
    state.result = { ok: true, rows: [row('a', '/work/repo/a')] };
    let alert: RelayAlert | undefined;
    let broken = false;
    const indexer = createIndexer(
      {
        roots: ['/work'],
        intervalMs: 1000,
        relayAlert: () => {
          if (broken) throw new Error('broken hook');
          return alert;
        },
      },
      deps,
    );
    await flush();
    expect(indexer.latest()).not.toHaveProperty('relayAlert');
    alert = { at: '2026-10-16T11:59:00.000Z', detail: 'The relay tried to send a message when pitwall hadn’t asked it to.', count: 1, blocked: true };
    await vi.advanceTimersByTimeAsync(1000);
    expect(indexer.latest()?.relayAlert).toEqual(alert);
    state.result = { ok: false, error: 'claude agents --json timed out after 10s' };
    await vi.advanceTimersByTimeAsync(1000);
    expect(indexer.latest()?.relayAlert).toEqual(alert);
    broken = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(indexer.latest()).not.toHaveProperty('relayAlert');
    indexer.stop();
  });

  it('adds why the relay is off to the snapshot, also when the source fails, and nothing when the hook has none or throws', async () => {
    const { state, deps } = harness();
    state.result = { ok: true, rows: [row('a', '/work/repo/a')] };
    let off: RelayOff | undefined;
    let broken = false;
    const indexer = createIndexer(
      {
        roots: ['/work'],
        intervalMs: 1000,
        relayOff: () => {
          if (broken) throw new Error('broken hook');
          return off;
        },
      },
      deps,
    );
    await flush();
    expect(indexer.latest()).not.toHaveProperty('relayOff');
    off = { since: '2026-10-20T11:59:00.000Z', reason: "its gate didn't check a SendMessage call." };
    await vi.advanceTimersByTimeAsync(1000);
    expect(indexer.latest()?.relayOff).toEqual(off);
    state.result = { ok: false, error: 'claude agents --json timed out after 10s' };
    await vi.advanceTimersByTimeAsync(1000);
    expect(indexer.latest()?.relayOff).toEqual(off);
    broken = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(indexer.latest()).not.toHaveProperty('relayOff');
    indexer.stop();
  });

  it('keeps the last groups and reports the error when the source fails', async () => {
    const { state, deps } = harness();
    state.result = { ok: true, rows: [row('a', '/work/repo/a')] };
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 1000 }, deps);
    const received: IndexSnapshot[] = [];
    indexer.subscribe((s) => received.push(s));
    await flush();

    state.result = { ok: false, error: 'claude agents --json timed out after 10s' };
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(2);
    expect(received[1]?.source).toEqual({ ok: false, error: 'claude agents --json timed out after 10s' });
    expect(received[1]?.groups).toEqual(received[0]?.groups);

    state.result = { ok: true, rows: [] };
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(3);
    expect(received[2]?.source).toEqual({ ok: true });
    expect(received[2]?.groups).toEqual([]);
    indexer.stop();
  });

  it('reports an empty list when the very first poll fails', async () => {
    const { state, deps } = harness();
    state.result = { ok: false, error: 'claude agents --json failed: claude was not found' };
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    expect(indexer.latest()).toMatchObject({ groups: [], source: { ok: false } });
    indexer.stop();
  });

  it('turns an unexpected error into a source error instead of throwing', async () => {
    const { deps } = harness();
    deps.agents = { list: () => Promise.reject(new Error('bug\nwith two lines')) };
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    expect(indexer.latest()?.source).toEqual({ ok: false, error: 'index poll failed: bug with two lines' });
    indexer.stop();
  });

  it('stop() clears the timer and the listeners, even with a poll in flight', async () => {
    const { state, deps } = harness();
    let release!: () => void;
    state.gate = new Promise((resolve) => (release = resolve));
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 100 }, deps);
    const listener = vi.fn();
    indexer.subscribe(listener);
    indexer.stop();
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.listCalls).toBe(1);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unsubscribes a listener', async () => {
    const { state, deps } = harness();
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 1000 }, deps);
    const listener = vi.fn();
    const unsubscribe = indexer.subscribe(listener);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    state.result = { ok: true, rows: [row('a', '/work/repo/a')] };
    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    indexer.stop();
  });

  it('keeps notifying other listeners when one throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps } = harness();
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    const good = vi.fn();
    indexer.subscribe(() => {
      throw new Error('listener bug');
    });
    indexer.subscribe(good);
    await flush();
    expect(good).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    indexer.stop();
  });
});

describe('createIndexer with the repos sessions worked in (W34)', () => {
  const ROOT = '/work';
  /** Repos under the root; any other directory is in no repo. */
  const REPOS = ['/work/alpha', '/work/beta', '/work/gamma'];

  /** A fake scanner: `found` is what workedIn() answers, by session id; `tracked` records each track(). */
  function fakeScanner() {
    const found = new Map<string, RepoWorkedIn[]>();
    const tracked: { sessions: TrackedSession[]; roots: string[] }[] = [];
    const scanner: WorkedInScanner = {
      track: (sessions, roots) => {
        tracked.push({ sessions: [...sessions], roots: [...roots] });
      },
      workedIn: (id) => found.get(id),
      settled: async () => undefined,
      stats: () => ({ bytesRead: 0, calls: 0, scans: 0, gitRuns: 0, gitPeak: 0 }),
      stop: () => undefined,
    };
    return { scanner, found, tracked };
  }

  const repo = (key: string, minutesAgo = 1): RepoWorkedIn => ({ key, root: ROOT, calls: 12, changes: 1, lastAt: new Date(NOW - minutesAgo * 60_000).toISOString() });

  function setup() {
    const { state, deps } = harness();
    const fake = fakeScanner();
    deps.workedIn = fake.scanner;
    deps.groups = {
      async resolve(cwd) {
        const key = REPOS.find((r) => cwd === r || cwd.startsWith(`${r}/`));
        return key ? { key, kind: 'git' } : { key: cwd, kind: 'directory' };
      },
      prune() {},
    };
    for (const id of ['in-alpha', 'in-root', 'in-root-alone', 'in-notes', 'in-beta']) state.files.set(id, `/made-up/projects/${id}.jsonl`);
    state.result = {
      ok: true,
      rows: [
        row('in-alpha', '/work/alpha/src'),
        row('in-root', ROOT),
        row('in-root-alone', ROOT),
        row('in-notes', '/work/notes'),
        row('in-beta', '/work/beta'),
      ],
    };
    return { state, deps, ...fake };
  }

  /** label: session ids, for every group. */
  const placement = (snapshot: IndexSnapshot | undefined) =>
    Object.fromEntries((snapshot?.groups ?? []).map((g) => [`${g.label} (${g.kind})`, g.sessions.map((s) => s.sessionId).sort()]));

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands the scanner every listed session with its transcript, its start group and the roots', async () => {
    const { deps, tracked } = setup();
    const indexer = createIndexer({ roots: [ROOT] }, deps);
    await flush();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.roots).toEqual([ROOT]);
    expect(tracked[0]?.sessions.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))).toEqual([
      { sessionId: 'in-alpha', file: '/made-up/projects/in-alpha.jsonl', startKey: '/work/alpha' },
      { sessionId: 'in-beta', file: '/made-up/projects/in-beta.jsonl', startKey: '/work/beta' },
      { sessionId: 'in-notes', file: '/made-up/projects/in-notes.jsonl', startKey: ROOT },
      { sessionId: 'in-root', file: '/made-up/projects/in-root.jsonl', startKey: ROOT },
      { sessionId: 'in-root-alone', file: '/made-up/projects/in-root-alone.jsonl', startKey: ROOT },
    ]);
    indexer.stop();
  });

  it('places each session by where it started, and under every repo it worked in', async () => {
    const { deps, found } = setup();
    found.set('in-alpha', [repo('/work/beta'), repo('/work/gamma', 5)]);
    found.set('in-root', [repo('/work/alpha')]);
    found.set('in-notes', [repo('/work/gamma')]);
    const indexer = createIndexer({ roots: [ROOT] }, deps);
    await flush();
    expect(placement(indexer.latest())).toEqual({
      // Started in it, and the root-started session that worked in it.
      'alpha (git)': ['in-alpha', 'in-root'],
      'beta (git)': ['in-alpha', 'in-beta'],
      // A repo reached only through workedIn, labelled as any other.
      'gamma (git)': ['in-alpha', 'in-notes'],
      // A directory below the root that's in no repo keeps its group, with every session started in it.
      'notes (directory)': ['in-notes'],
      // Only the root-started session that worked in no repo.
      'work (directory)': ['in-root-alone'],
    });
    indexer.stop();
  });

  it('adds workedIn to the summary, without the roots, in the scanner’s order', async () => {
    const { deps, found } = setup();
    found.set('in-alpha', [repo('/work/beta'), repo('/work/gamma', 5)]);
    const indexer = createIndexer({ roots: [ROOT] }, deps);
    await flush();
    const sessions = indexer.latest()?.groups.flatMap((g) => g.sessions) ?? [];
    const inAlpha = sessions.filter((s) => s.sessionId === 'in-alpha');
    // The same session in three groups, each with the same summary.
    expect(inAlpha).toHaveLength(3);
    for (const s of inAlpha) {
      expect(s.workedIn).toEqual([
        { key: '/work/beta', calls: 12, changes: 1, lastAt: new Date(NOW - 60_000).toISOString() },
        { key: '/work/gamma', calls: 12, changes: 1, lastAt: new Date(NOW - 5 * 60_000).toISOString() },
      ]);
    }
    expect(sessions.find((s) => s.sessionId === 'in-beta')).not.toHaveProperty('workedIn');
    indexer.stop();
  });

  it('leaves the root’s group out once every session started there worked in repos', async () => {
    const { deps, found } = setup();
    found.set('in-root', [repo('/work/alpha')]);
    found.set('in-root-alone', [repo('/work/beta')]);
    const indexer = createIndexer({ roots: [ROOT] }, deps);
    await flush();
    expect(indexer.latest()?.groups.some((g) => g.key === ROOT)).toBe(false);
    indexer.stop();
  });

  it('keeps a session where it started until its scan finishes, then moves it', async () => {
    const { deps, found } = setup();
    const indexer = createIndexer({ roots: [ROOT], intervalMs: 1000 }, deps);
    await flush();
    expect(placement(indexer.latest())['work (directory)']).toEqual(['in-root', 'in-root-alone']);
    found.set('in-root', [repo('/work/gamma')]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(placement(indexer.latest())).toMatchObject({ 'work (directory)': ['in-root-alone'], 'gamma (git)': ['in-root'] });
    indexer.stop();
  });

  it('keeps every session in its start group when the scanner throws', async () => {
    const { deps, scanner } = setup();
    scanner.track = () => {
      throw new Error('a scanner bug');
    };
    const indexer = createIndexer({ roots: [ROOT] }, deps);
    await flush();
    expect(indexer.latest()?.source).toEqual({ ok: true });
    expect(Object.keys(placement(indexer.latest())).sort()).toEqual(['alpha (git)', 'beta (git)', 'notes (directory)', 'work (directory)']);
    indexer.stop();
  });

  it('stops the scanner with the indexer', async () => {
    const { deps, scanner } = setup();
    const stop = vi.spyOn(scanner, 'stop');
    const indexer = createIndexer({ roots: [ROOT] }, deps);
    await flush();
    indexer.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('the indexer with a real scanner', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-index-worked-in-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('never waits for a scan: a poll finishes while one is held back, and a later poll has its result', async () => {
    const root = path.join(dir, 'code');
    const repoDir = path.join(root, 'api');
    await mkdir(path.join(repoDir, '.git'), { recursive: true });
    const file = path.join(dir, 'made-up.jsonl');
    const edit = { type: 'assistant', timestamp: new Date(NOW).toISOString(), cwd: root, message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(repoDir, 'a.ts') } }] } };
    await writeFile(file, `${JSON.stringify(edit)}\n`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { open } = await import('node:fs/promises');
    const scanner = createWorkedInScanner({
      home: dir,
      // A fake git that knows `.git` directories, and a transcript read that waits for the gate.
      run: async (_file, args) => `${path.join(args[1] ?? '', '.git')}\n`,
      fs: {
        open: async (p) => {
          if (p === file) await gate;
          return open(p, 'r');
        },
      },
    });
    const { state, deps } = harness();
    deps.workedIn = scanner;
    deps.groups = { resolve: async (cwd) => ({ key: cwd, kind: 'directory' }), prune() {} };
    state.files.set('s', file);
    state.result = { ok: true, rows: [row('s', root)] };
    const snapshots: IndexSnapshot[] = [];
    const indexer = createIndexer({ roots: [root], intervalMs: 50 }, deps);
    indexer.subscribe((snapshot) => snapshots.push(snapshot));
    // Several polls finish while the scan is held at its first read, each with the session where it started.
    while (snapshots.length < 3) await new Promise((resolve) => setTimeout(resolve, 10));
    for (const snapshot of snapshots) {
      expect(snapshot.groups.map((g) => [g.key, g.sessions.map((x) => x.sessionId)])).toEqual([[root, ['s']]]);
      expect(snapshot.groups[0]?.sessions[0]).not.toHaveProperty('workedIn');
    }
    release();
    await scanner.settled();
    const before = snapshots.length;
    while (snapshots.length === before) await new Promise((resolve) => setTimeout(resolve, 10));
    const moved = snapshots.at(-1);
    indexer.stop();
    // The session started in the root and changed api, so it's listed there alone.
    expect(moved?.groups.map((g) => [g.key, g.sessions.map((x) => x.sessionId)])).toEqual([[repoDir, ['s']]]);
    expect(moved?.groups[0]?.sessions[0]?.workedIn).toMatchObject([{ key: repoDir, calls: 1, changes: 1 }]);
  });
});

describe('the indexer against temporary directories', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-index-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('groups by repo, puts worktrees under their main repo, reads transcripts and flags stale sessions', async () => {
    const root = path.join(dir, 'root');
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'repo-worktrees', 'feature');
    const plain = path.join(root, 'notes');
    const configDir = path.join(dir, 'claude-config');
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await mkdir(path.dirname(worktree), { recursive: true });
    await mkdir(plain, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c', 'user.name=pitwall-test',
          '-c', 'user.email=pitwall-test@example.invalid',
          '-c', 'commit.gpgsign=false',
          '-c', 'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd, stdio: 'ignore' },
      );
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);

    const ids = {
      repo: '66666666-6666-4666-8666-666666666661',
      worktree: '66666666-6666-4666-8666-666666666662',
      plain: '66666666-6666-4666-8666-666666666663',
      stale: '66666666-6666-4666-8666-666666666664',
      outside: '66666666-6666-4666-8666-666666666665',
      asked: '66666666-6666-4666-8666-666666666666',
      gone: '66666666-6666-4666-8666-666666666667',
      staleAlive: '66666666-6666-4666-8666-666666666668',
    };
    const gone = path.join(root, 'removed-worktree');
    const transcript = async (cwd: string, id: string, lines: unknown[]) => {
      const projectDir = path.join(configDir, 'projects', encodeProjectDir(cwd));
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, `${id}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    };
    await transcript(path.join(repo, 'src'), ids.repo, [
      { type: 'user', timestamp: '2026-10-16T11:58:00.000Z', message: { content: 'make it faster' } },
      {
        type: 'assistant',
        timestamp: '2026-10-16T11:59:00.000Z',
        message: { id: 'm1', content: [{ type: 'text', text: 'Profiling now.' }] },
      },
    ]);
    await transcript(worktree, ids.worktree, [
      { type: 'user', timestamp: '2026-10-16T11:00:00.000Z', message: { content: 'build the feature' } },
    ]);
    await transcript(repo, ids.asked, [
      { type: 'ai-title', aiTitle: 'Tidy the docs', sessionId: ids.asked },
      { type: 'user', timestamp: '2026-10-16T11:50:00.000Z', message: { content: 'tidy the docs' } },
      { type: 'ai-title', aiTitle: 'Tidy the docs folder', sessionId: ids.asked },
      {
        type: 'assistant',
        timestamp: '2026-10-16T11:51:00.000Z',
        message: { id: 'm2', content: [{ type: 'text', text: '## Done\n\n**Open questions:**\n- Should I push it?\n\n**Next steps:**\n1. You review.' }] },
      },
    ]);
    await transcript(path.join(dir, 'elsewhere'), ids.outside, [
      { type: 'assistant', timestamp: '2026-10-16T11:52:00.000Z', message: { id: 'm4', content: [{ type: 'text', text: 'Outside the root.' }] } },
    ]);
    await transcript(repo, ids.staleAlive, [
      { type: 'user', timestamp: '2026-09-24T09:00:00.000Z', message: { content: 'migrate the data' } },
      {
        type: 'assistant',
        timestamp: '2026-09-24T09:05:00.000Z',
        message: { id: 'm3', content: [{ type: 'text', text: 'Which table first?' }] },
      },
    ]);

    const rows = [
      row(ids.repo, path.join(repo, 'src'), { status: 'busy' }),
      row(ids.worktree, worktree, { status: 'waiting', waitingFor: 'permission prompt' }),
      row(ids.plain, plain, { startedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() }),
      row(ids.stale, repo, {
        kind: 'background',
        shortId: 'ab12cd34',
        pid: undefined,
        status: undefined,
        state: 'blocked',
        startedAt: new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      row(ids.outside, path.join(dir, 'elsewhere')),
      row(ids.asked, repo, { status: 'idle' }),
      row(ids.gone, gone, { startedAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString() }),
      // Blocked since 24 Sep with its process still running: stale all the same.
      row(ids.staleAlive, repo, { kind: 'background', shortId: 'cd34ef56', pid: 2000, status: 'idle', state: 'blocked' }),
    ];

    const now = () => NOW;
    const indexer = createIndexer(
      { roots: [root], intervalMs: 60_000 },
      {
        agents: { list: async () => ({ ok: true, rows }) },
        groups: createGroupResolver({ now }),
        transcripts: createTranscriptReader({ configDir, now }),
        now,
        home: dir,
        concurrency: 8,
      },
    );
    const snapshot = await new Promise<IndexSnapshot>((resolve) => indexer.subscribe(resolve));
    const askedPage = await indexer.conversation(ids.asked);
    const outsidePage = await indexer.conversation(ids.outside);
    indexer.stop();

    // The session view reads the whole reply from the transcript.
    expect(askedPage?.entries[askedPage.entries.length - 1]).toEqual({
      kind: 'assistant',
      at: '2026-10-16T11:51:00.000Z',
      text: 'Done\n\nOpen questions:\n- Should I push it?\n\nNext steps:\n1. You review.',
    });
    // Its transcript exists, but the session is outside the root.
    expect(outsidePage).toBeUndefined();
    // Replies stay out of the snapshot. Only askedYou's excerpt comes from one.
    const sent = JSON.stringify(snapshot);
    for (const reply of ['Profiling now.', 'Which table first?', 'You review.']) expect(sent).not.toContain(reply);

    expect(snapshot.roots).toEqual([root]);
    expect(snapshot.source).toEqual({ ok: true });
    const view = snapshot.groups.map((g) => ({
      label: g.label,
      kind: g.kind,
      key: g.key,
      sessions: g.sessions.map((s) => [s.sessionId, s.transcript, s.stale]),
    }));
    expect(view).toEqual([
      {
        label: 'repo',
        kind: 'git',
        key: repo,
        sessions: [
          [ids.worktree, 'ok', false],
          [ids.asked, 'ok', false],
          [ids.repo, 'ok', false],
          [ids.stale, 'missing', true],
          [ids.staleAlive, 'ok', true],
        ],
      },
      { label: 'notes', kind: 'directory', key: plain, sessions: [[ids.plain, 'missing', false]] },
      { label: 'removed-worktree', kind: 'directory', key: gone, sessions: [[ids.gone, 'missing', false]] },
    ]);
    const sessions = snapshot.groups.flatMap((g) => g.sessions);
    const byId = (id: string) => sessions.find((s) => s.sessionId === id);
    expect(byId(ids.asked)).toMatchObject({
      askedYou: { reason: 'open-questions', excerpt: 'Should I push it?' },
      title: 'Tidy the docs folder',
      titleSource: 'claude-code',
    });
    expect(sessions.filter((s) => s.title !== undefined).map((s) => s.sessionId)).toEqual([ids.asked]);
    // Blocked, so not "asked you" even though its last message is a question.
    expect(byId(ids.staleAlive)).not.toHaveProperty('askedYou');
    expect(byId(ids.gone)?.cwdMissing).toBe(true);
    expect(sessions.filter((s) => s.cwdMissing).map((s) => s.sessionId)).toEqual([ids.gone]);
    const repoSession = snapshot.groups[0]?.sessions.find((s) => s.sessionId === ids.repo);
    expect(repoSession).toMatchObject({
      lastActivityAt: '2026-10-16T11:59:00.000Z',
      lastUserPrompt: 'make it faster',
    });
  });
});

describe('a root inside a repo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-index-root-in-repo-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives the root's sessions the enclosing repo's git group, with no special case, and its repos their own", async () => {
    const outer = path.join(dir, 'outer');
    const root = path.join(outer, 'code');
    const app = path.join(root, 'app');
    await mkdir(path.join(root, 'notes'), { recursive: true });
    await mkdir(app, { recursive: true });
    for (const repoDir of [outer, app]) execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'ignore' });
    const configDir = path.join(dir, 'claude-config');
    const ids = { root: '66666666-6666-4666-8666-666666666671', notes: '66666666-6666-4666-8666-666666666672', app: '66666666-6666-4666-8666-666666666673' };
    // The root-started session edits app.
    const projectDir = path.join(configDir, 'projects', encodeProjectDir(root));
    await mkdir(projectDir, { recursive: true });
    const edit = { type: 'assistant', timestamp: new Date(NOW).toISOString(), cwd: root, message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(app, 'a.ts') } }] } };
    await writeFile(path.join(projectDir, `${ids.root}.jsonl`), `${JSON.stringify(edit)}\n`);
    const rows = [row(ids.root, root), row(ids.notes, path.join(root, 'notes')), row(ids.app, app)];
    const now = () => NOW;
    const scanner = createWorkedInScanner({ home: dir });
    const indexer = createIndexer(
      { roots: [root], intervalMs: 50 },
      { agents: { list: async () => ({ ok: true, rows }) }, groups: createGroupResolver({ now }), transcripts: createTranscriptReader({ configDir, now }), workedIn: scanner, now, home: dir, concurrency: 8 },
    );
    const snapshots: IndexSnapshot[] = [];
    indexer.subscribe((next) => snapshots.push(next));
    while (snapshots.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await scanner.settled();
    expect(scanner.workedIn(ids.root)).toMatchObject([{ key: app, root, changes: 1 }]);
    const before = snapshots.length;
    while (snapshots.length === before) await new Promise((resolve) => setTimeout(resolve, 10));
    indexer.stop();
    const snapshot = snapshots.at(-1) as IndexSnapshot;
    const view = Object.fromEntries(snapshot.groups.map((g) => [g.key, { label: g.label, kind: g.kind, ids: g.sessions.map((s) => s.sessionId).sort() }]));
    expect(view).toEqual({
      // The root and its plain directory are in outer, a repo like any other, labelled outside the root.
      [outer]: { label: '~/outer', kind: 'git', ids: [ids.root, ids.notes].sort() },
      [app]: { label: 'app', kind: 'git', ids: [ids.root, ids.app].sort() },
    });
  });
});

describe('startIndexer', () => {
  it('reports a missing claude binary as a source error', async () => {
    const indexer = startIndexer({ roots: [os.tmpdir()], intervalMs: 60_000, claudeBin: 'pitwall-test-no-such-claude' });
    const snapshot = await new Promise<IndexSnapshot>((resolve) => indexer.subscribe(resolve));
    indexer.stop();
    expect(snapshot.source).toEqual({
      ok: false,
      error: 'claude agents --json --all failed: pitwall-test-no-such-claude was not found',
    });
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.roots).toEqual([await realpath(os.tmpdir())]);
  });
});
