// Starting a session for a pull request (W107; docs/design-system.md, 4: Pull requests): a PR row's
// New session, prefilled in its clone; Clone and start for a repo that isn't cloned, its confirmation,
// its failure and the New session that follows, with how to trust the new folder; the 'prompted' link
// that makes the new session the PR's owner at once; the PR view's own action; and Resume on the row
// of a finished session that owns an open PR, and in a stopped background session's view. Made-up
// PRs and sessions only, and a fake server: nothing here reaches gh or a session.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLONE_PATH, resumePath, SPAWN_PATH, type IndexSnapshot, type PullRequestList, type PullRequestPlace, type PullRequestSummary, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { AttachContext, type AttachEnv } from '../attach.js';
import type { StorageSource } from '../groupState.js';
import { prKey } from '../prs.js';
import { memoryNavigation } from '../selection.js';
import { fakeSockets, group, minutesAgo, NOW, pr, prLink, prList, session, snapshot } from '../test/fixtures.js';
import { toastMessages } from '../test/toasts.js';
import { CLONE_TITLE, CLONED_TRUST_TEXT, clonedText } from './CloneDialog.js';
import { Dashboard, startedText } from './Dashboard.js';
import { resumedText } from './EndedSession.js';
import { RESUME_HINT_IN_VIEW, rowResumeLabel } from './RowResume.js';
import { BACKGROUND_NOTES } from './SessionView.js';
import type { TerminalHandle } from './Terminal.js';

class QuietTerminal implements TerminalHandle {
  cols = 80;
  rows = 24;
  write() {}
  onData() {}
  fit() {}
  focus() {}
  dispose() {}
}
vi.mock('../xterm.js', () => ({ createXterm: () => new QuietTerminal() }));

const ROOT = '/Users/example/code';
const DEMO = `${ROOT}/demo-app`;
const DOCS = `${ROOT}/Docs-Site`;
const placed = (each: PullRequestSummary, place: PullRequestPlace): PullRequestSummary => ({ ...each, place });

// #57 asks your review in demo-app, which is cloned; #5 is yours in example/Docs-Site, which isn't; #31
// is owned by the ended session `ended-owner`, and #40 by the stopped job `stopped-owner`.
const review = placed(pr({ number: 57, relation: 'review-requested', reviewRequest: { via: 'direct' }, title: 'Add a made-up retry budget' }, 40), { kind: 'cloned', root: ROOT, key: DEMO, label: 'demo-app' });
const docs = placed(pr({ number: 5, repoLabel: 'example/Docs-Site', checks: 'failing', failingChecks: ['build'] }, 60), { kind: 'not-cloned', root: ROOT });
const endedWork = placed(pr({ number: 31 }, 90), { kind: 'cloned', root: ROOT, key: DEMO, label: 'demo-app' });
const stoppedWork = placed(pr({ number: 40 }, 100), { kind: 'cloned', root: ROOT, key: DEMO, label: 'demo-app' });
const PRS = [review, docs, endedWork, stoppedWork];

const STARTED = { shortId: 'pt107', name: 'pr-57' } as const;
const ENDED_ID = '00000000-0000-4000-8000-000000107031';
const STOPPED_ID = '00000000-0000-4000-8000-000000107040';

function sessions(started?: SessionSummary): SessionSummary[] {
  const alpha = session({ name: 'alpha', cwd: DEMO });
  const ended = session({ sessionId: ENDED_ID, name: 'ended-owner', cwd: DEMO, alive: false, pid: undefined, status: undefined, finished: true, ended: true, prLinks: [prLink('opened', endedWork, 3 * 24 * 60)], lastActivityAt: minutesAgo(60) });
  const stopped = session({
    sessionId: STOPPED_ID,
    name: 'stopped-owner',
    kind: 'background',
    shortId: 'pt040',
    cwd: DEMO,
    alive: false,
    pid: undefined,
    status: undefined,
    state: 'stopped',
    finished: true,
    prLinks: [prLink('opened', stoppedWork, 60)],
    lastActivityAt: minutesAgo(70),
  });
  return [alpha, ended, stopped, ...(started ? [started] : [])];
}

const snap = (started?: SessionSummary): IndexSnapshot => snapshot([group({ key: DEMO, label: 'demo-app', root: ROOT, sessions: sessions(started) })], { roots: [ROOT] });

/** The session the fake server started, as the next snapshot lists it, before the index has read its prompt: no links yet. */
const startedSession = (cwd = DEMO) =>
  session({ sessionId: '00000000-0000-4000-8000-000000107999', name: STARTED.name, kind: 'background', shortId: STARTED.shortId, state: 'working', status: undefined, pid: undefined, cwd, lastActivityAt: minutesAgo(0) });

interface Server {
  fetch: ReturnType<typeof vi.fn<FetchLike>>;
  posts: () => { url: string; body: unknown }[];
}

/** A fake pitwall: spawn starts STARTED; clone answers `clone`; resume answers `resume`; GETs a page of nothing. */
function fakeServer(options: { clone?: [number, unknown]; resume?: [number, unknown] } = {}): Server {
  const posts: { url: string; body: unknown }[] = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === SPAWN_PATH) return new Response(JSON.stringify({ ok: true, ...STARTED }), { status: 201 });
      if (url === CLONE_PATH) {
        const [status, body] = options.clone ?? [201, { ok: true, cwd: DOCS, hint: `cd ${DOCS} && claude` }];
        return new Response(JSON.stringify(body), { status });
      }
      if (url.endsWith('/resume')) {
        const [status, body] = options.resume ?? [200, { ok: true, shortId: 'pt031' }];
        return new Response(JSON.stringify(body), { status });
      }
      return new Response(JSON.stringify({ ok: false, error: 'not in this test' }), { status: 409 });
    }
    return new Response(JSON.stringify({ sessionId: 'x', entries: [] }), { status: 200 });
  });
  return { fetch, posts: () => posts };
}

function memory(): StorageSource {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return () => storage;
}

function renderDashboard(server: Server = fakeServer(), search = '?view=all', list: PullRequestList = prList(PRS)) {
  const api = createApiClient({ apiKey: 'k'.repeat(43), fetch: server.fetch });
  const navigation = memoryNavigation(search);
  const storage = memory();
  const attach: AttachEnv = { token: 'pitwall-test-token-0123456789abcdefghijklmnop', createSocket: fakeSockets().factory, host: '127.0.0.1:4517' };
  const ui = (s: IndexSnapshot, l: PullRequestList) => (
    <ApiContext.Provider value={api}>
      <AttachContext.Provider value={attach}>
        <Dashboard view={{ state: 'live', snapshot: s, prs: l }} navigation={navigation} storage={storage} />
      </AttachContext.Provider>
    </ApiContext.Provider>
  );
  const result = render(ui(snap(), list));
  return {
    ...result,
    update: async (s: IndexSnapshot, l: PullRequestList = list) => {
      result.rerender(ui(s, l));
      await settle();
    },
  };
}

const settle = () => act(async () => {});
const main = () => screen.getByRole('main');
const prRow = (each: PullRequestSummary) => main().querySelector<HTMLElement>(`li[data-pr="${prKey(each)}"]`);
const startButton = (each: PullRequestSummary) => prRow(each)?.querySelector<HTMLButtonElement>('[data-start-pr]');
const dialog = (name: string) => screen.getByRole('dialog', { name });
const field = (name: 'Name' | 'First prompt') => within(dialog('New session')).getByRole('textbox', { name: name === 'Name' ? /^Name/ : name }) as HTMLInputElement | HTMLTextAreaElement;
const directory = () => within(dialog('New session')).getByRole('combobox', { name: 'Directory' }) as HTMLSelectElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('New session for a PR row in a cloned repo', () => {
  it('is the row’s action, named for the PR, and opens New session prefilled in its clone', async () => {
    renderDashboard();
    const button = startButton(review)!;
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(document.getElementById(button.getAttribute('aria-labelledby') ?? '')?.textContent ?? button.getAttribute('aria-label')).toBe('New session for #57');
    fireEvent.click(button);
    expect(directory().value).toBe(DEMO);
    expect(field('Name').value).toBe('pr-57');
    expect(field('First prompt').value).toBe(`Review ${review.url}. Tell me what it changes and what you'd ask its author for, before you post anything on GitHub.`);
    // It didn't open the PR's view: the action is the row's control.
    expect(document.getElementById('pr-view')).toBeNull();
  });

  it('starts it there, and links the new session to the PR at once, so its row goes into the session’s', async () => {
    const server = fakeServer();
    const { update } = renderDashboard(server);
    fireEvent.click(startButton(review)!);
    fireEvent.click(within(dialog('New session')).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
    expect(server.posts()).toEqual([{ url: SPAWN_PATH, body: { cwd: DEMO, name: 'pr-57', prompt: expect.stringContaining(review.url) } }]);
    expect(toastMessages()).toContain(startedText(STARTED.name));
    // Listed, with no link of its own yet: the page's pending one makes it the owner.
    await update(snap(startedSession()));
    expect(prRow(review)).toBeNull();
    const row = within(main()).getByRole('button', { name: STARTED.name }).closest('li')!;
    expect(row.querySelector('.pr-badge')?.textContent).toMatch(/#57/);
  });

  it('links nothing when the prompt sent no longer names the PR', async () => {
    const { update } = renderDashboard();
    fireEvent.click(startButton(review)!);
    fireEvent.change(field('First prompt'), { target: { value: 'Something else, with no link.' } });
    fireEvent.click(within(dialog('New session')).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
    await update(snap(startedSession()));
    expect(prRow(review)).not.toBeNull();
  });

  it('closes on the backdrop until something is changed, since a prefill isn’t typing', () => {
    renderDashboard();
    fireEvent.click(startButton(review)!);
    fireEvent.pointerDown(document.querySelector('.dialog-backdrop')!);
    fireEvent.click(document.querySelector('.dialog-backdrop')!);
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
    fireEvent.click(startButton(review)!);
    const backdrop = document.querySelector('.dialog-backdrop')!;
    fireEvent.change(field('Name'), { target: { value: 'pr-57-b' } });
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog', { name: 'New session' })).not.toBeNull();
  });
});

describe('Clone and start for a PR row in a repo that isn’t cloned', () => {
  it('shows exactly what it will do first, and sends only the repo', async () => {
    const server = fakeServer();
    renderDashboard(server);
    const button = startButton(docs)!;
    fireEvent.click(button);
    const confirm = dialog(CLONE_TITLE);
    expect(confirm.querySelector('.clone-what')?.textContent).toBe('Clone example/Docs-Site into ~/code/Docs-Site');
    expect(server.posts()).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Clone' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: CLONE_TITLE })).toBeNull());
    expect(server.posts()).toEqual([{ url: CLONE_PATH, body: { repo: 'example/docs-site' } }]);
  });

  it('then opens New session in the new clone, saying how to trust it, with the command to copy', async () => {
    const server = fakeServer();
    renderDashboard(server);
    fireEvent.click(startButton(docs)!);
    fireEvent.click(within(dialog(CLONE_TITLE)).getByRole('button', { name: 'Clone' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).not.toBeNull());
    const notice = dialog('New session').querySelector('.cloned-notice')!;
    expect(notice.querySelector('.inline-alert-title')?.textContent).toBe(clonedText('example/Docs-Site', DOCS));
    expect(notice.textContent).toContain(CLONED_TRUST_TEXT);
    expect(notice.querySelector('.command-chip')?.textContent).toBe(`cd ${DOCS} && claude`);
    expect(directory().value).toBe(DOCS);
    expect(field('Name').value).toBe('pr-5');
    expect(field('First prompt').value).toBe(`Fix the failing checks on ${docs.url}.`);
    fireEvent.click(within(dialog('New session')).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
    expect(server.posts().at(-1)).toEqual({ url: SPAWN_PATH, body: { cwd: DOCS, name: 'pr-5', prompt: expect.stringContaining(docs.url) } });
  });

  it('from the repo’s own not-cloned group, follows the clone to its group, once the list places the PR under it', async () => {
    const { update } = renderDashboard(fakeServer(), '?repo=github.com/example/docs-site');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('example/Docs-Site');
    fireEvent.click(startButton(docs)!);
    fireEvent.click(within(dialog(CLONE_TITLE)).getByRole('button', { name: 'Clone' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).not.toBeNull());
    fireEvent.click(within(dialog('New session')).getByRole('button', { name: 'Cancel' }));
    await update(snap(), prList(PRS.map((each) => (each === docs ? placed(docs, { kind: 'cloned', root: ROOT, key: DOCS, label: 'Docs-Site' }) : each))));
    expect(main().querySelector('.session-list-label')?.textContent).toBe('Docs-Site');
    expect(prRow(docs)).not.toBeNull();
  });

  it('says what failed in pitwall’s words, and stays open, when the server refuses', async () => {
    renderDashboard(fakeServer({ clone: [409, { ok: false, error: '/Users/example/code/Docs-Site already exists, so pitwall didn’t clone into it.' }] }));
    fireEvent.click(startButton(docs)!);
    fireEvent.click(within(dialog(CLONE_TITLE)).getByRole('button', { name: 'Clone' }));
    const alert = await within(dialog(CLONE_TITLE)).findByRole('alert');
    expect(alert.textContent).toBe('Couldn’t clone example/Docs-Site. /Users/example/code/Docs-Site already exists, so pitwall didn’t clone into it.'.replace('Couldn’t', "Couldn't"));
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
  });
});

describe('the PR view’s action', () => {
  it('offers New session, or Clone and start, while no session owns the PR, and nothing once one does', async () => {
    const { update } = renderDashboard(fakeServer(), `?view=all&pr=${prKey(review)}`);
    const view = () => document.getElementById('pr-view')!;
    expect(within(view()).getByRole('button', { name: 'New session' })).toBeTruthy();
    fireEvent.click(within(view()).getByRole('button', { name: 'New session' }));
    expect(field('Name').value).toBe('pr-57');
    fireEvent.click(within(dialog('New session')).getByRole('button', { name: 'Cancel' }));
    const owner = session({ name: 'owner', cwd: DEMO, prLinks: [prLink('opened', review, 1)] });
    await update(snapshot([group({ key: DEMO, label: 'demo-app', root: ROOT, sessions: [...sessions(), owner] })], { roots: [ROOT] }));
    expect(within(view()).queryByRole('button', { name: 'New session' })).toBeNull();
  });
});

describe('Resume on the row of a finished session that owns an open PR', () => {
  it('is offered on the ended one’s row and the stopped job’s, not on a running session’s', () => {
    renderDashboard();
    const resumeOf = (name: string) => within(main()).getByRole('button', { name }).closest('li')!.querySelector('[data-resume-session]');
    expect(resumeOf('ended-owner')?.getAttribute('data-resume-session')).toBe(ENDED_ID);
    expect(resumeOf('stopped-owner')?.getAttribute('data-resume-session')).toBe(STOPPED_ID);
    expect(resumeOf('alpha')).toBeNull();
  });

  it('resumes it through the resume route, says so in a toast, and is busy meanwhile', async () => {
    const server = fakeServer();
    renderDashboard(server);
    const button = main().querySelector<HTMLButtonElement>(`[data-resume-session="${ENDED_ID}"]`)!;
    fireEvent.click(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await waitFor(() => expect(toastMessages()).toContain(resumedText('ended-owner')));
    expect(server.posts()).toEqual([{ url: resumePath(ENDED_ID), body: {} }]);
  });

  it('says where the trust command is when Claude Code doesn’t trust the folder', async () => {
    renderDashboard(fakeServer({ resume: [422, { ok: false, error: 'Workspace not trusted. Made up.', hint: `cd ${DEMO} && claude` }] }));
    fireEvent.click(main().querySelector<HTMLButtonElement>(`[data-resume-session="${STOPPED_ID}"]`)!);
    await waitFor(() => expect(toastMessages().some((message) => message.endsWith(RESUME_HINT_IN_VIEW))).toBe(true));
    expect(toastMessages().find((message) => message.endsWith(RESUME_HINT_IN_VIEW))).toBe(`Couldn't resume stopped-owner. Workspace not trusted. Made up. ${RESUME_HINT_IN_VIEW}`);
    expect(rowResumeLabel('stopped-owner')).toBe('Resume stopped-owner in the background');
  });

  it('is in a stopped background session’s view too, beside how to message it', () => {
    renderDashboard(fakeServer(), `?view=all&session=${STOPPED_ID}`);
    const view = document.getElementById('session-view')!;
    expect(view.querySelector('.session-view-foot')?.textContent).toContain(BACKGROUND_NOTES.resumable);
    expect(within(view).getByRole('button', { name: 'Resume in background' })).toBeTruthy();
  });
});
