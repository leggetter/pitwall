// The app's header (docs/design-system.md, 3): the Repos button below the sidebar breakpoint, the
// wordmark and the roots on the left; New session, the connection badge, when the list was updated
// and the theme switch on the right. At 600 px and narrower the right side wraps under the wordmark.

import type { RefObject } from 'react';
import type { ConnectionState } from '../connection.js';
import { formatRoots, plainText, updatedAgo } from '../format.js';
import { ConnectionBadge } from './ConnectionBadge.js';
import { Icon } from './Icon.js';
import { MiddleEllipsis } from './MiddleEllipsis.js';
import { ThemeSwitch } from './ThemeSwitch.js';

export interface HeaderProps {
  state: ConnectionState;
  /** The roots pitwall watches, once there's a snapshot. */
  roots?: readonly string[] | undefined;
  /** When the index last polled, once there's a snapshot. */
  updatedAt?: string | undefined;
  now: number;
  /** Opens the New session dialog. The button shows only when this is given. */
  onNewSession?: (() => void) | undefined;
  /** Opens the repo list's drawer. The Repos button shows only when this is given: below 900 px. */
  onRepos?: (() => void) | undefined;
  /** Whether the drawer is open, for the button's aria-expanded. */
  reposOpen?: boolean;
  /** The Repos button, which takes focus back when the drawer closes. */
  reposRef?: RefObject<HTMLButtonElement | null>;
}

export function Header({ state, roots, updatedAt, now, onNewSession, onRepos, reposOpen = false, reposRef }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header-start">
        {onRepos && (
          <button
            ref={reposRef}
            type="button"
            className="icon-button ghost md"
            aria-label="Repos"
            aria-haspopup="dialog"
            aria-expanded={reposOpen}
            // Until the design system's tooltips exist (W25), the browser's shows the same name.
            title="Repos"
            onClick={onRepos}
          >
            <Icon name="menu" />
          </button>
        )}
        <h1 className="brand">pitwall</h1>
        {roots && (
          // Until the design system's tooltips exist (W25), the browser's shows the full list.
          <p className="roots" title={roots.join(', ')}>
            <MiddleEllipsis text={plainText(formatRoots(roots))} />
          </p>
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
        {updatedAt && (
          <time className="updated" dateTime={updatedAt}>
            {updatedAgo(updatedAt, now)}
          </time>
        )}
        <ThemeSwitch />
      </div>
    </header>
  );
}
