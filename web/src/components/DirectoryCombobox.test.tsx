// New session's directory autocomplete (W70): "Another directory under a root…" reveals a combobox
// of the directories under the roots, fetched once per opening, and narrowed as you type. The WAI-ARIA
// APG editable combobox with list autocomplete, through the real dialog. Made-up directories only.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DIRECTORIES_PATH, SPAWN_PATH, type DirectoryList, type IndexSnapshot } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { group, session } from '../test/fixtures.js';
import { ANNOUNCE_DELAY_MS } from './Combobox.js';
import { DIRECTORY_TEXT, NewSessionDialog } from './NewSessionDialog.js';

const API_KEY = 'k'.repeat(43);
const CODE = '/Users/example/code';
const OSS = '/Users/example/oss';
const OTHER = '\u0000other';

const SNAPSHOT: Pick<IndexSnapshot, 'roots' | 'groups'> = {
  roots: [CODE],
  groups: [group({ key: `${CODE}/demo-app`, label: 'demo-app', sessions: [session({ name: 'pitwall-test-a' })] })],
};

const LIST: DirectoryList = {
  roots: [
    {
      root: CODE,
      dirs: [
        { path: 'demo-api', repo: true },
        { path: 'demo-app', repo: true },
        { path: 'notes' },
        { path: 'demo-app/web' },
        { path: 'notes/<img src=x>' },
      ],
      truncated: false,
    },
  ],
};

type Answer = { status: number; body?: unknown } | 'never';

/** A fake server: GET DIRECTORIES_PATH gets `directories`; POSTs (spawns) get 201. */
function fakeServer(directories: Answer = { status: 200, body: LIST }) {
  let release: (() => void) | undefined;
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (url === DIRECTORIES_PATH) {
      if (directories === 'never') {
        await new Promise<void>((resolve) => (release = resolve));
        return new Response(JSON.stringify(LIST), { status: 200 });
      }
      return new Response(directories.body === undefined ? 'not json' : JSON.stringify(directories.body), { status: directories.status });
    }
    if (init.method === 'POST' && url === SPAWN_PATH) return new Response(JSON.stringify({ ok: true, shortId: 'c0ffee12', name: 'pitwall-test-new' }), { status: 201 });
    return new Response('{}', { status: 404 });
  });
  return { fetch, release: () => release?.() };
}

const listGets = (fetch: ReturnType<typeof fakeServer>['fetch']) => fetch.mock.calls.filter(([url]) => url === DIRECTORIES_PATH);
const spawns = (fetch: ReturnType<typeof fakeServer>['fetch']) =>
  fetch.mock.calls.filter(([url, init]) => url === SPAWN_PATH && init.method === 'POST').map(([, init]) => JSON.parse(String(init.body)) as unknown);

const settle = () => act(async () => {});

function renderDialog(fetch: FetchLike, props: { snapshot?: Pick<IndexSnapshot, 'roots' | 'groups'>; tab?: string } = {}) {
  const api = createApiClient({ apiKey: API_KEY, fetch });
  const onClose = vi.fn();
  const onStarted = vi.fn();
  const ui = (
    <ApiContext.Provider value={api}>
      <NewSessionDialog snapshot={props.snapshot ?? SNAPSHOT} onClose={onClose} onStarted={onStarted} tab={props.tab} />
    </ApiContext.Provider>
  );
  const result = render(ui);
  return { ...result, onClose, onStarted, dialog: screen.getByRole('dialog', { name: 'New session' }) };
}

async function reveal(dialog: HTMLElement): Promise<HTMLInputElement> {
  fireEvent.change(within(dialog).getByLabelText('Directory'), { target: { value: OTHER } });
  await settle();
  return within(dialog).getByRole('combobox', { name: 'Directory path' }) as HTMLInputElement;
}

const listbox = (dialog: HTMLElement) => within(dialog).getByRole('listbox', { hidden: true });
const optionLabels = (dialog: HTMLElement) => within(listbox(dialog)).queryAllByRole('option', { hidden: true }).map((option) => option.textContent);
const popup = (dialog: HTMLElement) => dialog.querySelector('.combobox-popup') as HTMLElement;
const isOpen = (input: HTMLInputElement) => input.getAttribute('aria-expanded') === 'true';
const activeOption = (input: HTMLInputElement) => {
  const id = input.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};
const key = (input: HTMLInputElement, name: string, options: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(input, { key: name, ...options });

describe('Another directory under a root…', () => {
  it('reveals an editable combobox, moves focus into it, and opens its list of the directories', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);

    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-controls')).toBe(listbox(dialog).id);
    expect(listbox(dialog).getAttribute('aria-label')).toBe('Directories');
    expect(isOpen(input)).toBe(true);
    expect(popup(dialog).hidden).toBe(false);
    expect(optionLabels(dialog)).toEqual([
      '~/code/demo-api, repo',
      '~/code/demo-app, repo',
      '~/code/notes',
      '~/code/demo-app/web',
      '~/code/notes/<img src=x>',
    ]);
    // Every name is text, never markup.
    expect(listbox(dialog).querySelector('img')).toBeNull();
    // Nothing highlighted until the arrows move.
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    // Fetched with the apiKey, as every API call is.
    expect(listGets(server.fetch)).toHaveLength(1);
    expect((listGets(server.fetch)[0]?.[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('says it is loading until the list comes', async () => {
    const server = fakeServer('never');
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    expect(isOpen(input)).toBe(true);
    expect(within(popup(dialog)).getByText(DIRECTORY_TEXT.loading)).toBeTruthy();
    expect(listbox(dialog).hidden).toBe(true);
    server.release();
    await settle();
    expect(within(popup(dialog)).queryByText(DIRECTORY_TEXT.loading)).toBeNull();
    expect(optionLabels(dialog)).toHaveLength(5);
  });

  it('stops the request when the dialog closes before the list comes', async () => {
    const server = fakeServer('never');
    const { dialog, unmount } = renderDialog(server.fetch);
    await reveal(dialog);
    const signal = listGets(server.fetch)[0]?.[1].signal;
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('fetches the list once per opening of the dialog, when it is first chosen', async () => {
    const server = fakeServer();
    const first = renderDialog(server.fetch);
    expect(listGets(server.fetch)).toHaveLength(0);
    await reveal(first.dialog);
    fireEvent.change(within(first.dialog).getByLabelText('Directory'), { target: { value: `${CODE}/demo-app` } });
    await reveal(first.dialog);
    expect(listGets(server.fetch)).toHaveLength(1);
    first.unmount();

    const second = renderDialog(server.fetch);
    await reveal(second.dialog);
    expect(listGets(server.fetch)).toHaveLength(2);
  });

  it('narrows the options as you type, without asking the server again', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    fireEvent.change(input, { target: { value: 'APP' } });
    expect(optionLabels(dialog)).toEqual(['~/code/demo-app, repo', '~/code/demo-app/web']);
    fireEvent.change(input, { target: { value: 'nothing-like-it' } });
    expect(optionLabels(dialog)).toEqual([]);
    expect(within(popup(dialog)).getByText(DIRECTORY_TEXT.none)).toBeTruthy();
    expect(listGets(server.fetch)).toHaveLength(1);
  });

  it('moves through the options with ↓ and ↑, wrapping, and Enter accepts one without submitting', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    fireEvent.change(input, { target: { value: 'demo' } });
    expect(optionLabels(dialog)).toEqual(['~/code/demo-api, repo', '~/code/demo-app, repo', '~/code/demo-app/web']);

    key(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-api, repo');
    expect(activeOption(input)?.getAttribute('aria-selected')).toBe('true');
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app/web');
    key(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-api, repo');
    key(input, 'ArrowUp');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app/web');
    key(input, 'ArrowUp');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app, repo');
    // Only one is selected at a time.
    expect(within(listbox(dialog)).getAllByRole('option', { hidden: true }).filter((option) => option.getAttribute('aria-selected') === 'true')).toHaveLength(1);

    const enter = fireEvent.keyDown(input, { key: 'Enter' });
    expect(enter).toBe(false);
    expect(input.value).toBe('~/code/demo-app');
    expect(isOpen(input)).toBe(false);
    expect(document.activeElement).toBe(input);
    await settle();
    expect(spawns(server.fetch)).toEqual([]);

    // The request sends the absolute path.
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'go' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await settle();
    expect(spawns(server.fetch)).toEqual([{ cwd: `${CODE}/demo-app`, prompt: 'go' }]);
  });

  it('never submits on Enter, with or without a highlighted option; ⌘ and Ctrl + Enter still do', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'go' } });
    fireEvent.change(input, { target: { value: '~/code/notes' } });
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(isOpen(input)).toBe(false);
    await settle();
    expect(spawns(server.fetch)).toEqual([]);

    key(input, 'Enter', { metaKey: true });
    await settle();
    expect(spawns(server.fetch)).toEqual([{ cwd: `${CODE}/notes`, prompt: 'go' }]);
  });

  it('opens with ↓, highlighting the first; with ↑, the last; and with Alt + ↓, highlighting none', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    key(input, 'Escape');
    expect(isOpen(input)).toBe(false);
    key(input, 'ArrowDown', { altKey: true });
    expect(isOpen(input)).toBe(true);
    expect(activeOption(input)).toBeNull();
    key(input, 'Escape');
    key(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-api, repo');
    key(input, 'Escape');
    key(input, 'ArrowUp');
    expect(activeOption(input)?.textContent).toBe('~/code/notes/<img src=x>');
    // ← and → go back to the text, leaving the options.
    key(input, 'ArrowLeft');
    expect(activeOption(input)).toBeNull();
    expect(isOpen(input)).toBe(true);
  });

  it('closes an open list on Escape and keeps the dialog; Escape with it shut closes the dialog', async () => {
    const server = fakeServer();
    const { dialog, onClose } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    key(input, 'ArrowDown');
    key(input, 'Escape');
    expect(isOpen(input)).toBe(false);
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    expect(input.value).toBe('');
    expect(onClose).not.toHaveBeenCalled();
    key(input, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves on Tab without accepting', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    fireEvent.change(input, { target: { value: 'not' } });
    key(input, 'ArrowDown');
    key(input, 'Tab');
    fireEvent.blur(input);
    expect(input.value).toBe('not');
    expect(isOpen(input)).toBe(false);
  });

  it('closes on a press outside, or when focus moves to another element, but not when the window loses focus', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    fireEvent.blur(input, { relatedTarget: null });
    expect(isOpen(input)).toBe(true);
    // A press in the list or the field leaves it open.
    fireEvent.pointerDown(within(listbox(dialog)).getAllByRole('option', { hidden: true })[0] as HTMLElement);
    fireEvent.pointerDown(input);
    expect(isOpen(input)).toBe(true);
    fireEvent.pointerDown(within(dialog).getByLabelText('First prompt'));
    expect(isOpen(input)).toBe(false);

    fireEvent.click(input);
    expect(isOpen(input)).toBe(true);
    fireEvent.blur(input, { relatedTarget: within(dialog).getByLabelText(/^Name/) });
    expect(isOpen(input)).toBe(false);
  });

  it('closes when a submit puts focus on another field with a problem', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    fireEvent.change(input, { target: { value: '~/code/notes' } });
    expect(isOpen(input)).toBe(true);
    key(input, 'Enter', { ctrlKey: true });
    await settle();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('First prompt'));
    expect(isOpen(input)).toBe(false);
  });

  it('accepts a clicked option and keeps focus in the field', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    const option = within(listbox(dialog)).getAllByRole('option', { hidden: true })[3] as HTMLElement;
    // The press doesn't take focus out of the field.
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect(input.value).toBe('~/code/demo-app/web');
    expect(document.activeElement).toBe(input);
    expect(isOpen(input)).toBe(false);
    // A click in the field opens it again.
    fireEvent.click(input);
    expect(isOpen(input)).toBe(true);
  });

  it('sends a typed path as before once the text no longer is the chosen option', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    key(input, 'ArrowDown');
    key(input, 'Enter');
    expect(input.value).toBe('~/code/demo-api');
    fireEvent.change(input, { target: { value: '~/code/demo-api/deep/er/than/three' } });
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'go' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await settle();
    expect(spawns(server.fetch)).toEqual([{ cwd: `${CODE}/demo-api/deep/er/than/three`, prompt: 'go' }]);
  });

  it("with a root tab open, offers that root's directories alone (W38)", async () => {
    const list: DirectoryList = {
      roots: [
        { root: CODE, dirs: [{ path: 'demo-app' }], truncated: false },
        { root: OSS, dirs: [{ path: 'blog', repo: true }], truncated: false },
      ],
    };
    const server = fakeServer({ status: 200, body: list });
    const { dialog } = renderDialog(server.fetch, { snapshot: { roots: [CODE, OSS], groups: [] }, tab: OSS });
    const input = await reveal(dialog);
    expect(optionLabels(dialog)).toEqual(['~/oss/blog, repo']);
    expect(input.placeholder).toBe('~/oss/…');
  });

  it('says when not every directory is listed, and that a path can be typed', async () => {
    const server = fakeServer({ status: 200, body: { roots: [{ ...LIST.roots[0]!, truncated: true }] } });
    const { dialog } = renderDialog(server.fetch);
    await reveal(dialog);
    expect(within(popup(dialog)).getByText(DIRECTORY_TEXT.truncated)).toBeTruthy();
  });

  it('says when a root has no directories to list', async () => {
    const server = fakeServer({ status: 200, body: { roots: [{ root: CODE, dirs: [], truncated: false }] } });
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    expect(isOpen(input)).toBe(true);
    expect(within(popup(dialog)).getByText(DIRECTORY_TEXT.empty)).toBeTruthy();
  });

  it('shows the best 50, says how many there are, and announces the count once the typing stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const many: DirectoryList = {
      roots: [{ root: CODE, dirs: Array.from({ length: 312 }, (_, i) => ({ path: `project-${String(i).padStart(3, '0')}` })), truncated: false }],
    };
    const server = fakeServer({ status: 200, body: many });
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    expect(optionLabels(dialog)).toHaveLength(50);
    expect(within(popup(dialog)).getByText(`50 of 312. ${DIRECTORY_TEXT.narrow}`)).toBeTruthy();
    const status = within(dialog).getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    });
    expect(status.textContent).toBe(`50 of 312 directories. ${DIRECTORY_TEXT.narrow}`);

    // Not on every key: only once the typing stops.
    fireEvent.change(input, { target: { value: 'project-0' } });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 100);
    });
    fireEvent.change(input, { target: { value: 'project-01' } });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 100);
    });
    expect(status.textContent).toBe(`50 of 312 directories. ${DIRECTORY_TEXT.narrow}`);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(status.textContent).toBe('10 directories.');
    expect(within(popup(dialog)).queryByText(/of 312/)).toBeNull();
  });

  it("still takes a typed path when the list couldn't be had, and says so", async () => {
    for (const answer of [{ status: 500 }, { status: 200, body: { nope: true } }]) {
      const server = fakeServer(answer);
      const { dialog, unmount } = renderDialog(server.fetch);
      const input = await reveal(dialog);
      expect(isOpen(input)).toBe(false);
      const hint = within(dialog).getByText(DIRECTORY_TEXT.failed);
      expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(hint.id);
      fireEvent.change(input, { target: { value: '~/code/typed' } });
      fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'go' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
      await settle();
      expect(spawns(server.fetch)).toEqual([{ cwd: `${CODE}/typed`, prompt: 'go' }]);
      unmount();
    }
  });

  it('puts focus on the combobox when its directory is the first problem', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    fireEvent.change(input, { target: { value: '/etc' } });
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'go' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await settle();
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getByText('Use a directory under ~/code.')).toBeTruthy();
    expect(spawns(server.fetch)).toEqual([]);
  });
});
