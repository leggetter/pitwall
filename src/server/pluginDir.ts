// The pitwall plugin's folder (W176, W197), for `--plugin-dir` on the sessions pitwall starts or resumes
// (actions.ts), so they get the plugin's hooks with no install (spike 018, finding 5).
//
// Found from this file's place in the installed package, never the working directory. A built pitwall,
// dist/server/pluginDir.js, uses dist/plugin, the copy `npm run build` makes (scripts/copy-plugin.mjs),
// so the hooks change only with a rebuild, as the server does (W197's review, F3). Run from source,
// src/server/pluginDir.ts, it uses plugin/ two folders up, since src/plugin holds tests, not a plugin.
// A built one never falls back to plugin/, the live checkout (M5.4's security review, H3): with no
// dist/plugin, after a bare tsc or a part-deleted dist/, its sessions start without the flag.
// A folder counts only when its .claude-plugin/plugin.json is a regular file, so a package without the
// plugin, or a bundle that moved this file, starts sessions without the flag.
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The plugin's folder, or undefined when it isn't beside this module's package. */
export function pluginDirOf(fromFile: string = fileURLToPath(import.meta.url)): string | undefined {
  const here = path.dirname(fromFile);
  const built = path.basename(path.dirname(here)) === 'dist';
  const candidates = [path.resolve(here, '..', 'plugin')];
  if (!built) candidates.push(path.resolve(here, '..', '..', 'plugin'));
  for (const dir of candidates) {
    try {
      if (statSync(path.join(dir, '.claude-plugin', 'plugin.json')).isFile()) return dir;
    } catch {
      // Not here; try the next.
    }
  }
  return undefined;
}

/**
 * The option for `claude`, one argument so it never takes the next one: `--plugin-dir=<folder>`, or none.
 * `--plugin-dir` can repeat, so another `--plugin-dir <x> <prompt>` form could swallow the prompt.
 */
export function pluginDirArgs(dir: string | undefined): string[] {
  return dir === undefined ? [] : [`--plugin-dir=${dir}`];
}
