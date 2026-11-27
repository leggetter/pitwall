// The supervisor's claude.ai connectors (W191, D28, spike 022): the connectors your Claude sessions already
// have, chosen by display name in `supervisor.connectors`, and the one module that talks to Claude Code
// about them.
//
// `mcp_status` is a stream-json control request that Claude Code answers with each MCP server's status
// and tool names and hints, with no model call. It's documented in the Agent SDK, not in the CLI
// reference, so it's an internal interface by AGENTS.md's rule: everything that reads it is here, and
// every failure is a `{ ok: false, error }`, never a throw. A caller that gets one runs the supervisor
// without the claude.ai connectors (it keeps `--strict-mcp-config`), and says why in its log.
//
// What a start does:
//   1. probeClaudeAi(): a `claude -p` with no turn, polling mcp_status until the chosen connectors have
//      settled or a bounded wait passes. It gives the account's connectors now and each one's tools.
//   2. planClaudeAi(): from that, the connectors to deny whole (`deniedMcpServers`: every claude.ai
//      connector that isn't chosen, one added on claude.ai since you wrote the config included, so it never
//      reaches the model: an unrestricted prompt of 782 tool definitions cost $0.62 a Haiku turn in spike
//      022), the chosen tools to allow, and every other tool of a chosen connector to disallow by exact
//      name. A deny beats an allow, so there is never a wildcard deny.
import { type RelayChild, type RelaySpawner } from '../server/relay.js';
import { type ClaudeAiConnector, CONNECTOR_TOOL_PATTERN, claudeAiServerName, claudeAiToolPrefix } from './connectors.js';

/** One tool as mcp_status lists it: its name, and the server's own `annotations.readOnly`, when it gave one. */
export interface ClaudeAiTool {
  name: string;
  /** True or false when the annotation is there, undefined when the tool has none. A hint, never a check. */
  readOnly: boolean | undefined;
}

/** One claude.ai connector as mcp_status lists it. */
export interface ClaudeAiServer {
  /** `claude.ai <Display name>`. */
  name: string;
  /** `connected`, `pending`, `needs-auth`, `failed`, ... as Claude Code says. */
  status: string;
  tools: ClaudeAiTool[];
}

export type ClaudeAiSnapshot = { ok: true; servers: ClaudeAiServer[] } | { ok: false; error: string };

/** What a start gets from the probe, for the names of the connectors you chose. Never rejects. */
export type ClaudeAiProbe = (chosen: readonly string[]) => Promise<ClaudeAiSnapshot>;

const NAME_PREFIX = 'claude.ai ';
const MAX_SERVERS = 200;
const MAX_TOOLS = 2000;
const MAX_LINE = 4 * 1024 * 1024;

/** The `mcp_status` request, as one stream-json line. */
export function mcpStatusLine(requestId: string): string {
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'mcp_status' } })}\n`;
}

/**
 * The claude.ai connectors in a stream-json `control_response` line's event, when it's the answer to
 * `requestId`: undefined for any other line, `{ ok: false }` when it's the answer but isn't usable.
 */
export function readMcpStatus(event: unknown, requestId: string): ClaudeAiSnapshot | undefined {
  if (!isRecord(event) || event.type !== 'control_response' || !isRecord(event.response) || event.response.request_id !== requestId) return undefined;
  if (event.response.subtype !== 'success') return { ok: false, error: 'Claude Code refused the mcp_status request.' };
  const body = event.response.response;
  const raw = isRecord(body) ? body.mcpServers : undefined;
  if (!Array.isArray(raw)) return { ok: false, error: "Claude Code's mcp_status answer wasn't in the shape pitwall reads." };
  const servers: ClaudeAiServer[] = [];
  for (const item of raw.slice(0, MAX_SERVERS)) {
    if (!isRecord(item) || typeof item.name !== 'string') continue;
    if (!item.name.startsWith(NAME_PREFIX) && item.source !== 'claudeai') continue;
    const prefix = claudeAiToolPrefix(item.name.slice(NAME_PREFIX.length));
    const tools: ClaudeAiTool[] = [];
    for (const tool of (Array.isArray(item.tools) ? item.tools : []).slice(0, MAX_TOOLS)) {
      if (!isRecord(tool) || typeof tool.name !== 'string') continue;
      const annotations = isRecord(tool.annotations) ? tool.annotations : {};
      const name = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
      tools.push({ name, readOnly: typeof annotations.readOnly === 'boolean' ? annotations.readOnly : undefined });
    }
    servers.push({ name: item.name, status: typeof item.status === 'string' ? item.status.slice(0, 40) : 'unknown', tools });
  }
  return { ok: true, servers };
}

/** The claude.ai connector settled: not `pending`. */
function settled(server: ClaudeAiServer | undefined): boolean {
  return server !== undefined && server.status !== 'pending';
}

export interface ProbeOptions {
  spawn: RelaySpawner;
  claudeBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The wait for the chosen connectors to settle. Default 15 seconds. */
  timeoutMs?: number;
  /** The gap between mcp_status requests. Default 1 second. */
  pollMs?: number;
}

/** What the probe runs: no turn, no tools, none of your settings, and every claude.ai connector's tools kept from a model that never runs. */
export function probeArgs(): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    'haiku',
    '--no-session-persistence',
    '--tools',
    '',
    '--permission-mode',
    'default',
    '--setting-sources',
    '',
    '--settings',
    JSON.stringify({ autoMemoryEnabled: false, crossSessionInbound: 'refuse' }),
    '--disallowed-tools',
    'mcp__claude_ai_*',
  ];
}

/**
 * The account's claude.ai connectors and their tools now, with no model turn (spike 022, finding 6): runs
 * `claude`, asks mcp_status once a second until every connector in `chosen` has settled (or, with none
 * chosen, until some connector is there and none is pending), or the wait ends, then stops it. At the end of
 * the wait it answers with what it has, so a connector still `pending` is the caller's to treat as down.
 */
export function probeClaudeAi(chosen: readonly string[], options: ProbeOptions): Promise<ClaudeAiSnapshot> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 1000;
  const wanted = chosen.map(claudeAiServerName);
  return new Promise<ClaudeAiSnapshot>((resolve) => {
    let child: RelayChild | undefined;
    let done = false;
    let pending: string | undefined;
    let n = 0;
    let latest: ClaudeAiSnapshot | undefined;
    let poll: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (answer: ClaudeAiSnapshot) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      try {
        child?.end();
        child?.kill('SIGTERM');
      } catch {
        // Gone already.
      }
      resolve(answer);
    };
    const ask = () => {
      pending = `pitwall-probe-${++n}`;
      try {
        child?.write(mcpStatusLine(pending));
      } catch {
        finish({ ok: false, error: "pitwall couldn't write to claude." });
      }
    };
    const ready = (snapshot: ClaudeAiSnapshot & { ok: true }) =>
      wanted.length > 0 ? wanted.every((name) => settled(snapshot.servers.find((server) => server.name === name))) : snapshot.servers.length > 0 && snapshot.servers.every((server) => settled(server));
    try {
      child = options.spawn(
        options.claudeBin,
        probeArgs(),
        { cwd: options.cwd, env: options.env },
        {
          line: (line) => {
            if (done || pending === undefined || line.length > MAX_LINE) return;
            let event: unknown;
            try {
              event = JSON.parse(line);
            } catch {
              return;
            }
            const answer = readMcpStatus(event, pending);
            if (answer === undefined) return;
            pending = undefined;
            if (!answer.ok) return finish(answer);
            latest = answer;
            if (ready(answer)) finish(answer);
          },
          stderr: () => undefined,
          error: (message) => finish({ ok: false, error: `pitwall couldn't start claude (${message.slice(0, 80)}).` }),
          exit: () => finish({ ok: false, error: 'Claude Code exited before it listed its connectors.' }),
        },
      );
    } catch {
      return finish({ ok: false, error: "pitwall couldn't start claude." });
    }
    timer = setTimeout(() => finish(latest ?? { ok: false, error: `Claude Code didn't list its connectors within ${Math.round(timeoutMs / 1000)} seconds.` }), timeoutMs);
    poll = setInterval(() => {
      if (pending === undefined) ask();
    }, pollMs);
    ask();
  });
}

/** What one start of the supervisor takes from the claude.ai connectors. */
export interface ClaudeAiPlan {
  /** `claude.ai <Name>` of each connector to deny whole, for `deniedMcpServers`. */
  denyServers: string[];
  /** The chosen tools that the connector lists, `mcp__claude_ai_<Name>__<tool>`: for `--allowed-tools` and the turn-start check. */
  allowed: string[];
  /** Every other tool of a chosen connector, by exact name, for `--disallowed-tools`. */
  disallowed: string[];
  /** The names (in config) of the connectors this start uses. */
  names: string[];
  /** The `mcp__claude_ai_<Name>__` prefixes of this start's connectors, for the turn-start check's message. */
  prefixes: string[];
  /** Things to say in the log, in pitwall's words. */
  notes: string[];
}

/**
 * The plan from a snapshot: undefined `plan` with `why` when no chosen connector is usable (the caller then
 * runs without them and keeps `--strict-mcp-config`). A chosen connector that isn't `connected`, or has a tool
 * whose name pitwall can't put in a deny list, is denied whole and left out of this start; the others go on.
 */
export function planClaudeAi(chosen: readonly ClaudeAiConnector[], snapshot: ClaudeAiSnapshot): { plan: ClaudeAiPlan; why?: undefined } | { plan?: undefined; why: string } {
  if (!snapshot.ok) return { why: snapshot.error };
  const plan: ClaudeAiPlan = { denyServers: [], allowed: [], disallowed: [], names: [], prefixes: [], notes: [] };
  const used = new Set<string>();
  for (const connector of chosen) {
    const serverName = claudeAiServerName(connector.claudeAi);
    const server = snapshot.servers.find((entry) => entry.name === serverName);
    if (server === undefined) {
      plan.notes.push(`its connector ${connector.name} (claude.ai ${connector.claudeAi}) isn't one your account lists, so it's off for this start.`);
      continue;
    }
    if (server.status !== 'connected') {
      plan.notes.push(`its connector ${connector.name} is ${server.status}, so it's off for this start.${server.status === 'needs-auth' ? ' Sign in to it on claude.ai or in a Claude Code session.' : ''}`);
      continue;
    }
    if (server.tools.some((tool) => !CONNECTOR_TOOL_PATTERN.test(tool.name))) {
      plan.notes.push(`its connector ${connector.name} lists a tool whose name pitwall can't put in a deny list, so it's off for this start.`);
      continue;
    }
    const prefix = claudeAiToolPrefix(connector.claudeAi);
    const listed = new Set(server.tools.map((tool) => tool.name));
    const chosenTools = connector.tools.filter((tool) => listed.has(tool));
    const missing = connector.tools.filter((tool) => !listed.has(tool));
    if (missing.length > 0) plan.notes.push(`its connector ${connector.name} no longer lists ${missing.length} of the tools you chose, which pitwall ignores.`);
    if (chosenTools.length === 0) {
      plan.notes.push(`its connector ${connector.name} lists none of the tools you chose, so it's off for this start.`);
      continue;
    }
    const keep = new Set(chosenTools);
    plan.allowed.push(...chosenTools.map((tool) => `${prefix}${tool}`));
    plan.disallowed.push(...server.tools.filter((tool) => !keep.has(tool.name)).map((tool) => `${prefix}${tool.name}`));
    plan.names.push(connector.name);
    plan.prefixes.push(prefix);
    used.add(serverName);
  }
  if (plan.names.length === 0) return { why: plan.notes.join(' ') || 'no chosen claude.ai connector is usable.' };
  plan.denyServers = snapshot.servers.map((server) => server.name).filter((name) => !used.has(name));
  return { plan };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------------------ --connector-tools

/** Names that look like they take or fetch a URL: never preselected, marked `[may take a URL]` (spike 022, decision 3). */
const URL_LOOKING = /fetch|download|url|uri|link|href|website|webpage|browse|scrape|crawl|attachment/i;

export function mayTakeUrl(tool: string): boolean {
  return URL_LOOKING.test(tool);
}

/**
 * What `pitwall --connector-tools <name>` prints for a claude.ai connector: each tool with `[read-only]` from
 * the server's own annotation or `[no hint]`, `[may take a URL]` on a name that looks like it takes one, and the
 * `tools` list to paste with every read-only tool except the URL-looking ones. Names only: Claude Code gives no
 * description or input schema on this surface, so a hint preselects and you decide.
 */
export function formatClaudeAiListing(connector: Pick<ClaudeAiConnector, 'name' | 'claudeAi'> & { tools?: readonly string[] }, server: ClaudeAiServer): string {
  const lines: string[] = [];
  lines.push(`${connector.name} (claude.ai ${connector.claudeAi}): ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}, ${server.status}. [read-only] is the connector's own claim, not a check; Claude Code gives names and hints only, no descriptions or inputs.`);
  lines.push('');
  for (const tool of server.tools) {
    const hint = tool.readOnly === true ? '[read-only]' : '[no hint]  ';
    lines.push(`  ${hint} ${mayTakeUrl(tool.name) ? '[may take a URL] ' : ''}${tool.name}`);
  }
  if (server.tools.some((tool) => mayTakeUrl(tool.name))) {
    lines.push('');
    lines.push("  [may take a URL]: the name looks like the tool takes or fetches a URL. Don't choose it unless you know it only reads inside the service: what the supervisor puts in it goes to whatever address it names, with no card. Check its inputs in the service's docs.");
  }
  const chosen = server.tools.filter((tool) => tool.readOnly === true && !mayTakeUrl(tool.name)).map((tool) => tool.name);
  lines.push('');
  lines.push(`For the connector "${connector.name}" in supervisor.connectors, the read-only tools, without the ones that may take a URL (pitwall keeps out every other tool of this connector by itself):`);
  lines.push('');
  lines.push(`  "tools": ${JSON.stringify(chosen)}`);
  if (connector.tools !== undefined) {
    const listed = new Set(server.tools.map((tool) => tool.name));
    const known = new Set(connector.tools);
    const gone = connector.tools.filter((tool) => !listed.has(tool));
    lines.push('');
    if (gone.length === 0) lines.push('Every tool in your config file is listed by the connector.');
    else lines.push(`No longer listed by the connector, so pitwall ignores them: ${gone.join(', ')}.`);
    const unticked = server.tools.filter((tool) => tool.readOnly === true && !known.has(tool.name)).map((tool) => tool.name);
    if (unticked.length > 0) lines.push(`Read-only tools your config file doesn't choose, so they stay out: ${unticked.join(', ')}.`);
  }
  return `${lines.join('\n')}\n`;
}

/** What `pitwall --claude-ai-connectors` prints: the account's connector names, to put in `claudeAi`. */
export function formatClaudeAiNames(servers: readonly ClaudeAiServer[]): string {
  if (servers.length === 0) return 'Claude Code lists no claude.ai connectors. Sign in with your claude.ai account (not an API key) and add connectors at claude.ai.\n';
  const lines = ['The claude.ai connectors Claude Code lists, with the name to put in "claudeAi":', ''];
  for (const server of servers) lines.push(`  ${JSON.stringify(server.name.slice(NAME_PREFIX.length))}  (${server.status}, ${server.tools.length} tools)`);
  return `${lines.join('\n')}\n`;
}
