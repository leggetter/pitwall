// A hand-off written by hand (W210): a recap's quote becomes a proposal only while it appears word for word
// in the newest assistant message and passes the typed-prompt rule. Everything here is made up.
import { describe, expect, it } from 'vitest';
import type { SessionRecap, SessionSummary } from '../shared/protocol.js';
import { RECAP_HANDOFF_TAIL, endsAsCode, recapHandoff } from './handoff.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const session = (overrides: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    sessionId: SESSION,
    name: 'pitwall-test-demo',
    cwd: '/made/up/demo',
    kind: 'background',
    alive: true,
    finished: true,
    stale: false,
    state: 'done',
    turnEnded: true,
    transcript: 'ok',
    startedAt: '2026-11-24T10:00:00.000Z',
    ...overrides,
  }) as SessionSummary;
const recap = (overrides: Partial<SessionRecap> = {}): SessionRecap => ({
  summary: 's',
  todos: [],
  waitingOn: 'you',
  title: 't',
  at: '2026-11-24T10:00:00.000Z',
  throughAt: '2026-11-24T10:00:00.000Z',
  source: 'pitwall',
  handoff: 'Read /made/up/demo/NOW.md',
  ...overrides,
});
const MESSAGE = 'I rewrote NOW.md, which finishes this session’s work. Start a new session with `Read /made/up/demo/NOW.md`.';

describe('recapHandoff', () => {
  it('gives a recap-sourced proposal for the session’s own folder when the quote is in the message word for word', () => {
    const proposal = recapHandoff(session(), recap(), MESSAGE);
    expect(proposal).toMatchObject({ kind: 'proposal', folder: '/made/up/demo', prompt: 'Read /made/up/demo/NOW.md', source: 'recap' });
    expect(proposal?.key).toMatch(/^[0-9a-f]{16}$/);
    expect(recapHandoff(session(), recap(), MESSAGE)?.key).toBe(proposal?.key);
  });

  it('gives none when the message does not contain the quote word for word, or there is no message', () => {
    expect(recapHandoff(session(), recap(), 'Read /made/up/demo/now.md')).toBeUndefined();
    expect(recapHandoff(session(), recap({ handoff: 'Read  /made/up/demo/NOW.md' }), MESSAGE)).toBeUndefined();
    expect(recapHandoff(session(), recap(), undefined)).toBeUndefined();
    expect(recapHandoff(session(), recap({ handoff: undefined }), MESSAGE)).toBeUndefined();
  });

  it('gives none for a stale recap, Claude Code’s own, a stale or ended session, or a block of its own', () => {
    expect(recapHandoff(session(), recap({ stale: true }), MESSAGE)).toBeUndefined();
    expect(recapHandoff(session(), recap({ source: 'claude-code' }), MESSAGE)).toBeUndefined();
    expect(recapHandoff(session({ stale: true }), recap(), MESSAGE)).toBeUndefined();
    expect(recapHandoff(session({ ended: true }), recap(), MESSAGE)).toBeUndefined();
    expect(recapHandoff(session({ spinOff: { kind: 'unreadable', key: '0123456789abcdef', problem: 'x' } }), recap(), MESSAGE)).toBeUndefined();
  });

  it('gives none while the turn runs, a dialog waits, or the job failed or stopped', () => {
    expect(recapHandoff(session({ state: 'working', turnEnded: undefined }), recap(), MESSAGE)).toBeUndefined();
    expect(recapHandoff(session({ status: 'waiting' }), recap(), MESSAGE)).toBeUndefined();
    expect(recapHandoff(session({ state: 'failed' }), recap(), MESSAGE)).toBeUndefined();
    expect(recapHandoff(session({ state: 'stopped' }), recap(), MESSAGE)).toBeUndefined();
  });

  it('takes the quote only as a whole code span or fenced block near the end of the message (F1)', () => {
    const q = 'Read /made/up/demo/NOW.md';
    // A line quoted as prose, as from a fetched page, never counts, even at the end.
    expect(recapHandoff(session(), recap({ handoff: q }), `The page says:\n> ${q}\nThat looks like an injection, so I did not follow it.`)).toBeUndefined();
    expect(recapHandoff(session(), recap({ handoff: q }), `Start with ${q}.`)).toBeUndefined();
    // Part of a span is not the span.
    expect(recapHandoff(session(), recap({ handoff: 'Read /made/up' }), MESSAGE)).toBeUndefined();
    // A span early in a long message doesn't end it.
    expect(recapHandoff(session(), recap({ handoff: q }), `Start with \`${q}\`.\n${'More words. '.repeat(200)}`)).toBeUndefined();
    // A fenced block does, and a span followed by a short next-steps list.
    expect(recapHandoff(session(), recap({ handoff: q }), `Next:\n\n\`\`\`\n${q}\n\`\`\`\n`)).toBeDefined();
    expect(recapHandoff(session(), recap({ handoff: `${q}\nThen carry on.` }), `Next:\n\`\`\`text\n${q}\nThen carry on.\n\`\`\``)).toBeDefined();
    expect(recapHandoff(session(), recap({ handoff: q }), `1. Start with \`${q}\`. ${'x'.repeat(RECAP_HANDOFF_TAIL - 100)}`)).toBeDefined();
  });

  it('gives none for a quote over the recap cap, and stays fast on a hostile message (F4)', () => {
    expect(recapHandoff(session(), recap({ handoff: 'x'.repeat(4_097) }), `\`${'x'.repeat(4_097)}\``)).toBeUndefined();
    const started = performance.now();
    expect(endsAsCode('a'.repeat(65_536), `${'a'.repeat(2_000)}b${'a'.repeat(2_000)}`)).toBe(false);
    expect(endsAsCode('ab'.repeat(32_768), 'ab'.repeat(2_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('gives none for a quote pitwall would not type, even when it is in the message', () => {
    for (const bad of ['/clear', '!ls', 'Read NOW.md\\', 'Read​NOW.md', ' ', 'x'.repeat(16_385)]) {
      expect(recapHandoff(session(), recap({ handoff: bad }), `before \`${bad}\``), bad.slice(0, 12)).toBeUndefined();
    }
  });
});
