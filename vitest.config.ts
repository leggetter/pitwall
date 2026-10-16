import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is web/, so tests in src/ and web/
// are both found from the repo root.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts', 'web/**/*.test.tsx'],
  },
});
