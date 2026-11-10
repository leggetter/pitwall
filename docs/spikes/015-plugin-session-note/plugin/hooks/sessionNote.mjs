#!/usr/bin/env node
// SPIKE 015 PROTOTYPE, not production code: W176 builds the real hook, with tests and a security review.
//
// A SessionStart hook (startup, resume, clear, compact, fork) that, while pitwall runs, adds a few lines of
// context: pitwall watches this session, how to link a session, and how to propose a new one. With no
// pitwall running it prints nothing. It fails soft: any problem means no output and exit 0.
//
// Claude Code adds the note again on resume only when its text changed, and then keeps the old one too
// (spike 015, finding 4), so the note says it replaces any earlier one.
//
// pitwall's URL comes from `<PITWALL_HOME or ~/.pitwall>/server.json`, `{ "url": "http://127.0.0.1:<port>" }`,
// which pitwall doesn't write yet (W176 adds it). The file holds no token. It's read as untrusted: a regular
// file of this user's, not a link, not writable by group or others, at most 1 KiB, the URL exactly
// `http://127.0.0.1:<port>`. A background session's hooks get the background service's environment, not
// the shell's that ran `claude --bg`, so PITWALL_HOME reaches only foreground sessions (finding 3).
// Then a TCP connect to that port, within 300 ms, says pitwall is listening.
//
// For the spike only: with PITWALL_SPIKE015_LOG set, each run appends `{ at, source, session_id }` to that
// file, so the write-up can count which events ran the hook.
import { appendFileSync, closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const URL_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readInput() {
  try {
    const value = JSON.parse(readFileSync(0, 'utf8'));
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function pitwallUrl() {
  const home = process.env.PITWALL_HOME && path.isAbsolute(process.env.PITWALL_HOME) ? process.env.PITWALL_HOME : path.join(os.homedir(), '.pitwall');
  let fd;
  try {
    fd = openSync(path.join(home, 'server.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) return undefined;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return undefined;
    if ((stat.mode & 0o022) !== 0) return undefined;
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    const url = value !== null && typeof value === 'object' ? value.url : undefined;
    const match = typeof url === 'string' ? URL_PATTERN.exec(url) : null;
    if (match === null || Number(match[1]) > 65535) return undefined;
    return { url, port: Number(match[1]) };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(300, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function main() {
  const input = readInput();
  const sessionId = typeof input.session_id === 'string' && UUID.test(input.session_id) ? input.session_id : undefined;
  if (process.env.PITWALL_SPIKE015_LOG) {
    try {
      appendFileSync(process.env.PITWALL_SPIKE015_LOG, `${JSON.stringify({ at: new Date().toISOString(), source: input.source, session_id: sessionId })}\n`);
    } catch {
      // The log is the spike's, never the note's.
    }
  }
  const server = pitwallUrl();
  if (server === undefined || !(await listening(server.port))) return;
  const self = sessionId === undefined ? '' : ` This session is ${server.url}/?session=${sessionId}.`;
  const note = [
    `pitwall (${server.url}) watches the Claude Code sessions on this machine, this one included.${self}`,
    `When you mention another session, say in a few words what it is, then link its short ID: [<short id>](${server.url}/?session=<its full session ID>).`,
    'To propose a new, separate session, use the pitwall skill: you write the proposal, and the user starts it from pitwall.',
    'This replaces any earlier pitwall note in this conversation.',
  ].join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } }));
}

main().catch(() => {});
