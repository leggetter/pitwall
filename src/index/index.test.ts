import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLL_INTERVAL_MS, type IndexSnapshot, type LastMessage } from '../shared/protocol.js';
import type { AgentRow, AgentsResult } from './agents.js';
import { createGroupResolver } from './grouping.js';
import { createIndexer, startIndexer, type IndexerDeps } from './index.js';
import { createTranscriptReader, encodeProjectDir, type TranscriptInfo } from './transcripts.js';

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
    messages: new Map<string, LastMessage>(),
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
      lastMessage(sessionId) {
        return state.messages.get(sessionId);
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

  it('answers lastMessage only for sessions in the latest snapshot', async () => {
    const { state, deps } = harness();
    const message = (id: string): LastMessage => ({ sessionId: id, text: `full reply of ${id}`, truncated: false });
    for (const id of ['in', 'out', 'later-gone']) state.messages.set(id, message(id));
    state.result = { ok: true, rows: [row('in', '/work/repo/a'), row('out', '/elsewhere/b'), row('later-gone', '/work/repo/c')] };
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 1000 }, deps);
    // Before the first poll there is no snapshot, so nothing is answered.
    expect(indexer.lastMessage('in')).toBeUndefined();
    await flush();

    expect(indexer.lastMessage('in')).toEqual(message('in'));
    expect(indexer.lastMessage('later-gone')).toEqual(message('later-gone'));
    // Outside the roots: the reader may know it, but the index never serves it.
    expect(indexer.lastMessage('out')).toBeUndefined();
    expect(indexer.lastMessage('never-listed')).toBeUndefined();

    state.result = { ok: true, rows: [row('in', '/work/repo/a')] };
    await vi.advanceTimersByTimeAsync(1000);
    expect(indexer.lastMessage('later-gone')).toBeUndefined();
    expect(indexer.lastMessage('in')).toEqual(message('in'));

    // A failed poll keeps the last sessions, so it keeps answering for them.
    state.result = { ok: false, error: 'claude agents --json timed out after 10s' };
    await vi.advanceTimersByTimeAsync(1000);
    expect(indexer.lastMessage('in')).toEqual(message('in'));
    indexer.stop();
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
      rows: [row('in', '/work/repo/x'), row('out', '/workshop/repo/y'), row('nested', '/work/clients/acme/z')],
    };
    const indexer = createIndexer({ roots: ['/work', '/work/clients'] }, deps);
    await flush();
    const snapshot = indexer.latest();
    expect(snapshot?.groups.map((g) => [g.root, g.label]).sort()).toEqual([
      ['/work', 'repo'],
      ['/work/clients', 'acme'],
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
    const askedMessage = indexer.lastMessage(ids.asked);
    const outsideMessage = indexer.lastMessage(ids.outside);
    const noMessage = indexer.lastMessage(ids.worktree);
    indexer.stop();

    expect(askedMessage).toEqual({
      sessionId: ids.asked,
      text: 'Done\n\nOpen questions:\n- Should I push it?\n\nNext steps:\n1. You review.',
      truncated: false,
      at: '2026-10-16T11:51:00.000Z',
    });
    // Its transcript exists, but the session is outside the root.
    expect(outsideMessage).toBeUndefined();
    // In the snapshot, but its transcript has no assistant text.
    expect(noMessage).toBeUndefined();

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
      lastAssistantText: 'Done\n\nOpen questions:\n- Should I push it?\n\nNext steps:\n1. You review.',
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
      lastAssistantText: 'Profiling now.',
      lastUserPrompt: 'make it faster',
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
