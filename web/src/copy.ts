// Copying to the clipboard (docs/design-system.md, 4: Copy). Call copyText() inside the click or key
// handler itself: Safari refuses a write that comes later, such as after a state update. When the
// clipboard refuses, select the text on screen, so it can be copied by hand.

/** Writes `text` to the clipboard. Resolves false when the browser refuses or has no clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
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
