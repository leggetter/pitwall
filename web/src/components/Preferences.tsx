// The Preferences dialog (docs/design-system.md, 4: Preferences), W59, in place of W42's View
// preferences menu. Phil, 2026-10-23: "the preferences pane should be a dialog with sections covering
// the area that's being configured." The header's `preferences` icon button opens it.
//
// A small Dialog, with no footer: each choice applies as it's made, as the menu's did, and the page
// behind shows it at once, so there's nothing to save or cancel. Its sections follow the page, left
// to right, then what's the whole page's:
//
// - Repo list: Group sessions by (W42), which decides the repo list's groups and their counts.
// - Session view: Open running background sessions on (W54), and The terminal takes the keyboard (W57).
// - Keyboard: the single-key shortcuts, on or off: the same store as the keyboard shortcuts dialog's
//   off switch, which stays there, as WCAG 2.1.4's discoverable one.
// - Appearance: the theme: the same store as the header's theme switch, which stays as the quick way.
//
// Each section is a <section> named by its <h3>, and each setting a RadioGroup. Sort stays in the
// session list's header and the view's width on the divider: both are view controls, used in place.
// Each setting keeps its own key and validation: Group by and the two session view settings are the
// Dashboard's, passed in; the shortcuts and the theme are their stores' (shortcuts.ts, theme.ts).

import { useId, type ReactNode } from 'react';
import { BACKGROUND_TAB_DESCRIPTIONS, BACKGROUND_TAB_LABELS, BACKGROUND_TAB_TITLE, BACKGROUND_TABS, type BackgroundTab } from '../backgroundTab.js';
import { GROUP_BY_DESCRIPTIONS, GROUP_BY_LABELS, GROUP_BY_MODES, GROUP_BY_TITLE, type GroupBy } from '../groupBy.js';
import { useShortcuts } from '../shortcuts.js';
import { TERMINAL_FOCUS_DESCRIPTIONS, TERMINAL_FOCUS_LABELS, TERMINAL_FOCUS_TITLE, TERMINAL_FOCUSES, type TerminalFocus } from '../terminalFocus.js';
import { useTheme, type ThemeChoice } from '../theme.js';
import { Dialog } from './Dialog.js';
import { RadioGroup, type RadioOption } from './RadioGroup.js';
import './Preferences.css';

/** The header button's name and tooltip, and the dialog's title. */
export const PREFERENCES_LABEL = 'Preferences';

/** The dialog's subtitle, which describes it: why there's no Save button, and where the choices are kept. */
export const PREFERENCES_SUBTITLE = 'Each change applies at once, and this browser remembers it.';

/** The sections' titles, in the dialog's order. */
export const PREFERENCE_SECTIONS = {
  repoList: 'Repo list',
  sessionView: 'Session view',
  keyboard: 'Keyboard',
  appearance: 'Appearance',
} as const;

export const SHORTCUTS_TITLE = 'Single-key shortcuts';

export const SHORTCUTS_OPTIONS: readonly RadioOption<'on' | 'off'>[] = [
  { value: 'on', label: 'On', description: 'The keys /, n, ?, j, k and s work anywhere, except while you type in a field or the terminal.' },
  { value: 'off', label: 'Off', description: "Those keys do nothing, so a stray key or a speech command can't set one off." },
];

export const SHORTCUTS_PREFERENCE_HINT = 'The keyboard shortcuts dialog, from the header, lists every key and has this switch too.';

export const THEME_TITLE = 'Theme';

export const THEME_OPTIONS: readonly RadioOption<ThemeChoice>[] = [
  { value: 'system', label: 'System', description: 'Light or dark as your system is set, and it follows when that changes.' },
  { value: 'light', label: 'Light', description: 'Light, whatever your system says. The terminal stays dark.' },
  { value: 'dark', label: 'Dark', description: 'Dark, whatever your system says.' },
];

const GROUP_BY_OPTIONS: readonly RadioOption<GroupBy>[] = GROUP_BY_MODES.map((mode) => ({ value: mode, label: GROUP_BY_LABELS[mode], description: GROUP_BY_DESCRIPTIONS[mode] }));
const BACKGROUND_TAB_OPTIONS: readonly RadioOption<BackgroundTab>[] = BACKGROUND_TABS.map((tab) => ({ value: tab, label: BACKGROUND_TAB_LABELS[tab], description: BACKGROUND_TAB_DESCRIPTIONS[tab] }));
const TERMINAL_FOCUS_OPTIONS: readonly RadioOption<TerminalFocus>[] = TERMINAL_FOCUSES.map((choice) => ({
  value: choice,
  label: TERMINAL_FOCUS_LABELS[choice],
  description: TERMINAL_FOCUS_DESCRIPTIONS[choice],
}));

/** A section: a <section> named by its <h3>, then its settings. */
function PreferencesSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="preferences-section" aria-labelledby={id}>
      <h3 className="preferences-section-title" id={id}>
        {title}
      </h3>
      {children}
    </section>
  );
}

export interface RepoListPreferencesProps {
  groupBy: GroupBy;
  onGroupBy: (mode: GroupBy) => void;
}

/** Repo list: Group sessions by (W42). */
export function RepoListPreferences({ groupBy, onGroupBy }: RepoListPreferencesProps) {
  return (
    <PreferencesSection title={PREFERENCE_SECTIONS.repoList}>
      <RadioGroup legend={GROUP_BY_TITLE} value={groupBy} options={GROUP_BY_OPTIONS} onChange={onGroupBy} />
    </PreferencesSection>
  );
}

export interface SessionViewPreferencesProps {
  /** The tab a running background session's view opens on (W54). */
  backgroundTab: BackgroundTab;
  onBackgroundTab: (tab: BackgroundTab) => void;
  /** When the terminal takes the keyboard as it attaches (W57). */
  terminalFocus: TerminalFocus;
  onTerminalFocus: (choice: TerminalFocus) => void;
}

/** Session view: Open running background sessions on (W54), and The terminal takes the keyboard (W57). */
export function SessionViewPreferences({ backgroundTab, onBackgroundTab, terminalFocus, onTerminalFocus }: SessionViewPreferencesProps) {
  return (
    <PreferencesSection title={PREFERENCE_SECTIONS.sessionView}>
      <RadioGroup legend={BACKGROUND_TAB_TITLE} value={backgroundTab} options={BACKGROUND_TAB_OPTIONS} onChange={onBackgroundTab} />
      <RadioGroup legend={TERMINAL_FOCUS_TITLE} value={terminalFocus} options={TERMINAL_FOCUS_OPTIONS} onChange={onTerminalFocus} />
    </PreferencesSection>
  );
}

/** Keyboard: the single-key shortcuts, on the store the keyboard shortcuts dialog's off switch uses. */
export function KeyboardPreferences() {
  const { on, setOn } = useShortcuts();
  return (
    <PreferencesSection title={PREFERENCE_SECTIONS.keyboard}>
      <RadioGroup legend={SHORTCUTS_TITLE} hint={SHORTCUTS_PREFERENCE_HINT} value={on ? 'on' : 'off'} options={SHORTCUTS_OPTIONS} onChange={(value) => setOn(value === 'on')} />
    </PreferencesSection>
  );
}

/** Appearance: the theme, on the store the header's theme switch uses. */
export function AppearancePreferences() {
  const { choice, setChoice } = useTheme();
  return (
    <PreferencesSection title={PREFERENCE_SECTIONS.appearance}>
      <RadioGroup legend={THEME_TITLE} value={choice} options={THEME_OPTIONS} onChange={setChoice} />
    </PreferencesSection>
  );
}

/** The settings the Dashboard keeps, which the dialog shows and changes. */
export type PreferencesProps = RepoListPreferencesProps & SessionViewPreferencesProps;

export interface PreferencesDialogProps extends PreferencesProps {
  onClose: () => void;
}

export function PreferencesDialog({ onClose, groupBy, onGroupBy, backgroundTab, onBackgroundTab, terminalFocus, onTerminalFocus }: PreferencesDialogProps) {
  return (
    <Dialog title={PREFERENCES_LABEL} subtitle={PREFERENCES_SUBTITLE} size="sm" onClose={onClose} className="preferences-dialog">
      <RepoListPreferences groupBy={groupBy} onGroupBy={onGroupBy} />
      <SessionViewPreferences backgroundTab={backgroundTab} onBackgroundTab={onBackgroundTab} terminalFocus={terminalFocus} onTerminalFocus={onTerminalFocus} />
      <KeyboardPreferences />
      <AppearancePreferences />
    </Dialog>
  );
}
