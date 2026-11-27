// The supervisor's claude.ai connectors (W191, spike 022): the probe's control channel, the plan from what
// it lists, and what --connector-tools prints. A fake spawner and a fake control channel; no test runs claude.
import { describe, expect, it } from 'vitest';
import type { RelayChild, RelayChildEvents, RelaySpawner } from '../server/relay.js';
import { formatClaudeAiListing, formatClaudeAiNames, mayTakeUrl, planClaudeAi, probeArgs, probeClaudeAi, readMcpStatus, type ClaudeAiServer } from './claudeAi.js';
import type { ClaudeAiConnector } from './connectors.js';

const slack: ClaudeAiConnector = { name: 'slack', claudeAi: 'Slack', tools: ['slack_read_channel', 'slack_search_public'] };

function server(name: string, status: string, tools: [string, boolean | undefined][]): ClaudeAiServer {
  return { name: `claude.ai ${name}`, status, tools: tools.map(([tool, readOnly]) => ({ name: tool, readOnly })) };
}
const SLACK = server('Slack', 'connected', [['slack_read_channel', true], ['slack_search_public', true], ['slack_send_message', false], ['slack_read_canvas', undefined]]);
const OTHER = server('Notion', 'connected', [['notion-search', true]]);

function rawStatus(id: string, servers: unknown[]): string {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { mcpServers: servers } } });
}
function rawServer(name: string, status: string, tools: { name: string; annotations?: Record<string, unknown> }[]) {
  return { name: `claude.ai ${name}`, status, source: 'claudeai', tools };
}

describe('readMcpStatus', () => {
  it('reads the claude.ai servers, their tools and the readOnly annotation, and ignores other servers and other lines', () => {
    const event = JSON.parse(
      rawStatus('r1', [
        rawServer('Slack', 'connected', [{ name: 'slack_read_channel', annotations: { readOnly: true } }, { name: 'mcp__claude_ai_Slack__slack_send_message', annotations: { readOnly: false } }, { name: 'slack_x' }]),
        { name: 'pitwall', status: 'connected', tools: [] },
      ]),
    );
    expect(readMcpStatus(event, 'r1')).toEqual({
      ok: true,
      servers: [{ name: 'claude.ai Slack', status: 'connected', tools: [{ name: 'slack_read_channel', readOnly: true }, { name: 'slack_send_message', readOnly: false }, { name: 'slack_x', readOnly: undefined }] }],
    });
    expect(readMcpStatus(event, 'other')).toBeUndefined();
    expect(readMcpStatus({ type: 'system' }, 'r1')).toBeUndefined();
  });

  it('answers not-ok for an error response or a shape it does not read', () => {
    expect(readMcpStatus({ type: 'control_response', response: { subtype: 'error', request_id: 'r' } }, 'r')).toMatchObject({ ok: false });
    expect(readMcpStatus({ type: 'control_response', response: { subtype: 'success', request_id: 'r', response: { servers: 1 } } }, 'r')).toMatchObject({ ok: false });
  });
});

/** A fake claude that answers each mcp_status with the next of `answers` (the last repeats), or never. */
function fakeSpawner(answers: unknown[][] | 'silent' | 'exit' | 'throw', record: { args?: string[]; killed?: boolean; writes: string[] }): RelaySpawner {
  return (_file, args, _options, events: RelayChildEvents) => {
    if (answers === 'throw') throw new Error('nope');
    record.args = args;
    let asked = 0;
    const child: RelayChild = {
      pid: 1,
      write(data) {
        record.writes.push(data);
        const line = JSON.parse(data) as { request_id: string };
        if (answers === 'silent' || answers === 'exit') return;
        const servers = answers[Math.min(asked++, answers.length - 1)]!;
        setImmediate(() => events.line(rawStatus(line.request_id, servers)));
      },
      end() {},
      kill() {
        record.killed = true;
      },
    };
    if (answers === 'exit') setImmediate(() => events.exit(1, null));
    return child;
  };
}
const run = (chosen: string[], spawn: RelaySpawner) => probeClaudeAi(chosen, { spawn, claudeBin: 'claude', cwd: '/made-up', env: {}, timeoutMs: 80, pollMs: 5 });

describe('probeClaudeAi', () => {
  it('runs claude with no turn, no tools and no claude.ai wildcard allow, polls until the chosen connector is connected, and stops it', async () => {
    const record = { writes: [] as string[] } as { args?: string[]; killed?: boolean; writes: string[] };
    const pending = rawServer('Slack', 'pending', []);
    const done = rawServer('Slack', 'connected', [{ name: 'slack_read_channel', annotations: { readOnly: true } }]);
    const answer = await run(['Slack'], fakeSpawner([[], [pending], [done]], record));
    expect(answer).toMatchObject({ ok: true, servers: [{ name: 'claude.ai Slack', status: 'connected' }] });
    expect(record.writes.length).toBe(3);
    expect(record.killed).toBe(true);
    const args = record.args!;
    expect(args).toContain('stream-json');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).not.toContain('--allowed-tools');
    expect(args).toEqual(probeArgs());
    // No user message was ever written: no turn, no tokens.
    expect(record.writes.every((line) => (JSON.parse(line) as { type: string }).type === 'control_request')).toBe(true);
  });

  it('with none chosen, waits for a connector to be there and none pending', async () => {
    const record = { writes: [] as string[] } as { args?: string[]; killed?: boolean; writes: string[] };
    const answer = await run([], fakeSpawner([[], [rawServer('A', 'pending', [])], [rawServer('A', 'connected', []), rawServer('B', 'needs-auth', [])]], record));
    expect(answer).toMatchObject({ ok: true });
    expect((answer as { servers: unknown[] }).servers).toHaveLength(2);
  });

  it('fails soft: a spawner that throws, a child that exits, a silent one, and a connector still pending at the end', async () => {
    const record = () => ({ writes: [] as string[] }) as { args?: string[]; killed?: boolean; writes: string[] };
    expect(await run(['Slack'], fakeSpawner('throw', record()))).toMatchObject({ ok: false });
    expect(await run(['Slack'], fakeSpawner('exit', record()))).toMatchObject({ ok: false, error: expect.stringContaining('exited') });
    expect(await run(['Slack'], fakeSpawner('silent', record()))).toMatchObject({ ok: false, error: expect.stringContaining("didn't list") });
    const late = await run(['Slack'], fakeSpawner([[rawServer('Slack', 'pending', [])]], record()));
    expect(late).toMatchObject({ ok: true, servers: [{ status: 'pending' }] });
  });

  it('answers not-ok for an mcp_status error', async () => {
    const spawn: RelaySpawner = (_f, _a, _o, events) => ({
      pid: 1,
      write: (data) => setImmediate(() => events.line(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: (JSON.parse(data) as { request_id: string }).request_id } }))),
      end() {},
      kill() {},
    });
    expect(await run(['Slack'], spawn)).toMatchObject({ ok: false });
  });
});

describe('planClaudeAi', () => {
  it('allows the chosen tools, disallows every other tool of the chosen connector by exact name, and denies every other connector whole', () => {
    const plan = planClaudeAi([slack], { ok: true, servers: [SLACK, OTHER, server('Gmail', 'pending', [])] }).plan!;
    expect(plan.allowed).toEqual(['mcp__claude_ai_Slack__slack_read_channel', 'mcp__claude_ai_Slack__slack_search_public']);
    expect(plan.disallowed).toEqual(['mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Slack__slack_read_canvas']);
    expect(plan.denyServers).toEqual(['claude.ai Notion', 'claude.ai Gmail']);
    expect(plan.names).toEqual(['slack']);
    // Never a wildcard: a deny beats an allow (spike 022, finding 3).
    expect([...plan.disallowed, ...plan.denyServers].some((entry) => entry.includes('*'))).toBe(false);
  });

  it('maps characters outside A-Za-z0-9_- to _ in the prefix, and keeps the server name as is', () => {
    const customer: ClaudeAiConnector = { name: 'cio', claudeAi: 'Customer.io', tools: ['list_things'] };
    const plan = planClaudeAi([customer], { ok: true, servers: [server('Customer.io', 'connected', [['list_things', true], ['send_it', false]])] }).plan!;
    expect(plan.allowed).toEqual(['mcp__claude_ai_Customer_io__list_things']);
    expect(plan.disallowed).toEqual(['mcp__claude_ai_Customer_io__send_it']);
  });

  it('ignores a chosen tool the connector no longer lists, and says so', () => {
    const plan = planClaudeAi([{ ...slack, tools: ['slack_read_channel', 'gone_tool'] }], { ok: true, servers: [SLACK] }).plan!;
    expect(plan.allowed).toEqual(['mcp__claude_ai_Slack__slack_read_channel']);
    expect(plan.notes.join(' ')).toContain('no longer lists 1');
  });

  it('has no plan, with why, when not signed in, failed, missing, a snapshot is unavailable, or a tool name cannot go in a deny list', () => {
    expect(planClaudeAi([slack], { ok: false, error: 'gone' })).toEqual({ why: 'gone' });
    expect(planClaudeAi([slack], { ok: true, servers: [server('Slack', 'needs-auth', [])] }).why).toContain('needs-auth');
    expect(planClaudeAi([slack], { ok: true, servers: [server('Slack', 'failed', [])] }).why).toContain('failed');
    expect(planClaudeAi([slack], { ok: true, servers: [OTHER] }).why).toContain("isn't one your account lists");
    expect(planClaudeAi([slack], { ok: true, servers: [server('Slack', 'connected', [['bad,name', true], ['slack_read_channel', true]])] }).why).toContain("can't put in a deny list");
  });

  it('keeps going with the connectors that are usable and denies the one that is not', () => {
    const notion: ClaudeAiConnector = { name: 'notion', claudeAi: 'Notion', tools: ['notion-search'] };
    const plan = planClaudeAi([slack, notion], { ok: true, servers: [server('Slack', 'needs-auth', []), OTHER] }).plan!;
    expect(plan.names).toEqual(['notion']);
    expect(plan.denyServers).toEqual(['claude.ai Slack']);
    expect(plan.notes.join(' ')).toContain('needs-auth');
  });
});

describe('--connector-tools output', () => {
  it('marks read-only, no hint and may-take-a-URL, and pastes every read-only tool except the URL-looking ones', () => {
    const notion = server('Notion', 'connected', [['notion-search', true], ['notion-fetch', true], ['notion-create-pages', false], ['notion-get-users', undefined], ['download_attachment', true]]);
    const text = formatClaudeAiListing({ name: 'notion', claudeAi: 'Notion' }, notion);
    expect(text).toContain('[read-only] notion-search');
    expect(text).toMatch(/\[read-only\]\s+\[may take a URL\] notion-fetch/);
    expect(text).toMatch(/\[no hint\]\s+notion-get-users/);
    expect(text).toContain('"tools": ["notion-search"]');
    expect(mayTakeUrl('notion-search')).toBe(false);
    expect(mayTakeUrl('read_link')).toBe(true);
  });

  it('says which of the config file’s tools are gone, and lists the account’s connector names', () => {
    expect(formatClaudeAiListing({ ...slack }, { ...SLACK, tools: [{ name: 'slack_read_channel', readOnly: true }] })).toContain('No longer listed by the connector, so pitwall ignores them: slack_search_public.');
    const names = formatClaudeAiNames([SLACK, OTHER]);
    expect(names).toContain('"Slack"');
    expect(names).toContain('"Notion"');
    expect(formatClaudeAiNames([])).toContain('no claude.ai connectors');
  });
});
