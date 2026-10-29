import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLL_INTERVAL_MS, type IndexSnapshot, type PrLink, type RelayAlert, type RelayOff } from '../shared/protocol.js';
import { createAgentsSource, type AgentRow, type AgentsResult } from './agents.js';
import { createEndedScanner, type EndedScanner, type EndedSession } from './ended.js';
import { createGroupResolver } from './grouping.js';
import { createIndexer, startIndexer, type IndexerDeps } from './index.js';
import { createJobReader, type JobNeeds } from './jobs.js';
import { createSubagentTracker } from './subagents.js';
import { createTranscriptReader, encodeProjectDir, type TranscriptInfo } from './transcripts.js';
import { createWorkedInScanner, type RepoWorkedIn, type TrackedSession, type WorkedInScanner } from './workedIn.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

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
        // Its prompt is the newest line, so a turn is running, as far as the page can tell (W102).
        turnEnded: false,
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

  it("reads a listed session's turn afresh from its transcript, for End session (W90), and 'unknown' whenever it can't say", async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-index-turn-'));
    try {
      const { state, deps } = harness();
      const at = new Date(NOW).toISOString();
      const lines = (...entries: object[]) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
      const prompt = { type: 'user', timestamp: at, message: { content: 'a prompt' } };
      const reply = { type: 'assistant', timestamp: at, message: { id: 'm1', content: [{ type: 'text', text: 'Done.' }] } };
      const turnEnd = { type: 'system', subtype: 'turn_duration', durationMs: 1234, timestamp: at };
      const file = path.join(dir, 'turn.jsonl');
      await writeFile(file, lines(prompt, reply, turnEnd));
      state.files.set('turn', file);
      state.files.set('out', file);
      state.result = { ok: true, rows: [row('turn', '/work/repo/a'), row('no-file', '/work/repo/b'), row('out', '/elsewhere/c')] };
      const indexer = createIndexer({ roots: ['/work'], intervalMs: 60_000 }, deps);
      // Before the first snapshot, nothing is listed.
      expect(await indexer.turnState('turn')).toBe('unknown');
      await new Promise<IndexSnapshot>((resolve) => indexer.subscribe(resolve));

      expect(await indexer.turnState('turn')).toBe('ended');
      // A new prompt since, written after the poll: read afresh, not from the poll's fields.
      await appendFile(file, lines(prompt));
      expect(await indexer.turnState('turn')).toBe('running');
      // No turn's end in its entries, as from an older Claude Code.
      await writeFile(file, lines(prompt, reply));
      expect(await indexer.turnState('turn')).toBe('unknown');
      // No transcript, outside the roots, never listed, and a file that has gone.
      expect(await indexer.turnState('no-file')).toBe('unknown');
      expect(await indexer.turnState('out')).toBe('unknown');
      expect(await indexer.turnState('never-listed')).toBe('unknown');
      await rm(file);
      expect(await indexer.turnState('turn')).toBe('unknown');
      indexer.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts a listed session's running sub-agents afresh, for End session (W90), and undefined whenever it can't say", async () => {
    vi.useRealTimers();
    const { state, deps } = harness();
    state.result = { ok: true, rows: [row('a', '/work/repo/a'), row('out', '/elsewhere/b')] };
    // Without a tracker it can't say.
    const bare = createIndexer({ roots: ['/work'], intervalMs: 60_000 }, deps);
    await new Promise<IndexSnapshot>((resolve) => bare.subscribe(resolve));
    expect(await bare.runningSubagents('a')).toBeUndefined();
    bare.stop();

    let answer: number | undefined | 'throw' = 2;
    const asked: string[] = [];
    const tracker = createSubagentTracker({ processStartMs: async () => undefined });
    tracker.runningFresh = async (sessionId) => {
      asked.push(sessionId);
      if (answer === 'throw') throw new Error('a bug');
      return answer;
    };
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 60_000 }, { ...deps, subagents: tracker });
    expect(await indexer.runningSubagents('a')).toBeUndefined();
    await new Promise<IndexSnapshot>((resolve) => indexer.subscribe(resolve));
    expect(await indexer.runningSubagents('a')).toBe(2);
    answer = undefined;
    expect(await indexer.runningSubagents('a')).toBeUndefined();
    answer = 'throw';
    expect(await indexer.runningSubagents('a')).toBeUndefined();
    // Outside the roots, or never listed: not asked.
    expect(await indexer.runningSubagents('out')).toBeUndefined();
    expect(await indexer.runningSubagents('never-listed')).toBeUndefined();
    expect(asked).toEqual(['a', 'a', 'a']);
    indexer.stop();
  });

  it("shows a session's SendMessage calls to the relay as to-pitwall entries when given the relay's name (W46), and as tool calls without it", async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-index-relay-'));
    try {
      const { state, deps } = harness();
      const file = path.join(dir, 'in.jsonl');
      const at = new Date(NOW).toISOString();
      const call = { type: 'assistant', timestamp: at, message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'SendMessage', input: { to: 'pitwall-test-relay', message: 'Done: **both** flows.' } }] } };
      await writeFile(file, `${JSON.stringify(call)}\n`);
      state.files.set('in', file);
      state.result = { ok: true, rows: [row('in', '/work/repo/a')] };
      for (const relayName of ['pitwall-test-relay', undefined]) {
        const indexer = createIndexer({ roots: ['/work'], intervalMs: 60_000, ...(relayName === undefined ? {} : { relayName }) }, deps);
        await new Promise<IndexSnapshot>((resolve) => indexer.subscribe(resolve));
        expect((await indexer.conversation('in'))?.entries).toEqual(
          relayName === undefined
            ? [{ kind: 'tool', at, text: 'SendMessage', toolName: 'SendMessage' }]
            : [{ kind: 'to-pitwall', at, text: 'Done: **both** flows.', markdown: true }],
        );
        indexer.stop();
      }
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

  it('keeps askedYou only for sessions that have finished their turn, and sorts them with the others that need you', async () => {
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
    expect(sessions.map((s) => [s.sessionId, s.askedYou?.excerpt, s.needsYou?.reason])).toEqual([
      ['idle-asked', 'Ship it?', 'asked'],
      ['waiting', undefined, 'prompt'],
      ['busy-asked', undefined, undefined],
      ['idle', undefined, undefined],
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
    alert = { at: '2026-10-16T11:59:00.000Z', detail: 'The relay tried to send a message when pitwall hadn’t asked it to.', count: 1, blocked: true, cause: 'unrequested' };
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

describe('createIndexer with the repos sessions worked in (W34, W39)', () => {
  const ROOT = '/work';
  /** Repos under the root; any other directory is in no repo. */
  const REPOS = ['/work/alpha', '/work/beta', '/work/gamma'];

  /** A fake scanner: `found` is what workedIn() answers, by session id, and `links` what prLinks() does; `tracked` records each track(). */
  function fakeScanner() {
    const found = new Map<string, RepoWorkedIn[]>();
    const links = new Map<string, PrLink[]>();
    const tracked: { sessions: TrackedSession[]; roots: string[] }[] = [];
    const scanner: WorkedInScanner = {
      track: (sessions, roots) => {
        tracked.push({ sessions: [...sessions], roots: [...roots] });
      },
      workedIn: (id) => found.get(id),
      prLinks: (id) => links.get(id),
      settled: async () => undefined,
      stats: () => ({ bytesRead: 0, calls: 0, scans: 0, gitRuns: 0, gitPeak: 0 }),
      stop: () => undefined,
    };
    return { scanner, found, links, tracked };
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

  it('lists each session only where it started, whatever it worked in (W39)', async () => {
    const { deps, found } = setup();
    found.set('in-alpha', [repo('/work/beta'), repo('/work/gamma', 5)]);
    found.set('in-root', [repo('/work/alpha'), repo('/work/gamma', 3)]);
    found.set('in-notes', [repo('/work/gamma')]);
    const indexer = createIndexer({ roots: [ROOT] }, deps);
    await flush();
    expect(placement(indexer.latest())).toEqual({
      // Started in alpha's subdirectory; not under beta, the sibling it worked in.
      'alpha (git)': ['in-alpha'],
      'beta (git)': ['in-beta'],
      // A directory below the root that's in no repo lists the session started in it, and only that.
      'notes (directory)': ['in-notes'],
      // The root's own group: every session started in the root, the one that worked in repos too.
      'work (directory)': ['in-root', 'in-root-alone'],
    });
    // gamma had only sessions that worked in it, so it has no group.
    expect(indexer.latest()?.groups.some((g) => g.key === '/work/gamma')).toBe(false);
    indexer.stop();
  });

  it('adds workedIn to the summary, each repo with the label its group has or would have, in the scanner’s order', async () => {
    const { deps, found } = setup();
    found.set('in-root', [repo('/work/alpha'), repo('/work/gamma', 5)]);
    const indexer = createIndexer({ roots: [ROOT] }, deps);
    await flush();
    const sessions = indexer.latest()?.groups.flatMap((g) => g.sessions) ?? [];
    // Listed once, in the root's group.
    expect(sessions.filter((s) => s.sessionId === 'in-root')).toHaveLength(1);
    expect(indexer.latest()?.groups.find((g) => g.key === ROOT)?.sessions.map((s) => s.sessionId)).toContain('in-root');
    expect(sessions.find((s) => s.sessionId === 'in-root')?.workedIn).toEqual([
      // alpha has a group, labelled the same; gamma has none. Each names the root its group sits under, or would (W42).
      { key: '/work/alpha', label: 'alpha', root: ROOT, calls: 12, changes: 1, lastAt: new Date(NOW - 60_000).toISOString() },
      { key: '/work/gamma', label: 'gamma', root: ROOT, calls: 12, changes: 1, lastAt: new Date(NOW - 5 * 60_000).toISOString() },
    ]);
    expect(indexer.latest()?.groups.find((g) => g.key === '/work/alpha')?.label).toBe('alpha');
    expect(sessions.find((s) => s.sessionId === 'in-beta')).not.toHaveProperty('workedIn');
    indexer.stop();
  });

  it('adds prLinks to the summary as copies, in the scanner’s order, with or without workedIn, and leaves out none or not yet scanned', async () => {
    const { deps, found, links } = setup();
    const at = new Date(NOW - 60_000).toISOString();
    const scanned: PrLink[] = [
      { kind: 'opened', repo: 'example/demo-app', number: 12, lastAt: at },
      { kind: 'pushed', repo: 'example/demo-app', branch: 'feature/made-up', lastAt: at },
    ];
    links.set('in-alpha', scanned);
    links.set('in-root', [{ kind: 'mentioned', repo: 'example/demo-api', number: 3, lastAt: at }]);
    found.set('in-root', [repo('/work/alpha')]);
    links.set('in-notes', []);
    const indexer = createIndexer({ roots: [ROOT] }, deps);
    await flush();
    const sessions = indexer.latest()?.groups.flatMap((g) => g.sessions) ?? [];
    const inAlpha = sessions.find((s) => s.sessionId === 'in-alpha');
    expect(inAlpha?.prLinks).toEqual(scanned);
    expect(inAlpha?.prLinks?.[0]).not.toBe(scanned[0]);
    expect(inAlpha).not.toHaveProperty('workedIn');
    expect(sessions.find((s) => s.sessionId === 'in-root')?.prLinks).toEqual([{ kind: 'mentioned', repo: 'example/demo-api', number: 3, lastAt: at }]);
    expect(sessions.find((s) => s.sessionId === 'in-notes')).not.toHaveProperty('prLinks');
    expect(sessions.find((s) => s.sessionId === 'in-beta')).not.toHaveProperty('prLinks');
    indexer.stop();
  });

  it("labels a worked-in repo from its own root, and names that root, as buildGroups would label and place its group, with ~ outside every root", async () => {
    const { state, deps, found } = setup();
    state.result = { ok: true, rows: [row('in-root', ROOT)] };
    // A repo under a second root, one nested below a directory, and a worktree whose main repo is outside the roots.
    found.set('in-root', [
      { ...repo('/other/service'), root: '/other' },
      repo('/work/projects/delta'),
      { ...repo('/home/someone/elsewhere/main'), root: ROOT },
    ]);
    const indexer = createIndexer({ roots: [ROOT, '/other'] }, deps);
    await flush();
    const summary = indexer.latest()?.groups.flatMap((g) => g.sessions).find((s) => s.sessionId === 'in-root');
    expect(summary?.workedIn?.map((r) => [r.key, r.label, r.root])).toEqual([
      // Under the other root: its group would sit under /other, so the web UI can list the session in that root's tab (W42).
      ['/other/service', 'service', '/other'],
      ['/work/projects/delta', 'projects/delta', ROOT],
      // A worktree touched under /work whose main repo is outside the roots: its group would sit under /work.
      ['/home/someone/elsewhere/main', '~/elsewhere/main', ROOT],
    ]);
    indexer.stop();
  });

  it('keeps a worktree’s and a subdirectory’s sessions under their repo, and nowhere else', async () => {
    const { state, deps, found } = setup();
    const resolve = deps.groups.resolve;
    // The real resolver gives a worktree its main repo's key, from git's common dir.
    deps.groups = { resolve: async (cwd) => (cwd.startsWith('/work/alpha-worktrees/') ? { key: '/work/alpha', kind: 'git' } : resolve(cwd)), prune() {} };
    state.result = { ok: true, rows: [row('in-alpha', '/work/alpha/src'), row('in-worktree', '/work/alpha-worktrees/feature'), row('in-beta', '/work/beta')] };
    found.set('in-alpha', [repo('/work/beta')]);
    found.set('in-worktree', [repo('/work/beta'), repo('/work/gamma')]);
    const indexer = createIndexer({ roots: [ROOT] }, deps);
    await flush();
    expect(placement(indexer.latest())).toEqual({ 'alpha (git)': ['in-alpha', 'in-worktree'], 'beta (git)': ['in-beta'] });
    indexer.stop();
  });

  it("keeps the root's group once every session started there has worked in repos", async () => {
    const { deps, found } = setup();
    found.set('in-root', [repo('/work/alpha')]);
    found.set('in-root-alone', [repo('/work/beta')]);
    const indexer = createIndexer({ roots: [ROOT] }, deps);
    await flush();
    expect(placement(indexer.latest())['work (directory)']).toEqual(['in-root', 'in-root-alone']);
    indexer.stop();
  });

  it('keeps a session where it started once its scan finishes, and adds what the scan found', async () => {
    const { deps, found } = setup();
    const indexer = createIndexer({ roots: [ROOT], intervalMs: 1000 }, deps);
    await flush();
    const before = placement(indexer.latest());
    expect(before['work (directory)']).toEqual(['in-root', 'in-root-alone']);
    found.set('in-root', [repo('/work/gamma')]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(placement(indexer.latest())).toEqual(before);
    const inRoot = indexer.latest()?.groups.flatMap((g) => g.sessions).find((s) => s.sessionId === 'in-root');
    expect(inRoot?.workedIn).toMatchObject([{ key: '/work/gamma', label: 'gamma' }]);
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
    const scanned = snapshots.at(-1);
    indexer.stop();
    // The session started in the root and changed api: it stays in the root's group, with api in its workedIn.
    expect(scanned?.groups.map((g) => [g.key, g.sessions.map((x) => x.sessionId)])).toEqual([[root, ['s']]]);
    expect(scanned?.groups[0]?.sessions[0]?.workedIn).toMatchObject([{ key: repoDir, label: 'api', root, calls: 1, changes: 1 }]);
  });

  it('names the root a worked-in repo sits under, another root’s included, from the real scanner (W42)', async () => {
    const root = path.join(dir, 'code');
    const other = path.join(dir, 'other');
    const here = path.join(root, 'api');
    const there = path.join(other, 'service');
    for (const repo of [here, there]) await mkdir(path.join(repo, '.git'), { recursive: true });
    const file = path.join(dir, 'made-up.jsonl');
    // Started in the first root itself: one edit in its repo, and two in a repo under the other root.
    const edit = (n: number, target: string) => ({ type: 'assistant', timestamp: new Date(NOW + n).toISOString(), cwd: root, message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'Edit', input: { file_path: path.join(target, `f${n}.ts`) } }] } });
    await writeFile(file, [edit(1, here), edit(2, there), edit(3, there)].map((line) => JSON.stringify(line)).join('\n') + '\n');
    const scanner = createWorkedInScanner({ home: dir, run: async (_file, args) => `${path.join(args[1] ?? '', '.git')}\n` });
    const { state, deps } = harness();
    deps.workedIn = scanner;
    deps.groups = { resolve: async (cwd) => ({ key: cwd, kind: 'directory' }), prune() {} };
    state.files.set('s', file);
    state.result = { ok: true, rows: [row('s', root)] };
    const snapshots: IndexSnapshot[] = [];
    const indexer = createIndexer({ roots: [root, other], intervalMs: 50 }, deps);
    indexer.subscribe((snapshot) => snapshots.push(snapshot));
    while (snapshots.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await scanner.settled();
    const before = snapshots.length;
    while (snapshots.length === before) await new Promise((resolve) => setTimeout(resolve, 10));
    indexer.stop();
    const scanned = snapshots.at(-1);
    // Still listed where it started; each repo names the root its group would sit under.
    expect(scanned?.groups.map((g) => [g.key, g.root, g.sessions.map((x) => x.sessionId)])).toEqual([[root, root, ['s']]]);
    const workedIn = scanned?.groups[0]?.sessions[0]?.workedIn ?? [];
    expect(workedIn.map(({ key, label, root: repoRoot, changes }) => ({ key, label, root: repoRoot, changes })).sort((a, b) => (a.key < b.key ? -1 : 1))).toEqual([
      { key: here, label: 'api', root, changes: 1 },
      { key: there, label: 'service', root: other, changes: 2 },
    ]);
  });
});

describe("Needs you from each session's context (W69)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The harness with a fake job reader answering `jobs` by short id, 'unknown' for any other. */
  function withJobs(jobs: Record<string, JobNeeds>) {
    const { state, deps } = harness();
    const reads: string[][] = [];
    const retained: string[][] = [];
    deps.jobs = {
      async read(shortId, sessionId) {
        reads.push([shortId, sessionId]);
        return jobs[shortId] ?? { kind: 'unknown' };
      },
      retain(ids) {
        retained.push([...ids].sort());
      },
    };
    return { state, deps, reads, retained };
  }

  const blockedJob = (id: string, shortId: string, overrides: Partial<AgentRow> = {}) =>
    row(id, `/work/repo/${id}`, { kind: 'background', shortId, status: 'idle', state: 'blocked', ...overrides });
  const reasons = (snapshot: IndexSnapshot | undefined) =>
    Object.fromEntries((snapshot?.groups ?? []).flatMap((g) => g.sessions.map((s) => [s.sessionId, s.needsYou ?? null])));

  it("reads each unfinished background job's file, and needs you only when the context says so", async () => {
    const { state, deps, reads, retained } = withJobs({
      ask1: { kind: 'needs', text: 'Do you prefer tea or coffee?' },
      none1: { kind: 'none' },
    });
    state.result = {
      ok: true,
      rows: [
        blockedJob('asks', 'ask1'),
        // Resumed, with Claude Code's "send a prompt to start": the job's file was read and asks nothing.
        blockedJob('placeholder', 'none1'),
        // Its file couldn't be used, so the old rule applies and the question is never hidden.
        blockedJob('unreadable', 'gone1'),
        blockedJob('done', 'done1', { pid: undefined, status: undefined, state: 'done' }),
        row('interactive', '/work/repo/i', { status: 'idle' }),
      ],
    };
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    expect(reasons(indexer.latest())).toEqual({
      asks: { reason: 'claude-code', text: 'Do you prefer tea or coffee?' },
      placeholder: null,
      unreadable: { reason: 'blocked' },
      done: null,
      interactive: null,
    });
    // Never a finished job's file, or an interactive session's.
    expect(reads.sort()).toEqual([
      ['ask1', 'asks'],
      ['gone1', 'unreadable'],
      ['none1', 'placeholder'],
    ]);
    expect(retained.at(-1)).toEqual(['ask1', 'done1', 'gone1', 'none1']);
    indexer.stop();
  });

  it('falls back to the old rule for every blocked job when there is no job reader, or it throws', async () => {
    const { state, deps } = harness();
    state.result = { ok: true, rows: [blockedJob('a', 'aaa1')] };
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    expect(reasons(indexer.latest())).toEqual({ a: { reason: 'blocked' } });
    indexer.stop();

    const throwing = harness();
    throwing.state.result = { ok: true, rows: [blockedJob('b', 'bbb1')] };
    throwing.deps.jobs = {
      read: async () => {
        throw new Error('made-up failure');
      },
      retain: () => undefined,
    };
    const second = createIndexer({ roots: ['/work'] }, throwing.deps);
    await flush();
    expect(reasons(second.latest())).toEqual({ b: { reason: 'blocked' } });
    second.stop();
  });

  it("needs you when the last turn ended asking you, though a plugin's monitor keeps the job busy and working", async () => {
    const { state, deps } = withJobs({ mon1: { kind: 'none' } });
    state.result = { ok: true, rows: [blockedJob('monitor', 'mon1', { pid: 4242, status: 'busy', state: 'working' })] };
    state.transcripts.set('monitor', {
      transcript: 'ok',
      lastActivityAt: new Date(NOW - 60_000).toISOString(),
      askedYou: { reason: 'question', excerpt: 'Do you prefer tea or coffee?' },
      turnEnded: true,
    });
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    const [summary] = indexer.latest()?.groups[0]?.sessions ?? [];
    expect(summary?.askedYou?.excerpt).toBe('Do you prefer tea or coffee?');
    expect(summary?.needsYou).toEqual({ reason: 'asked' });
    indexer.stop();
  });

  it('needs you after a restart you asked for, until a prompt newer than it, and polls soon', async () => {
    const { state, deps } = withJobs({ res1: { kind: 'none' } });
    const restartedAt = NOW - 10_000;
    state.result = { ok: true, rows: [blockedJob('resumed', 'res1', { state: 'working', status: 'busy' })] };
    state.transcripts.set('resumed', { transcript: 'ok', lastActivityAt: new Date(NOW - DAY_MS).toISOString(), lastPromptMs: NOW - DAY_MS });
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 60_000 }, deps);
    await flush();
    expect(reasons(indexer.latest())).toEqual({ resumed: null });

    indexer.noteRestart('resumed', restartedAt);
    await flush();
    expect(state.listCalls).toBe(2);
    expect(reasons(indexer.latest())).toEqual({ resumed: { reason: 'restarted' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reasons(indexer.latest())).toEqual({ resumed: { reason: 'restarted' } });

    // You sent it a prompt: it no longer needs you, even if its transcript can't be read later.
    state.transcripts.set('resumed', { transcript: 'ok', lastActivityAt: new Date(NOW).toISOString(), lastPromptMs: restartedAt + 5000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reasons(indexer.latest())).toEqual({ resumed: null });
    state.transcripts.set('resumed', { transcript: 'unreadable' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reasons(indexer.latest())).toEqual({ resumed: null });
    indexer.stop();
  });

  it('drops a restart once its session is no longer listed, keeps it through a failed poll, and ignores a bad one', async () => {
    const { state, deps } = withJobs({ res1: { kind: 'none' } });
    const listed: AgentsResult = { ok: true, rows: [blockedJob('resumed', 'res1', { state: 'working', status: 'idle' })] };
    state.result = listed;
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 60_000 }, deps);
    await flush();
    indexer.noteRestart('resumed', NOW);
    indexer.noteRestart('../escape', NOW);
    indexer.noteRestart('resumed-too', Number.NaN);
    await flush();
    expect(reasons(indexer.latest())).toEqual({ resumed: { reason: 'restarted' } });

    state.result = { ok: false, error: 'made-up failure' };
    await vi.advanceTimersByTimeAsync(60_000);
    state.result = listed;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reasons(indexer.latest())).toEqual({ resumed: { reason: 'restarted' } });

    state.result = { ok: true, rows: [] };
    await vi.advanceTimersByTimeAsync(60_000);
    state.result = listed;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reasons(indexer.latest())).toEqual({ resumed: null });
    indexer.stop();
  });

  it("doesn't need you for a restart that didn't wake the session, as when claude attach starts and then fails", async () => {
    const { state, deps } = withJobs({ cr1: { kind: 'none' } });
    // Crashed: working with no process. You confirm the restart, but claude attach exits without waking it.
    const crashed = blockedJob('crashed', 'cr1', { state: 'working', status: undefined, pid: undefined });
    state.result = { ok: true, rows: [crashed] };
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 60_000 }, deps);
    await flush();
    indexer.noteRestart('crashed', NOW);
    await flush();
    expect(reasons(indexer.latest())).toEqual({ crashed: null });
    // Woken later, by another attach, it has a process and waits for your prompt.
    state.result = { ok: true, rows: [{ ...crashed, pid: 5150, status: 'idle' }] };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reasons(indexer.latest())).toEqual({ crashed: { reason: 'restarted' } });
    indexer.stop();
  });

  it('never needs you for a restart of a session that is stale or finished', async () => {
    const { state, deps } = withJobs({ old1: { kind: 'none' }, fin1: { kind: 'none' } });
    state.result = {
      ok: true,
      rows: [
        blockedJob('stale', 'old1', { startedAt: new Date(NOW - 30 * DAY_MS).toISOString() }),
        blockedJob('finished', 'fin1', { pid: undefined, status: undefined, state: 'stopped' }),
      ],
    };
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    indexer.noteRestart('stale', NOW);
    indexer.noteRestart('finished', NOW);
    await flush();
    expect(reasons(indexer.latest())).toEqual({ stale: null, finished: null });
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
    const askedPage = await indexer.conversation(ids.asked);
    const outsidePage = await indexer.conversation(ids.outside);
    indexer.stop();

    // The session view reads the whole reply from the transcript, as the markdown it was written in (W36).
    expect(askedPage?.entries[askedPage.entries.length - 1]).toEqual({
      kind: 'assistant',
      at: '2026-10-16T11:51:00.000Z',
      text: '## Done\n\n**Open questions:**\n- Should I push it?\n\n**Next steps:**\n1. You review.',
      markdown: true,
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
          [ids.asked, 'ok', false],
          [ids.worktree, 'ok', false],
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
      // Only the session started in app: the root's session worked in it, which its workedIn says.
      [app]: { label: 'app', kind: 'git', ids: [ids.app] },
    });
    const rootSession = snapshot.groups.flatMap((g) => g.sessions).find((s) => s.sessionId === ids.root);
    expect(rootSession?.workedIn).toMatchObject([{ key: app, label: 'app', root, changes: 1 }]);
  });
});

describe('createIndexer with ended interactive sessions (W66)', () => {
  /** A fake scanner: `found` is what the last scan found; `tracked` records each track(). */
  function fakeEnded() {
    const state = {
      found: [] as EndedSession[],
      tracked: [] as { listed: string[]; roots: string[] }[],
      listener: undefined as (() => void) | undefined,
      stopped: false,
      throws: false,
    };
    const scanner: EndedScanner = {
      track(listed, roots) {
        if (state.throws) throw new Error('scanner bug');
        state.tracked.push({ listed: [...listed].sort(), roots: [...roots] });
      },
      // Unfiltered, unlike the real one, so the index's own check shows.
      sessions: () => state.found,
      file: (id) => state.found.find((s) => s.sessionId === id)?.file,
      subscribe(listener) {
        state.listener = listener;
        return () => (state.listener = undefined);
      },
      settled: async () => undefined,
      stats: () => ({ scans: 0, statted: 0, bytesRead: 0, tailReads: 0, fullReads: 0, lastScanMs: 0 }),
      stop: () => {
        state.stopped = true;
      },
    };
    return { scanner, ended: state };
  }

  const endedSession = (id: string, cwd: string, minutesAgo: number, extra: Partial<EndedSession> = {}): EndedSession => ({
    sessionId: id,
    file: `/made-up/projects/${id}.jsonl`,
    cwd,
    name: `${path.basename(cwd)}-${id.slice(0, 8)}`,
    startedAt: new Date(NOW - (minutesAgo + 30) * 60_000).toISOString(),
    transcript: { transcript: 'ok', lastActivityAt: new Date(NOW - minutesAgo * 60_000).toISOString(), lastUserPrompt: 'Fix the flaky test' },
    ...extra,
  });

  function setup() {
    const { state, deps } = harness();
    const fake = fakeEnded();
    deps.ended = fake.scanner;
    return { state, deps, ...fake };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists ended sessions where they started, as finished interactive sessions with no process, after the live ones', async () => {
    const { state, deps, ended } = setup();
    state.result = { ok: true, rows: [row('live', '/work/repo/a', { startedAt: new Date(NOW - 3 * 3_600_000).toISOString() })] };
    state.transcripts.set('live', { transcript: 'ok', lastActivityAt: new Date(NOW - 2 * 3_600_000).toISOString() });
    ended.found = [
      endedSession('ended-new', '/work/repo/b', 5, { transcript: { transcript: 'ok', lastActivityAt: new Date(NOW - 5 * 60_000).toISOString(), askedYou: { reason: 'question', excerpt: 'Push it?' } } }),
      endedSession('ended-old', '/work/other/c', 60, { name: 'named-by-flag' }),
    ];
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    const groups = indexer.latest()?.groups ?? [];
    expect(groups.map((g) => [g.key, g.sessions.map((s) => s.sessionId)])).toEqual([
      ['/work/repo', ['live', 'ended-new']],
      ['/work/other', ['ended-old']],
    ]);
    expect(groups[0]?.sessions[1]).toEqual({
      sessionId: 'ended-new',
      name: 'b-ended-ne',
      kind: 'interactive',
      cwd: '/work/repo/b',
      alive: false,
      startedAt: new Date(NOW - 35 * 60_000).toISOString(),
      stale: false,
      finished: true,
      ended: true,
      askedYou: { reason: 'question', excerpt: 'Push it?' },
      lastActivityAt: new Date(NOW - 5 * 60_000).toISOString(),
      transcript: 'ok',
    });
    expect(groups[1]?.sessions[0]).toMatchObject({ name: 'named-by-flag', lastUserPrompt: 'Fix the flaky test', ended: true });
    // The transcript reader isn't asked about them: the scanner read them.
    expect(state.reads).toEqual(['live']);
    indexer.stop();
  });

  it('hands the scanner every session id claude agents listed, excluded ones included, and never lists one of those as ended', async () => {
    const { state, deps, ended } = setup();
    state.result = { ok: true, rows: [row('live', '/work/repo/a'), row('relay', '/work/repo/r'), row('outside', '/elsewhere/x')] };
    ended.found = [endedSession('live', '/work/repo/a', 5), endedSession('relay', '/work/repo/r', 5), endedSession('gone-for-good', '/work/repo/c', 5)];
    const indexer = createIndexer({ roots: ['/work'], exclude: (r) => r.sessionId === 'relay' }, deps);
    await flush();
    expect(ended.tracked).toEqual([{ listed: ['live', 'outside', 'relay'], roots: ['/work'] }]);
    const sessions = indexer.latest()?.groups.flatMap((g) => g.sessions) ?? [];
    expect(sessions.map((s) => [s.sessionId, s.ended === true])).toEqual([
      ['live', false],
      ['gone-for-good', true],
    ]);
    indexer.stop();
  });

  it('counts a session as listed in a row parseAgentRows skips, an unknown kind, no startedAt or a relative cwd, so it never shows as ended (W81)', async () => {
    const { deps, ended } = setup();
    const startedAt = NOW - 60_000;
    const output = [
      { sessionId: 'live', kind: 'interactive', cwd: '/work/repo/a', startedAt, pid: 1000 },
      { sessionId: 'odd-kind', kind: 'remote', cwd: '/work/repo/b', startedAt, pid: 1001 },
      { sessionId: 'no-start', kind: 'interactive', cwd: '/work/repo/c', pid: 1002 },
      { sessionId: 'relative', kind: 'interactive', cwd: 'repo/d', startedAt, pid: 1003 },
    ];
    // The real source and parser, over made-up output: no `claude` runs.
    deps.agents = createAgentsSource({ run: async () => JSON.stringify(output) });
    ended.found = ['odd-kind', 'no-start', 'relative', 'gone-for-good'].map((id) => endedSession(id, '/work/repo/e', 5));
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    expect(ended.tracked).toEqual([{ listed: ['live', 'no-start', 'odd-kind', 'relative'], roots: ['/work'] }]);
    const sessions = indexer.latest()?.groups.flatMap((g) => g.sessions) ?? [];
    expect(sessions.map((s) => [s.sessionId, s.ended === true])).toEqual([
      ['live', false],
      ['gone-for-good', true],
    ]);
    indexer.stop();
  });

  it('checks the start directory afresh: one that has gone is marked, one no longer under a root is left out, and the exclude hook applies', async () => {
    const { deps, ended } = setup();
    deps.realpath = async (p) => {
      if (p === '/work/repo/removed') throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
      if (p === '/work/link') return '/elsewhere/target';
      return p;
    };
    ended.found = [endedSession('removed', '/work/repo/removed', 5), endedSession('moved', '/work/link', 6), endedSession('hidden', '/work/repo/h', 7)];
    const indexer = createIndexer({ roots: ['/work'], exclude: (r) => r.sessionId === 'hidden' }, deps);
    await flush();
    const sessions = indexer.latest()?.groups.flatMap((g) => g.sessions) ?? [];
    expect(sessions.map((s) => [s.sessionId, s.cwdMissing === true])).toEqual([['removed', true]]);
    indexer.stop();
  });

  it("gives the worked-in scanner ended sessions too, with the scanner's transcript, and adds what it found", async () => {
    const { state, deps, ended } = setup();
    const tracked: TrackedSession[][] = [];
    deps.workedIn = {
      track: (sessions) => tracked.push([...sessions]),
      workedIn: (id) => (id === 'ended' ? [{ key: '/work/api', root: '/work', calls: 3, changes: 1, lastAt: new Date(NOW).toISOString() }] : undefined),
      prLinks: (id) => (id === 'ended' ? [{ kind: 'opened', repo: 'example/demo-app', number: 7, lastAt: new Date(NOW).toISOString() }] : undefined),
      settled: async () => undefined,
      stats: () => ({ bytesRead: 0, calls: 0, scans: 0, gitRuns: 0, gitPeak: 0 }),
      stop: () => undefined,
    };
    state.files.set('live', '/made-up/projects/live.jsonl');
    state.result = { ok: true, rows: [row('live', '/work/repo/a')] };
    ended.found = [endedSession('ended', '/work/repo/b', 5)];
    const indexer = createIndexer({ roots: ['/work'] }, deps);
    await flush();
    expect(tracked[0]?.map((t) => [t.sessionId, t.file, t.startKey])).toEqual([
      ['live', '/made-up/projects/live.jsonl', '/work/repo'],
      ['ended', '/made-up/projects/ended.jsonl', '/work/repo'],
    ]);
    const endedSummary = indexer.latest()?.groups[0]?.sessions.find((s) => s.sessionId === 'ended');
    expect(endedSummary?.workedIn).toEqual([{ key: '/work/api', label: 'api', root: '/work', calls: 3, changes: 1, lastAt: new Date(NOW).toISOString() }]);
    expect(endedSummary?.prLinks).toEqual([{ kind: 'opened', repo: 'example/demo-app', number: 7, lastAt: new Date(NOW).toISOString() }]);
    indexer.stop();
  });

  it("answers conversation for an ended session from the scanner's transcript", async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-index-ended-'));
    try {
      const { deps, ended } = setup();
      const file = path.join(dir, 'ended.jsonl');
      await writeFile(file, `${JSON.stringify({ type: 'user', timestamp: new Date(NOW).toISOString(), message: { content: 'an old prompt' } })}\n`);
      ended.found = [endedSession('ended', '/work/repo/b', 5, { file })];
      const indexer = createIndexer({ roots: ['/work'], intervalMs: 60_000 }, deps);
      await new Promise<IndexSnapshot>((resolve) => indexer.subscribe(resolve));
      expect(await indexer.conversation('ended')).toEqual({ sessionId: 'ended', entries: [{ kind: 'user', at: new Date(NOW).toISOString(), text: 'an old prompt' }], turnEnded: false });
      indexer.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('polls soon when the scanner found a different set, and leaves ended sessions out when it throws', async () => {
    const { state, deps, ended } = setup();
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 60_000 }, deps);
    await flush();
    expect(state.listCalls).toBe(1);
    ended.found = [endedSession('ended', '/work/repo/b', 5)];
    ended.listener?.();
    await flush();
    expect(state.listCalls).toBe(2);
    expect(indexer.latest()?.groups.flatMap((g) => g.sessions.map((s) => s.sessionId))).toEqual(['ended']);

    ended.throws = true;
    indexer.pollSoon();
    await flush();
    expect(state.listCalls).toBe(3);
    expect(indexer.latest()?.groups).toEqual([]);
    expect(indexer.latest()?.source).toEqual({ ok: true });
    indexer.stop();
    expect(ended.stopped).toBe(true);
    expect(ended.listener).toBeUndefined();
  });

  it('pollSoon polls now, or once the running poll is done, never two at once', async () => {
    const { state, deps } = setup();
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 60_000 }, deps);
    await flush();
    expect(state.listCalls).toBe(1);
    indexer.pollSoon();
    await flush();
    expect(state.listCalls).toBe(2);

    let release!: () => void;
    state.gate = new Promise((resolve) => (release = resolve));
    indexer.pollSoon();
    await flush();
    expect(state.listCalls).toBe(3);
    // Asked twice more while that one runs: one more poll, after it.
    indexer.pollSoon();
    indexer.pollSoon();
    await flush();
    expect(state.listCalls).toBe(3);
    state.gate = undefined;
    release();
    await flush();
    await flush();
    expect(state.listCalls).toBe(4);
    indexer.stop();
    indexer.pollSoon();
    await flush();
    expect(state.listCalls).toBe(4);
  });
});

describe("the indexer with real transcripts and job files (W69)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-index-jobs-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sets needsYou from each session's job file and transcript", async () => {
    const root = path.join(dir, 'work');
    const cwd = path.join(root, 'app');
    await mkdir(cwd, { recursive: true });
    const configDir = path.join(dir, 'claude');
    const projectDir = path.join(configDir, 'projects', encodeProjectDir(cwd));
    await mkdir(projectDir, { recursive: true });
    const ids = {
      placeholder: '70000000-0000-4000-8000-000000000001',
      monitor: '70000000-0000-4000-8000-000000000002',
      asks: '70000000-0000-4000-8000-000000000003',
      mismatched: '70000000-0000-4000-8000-000000000004',
      older: '70000000-0000-4000-8000-000000000005',
    };
    const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
    const lines = (...entries: unknown[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
    const prompt = (minutes: number, content: string) => ({ type: 'user', timestamp: at(minutes), message: { role: 'user', content } });
    const reply = (minutes: number, text: string) => ({ type: 'assistant', timestamp: at(minutes), message: { id: `m${minutes}`, role: 'assistant', content: [{ type: 'text', text }] } });
    const turnEnd = (minutes: number) => ({ type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: at(minutes) });
    const transcript = (id: string, text: string) => writeFile(path.join(projectDir, `${id}.jsonl`), text);
    await transcript(ids.placeholder, lines(prompt(30, 'Tidy the docs'), reply(29, 'Tidied.'), turnEnd(29)));
    await transcript(ids.monitor, lines(prompt(20, 'Pick a drink'), reply(19, 'Do you prefer tea or coffee?'), turnEnd(19)));
    await transcript(ids.asks, lines(prompt(10, 'Plan the migration'), reply(9, 'Working on it.')));
    await transcript(ids.mismatched, lines(prompt(8, 'Run the checks'), reply(7, 'Checked.'), turnEnd(7)));
    // An older Claude Code's transcript: no turn_duration entries, so the status decides.
    await transcript(ids.older, lines(prompt(5, 'Look at the logs'), reply(4, 'Shall I open an issue?')));

    const jobsDir = path.join(configDir, 'jobs');
    const job = async (shortId: string, fields: Record<string, unknown>) => {
      await mkdir(path.join(jobsDir, shortId), { recursive: true });
      await writeFile(path.join(jobsDir, shortId, 'state.json'), JSON.stringify(fields));
    };
    await job('ph000001', { sessionId: ids.placeholder, state: 'blocked', needs: 'send a prompt to start' });
    await job('mn000002', { sessionId: ids.monitor, state: 'running' });
    await job('as000003', { sessionId: ids.asks, state: 'blocked', needs: 'Which table goes first?' });
    await job('mm000004', { sessionId: '70000000-0000-4000-8000-0000000000ff', state: 'blocked', needs: 'Not this one?' });

    const background = (id: string, shortId: string, overrides: Partial<AgentRow>) =>
      row(id, cwd, { kind: 'background', shortId, startedAt: at(60), ...overrides });
    const rows = [
      background(ids.placeholder, 'ph000001', { status: 'idle', state: 'blocked' }),
      background(ids.monitor, 'mn000002', { status: 'busy', state: 'working' }),
      background(ids.asks, 'as000003', { status: 'idle', state: 'blocked' }),
      background(ids.mismatched, 'mm000004', { status: 'idle', state: 'blocked' }),
      row(ids.older, cwd, { status: 'idle', startedAt: at(60) }),
    ];
    const now = () => NOW;
    const indexer = createIndexer(
      { roots: [root], intervalMs: 60_000 },
      {
        agents: { list: async () => ({ ok: true, rows }) },
        groups: { resolve: async (p) => ({ key: p, kind: 'directory' }), prune() {} },
        transcripts: createTranscriptReader({ configDir, now }),
        jobs: createJobReader({ jobsDir }),
        now,
        home: dir,
        concurrency: 4,
      },
    );
    const snapshot = await new Promise<IndexSnapshot>((resolve) => indexer.subscribe(resolve));
    indexer.stop();
    const byId = new Map(snapshot.groups.flatMap((g) => g.sessions).map((s) => [s.sessionId, s]));
    expect(byId.get(ids.placeholder)?.needsYou).toBeUndefined();
    expect(byId.get(ids.monitor)?.needsYou).toEqual({ reason: 'asked' });
    expect(byId.get(ids.monitor)?.askedYou?.excerpt).toBe('Do you prefer tea or coffee?');
    expect(byId.get(ids.asks)?.needsYou).toEqual({ reason: 'claude-code', text: 'Which table goes first?' });
    expect(byId.get(ids.mismatched)?.needsYou).toEqual({ reason: 'blocked' });
    expect(byId.get(ids.older)?.needsYou).toEqual({ reason: 'asked' });
    // Needs you first, by activity; the blocked job that asks nothing sorts as idle, last.
    expect(snapshot.groups[0]?.sessions.map((s) => s.sessionId)).toEqual([ids.older, ids.mismatched, ids.asks, ids.monitor, ids.placeholder]);
  });
});

describe('the indexer with a real ended-session scanner', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-index-ended-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('shows a session that ended within a poll of the scan, and only as listed once it is resumed', async () => {
    const root = path.join(dir, 'work');
    const cwd = path.join(root, 'app');
    await mkdir(cwd, { recursive: true });
    const configDir = path.join(dir, 'claude');
    const sessionId = '5e66fcb3-0000-4000-8000-000000000000';
    const projectDir = path.join(configDir, 'projects', encodeProjectDir(cwd));
    await mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    const at = new Date(Date.now() - 60_000).toISOString();
    const entry = (type: string, content: unknown) => ({ type, timestamp: at, cwd, entrypoint: 'cli', ...(type === 'user' ? { promptSource: 'typed' } : {}), message: { role: type, content } });
    await writeFile(file, `${JSON.stringify(entry('user', 'Tidy the docs'))}\n${JSON.stringify(entry('assistant', [{ type: 'text', text: 'Tidied.' }]))}\n`);
    await utimes(file, new Date(at), new Date(at));

    const { state, deps } = harness();
    deps.now = Date.now;
    deps.ended = createEndedScanner({ configDir });
    deps.groups = { resolve: async (p) => ({ key: p, kind: 'directory' }), prune() {} };
    state.result = { ok: true, rows: [] };
    const snapshots: IndexSnapshot[] = [];
    // A long interval: only the scanner's prompt makes the second poll.
    const indexer = createIndexer({ roots: [root], intervalMs: 600_000 }, deps);
    indexer.subscribe((snapshot) => snapshots.push(snapshot));
    while (snapshots.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(snapshots[0]?.groups).toEqual([]);
    expect(snapshots[1]?.groups.flatMap((g) => g.sessions)).toMatchObject([{ sessionId, name: `app-5e66fcb3`, ended: true, finished: true, lastUserPrompt: 'Tidy the docs' }]);
    expect(await indexer.conversation(sessionId)).toMatchObject({ entries: [{ kind: 'user', text: 'Tidy the docs' }, { kind: 'assistant', text: 'Tidied.' }] });

    // Resumed: claude agents lists it as a background session, and the next poll shows only that.
    state.result = { ok: true, rows: [row(sessionId, cwd, { kind: 'background', shortId: '5e66fcb3', state: 'blocked', status: 'idle' })] };
    indexer.pollSoon();
    while (snapshots.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(snapshots[2]?.groups.flatMap((g) => g.sessions).map((s) => [s.sessionId, s.kind, s.ended === true])).toEqual([[sessionId, 'background', false]]);
    indexer.stop();
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

describe('createIndexer: sub-agents (W76)', () => {
  // Synthetic transcripts and sub-agents only, in a temp folder shaped like Claude Code's.
  const at = (seconds: number) => new Date(NOW - 3_600_000 + seconds * 1000).toISOString();
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const call = (id: string, description: string, seconds: number) =>
    line({ type: 'assistant', timestamp: at(seconds), message: { id: `msg_${id}`, content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Agent', input: { description, run_in_background: true } }] } }) +
    line({ type: 'user', timestamp: at(seconds), message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: `Async agent launched successfully. agentId: ${id}` }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: id } });
  const ended = (id: string, seconds: number) =>
    line({ type: 'user', timestamp: at(seconds), origin: { kind: 'task-notification' }, message: { content: `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>` } }) +
    line({ type: 'user', timestamp: at(seconds + 1), origin: { kind: 'peer', from: id }, message: { content: `Report from ${id}.` } });
  const steps = (id: string, seconds: number, count: number) =>
    Array.from({ length: count }, (_, i) => line({ type: 'assistant', isSidechain: true, agentId: id, timestamp: at(seconds + i), message: { id: `m_${id}_${i}`, content: [{ type: 'text', text: `${id} step ${i}` }] } })).join('');

  let dir: string;
  let main: string;
  let folder: string;

  beforeEach(async () => {
    vi.useRealTimers();
    dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-index-subagents-'));
    folder = path.join(dir, 'live', 'subagents');
    await mkdir(folder, { recursive: true });
    main = path.join(dir, 'live.jsonl');
    for (const [id, description, seconds] of [['a1', 'First made-up job', 20], ['a2', 'Second made-up job', 30]] as const) {
      await writeFile(path.join(folder, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description, toolUseId: `toolu_${id}`, spawnDepth: 1, requestShape: 'background' }));
      await writeFile(path.join(folder, `agent-${id}.jsonl`), steps(id, seconds, 3));
    }
    await writeFile(path.join(folder, 'agent-m1.meta.json'), JSON.stringify({ description: 'Only a meta so far', toolUseId: 'toolu_m1' }));
    await writeFile(main, call('a1', 'First made-up job', 10) + call('a2', 'Second made-up job', 11));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** An indexer listing `live` and `none`, both alive, and `gone`, a finished background session, all with transcripts. */
  async function started() {
    const { state, deps } = harness();
    const none = path.join(dir, 'none.jsonl');
    const gone = path.join(dir, 'gone.jsonl');
    await writeFile(none, line({ type: 'user', timestamp: at(1), message: { content: 'a prompt' } }));
    await mkdir(path.join(dir, 'gone', 'subagents'), { recursive: true });
    await writeFile(path.join(dir, 'gone', 'subagents', 'agent-g1.jsonl'), steps('g1', 5, 1));
    await writeFile(gone, call('g1', 'Never ended', 4));
    state.files.set('live', main).set('none', none).set('gone', gone);
    state.result = {
      ok: true,
      rows: [
        row('live', '/work/repo/a', { startedAt: at(0) }),
        row('none', '/work/repo/b', { startedAt: at(0) }),
        row('gone', '/work/repo/c', { kind: 'background', shortId: 'gone1', pid: undefined, state: 'done', status: undefined, startedAt: at(0) }),
      ],
    };
    // No `ps` in tests: the process's start is unknown, so the startedAt rule applies.
    deps.subagents = createSubagentTracker({ processStartMs: async () => undefined });
    const indexer = createIndexer({ roots: ['/work'], intervalMs: 60_000 }, deps);
    return { indexer, state };
  }

  function sessionIn(snapshot: IndexSnapshot | undefined, id: string) {
    return snapshot?.groups.flatMap((group) => group.sessions).find((session) => session.sessionId === id);
  }

  /** The first snapshot, from now on, that `predicate` holds for. */
  function snapshotWhere(indexer: ReturnType<typeof createIndexer>, predicate: (snapshot: IndexSnapshot) => boolean): Promise<IndexSnapshot> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('no such snapshot'));
      }, 3000);
      const off = indexer.subscribe((snapshot) => {
        if (!predicate(snapshot)) return;
        clearTimeout(timer);
        off();
        resolve(snapshot);
      });
    });
  }

  it('adds subagentsRunning to a live session while any run, polls soon when its scan changes it, and drops it once none do', async () => {
    const { indexer } = await started();
    try {
      // The first poll has no scan to go on; the scan it starts makes the index poll again.
      const counted = await snapshotWhere(indexer, (s) => sessionIn(s, 'live')?.subagentsRunning !== undefined);
      // a1, a2 and m1, which has only its meta so far.
      expect(sessionIn(counted, 'live')?.subagentsRunning).toBe(3);
      expect(sessionIn(counted, 'none')).not.toHaveProperty('subagentsRunning');
      // Not alive: no count, though its sub-agent never ended.
      expect(sessionIn(counted, 'gone')).not.toHaveProperty('subagentsRunning');

      await appendFile(main, ended('a1', 100));
      const fewer = snapshotWhere(indexer, (s) => sessionIn(s, 'live')?.subagentsRunning === 2);
      indexer.pollSoon();
      await fewer;

      await appendFile(main, ended('a2', 110) + call('m1', 'Only a meta so far', 111) + ended('m1', 112));
      const none = snapshotWhere(indexer, (s) => sessionIn(s, 'live') !== undefined && sessionIn(s, 'live')?.subagentsRunning === undefined);
      indexer.pollSoon();
      await none;
    } finally {
      indexer.stop();
    }
  });

  it('lists a listed session’s sub-agents, an empty list for one with none, and nothing for one not listed', async () => {
    const { indexer } = await started();
    try {
      await snapshotWhere(indexer, () => true);
      const list = await indexer.subagents('live');
      expect(list?.sessionId).toBe('live');
      expect(list?.truncated).toBe(false);
      expect(list?.subagents.map((s) => [s.agentId, s.state, s.description])).toEqual([
        ['a2', 'running', 'Second made-up job'],
        ['a1', 'running', 'First made-up job'],
        ['m1', 'running', 'Only a meta so far'],
      ]);
      expect((await indexer.subagents('gone'))?.subagents).toMatchObject([{ agentId: 'g1', state: 'unknown', description: 'Never ended' }]);
      expect(await indexer.subagents('none')).toEqual({ sessionId: 'none', subagents: [], truncated: false });
      expect(await indexer.subagents('never-listed')).toBeUndefined();
    } finally {
      indexer.stop();
    }
  });

  it('pages a sub-agent’s own transcript, only for one of a listed session’s sub-agents', async () => {
    await writeFile(path.join(folder, 'agent-a1.jsonl'), steps('a1', 20, 60));
    const { indexer, state } = await started();
    try {
      await snapshotWhere(indexer, () => true);
      const newest = await indexer.subagentConversation('live', 'a1');
      expect(newest?.sessionId).toBe('live');
      expect(newest?.entries).toHaveLength(50);
      expect(newest?.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'a1 step 59' });
      const older = await indexer.subagentConversation('live', 'a1', newest?.before);
      expect(older?.entries.map((e) => e.text)).toEqual(Array.from({ length: 10 }, (_, i) => `a1 step ${i}`));
      expect(older?.before).toBeUndefined();

      // Listed by its meta only: an empty page, and no page before it.
      expect(await indexer.subagentConversation('live', 'm1')).toEqual({ sessionId: 'live', entries: [] });
      expect(await indexer.subagentConversation('live', 'm1', newest?.before)).toBeUndefined();
      for (const agentId of ['zz9', '../a1', 'a1/../a1', 'a1.jsonl', '', 'g1']) {
        expect(await indexer.subagentConversation('live', agentId)).toBeUndefined();
      }
      expect(await indexer.subagentConversation('never-listed', 'a1')).toBeUndefined();
      await expect(indexer.subagentConversation('live', 'a1', 'not a cursor')).rejects.toMatchObject({ reason: 'invalid' });
      // The session's own cursor is for another file: stale.
      await writeFile(main, `${await readFile(main, 'utf8')}${steps('x', 1, 60).replaceAll('"isSidechain":true,', '')}`);
      const sessionPage = await indexer.conversation('live');
      await expect(indexer.subagentConversation('live', 'a1', sessionPage?.before)).rejects.toMatchObject({ reason: 'stale' });
      // Rewritten since, with other text before the cursor's place, which its fingerprint covers,
      // since a file system may reuse the inode: stale.
      await rm(path.join(folder, 'agent-a1.jsonl'));
      await writeFile(path.join(folder, 'agent-a1.jsonl'), steps('z9', 20, 70));
      await expect(indexer.subagentConversation('live', 'a1', newest?.before)).rejects.toMatchObject({ reason: 'stale' });

      // A session that leaves the snapshot is no longer served.
      state.result = { ok: true, rows: [row('none', '/work/repo/b')] };
      await new Promise<void>((resolve) => {
        const off = indexer.subscribe(() => {
          off();
          resolve();
        });
        indexer.pollSoon();
      });
      expect(await indexer.subagentConversation('live', 'a1')).toBeUndefined();
      expect(await indexer.subagents('live')).toBeUndefined();
    } finally {
      indexer.stop();
    }
  });

  it("labels the session's conversation entries with its sub-agents", async () => {
    await appendFile(main, ended('a1', 100));
    const { indexer } = await started();
    try {
      await snapshotWhere(indexer, () => true);
      const entries = (await indexer.conversation('live'))?.entries ?? [];
      expect(entries.filter((e) => e.subagent !== undefined).map((e) => [e.kind, e.subagent])).toEqual([
        ['tool', { agentId: 'a1', description: 'First made-up job' }],
        ['tool', { agentId: 'a2', description: 'Second made-up job' }],
        ['cross-session', { agentId: 'a1', description: 'First made-up job' }],
      ]);
    } finally {
      indexer.stop();
    }
  });
});
