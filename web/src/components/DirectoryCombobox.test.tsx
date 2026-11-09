// New session's Directory combobox (W70, W140): the groups' directories and the roots first, then the
// directories under the roots, fetched once per opening, and narrowed as you type. The WAI-ARIA APG
// editable combobox with list autocomplete, through the real dialog. Made-up directories only.
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

const directory = (dialog: HTMLElement) => within(dialog).getByRole('combobox', { name: 'Directory' }) as HTMLInputElement;

/** The field, emptied, as when you select its text and delete it: the list opens with every option. */
async function reveal(dialog: HTMLElement): Promise<HTMLInputElement> {
  await settle();
  const input = directory(dialog);
  fireEvent.change(input, { target: { value: '' } });
  return input;
}

/** SNAPSHOT's group and root first, then the rest of LIST, shallower first. */
const ALL = ['~/code/demo-app, repo', '~/code', '~/code/demo-api, repo', '~/code/notes', '~/code/demo-app/web', '~/code/notes/<img src=x>'];

const listbox = (dialog: HTMLElement) => within(dialog).getByRole('listbox', { hidden: true });
const optionLabels = (dialog: HTMLElement) => within(listbox(dialog)).queryAllByRole('option', { hidden: true }).map((option) => option.textContent);
const popup = (dialog: HTMLElement) => dialog.querySelector('.combobox-popup') as HTMLElement;
const isOpen = (input: HTMLInputElement) => input.getAttribute('aria-expanded') === 'true';
const activeOption = (input: HTMLInputElement) => {
  const id = input.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};
const key = (input: HTMLInputElement, name: string, options: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(input, { key: name, ...options });

describe('Directory', () => {
  it('opens showing its first choice, focused with its text selected, so typing replaces it', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    await settle();
    const input = directory(dialog);
    expect(input.value).toBe('~/code/demo-app');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    // Shut until asked, so it doesn't cover the fields under it as the dialog opens.
    expect(isOpen(input)).toBe(false);
    // A select's chevron says it's a list too; it's decoration, so a screen reader hears the combobox alone.
    expect(input.closest('.combobox')?.querySelector('svg.select-icon')?.getAttribute('aria-hidden')).toBe('true');
    // Untouched, it sends the first choice.
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'go' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await settle();
    expect(spawns(server.fetch)).toEqual([{ cwd: `${CODE}/demo-app`, prompt: 'go' }]);
  });

  it('offers every directory while it shows the chosen one, as a select would, and narrows once you type', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    await settle();
    const input = directory(dialog);
    fireEvent.click(input);
    expect(isOpen(input)).toBe(true);
    expect(optionLabels(dialog)).toEqual(ALL);
    fireEvent.change(input, { target: { value: 'notes' } });
    expect(optionLabels(dialog)).toEqual(['~/code/notes', '~/code/notes/<img src=x>']);
    // Chosen again, it shows every one again. Typing highlighted the first (W142).
    key(input, 'Enter');
    expect(input.value).toBe('~/code/notes');
    fireEvent.click(input);
    expect(optionLabels(dialog)).toEqual(ALL);
  });

  it("puts the groups' directories first on a tie, and a better match first otherwise", async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    // demo-app, a group's, and demo-api both start with it: the group's first.
    fireEvent.change(input, { target: { value: 'demo' } });
    expect(optionLabels(dialog)).toEqual(['~/code/demo-app, repo', '~/code/demo-api, repo', '~/code/demo-app/web']);
    fireEvent.change(input, { target: { value: 'demo-api' } });
    expect(optionLabels(dialog)).toEqual(['~/code/demo-api, repo']);
    // A root matches on its own name.
    fireEvent.change(input, { target: { value: 'code' } });
    expect(optionLabels(dialog)).toEqual(['~/code']);
  });

  it("is an editable combobox whose list holds the groups' directories, the roots, then the directories under them", async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);

    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-controls')).toBe(listbox(dialog).id);
    expect(listbox(dialog).getAttribute('aria-label')).toBe('Directories');
    expect(isOpen(input)).toBe(true);
    expect(popup(dialog).hidden).toBe(false);
    expect(optionLabels(dialog)).toEqual(ALL);
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
    // The groups' directories and the root, which need no list, meanwhile.
    expect(optionLabels(dialog)).toEqual(['~/code/demo-app', '~/code']);
    server.release();
    await settle();
    expect(within(popup(dialog)).queryByText(DIRECTORY_TEXT.loading)).toBeNull();
    expect(optionLabels(dialog)).toEqual(ALL);
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

  it('fetches the list once per opening of the dialog, as it opens', async () => {
    const server = fakeServer();
    const first = renderDialog(server.fetch);
    await settle();
    expect(listGets(server.fetch)).toHaveLength(1);
    const input = await reveal(first.dialog);
    fireEvent.change(input, { target: { value: 'demo' } });
    key(input, 'ArrowDown');
    key(input, 'Enter');
    fireEvent.change(input, { target: { value: 'notes' } });
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
    expect(optionLabels(dialog)).toEqual(['~/code/demo-app, repo', '~/code/demo-api, repo', '~/code/demo-app/web']);

    // Typing highlighted the first (W142); ↓ moves on from it.
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app, repo');
    expect(activeOption(input)?.getAttribute('aria-selected')).toBe('true');
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app/web');
    key(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app, repo');
    key(input, 'ArrowUp');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app/web');
    key(input, 'ArrowUp');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-api, repo');
    // Only one is selected at a time.
    expect(within(listbox(dialog)).getAllByRole('option', { hidden: true }).filter((option) => option.getAttribute('aria-selected') === 'true')).toHaveLength(1);

    const enter = fireEvent.keyDown(input, { key: 'Enter' });
    expect(enter).toBe(false);
    expect(input.value).toBe('~/code/demo-api');
    expect(isOpen(input)).toBe(false);
    expect(document.activeElement).toBe(input);
    await settle();
    expect(spawns(server.fetch)).toEqual([]);

    // The request sends the absolute path.
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'go' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await settle();
    expect(spawns(server.fetch)).toEqual([{ cwd: `${CODE}/demo-api`, prompt: 'go' }]);
  });

  it('highlights the first match as you type, so Enter takes it (W142)', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    fireEvent.change(input, { target: { value: 'dem' } });
    expect(isOpen(input)).toBe(true);
    const first = within(listbox(dialog)).getAllByRole('option', { hidden: true })[0];
    expect(input.getAttribute('aria-activedescendant')).toBe(first?.id);
    expect(first?.getAttribute('aria-selected')).toBe('true');
    // ↓ moves to the second, and typing again goes back to the first.
    key(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-api, repo');
    fireEvent.change(input, { target: { value: 'dem-' } });
    fireEvent.change(input, { target: { value: 'demo-' } });
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app, repo');

    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(input.value).toBe('~/code/demo-app');
    expect(isOpen(input)).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'go' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await settle();
    expect(spawns(server.fetch)).toEqual([{ cwd: `${CODE}/demo-app`, prompt: 'go' }]);
  });

  it('highlights none while nothing matches, or the text is emptied, so Enter keeps the text (W142)', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    fireEvent.change(input, { target: { value: 'nothing-like-it' } });
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    key(input, 'Enter');
    expect(input.value).toBe('nothing-like-it');
    expect(isOpen(input)).toBe(false);

    // Emptied, or only spaces: the list offers every directory, and none is picked for you.
    for (const text of ['', '  ']) {
      fireEvent.change(input, { target: { value: 'dem' } });
      expect(activeOption(input)).not.toBeNull();
      fireEvent.change(input, { target: { value: text } });
      expect(optionLabels(dialog)).toEqual(ALL);
      expect(input.getAttribute('aria-activedescendant')).toBeNull();
      key(input, 'Enter');
      expect(input.value).toBe(text);
      expect(isOpen(input)).toBe(false);
    }
    // ↓ still highlights the first.
    key(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app, repo');
  });

  it('highlights the first match once the list comes, when you typed before it did (W142)', async () => {
    const server = fakeServer('never');
    const { dialog } = renderDialog(server.fetch);
    await settle();
    const input = directory(dialog);
    // Only the group's directory and the root are offered yet; neither matches.
    fireEvent.change(input, { target: { value: 'api' } });
    expect(activeOption(input)).toBeNull();
    server.release();
    await settle();
    expect(activeOption(input)?.textContent).toBe('~/code/demo-api, repo');
    key(input, 'Enter');
    expect(input.value).toBe('~/code/demo-api');
  });

  it("highlights none while it shows the chosen directory, until you type, nor when you type back to it (W142)", async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    await settle();
    const input = directory(dialog);
    const chosen = input.value;
    expect(chosen).not.toBe('');
    key(input, 'ArrowDown', { altKey: true });
    expect(isOpen(input)).toBe(true);
    expect(activeOption(input)).toBeNull();
    // Typed back to the chosen text, the list offers everything again, and Enter keeps the choice.
    fireEvent.change(input, { target: { value: chosen.slice(0, -1) } });
    expect(activeOption(input)).not.toBeNull();
    fireEvent.change(input, { target: { value: chosen } });
    expect(activeOption(input)).toBeNull();
    key(input, 'Enter');
    expect(input.value).toBe(chosen);
  });

  it('never submits on Enter, with or without a highlighted option; ⌘ and Ctrl + Enter still do', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'go' } });
    // With the first match highlighted, as typing leaves it (W142), Enter accepts it.
    fireEvent.change(input, { target: { value: '~/code/notes' } });
    expect(activeOption(input)?.textContent).toBe('~/code/notes');
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(isOpen(input)).toBe(false);
    // With none, as when nothing matches, Enter only closes the list.
    fireEvent.change(input, { target: { value: '~/code/nothing-like-it' } });
    expect(activeOption(input)).toBeNull();
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(isOpen(input)).toBe(false);
    expect(input.value).toBe('~/code/nothing-like-it');
    await settle();
    expect(spawns(server.fetch)).toEqual([]);

    // ⌘ + Enter starts with what's typed, not the first match it highlights.
    fireEvent.change(input, { target: { value: '~/code/note' } });
    expect(activeOption(input)?.textContent).toBe('~/code/notes');

    key(input, 'Enter', { metaKey: true });
    await settle();
    expect(spawns(server.fetch)).toEqual([{ cwd: `${CODE}/note`, prompt: 'go' }]);
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
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app, repo');
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

  it('leaves every key to an input method while it composes, Safari\'s 229 after compositionend included', async () => {
    const server = fakeServer();
    const { dialog, onClose } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    fireEvent.change(input, { target: { value: 'demo' } });
    // Choosing a candidate, then confirming the conversion, while composing: the highlight stays on
    // the first, where typing put it (W142).
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app, repo');
    expect(fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true })).toBe(true);
    expect(activeOption(input)?.textContent).toBe('~/code/demo-app, repo');
    key(input, 'ArrowDown');
    expect(activeOption(input)?.textContent).toBe('~/code/demo-api, repo');
    expect(fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true })).toBe(true);
    expect(activeOption(input)?.textContent).toBe('~/code/demo-api, repo');
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(input.value).toBe('demo');
    expect(isOpen(input)).toBe(true);
    // An Escape that ends a composition, Safari's 229 included, closes neither the list nor the dialog.
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();
    expect(isOpen(input)).toBe(true);
    expect(input.value).toBe('demo');
    expect(screen.getByRole('dialog', { name: 'New session' })).toBe(dialog);
    // Composition over, the keys are the list's again.
    key(input, 'Enter');
    expect(input.value).toBe('~/code/demo-api');
    expect(onClose).not.toHaveBeenCalled();
    expect(spawns(server.fetch)).toEqual([]);
  });

  it('sends exactly the path it shows: a chosen name with a space at its end, and then typed text, trimmed as before', async () => {
    // The server leaves such names out; this one is made up to show the field and the request agree.
    for (const space of [' ', '\u3000', '\u00a0']) {
      const server = fakeServer({ status: 200, body: { roots: [{ root: CODE, dirs: [{ path: `notes${space}` }], truncated: false }] } });
      const { dialog, unmount } = renderDialog(server.fetch);
      const input = await reveal(dialog);
      // The last, after the group's directory and the root.
      key(input, 'ArrowUp');
      key(input, 'Enter');
      expect(input.value).toBe(`~/code/notes${space}`);
      fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'go' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
      await settle();
      // Edited by a space or none, it's typed text again, trimmed as before.
      fireEvent.change(input, { target: { value: `~/code/notes${space}${space}` } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
      await settle();
      expect(spawns(server.fetch)).toEqual([
        { cwd: `${CODE}/notes${space}`, prompt: 'go' },
        { cwd: `${CODE}/notes`, prompt: 'go' },
      ]);
      unmount();
    }
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
    const option = within(listbox(dialog)).getAllByRole('option', { hidden: true })[4] as HTMLElement;
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
    key(input, 'ArrowUp');
    key(input, 'ArrowUp');
    key(input, 'Enter');
    expect(input.value).toBe('~/code/demo-app/web');
    fireEvent.change(input, { target: { value: '~/code/demo-app/web/deep/er/than/three' } });
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'go' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await settle();
    expect(spawns(server.fetch)).toEqual([{ cwd: `${CODE}/demo-app/web/deep/er/than/three`, prompt: 'go' }]);
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
    await settle();
    expect(directory(dialog).value).toBe('~/oss');
    const input = await reveal(dialog);
    expect(optionLabels(dialog)).toEqual(['~/oss', '~/oss/blog, repo']);
    expect(input.placeholder).toBe('~/oss/…');
  });

  it('says when not every directory is listed, and that a path can be typed', async () => {
    const server = fakeServer({ status: 200, body: { roots: [{ ...LIST.roots[0]!, truncated: true }] } });
    const { dialog } = renderDialog(server.fetch);
    await reveal(dialog);
    expect(within(popup(dialog)).getByText(DIRECTORY_TEXT.truncated)).toBeTruthy();
  });

  it("still offers the groups' directories and the root when the root has none to list", async () => {
    const server = fakeServer({ status: 200, body: { roots: [{ root: CODE, dirs: [], truncated: false }] } });
    const { dialog } = renderDialog(server.fetch);
    const input = await reveal(dialog);
    expect(isOpen(input)).toBe(true);
    expect(optionLabels(dialog)).toEqual(['~/code/demo-app', '~/code']);
    expect(within(popup(dialog)).queryByText(DIRECTORY_TEXT.empty)).toBeNull();
  });

  it('says when there are no directories to list at all', async () => {
    const server = fakeServer({ status: 200, body: { roots: [] } });
    const { dialog } = renderDialog(server.fetch, { snapshot: { roots: [], groups: [] } });
    await settle();
    const input = directory(dialog);
    // Nothing to choose, so it opens empty.
    expect(input.value).toBe('');
    fireEvent.click(input);
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
    expect(within(popup(dialog)).getByText(`50 of 314. ${DIRECTORY_TEXT.narrow}`)).toBeTruthy();
    // The combobox's own, not the files' status in the first prompt's field (W82).
    const status = within(input.closest<HTMLElement>('.combobox')!).getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    });
    expect(status.textContent).toBe(`50 of 314 directories. ${DIRECTORY_TEXT.narrow}`);

    // Not on every key: only once the typing stops.
    fireEvent.change(input, { target: { value: 'project-0' } });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 100);
    });
    fireEvent.change(input, { target: { value: 'project-01' } });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 100);
    });
    expect(status.textContent).toBe(`50 of 314 directories. ${DIRECTORY_TEXT.narrow}`);
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
      // The groups' directories and the root, which need no list, are still offered.
      expect(optionLabels(dialog)).toEqual(['~/code/demo-app', '~/code']);
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
