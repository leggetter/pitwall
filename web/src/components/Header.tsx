// The app's header (docs/design-system.md, 3): the Repos button below the sidebar breakpoint, the
// wordmark and the roots on the left; New session, the connection badge, when the list was updated,
// the theme switch and the keyboard shortcuts button on the right. At 600 px and narrower the right
// side wraps under the wordmark. The roots show home as ~, with the full paths in a tooltip; the
// update time ticks on the shared clock, with the absolute time in its tooltip.
//
// New session's tooltip shows its shortcut, `n`, and the shortcuts button's shows `?`. While the
// single-key shortcuts are off, New session has no tooltip, since it would only repeat its label,
// and the shortcuts button still opens the dialog, so they can be turned back on.
//
// New session says its key in aria-keyshortcuts too. The shortcuts button doesn't: ARIA 1.2 wants
// the keys pressed, modifiers and all, and `?` is Shift and another key that differs by layout, so
// no value would be right everywhere. Its tooltip, and the dialog's map, say it instead.

import type { RefObject } from 'react';
import type { ConnectionState } from '../connection.js';
import { formatRoots, plainText } from '../format.js';
import { SHORTCUT_KEYS, useShortcuts } from '../shortcuts.js';
import { ConnectionBadge } from './ConnectionBadge.js';
import { Icon } from './Icon.js';
import { MiddleEllipsis } from './MiddleEllipsis.js';
import { ThemeSwitch } from './ThemeSwitch.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';

export interface HeaderProps {
  state: ConnectionState;
  /** The roots pitwall watches, once there's a snapshot. */
  roots?: readonly string[] | undefined;
  /** When the index last polled, once there's a snapshot. */
  updatedAt?: string | undefined;
  /** Opens the New session dialog. The button shows only when this is given. */
  onNewSession?: (() => void) | undefined;
  /** Opens the repo list's drawer. The Repos button shows only when this is given: below 900 px. */
  onRepos?: (() => void) | undefined;
  /** Whether the drawer is open, for the button's aria-expanded. */
  reposOpen?: boolean;
  /** The Repos button, which takes focus back when the drawer closes. */
  reposRef?: RefObject<HTMLButtonElement | null>;
  /** Opens the keyboard shortcuts dialog. The button shows only when this is given. */
  onShortcuts?: (() => void) | undefined;
}

export const SHORTCUTS_LABEL = 'Keyboard shortcuts';

export function Header({ state, roots, updatedAt, onNewSession, onRepos, reposOpen = false, reposRef, onShortcuts }: HeaderProps) {
  const shortcuts = useShortcuts();
  return (
    <header className="app-header">
      <div className="app-header-start">
        {onRepos && (
          <Tooltip content="Repos" relation="label">
            <button ref={reposRef} type="button" className="icon-button ghost md" aria-haspopup="dialog" aria-expanded={reposOpen} onClick={onRepos}>
              <Icon name="menu" />
            </button>
          </Tooltip>
        )}
        <h1 className="brand">pitwall</h1>
        {roots && (
          // The full paths, home and all; on screen, home is ~ and the list may be cut in the middle.
          <Tooltip content={plainText(roots.join(', '))} relation="none">
            <p className="roots">
              <MiddleEllipsis text={plainText(formatRoots(roots))} />
            </p>
          </Tooltip>
        )}
      </div>
      <div className="app-header-end">
        {onNewSession && (
          // Its name is its label, which the tooltip repeats only to show the shortcut.
          <Tooltip content={shortcuts.on ? 'New session' : undefined} keys={SHORTCUT_KEYS.newSession} relation="label">
            <button
              type="button"
              className="button primary md"
              aria-haspopup="dialog"
              aria-keyshortcuts={shortcuts.on ? 'n' : undefined}
              onClick={onNewSession}
            >
              <Icon name="add" />
              New session
            </button>
          </Tooltip>
        )}
        <ConnectionBadge state={state} />
        {updatedAt && <Timestamp className="updated" at={updatedAt} format="updated" />}
        <ThemeSwitch />
        {onShortcuts && (
          <Tooltip content={SHORTCUTS_LABEL} keys={SHORTCUT_KEYS.shortcuts} relation="label">
            <button
              type="button"
              className="icon-button ghost md"
              aria-haspopup="dialog"
              onClick={onShortcuts}
            >
              <Icon name="keyboard" />
            </button>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
