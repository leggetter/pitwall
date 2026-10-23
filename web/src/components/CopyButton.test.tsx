// Copy buttons and command chips (docs/design-system.md, 4: Copy): the write inside the click, the
// copied icon for --pw-copied-timeout and the Copied toast, and a refusal: the text selected, the
// button's tooltip saying so, and an error toast. Every copy goes through copy.ts.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipboardContext, copyText, type ClipboardLike } from '../copy.js';
import { toastMessages, toastSaying } from '../test/toasts.js';
import { cutShort, descriptionOf, tooltipText } from '../test/tooltips.js';
import { COPIED_TIMEOUT_MS } from '../timing.js';
import { CopyButton } from './CopyButton.js';
import { CopyCommand } from './CopyCommand.js';
import { ToastProvider } from './Toast.js';

function PathAndCopy() {
  const ref = useRef<HTMLElement>(null);
  return (
    <p>
      <code ref={ref}>~/code/demo-app</code> <CopyButton text="/Users/example/code/demo-app" label="Copy path" target={ref} />
    </p>
  );
}

function renderWith(clipboard: ClipboardLike, ui = <PathAndCopy />) {
  return render(
    <ClipboardContext.Provider value={clipboard}>
      <ToastProvider>{ui}</ToastProvider>
    </ClipboardContext.Provider>,
  );
}

const settle = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

describe('CopyButton', () => {
  it('is a ghost sm icon button named for what it copies, with that as its tooltip', async () => {
    renderWith({ writeText: vi.fn(async () => {}) });
    const button = screen.getByRole('button', { name: 'Copy path' });
    expect(button.className).toBe('icon-button ghost sm copy-button');
    expect(button.hasAttribute('title')).toBe(false);
    expect(await tooltipText(button)).toBe('Copy path');
  });

  it('writes inside the click, then shows the copied icon for --pw-copied-timeout and a Copied toast', async () => {
    const writeText = vi.fn(async () => {});
    renderWith({ writeText });
    const button = screen.getByRole('button', { name: 'Copy path' });
    fireEvent.click(button);
    // Before any await: in the click, as Safari requires.
    expect(writeText).toHaveBeenCalledWith('/Users/example/code/demo-app');
    await settle();
    expect(button.dataset.copy).toBe('copied');
    expect(button.className).toContain('copied');
    expect(toastMessages()).toEqual(['Copied']);
    expect(toastSaying('Copied').className).toBe('toast success');

    await act(async () => {
      vi.advanceTimersByTime(COPIED_TIMEOUT_MS - 100);
    });
    expect(button.dataset.copy).toBe('copied');
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(button.dataset.copy).toBe('idle');
  });

  it('when the clipboard refuses: selects the text on screen, says so in its tooltip, which describes it, and in an error toast', async () => {
    renderWith({ writeText: vi.fn(async () => Promise.reject(new Error('not allowed'))) });
    const button = screen.getByRole('button', { name: 'Copy path' });
    fireEvent.click(button);
    await settle();
    expect(window.getSelection()?.toString()).toBe('~/code/demo-app');
    expect(button.dataset.copy).toBe('failed');
    // Still named for what it copies, and described by why it didn't.
    expect(button.getAttribute('aria-label')).toBe('Copy path');
    expect(descriptionOf(button)).toBe("Couldn't copy; the text is selected");
    expect(toastMessages()).toEqual(["Couldn't copy; the text is selected"]);
    expect(toastSaying("Couldn't copy; the text is selected").getAttribute('role')).toBe('alert');

    // Until the next copy, which works.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(button.dataset.copy).toBe('failed');
  });

  it("falls back to the browser's clipboard, and says it couldn't when there is none", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    expect(await copyText('x')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('x');
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    expect(await copyText('x')).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('CopyCommand, the command chip', () => {
  const command = 'cd /Users/example/code/demo-app && claude';

  it('shows the whole command in code style, then its copy button, which copies it through copy.ts', async () => {
    const writeText = vi.fn(async () => {});
    renderWith({ writeText }, <CopyCommand command={command} />);
    const chip = document.querySelector('code.command-chip')!;
    // Both parts of the middle ellipsis are in the DOM.
    expect(chip.textContent).toBe(command);
    expect(chip.querySelector('.middle-ellipsis-end')?.textContent).toBe('/demo-app && claude');
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(writeText).toHaveBeenCalledWith(command);
    await settle();
    expect(toastMessages()).toEqual(['Copied']);
  });

  it('has the whole command in a tooltip when the chip cuts it, and selects the chip when the clipboard refuses', async () => {
    renderWith({ writeText: vi.fn(async () => Promise.reject(new Error('not allowed'))) }, <CopyCommand command={command} />);
    const chip = document.querySelector<HTMLElement>('code.command-chip')!;
    expect(await tooltipText(chip)).toBeUndefined();
    cutShort(chip);
    expect(await tooltipText(chip)).toBe(command);

    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    await settle();
    expect(window.getSelection()?.toString()).toBe(command);
  });
});
