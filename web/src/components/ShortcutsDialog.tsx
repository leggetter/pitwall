// The keyboard shortcuts dialog (docs/design-system.md, 4: Keyboard shortcuts dialog): a small
// Dialog listing the keyboard map in 6.2, with key caps, ⌘ or Ctrl by platform. It opens from `?` or
// the header's keyboard button, and the checkbox at its top turns the single-key shortcuts on or off
// (WCAG 2.1.4), stored as pitwall.shortcuts.v1. With nothing to submit, it has no footer.
//
// keyboardMap() names each row of 6.2's table by its Key and Where cells, as the doc writes them, and
// ShortcutsDialog.test.tsx checks the two list the same rows.

import { Fragment, useId } from 'react';
import { useShortcuts } from '../shortcuts.js';
import { Dialog } from './Dialog.js';
import { KeyCaps, usesCommandKey } from './KeyCaps.js';
import './ShortcutsDialog.css';

/** One combination of keys, as KeyCaps takes it: the caps and how to read them out. */
export interface Combo {
  keys: readonly string[];
  label: string;
}

export interface MapRow {
  /** The row of 6.2's table this is: its Key and Where cells, exactly as the doc has them. */
  doc: { key: string; where: string };
  /** What it does, and where when that isn't the group's. */
  what: string;
  /** Lists of alternatives: the combinations in each are shown with " / " between them, and the lists with ", ". */
  keys: readonly (readonly Combo[])[];
}

export interface MapGroup {
  title: string;
  /** The single-key shortcuts, which the checkbox turns off. */
  single?: boolean;
  rows: readonly MapRow[];
}

const key = (cap: string, label: string = cap): Combo => ({ keys: [cap], label });
const DOWN = key('↓', 'Down arrow');
const UP = key('↑', 'Up arrow');
const LEFT = key('←', 'Left arrow');
const RIGHT = key('→', 'Right arrow');
const HOME = key('Home');
const END = key('End');
const ENTER = key('↵', 'Enter');
const SHIFT_ENTER: Combo = { keys: ['Shift', '↵'], label: 'Shift Enter' };
const ESCAPE = key('Esc', 'Escape');

/** The keyboard map (6.2), in the dialog's groups, with ⌘ on Apple platforms and Ctrl elsewhere. */
export function keyboardMap(command: boolean = usesCommandKey()): MapGroup[] {
  const modEnter: Combo = command ? { keys: ['⌘', '↵'], label: 'Command Enter' } : { keys: ['Ctrl', '↵'], label: 'Control Enter' };
  return [
    {
      title: 'Anywhere',
      single: true,
      rows: [
        { doc: { key: '`/`', where: 'Anywhere' }, what: 'Focus the filter field', keys: [[key('/', 'Slash')]] },
        { doc: { key: '`n`', where: 'Anywhere' }, what: 'Open the New session dialog', keys: [[key('n', 'N')]] },
        { doc: { key: '`?`', where: 'Anywhere' }, what: 'Show keyboard shortcuts', keys: [[key('?', 'Question mark')]] },
        {
          doc: { key: '`j` / `k`', where: 'Anywhere, including the conversation' },
          what: 'Next or previous session in the list, showing it if a session is open',
          keys: [[key('j', 'J'), key('k', 'K')]],
        },
        { doc: { key: '`s`', where: 'Anywhere, with a session open' }, what: 'Star or unstar the open session', keys: [[key('s', 'S')]] },
      ],
    },
    {
      title: 'Lists',
      rows: [
        {
          doc: { key: '↓ / ↑', where: 'On a session row' },
          what: 'On a session row: the next or previous row, showing that session too if one is open',
          keys: [[DOWN, UP]],
        },
        { doc: { key: 'Enter', where: 'On a session row' }, what: 'On a session row: open the session', keys: [[ENTER]] },
        {
          doc: { key: '↓ / ↑, Home / End, Enter', where: 'The repo list' },
          what: 'In the repo list: move, jump to either end, select',
          keys: [[DOWN, UP], [HOME, END], [ENTER]],
        },
        {
          doc: { key: '← / →, Home / End', where: 'The root tabs, with two or more roots' },
          what: 'In the root tabs, with several roots: move between them. Enter or Space opens one',
          keys: [[LEFT, RIGHT], [HOME, END]],
        },
      ],
    },
    {
      title: 'Session view',
      rows: [
        {
          doc: { key: '↓ / ↑', where: "In the session view's header, except in an open menu, which uses them itself" },
          what: 'In its header: the next or previous session',
          keys: [[DOWN, UP]],
        },
        {
          doc: { key: '← / →, Home / End', where: "The session view's tabs" },
          what: 'In the tabs: move between Conversation, Terminal and Sub-agents. Enter or Space opens one',
          keys: [[LEFT, RIGHT], [HOME, END]],
        },
        {
          doc: { key: '↓ / ↑, Home / End, Enter', where: 'The Sub-agents list' },
          what: "In the Sub-agents list: move, jump to either end, open one's transcript",
          keys: [[DOWN, UP], [HOME, END], [ENTER]],
        },
        {
          doc: { key: '← / →, Home / End', where: 'The divider' },
          what: 'On the divider: resize the view by 16 px, or to its minimum or maximum',
          keys: [[LEFT, RIGHT], [HOME, END]],
        },
        { doc: { key: '⌘/Ctrl + Enter', where: 'The message box' }, what: 'In the message box: send', keys: [[modEnter]] },
        { doc: { key: 'F6', where: 'The terminal' }, what: 'In the terminal: leave it, for the Terminal tab', keys: [[key('F6')]] },
        { doc: { key: 'Shift + Enter', where: 'The terminal' }, what: "In the terminal: a new line in Claude Code's prompt", keys: [[SHIFT_ENTER]] },
      ],
    },
    {
      title: 'Menus and dialogs',
      rows: [
        {
          doc: { key: '↑ / ↓, Home / End, Enter, Escape', where: 'An open menu' },
          what: 'In an open menu: move, jump to either end, choose, close',
          keys: [[UP, DOWN], [HOME, END], [ENTER], [ESCAPE]],
        },
        {
          doc: { key: '↓ / ↑, Alt + ↓, Enter, Escape', where: "A combobox, such as New session's directory" },
          what: 'In a combobox: move through its list, open it, choose, close the list',
          keys: [[DOWN, UP], [{ keys: ['Alt', '↓'], label: 'Alt Down arrow' }], [ENTER], [ESCAPE]],
        },
        { doc: { key: '⌘/Ctrl + Enter', where: 'The New session dialog' }, what: 'In the New session dialog: start the session', keys: [[modEnter]] },
        {
          doc: { key: '↑ / ↓, ← / →', where: 'A radio group, in Preferences' },
          what: 'In Preferences: choose the previous or next option, which applies at once',
          keys: [[UP, DOWN], [LEFT, RIGHT]],
        },
      ],
    },
    {
      title: 'Closing and moving',
      rows: [
        {
          doc: { key: 'Escape', where: 'Layered, nearest first' },
          what: "Close the nearest: a tooltip, a menu or list, a confirmation, a dialog, the filter's text, then the session view. Not with a draft in the message box",
          keys: [[ESCAPE]],
        },
        {
          doc: { key: 'Tab / Shift + Tab', where: 'Everywhere but the terminal' },
          what: 'Move between the header, the repo list, the session list and the session view',
          keys: [[key('Tab'), { keys: ['Shift', 'Tab'], label: 'Shift Tab' }]],
        },
      ],
    },
  ];
}

/** A row's keys: each list's combinations with " / " between them, and the lists with ", ". */
function RowKeys({ keys }: { keys: MapRow['keys'] }) {
  return (
    <dd className="shortcut-keys">
      {keys.map((alternatives, list) => (
        <span key={list} className="shortcut-alternatives">
          {alternatives.map((combo, at) => (
            <Fragment key={combo.label}>
              {at > 0 && (
                <span className="shortcut-or">
                  <span aria-hidden="true">/</span>
                  <span className="visually-hidden"> or </span>
                </span>
              )}
              <KeyCaps keys={combo.keys} label={combo.label} />
            </Fragment>
          ))}
          {list < keys.length - 1 && (
            <span className="shortcut-then">
              <span aria-hidden="true">,</span>
              <span className="visually-hidden">, </span>
            </span>
          )}
        </span>
      ))}
    </dd>
  );
}

export interface ShortcutsDialogProps {
  onClose: () => void;
  /** Whether the modifier is ⌘. Tests and the gallery pass their own; the browser's platform otherwise. */
  command?: boolean;
}

export const SHORTCUTS_HINT = "The keys under Anywhere, which are ignored while you type in a field. While they're off, the keyboard button in the header opens this dialog.";

export function ShortcutsDialog({ onClose, command }: ShortcutsDialogProps) {
  const ids = { box: useId(), hint: useId() };
  const { on, setOn } = useShortcuts();
  const groups = keyboardMap(command);
  return (
    <Dialog title="Keyboard shortcuts" size="sm" onClose={onClose} className="shortcuts-dialog">
      <div className="field shortcuts-switch">
        <span className="checkbox">
          <input id={ids.box} type="checkbox" checked={on} aria-describedby={ids.hint} onChange={(event) => setOn(event.target.checked)} />
          <label htmlFor={ids.box}>Single-key shortcuts</label>
        </span>
        <p className="field-hint" id={ids.hint}>
          {SHORTCUTS_HINT}
        </p>
      </div>
      {groups.map((group, index) => (
        <section key={group.title} className="shortcuts-group" aria-labelledby={`${ids.box}-group-${index}`}>
          <h3 className="shortcuts-group-title" id={`${ids.box}-group-${index}`}>
            {group.title}
            {group.single && !on && (
              <span className="shortcuts-off">
                <span className="visually-hidden">, </span>Off
              </span>
            )}
          </h3>
          <dl className="shortcut-list">
            {group.rows.map((row) => (
              <div key={`${row.doc.key} ${row.doc.where}`} className="shortcut">
                <dt className="shortcut-what">{row.what}</dt>
                <RowKeys keys={row.keys} />
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Dialog>
  );
}
