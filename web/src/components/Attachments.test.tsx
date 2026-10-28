// New session's attachments (W82; docs/design-system.md, 4: Dialogs, Attachments): the Attach files
// button and its file input, a drop on the prompt with its drop target, a paste, the list and its
// states, Remove and Try again with focus, at most two uploads at once, and Start session waiting for
// them and sending their ids. Against a fake fetch; made-up files only.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PATH, attachmentPath, SPAWN_PATH, type IndexSnapshot } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { ATTACH_TEXT } from '../attachments.js';
import { group, session, snapshot } from '../test/fixtures.js';
import { NewSessionDialog } from './NewSessionDialog.js';

const API_KEY = 'k'.repeat(43);
const REPO = '/Users/example/code/demo-app';
const SNAPSHOT: IndexSnapshot = snapshot([group({ key: REPO, label: 'demo-app', sessions: [session({ name: 'demo-docs' })] })]);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Upload {
  name: string;
  type: string;
  size: number;
  signal: AbortSignal | undefined;
  answer: (response: Response) => void;
}

/**
 * A fake pitwall: each upload waits until the test answers it (or answers at once with `auto`), a
 * spawn starts, and a DELETE of an upload is recorded and answered 204. An aborted upload rejects,
 * as fetch does.
 */
function fakeServer({ auto }: { auto?: (upload: Omit<Upload, 'answer'>, index: number) => Response } = {}) {
  const uploads: Upload[] = [];
  const spawns: unknown[] = [];
  const deletes: string[] = [];
  let id = 0;
  const fetch = vi.fn<FetchLike>((url, init) => {
    if (init.method === 'DELETE') {
      deletes.push(url);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url === SPAWN_PATH) {
      spawns.push(JSON.parse(String(init.body)));
      return Promise.resolve(json(201, { ok: true, shortId: 'c0ffee12', name: 'pitwall-test-spawn' }));
    }
    if (url !== ATTACHMENTS_PATH) return Promise.resolve(json(404, {}));
    const headers = init.headers as Record<string, string>;
    const body = init.body as Blob;
    const upload = { name: decodeURIComponent(headers['X-Pitwall-Filename'] ?? ''), type: headers['Content-Type'] ?? '', size: body.size, signal: init.signal ?? undefined };
    if (auto) {
      const index = uploads.length;
      uploads.push({ ...upload, answer: () => {} });
      return Promise.resolve(auto(upload, index));
    }
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      uploads.push({ ...upload, answer: resolve });
    });
  });
  const kept = (upload: Pick<Upload, 'name' | 'type' | 'size'>) => {
    id += 1;
    return json(201, { ok: true, attachment: { id: `id-${id}`, name: upload.name, type: upload.type, size: upload.size } });
  };
  return { fetch, uploads, spawns, deletes, kept };
}

/** `null` renders it without an API, as where sessions can't be started from. */
function renderDialog(fetch: FetchLike | null = fakeServer().fetch) {
  const onClose = vi.fn();
  const onStarted = vi.fn();
  const api = fetch ? createApiClient({ apiKey: API_KEY, fetch }) : undefined;
  const result = render(
    <ApiContext.Provider value={api}>
      <NewSessionDialog snapshot={SNAPSHOT} onClose={onClose} onStarted={onStarted} />
    </ApiContext.Provider>,
  );
  const dialog = screen.getByRole('dialog', { name: 'New session' });
  return { ...result, dialog, onClose, onStarted };
}

const settle = () => act(async () => {});

const file = (name: string, type: string, size = 12) => {
  const made = new File([new Uint8Array(Math.min(size, 64))], name, { type });
  if (size > 64) Object.defineProperty(made, 'size', { value: size });
  return made;
};

const prompt = (dialog: HTMLElement) => within(dialog).getByLabelText('First prompt');
const input = (dialog: HTMLElement) => dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
const list = (dialog: HTMLElement) => within(dialog).queryByRole('list', { name: 'Attached files' });
const rows = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>('.attachment')];
const states = (dialog: HTMLElement) => rows(dialog).map((row) => [row.querySelector('.attachment-name')?.textContent, row.dataset.state]);
/** What the first prompt's field last announced about its files. */
const announced = (dialog: HTMLElement) => within(prompt(dialog).closest<HTMLElement>('.field')!).getByRole('status').textContent;
const start = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Start session' });
const attachButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Attach files' });
const describedText = (element: Element) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' | ');

async function choose(dialog: HTMLElement, files: File[]) {
  fireEvent.change(input(dialog), { target: { files } });
  await settle();
}

type Carried = { types: string[]; files: File[]; dropEffect: string };

/**
 * A drag event carrying `dataTransfer` as it is, so a handler's dropEffect can be read back. Returns
 * false when a handler prevented its default, as dispatchEvent does.
 */
function drag(type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', target: Element, dataTransfer: Carried): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  let result = true;
  act(() => {
    result = target.dispatchEvent(event);
  });
  return result;
}

async function drop(dialog: HTMLElement, files: File[], target: Element = prompt(dialog)) {
  const dataTransfer = { types: ['Files'], files, dropEffect: 'none' };
  drag('dragenter', target, dataTransfer);
  drag('dragover', target, dataTransfer);
  drag('drop', target, dataTransfer);
  await settle();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('New session: Attach files', () => {
  it('is an outline sm button with the attach icon, under the prompt, described by what it takes, with a native file input behind it', () => {
    const { dialog } = renderDialog();
    const button = attachButton(dialog);
    expect(button.className).toBe('button sm');
    expect(button.querySelector('svg')).toBeTruthy();
    expect(describedText(button)).toBe(ATTACH_TEXT.hint);
    const field = input(dialog);
    expect(field.multiple).toBe(true);
    expect(field.hidden).toBe(true);
    expect(field.tabIndex).toBe(-1);
    expect(field.accept.split(',')).toEqual(expect.arrayContaining(['image/png', 'application/pdf', 'text/markdown', '.md', '.csv']));
    const click = vi.spyOn(field, 'click').mockImplementation(() => {});
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
    // Nothing is listed until a file is added.
    expect(list(dialog)).toBeNull();
  });

  it('lists each chosen file with its size, uploads it with its type and name, and empties the input', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    await choose(dialog, [file('diagram.png', 'image/png', 250_000), file('notes.md', '')]);

    expect(states(dialog)).toEqual([
      ['diagram.png', 'uploading'],
      ['notes.md', 'uploading'],
    ]);
    expect(rows(dialog)[0]!.querySelector('.attachment-meta')?.textContent).toBe('244 KB · Uploading…');
    expect(server.uploads.map(({ name, type, size }) => ({ name, type, size }))).toEqual([
      { name: 'diagram.png', type: 'image/png', size: 250_000 },
      { name: 'notes.md', type: 'text/markdown', size: 12 },
    ]);
    expect(input(dialog).value).toBe('');

    await act(async () => server.uploads[0]!.answer(server.kept(server.uploads[0]!)));
    expect(states(dialog)[0]).toEqual(['diagram.png', 'uploaded']);
    expect(rows(dialog)[0]!.querySelector('.attachment-meta')?.textContent).toBe('244 KB');
    expect(announced(dialog)).toBe('Attached diagram.png.');
  });

  it('shows the name as text, cut in the middle with its extension kept, and a type icon for a file that is not an image', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    await choose(dialog, [file('Quarterly planning notes, second draft.pdf', 'application/pdf'), file('<b>bold</b>.txt', 'text/plain')]);
    const [pdf, text] = rows(dialog);
    expect(pdf!.querySelector('.middle-ellipsis-start')?.textContent).toBe('Quarterly planning notes, second');
    expect(pdf!.querySelector('.middle-ellipsis-end')?.textContent).toBe(' draft.pdf');
    expect(text!.querySelector('b')).toBeNull();
    expect(text!.querySelector('.attachment-name')?.textContent).toBe('<b>bold</b>.txt');
    expect(pdf!.querySelector('.attachment-tile svg')).toBeTruthy();
    expect(pdf!.querySelector('.attachment-tile')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws a thumbnail for an image, from its middle, as a data: URL the CSP allows', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 128, height: 72, close })));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
    const { dialog } = renderDialog();
    await choose(dialog, [file('shot.png', 'image/png')]);
    await settle();
    const thumbnail = rows(dialog)[0]!.querySelector('img');
    expect(thumbnail?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(thumbnail?.getAttribute('alt')).toBe('');
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 28, 0, 72, 72, 0, 0, 64, 64);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('New session: dropping files on the prompt', () => {
  it('shows the drop target over the prompt while files are dragged over the page, solid over the prompt, and attaches what is dropped', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    const dataTransfer = { types: ['Files'], files: [] as File[], dropEffect: 'move' };
    const name = within(dialog).getByLabelText(/^Name/);

    drag('dragenter', name, dataTransfer);
    const target = dialog.querySelector('.prompt-drop-target');
    expect(target?.textContent).toBe('Drop files to attach them');
    expect(target?.getAttribute('aria-hidden')).toBe('true');
    expect(target?.classList.contains('over')).toBe(false);
    // Not over the prompt: the browser's own drop, which would open the file, is stopped, and the pointer says no.
    expect(drag('dragover', name, dataTransfer)).toBe(false);
    expect(dataTransfer.dropEffect).toBe('none');

    drag('dragenter', prompt(dialog), dataTransfer);
    drag('dragleave', name, dataTransfer);
    expect(drag('dragover', prompt(dialog), dataTransfer)).toBe(false);
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(dialog.querySelector('.prompt-drop-target')?.classList.contains('over')).toBe(true);

    drag('drop', prompt(dialog), { ...dataTransfer, files: [file('a.txt', 'text/plain')] });
    await settle();
    expect(dialog.querySelector('.prompt-drop-target')).toBeNull();
    expect(states(dialog)).toEqual([['a.txt', 'uploading']]);
  });

  it('hides the drop target once the files leave the page, and attaches nothing dropped anywhere but the prompt', async () => {
    const { dialog } = renderDialog();
    const dataTransfer = { types: ['Files'], files: [file('a.txt', 'text/plain')], dropEffect: 'none' };
    drag('dragenter', prompt(dialog), dataTransfer);
    expect(dialog.querySelector('.prompt-drop-target')).toBeTruthy();
    drag('dragleave', prompt(dialog), dataTransfer);
    expect(dialog.querySelector('.prompt-drop-target')).toBeNull();

    const name = within(dialog).getByLabelText(/^Name/);
    drag('dragenter', name, dataTransfer);
    expect(drag('drop', name, dataTransfer)).toBe(false);
    await settle();
    expect(list(dialog)).toBeNull();
    expect(dialog.querySelector('.prompt-drop-target')).toBeNull();
  });

  it('leaves a drag that carries no files alone, such as selected text', () => {
    const { dialog } = renderDialog();
    const dataTransfer = { types: ['text/plain'], files: [], dropEffect: 'none' };
    drag('dragenter', prompt(dialog), dataTransfer);
    expect(dialog.querySelector('.prompt-drop-target')).toBeNull();
    expect(drag('dragover', prompt(dialog), dataTransfer)).toBe(true);
  });
});

describe('New session: pasting into the prompt', () => {
  const clipboard = (files: File[], text = '') => ({ files, items: [], types: files.length > 0 ? ['Files'] : ['text/plain'], getData: (type: string) => (type === 'text/plain' ? text : '') });

  it('attaches a pasted image, and the paste puts no text in the prompt', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    expect(fireEvent.paste(prompt(dialog), { clipboardData: clipboard([file('image.png', 'image/png')]) })).toBe(false);
    await settle();
    expect(states(dialog)).toEqual([['image.png', 'uploading']]);
    expect((prompt(dialog) as HTMLTextAreaElement).value).toBe('');
  });

  it('lets pasted text paste as text, with or without a picture of it, as a spreadsheet copies one', async () => {
    const { dialog } = renderDialog();
    expect(fireEvent.paste(prompt(dialog), { clipboardData: clipboard([], 'Reply with: ready') })).toBe(true);
    expect(fireEvent.paste(prompt(dialog), { clipboardData: clipboard([file('image.png', 'image/png')], 'Region\tTotal') })).toBe(true);
    await settle();
    expect(list(dialog)).toBeNull();
  });
});

describe('New session: refused files', () => {
  it('lists each with why, uploads the rest, and announces the refusals', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    await drop(dialog, [file('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), file('huge.png', 'image/png', ATTACHMENT_MAX_BYTES + 1), file('ok.json', 'application/json')]);

    expect(states(dialog)).toEqual([
      ['report.docx', 'refused'],
      ['huge.png', 'refused'],
      ['ok.json', 'uploading'],
    ]);
    const [docx, huge] = rows(dialog);
    expect(docx!.querySelector('.attachment-problem')?.textContent).toBe("Couldn't attach it. Only images, PDFs and text files can be attached.");
    expect(huge!.querySelector('.attachment-problem')?.textContent).toBe("Couldn't attach it. It's 10.1 MB, over the 10 MB limit.");
    // Its size, rounded up as the problem has it, never as the limit.
    expect(huge!.querySelector('.attachment-meta')?.textContent).toBe('10.1 MB');
    // A refused file has Remove only, and isn't sent.
    expect(within(docx!).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(server.uploads.map((upload) => upload.name)).toEqual(['ok.json']);
    expect(announced(dialog)).toBe(
      "Couldn't attach report.docx. Only images, PDFs and text files can be attached. Couldn't attach huge.png. It's 10.1 MB, over the 10 MB limit.",
    );
    // Its Remove says which file, and why it's there.
    const remove = within(docx!).getByRole('button', { name: 'Remove report.docx' });
    expect(describedText(remove)).toBe("12 B | Couldn't attach it. Only images, PDFs and text files can be attached.");
  });

  it('refuses the eleventh file, with the limit, and counts no refused file towards it', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    await drop(dialog, [file('nope.exe', 'application/octet-stream'), ...Array.from({ length: 11 }, (_, index) => file(`f${index + 1}.txt`, 'text/plain'))]);
    const refused = rows(dialog).filter((row) => row.dataset.state === 'refused');
    expect(refused.map((row) => row.querySelector('.attachment-name')?.textContent)).toEqual(['nope.exe', 'f11.txt']);
    expect(refused[1]!.querySelector('.attachment-problem')?.textContent).toBe("Couldn't attach it. A first prompt takes at most 10 files.");
  });

  it("lists the server's refusal, a 415 for bytes that contradict the type, with its reason in code style and no Try again, and it doesn't hold up Start session", async () => {
    const server = fakeServer({ auto: () => json(415, { ok: false, error: "Made up: its first bytes aren't a PNG's." }) });
    const { dialog } = renderDialog(server.fetch);
    await choose(dialog, [file('fake.png', 'image/png')]);
    await settle();
    const [row] = rows(dialog);
    expect(row!.dataset.state).toBe('refused');
    expect(row!.querySelector('.attachment-problem')?.textContent).toBe("Couldn't attach it. Made up: its first bytes aren't a PNG's.");
    expect(row!.querySelector('.attachment-problem .alert-detail')?.textContent).toBe("Made up: its first bytes aren't a PNG's.");
    expect(within(row!).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(start(dialog).getAttribute('aria-disabled')).toBeNull();
  });
});

describe('New session: uploads', () => {
  it('runs at most two at once, starting the next as one finishes', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    await choose(dialog, [file('1.txt', 'text/plain'), file('2.txt', 'text/plain'), file('3.txt', 'text/plain')]);
    expect(server.uploads.map((upload) => upload.name)).toEqual(['1.txt', '2.txt']);
    expect(states(dialog).map(([, state]) => state)).toEqual(['uploading', 'uploading', 'waiting']);
    expect(rows(dialog)[2]!.querySelector('.attachment-meta')?.textContent).toBe('12 B · Waiting…');
    await act(async () => server.uploads[1]!.answer(server.kept(server.uploads[1]!)));
    expect(server.uploads.map((upload) => upload.name)).toEqual(['1.txt', '2.txt', '3.txt']);
  });

  it('Remove aborts an upload, starts the next, and puts focus on the next file, or else Attach files', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    await choose(dialog, [file('1.txt', 'text/plain'), file('2.txt', 'text/plain'), file('3.txt', 'text/plain')]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 1.txt' }));
    await settle();
    expect(server.uploads[0]!.signal?.aborted).toBe(true);
    expect(states(dialog).map(([name]) => name)).toEqual(['2.txt', '3.txt']);
    expect(server.uploads.map((upload) => upload.name)).toEqual(['1.txt', '2.txt', '3.txt']);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Remove 2.txt' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 3.txt' }));
    await settle();
    expect(document.activeElement).toBe(attachButton(dialog));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 2.txt' }));
    await settle();
    expect(list(dialog)).toBeNull();
    expect(document.activeElement).toBe(attachButton(dialog));
  });

  it('a failure says so, with Try again and Remove; Try again uploads it again, with focus on its Remove', async () => {
    const server = fakeServer({ auto: (upload, index) => (index === 0 ? json(500, { ok: false, error: "Made up: pitwall couldn't write it." }) : server.kept(upload)) });
    const { dialog } = renderDialog(server.fetch);
    await choose(dialog, [file('notes.txt', 'text/plain')]);
    await settle();
    const [row] = rows(dialog);
    expect(row!.dataset.state).toBe('failed');
    expect(row!.querySelector('.attachment-problem')?.textContent).toBe("Couldn't upload it. Made up: pitwall couldn't write it.");
    expect(announced(dialog)).toBe("Couldn't upload notes.txt. Made up: pitwall couldn't write it.");
    const retry = within(row!).getByRole('button', { name: 'Try again' });
    expect(within(row!).getByRole('button', { name: 'Remove notes.txt' })).toBeTruthy();

    fireEvent.click(retry);
    await settle();
    expect(server.uploads).toHaveLength(2);
    expect(states(dialog)).toEqual([['notes.txt', 'uploaded']]);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Remove notes.txt' }));
  });

  it('a network failure or a 5xx without a reason gives the status, or none', async () => {
    const server = fakeServer({ auto: (_upload, index) => (index === 0 ? new Response('', { status: 502 }) : (null as unknown as Response)) });
    const { dialog } = renderDialog(server.fetch);
    await choose(dialog, [file('a.txt', 'text/plain')]);
    await settle();
    expect(rows(dialog)[0]!.querySelector('.attachment-problem')?.textContent).toBe("Couldn't upload it (HTTP 502).");
  });

  it('without an API, says files cannot be uploaded from here', async () => {
    const { dialog } = renderDialog(null);
    await choose(dialog, [file('a.txt', 'text/plain')]);
    expect(rows(dialog)[0]!.querySelector('.attachment-problem')?.textContent).toBe("Couldn't upload it. Files can't be uploaded from here.");
  });

  it('Remove asks the server to remove a file it has kept, and not one still on its way', async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    await choose(dialog, [file('a.txt', 'text/plain'), file('b.txt', 'text/plain')]);
    await act(async () => server.uploads[0]!.answer(server.kept(server.uploads[0]!)));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove a.txt' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove b.txt' }));
    await settle();
    expect(server.deletes).toEqual([attachmentPath('id-1')]);
    expect(server.uploads[1]!.signal?.aborted).toBe(true);
  });

  it('closing the dialog without starting aborts the uploads still running, and asks the server to remove the kept ones', async () => {
    const server = fakeServer();
    const { dialog, unmount } = renderDialog(server.fetch);
    await choose(dialog, [file('a.txt', 'text/plain'), file('b.txt', 'text/plain'), file('c.txt', 'text/plain')]);
    await act(async () => server.uploads[1]!.answer(server.kept(server.uploads[1]!)));
    unmount();
    await settle();
    expect(server.uploads[0]!.signal?.aborted).toBe(true);
    expect(server.uploads[2]!.signal?.aborted).toBe(true);
    expect(server.deletes).toEqual([attachmentPath('id-1')]);
  });

  it("refuses an empty file before sending it", async () => {
    const server = fakeServer();
    const { dialog } = renderDialog(server.fetch);
    await choose(dialog, [new File([], 'empty.txt', { type: 'text/plain' })]);
    expect(rows(dialog)[0]!.querySelector('.attachment-problem')?.textContent).toBe("Couldn't attach it. It's empty.");
    expect(server.uploads).toEqual([]);
  });

  it("a 503, a pitwall that keeps no attachments here, says the session can still start without them, and doesn't hold it up", async () => {
    const server = fakeServer({ auto: () => json(503, { ok: false, error: "Made up: this pitwall doesn't keep attachments." }) });
    const { dialog } = renderDialog(server.fetch);
    await choose(dialog, [file('a.txt', 'text/plain')]);
    await settle();
    const [row] = rows(dialog);
    expect(row!.dataset.state).toBe('refused');
    expect(row!.querySelector('.attachment-problem')?.textContent).toBe(
      "Couldn't attach it. Files can't be attached on this machine. You can still start the session without them. Made up: this pitwall doesn't keep attachments.",
    );
    expect(within(row!).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(start(dialog).getAttribute('aria-disabled')).toBeNull();
  });
});

describe('New session: starting with files', () => {
  it("is off while a file uploads, saying why; ⌘ Enter shows the problem and puts focus on the list", async () => {
    const server = fakeServer();
    const { dialog, onStarted } = renderDialog(server.fetch);
    fireEvent.change(prompt(dialog), { target: { value: 'Look at these.' } });
    await choose(dialog, [file('a.txt', 'text/plain')]);

    expect(start(dialog).getAttribute('aria-disabled')).toBe('true');
    expect(describedText(start(dialog))).toBe('Wait for the file to upload, or remove it.');
    fireEvent.click(start(dialog));
    await settle();
    expect(server.spawns).toEqual([]);

    fireEvent.keyDown(prompt(dialog), { key: 'Enter', metaKey: true });
    await settle();
    expect(server.spawns).toEqual([]);
    expect(document.activeElement).toBe(list(dialog));
    expect(describedText(list(dialog)!)).toBe('Wait for the file to upload, or remove it.');

    await act(async () => server.uploads[0]!.answer(server.kept(server.uploads[0]!)));
    expect(start(dialog).getAttribute('aria-disabled')).toBeNull();
    expect(dialog.querySelectorAll('.field-problem')).toHaveLength(0);
    fireEvent.click(start(dialog));
    await settle();
    expect(server.spawns).toEqual([{ cwd: REPO, prompt: 'Look at these.', attachments: ['id-1'] }]);
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it('closing after the session started leaves its files to it', async () => {
    const server = fakeServer({ auto: (upload) => server.kept(upload) });
    const { dialog, unmount } = renderDialog(server.fetch);
    fireEvent.change(prompt(dialog), { target: { value: 'Look at this.' } });
    await choose(dialog, [file('a.txt', 'text/plain')]);
    await settle();
    fireEvent.click(start(dialog));
    await settle();
    expect(server.spawns).toHaveLength(1);
    unmount();
    await settle();
    expect(server.deletes).toEqual([]);
  });

  it('is off while a file has failed, until it is removed', async () => {
    const server = fakeServer({ auto: (upload, index) => (index === 1 ? json(500, { ok: false, error: 'Made up.' }) : server.kept(upload)) });
    const { dialog } = renderDialog(server.fetch);
    fireEvent.change(prompt(dialog), { target: { value: 'Look at these.' } });
    await choose(dialog, [file('a.txt', 'text/plain'), file('b.txt', 'text/plain'), file('c.txt', 'text/plain')]);
    await settle();
    await settle();
    expect(states(dialog).map(([, state]) => state)).toEqual(['uploaded', 'failed', 'uploaded']);
    expect(describedText(start(dialog))).toBe("A file didn't upload. Try it again, or remove it.");
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove b.txt' }));
    await settle();
    expect(start(dialog).getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(start(dialog));
    await settle();
    // In the list's order.
    expect(server.spawns).toEqual([{ cwd: REPO, prompt: 'Look at these.', attachments: ['id-1', 'id-2'] }]);
  });

  it('while starting, Remove, Try again and Attach files are aria-disabled, and a drop or a paste attaches nothing', async () => {
    let answerSpawn: (response: Response) => void = () => {};
    const server = fakeServer({ auto: (upload) => server.kept(upload) });
    const fetch = vi.fn<FetchLike>((url, init) => (url === SPAWN_PATH ? new Promise((resolve) => (answerSpawn = resolve)) : server.fetch(url, init)));
    const { dialog } = renderDialog(fetch);
    fireEvent.change(prompt(dialog), { target: { value: 'Look at this.' } });
    await choose(dialog, [file('a.txt', 'text/plain')]);
    await settle();
    fireEvent.click(start(dialog));
    await settle();

    expect(attachButton(dialog).getAttribute('aria-disabled')).toBe('true');
    const remove = within(dialog).getByRole('button', { name: 'Remove a.txt' });
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(remove);
    await drop(dialog, [file('b.txt', 'text/plain')]);
    expect(dialog.querySelector('.prompt-drop-target')).toBeNull();
    fireEvent.paste(prompt(dialog), { clipboardData: { files: [file('image.png', 'image/png')], items: [], getData: () => '' } });
    await settle();
    expect(states(dialog)).toEqual([['a.txt', 'uploaded']]);
    await act(async () => answerSpawn(json(201, { ok: true, shortId: 'c0ffee12', name: 'pitwall-test-spawn' })));
  });

  it('keeps the dialog open on a click on the backdrop once a file is added', async () => {
    const { dialog, onClose } = renderDialog();
    await choose(dialog, [file('a.txt', 'text/plain')]);
    const backdrop = document.querySelector('.dialog-backdrop')!;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});
