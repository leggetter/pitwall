// Ask the supervisor (W178): a session's actions menu and a PR's view open the supervisor's panel with its
// message box started for you to finish, "About the session ..." with its name and id, appended after
// any draft, and never sent (D4). Offered only while pitwall runs a supervisor. Made-up sessions and PRs only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IndexSnapshot, PullRequestSummary, SupervisorState } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { BACKGROUND_TAB_KEY } from '../backgroundTab.js';
import type { StorageSource } from '../groupState.js';
import { ASK_PR_TITLE_MAX, ASK_SUPERVISOR, askAboutPr, askAboutSession } from '../supervisor.js';
import { group, pr, prList, session, snapshot, withoutSubagents } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { Dashboard } from './Dashboard.js';

const ROOT = '/Users/example/code';
const alpha = session({ sessionId: '00000000-0000-4000-8000-00000000a178', name: 'pitwall-test-alpha', cwd: `${ROOT}/demo-app` });
const idle: SupervisorState = { status: 'idle', approvals: [] };
const here = (each: PullRequestSummary): PullRequestSummary => ({ ...each, place: { kind: 'cloned', root: ROOT, key: `${ROOT}/demo-app`, label: 'demo-app' } });
const change = here(pr({ number: 31 }, 20));

const snap = (supervisor: SupervisorState | null = idle): IndexSnapshot =>
  snapshot([group({ key: `${ROOT}/demo-app`, label: 'demo-app', sessions: [alpha] })], { roots: [ROOT], ...(supervisor ? { supervisor } : {}) });

function memory(): StorageSource {
  const values = new Map<string, string>([[BACKGROUND_TAB_KEY, 'conversation']]);
  return () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) });
}

function renderDashboard(first: IndexSnapshot, search = '?view=all') {
  const fetch = vi.fn<FetchLike>(async (url) => {
    if (url.startsWith('/api/supervisor')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ sessionId: 'x', entries: [] }), { status: 200 });
  });
  const history = fakeHistory(search);
  const api = createApiClient({ apiKey: 'k'.repeat(43), fetch: withoutSubagents(fetch) });
  const storage = memory();
  render(
    <ApiContext.Provider value={api}>
      <Dashboard view={{ state: 'live', snapshot: first, prs: prList([change]) }} navigation={history.navigation} storage={storage} />
    </ApiContext.Provider>,
  );
  return { fetch, history };
}

const settle = () => act(async () => {});
const panel = () => document.getElementById('supervisor-view') ?? undefined;
const sessionView = () => document.getElementById('session-view')!;
const box = () => within(panel()!).getByRole('textbox') as HTMLTextAreaElement;
const posts = (fetch: ReturnType<typeof vi.fn<FetchLike>>) => fetch.mock.calls.filter(([, init]) => init.method === 'POST');

async function askFromMenu() {
  fireEvent.click(screen.getByRole('button', { name: alpha.name }));
  await settle();
  fireEvent.click(within(sessionView()).getByRole('button', { name: 'Session actions' }));
  fireEvent.click(within(sessionView()).getByRole('menuitem', { name: ASK_SUPERVISOR }));
  await settle();
}

describe('the texts', () => {
  it('name the session and its id, or the PR, on one line, ready to finish', () => {
    expect(askAboutSession({ name: 'a\nb  c', sessionId: 'abc' })).toBe('About the session "a b c" (id abc): ');
    expect(askAboutPr({ repoLabel: 'example/demo-app', number: 4, title: ' Fix\nit ' })).toBe('About the pull request example/demo-app#4 (Fix it): ');
    const long = askAboutPr({ repoLabel: 'example/demo-app', number: 5, title: 'x'.repeat(500) });
    expect(long).toBe(`About the pull request example/demo-app#5 (${'x'.repeat(ASK_PR_TITLE_MAX - 1)}…): `);
  });
});

describe('Ask the supervisor from a session', () => {
  it('opens the panel with the box started for you, focus in it, and sends nothing', async () => {
    const { fetch, history } = renderDashboard(snap());
    await askFromMenu();
    expect(history.location.search).toContain('supervisor');
    expect(box().value).toBe(askAboutSession(alpha));
    expect(document.activeElement).toBe(box());
    expect(posts(fetch)).toEqual([]);
  });

  it('adds to a draft already in the box, on a line of its own, instead of replacing it', async () => {
    renderDashboard(snap(), '?view=all&supervisor');
    await settle();
    fireEvent.change(box(), { target: { value: 'First, a thought' } });
    await askFromMenu();
    expect(box().value).toBe(`First, a thought\n\n${askAboutSession(alpha)}`);
  });

  it('is not offered while pitwall runs no supervisor', async () => {
    renderDashboard(snap(null));
    fireEvent.click(screen.getByRole('button', { name: alpha.name }));
    await settle();
    fireEvent.click(within(sessionView()).getByRole('button', { name: 'Session actions' }));
    expect(within(sessionView()).queryByRole('menuitem', { name: ASK_SUPERVISOR })).toBeNull();
  });
});

describe('Ask the supervisor from a PR', () => {
  it('is a button in the PR view that starts the box with the PR, and sends nothing', async () => {
    const { fetch } = renderDashboard(snap(), '?view=prs&pr=example/demo-app/31');
    await settle();
    const view = document.getElementById('pr-view')!;
    fireEvent.click(within(view).getByRole('button', { name: ASK_SUPERVISOR }));
    await settle();
    expect(box().value).toBe(askAboutPr(change));
    expect(posts(fetch)).toEqual([]);
  });

  it('is not offered while pitwall runs no supervisor', async () => {
    renderDashboard(snap(null), '?view=prs&pr=example/demo-app/31');
    await settle();
    expect(within(document.getElementById('pr-view')!).queryByRole('button', { name: ASK_SUPERVISOR })).toBeNull();
  });
});
