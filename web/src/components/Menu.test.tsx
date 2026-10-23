// The menu button and its menu (docs/design-system.md, 4: Menus): its semantics, keyboard and focus.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { descriptionOf, shownTooltip, tooltipText } from '../test/tooltips.js';
import { closeMenus, MenuButton, type MenuEntry } from './Menu.js';

function setup(overrides: { disabled?: boolean } = {}) {
  const calls: { label: string; focused: Element | null }[] = [];
  const select = (label: string) => () => calls.push({ label, focused: document.activeElement });
  const entries: MenuEntry[] = [
    { id: 'one', label: 'Copy session ID', icon: 'copy', onSelect: select('Copy session ID') },
    { id: 'two', label: 'Stop session', icon: 'stop', disabled: overrides.disabled ?? true, hint: "It isn't running.", onSelect: select('Stop session') },
    { kind: 'separator', id: 'separator' },
    { id: 'three', label: 'Remove session', icon: 'remove', danger: true, onSelect: select('Remove session') },
  ];
  render(
    <>
      <button type="button">Before</button>
      <MenuButton label="Session actions" icon="more" entries={entries} />
      <button type="button">After</button>
    </>,
  );
  const button = screen.getByRole('button', { name: 'Session actions' });
  const items = () => screen.getAllByRole('menuitem');
  return { button, items, calls };
}

describe('MenuButton', () => {
  it('keeps an icon’s room for an item without one, so the labels line up, and only where other items have icons (W31)', () => {
    const entries: MenuEntry[] = [
      { id: 'one', label: 'Copy session ID', icon: 'copy', onSelect: () => {} },
      { id: 'two', label: 'Make view wider', onSelect: () => {} },
    ];
    const { unmount } = render(<MenuButton label="Session actions" icon="more" entries={entries} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    const [withIcon, without] = screen.getAllByRole('menuitem');
    expect(withIcon?.querySelector('svg')).not.toBeNull();
    expect(without?.querySelector('svg')).toBeNull();
    expect(without?.querySelector('.menu-item-icon-room')?.getAttribute('aria-hidden')).toBe('true');
    expect(without?.textContent).toBe('Make view wider');
    unmount();

    render(<MenuButton label="Plain" icon="more" entries={[{ id: 'only', label: 'No icons here', onSelect: () => {} }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Plain' }));
    expect(screen.getByRole('menuitem').querySelector('.menu-item-icon-room')).toBeNull();
  });

  it('is an icon button that says it opens a menu, and controls the menu while it is open', async () => {
    const { button } = setup();
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    // Its name is its tooltip (6.1, item 5), and there's no title.
    expect(button.getAttribute('aria-label')).toBe('Session actions');
    expect(await tooltipText(button)).toBe('Session actions');
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'Session actions' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(menu.id);
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: 'Remove session' }).className).toBe('menu-item danger');
    // Items are reached with the arrows, not Tab.
    for (const item of screen.getAllByRole('menuitem')) expect(item.tabIndex).toBe(-1);
  });

  it('focuses the first item on open; ↓ and ↑ move, wrapping, past the separator; Home and End jump', () => {
    const { button, items } = setup();
    fireEvent.click(button);
    const [first, second, third] = items();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first!, { key: 'ArrowDown' });
    // A disabled item can still be reached, as the APG asks, so it can say why it's off.
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third!, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: 'End' });
    expect(document.activeElement).toBe(third);
  });

  it('activates an item with a click, Enter or Space: it closes, focus goes back to the button, then the item runs', () => {
    const { button, calls } = setup();
    fireEvent.click(button);
    // Enter and Space reach a <button> as a click.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove session' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
    expect(calls).toEqual([{ label: 'Remove session', focused: button }]);
  });

  it('ignores a disabled item, which stays aria-disabled with its reason, and keeps the menu open', () => {
    const { button, calls } = setup();
    fireEvent.click(button);
    const stop = screen.getByRole('menuitem', { name: 'Stop session' });
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    // Its reason describes it, and is its tooltip.
    expect(descriptionOf(stop)).toBe("It isn't running.");
    expect(stop.hasAttribute('title')).toBe(false);
    fireEvent.click(stop);
    expect(calls).toEqual([]);
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it("shows a disabled item's reason when the arrows reach it, and Escape closes the menu and its tooltip together", () => {
    const { button, items } = setup();
    fireEvent.click(button);
    const [first, stop] = items();
    expect(shownTooltip()).toBeNull();
    fireEvent.keyDown(first!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(stop);
    expect(shownTooltip()?.textContent).toBe("It isn't running.");

    fireEvent.keyDown(stop!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    // The item's tooltip went with the menu, and focus put back on the button doesn't open the button's.
    expect(shownTooltip()).toBeNull();
    // Moving focus there from elsewhere does.
    act(() => screen.getByRole('button', { name: 'Before' }).focus());
    act(() => button.focus());
    expect(shownTooltip()?.textContent).toBe('Session actions');
  });

  it('gives an enabled item no tooltip', () => {
    const { button, items } = setup({ disabled: false });
    fireEvent.click(button);
    fireEvent.keyDown(items()[0]!, { key: 'ArrowDown' });
    expect(items()[1]?.hasAttribute('aria-describedby')).toBe(false);
    expect(shownTooltip()).toBeNull();
  });

  it('closes on Escape, handled there so nothing behind closes too, and focus goes back to the button', () => {
    const { button } = setup();
    const behind = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    document.addEventListener('keydown', behind);
    fireEvent.click(button);

    fireEvent.keyDown(screen.getAllByRole('menuitem')[1]!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    // Stopped before it reached the document: Escape there would close the session view.
    expect(behind).not.toHaveBeenCalled();
    document.removeEventListener('keydown', behind);
  });

  it('closes on Tab, putting focus on the button so Tab goes on from there', () => {
    const { button } = setup();
    fireEvent.click(button);
    const tab = fireEvent.keyDown(screen.getAllByRole('menuitem')[0]!, { key: 'Tab' });
    // Not prevented: the browser moves focus on from the button.
    expect(tab).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes on a press outside, leaving focus to the press, and toggles on its button', () => {
    const { button } = setup();
    fireEvent.click(button);
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Copy session ID' }));
    expect(screen.getByRole('menu')).toBeTruthy();

    const after = screen.getByRole('button', { name: 'After' });
    fireEvent.pointerDown(after);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).not.toBe(button);

    fireEvent.click(button);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens below its button, and above it when there is no room below but there is above', () => {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) });
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? rect(0, 150) : rect(window.innerHeight - 40, 28);
    });
    const { button } = setup();
    fireEvent.click(button);
    expect(screen.getByRole('menu').className).toBe('menu up');
    fireEvent.click(button);

    spy.mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? rect(0, 150) : rect(20, 28);
    });
    fireEvent.click(button);
    expect(screen.getByRole('menu').className).toBe('menu');
  });

  it('with room on neither side, as on a short window, opens below, as tall as the window leaves, and scrolls (W54)', () => {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) });
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      // A panel taller than either side of a button in the middle of the window.
      return this.getAttribute('role') === 'menu' ? rect(0, window.innerHeight) : rect(window.innerHeight / 2 - 14, 28);
    });
    const { button } = setup();
    fireEvent.click(button);
    const menu = screen.getByRole('menu');
    expect(menu.className).toBe('menu');
    // Below the button: what's left of the window, less the 4 px gap and 8 px from its foot.
    expect(menu.style.maxHeight).toBe(`${window.innerHeight / 2 - 14 - 4 - 8}px`);
    expect(menu.style.overflowY).toBe('auto');
    fireEvent.click(button);

    // Room below again: no limit.
    spy.mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? rect(0, 150) : rect(20, 28);
    });
    fireEvent.click(button);
    expect(screen.getByRole('menu').style.maxHeight).toBe('');
  });

  it('closes with closeMenus, for a shortcut, inside the element given only: focus in it goes back to its button', () => {
    const entries: MenuEntry[] = [{ id: 'one', label: 'Copy session ID', onSelect: () => {} }];
    render(
      <>
        <div data-testid="here">
          <MenuButton label="Here" icon="more" entries={entries} />
        </div>
        <div data-testid="there">
          <MenuButton label="There" icon="more" entries={entries} />
        </div>
      </>,
    );
    const here = screen.getByRole('button', { name: 'Here' });
    const there = screen.getByRole('button', { name: 'There' });
    fireEvent.click(there);
    fireEvent.click(here);
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    expect(screen.getByRole('menu', { name: 'Here' }).contains(document.activeElement)).toBe(true);

    let closed = false;
    act(() => {
      closed = closeMenus(screen.getByTestId('here'));
    });
    expect(closed).toBe(true);
    expect(screen.queryByRole('menu', { name: 'Here' })).toBeNull();
    expect(here.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(here);
    // Its tooltip stays shut: focus was put back, not moved there.
    expect(shownTooltip()).toBeNull();
    expect(screen.getByRole('menu', { name: 'There' })).toBeTruthy();

    // One without focus in it closes, and focus stays where it is.
    act(() => {
      closed = closeMenus(document.body);
    });
    expect(closed).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(here);
    act(() => {
      closed = closeMenus(document.body);
    });
    expect(closed).toBe(false);
  });
});

// A radio group in a menu (W42, View preferences): its semantics, focus on the chosen option, the
// keyboard through its options, choosing, and the panel kept inside the window.
describe('MenuButton with a radio group (W42)', () => {
  function radio(value = 'b') {
    const changes: { value: string; focused: Element | null }[] = [];
    const entries: MenuEntry[] = [
      {
        kind: 'radio-group',
        id: 'pick',
        title: 'Group sessions by',
        value,
        options: [
          { value: 'a', label: 'Alpha', description: 'The first made-up mode.' },
          { value: 'b', label: 'Beta', description: 'The second made-up mode.' },
          { value: 'c', label: 'Gamma' },
        ],
        onChange: (next) => changes.push({ value: next, focused: document.activeElement }),
      },
    ];
    render(
      <>
        <MenuButton label="View preferences" icon="preferences" entries={entries} />
        <button type="button">After</button>
      </>,
    );
    const button = screen.getByRole('button', { name: 'View preferences' });
    const options = () => screen.getAllByRole('menuitemradio');
    return { button, options, changes };
  }

  const describedBy = (element: Element) => {
    const id = element.getAttribute('aria-describedby');
    return id === null ? undefined : document.getElementById(id)?.textContent;
  };

  it('is a group named by its title, of radio options named by their labels, the chosen one checked, each described by its line', () => {
    const { button, options } = radio();
    fireEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'View preferences' });
    const group = within(menu).getByRole('group', { name: 'Group sessions by' });
    expect(options().every((option) => group.contains(option))).toBe(true);
    expect(options().map((option) => option.getAttribute('aria-label') ?? document.getElementById(option.getAttribute('aria-labelledby') ?? '')?.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(options().map((option) => option.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(options().map(describedBy)).toEqual(['The first made-up mode.', 'The second made-up mode.', undefined]);
    expect(options().every((option) => option.tabIndex === -1)).toBe(true);
    // The title shows once, and is heard once, as the group's name.
    const title = menu.querySelector('.menu-group-title');
    expect(title?.textContent).toBe('Group sessions by');
    expect(title?.getAttribute('aria-hidden')).toBe('true');
    // The chosen one has the check mark; the others keep its room, so the labels line up.
    expect(options()[1]?.querySelector('svg')).not.toBeNull();
    expect(options()[0]?.querySelector('svg')).toBeNull();
    expect(options()[0]?.querySelector('.menu-item-icon-room')?.getAttribute('aria-hidden')).toBe('true');
    expect(menu.classList.contains('described')).toBe(true);
  });

  it('focuses the chosen option as it opens, and the arrows, Home and End move through the options, wrapping', () => {
    const { button, options } = radio('c');
    fireEvent.click(button);
    expect(document.activeElement).toBe(options()[2]);
    fireEvent.keyDown(options()[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options()[0]);
    fireEvent.keyDown(options()[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(options()[2]);
    fireEvent.keyDown(options()[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(options()[0]);
    fireEvent.keyDown(options()[0]!, { key: 'End' });
    expect(document.activeElement).toBe(options()[2]);
  });

  it('chooses an option with a click, Enter or Space: the menu closes, focus is back on the button, then onChange runs', () => {
    const { button, options, changes } = radio();
    fireEvent.click(button);
    fireEvent.keyDown(options()[1]!, { key: 'ArrowDown' });
    // Enter and Space reach a <button> as a click.
    fireEvent.click(options()[2]!);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(changes).toEqual([{ value: 'c', focused: button }]);
  });

  it('closes on the chosen option without calling onChange, since nothing changed', () => {
    const { button, options, changes } = radio();
    fireEvent.click(button);
    fireEvent.click(options()[1]!);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(changes).toEqual([]);
  });

  it('closes on Escape or Tab with focus on the button, choosing nothing', () => {
    const { button, options, changes } = radio();
    fireEvent.click(button);
    fireEvent.keyDown(options()[1]!, { key: 'ArrowDown' });
    fireEvent.keyDown(options()[2]!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.keyDown(options()[1]!, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(changes).toEqual([]);
  });

  it('moves the panel in from the window’s start edge when aligning it to the button’s end would cut it off there', () => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    // The panel would start 40 px off screen; the button is on screen, near the start of a narrow window.
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'menu') return { left: -40, right: 248, top: 60, bottom: 200, width: 288, height: 140, x: -40, y: 60, toJSON: () => ({}) } as DOMRect;
      if (this.getAttribute('aria-haspopup') === 'menu') return { left: 216, right: 248, top: 20, bottom: 52, width: 32, height: 32, x: 216, y: 20, toJSON: () => ({}) } as DOMRect;
      return real.call(this);
    });
    try {
      const { button } = radio();
      fireEvent.click(button);
      // 8 px from the edge: 48 px further in than aligned.
      expect(screen.getByRole('menu').style.right).toBe('-48px');
      fireEvent.keyDown(screen.getAllByRole('menuitemradio')[1]!, { key: 'Escape' });
    } finally {
      spy.mockRestore();
    }
    // A menu that fits stays aligned to its button's end.
    fireEvent.click(screen.getByRole('button', { name: 'View preferences' }));
    expect(screen.getByRole('menu').style.right).toBe('');
  });
});
