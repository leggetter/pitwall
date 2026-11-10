// The Usage view's incremental reads (W158): each transcript read on from where the last read
// stopped. Made-up transcripts shaped like Claude Code's; no real session's content.
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUsageLedger } from './ledger.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

function call(id: string, when: string, u: { input?: number; write?: number; read?: number; output?: number; model?: string } = {}, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: when,
    cwd: '/made-up/work/repo',
    message: {
      id,
      model: u.model ?? 'claude-opus-5-5',
      content: [{ type: 'text', text: 'made up' }],
      usage: {
        input_tokens: u.input ?? 1,
        cache_creation_input_tokens: u.write ?? 0,
        cache_read_input_tokens: u.read ?? 0,
        output_tokens: u.output ?? 1,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: u.write ?? 0 },
      },
    },
    ...extra,
  });
}

let dir: string;
let projects: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-ledger-'));
  projects = path.join(dir, 'projects');
  await mkdir(path.join(projects, 'p'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = (name: string) => path.join(projects, 'p', name);

async function touch(full: string, hoursAgo = 0) {
  const when = new Date(NOW - hoursAgo * 3_600_000);
  await utimes(full, when, when);
}

describe('the ledger', () => {
  it('reads each transcript on from where the last read stopped', async () => {
    const a = file('aaaaaaaa-0000-4000-8000-000000000001.jsonl');
    await writeFile(a, `${call('m1', at(3))}\n${'x'.repeat(5000)}\n`);
    await touch(a, 2);
    const ledger = createUsageLedger({ projectsDir: projects, now: () => NOW });
    const first = await ledger.refresh(NOW - 86_400_000);
    expect(first.files).toBe(1);
    expect(first.bytesRead).toBeGreaterThan(5000);
    expect(ledger.scans()[0]?.calls.map((each) => each.id)).toEqual(['m1']);

    // Nothing new: nothing read.
    expect((await ledger.refresh(NOW - 86_400_000)).bytesRead).toBe(0);

    // A line appended, and half of the next: only the new bytes are read, and the half waits.
    const next = call('m2', at(2), { output: 7 });
    const half = call('m3', at(1));
    await appendFile(a, `${next}\n${half.slice(0, 40)}`);
    await touch(a, 1.5);
    const second = await ledger.refresh(NOW - 86_400_000);
    expect(second.bytesRead).toBe(next.length + 1 + 40);
    expect(ledger.scans()[0]?.calls.map((each) => each.id)).toEqual(['m1', 'm2']);
    await appendFile(a, `${half.slice(40)}\n${call('m1', at(3))}\n`);
    await touch(a, 1);
    await ledger.refresh(NOW - 86_400_000);
    // m1 again is a repeat of a response already counted.
    expect(ledger.scans()[0]?.calls.map((each) => each.id)).toEqual(['m1', 'm2', 'm3']);
    expect(ledger.scans()[0]?.sameFileDuplicates).toBe(1);
  });

  it('reads a replaced or shortened file again, drops a deleted one, and leaves out files older than asked', async () => {
    const a = file('aaaaaaaa-0000-4000-8000-000000000001.jsonl');
    const old = file('aaaaaaaa-0000-4000-8000-000000000002.jsonl');
    await writeFile(a, `${call('m1', at(3))}\n${call('m2', at(2))}\n`);
    await writeFile(old, `${call('o1', at(100))}\n`);
    await touch(a);
    await touch(old, 100);
    const ledger = createUsageLedger({ projectsDir: projects, now: () => NOW });
    await ledger.refresh(NOW - 86_400_000);
    expect(ledger.scans().flatMap((scan) => scan.calls.map((each) => each.id))).toEqual(['m1', 'm2']);

    // A longer window takes in the older file.
    await ledger.refresh(NOW - 5 * 86_400_000);
    expect(ledger.scans().flatMap((scan) => scan.calls.map((each) => each.id)).sort()).toEqual(['m1', 'm2', 'o1']);

    // Rewritten shorter: read again from the start.
    await writeFile(a, `${call('n1', at(1))}\n`);
    await ledger.refresh(NOW - 86_400_000);
    expect(ledger.scans().find((scan) => scan.file === a)?.calls.map((each) => each.id)).toEqual(['n1']);

    // Gone: dropped.
    await unlink(old);
    await ledger.refresh(NOW - 86_400_000);
    expect(ledger.scans().map((scan) => scan.file)).toEqual([a]);
  });

  it('reads a file cut short and written again in place, or with an older time, from the start', async () => {
    const a = file('aaaaaaaa-0000-4000-8000-000000000001.jsonl');
    await writeFile(a, `${call('m1', at(3))}\n`);
    await touch(a, 1);
    const ledger = createUsageLedger({ projectsDir: projects, now: () => NOW });
    await ledger.refresh(NOW - 86_400_000);
    // Same inode, longer, but its first line is another one now.
    await writeFile(a, `${call('n1', at(2))}\n${call('n2', at(1))}\n`);
    await touch(a, 0.5);
    await ledger.refresh(NOW - 86_400_000);
    expect(ledger.scans()[0]?.calls.map((each) => each.id)).toEqual(['n1', 'n2']);
    // The same bytes again with an older time: read again, and still counted once.
    await touch(a, 0.9);
    await ledger.refresh(NOW - 86_400_000);
    expect(ledger.scans()[0]?.calls.map((each) => each.id)).toEqual(['n1', 'n2']);
  });

  it('never waits on a FIFO or follows a link, for a transcript, a sub-agent’s meta file or its folder', async () => {
    const session = 'aaaaaaaa-0000-4000-8000-000000000001';
    const sub = path.join(projects, 'p', session, 'subagents');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, 'agent-1.jsonl'), `${call('s1', at(1))}\n`);
    execFileSync('mkfifo', [path.join(sub, 'agent-1.meta.json')]);
    await writeFile(path.join(sub, 'agent-2.jsonl'), `${call('s2', at(1))}\n`);
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ agentType: 'linked' }));
    await symlink(path.join(dir, 'meta.json'), path.join(sub, 'agent-2.meta.json'));
    // A second session whose subagents folder is a link elsewhere: not followed.
    const elsewhere = path.join(dir, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'agent-9.jsonl'), `${call('x9', at(1))}\n`);
    await mkdir(path.join(projects, 'p', 'aaaaaaaa-0000-4000-8000-000000000002'));
    await symlink(elsewhere, path.join(projects, 'p', 'aaaaaaaa-0000-4000-8000-000000000002', 'subagents'));
    const ledger = createUsageLedger({ projectsDir: projects, now: () => NOW });
    const stats = await ledger.refresh(NOW - 86_400_000);
    expect(stats.files).toBe(2);
    const scans = ledger.scans();
    expect(scans.flatMap((scan) => scan.calls.map((each) => each.id)).sort()).toEqual(['s1', 's2']);
    expect(scans.map((scan) => scan.agentType)).toEqual([undefined, undefined]);
  }, 5000);

  it('drops a line over the cap, counts it as malformed, and never reads it again (W180, U-F1)', async () => {
    const a = file('aaaaaaaa-0000-4000-8000-000000000001.jsonl');
    // A line with no newline, longer than the cap: what's read of it is dropped, not kept for later.
    await writeFile(a, `${call('m1', at(3))}\n${'y'.repeat(3000)}`);
    await touch(a, 2);
    const ledger = createUsageLedger({ projectsDir: projects, now: () => NOW, maxLineBytes: 1000 });
    const first = await ledger.refresh(NOW - 86_400_000);
    expect(ledger.scans()[0]!.calls.map((c) => c.id)).toEqual(['m1']);
    expect(first.bytesRead).toBeGreaterThan(3000);
    // Written to again, the skipped line isn't read again: only what's new.
    await appendFile(a, `${'y'.repeat(500)}\n${call('m2', at(1))}\n${'z'.repeat(1500)}\n${call('m3', at(1))}\n`);
    await touch(a, 1);
    const second = await ledger.refresh(NOW - 86_400_000);
    expect(second.bytesRead).toBeLessThan(3000 + call('m2', at(1)).length + call('m3', at(1)).length);
    const scan = ledger.scans()[0]!;
    expect(scan.calls.map((c) => c.id)).toEqual(['m1', 'm2', 'm3']);
    // The long line and the 1,500-byte one, a line each, never parsed.
    expect(scan.malformed).toBe(2);
    expect(scan.lines).toBe(5);
  });

  it('copes with no projects folder', async () => {
    const ledger = createUsageLedger({ projectsDir: path.join(dir, 'missing'), now: () => NOW });
    const stats = await ledger.refresh(0);
    expect(stats.files).toBe(0);
    expect(stats.unreadable).toBe(1);
    expect(ledger.scans()).toEqual([]);
  });

  it('shares a read in flight, and reads again for a longer window', async () => {
    const a = file('aaaaaaaa-0000-4000-8000-000000000001.jsonl');
    await writeFile(a, `${call('m1', at(3))}\n`);
    await touch(a, 50);
    const ledger = createUsageLedger({ projectsDir: projects, now: () => NOW });
    const [short, same, long] = await Promise.all([ledger.refresh(NOW - 86_400_000), ledger.refresh(NOW - 86_400_000), ledger.refresh(NOW - 3 * 86_400_000)]);
    expect(short).toBe(same);
    expect(short.files).toBe(0);
    expect(long.files).toBe(1);
  });
});
