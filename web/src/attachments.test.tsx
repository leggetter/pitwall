// New session's attachments (W82): the checks, the wording, the sizes, the paste rule and the upload
// call, against ATTACHMENTS_PATH as the contract has it (src/shared/protocol.ts). Made-up files only.
import { describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_MAX_PER_SESSION, ATTACHMENTS_PATH, attachmentPath } from '../../src/shared/protocol.js';
import { createApiClient, type FetchLike } from './api.js';
import {
  ATTACH_TEXT,
  attachmentsProblem,
  attachmentType,
  cleanName,
  fileProblem,
  formatSize,
  pastedFiles,
  problemLead,
  problemSentence,
  uniqueName,
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
    ['', 'notes.TXT', 'text/plain'],
  ])('a file typed %j and named %s uploads as %s', (type, name, expected) => {
    expect(attachmentType({ name, type })).toBe(expected);
  });

  // Code, configuration and logs, whatever type the browser gives them: the server checks they're UTF-8 with no NUL.
  it.each([
    ['text/x-python', 'main.py'],
    ['', 'config.yaml'],
    ['application/x-yaml', 'compose.yml'],
    ['', 'app.log'],
    ['video/mp2t', 'index.ts'],
    ['video/mp2t', 'vite.config.mts'],
    ['text/html', 'page.html'],
    ['', 'main.go'],
    ['', 'Makefile'],
    ['', '.env'],
    ['application/octet-stream', 'Cargo.lock'],
    ['text/javascript', 'app.js'],
    ['application/javascript', 'legacy.js'],
    ['application/x-sh', 'build.sh'],
    ['application/toml', 'pyproject.toml'],
    ['application/xml', 'pom.xml'],
    ['application/ld+json', 'schema.jsonld'],
    ['application/sql', 'seed.sql'],
    ['text/x-c', 'main.c'],
  ])('a text file typed %j and named %s uploads as text/plain', (type, name) => {
    expect(attachmentType({ name, type })).toBe('text/plain');
    expect(fileProblem({ name, type, size: 10 }, 0)).toBeUndefined();
  });

  it.each([
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx'],
    ['image/svg+xml', 'logo.svg'],
    ['image/heic', 'shot.heic'],
    ['', 'shot.HEIC'],
    ['application/zip', 'site.zip'],
    ['video/mp4', 'demo.mp4'],
    ['video/mp4', 'demo'],
    ['', 'voice.m4a'],
    ['audio/mpeg', 'song'],
    ['application/x-msdownload', 'setup.exe'],
    ['', 'App.dmg'],
    ['font/woff2', 'inter.woff2'],
    ['application/x-sqlite3', 'local.db'],
  ])('a file typed %j and named %s is refused, naming the images pitwall takes', (type, name) => {
    expect(attachmentType({ name, type })).toBeUndefined();
    expect(fileProblem({ name, type, size: 10 }, 0)).toBe('Only PNG, JPEG, GIF and WebP images, PDFs and text files can be attached.');
  });

  it('refuses, in this order, the type, an empty file, the size, a name the server refuses, a blank one, a long one, then one past the limit', () => {
    const ok = { name: 'shot.png', type: 'image/png', size: 1024 };
    expect(fileProblem(ok, 0)).toBeUndefined();
    expect(fileProblem({ ...ok, size: 0 }, 0)).toBe("It's empty.");
    expect(fileProblem({ ...ok, size: 1 }, 0)).toBeUndefined();
    expect(fileProblem({ ...ok, size: ATTACHMENT_MAX_BYTES }, 0)).toBeUndefined();
    expect(fileProblem({ ...ok, size: ATTACHMENT_MAX_BYTES + 1 }, 0)).toBe("It's 10.1 MB, over the 10 MB limit.");
    expect(fileProblem({ ...ok, name: `${'a'.repeat(197)}.png` }, 0)).toBe(ATTACH_TEXT.long);
    expect(fileProblem({ ...ok, name: `${'a'.repeat(196)}.png` }, 0)).toBeUndefined();
    for (const name of ['a/b.png', 'a\\b.png', 'a\nb.png', 'a\u0007b.png', 'a\u202eb.png', 'a\u2066b.png', 'a\u200fb.png']) {
      expect(fileProblem({ ...ok, name }, 0), JSON.stringify(name)).toBe(ATTACH_TEXT.name);
    }
    // Counted as the server counts it, after NFC normalisation: 100 é's written as e and a combining accent are 100 characters.
    const decomposed = `${'e\u0301'.repeat(100)}.txt`;
    expect(decomposed.length).toBe(204);
    expect(fileProblem({ ...ok, name: decomposed }, 0)).toBeUndefined();
    expect(fileProblem({ ...ok, name: `  ${'a'.repeat(196)}.png  ` }, 0)).toBeUndefined();
    expect(fileProblem({ ...ok, name: '   ' }, 0)).toBe('Its name is blank. Rename the file, then attach it again.');
    expect(fileProblem({ ...ok, name: '\u3000' }, 0)).toBe(ATTACH_TEXT.blank);
    // macOS screenshots' narrow no-break space is a space, not a control.
    expect(fileProblem({ ...ok, name: 'Screenshot 2026-10-28 at 10.15.32 AM.png' }, 0)).toBeUndefined();
    expect(fileProblem(ok, ATTACHMENTS_MAX_PER_SESSION - 1)).toBeUndefined();
    expect(fileProblem(ok, ATTACHMENTS_MAX_PER_SESSION)).toBe('A first prompt takes at most 10 files.');
    expect(fileProblem({ name: 'big.docx', type: '', size: ATTACHMENT_MAX_BYTES * 2 }, ATTACHMENTS_MAX_PER_SESSION)).toBe(ATTACH_TEXT.type);
  });
});

describe('the characters that show as nothing (W87)', () => {
  it('are dropped as the server drops them, before a name is counted or found blank', () => {
    expect(cleanName(' photo\u200b.png ')).toBe('photo.png');
    expect(cleanName('report\u{e0041}\u{e007f}\u3164\ufe0f.pdf')).toBe('report.pdf');
    expect(cleanName('cafe\u0301\u00ad.txt')).toBe('caf\u00e9.txt');
    const ok = { name: 'shot.png', type: 'image/png', size: 1024 };
    expect(fileProblem({ ...ok, name: '\u200b\u3164\u{e0020}' }, 0)).toBe(ATTACH_TEXT.blank);
    // 196 letters, the extension and ten zero-width spaces: 200 once they're dropped, as the server counts it.
    expect(fileProblem({ ...ok, name: `${'a'.repeat(196)}${'\u200b'.repeat(10)}.png` }, 0)).toBeUndefined();
  });
});

describe('a name already listed', () => {
  it('is numbered before its extension, with the first number free', () => {
    expect(uniqueName('image.png', new Set())).toBe('image.png');
    expect(uniqueName('image.png', new Set(['image.png']))).toBe('image (2).png');
    expect(uniqueName('image.png', new Set(['image.png', 'image (2).png']))).toBe('image (3).png');
    expect(uniqueName('Makefile', new Set(['Makefile']))).toBe('Makefile (2)');
    expect(uniqueName('.env', new Set(['.env']))).toBe('.env (2)');
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
    expect(problemSentence({ verb: 'attach', reason: ATTACH_TEXT.type }, 'report.docx')).toBe(
      "Couldn't attach report.docx. Only PNG, JPEG, GIF and WebP images, PDFs and text files can be attached.",
    );
    expect(ATTACH_TEXT.hint).toBe('Or drop or paste them into the prompt: images, PDFs and text files, code included, up to 10 MB each.');
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
  const clipboard = (files: File[], text = '', items?: Array<{ kind: string; getAsFile: () => File | null }>, types: string[] = []) =>
    ({ files, items: items ?? [], types, getData: (type: string) => (type === 'text/plain' ? text : '') }) as unknown as DataTransfer;

  it('attaches the files it carries, alone or with their names as text, as a copied file has', () => {
    expect(pastedFiles(clipboard([image]))).toEqual([image]);
    expect(pastedFiles(clipboard([image], 'image.png'))).toEqual([image]);
    expect(pastedFiles(clipboard([image], '/Users/example/Desktop/image.png\n'))).toEqual([image]);
    expect(pastedFiles(clipboard([image], 'C:\\Users\\example\\image.png'))).toEqual([image]);
  });

  it("attaches an image whose text is its URL, as a browser's Copy Image may put", () => {
    expect(pastedFiles(clipboard([image], 'https://example.com/images/cat.jpg'))).toEqual([image]);
    expect(pastedFiles(clipboard([image], '  data:image/png;base64,iVBORw0KGgo=\n', [], ['text/html', 'text/plain', 'Files']))).toEqual([image]);
    // Two URLs, or a URL in a sentence, are text.
    expect(pastedFiles(clipboard([image], 'https://example.com/a.png https://example.com/b.png'))).toBeUndefined();
    expect(pastedFiles(clipboard([image], 'see https://example.com/a.png'))).toBeUndefined();
  });

  it("attaches the image Word copies alone, whose text is an object replacement character", () => {
    expect(pastedFiles(clipboard([image], '\ufffc', [], ['text/html', 'text/rtf', 'text/plain', 'Files']))).toEqual([image]);
  });

  it('pastes whitespace as text when it comes with rich text, as a blank spreadsheet cell does, and attaches when nothing else came', () => {
    expect(pastedFiles(clipboard([image], '\r\n', [], ['text/plain', 'text/html', 'Files']))).toBeUndefined();
    expect(pastedFiles(clipboard([image], ' ', [], ['text/plain', 'text/rtf', 'Files']))).toBeUndefined();
    expect(pastedFiles(clipboard([image], '\n', [], ['text/plain', 'Files']))).toEqual([image]);
  });

  it("doesn't take a sentence that ends with a file's name for its name", () => {
    expect(pastedFiles(clipboard([image], 'please look at image.png'))).toBeUndefined();
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

  it("calls a 503 unavailable: this pitwall keeps no attachments, which trying again won't change", async () => {
    expect(await send(async () => json(503, { ok: false, error: "This pitwall doesn't keep attachments." }))).toEqual({ kind: 'unavailable', error: "This pitwall doesn't keep attachments." });
    expect(await send(async () => new Response('', { status: 503 }))).toEqual({ kind: 'unavailable' });
  });

  it('calls anything else a failure, which trying again may fix', async () => {
    // An upload that stalled: the server kept nothing.
    expect(await send(async () => json(408, { ok: false, error: 'Made up: the upload stalled.' }))).toEqual({ kind: 'failed', error: 'Made up: the upload stalled.' });
    expect(await send(async () => json(429, { ok: false, error: 'Made up: 30 unused uploads.' }))).toEqual({ kind: 'failed', error: 'Made up: 30 unused uploads.' });
    expect(await send(async () => new Response('', { status: 500 }))).toEqual({ kind: 'failed', status: 500 });
    expect(await send(async () => json(500, { ok: false, error: "Made up: pitwall couldn't write it." }))).toEqual({ kind: 'failed', error: "Made up: pitwall couldn't write it." });
    expect(await send(async () => json(413, { ok: false }))).toEqual({ kind: 'refused', status: 413 });
    expect(await send(async () => Promise.reject(new TypeError('Failed to fetch')))).toEqual({ kind: 'failed' });
  });

  it("doesn't take an answer that doesn't say which file it kept", async () => {
    for (const attachment of [undefined, { id: '', name: 'a', type: 'text/plain', size: 1 }, { id: ID, name: 'a', type: 'text/html', size: 1 }, { id: ID, name: 'a', type: 'text/plain', size: -1 }]) {
      expect(await send(async () => json(201, { ok: true, attachment }))).toEqual({ kind: 'failed', error: ATTACH_TEXT.unclear });
    }
  });

  it("removes an unused upload with DELETE attachmentPath(), the apiKey and no body, and takes a 204 as done", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    expect(await createApiClient({ apiKey: API_KEY, fetch }).delete(attachmentPath(ID))).toEqual({ kind: 'ok', status: 204, body: undefined });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ATTACHMENTS_PATH}/${ID}`);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: `Bearer ${API_KEY}` });
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
