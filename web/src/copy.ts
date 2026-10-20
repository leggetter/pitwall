// Copying to the clipboard (docs/design-system.md, 4: Copy). Call the copy inside the click or key
// handler itself: Safari refuses a write that comes later, such as after a state update. When the
// clipboard refuses, select the text on screen, so it can be copied by hand.
//
// Every copy in the web UI goes through here: useCopy() in a component, which writes to the
// clipboard that ClipboardContext gives, the browser's by default. The #uikit gallery gives its own,
// so its copy buttons show both results without touching the real clipboard.

import { createContext, useCallback, useContext } from 'react';

/** The part of the Clipboard API pitwall uses. */
export interface ClipboardLike {
  writeText: (text: string) => Promise<void>;
}

/** The clipboard to write to. Undefined is the browser's, navigator.clipboard. */
export const ClipboardContext = createContext<ClipboardLike | undefined>(undefined);

/** Writes `text` to `clipboard`, or the browser's. Resolves false when it refuses or there's none. */
export async function copyText(text: string, clipboard: ClipboardLike | undefined = navigator.clipboard): Promise<boolean> {
  try {
    if (!clipboard?.writeText) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** copyText() on the clipboard from ClipboardContext. Call what it returns inside the event handler. */
export function useCopy(): (text: string) => Promise<boolean> {
  const clipboard = useContext(ClipboardContext);
  return useCallback((text: string) => copyText(text, clipboard ?? navigator.clipboard), [clipboard]);
}

/** Selects an element's text, for copying by hand when the clipboard refuses. */
export function selectText(element: HTMLElement | null): void {
  if (!element) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The words for a copy's result (4: Copy), in the toast and, when it failed, the button's tooltip. */
export const COPIED = 'Copied';
export const COPY_FAILED = "Couldn't copy; the text is selected";
