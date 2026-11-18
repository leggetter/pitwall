// pitwall's own reference for the supervisor (W178): docs/states.md, how each state and badge is decided,
// which the pitwall_states tool serves. `npm run build` copies it to dist/docs (scripts/copy-reference.mjs),
// so a built pitwall reads the copy it was built with; run from source, it reads the checkout's. Found from
// this file's place in the package, never the working directory. Read-only, and fails soft: undefined when
// the file isn't there or isn't a regular file.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The most bytes of the reference one answer carries. */
export const REFERENCE_MAX_BYTES = 60_000;

/** The reference's path for a module at `fromFile`, or undefined. */
export function statesDocPath(fromFile: string = fileURLToPath(import.meta.url)): string | undefined {
  const here = path.dirname(fromFile);
  const built = path.basename(path.dirname(here)) === 'dist';
  const candidates = built ? [path.resolve(here, '..', 'docs', 'states.md')] : [path.resolve(here, '..', '..', 'docs', 'states.md')];
  for (const file of candidates) {
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** The reference's text, or undefined when it can't be read. */
export function readStatesDoc(file: string | undefined = statesDocPath()): string | undefined {
  if (file === undefined) return undefined;
  try {
    const text = readFileSync(file, 'utf8');
    return text.length > REFERENCE_MAX_BYTES ? text.slice(0, REFERENCE_MAX_BYTES) : text;
  } catch {
    return undefined;
  }
}
