// The #uikit route (W19): the design system's gallery in place of the app, in dev builds only.
// App.tsx renders this only when the build includes the gallery, so npm run build leaves this
// module out along with the gallery it loads.

import { Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';

/** `#uikit`, or `#uikit/<section>` for a link to one section. Anything else is the app's. */
export function isUikitHash(hash: string): boolean {
  return /^#uikit(?:\/|$)/.test(hash);
}

/** The parts of `window` the route reads, so tests can pass their own. */
export type RouteEnv = Pick<Window, 'location' | 'addEventListener' | 'removeEventListener'>;

/** Whether the address bar is on the gallery. Follows fragment navigations, such as the back button. */
export function useUikitRoute(env: RouteEnv = window): boolean {
  const [onGallery, setOnGallery] = useState(() => isUikitHash(env.location.hash));
  useEffect(() => {
    const update = () => setOnGallery(isUikitHash(env.location.hash));
    update();
    env.addEventListener('hashchange', update);
    return () => env.removeEventListener('hashchange', update);
  }, [env]);
  return onGallery;
}

export interface UikitRouteProps {
  /** The gallery, lazily imported. */
  gallery: ComponentType;
  /** The app, shown everywhere but #uikit. Unmounted while the gallery shows, so its connection closes. */
  children: ReactNode;
}

export function UikitRoute({ gallery: Gallery, children }: UikitRouteProps) {
  if (!useUikitRoute()) return children;
  return (
    <Suspense fallback={<p className="placeholder">Loading the UI kit…</p>}>
      <Gallery />
    </Suspense>
  );
}
