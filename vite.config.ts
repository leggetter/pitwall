import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const NOTICES = fileURLToPath(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url));

/**
 * Ships the third-party licences with the files they cover: THIRD_PARTY_NOTICES.md
 * is copied into dist/web, as .txt so the server serves it as text.
 */
function thirdPartyNotices(): Plugin {
  return {
    name: 'pitwall-third-party-notices',
    buildStart() {
      this.addWatchFile(NOTICES);
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: readFileSync(NOTICES, 'utf8') });
    },
  };
}

// Builds the web UI from web/ to dist/web, where the pitwall server serves it.
// There is no Vite dev server in M1: `npm run dev` runs `vite build --watch`.
export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react(), thirdPartyNotices()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
});
