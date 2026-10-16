// Spike S3 + S6: attach to a background session through node-pty, type a prompt,
// and watch the transcript file grow.
// usage: node 001-pty-attach.mjs <node_modules dir> <session short id> <transcript path>
import { createRequire } from 'node:module';
import { statSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [modulesDir, id, transcript] = process.argv.slice(2);
const require = createRequire(path.join(modulesDir, 'noop.js'));
const pty = require('node-pty');

const lines = () => readFileSync(transcript, 'utf8').split('\n').filter(Boolean).length;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const before = lines();
log(`transcript lines before: ${before}`);

const term = pty.spawn('claude', ['attach', id], {
  name: 'xterm-256color', cols: 120, rows: 40, cwd: process.env.HOME, env: process.env,
});
let out = '';
term.onData((d) => { out += d; });
term.onExit(({ exitCode, signal }) => log(`pty exited code=${exitCode} signal=${signal}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(6000);
log(`bytes rendered after attach: ${out.length}`);
const prompt = 'pitwall spike S3: what is 2+2? Reply with just the number.';
for (const ch of prompt) { term.write(ch); await sleep(5); }
term.write('\r');
const sentAt = Date.now();
log('prompt typed');

let firstGrowth = null;
let last = before;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const n = lines();
  if (n > last) {
    if (firstGrowth === null) { firstGrowth = Date.now() - sentAt; log(`transcript grew first after ${firstGrowth} ms`); }
    last = n;
  }
  if (readFileSync(transcript, 'utf8').includes('"text":"4"')) { log('answer "4" found in transcript'); break; }
}
log(`transcript lines after: ${lines()} (was ${before})`);
writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'pty-out.txt'), out);
term.kill();
await sleep(1500);
process.exit(0);
