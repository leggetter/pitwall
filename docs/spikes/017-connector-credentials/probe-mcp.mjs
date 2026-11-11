// Throwaway MCP server for spike 017. It records how a credential reaches a server, never a real one:
// `stdio` logs the names of the environment variables it was given, and whether PROBE_TOKEN equals PROBE_EXPECT;
// `http <port>` logs, per request, whether the Authorization header equals `Bearer <PROBE_EXPECT>`.
// Run only with made-up values. Logs go to PROBE_LOG.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
const log = (o) => appendFileSync(process.env.PROBE_LOG ?? '/dev/null', JSON.stringify(o) + '\n');
const expect = process.env.PROBE_EXPECT ?? '';
const tools = [{ name: 'probe_read', description: 'Read nothing (probe).', inputSchema: { type: 'object', properties: {} } }];
const answer = (m) => {
  if (m.method === 'initialize') return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0' } } };
  if (m.method === 'tools/list') return { jsonrpc: '2.0', id: m.id, result: { tools } };
  if (m.method === 'tools/call') return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'nothing' }] } };
  if (m.id !== undefined) return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } };
  return undefined;
};
if (process.argv[2] === 'http') {
  createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers.authorization ?? null;
      log({ method: req.method, path: req.url, auth: auth === null ? 'absent' : auth === `Bearer ${expect}` ? 'expected' : auth === 'Bearer ' ? 'empty' : 'other' });
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      if (auth !== `Bearer ${expect}`) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}'); return; }
      const reply = answer(JSON.parse(body));
      if (!reply) { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
  }).listen(Number(process.argv[3]), '127.0.0.1');
} else {
  log({ envNames: Object.keys(process.env).sort(), token: process.env.PROBE_TOKEN === undefined ? 'absent' : process.env.PROBE_TOKEN === expect ? 'expected' : 'other' });
  createInterface({ input: process.stdin }).on('line', (line) => { const r = answer(JSON.parse(line)); if (r) process.stdout.write(JSON.stringify(r) + '\n'); });
}
