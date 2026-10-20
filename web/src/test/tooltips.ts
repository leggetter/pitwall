// Tooltips in tests (Tooltip.tsx): hovering as a mouse does, waiting out --pw-delay-tooltip on real
// or fake timers, and reading what a trigger's tooltip says.

import { act, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { TOOLTIP_DELAY_MS } from '../timing.js';

/** The real setTimeout, from before any test fakes it. */
const realSetTimeout = globalThis.setTimeout;

/** Lets `ms` pass: on fake timers if the test fakes setTimeout, and really if it doesn't, as when it fakes Date alone. */
export async function pass(ms: number): Promise<void> {
  if (vi.isFakeTimers()) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }
  if (globalThis.setTimeout === realSetTimeout) await act(() => new Promise<void>((resolve) => realSetTimeout(resolve, ms)));
}

/** The tooltips on screen now: open, not hidden. */
export function shownTooltips(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="tooltip"]:not([hidden])')];
}

/** The one tooltip on screen, or null. */
export function shownTooltip(): HTMLElement | null {
  const shown = shownTooltips();
  if (shown.length > 1) throw new Error(`${shown.length} tooltips are showing`);
  return shown[0] ?? null;
}

/** Moves a mouse onto `element` and waits out the delay. Returns the tooltip that shows, if any. */
export async function hover(element: Element): Promise<HTMLElement | null> {
  fireEvent.pointerEnter(element, { pointerType: 'mouse' });
  await pass(TOOLTIP_DELAY_MS + 20);
  return shownTooltip();
}

/** Moves the mouse off `element`, onto `to` (the page by default). */
export function unhover(element: Element, to: Element = document.body): void {
  fireEvent.pointerLeave(element, { pointerType: 'mouse', relatedTarget: to });
}

/** The text of the tooltip `element` is described by, which is in the DOM before it shows. */
export function descriptionOf(element: Element): string | undefined {
  const ids = element.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
  const tip = ids.map((id) => document.getElementById(id)).find((found) => found?.getAttribute('role') === 'tooltip');
  return tip?.querySelector('.tooltip-text')?.textContent ?? undefined;
}

/** What `element`'s tooltip says, shown by hovering it, and the mouse moved off again. */
export async function tooltipText(element: Element): Promise<string | undefined> {
  const tip = await hover(element);
  const text = tip?.querySelector('.tooltip-text')?.textContent ?? undefined;
  unhover(element);
  await pass(0);
  return text;
}

/**
 * Makes `element` look cut short to the tooltip, for an `onlyIfCut` tooltip: happy-dom has no layout,
 * so its text never overflows. It clips its overflow, and has more content than room.
 */
export function cutShort(element: Element): void {
  if (!(element instanceof HTMLElement)) throw new Error('not an HTMLElement');
  element.style.overflow = 'hidden';
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: 200 });
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: 100 });
}
