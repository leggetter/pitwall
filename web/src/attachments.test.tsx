// New session's attachments (W82): the checks, the wording, the sizes, the paste rule and the upload
// call, against ATTACHMENTS_PATH as the contract has it (src/shared/protocol.ts). Made-up files only.
import { describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, ATTACHMENTS_MAX_PER_SESSION, ATTACHMENTS_PATH } from '../../src/shared/protocol.js';
import { createApiClient, type FetchLike } from './api.js';
import {
  ACCEPT,
  ATTACH_TEXT,
  attachmentsProblem,
  attachmentType,
  fileProblem,
  formatSize,
  pastedFiles,
  problemLead,
  problemSentence,
  uploadAttachment,
} from './attachments.js';
import { fileNameParts } from './format.js';

const API_KEY = 'k'.repeat(43);
const ID = '3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('which files it takes', () => {
  it.each([
    ['image/png', 'a.png', 'image/png'],
    ['image/jpeg', 'a.jpg', 'image/jpeg'],
    ['image/jpg', 'a.jpg', 'image/jpeg'],
    ['text/x-markdown', 'a.md', 'text/markdown'],
    ['', 'notes.md', 'text/markdown'],
    ['', 'NOTES.MARKDOWN', 'text/markdown'],
    ['application/vnd.ms-excel', 'export.csv', 'text/csv'],
    ['text/plain;charset=utf-8', 'a.txt', 'text/plain'],
    ['', 'data.json', 'application/json'],
  ])('a file typed %j and named %s uploads as %s', (type, name, expected) => {
    expect(attachmentType({ name, type })).toBe(expected);
  });

  it.each([
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx'],
    ['image/svg+xml', 'logo.svg'],
    ['application/zip', 'site.zip'],
    ['', 'Makefile'],
    ['', '.png'],
  ])('a file typed %j and named %s is refused', (type, name) => {
    expect(attachmentType({ name, type })).toBeUndefined();
    expect(fileProblem({ name, type, size: 10 }, 0)).toBe(ATTACH_TEXT.type);
  });

  it("offers the picker every type and the extensions that stand for them", () => {
    const accepted = ACCEPT.split(',');
    for (const type of ATTACHMENT_TYPES) expect(accepted).toContain(type);
    for (const extension of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.md', '.csv', '.json']) expect(accepted).toContain(extension);
  });

  it('refuses, in this order, the type, the size, a long name, a name the server refuses, then one past the limit', () => {
    const ok = { name: 'shot.png', type: 'image/png', size: 1024 };
    expect(fileProblem(ok, 0)).toBeUndefined();
    expect(fileProblem({ ...ok, size: ATTACHMENT_MAX_BYTES }, 0)).toBeUndefined();
    expect(fileProblem({ ...ok, size: ATTACHMENT_MAX_BYTES + 1 }, 0)).toBe("It's 10.1 MB, over the 10 MB limit.");
    expect(fileProblem({ ...ok, name: `${'a'.repeat(197)}.png` }, 0)).toBe(ATTACH_TEXT.long);
    expect(fileProblem({ ...ok, name: `${'a'.repeat(196)}.png` }, 0)).toBeUndefined();
    for (const name of ['a/b.png', 'a\\b.png', 'a\nb.png', 'a\u0007b.png', 'a‮b.png', 'a⁦b.png', 'a‏b.png']) {
      expect(fileProblem({ ...ok, name }, 0), JSON.stringify(name)).toBe(ATTACH_TEXT.name);
    }
    // macOS screenshots' narrow no-break space is a space, not a control.
    expect(fileProblem({ ...ok, name: 'Screenshot 2026-10-28 at 10.15.32 AM.png' }, 0)).toBeUndefined();
    expect(fileProblem(ok, ATTACHMENTS_MAX_PER_SESSION - 1)).toBeUndefined();
    expect(fileProblem(ok, ATTACHMENTS_MAX_PER_SESSION)).toBe('A first prompt takes at most 10 files.');
    expect(fileProblem({ name: 'big.docx', type: '', size: ATTACHMENT_MAX_BYTES * 2 }, ATTACHMENTS_MAX_PER_SESSION)).toBe(ATTACH_TEXT.type);
  });
});

describe('sizes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [4300, '4.2 KB'],
    [250_000, '244 KB'],
    [1_572_864, '1.5 MB'],
    [ATTACHMENT_MAX_BYTES, '10 MB'],
  ])('%d bytes read %s', (bytes, shown) => {
    expect(formatSize(bytes)).toBe(shown);
  });

  it('rounds up for a refusal, so a byte over the limit never reads as the limit', () => {
    expect(formatSize(ATTACHMENT_MAX_BYTES + 1, { up: true })).toBe('10.1 MB');
    expect(formatSize(ATTACHMENT_MAX_BYTES * 3, { up: true })).toBe('30 MB');
  });
});

describe("a file's name, cut in the middle", () => {
  it('keeps its extension and the 6 characters before it', () => {
    expect(fileNameParts('Screenshot 2026-10-28 at 10.15.32.png')).toEqual({ start: 'Screenshot 2026-10-28 at 10', end: '.15.32.png' });
    expect(fileNameParts('a-very-long-name-without-an-extension')).toEqual({ start: 'a-very-long-name-without-an-ext', end: 'ension' });
  });

  it('leaves a short name whole, and never cuts inside a character', () => {
    expect(fileNameParts('notes.txt')).toEqual({ start: 'notes.txt', end: '' });
    expect(fileNameParts('😀😀😀😀😀😀😀.md')).toEqual({ start: '😀', end: '😀😀😀😀😀😀.md' });
  });
});

describe('the wording', () => {
  it('leads with what happened, then why', () => {
    expect(problemLead({ verb: 'attach', reason: ATTACH_TEXT.type }, 'it')).toBe("Couldn't attach it.");
    expect(problemLead({ verb: 'upload', status: 500 }, 'it')).toBe("Couldn't upload it (HTTP 500).");
    expect(problemLead({ verb: 'upload', detail: 'Made up: full.', status: 503 }, 'it')).toBe("Couldn't upload it.");
    expect(problemSentence({ verb: 'attach', reason: ATTACH_TEXT.type }, 'report.docx')).toBe("Couldn't attach report.docx. Only images, PDFs and text files can be attached.");
    expect(ATTACH_TEXT.hint).toBe('Or drop or paste them into the prompt: images, PDFs and text files, up to 10 MB each.');
  });

  it("says why Start session is off: a failed file first, since one uploading finishes by itself", () => {
    expect(attachmentsProblem(0, 0)).toBeUndefined();
    expect(attachmentsProblem(1, 0)).toBe('Wait for the file to upload, or remove it.');
    expect(attachmentsProblem(3, 0)).toBe('Wait for the 3 files to upload, or remove them.');
    expect(attachmentsProblem(2, 1)).toBe("A file didn't upload. Try it again, or remove it.");
    expect(attachmentsProblem(0, 2)).toBe("2 files didn't upload. Try them again, or remove them.");
  });
});

describe('a paste', () => {
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
  const clipboard = (files: File[], text = '', items?: Array<{ kind: string; getAsFile: () => File | null }>) =>
    ({ files, items: items ?? [], getData: (type: string) => (type === 'text/plain' ? text : '') }) as unknown as DataTransfer;

  it('attaches the files it carries, alone or with their names as text, as a copied file has', () => {
    expect(pastedFiles(clipboard([image]))).toEqual([image]);
    expect(pastedFiles(clipboard([image], 'image.png'))).toEqual([image]);
    expect(pastedFiles(clipboard([image], '/Users/example/Desktop/image.png\n'))).toEqual([image]);
  });

  it('pastes text as text, even with files, as a copy from a spreadsheet carries a picture of its cells', () => {
    expect(pastedFiles(clipboard([], 'plain text'))).toBeUndefined();
    expect(pastedFiles(clipboard([image], 'Region\tTotal\nNorth\t12'))).toBeUndefined();
    expect(pastedFiles(null)).toBeUndefined();
  });

  it('finds a file that a browser put in items alone', () => {
    expect(pastedFiles(clipboard([], '', [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => image }]))).toEqual([image]);
  });
});

describe('the upload', () => {
  const file = new File(['# Notes\n'], 'Release notes, draft 2.md', { type: 'text/markdown' });
  const send = (fetch: FetchLike, signal = new AbortController().signal) => uploadAttachment(createApiClient({ apiKey: API_KEY, fetch }), file, file.name, 'text/markdown', signal);

  it("POSTs the bytes to ATTACHMENTS_PATH as the file's type, its name URL-encoded in X-Pitwall-Filename, with the apiKey", async () => {
    const fetch = vi.fn<FetchLike>(async () => json(201, { ok: true, attachment: { id: ID, name: 'Release notes, draft 2.md', type: 'text/markdown', size: 8 } }));
    expect(await send(fetch)).toEqual({ kind: 'uploaded', attachment: { id: ID, name: 'Release notes, draft 2.md', type: 'text/markdown', size: 8 } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(ATTACHMENTS_PATH);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect(init.headers).toEqual({ Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'text/markdown', 'X-Pitwall-Filename': 'Release%20notes%2C%20draft%202.md' });
  });

  it('keeps the key and the type its own, whatever headers a route asks for', async () => {
    const fetch = vi.fn<FetchLike>(async () => json(201, {}));
    await createApiClient({ apiKey: API_KEY, fetch }).upload(ATTACHMENTS_PATH, { body: file, contentType: 'text/plain', headers: { authorization: 'Bearer other', 'CONTENT-TYPE': 'text/html', 'X-Pitwall-Filename': 'a' } });
    expect(fetch.mock.calls[0]![1].headers).toEqual({ Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'text/plain', 'X-Pitwall-Filename': 'a' });
  });

  it('sends it again with the next key after a 401, as post() does', async () => {
    const answers = [new Response(null, { status: 401 }), json(201, { ok: true, attachment: { id: ID, name: 'a.md', type: 'text/markdown', size: 8 } })];
    const fetch = vi.fn<FetchLike>(async () => answers.shift()!);
    const api = createApiClient({ apiKey: API_KEY, fetch });
    api.keys.onStale(() => api.keys.set('n'.repeat(43)));
    const result = await api.upload(ATTACHMENTS_PATH, { body: file, contentType: 'text/markdown' });
    expect(result.kind).toBe('ok');
    expect(fetch.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization)).toEqual([`Bearer ${API_KEY}`, `Bearer ${'n'.repeat(43)}`]);
    expect(fetch.mock.calls[1]![1].body).toBe(file);
  });

  it.each([
    [400, 'Made up: a name with a path separator.'],
    [413, 'Made up: over 10 MiB.'],
    [415, "Made up: its first bytes aren't a PNG's."],
  ])("calls a %d a refusal, with the server's reason", async (status, error) => {
    expect(await send(async () => json(status, { ok: false, error }))).toEqual({ kind: 'refused', error });
  });

  it('calls anything else a failure, which trying again may fix', async () => {
    expect(await send(async () => json(429, { ok: false, error: 'Made up: 30 unused uploads.' }))).toEqual({ kind: 'failed', error: 'Made up: 30 unused uploads.' });
    expect(await send(async () => new Response('', { status: 500 }))).toEqual({ kind: 'failed', status: 500 });
    expect(await send(async () => json(413, { ok: false }))).toEqual({ kind: 'refused', status: 413 });
    expect(await send(async () => Promise.reject(new TypeError('Failed to fetch')))).toEqual({ kind: 'failed' });
  });

  it("doesn't take an answer that doesn't say which file it kept", async () => {
    for (const attachment of [undefined, { id: '', name: 'a', type: 'text/plain', size: 1 }, { id: ID, name: 'a', type: 'text/html', size: 1 }, { id: ID, name: 'a', type: 'text/plain', size: -1 }]) {
      expect(await send(async () => json(201, { ok: true, attachment }))).toEqual({ kind: 'failed', error: ATTACH_TEXT.unclear });
    }
  });

  it('says it was aborted, whatever the fetch did', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<FetchLike>(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    expect(await send(fetch, controller.signal)).toEqual({ kind: 'aborted' });
  });
});
