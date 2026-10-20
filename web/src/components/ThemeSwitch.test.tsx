// The theme switch (docs/design-system.md, section 4 and 2.2): its semantics, what pressing an option
// stores and shows, and System following the system live. Each test has its own store, on fakes.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { StorageSource } from '../groupState.js';
import { createThemeStore, THEME_KEY, ThemeStoreContext, type ThemeStore } from '../theme.js';
import { ThemeSwitch } from './ThemeSwitch.js';

function fakeQuery(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    matches,
    addEventListener(_type: 'change', listener: () => void) {
      listeners.add(listener);
    },
    flip(next: boolean) {
      this.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

function setup({ stored, systemDark = false, blocked = false }: { stored?: string; systemDark?: boolean; blocked?: boolean } = {}) {
  const values = new Map<string, string>(stored === undefined ? [] : [[THEME_KEY, stored]]);
  const storage: StorageSource = () => {
    if (blocked) throw new DOMException('The operation is insecure.', 'SecurityError');
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
  };
  const query = fakeQuery(systemDark);
  const root = document.documentElement;
  const store = createThemeStore({ storage, darkQuery: () => query, root: () => root });
  const wrap = (children: ReactNode, value: ThemeStore = store) => <ThemeStoreContext.Provider value={value}>{children}</ThemeStoreContext.Provider>;
  return { values, query, root, store, wrap };
}

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');

describe('ThemeSwitch', () => {
  it('is a group named Theme, of three toggle buttons named for their theme', () => {
    const { wrap } = setup();
    render(wrap(<ThemeSwitch />));

    const group = screen.getByRole('group', { name: 'Theme' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['System theme', 'Light theme', 'Dark theme']);
    for (const button of buttons) {
      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('aria-pressed')).toMatch(/^(?:true|false)$/);
      // The icon is decorative; the label names the button.
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('presses System when nothing is stored', () => {
    const { wrap } = setup();
    render(wrap(<ThemeSwitch />));

    expect([pressed('System theme'), pressed('Light theme'), pressed('Dark theme')]).toEqual(['true', 'false', 'false']);
  });

  it('presses the stored choice', () => {
    const { wrap } = setup({ stored: 'dark' });
    render(wrap(<ThemeSwitch />));

    expect([pressed('System theme'), pressed('Light theme'), pressed('Dark theme')]).toEqual(['false', 'false', 'true']);
  });

  it('stores the choice and changes data-theme at once, with no reload', () => {
    const { wrap, values, root } = setup({ systemDark: false });
    render(wrap(<ThemeSwitch />));
    expect(root.getAttribute('data-theme')).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'Dark theme' }));
    expect(values.get(THEME_KEY)).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(pressed('Dark theme')).toBe('true');
    expect(pressed('System theme')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Light theme' }));
    expect(values.get(THEME_KEY)).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it("follows the system's change event live while System is pressed, and not otherwise", () => {
    const { wrap, query, root } = setup({ stored: 'light', systemDark: false });
    render(wrap(<ThemeSwitch />));

    act(() => query.flip(true));
    expect(root.getAttribute('data-theme')).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'System theme' }));
    expect(root.getAttribute('data-theme')).toBe('dark');
    act(() => query.flip(false));
    expect(root.getAttribute('data-theme')).toBe('light');
    act(() => query.flip(true));
    expect(root.getAttribute('data-theme')).toBe('dark');
    // System stays pressed throughout: only what it resolves to changes.
    expect(pressed('System theme')).toBe('true');
  });

  it('keeps every switch on the page in step, because they share one store', () => {
    const { wrap } = setup();
    render(
      wrap(
        <>
          <div data-testid="one">
            <ThemeSwitch />
          </div>
          <div data-testid="two">
            <ThemeSwitch />
          </div>
        </>,
      ),
    );

    fireEvent.click(within(screen.getByTestId('one')).getByRole('button', { name: 'Dark theme' }));
    expect(within(screen.getByTestId('two')).getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('still switches when storage is blocked', () => {
    const { wrap, root } = setup({ blocked: true });
    render(wrap(<ThemeSwitch />));

    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Dark theme' }))).not.toThrow();
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(pressed('Dark theme')).toBe('true');
  });
});
