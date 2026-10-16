// Runs before each web UI test file (vitest.config.ts, the `web` project).
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  document.title = '';
});
