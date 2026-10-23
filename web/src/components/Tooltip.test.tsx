// The tooltip (docs/design-system.md, 4: Tooltips, 2.13 and 6.1 items 5 and 13): when it opens and
// closes, Escape, staying while hovered, how it names or describes its trigger, and where it sits.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { block, declarations, withoutComments } from '../test/css.js';
import { cutShort, descriptionOf, pass, shownTooltip, shownTooltips } from '../test/tooltips.js';
import { TOOLTIP_DELAY_MS } from '../timing.js';
import { focusQuietly, Tooltip } from './Tooltip.js';
import tooltipCss from './Tooltip.css?raw';

const mouse = { pointerType: 'mouse' } as const;

function Close({ onClick }: { onClick?: () => void }) {
  return (
    <Tooltip content="Close" keys={{ keys: ['Esc'], label: 'Escape' }} relation="label">
      <button type="button" className="icon-button ghost md" onClick={onClick}>
        x
      </button>
    </Tooltip>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});

afterEach(async () => {
  // Past the window in which the next tooltip opens at once, so each test starts cold.
  await pass(TOOLTIP_DELAY_MS * 2);
});

describe('Tooltip: opening and closing', () => {
  it('opens on hover after --pw-delay-tooltip, not before, and closes at once when the pointer leaves', async () => {
    render(<Close />);
    const button = screen.getByRole('button', { name: 'Close' });

    fireEvent.pointerEnter(button, mouse);
    await pass(TOOLTIP_DELAY_MS - 50);
    expect(shownTooltip()).toBeNull();
    await pass(60);
    const tip = shownTooltip();
    expect(tip?.textContent).toBe('CloseEscEscape');

    fireEvent.pointerLeave(button, { ...mouse, relatedTarget: document.body });
    await pass(0);
    expect(shownTooltip()).toBeNull();
  });

  it("doesn't open for a pointer that leaves before the delay, or for a touch", async () => {
    render(<Close />);
    const button = screen.getByRole('button', { name: 'Close' });
    fireEvent.pointerEnter(button, mouse);
    await pass(100);
    fireEvent.pointerLeave(button, { ...mouse, relatedTarget: document.body });
    await pass(TOOLTIP_DELAY_MS);
    expect(shownTooltip()).toBeNull();

    fireEvent.pointerEnter(button, { pointerType: 'touch' });
    await pass(TOOLTIP_DELAY_MS + 50);
    expect(shownTooltip()).toBeNull();
  });

  it('opens at once on keyboard focus, and closes on blur', async () => {
    render(
      <>
        <button type="button">Before</button>
        <Close />
      </>,
    );
    act(() => screen.getByRole('button', { name: 'Close' }).focus());
    expect(shownTooltip()?.querySelector('.tooltip-text')?.textContent).toBe('Close');
    act(() => screen.getByRole('button', { name: 'Before' }).focus());
    expect(shownTooltip()).toBeNull();
  });

  it("doesn't open when focus is put back on its trigger as something closes", () => {
    render(<Close />);
    act(() => focusQuietly(screen.getByRole('button', { name: 'Close' })));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    expect(shownTooltip()).toBeNull();
  });

  it('closes on a press of its trigger, which is for the control, and stays shut until the pointer leaves', async () => {
    const onClick = vi.fn();
    render(<Close onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Close' });
    fireEvent.pointerEnter(button, mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    expect(shownTooltip()).not.toBeNull();

    fireEvent.pointerDown(button, mouse);
    fireEvent.click(button);
    await pass(0);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(shownTooltip()).toBeNull();

    fireEvent.pointerLeave(button, { ...mouse, relatedTarget: document.body });
    fireEvent.pointerEnter(button, mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    expect(shownTooltip()).not.toBeNull();
  });

  it('opens the next tooltip at once when one has just closed, as along a row of icon buttons', async () => {
    render(
      <>
        <Close />
        <Tooltip content="Session actions" relation="label">
          <button type="button">…</button>
        </Tooltip>
      </>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    const actions = screen.getByRole('button', { name: 'Session actions' });
    fireEvent.pointerEnter(close, mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    fireEvent.pointerLeave(close, { ...mouse, relatedTarget: actions });
    fireEvent.pointerEnter(actions, mouse);
    await pass(0);
    expect(shownTooltip()?.querySelector('.tooltip-text')?.textContent).toBe('Session actions');
  });
});

describe('Tooltip: Escape and hovering it (WCAG 1.4.13)', () => {
  it('closes on Escape, which goes no further, so nothing behind it closes too', async () => {
    const behind = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    document.addEventListener('keydown', behind);
    render(<Close />);
    const button = screen.getByRole('button', { name: 'Close' });
    act(() => button.focus());
    expect(shownTooltip()).not.toBeNull();

    fireEvent.keyDown(button, { key: 'Escape' });
    expect(shownTooltip()).toBeNull();
    expect(behind).not.toHaveBeenCalled();
    // Dismissed without moving focus, and the next Escape goes on as usual.
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(behind).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', behind);
  });

  it('closes a hovered tooltip on Escape wherever focus is, except in the terminal, which gets every key', async () => {
    render(
      <>
        <Close />
        <div className="xterm">
          <textarea aria-label="Terminal input" />
        </div>
        <input aria-label="Elsewhere" />
      </>,
    );
    const button = screen.getByRole('button', { name: 'Close' });
    fireEvent.pointerEnter(button, mouse);
    await pass(TOOLTIP_DELAY_MS + 10);

    const terminal = screen.getByLabelText('Terminal input');
    const toTerminal = fireEvent.keyDown(terminal, { key: 'Escape' });
    expect(toTerminal).toBe(true);
    expect(shownTooltip()).not.toBeNull();

    const elsewhere = fireEvent.keyDown(screen.getByLabelText('Elsewhere'), { key: 'Escape' });
    expect(elsewhere).toBe(false);
    expect(shownTooltip()).toBeNull();
  });

  it('stays while the pointer moves from its trigger onto it, and closes once the pointer leaves both', async () => {
    render(<Close />);
    const button = screen.getByRole('button', { name: 'Close' });
    fireEvent.pointerEnter(button, mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    const tip = shownTooltip()!;

    fireEvent.pointerLeave(button, { ...mouse, relatedTarget: tip });
    fireEvent.pointerEnter(tip, mouse);
    await pass(1_000);
    expect(shownTooltip()).toBe(tip);

    // Back to the trigger and onto the tooltip again: still open.
    fireEvent.pointerLeave(tip, { ...mouse, relatedTarget: button });
    fireEvent.pointerEnter(button, mouse);
    await pass(0);
    expect(shownTooltip()).toBe(tip);

    fireEvent.pointerLeave(button, { ...mouse, relatedTarget: tip });
    fireEvent.pointerLeave(tip, { ...mouse, relatedTarget: document.body });
    await pass(0);
    expect(shownTooltip()).toBeNull();
  });

  it("isn't a click on what its trigger sits in: React passes a portal's events up its tree", async () => {
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <Close />
      </div>,
    );
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Close' }), mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    fireEvent.click(shownTooltip()!);
    expect(onRow).not.toHaveBeenCalled();
  });
});

describe('Tooltip: naming and describing its trigger (6.1, item 5)', () => {
  it("names an icon button: its aria-label is the tooltip's text, and the tooltip is hidden from assistive technology", async () => {
    render(<Close />);
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button.getAttribute('aria-label')).toBe('Close');
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(button.hasAttribute('title')).toBe(false);
    // Not in the DOM until it shows.
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    fireEvent.pointerEnter(button, mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    expect(shownTooltip()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('describes a control, with the tooltip in the DOM from the start, after any description it had', async () => {
    render(
      <>
        <p id="own">Its own help.</p>
        <Tooltip content="Type a message to send it.">
          <button type="button" aria-describedby="own">
            Send
          </button>
        </Tooltip>
      </>,
    );
    const send = screen.getByRole('button', { name: 'Send' });
    const ids = send.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(ids[0]).toBe('own');
    const tip = document.getElementById(ids[1] ?? '')!;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.hidden).toBe(true);
    expect(descriptionOf(send)).toBe('Type a message to send it.');
    expect(screen.getByRole('button', { name: 'Send', description: 'Its own help. Type a message to send it.' })).toBe(send);

    act(() => send.focus());
    expect(tip.hidden).toBe(false);
    expect(tip.hasAttribute('aria-hidden')).toBe(false);
  });

  it('leaves its trigger alone when there is no content', () => {
    render(
      <Tooltip content={undefined}>
        <button type="button">Send</button>
      </Tooltip>,
    );
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.hasAttribute('aria-describedby')).toBe(false);
    act(() => send.focus());
    expect(shownTooltips()).toEqual([]);
  });

  it('renders its text as text, never markup', async () => {
    render(
      <Tooltip content={'<b>bold</b>\nsecond line'} relation="none">
        <span>title</span>
      </Tooltip>,
    );
    fireEvent.pointerEnter(screen.getByText('title'), mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    const tip = shownTooltip()!;
    expect(tip.querySelector('b')).toBeNull();
    expect(tip.textContent).toBe('<b>bold</b>\nsecond line');
  });

  it("opens on hover only for an element that's never focusable, and not for focus inside it", async () => {
    render(
      <Tooltip content="Session 1, started yesterday" relation="none">
        <h3>
          <button type="button">demo</button>
        </h3>
      </Tooltip>,
    );
    act(() => screen.getByRole('button', { name: 'demo' }).focus());
    expect(shownTooltip()).toBeNull();
    fireEvent.pointerEnter(screen.getByRole('heading'), mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    expect(shownTooltip()?.textContent).toBe('Session 1, started yesterday');
  });

  it('with onlyIfCut, opens only when text in its trigger is cut short on screen', async () => {
    render(
      <Tooltip content="~/code/a-long-repo-name" relation="none" onlyIfCut>
        <span className="label">~/code/a-long-repo-name</span>
      </Tooltip>,
    );
    const label = screen.getByText('~/code/a-long-repo-name');
    fireEvent.pointerEnter(label, mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    expect(shownTooltip()).toBeNull();
    fireEvent.pointerLeave(label, { ...mouse, relatedTarget: document.body });

    cutShort(label);
    fireEvent.pointerEnter(label, mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    expect(shownTooltip()?.textContent).toBe('~/code/a-long-repo-name');
  });
});

describe('Tooltip: an info button (toggle)', () => {
  it('shows on a click or a tap, and hides on a second, on Escape, or on a press elsewhere', async () => {
    render(
      <>
        <Tooltip content="What /bg does." relation="label" toggle>
          <button type="button">i</button>
        </Tooltip>
        <button type="button">Elsewhere</button>
      </>,
    );
    const info = screen.getByRole('button', { name: 'What /bg does.' });
    fireEvent.pointerDown(info, { pointerType: 'touch' });
    fireEvent.click(info);
    expect(shownTooltip()?.textContent).toBe('What /bg does.');
    fireEvent.click(info);
    expect(shownTooltip()).toBeNull();

    fireEvent.click(info);
    fireEvent.keyDown(info, { key: 'Escape' });
    expect(shownTooltip()).toBeNull();

    fireEvent.click(info);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(shownTooltip()).toBeNull();
  });
});

describe('Tooltip: where it sits', () => {
  const rect = (top: number, left: number, width: number, height: number) => new DOMRect(left, top, width, height);

  it('sits 6 px above its trigger, centred on it, and below when there is no room above', async () => {
    render(<Close />);
    const button = screen.getByRole('button', { name: 'Close' });
    vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(200, 100, 28, 28));
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 60, 32));
    fireEvent.pointerEnter(button, mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    let tip = shownTooltip()!;
    expect([tip.style.top, tip.style.left, tip.dataset.side]).toEqual(['162px', '84px', 'top']);
    fireEvent.pointerLeave(button, { ...mouse, relatedTarget: document.body });
    await pass(TOOLTIP_DELAY_MS * 2);

    vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(10, 2, 28, 28));
    fireEvent.pointerEnter(button, mouse);
    await pass(TOOLTIP_DELAY_MS + 10);
    tip = shownTooltip()!;
    // Below, and kept 8 px from the window's left edge.
    expect([tip.style.top, tip.style.left, tip.dataset.side]).toEqual(['44px', '8px', 'bottom']);
  });

  it('is the card the doc describes: at most 344 px wide, at --pw-z-tooltip, fixed to the window, text in meta size', () => {
    const css = withoutComments(tooltipCss);
    const card = new Map(declarations(block(css, /\n?\.tooltip\s*\{/)));
    expect(card.get('position')).toBe('fixed');
    expect(card.get('z-index')).toBe('var(--pw-z-tooltip)');
    expect(card.get('max-width')).toBe('min(var(--pw-tooltip-max-w), calc(100vw - 2 * var(--pw-space-2)))');
    expect(card.get('background')).toBe('var(--pw-surface-overlay)');
    expect(card.get('box-shadow')).toBe('var(--pw-shadow-1)');
    expect(card.get('border-radius')).toBe('var(--pw-radius-md)');
    expect(card.get('padding')).toBe('var(--pw-space-1-5) var(--pw-space-2)');
    expect(card.get('font-size')).toBe('var(--pw-text-s)');
    expect(card.get('gap')).toBe('var(--pw-space-2)');
  });
});
