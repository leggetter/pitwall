// The pitwall side of the supervisor's recipient gate (M5, W115): the 0700 folder it shares with its
// hook (supervisorGateHook.mjs, which has the rules), the hooks for the supervisor's --settings, the
// ready marker, and the list of sessions it may message, which pitwall rewrites as its list changes.
//
// The gate only denies. Approvals (approvals.ts, src/server/supervisorActions.ts) are where you
// decide; the gate refuses, before any card, a SendMessage pitwall would never send.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLaunchDir } from '../server/launch.js';
import { readyPath, recipientsPath, RECIPIENTS_VERSION } from './supervisorGateHook.mjs';

/** The gate's folder, in the supervisor's. */
export const SUPERVISOR_GATE_DIR_NAME = 'gate';

/** How long the hook may take before Claude Code gives up on it, and blocks the call. */
const HOOK_TIMEOUT_SECONDS = 10;

/** Names the gate and its hook give files: the only ones forget() and the sweep remove. */
const GATE_FILE = /^[0-9a-f]{32}\.(?:ready|recipients|recipients\.tmp-[0-9a-f]+)$/;

/** Files older than this are from an earlier run, and are removed at the next start. */
const STALE_MS = 24 * 60 * 60 * 1000;

export interface SupervisorGate {
  /** Creates the folder if needed and checks it's safe. Throws when it isn't. Removes an earlier run's files. */
  prepare(): void;
  /** A new id, for one supervisor process. */
  newId(): string;
  /** The `hooks` for the supervisor's --settings, for gate `id`. */
  hooks(id: string): Record<string, unknown>;
  /** Whether its SessionStart hook ran, so its hooks loaded. */
  isReady(id: string): boolean;
  /** Writes the names gate `id` lets through to approval, replacing the list before. Throws when it can't. */
  setRecipients(id: string, names: readonly string[]): void;
  /** Removes gate `id`'s files, once its process has gone. */
  forget(id: string): void;
}

export interface SupervisorGateOptions {
  /** `$PITWALL_HOME/supervisor/gate`. */
  dir: string;
  /** Default process.execPath. */
  node?: string;
  /** Default supervisorGateHook.mjs next to this file: in src/ under tsx, in dist/ once built. */
  script?: string;
  /** Creates the folder if needed and checks it's 0700 and the user's own. Default: the launch folder's check. */
  ensureDir?: (dir: string) => void;
}

/** The hook script, next to this module. */
export function supervisorGateScriptPath(): string {
  return fileURLToPath(new URL('./supervisorGateHook.mjs', import.meta.url));
}

/**
 * The hooks: PreToolUse on SendMessage, which can only deny, with `onFailure: "block"` so a hook that
 * can't run blocks the call; and SessionStart, which marks the gate ready. Exec form (`args`), so no
 * shell parses the paths.
 */
export function supervisorGateHooks(options: { node: string; script: string; dir: string; id: string }): Record<string, unknown> {
  const hook = (extra: Record<string, unknown>) => ({
    type: 'command',
    command: options.node,
    args: [options.script, options.dir, options.id],
    timeout: HOOK_TIMEOUT_SECONDS,
    ...extra,
  });
  return {
    SessionStart: [{ hooks: [hook({})] }],
    PreToolUse: [{ matcher: 'SendMessage', hooks: [hook({ onFailure: 'block' })] }],
  };
}

export function createSupervisorGate(options: SupervisorGateOptions): SupervisorGate {
  const dir = path.resolve(options.dir);
  const node = options.node ?? process.execPath;
  const script = options.script ?? supervisorGateScriptPath();
  const ensureDir =
    options.ensureDir ??
    ((d: string) => {
      ensureLaunchDir(path.dirname(d));
      ensureLaunchDir(d);
    });
  const unlink = (file: string) => {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  };

  return {
    prepare() {
      ensureDir(dir);
      removeStaleFiles(dir);
    },
    newId: () => randomBytes(16).toString('hex'),
    hooks: (id) => supervisorGateHooks({ node, script, dir, id }),
    isReady: (id) => existsSync(readyPath(dir, id)),
    setRecipients(id, names) {
      const body = `${JSON.stringify({ v: RECIPIENTS_VERSION, names: [...names] })}\n`;
      const temporary = `${recipientsPath(dir, id)}.tmp-${randomBytes(6).toString('hex')}`;
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeSync(fd, body);
      } catch (error) {
        closeSync(fd);
        unlink(temporary);
        throw error;
      }
      closeSync(fd);
      // Atomic: the hook reads the old list or the new one, never half of one.
      renameSync(temporary, recipientsPath(dir, id));
    },
    forget(id) {
      unlink(recipientsPath(dir, id));
      unlink(readyPath(dir, id));
    },
  };
}

/** Removes gate files in `dir` last changed over a day ago, which a pitwall that was killed left. */
function removeStaleFiles(dir: string, now: number = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!GATE_FILE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stats = lstatSync(file);
      if (stats.isDirectory() || now - stats.mtimeMs <= STALE_MS) continue;
      unlinkSync(file);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}
