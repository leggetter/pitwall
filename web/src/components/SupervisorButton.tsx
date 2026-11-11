// The header's Supervisor button (W182; docs/design-system.md, 3: Header, and 4: Supervisor): the
// header's most important control, last on its right, above the panel it opens from the right (W177).
// It took the place of the repo list's Supervisor item (W114), whose state it carries.
//
// - An outline md button with the `supervisor` icon and "Supervisor", where Usage, the theme switch,
//   Preferences and the shortcuts are ghost icon buttons: a label and an edge are what give it more
//   weight than them. Outline, not primary, as New session is: an always-there button in the
//   accent's blue was too much (Phil, 2026-11-02).
// - Its status, a badge after its name while it works, starts, is held or has failed, as the item had
//   it; nothing for idle or off. Then its drafts that wait on you, a solid count, as Needs you's is.
//   Both are in its name too, "Supervisor, working, 2 drafts need you", never the colour alone.
// - A disclosure toggle: `aria-expanded`, with the selected look while the panel is open, and
//   `aria-controls` then. Below 1,200 px, where the panel is a dialog over the page, `aria-haspopup=
//   "dialog"` too, as the Repos button has; from 1,200 px the panel is a column beside the others, a
//   complementary landmark, not a dialog, so it has none (W187). Pressed again, it closes it, and
//   focus stays on it.
// - Below 1,000 px its label is visually hidden, so its name stays "Supervisor" and its tooltip says
//   it; the icon, the edge and the badges stay. At 600 px and narrower it's on the header's top line,
//   at its right (styles.css).

import type { Ref } from 'react';
import type { SupervisorStatus } from '../../../src/shared/protocol.js';
import { itemStatusText, STATUS_LABELS, STATUS_LOOKS, SUPERVISOR_NAME, SUPERVISOR_VIEW_ID } from '../supervisor.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { Tooltip } from './Tooltip.js';

export interface HeaderSupervisor {
  status: SupervisorStatus;
  /** How many of its drafts wait on you. */
  approvals: number;
  /** Whether its panel is open. */
  open: boolean;
  /** Whether its panel is a dialog over the page, below 1,200 px, rather than a column beside the others (W187). */
  dialog?: boolean;
  /** Opens its panel, or closes it while it's open. */
  onToggle: () => void;
  /** The button, which takes focus back when the panel closes. */
  ref?: Ref<HTMLButtonElement> | undefined;
}

export interface SupervisorButtonProps extends HeaderSupervisor {
  /** Below 1,000 px: the label is hidden (supervisor.css), and the tooltip says it. */
  narrow?: boolean;
}

export function SupervisorButton({ status, approvals, open, dialog = true, onToggle, ref, narrow = false }: SupervisorButtonProps) {
  const statusText = itemStatusText(status);
  const look = STATUS_LOOKS[status];
  return (
    // Its name is its text; the tooltip, only where the label is hidden, adds nothing to it.
    <Tooltip content={narrow ? SUPERVISOR_NAME : undefined} relation="none">
      <Button
        ref={ref}
        icon="supervisor"
        className="supervisor-button"
        aria-haspopup={dialog ? 'dialog' : undefined}
        aria-expanded={open}
        aria-controls={open ? SUPERVISOR_VIEW_ID : undefined}
        data-supervisor-button={status}
        onClick={onToggle}
      >
        <span className="supervisor-button-label">{SUPERVISOR_NAME}</span>
        {statusText !== undefined && (
          <>
            {/* Its words are the visible badge's, said once, from here. */}
            <span className="visually-hidden">, {statusText}</span>
            <span className="supervisor-button-status" aria-hidden="true">
              <Badge look={look.look} lead={look.lead === 'spinner' ? 'dot' : look.lead}>
                {STATUS_LABELS[status]}
              </Badge>
            </span>
          </>
        )}
        {approvals > 0 && (
          <>
            <span className="visually-hidden">, </span>
            <span className="badge badge-attention supervisor-button-drafts">
              {approvals}
              <span className="visually-hidden">{approvals === 1 ? ' draft needs you' : ' drafts need you'}</span>
            </span>
          </>
        )}
      </Button>
    </Tooltip>
  );
}
