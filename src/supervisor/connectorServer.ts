// A supervisor connector's server and its credentials (W184, D28: the supervisor reads through
// read-only connectors you choose). The one piece W185 (spike: Slack, Notion and Gmail with real
// accounts) may change: how a connector reaches its service and gets its credentials. Everything
// else, the tool choice, the command line and the turn-start check, is in connectors.ts and doesn't
// depend on what's here.
//
// Three routes, in spike 017's order of preference (W185, how Slack and Notion get their credentials):
//
//   1. { "url": "https://mcp.example.com/mcp", "oauth": { "clientId": ..., "callbackPort": ..., "scopes": ... } }
//      An HTTP server signed in through Claude Code's own OAuth, once, in an interactive session with
//      the same entry (`pitwall --connector-tools <name>` prints how). Claude Code keeps the sign-in,
//      keyed by the server's name, type, URL and headers (spike 017, finding 4), so pitwall holds no
//      secret, and the entry has no headers. `oauth` is optional, for a server without dynamic client
//      registration (Slack); its `scopes` narrow the grant to reads where the service allows it.
//   2. { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${NOTION_TOKEN}" } }
//      An HTTP server with a header from a variable you name.
//   3. { "command": "npx", "args": ["-y", "some-mcp"], "env": ["SLACK_BOT_TOKEN", "HOME"] }
//      A stdio server, only behind connectorLauncher.mjs (below).
//
// The config file holds variable names, never values (D24, D28). Their values come from pitwall's
// own environment at each start, and pitwall writes them into the supervisor's 0600 MCP config in its
// 0700 folder, removed when its process exits, as it does its bearer token: never into Claude Code's
// environment, which every stdio server inherits (spike 017, finding 6).
//
// Claude Code expands `${NAME}` in an MCP config's entries, headers, env and args at least, from its
// own environment (spike 017, finding 5). So nothing pitwall writes there may hold `${`: the config
// file's command, arguments and URL are refused with one, and an entry that would hold one after its
// values are filled in, from a variable's value or pitwall's own paths, is left out of that start
// (connectors.ts). Otherwise text could reach a connector as the value of a variable it never named,
// such as Anthropic's key in Claude Code's environment.
//
// A stdio connector gets only the variables its entry names, plus the absolute PATH of D23. Claude
// Code passes its whole environment to a stdio server (checked on 2.1.322: a variable set only in
// claude's environment, and Claude Code's own messaging socket and token, reached the server), so
// pitwall runs the command through connectorLauncher.mjs, which starts it with exactly those
// variables, whatever Claude Code passes.
//
// An HTTP connector is `https` only, or `http` to this machine's loopback. Its headers' variables are
// filled in from pitwall's environment.
import os from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from '../index/exec.js';
import { CODE_LOADING_VARIABLES } from '../server/relay.js';

/** A stdio server: a command pitwall runs through the launcher, with the variables `env` names. */
export interface StdioConnectorServer {
  kind: 'stdio';
  /** Absolute, or a bare name found on the child's PATH. A leading `~/` is expanded. */
  command: string;
  args: string[];
  /** The variables it gets from pitwall's environment, by name. */
  env: string[];
}

/** An HTTP server (Claude Code's `http` type): its URL, and headers whose `${NAME}` parts are filled in. */
export interface HttpConnectorServer {
  kind: 'http';
  url: string;
  /** Each header's template: literal text and `${NAME}` references to pitwall's environment. None with `oauth`. */
  headers: Record<string, string>;
  /** Claude Code's own OAuth settings for it (route 1), passed on as they are. */
  oauth?: ConnectorOAuth;
}

/** Claude Code's `oauth` block for an HTTP server (spike 017, findings 3 and 7). */
export interface ConnectorOAuth {
  clientId?: string;
  callbackPort?: number;
  /** Space-separated scopes, to narrow the grant. */
  scopes?: string;
}

export type ConnectorServer = StdioConnectorServer | HttpConnectorServer;

/** How pitwall runs a stdio connector: node, and connectorLauncher.mjs beside this file. */
export interface ConnectorLauncher {
  node: string;
  script: string;
}

/** The launcher beside this file: in src/ under tsx, in dist/ once built, as the gate hook is. */
export function defaultConnectorLauncher(): ConnectorLauncher {
  return { node: process.execPath, script: fileURLToPath(new URL('./connectorLauncher.mjs', import.meta.url)) };
}

/**
 * How long one call to a connector may take, in milliseconds: its server entry's `timeout`, a hard
 * limit per call in Claude Code (prompt.ts, SUPERVISOR_MCP_TIMEOUT_MS). Pitwall's own server gets 30
 * minutes, for the approve call's wait; a connector only reads, so a minute.
 */
export const CONNECTOR_TIMEOUT_MS = 60_000;

/** A variable's name: as a POSIX shell takes one. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4096;
const MAX_ENV = 32;
const MAX_HEADERS = 32;
const MAX_HEADER_LENGTH = 2048;
const MAX_URL_LENGTH = 2048;

/** A header's name: an HTTP token, letters, digits and `-` only. */
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** A header that carries a credential, so its value must come from a variable, never the file. */
const SECRET_HEADER = /^(?:authorization|proxy-authorization|cookie)$|key|token|secret|auth|session|password|credential/i;

/** What Claude Code expands in an MCP config's entries (spike 017, finding 5). */
export const EXPANSION = '${';

/** A client id, as the services issue them: letters, digits, `.`, `_` and `-`. */
const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** OAuth scopes: space-separated, each letters, digits and `:._-`. */
const SCOPES = /^[A-Za-z0-9:._-]{1,100}(?: [A-Za-z0-9:._-]{1,100}){0,49}$/;

/** One `${NAME}` reference in a header's template. */
const REFERENCE = /\$\{([^}]*)\}/g;

/** Hosts an `http` URL may name: this machine's loopback. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Names a connector may never take from pitwall's environment: pitwall's own (its token among them),
 * Claude Code's and its provider's, the search path, which pitwall sets, and those that load code.
 */
export function refusedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper === 'PATH' ||
    upper.startsWith('PITWALL_') ||
    upper.startsWith('ANTHROPIC_') ||
    upper.startsWith('CLAUDE') ||
    upper.startsWith('DYLD_') ||
    upper.startsWith('LD_') ||
    CODE_LOADING_VARIABLES.has(upper)
  );
}

type Fail = (key: string, message: string) => never;

/**
 * A connector's `server` entry from the config file, checked. Never quotes a value from the file in
 * a message (D24), only its key.
 */
export function parseConnectorServer(value: unknown, key: string, fail: Fail, unknown: (key: string) => void, home: string = os.homedir()): ConnectorServer {
  if (!isPlainObject(value)) return fail(key, 'must be an object: { "command": ..., "args": [...], "env": [...] } or { "url": ..., "headers": {...} }');
  const hasCommand = Object.hasOwn(value, 'command');
  const hasUrl = Object.hasOwn(value, 'url');
  if (hasCommand === hasUrl) return fail(key, 'needs either "command", for a server pitwall runs, or "url", for one over HTTP, and not both');
  if (hasCommand) {
    for (const name of Object.keys(value)) if (name !== 'command' && name !== 'args' && name !== 'env') unknown(`${key}.${name}`);
    return { kind: 'stdio', command: parseCommand(value.command, `${key}.command`, fail, home), args: parseArgs(value.args, `${key}.args`, fail), env: parseEnvNames(value.env, `${key}.env`, fail) };
  }
  for (const name of Object.keys(value)) if (name !== 'url' && name !== 'headers' && name !== 'oauth') unknown(`${key}.${name}`);
  const url = parseUrl(value.url, `${key}.url`, fail);
  const headers = parseHeaders(value.headers, `${key}.headers`, fail);
  if (!Object.hasOwn(value, 'oauth')) return { kind: 'http', url, headers };
  if (Object.keys(headers).length > 0) return fail(`${key}.oauth`, "can't go with headers: Claude Code keeps an OAuth sign-in for the entry as it was signed in, with no headers");
  return { kind: 'http', url, headers, oauth: parseOAuth(value.oauth, `${key}.oauth`, fail, unknown) };
}

function parseOAuth(value: unknown, key: string, fail: Fail, unknown: (key: string) => void): ConnectorOAuth {
  if (!isPlainObject(value)) return fail(key, 'must be an object, such as { "clientId": ..., "callbackPort": 3118, "scopes": "search:read" }');
  const oauth: ConnectorOAuth = {};
  for (const name of Object.keys(value)) if (name !== 'clientId' && name !== 'callbackPort' && name !== 'scopes') unknown(`${key}.${name}`);
  if (Object.hasOwn(value, 'clientId')) {
    if (typeof value.clientId !== 'string' || !CLIENT_ID.test(value.clientId)) return fail(`${key}.clientId`, 'must be a client id: letters, digits, ., _ and -, at most 128 characters. A client secret never goes in the file');
    oauth.clientId = value.clientId;
  }
  if (Object.hasOwn(value, 'callbackPort')) {
    const port = value.callbackPort;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) return fail(`${key}.callbackPort`, 'must be a port from 1024 to 65535');
    oauth.callbackPort = port;
  }
  if (Object.hasOwn(value, 'scopes')) {
    if (typeof value.scopes !== 'string' || !SCOPES.test(value.scopes)) return fail(`${key}.scopes`, 'must be scopes separated by single spaces, such as "search:read.public channels:history"');
    oauth.scopes = value.scopes;
  }
  return oauth;
}

function parseCommand(value: unknown, key: string, fail: Fail, home: string): string {
  if (typeof value !== 'string' || value === '') return fail(key, 'must be a command: an absolute path, a path starting with ~/, or a name on your PATH');
  if (!printable(value) || value.length > MAX_ARG_LENGTH) return fail(key, `must be printable text of at most ${MAX_ARG_LENGTH} characters`);
  if (value.includes(EXPANSION)) return fail(key, 'must not hold ${, which Claude Code would fill in from its own environment');
  const expanded = value.startsWith('~/') ? `${home}/${value.slice(2)}` : value;
  // A relative path would be found in the supervisor's empty folder, where nothing is.
  if (!isAbsolute(expanded) && expanded.includes('/')) return fail(key, 'must be an absolute path, a path starting with ~/, or a bare name on your PATH');
  return expanded;
}

function parseArgs(value: unknown, key: string, fail: Fail): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(key, 'must be a list of arguments');
  if (value.length > MAX_ARGS) return fail(key, `has more than ${MAX_ARGS} arguments`);
  return value.map((arg: unknown, i) => {
    if (typeof arg !== 'string' || !printable(arg) || arg.length > MAX_ARG_LENGTH) return fail(`${key}[${i}]`, `must be printable text of at most ${MAX_ARG_LENGTH} characters`);
    if (arg.includes(EXPANSION)) return fail(`${key}[${i}]`, 'must not hold ${, which Claude Code would fill in from its own environment. A connector gets a value only through "env"');
    return arg;
  });
}

function parseEnvNames(value: unknown, key: string, fail: Fail): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(key, 'must be a list of variable names, such as ["SLACK_BOT_TOKEN"]: their values come from pitwall\'s environment, never the file');
  if (value.length > MAX_ENV) return fail(key, `names more than ${MAX_ENV} variables`);
  const seen = new Set<string>();
  value.forEach((name: unknown, i) => {
    const at = `${key}[${i}]`;
    if (typeof name !== 'string' || !ENV_NAME_PATTERN.test(name)) return fail(at, 'must be a variable name: letters, digits and _, not starting with a digit. Put the value in pitwall\'s environment, never in the file');
    if (refusedEnvName(name)) return fail(at, "is one a connector may never have: PATH, which pitwall sets, pitwall's, Claude Code's and Anthropic's own variables, and those that load code");
    if (seen.has(name)) return fail(at, 'is listed twice');
    seen.add(name);
  });
  return [...seen];
}

function parseUrl(value: unknown, key: string, fail: Fail): string {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || !printable(value)) return fail(key, `must be a URL of at most ${MAX_URL_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(key, 'must be a URL, such as https://mcp.example.com/mcp');
  }
  if (url.username !== '' || url.password !== '') return fail(key, 'must not hold a user name or password: put a credential in a header, from a variable');
  if (url.hash !== '') return fail(key, 'must not have a # part');
  if (value.includes(EXPANSION) || url.href.includes(EXPANSION)) return fail(key, 'must not hold ${, which Claude Code would fill in from its own environment');
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.href;
  return fail(key, 'must be https, or http only to this machine (127.0.0.1, localhost or [::1])');
}

function parseHeaders(value: unknown, key: string, fail: Fail): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return fail(key, 'must be an object of headers, such as { "Authorization": "Bearer ${NOTION_API_KEY}" }');
  const names = Object.keys(value);
  if (names.length > MAX_HEADERS) return fail(key, `has more than ${MAX_HEADERS} headers`);
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of names) {
    const at = `${key}.${name}`;
    if (!HEADER_NAME.test(name)) fail(key, 'has a header name that isn’t one: letters, digits and - only');
    if (seen.has(name.toLowerCase())) fail(at, 'is listed twice');
    seen.add(name.toLowerCase());
    const template = value[name];
    if (typeof template !== 'string' || template.length > MAX_HEADER_LENGTH || !/^[\x20-\x7E]*$/.test(template)) {
      fail(at, `must be printable ASCII text of at most ${MAX_HEADER_LENGTH} characters`);
    }
    const references = headerReferences(template as string);
    if (references === undefined) fail(at, 'may use $ only in ${NAME}, a variable from pitwall\'s environment');
    if (references!.some((name) => !ENV_NAME_PATTERN.test(name) || refusedEnvName(name))) {
      fail(at, "names a variable that isn't one, or one a connector may never have (pitwall's, Claude Code's or Anthropic's)");
    }
    if (SECRET_HEADER.test(name) && references!.length === 0) {
      fail(at, 'carries a credential, so it must take it from a variable, such as "Bearer ${NOTION_API_KEY}", never from the file');
    }
    headers[name] = template as string;
  }
  return headers;
}

/** The variable names a header's template refers to, or undefined when it has a `$` outside `${NAME}`. */
export function headerReferences(template: string): string[] | undefined {
  const names: string[] = [];
  const rest = template.replace(REFERENCE, (_match, name: string) => {
    names.push(name);
    return '';
  });
  return rest.includes('$') ? undefined : names;
}

/** The variables a server needs from pitwall's environment, by name. */
export function serverVariables(server: ConnectorServer): string[] {
  if (server.kind === 'stdio') return server.env;
  return [...new Set(Object.values(server.headers).flatMap((template) => headerReferences(template) ?? []))];
}

/**
 * What a stdio connector's process gets: the variables it names, from `env`, and the absolute PATH of
 * D23 (childEnvironment()). Nothing else: no HOME unless it names it.
 */
export function connectorEnvironment(server: StdioConnectorServer, env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  const path = childEnvironment({ PATH: env.PATH ?? '', ...(env.HOME === undefined ? {} : { HOME: env.HOME }) }).PATH;
  if (path !== undefined) result.PATH = path;
  for (const name of server.env) {
    const value = env[name];
    if (usable(value)) result[name] = value;
  }
  return result;
}

/** A server entry for the MCP config, or the variables it lacks: unset, or with a value it can't use. */
export type ResolvedServer = { ok: true; entry: Record<string, unknown> } | { ok: false; missing: string[] };

/** A variable's value a connector can take: set, and without `${`, which Claude Code would expand again. */
function usable(value: string | undefined): value is string {
  return value !== undefined && !value.includes(EXPANSION);
}

/**
 * The connector's entry in the supervisor's MCP config, with its variables' values from `env`, or the
 * names it lacks, when one isn't set (or, for a header, holds a character a header can't). A stdio
 * server runs through the launcher, which keeps only the variables named on its command line.
 */
export function resolveConnectorServer(server: ConnectorServer, env: NodeJS.ProcessEnv, launcher: ConnectorLauncher): ResolvedServer {
  const missing = serverVariables(server).filter((name) => !usable(env[name]));
  if (missing.length > 0) return { ok: false, missing };
  if (server.kind === 'stdio') {
    const keep = server.env.flatMap((name) => ['--keep', name]);
    return {
      ok: true,
      entry: { type: 'stdio', command: launcher.node, args: [launcher.script, ...keep, '--', server.command, ...server.args], env: connectorEnvironment(server, env), timeout: CONNECTOR_TIMEOUT_MS },
    };
  }
  const headers = resolveHeaders(server, env);
  if (!headers.ok) return headers;
  return { ok: true, entry: httpEntry(server, headers.headers) };
}

/**
 * An HTTP connector's entry. With `oauth`, or no headers, it's the entry you sign in with (route 1):
 * Claude Code finds the sign-in by its name, type, URL and headers, so it has no `headers` key at
 * all; `timeout` and `oauth` aren't part of that key (spike 017, finding 4).
 */
export function httpEntry(server: HttpConnectorServer, headers: Record<string, string>): Record<string, unknown> {
  return {
    type: 'http',
    url: server.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(server.oauth === undefined ? {} : { oauth: { ...server.oauth } }),
    timeout: CONNECTOR_TIMEOUT_MS,
  };
}

/** An HTTP connector's headers with their variables filled in from `env`. */
export function resolveHeaders(server: HttpConnectorServer, env: NodeJS.ProcessEnv): { ok: true; headers: Record<string, string> } | { ok: false; missing: string[] } {
  const missing = new Set<string>();
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(server.headers)) {
    headers[name] = template.replace(REFERENCE, (_match, variable: string) => {
      const value = env[variable];
      // A header can't carry a line break or a control character, or `${`: such a value counts as missing.
      if (!usable(value) || !/^[\x20-\x7E\t]*$/.test(value)) {
        missing.add(variable);
        return '';
      }
      return value;
    });
  }
  return missing.size > 0 ? { ok: false, missing: [...missing] } : { ok: true, headers };
}

/** A one-line description of where a server is, for messages: its command's name or its URL's origin, never an argument or a header. */
export function describeServer(server: ConnectorServer): string {
  if (server.kind === 'stdio') return server.command;
  return new URL(server.url).origin;
}

function printable(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001F\u007F-\u009F]/.test(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
