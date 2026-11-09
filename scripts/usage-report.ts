// The usage report (W131): aggregate token usage from this machine's Claude Code transcripts, to
// test the draft efficiency rules before any goes into an agent's instructions.
//
//   npx tsx scripts/usage-report.ts [--days 14] [--json]
//
// Read-only. It prints totals only: never a prompt, a message, a tool's input or output, or a
// file's contents. Repo directories and session id prefixes are the most it names. CLAUDE_CONFIG_DIR
// and PITWALL_HOME are honoured, as pitwall honours them.
import { formatReport } from '../src/usage/format.js';
import { buildUsageReport } from '../src/usage/report.js';

function usage(message: string): never {
  process.stderr.write(`${message}\nUsage: npx tsx scripts/usage-report.ts [--days <n>] [--json]\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let days = 14;
let json = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') json = true;
  else if (arg === '--days') {
    const value = Number(args[++i]);
    if (!Number.isInteger(value) || value < 1 || value > 366) usage('--days takes a whole number of days, 1 to 366.');
    days = value;
  } else if (arg === '--help' || arg === '-h') usage('A usage report from Claude Code transcripts.');
  else usage(`Unknown argument: ${arg}`);
}

const report = await buildUsageReport({ days });
process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
