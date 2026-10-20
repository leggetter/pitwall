// The keyboard shortcuts dialog (W26, docs/design-system.md, 4: Keyboard shortcuts dialog): every
// row of 6.2's keyboard map and no other, with key caps and the platform's modifier, on a small
// Dialog with no footer, and its off switch.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import designSystem from '../../../docs/design-system.md?raw';
import type { StorageSource } from '../groupState.js';
import { createShortcutsStore, SHORTCUTS_KEY, ShortcutsStoreContext } from '../shortcuts.js';
import { keyboardMap, SHORTCUTS_HINT, ShortcutsDialog } from './ShortcutsDialog.js';

/** 6.2's table: each row's Key and Where cells, as written. */
function docRows(): { key: string; where: string }[] {
  const section = designSystem.split('### 6.2 Keyboard map')[1]?.split('\n## ')[0] ?? '';
  const table = section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2);
  return table.map((line) => {
    const [key = '', where = ''] = line.split('|').slice(1, -1).map((cell) => cell.trim());
    return { key, where };
  });
}

function memory(entries: Record<string, string> = {}): StorageSource & { values: Map<string, string> } {
  const values = new Map(Object.entries(entries));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return Object.assign(() => storage, { values });
}

function renderDialog({ command = true, stored = memory() }: { command?: boolean; stored?: ReturnType<typeof memory> } = {}) {
  const store = createShortcutsStore({ storage: stored, events: { addEventListener: () => {} } });
  let closed = 0;
  const result = render(
    <ShortcutsStoreContext.Provider value={store}>
      <ShortcutsDialog command={command} onClose={() => (closed += 1)} />
    </ShortcutsStoreContext.Provider>,
  );
  return { ...result, store, stored, closed: () => closed };
}

/** What a screen reader hears for `element`: its text, leaving out what's aria-hidden. */
function heard(element: Element | null): string {
  if (!element) return '';
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent ?? '';
}

/** Each row of the dialog: what it says, then the key caps it shows, and what a screen reader hears for them. */
function dialogRows() {
  return [...document.querySelectorAll('.shortcut')].map((row) => ({
    what: row.querySelector('dt')?.textContent,
    caps: [...row.querySelectorAll('kbd')].map((kbd) => kbd.textContent).join(' '),
    heard: heard(row.querySelector('dd')),
  }));
}

describe('the keyboard shortcuts dialog', () => {
  it("lists every row of 6.2's keyboard map, and no other", () => {
    const rows = docRows();
    expect(rows.length).toBe(16);
    const listed = keyboardMap(true).flatMap((group) => group.rows.map((row) => row.doc));
    expect(listed).toHaveLength(rows.length);
    expect(new Set(listed.map((row) => `${row.key} | ${row.where}`))).toEqual(new Set(rows.map((row) => `${row.key} | ${row.where}`)));
  });

  it('shows each row with its key caps, read out in words', () => {
    renderDialog();
    const rows = dialogRows();
    expect(rows).toHaveLength(16);
    const byWhat = new Map(rows.map((row) => [row.what, row]));
    expect(byWhat.get('Focus the filter field')).toEqual({ what: 'Focus the filter field', caps: '/', heard: 'Slash' });
    expect(byWhat.get('Open the New session dialog')?.caps).toBe('n');
    expect(byWhat.get('Show keyboard shortcuts')?.caps).toBe('?');
    expect(byWhat.get('Next or previous session in the list, showing it if a session is open')).toMatchObject({ caps: 'j k', heard: 'J or K' });
    expect(byWhat.get('In the repo list: move, jump to either end, select')).toMatchObject({ caps: '↓ ↑ Home End ↵', heard: 'Down arrow or Up arrow, Home or End, Enter' });
    expect(byWhat.get('In an open menu: move, jump to either end, choose, close')?.caps).toBe('↑ ↓ Home End ↵ Esc');
    expect(byWhat.get('In the terminal: leave it, for the Terminal tab')?.caps).toBe('F6');
    expect(byWhat.get('Move between the header, the repo list, the session list and the session view')).toMatchObject({ caps: 'Tab Shift Tab', heard: 'Tab or Shift Tab' });
    for (const row of rows) expect(row.caps, row.what ?? '').not.toBe('');
  });

  it('shows ⌘ on Apple platforms and Ctrl elsewhere', () => {
    const { unmount } = renderDialog({ command: true });
    const sends = () => dialogRows().filter((row) => row.what?.endsWith('send') || row.what?.endsWith('start the session'));
    expect(sends().map((row) => [row.caps, row.heard])).toEqual([
      ['⌘ ↵', 'Command Enter'],
      ['⌘ ↵', 'Command Enter'],
    ]);
    unmount();
    renderDialog({ command: false });
    expect(sends().map((row) => [row.caps, row.heard])).toEqual([
      ['Ctrl ↵', 'Control Enter'],
      ['Ctrl ↵', 'Control Enter'],
    ]);
    expect(document.body.textContent).not.toContain('⌘');
  });

  it('is a small dialog named Keyboard shortcuts, in groups with headings, with no footer', () => {
    renderDialog();
    const shown = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(shown.classList.contains('sm')).toBe(true);
    expect(shown.getAttribute('aria-modal')).toBe('true');
    expect(shown.querySelector('.dialog-foot')).toBeNull();
    expect(within(shown).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Anywhere', 'Lists', 'Session view', 'Menus and dialogs', 'Closing and moving']);
    for (const region of within(shown).getAllByRole('region')) expect(region.getAttribute('aria-labelledby')).toMatch(/^\S+$/);
  });

  it('has the off switch first, focused as it opens, on by default and described by its note', () => {
    renderDialog();
    const box = screen.getByRole('checkbox', { name: 'Single-key shortcuts' }) as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    expect(box.checked).toBe(true);
    expect(document.getElementById(box.getAttribute('aria-describedby')!)?.textContent).toBe(SHORTCUTS_HINT);
  });

  it('stores the switch as pitwall.shortcuts.v1, and says Anywhere is off while it is', () => {
    const { stored } = renderDialog();
    const box = screen.getByRole('checkbox', { name: 'Single-key shortcuts' }) as HTMLInputElement;
    const anywhere = () => screen.getAllByRole('heading', { level: 3 })[0]?.textContent;
    expect(anywhere()).toBe('Anywhere');
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    expect(stored.values.get(SHORTCUTS_KEY)).toBe('off');
    expect(anywhere()).toBe('Anywhere, Off');
    // A click on the label toggles it too.
    fireEvent.click(screen.getByText('Single-key shortcuts'));
    expect(box.checked).toBe(true);
    expect(stored.values.get(SHORTCUTS_KEY)).toBe('on');
  });

  it('starts from a stored off', () => {
    renderDialog({ stored: memory({ [SHORTCUTS_KEY]: 'off' }) });
    expect((screen.getByRole('checkbox', { name: 'Single-key shortcuts' }) as HTMLInputElement).checked).toBe(false);
  });

  it('closes on Escape and with Close', () => {
    const { closed } = renderDialog();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(closed()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(closed()).toBe(2);
  });
});
