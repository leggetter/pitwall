// Links in the attached terminal. xterm.js 6 makes OSC 8 hyperlinks clickable.
// What a session prints is untrusted, and an OSC 8 link's visible text can
// differ from where it goes, so pitwall states its own rule rather than
// relying on xterm's default:
// - only absolute http: and https: URLs;
// - a confirmation first, showing the full URL the link really opens, as the
//   browser parsed it (so an internationalised host shows in punycode), never
//   the link's text;
// - a new tab with noopener and noreferrer, so the new page gets neither a
//   handle on this one nor a referrer.
//
// A `file:` link, and a relative target such as `src/a.ts#L12`, which Claude Code writes for a
// markdown link to a file, go to the session view's opener (W211, fileLinks.ts) when there is one;
// the server checks the path and asks about one outside your workspaces. Any other scheme is refused
// without asking. xterm.js is told to pass every scheme to the handler (allowNonHttpProtocols) only
// when there's an opener, since this handler is then the only thing deciding.
import type { ILinkHandler } from '@xterm/xterm';
import { parseFileTarget, type FileRef } from './fileLinks.js';

export interface LinkOpeners {
  /** Default window.open. */
  open?: (url: string, target: string, features: string) => unknown;
  /** Default window.confirm. */
  confirm?: (message: string) => boolean;
}

/** The question asked before opening `url`. It names the whole URL. */
export function confirmMessage(url: URL): string {
  return `Open this link in a new tab?\n\n${url.href}`;
}

/** A `file:` or relative link's file, to the opener, with no question here: the server asks when the file is outside your workspaces. */
function openFileLink(uri: string, onFile: ((ref: FileRef) => void) | undefined): boolean {
  const ref = onFile ? parseFileTarget(uri) : undefined;
  if (!ref || !onFile) return false;
  onFile(ref);
  return true;
}

/**
 * Opens `uri` in a new tab when it's an absolute http: or https: URL and the
 * user confirms. Says whether it did. Any other URI is refused without asking.
 */
export function openTerminalLink(uri: string, openers: LinkOpeners = {}, onFile?: (ref: FileRef) => void): boolean {
  const open = openers.open ?? ((url, target, features) => window.open(url, target, features));
  const confirm = openers.confirm ?? ((message) => window.confirm(message));
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return openFileLink(uri, onFile);
  }
  // file: and, parsed as a scheme, `name.ts:12`, are for the opener, which refuses any other scheme.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return openFileLink(uri, onFile);
  if (!confirm(confirmMessage(url))) return false;
  open(url.href, '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * The terminal's linkHandler. xterm.js passes it the link's URI (the OSC 8
 * target), not its visible text. allowNonHttpProtocols stays false, so
 * xterm.js doesn't offer other schemes either.
 */
export function createLinkHandler(onFile?: (ref: FileRef) => void): ILinkHandler {
  return {
    activate: (_event, uri) => {
      openTerminalLink(uri, {}, onFile);
    },
    allowNonHttpProtocols: onFile !== undefined,
  };
}

export const terminalLinkHandler: ILinkHandler = createLinkHandler();
