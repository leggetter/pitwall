// Links to pitwall's own address (W220). A session writes them (a spin-off link, W209, or ?session=<id>), and
// clicked inside pitwall they used to open a new tab, which has no token (W175 gives a link code only to a
// navigation no page started), so it showed the sign-in notice. Now they navigate in this tab, which has it.
//
// Own address: the same origin, and the path `/`. Only the query string is followed. A link with a fragment,
// even an empty `#`, is never followed in place: what a session prints is untrusted, a `#token=…` link must
// never reach token.ts in this tab, and the page is never reloaded. It keeps the old way, a question and a
// new tab. The navigation is a pushed history entry that the app's own popstate listeners follow, as the
// back button does (openSession.ts, selection.ts, openPr.ts, supervisor.ts, SessionView's spin-off card).

/** The part of `window` an own link uses, so tests can pass their own. */
export interface OwnLinkEnv {
  location: Pick<Location, 'origin' | 'pathname' | 'search'>;
  history: Pick<History, 'pushState' | 'state'>;
  dispatchEvent(event: Event): boolean;
}

/**
 * The query string (starting with "?", or empty) of `href` when it is a link to this page's own address, with no
 * fragment, or undefined for any other link.
 */
export function ownLinkSearch(href: string, env: Pick<OwnLinkEnv, 'location'> = window): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.origin !== env.location.origin || url.pathname !== '/') return undefined;
  // `#` alone leaves url.hash empty, so look at the text.
  if (href.includes('#')) return undefined;
  return url.search;
}

/** Whether `href` is a link to this page's own address that is followed in place. */
export function isOwnLink(href: string, env: Pick<OwnLinkEnv, 'location'> = window): boolean {
  return ownLinkSearch(href, env) !== undefined;
}

/** Pushes `search` as a history entry and tells the app to follow it, as the back button does. The page isn't reloaded. */
export function followOwnLink(search: string, env: OwnLinkEnv = window): void {
  if (search !== env.location.search) env.history.pushState(env.history.state, '', `${env.location.pathname}${search}`);
  env.dispatchEvent(new PopStateEvent('popstate', { state: env.history.state }));
}
