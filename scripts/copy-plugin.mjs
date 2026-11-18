// Copies plugin/ to dist/plugin as part of `npm run build` (W197's review, F3), so the hooks the
// sessions pitwall starts load with `--plugin-dir` change only when pitwall is built again, as its
// server does, not whenever the checkout's branch or files change. src/server/pluginDir.ts prefers
// dist/plugin to plugin/ for a built pitwall. Links in plugin/ aren't copied.
import { cpSync, lstatSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'plugin');
const to = path.join(root, 'dist', 'plugin');
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, filter: (source) => !lstatSync(source).isSymbolicLink() });
