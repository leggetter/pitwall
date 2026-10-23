// A modal dialog (docs/design-system.md, 4: Dialogs): a backdrop at --pw-z-backdrop, centring a card
// at --pw-z-dialog, 48 px from the top and 16 px from the sides. The card has a header (the title, an
// optional meta subtitle, and Close), a body that scrolls, and a footer: meta text at the left, then
// Cancel and the primary action at the right. A dialog with nothing to submit has no footer.
//
// - role="dialog", aria-modal, named by its title and described by its subtitle.
// - Focus moves to the first field on open, Tab and Shift+Tab stay inside, and focus goes back to
//   whatever had it, normally the button that opened it, when it closes, without opening that
//   button's tooltip (focusQuietly), which would take the next Escape. A radio group is one field,
//   its chosen radio, as Tab has it, so the Preferences dialog opens on its first group's choice and
//   Tab from the last group's choice goes round to the first (W59).
// - Its header and footer are plain elements, not <header> and <footer>, which outside a sectioning
//   element would be the page's banner and contentinfo landmarks.
// - Escape closes it, and goes no further, so the session view behind stays open. A click on the
//   backdrop closes it only when nothing has been typed. While its action runs (`busy`), neither does,
//   and Close is aria-disabled.

import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Icon } from './Icon.js';
import { focusQuietly, Tooltip } from './Tooltip.js';
import './Dialog.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const isRadio = (element: Element): element is HTMLInputElement => element instanceof HTMLInputElement && element.type === 'radio';

/**
 * Whether a radio is its group's Tab stop, as browsers have it: the checked one, or the first when
 * none is (W59). A group is the radios with its name in the same form, or in none.
 */
function isRadioStop(radio: HTMLInputElement, candidates: readonly HTMLElement[]): boolean {
  if (radio.name === '') return true;
  const group = candidates.filter((element): element is HTMLInputElement => isRadio(element) && element.name === radio.name && element.form === radio.form);
  return (group.find((each) => each.checked) ?? group[0]) === radio;
}

/** What Tab can reach inside `root`, in order: not disabled, not hidden, and one radio for each group. */
function tabStops(root: HTMLElement | null): HTMLElement[] {
  const candidates = [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((element) => element.tabIndex >= 0 && !element.closest('[hidden]'));
  return candidates.filter((element) => !isRadio(element) || isRadioStop(element, candidates));
}

export interface DialogProps {
  title: string;
  /** Meta text under the title, which describes the dialog. */
  subtitle?: ReactNode;
  /** --pw-dialog-sm, -md (the default) or -lg. */
  size?: 'sm' | 'md' | 'lg';
  onClose: () => void;
  /** Its action is running: Escape, Close and the backdrop do nothing. */
  busy?: boolean;
  /** Something has been typed: a click on the backdrop doesn't close it. */
  dirty?: boolean;
  /** At the footer's left, in meta text. */
  footerMeta?: ReactNode;
  /** At the footer's right: Cancel, then the primary action. A dialog with neither this nor footerMeta, such as the keyboard shortcuts dialog, has no footer. */
  actions?: ReactNode;
  /** Makes the body and footer a form, which this submits. Submitting is the caller's: it says when it's busy. */
  onSubmit?: (() => void) | undefined;
  /** Keys inside the dialog, after its own Escape and Tab handling. */
  onKeyDown?: ((event: KeyboardEvent<HTMLDivElement>) => void) | undefined;
  className?: string;
  children: ReactNode;
}

export function Dialog({ title, subtitle, size = 'md', onClose, busy = false, dirty = false, footerMeta, actions, onSubmit, onKeyDown, className, children }: DialogProps) {
  const ids = { title: useId(), subtitle: useId() };
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // A press that started on the backdrop, so a drag that ends there doesn't count as a click on it.
  const pressedBackdrop = useRef(false);

  // The first field takes focus; whatever had it before gets it back when the dialog goes.
  useEffect(() => {
    const returnTo = document.activeElement;
    (tabStops(body.current)[0] ?? tabStops(card.current)[0])?.focus();
    return () => {
      // Put back, not moved there by the user: its tooltip stays shut, so the next Escape goes on to whatever is behind.
      if (returnTo instanceof HTMLElement && returnTo.isConnected) focusQuietly(returnTo);
    };
  }, []);

  const close = () => {
    if (!busy) onClose();
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // Handled here, so the session view behind doesn't close too.
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const stops = tabStops(card.current);
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (first && last) {
        if (event.shiftKey && (document.activeElement === first || !card.current?.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !card.current?.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }
    onKeyDown?.(event);
  };

  const backdropClick = (event: MouseEvent<HTMLDivElement>) => {
    const fromBackdrop = pressedBackdrop.current;
    pressedBackdrop.current = false;
    if (event.target !== event.currentTarget || !fromBackdrop) return;
    if (!dirty) close();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit?.();
  };

  const content = (
    <>
      <div className="dialog-head">
        <div className="dialog-heading">
          <h2 className="dialog-title" id={ids.title}>
            {title}
          </h2>
          {subtitle !== undefined && (
            <p className="dialog-subtitle" id={ids.subtitle}>
              {subtitle}
            </p>
          )}
        </div>
        <Tooltip content="Close" keys={{ keys: ['Esc'], label: 'Escape' }} relation="label">
          <button
            type="button"
            className="icon-button ghost md dialog-close"
            aria-disabled={busy || undefined}
            aria-keyshortcuts="Escape"
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </Tooltip>
      </div>
      <div className="dialog-body" ref={body}>
        {children}
      </div>
      {(footerMeta !== undefined || actions !== undefined) && (
        <div className="dialog-foot">
          {footerMeta !== undefined && <p className="dialog-foot-meta">{footerMeta}</p>}
          <div className="dialog-actions">{actions}</div>
        </div>
      )}
    </>
  );

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      // Keeps focus in the dialog: a press on the backdrop would otherwise move it to the page.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
      onClick={backdropClick}
    >
      <div
        ref={card}
        className={['dialog', size, className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-describedby={subtitle !== undefined ? ids.subtitle : undefined}
        onKeyDown={keyDown}
      >
        {onSubmit ? (
          <form className="dialog-form" onSubmit={submit} noValidate>
            {content}
          </form>
        ) : (
          <div className="dialog-form">{content}</div>
        )}
      </div>
    </div>
  );
}
