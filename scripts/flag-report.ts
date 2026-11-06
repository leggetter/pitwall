// The flag report (W153): what the flags in pitwall's log say about Needs you's false calls.
//
//   npx tsx scripts/flag-report.ts [--days 30] [--json]
//
// Read-only. It reads $PITWALL_HOME/flags.jsonl (~/.pitwall without it), as pitwall reads it, and
// prints counts by reason, by the recap's source, by where you clicked and by what came of the ask,
// then each flag's text, the to-do or line pitwall showed, shortened. The texts are your sessions'
// own words, so the report stays on this machine: don't paste it anywhere public.
import path from 'node:path';
import { FLAG_LOG_NAME, readFlagLog, type FlagLogLine } from '../src/server/flags.js';
import { pitwallHome } from '../src/server/launch.js';

function usage(message: string): never {
  process.stderr.write(`${message}\nUsage: npx tsx scripts/flag-report.ts [--days <n>] [--json]\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let days = 30;
let json = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') json = true;
  else if (arg === '--days') {
    const value = Number(args[++i]);
    if (!Number.isInteger(value) || value < 1 || value > 366) usage('--days takes a whole number of days, 1 to 366.');
    days = value;
  } else if (arg === '--help' || arg === '-h') usage("A report of the flags in pitwall's log.");
  else usage(`Unknown argument: ${arg}`);
}

const since = Date.now() - days * 24 * 60 * 60 * 1000;
const lines = readFlagLog(path.join(pitwallHome(), FLAG_LOG_NAME)).filter((line) => Date.parse(line.at) >= since);
const flags = lines.filter((line) => line.kind === 'flag');
// An undo within 10 minutes of its session's flag is counted as a misclick, not a false call taken back.
const undone = new Set<FlagLogLine>();
for (const undo of lines.filter((line) => line.kind === 'undo')) {
  const flag = flags.findLast((each) => each.sessionId === undo.sessionId && Date.parse(each.at) <= Date.parse(undo.at));
  if (flag !== undefined && Date.parse(undo.at) - Date.parse(flag.at) <= 10 * 60 * 1000) undone.add(flag);
}
const kept = flags.filter((flag) => !undone.has(flag));
const countBy = (key: (flag: FlagLogLine) => string | undefined) => {
  const counts: Record<string, number> = {};
  for (const flag of kept) {
    const name = key(flag) ?? 'unknown';
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
};
const report = {
  days,
  flags: kept.length,
  undoneSoon: undone.size,
  sessions: new Set(kept.map((flag) => flag.sessionId)).size,
  byReason: countBy((flag) => flag.reason),
  byRecapSource: countBy((flag) => (flag.reason === 'recap' ? (flag.recapSource ?? 'unknown') : undefined)),
  byFrom: countBy((flag) => flag.from),
  byAsked: countBy((flag) => flag.asked),
  texts: kept.map((flag) => ({ at: flag.at, session: flag.sessionId.slice(0, 8), reason: flag.reason ?? 'unknown', text: (flag.text ?? '').replace(/\s+/g, ' ').slice(0, 160) })),
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const table = (title: string, counts: Record<string, number>) =>
    Object.keys(counts).length === 0 ? '' : `\n${title}\n${Object.entries(counts).map(([name, count]) => `  ${name.padEnd(14)} ${String(count).padStart(5)}`).join('\n')}\n`;
  process.stdout.write(
    [
      `Flags in the last ${days} days: ${report.flags}, on ${report.sessions} sessions (${report.undoneSoon} more undone within 10 minutes, left out).\n`,
      table('By reason', report.byReason),
      table("By the recap's source (reason recap)", report.byRecapSource),
      table('By where you clicked', report.byFrom),
      table('By what came of the ask', report.byAsked),
      report.texts.length === 0 ? '' : `\nTexts\n${report.texts.map((each) => `  ${each.at.slice(0, 16)} ${each.session} ${each.reason.padEnd(11)} ${each.text}`).join('\n')}\n`,
    ].join(''),
  );
}
