// Throwaway stdio MCP server for spike 022. Not a connector: no data, no network.
// Tools: fake_read (annotated readOnly; takes 8 s, so a late tool can arrive mid-turn),
// fake_write, and, after the first tools/list plus 4 s, fake_late_write, announced with
// notifications/tools/list_changed. With FAKE_ROLE=prompt it is the permission prompt tool
// instead: `approve` logs its input and denies, as pitwall's approve does for anything unlisted.
// Every call is appended to FAKE_LOG, so a run shows whether a tool was ever reached.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = (m) => appendFileSync(process.env.FAKE_LOG ?? '/dev/null', m + '\n');
const prompt = process.env.FAKE_ROLE === 'prompt';
const base = [
  { name: 'fake_read', description: 'Read a fake record. Read-only.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'fake_write', description: 'Write a fake record.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
];
const late = { name: 'fake_late_write', description: 'Write a fake record (appears mid-turn).', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
const approve = { name: 'approve', description: 'Permission prompt.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } } } };
let lateOn = false;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '0' } } });
  else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: prompt ? [approve] : lateOn ? [...base, late] : base } });
    if (!prompt && !lateOn) setTimeout(() => { lateOn = true; log('LIST_CHANGED sent'); send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); }, 4000);
  } else if (m.method === 'tools/call') {
    log(`${prompt ? 'PROMPTED' : 'CALLED'} ${m.params.name} ${JSON.stringify(m.params.arguments).slice(0, 120)}`);
    const reply = () => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: prompt ? JSON.stringify({ behavior: 'deny', message: 'pitwall: not allowed' }) : 'ok (fake)' }] } });
    if (m.params.name === 'fake_read') setTimeout(reply, 8000); else reply();
  } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
});
