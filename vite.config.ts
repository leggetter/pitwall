import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the web UI from web/ to dist/web, where the pitwall server serves it.
// There is no Vite dev server in M1: `npm run dev` runs `vite build --watch`.
export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
});
