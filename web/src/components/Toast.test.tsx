// Toasts (docs/design-system.md, 4: Toasts, 2.13, 6.1 item 9): the live region that's there before
// any toast, the timeout and its pause, error toasts, the stack's limit, Dismiss and its focus.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { block, blocks, declarations, withoutComments } from '../test/css.js';
import { toastMessages, toastRegion, toastSaying } from '../test/toasts.js';
import { TOAST_TIMEOUT_MS } from '../timing.js';
import { MAX_TOASTS, ToastProvider, useToast, type ShowToast } from './Toast.js';
import toastCss from './Toast.css?raw';

/** Renders a provider, and returns its show function and a button inside it, for focus to come from. */
function setup(onFocusLost?: () => void) {
  let show: ShowToast = () => {};
  function Grab() {
    show = useToast();
    return (
      <button type="button" className="before">
        Before
      </button>
    );
  }
  render(
    <ToastProvider onFocusLost={onFocusLost}>
      <Grab />
    </ToastProvider>,
  );
  return { show: (...args: Parameters<ShowToast>) => act(() => show(...args)) };
}

/** Lets `ms` pass on the fake timers. */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/** Lets `ms` pass, then the fade-out of anything that went. */
async function pass(ms: number) {
  await advance(ms);
  await advance(100);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

describe('Toasts: the live region', () => {
  it('is a polite live region that is in the DOM, empty, before the first toast, and the same element after it', () => {
    const { show } = setup();
    const region = toastRegion();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.hasAttribute('role')).toBe(false);
    expect(region.textContent).toBe('');

    show({ message: 'Copied' });
    // The text arrives inside the region that was already there, so it's announced (W24's finding).
    expect(toastRegion()).toBe(region);
    expect(region.textContent).toBe('Copied');
  });

  it('gives an error toast role="alert" too, and the others no role', () => {
    const { show } = setup();
    show({ message: 'Copied' });
    show({ tone: 'error', message: "Couldn't copy; the text is selected" });
    expect(toastSaying('Copied').hasAttribute('role')).toBe(false);
    expect(toastSaying("Couldn't copy; the text is selected").getAttribute('role')).toBe('alert');
    expect(toastSaying("Couldn't copy; the text is selected").className).toBe('toast error');
  });

  it('renders its message as text, never markup', () => {
    const { show } = setup();
    show({ message: 'Removed <b>pitwall-test</b>' });
    expect(toastRegion().querySelector('b')).toBeNull();
    expect(toastMessages()).toEqual(['Removed <b>pitwall-test</b>']);
  });
});

describe('Toasts: timing', () => {
  it('takes a success toast away after --pw-toast-timeout, and keeps an error toast until it is dismissed', async () => {
    const { show } = setup();
    show({ message: 'Stopped. Its conversation is kept.' });
    show({ tone: 'error', message: 'A made-up failure.' });
    await pass(TOAST_TIMEOUT_MS - 200);
    expect(toastMessages()).toEqual(['Stopped. Its conversation is kept.', 'A made-up failure.']);
    await pass(200);
    expect(toastMessages()).toEqual(['A made-up failure.']);
    await pass(60_000);
    expect(toastMessages()).toEqual(['A made-up failure.']);
  });

  it('stops the time while the pointer is over the stack, and goes on from where it was', async () => {
    const { show } = setup();
    show({ message: 'Copied' });
    await advance(TOAST_TIMEOUT_MS - 1_000);
    fireEvent.pointerEnter(toastRegion());
    await advance(10_000);
    expect(toastMessages()).toEqual(['Copied']);

    // 1 s was left: not gone after 0.8 s, gone after 1.1 s.
    fireEvent.pointerLeave(toastRegion());
    await advance(800);
    expect(toastMessages()).toEqual(['Copied']);
    await pass(300);
    expect(toastMessages()).toEqual([]);
  });

  it('stops the time while focus is inside the stack', async () => {
    const { show } = setup();
    show({ message: 'Copied' });
    act(() => screen.getByRole('button', { name: 'Dismiss' }).focus());
    await pass(10_000);
    expect(toastMessages()).toEqual(['Copied']);

    act(() => screen.getByRole('button', { name: 'Before' }).focus());
    await pass(TOAST_TIMEOUT_MS);
    expect(toastMessages()).toEqual([]);
  });
});

describe('Toasts: the stack', () => {
  it(`shows ${MAX_TOASTS} at most, newest at the bottom, and the oldest goes first`, () => {
    const { show } = setup();
    for (const message of ['one', 'two', 'three', 'four']) show({ message });
    expect(toastMessages()).toEqual(['two', 'three', 'four']);
  });

  it('replaces a toast that says the same, so it is announced again without stacking', () => {
    const { show } = setup();
    show({ message: 'Copied' });
    const first = toastSaying('Copied');
    show({ message: 'Stopped. Its conversation is kept.' });
    show({ message: 'Copied' });
    expect(toastMessages()).toEqual(['Stopped. Its conversation is kept.', 'Copied']);
    expect(toastSaying('Copied')).not.toBe(first);
  });

  it('has a ghost sm Dismiss on each, named by its tooltip, which takes the toast away', async () => {
    const { show } = setup();
    show({ tone: 'error', message: 'A made-up failure.' });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss.className).toBe('icon-button ghost sm toast-dismiss');
    fireEvent.click(dismiss);
    await pass(0);
    expect(toastMessages()).toEqual([]);
  });

  it("moves focus from a dismissed toast's button to the next toast's, then out of the stack", async () => {
    const lost = vi.fn();
    const { show } = setup(lost);
    show({ tone: 'error', message: 'first' });
    show({ tone: 'error', message: 'second' });
    const [first, second] = screen.getAllByRole('button', { name: 'Dismiss' });
    act(() => first!.focus());
    fireEvent.click(first!);
    expect(document.activeElement).toBe(second);
    await pass(0);
    fireEvent.click(second!);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});

describe('Toasts: the styles', () => {
  const css = withoutComments(toastCss);

  it('sit at the bottom right, 24 px from the edges, 12 px apart, at --pw-z-toast, 360 px wide', () => {
    const stack = new Map(declarations(block(css, /\n\.toasts\s*\{/)));
    expect(stack.get('position')).toBe('fixed');
    expect([stack.get('right'), stack.get('bottom')]).toEqual(['var(--pw-space-6)', 'var(--pw-space-6)']);
    expect(stack.get('gap')).toBe('var(--pw-space-3)');
    expect(stack.get('z-index')).toBe('var(--pw-z-toast)');
    expect(stack.get('width')).toBe('var(--pw-toast-w)');
    // Only the toasts take the pointer, not the empty stack.
    expect(stack.get('pointer-events')).toBe('none');
  });

  it('are full width, 16 px from the edges, in an app 600 px wide or narrower', () => {
    const [compact] = blocks(css, /@container pitwall \(max-width: 600px\)\s*\{/);
    const stack = new Map(declarations(block(compact ?? '', /\.toasts\s*\{/)));
    expect([stack.get('left'), stack.get('right'), stack.get('bottom'), stack.get('width')]).toEqual([
      'var(--pw-space-4)',
      'var(--pw-space-4)',
      'var(--pw-space-4)',
      'auto',
    ]);
  });

  it('fade and scale in and out over --pw-duration-base', () => {
    const toast = new Map(declarations(block(css, /\n\.toast\s*\{/)));
    expect(toast.get('animation')).toBe('toast-in var(--pw-duration-base) var(--pw-ease-out)');
    expect(toast.get('box-shadow')).toBe('var(--pw-shadow-3)');
    expect(toast.get('background')).toBe('var(--pw-surface-overlay)');
    expect(block(css, /@keyframes toast-in\s*\{/)).toMatch(/opacity: 0;\s*transform: scale\(0\.96\)/);
  });
});
