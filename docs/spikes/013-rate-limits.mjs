// Spike 013 (W157, the plan's percentages): probes (a) and (c).
// usage: node docs/spikes/013-rate-limits.mjs a|c
//   a: one short Haiku call with stream-json; prints each `rate_limit_event`'s `rate_limit_info`
//   c: `/usage` over stdin; prints `usage_report.rate_limits` and what the call cost
// Prints event types, rate-limit fields and the cost only, never the model's or `/usage`'s text.
// Probe (b) is the status line command beside this file, 013-rate-limits-statusline.mjs.
import { spawnSync } from 'node:child_process';

const probe = process.argv[2];
if (probe !== 'a' && probe !== 'c') throw new Error('usage: 013-rate-limits.mjs a|c');
const args = [
  '-p', '--no-session-persistence', '--model', 'haiku', '--max-turns', '1',
  '--output-format', 'stream-json', '--verbose',
  '--tools', '', '--setting-sources', '', '--strict-mcp-config',
  '--name', `pitwall-test-013${probe}`,
];
const input = probe === 'a' ? 'Reply with OK.' : '/usage';
const run = spawnSync('claude', args, { input, encoding: 'utf8' });
if (run.status !== 0) throw new Error(`claude exited ${run.status}`);
const events = run.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
console.log('events:', events.map((e) => `${e.type}${e.subtype ? `:${e.subtype}` : ''}`).join(' '));
for (const e of events) {
  if (e.type === 'rate_limit_event') console.log('rate_limit_info:', JSON.stringify(e.rate_limit_info));
  if (e.type === 'assistant' && probe === 'c') {
    console.log('model:', e.message?.model);
    console.log('usage_report.rate_limits:', JSON.stringify(e.usage_report?.rate_limits ?? null));
  }
}
const result = events.find((e) => e.type === 'result');
console.log('cost:', result?.total_cost_usd, 'turns:', result?.num_turns, 'api ms:', result?.duration_api_ms,
  'tokens:', JSON.stringify({ in: result?.usage?.input_tokens, write: result?.usage?.cache_creation_input_tokens, read: result?.usage?.cache_read_input_tokens, out: result?.usage?.output_tokens }));
