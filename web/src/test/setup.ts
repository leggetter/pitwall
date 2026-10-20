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
  // The theme store sets data-theme; each test starts without it.
  document.documentElement.removeAttribute('data-theme');
  window.history.replaceState(null, '', '/');
  document.title = '';
});
