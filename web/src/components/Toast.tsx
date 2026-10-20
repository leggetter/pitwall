// Toasts (docs/design-system.md, 4: Toasts, and 2.13): results you asked for but aren't looking at,
// such as "Copied", "Stopped. Its conversation is kept." and "Removed name". A stack at the bottom
// right, newest at the bottom, three at most, the oldest going first.
//
// - The stack is an aria-live="polite" region that's always in the DOM, from before the first toast,
//   so a toast's text is announced as it arrives. An error toast is role="alert" too.
// - Success and info toasts go after --pw-toast-timeout. The time stops while the pointer is over the
//   stack or focus is inside it, and starts again from where it was. Error toasts stay until dismissed.
// - The same message again replaces the toast that says it, so it's announced again without stacking.
// - Text only, never markup (6.1, 16). Form errors, the relay's results and anything that needs a
//   decision stay inline instead.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { cssTime, TOAST_TIMEOUT_MS } from '../timing.js';
import { Icon, type IconName } from './Icon.js';
import { focusQuietly, Tooltip } from './Tooltip.js';
import './Toast.css';

export type ToastTone = 'success' | 'info' | 'error';

export interface ToastInput {
  tone?: ToastTone;
  /** Plain text. */
  message: string;
}

export interface ToastData {
  id: number;
  tone: ToastTone;
  message: string;
  /** Going: it fades out, then it's removed. */
  leaving?: boolean;
}

/** Shows a toast. Outside a ToastProvider, nothing shows. */
export type ShowToast = (toast: ToastInput) => void;

/** What useToast() returns. The Dashboard provides it, with the stack inside the app. */
export const ToastContext = createContext<ShowToast>(() => {});

/** The function that shows a toast, from the nearest provider. */
export function useToast(): ShowToast {
  return useContext(ToastContext);
}

/** At most this many at once: the oldest goes first. */
export const MAX_TOASTS = 3;

const ICONS: Record<ToastTone, IconName> = { success: 'success', info: 'info', error: 'error' };

let nextId = 0;

/**
 * The toasts' state: `show` for ToastContext, and the props for the ToastRegion that renders them.
 * For a component that both shows toasts and places the stack, as the Dashboard does inside the app.
 */
export function useToastStack(): { show: ShowToast; region: Pick<ToastRegionProps, 'toasts' | 'onDismiss' | 'onGone'> } {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const show = useCallback<ShowToast>(({ tone = 'success', message }) => {
    const toast: ToastData = { id: (nextId += 1), tone, message };
    setToasts((list) => {
      const others = list.filter((shown) => shown.message !== message || shown.tone !== tone);
      const live = others.filter((shown) => !shown.leaving);
      // The oldest goes first: at once, so the stack never has more than three.
      const over = live.length + 1 - MAX_TOASTS;
      const dropped = new Set(over > 0 ? live.slice(0, over).map((shown) => shown.id) : []);
      return [...others.filter((shown) => !dropped.has(shown.id)), toast];
    });
  }, []);

  const leave = useCallback((id: number) => {
    setToasts((list) => list.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
  }, []);
  const remove = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  return { show, region: { toasts, onDismiss: leave, onGone: remove } };
}

export interface ToastProviderProps {
  /** Where focus goes when a toast that had it is dismissed and no toast is left to take it. */
  onFocusLost?: (() => void) | undefined;
  children: ReactNode;
}

/** Gives everything inside it useToast(), and renders the stack after it. */
export function ToastProvider({ onFocusLost, children }: ToastProviderProps) {
  const { show, region } = useToastStack();
  return (
    <ToastContext.Provider value={show}>
      {children}
      <ToastRegion {...region} onFocusLost={onFocusLost} />
    </ToastContext.Provider>
  );
}

export interface ToastRegionProps {
  toasts: readonly ToastData[];
  /** Dismiss, or its time ran out: it starts to go. */
  onDismiss: (id: number) => void;
  /** It has faded out. */
  onGone: (id: number) => void;
  onFocusLost?: (() => void) | undefined;
}

/** The live region and its toasts. Always rendered, even with no toasts, so it's there before the first one. */
export function ToastRegion({ toasts, onDismiss, onGone, onFocusLost }: ToastRegionProps) {
  const region = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  // Dismiss takes its button away: focus goes to the next toast's Dismiss, or the one before, or out of the stack.
  const dismiss = (id: number) => {
    const buttons = [...(region.current?.querySelectorAll<HTMLButtonElement>('.toast:not(.leaving) .toast-dismiss') ?? [])];
    const at = buttons.findIndex((button) => button.closest('.toast')?.getAttribute('data-toast') === String(id));
    const hadFocus = at >= 0 && region.current?.contains(document.activeElement);
    onDismiss(id);
    if (!hadFocus) return;
    const next = buttons[at + 1] ?? buttons[at - 1];
    if (next) focusQuietly(next);
    else {
      setFocused(false);
      onFocusLost?.();
    }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocused(false);
  };

  return (
    <div
      ref={region}
      className="toasts"
      aria-live="polite"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} paused={paused} onDismiss={() => dismiss(toast.id)} onTimeout={() => onDismiss(toast.id)} onGone={() => onGone(toast.id)} />
      ))}
    </div>
  );
}

interface ToastCardProps {
  toast: ToastData;
  paused: boolean;
  onDismiss: () => void;
  onTimeout: () => void;
  onGone: () => void;
}

function ToastCard({ toast, paused, onDismiss, onTimeout, onGone }: ToastCardProps) {
  const card = useRef<HTMLDivElement>(null);
  // What's left of its time, kept across pauses.
  const remaining = useRef<number | undefined>(undefined);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  const { tone, leaving = false } = toast;

  useEffect(() => {
    if (tone === 'error' || leaving || paused) return;
    remaining.current ??= cssTime(card.current, '--pw-toast-timeout', TOAST_TIMEOUT_MS);
    const started = Date.now();
    const timer = setTimeout(() => onTimeoutRef.current(), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, (remaining.current ?? 0) - (Date.now() - started));
    };
  }, [tone, leaving, paused]);

  // Going: removed when its fade ends, or after the fade's time if no animation runs.
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => onGoneRef.current(), cssTime(card.current, '--pw-duration-base', 0) + 50);
    return () => clearTimeout(timer);
  }, [leaving]);

  return (
    <div
      ref={card}
      className={leaving ? `toast ${tone} leaving` : `toast ${tone}`}
      data-toast={toast.id}
      role={tone === 'error' ? 'alert' : undefined}
      onAnimationEnd={(event) => {
        if (leaving && event.target === event.currentTarget) onGoneRef.current();
      }}
    >
      <span className="toast-tile">
        <Icon name={ICONS[tone]} />
      </span>
      <p className="toast-message">{toast.message}</p>
      <Tooltip content="Dismiss" relation="label">
        <button type="button" className="icon-button ghost sm toast-dismiss" onClick={onDismiss}>
          <Icon name="close" />
        </button>
      </Tooltip>
    </div>
  );
}
