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
          // The page's origin is pitwall's, so proofs bound to location.origin are shaped like real ones.
          environmentOptions: { happyDOM: { url: 'http://127.0.0.1:4517/' } },
          setupFiles: ['web/src/test/setup.ts'],
          // Stylesheets are empty in tests, except when imported as text with ?raw, as the token and font tests do.
          css: { include: [/\.css\?raw$/] },
        },
      },
    ],
  },
});
