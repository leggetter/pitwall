// The Preferences dialog in tests (Preferences.tsx, W59): opening it from the header's button, and
// choosing a setting's option as a person would, focusing the radio and clicking it, then closing it
// with Escape, which puts focus back on the button.

import { act, fireEvent, screen, within } from '@testing-library/react';

/** The header's Preferences button. */
export const preferencesButton = (): HTMLElement => screen.getByRole('button', { name: 'Preferences' });

/** The open Preferences dialog, or null. */
export const preferencesDialog = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Preferences' });

/** Opens the dialog from the header's button, focused as a click focuses it, unless it's open already, and returns it. */
export function openPreferences(): HTMLElement {
  const open = preferencesDialog();
  if (open) return open;
  const button = preferencesButton();
  act(() => button.focus());
  fireEvent.click(button);
  return screen.getByRole('dialog', { name: 'Preferences' });
}

/** A setting's radio group, by its legend, in the open dialog. */
export const preferenceGroup = (setting: string): HTMLElement => within(openPreferences()).getByRole('group', { name: setting });

/** A setting's radios, in order. */
export const preferenceOptions = (setting: string): HTMLInputElement[] => within(preferenceGroup(setting)).getAllByRole<HTMLInputElement>('radio');

/** One of a setting's radios, by its label. */
export const preferenceOption = (setting: string, option: string): HTMLInputElement => within(preferenceGroup(setting)).getByRole<HTMLInputElement>('radio', { name: option });

/** The label of a setting's chosen option. */
export const chosenPreference = (setting: string): string | undefined => {
  const chosen = preferenceOptions(setting).find((radio) => radio.checked);
  return chosen ? (chosen.labels?.[0]?.textContent ?? undefined) : undefined;
};

/**
 * Chooses `option` of `setting`: opens the dialog if it's closed, focuses the radio and clicks it, as
 * a click does, then, unless `close` is false, closes the dialog with Escape.
 */
export function choosePreference(setting: string, option: string, { close = true }: { close?: boolean } = {}): void {
  const radio = preferenceOption(setting, option);
  radio.focus();
  fireEvent.click(radio);
  if (close) fireEvent.keyDown(document.activeElement ?? radio, { key: 'Escape' });
}
