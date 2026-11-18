// Shared by the pitwall plugin's hook tests (W197): a made-up "pitwall running" (a listener of the test's own and a
// fresh server.json that names this test process), made-up transcripts and sub-agent files, and a runner that
// starts a hook as Claude Code does, node with the script and the hook's JSON input on stdin. No real session.
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface Kit {
  tmp: string;
  /** PITWALL_HOME for hooks that should find pitwall running. */
  home: string;
  /** PITWALL_HOME that holds no server file: pitwall isn't running. */
  emptyHome: string;
  stateDir: string;
  close(): Promise<void>;
}

export async function makeKit(prefix: string): Promise<Kit> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), `pitwall-test-${prefix}-`));
  const server: Server = createServer((socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const home = path.join(tmp, 'home');
  const emptyHome = path.join(tmp, 'empty-home');
  for (const dir of [home, emptyHome]) {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const file = path.join(home, 'server.json');
  writeFileSync(file, JSON.stringify({ v: 1, url: `http://127.0.0.1:${port}`, pid: process.pid }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return {
    tmp,
    home,
    emptyHome,
    stateDir: path.join(tmp, 'state'),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export const usage = (input: number, read: number, write: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 10 });

export const assistant = (id: string, u: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { id, model: 'claude-test', role: 'assistant', usage: u, content: [{ type: 'text', text: 'made up' }] }, ...extra });

export const userLine = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'made up' } });

/** A session's transcript path under `tmp`; the file itself is written only when `lines` is given. */
export function sessionFile(tmp: string, name: string, lines?: string[]): string {
  const file = path.join(tmp, `${name}.jsonl`);
  if (lines !== undefined) writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/**
 * Makes `<transcript minus .jsonl>/subagents/` and, for the agent, its transcript (all sidechain, as
 * Claude Code writes them) and its meta file. `meta` undefined writes none.
 */
export function subagent(transcript: string, agentId: string, options: { context?: number; meta?: Record<string, unknown> | string }): string {
  const dir = path.join(transcript.slice(0, -'.jsonl'.length), 'subagents');
  mkdirSync(dir, { recursive: true });
  if (options.context !== undefined) {
    writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), `${[userLine, assistant('s1', usage(2, options.context - 2, 0), { isSidechain: true })].join('\n')}\n`);
  }
  if (options.meta !== undefined) writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), typeof options.meta === 'string' ? options.meta : JSON.stringify(options.meta));
  return dir;
}

export interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runScript(script: string, input: Record<string, unknown> | string, env: Record<string, string>): HookRun {
  const result = spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
