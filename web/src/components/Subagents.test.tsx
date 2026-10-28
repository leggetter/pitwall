// Sub-agents in the session view (W77, docs/design-system.md, 4: Sub-agents): when the tab shows, and
// its count; when the list is asked for; its rows, order and states; a sub-agent's transcript, read-only,
// and Back; the conversation's entries named by description, with links to the tab; the tab's keys;
// and the session row's running count. Made-up sessions and sub-agents only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  subagentConversationPath,
  subagentsPath,
  type ConversationEntry,
  type ConversationPage,
  type SessionSummary,
  type SubagentList,
  type SubagentSummary,
} from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { asConversationPage } from '../conversation.js';
import { asSubagentList, runningText, sortSubagents, subagentBadge, toolCallsText } from '../subagents.js';
import { NOW, group, minutesAgo, session } from '../test/fixtures.js';
import { SUBAGENT_LINK_HINT } from './Conversation.js';
import { SessionRow } from './SessionRow.js';
import { SessionView } from './SessionView.js';
import { NO_SUBAGENTS } from './Subagents.js';

vi.mock('../xterm.js', () => ({
  createXterm: () => ({ cols: 80, rows: 24, write() {}, onData() {}, fit() {}, focus() {}, dispose() {} }),
}));

const SID = '00000000-0000-4000-8000-0000000000e7';
const API_KEY = 'k'.repeat(43);
const at = (minutes: number) => minutesAgo(minutes);

function sub(agentId: string, overrides: Partial<SubagentSummary> = {}): SubagentSummary {
  return { agentId, description: `Made-up task ${agentId}`, agentType: 'general-purpose', state: 'done', startedAt: at(30), lastActivityAt: at(20), toolCalls: 4, ...overrides };
}

/** Running, done long ago, failed, stopped, unknown and one another started, out of order, as a server might send them. */
const SUBAGENTS: SubagentSummary[] = [
  sub('a1', { description: 'Read the export job', state: 'done', startedAt: at(50), toolCalls: 12 }),
  sub('a2', { description: 'Check the retry tests', state: 'running', startedAt: at(10), lastActivityAt: at(0.2), toolCalls: 1 }),
  sub('a3', { description: 'Review the made-up auth module', state: 'failed', startedAt: at(40), agentType: 'Explore' }),
  sub('a4', { description: 'Look for flaky tests', state: 'stopped', startedAt: at(35), toolCalls: 0 }),
  sub('a5', { description: 'Summarise the logs', state: 'unknown', startedAt: at(45), agentType: undefined }),
  sub('a6', { description: 'Search the made-up docs', state: 'running', startedAt: at(5), lastActivityAt: at(1), startedBy: 'a3' }),
];

const listOf = (subagents: SubagentSummary[], truncated = false): SubagentList => ({ sessionId: SID, subagents, truncated });
const page = (entries: ConversationEntry[]): ConversationPage => ({ sessionId: SID, entries });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

type ListAnswer = SubagentList | number | 'pending';

/** A server for one session: its conversation, its sub-agents, as the test sets them, and each sub-agent's transcript. */
function fakeServer(options: { list?: ListAnswer; entries?: ConversationEntry[]; transcripts?: Record<string, ConversationEntry[]> } = {}) {
  let list: ListAnswer = options.list ?? listOf([]);
  let entries = options.entries ?? [{ kind: 'user', at: at(12), text: 'Tidy the made-up export job.' }];
  const fetch = vi.fn<FetchLike>(async (url) => {
    const path = url.split('?')[0];
    if (path === subagentsPath(SID)) {
      if (list === 'pending') return new Promise<Response>(() => {});
      return typeof list === 'number' ? new Response(null, { status: list }) : json(list);
    }
    const agent = /\/subagents\/([^/]+)\/conversation$/.exec(path ?? '')?.[1];
    if (agent !== undefined) return json(page(options.transcripts?.[agent] ?? [{ kind: 'user', at: at(9), text: `The made-up task for ${agent}.` }]));
    return json(page(entries));
  });
  return {
    fetch,
    setList(next: ListAnswer) {
      list = next;
    },
    setEntries(next: ConversationEntry[]) {
      entries = next;
    },
    /** How many times the sub-agents were asked for. */
    listed: () => fetch.mock.calls.filter(([url]) => url === subagentsPath(SID)).length,
  };
}

const settle = () => act(async () => {});

function target(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session({ sessionId: SID, name: 'pitwall-test-agents', lastActivityAt: at(1), ...overrides });
}

async function renderView(server: ReturnType<typeof fakeServer>, overrides: Partial<SessionSummary> = {}) {
  const api = createApiClient({ apiKey: API_KEY, fetch: server.fetch });
  let current = target(overrides);
  let polledAt = at(0);
  const ui = () => (
    <ApiContext.Provider value={api}>
      <SessionView session={current} listed onClose={() => {}} polledAt={polledAt} />
    </ApiContext.Provider>
  );
  const result = render(ui());
  await settle();
  await settle();
  return {
    ...result,
    async update(next: Partial<SessionSummary>) {
      current = { ...current, ...next };
      result.rerender(ui());
      await settle();
      await settle();
    },
    /** A poll: the heartbeat's newer time, with nothing else changed. */
    async poll() {
      polledAt = new Date(Date.parse(polledAt) + 5000).toISOString();
      result.rerender(ui());
      await settle();
      await settle();
    },
  };
}

const tabs = () => screen.getAllByRole('tab').map((tab) => tab.textContent?.replace(', attached', ''));
const subagentsTab = () => screen.getByRole('tab', { name: /^Sub-agents/ });
const panel = () => document.querySelector<HTMLElement>('.session-view-subagents')!;
const rowNames = () => [...panel().querySelectorAll('.subagent-open')].map((button) => button.textContent);
const row = (description: string) => [...panel().querySelectorAll<HTMLElement>('li.subagent')].find((li) => li.querySelector('.subagent-open')?.textContent === description)!;

async function openTab() {
  fireEvent.click(subagentsTab());
  await settle();
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('the Sub-agents tab: when it shows', () => {
  it('stays away for a session with none, after asking once, following its conversation', async () => {
    const server = fakeServer();
    await renderView(server);
    expect(tabs()).toEqual(['Conversation', 'Terminal']);
    expect(server.listed()).toBe(1);
    // The conversation first, then the list: never both at once.
    expect(server.fetch.mock.calls.map(([url]) => url.split('/').at(-1))).toEqual(['conversation', 'subagents']);
  });

  it('shows as the third tab with its count once the list has any, for a finished and an ended session too', async () => {
    for (const overrides of [{}, { kind: 'background' as const, shortId: 'pt000001', state: 'done' as const, alive: false, finished: true, status: undefined }, { ended: true as const, finished: true, alive: false, status: undefined }]) {
      const server = fakeServer({ list: listOf(SUBAGENTS) });
      const view = await renderView(server, overrides);
      expect(tabs().at(-1)).toBe('Sub-agents (6)');
      expect(subagentsTab().getAttribute('aria-selected')).toBe('false');
      view.unmount();
    }
  });

  it('says 200+ when the oldest were left out', async () => {
    await renderView(fakeServer({ list: listOf([sub('b1')], true) }));
    expect(subagentsTab().textContent).toBe('Sub-agents (1+)');
  });

  it('shows at once, without a count, while the snapshot counts some running and the list is on its way', async () => {
    await renderView(fakeServer({ list: 'pending' }), { subagentsRunning: 2 });
    expect(subagentsTab().textContent).toBe('Sub-agents');
  });

  it('shows when the conversation names one, and stays when the list says none', async () => {
    const server = fakeServer({
      entries: [{ kind: 'tool', at: at(3), toolName: 'Agent', text: 'Agent: Look around', subagent: { agentId: 'c1', description: 'Look around' } }],
    });
    await renderView(server);
    expect(tabs()).toEqual(['Conversation', 'Terminal', 'Sub-agents']);
    // The list didn't have it, so it was asked for again, once.
    expect(server.listed()).toBe(2);
  });

  it("isn't asked for, and doesn't show, where the server has no such route", async () => {
    const server = fakeServer({ list: 404 });
    await renderView(server);
    expect(tabs()).toEqual(['Conversation', 'Terminal']);
    expect(document.querySelector('.subagents-alert')).toBeNull();
  });
});

describe('the Sub-agents tab: its list', () => {
  it('lists running ones first, then the newest started first, as one flat list', async () => {
    await renderView(fakeServer({ list: listOf(SUBAGENTS) }));
    await openTab();
    expect(rowNames()).toEqual([
      'Search the made-up docs',
      'Check the retry tests',
      'Look for flaky tests',
      'Review the made-up auth module',
      'Summarise the logs',
      'Read the export job',
    ]);
  });

  it('gives each row its description, state badge, last activity, type, tool calls and start, and a nested one what started it', async () => {
    await renderView(fakeServer({ list: listOf(SUBAGENTS) }));
    await openTab();
    const running = row('Search the made-up docs');
    expect(running.querySelector('.badge')?.textContent).toBe('Running');
    expect(running.querySelector('.badge .status-dot')).not.toBeNull();
    expect(running.querySelector('.subagent-line time.activity')?.textContent).toBe('1m ago');
    expect(running.querySelector('.subagent-meta')?.textContent).toBe('general-purpose · , 4 tool calls · , Started 5m ago');
    expect(running.querySelector('.subagent-parent')?.textContent).toBe('Started by Review the made-up auth module');
    expect(row('Read the export job').querySelector('.badge')?.textContent).toBe('Done');
    expect(row('Review the made-up auth module').querySelector('.badge')?.textContent).toBe('Failed');
    expect(row('Look for flaky tests').querySelector('.badge')?.textContent).toBe('Stopped');
    expect(row('Look for flaky tests').querySelector('.subagent-meta')?.textContent).toContain('No tool calls');
    // Unknown: no badge at all.
    expect(row('Summarise the logs').querySelector('.badge')).toBeNull();
    expect(row('Summarise the logs').querySelector('.subagent-meta')?.textContent).toBe('4 tool calls · , Started 45m ago');
    // The button's name is the whole description; the rest of the row describes it.
    const button = within(running).getByRole('button', { name: 'Search the made-up docs' });
    const described = button.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['Running, active 1m ago', 'general-purpose · , 4 tool calls · , Started 5m ago', 'Started by Review the made-up auth module']);
  });

  it('is one Tab stop: ↓ and ↑, Home and End move between the rows, stopping at the ends', async () => {
    await renderView(fakeServer({ list: listOf(SUBAGENTS) }));
    await openTab();
    const buttons = [...panel().querySelectorAll<HTMLButtonElement>('.subagent-open')];
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    buttons[0]!.focus();
    fireEvent.keyDown(buttons[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1]);
    fireEvent.keyDown(buttons[1]!, { key: 'End' });
    expect(document.activeElement).toBe(buttons[5]);
    fireEvent.keyDown(buttons[5]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[5]);
    fireEvent.keyDown(buttons[5]!, { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('shows the empty state for a tab shown while the list says none', async () => {
    await renderView(fakeServer({ list: listOf([]) }), { subagentsRunning: 1 });
    await openTab();
    expect(panel().querySelector('.empty-state-title')?.textContent).toBe(NO_SUBAGENTS.title);
    expect(panel().querySelector('.empty-state-sentence')?.textContent).toBe(NO_SUBAGENTS.sentence);
  });

  it('a failed first list is a danger alert with Try again, and working again it gives the list, with focus kept in it', async () => {
    const server = fakeServer({ list: 500 });
    await renderView(server, { subagentsRunning: 1 });
    await openTab();
    const alert = panel().querySelector<HTMLElement>('.subagents-alert')!;
    expect(alert.className).toContain('danger');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.querySelector('.inline-alert-body')?.textContent).toBe("Couldn't load the sub-agents (HTTP 500).");
    server.setList(listOf(SUBAGENTS));
    const retry = within(alert).getByRole('button', { name: 'Try again' });
    retry.focus();
    fireEvent.click(retry);
    await settle();
    await settle();
    expect(panel().querySelector('.subagents-alert')).toBeNull();
    expect(rowNames()).toHaveLength(6);
    // Its button went with the alert: focus is on the list's first row, never the page.
    expect(document.activeElement?.textContent).toBe('Search the made-up docs');
  });

  it('a refresh that fails keeps the list, with a warning that it may be out of date', async () => {
    const server = fakeServer({ list: listOf(SUBAGENTS) });
    await renderView(server);
    server.setList(502);
    await openTab();
    expect(rowNames()).toHaveLength(6);
    const alert = panel().querySelector<HTMLElement>('.subagents-alert')!;
    expect(alert.className).toContain('warning');
    expect(alert.querySelector('.inline-alert-body')?.textContent).toBe("Couldn't refresh the sub-agents (HTTP 502), so they may be out of date.");
  });

  it('says the oldest were left out at the end of a truncated list', async () => {
    await renderView(fakeServer({ list: listOf(SUBAGENTS, true) }));
    await openTab();
    expect(panel().querySelector('.subagents-truncated')?.textContent).toBe('This session has more than 6 sub-agents, so the oldest are left out.');
  });

  it('loads when its tab opens, and again at each poll while any run and the tab is open, and once more as they stop', async () => {
    const server = fakeServer({ list: listOf(SUBAGENTS) });
    const view = await renderView(server, { subagentsRunning: 2 });
    expect(server.listed()).toBe(1);
    // Closed: a poll asks for nothing.
    await view.poll();
    expect(server.listed()).toBe(1);
    await openTab();
    expect(server.listed()).toBe(2);
    await view.poll();
    await view.poll();
    expect(server.listed()).toBe(4);
    await view.update({ subagentsRunning: undefined });
    expect(server.listed()).toBe(5);
    await view.poll();
    expect(server.listed()).toBe(5);
  });

  it('hides the message box while the tab is open: there is none for a sub-agent', async () => {
    await renderView(fakeServer({ list: listOf(SUBAGENTS) }));
    const footer = document.querySelector<HTMLElement>('.session-view-foot')!;
    expect(footer.hidden).toBe(false);
    await openTab();
    expect(footer.hidden).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Conversation' }));
    expect(footer.hidden).toBe(false);
  });
});

describe("a sub-agent's transcript", () => {
  it('opens from its row, read-only, with its heading focused, and Back returns to the list with focus on that row', async () => {
    const server = fakeServer({ list: listOf(SUBAGENTS), transcripts: { a3: [{ kind: 'assistant', at: at(39), text: 'Reading the made-up auth module.', markdown: true }] } });
    await renderView(server);
    await openTab();
    fireEvent.click(within(row('Review the made-up auth module')).getByRole('button'));
    await settle();
    await settle();
    const transcript = panel().querySelector<HTMLElement>('.subagent-transcript')!;
    expect(document.activeElement).toBe(within(transcript).getByRole('heading', { name: 'Review the made-up auth module' }));
    expect(transcript.querySelector('.badge')?.textContent).toBe('Failed');
    expect(transcript.querySelector('.entry-assistant .entry-text')?.textContent).toBe('Reading the made-up auth module.');
    expect(server.fetch.mock.calls.some(([url]) => url === subagentConversationPath(SID, 'a3'))).toBe(true);
    // Read-only: no message box, no textarea anywhere in the panel.
    expect(transcript.querySelector('textarea')).toBeNull();
    expect(document.querySelector<HTMLElement>('.session-view-foot')?.hidden).toBe(true);
    expect(within(transcript).getByRole('region', { name: 'Review the made-up auth module' })).toBeTruthy();

    fireEvent.click(within(transcript).getByRole('button', { name: 'Back to sub-agents' }));
    await settle();
    expect(panel().querySelector('.subagent-transcript')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Review the made-up auth module');
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
  });

  it("labels what started or messaged it as the session's, or the sub-agent's that started it, never as yours", async () => {
    const task: ConversationEntry[] = [{ kind: 'user', at: at(9), text: 'The made-up task.' }];
    await renderView(fakeServer({ list: listOf(SUBAGENTS), transcripts: { a1: task, a6: task } }));
    await openTab();
    const speaker = () => panel().querySelector('.subagent-transcript li.entry-user .entry-speaker')?.textContent?.replace(/ · .*$/, '');
    fireEvent.click(within(row('Read the export job')).getByRole('button'));
    await settle();
    await settle();
    expect(speaker()).toBe('From the session');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Back to sub-agents' }));
    await settle();
    fireEvent.click(within(row('Search the made-up docs')).getByRole('button'));
    await settle();
    await settle();
    expect(speaker()).toBe('From sub-agent: Review the made-up auth module');
    // Its name links to the transcript of the one that started it.
    fireEvent.click(panel().querySelector<HTMLElement>('.subagent-transcript li.entry-user .subagent-link')!);
    await settle();
    await settle();
    expect(document.activeElement).toBe(within(panel()).getByRole('heading', { name: 'Review the made-up auth module' }));
  });

  it("has Load earlier and Jump to latest, as the session's conversation does", async () => {
    const server = fakeServer({ list: listOf(SUBAGENTS) });
    server.fetch.mockImplementation(async (url) => {
      if (url === subagentsPath(SID)) return json(listOf(SUBAGENTS));
      if (url.startsWith(subagentConversationPath(SID, 'a1'))) return json({ ...page([{ kind: 'user', at: at(48), text: 'The made-up task.' }]), before: 'cursor-1' });
      return json(page([]));
    });
    await renderView(server);
    await openTab();
    fireEvent.click(within(row('Read the export job')).getByRole('button'));
    await settle();
    await settle();
    expect(within(panel()).getByRole('button', { name: 'Load earlier' })).toBeTruthy();
  });
});

describe('the conversation names sub-agents by their description', () => {
  const ENTRIES: ConversationEntry[] = [
    { kind: 'tool', at: at(8), toolName: 'Agent', text: 'Agent: Review the made-up auth module', subagent: { agentId: 'a3', description: 'Review the made-up auth module' } },
    { kind: 'cross-session', at: at(6), from: 'a3', text: 'The made-up module looks fine.', markdown: true, subagent: { agentId: 'a3', description: 'Review the made-up auth module' } },
    { kind: 'tool', at: at(4), toolName: 'SendMessage', text: 'SendMessage', subagent: { agentId: 'a3', description: 'Review the made-up auth module' } },
  ];

  it('a report reads "From sub-agent: *description*", and the Agent and SendMessage lines name it, each with a link', async () => {
    await renderView(fakeServer({ list: listOf(SUBAGENTS), entries: ENTRIES }));
    const conversation = document.querySelector<HTMLElement>('.conversation')!;
    expect(conversation.querySelector('.entry-cross-session .entry-speaker')?.textContent).toMatch(/^From sub-agent: Review the made-up auth module · /);
    expect([...conversation.querySelectorAll('.tool-call-text')].map((line) => line.textContent)).toEqual(['Agent: Review the made-up auth module', 'SendMessage to Review the made-up auth module']);
    const links = [...conversation.querySelectorAll<HTMLButtonElement>('.subagent-link')];
    expect(links.map((link) => link.textContent)).toEqual(['Review the made-up auth module', 'Review the made-up auth module', 'Review the made-up auth module']);
    expect(document.getElementById(links[0]!.getAttribute('aria-describedby')!.split(' ')[0]!)?.textContent).toBe(SUBAGENT_LINK_HINT);
  });

  it("a link opens its transcript in the Sub-agents tab, with focus on its heading; Back goes to the list with focus on its row", async () => {
    await renderView(fakeServer({ list: listOf(SUBAGENTS), entries: ENTRIES }));
    const report = document.querySelector<HTMLElement>('.entry-cross-session .subagent-link')!;
    report.focus();
    fireEvent.click(report);
    await settle();
    await settle();
    expect(subagentsTab().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(within(panel()).getByRole('heading', { name: 'Review the made-up auth module' }));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Back to sub-agents' }));
    await settle();
    expect(document.activeElement?.textContent).toBe('Review the made-up auth module');
    expect(document.activeElement?.closest('li.subagent')).not.toBeNull();
  });

  it("reads the sub-agent a report or a call is about, and drops one that isn't well formed", () => {
    const odd = [...ENTRIES, { kind: 'cross-session', at: at(2), text: 'x', subagent: { agentId: 'not an id', description: 'x' } }, { kind: 'user', at: at(1), text: 'y', subagent: { agentId: 'a3', description: 'y' } }];
    const parsed = asConversationPage(page(odd as ConversationEntry[]), SID);
    expect(parsed?.entries.map((entry) => entry.subagent?.agentId)).toEqual(['a3', 'a3', 'a3', undefined, undefined]);
  });
});

describe("the tabs' keys", () => {
  it('← and → reach Sub-agents and wrap, and only Enter, Space or a click opens it', async () => {
    await renderView(fakeServer({ list: listOf(SUBAGENTS) }));
    const conversation = screen.getByRole('tab', { name: 'Conversation' });
    conversation.focus();
    fireEvent.keyDown(conversation, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(subagentsTab());
    expect(subagentsTab().getAttribute('aria-selected')).toBe('false');
    fireEvent.keyDown(subagentsTab(), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(conversation);
    fireEvent.keyDown(conversation, { key: 'End' });
    expect(document.activeElement).toBe(subagentsTab());
    fireEvent.click(subagentsTab());
    await settle();
    expect(subagentsTab().getAttribute('aria-selected')).toBe('true');
    expect(subagentsTab().tabIndex).toBe(0);
    expect(panel().getAttribute('role')).toBe('tabpanel');
    expect(panel().getAttribute('aria-labelledby')).toBe(subagentsTab().id);
  });
});

describe("the session row's running count", () => {
  const rowFor = (overrides: Partial<SessionSummary>, showGroup = true) => {
    const s = session({ name: 'pitwall-test-row', ...overrides });
    return render(
      <ul>
        <SessionRow session={s} group={group({ sessions: [s] })} showGroup={showGroup} onOpen={() => {}} />
      </ul>,
    );
  };

  it('ends line 2 with "· 2 sub-agents running" while any run, and says nothing otherwise', () => {
    const many = rowFor({ subagentsRunning: 2, lastUserPrompt: 'Tidy the made-up export job.' });
    expect(many.container.querySelector('.session-what')?.textContent).toBe('demo-app · You: Tidy the made-up export job. · 2 sub-agents running');
    expect(many.container.querySelector('.session-running')?.textContent).toBe(' · 2 sub-agents running');
    many.unmount();
    const one = rowFor({ subagentsRunning: 1 }, false);
    expect(one.container.querySelector('.session-running')?.textContent).toMatch(/1 sub-agent running$/);
    one.unmount();
    const alone = rowFor({ subagentsRunning: 1, lastUserPrompt: undefined }, false);
    expect(alone.container.querySelector('.session-what')?.textContent).toBe('1 sub-agent running');
    alone.unmount();
    const none = rowFor({ subagentsRunning: undefined });
    expect(none.container.querySelector('.session-running')).toBeNull();
  });
});

describe('subagents.ts', () => {
  it('reads a list, dropping entries that are not well formed and sorting it as the tab shows it', () => {
    const list = asSubagentList(
      {
        sessionId: SID,
        truncated: true,
        subagents: [
          sub('ok1', { state: 'done', startedAt: at(9) }),
          { ...sub('bad1'), agentId: 'has spaces' },
          { ...sub('bad2'), toolCalls: -1 },
          { ...sub('odd'), state: 'paused', startedAt: at(1) },
          sub('run', { state: 'running', startedAt: at(60) }),
          { ...sub('nostart'), startedAt: 'not a time' },
        ],
      },
      SID,
    );
    expect(list?.truncated).toBe(true);
    expect(list?.subagents.map((each) => `${each.agentId}:${each.state}`)).toEqual(['run:running', 'odd:unknown', 'ok1:done', 'nostart:done']);
    expect(asSubagentList({ sessionId: 'another', subagents: [] }, SID)).toBeUndefined();
    expect(asSubagentList({ sessionId: SID }, SID)).toBeUndefined();
  });

  it('keeps the order among equals', () => {
    const same = [sub('x', { startedAt: at(5) }), sub('y', { startedAt: at(5) })];
    expect(sortSubagents(same).map((each) => each.agentId)).toEqual(['x', 'y']);
  });

  it('words its counts and badges', () => {
    expect([toolCallsText(0), toolCallsText(1), toolCallsText(1234)]).toEqual(['No tool calls', '1 tool call', '1,234 tool calls']);
    expect([runningText(1), runningText(2)]).toEqual(['1 sub-agent running', '2 sub-agents running']);
    expect((['running', 'done', 'failed', 'stopped', 'unknown'] as const).map((state) => subagentBadge(state)?.label)).toEqual(['Running', 'Done', 'Failed', 'Stopped', undefined]);
    expect(subagentBadge('running')?.dot).toBe(true);
  });
});
