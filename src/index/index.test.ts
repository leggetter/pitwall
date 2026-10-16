import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexSnapshot } from '../shared/protocol.js';
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

  it('defaults to a 2 second interval', async () => {
    const { state, deps } = harness();
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    await vi.advanceTimersByTimeAsync(1999);
    expect(state.listCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.listCalls).toBe(2);
    indexer.stop();
  });

  it('notifies only when something other than generatedAt changed, but latest() is always the newest', async () => {
    const { state, deps } = harness();
    state.result = { ok: true, rows: [row('a', '/work/repo/a')] };
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 1000 }, deps);
    const received: IndexSnapshot[] = [];
    indexer.subscribe((s) => received.push(s));
    await flush();
    expect(received).toHaveLength(1);

    state.now += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(1);
    expect(indexer.latest()?.generatedAt).toBe(new Date(NOW + 1000).toISOString());

    state.transcripts.set('a', { transcript: 'ok', lastActivityAt: new Date(NOW).toISOString(), lastUserPrompt: 'go' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(2);
    expect(received[1]?.groups[0]?.sessions[0]?.lastUserPrompt).toBe('go');

    state.result = { ok: true, rows: [row('a', '/work/repo/a', { status: 'busy' })] };
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(3);
    indexer.stop();
  });

  it('never overlaps polls: a tick during a running poll is skipped', async () => {
    const { state, deps } = harness();
    let release!: () => void;
    state.gate = new Promise((resolve) => (release = resolve));
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 100 }, deps);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.listCalls).toBe(1);
    expect(indexer.latest()).toBeUndefined();

    state.gate = undefined;
    release();
    await flush();
    expect(indexer.latest()).toBeDefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.listCalls).toBe(2);
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
    };
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
    indexer.stop();

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
          [ids.repo, 'ok', false],
          [ids.stale, 'missing', true],
        ],
      },
      { label: 'notes', kind: 'directory', key: plain, sessions: [[ids.plain, 'missing', false]] },
    ]);
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
      error: 'claude agents --json failed: pitwall-test-no-such-claude was not found',
    });
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.roots).toEqual([await realpath(os.tmpdir())]);
  });
});
