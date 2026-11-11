// The pitwall plugin's SessionStart hook (W176), plugin/hooks/sessionNote.mjs: run as Claude Code runs
// it, node with the hook's JSON input on stdin, and through runHook() for the cases around it. Made-up
// homes under the temp directory, never ~/.pitwall, and a listener of the test's own for "pitwall".
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeOf, isAlive, listening, noteFor, readServer, runHook } from '../../plugin/hooks/sessionNote.mjs';
import { claimServerFile, readServerFile } from '../server/serverFile.js';

const SCRIPT = fileURLToPath(new URL('../../plugin/hooks/sessionNote.mjs', import.meta.url));
const SESSION = '0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const posix = process.platform !== 'win32';

let tmp: string;
let server: Server;
let port: number;
let closedPort: number;
let deadPid: number;
let n = 0;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-sessionnote-'));
  server = createServer((socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
  const other = createServer();
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  closedPort = (other.address() as AddressInfo).port;
  await new Promise((resolve) => other.close(resolve));
  // A process that has exited: its pid names nothing now.
  deadPid = spawnSync(process.execPath, ['-e', '0']).pid as number;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
});

/** A fresh user home holding a 0700 .pitwall; returns both. */
function userHome(): { home: string; pitwall: string } {
  const home = path.join(tmp, `user-${++n}`);
  const pitwall = path.join(home, '.pitwall');
  mkdirSync(pitwall, { recursive: true, mode: 0o700 });
  chmodSync(pitwall, 0o700);
  return { home, pitwall };
}
const fileIn = (dir: string) => path.join(dir, 'server.json');
const writeServer = (dir: string, text: string, mode = 0o600) => {
  writeFileSync(fileIn(dir), text, { mode });
  chmodSync(fileIn(dir), mode);
};
const good = (p = port, pid = process.pid) => JSON.stringify({ v: 1, url: `http://127.0.0.1:${p}`, pid });
const input = JSON.stringify({ session_id: SESSION, hook_event_name: 'SessionStart', source: 'startup' });
const hook = (home: string, env: NodeJS.ProcessEnv = {}, text = input) => runHook(text, env, { home });

/** Runs the script with node, as Claude Code does, and returns stdout, stderr, the exit code and how long it took. */
async function runScript(env: NodeJS.ProcessEnv, stdin = input) {
  const started = Date.now();
  const child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  // The hook stops reading past its cap, so a long input can meet a closed pipe.
  child.stdin.on('error', () => {});
  child.stdin.end(stdin);
  const [code] = (await once(child, 'exit')) as [number | null];
  return { stdout, stderr, code, ms: Date.now() - started };
}

describe('the hook, run as Claude Code runs it', () => {
  it('while pitwall runs: the note, with its port and this session’s link', async () => {
    const { home, pitwall } = userHome();
    writeServer(pitwall, good());
    const { stdout, stderr, code } = await runScript({ HOME: home });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toBe(noteFor(`http://127.0.0.1:${port}`, SESSION));
    expect(out.hookSpecificOutput.additionalContext).toContain(`http://127.0.0.1:${port}/?session=${SESSION}`);
  });

  it('reads the file pitwall itself writes (src/server/serverFile.ts)', async () => {
    const { home, pitwall } = userHome();
    const handle = claimServerFile({ home: pitwall, url: `http://127.0.0.1:${port}`, dev: false, reclaimMs: 0 });
    expect(readServerFile(handle.file)).toEqual({ v: 1, url: `http://127.0.0.1:${port}`, pid: process.pid });
    expect((await runScript({ HOME: home })).stdout).toContain(`127.0.0.1:${port}`);
    handle.close();
    expect((await runScript({ HOME: home })).stdout).toBe('');
  });

  it('with no pitwall: nothing, exit 0, nothing on stderr', async () => {
    const { home } = userHome();
    expect(await runScript({ HOME: home })).toMatchObject({ stdout: '', stderr: '', code: 0 });
  });

  it.skipIf(!posix)('a FIFO in the file’s place: nothing, and no hang', async () => {
    const { home, pitwall } = userHome();
    spawnSync('mkfifo', [fileIn(pitwall)]);
    const result = await runScript({ HOME: home });
    expect(result).toMatchObject({ stdout: '', stderr: '', code: 0 });
    expect(result.ms).toBeLessThan(3000);
  });

  it('garbage or no input: the note without this session’s link', async () => {
    const { home, pitwall } = userHome();
    writeServer(pitwall, good());
    for (const stdin of ['', 'not json', JSON.stringify({ session_id: '../../etc' })]) {
      const { stdout } = await runScript({ HOME: home }, stdin);
      expect(stdout).toContain(`pitwall (http://127.0.0.1:${port}) watches`);
      expect(stdout).not.toContain('this one included:');
    }
  });

  it('input past its cap: still the note, without the link, and quiet', async () => {
    const { home, pitwall } = userHome();
    writeServer(pitwall, good());
    const { stdout, stderr } = await runScript({ HOME: home }, JSON.stringify({ session_id: SESSION, pad: 'x'.repeat(200_000) }));
    expect(stderr).toBe('');
    expect(stdout).not.toContain(SESSION);
  });
});

describe('runHook', () => {
  it('nothing without the file, for a stale pid, or for a port nothing listens on', async () => {
    const { home, pitwall } = userHome();
    expect(await hook(home)).toBe('');
    writeServer(pitwall, good(port, deadPid));
    expect(isAlive(deadPid)).toBe(false);
    expect(await hook(home)).toBe('');
    writeServer(pitwall, good(closedPort));
    expect(await listening(closedPort)).toBe(false);
    expect(await hook(home)).toBe('');
  });

  it('nothing for a malformed, huge, or wrongly shaped file, or a URL that isn’t 127.0.0.1', async () => {
    const { home, pitwall } = userHome();
    for (const text of [
      '{',
      'null',
      '[]',
      JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, pad: 'x'.repeat(2000) }),
      `${good()}${' '.repeat(2000)}`,
      JSON.stringify({ url: `http://localhost:${port}`, pid: process.pid }),
      JSON.stringify({ url: `http://evil.example:${port}`, pid: process.pid }),
      JSON.stringify({ url: `http://127.0.0.1:${port}/`, pid: process.pid }),
      JSON.stringify({ url: `http://127.0.0.1:${port}/?x=](https://evil.example)`, pid: process.pid }),
      JSON.stringify({ url: 'http://127.0.0.1:70000', pid: process.pid }),
      JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: 0 }),
      JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: -1 }),
      JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: 1 }),
      JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: String(process.pid) }),
    ]) {
      writeServer(pitwall, text);
      expect(await hook(home), text.slice(0, 80)).toBe('');
    }
  });

  it.skipIf(!posix)('nothing through a link, or from a file others can write', async () => {
    const { home, pitwall } = userHome();
    const elsewhere = path.join(tmp, `elsewhere-${++n}.json`);
    writeFileSync(elsewhere, good(), { mode: 0o600 });
    symlinkSync(elsewhere, fileIn(pitwall));
    expect(await hook(home)).toBe('');

    const second = userHome();
    writeServer(second.pitwall, good(), 0o620);
    expect(await hook(second.home)).toBe('');
    writeServer(second.pitwall, good(), 0o602);
    expect(await hook(second.home)).toBe('');
    writeServer(second.pitwall, good(), 0o644);
    expect(await hook(second.home)).not.toBe('');
  });

  it('the same text for the same port and session, so a resume doesn’t add it twice', async () => {
    const { home, pitwall } = userHome();
    writeServer(pitwall, good());
    const first = await hook(home);
    expect(first).not.toBe('');
    expect(await hook(home)).toBe(first);
  });

  it('reads PITWALL_HOME only when it’s absolute; ~/.pitwall otherwise', async () => {
    const { home } = userHome();
    const other = path.join(tmp, `other-${++n}`);
    mkdirSync(other, { mode: 0o700 });
    writeServer(other, good());
    expect(await hook(home, { PITWALL_HOME: other })).toContain(`127.0.0.1:${port}`);
    expect(await hook(home, { PITWALL_HOME: path.relative(process.cwd(), other) })).toBe('');
    expect(homeOf({ PITWALL_HOME: 'rel' }, '/u')).toBe(path.join('/u', '.pitwall'));
    expect(homeOf({ PITWALL_HOME: '' }, '/u')).toBe(path.join('/u', '.pitwall'));
    expect(homeOf({}, '/u')).toBe(path.join('/u', '.pitwall'));
  });

  it('checks the pid as well as the port: a live port with a dead pid adds nothing', async () => {
    const { home, pitwall } = userHome();
    writeServer(pitwall, good());
    expect(await runHook(input, {}, { home, alive: () => false, listening: async () => true })).toBe('');
    expect(await runHook(input, {}, { home, alive: () => true, listening: async () => false })).toBe('');
    expect(await runHook(input, {}, { home, alive: () => true, listening: async () => true })).not.toBe('');
  });

  it('reads the file as serverFile.ts does', () => {
    const { pitwall } = userHome();
    writeServer(pitwall, good());
    expect(readServer(fileIn(pitwall))).toEqual({ url: `http://127.0.0.1:${port}`, port, pid: process.pid });
    expect(readServerFile(fileIn(pitwall))).toEqual({ v: 1, url: `http://127.0.0.1:${port}`, pid: process.pid });
  });

  it('keeps the note to four short lines', () => {
    const note = noteFor('http://127.0.0.1:4518', SESSION);
    expect(note.split('\n')).toHaveLength(4);
    expect(note.length).toBeLessThan(700);
  });
});
