// The single-key shortcuts' setting and keys (docs/design-system.md, 6.2, and 4: Keyboard shortcuts
// dialog): pitwall.shortcuts.v1, on by default and whenever storage is missing or throws, a change
// from another tab, and which key presses are shortcuts at all.

import { describe, expect, it } from 'vitest';
import type { StorageSource } from './groupState.js';
import { createShortcutsStore, isCharacterKey, isTyping, pageShortcutsStore, readShortcutsOn, SHORTCUTS_KEY, shortcutFor, writeShortcutsOn } from './shortcuts.js';

function memory(entries: Record<string, string> = {}): StorageSource & { values: Map<string, string> } {
  const values = new Map(Object.entries(entries));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return Object.assign(() => storage, { values });
}

const throwing: StorageSource = () => ({
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
});

/** A window's `storage` events, sent by hand, as another tab's change would arrive. */
function events() {
  const listeners: ((event: { key: string | null }) => void)[] = [];
  return {
    addEventListener: (_type: 'storage', listener: (event: { key: string | null }) => void) => void listeners.push(listener),
    fire: (key: string | null) => {
      for (const listener of listeners) listener({ key });
    },
  };
}

describe('pitwall.shortcuts.v1', () => {
  it('is on by default: with nothing stored, no storage, or anything but "off"', () => {
    expect(readShortcutsOn(memory())).toBe(true);
    expect(readShortcutsOn(() => undefined)).toBe(true);
    expect(readShortcutsOn(memory({ [SHORTCUTS_KEY]: 'on' }))).toBe(true);
    expect(readShortcutsOn(memory({ [SHORTCUTS_KEY]: 'false' }))).toBe(true);
    expect(readShortcutsOn(memory({ [SHORTCUTS_KEY]: 'off' }))).toBe(false);
  });

  it('stores on and off, and reads them back', () => {
    const storage = memory();
    writeShortcutsOn(false, storage);
    expect(storage.values.get(SHORTCUTS_KEY)).toBe('off');
    expect(readShortcutsOn(storage)).toBe(false);
    writeShortcutsOn(true, storage);
    expect(storage.values.get(SHORTCUTS_KEY)).toBe('on');
    expect(readShortcutsOn(storage)).toBe(true);
  });

  it('is on when storage throws, and a choice made then lasts in memory, without throwing', () => {
    expect(readShortcutsOn(throwing)).toBe(true);
    expect(() => writeShortcutsOn(false, throwing)).not.toThrow();
    const store = createShortcutsStore({ storage: throwing, events: events() });
    expect(store.get()).toBe(true);
    store.set(false);
    expect(store.get()).toBe(false);
  });

  it('starts from what is stored, and tells its listeners of a change', () => {
    const storage = memory({ [SHORTCUTS_KEY]: 'off' });
    const store = createShortcutsStore({ storage, events: events() });
    expect(store.get()).toBe(false);
    let heard = 0;
    const stop = store.subscribe(() => {
      heard += 1;
    });
    store.set(true);
    expect(store.get()).toBe(true);
    expect(storage.values.get(SHORTCUTS_KEY)).toBe('on');
    expect(heard).toBe(1);
    store.set(true);
    expect(heard).toBe(1);
    stop();
    store.set(false);
    expect(heard).toBe(1);
  });

  it("picks up another tab's change from the storage event, and storage being cleared, never writing back", () => {
    const storage = memory();
    const tabs = events();
    const store = createShortcutsStore({ storage, events: tabs });
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    storage.values.set(SHORTCUTS_KEY, 'off');
    tabs.fire('pitwall.theme.v1');
    expect(store.get()).toBe(true);
    tabs.fire(SHORTCUTS_KEY);
    expect(store.get()).toBe(false);
    expect(heard).toBe(1);
    storage.values.clear();
    tabs.fire(null);
    expect(store.get()).toBe(true);
    expect(heard).toBe(2);
    expect(storage.values.size).toBe(0);
  });

  it("the page's store is on localStorage and the window's storage event", () => {
    const store = pageShortcutsStore();
    expect(store.get()).toBe(true);
    store.set(false);
    expect(window.localStorage.getItem(SHORTCUTS_KEY)).toBe('off');
    // Another tab turns them back on.
    window.localStorage.setItem(SHORTCUTS_KEY, 'on');
    window.dispatchEvent(new StorageEvent('storage', { key: SHORTCUTS_KEY }));
    expect(store.get()).toBe(true);
  });
});

/** A key press as the document sees it, on `target`. */
function press(key: string, target: EventTarget | null = document.body, init: Partial<Parameters<typeof shortcutFor>[0]> = {}) {
  return shortcutFor({ key, altKey: false, ctrlKey: false, metaKey: false, repeat: false, isComposing: false, defaultPrevented: false, target, ...init });
}

describe('which key presses are shortcuts', () => {
  it('maps /, n, ?, j, k and s, and nothing else', () => {
    expect(press('/')).toBe('filter');
    expect(press('n')).toBe('new-session');
    expect(press('?')).toBe('shortcuts');
    expect(press('j')).toBe('next');
    expect(press('k')).toBe('previous');
    expect(press('s')).toBe('star');
    for (const key of ['N', 'J', 'K', 'S', 'a', 'Enter', 'Escape', 'ArrowDown', 'F6', 'constructor', ' ']) expect(press(key)).toBeUndefined();
  });

  it('never with ⌘, Ctrl or Alt held; Shift is allowed, since ? needs it', () => {
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      for (const key of ['/', 'n', '?', 'j', 'k', 's']) expect(press(key, document.body, { [modifier]: true })).toBeUndefined();
    }
    expect(press('?', document.body)).toBe('shortcuts');
  });

  it('ignores n, ? and s repeating as the key is held, but lets j and k repeat', () => {
    expect(press('n', document.body, { repeat: true })).toBeUndefined();
    expect(press('?', document.body, { repeat: true })).toBeUndefined();
    // Held, s would star and unstar over and over (W53).
    expect(press('s', document.body, { repeat: true })).toBeUndefined();
    expect(press('j', document.body, { repeat: true })).toBe('next');
    expect(press('k', document.body, { repeat: true })).toBe('previous');
  });

  it('ignores a key something nearer handled, and one an input method is composing', () => {
    expect(press('j', document.body, { defaultPrevented: true })).toBeUndefined();
    expect(press('j', document.body, { isComposing: true })).toBeUndefined();
  });

  it('ignores keys typed into a text field, a textarea, a select, something contenteditable or the terminal', () => {
    const make = (html: string) => {
      const holder = document.createElement('div');
      holder.innerHTML = html;
      document.body.append(holder);
      return holder.firstElementChild!;
    };
    const typing = [
      make('<input type="text">'),
      make('<input type="search">'),
      make('<input>'),
      make('<input type="number">'),
      make('<textarea></textarea>'),
      make('<select><option>a</option></select>'),
      make('<div contenteditable="true"><span>text</span></div>').firstElementChild!,
      make('<div contenteditable=""></div>'),
      make('<div class="xterm"><textarea class="xterm-helper-textarea"></textarea><div class="xterm-screen"></div></div>').lastElementChild!,
    ];
    for (const target of typing) {
      expect(isTyping(target)).toBe(true);
      for (const key of ['/', 'n', '?', 'j', 'k', 's']) expect(press(key, target)).toBeUndefined();
    }
    const notTyping = [document.body, make('<button>Go</button>'), make('<input type="checkbox">'), make('<div tabindex="0"></div>'), make('<div contenteditable="false"></div>')];
    for (const target of notTyping) {
      expect(isTyping(target)).toBe(false);
      expect(press('j', target)).toBe('next');
    }
    document.body.replaceChildren();
  });
});

describe('character keys, which tooltips leave out while the shortcuts are off', () => {
  it('are one printable key; Esc, F6, ↵, the arrows and combinations are not', () => {
    for (const keys of [['/'], ['?'], ['n'], ['j'], ['1']]) expect(isCharacterKey(keys)).toBe(true);
    for (const keys of [['Esc'], ['F6'], ['↵'], ['↑'], ['→'], ['⌘', '↵'], ['Ctrl', '↵'], ['Shift', 'Tab'], []]) expect(isCharacterKey(keys)).toBe(false);
  });
});
