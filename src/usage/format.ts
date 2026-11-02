// The usage report as text tables (W131). Aggregates only, as report.ts builds them.
import type { Distribution, Row, Totals, UsageReport } from './report.js';

export function tokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);

export function table(head: string[], body: (string | number)[][]): string {
  const cells = [head, ...body.map((row) => row.map(String))];
  const widths = head.map((_, i) => Math.max(...cells.map((row) => (row[i] ?? '').length)));
  const line = (row: string[]) =>
    row
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.slice(1).map(line)].join('\n');
}

const TOTALS_HEAD = ['calls', 'total', 'fresh in', 'cache write', 'cache read', 'output', 'read %', 'cost*'];
const totalsCells = (t: Totals) => [t.calls, tokens(t.total), tokens(t.input), tokens(t.cacheWrite), tokens(t.cacheRead), tokens(t.output), pct(t.total > 0 ? t.cacheRead / t.total : 0), usd(t.cost)];

function rowTable(first: string, rows: Row[], limit = rows.length, grand?: number): string {
  const head = [first, ...(rows.some((row) => row.sessions !== undefined) ? ['sessions'] : []), ...TOTALS_HEAD, ...(grand === undefined ? [] : ['of all'])];
  const hasSessions = head.includes('sessions');
  const body = rows.slice(0, limit).map((row) => [row.key, ...(hasSessions ? [row.sessions ?? ''] : []), ...totalsCells(row), ...(grand === undefined ? [] : [pct(grand > 0 ? row.total / grand : 0)])]);
  const more = rows.length > limit ? `\n(${rows.length - limit} more in --json)` : '';
  return table(head, body) + more;
}

const dist = (label: string, d: Distribution, f: (n: number) => string = tokens) => [label, d.count, f(d.median), f(d.mean), f(d.p90), f(d.p99), f(d.max), f(d.sum)];
const DIST_HEAD = ['', 'n', 'median', 'mean', 'p90', 'p99', 'max', 'sum'];

export function formatReport(r: UsageReport): string {
  const out: string[] = [];
  const section = (title: string) => out.push('', `== ${title} ==`, '');
  const t = r.totals;

  out.push(`Claude Code usage, the last ${r.window.days} days: ${r.window.since} to ${r.window.until} (hours in ${r.window.timeZone})`);
  out.push(`* cost: ${r.costLabel}.`);
  out.push(`total = fresh input + cache writes + cache reads + output. A call is one API response, counted once.`);
  out.push('', table(['', ...TOTALS_HEAD], [['all', ...totalsCells(t)]]));
  out.push(
    '',
    `files read: ${r.files.main} main sessions, ${r.files.subagent} sub-agent runs (${r.files.withCalls} with calls in the window); ${r.files.olderThanWindow} older than the window skipped; ${r.files.unreadable} unreadable`,
  );

  section('By day');
  out.push(rowTable('day', r.byDay));

  section('Rule 1: long sessions should hand off (re-reading context)');
  out.push(`shares of all tokens: cache reads ${pct(r.rule1.cacheReadShare)}, cache writes ${pct(r.rule1.cacheWriteShare)}, fresh input ${pct(r.rule1.freshInputShare)}, output ${pct(r.rule1.outputShare)}`);
  out.push('', 'Per main session (its own calls, not its sub-agents\'; pitwall\'s own calls left out):', '');
  out.push(
    table(DIST_HEAD, [
      dist('total tokens', r.rule1.perSession.total),
      dist('calls', r.rule1.perSession.calls, (n) => String(Math.round(n))),
      dist('cache read per call', r.rule1.perSession.cacheReadPerCall),
      dist('largest context', r.rule1.perSession.maxContext),
    ]),
  );
  out.push('', 'Main sessions\' calls by their place in the session: how the context re-read per call grows:', '');
  out.push(
    table(
      ['call number', 'calls', 'mean context', 'mean cache read', 'cache read', 'of reads', 'of tokens'],
      r.rule1.byCallIndex.map((b) => [b.label, b.calls, tokens(b.meanContext), tokens(b.meanCacheRead), tokens(b.cacheRead), pct(b.cacheReadShare), pct(b.totalShare)]),
    ),
  );
  out.push('', 'All calls (main and sub-agents, not pitwall\'s) by the context size they sent:', '');
  out.push(
    table(
      ['context', 'calls', 'mean context', 'cache read', 'of reads', 'of tokens'],
      r.rule1.byContextSize.map((b) => [b.label, b.calls, tokens(b.meanContext), tokens(b.cacheRead), pct(b.cacheReadShare), pct(b.totalShare)]),
    ),
  );
  out.push('', 'Main sessions by length:', '');
  out.push(rowTable('length', r.rule1.bySessionLength, undefined, r.rule1.bySessionLength.reduce((s, x) => s + x.total, 0)));
  out.push('', 'Top 10 sessions by their own total (session id prefix only):', '');
  out.push(
    table(
      ['session', 'kind', 'repo', 'model', 'calls', 'total', 'read %', 'largest ctx', 'sub-agents', 'sub-agent total', 'cost*'],
      r.rule1.top10.map((s) => [s.session, s.kind, s.repo, s.model, s.calls, tokens(s.total), pct(s.total > 0 ? s.cacheRead / s.total : 0), tokens(s.maxContext), s.subagentRuns, tokens(s.subagentTotal), usd(s.cost)]),
    ),
  );

  section('Rule 2: match the model to the work');
  out.push(rowTable('model', r.rule2.byModel, undefined, t.total));
  out.push('', rowTable('model  effort', r.rule2.byModelEffort, undefined, t.total));
  out.push('', rowTable('repo', r.rule2.byRepo, 25, t.total));
  out.push('', rowTable('repo  model', r.rule2.byRepoModel, 30, t.total));

  section('Rule 3: sub-agents only for big work');
  out.push(
    table(
      ['', 'sessions or runs', ...TOTALS_HEAD, 'of all'],
      [
        ['main sessions (incl. pitwall\'s)', r.rule3.main.sessions, ...totalsCells(r.rule3.main), pct(t.total > 0 ? r.rule3.main.total / t.total : 0)],
        ['sub-agent runs', r.rule3.subagent.runs, ...totalsCells(r.rule3.subagent), pct(t.total > 0 ? r.rule3.subagent.total / t.total : 0)],
      ],
    ),
  );
  out.push('', table(DIST_HEAD, [dist('tokens per sub-agent run', r.rule3.runTotal), dist('calls per sub-agent run', r.rule3.runCalls, (n) => String(Math.round(n)))]));
  out.push('', table(['run size', 'runs', 'of runs', 'tokens', 'of sub-agent tokens'], r.rule3.runSizes.map((s) => [s.label, s.runs, pct(s.runShare), tokens(s.total), pct(s.totalShare)])));
  out.push('', 'What a run pays before it does anything: the context of its first call', '');
  out.push(table(DIST_HEAD, [dist('main session, first call', r.rule3.firstCallContext.main), dist('sub-agent run, first call', r.rule3.firstCallContext.subagent)]));
  out.push('', rowTable('agent type', r.rule3.byAgentType, 15, r.rule3.subagent.total));

  section('Rule 4: one agent at a time');
  out.push(`hours with any call: ${r.rule4.activeHours}`);
  out.push('', 'Hours by how many main sessions (not sub-agents, not pitwall\'s) made calls in them:', '');
  out.push(table(['main sessions', 'hours', 'tokens', 'of all', 'tokens per hour'], r.rule4.byConcurrency.map((c) => [c.sessions, c.hours, tokens(c.total), pct(c.totalShare), tokens(c.meanPerHour)])));
  out.push('', 'Peak hours:', '');
  out.push(table(['hour', 'tokens', 'cost*', 'sessions', 'sub-agent runs', 'pitwall\'s'], r.rule4.peakHours.map((h) => [h.hour, tokens(h.total), usd(h.cost), h.sessions, h.subagents, h.pitwall])));
  out.push('', 'Busiest five-hour windows, not overlapping:', '');
  out.push(table(['from', 'tokens', 'cost*'], r.rule4.busiestFiveHours.map((w) => [w.from, tokens(w.total), usd(w.cost)])));
  out.push('', '(every hour is in --json)');

  section('Rule 5: big tool outputs');
  const r5 = r.rule5;
  out.push(`${r5.results} tool results, ${r5.images} images; ${tokens(r5.chars.sum)} characters, about ${tokens(r5.estimatedTokens)} tokens at 4 characters a token`);
  out.push(`about ${pct(r5.shareOfNewContext)} of fresh input plus cache writes, what enters context; about ${pct(r5.shareOfContextSent)} of all context sent, carried until a compaction (rough)`);
  out.push("images aren't counted in characters or tokens, so an image-heavy tool's median can be 0");
  out.push('', table(DIST_HEAD, [dist('characters per result', r5.chars)]));
  out.push('', table(['size', 'results', 'characters', 'of characters'], r5.sizes.map((s) => [s.label, s.results, tokens(s.chars), pct(s.charShare)])));
  out.push('', table(['tool', 'results', 'images', 'characters', 'median', 'p90', 'max'], r5.byTool.map((x) => [x.tool, x.results, x.images, tokens(x.chars), tokens(x.median), tokens(x.p90), tokens(x.max)])));

  section("pitwall's own calls");
  out.push(`${pct(r.pitwall.shareOfTotal)} of all tokens. Recaps and plan status run with --no-session-persistence, so they leave no transcript and aren't here.`);
  out.push('', rowTable('kind', r.pitwall.byKind));

  section('Data quality');
  const unpriced = Object.entries(r.caveats.unpricedModels);
  out.push(
    [
      `lines read ${r.lines.read}, parsed ${r.lines.parsed} (only lines that could be a response, a tool result, a name or a compaction are parsed); skipped: ${r.lines.malformed} not JSON, ${r.lines.noTimestamp} without a timestamp, ${r.lines.noUsage} responses without usage or model, ${r.lines.synthetic} synthetic, ${r.lines.outsideWindow} responses before the window`,
      `duplicates: ${r.duplicates.sameFileLines} lines repeating a response in the same file (counted once; ${r.duplicates.usageDiffered} with different usage, the larger output kept), ${r.duplicates.crossFileCalls} responses copied into another file, ${r.duplicates.crossFileToolResults} tool results copied`,
      `cache writes without a 5m/1h split, priced as 5m: ${r.caveats.cacheWritesWithoutTtlSplit} calls; sub-agent runs without a cwd of their own: ${r.caveats.subagentsWithoutCwd}`,
      `models without a price: ${unpriced.length === 0 ? 'none' : unpriced.map(([m, n]) => `${m} (${n} calls)`).join(', ')}`,
    ].join('\n'),
  );
  return out.join('\n') + '\n';
}
