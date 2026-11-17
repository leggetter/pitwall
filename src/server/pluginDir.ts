// The pitwall plugin's folder (W176, W197), for `--plugin-dir` on the sessions pitwall starts or resumes
// (actions.ts), so they get the plugin's hooks with no install (spike 018, finding 5).
//
// Found from this file's place in the installed package, never the working directory: the compiled
// dist/server/pluginDir.js and src/server/pluginDir.ts are both two folders below the package root,
// where plugin/ sits. It counts only when plugin/.claude-plugin/plugin.json is a regular file there, so a
// package without the plugin, or a bundle that moved this file, starts sessions without the flag.
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The plugin's folder, or undefined when it isn't beside this module's package. */
export function pluginDirOf(fromFile: string = fileURLToPath(import.meta.url)): string | undefined {
  const dir = path.resolve(path.dirname(fromFile), '..', '..', 'plugin');
  try {
    return statSync(path.join(dir, '.claude-plugin', 'plugin.json')).isFile() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The option for `claude`, one argument so it never takes the next one: `--plugin-dir=<folder>`, or none.
 * `--plugin-dir` can repeat, so another `--plugin-dir <x> <prompt>` form could swallow the prompt.
 */
export function pluginDirArgs(dir: string | undefined): string[] {
  return dir === undefined ? [] : [`--plugin-dir=${dir}`];
}
