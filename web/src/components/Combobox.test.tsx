// The Combobox on its own: how its highlight follows options that change under it, and autoSelect
// (W142) against the default. New session's Directory field is tested through the real dialog in
// DirectoryCombobox.test.tsx. Made-up options only.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Combobox, type ComboboxOption } from './Combobox.js';

const options = (...labels: string[]): ComboboxOption[] => labels.map((label) => ({ label }));

function renderBox(props: { value?: string; options: ComboboxOption[]; autoSelect?: boolean }) {
  const onInput = vi.fn();
  const onAccept = vi.fn();
  const ui = (next: { value?: string; options: ComboboxOption[]; autoSelect?: boolean }) => (
    <Combobox
      id="box"
      label="Thing"
      listLabel="Things"
      value={next.value ?? ''}
      onInput={onInput}
      options={next.options}
      onAccept={onAccept}
      autoSelect={next.autoSelect ?? false}
    />
  );
  const result = render(ui(props));
  const input = screen.getByRole('combobox', { name: 'Thing' }) as HTMLInputElement;
  return { input, onAccept, rerender: (next: typeof props) => result.rerender(ui(next)) };
}

const active = (input: HTMLInputElement) => {
  const id = input.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent : undefined;
};
const key = (input: HTMLInputElement, name: string) => fireEvent.keyDown(input, { key: name });

describe('Combobox', () => {
  it('keeps the highlight on the option the arrows moved to as the options change, and drops it when that one goes', () => {
    const { input, rerender } = renderBox({ options: options('beta', 'gamma') });
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    expect(active(input)).toBe('gamma');
    rerender({ options: options('alpha', 'beta', 'gamma') });
    expect(active(input)).toBe('gamma');
    rerender({ options: options('alpha', 'beta') });
    expect(active(input)).toBeUndefined();
  });

  it('without autoSelect, typing highlights none, so Enter only closes the list', () => {
    const { input, onAccept, rerender } = renderBox({ options: options('alpha', 'beta') });
    fireEvent.change(input, { target: { value: 'a' } });
    rerender({ value: 'a', options: options('alpha', 'beta') });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(active(input)).toBeUndefined();
    key(input, 'Enter');
    expect(onAccept).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('with autoSelect, typing highlights the first, following it as the options change, and Enter accepts it', () => {
    const { input, onAccept, rerender } = renderBox({ options: [], autoSelect: true });
    fireEvent.change(input, { target: { value: 'a' } });
    rerender({ value: 'a', options: [], autoSelect: true });
    expect(active(input)).toBeUndefined();
    rerender({ value: 'a', options: options('beta', 'alpha'), autoSelect: true });
    expect(active(input)).toBe('beta');
    rerender({ value: 'a', options: options('alpha', 'beta'), autoSelect: true });
    expect(active(input)).toBe('alpha');
    key(input, 'Enter');
    expect(onAccept).toHaveBeenCalledWith({ label: 'alpha' });
  });

  it('scrolls the list back to the top as you type, so a first match it highlights is in sight', () => {
    const { input, rerender } = renderBox({ options: options('alpha', 'beta', 'gamma'), autoSelect: true });
    key(input, 'ArrowDown');
    const list = screen.getByRole('listbox', { name: 'Things' });
    const scrolledTo: number[] = [];
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => 40, set: (to: number) => scrolledTo.push(to) });
    fireEvent.change(input, { target: { value: 'a' } });
    rerender({ value: 'a', options: options('alpha', 'gamma'), autoSelect: true });
    expect(scrolledTo).toEqual([0]);
    expect(active(input)).toBe('alpha');
  });

  it('with autoSelect turned off as it renders, the first typed towards is not highlighted', () => {
    const { input, rerender } = renderBox({ options: options('alpha'), autoSelect: true });
    fireEvent.change(input, { target: { value: 'alpha' } });
    rerender({ value: 'alpha', options: options('alpha'), autoSelect: false });
    expect(active(input)).toBeUndefined();
    // ← → Home End leave the options, with autoSelect on as with it off.
    fireEvent.change(input, { target: { value: 'alph' } });
    rerender({ value: 'alph', options: options('alpha'), autoSelect: true });
    expect(active(input)).toBe('alpha');
    key(input, 'Home');
    expect(active(input)).toBeUndefined();
  });
});
