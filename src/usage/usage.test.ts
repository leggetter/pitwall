import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatReport } from './format.js';
import { costOf, priceKey } from './prices.js';
import { buildUsageReport, distribution, lexicalRepo, pitwallKindOf, type UsageReport } from './report.js';

// Made-up transcripts, shaped like Claude Code's: no real session's content.
const NOW = Date.parse('2026-11-02T12:00:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const SECRET = 'SECRET-TEXT-NEVER-PRINTED';

interface Usage {
  input?: number;
  write?: number;
  write1h?: number;
  read?: number;
  output?: number;
  speed?: string;
}

function assistant(id: string, when: string, cwd: string, u: Usage, extra: Record<string, unknown> = {}, content: unknown[] = [{ type: 'text', text: SECRET }]) {
  const write = u.write ?? 0;
  return JSON.stringify({
    type: 'assistant',
    timestamp: when,
    cwd,
    effort: 'high',
    message: {
      id,
      model: 'claude-opus-5-5',
      content,
      usage: {
        input_tokens: u.input ?? 0,
        cache_creation_input_tokens: write,
        cache_read_input_tokens: u.read ?? 0,
        output_tokens: u.output ?? 0,
        cache_creation: { ephemeral_1h_input_tokens: u.write1h ?? 0, ephemeral_5m_input_tokens: write - (u.write1h ?? 0) },
        ...(u.speed === undefined ? {} : { speed: u.speed }),
      },
    },
    ...extra,
  });
}

function toolResult(toolUseId: string, when: string, cwd: string, text: string) {
  return JSON.stringify({ type: 'user', timestamp: when, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } });
}

let dir: string;
let configDir: string;
let pitwallHome: string;

async function transcript(project: string, file: string, lines: string[], mtimeHoursAgo = 1) {
  const full = path.join(configDir, 'projects', project, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, lines.join('\n') + '\n');
  const when = new Date(NOW - mtimeHoursAgo * 3_600_000);
  await utimes(full, when, when);
  return full;
}

async function report(): Promise<UsageReport> {
  return buildUsageReport({ days: 14, now: NOW, configDir, home: dir, pitwallHome, resolveRepo: async (cwd) => lexicalRepo(cwd) });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-usage-'));
  configDir = path.join(dir, '.claude');
  pitwallHome = path.join(dir, '.pitwall');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the usage report', () => {
  it('counts each response once, skips bad lines, reads sub-agents, and leaves out old files', async () => {
    const repo = path.join(dir, 'git', 'app');
    const worktree = path.join(repo, '.worktrees', 'feature');
    const toolUse = [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: SECRET } }];
    await transcript('-app', 'sess-a.jsonl', [
      JSON.stringify({ type: 'custom-title', customTitle: SECRET, sessionId: 'sess-a' }),
      assistant('msg_1', at(3), repo, { input: 10, write: 1000, write1h: 1000, output: 50 }, {}, toolUse),
      // The same response on a second line, as Claude Code writes one line per content block.
      assistant('msg_1', at(3), repo, { input: 10, write: 1000, write1h: 1000, output: 50 }),
      toolResult('toolu_1', at(3), repo, 'x'.repeat(4000)),
      '{"type":"assistant","message":{"id":"msg_broken"',
      assistant('msg_2', at(2), repo, { input: 5, read: 1000, write: 200, output: 20 }),
      // Before the window, in a file written during it.
      assistant('msg_old', at(24 * 20), repo, { input: 999_999 }),
      // A sub-agent's call copied into its parent's file, as older versions did.
      assistant('msg_sub_1', at(2), repo, { input: 1, read: 300, output: 3 }, { isSidechain: true }),
    ]);
    await transcript('-app', 'sess-a/subagents/agent-a1.jsonl', [
      assistant('msg_sub_1', at(2), repo, { input: 1, read: 300, output: 3 }, { isSidechain: true }),
      assistant('msg_sub_2', at(2), repo, { input: 1, read: 400, output: 4 }, { isSidechain: true }),
    ]);
    await writeFile(path.join(configDir, 'projects', '-app', 'sess-a', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: SECRET }));
    await transcript('-app-wt', 'sess-b.jsonl', [assistant('msg_3', at(1), worktree, { input: 100, output: 10, speed: 'fast' })]);
    // Older than the window by its mtime: never opened.
    await transcript('-app', 'sess-old.jsonl', [assistant('msg_x', at(24 * 30), repo, { input: 1_000_000 })], 24 * 30);
    // pitwall's own relay, by its directory.
    await transcript('-pitwall-relay', 'sess-r.jsonl', [assistant('msg_r', at(1), path.join(pitwallHome, 'relay'), { input: 7, output: 7 })]);

    const r = await report();

    expect(r.files).toMatchObject({ main: 3, subagent: 1, olderThanWindow: 1, withCalls: 4 });
    expect(r.lines.malformed).toBe(1);
    expect(r.lines.outsideWindow).toBe(1);
    expect(r.duplicates.sameFileLines).toBe(1);
    expect(r.duplicates.crossFileCalls).toBe(1);
    expect(r.totals.calls).toBe(6);
    expect(r.totals.input).toBe(10 + 5 + 1 + 1 + 100 + 7);
    expect(r.totals.cacheWrite).toBe(1200);
    expect(r.totals.cacheWrite1h).toBe(1000);
    expect(r.totals.cacheRead).toBe(1000 + 300 + 400);

    // The sub-agent's calls count once, under its own file.
    expect(r.rule3.subagent).toMatchObject({ runs: 1, calls: 2, cacheRead: 700 });
    expect(r.rule3.byAgentType.map((row) => row.key)).toEqual(['Explore']);

    // The worktree is grouped under its repo, and pitwall's relay on its own.
    const repos = r.rule2.byRepo.map((row) => row.key);
    expect(repos).toContain('~/git/app');
    expect(repos).toContain("(pitwall's own: relay)");
    expect(r.rule2.byRepo.find((row) => row.key === '~/git/app')?.sessions).toBe(2);
    expect(r.pitwall.byKind).toEqual([expect.objectContaining({ key: 'relay', calls: 1, total: 14 })]);

    // Tool results: one, its size in characters, its tool's name from the call that asked for it.
    expect(r.rule5).toMatchObject({ results: 1, estimatedTokens: 1000 });
    expect(r.rule5.byTool[0]).toMatchObject({ tool: 'Read', results: 1, chars: 4000 });
    expect(r.rule5.shareOfContextSent).toBeGreaterThan(0);

    // Costs at list price: msg_3 is fast mode, twice the rate.
    const fast = costOf({ model: 'claude-opus-5-5', input: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 10, speed: 'fast' }) ?? 0;
    expect(fast).toBeCloseTo(((100 * 4 + 10 * 20) / 1e6) * 2, 12);
    expect(r.totals.cost).toBeGreaterThan(fast);

    // Nothing from a message, a tool's input or output, a title or a sub-agent's description.
    const text = formatReport(r);
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(text).toContain('Rule 5: big tool outputs');
  });

  it('copes with no transcripts at all', async () => {
    const r = await report();
    expect(r.totals.calls).toBe(0);
    expect(r.files.unreadable).toBe(1);
    expect(() => formatReport(r)).not.toThrow();
  });
});

describe('prices', () => {
  it('keys a model id without its date, provider prefix or context suffix', () => {
    expect(priceKey('claude-opus-4-1-20250805')).toBe('claude-opus-4-1');
    expect(priceKey('claude-opus-4-20250514')).toBe('claude-opus-4');
    expect(priceKey('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(priceKey('us.anthropic.claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  });

  it('prices cache writes by TTL, Haiku 5.5 by prompt length, and knows nothing of an unknown model', () => {
    const call = { model: 'claude-opus-5-5', input: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6, output: 1e6 };
    expect(costOf(call)).toBeCloseTo(4 + 5 + 8 + 0.2 + 20, 9);
    expect(costOf({ ...call, geo: 'us' })).toBeCloseTo((4 + 5 + 8 + 0.2 + 20) * 1.1, 9);
    const haiku = { model: 'claude-haiku-5-5', input: 50_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
    expect(costOf(haiku)).toBeCloseTo(0.005, 12);
    expect(costOf({ ...haiku, cacheRead: 60_000 })).toBeCloseTo(50_000 * 0.5e-6 + 60_000 * 0.05e-6, 12);
    expect(costOf({ ...call, model: 'claude-unknown-9' })).toBeUndefined();
  });
});

describe('helpers', () => {
  it('tells pitwall’s own calls apart by directory or name', () => {
    expect(pitwallKindOf('/h/.pitwall/supervisor/session', [], '/h/.pitwall')).toBe('supervisor');
    expect(pitwallKindOf('/h/.pitwall/relay', [], '/h/.pitwall')).toBe('relay');
    expect(pitwallKindOf('/tmp/x', ['pitwall-recap'], '/h/.pitwall')).toBe('recap');
    expect(pitwallKindOf('/tmp/x', ['pitwall-test-relay-1'], '/h/.pitwall')).toBe('test');
    expect(pitwallKindOf('/tmp/x', ['my session'], '/h/.pitwall')).toBeUndefined();
  });

  it('groups a gone worktree under its repo by its path', () => {
    expect(lexicalRepo('/x/repo/.worktrees/a/sub')).toBe('/x/repo');
    expect(lexicalRepo('/x/repo/.claude/worktrees/b')).toBe('/x/repo');
    expect(lexicalRepo('/x/repo')).toBe('/x/repo');
  });

  it('takes nearest-rank percentiles', () => {
    expect(distribution([5, 1, 3, 2, 4])).toMatchObject({ count: 5, median: 3, p90: 5, max: 5, sum: 15, mean: 3 });
    expect(distribution([])).toMatchObject({ count: 0, median: 0, max: 0 });
  });
});
