// One clock for every relative time on the page (docs/design-system.md, 4: Timestamps): a single
// one-second interval, running only while something shows a time. Each Timestamp subscribes and
// re-renders itself on the tick, so the rest of the page doesn't re-render every second.

import { useEffect, useState } from 'react';

type Listener = (now: number) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
  const now = Date.now();
  for (const listener of listeners) listener(now);
}

/** Calls `listener` with the time every second, on the one shared interval. Returns the unsubscribe. */
export function subscribeClock(listener: Listener): () => void {
  listeners.add(listener);
  timer ??= setInterval(tick, 1_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** How many components the clock is ticking for, and whether its interval is running. For tests. */
export function clockState(): { listeners: number; running: boolean } {
  return { listeners: listeners.size, running: timer !== undefined };
}

/** The current time, updated every second by the shared clock. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // The time may have moved on between the render and this effect.
    setNow(Date.now());
    return subscribeClock(setNow);
  }, []);
  return now;
}
