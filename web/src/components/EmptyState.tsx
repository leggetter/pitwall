// Empty states (docs/design-system.md, 4: Empty states, and 5: Empty states): centred in their
// pane, at most 408 px wide, with a 24 px icon in --pw-text-subtle, the title, one sentence, and the
// action, on Button. No illustrations. The title says what's missing, the sentence says how things
// get here, and the action makes it happen. Everything in it is text, never markup.

import type { ReactNode, RefObject } from 'react';
import { Icon, type IconName } from './Icon.js';

export interface EmptyStateProps {
  icon: IconName;
  title: ReactNode;
  sentence?: ReactNode;
  /** The action, on Button: one, or the group the doc's table gives ("Clear filters", "Search all sessions"). */
  actions?: ReactNode;
  /**
   * The title as the region's heading, an <h2> that takes focus from script only, as the session
   * view's unlisted state has. Otherwise it's a paragraph, so the page's outline is unchanged.
   */
  heading?: { id: string; ref?: RefObject<HTMLHeadingElement | null> | undefined };
}

export function EmptyState({ icon, title, sentence, actions, heading }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={24} className="empty-state-icon" />
      {heading ? (
        <h2 className="empty-state-title" id={heading.id} ref={heading.ref} tabIndex={-1}>
          {title}
        </h2>
      ) : (
        <p className="empty-state-title">{title}</p>
      )}
      {sentence !== undefined && <p className="empty-state-sentence">{sentence}</p>}
      {actions !== undefined && <div className="empty-state-actions">{actions}</div>}
    </div>
  );
}
