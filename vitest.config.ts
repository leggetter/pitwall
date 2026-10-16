import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is web/, so tests in src/ and web/
// are both found from the repo root. Server tests run in Node; web UI tests run
// in happy-dom, with Testing Library cleaned up after each test.
export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'server', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: {
          name: 'web',
          include: ['web/**/*.test.tsx'],
          environment: 'happy-dom',
          setupFiles: ['web/src/test/setup.ts'],
        },
      },
    ],
  },
});
