// Formatting helpers for text, paths and times. All pure, so they're easy to test.

// Terminal escape sequences: CSI (colours, cursor moves), OSC (titles,
// hyperlinks) and the remaining two-character escapes.
const TERMINAL_ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g;
// C0 and C1 control characters other than tab and newline, and the bidi
// embedding, override and isolate controls, which can make text read
// differently from what it contains.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * Session text is untrusted. React already renders it as text, never markup;
 * this also drops terminal escapes and invisible control characters so they
 * show neither as garbage nor as misleading text.
 */
export function plainText(text: string): string {
  return text.replace(TERMINAL_ESCAPES, '').replace(CONTROL_CHARACTERS, '');
}

/**
 * pitwall's own sentence for something that failed (docs/design-system.md, 5: Errors): "Couldn't
 * stop the session.", with the HTTP status when the server answered, "(HTTP 502)". The server's
 * reason, when it gave one, goes after it, as text.
 */
export function couldNot(what: string, status: number | undefined): string {
  return `Couldn't ${what}${status === undefined ? '' : ` (HTTP ${status})`}.`;
}

/**
 * Shortens a home directory to `~` when the path makes it obvious: macOS
 * `/Users/<name>` and Linux `/home/<name>`. The browser can't ask for the real
 * home directory, and the contract doesn't send it.
 */
export function shortenHome(path: string): string {
  const match = /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(path);
  return match ? `~${path.slice(match[0].length)}` : path;
}

/** "12s ago", "5m ago", "3h ago", "2d ago". Future times (clock skew) read as "just now". */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "updated 7s ago": always in seconds below a minute, so the header ticks visibly. */
export function updatedAgo(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'updated at an unknown time';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `updated ${seconds}s ago`;
  return `updated ${relativeTime(iso, now)}`;
}

/** The absolute local time, with seconds, for a timestamp's tooltip. */
export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** The time of day alone, in the user's locale ("11:06"), for the conversation's speaker lines. Undefined when it isn't a time. */
export function clockTime(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Roots for display: home-shortened and comma-separated. */
export function formatRoots(roots: readonly string[]): string {
  return roots.map(shortenHome).join(', ');
}

/**
 * A path, or a list of them, cut in two for a middle ellipsis (docs/design-system.md, 5): the end,
 * from the last `/`, always shows, and the start is cut short with "…" when there isn't room. With
 * no `/` after the first character, the end is empty, so the text is only cut at its end.
 */
export function middleEllipsisParts(text: string): { start: string; end: string } {
  const slash = text.lastIndexOf('/');
  return slash > 0 ? { start: text.slice(0, slash), end: text.slice(slash) } : { start: text, end: '' };
}
