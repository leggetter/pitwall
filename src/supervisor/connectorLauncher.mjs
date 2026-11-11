#!/usr/bin/env node
// @ts-check
// Starts a supervisor connector's stdio server with only the variables pitwall named (W184, D28).
//
//   node connectorLauncher.mjs [--keep NAME]... -- <command> [arg...]
//
// Claude Code runs it as the connector's `command`, from the supervisor's 0600 MCP config, and
// passes it its whole environment (checked on 2.1.322), its own messaging token included. This
// starts <command> with PATH and the --keep variables alone, taken from that environment, where the
// config's `env` block put their values; stdin, stdout and stderr are the connector's own, so the
// MCP stream goes straight through. No shell.
//
// It replaces itself with the command (`process.execve`, Node 22.15 and later), finding a bare name
// on the kept PATH, so no process is left whose starting environment, which `ps -E` shows, holds
// Claude Code's messaging token (W186's F4). On a Node without it, it starts the command as a child,
// forwards SIGTERM, SIGINT and SIGHUP, and exits as the server does; the launcher's own starting
// environment is then still visible to `ps` while it runs.
//
// This is hygiene against a connector picking up what it was never given, not a boundary: any
// process of the same user can read the 0600 MCP config, and the messaging token, anyway.
//
// Plain JavaScript with no dependencies, so the same file runs from src/ under `npm run dev` and
// from dist/ once built, as the supervisor's gate hook does (supervisorGateHook.mjs).
import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A variable's name, as connectorServer.ts's ENV_NAME_PATTERN. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * The command, its arguments and its environment from the launcher's arguments and environment, or
 * an error. PATH is always kept; nothing else is, unless --keep names it.
 *
 * @param {readonly string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true, command: string, args: string[], env: Record<string, string> } | { ok: false, error: string }}
 */
export function launchPlan(argv, env) {
  const keep = new Set(['PATH']);
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i += 2) {
    const name = argv[i + 1];
    if (argv[i] !== '--keep' || name === undefined || !NAME.test(name)) return { ok: false, error: 'usage: connectorLauncher.mjs [--keep NAME]... -- <command> [arg...]' };
    keep.add(name);
  }
  const [command, ...args] = argv.slice(i + 1);
  if (argv[i] !== '--' || command === undefined || command === '') return { ok: false, error: 'usage: connectorLauncher.mjs [--keep NAME]... -- <command> [arg...]' };
  /** @type {Record<string, string>} */
  const childEnv = {};
  for (const name of keep) {
    const value = env[name];
    if (value !== undefined) childEnv[name] = value;
  }
  return { ok: true, command, args, env: childEnv };
}

/**
 * The command's path: as it is when it has a `/`, else the first executable file of that name in an
 * absolute directory on `searchPath`, as execvp would find it. Undefined when there's none.
 *
 * @param {string} command
 * @param {string | undefined} searchPath
 * @returns {string | undefined}
 */
export function findCommand(command, searchPath) {
  if (command.includes('/')) return command;
  for (const dir of (searchPath ?? '').split(':')) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const plan = launchPlan(process.argv.slice(2), process.env);
  if (!plan.ok) {
    process.stderr.write(`pitwall connector launcher: ${plan.error}\n`);
    process.exit(2);
  }
  if (typeof process.execve === 'function') {
    const file = findCommand(plan.command, plan.env.PATH);
    if (file === undefined) {
      process.stderr.write("pitwall connector launcher: couldn't find the connector's command on its PATH\n");
      process.exit(127);
    }
    try {
      // argv[0] is the command as given. Never returns when it works.
      process.execve(file, [plan.command, ...plan.args], plan.env);
    } catch (error) {
      process.stderr.write(`pitwall connector launcher: couldn't start the connector's command (${/** @type {NodeJS.ErrnoException} */ (error).code ?? 'error'})\n`);
      process.exit(127);
    }
  }
  const child = spawn(plan.command, plan.args, { env: plan.env, stdio: 'inherit' });
  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP'])) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
  child.on('error', (error) => {
    // The command's name only: never an argument, which might be sensitive.
    process.stderr.write(`pitwall connector launcher: couldn't start the connector's command (${/** @type {NodeJS.ErrnoException} */ (error).code ?? 'error'})\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal === null ? 1 : 128));
  });
}
