// Spike 013 (W157, the plan's percentages): a status line command that keeps only `rate_limits`.
// usage, passed per session, never in ~/.claude/settings.json:
//   claude --bg --settings '{"statusLine":{"type":"command","command":"node <this file> <out.json>"}}' ...
// It reads the status line's JSON from stdin and writes `{ written_at, rate_limits }` to <out.json>,
// 0600, through a temporary file and a rename, so a reader never sees half a file. It keeps nothing
// else from the input: no paths, no session id, no transcript path. It prints an empty line, so the
// session's status line stays blank.
import { chmodSync, renameSync, writeFileSync } from 'node:fs';

const out = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const record = { written_at: Math.floor(Date.now() / 1000), rate_limits: data.rate_limits ?? null };
    const tmp = `${out}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, out);
  } catch {
    // Fail soft: the session's status line must never break because of this.
  }
  process.stdout.write('\n');
});
