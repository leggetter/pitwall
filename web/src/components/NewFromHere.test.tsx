// New session from here (W118): the session view's actions menu opens New session in the session's
// directory with a blank prompt; Draft from this session adds the text selected in its conversation,
// quoted, after one line naming the session, and nothing else; it's off with no selection; the item is
// off, saying why, for a directory that has gone; and it's reached and used from the keyboard.
// Made-up sessions only, and a fake server: nothing here reaches a session.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPAWN_PATH, type ConversationPage, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import {
  conversationSelection,
  DRAFT_HINTS,
  DRAFT_LABEL,
  draftState,
  draftText,
  NEW_FROM_HERE_HINTS,
  NEW_FROM_HERE_LABEL,
  quoteSelection,
  sourceLine,
  withDraft,
} from '../fromSession.js';
import { MAX_PROMPT_LENGTH } from '../spawn.js';
import { group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { Dashboard } from './Dashboard.js';

const API_KEY = 'k'.repeat(43);
const CODE = '/Users/example/code';
const DEMO = `${CODE}/demo-app`;
const WORKTREE = `${DEMO}/.claude/worktrees/pitwall-test-wt`;
const id = (n: number) => `00000000-0000-4000-8000-0000001180${String(n).padStart(2, '0')}`;
const REPLY = 'The made-up export retries three times.\nThen it gives up.';

function sessions(): SessionSummary[] {
  return [
    session({ sessionId: id(1), name: 'demo-live', cwd: WORKTREE, title: 'A made-up title pitwall must never send', lastActivityAt: minutesAgo(5) }),
    session({ sessionId: id(2), name: 'demo-ended', ended: true, finished: true, alive: false, pid: undefined, status: undefined, lastActivityAt: minutesAgo(60) }),
    session({ sessionId: id(3), name: 'demo-gone', cwdMissing: true, cwd: `${DEMO}/.claude/worktrees/pitwall-test-gone`, lastActivityAt: minutesAgo(10) }),
  ];
}
const snap = (): IndexSnapshot => snapshot([group({ key: DEMO, label: 'demo-app', sessions: sessions() })]);

/** GETs are a conversation page with one reply; a POST starts a session. */
function fakeServer() {
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method !== 'POST') {
      const sessionId = decodeURIComponent(url.split('/')[3] ?? '');
      const page: ConversationPage = { sessionId, entries: [{ kind: 'assistant', text: REPLY }] };
      return new Response(JSON.stringify(page), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, shortId: 'pt118001', name: 'demo-follow-up' }), { status: 200 });
  });
}

function renderAt(sessionId: string) {
  const history = fakeHistory(`?view=all&session=${sessionId}`);
  const fetch = fakeServer();
  const api = createApiClient({ apiKey: API_KEY, fetch });
  render(
    <ApiContext.Provider value={api}>
      <Dashboard view={{ state: 'live', snapshot: snap() }} navigation={history.navigation} />
    </ApiContext.Provider>,
  );
  return { fetch };
}

const settle = () => act(async () => {});
const view = () => document.getElementById('session-view') as HTMLElement;
const menuButton = () => within(view()).getByRole('button', { name: 'Session actions' });
const item = (name: string) => within(view()).getByRole('menuitem', { name });
const dialog = () => screen.getByRole('dialog', { name: 'New session' });
const prompt = () => within(dialog()).getByLabelText('First prompt') as HTMLTextAreaElement;
const directory = () => within(dialog()).getByLabelText('Directory') as HTMLSelectElement;
const draftButton = () => within(dialog()).getByRole('button', { name: DRAFT_LABEL });
const describedBy = (element: HTMLElement) => (element.getAttribute('aria-describedby') ?? '').split(' ').map((each) => document.getElementById(each)?.textContent ?? '').join(' ');

/** Selects the text of the conversation's reply, as a drag over it would: from its first word to its last. */
function selectReply() {
  const texts: Text[] = [];
  const walker = document.createTreeWalker(view().querySelector('.conversation')!, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  const start = texts.find((each) => each.data.includes('The made-up export'));
  const end = texts.find((each) => each.data.includes('gives up'));
  if (!start || !end) throw new Error('no reply in the conversation');
  const range = document.createRange();
  range.setStart(start, start.data.indexOf('The made-up'));
  range.setEnd(end, end.data.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection.toString();
}

/** Presses the menu's button as a pointer does, then chooses New session from here. */
function chooseFromMenu() {
  fireEvent.pointerDown(menuButton());
  fireEvent.click(menuButton());
  fireEvent.click(item(NEW_FROM_HERE_LABEL));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe('the draft', () => {
  it('quotes the selection line by line, as text, leaving out blank lines at the ends and spaces at line ends', () => {
    expect(quoteSelection('\n\nfirst line  \r\n\r\nsecond line\u001b[31m red\u001b[0m\n\n')).toBe('> first line\n>\n> second line red');
    expect(quoteSelection(' \n\t\n')).toBe('');
  });

  it('names the session on one line, in pitwall’s fixed words, as text', () => {
    expect(sourceLine('demo-live')).toBe('From my session "demo-live":');
    expect(sourceLine('two\nlines‮ here ')).toBe('From my session "two lines here":');
  });

  it('is the source line, a blank line and the quote: nothing else, and nothing for an empty selection', () => {
    expect(draftText({ name: 'demo-live', selection: 'one\ntwo' })).toBe('From my session "demo-live":\n\n> one\n> two');
    expect(draftText({ name: 'demo-live', selection: '   ' })).toBeUndefined();
    expect(draftText({ name: 'demo-live', selection: '' })).toBeUndefined();
  });

  it('goes at the prompt’s start, before what was typed, or before a blank line to type after', () => {
    expect(withDraft('', '> a')).toBe('> a\n\n');
    expect(withDraft('Fix it', '> a')).toBe('> a\n\nFix it');
  });

  it('says why it can’t be added: none selected, already in the prompt, or too long', () => {
    expect(draftState('', undefined)).toBe('none');
    expect(draftState('x > a y', '> a')).toBe('added');
    expect(draftState('x'.repeat(MAX_PROMPT_LENGTH - 3), '> a')).toBe('tooLong');
    expect(draftState('', '> a')).toBe('ready');
  });

  it('reads a selection only when it starts and ends in the conversation', () => {
    const panel = document.createElement('div');
    panel.innerHTML = '<p>inside text</p>';
    const outside = document.createElement('p');
    outside.textContent = 'outside text';
    document.body.append(panel, outside);
    const selection = window.getSelection()!;
    const select = (start: Node, end: Node) => {
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent?.length ?? 0);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    select(panel.querySelector('p')!.firstChild!, panel.querySelector('p')!.firstChild!);
    expect(conversationSelection(panel, selection)).toBe('inside text');
    select(panel.querySelector('p')!.firstChild!, outside.firstChild!);
    expect(conversationSelection(panel, selection)).toBe('');
    selection.removeAllRanges();
    expect(conversationSelection(panel, selection)).toBe('');
    expect(conversationSelection(null, selection)).toBe('');
    panel.remove();
    outside.remove();
  });
});

describe('New session from here', () => {
  it('is first in the actions menu, then a separator, and opens New session in the session’s directory with a blank prompt', async () => {
    renderAt(id(1));
    await settle();
    fireEvent.click(menuButton());
    const menu = within(view()).getByRole('menu', { name: 'Session actions' });
    expect(menu.children[0]?.textContent).toBe(NEW_FROM_HERE_LABEL);
    expect(menu.children[1]?.getAttribute('role')).toBe('separator');
    expect(item(NEW_FROM_HERE_LABEL).getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(item(NEW_FROM_HERE_LABEL));
    await settle();
    // A worktree no group lists: added to the choices, and chosen.
    expect(directory().value).toBe(WORKTREE);
    expect(prompt().value).toBe('');
    expect((within(dialog()).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('');
    expect(dialog().textContent).toContain("demo-live's directory, which you can change.");
    // Nothing selected: Draft from this session is off, and says to select text first.
    expect(draftButton().getAttribute('aria-disabled')).toBe('true');
    expect(describedBy(draftButton())).toBe(DRAFT_HINTS.none);
  });

  it('drafts the selected text, quoted, after a line naming the session, and sends only that and what you type', async () => {
    const { fetch } = renderAt(id(1));
    await settle();
    const selected = selectReply();
    expect(selected).toContain('retries three times');
    chooseFromMenu();
    await settle();
    expect(prompt().value).toBe('');
    expect(draftButton().getAttribute('aria-disabled')).toBeNull();
    expect(describedBy(draftButton())).toBe(DRAFT_HINTS.ready);

    fireEvent.click(draftButton());
    await settle();
    const draft = `From my session "demo-live":\n\n${quoteSelection(selected)}`;
    expect(quoteSelection(selected)).toBe('> The made-up export retries three times.\n> Then it gives up.');
    expect(prompt().value).toBe(`${draft}\n\n`);
    expect(document.activeElement).toBe(prompt());
    expect(prompt().selectionStart).toBe(prompt().value.length);
    // In the prompt now: off, saying so.
    expect(draftButton().getAttribute('aria-disabled')).toBe('true');
    expect(describedBy(draftButton())).toBe(DRAFT_HINTS.added);

    fireEvent.change(prompt(), { target: { value: `${prompt().value}Make the retries configurable.` } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Start session' }));
    await settle();
    const started = fetch.mock.calls.filter(([url, init]) => init.method === 'POST' && url.endsWith(SPAWN_PATH));
    expect(started).toHaveLength(1);
    const body = JSON.parse(String(started[0]![1].body)) as Record<string, unknown>;
    // Its directory and the prompt as typed: never the title, a recap or anything else pitwall or a model chose.
    expect(body).toEqual({ cwd: WORKTREE, prompt: `${draft}\n\nMake the retries configurable.` });
    expect(String(body.prompt)).not.toContain('A made-up title');
  });

  it('ignores text selected outside the conversation', async () => {
    renderAt(id(1));
    await settle();
    const heading = view().querySelector('.session-view-name')!;
    const range = document.createRange();
    range.selectNodeContents(heading);
    window.getSelection()!.addRange(range);
    chooseFromMenu();
    await settle();
    expect(draftButton().getAttribute('aria-disabled')).toBe('true');
    expect(describedBy(draftButton())).toBe(DRAFT_HINTS.none);
  });

  it('works for an ended session whose directory is there', async () => {
    renderAt(id(2));
    await settle();
    fireEvent.click(menuButton());
    expect(item(NEW_FROM_HERE_LABEL).getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(item(NEW_FROM_HERE_LABEL));
    await settle();
    expect(directory().value).toBe(DEMO);
  });

  it('is off for a session whose directory has gone, saying why, and opens nothing', async () => {
    renderAt(id(3));
    await settle();
    fireEvent.click(menuButton());
    const off = item(NEW_FROM_HERE_LABEL);
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(describedBy(off)).toContain(NEW_FROM_HERE_HINTS.missing);
    fireEvent.click(off);
    await settle();
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
  });

  it('is reached from the keyboard: the menu opens on it, and Enter opens the dialog', async () => {
    renderAt(id(1));
    await settle();
    const button = menuButton();
    button.focus();
    // Enter on a button is a click, which the browser makes; the keydown comes first.
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    expect(document.activeElement).toBe(item(NEW_FROM_HERE_LABEL));
    fireEvent.keyDown(item(NEW_FROM_HERE_LABEL), { key: 'Enter' });
    fireEvent.click(item(NEW_FROM_HERE_LABEL));
    await settle();
    expect(dialog()).toBeTruthy();
    expect(directory().value).toBe(WORKTREE);
  });
});
