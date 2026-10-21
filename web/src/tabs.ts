// Tabs (docs/design-system.md, 4: Tabs): the keys of a tablist, which the session view's Conversation
// and Terminal tabs and the header's root tabs share. The tablist is one Tab stop, the open tab's
// (roving tabindex). ← and → move focus to the previous and next tab, wrapping at the ends, and Home
// and End to the first and last. Moving focus never opens a tab: Enter or Space does, as the tab's
// own click, because opening Terminal attaches, and opening a root tab changes all three columns and
// adds a history entry, neither of which an arrow key should do.

import type { KeyboardEvent } from 'react';

/** Moves focus along `tabs` for an arrow, Home or End pressed on one of them. Keys with a modifier are left alone, so Alt + ← still goes back. */
export function moveTabFocus(event: KeyboardEvent<HTMLElement>, tabs: readonly (HTMLElement | null | undefined)[]): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const list = tabs.filter((tab): tab is HTMLElement => tab instanceof HTMLElement);
  const at = list.findIndex((tab) => tab === document.activeElement);
  if (at < 0 || list.length === 0) return;
  const last = list.length - 1;
  const to = { ArrowRight: at === last ? 0 : at + 1, ArrowLeft: at === 0 ? last : at - 1, Home: 0, End: last }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  list[to]?.focus();
}
