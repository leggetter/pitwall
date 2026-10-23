// An inline confirmation (docs/design-system.md, 4: Inline confirmation): a question, its consequence,
// then Cancel and the confirm button, for a destructive or surprising action in the session view,
// without a dialog: Stop, Remove, the restart before attaching, and a link that asks before it opens
// (Markdown.tsx, W55). Cancel takes focus when it opens. Escape inside it cancels, and goes no further,
// so the view stays open; for Stop, Remove and the restart, the view handles Escape from anywhere else,
// and whatever opened it puts focus back on itself.
//
// While the action runs, the confirm button is busy and Cancel is aria-disabled, and Escape does
// nothing: the request is already out.

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button.js';
import type { IconName } from './Icon.js';

export interface InlineConfirmProps {
  /** The title: "Stop this session?" */
  question: string;
  /** What happens, in meta text: text, and a literal value in code style, such as a link's address. Never markup from a session. */
  consequence: ReactNode;
  /** The confirm button: it repeats the question's verb and object. */
  confirmLabel: string;
  /** Its label while busy: "Stopping…". */
  busyLabel: string;
  icon?: IconName;
  variant: 'danger' | 'primary';
  /** The left bar: --pw-danger-fg, or --pw-warning-indicator for the restart. */
  tone?: 'danger' | 'warning';
  /** role="alertdialog" for the restart and a link that asks, which interrupt opening a tab or a link; role="group" otherwise. */
  role?: 'group' | 'alertdialog';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function InlineConfirm({
  question,
  consequence,
  confirmLabel,
  busyLabel,
  icon,
  variant,
  tone = 'danger',
  role = 'group',
  busy = false,
  onConfirm,
  onCancel,
}: InlineConfirmProps) {
  const questionId = useId();
  const consequenceId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // The safe choice takes focus as it opens (6.1, item 8).
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    // Handled here, so the session view behind stays open.
    event.preventDefault();
    event.stopPropagation();
    if (!busy) onCancel();
  };

  return (
    <div
      className={`inline-confirm ${tone}`}
      role={role}
      aria-labelledby={questionId}
      aria-describedby={consequenceId}
      onKeyDown={onKeyDown}
    >
      <div className="inline-confirm-text">
        <p className="inline-confirm-question" id={questionId}>
          {question}
        </p>
        <p className="inline-confirm-consequence" id={consequenceId}>
          {consequence}
        </p>
      </div>
      <div className="inline-confirm-buttons">
        <Button ref={cancelRef} size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={variant} size="sm" icon={icon} busy={busy} busyLabel={busyLabel} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
