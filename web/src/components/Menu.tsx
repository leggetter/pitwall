// A menu button and its menu (docs/design-system.md, 4: Menus): an icon button with
// aria-haspopup="menu" that opens a role="menu" panel below it, aligned to its end edge, flipping up
// when there's no room, and moved in from the window's start edge when aligning would cut it off
// there. ↑ and ↓ move between items, wrapping; Home and End jump to the ends; Enter or Space
// activates; Escape and Tab close it. Focus goes back to the button whenever it closes from the
// keyboard or an item, before the item runs, so an item that opens something can move focus on from
// there. A press outside closes it without moving focus; focus moving away by itself doesn't, so a
// page can show several open menus, as the #uikit gallery does. With room on neither side of its
// button, as on a short window, it opens below, as tall as the window leaves, and scrolls (W54, as
// View preferences grew a second group).
//
// A radio group (W42, View preferences) is a role="group" of role="menuitemradio" items, named by
// its title, which shows above them. Each option has a label and may have one line saying what it
// does, which describes it; the chosen one is aria-checked, with a check mark. Opening focuses the
// chosen option, and choosing one closes the menu as any item does, then calls onChange when the
// choice changed. The arrows go through a group's options as through any items.
//
// The button's name is its tooltip. A disabled item says why in a tooltip, on hover and when the
// arrows reach it, and is described by it; Escape still closes the menu, its tooltip with it.
//
// A single-key shortcut that moves focus elsewhere, such as `/` or `j`, closes the open menus first
// (closeMenus), so none is left open behind wherever focus goes.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Icon, type IconName } from './Icon.js';
import { focusQuietly, Tooltip } from './Tooltip.js';

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
  /** Why it's disabled, in its tooltip. */
  hint?: string;
  /** Runs after the menu has closed and focus is back on its button. */
  onSelect: () => void;
}

export interface MenuSeparator {
  kind: 'separator';
  id: string;
}

/** One choice in a radio group. */
export interface MenuRadioOption<V extends string = string> {
  value: V;
  /** Sentence case, short: the option's accessible name. */
  label: string;
  /** One plain line saying what it does, under the label, which describes the option. */
  description?: string;
}

/** A set of options, one of them chosen: role="group" of role="menuitemradio" items (W42). */
export interface MenuRadioGroup<V extends string = string> {
  kind: 'radio-group';
  id: string;
  /** The group's name, shown above its options. */
  title: string;
  options: readonly MenuRadioOption<V>[];
  /** The chosen option's value. */
  value: V;
  /** Runs after the menu has closed and focus is back on its button, when the choice changed. */
  onChange: (value: V) => void;
}

export type MenuEntry = MenuItem | MenuSeparator | MenuRadioGroup;

export interface MenuButtonProps {
  /** The button's accessible name and tooltip, and the menu's name. */
  label: string;
  icon: IconName;
  entries: readonly MenuEntry[];
  /** The button, for whatever later wants focus back on it, such as a confirmation an item opened. */
  buttonRef?: RefObject<HTMLButtonElement | null>;
  /** Whether the menu is open, for a caller that needs to know (Escape's layering). */
  onOpenChange?: (open: boolean) => void;
}

const isItem = (entry: MenuEntry): entry is MenuItem => entry.kind === undefined || entry.kind === 'item';

/** The gap between the button and the panel, in px. */
const GAP = 4;

/** How close the panel may come to the window's start edge, in px, when it's moved in from there, and to its foot when it scrolls. */
const EDGE = 8;

/** The least a panel that scrolls is cut to, in px: two items and a bit, so it reads as a list that goes on. */
const MIN_LIMIT = 96;

/** Everything the arrows move through: items and radio options alike. */
const FOCUSABLE = '[role="menuitem"], [role="menuitemradio"]';

/** Each open menu: where it is, and how to close it. */
const openMenus = new Map<() => void, () => Element | null>();

/**
 * Closes every open menu inside `within`, for a shortcut that moves focus elsewhere (docs/design-system.md,
 * 6.2). Focus in one goes back to its button first, as Escape would put it, so a dialog the shortcut
 * opens returns focus there. Returns whether any was open.
 */
export function closeMenus(within: Element): boolean {
  let closed = false;
  for (const [close, where] of [...openMenus]) {
    const anchor = where();
    if (!anchor || !within.contains(anchor)) continue;
    close();
    closed = true;
  }
  return closed;
}

export function MenuButton({ label, icon, entries, buttonRef, onOpenChange }: MenuButtonProps) {
  const menuId = useId();
  const own = useRef<HTMLButtonElement>(null);
  const button = buttonRef ?? own;
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  // How far the panel is moved in from the window's start edge, which aligning it to the button's end cut off.
  const [shift, setShift] = useState(0);
  // How tall the panel may be, when it fits neither below its button nor above: it scrolls then.
  const [limit, setLimit] = useState<number | undefined>(undefined);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];

  const show = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChangeRef.current?.(next);
  }, []);

  /** Closes the menu and puts focus back on its button. */
  const closeToButton = useCallback(() => {
    show(false);
    // Put back, not moved there by the user: its tooltip stays shut.
    focusQuietly(button.current);
  }, [show, button]);

  // On open: below the button unless there's no room there and there is above, moved in from the
  // window's start edge if it would cross it, then the chosen radio option, or the first item, takes focus.
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      setLimit(undefined);
      return;
    }
    const panel = menu.current;
    const trigger = button.current;
    if (panel && trigger) {
      const rect = panel.getBoundingClientRect();
      const height = rect.height + GAP;
      const { top, bottom } = trigger.getBoundingClientRect();
      // Only a button on screen can run out of room; one scrolled out of view opens below, as usual.
      const onScreen = bottom > 0 && top < window.innerHeight;
      const below = window.innerHeight - bottom;
      setUp(onScreen && below < height && top >= height);
      // A button near the start of a narrow window: the panel, aligned to its end, would start off screen.
      setShift(onScreen && rect.left < EDGE ? EDGE - rect.left : 0);
      // No room on either side: below, down to EDGE from the window's foot, scrolling, and never so
      // short that an item or two can't show.
      setLimit(onScreen && below < height && top < height ? Math.max(below - GAP - EDGE, MIN_LIMIT) : undefined);
    }
    // Without scrolling: the menu opens where its button already is, in view.
    const list = items();
    (list.find((item) => item.getAttribute('aria-checked') === 'true') ?? list[0])?.focus({ preventScroll: true });
  }, [open, button]);

  // While open, a shortcut can close it (closeMenus).
  useEffect(() => {
    if (!open) return;
    const close = () => {
      if (menu.current?.contains(document.activeElement)) closeToButton();
      else show(false);
    };
    openMenus.set(close, () => anchor.current);
    return () => {
      openMenus.delete(close);
    };
  }, [open, closeToButton, show]);

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

  // Radio options keep an icon's room for the check mark, so labels line up with any items' too.
  const iconRoom = entries.some((entry) => (isItem(entry) && entry.icon !== undefined) || entry.kind === 'radio-group');
  const described = entries.some((entry) => entry.kind === 'radio-group' && entry.options.some((option) => option.description !== undefined));

  const activate = (item: MenuItem) => {
    if (item.disabled) return;
    closeToButton();
    // In the same event as the click or key, so a copy to the clipboard is still allowed (4: Copy).
    item.onSelect();
  };

  const choose = (group: MenuRadioGroup, value: string) => {
    closeToButton();
    if (value !== group.value) group.onChange(value);
  };

  const radioGroup = (group: MenuRadioGroup) => {
    const base = `${menuId}-${group.id}`;
    return (
      // Named by its title; the title shown is hidden from assistive technology, which hears the name once.
      <div key={group.id} role="group" aria-label={group.title} className="menu-group">
        <div className="menu-group-title" aria-hidden="true">
          {group.title}
        </div>
        {group.options.map((option, index) => {
          const checked = option.value === group.value;
          const labelId = `${base}-${index}-label`;
          const descriptionId = `${base}-${index}-description`;
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              tabIndex={-1}
              className="menu-item menu-radio"
              aria-labelledby={labelId}
              aria-describedby={option.description === undefined ? undefined : descriptionId}
              onClick={() => choose(group, option.value)}
            >
              {checked ? <Icon name="checked" /> : <span className="menu-item-icon-room" aria-hidden="true" />}
              <span className="menu-radio-text">
                <span className="menu-item-label" id={labelId}>
                  {option.label}
                </span>
                {option.description !== undefined && (
                  <span className="menu-radio-description" id={descriptionId}>
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div ref={anchor} className="menu-anchor">
      <Tooltip content={label} relation="label">
        <button
          ref={button}
          type="button"
          className="icon-button ghost md"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => show(!open)}
        >
          <Icon name={icon} />
        </button>
      </Tooltip>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className={['menu', up && 'up', described && 'described'].filter(Boolean).join(' ')}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          style={shift > 0 || limit !== undefined ? { ...(shift > 0 ? { right: `${-shift}px` } : {}), ...(limit !== undefined ? { maxHeight: `${limit}px`, overflowY: 'auto' } : {}) } : undefined}
        >
          {/* An item with no icon of its own keeps the room for one, so the labels line up. */}
          {entries.map((entry) =>
            entry.kind === 'radio-group' ? (
              radioGroup(entry)
            ) : isItem(entry) ? (
              <Tooltip key={entry.id} content={entry.disabled ? entry.hint : undefined} relation="description">
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={entry.danger ? 'menu-item danger' : 'menu-item'}
                  aria-disabled={entry.disabled || undefined}
                  onClick={() => activate(entry)}
                >
                  {entry.icon ? <Icon name={entry.icon} /> : iconRoom && <span className="menu-item-icon-room" aria-hidden="true" />}
                  <span className="menu-item-label">{entry.label}</span>
                </button>
              </Tooltip>
            ) : (
              <div key={entry.id} role="separator" className="menu-separator" />
            ),
          )}
        </div>
      )}
    </div>
  );
}
