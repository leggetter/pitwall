// The repo list as a drawer, below the sidebar breakpoint (docs/design-system.md, 3: Repo list): it
// slides in from the left over a backdrop, and it's modal, like a dialog. Escape or a click on the
// backdrop closes it; the Dashboard puts focus back on the header's Repos button.

import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface RepoDrawerProps {
  /** Closed with Escape or the backdrop. */
  onClose: () => void;
  /** The repo list. */
  children: ReactNode;
}

export function RepoDrawer({ onClose, children }: RepoDrawerProps) {
  const drawer = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // Handled here, so the session view behind doesn't close too.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !drawer.current) return;
    // Keep Tab inside the drawer. The repo list is one Tab stop, so this usually keeps focus where it is;
    // the Hidden section's toggle, links and Unhide buttons are stops of their own, except while it's closed.
    const stops = [...drawer.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter(
      (element) => element.tabIndex >= 0 && !element.closest('[hidden]'),
    );
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div className="repo-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={drawer} className="repo-drawer" role="dialog" aria-modal="true" aria-label="Repos" onKeyDown={onKeyDown}>
        {children}
      </div>
    </>
  );
}
