// Choosing a connector's tools (W184, D28): `pitwall --connector-tools <name>` asks the connector's
// server for its tools, once, and prints them, with the read-only ones its server hints at
// preselected, as the `tools` and `otherTools` to put in the config file. You keep the ones that
// read. pitwall never writes the config file (D24); you paste them in.
//
// It runs the connector's command, or calls its URL, only when you run that command, and says so
// first: it's the one way pitwall starts a connector outside the supervisor. A stdio server runs with
// only the variables its entry names and the absolute PATH (connectorEnvironment()), no shell, in a
// fresh 0700 folder of its own that's removed after, in a process group of its own that gets SIGTERM
// and then SIGKILL when the listing is done or times out. An HTTP server is called with its headers,
// following no redirect, so a header's secret goes to that host alone.
//
// An HTTP connector with no headers is one Claude Code signs in to with OAuth (route 1, spike 017),
// whose sign-in pitwall never sees. Its tools are listed through Claude Code itself instead: one
// `claude -p` under the supervisor's strict flags, with no tools of its own and this connector alone in
// a 0600 MCP config, on Haiku, stopped as soon as its system/init lists the connector's tools, before or
// just after its one short model call. Names only: init has no hints or descriptions. A connector that
// isn't signed in comes back `needs-auth`, and pitwall prints how to sign in, once, with that same entry.
//
// What the server says is someone else's text: names are checked against CONNECTOR_TOOL_PATTERN,
// descriptions cut to one plain line without control, format or invisible characters before they
// reach your terminal, and its read-only hint only preselects (spike 016, finding 4).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relayEnvironment } from '../server/relay.js';
import { CONNECTOR_TOOL_PATTERN, type SupervisorConnector } from './connectors.js';
import {
  type ConnectorLauncher,
  type ConnectorServer,
  connectorEnvironment,
  defaultConnectorLauncher,
  describeServer,
  EXPANSION,
  type HttpConnectorServer,
  resolveConnectorServer,
  resolveHeaders,
} from './connectorServer.js';

/** One tool the server listed. */
export interface ListedTool {
  name: string;
  /** The server's own `annotations.readOnlyHint`: preselects, never decides. */
  readOnlyHint: boolean;
  /** One plain line, at most DESCRIPTION_MAX characters. */
  description: string;
  /**
   * It takes a URL or URI, or says it fetches one (W186's F1): a "read" that sends what the model puts
   * in it to any address, so never one to choose. Never preselected.
   */
  takesUrl: boolean;
}

/** A property's name that is a URL, URI or link. */
const URL_PROPERTY = /(?:^|[_-])(?:url|uri|href|link|endpoint)s?$|(?:Url|Uri|URL|URI|Href|Link|Endpoint)s?$/;

/** A description that says the tool fetches an address. */
const FETCHES_URL = /\b(?:fetch|fetches|download|downloads|open|opens|visit|visits|request|requests|get|gets)\b[^.]{0,60}\b(?:url|uri|link|web ?page|website|address)/i;

/** Whether a tool's input schema or description says it takes, or fetches, a URL. */
export function takesUrl(item: Record<string, unknown>): boolean {
  const schema = isRecord(item.inputSchema) ? item.inputSchema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [name, property] of Object.entries(properties)) {
    if (URL_PROPERTY.test(name)) return true;
    if (isRecord(property) && (property.format === 'uri' || property.format === 'url' || property.format === 'iri')) return true;
  }
  return typeof item.description === 'string' && FETCHES_URL.test(item.description);
}

export type ToolListing = { ok: true; tools: ListedTool[]; unusable: number; schemas?: false } | { ok: false; error: string };

/** The MCP protocol version pitwall asks for. A server answers with the one it speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

const DESCRIPTION_MAX = 160;
const MAX_PAGES = 20;
const MAX_TOOLS_LISTED = 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ListToolsOptions {
  /** Where the variables' values come from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** For an HTTP server. Default globalThis.fetch. */
  fetch?: typeof fetch;
  /** pitwall's version, sent as the MCP client's. */
  version?: string;
}

/** Asks `server` for its tools. Never rejects. */
export async function listConnectorTools(server: ConnectorServer, options: ListToolsOptions = {}): Promise<ToolListing> {
  const env = options.env ?? process.env;
  const missing = server.kind === 'stdio' ? server.env.filter((name) => env[name] === undefined) : [];
  if (missing.length > 0) return { ok: false, error: `pitwall's environment has no ${missing.join(', ')}, which the connector's server needs.` };
  const client = server.kind === 'stdio' ? stdioClient(server, env, options) : httpClient(server, env, options);
  if ('error' in client) return { ok: false, error: client.error };
  try {
    const init = await client.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'pitwall', version: options.version ?? '0' } });
    if (!isRecord(init)) return { ok: false, error: "the server's answer to initialize wasn't one pitwall could read." };
    client.protocolVersion = typeof init.protocolVersion === 'string' && /^[0-9-]{1,20}$/.test(init.protocolVersion) ? init.protocolVersion : MCP_PROTOCOL_VERSION;
    await client.notify('notifications/initialized');
    const raw: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.request('tools/list', cursor === undefined ? {} : { cursor });
      if (!isRecord(result) || !Array.isArray(result.tools)) return { ok: false, error: "the server's list of tools wasn't one pitwall could read." };
      raw.push(...result.tools);
      if (raw.length > MAX_TOOLS_LISTED) return { ok: false, error: `the server listed more than ${MAX_TOOLS_LISTED} tools.` };
      cursor = typeof result.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    return { ok: true, ...readTools(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof ListingError ? error.message : 'the server stopped answering.' };
  } finally {
    client.close();
  }
}

/**
 * A tool's name as Claude Code shows it in `mcp__<server>__<tool>`: each character other than a letter,
 * a digit, `_` or `-` as `_` (seen on 2.1.322: "bad name with spaces" became `bad_name_with_spaces`).
 */
export function claudeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * The tools from a `tools/list` answer: each name as Claude Code shows it and checked, its hint and a
 * plain description. Duplicates once. A name that still isn't one pitwall can use is counted.
 */
export function readTools(raw: readonly unknown[]): { tools: ListedTool[]; unusable: number } {
  const tools: ListedTool[] = [];
  const seen = new Set<string>();
  let unusable = 0;
  for (const item of raw) {
    const name = isRecord(item) && typeof item.name === 'string' ? claudeToolName(item.name) : '';
    if (!isRecord(item) || !CONNECTOR_TOOL_PATTERN.test(name)) {
      unusable++;
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const annotations = isRecord(item.annotations) ? item.annotations : {};
    tools.push({ name, readOnlyHint: annotations.readOnlyHint === true, description: plainLine(typeof item.description === 'string' ? item.description : '', DESCRIPTION_MAX), takesUrl: takesUrl(item) });
  }
  return { tools, unusable };
}

/**
 * What `pitwall --connector-tools` prints: each tool, the hinted ones marked, then the two lists to
 * put in the config file, the hinted tools preselected as `tools`.
 */
export function formatToolListing(connector: Pick<SupervisorConnector, 'name' | 'tools' | 'otherTools'> | { name: string }, listing: Extract<ToolListing, { ok: true }>): string {
  const lines: string[] = [];
  const name = connector.name;
  lines.push(`${name}: ${listing.tools.length} tool${listing.tools.length === 1 ? '' : 's'}, named as Claude Code shows them. [read-only hint] is the server's own claim, not a check: keep only the tools that read.`);
  lines.push('');
  for (const tool of listing.tools) {
    const mark = tool.takesUrl ? '[takes a URL]    ' : tool.readOnlyHint ? '[read-only hint] ' : '                 ';
    lines.push(`  ${mark}${tool.name}${tool.description === '' ? '' : `: ${tool.description}`}`);
  }
  if (listing.tools.some((tool) => tool.takesUrl)) {
    lines.push('');
    lines.push("  [takes a URL]: the tool takes a URL or link, or says it fetches one. Don't choose it, even if it only reads: what the supervisor puts in it, which could be your sessions' text, goes to whatever address it names, with no card.");
  }
  if (listing.schemas === false) {
    lines.push('');
    lines.push("  Listed through Claude Code, which shows names only: no hints, descriptions or inputs. Check each tool's inputs in the service's docs, and don't choose one that takes a URL or fetches one.");
  }
  if (listing.unusable > 0) {
    lines.push('');
    lines.push(`  ${listing.unusable} more had a name pitwall can't use (letters, digits, _ and - only, at most 64), so the supervisor would stop if it saw them. Don't turn this connector on unless that's fixed.`);
  }
  const chosen = listing.tools.filter((tool) => tool.readOnlyHint && !tool.takesUrl).map((tool) => tool.name);
  const others = listing.tools.filter((tool) => !tool.readOnlyHint || tool.takesUrl).map((tool) => tool.name);
  lines.push('');
  lines.push(`For the connector "${name}" in supervisor.connectors, move each tool that only reads into "tools", and leave the rest in "otherTools":`);
  lines.push('');
  lines.push(`  "tools": ${JSON.stringify(chosen)},`);
  lines.push(`  "otherTools": ${JSON.stringify(others)}`);
  if ('tools' in connector) {
    const listed = new Set(listing.tools.map((tool) => tool.name));
    const known = new Set([...connector.tools, ...connector.otherTools]);
    const added = listing.tools.filter((tool) => !known.has(tool.name)).map((tool) => tool.name);
    const gone = [...known].filter((tool) => !listed.has(tool));
    lines.push('');
    if (added.length === 0 && gone.length === 0) lines.push('The config file already names every one of these tools.');
    if (added.length > 0) lines.push(`New since your config file's lists: ${added.join(', ')}. Until they're in "tools" or "otherTools", the supervisor stops at its next turn.`);
    if (gone.length > 0) lines.push(`No longer listed by the server: ${gone.join(', ')}.`);
  }
  return `${lines.join('\n')}\n`;
}

/** Whether pitwall lists a connector's tools through Claude Code: an HTTP one with no headers, signed in with OAuth (route 1). */
export function listsThroughClaude(server: ConnectorServer): server is HttpConnectorServer {
  return server.kind === 'http' && Object.keys(server.headers).length === 0;
}

/** What `pitwall --connector-tools` says before it runs anything. */
export function listingNotice(connector: Pick<SupervisorConnector, 'name' | 'server'>): string {
  if (listsThroughClaude(connector.server)) {
    return `pitwall will run claude -p on Haiku, with no tools and only the connector ${connector.name}, ${describeServer(connector.server)}, to see its tools as the supervisor would, using the sign-in Claude Code keeps for it, and stop it once they're listed.`;
  }
  return connector.server.kind === 'stdio'
    ? `pitwall will run the connector ${connector.name}'s command, ${describeServer(connector.server)}, as you, to ask its server for its tools, and stop it after.`
    : `pitwall will call the connector ${connector.name}'s server, ${describeServer(connector.server)}, with its headers, to ask for its tools.`;
}

/**
 * How to sign in to an OAuth connector, once, so Claude Code keeps the sign-in where the supervisor's
 * runs find it: an interactive session with the same entry under the same name (spike 017, Needs
 * Phil). The entry is pitwall's own, as connectorServer.ts's httpEntry() makes it.
 */
export function signInInstructions(name: string, server: HttpConnectorServer, launcher: ConnectorLauncher = defaultConnectorLauncher()): string {
  const resolved = resolveConnectorServer(server, {}, launcher);
  const entry = resolved.ok ? resolved.entry : {};
  const json = JSON.stringify({ mcpServers: { [name]: entry } }).replace(/'/g, "'\\''");
  return [
    `The connector ${name} needs a sign-in, which Claude Code keeps, never pitwall. Once, in a terminal:`,
    '',
    '  mkdir -p ~/pitwall-connector-signin && cd ~/pitwall-connector-signin',
    `  printf '%s\\n' '${json}' > ${name}.json`,
    `  claude --setting-sources '' --strict-mcp-config --mcp-config ${name}.json`,
    '',
    `In that session, run /mcp, choose ${name}, then Authenticate, and approve in the browser; then /exit.`,
    `Then run pitwall --connector-tools ${name} again. A change to its URL or name in the config file needs a new sign-in.`,
  ].join('\n');
}

/** The answer from listing through Claude Code: as listConnectorTools()'s, or not signed in. */
export type ClaudeToolListing = ToolListing | { ok: false; needsAuth: true; error: string };

export interface ClaudeListingOptions {
  /** Default 'claude'. */
  claudeBin?: string;
  /** What claude's environment is made from (relayEnvironment()). Default process.env. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  launcher?: ConnectorLauncher;
}

/** Lists an OAuth connector's tools as Claude Code sees them, with the sign-in it keeps. Never rejects. */
export async function listToolsThroughClaude(name: string, server: HttpConnectorServer, options: ClaudeListingOptions = {}): Promise<ClaudeToolListing> {
  const resolved = resolveConnectorServer(server, options.env ?? process.env, options.launcher ?? defaultConnectorLauncher());
  if (!resolved.ok || JSON.stringify(resolved.entry).includes(EXPANSION)) return { ok: false, error: "the connector's entry couldn't be written for Claude Code." };
  let dir: string;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pitwall-connector-'));
    writeFileSync(path.join(dir, 'mcp.json'), `${JSON.stringify({ mcpServers: { [name]: resolved.entry } })}\n`, { mode: 0o600, flag: 'wx' });
  } catch {
    return { ok: false, error: "pitwall couldn't write the connector's MCP config for Claude Code." };
  }
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    'haiku',
    '--max-turns',
    '1',
    '--no-session-persistence',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    path.join(dir, 'mcp.json'),
    '--permission-mode',
    'default',
    '--',
    'Reply with OK.',
  ];
  const timeoutMs = options.timeoutMs ?? 90_000;
  return new Promise<ClaudeToolListing>((resolve) => {
    let child: ChildProcess;
    let done = false;
    const finish = (answer: ClaudeToolListing) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        // Gone already.
      }
      rmSync(dir, { recursive: true, force: true });
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `Claude Code didn't list the connector's tools within ${Math.round(timeoutMs / 1000)} seconds.` }), timeoutMs);
    try {
      child = spawn(options.claudeBin ?? 'claude', args, { cwd: dir, env: relayEnvironment(options.env ?? process.env), stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    } catch {
      finish({ ok: false, error: "pitwall couldn't start claude." });
      return;
    }
    let buffer = '';
    let bytes = 0;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) return finish({ ok: false, error: 'Claude Code wrote more than pitwall reads.' });
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at !== -1 && !done; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(event) || event.type !== 'system' || event.subtype !== 'init') continue;
        finish(readInit(name, event));
      }
    });
    child.on('error', () => finish({ ok: false, error: "pitwall couldn't start claude." }));
    child.on('exit', () => finish({ ok: false, error: 'Claude Code exited before it listed its tools.' }));
  });
}

/** A system/init event's answer for one connector: its status, and its tools' names without the `mcp__<name>__` prefix. */
export function readInit(name: string, event: Record<string, unknown>): ClaudeToolListing {
  const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
  const server = servers.find((entry) => isRecord(entry) && entry.name === name);
  const status = isRecord(server) && typeof server.status === 'string' ? server.status : 'missing';
  if (status === 'needs-auth') return { ok: false, needsAuth: true, error: `the connector ${name} isn't signed in.` };
  if (status !== 'connected') return { ok: false, error: `Claude Code says the connector ${name} is ${plainLine(status, 40)}.` };
  const prefix = `mcp__${name}__`;
  const tools = Array.isArray(event.tools) ? event.tools.filter((tool): tool is string => typeof tool === 'string' && tool.startsWith(prefix)) : [];
  return { ok: true, ...readTools(tools.map((tool) => ({ name: tool.slice(prefix.length) }))), schemas: false };
}

class ListingError extends Error {}

interface Client {
  protocolVersion?: string;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string): Promise<void>;
  close(): void;
}

function stdioClient(server: Extract<ConnectorServer, { kind: 'stdio' }>, env: NodeJS.ProcessEnv, options: ListToolsOptions): Client | { error: string } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cwd: string;
  try {
    cwd = mkdtempSync(path.join(os.tmpdir(), 'pitwall-connector-'));
  } catch {
    return { error: "pitwall couldn't make a folder to run the connector's command in." };
  }
  let child: ChildProcess;
  try {
    child = spawn(server.command, server.args, { cwd, env: connectorEnvironment(server, env), stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  } catch {
    rmSync(cwd, { recursive: true, force: true });
    return { error: "pitwall couldn't start the connector's command." };
  }
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let failure: string | undefined;
  const failAll = (message: string) => {
    failure ??= message;
    for (const entry of waiting.values()) entry.reject(new ListingError(failure));
    waiting.clear();
  };
  let buffer = '';
  let bytes = 0;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) return failAll('the server wrote more than pitwall reads.');
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      settle(message, waiting);
    }
  });
  child.on('error', (error: NodeJS.ErrnoException) => failAll(`pitwall couldn't start the connector's command (${error.code ?? 'error'}).`));
  child.on('exit', (code) => failAll(`the connector's command exited${code === null ? '' : ` with code ${code}`} before it answered.`));
  child.stdin?.on('error', () => undefined);
  const timer = setTimeout(() => failAll(`the server didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`), timeoutMs);
  let nextId = 1;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Gone already.
    }
  };
  return {
    request(method, params) {
      if (failure !== undefined) return Promise.reject(new ListingError(failure));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method) {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
      return Promise.resolve();
    },
    close() {
      clearTimeout(timer);
      failure ??= 'closed';
      child.stdin?.end();
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 2000).unref();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function settle(message: unknown, waiting: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>): void {
  if (!isRecord(message) || typeof message.id !== 'number') return;
  const entry = waiting.get(message.id);
  if (entry === undefined) return;
  waiting.delete(message.id);
  if (isRecord(message.error)) entry.reject(new ListingError(`the server answered with an error${typeof message.error.code === 'number' ? ` (${message.error.code})` : ''}.`));
  else entry.resolve(message.result);
}

function httpClient(server: Extract<ConnectorServer, { kind: 'http' }>, env: NodeJS.ProcessEnv, options: ListToolsOptions): Client | { error: string } {
  const headers = resolveHeaders(server, env);
  if (!headers.ok) return { error: `pitwall's environment has no ${headers.missing.join(', ')}, which the connector's headers need.` };
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let session: string | undefined;
  let nextId = 1;
  const client: Client = {
    async request(method, params) {
      const id = nextId++;
      const text = await post(doFetch, server.url, headers.headers, session, client.protocolVersion, { jsonrpc: '2.0', id, method, params }, timeoutMs, (value) => {
        session ??= value;
      });
      const messages = text.type === 'sse' ? sseMessages(text.body) : [parseJson(text.body)];
      const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        for (const message of messages) settle(message, waiting);
        if (waiting.has(id)) reject(new ListingError(`the server's answer to ${method} had no result pitwall could read.`));
      });
    },
    async notify(method) {
      await post(doFetch, server.url, headers.headers, session, client.protocolVersion, { jsonrpc: '2.0', method }, timeoutMs, () => undefined);
    },
    close() {},
  };
  return client;
}

async function post(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  session: string | undefined,
  protocolVersion: string | undefined,
  body: unknown,
  timeoutMs: number,
  onSession: (id: string) => void,
): Promise<{ type: 'json' | 'sse'; body: string }> {
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      // A redirect would take the headers, and their secret, to another URL.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(session === undefined ? {} : { 'Mcp-Session-Id': session }),
        ...(protocolVersion === undefined ? {} : { 'MCP-Protocol-Version': protocolVersion }),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ListingError("pitwall couldn't reach the server, or it redirected, which pitwall doesn't follow.");
  }
  if (response.status === 401 || response.status === 403) throw new ListingError(`the server refused pitwall's credentials (HTTP ${response.status}).`);
  if (!response.ok) throw new ListingError(`the server answered HTTP ${response.status}.`);
  const id = response.headers.get('mcp-session-id');
  if (id !== null && /^[\x21-\x7E]{1,256}$/.test(id)) onSession(id);
  const text = await cappedText(response);
  return { type: (response.headers.get('content-type') ?? '').includes('text/event-stream') ? 'sse' : 'json', body: text };
}

async function cappedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_OUTPUT_BYTES) {
      await reader.cancel();
      throw new ListingError('the server wrote more than pitwall reads.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The JSON messages in a text/event-stream body: each event's `data:` lines, joined. */
export function sseMessages(body: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data !== '') messages.push(parseJson(data));
  }
  return messages;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One plain line: control, format and invisible characters and line breaks as spaces, cut to `max`. */
export function plainLine(text: string, max: number): string {
  const flat = text
    .slice(0, max * 4)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
