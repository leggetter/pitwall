// The one place pitwall touches node-pty, its first native dependency. The
// attach socket (attach.ts) takes a PtySpawner, so tests pass a fake and never
// run `claude`; the server uses spawnPty() below.
//
// node-pty is loaded on the first attach, not at startup. A missing or broken
// native build then fails that attach with a message, and the rest of pitwall
// (the index, the session view) keeps working.
import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** What attach.ts needs from a PTY. node-pty's IPty has all of it. */
export interface PtyProcess {
  /** Output, decoded as UTF-8. */
  onData(listener: (data: string) => void): unknown;
  /** `signal` is 0 or undefined when the process exited on its own. */
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** SIGHUP by default. */
  kill(signal?: string): void;
  /** Flow control: stop and restart reading output. */
  pause(): void;
  resume(): void;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd: string;
  /** The complete environment: nothing is inherited. */
  env: Record<string, string>;
  /** $TERM. */
  name: string;
}

/** Starts `file` with `args` in a new PTY, without a shell. Throws when it can't. */
export type PtySpawner = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

type NodePty = typeof import('node-pty');

let nodePty: NodePty | undefined;

/** The real PtySpawner, over node-pty. */
export const spawnPty: PtySpawner = (file, args, options) => {
  nodePty ??= loadNodePty();
  return nodePty.spawn(file, args, { ...options, encoding: 'utf8' });
};

function loadNodePty(): NodePty {
  const require = createRequire(import.meta.url);
  const pty = require('node-pty') as NodePty;
  makeSpawnHelperExecutable(require);
  return pty;
}

/**
 * node-pty 1.1.0's macOS prebuilds ship `spawn-helper` without its execute
 * bit (mode 0644 in the published tarball), so every spawn fails with
 * `posix_spawnp failed.` Set it, once, when it's missing. Linux builds from
 * source and doesn't use the helper. Remove this when an upgrade ships the
 * helper executable (1.2.0-beta.15 does).
 */
function makeSpawnHelperExecutable(require: NodeRequire): void {
  if (process.platform !== 'darwin') return;
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const dir of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
    const helper = join(root, dir, 'spawn-helper');
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      try {
        chmodSync(helper, 0o755);
      } catch {
        // Read-only install: the spawn then fails with node-pty's own error.
      }
    }
    return;
  }
}
