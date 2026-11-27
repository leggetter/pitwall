// The supervisor's connectors (W184, D28: the supervisor reads through read-only connectors you
// choose). The config file's `supervisor.connectors`, checked, and what each start of the supervisor
// adds to its command line and its turn-start check. Pure functions, so they can be tested without a
// process. How a connector reaches its service and gets its credentials is connectorServer.ts.
//
//   "supervisor": {
//     "connectors": [
//       {
//         "name": "slack",
//         "server": { "command": "npx", "args": ["-y", "some-slack-mcp"], "env": ["SLACK_BOT_TOKEN"] },
//         "tools": ["search_messages", "read_thread"],
//         "otherTools": ["post_message"]
//       }
//     ]
//   }
//
// `tools` are the tools you chose as read-only, which `--allowed-tools` lets run; `otherTools` are
// every other tool the server listed when you chose (`pitwall --connector-tools <name>` prints both),
// which `--disallowed-tools` takes out of the model's list (spike 016, finding 3). A tool in neither,
// one the server added since, is still in the model's list, and the supervisor stops any turn whose
// system/init lists it (supervisor.ts), so it fails closed until you choose again (D28). A server's
// read-only hint only preselects a tool when pitwall prints them; it never decides (spike 016, finding 4).
import os from 'node:os';
import { MCP_SERVER_NAME } from '../shared/protocol.js';
import { type ConnectorLauncher, type ConnectorServer, EXPANSION, parseConnectorServer, resolveConnectorServer } from './connectorServer.js';

/** One connector, as the config file has it once checked. */
export interface SupervisorConnector {
  /** Its MCP server's name, in the supervisor's MCP config and in its tools' names: `mcp__<name>__<tool>`. */
  name: string;
  server: ConnectorServer;
  /** The tools you chose as read-only: the only ones the supervisor may call. At least one. */
  tools: string[];
  /** Every other tool the server listed when you chose: kept out of the model's list. */
  otherTools: string[];
}

/**
 * One claude.ai connector your Claude sessions already have (W191, D28), chosen by its display name:
 * `{ "name": "slack", "claudeAi": "Slack", "tools": [...] }`. It holds no credential: the sign-in is Claude
 * Code's, from claude.ai. pitwall works out the tools to keep out from what the connector lists at each
 * start (claudeAi.ts), so there is no `otherTools`.
 */
export interface ClaudeAiConnector {
  /** The name you give it here, as for the other kind: `pitwall --connector-tools <name>`. */
  name: string;
  /** The display name after `claude.ai `, such as `Slack`. */
  claudeAi: string;
  /** The tools you chose as read-only, as the connector lists them, without the `mcp__claude_ai_<Name>__` prefix. At least one. */
  tools: string[];
}

/** The config file's `supervisor` block. */
export interface SupervisorConfig {
  connectors: SupervisorConnector[];
  /** The claude.ai connectors (W191). Absent when the file has none. */
  claudeAi?: ClaudeAiConnector[];
}

/** A claude.ai connector's display name as pitwall accepts one: letters, digits, spaces and a few marks, such as `Customer.io`. */
export const CLAUDE_AI_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 ._&()-]{0,62}[A-Za-z0-9)])?$/;

/** A connector's name: lowercase letters, digits and `-`, starting with a letter. No `_`, so `mcp__<name>__<tool>` reads one way. */
export const CONNECTOR_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** A tool's name as pitwall accepts one: what Claude Code keeps unchanged in `mcp__<server>__<tool>`, and never a `,` or `*`. */
export const CONNECTOR_TOOL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const MAX_CONNECTORS = 8;
export const MAX_CONNECTOR_TOOLS = 200;

type Fail = (key: string, message: string) => never;

/** The config file's `supervisor` block, checked. Never quotes a value from the file in a message (D24). */
export function parseSupervisorConfig(value: unknown, key: string, fail: Fail, unknown: (key: string) => void, home: string = os.homedir()): SupervisorConfig {
  if (!isPlainObject(value)) return fail(key, 'must be an object, such as { "connectors": [...] }');
  for (const name of Object.keys(value)) if (name !== 'connectors') unknown(`${key}.${name}`);
  if (!Object.hasOwn(value, 'connectors')) return { connectors: [] };
  const list = value.connectors;
  const listKey = `${key}.connectors`;
  if (!Array.isArray(list)) return fail(listKey, 'must be a list of connectors, each { "name", "server", "tools", "otherTools" } or { "name", "claudeAi", "tools" }');
  if (list.length > MAX_CONNECTORS) return fail(listKey, `has more than ${MAX_CONNECTORS} connectors`);
  const names = new Set<string>();
  const claudeAi: ClaudeAiConnector[] = [];
  const claudeAiKeys = new Set<string>();
  const connectors: SupervisorConnector[] = [];
  list.forEach((entry: unknown, i) => {
      const at = `${listKey}[${i}]`;
      if (!isPlainObject(entry)) return fail(at, 'must be an object: { "name", "server", "tools", "otherTools" } or { "name", "claudeAi", "tools" }');
      if (Object.hasOwn(entry, 'claudeAi')) {
        for (const key of Object.keys(entry)) if (!['name', 'claudeAi', 'tools'].includes(key)) fail(`${at}.${key}`, 'is not allowed on a claudeAi connector: the sign-in is Claude Code\'s, and pitwall works out which tools to keep out');
        const name = parseConnectorName(entry.name, at, names, fail);
        const display = entry.claudeAi;
        if (typeof display !== 'string' || !CLAUDE_AI_NAME_PATTERN.test(display)) {
          return fail(`${at}.claudeAi`, 'must be the connector\'s display name on claude.ai, such as "Slack": letters, digits, spaces and . _ & ( ) -, at most 64 characters. Run pitwall --claude-ai-connectors to list yours');
        }
        const key = claudeAiToolPrefix(display);
        if (claudeAiKeys.has(key)) return fail(`${at}.claudeAi`, 'names the same connector as another entry');
        claudeAiKeys.add(key);
        if (!Object.hasOwn(entry, 'tools')) return fail(`${at}.tools`, `is missing. Run pitwall --connector-tools ${name} to list the connector's tools and choose the read-only ones`);
        const tools = parseToolList(entry.tools, `${at}.tools`, fail);
        if (tools.length === 0) return fail(`${at}.tools`, 'is empty: choose at least one read-only tool, or remove the connector');
        claudeAi.push({ name, claudeAi: display, tools });
        return;
      }
      for (const name of Object.keys(entry)) if (!['name', 'server', 'tools', 'otherTools'].includes(name)) unknown(`${at}.${name}`);
      const name = parseConnectorName(entry.name, at, names, fail);
      if (!Object.hasOwn(entry, 'server')) return fail(`${at}.server`, 'is missing: each connector needs its MCP server');
      const server = parseConnectorServer(entry.server, `${at}.server`, fail, unknown, home);
      if (!Object.hasOwn(entry, 'tools')) return fail(`${at}.tools`, `is missing. Run pitwall --connector-tools ${name} to list the server's tools and choose the read-only ones`);
      const tools = parseToolList(entry.tools, `${at}.tools`, fail);
      if (tools.length === 0) return fail(`${at}.tools`, 'is empty: choose at least one read-only tool, or remove the connector');
      const otherTools = Object.hasOwn(entry, 'otherTools') ? parseToolList(entry.otherTools, `${at}.otherTools`, fail) : [];
      const chosen = new Set(tools);
      otherTools.forEach((tool, j) => {
        if (chosen.has(tool)) fail(`${at}.otherTools[${j}]`, 'is also in "tools". A tool is either one you chose as read-only or one kept out');
      });
      connectors.push({ name, server, tools, otherTools });
  });
  return { connectors, ...(claudeAi.length === 0 ? {} : { claudeAi }) };
}

function parseConnectorName(name: unknown, at: string, names: Set<string>, fail: Fail): string {
  if (typeof name !== 'string' || !CONNECTOR_NAME_PATTERN.test(name)) {
    return fail(`${at}.name`, 'must be a name of lowercase letters, digits and -, starting with a letter, at most 32 characters, such as "slack"');
  }
  if (name === MCP_SERVER_NAME) return fail(`${at}.name`, "is pitwall's own MCP server's name. Choose another");
  if (names.has(name)) return fail(`${at}.name`, 'is the name of another connector. Each needs its own');
  names.add(name);
  return name;
}

/** `mcp__claude_ai_<Name>__`: Claude Code's prefix for a claude.ai connector's tools, each character outside A-Za-z0-9_- as `_` (spike 022, finding 7). */
export function claudeAiToolPrefix(display: string): string {
  return `mcp__claude_ai_${display.replace(/[^A-Za-z0-9_-]/g, '_')}__`;
}

/** A claude.ai connector's server name in Claude Code: `claude.ai <Name>`. */
export function claudeAiServerName(display: string): string {
  return `claude.ai ${display}`;
}

function parseToolList(value: unknown, key: string, fail: Fail): string[] {
  if (!Array.isArray(value)) return fail(key, 'must be a list of the server\'s tool names, such as ["search"]');
  if (value.length > MAX_CONNECTOR_TOOLS) return fail(key, `has more than ${MAX_CONNECTOR_TOOLS} tools`);
  const seen = new Set<string>();
  value.forEach((tool: unknown, i) => {
    if (typeof tool !== 'string' || !CONNECTOR_TOOL_PATTERN.test(tool)) {
      return fail(`${key}[${i}]`, 'must be a tool name as the server lists it: letters, digits, _ and -, at most 64 characters, without the mcp__ prefix');
    }
    if (seen.has(tool)) return fail(`${key}[${i}]`, 'is listed twice');
    seen.add(tool);
  });
  return [...seen];
}

/** A connector's tool as Claude Code names it: `mcp__<connector>__<tool>`. */
export function connectorToolName(connector: string, tool: string): string {
  return `mcp__${connector}__${tool}`;
}

/** What one start of the supervisor gives it from its connectors. */
export interface ConnectorLaunch {
  /** The MCP config's entries, by connector name, with their variables' values: for the 0600 file only. */
  servers: Record<string, Record<string, unknown>>;
  /** The chosen tools, `mcp__<connector>__<tool>`: for `--allowed-tools` and the turn-start check. */
  allowed: string[];
  /** Every other tool the servers listed, for `--disallowed-tools`. */
  disallowed: string[];
  /** The connectors on this start, by name. */
  names: string[];
  /** Connectors left out of this start, each with why, in pitwall's words: variables' names only, never a value. */
  skipped: { name: string; why: string }[];
}

/**
 * What this start of the supervisor gets from `connectors`: each one whose variables are all in `env`
 * joins the MCP config, with its chosen tools allowed and its other tools disallowed; one that lacks
 * a variable is left out of this start, tools and all, and named in `skipped`.
 */
export function connectorLaunch(connectors: readonly SupervisorConnector[], env: NodeJS.ProcessEnv, launcher: ConnectorLauncher): ConnectorLaunch {
  const launch: ConnectorLaunch = { servers: {}, allowed: [], disallowed: [], names: [], skipped: [] };
  for (const connector of connectors) {
    const resolved = resolveConnectorServer(connector.server, env, launcher);
    if (!resolved.ok) {
      launch.skipped.push({ name: connector.name, why: `pitwall's environment has no usable ${resolved.missing.join(', ')} (unset, or holding \${ or a line break)` });
      continue;
    }
    // Last, over the whole entry as it will be written: Claude Code would expand a `${` anywhere in it
    // (spike 017, finding 5), from a value, a path of pitwall's or anything else.
    if (JSON.stringify(resolved.entry).includes(EXPANSION)) {
      launch.skipped.push({ name: connector.name, why: 'its entry would hold ${, which Claude Code would fill in from its own environment' });
      continue;
    }
    launch.servers[connector.name] = resolved.entry;
    launch.names.push(connector.name);
    launch.allowed.push(...connector.tools.map((tool) => connectorToolName(connector.name, tool)));
    launch.disallowed.push(...connector.otherTools.map((tool) => connectorToolName(connector.name, tool)));
  }
  return launch;
}

/** The connector a tool's name belongs to, `mcp__<connector>__…`, when it's one of `names`. */
export function connectorOf(tool: string, names: readonly string[]): string | undefined {
  return names.find((name) => tool.startsWith(`mcp__${name}__`));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
