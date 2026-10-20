// Buttons (docs/design-system.md, 4: Buttons): outline by default, or primary, ghost or danger, at
// sm, md or lg, with an optional 16 px leading icon.
//
// - Disabled is aria-disabled="true", never the `disabled` attribute, so the button stays focusable
//   and its tooltip can say why. Activation does nothing: a click, or Enter or Space, which the
//   browser turns into a click, is ignored, and a submit button doesn't submit its form.
// - Busy: a spinner in the icon's place (or before the label), the progressive label ("Stopping…"),
//   aria-busy="true", and its idle width kept as its min-width. Activation is ignored meanwhile.

import { useCallback, useLayoutEffect, useRef, type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from './Icon.js';
import { Spinner } from './Spinner.js';

export type ButtonVariant = 'outline' | 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled' | 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A 16 px icon before the label. A spinner takes its place while busy. */
  icon?: IconName;
  /** aria-disabled: still focusable, but activating it does nothing. */
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  /** The label while busy, the -ing form with an ellipsis ("Sending…"). The idle label otherwise. */
  busyLabel?: string | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
  children: ReactNode;
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

export function Button({
  variant = 'outline',
  size = 'md',
  icon,
  disabled = false,
  busy = false,
  busyLabel,
  ref,
  type = 'button',
  className,
  style,
  onClick,
  children,
  ...rest
}: ButtonProps) {
  const own = useRef<HTMLButtonElement | null>(null);
  // The width it had when it last wasn't busy, so the busy label doesn't make it shrink. Measured
  // only for a button that can be busy, which says so with its busyLabel.
  const idleWidth = useRef(0);
  useLayoutEffect(() => {
    if (!busy && busyLabel !== undefined && own.current) idleWidth.current = own.current.getBoundingClientRect().width;
  });
  const setRefs = useCallback(
    (element: HTMLButtonElement | null) => {
      own.current = element;
      setRef(ref, element);
    },
    [ref],
  );

  const inert = disabled || busy;
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (inert) {
      // Keeps a submit button from submitting its form.
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  const classes = ['button', variant === 'outline' ? undefined : variant, size, className].filter(Boolean).join(' ');
  return (
    <button
      {...rest}
      ref={setRefs}
      type={type}
      className={classes}
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
      style={busy && idleWidth.current > 0 ? { ...style, minWidth: idleWidth.current } : style}
      onClick={click}
    >
      {busy ? <Spinner size="button" /> : icon && <Icon name={icon} />}
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  );
}
