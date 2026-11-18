// Copies docs/states.md to dist/docs as part of `npm run build` (W178), for the supervisor's
// pitwall_states tool (src/server/referenceDocs.ts).
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'dist', 'docs'), { recursive: true });
cpSync(path.join(root, 'docs', 'states.md'), path.join(root, 'dist', 'docs', 'states.md'));
