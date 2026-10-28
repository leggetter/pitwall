// Ended interactive sessions in the web UI (W67): listed in their group's Finished section, muted and
// labelled Ended, never in Needs you; those older than ENDED_SHOWN_DAYS hidden from every list, count
// and the repo list until Show older, one switch for the page that isn't stored; and the session view
// of one: the Conversation tab alone, Ended, a footer with Resume in background and Copy command, and
// each result of a resume, after which the view shows it as the running background session it now is.
// Made-up sessions only, a fake server and fake sockets: nothing here reaches a session.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENDED_SHOWN_DAYS, PROTOCOL_VERSION, resumePath, type ConversationPage, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { AttachContext, type AttachEnv } from '../attach.js';
import { draftKey } from '../drafts.js';
import type { StorageSource } from '../groupState.js';
import { isOlderEnded, posixQuote, resumeCommand, statusBadge, withoutOlderEnded, needsAttention } from '../sessions.js';
import { STARRED_KEY } from '../starred.js';
import { fakeSockets, group, minutesAgo, NOW, session, snapshot, type FakeSocket } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { toastMessages, toastSaying } from '../test/toasts.js';
import { Dashboard } from './Dashboard.js';
import {
  COPY_STARTED,
  ENDED_GONE_NOTE,
  ENDED_NOTE,
  RESUME_HINT_TEXT,
  RESUME_LISTED_MS,
  resumedText,
  resumeToast,
} from './EndedSession.js';
import { KEPT_NOT_RUNNING } from './RelayBox.js';
import { OLDER_NOTE, olderText } from './SessionList.js';
import { ENDED_ASKED_HINT } from './SessionRow.js';
import { BG_NOTE } from './SessionView.js';
import type { TerminalHandle } from './Terminal.js';

// xterm.js, replaced by a terminal whose screen is a textarea, so where focus goes can be seen.
class FakeTerminal implements TerminalHandle {
  cols = 80;
  rows = 24;
  readonly screen: HTMLTextAreaElement;
  constructor(container: HTMLElement) {
    this.screen = document.createElement('textarea');
    this.screen.className = 'fake-terminal';
    container.append(this.screen);
  }
  write() {}
  onData() {}
  fit() {}
  focus() {
    this.screen.focus();
  }
  dispose() {
    this.screen.remove();
  }
}
const terminals: FakeTerminal[] = [];
vi.mock('../xterm.js', () => ({
  createXterm: (container: HTMLElement) => {
    const terminal = new FakeTerminal(container);
    terminals.push(terminal);
    return terminal;
  },
}));

const API_KEY = 'k'.repeat(43);
const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const NONCE = 'n'.repeat(43);
const DAY = 24 * 60;
const CODE = '/Users/example/code';
const DEMO = `${CODE}/demo-app`;
const NOTES = `${CODE}/notes`;
const id = (n: number) => `00000000-0000-4000-8000-0000000067${String(n).padStart(2, '0')}`;
const LIVE = id(1);
const ENDED = id(2);
const ENDED_OLD = id(4);
const DONE = id(6);

/** An ended interactive session, as W66 lists one: interactive, finished, no process, no status or state. */
const ended = (n: number, name: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  session({ sessionId: id(n), name, cwd: DEMO, ended: true, finished: true, alive: false, pid: undefined, status: undefined, ...extra });

/**
 * demo-app: demo-live, a running interactive session; demo-ended, ended two days ago; demo-ended-asked,
 * ended yesterday, having asked something; demo-ended-old, ended ten days ago; job-done, a finished
 * background session; demo-ended-gone, whose directory has gone. notes: notes-ended-old, alone, ended
 * twenty days ago, so the group has only an older ended session.
 */
function sessions(): SessionSummary[] {
  return [
    session({ sessionId: LIVE, name: 'demo-live', lastActivityAt: minutesAgo(5) }),
    ended(2, 'demo-ended', { title: 'Tidy the made-up export job', lastActivityAt: minutesAgo(2 * DAY) }),
    ended(3, 'demo-ended-asked', { lastActivityAt: minutesAgo(DAY), askedYou: { reason: 'question', excerpt: 'Should the made-up export keep archived rows?' } }),
    ended(4, 'demo-ended-old', { lastActivityAt: minutesAgo(10 * DAY) }),
    session({ sessionId: DONE, name: 'job-done', kind: 'background', shortId: 'pt6706', state: 'done', alive: false, pid: undefined, status: undefined, finished: true, lastActivityAt: minutesAgo(3 * DAY) }),
    ended(7, 'demo-ended-gone', { cwd: `${DEMO}/.claude/worktrees/pitwall-test-gone`, cwdMissing: true, lastActivityAt: minutesAgo(4 * DAY) }),
  ];
}
const notes = () => [ended(5, 'notes-ended-old', { cwd: NOTES, lastActivityAt: minutesAgo(20 * DAY) })];
const snap = (demo: SessionSummary[] = sessions(), notesSessions: SessionSummary[] = notes()): IndexSnapshot =>
  snapshot([group({ key: DEMO, label: 'demo-app', sessions: demo }), ...(notesSessions.length > 0 ? [group({ key: NOTES, label: 'notes', kind: 'directory', sessions: notesSessions })] : [])]);

/** A second root, ~/oss, with one running session in blog, so the header has a tab per root (W38). */
const OSS = '/Users/example/oss';
const BLOG = `${OSS}/blog`;
const twoRoots = (demo: SessionSummary[] = sessions()): IndexSnapshot => {
  const one = snap(demo);
  const blog = group({ key: BLOG, label: 'blog', root: OSS, sessions: [session({ sessionId: id(8), name: 'blog-live', cwd: BLOG, lastActivityAt: minutesAgo(1) })] });
  return { ...one, roots: [CODE, OSS], groups: [...one.groups, blog] };
};
/** Opens a root tab by its label, as shown. */
function openRoot(label: string) {
  const tab = [...document.querySelectorAll<HTMLElement>('.root-tab')].find((each) => each.querySelector('.root-tab-label')?.textContent === label);
  if (!tab) throw new Error(`no root tab ${label}`);
  fireEvent.click(tab);
}

/** demo-ended, resumed: the same id, now a running background session waiting for a prompt (spike 006). */
const resumedSessions = () =>
  sessions().map((each) =>
    each.sessionId === ENDED
      ? session({ sessionId: ENDED, name: 'demo-ended', title: 'Tidy the made-up export job', cwd: DEMO, kind: 'background', shortId: '00000000', state: 'blocked', status: 'idle', lastActivityAt: minutesAgo(0) })
      : each,
  );

/** demo-ended, open in its terminal again: the same id, a running interactive session, as when a resume starts a copy (spike 006, finding 5). */
const reopenedSessions = () =>
  sessions().map((each) => (each.sessionId === ENDED ? session({ sessionId: ENDED, name: 'demo-ended', title: 'Tidy the made-up export job', cwd: DEMO, lastActivityAt: minutesAgo(0) }) : each));

type Answer = { status: number; body?: unknown; retryAfter?: string } | 'network' | 'held';

// W66's answers (src/server/actions.ts on m3.1/ended-index), as a real resume would get them.
const COPY_ERROR =
  'It was open in another Claude Code process after all, so Claude Code started a copy as ee8a7a26 instead. The copy is listed as a background session with no name, which you can stop and remove.';
const RUNNING_AGAIN = "It's running again, in a terminal or in the background, so pitwall didn't resume it: that would start a copy.";
const TIMED_OUT = "claude --resume didn't finish within 30s. The session may still appear in the list.";

/**
 * Every GET is a conversation page; each POST gets the next answer, or the last, and all are
 * recorded. A 'held' answer waits until the test calls `release`.
 */
function fakeServer(...answers: Answer[]) {
  let call = 0;
  const held: Array<(response: Response) => void> = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (init.method !== 'POST') {
      const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
      const page: ConversationPage = { sessionId, entries: [{ kind: 'assistant', text: 'A made-up reply.' }] };
      return new Response(JSON.stringify(page), { status: 200 });
    }
    const answer = answers[Math.min(call, answers.length - 1)] ?? { status: 200, body: { ok: true, shortId: '00000000' } };
    call += 1;
    if (answer === 'network') throw new TypeError('made up: the network is down');
    if (answer === 'held') return new Promise<Response>((resolve) => held.push(resolve));
    const headers = answer.retryAfter === undefined ? undefined : { 'Retry-After': answer.retryAfter };
    return new Response(answer.body === undefined ? 'not json' : JSON.stringify(answer.body), { status: answer.status, ...(headers ? { headers } : {}) });
  });
  /** Answers the oldest held POST. */
  const release = (status: number, body: unknown) => act(async () => held.shift()?.(new Response(JSON.stringify(body), { status })));
  return Object.assign(fetch, { release });
}

function memory(entries: Record<string, string> = {}): StorageSource & { values: Map<string, string> } {
  const values = new Map(Object.entries(entries));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return Object.assign(() => storage, { values });
}

interface Options {
  search?: string;
  storage?: StorageSource;
  answers?: Answer[];
}

function renderDashboard(first: IndexSnapshot = snap(), options: Options = {}) {
  const history = fakeHistory(options.search ?? '?view=all');
  const fetch = fakeServer(...(options.answers ?? []));
  const api = createApiClient({ apiKey: API_KEY, fetch });
  const sockets = fakeSockets();
  const env: AttachEnv = { token: TOKEN, createSocket: sockets.factory, host: '127.0.0.1:4517' };
  const storage = options.storage ?? memory();
  const ui = (s: IndexSnapshot) => (
    <ApiContext.Provider value={api}>
      <AttachContext.Provider value={env}>
        <Dashboard view={{ state: 'live', snapshot: s }} navigation={history.navigation} storage={storage} />
      </AttachContext.Provider>
    </ApiContext.Provider>
  );
  const result = render(ui(first));
  return { ...result, history, fetch, sockets, storage, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

const settle = () => act(async () => {});
const list = () => screen.getByRole('main');
const rowNames = () => [...list().querySelectorAll<HTMLElement>('[data-open-session]')].filter((button) => !button.closest('[hidden]')).map((button) => button.textContent ?? '');
const rowOf = (name: string) => within(list()).getByRole('button', { name }).closest('li.session') as HTMLElement;
const finishedToggle = () => list().querySelector<HTMLButtonElement>('.finished-toggle');
async function openFinished() {
  const toggle = finishedToggle();
  if (toggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  await settle();
}
const olderButton = () => list().querySelector<HTMLButtonElement>('[data-older-toggle]');
const repoLabels = () => [...screen.getByRole('navigation', { name: 'Repos' }).querySelectorAll('[data-repo-item] .repo-item-label')].map((label) => label.textContent);
const summaryCount = () => list().querySelector('.summary-count')?.textContent;
async function open(name: string) {
  await openFinished();
  const button = within(list()).getByRole('button', { name });
  button.focus();
  fireEvent.click(button);
  await settle();
}
const view = () => document.getElementById('session-view') as HTMLElement;
const footer = () => view().querySelector('footer.session-view-foot') as HTMLElement | null;
const button = (name: string | RegExp) => within(view()).getByRole('button', { name });
const posts = (fetch: ReturnType<typeof fakeServer>) => fetch.mock.calls.filter(([, init]) => init.method === 'POST');

/** Opens the view's actions menu, and returns its items' names in order, with "—" for a separator. */
function openMenu(): string[] {
  fireEvent.click(within(view()).getByRole('button', { name: 'Session actions' }));
  const menu = within(view()).getByRole('menu', { name: 'Session actions' });
  return [...menu.children].map((child) => (child.getAttribute('role') === 'separator' ? '—' : (child.textContent ?? '')));
}

beforeEach(() => {
  terminals.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  setWidth(1440);
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('what the page derives from an ended session', () => {
  it('gives it the Ended badge, subtle neutral as Stopped, and never counts it as needing you, even when it asked', () => {
    const asked = ended(3, 'demo-ended-asked', { askedYou: { reason: 'question', excerpt: 'Keep it?' } });
    expect(statusBadge(asked)).toEqual({ status: 'ended', label: 'Ended', look: 'subtle-neutral' });
    expect(needsAttention(asked)).toBe(false);
    // Even were finished left out, ended alone keeps it out of Needs you.
    expect(needsAttention({ ...asked, finished: false })).toBe(false);
  });

  it('copies `cd <cwd> && claude --resume <id>`, the directory always in single quotes, each quote in it escaped', () => {
    expect(resumeCommand(ended(2, 'a'))).toBe(`cd '${DEMO}' && claude --resume ${ENDED}`);
    expect(resumeCommand(ended(2, 'a', { cwd: "/Users/example/code/it's here" }))).toBe(`cd '/Users/example/code/it'\\''s here' && claude --resume ${ENDED}`);
    expect(posixQuote("a'b")).toBe(`'a'\\''b'`);
    expect(posixQuote('$(touch x) `y` "z"')).toBe(`'$(touch x) \`y\` "z"'`);
  });

  it('has no resume command for one whose directory has gone, or with a control character in it, or an unsafe id, or one that hasn\'t ended', () => {
    expect(resumeCommand(ended(2, 'a', { cwdMissing: true }))).toBeUndefined();
    expect(resumeCommand(ended(2, 'a', { cwd: `${DEMO}\nrm -rf x` }))).toBeUndefined();
    expect(resumeCommand(ended(2, 'a', { sessionId: '-h' }))).toBeUndefined();
    expect(resumeCommand(ended(2, 'a', { sessionId: 'abc; rm x' }))).toBeUndefined();
    expect(resumeCommand(session({ sessionId: LIVE }))).toBeUndefined();
  });

  it('has none for a directory with DEL, a C1 control or a bidi control in it, which could read differently from what’s copied, and one past ASCII otherwise', () => {
    const unsafe = ['\u007f', '\u0080', '\u0085', '\u009b', '\u009f', '\u061c', '\u200e', '\u200f', '\u202a', '\u202d', '\u202e', '\u2066', '\u2068', '\u2069'];
    for (const char of unsafe) {
      expect(resumeCommand(ended(2, 'a', { cwd: `${CODE}/demo${char}-app` })), `U+${char.codePointAt(0)?.toString(16).padStart(4, '0')}`).toBeUndefined();
    }
    // Just outside the ranges: still a command, quoted as any other.
    for (const char of ['\u00a0', '\u00e9', '\u200d', '\u2065', '\u206a']) {
      expect(resumeCommand(ended(2, 'a', { cwd: `${CODE}/demo${char}-app` }))).toBe(`cd '${CODE}/demo${char}-app' && claude --resume ${ENDED}`);
    }
  });

  it(`hides ended sessions last active more than ${ENDED_SHOWN_DAYS} days before the snapshot's time, and nothing else`, () => {
    const now = NOW;
    const edge = ENDED_SHOWN_DAYS * DAY;
    expect(isOlderEnded(ended(2, 'a', { lastActivityAt: minutesAgo(edge - 1) }), now)).toBe(false);
    expect(isOlderEnded(ended(2, 'a', { lastActivityAt: minutesAgo(edge + 1) }), now)).toBe(true);
    // Its start, when it has no activity.
    expect(isOlderEnded(ended(2, 'a', { lastActivityAt: undefined, startedAt: minutesAgo(edge + 1) }), now)).toBe(true);
    expect(isOlderEnded(session({ finished: true, kind: 'background', state: 'done', lastActivityAt: minutesAgo(30 * DAY) }), now)).toBe(false);
    // A time that isn't one hides nothing.
    expect(isOlderEnded(ended(2, 'a', { lastActivityAt: minutesAgo(30 * DAY) }), Number.NaN)).toBe(false);
  });

  it('takes them out of their groups, leaves out a group with nothing else, and gives back the same groups when there are none', () => {
    const groups = snap().groups;
    const windowed = withoutOlderEnded(groups, NOW);
    expect(windowed.map((each) => each.label)).toEqual(['demo-app']);
    expect(windowed[0]?.sessions.map((each) => each.name)).toEqual(['demo-live', 'demo-ended', 'demo-ended-asked', 'job-done', 'demo-ended-gone']);
    const recent = snap(sessions().filter((each) => each.sessionId !== ENDED_OLD), []).groups;
    expect(withoutOlderEnded(recent, NOW)).toBe(recent);
  });

  it('names an ended session in a finished Asked you, and in a result that arrives after the view has gone', () => {
    expect(ENDED_ASKED_HINT).toBe("Its last message asked you something. It has ended, so it isn't counted as needing you.");
    expect(resumeToast('demo-ended', { kind: 'resumed' })).toEqual({ tone: 'success', message: 'Resumed demo-ended in the background.' });
    expect(resumeToast('demo-ended', { kind: 'refused', error: 'made up.' })?.message).toBe("Couldn't resume demo-ended. made up.");
    expect(resumeToast('demo-ended', { kind: 'copied', error: COPY_ERROR, copyShortId: 'ee8a7a26' })?.message).toBe(`Couldn't resume demo-ended. ${COPY_ERROR}`);
    expect(resumeToast('demo-ended', { kind: 'failed', error: 'x', status: 502 })?.message).toBe("Couldn't resume demo-ended (HTTP 502).");
    expect(resumeToast('demo-ended', { kind: 'unauthorized' })).toBeUndefined();
  });
});

describe('ended sessions in the lists', () => {
  it('are in their group’s Finished section, muted, last, labelled Ended, with the time of their last activity', async () => {
    renderDashboard();
    await settle();
    expect(rowNames()).toEqual(['demo-live']);
    expect(finishedToggle()?.textContent).toBe('Finished (4) · 1 asked you');
    await openFinished();
    // Finished, newest first: demo-ended-asked (1 day), demo-ended (2), job-done (3), demo-ended-gone (4).
    expect(rowNames()).toEqual(['demo-live', 'demo-ended-asked', 'demo-ended', 'job-done', 'demo-ended-gone']);
    const row = rowOf('demo-ended');
    expect(row.classList.contains('finished')).toBe(true);
    expect(row.querySelector('.badge.state-ended')?.textContent).toBe('Ended');
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe(minutesAgo(2 * DAY));
    // The one that asked has the outlined Asked you, whose hint says it has ended.
    expect(rowOf('demo-ended-asked').querySelector('.badge-outline')?.textContent).toBe('Asked you');
  });

  it('are never in Needs you, or its count, whatever they asked', async () => {
    renderDashboard(snap(), { search: '?view=needs-you' });
    await settle();
    expect(within(list()).queryByRole('button', { name: 'demo-ended-asked' })).toBeNull();
    expect(screen.getByText('Nothing needs you right now')).toBeTruthy();
    expect(document.title).toBe('pitwall');
  });

  it('match the filter as other sessions do, and the Interactive chip', async () => {
    renderDashboard();
    await openFinished();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), { target: { value: 'export' } });
    await settle();
    expect(rowNames()).toEqual(['demo-ended']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Background', pressed: false }));
    await settle();
    expect(rowNames()).toEqual(['job-done']);
  });

  it('can be starred, and show in Starred’s own Finished section', async () => {
    renderDashboard(snap(), { search: '?view=starred', storage: memory({ [STARRED_KEY]: JSON.stringify({ v: 1, ids: [ENDED] }) }) });
    await settle();
    expect(finishedToggle()?.textContent).toBe('Finished (1)');
    await openFinished();
    expect(rowNames()).toEqual(['demo-ended']);
    expect(within(rowOf('demo-ended')).getByRole('button', { name: 'Star demo-ended', pressed: true })).toBeTruthy();
  });
});

describe(`ended sessions older than ${ENDED_SHOWN_DAYS} days`, () => {
  it('are left out of every list and count, and a group with nothing else is left out of the repo list', async () => {
    renderDashboard();
    await openFinished();
    expect(rowNames()).not.toContain('demo-ended-old');
    expect(summaryCount()).toBe('5 sessions');
    expect(repoLabels()).toEqual(['Needs you', 'All sessions', 'Starred', 'demo-app']);
    const demo = screen.getByRole('link', { name: /^demo-app/ });
    expect(demo.textContent).toContain('5');
  });

  it('are behind Show older, after the Finished section’s rows, which says how many and is described by the line after it', async () => {
    renderDashboard();
    await openFinished();
    const toggle = olderButton()!;
    // The selection's: demo-app's one and notes' one, in All sessions.
    expect(toggle.textContent).toBe('Show 2 older sessions');
    expect(toggle.closest('ul')?.lastElementChild).toBe(toggle.closest('li'));
    const note = document.getElementById(toggle.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toBe(OLDER_NOTE);
    expect(OLDER_NOTE).toBe('Ended more than 7 days ago');
    expect(olderText(1, false)).toBe('Show 1 older session');
  });

  it('show once it’s pressed, which keeps focus as Hide older, adds them to the counts and the repo list, and is one switch for the page', async () => {
    renderDashboard();
    await openFinished();
    const toggle = olderButton()!;
    toggle.focus();
    fireEvent.click(toggle);
    await settle();
    expect(olderButton()).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.textContent).toBe('Hide older sessions');
    expect(rowNames()).toEqual(['demo-live', 'demo-ended-asked', 'demo-ended', 'job-done', 'demo-ended-gone', 'demo-ended-old', 'notes-ended-old']);
    expect(summaryCount()).toBe('7 sessions');
    expect(repoLabels()).toEqual(['Needs you', 'All sessions', 'Starred', 'demo-app', 'notes']);
    // Another selection: still on.
    fireEvent.click(screen.getByRole('link', { name: /^notes/ }));
    await openFinished();
    expect(rowNames()).toEqual(['notes-ended-old']);
    expect(olderButton()?.textContent).toBe('Hide older sessions');
    fireEvent.click(olderButton()!);
    await settle();
    // Hidden again: notes has no sessions now, and says so, with Show older.
    expect(screen.getByText('No sessions in notes now')).toBeTruthy();
  });

  it('isn’t kept across a reload', async () => {
    const storage = memory();
    const first = renderDashboard(snap(), { storage });
    await openFinished();
    fireEvent.click(olderButton()!);
    await settle();
    expect(rowNames()).toContain('demo-ended-old');
    first.unmount();
    expect([...storage.values.keys()].some((key) => /older/i.test(key))).toBe(false);
    renderDashboard(snap(), { storage });
    await openFinished();
    expect(rowNames()).not.toContain('demo-ended-old');
    expect(olderButton()?.textContent).toBe('Show 2 older sessions');
  });

  it('count only what the filter shows', async () => {
    renderDashboard();
    await openFinished();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), { target: { value: 'demo' } });
    await settle();
    expect(olderButton()?.textContent).toBe('Show 1 older session');
  });

  it('are offered from an empty state when they’re all a selection has, which opens the Finished section and puts focus on Hide older', async () => {
    const onlyOld = snap([ended(4, 'demo-ended-old', { lastActivityAt: minutesAgo(10 * DAY) })]);
    renderDashboard(onlyOld);
    await settle();
    expect(screen.getByText('No Claude Code sessions under ~/code')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 older sessions' }));
    await settle();
    expect(finishedToggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(rowNames()).toEqual(['demo-ended-old', 'notes-ended-old']);
    expect(document.activeElement).toBe(olderButton());
    expect(olderButton()?.textContent).toBe('Hide older sessions');
  });

  it('are offered from a group’s empty state, whose group has only those', async () => {
    renderDashboard(snap(), { search: `?repo=${NOTES}` });
    await settle();
    expect(screen.getByText('No sessions in notes now')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 older session' }));
    await settle();
    expect(rowNames()).toEqual(['notes-ended-old']);
  });

  it('still show in a view that’s open when they’re hidden again, which doesn’t say it’s no longer listed', async () => {
    renderDashboard();
    await openFinished();
    fireEvent.click(olderButton()!);
    await open('demo-ended-old');
    fireEvent.click(olderButton()!);
    await settle();
    expect(rowNames()).not.toContain('demo-ended-old');
    expect(view().querySelector('.session-view-name')?.textContent).toBe('demo-ended-old');
    expect(within(view()).queryByText('This session is no longer listed, so this is what it showed last.')).toBeNull();
  });

  it('open from a URL, though they’re hidden', async () => {
    renderDashboard(snap(), { search: `?view=all&session=${ENDED_OLD}` });
    await settle();
    expect(view().querySelector('.session-view-name')?.textContent).toBe('demo-ended-old');
  });
});

describe('the session view of an ended session', () => {
  it('has the Conversation tab alone, Ended as its status, no /bg note, no message box, and the footer’s note and actions', async () => {
    const { sockets } = renderDashboard();
    await open('demo-ended');
    expect(within(view()).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Conversation']);
    expect(within(view()).getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true');
    expect(view().querySelector('.session-view-meta .badge.state-ended')?.textContent).toBe('Ended');
    expect(within(view()).queryByRole('button', { name: BG_NOTE })).toBeNull();
    expect(view().querySelector('.relay-box')).toBeNull();
    expect(footer()?.querySelector('.session-view-note')?.textContent).toBe(ENDED_NOTE);
    const actions = [...footer()!.querySelectorAll('.ended-actions button')].map((each) => each.textContent);
    expect(actions).toEqual(['Copy command', 'Resume in background']);
    expect(button('Resume in background').className).toContain('primary');
    expect(sockets.sockets).toHaveLength(0);
  });

  it('has Copy session ID, Copy resume command, then Resume in background in its actions menu, and no Stop or Remove', async () => {
    renderDashboard();
    await open('demo-ended');
    // The width items too, in three columns.
    expect(openMenu()).toEqual(['Copy session ID', 'Copy resume command', '—', 'Make view wider', 'Make view narrower', 'Reset view width', '—', 'Resume in background']);
  });

  it('says why one whose directory has gone can’t be resumed, with nothing to press', async () => {
    const { fetch } = renderDashboard();
    await open('demo-ended-gone');
    expect(footer()?.querySelector('.session-view-note')?.textContent).toBe(ENDED_GONE_NOTE);
    expect(footer()?.querySelector('.ended-actions')).toBeNull();
    expect(view().querySelector('.session-view-missing')?.textContent).toBe('Directory no longer exists');
    expect(openMenu()).toEqual(['Copy session ID', '—', 'Make view wider', 'Make view narrower', 'Reset view width']);
    expect(posts(fetch)).toEqual([]);
  });

  it('keeps a draft the tab kept, in the message box above the note, which says it can’t be sent', async () => {
    window.sessionStorage.setItem(draftKey(ENDED), JSON.stringify({ v: 1, text: 'A made-up draft.' }));
    renderDashboard();
    await open('demo-ended');
    const box = footer()!.querySelector<HTMLElement>('.relay-box')!;
    expect(within(box).getByRole('textbox').textContent).toBe('A made-up draft.');
    expect(box.textContent).toContain(KEPT_NOT_RUNNING);
    expect(box.nextElementSibling?.classList.contains('ended-foot')).toBe(true);
  });

  it('becomes an ended session’s view when its process exits while it’s open, on Conversation, with the footer’s actions', async () => {
    const live = sessions().map((each) => (each.sessionId === ENDED ? session({ sessionId: ENDED, name: 'demo-ended', cwd: DEMO, lastActivityAt: minutesAgo(1) }) : each));
    const { update } = renderDashboard(snap(live));
    await open('demo-ended');
    expect(view().querySelector('.relay-box')).not.toBeNull();
    update(snap());
    await settle();
    expect(view().querySelector('.session-view-name')?.textContent).toBe('demo-ended');
    expect(view().querySelector('.relay-box')).toBeNull();
    expect(footer()?.querySelector('.session-view-note')?.textContent).toBe(ENDED_NOTE);
    expect(within(view()).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Conversation']);
  });

  it('opens on Conversation when stepped onto with j, and attaches nothing', async () => {
    const { sockets } = renderDashboard();
    await open('demo-ended-asked');
    fireEvent.keyDown(view().querySelector('h2')!, { key: 'j' });
    await settle();
    expect(view().querySelector('.session-view-name')?.textContent).toBe('demo-ended');
    expect(within(view()).getAllByRole('tab')).toHaveLength(1);
    expect(sockets.sockets).toHaveLength(0);
  });

  describe('Copy command', () => {
    let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
    beforeEach(() => {
      writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    });

    it('copies the command that resumes it in a terminal, with the Copied toast', async () => {
      renderDashboard();
      await open('demo-ended');
      fireEvent.click(button('Copy command'));
      await settle();
      expect(writeText).toHaveBeenCalledWith(`cd '${DEMO}' && claude --resume ${ENDED}`);
      expect(toastMessages()).toEqual(['Copied']);
    });

    it('copies the same from the actions menu', async () => {
      renderDashboard();
      await open('demo-ended');
      openMenu();
      fireEvent.click(within(view()).getByRole('menuitem', { name: 'Copy resume command' }));
      await settle();
      expect(writeText).toHaveBeenCalledWith(`cd '${DEMO}' && claude --resume ${ENDED}`);
    });

    it('shows the command, selected, under line 2 when the clipboard refuses', async () => {
      writeText.mockRejectedValue(new Error('made up: refused'));
      renderDashboard();
      await open('demo-ended');
      fireEvent.click(button('Copy command'));
      await settle();
      expect(view().querySelector('.session-view-copy-fallback')?.textContent).toBe(`Resume command: cd '${DEMO}' && claude --resume ${ENDED}`);
      expect(toastMessages()).toEqual(["Couldn't copy; the text is selected"]);
    });
  });
});

describe('Resume in background', () => {
  it('POSTs resumePath() with the API key and no prompt, busy and disabled while it runs, then a toast; busy until it’s listed as running', async () => {
    const { fetch } = renderDashboard(snap(), { answers: ['held'] });
    await open('demo-ended');
    fireEvent.click(button('Resume in background'));
    await settle();
    const [url, init] = posts(fetch)[0] ?? [];
    expect(url).toBe(resumePath(ENDED));
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init?.body).toBe('{}');
    const busy = within(footer()!).getByRole('button', { name: 'Resuming…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    // A second press while it's out sends nothing.
    fireEvent.click(busy);
    await settle();
    expect(posts(fetch)).toHaveLength(1);
    await fetch.release(200, { ok: true, shortId: '00000000' });
    expect(toastMessages()).toEqual([resumedText('demo-ended')]);
    expect(toastMessages()).toEqual(['Resumed demo-ended in the background.']);
    // Still listed as ended: busy until the snapshot says otherwise.
    expect(within(footer()!).getByRole('button', { name: 'Resuming…' })).toBeTruthy();
    expect(view().querySelector('.session-view-name')?.textContent).toBe('demo-ended');
  });

  it('is Resume in background again if the snapshot still lists it as ended after a while', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    renderDashboard();
    await open('demo-ended');
    fireEvent.click(button('Resume in background'));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(within(footer()!).getByRole('button', { name: 'Resuming…' })).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(RESUME_LISTED_MS));
    expect(within(footer()!).getByRole('button', { name: 'Resume in background' }).getAttribute('aria-busy')).toBeNull();
  });

  it('doesn’t open the Terminal tab for a listing after it has given up on one', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    const { update, sockets } = renderDashboard();
    await open('demo-ended');
    fireEvent.click(button('Resume in background'));
    await act(() => vi.advanceTimersByTimeAsync(10));
    await act(() => vi.advanceTimersByTimeAsync(RESUME_LISTED_MS));
    expect(within(footer()!).getByRole('button', { name: 'Resume in background' })).toBeTruthy();
    update(snap(resumedSessions()));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(within(view()).getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true');
    expect(sockets.sockets).toHaveLength(0);
  });

  it('opens the Terminal tab once the snapshot lists it as a running background session, with focus on the tab and none in the terminal (W57), and keeps its star', async () => {
    const storage = memory({ [STARRED_KEY]: JSON.stringify({ v: 1, ids: [ENDED] }) });
    const { update, sockets } = renderDashboard(snap(), { storage });
    await open('demo-ended');
    const resume = button('Resume in background');
    resume.focus();
    fireEvent.click(resume);
    await settle();
    update(snap(resumedSessions()));
    await settle();
    expect(view().querySelector('.session-view-name')?.textContent).toBe('demo-ended');
    const terminalTab = within(view()).getByRole('tab', { name: /^Terminal/ });
    expect(terminalTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(terminalTab);
    expect(view().querySelector('.ended-foot')).toBeNull();
    expect(within(view()).getByRole('button', { name: 'Star demo-ended', pressed: true })).toBeTruthy();
    // It's a running background session's row now, needing you, and still starred.
    expect(rowOf('demo-ended').classList.contains('finished')).toBe(false);
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    const socket = sockets.last as FakeSocket;
    act(() => {
      socket.open();
      socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: NONCE });
    });
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    act(() => socket.receive({ type: 'ready' }));
    act(() => socket.receive({ type: 'attached' }));
    await settle();
    expect(JSON.parse(socket.sent[1] ?? '{}')).toMatchObject({ type: 'open', sessionId: ENDED });
    expect(document.activeElement).not.toBe(terminals.at(-1)?.screen);
  });

  it('opens the Terminal tab just the same when the snapshot lists it as running before the server answers, moving focus from Resume to the tab', async () => {
    const { fetch, update, sockets } = renderDashboard(snap(), { answers: ['held'] });
    await open('demo-ended');
    const resume = button('Resume in background');
    resume.focus();
    fireEvent.click(resume);
    await settle();
    update(snap(resumedSessions()));
    await settle();
    expect(view().querySelector('.ended-foot')).toBeNull();
    const terminalTab = within(view()).getByRole('tab', { name: /^Terminal/ });
    expect(terminalTab.getAttribute('aria-selected')).toBe('true');
    // Never the page: Resume in background went with the footer.
    expect(document.activeElement).toBe(terminalTab);
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    await fetch.release(200, { ok: true, shortId: '00000000' });
    expect(toastMessages()).toEqual(['Resumed demo-ended in the background.']);
    expect(terminalTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(terminalTab);
    expect(sockets.sockets).toHaveLength(1);
  });

  it('opens the Terminal tab once, so a root tab opened again later leaves the tab you chose, whichever came first', async () => {
    const { fetch, update, sockets } = renderDashboard(twoRoots(), { answers: ['held'] });
    await open('demo-ended');
    fireEvent.click(button('Resume in background'));
    await settle();
    update(twoRoots(resumedSessions()));
    await settle();
    await waitFor(() => expect(sockets.sockets).toHaveLength(1));
    await fetch.release(200, { ok: true, shortId: '00000000' });
    // Back to the conversation, by choice, which detaches.
    fireEvent.click(within(view()).getByRole('tab', { name: 'Conversation' }));
    await settle();
    const kept = view();
    openRoot('~/oss');
    await settle();
    expect(kept.hidden).toBe(true);
    openRoot('~/code');
    await settle();
    expect(kept.hidden).toBe(false);
    expect(within(kept).getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true');
    expect(sockets.sockets).toHaveLength(1);
  });

  it('moves focus from the footer to the heading when the session leaves the list, which takes the footer away', async () => {
    const { update } = renderDashboard();
    await open('demo-ended');
    button('Copy command').focus();
    update(snap(sessions().filter((each) => each.sessionId !== ENDED)));
    await settle();
    expect(within(view()).getByText('This session is no longer listed, so this is what it showed last.')).toBeTruthy();
    expect(footer()).toBeNull();
    expect(document.activeElement).toBe(view().querySelector('h2'));
  });

  it('stays on Conversation once it’s running when Preferences says so', async () => {
    const storage = memory({ 'pitwall.background-tab.v1': 'conversation' });
    const { update, sockets } = renderDashboard(snap(), { storage });
    await open('demo-ended');
    fireEvent.click(button('Resume in background'));
    await settle();
    update(snap(resumedSessions()));
    await settle();
    expect(within(view()).getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true');
    expect(footer()?.querySelector('.session-view-note')?.textContent).toBe('To message it, type in its Terminal tab, which attaches to it.');
    expect(sockets.sockets).toHaveLength(0);
  });

  it('is in the actions menu too, off while it runs', async () => {
    const { fetch } = renderDashboard(snap(), { answers: [{ status: 409, body: { ok: false, error: 'Made up: it is open in a terminal again.' } }] });
    await open('demo-ended');
    openMenu();
    fireEvent.click(within(view()).getByRole('menuitem', { name: 'Resume in background' }));
    await settle();
    expect(posts(fetch).map(([url]) => url)).toEqual([resumePath(ENDED)]);
    expect(footer()?.querySelector('.resume-failure')?.textContent).toBe("Couldn't resume the session. Made up: it is open in a terminal again.");
  });

  it.each([
    ['a 409, with the server’s reason', { status: 409, body: { ok: false, error: 'Made up: a resume of it is already running.' } }, "Couldn't resume the session. Made up: a resume of it is already running."],
    ['a 409 for a session that’s running again', { status: 409, body: { ok: false, error: RUNNING_AGAIN } }, `Couldn't resume the session. ${RUNNING_AGAIN}`],
    ['a 422 with no hint', { status: 422, body: { ok: false, error: 'Workspace not trusted. Made up.' } }, "Couldn't resume the session. Workspace not trusted. Made up."],
    ['a 502, with the server’s reason', { status: 502, body: { ok: false, error: "Couldn't run claude: made up." } }, "Couldn't resume the session. Couldn't run claude: made up."],
    ['a 504, with the server’s reason', { status: 504, body: { ok: false, error: TIMED_OUT } }, `Couldn't resume the session. ${TIMED_OUT}`],
    ['a 404, with the server’s reason', { status: 404, body: { ok: false, error: 'Made up: not listed.' } }, "Couldn't resume the session. Made up: not listed."],
    ['a 429, with the server’s reason', { status: 429, body: { ok: false, error: 'Made up: try again in a moment.' }, retryAfter: '1' }, "Couldn't resume the session. Made up: try again in a moment."],
    ['a 429 with no reason, by its Retry-After', { status: 429, retryAfter: '2' }, "Couldn't resume the session (HTTP 429). Try again in 2 seconds."],
    ['a 502 with no reason', { status: 502 }, "Couldn't resume the session (HTTP 502)."],
    ['no answer at all', 'network', "Couldn't resume the session."],
  ] as const)('says why, in a danger alert in the footer, after %s', async (_what, answer, text) => {
    renderDashboard(snap(), { answers: [answer] });
    await open('demo-ended');
    const resume = button('Resume in background');
    resume.focus();
    fireEvent.click(resume);
    await settle();
    const alert = footer()!.querySelector('.resume-failure')!;
    expect(alert.textContent).toBe(text);
    expect(alert.classList.contains('danger')).toBe(true);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(resume);
    expect(resume.getAttribute('aria-busy')).toBeNull();
    expect(toastMessages()).toEqual([]);
  });

  it('gives the command to run, to copy, when the server has a hint', async () => {
    const untrusted = `Workspace not trusted. Run \`claude\` in ${DEMO} once and accept the trust prompt, then retry.`;
    renderDashboard(snap(), { answers: [{ status: 422, body: { ok: false, error: untrusted, hint: `cd ${DEMO} && claude` } }] });
    await open('demo-ended');
    fireEvent.click(button('Resume in background'));
    await settle();
    const alert = footer()!.querySelector<HTMLElement>('.resume-failure')!;
    expect(alert.querySelector('.alert-detail')?.textContent).toBe(untrusted);
    expect(alert.textContent).toContain(RESUME_HINT_TEXT);
    expect(alert.querySelector('.command-chip')?.textContent).toBe(`cd ${DEMO} && claude`);
    expect(within(alert).getByRole('button', { name: 'Copy trust command' })).toBeTruthy();
  });

  it('warns when Claude Code started a copy instead, in the server’s words alone, which name the copy, and in a toast, which is what announces it', async () => {
    renderDashboard(snap(), { answers: [{ status: 409, body: { ok: false, error: COPY_ERROR, copyShortId: 'ee8a7a26' } }] });
    await open('demo-ended');
    fireEvent.click(button('Resume in background'));
    await settle();
    const alert = footer()!.querySelector<HTMLElement>('.resume-failure')!;
    expect(alert.classList.contains('warning')).toBe(true);
    expect(alert.querySelector('.inline-alert-title')?.textContent).toBe(COPY_STARTED);
    expect(alert.querySelector('.inline-alert-body')?.textContent).toBe(COPY_ERROR);
    // pitwall's own sentence, so not in Claude Code's code style.
    expect(alert.querySelector('.alert-detail')).toBeNull();
    // Announced once: by the toast, an alert in the toasts' live region, not by the footer's warning too.
    expect(alert.getAttribute('role')).toBeNull();
    expect(toastMessages()).toEqual([`Couldn't resume demo-ended. ${COPY_ERROR}`]);
    expect(toastSaying(`Couldn't resume demo-ended. ${COPY_ERROR}`).getAttribute('role')).toBe('alert');
  });

  it('keeps the copy’s warning, in its toast, when the next snapshot lists the session as running in its terminal, which takes the footer away', async () => {
    const { update } = renderDashboard(snap(), { answers: [{ status: 409, body: { ok: false, error: COPY_ERROR, copyShortId: 'ee8a7a26' } }] });
    await open('demo-ended');
    const resume = button('Resume in background');
    resume.focus();
    fireEvent.click(resume);
    await settle();
    expect(document.activeElement).toBe(resume);
    update(snap(reopenedSessions()));
    await settle();
    expect(view().querySelector('.ended-foot')).toBeNull();
    expect(view().querySelector('.relay-box')).not.toBeNull();
    expect(toastMessages()).toEqual([`Couldn't resume demo-ended. ${COPY_ERROR}`]);
    // Resume in background went with the footer: focus goes to the Terminal tab, off for an interactive session, never the page.
    const terminalTab = within(view()).getByRole('tab', { name: /^Terminal/ });
    expect(document.activeElement).toBe(terminalTab);
    expect(within(view()).getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true');
  });

  it('still says a copy started, in a toast, when the snapshot lists the session as running before the server answers', async () => {
    const { fetch, update, sockets } = renderDashboard(snap(), { answers: ['held'] });
    await open('demo-ended');
    fireEvent.click(button('Resume in background'));
    await settle();
    update(snap(reopenedSessions()));
    await settle();
    expect(view().querySelector('.ended-foot')).toBeNull();
    await fetch.release(409, { ok: false, error: COPY_ERROR, copyShortId: 'ee8a7a26' });
    expect(toastMessages()).toEqual([`Couldn't resume demo-ended. ${COPY_ERROR}`]);
    // Running in its terminal: an interactive session, so the view stays on Conversation, and nothing attaches.
    expect(within(view()).getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true');
    expect(sockets.sockets).toHaveLength(0);
  });

  it('keeps j and k from moving the view while its request is out', async () => {
    const { fetch } = renderDashboard(snap(), { answers: ['held'] });
    await open('demo-ended');
    fireEvent.click(button('Resume in background'));
    await settle();
    fireEvent.keyDown(document.body, { key: 'j' });
    await settle();
    expect(view().querySelector('.session-view-name')?.textContent).toBe('demo-ended');
    await fetch.release(409, { ok: false, error: 'Made up.' });
    fireEvent.keyDown(document.body, { key: 'j' });
    await settle();
    expect(view().querySelector('.session-view-name')?.textContent).toBe('job-done');
  });

  it('still says how it went, in a toast naming the session, when the view has gone meanwhile', async () => {
    const { fetch } = renderDashboard(snap(), { answers: ['held'] });
    await open('demo-ended');
    fireEvent.click(button('Resume in background'));
    await settle();
    fireEvent.click(within(view()).getByRole('button', { name: 'Close' }));
    await settle();
    expect(document.getElementById('session-view')).toBeNull();
    await fetch.release(200, { ok: true, shortId: '00000000' });
    expect(toastMessages()).toEqual(['Resumed demo-ended in the background.']);
  });
});
