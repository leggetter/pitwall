// Throwaway stdio MCP server: one read tool, one write tool. The write tool logs to FAKE_LOG so a run shows whether it was ever called.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = (m) => appendFileSync(process.env.FAKE_LOG ?? '/dev/null', m + '\n');
const tools = [
  { name: 'fake_search', description: 'Search the fake workspace (read-only).', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
  { name: 'fake_post', description: 'Post a message to the fake workspace (write).', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else if (m.method === 'tools/call') {
    log(`CALLED ${m.params.name} ${JSON.stringify(m.params.arguments)}`);
    const text = m.params.name === 'fake_search' ? 'Result: the launch is on Friday. (fake data)' : 'posted';
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } });
  } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
});
