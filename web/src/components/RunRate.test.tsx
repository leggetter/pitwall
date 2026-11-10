// The run rate on the header's Usage button (W159): reading the server's answer, asking only while on
// and visible, the figures' levels, Ahead of pace, the reading's age, and the pace in the Usage view.
// Made-up figures only.

import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_RATE_PATH, RUN_RATE_POLL_MS, USAGE_PATH, type RunRate, type RunRateWeek, type UsageView } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type ApiClient, type FetchLike } from '../api.js';
import { asRunRate, paceText, projectionText, useRunRate, type VisibilityEnv } from '../runRate.js';
import { group, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { Dashboard } from './Dashboard.js';
import { Header } from './Header.js';
import { UsageDialog } from './UsageDialog.js';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const RESETS = '2026-11-15T12:00:00.000Z';

function week(used: number, extra: Partial<RunRateWeek> = {}): RunRateWeek {
  return {
    usedPercentage: used,
    resetsAt: RESETS,
    level: used >= 90 ? 'red' : used >= 70 ? 'amber' : 'normal',
    pace: { targetAt: '2026-11-13T18:00:00.000Z', line: 45.1, points: used - 45.1, ahead: used - 45.1 >= 3, pastTarget: false },
    projection: { status: 'range', earliest: '2026-11-14T13:00:00.000Z', latest: null, perHour: { low: 0.4, high: 0.7 } },
    ...extra,
  };
}

function rate(seven: RunRateWeek | null, extra: Partial<RunRate & { status: 'available' }> = {}): RunRate {
  return { status: 'available', readAt: new Date(NOW - 60_000).toISOString(), target: { percent: 80, day: 'friday', time: '18:00' }, sevenDay: seven, fiveHour: null, ...extra };
}

afterEach(() => {
  vi.useRealTimers();
});

function header(runRate: RunRate | undefined) {
  return render(<Header state="live" onUsage={() => {}} runRate={runRate} />);
}

const usageButton = () => document.querySelector<HTMLButtonElement>('header .usage-button')!;

describe('reading the answer', () => {
  it('takes the three shapes, and refuses anything else', () => {
    expect(asRunRate({ status: 'off' })).toEqual({ status: 'off' });
    expect(asRunRate({ status: 'unavailable', readAt: '2026-11-11T12:00:00Z', reason: 'timeout' })).toMatchObject({ status: 'unavailable' });
    expect(asRunRate(rate(week(40)))).toEqual(rate(week(40)));
    expect(asRunRate(rate(null, { fiveHour: { usedPercentage: 20, resetsAt: null, level: 'normal' } }))).toBeDefined();
    expect(asRunRate(null)).toBeUndefined();
    expect(asRunRate({ status: 'available' })).toBeUndefined();
    expect(asRunRate(rate(week(40, { level: 'purple' as never })))).toBeUndefined();
    expect(asRunRate(rate(week(40, { usedPercentage: '40' as never })))).toBeUndefined();
    expect(asRunRate(rate(week(40, { projection: { status: 'range', earliest: 'soon' } as never })))).toBeUndefined();
    expect(asRunRate({ ...rate(week(40)), target: { percent: 80, day: 'funday', time: '18:00' } })).toBeUndefined();
  });

  it('says the pace and the projection in words', () => {
    expect(paceText(week(57).pace!)).toBe('12 points ahead of pace');
    expect(paceText(week(46).pace!)).toBe('On pace');
    expect(paceText(week(37).pace!)).toBe('8 points under the line');
    expect(projectionText({ status: 'thin' })).toMatch(/^Not enough readings yet this week/);
    expect(projectionText({ status: 'lasts' })).toBe('At this rate, it lasts to the reset.');
    expect(projectionText(week(40).projection)).toMatch(/^At this rate, 100% from \S+ \d\d:\d\d, or not before the reset\.$/);
  });
});

describe('asking for it', () => {
  function visibility(visible = true): VisibilityEnv & { set(next: boolean): void } {
    let shown = visible;
    const listeners = new Set<() => void>();
    return {
      visible: () => shown,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      set(next) {
        shown = next;
        for (const listener of listeners) listener();
      },
    };
  }

  function Probe({ api, on, env }: { api: ApiClient; on: boolean; env: VisibilityEnv }) {
    const answer = useRunRate(api, on, env);
    return <p data-testid="rate">{answer?.status ?? 'none'}</p>;
  }

  it('asks only while on and visible: at once, every 5 minutes, again when shown, never while hidden', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(rate(week(40))), { status: 200 }));
    const api = createApiClient({ apiKey: 'k'.repeat(43), fetch });
    const env = visibility();
    const view = render(<Probe api={api} on={false} env={env} />);
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(<Probe api={api} on env={env} />);
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(RUN_RATE_PATH);
    expect(screen.getByTestId('rate').textContent).toBe('available');
    await act(async () => vi.advanceTimersByTime(RUN_RATE_POLL_MS));
    expect(fetch).toHaveBeenCalledTimes(2);
    act(() => env.set(false));
    await act(async () => vi.advanceTimersByTime(3 * RUN_RATE_POLL_MS));
    expect(fetch).toHaveBeenCalledTimes(2);
    act(() => env.set(true));
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(3);
    view.rerender(<Probe api={api} on={false} env={env} />);
    expect(screen.getByTestId('rate').textContent).toBe('none');
    await act(async () => vi.advanceTimersByTime(3 * RUN_RATE_POLL_MS));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('takes a 404 as off, and keeps the last answer when an ask fails', async () => {
    const answers = [new Response(JSON.stringify(rate(week(40))), { status: 200 }), new Response(null, { status: 500 })];
    const fetch = vi.fn<FetchLike>(async () => answers.shift() ?? new Response(null, { status: 404 }));
    vi.useFakeTimers();
    const api = createApiClient({ apiKey: 'k'.repeat(43), fetch });
    render(<Probe api={api} on env={visibility()} />);
    await act(async () => {});
    expect(screen.getByTestId('rate').textContent).toBe('available');
    await act(async () => vi.advanceTimersByTime(RUN_RATE_POLL_MS));
    expect(screen.getByTestId('rate').textContent).toBe('available');
    await act(async () => vi.advanceTimersByTime(RUN_RATE_POLL_MS));
    expect(screen.getByTestId('rate').textContent).toBe('off');
  });
});

describe('the header’s Usage button', () => {
  it('is the icon alone, named Usage, with no figures: off, unavailable or not asked yet', () => {
    for (const each of [undefined, { status: 'off' } as RunRate, { status: 'unavailable', readAt: new Date(NOW).toISOString(), reason: 'timeout' } as RunRate, rate(null)]) {
      const { unmount } = header(each);
      expect(screen.getByRole('button', { name: 'Usage' }).textContent).toBe('');
      unmount();
    }
  });

  it('shows the week, in its level’s tone, with what’s on screen in its name', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { rerender } = header(rate(week(45)));
    const button = screen.getByRole('button', { name: /^Usage: Week 45%/ });
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.querySelector('[data-level]')?.className).toContain('badge-subtle-neutral');
    expect(within(button).queryByText('Ahead of pace')).toBeNull();
    rerender(<Header state="live" onUsage={() => {}} runRate={rate(week(72))} />);
    expect(usageButton().querySelector('[data-level]')?.className).toContain('badge-subtle-warning');
    rerender(<Header state="live" onUsage={() => {}} runRate={rate(week(93))} />);
    expect(usageButton().querySelector('[data-level]')?.className).toContain('badge-subtle-danger');
    expect(usageButton().textContent).toBe('Usage: Week 93%Ahead of pace');
  });

  it('says Ahead of pace over the line, has the pace in its description, and the five hours only when sent', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    header(rate(week(57), { fiveHour: { usedPercentage: 30, resetsAt: '2026-11-11T14:00:00.000Z', level: 'normal' } }));
    const button = usageButton();
    expect(within(button).getByText('Ahead of pace').className).toContain('badge-subtle-warning');
    expect(within(button).getByText('5h 30%')).toBeTruthy();
    // At 600 px and narrower, only the week's figure shows: the rest is in the name, and ahead is an icon in its badge.
    expect(button.querySelector('[data-level] svg.usage-meter-ahead-icon')).not.toBeNull();
    expect([...button.querySelectorAll('.usage-meter-wide')].map((each) => each.textContent)).toEqual(['5h 30%', 'Ahead of pace']);
    const description = document.getElementById(button.getAttribute('aria-describedby')!.split(' ').at(-1)!)?.textContent ?? '';
    expect(description).toContain("The plan's week: 57% used");
    expect(description).toContain('12 points ahead of pace. The line for 80% by Fri 18:00 is at 45% now.');
    expect(description).toContain('At this rate, 100% from');
    expect(description).toContain('The five hours: 30% used');
  });

  it('says a reading’s age once it’s over 10 minutes old, and shows none of a week that has reset', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { rerender } = header(rate(week(45), { readAt: new Date(NOW - 9 * 60_000).toISOString() }));
    expect(usageButton().querySelector('.usage-meter-age')).toBeNull();
    rerender(<Header state="live" onUsage={() => {}} runRate={rate(week(45), { readAt: new Date(NOW - 14 * 60_000).toISOString() })} />);
    expect(usageButton().querySelector('.usage-meter-age')?.textContent).toBe('14m ago');
    rerender(<Header state="live" onUsage={() => {}} runRate={rate(week(45), { fallback: { reason: 'timeout' } })} />);
    expect(usageButton().querySelector('.usage-meter-age')?.textContent).toBe('1m ago');
    rerender(<Header state="live" onUsage={() => {}} runRate={rate(week(45, { resetsAt: new Date(NOW - 1000).toISOString() }))} />);
    expect(screen.getByRole('button', { name: 'Usage' }).textContent).toBe('');
  });
});

describe('in the app', () => {
  function app(planUsage: boolean, answer: RunRate = rate(week(57))) {
    const fetch = vi.fn<FetchLike>(async (url) => (url === RUN_RATE_PATH ? new Response(JSON.stringify(answer), { status: 200 }) : new Response('{}', { status: 404 })));
    const api = createApiClient({ apiKey: 'k'.repeat(43), fetch });
    const snap = { ...snapshot([group({ sessions: [session()] })]), ...(planUsage ? { planUsage: 'on' as const } : {}) };
    render(
      <ApiContext.Provider value={api}>
        <Dashboard view={{ state: 'live', snapshot: snap }} navigation={fakeHistory('?view=all').navigation} />
      </ApiContext.Provider>,
    );
    return fetch;
  }

  it('asks for the run rate only when the snapshot says it’s on, and shows it on the button', async () => {
    const off = app(false);
    await act(async () => {});
    expect(off.mock.calls.filter(([url]) => url === RUN_RATE_PATH)).toHaveLength(0);
    document.body.innerHTML = '';
    const on = app(true);
    expect(await screen.findByRole('button', { name: /^Usage: Week 57%/ })).toBeTruthy();
    expect(on.mock.calls.filter(([url]) => url === RUN_RATE_PATH)).toHaveLength(1);
    expect(on.mock.calls.filter(([url]) => url.startsWith(USAGE_PATH))).toHaveLength(0);
  });
});

describe('the Usage view’s pace', () => {
  const VIEW = {
    window: { key: 'week', since: '2026-11-08T12:00:00.000Z', until: '2026-11-11T12:00:00.000Z', from: 'reset', bucket: 'day' },
    plan: { status: 'available', readAt: '2026-11-11T11:59:00.000Z', sevenDay: { usedPercentage: 57, resetsAt: RESETS }, fiveHour: null },
    costLabel: 'API list price, a stand-in',
    totals: { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 },
    buckets: [],
    byRepo: { rows: [] },
    bySession: { rows: [] },
    byModel: [],
    split: { main: { sessions: 0, calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 }, subagent: { runs: 0, calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 } },
    scan: { at: '2026-11-11T11:59:58.000Z', files: 0, unreadable: 0, malformed: 0 },
  } as unknown as UsageView;

  function dialog(view: UsageView) {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(view), { status: 200 }));
    render(
      <ApiContext.Provider value={createApiClient({ apiKey: 'k'.repeat(43), fetch })}>
        <UsageDialog onClose={() => {}} sessions={[]} />
      </ApiContext.Provider>,
    );
  }

  it('sits beside the plan’s week: how far from the line, the line, and the projection', async () => {
    dialog({ ...VIEW, runRate: rate(week(57)) });
    expect(await screen.findByText('Pace for 80% by Fri 18:00')).toBeTruthy();
    expect(screen.getByText('12 points ahead of pace')).toBeTruthy();
    expect(screen.getByText('The line for 80% by Fri 18:00 is at 45% now.')).toBeTruthy();
    expect(screen.getByText(/^At this rate, 100% from/)).toBeTruthy();
  });

  it('says how old its reading is when it stands in for a failed read', async () => {
    dialog({ ...VIEW, runRate: rate(week(57), { readAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), fallback: { reason: 'timeout' } }) });
    expect(await screen.findByText("From a reading 2h ago: pitwall's latest read of the plan's week failed.")).toBeTruthy();
  });

  it('is left out when the run rate is off or unavailable', async () => {
    dialog({ ...VIEW, runRate: { status: 'off' } });
    expect(await screen.findByText('57% used')).toBeTruthy();
    expect(screen.queryByText(/^Pace for/)).toBeNull();
  });
});
