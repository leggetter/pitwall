// Session lineage (W167): what a session continues, and what continues it.
//
//   npx tsx scripts/lineage.ts <session id> [--json]
//
// Read-only. It reads $PITWALL_HOME/lineage.jsonl (~/.pitwall without it) as pitwall reads it, and
// prints the chain both ways from the session: the sessions it carries on from, then the ones that
// carry on from it, nearest first, each with how (clear or continue), when, and the path of its
// transcript if it can be found, so an agent that was cleared can read its predecessor's last
// turns. `<session id>` is a full session id, or its first 8 characters or more when they name one
// session in the log. The log holds ids, paths and branch names only (src/server/lineage.ts); the
// transcripts it points at are session content, so keep what you read from them local.
import path from 'node:path';
import { findTranscript } from '../src/index/lineageSources.js';
import { chainOf, LINEAGE_LOG_NAME, readLineageLog, type LineageLine } from '../src/server/lineage.js';
import { pitwallHome } from '../src/server/launch.js';

function usage(message: string): never {
  process.stderr.write(`${message}\nUsage: npx tsx scripts/lineage.ts <session id> [--json]\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let json = false;
let given: string | undefined;
for (const arg of args) {
  if (arg === '--json') json = true;
  else if (arg === '--help' || arg === '-h') usage("What a session continues, and what continues it, from pitwall's lineage log.");
  else if (arg.startsWith('-') || given !== undefined) usage(`Unknown argument: ${arg}`);
  else given = arg;
}
if (given === undefined || !/^[A-Za-z0-9_-]{8,128}$/.test(given)) usage('Give a session id, or its first 8 characters or more.');

const lines = readLineageLog(path.join(pitwallHome(), LINEAGE_LOG_NAME));
const ids = new Set(lines.flatMap((line) => [line.from, line.to]));
const matches = [...ids].filter((id) => id === given || id.startsWith(given!));
if (matches.length > 1 && !matches.includes(given)) usage(`${given} names ${matches.length} sessions in the log; give more of the id.`);
const sessionId = matches.includes(given) ? given : (matches[0] ?? given);

const chain = chainOf(lines, sessionId);

interface Step {
  id: string;
  how: LineageLine['how'];
  at: string;
  inferred: boolean;
  job?: string;
  cwd?: string;
  branch?: string;
  transcript: string | null;
}

async function step(id: string, line: LineageLine): Promise<Step> {
  const transcript = (await findTranscript(id, line.cwd === undefined ? [] : [line.cwd])) ?? null;
  return {
    id,
    how: line.how,
    at: line.at,
    inferred: line.inferred === true,
    ...(line.job === undefined ? {} : { job: line.job }),
    ...(line.cwd === undefined ? {} : { cwd: line.cwd }),
    ...(line.branch === undefined ? {} : { branch: line.branch }),
    transcript,
  };
}

const own = { id: sessionId, transcript: (await findTranscript(sessionId)) ?? null };
const back = await Promise.all(chain.back.map((line) => step(line.from, line)));
const forward = await Promise.all(chain.forward.map((line) => step(line.to, line)));

if (json) {
  process.stdout.write(`${JSON.stringify({ session: own, back, forward }, null, 2)}\n`);
} else {
  const show = (label: string, steps: Step[]) => {
    if (steps.length === 0) return;
    process.stdout.write(`${label}\n`);
    for (const each of steps) {
      process.stdout.write(`  ${each.id}  ${each.how}${each.inferred ? ' (inferred)' : ''}  ${each.at}${each.job === undefined ? '' : `  job ${each.job}`}\n`);
      if (each.cwd !== undefined) process.stdout.write(`    directory   ${each.cwd}${each.branch === undefined ? '' : `  (${each.branch})`}\n`);
      process.stdout.write(`    transcript  ${each.transcript ?? 'not found'}\n`);
    }
  };
  process.stdout.write(`${own.id}\n  transcript  ${own.transcript ?? 'not found'}\n`);
  show('Continued from (nearest first):', back);
  show('Continued in (nearest first):', forward);
  if (back.length === 0 && forward.length === 0) process.stdout.write('No lineage recorded for this session.\n');
}
