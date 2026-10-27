// Runs before each web UI test file (vitest.config.ts, the `web` project).
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// No web test reaches the network. happy-dom's fetch is a real one, and the app's default fetch
// calls it: a test that renders App without a fetch of its own would otherwise send its requests to
// whatever listens on 127.0.0.1:4517, such as a pitwall that's running, as the editor list's GET
// (W72) does as soon as the page has an apiKey. So it fails, as a network error does, which the app
// takes as the request failing. A test that needs answers passes the app a fake fetch.
if (typeof window !== 'undefined') {
  const offline = () => Promise.reject(new TypeError('web tests never reach the network: pass the app a fake fetch'));
  window.fetch = offline;
  globalThis.fetch = offline;
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
