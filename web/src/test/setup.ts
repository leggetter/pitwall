// Runs before each web UI test file (vitest.config.ts, the `web` project).
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // A file that runs in Node (`// @vitest-environment node`), such as the build test, has no page to reset.
  if (typeof window === 'undefined') return;
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.title = '';
});
