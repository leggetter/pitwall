// Serves the built web UI from webRoot. Written out rather than using
// @hono/node-server's serveStatic so the path rules are visible in one place:
// every segment is decoded and checked, and the resolved real path, after
// symlinks, must stay inside the real webRoot.
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export type StaticResult =
  | { kind: 'file'; body: Buffer; contentType: string; isIndex: boolean }
  | { kind: 'not-found' }
  /** webRoot, or its index.html, doesn't exist yet: `vite build --watch` hasn't finished. */
  | { kind: 'building' };

/**
 * Where the server serves BUILDING_SCRIPT. Not under webRoot, which may not
 * exist yet, and outside /api/ so it needs no credential.
 */
export const BUILDING_SCRIPT_PATH = '/_pitwall/reload.js';

/**
 * Reloads the page a second later. location.reload() keeps the URL and its
 * #token fragment, so the browser the CLI opened while `vite build --watch`
 * was still running lands on the UI by itself.
 */
export const BUILDING_SCRIPT = 'setTimeout(function () { location.reload(); }, 1000);\n';

/**
 * A short page for the 503 while the UI builds. The CSP blocks inline script,
 * so it loads BUILDING_SCRIPT from this server instead.
 */
export const BUILDING_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>pitwall</title>' +
  `<script src="${BUILDING_SCRIPT_PATH}"></script></head>` +
  '<body><p>The pitwall UI is still building. This page reloads when it is ready.</p></body></html>';

const NOT_FOUND: StaticResult = { kind: 'not-found' };
const BUILDING: StaticResult = { kind: 'building' };

/**
 * Maps a URL pathname (still percent-encoded) to a file under webRoot. `/` is
 * index.html. Anything that could step outside webRoot is not found: empty,
 * `.`-prefixed (which covers `.` and `..`) or undecodable segments, and
 * segments that decode to contain `/`, `\` or NUL.
 */
export async function resolveStaticFile(webRoot: string, pathname: string): Promise<StaticResult> {
  const segments = pathname === '/' ? ['index.html'] : decodeSegments(pathname);
  if (!segments) return NOT_FOUND;
  const isIndex = segments[segments.length - 1] === 'index.html';

  let root: string;
  try {
    root = await realpath(webRoot);
  } catch (error) {
    if (isMissing(error)) return BUILDING;
    throw error;
  }

  const candidate = join(root, ...segments);
  if (!isInside(root, candidate)) return NOT_FOUND;

  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    // During `vite build --watch`, webRoot is emptied before each rebuild.
    if (isMissing(error)) return isIndex && segments.length === 1 ? BUILDING : NOT_FOUND;
    throw error;
  }
  if (!isInside(root, real)) return NOT_FOUND;

  try {
    if (!(await stat(real)).isFile()) return NOT_FOUND;
    const body = await readFile(real);
    const contentType = CONTENT_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream';
    return { kind: 'file', body, contentType, isIndex };
  } catch (error) {
    if (isMissing(error)) return NOT_FOUND;
    throw error;
  }
}

function decodeSegments(pathname: string): string[] | undefined {
  if (!pathname.startsWith('/')) return undefined;
  const segments: string[] = [];
  for (const raw of pathname.slice(1).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment === '' || segment.startsWith('.') || /[/\\\0]/.test(segment)) return undefined;
    segments.push(segment);
  }
  return segments;
}

function isInside(root: string, path: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
