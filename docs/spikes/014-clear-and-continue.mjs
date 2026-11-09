// Spike 014 (W168, Clear and continue): can pitwall send `/clear` and then a prompt to a background
// job through `claude attach` in a PTY, and confirm each step from `claude agents --json`, not the screen?
// usage: node docs/spikes/014-clear-and-continue.mjs <node_modules dir> <job short id> <cwd>
// Only ever against a throwaway `pitwall-test-*` job (AGENTS.md: never touch a real session).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const [modulesDir, id, cwd] = process.argv.slice(2);
const require = createRequire(path.join(modulesDir, 'noop.js'));
const pty = require('node-pty');

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function row() {
  const rows = JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8' }));
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`job ${id} not listed`);
  if (!String(found.name ?? '').startsWith('pitwall-test-')) throw new Error(`refusing: ${id} is not a pitwall-test-* job`);
  return found;
}
function transcript(sessionId) {
  const dir = path.join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  return path.join(dir, `${sessionId}.jsonl`);
}
function userTexts(sessionId) {
  const file = transcript(sessionId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.type === 'user' && typeof e.message?.content === 'string').map((e) => e.message.content);
}
async function until(what, test, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = test();
    if (value) { log(`${what} after ${Date.now() - start} ms`); return value; }
    await sleep(250);
  }
  log(`${what}: not within ${ms} ms`);
  return undefined;
}

const before = row();
log(`before: state=${before.state} status=${before.status} sessionId=${before.sessionId} name=${before.name}`);

const term = pty.spawn('claude', ['attach', id], { name: 'xterm-256color', cols: 120, rows: 40, cwd, env: process.env });
let out = '';
let bracketed = false;
term.onData((d) => { out += d; if (d.includes('\x1b[?2004h')) bracketed = true; });
term.onExit(({ exitCode, signal }) => log(`pty exited code=${exitCode} signal=${signal}`));

// 1. Ready to type: wait for output to go quiet, rather than reading the screen.
let lastLen = -1;
await until('attach output quiet for 1 s', () => { const quiet = out.length > 0 && out.length === lastLen; lastLen = out.length; return quiet; }, 15000);
log(`bracketed paste on: ${bracketed}`);
const afterAttach = row();
log(`after attach: state=${afterAttach.state} status=${afterAttach.status} sessionId=${afterAttach.sessionId}`);

// 2. /clear, confirmed by a new session id for the same job.
term.write('/clear');
await sleep(300);
term.write('\r');
const cleared = await until('new sessionId listed', () => { const r = row(); return r.sessionId !== before.sessionId ? r : undefined; });
if (!cleared) { term.kill(); process.exit(1); }
log(`after clear: state=${cleared.state} status=${cleared.status} sessionId=${cleared.sessionId} name=${cleared.name}`);

// 3. A two-line prompt, bracketed, then Enter; confirmed from the new transcript.
await sleep(500);
const prompt = 'Continues session ' + before.sessionId + '.\nSpike 014: reply with just the word CLEARED.';
term.write(bracketed ? `\x1b[200~${prompt}\x1b[201~` : prompt);
await sleep(300);
term.write('\r');
const texts = await until('prompt in the new transcript', () => { const t = userTexts(cleared.sessionId).filter((x) => x.includes('Spike 014')); return t.length ? t : undefined; });
log(`user messages with it: ${texts?.length}; one message with both lines: ${texts?.[0]?.includes('Continues session') && texts?.[0]?.includes('\n')}`);
const answered = await until('answer in the new transcript', () => readFileSync(transcript(cleared.sessionId), 'utf8').includes('CLEARED"'), 60000);
const after = row();
log(`end: state=${after.state} status=${after.status} sessionId=${after.sessionId} name=${after.name} answered=${Boolean(answered)}`);
const state = path.join(homedir(), '.claude', 'jobs', id, 'state.json');
if (existsSync(state)) {
  const s = JSON.parse(readFileSync(state, 'utf8'));
  log(`state.json: sessionId=${s.sessionId} resumeSessionId=${s.resumeSessionId} name=${s.name} state=${s.state}`);
}
term.kill();
await sleep(1500);
const detached = row();
log(`after detach: state=${detached.state} status=${detached.status} sessionId=${detached.sessionId}`);
process.exit(0);
