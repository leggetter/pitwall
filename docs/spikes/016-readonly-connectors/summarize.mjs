// node summarize.mjs <out.jsonl>: what the init message listed, which tools the model used, what came back.
import { readFileSync } from 'node:fs';
const lines = readFileSync(process.argv[2], 'utf8').trim().split('\n').map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
const init = lines.find((x) => x.type === 'system' && x.subtype === 'init');
console.log('init tools:', JSON.stringify(init?.tools), 'mcp:', JSON.stringify(init?.mcp_servers), 'mode:', init?.permissionMode);
for (const x of lines) {
  if (x.type === 'assistant') for (const c of x.message.content) if (c.type === 'tool_use') console.log('tool_use', c.name);
  if (x.type === 'user') for (const c of x.message.content ?? []) if (c.type === 'tool_result') console.log('tool_result', c.is_error ? 'ERROR' : 'ok', JSON.stringify(c.content).slice(0, 160));
  if (x.type === 'result') console.log('result:', x.subtype, String(x.result).slice(0, 200));
}
