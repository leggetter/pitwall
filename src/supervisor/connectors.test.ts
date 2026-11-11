// The supervisor's connectors (W184, D28): the config file's `supervisor.connectors`, checked, and what
// a start adds to the MCP config and the command line. Pure functions; nothing runs.
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../config.js';
import { connectorLaunch, connectorOf, connectorToolName, type SupervisorConnector } from './connectors.js';
import { CONNECTOR_TIMEOUT_MS, headerReferences, refusedEnvName, resolveConnectorServer } from './connectorServer.js';

const FILE = '/made-up/config.json';
const HOME = '/made-up/home';
const launcher = { node: '/made-up/node', script: '/made-up/connectorLauncher.mjs' };

function parse(supervisor: unknown) {
  return parseConfig(JSON.stringify({ supervisor }), FILE, { home: HOME });
}

function error(supervisor: unknown): string {
  try {
    parse(supervisor);
  } catch (caught) {
    expect(caught).toBeInstanceOf(ConfigError);
    return (caught as Error).message;
  }
  throw new Error('expected a ConfigError');
}

const stdio = { command: 'npx', args: ['-y', 'made-up-slack-mcp'], env: ['SLACK_BOT_TOKEN'] };
const slack = { name: 'slack', server: stdio, tools: ['search', 'read_thread'], otherTools: ['post_message'] };

describe('supervisor.connectors in the config file', () => {
  it('reads a stdio and an HTTP connector, each with its chosen and other tools', () => {
    const config = parse({
      connectors: [
        slack,
        { name: 'notion', server: { url: 'https://mcp.made-up.example/mcp', headers: { Authorization: 'Bearer ${NOTION_API_KEY}', 'Notion-Version': '2022-06-28' } }, tools: ['search'] },
        { name: 'local', server: { command: '~/bin/fake-mcp' }, tools: ['read'] },
      ],
    });
    expect(config.supervisor?.connectors).toEqual([
      { name: 'slack', server: { kind: 'stdio', command: 'npx', args: ['-y', 'made-up-slack-mcp'], env: ['SLACK_BOT_TOKEN'] }, tools: ['search', 'read_thread'], otherTools: ['post_message'] },
      { name: 'notion', server: { kind: 'http', url: 'https://mcp.made-up.example/mcp', headers: { Authorization: 'Bearer ${NOTION_API_KEY}', 'Notion-Version': '2022-06-28' } }, tools: ['search'], otherTools: [] },
      { name: 'local', server: { kind: 'stdio', command: '/made-up/home/bin/fake-mcp', args: [], env: [] }, tools: ['read'], otherTools: [] },
    ]);
    expect(config.warnings).toEqual([]);
    expect(parse({}).supervisor).toEqual({ connectors: [] });
  });

  it('warns about unknown keys, as the rest of the file does', () => {
    const config = parse({ connectors: [{ ...slack, extra: 1, server: { ...stdio, cwd: '/x' } }], other: true });
    expect(config.warnings.join('\n')).toContain('"supervisor.other"');
    expect(config.warnings.join('\n')).toContain('"supervisor.connectors[0].extra"');
    expect(config.warnings.join('\n')).toContain('"supervisor.connectors[0].server.cwd"');
  });

  it('refuses a bad name, pitwall’s own, or one used twice', () => {
    expect(error({ connectors: [{ ...slack, name: 'Slack' }] })).toContain('"supervisor.connectors[0].name" must be a name of lowercase letters');
    expect(error({ connectors: [{ ...slack, name: 'my_slack' }] })).toContain('lowercase letters, digits and -');
    expect(error({ connectors: [{ ...slack, name: 'pitwall' }] })).toContain("pitwall's own MCP server's name");
    expect(error({ connectors: [slack, { ...slack }] })).toContain('"supervisor.connectors[1].name" is the name of another connector');
    expect(error({ connectors: 'slack' })).toContain('"supervisor.connectors" must be a list');
    expect(error({ connectors: Array.from({ length: 9 }, (_, i) => ({ ...slack, name: `c${i}` })) })).toContain('more than 8 connectors');
  });

  it('needs at least one chosen tool, names only, none both chosen and kept out', () => {
    expect(error({ connectors: [{ name: 'slack', server: stdio }] })).toContain('Run pitwall --connector-tools slack');
    expect(error({ connectors: [{ ...slack, tools: [] }] })).toContain('choose at least one read-only tool');
    expect(error({ connectors: [{ ...slack, tools: ['search,post_message'] }] })).toContain('"supervisor.connectors[0].tools[0]" must be a tool name');
    expect(error({ connectors: [{ ...slack, tools: ['*'] }] })).toContain('must be a tool name');
    expect(error({ connectors: [{ ...slack, tools: ['mcp__slack__search'.replace(/_/g, '.')] }] })).toContain('must be a tool name');
    expect(error({ connectors: [{ ...slack, tools: ['search', 'search'] }] })).toContain('is listed twice');
    expect(error({ connectors: [{ ...slack, otherTools: ['search'] }] })).toContain('"supervisor.connectors[0].otherTools[0]" is also in "tools"');
  });

  it('a stdio server: a command that isn’t relative, printable arguments, variables by name only, never pitwall’s, Claude Code’s or Anthropic’s', () => {
    const withServer = (server: unknown) => ({ connectors: [{ ...slack, server }] });
    expect(error(withServer({ command: './server' }))).toContain('must be an absolute path, a path starting with ~/, or a bare name');
    expect(error(withServer({ command: '' }))).toContain('must be a command');
    expect(error(withServer({ command: 'npx', args: ['a\nb'] }))).toContain('"supervisor.connectors[0].server.args[0]" must be printable text');
    expect(error(withServer({ command: 'npx', env: { SLACK_KEY: 'x' } }))).toContain('must be a list of variable names');
    // A value under a key named like a token is caught before that, by the file's own token rule.
    expect(error(withServer({ command: 'npx', env: { SLACK_BOT_TOKEN: 'x' } }))).toContain('is named like a token');
    expect(error(withServer({ command: 'npx', env: ['SLACK BOT'] }))).toContain('must be a variable name');
    for (const name of ['PITWALL_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDECODE', 'PATH', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD']) {
      expect(error(withServer({ command: 'npx', env: [name] })), name).toContain('is one a connector may never have');
    }
    expect(error(withServer({ command: 'npx', url: 'https://x.example' }))).toContain('needs either "command"');
    expect(error(withServer({}))).toContain('needs either "command"');
  });

  it('an HTTP server: https, or http to loopback only, no credentials in the URL, and a credential header from a variable', () => {
    const withServer = (server: unknown) => ({ connectors: [{ ...slack, server }] });
    expect(error(withServer({ url: 'http://mcp.made-up.example/mcp' }))).toContain('must be https, or http only to this machine');
    expect(error(withServer({ url: 'http://10.0.0.2/mcp' }))).toContain('must be https, or http only to this machine');
    expect(error(withServer({ url: 'ftp://x.example' }))).toContain('must be https');
    expect(error(withServer({ url: 'https://user:pw@x.example/mcp' }))).toContain('must not hold a user name or password');
    expect(error(withServer({ url: 'not a url' }))).toContain('must be a URL');
    for (const url of ['http://127.0.0.1:9000/mcp', 'http://localhost:9000/mcp', 'http://[::1]:9000/mcp', 'https://10.0.0.2/mcp']) {
      expect(parse(withServer({ url })).supervisor?.connectors[0]?.server, url).toMatchObject({ kind: 'http' });
    }
    expect(error(withServer({ url: 'https://x.example', headers: { Authorization: 'Bearer made-up-literal' } }))).toContain('carries a credential, so it must take it from a variable');
    expect(error(withServer({ url: 'https://x.example', headers: { 'X-Api-Key': 'made-up-literal' } }))).toContain('carries a credential');
    expect(error(withServer({ url: 'https://x.example', headers: { Authorization: 'Bearer $NOTION' } }))).toContain('may use $ only in ${NAME}');
    expect(error(withServer({ url: 'https://x.example', headers: { Authorization: 'Bearer ${ANTHROPIC_API_KEY}' } }))).toContain("names a variable that isn't one, or one a connector may never have");
    expect(error(withServer({ url: 'https://x.example', headers: { Authorization: 'Bearer ${NOTION}\r\nX: y' } }))).toContain('must be printable ASCII');
    expect(error(withServer({ url: 'https://x.example', headers: { 'Bad Header': 'x' } }))).toContain("has a header name that isn’t one");
  });

  it('never quotes a value from the file in a message (D24)', () => {
    const secret = 'made-up-secret-value-1234567890';
    const messages = [
      error({ connectors: [{ ...slack, server: { url: `https://${secret}:x@x.example` } }] }),
      error({ connectors: [{ ...slack, server: { url: 'https://x.example', headers: { Authorization: `Bearer ${secret}` } } }] }),
      error({ connectors: [{ ...slack, server: { command: 'npx', env: [`${secret} x`] } }] }),
      error({ connectors: [{ ...slack, tools: [`${secret},x`] }] }),
      error({ connectors: [{ ...slack, name: secret.toUpperCase() }] }),
    ];
    for (const message of messages) expect(message).not.toContain(secret);
    expect(messages[4]).not.toContain(secret.toUpperCase());
  });

  it('keeps the file’s token rules: a key named like a token is still an error', () => {
    expect(error({ connectors: [{ ...slack, server: { ...stdio, apiToken: 'x' } }] })).toContain('is named like a token');
    expect(error({ connectors: [{ ...slack, server: { url: 'https://x.example', headers: { Authorization: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' } } }] })).toContain('looks like a GitHub token');
  });
});

describe('connectorLaunch()', () => {
  const connectors: SupervisorConnector[] = [
    { name: 'slack', server: { kind: 'stdio', command: 'npx', args: ['-y', 'made-up-slack-mcp'], env: ['SLACK_BOT_TOKEN', 'HOME'] }, tools: ['search', 'read_thread'], otherTools: ['post_message'] },
    { name: 'notion', server: { kind: 'http', url: 'https://mcp.made-up.example/mcp', headers: { Authorization: 'Bearer ${NOTION_API_KEY}' } }, tools: ['search'], otherTools: ['create_page', 'update_page'] },
  ];
  const env = { PATH: '/usr/bin:.:/bin', HOME: '/made-up/home', SLACK_BOT_TOKEN: 'made-up-slack', NOTION_API_KEY: 'made-up-notion', ANTHROPIC_API_KEY: 'made-up-anthropic', PITWALL_TOKEN: 'made-up-pitwall' };

  it('allows exactly the chosen tools, disallows the others, and puts each server, with its values, in the MCP config', () => {
    const launch = connectorLaunch(connectors, env, launcher);
    expect(launch.names).toEqual(['slack', 'notion']);
    expect(launch.allowed).toEqual(['mcp__slack__search', 'mcp__slack__read_thread', 'mcp__notion__search']);
    expect(launch.disallowed).toEqual(['mcp__slack__post_message', 'mcp__notion__create_page', 'mcp__notion__update_page']);
    expect(launch.skipped).toEqual([]);
    expect(launch.servers.slack).toEqual({
      type: 'stdio',
      command: '/made-up/node',
      args: ['/made-up/connectorLauncher.mjs', '--keep', 'SLACK_BOT_TOKEN', '--keep', 'HOME', '--', 'npx', '-y', 'made-up-slack-mcp'],
      // Only the named variables and the absolute PATH: never pitwall's token or Anthropic's key.
      env: { PATH: '/usr/bin:/bin', SLACK_BOT_TOKEN: 'made-up-slack', HOME: '/made-up/home' },
      timeout: CONNECTOR_TIMEOUT_MS,
    });
    expect(launch.servers.notion).toEqual({ type: 'http', url: 'https://mcp.made-up.example/mcp', headers: { Authorization: 'Bearer made-up-notion' }, timeout: CONNECTOR_TIMEOUT_MS });
    expect(JSON.stringify(launch.servers)).not.toMatch(/made-up-anthropic|made-up-pitwall/);
  });

  it('leaves out a connector whose variable isn’t set, naming the variable and never a value', () => {
    const launch = connectorLaunch(connectors, { ...env, SLACK_BOT_TOKEN: undefined }, launcher);
    expect(launch.names).toEqual(['notion']);
    expect(launch.skipped).toEqual([{ name: 'slack', why: "pitwall's environment has no usable SLACK_BOT_TOKEN (unset, or holding ${ or a line break)" }]);
    expect(launch.allowed.some((tool) => tool.startsWith('mcp__slack__'))).toBe(false);
    expect(Object.keys(launch.servers)).toEqual(['notion']);
    // A header value with a line break counts as missing, so it can't add a header.
    expect(connectorLaunch(connectors, { ...env, NOTION_API_KEY: 'x\r\nX-Evil: 1' }, launcher).skipped).toEqual([{ name: 'notion', why: expect.stringContaining('no usable NOTION_API_KEY') }]);
    expect(connectorLaunch([], env, launcher)).toEqual({ servers: {}, allowed: [], disallowed: [], names: [], skipped: [] });
  });

  it('never writes ${ into the MCP config, where Claude Code would expand it from its own environment (spike 017, finding 5)', () => {
    // A variable's value that holds one: in a header and in a stdio server's env.
    const expanding = connectorLaunch(connectors, { ...env, SLACK_BOT_TOKEN: 'x${ANTHROPIC_API_KEY}', NOTION_API_KEY: '${CLAUDE_CODE_MESSAGING_TOKEN}' }, launcher);
    expect(expanding.names).toEqual([]);
    expect(expanding.skipped.map((entry) => entry.name)).toEqual(['slack', 'notion']);
    expect(JSON.stringify(expanding.servers)).not.toContain('${');
    // A path of pitwall's own that holds one: caught over the whole entry.
    const odd = connectorLaunch(connectors.slice(0, 1), env, { node: '/made-up/${HOME}/node', script: '/made-up/launcher.mjs' });
    expect(odd.skipped).toEqual([{ name: 'slack', why: 'its entry would hold ${, which Claude Code would fill in from its own environment' }]);
    // The config file's command, arguments and URL are refused with one.
    expect(error({ connectors: [{ ...slack, server: { command: 'npx', args: ['--token=${ANTHROPIC_API_KEY}'] } }] })).toContain('must not hold ${');
    expect(error({ connectors: [{ ...slack, server: { command: '/opt/${HOME}/mcp' } }] })).toContain('must not hold ${');
    expect(error({ connectors: [{ ...slack, server: { url: 'https://x.example/${ANTHROPIC_API_KEY}' } }] })).toContain('must not hold ${');
    expect(error({ connectors: [{ ...slack, server: { url: 'https://x.example', headers: { 'X-Note': 'a ${ANTHROPIC_API_KEY:-x} b' } } }] })).toContain("names a variable that isn't one");
  });

  it('an OAuth connector (route 1): no headers, so it matches the entry you signed in with, and its oauth block passed on', () => {
    const notion = parse({ connectors: [{ name: 'notion', server: { url: 'https://mcp.made-up.example/mcp' }, tools: ['notion-search'] }] }).supervisor!.connectors[0]!;
    const slackOAuth = parse({
      connectors: [{ name: 'slack', server: { url: 'https://mcp.made-up.example/slack', oauth: { clientId: '1234.5678', callbackPort: 3118, scopes: 'search:read.public channels:history' } }, tools: ['search'] }],
    }).supervisor!.connectors[0]!;
    const launch = connectorLaunch([notion, slackOAuth], {}, launcher);
    expect(launch.servers.notion).toEqual({ type: 'http', url: 'https://mcp.made-up.example/mcp', timeout: CONNECTOR_TIMEOUT_MS });
    expect(launch.servers.slack).toEqual({ type: 'http', url: 'https://mcp.made-up.example/slack', oauth: { clientId: '1234.5678', callbackPort: 3118, scopes: 'search:read.public channels:history' }, timeout: CONNECTOR_TIMEOUT_MS });
    expect(launch.allowed).toEqual(['mcp__notion__notion-search', 'mcp__slack__search']);
    const withServer = (server: unknown) => ({ connectors: [{ ...slack, server }] });
    expect(error(withServer({ url: 'https://x.example', headers: { 'X-A': 'b' }, oauth: {} }))).toContain("can't go with headers");
    expect(error(withServer({ url: 'https://x.example', oauth: { clientId: 'a b' } }))).toContain('must be a client id');
    expect(error(withServer({ url: 'https://x.example', oauth: { callbackPort: 80 } }))).toContain('must be a port from 1024 to 65535');
    expect(error(withServer({ url: 'https://x.example', oauth: { scopes: 'a  b' } }))).toContain('must be scopes separated by single spaces');
    expect(parse(withServer({ url: 'https://x.example', oauth: { clientSecret: 'x' } })).warnings.join('\n')).toContain('"supervisor.connectors[0].server.oauth.clientSecret"');
  });

  it('names tools as Claude Code does, and finds a tool’s connector', () => {
    expect(connectorToolName('slack', 'search')).toBe('mcp__slack__search');
    expect(connectorOf('mcp__slack__added_since', ['slack', 'notion'])).toBe('slack');
    expect(connectorOf('mcp__pitwall__list_sessions', ['slack'])).toBeUndefined();
    expect(connectorOf('Bash', ['slack'])).toBeUndefined();
  });

  it('header references and refused names', () => {
    expect(headerReferences('Bearer ${A} ${B_2}')).toEqual(['A', 'B_2']);
    expect(headerReferences('Bearer $A')).toBeUndefined();
    expect(headerReferences('plain')).toEqual([]);
    expect(refusedEnvName('slack_bot_token')).toBe(false);
    expect(refusedEnvName('pitwall_token')).toBe(true);
    expect(resolveConnectorServer({ kind: 'stdio', command: 'x', args: [], env: ['A', 'B'] }, { A: '1' }, launcher)).toEqual({ ok: false, missing: ['B'] });
  });
});
