// Tooltips (docs/design-system.md, 4: Tooltips, and 2.13): a small card of plain text, with key caps
// for a shortcut, 6 px above its trigger, or below it when there's no room above. One trigger, the
// single child, which takes the tooltip's handlers and ARIA; its own handlers still run first.
//
// - Opens on hover after --pw-delay-tooltip, or at once when another tooltip is open or has just
//   closed, so moving along a row of icon buttons doesn't wait each time. Opens at once on keyboard
//   focus (:focus-visible), never on a click's focus, nor when focus is put back on its trigger as
//   something closes (focusQuietly).
// - Closes at once on pointer leave, blur, a press on the trigger, or Escape. It stays while the
//   pointer is over the tooltip itself (WCAG 1.4.13): the card's hit area reaches back over the gap.
// - Escape is the nearest layer (6.2): it closes the tooltip and goes no further, so the view behind
//   stays open. Not inside a menu, whose Escape closes the menu and its tooltips together, and never
//   inside the terminal, which gets every key.
// - It's rendered into document.body, fixed to the window, so no scrolling pane, overflow or
//   stacking context of the page cuts it off, at --pw-z-tooltip. Text only, never markup (6.1, 16).
//
// How the trigger relates to it (6.1, item 5):
// - `label`, for an icon-only control: the trigger's aria-label is the tooltip's text, so its name
//   and its tooltip match. The tooltip is hidden from assistive technology, which has the name.
// - `description`: the trigger's aria-describedby points at the tooltip, which is always in the
//   DOM, hidden while closed, so the description is there before the tooltip shows.
// - `none`: for an element that's never focusable, whose tooltip repeats what's in the DOM or adds
//   to it, such as a title cut short. It opens on hover only, so it's never the only route to
//   something that matters (6.1, item 13).

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { cssTime, TOOLTIP_DELAY_MS } from '../timing.js';
import { KeyCaps } from './KeyCaps.js';
import './Tooltip.css';

export type TooltipRelation = 'label' | 'description' | 'none';

/** The props a tooltip gives its trigger. Its own are called first. */
interface TriggerProps {
  ref?: Ref<HTMLElement> | undefined;
  onPointerEnter?: ((event: PointerEvent<HTMLElement>) => void) | undefined;
  onPointerLeave?: ((event: PointerEvent<HTMLElement>) => void) | undefined;
  onPointerDown?: ((event: PointerEvent<HTMLElement>) => void) | undefined;
  onClick?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  onFocus?: ((event: FocusEvent<HTMLElement>) => void) | undefined;
  onBlur?: ((event: FocusEvent<HTMLElement>) => void) | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
}

export interface TooltipProps {
  /** The tooltip's text, as plain text. Undefined renders the trigger alone, with no tooltip. */
  content: string | undefined;
  /** Key caps after the text, such as Esc on Close. */
  keys?: { keys: readonly string[]; label: string } | undefined;
  /** How the trigger relates to it: see the top of this file. */
  relation?: TooltipRelation;
  /** Only when text in the trigger is cut short on screen: for a tooltip that repeats it. */
  onlyIfCut?: boolean;
  /** A click shows it and another hides it, as on an info icon: touch screens can't hover. */
  toggle?: boolean;
  children: ReactElement<TriggerProps>;
}

/** The gap between the trigger and the card, and the least room left at the window's edges, in px. */
const GAP = 6;
const MARGIN = 8;

// Shared by every tooltip: whether one is showing, or one has just closed, so the next opens at once.
let showing = 0;
let lastClosed = Number.NEGATIVE_INFINITY;

function warm(delay: number): boolean {
  return showing > 0 || performance.now() - lastClosed < delay;
}

// The element focusQuietly() is focusing, whose tooltip doesn't open for it.
let quiet: Element | null = null;

/**
 * Puts focus on `element` without opening its tooltip: for focus put back where it was when a menu,
 * a confirmation, the drawer or a toast closes. The user didn't move focus there, so a tooltip popping
 * up would only be one more thing for the next Escape to close.
 */
export function focusQuietly(element: HTMLElement | null | undefined): void {
  if (!element) return;
  quiet = element;
  try {
    element.focus();
  } finally {
    quiet = null;
  }
}

/** Whether focus came from the keyboard. Where the browser can't say, it did. */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Whether any text in `element` is cut short on screen: an element that clips its overflow, with more
 * content than room. Text that's only for screen readers (.visually-hidden) doesn't count.
 */
export function isCut(element: Element | null): boolean {
  if (!element) return false;
  return [element, ...element.querySelectorAll('*')].some(
    (node) =>
      node instanceof HTMLElement &&
      !node.closest('.visually-hidden') &&
      node.scrollWidth > node.clientWidth + 1 &&
      getComputedStyle(node).overflowX !== 'visible',
  );
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

export function Tooltip({ content, keys, relation = 'description', onlyIfCut = false, toggle = false, children }: TooltipProps) {
  const id = useId();
  const trigger = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  const delayTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Where the pointer is: over the trigger, over the tooltip, or neither.
  const pointer = useRef<'trigger' | 'tooltip' | undefined>(undefined);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = content !== undefined && (hovered || focused || pinned) && !dismissed;

  const childProps = children.props;
  const childRef = childProps.ref;
  const setTrigger = useCallback(
    (element: HTMLElement | null) => {
      trigger.current = element;
      setRef(childRef, element);
    },
    [childRef],
  );

  // Dismissed lasts until the pointer and focus have both left, and new content shows at once.
  useEffect(() => {
    if (!hovered && !focused && !pinned) setDismissed(false);
  }, [hovered, focused, pinned]);
  useEffect(() => {
    setDismissed(false);
  }, [content]);

  useEffect(() => () => clearTimeout(delayTimer.current), []);

  // Counted while showing, for the next tooltip's delay.
  useEffect(() => {
    if (!open) return;
    showing += 1;
    return () => {
      showing -= 1;
      lastClosed = performance.now();
    };
  }, [open]);

  /** Above the trigger, centred on it, or below it when there's no room above; never past the window's edges. */
  const place = useCallback(() => {
    const anchor = trigger.current;
    const card = tip.current;
    if (!anchor || !card) return;
    const box = anchor.getBoundingClientRect();
    // Measured at the window's corner, so where it sat last doesn't narrow it.
    card.style.top = '0px';
    card.style.left = '0px';
    const { width, height } = card.getBoundingClientRect();
    const roomAbove = box.top - GAP - height >= MARGIN;
    const roomBelow = box.bottom + GAP + height <= window.innerHeight - MARGIN;
    const above = roomAbove || !roomBelow;
    const top = above ? box.top - GAP - height : box.bottom + GAP;
    const left = Math.min(Math.max(box.left + box.width / 2 - width / 2, MARGIN), Math.max(MARGIN, window.innerWidth - MARGIN - width));
    card.style.top = `${Math.round(top)}px`;
    card.style.left = `${Math.round(left)}px`;
    card.dataset.side = above ? 'top' : 'bottom';
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, content, place]);

  // While open: follow the trigger as anything scrolls or the window resizes, and close on Escape.
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target instanceof Element ? event.target : null;
      // The terminal gets every key; a menu closes, and its tooltips with it.
      if (target?.closest('.xterm') || trigger.current?.closest('[role="menu"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      setPinned(false);
    };
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, place]);

  // Pinned by a click: a press anywhere else unpins it.
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && (trigger.current?.contains(event.target) || tip.current?.contains(event.target))) return;
      setPinned(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [pinned]);

  if (content === undefined) return children;

  const showOnHover = () => {
    if (pointer.current === undefined) return;
    if (onlyIfCut && !isCut(trigger.current)) return;
    setHovered(true);
  };

  const enter = (event: PointerEvent<HTMLElement>) => {
    childProps.onPointerEnter?.(event);
    // Touch screens can't hover: a tap is a press, not a hover.
    if (event.pointerType === 'touch') return;
    pointer.current = 'trigger';
    clearTimeout(delayTimer.current);
    const delay = cssTime(trigger.current, '--pw-delay-tooltip', TOOLTIP_DELAY_MS);
    if (warm(delay)) showOnHover();
    else delayTimer.current = setTimeout(showOnHover, delay);
  };

  /** The pointer left the trigger or the tooltip: it stays open only if it went to the other. */
  const leave = (event: PointerEvent<HTMLElement>, from: 'trigger' | 'tooltip') => {
    const to = event.relatedTarget;
    const other = from === 'trigger' ? tip.current : trigger.current;
    if (to instanceof Node && other?.contains(to)) {
      pointer.current = from === 'trigger' ? 'tooltip' : 'trigger';
      return;
    }
    pointer.current = undefined;
    clearTimeout(delayTimer.current);
    setHovered(false);
  };

  const triggerProps: TriggerProps = {
    ref: setTrigger,
    onPointerEnter: enter,
    onPointerLeave: (event) => {
      childProps.onPointerLeave?.(event);
      leave(event, 'trigger');
    },
    onPointerDown: (event) => {
      childProps.onPointerDown?.(event);
      // A press is for the control, not its tooltip; a toggle's click decides instead.
      if (!toggle) {
        clearTimeout(delayTimer.current);
        setDismissed(true);
      }
    },
    onClick: (event) => {
      childProps.onClick?.(event);
      if (!toggle) return;
      // Shows it until a press elsewhere, blur or Escape; a second click hides it.
      if (pinned) {
        setPinned(false);
        setDismissed(true);
      } else {
        setPinned(true);
        setDismissed(false);
      }
    },
    onFocus: (event) => {
      childProps.onFocus?.(event);
      // Only the trigger's own focus: not a control inside it, such as a row's name in its heading.
      if (event.target !== event.currentTarget || quiet === event.currentTarget || !focusVisible(event.currentTarget)) return;
      if (onlyIfCut && !isCut(event.currentTarget)) return;
      setFocused(true);
    },
    onBlur: (event) => {
      childProps.onBlur?.(event);
      if (event.target !== event.currentTarget) return;
      setFocused(false);
      setPinned(false);
    },
  };
  if (relation === 'label') triggerProps['aria-label'] = content;
  if (relation === 'description') triggerProps['aria-describedby'] = [childProps['aria-describedby'], id].filter(Boolean).join(' ');

  // A description is always in the DOM, so it's there before the tooltip shows; the others only while open.
  const rendered = open || relation === 'description';
  return (
    <>
      {cloneElement(children, triggerProps)}
      {rendered &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className="tooltip"
            hidden={!open}
            aria-hidden={relation === 'description' ? undefined : true}
            onPointerEnter={() => {
              pointer.current = 'tooltip';
            }}
            onPointerLeave={(event) => leave(event, 'tooltip')}
            // Not a click on whatever the trigger sits in, such as a row: React passes a portal's events up its tree.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <span className="tooltip-text">{content}</span>
            {keys && <KeyCaps keys={keys.keys} label={keys.label} />}
          </div>,
          document.body,
        )}
    </>
  );
}
