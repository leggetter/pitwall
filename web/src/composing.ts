// Whether a key belongs to an input method (IME) that's composing text, so a component leaves it
// alone: the terminal's Shift + Enter, the combobox's keys, and a dialog's Escape (W70).

/**
 * Whether an input method is composing, so the key is the IME's: `isComposing`, or keyCode 229,
 * which Safari gives the key that ends a composition after its compositionend, with `isComposing`
 * already false.
 */
export function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
