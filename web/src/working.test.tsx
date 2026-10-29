// The working line's rules (W102, working.ts): when the turn started, its mid-turn prompts aside; the
// step phrases; whether the line is working, waiting or gone; and how the time reads. Made-up entries.

import { describe, expect, it } from 'vitest';
import type { ConversationEntry } from '../../src/shared/protocol.js';
import { session } from './test/fixtures.js';
import {
  currentStep,
  elapsedText,
  STEP_MAX,
  stepPhrase,
  THINKING,
  turnMode,
  turnStarted,
  turnStartIndex,
  waitingAnnouncement,
  waitingLine,
  workingLineState,
} from './working.js';

const at = (second: number) => `2026-03-02T11:50:${String(second).padStart(2, '0')}.000Z`;
const you = (second: number, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({ kind: 'user', at: at(second), text: `prompt ${second}`, ...extra });
const claude = (second: number): ConversationEntry => ({ kind: 'assistant', at: at(second), text: `reply ${second}`, markdown: true });
/** A tool call; with `result`, its result has come back, an error or not. */
const call = (second: number, text: string, result?: 'ok' | 'error', extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  kind: 'tool',
  at: at(second),
  text,
  toolName: text.split(':')[0] ?? text,
  ...(result === undefined ? {} : { toolError: result === 'error' }),
  ...extra,
});
const CWD = '/Users/example/code/demo-app';

describe('working line: when the turn started', () => {
  it('is the newest prompt before the run of Claude’s own entries', () => {
    const entries = [you(1), claude(2), you(3), claude(4), call(5, 'Bash: npm test', 'ok'), { kind: 'to-pitwall' as const, at: at(6), text: 'Done.' }, call(7, 'Read: a.ts')];
    expect(turnStartIndex(entries)).toBe(2);
    expect(turnStarted(entries, false)).toEqual({ since: at(3), atLeast: false });
  });

  it('skips prompts typed mid-turn, and messages, reports and notifications that came mid-turn: they don’t restart it (W99)', () => {
    const entries = [
      you(1),
      claude(2),
      call(3, 'Bash: npm test', 'ok'),
      you(4, { midTurn: true }),
      { kind: 'cross-session' as const, at: at(5), text: 'From a peer.', from: 'pitwall-test-peer', midTurn: true as const },
      { kind: 'notice' as const, at: at(6), text: 'Build finished', midTurn: true as const },
      call(7, 'Bash: npm run lint'),
    ];
    expect(turnStartIndex(entries)).toBe(0);
    expect(turnStarted(entries, false).since).toBe(at(1));
  });

  it('skips a compaction and Claude Code’s own error, which the server marks mid-turn too', () => {
    const entries = [you(1), call(2, 'Bash: npm test', 'ok'), { kind: 'notice' as const, at: at(3), text: 'Conversation compacted', midTurn: true as const }, claude(4)];
    expect(turnStartIndex(entries)).toBe(0);
  });

  it('starts at a message from another session, a task notification or a slash command between turns', () => {
    expect(turnStartIndex([you(1), claude(2), { kind: 'cross-session', at: at(3), text: 'Please look.', from: 'pitwall-test-peer' }, claude(4)])).toBe(2);
    expect(turnStartIndex([you(1), claude(2), { kind: 'notice', at: at(3), text: 'Background command finished' }, call(4, 'Bash: npm test')])).toBe(2);
  });

  it('is the prompt itself while Claude has written nothing since', () => {
    expect(turnStarted([you(1), claude(2), you(3)], false)).toEqual({ since: at(3), atLeast: false });
  });

  it('is at least the oldest entry shown when the turn began before them, and that entry at the transcript’s start', () => {
    const entries = [call(10, 'Bash: npm test', 'ok'), claude(11), call(12, 'Bash: npm run build')];
    expect(turnStartIndex(entries)).toBe(-1);
    expect(turnStarted(entries, true)).toEqual({ since: at(10), atLeast: true });
    expect(turnStarted(entries, false)).toEqual({ since: at(10), atLeast: false });
  });

  it('has no time when the entry that began it has none', () => {
    expect(turnStarted([{ kind: 'user', text: 'no time' }, claude(2)], false)).toEqual({ atLeast: false });
    expect(turnStarted([], true)).toEqual({ atLeast: false });
  });
});

describe('working line: the current step', () => {
  const step = (...entries: ConversationEntry[]) => currentStep(entries, turnStartIndex(entries), CWD);

  it('is Thinking with no tool call waiting on its result', () => {
    expect(step(you(1))).toBe(THINKING);
    expect(step(you(1), call(2, 'Bash: npm test', 'ok'), call(3, 'Edit: a.ts', 'error'), claude(4))).toBe(THINKING);
  });

  it("runs a tool by the line the conversation shows for it", () => {
    expect(step(you(1), claude(2), call(3, 'Bash: npm test'))).toBe('Running Bash: npm test');
    expect(step(you(1), call(2, 'Grep: TODO'))).toBe('Running Grep: TODO');
    expect(step(you(1), call(2, 'WebFetch: https://example.com/docs'))).toBe('Running WebFetch: https://example.com/docs');
  });

  it('is the newest call still out, of several sent at once', () => {
    expect(step(you(1), call(2, 'Bash: npm test'), call(3, 'Bash: npm run lint', 'ok'))).toBe('Running Bash: npm test');
    expect(step(you(1), call(2, 'Bash: npm test'), call(3, 'Read: b.ts'))).toBe('Reading b.ts');
  });

  it('edits, writes and reads a file by its path from the session’s directory, or with home as ~ outside it', () => {
    expect(step(you(1), call(2, `Edit: ${CWD}/src/app.ts`))).toBe('Editing src/app.ts');
    expect(step(you(1), call(2, `MultiEdit: ${CWD}/src/app.ts`))).toBe('Editing src/app.ts');
    expect(step(you(1), call(2, `Write: ${CWD}/notes.md`))).toBe('Writing notes.md');
    expect(step(you(1), call(2, 'Read: /Users/example/other/app.ts'))).toBe('Reading ~/other/app.ts');
    expect(step(you(1), call(2, 'Edit: /etc/hosts'))).toBe('Editing /etc/hosts');
    // A call that named no file is run by its name, as the conversation's line shows it.
    expect(step(you(1), call(2, 'Edit'))).toBe('Running Edit');
  });

  it('waits for the sub-agents an Agent or Task call started, counting each still out', () => {
    expect(step(you(1), call(2, 'Agent: Read the routes'))).toBe('Waiting for 1 sub-agent');
    expect(step(you(1), call(2, 'Agent: Read the routes'), call(3, 'Task: Check the tests'), call(4, 'Agent: Done one', 'ok'))).toBe('Waiting for 2 sub-agents');
  });

  it('calls an MCP server’s tool by its server and tool', () => {
    expect(step(you(1), call(2, 'mcp__github__create_pull_request'))).toBe('Calling github create_pull_request');
    expect(step(you(1), call(2, 'mcp__claude_ai_Example_Docs__search'))).toBe('Calling claude_ai_Example_Docs search');
  });

  it('is capped, on one line, without control characters', () => {
    const long = step(you(1), call(2, `Bash: ${'x'.repeat(300)}`));
    expect(long).toHaveLength(STEP_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(step(you(1), call(2, 'Bash: echo\u001b[31m one\n\ttwo'))).toBe('Running Bash: echo one two');
  });

  it('never counts a call from an earlier turn that never got its result, as an interrupted one', () => {
    expect(step(call(1, 'Bash: sleep 100'), { kind: 'notice', at: at(2), text: '[Request interrupted by user]' }, you(3), claude(4))).toBe(THINKING);
  });

  it('names a call with no tool name by its line', () => {
    expect(stepPhrase({ kind: 'tool', text: 'tool' }, [], CWD)).toBe('Running tool');
  });
});

describe('working line: working, waiting or gone', () => {
  it('works while Claude Code says busy, or a background job is working', () => {
    expect(turnMode(session({ status: 'busy' }), true, undefined)).toBe('working');
    expect(turnMode(session({ kind: 'background', status: undefined, state: 'working' }), true, false)).toBe('working');
  });

  it('goes when the newest page says the turn has ended, whatever Claude Code says, as with a plugin’s monitor (spike 007)', () => {
    expect(turnMode(session({ status: 'busy' }), true, true)).toBe('idle');
  });

  it('waits on you with a prompt on screen, or a background job blocked on you', () => {
    expect(turnMode(session({ status: 'waiting', waitingFor: 'permission prompt' }), true, undefined)).toBe('waiting');
    expect(turnMode(session({ kind: 'background', status: 'idle', state: 'blocked', needsYou: { reason: 'claude-code', text: 'Keep the archive?' } }), true, true)).toBe('waiting');
  });

  it('is gone when idle, done, ended, not running or no longer listed', () => {
    expect(turnMode(session({ status: 'idle' }), true, undefined)).toBe('idle');
    expect(turnMode(session({ kind: 'background', status: undefined, state: 'done' }), true, undefined)).toBe('idle');
    expect(turnMode(session({ status: 'busy' }), false, undefined)).toBe('idle');
    expect(turnMode(session({ status: undefined, alive: false, pid: undefined }), true, undefined)).toBe('idle');
    expect(turnMode(session({ ended: true, finished: true, alive: false, pid: undefined, status: undefined }), true, undefined)).toBe('idle');
    // A blocked job that needs nothing of you is idle (W69).
    expect(turnMode(session({ kind: 'background', status: 'idle', state: 'blocked', needsYou: undefined }), true, undefined)).toBe('idle');
  });

  it('says what it waits for and where to answer, by kind, with no time', () => {
    expect(waitingLine(session({ status: 'waiting', waitingFor: 'permission prompt' }), false)).toEqual({ mode: 'waiting', text: 'Waiting for you: permission prompt', where: 'Answer it in its terminal.' });
    expect(waitingLine(session({ kind: 'background', status: 'waiting', state: 'blocked', waitingFor: 'input needed' }), true)).toEqual({
      mode: 'waiting',
      text: 'Waiting for you: input needed',
      where: 'Answer it in its Terminal tab.',
    });
    // Where pitwall can't attach to it, it doesn't say where.
    expect(waitingLine(session({ kind: 'background', status: 'idle', state: 'blocked' }), false)).toEqual({ mode: 'waiting', text: 'Waiting for you' });
    expect(waitingAnnouncement({ mode: 'waiting', text: 'Waiting for you: permission prompt', where: 'Answer it in its terminal.' })).toBe(
      'Waiting for you: permission prompt. Answer it in its terminal.',
    );
    expect(waitingAnnouncement({ mode: 'waiting', text: 'Waiting for you' })).toBe('Waiting for you.');
  });

  it('builds the working line from the entries shown', () => {
    const working = session({ status: 'busy', cwd: CWD });
    expect(workingLineState('working', working, false, [you(1), call(2, `Edit: ${CWD}/a.ts`)], false)).toEqual({ mode: 'working', since: at(1), step: 'Editing a.ts' });
    expect(workingLineState('working', working, false, [call(2, 'Bash: npm test')], true)).toEqual({ mode: 'working', since: at(2), atLeast: true, step: 'Running Bash: npm test' });
    expect(workingLineState('idle', working, false, [you(1)], false)).toEqual({ mode: 'idle' });
  });
});

describe('working line: how long', () => {
  it('reads in seconds, minutes and seconds, then hours and minutes', () => {
    expect(elapsedText(0)).toBe('0s');
    expect(elapsedText(45_900)).toBe('45s');
    expect(elapsedText(134_000)).toBe('2m 14s');
    expect(elapsedText(3_900_000)).toBe('1h 5m');
  });

  it('says at least, in whole minutes, when the start is further back than what’s shown', () => {
    expect(elapsedText(45_000, true)).toBe('45s+');
    expect(elapsedText(734_000, true)).toBe('12m+');
    expect(elapsedText(3_900_000, true)).toBe('1h 5m+');
  });

  it('is 0s for a start in the future, from a clock that’s off', () => {
    expect(elapsedText(-5_000)).toBe('0s');
  });
});
