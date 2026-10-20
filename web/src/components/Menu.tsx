// A menu button and its menu (docs/design-system.md, 4: Menus): an icon button with
// aria-haspopup="menu" that opens a role="menu" panel below it, aligned to its end edge, flipping up
// when there's no room. ↑ and ↓ move between items, wrapping; Home and End jump to the ends; Enter or
// Space activates; Escape and Tab close it. Focus goes back to the button whenever it closes from the
// keyboard or an item, before the item runs, so an item that opens something can move focus on from
// there. A press outside closes it without moving focus; focus moving away by itself doesn't, so a
// page can show several open menus, as the #uikit gallery does. The other overlays (W25) build on this.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Icon, type IconName } from './Icon.js';

export interface MenuItem {
  kind?: 'item';
  /** Unique within the menu: its key. */
  id: string;
  /** Sentence case, a verb and its object. */
  label: string;
  icon?: IconName;
  /** In danger text, for an action that can't be undone without effort. */
  danger?: boolean;
  /** Shown and reachable with the arrows, but activating it does nothing (aria-disabled). */
  disabled?: boolean;
  /** Why it's disabled. The browser's hover text, until the design system's tooltips exist (W25). */
  hint?: string;
  /** Runs after the menu has closed and focus is back on its button. */
  onSelect: () => void;
}

export interface MenuSeparator {
  kind: 'separator';
  id: string;
}

export type MenuEntry = MenuItem | MenuSeparator;

export interface MenuButtonProps {
  /** The button's accessible name and hover text, and the menu's name. */
  label: string;
  icon: IconName;
  entries: readonly MenuEntry[];
  /** The button, for whatever later wants focus back on it, such as a confirmation an item opened. */
  buttonRef?: RefObject<HTMLButtonElement | null>;
  /** Whether the menu is open, for a caller that needs to know (Escape's layering). */
  onOpenChange?: (open: boolean) => void;
}

const isItem = (entry: MenuEntry): entry is MenuItem => entry.kind !== 'separator';

/** The gap between the button and the panel, in px. */
const GAP = 4;

export function MenuButton({ label, icon, entries, buttonRef, onOpenChange }: MenuButtonProps) {
  const menuId = useId();
  const own = useRef<HTMLButtonElement>(null);
  const button = buttonRef ?? own;
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  const show = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChangeRef.current?.(next);
  }, []);

  /** Closes the menu and puts focus back on its button. */
  const closeToButton = useCallback(() => {
    show(false);
    button.current?.focus();
  }, [show, button]);

  // On open: below the button unless there's no room there and there is above, then the first item takes focus.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = menu.current;
    const trigger = button.current;
    if (panel && trigger) {
      const height = panel.getBoundingClientRect().height + GAP;
      const { top, bottom } = trigger.getBoundingClientRect();
      // Only a button on screen can run out of room; one scrolled out of view opens below, as usual.
      const onScreen = bottom > 0 && top < window.innerHeight;
      setUp(onScreen && window.innerHeight - bottom < height && top >= height);
    }
    items()[0]?.focus();
  }, [open, button]);

  // A press outside the button and the menu closes it, leaving focus where the press puts it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && anchor.current?.contains(event.target)) return;
      show(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, show]);

  const move = (to: 'next' | 'previous' | 'first' | 'last') => {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const index =
      to === 'first' ? 0 : to === 'last' ? list.length - 1 : to === 'next' ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
    list[index]?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move('next');
        return;
      case 'ArrowUp':
        event.preventDefault();
        move('previous');
        return;
      case 'Home':
        event.preventDefault();
        move('first');
        return;
      case 'End':
        event.preventDefault();
        move('last');
        return;
      case 'Escape':
        // Handled here, so nothing behind it, such as the session view, closes too.
        event.preventDefault();
        event.stopPropagation();
        closeToButton();
        return;
      case 'Tab':
        // Back to the button, and Tab goes on from there to the next control.
        closeToButton();
        return;
    }
  };

  const activate = (item: MenuItem) => {
    if (item.disabled) return;
    closeToButton();
    // In the same event as the click or key, so a copy to the clipboard is still allowed (4: Copy).
    item.onSelect();
  };

  return (
    <div ref={anchor} className="menu-anchor">
      <button
        ref={button}
        type="button"
        className="icon-button ghost md"
        aria-label={label}
        // Until the design system's tooltips exist (W25), the browser's shows the same name.
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => show(!open)}
      >
        <Icon name={icon} />
      </button>
      {open && (
        <div ref={menu} id={menuId} className={up ? 'menu up' : 'menu'} role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
          {entries.map((entry) =>
            isItem(entry) ? (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={entry.danger ? 'menu-item danger' : 'menu-item'}
                aria-disabled={entry.disabled || undefined}
                title={entry.disabled ? entry.hint : undefined}
                onClick={() => activate(entry)}
              >
                {entry.icon && <Icon name={entry.icon} />}
                <span className="menu-item-label">{entry.label}</span>
              </button>
            ) : (
              <div key={entry.id} role="separator" className="menu-separator" />
            ),
          )}
        </div>
      )}
    </div>
  );
}
