// The dialog itself (W31, docs/design-system.md, 4: Dialogs): where focus goes when it closes, also
// when it closes on an answer rather than a click or a key (W83), and that nothing inside it is a page
// landmark. The New session and keyboard shortcuts dialogs, which are built on it, have their own tests.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Dialog } from './Dialog.js';
import { Icon } from './Icon.js';
import { shownTooltip } from '../test/tooltips.js';
import { Tooltip } from './Tooltip.js';

/** An icon button with a tooltip, as the header's are, that opens a made-up dialog with a footer. */
function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content="Open the made-up dialog" relation="label">
        <button type="button" className="icon-button ghost md" onClick={() => setOpen(true)}>
          <Icon name="keyboard" />
        </button>
      </Tooltip>
      {open && (
        <Dialog title="A made-up dialog" onClose={() => setOpen(false)} footerMeta="Made-up meta" actions={<button type="button">Done</button>}>
          <input aria-label="A made-up field" />
        </Dialog>
      )}
    </>
  );
}

const opener = () => screen.getByRole('button', { name: 'Open the made-up dialog' });

/** A made-up dialog whose Done closes it once `answered` resolves, as New session closes once its request answers. */
function ClosesOnAnswer({ answered }: { answered: Promise<void> }) {
  const [open, setOpen] = useState(false);
  const done = () => void answered.then(() => setOpen(false));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open the made-up dialog
      </button>
      {open && (
        <Dialog title="A made-up dialog" onClose={() => setOpen(false)} actions={<button type="button" onClick={done}>Done</button>}>
          <input aria-label="A made-up field" />
        </Dialog>
      )}
    </>
  );
}

describe('Dialog', () => {
  it("gives focus back to its opener on Escape without opening the opener's tooltip, so the next Escape goes on", () => {
    render(<Opener />);
    // Focused from the keyboard, the opener shows its tooltip, as in the app.
    act(() => opener().focus());
    expect(shownTooltip()).not.toBeNull();
    fireEvent.click(opener());
    const field = screen.getByRole('textbox', { name: 'A made-up field' });
    expect(document.activeElement).toBe(field);
    expect(shownTooltip()).toBeNull();

    // Escape inside the dialog closes it, and only it.
    expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener());
    expect(shownTooltip()).toBeNull();
  });

  it('gives focus back the same way after Close', () => {
    render(<Opener />);
    act(() => opener().focus());
    fireEvent.click(opener());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener());
    expect(shownTooltip()).toBeNull();
  });

  it('gives focus back as it leaves the page when it closes on an answer, not a click or a key (W83)', async () => {
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    render(<ClosesOnAnswer answered={answered} />);
    opener().focus();
    fireEvent.click(opener());
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Where focus is as the dialog goes, before React's next task: a close that isn't a click or a key
    // runs the effects it leaves in that later task, and anything that looks in between sees this.
    const seen: (Element | null)[] = [];
    const observer = new MutationObserver(() => {
      if (seen.length === 0 && document.querySelector('[role="dialog"]') === null) seen.push(document.activeElement);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    answer();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    observer.disconnect();
    expect(seen).toEqual([opener()]);
    expect(document.activeElement).toBe(opener());
  });

  it('has no landmarks inside: its header and footer are plain elements', () => {
    render(<Opener />);
    fireEvent.click(opener());
    const dialog = screen.getByRole('dialog', { name: 'A made-up dialog' });
    expect(dialog.querySelector('header, footer')).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(dialog.querySelector('.dialog-head')).not.toBeNull();
    expect(dialog.querySelector('.dialog-foot')?.textContent).toContain('Made-up meta');
  });
});
