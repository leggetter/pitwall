// The hand-off nudge (W133 B, in the pitwall plugin since W197): run as Claude Code runs it, node with the script reading a Stop
// input on stdin, against made-up transcripts. No real session content, and no test runs claude.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THRESHOLD, lastContext, levelOf, thresholdOf } from '../../plugin/hooks/handoffNudge.mjs';
import { makeKit, type Kit } from './pluginHookKit.js';

const SCRIPT = fileURLToPath(new URL('../../plugin/hooks/handoffNudge.mjs', import.meta.url));

let kit: Kit;
let tmp: string;
let stateDir: string;
let sessionN = 0;
beforeAll(async () => {
  kit = await makeKit('handoff');
  tmp = kit.tmp;
  stateDir = kit.stateDir;
});
afterAll(async () => {
  await kit.close();
});

const assistant = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { id, model: 'claude-test', role: 'assistant', usage, content: [{ type: 'text', text: 'made up' }] }, ...extra });
const usage = (input: number, read: number, write: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 10 });
const user = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'made up' } });
const request = JSON.stringify({ type: 'api-request-blob', blob: 'x'.repeat(2000) });

function transcript(lines: string[]): string {
  const file = path.join(tmp, `t-${++sessionN}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function newSession(): string {
  return `00000000-0000-4000-8000-${String(++sessionN).padStart(12, '0')}`;
}

function run(input: Record<string, unknown> | string, threshold = 1000, dir = stateDir, home = kit.home) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, PITWALL_HOME: home, PITWALL_HANDOFF_THRESHOLD: String(threshold), PITWALL_HANDOFF_STATE_DIR: dir },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const stop = (sessionId: string, transcriptPath: string, extra: Record<string, unknown> = {}) => ({
  session_id: sessionId,
  transcript_path: transcriptPath,
  cwd: tmp,
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'made up',
  ...extra,
});

function nudged(stdout: string): string {
  const output = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(output.hookSpecificOutput.hookEventName).toBe('Stop');
  return output.hookSpecificOutput.additionalContext;
}

describe('lastContext()', () => {
  it('sums the last main-chain call’s input, cache reads and cache writes', () => {
    expect(lastContext([assistant('m1', usage(1, 2, 3)), user, assistant('m2', usage(10, 500, 40)), request].join('\n'))).toBe(550);
  });

  it('skips sidechain, synthetic and request lines, and lines cut or not JSON', () => {
    const text = [
      assistant('m1', usage(5, 100, 0)),
      assistant('m2', usage(5, 900_000, 0), { isSidechain: true }),
      JSON.stringify({ type: 'assistant', message: { id: 'm3', model: '<synthetic>', usage: usage(0, 900_000, 0) } }),
      '{"type":"api-request","usage":{"input_tokens":900000',
      'not json',
    ].join('\n');
    expect(lastContext(text)).toBe(105);
  });

  it('is undefined with no usage, or when a compaction comes after the last call', () => {
    expect(lastContext([user, request].join('\n'))).toBeUndefined();
    expect(lastContext([assistant('m1', usage(1, 300_000, 0)), JSON.stringify({ type: 'system', subtype: 'compact_boundary' }), user].join('\n'))).toBeUndefined();
  });
});

describe('levels and the threshold', () => {
  it('is 200K by default, with a positive whole-number override only', () => {
    expect(THRESHOLD).toBe(200_000);
    expect(thresholdOf({})).toBe(200_000);
    expect(thresholdOf({ PITWALL_HANDOFF_THRESHOLD: '1000' })).toBe(1000);
    expect(thresholdOf({ PITWALL_HANDOFF_THRESHOLD: '0' })).toBe(200_000);
    expect(thresholdOf({ PITWALL_HANDOFF_THRESHOLD: '-5' })).toBe(200_000);
    expect(thresholdOf({ PITWALL_HANDOFF_THRESHOLD: 'lots' })).toBe(200_000);
    expect([levelOf(199_999, THRESHOLD), levelOf(200_000, THRESHOLD), levelOf(400_000, THRESHOLD)]).toEqual([0, 1, 2]);
  });
});

describe('the hook, run as Claude Code runs it', () => {
  it('prints nothing under the threshold', () => {
    const result = run(stop(newSession(), transcript([user, assistant('m1', usage(1, 900, 0)), request])));
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('does nothing while pitwall isn’t running', () => {
    const result = run(stop(newSession(), transcript([user, assistant('m1', usage(2, 1200, 300))])), 1000, stateDir, kit.emptyHome);
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('nudges once past the threshold, naming the size and the handoff skill', () => {
    const result = run(stop(newSession(), transcript([user, assistant('m1', usage(2, 1200, 300)), request])));
    expect(result.status).toBe(0);
    const message = nudged(result.stdout);
    expect(message).toMatch(/about 2K tokens/);
    expect(message).toMatch(/handoff skill/);
    expect(message).toMatch(/safe point/);
  });

  it('doesn’t nudge again at the same level, does at twice the threshold, and re-arms after a compaction', () => {
    const session = newSession();
    const at = (n: number) => transcript([user, assistant(`m${n}`, usage(0, n, 0))]);
    expect(nudged(run(stop(session, at(1500))).stdout)).toMatch(/about 2K/);
    expect(run(stop(session, at(1600))).stdout).toBe('');
    expect(nudged(run(stop(session, at(2100))).stdout)).toMatch(/about 2K/);
    expect(run(stop(session, at(2500))).stdout).toBe('');
    // Compacted back under the threshold, then past it again.
    expect(run(stop(session, at(400))).stdout).toBe('');
    expect(nudged(run(stop(session, at(1100))).stdout)).toMatch(/about 1K/);
  });

  it('keeps sessions apart', () => {
    const file = transcript([assistant('m1', usage(0, 5000, 0))]);
    expect(run(stop(newSession(), file)).stdout).not.toBe('');
    expect(run(stop(newSession(), file)).stdout).not.toBe('');
  });

  it('does nothing when Claude Code is already continuing because of a Stop hook', () => {
    const result = run(stop(newSession(), transcript([assistant('m1', usage(0, 5000, 0))]), { stop_hook_active: true }));
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('ignores sidechain records, even large ones, after the main chain’s last call', () => {
    const file = transcript([assistant('m1', usage(0, 500, 0)), assistant('s1', usage(0, 900_000, 0), { isSidechain: true })]);
    expect(run(stop(newSession(), file)).stdout).toBe('');
  });

  it('leaves other events and sub-agents alone', () => {
    const file = transcript([assistant('m1', usage(0, 5000, 0))]);
    expect(run(stop(newSession(), file, { hook_event_name: 'SubagentStop' })).stdout).toBe('');
    expect(run(stop(newSession(), file, { agent_id: 'a1' })).stdout).toBe('');
  });

  it('fails soft: a missing or malformed transcript, bad input, or an odd session id exits 0 silently', () => {
    const quiet = { status: 0, stdout: '', stderr: '' };
    expect(run(stop(newSession(), path.join(tmp, 'missing.jsonl')))).toEqual(quiet);
    expect(run(stop(newSession(), transcript(['{"type":"assistant","message":{', 'garbage', ''])))).toEqual(quiet);
    expect(run(stop(newSession(), tmp))).toEqual(quiet);
    expect(run(stop(newSession(), 'relative.jsonl'))).toEqual(quiet);
    expect(run(stop('../escape', transcript([assistant('m1', usage(0, 5000, 0))])))).toEqual(quiet);
    expect(run({ hook_event_name: 'Stop' })).toEqual(quiet);
    expect(run('not json')).toEqual(quiet);
    expect(run('')).toEqual(quiet);
  });

  it('reads past large lines at the end of the file', () => {
    const big = JSON.stringify({ type: 'api-request-blob', blob: 'x'.repeat(3 * 1024 * 1024) });
    const result = run(stop(newSession(), transcript([assistant('m1', usage(0, 5000, 0)), big, big])));
    expect(nudged(result.stdout)).toMatch(/about 5K/);
  });

  it('stays silent when the state folder is a link, as another user could plant in a shared /tmp', () => {
    const real = path.join(tmp, 'elsewhere');
    mkdirSync(real);
    const link = path.join(tmp, 'linked-state');
    symlinkSync(real, link);
    const result = run(stop(newSession(), transcript([user, assistant('m1', usage(0, 5000, 0))])), 1000, link);
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('stays silent, and reads nothing from it, when the state folder is open to others (W197 review, F2)', () => {
    const open = path.join(tmp, 'open-state');
    mkdirSync(open);
    chmodSync(open, 0o777);
    const session = newSession();
    writeFileSync(path.join(open, `${session}.json`), JSON.stringify({ v: 1, level: 2 }));
    const result = run(stop(session, transcript([user, assistant('m1', usage(0, 5000, 0))])), 1000, open);
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('neither hangs on a FIFO nor follows a link to /dev/zero as a state file (W197 review, F2)', () => {
    const own = path.join(tmp, 'own-state');
    mkdirSync(own, { mode: 0o700 });
    const fifo = newSession();
    expect(spawnSync('mkfifo', [path.join(own, `${fifo}.json`)]).status).toBe(0);
    const zero = newSession();
    symlinkSync('/dev/zero', path.join(own, `${zero}.json`));
    for (const session of [fifo, zero]) {
      const started = Date.now();
      const result = run(stop(session, transcript([user, assistant('m1', usage(0, 5000, 0))])), 1000, own);
      expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(Date.now() - started).toBeLessThan(5000);
    }
  });

  it('stays silent with a relative state folder, rather than write in the working directory', () => {
    const result = run(stop(newSession(), transcript([user, assistant('m1', usage(0, 5000, 0))])), 1000, 'relative-state');
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });
});
