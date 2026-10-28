// Runs before each web UI test file (vitest.config.ts, the `web` project).
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// No web test reaches the network. happy-dom's fetch, WebSocket and XMLHttpRequest are real ones,
// and the app's defaults use the first two: a test that renders App without a fetch or a
// createSocket of its own would otherwise reach whatever listens on 127.0.0.1:4517, such as the
// user's own pitwall, as the editor list's GET (W72) does as soon as the page has an apiKey.
// - fetch fails, as a network error does, which the app takes as the request failing.
// - WebSocket and XMLHttpRequest throw as they're made, so a test that opens one fails, saying why.
// A test that needs answers passes the app a fake fetch and a createSocket; one that stubs a global
// itself (vi.stubGlobal) still can, and gets these back afterwards.
if (typeof window !== 'undefined') {
  const offline = () => Promise.reject(new TypeError('web tests never reach the network: pass the app a fake fetch'));
  const refuse = (what: string, instead: string) =>
    class {
      constructor() {
        throw new TypeError(`web tests never reach the network: ${what} refused. ${instead}`);
      }
    };
  const OfflineWebSocket = refuse('a WebSocket was', 'Pass the app a createSocket, such as fakeSockets().factory.') as unknown as typeof WebSocket;
  const OfflineXhr = refuse('an XMLHttpRequest was', 'The app never makes one; fake whatever does.') as unknown as typeof XMLHttpRequest;
  for (const target of [window, globalThis] as Array<Record<string, unknown>>) {
    target.fetch = offline;
    target.WebSocket = OfflineWebSocket;
    target.XMLHttpRequest = OfflineXhr;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // A file that runs in Node (`// @vitest-environment node`), such as the build test, has no page to reset.
  if (typeof window === 'undefined') return;
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  // As another tab clearing storage would: the page's shortcuts store reads it again, so each test starts with them on.
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
  // The theme store sets data-theme; each test starts without it.
  document.documentElement.removeAttribute('data-theme');
  window.history.replaceState(null, '', '/');
  document.title = '';
});
