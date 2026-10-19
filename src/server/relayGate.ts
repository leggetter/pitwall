// The pitwall side of the relay's gate (D8): the 0700 directory the gate
// shares with its hook, the expectation pitwall writes before each request,
// and the hook configuration for the relay's --settings. The hook itself is
// relayGateHook.mjs, which has the protocol.
//
// Why a hook: the relay's SendMessage needs no permission for a session on
// this machine, so `--permission-mode dontAsk` doesn't stop a call nobody
// approved, and pitwall's own check of the stream-json output comes only
// after the call has run. A PreToolUse hook runs before it, and with
// `onFailure: "block"` a hook that can't run blocks the call.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLaunchDir } from './launch.js';
import { EXPECTATION_VERSION, expectationPath, readyPath, textHash } from './relayGateHook.mjs';

/** The gate's directory, under PITWALL_HOME, next to the relay's own. */
export const RELAY_GATE_DIR_NAME = 'relay-gate';

/** How long the hook may take before Claude Code gives up on it, and blocks the call. */
const HOOK_TIMEOUT_SECONDS = 10;

/** Files the gate leaves behind that are older than this are from an earlier run, and are deleted on startup. */
const STALE_MS = 60 * 60 * 1000;

/** Names the gate and its hook give files. Startup cleanup deletes only these. */
const GATE_FILE = /^[0-9a-f]{32}\.(?:ready|expect|expect\.tmp-[0-9a-f]+|claim-[0-9a-f]+)$/;

/** What pitwall expects the relay's next SendMessage call to be. */
export interface GateExpectation {
  /** The request id, from relayPrompt.ts. */
  request: string;
  /** The target's name, exactly as it goes in `to`. */
  to: string;
  /** The text. Only its hash is written. */
  text: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export interface RelayGate {
  /** Creates the directory if needed and checks it's safe. Throws when it isn't. */
  prepare(): void;
  /** A new id, for one relay process. */
  newId(): string;
  /** The `--settings` value that installs the hook for gate `id`. */
  settings(id: string): string;
  /** Whether the hook has run at the relay's SessionStart, so its hooks are loaded. */
  isReady(id: string): boolean;
  /** Writes the expectation for gate `id`, replacing any before it. */
  expect(id: string, expectation: GateExpectation): void;
  /** Whether an expectation is still waiting for gate `id`: no SendMessage call has claimed it. */
  pending(id: string): boolean;
  /** Removes the expectation for gate `id`, if any. */
  clear(id: string): void;
  /** Removes everything for gate `id`, once its relay has gone. */
  forget(id: string): void;
}

export interface RelayGateOptions {
  /** `$PITWALL_HOME/relay-gate`. */
  dir: string;
  /** Default process.execPath. */
  node?: string;
  /** Default relayGateHook.mjs next to this file: in src/ under tsx, in dist/ once built. */
  script?: string;
  /** Creates the directory and its parent if needed, and checks each is 0700 and the user's own. Default: the launch directory's check. */
  ensureDir?: (dir: string) => void;
}

/** The hook script, next to this module. */
export function gateScriptPath(): string {
  return fileURLToPath(new URL('./relayGateHook.mjs', import.meta.url));
}

/**
 * The relay's settings: a PreToolUse hook for SendMessage, which must allow
 * each call, and a SessionStart hook that marks the gate ready. Exec form
 * (`args`), so no shell parses the paths.
 */
export function gateSettings(options: { node: string; script: string; dir: string; id: string }): string {
  const hook = (extra: Record<string, unknown>) => ({
    type: 'command',
    command: options.node,
    args: [options.script, options.dir, options.id],
    timeout: HOOK_TIMEOUT_SECONDS,
    ...extra,
  });
  return JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [hook({})] }],
      PreToolUse: [{ matcher: 'SendMessage', hooks: [hook({ onFailure: 'block' })] }],
    },
  });
}

export function createRelayGate(options: RelayGateOptions): RelayGate {
  const dir = path.resolve(options.dir);
  const node = options.node ?? process.execPath;
  const script = options.script ?? gateScriptPath();
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
      removeStaleGateFiles(dir);
    },
    newId: () => randomBytes(16).toString('hex'),
    settings: (id) => gateSettings({ node, script, dir, id }),
    isReady: (id) => existsSync(readyPath(dir, id)),
    expect(id, expectation) {
      const body = `${JSON.stringify({
        v: EXPECTATION_VERSION,
        request: expectation.request,
        to: expectation.to,
        sha256: textHash(expectation.text),
        expiresAt: expectation.expiresAt,
      })}\n`;
      const temporary = `${expectationPath(dir, id)}.tmp-${randomBytes(6).toString('hex')}`;
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
      // Atomic: the hook sees the old expectation or the new one, never half of one.
      renameSync(temporary, expectationPath(dir, id));
    },
    pending: (id) => existsSync(expectationPath(dir, id)),
    clear: (id) => unlink(expectationPath(dir, id)),
    forget(id) {
      unlink(expectationPath(dir, id));
      unlink(readyPath(dir, id));
    },
  };
}

/** Deletes gate files in `dir` last modified over an hour ago, left by a pitwall that was killed. Returns their names. */
export function removeStaleGateFiles(dir: string, now: number = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!GATE_FILE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stats = lstatSync(file);
      if (stats.isDirectory() || now - stats.mtimeMs <= STALE_MS) continue;
      unlinkSync(file);
      removed.push(name);
    } catch {
      // Gone already, or not ours to delete.
    }
  }
  return removed;
}
