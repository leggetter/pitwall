// Listing a connector's tools (W184) and the launcher that starts a stdio connector with only its
// named variables. Against the throwaway server in src/test/fakeConnector.mjs and a fake fetch: never a
// real service.
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { launchPlan } from './connectorLauncher.mjs';
import { defaultConnectorLauncher } from './connectorServer.js';
import { formatToolListing, listConnectorTools, listingNotice, listsThroughClaude, listToolsThroughClaude, plainLine, readInit, readTools, signInInstructions, sseMessages } from './connectorTools.js';

const FAKE = fileURLToPath(new URL('../test/fakeConnector.mjs', import.meta.url));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-connectors-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('connectorLauncher.mjs', () => {
  it('keeps PATH and the variables --keep names, and nothing else', () => {
    expect(launchPlan(['--keep', 'SLACK_BOT_TOKEN', '--', 'npx', '-y', 'x'], { PATH: '/usr/bin', SLACK_BOT_TOKEN: 's', ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_MESSAGING_TOKEN: 'm' })).toEqual({
      ok: true,
      command: 'npx',
      args: ['-y', 'x'],
      env: { PATH: '/usr/bin', SLACK_BOT_TOKEN: 's' },
    });
    expect(launchPlan(['--', 'node'], { HOME: '/h' })).toEqual({ ok: true, command: 'node', args: [], env: {} });
    for (const bad of [['node'], ['--keep'], ['--keep', 'A B', '--', 'x'], ['--keep', 'A'], ['--keep', 'A', '--'], ['--other', 'A', '--', 'x']]) {
      expect(launchPlan(bad, {}).ok, bad.join(' ')).toBe(false);
    }
  });

  it('starts the server with only those variables, whatever its own environment holds', async () => {
    const log = path.join(scratch, 'env-names.txt');
    const launcher = defaultConnectorLauncher();
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        launcher.node,
        [launcher.script, '--keep', 'FAKE_NAMED', '--', process.execPath, FAKE, '--env-log', log],
        { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_NAMED: '1', ANTHROPIC_API_KEY: 'made-up', CLAUDE_CODE_MESSAGING_SOCKET: '/made-up.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'made-up', CLAUDECODE: '1', PITWALL_TOKEN: 'made-up' }, timeout: 10_000 },
        (error) => (error === null || error.killed === false ? resolve() : reject(error)),
      );
      child.stdin?.end();
    });
    const names = readFileSync(log, 'utf8').trim().split('\n');
    // Node may add none of its own; the kept two are there and nothing pitwall's or Claude Code's is.
    expect(names).toContain('PATH');
    expect(names).toContain('FAKE_NAMED');
    expect(names.filter((name) => /ANTHROPIC|CLAUDE|PITWALL/.test(name))).toEqual([]);
    // The supervisor's cross-session messaging, which a connector could otherwise use to message a
    // session without your click (spike 017, finding 6).
    expect(names).not.toContain('CLAUDE_CODE_MESSAGING_SOCKET');
    expect(names).not.toContain('CLAUDE_CODE_MESSAGING_TOKEN');
  });
});

describe('listConnectorTools(): stdio', () => {
  it('asks the server for its tools, every page, with each name checked and each description one plain line', async () => {
    const listing = await listConnectorTools({ kind: 'stdio', command: process.execPath, args: [FAKE], env: [] }, { env: { PATH: process.env.PATH }, timeoutMs: 10_000 });
    expect(listing).toEqual({
      ok: true,
      unusable: 0,
      tools: [
        { name: 'fake_search', readOnlyHint: true, description: 'Search the fake workspace. [31m (read-only)' },
        { name: 'fake_read_thread', readOnlyHint: true, description: 'Read a fake thread.' },
        { name: 'fake_post', readOnlyHint: false, description: 'Post a message to the fake workspace (write).' },
        // As Claude Code shows it, so it can be kept out.
        { name: 'bad_name_with_spaces', readOnlyHint: false, description: 'A name Claude Code shows with _ for each space.' },
      ],
    });
  });

  it('says what’s missing, or that the command failed, with no value', async () => {
    expect(await listConnectorTools({ kind: 'stdio', command: process.execPath, args: [FAKE], env: ['FAKE_SECRET'] }, { env: {} })).toEqual({ ok: false, error: "pitwall's environment has no FAKE_SECRET, which the connector's server needs." });
    const gone = await listConnectorTools({ kind: 'stdio', command: '/made-up/not-there', args: [], env: [] }, { env: { PATH: '/usr/bin' }, timeoutMs: 5000 });
    expect(gone.ok).toBe(false);
    const exits = await listConnectorTools({ kind: 'stdio', command: process.execPath, args: ['-e', 'process.exit(3)'], env: [] }, { env: { PATH: process.env.PATH }, timeoutMs: 5000 });
    expect(exits).toEqual({ ok: false, error: "the connector's command exited with code 3 before it answered." });
  });
});

describe('listConnectorTools(): HTTP', () => {
  const tools = [
    { name: 'search', annotations: { readOnlyHint: true } },
    { name: 'create_page', description: 'Create a page.' },
  ];

  it('initializes, keeps the session id, reads JSON and event-stream answers, sends the headers and follows no redirect', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      const body = JSON.parse(String(init!.body)) as { id?: number; method: string };
      if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'made-up-session' } });
      if (body.id === undefined) return new Response(null, { status: 202 });
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    const listing = await listConnectorTools({ kind: 'http', url: 'https://mcp.made-up.example/mcp', headers: { Authorization: 'Bearer ${NOTION_API_KEY}' } }, { env: { NOTION_API_KEY: 'made-up-key' }, fetch: fake });
    expect(listing).toEqual({ ok: true, unusable: 0, tools: [{ name: 'search', readOnlyHint: true, description: '' }, { name: 'create_page', readOnlyHint: false, description: 'Create a page.' }] });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.url).toBe('https://mcp.made-up.example/mcp');
      expect(call.init.redirect).toBe('error');
      expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer made-up-key');
    }
    expect((calls[2]!.init.headers as Record<string, string>)['Mcp-Session-Id']).toBe('made-up-session');
  });

  it('says when the credentials were refused, or a variable is missing', async () => {
    const refused: typeof fetch = async () => new Response('no', { status: 401 });
    const server = { kind: 'http' as const, url: 'https://mcp.made-up.example/mcp', headers: { Authorization: 'Bearer ${NOTION_API_KEY}' } };
    expect(await listConnectorTools(server, { env: { NOTION_API_KEY: 'k' }, fetch: refused })).toEqual({ ok: false, error: "the server refused pitwall's credentials (HTTP 401)." });
    expect(await listConnectorTools(server, { env: {}, fetch: refused })).toEqual({ ok: false, error: "pitwall's environment has no NOTION_API_KEY, which the connector's headers need." });
  });
});

describe('listToolsThroughClaude(): an OAuth connector (route 1, spike 017)', () => {
  const server = { kind: 'http' as const, url: 'https://mcp.made-up.example/mcp', headers: {}, oauth: { clientId: '1234.5678', callbackPort: 3118 } };

  /** A stand-in for claude: records its arguments and MCP config, then prints a system/init. */
  function fakeClaude(init: Record<string, unknown>): { bin: string; seen: string } {
    const dir = mkdtempSync(path.join(scratch, 'claude-'));
    const bin = path.join(dir, 'fake-claude');
    const seen = path.join(dir, 'seen.json');
    writeFileSync(
      bin,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--mcp-config') + 1];
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args, mode: fs.statSync(file).mode & 0o777, config: JSON.parse(fs.readFileSync(file, 'utf8')), env: Object.keys(process.env) }));
process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + '\\n');
setTimeout(() => {}, 10000);
`,
    );
    chmodSync(bin, 0o755);
    return { bin, seen };
  }

  it('runs claude under the strict flags with this connector alone, in a 0600 config, and reads its tools from system/init', async () => {
    const { bin, seen } = fakeClaude({ type: 'system', subtype: 'init', tools: ['mcp__notion__notion-search', 'mcp__notion__notion-create-pages', 'mcp__other__x'], mcp_servers: [{ name: 'notion', status: 'connected' }] });
    const listing = await listToolsThroughClaude('notion', server, { claudeBin: bin, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'made-up' }, timeoutMs: 10_000 });
    expect(listing).toEqual({ ok: true, unusable: 0, tools: [{ name: 'notion-search', readOnlyHint: false, description: '' }, { name: 'notion-create-pages', readOnlyHint: false, description: '' }] });
    const run = JSON.parse(readFileSync(seen, 'utf8')) as { args: string[]; mode: number; config: unknown };
    const value = (flag: string) => run.args[run.args.indexOf(flag) + 1];
    expect(value('--tools')).toBe('');
    expect(value('--setting-sources')).toBe('');
    expect(run.args).toContain('--strict-mcp-config');
    expect(run.args).toContain('--no-session-persistence');
    expect(value('--model')).toBe('haiku');
    expect(value('--permission-mode')).toBe('default');
    expect(run.mode).toBe(0o600);
    // The entry the supervisor uses, with no headers, so it finds the same sign-in.
    expect(run.config).toEqual({ mcpServers: { notion: { type: 'http', url: 'https://mcp.made-up.example/mcp', oauth: { clientId: '1234.5678', callbackPort: 3118 }, timeout: 60_000 } } });
  });

  it('says when it isn’t signed in, and how to sign in with the same entry', async () => {
    const { bin } = fakeClaude({ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'notion', status: 'needs-auth' }] });
    expect(await listToolsThroughClaude('notion', server, { claudeBin: bin, env: { PATH: process.env.PATH }, timeoutMs: 10_000 })).toEqual({ ok: false, needsAuth: true, error: "the connector notion isn't signed in." });
    const text = signInInstructions('notion', server, { node: '/n', script: '/s' });
    expect(text).toContain(`'{"mcpServers":{"notion":{"type":"http","url":"https://mcp.made-up.example/mcp","oauth":{"clientId":"1234.5678","callbackPort":3118},"timeout":60000}}}' > notion.json`);
    expect(text).toContain('claude --strict-mcp-config --mcp-config notion.json');
    expect(readInit('notion', { mcp_servers: [{ name: 'notion', status: 'failed' }] })).toEqual({ ok: false, error: 'Claude Code says the connector notion is failed.' });
    expect(listsThroughClaude(server)).toBe(true);
    expect(listsThroughClaude({ ...server, headers: { Authorization: 'Bearer ${X}' } })).toBe(false);
    expect(listsThroughClaude({ kind: 'stdio', command: 'x', args: [], env: [] })).toBe(false);
  });
});

describe('what --connector-tools prints', () => {
  it('marks the hint as the server’s claim, preselects the hinted tools, and says what changed since the config file’s lists', () => {
    const listing = { ok: true as const, unusable: 1, tools: [{ name: 'fake_search', readOnlyHint: true, description: 'Search.' }, { name: 'fake_post', readOnlyHint: false, description: '' }, { name: 'fake_new', readOnlyHint: false, description: '' }] };
    const text = formatToolListing({ name: 'fake', tools: ['fake_search', 'fake_gone'], otherTools: ['fake_post'] }, listing);
    expect(text).toContain("[read-only hint] is the server's own claim, not a check");
    expect(text).toContain('  [read-only hint] fake_search: Search.');
    expect(text).toContain('"tools": ["fake_search"],');
    expect(text).toContain('"otherTools": ["fake_post","fake_new"]');
    expect(text).toContain('New since your config file\'s lists: fake_new.');
    expect(text).toContain('No longer listed by the server: fake_gone.');
    expect(text).toContain("1 more had a name pitwall can't use");
    expect(listingNotice({ name: 'fake', server: { kind: 'stdio', command: 'npx', args: ['--secret-flag'], env: [] } })).toBe("pitwall will run the connector fake's command, npx, as you, to ask its server for its tools, and stop it after.");
    expect(listingNotice({ name: 'n', server: { kind: 'http', url: 'https://mcp.made-up.example/mcp?x=1', headers: {} } })).toContain('https://mcp.made-up.example,');
  });

  it('reads tools defensively and strips control, format and invisible characters', () => {
    expect(readTools([null, { name: 'a' }, { name: 'a' }, { name: 'x y' }, { name: 7 }, { name: 'x'.repeat(65) }, { name: '' }])).toEqual({
      tools: [{ name: 'a', readOnlyHint: false, description: '' }, { name: 'x_y', readOnlyHint: false, description: '' }],
      unusable: 4,
    });
    expect(plainLine('a\u0007b​c‮d\ne\u{E0041}f', 100)).toBe('a b c d e f');
    expect(plainLine('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(sseMessages('data: {"id":1}\n\nevent: x\ndata: not json\n\n')).toEqual([{ id: 1 }, undefined]);
  });
});
