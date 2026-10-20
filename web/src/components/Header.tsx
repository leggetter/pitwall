// The app's header (docs/design-system.md, 3): the Repos button below the sidebar breakpoint, the
// wordmark and the roots on the left; New session, the connection badge, when the list was updated
// and the theme switch on the right. At 600 px and narrower the right side wraps under the wordmark.
// The roots show home as ~, with the full paths in a tooltip; the update time ticks on the shared
// clock, with the absolute time in its tooltip.

import type { RefObject } from 'react';
import type { ConnectionState } from '../connection.js';
import { formatRoots, plainText } from '../format.js';
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
}

export function Header({ state, roots, updatedAt, onNewSession, onRepos, reposOpen = false, reposRef }: HeaderProps) {
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
          <button type="button" className="button primary md" aria-haspopup="dialog" onClick={onNewSession}>
            <Icon name="add" />
            New session
          </button>
        )}
        <ConnectionBadge state={state} />
        {updatedAt && <Timestamp className="updated" at={updatedAt} format="updated" />}
        <ThemeSwitch />
      </div>
    </header>
  );
}
