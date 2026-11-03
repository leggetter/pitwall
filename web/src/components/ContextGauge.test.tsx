// The context gauge (W133): the row's badge over 200K and over 400K, nothing below or when unknown,
// and the session view's number, badge, "unavailable" and note. Made-up sessions only.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CONTEXT_HIGH_TOKENS, CONTEXT_WARN_TOKENS, type SessionSummary } from '../../../src/shared/protocol.js';
import { contextLevel, formatTokens } from '../context.js';
import { group, session } from '../test/fixtures.js';
import { ContextMeta, ContextNote } from './ContextGauge.js';
import { SessionRow } from './SessionRow.js';

function renderRow(s: SessionSummary) {
  render(
    <ul>
      <SessionRow session={s} group={group({ sessions: [s] })} />
    </ul>,
  );
  return document.querySelector<HTMLElement>('li.session')!;
}

describe('context levels and numbers', () => {
  it('flags over 200K in warning and over 400K in danger, not at the thresholds', () => {
    expect(contextLevel(CONTEXT_WARN_TOKENS)).toBe('ok');
    expect(contextLevel(CONTEXT_WARN_TOKENS + 1)).toBe('warn');
    expect(contextLevel(CONTEXT_HIGH_TOKENS)).toBe('warn');
    expect(contextLevel(CONTEXT_HIGH_TOKENS + 1)).toBe('high');
  });

  it('shortens, rounding down', () => {
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(85_400)).toBe('85K');
    expect(formatTokens(412_999)).toBe('412K');
    expect(formatTokens(1_190_000)).toBe('1.1M');
  });
});

describe("the row's context badge", () => {
  it('shows nothing at or below 200K, or when the size is unknown', () => {
    const row = renderRow(session({ contextTokens: 150_000 }));
    expect(row.querySelector('.context-badge')).toBeNull();
    const unknown = renderRow(session());
    expect(unknown.querySelector('.context-badge')).toBeNull();
  });

  it('shows a warning badge over 200K, with its level in text', () => {
    const badge = renderRow(session({ contextTokens: 212_345 })).querySelector('.context-badge')!;
    expect(badge.classList.contains('badge-subtle-warning')).toBe(true);
    expect(badge.textContent).toBe('Context 212K, over 200K');
  });

  it('shows a danger badge over 400K', () => {
    const badge = renderRow(session({ contextTokens: 760_000 })).querySelector('.context-badge')!;
    expect(badge.classList.contains('badge-subtle-danger')).toBe(true);
    expect(badge.textContent).toBe('Context 760K, over 400K');
  });

  it("isn't on a finished session's muted row", () => {
    const row = renderRow(session({ contextTokens: 760_000, alive: false, finished: true, kind: 'interactive', ended: true }));
    expect(row.querySelector('.context-badge')).toBeNull();
  });
});

describe("the session view's context", () => {
  it('shows the number quietly at or below 200K, with no badge and no note', () => {
    render(
      <>
        <ContextMeta tokens={85_000} />
        <ContextNote tokens={85_000} />
      </>,
    );
    expect(screen.getByText('Context 85K')).toBeTruthy();
    expect(document.querySelector('.context-badge')).toBeNull();
    expect(document.querySelector('.session-view-context-note')).toBeNull();
    expect(screen.getByRole('button', { name: /tokens of context its last call carried/ })).toBeTruthy();
  });

  it('shows the badge and a note on what to do over 200K', () => {
    render(
      <>
        <ContextMeta tokens={250_000} />
        <ContextNote tokens={250_000} />
      </>,
    );
    expect(document.querySelector('.context-badge.badge-subtle-warning')!.textContent).toBe('Context 250K, over 200K');
    const note = document.querySelector('.session-view-context-note')!;
    expect(note.textContent).toContain('250K tokens of context, over 200K');
    expect(note.textContent).toContain('/compact');
    expect(note.textContent).toContain('handoff');
  });

  it('says to hand off now over 400K', () => {
    render(
      <>
        <ContextMeta tokens={916_000} />
        <ContextNote tokens={916_000} />
      </>,
    );
    expect(document.querySelector('.context-badge.badge-subtle-danger')!.textContent).toBe('Context 916K, over 400K');
    expect(document.querySelector('.session-view-context-note')!.textContent).toContain('Hand it off to a new session now');
  });

  it('says unavailable when the size is unknown, with no note', () => {
    render(
      <>
        <ContextMeta tokens={undefined} />
        <ContextNote tokens={undefined} />
      </>,
    );
    expect(screen.getByText('Context unavailable')).toBeTruthy();
    expect(document.querySelector('.session-view-context-note')).toBeNull();
  });
});
