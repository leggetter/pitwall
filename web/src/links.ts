// Links in the attached terminal. xterm.js 6 makes OSC 8 hyperlinks clickable.
// With no linkHandler set, it blocks the page with confirm() and then opens a
// blank window, clears its opener and navigates it to the URI. What a session
// prints is untrusted, so pitwall states its own rule rather than relying on
// that default: only absolute http: and https: URLs, opened in a new tab with
// noopener and noreferrer, so the new page gets neither a handle on this one
// nor a referrer.
import type { ILinkHandler } from '@xterm/xterm';

type Open = (url: string, target: string, features: string) => unknown;

/** Opens `uri` in a new tab when it's an absolute http: or https: URL. Says whether it did. */
export function openTerminalLink(uri: string, open: Open = (url, target, features) => window.open(url, target, features)): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  open(url.href, '_blank', 'noopener,noreferrer');
  return true;
}

/** The terminal's linkHandler. allowNonHttpProtocols stays false, so xterm.js doesn't offer other schemes either. */
export const terminalLinkHandler: ILinkHandler = {
  activate: (_event, text) => {
    openTerminalLink(text);
  },
  allowNonHttpProtocols: false,
};
