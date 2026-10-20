// Toasts in tests (Toast.tsx): the stack's live region and what it says.

/** The toasts' stack: the polite live region that's always in the DOM. */
export function toastRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>('.toasts');
  if (!region) throw new Error('no toast region');
  return region;
}

/** The messages of the toasts showing, oldest first, without those on their way out. */
export function toastMessages(): string[] {
  return [...toastRegion().querySelectorAll('.toast:not(.leaving) .toast-message')].map((message) => message.textContent ?? '');
}

/** The toast that says `message`. */
export function toastSaying(message: string): HTMLElement {
  const found = [...toastRegion().querySelectorAll<HTMLElement>('.toast')].find((toast) => toast.querySelector('.toast-message')?.textContent === message);
  if (!found) throw new Error(`no toast says "${message}"; showing: ${JSON.stringify(toastMessages())}`);
  return found;
}
