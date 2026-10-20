// Badges (docs/design-system.md, 4: Badges and Status dot): 20 px rectangles in label type, solid,
// subtle or outline. A session's status badge takes its look from pitwall's state aliases
// (tokens.css, section 4), so a state's look changes in one place; the other badges take a tone's.

import type { ReactNode } from 'react';
import { plainText } from '../format.js';
import type { BadgeLook, StatusBadge as StatusBadgeData } from '../sessions.js';
import { Spinner } from './Spinner.js';
import { Tooltip } from './Tooltip.js';

export interface BadgeProps {
  look: BadgeLook;
  /** Before the label: an 8 px status dot, or the 12 px Spinner, in the badge's text colour. Both are aria-hidden; the label says it. */
  lead?: 'dot' | 'spinner' | undefined;
  /**
   * What the badge means, in a tooltip, such as Stale's explanation. Badges aren't focusable, so it
   * opens on hover only: it explains the label, and never says something the label doesn't.
   */
  hint?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export function Badge({ look, lead, hint, className, children }: BadgeProps) {
  return (
    <Tooltip content={hint} relation="none">
      <span className={['badge', `badge-${look}`, hint !== undefined && 'has-hint', className].filter(Boolean).join(' ')}>
        <BadgeContent lead={lead}>{children}</BadgeContent>
      </span>
    </Tooltip>
  );
}

function BadgeContent({ lead, children }: { lead?: BadgeProps['lead']; children: ReactNode }) {
  return (
    <>
      {lead === 'dot' && <span className="status-dot" aria-hidden="true" />}
      {lead === 'spinner' && <Spinner />}
      {/* Its own box, so a label too long for the row ends in an ellipsis. */}
      <span className="badge-label">{children}</span>
    </>
  );
}

/** A session's status, as statusBadge() describes it. */
export function StatusBadge({ badge }: { badge: StatusBadgeData }) {
  return (
    <span className={`badge state-${badge.status}`} data-status={badge.status}>
      <BadgeContent lead={badge.dot ? 'dot' : undefined}>{plainText(badge.label)}</BadgeContent>
    </span>
  );
}
