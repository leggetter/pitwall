// Single-key shortcuts (docs/design-system.md, 6.2): `/`, `?`, `n`, `j` and `k`. They can be turned
// off in the keyboard shortcuts dialog (WCAG 2.1.4, Character Key Shortcuts), and the choice is stored
// in localStorage as pitwall.shortcuts.v1. They're on by default, and whenever storage is missing,
// blocked or holds anything else.
//
// As the theme does (theme.ts), one store holds the setting, so the dialog's checkbox, the filter
// field's key cap and every tooltip show the same one, and a change made in another tab arrives by
// the window's `storage` event.
//
// Which key is which shortcut is decided here, and when a key isn't one: never while typing in a
// field, a select, something contenteditable or the terminal, never with ⌘, Ctrl or Alt held, so the
// browser's and the system's own shortcuts are untouched, and never for a key someone else handled.
// What each one does is the Dashboard's.

import { createContext, useContext, useSyncExternalStore } from 'react';
import { browserStorage, type StorageSource } from './groupState.js';
import type { StorageEvents } from './theme.js';

export const SHORTCUTS_KEY = 'pitwall.shortcuts.v1';

/** A stored value as on or off: only "off" is off, so missing, unreadable or unknown values are on. */
export function parseShortcutsOn(value: unknown): boolean {
  return value !== 'off';
}

export function readShortcutsOn(storage: StorageSource = browserStorage): boolean {
  try {
    return parseShortcutsOn(storage()?.getItem(SHORTCUTS_KEY));
  } catch {
    // Blocked: on, the default.
    return true;
  }
}

export function writeShortcutsOn(on: boolean, storage: StorageSource = browserStorage): void {
  try {
    storage()?.setItem(SHORTCUTS_KEY, on ? 'on' : 'off');
  } catch {
    // Blocked or full: the choice lasts until the page reloads.
  }
}

export interface ShortcutsStore {
  /** Whether the single-key shortcuts are on. */
  get(): boolean;
  /** Stores the choice and applies it at once. */
  set(on: boolean): void;
  subscribe(listener: () => void): () => void;
}

export interface ShortcutsEnv {
  storage?: StorageSource;
  /** Default: window. */
  events?: StorageEvents;
}

export function createShortcutsStore({ storage = browserStorage, events = window }: ShortcutsEnv = {}): ShortcutsStore {
  const listeners = new Set<() => void>();
  let on = readShortcutsOn(storage);
  const show = (next: boolean) => {
    if (next === on) return;
    on = next;
    for (const listener of listeners) listener();
  };
  // A choice made in another of pitwall's tabs, or storage cleared (a null key). Read, never written
  // back, so two tabs can't echo a change between them.
  events.addEventListener('storage', (event) => {
    if (event.key === SHORTCUTS_KEY || event.key === null) show(readShortcutsOn(storage));
  });
  return {
    get: () => on,
    set(next) {
      writeShortcutsOn(next, storage);
      show(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let pageStore: ShortcutsStore | undefined;

/** The page's store, on localStorage and the window's `storage` event. */
export function pageShortcutsStore(): ShortcutsStore {
  pageStore ??= createShortcutsStore();
  return pageStore;
}

/** Tests and the gallery can provide a store of their own, so their choices stay in memory. */
export const ShortcutsStoreContext = createContext<ShortcutsStore | undefined>(undefined);

export function useShortcutsStore(): ShortcutsStore {
  return useContext(ShortcutsStoreContext) ?? pageShortcutsStore();
}

/** Whether the single-key shortcuts are on, and a way to turn them on or off. */
export function useShortcuts(): { on: boolean; setOn: (on: boolean) => void } {
  const store = useShortcutsStore();
  const on = useSyncExternalStore(store.subscribe, store.get);
  return { on, setOn: store.set };
}

/**
 * Whether a combination of key caps is a single character key, such as `/` or `n`: one key that
 * types a printable character. Tooltips leave those out while the shortcuts are off. Esc, F6, ↵, the
 * arrows and combinations with a modifier aren't character keys, so they still show.
 */
export function isCharacterKey(keys: readonly string[]): boolean {
  return keys.length === 1 && /^[!-~]$/.test(keys[0] ?? '');
}

/** Input types whose keys aren't typing, such as a checkbox's Space. Every other input takes text. */
const NOT_TEXT = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** Whether a key on `target` is typing: in a text field, a textarea, a select, something contenteditable or the terminal. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('.xterm')) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !NOT_TEXT.has(target.type);
  return (target instanceof HTMLElement && target.isContentEditable) || target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

export type Shortcut = 'filter' | 'new-session' | 'shortcuts' | 'next' | 'previous';

const KEYS: ReadonlyMap<string, Shortcut> = new Map([
  ['/', 'filter'],
  ['n', 'new-session'],
  ['?', 'shortcuts'],
  ['j', 'next'],
  ['k', 'previous'],
]);

/** Shortcuts that open a dialog, which holding the key down mustn't repeat. */
const NO_REPEAT: ReadonlySet<Shortcut> = new Set(['new-session', 'shortcuts']);

/**
 * The single-key shortcut a key press is, if any. Not with ⌘, Ctrl or Alt held, not while typing,
 * not while an input method is composing, not for a key something nearer already handled, and not
 * when `n` or `?` repeats as the key is held. Shift is allowed, since some layouts need it for `/`
 * and most for `?`; it makes `n`, `j` and `k` capitals, which aren't shortcuts. Whether the
 * shortcuts are on is the caller's to check.
 */
export function shortcutFor(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'repeat' | 'isComposing' | 'defaultPrevented' | 'target'>): Shortcut | undefined {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return undefined;
  const shortcut = KEYS.get(event.key);
  if (shortcut === undefined || (event.repeat && NO_REPEAT.has(shortcut))) return undefined;
  return isTyping(event.target) ? undefined : shortcut;
}

/** The key caps for each shortcut that has a control: in its tooltip, or beside the filter field. */
export const SHORTCUT_KEYS = {
  filter: { keys: ['/'], label: 'Slash' },
  newSession: { keys: ['n'], label: 'N' },
  shortcuts: { keys: ['?'], label: 'Question mark' },
} as const;
