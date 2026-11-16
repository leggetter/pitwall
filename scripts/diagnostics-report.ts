// The diagnostics report (W165): why sessions were in Needs you, and for how long.
//
//   npx tsx scripts/diagnostics-report.ts [--days 7] [--session <id>] [--json]
//
// Read-only. It reads $PITWALL_HOME/diagnostics.jsonl (~/.pitwall without it), as pitwall reads it,
// and prints the stretches each session spent in Needs you by reason, which reasons fire most, which
// of a session's own reason and a PR's the row explained, and what the PR poller found (counts).
// `--session` takes a full session id or its first 8 characters or more and prints that session's
// timeline. The log holds ids and fixed words only (src/server/diagnostics.ts), so the report has
// no session content in it. It does print a PR as owner/repo#123, so a private repo's name is in it:
// check before pasting a report somewhere public.
import path from 'node:path';
import { DIAGNOSTICS_LOG_NAME, readDiagnosticsLog } from '../src/server/diagnostics.js';
import { buildReport, formatReport } from '../src/server/diagnosticsReport.js';
import { pitwallHome } from '../src/server/launch.js';

function usage(message: string): never {
  process.stderr.write(`${message}\nUsage: npx tsx scripts/diagnostics-report.ts [--days <n>] [--session <id>] [--json]\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let days = 7;
let json = false;
let session: string | undefined;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') json = true;
  else if (arg === '--days') {
    const value = Number(args[++i]);
    if (!Number.isInteger(value) || value < 1 || value > 366) usage('--days takes a whole number of days, 1 to 366.');
    days = value;
  } else if (arg === '--session') {
    const value = args[++i];
    if (value === undefined || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) usage('--session takes a session id, or its first 8 characters or more.');
    session = value;
  } else if (arg === '--help' || arg === '-h') usage("A report of pitwall's diagnostics log: why sessions were in Needs you.");
  else usage(`Unknown argument: ${arg}`);
}

const lines = readDiagnosticsLog(path.join(pitwallHome(), DIAGNOSTICS_LOG_NAME));
const report = buildReport(lines, { days, now: Date.now(), ...(session === undefined ? {} : { session }) });
process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
