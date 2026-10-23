// Timestamps (docs/design-system.md, 4: Timestamps): relative times on one shared clock, a single
// interval however many there are, the time of day for speaker lines, which doesn't tick, the
// absolute time in a tooltip, and never in a live region.

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clockState } from '../clock.js';
import { absoluteTime, clockTime } from '../format.js';
import { group, NOW, session, snapshot } from '../test/fixtures.js';
import { tooltipText } from '../test/tooltips.js';
import { Dashboard } from './Dashboard.js';
import { Timestamp } from './Timestamp.js';

const secondsAgo = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
});

describe('Timestamp', () => {
  it('says how long ago, in a <time> with the instant in datetime', () => {
    render(
      <>
        {[2, 42, 5 * 60, 3 * 3600, 2 * 86400].map((seconds) => (
          <Timestamp key={seconds} at={secondsAgo(seconds)} />
        ))}
        <Timestamp at={secondsAgo(7)} format="updated" />
        <Timestamp at={secondsAgo(300)} prefix="Active " />
      </>,
    );
    const times = [...document.querySelectorAll('time')];
    expect(times.map((time) => time.textContent)).toEqual(['just now', '42s ago', '5m ago', '3h ago', '2d ago', 'updated 7s ago', 'Active 5m ago']);
    expect(times[2]?.getAttribute('datetime')).toBe(secondsAgo(300));
    expect(times.every((time) => !time.hasAttribute('title'))).toBe(true);
  });

  it('has the absolute time, with seconds, in a tooltip', async () => {
    render(<Timestamp at="2026-03-02T11:55:07.000Z" />);
    const text = await tooltipText(screen.getByText(/ago$/));
    expect(text).toMatch(/2026/);
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}|\d{1,2}:\d{2}:\d{2}/);
  });

  it('ticks every second, every one of them on one shared interval, which stops when none is left', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { unmount } = render(
      <>
        {Array.from({ length: 50 }, (_, index) => (
          <Timestamp key={index} at={secondsAgo(10)} format="updated" />
        ))}
      </>,
    );
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clockState()).toEqual({ listeners: 50, running: true });
    expect(screen.getAllByText('updated 10s ago')).toHaveLength(50);

    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getAllByText('updated 11s ago')).toHaveLength(50);
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getAllByText('updated 13s ago')).toHaveLength(50);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    unmount();
    expect(clockState()).toEqual({ listeners: 0, running: false });
  });

  it("shows the time of day alone, for the conversation's speaker lines, with the whole date and time in its tooltip, and never ticks", async () => {
    const at = '2026-03-02T11:06:14.000Z';
    render(
      <>
        {Array.from({ length: 30 }, (_, index) => (
          <Timestamp key={index} at={at} format="time" />
        ))}
        <Timestamp at="not a time" format="time" />
      </>,
    );
    const times = [...document.querySelectorAll('time')];
    // The bad one shows nothing.
    expect(times).toHaveLength(30);
    expect(times[0]?.textContent).toBe(clockTime(at));
    expect(times[0]?.textContent).toMatch(/^\d{1,2}[:.]\d{2}/);
    expect(times[0]?.getAttribute('datetime')).toBe(at);
    expect(clockState()).toEqual({ listeners: 0, running: false });
    expect(await tooltipText(times[0]!)).toBe(absoluteTime(at));
    act(() => vi.advanceTimersByTime(60_000));
    expect(times[0]?.textContent).toBe(clockTime(at));
  });

  it("drives every time in the dashboard from that one interval, none of them in a live region", () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const sessions = Array.from({ length: 20 }, (_, index) => session({ name: `demo-${index}`, lastActivityAt: secondsAgo(60 * (index + 1)) }));
    render(<Dashboard view={{ state: 'live', snapshot: snapshot([group({ sessions })]) }} />);
    const times = [...document.querySelectorAll('time')];
    // The header's, and each row's.
    expect(times).toHaveLength(21);
    expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 1_000)).toHaveLength(1);
    expect(clockState().listeners).toBe(21);
    for (const time of times) expect(time.closest('[aria-live], [role="status"], [role="alert"], [role="log"]')).toBeNull();
  });
});
