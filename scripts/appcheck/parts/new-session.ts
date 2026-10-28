// The New session dialog (docs/design-system.md, 4: Dialogs; W12): from the header or `n`, with the
// roots' directories; Start session asks for a first prompt; a start says so in a toast, and the
// session's view opens once the index lists it, as the fake server does a moment later; "Another
// directory under a root…" reveals the directory autocomplete (W70), which narrows as you type, takes
// an option from the keyboard, and starts a session in it; files for the first prompt (W82), through
// Attach files, a drop and a paste, refused ones, the server's refusal and its 503, Remove, which
// asks the server to remove a kept one, an upload that's slow, one that fails, a start that sends
// their ids, and a close that asks the server to remove them; Cancel closes it. W63's switch to the new
// session's group and tab is its own part, new-session-selected.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { API_SERVER, CODE, DEMO_APP, DEMO_APP_WEB } from '../fixtures.js';
import type { Case, Part } from '../runner.js';
import { FAIL_UPLOAD, SLOW_UPLOAD, UNAVAILABLE_UPLOAD } from '../server.js';
import { chooseOption, DIALOG, dialogBox, dialogButton, dialogName, focused, headerButton, openDialog, toasts, viewName } from './_dom.js';

const q = JSON.stringify;
const field = (label: string) => `[...(${DIALOG}?.querySelectorAll('input, select, textarea') ?? [])].find((el) => el.labels?.[0]?.textContent.trim().startsWith(${q(label)}))`;
const DIRECTORY = field('Directory');
const PROMPT = field('First prompt');
const FIRST_PROMPT = 'A made-up first prompt for the app check.';
/** The select's "Another directory under a root…" choice. */
const OTHER = '\u0000other';
const COMBOBOX = `${DIALOG}?.querySelector('[role="combobox"]')`;
/** The options the list shows, as they read. */
const OPTIONS = `[...(${DIALOG}?.querySelectorAll('[role="listbox"] [role="option"]') ?? [])].filter((el) => !el.closest('[hidden]')).map((el) => el.textContent)`;
const EXPANDED = `${COMBOBOX}?.getAttribute('aria-expanded')`;
const ACTIVE = `document.getElementById(${COMBOBOX}?.getAttribute('aria-activedescendant') ?? '')`;
/** Each request for the directory list, as the fake server recorded it. */
const listRequests = (requests: string[]) => requests.filter((request) => request.startsWith('GET /api/directories '));

/** The 10 MiB limit (ATTACHMENT_MAX_BYTES). */
const MAX_BYTES = 10 * 1024 * 1024;
/** The files' rows, and each one's name and state, as listed. */
const ROWS = `[...(${DIALOG}?.querySelectorAll('.attachment') ?? [])]`;
const LISTED = `${ROWS}.map((row) => [row.querySelector('.attachment-name').textContent, row.dataset.state])`;
const problemOf = (name: string) => `${ROWS}.find((row) => row.querySelector('.attachment-name').textContent === ${q(name)})?.querySelector('.attachment-problem')?.textContent`;
/** What describes an element, its aria-describedby's text, joined. */
const describedText = (element: string) => `((${element})?.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' | ')`;
const START_OFF = `${dialogButton('Start session')}?.getAttribute('aria-disabled') === 'true'`;
const ROW_COUNT = `${ROWS}.length`;
const settledRows = (count: number) => `${ROWS}.length === ${count} && ${ROWS}.every((row) => row.dataset.state !== 'waiting' && row.dataset.state !== 'uploading')`;

/** A file to hand the page: its bytes as base64, or text, or a size of zeros. */
type MadeUpFile = { name: string; type: string; base64?: string; text?: string; size?: number };

/** A DataTransfer holding `files`, made in the page. */
const transfer = (files: MadeUpFile[]) => `(() => {
  const transfer = new DataTransfer();
  for (const f of ${q(files)}) {
    const bytes = f.base64 !== undefined ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) : f.text !== undefined ? new TextEncoder().encode(f.text) : new Uint8Array(f.size ?? 0);
    transfer.items.add(new File([bytes], f.name, { type: f.type }));
  }
  return transfer;
})()`;
/** Drags `files` onto the first prompt and holds them there, as from the Finder: dragenter, then dragover. */
const dragOnPrompt = (files: MadeUpFile[]) => `(() => {
  const transfer = ${transfer(files)};
  window.__appcheckDrag = transfer;
  for (const type of ['dragenter', 'dragover']) ${PROMPT}.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
  return [...transfer.types];
})()`;
/** Drops what dragOnPrompt holds; true when the page took the drop. */
const DROP_ON_PROMPT = `!${PROMPT}.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__appcheckDrag, bubbles: true, cancelable: true }))`;
/** Pastes `files`, and `text` with them, into the first prompt; true when the page took the paste. */
const pasteIntoPrompt = (files: MadeUpFile[], text?: string) => `(() => {
  const transfer = ${transfer(files)};
  ${text === undefined ? '' : `transfer.setData('text/plain', ${q(text)});`}
  return !${PROMPT}.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
})()`;

async function dropOnPrompt(t: Case, files: MadeUpFile[]): Promise<void> {
  await t.page.evaluate(dragOnPrompt(files));
  await t.page.evaluate(DROP_ON_PROMPT);
  await t.page.settle();
}

/** A made-up PNG, its left half blue and its right half red, so its thumbnail can be seen. */
function madeUpPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels.set(x < width / 2 ? [0x00, 0x44, 0xcc] : [0xe0, 0x7b, 0x72], y * stride + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const PNG = madeUpPng(48, 32);
const PICKED = [
  { name: 'pitwall-test-diagram.png', type: 'image/png', bytes: PNG },
  { name: 'pitwall-test-notes.txt', type: 'text/plain', bytes: Buffer.from('Made-up notes for the app check.\n') },
];

/** Writes the picker's files into the run's output folder, once, and returns their absolute paths. */
async function pickerFiles(t: Case): Promise<string[]> {
  const dir = resolve(join(t.out, 'files', 'new-session'));
  await mkdir(dir, { recursive: true });
  return Promise.all(
    PICKED.map(async ({ name, bytes }) => {
      const path = join(dir, name);
      await writeFile(path, bytes);
      return path;
    }),
  );
}

/** Chooses files in Attach files' native input, as the system's picker would (DOM.setFileInputFiles). */
async function pick(t: Case, paths: string[]): Promise<void> {
  const { result } = await t.page.send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: `${DIALOG}?.querySelector('input[type="file"]')` });
  if (!result.objectId) throw new Error("the dialog has no file input for Attach files");
  await t.page.send('DOM.setFileInputFiles', { files: paths, objectId: result.objectId });
  await t.page.settle();
}

const part: Part = {
  name: 'new-session',
  title: 'The New session dialog: its fields, a missing prompt, a start that opens the session once listed, and Cancel',
  async run(t) {
    const { page, server } = t;
    const name = `pitwall-test-appcheck-${t.at}`;

    await t.step('opens from the header, with the roots and their directories', async () => {
      await t.fresh({ search: '?view=all' });
      await openDialog(t, 'New session');
      const labels = await page.evaluate<string[]>(`[...${DIALOG}.querySelectorAll('label.field-label')].map((l) => l.textContent.trim())`);
      t.expectEqual(labels, ['Directory', 'Name optional', 'Model optional', 'First prompt'], 'its fields');
      const values = await page.evaluate<string[]>(`[...${DIRECTORY}.options].map((o) => o.value)`);
      for (const dir of [CODE, API_SERVER, DEMO_APP]) t.expect(values.includes(dir), `it offers ${dir}`, values);
      t.expect(await page.evaluate(`document.activeElement === ${DIRECTORY}`), 'focus is on Directory, its first field', await page.evaluate(focused));
      t.expect(await page.evaluate(`!!${dialogButton('Start session')} && !!${dialogButton('Cancel')}`), 'Start session and Cancel');
      const card = await page.evaluate<{ left: number; right: number; top: number; bottom: number }>(dialogBox);
      t.expect(card.left >= 15.5 && card.right <= t.viewport.width - 15.5 && card.top >= 0 && card.bottom <= t.viewport.height, 'inside the window', card);
      await t.shot('open');
    });

    await t.step('Start session asks for a first prompt, and starts nothing', async () => {
      await page.click('Start session', dialogButton('Start session'));
      await page.waitFor('the problem', `!!${DIALOG}.querySelector('.field-problem')`);
      t.expect(await page.evaluate(`document.activeElement === ${PROMPT}`), 'focus goes to the first prompt', await page.evaluate(focused));
      t.expect(await page.evaluate(`(${PROMPT}).getAttribute('aria-describedby')?.split(' ').some((id) => document.getElementById(id)?.classList.contains('field-problem'))`), 'the prompt is described by its problem');
      t.expectEqual(server.records.spawns, [], 'nothing was started');
    });

    await t.step('starts a session, says so, and opens its view once it is listed', async () => {
      t.expectEqual(await page.evaluate(chooseOption(DIRECTORY, API_SERVER)), API_SERVER, 'the directory chosen');
      await page.click('Name', field('Name'));
      await page.type(name);
      await page.click('First prompt', PROMPT);
      await page.type(FIRST_PROMPT);
      await page.click('Start session', dialogButton('Start session'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expect((await page.evaluate<string[]>(toasts)).includes(`Started ${name}. Its view opens when it shows up in the list.`), 'the toast says it started', await page.evaluate(toasts));
      t.expectEqual(server.records.spawns, [{ cwd: API_SERVER, name, promptLength: FIRST_PROMPT.length }], 'the fake server got the start, once');
      await page.waitFor('its view', `${viewName} === ${q(name)}`, 8000);
      t.expect(await page.evaluate(`[...document.querySelectorAll('.session-list [data-open-session]')].some((el) => el.textContent.trim() === ${q(name)})`), 'its row is listed');
      await t.shot('started');
    });

    await t.step('Another directory under a root… reveals the autocomplete, with focus in it, which narrows as you type', async () => {
      await t.fresh({ search: '?view=all' });
      await openDialog(t, 'New session');
      await page.evaluate(chooseOption(DIRECTORY, OTHER));
      await page.waitFor('the combobox to take focus', `document.activeElement === ${COMBOBOX}`);
      await page.waitFor('its list', `${EXPANDED} === 'true' && ${OPTIONS}.length > 0`);
      t.expectEqual(
        await page.evaluate(OPTIONS),
        ['~/code/api-server, repo', '~/code/demo-app, repo', '~/code/docs-site, repo', '~/code/notes', '~/code/api-server/cmd', '~/code/demo-app/docs', '~/code/demo-app/web', '~/code/api-server/cmd/server'],
        'the directories under the root, shallower first, repos marked',
      );
      t.expectEqual(await page.evaluate(`${COMBOBOX}.getAttribute('aria-controls') === ${DIALOG}.querySelector('[role="listbox"]').id`), true, 'it controls its listbox');
      t.expectEqual(listRequests(server.records.requests), ['GET /api/directories 200'], 'the list was fetched, once');
      await page.type('web');
      await page.waitFor('the list to narrow', `${OPTIONS}.length === 1`);
      t.expectEqual(await page.evaluate(OPTIONS), ['~/code/demo-app/web'], 'only what matches');
      t.expectEqual(listRequests(server.records.requests).length, 1, 'typing asked the server nothing');
      await t.shot('directory-list');
    });

    await t.step('takes an option from the keyboard, and Escape closes only the list', async () => {
      await page.key('ArrowDown');
      t.expectEqual(await page.evaluate(`${ACTIVE}?.textContent`), '~/code/demo-app/web', '↓ highlights the option');
      const box = await page.evaluate<{ top: number; bottom: number; left: number; right: number }>(
        `(() => { const r = ${ACTIVE}.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`,
      );
      t.expect(box.top >= 0 && box.bottom <= t.viewport.height && box.left >= 0 && box.right <= t.viewport.width, 'the highlighted option is in the window', box);
      await page.key('Enter');
      t.expectEqual(await page.evaluate(`${COMBOBOX}.value`), '~/code/demo-app/web', 'Enter puts it in the field');
      t.expectEqual(await page.evaluate(EXPANDED), 'false', 'and closes the list');
      t.expect(await page.evaluate(`document.activeElement === ${COMBOBOX}`), 'focus stays in the field', await page.evaluate(focused));
      t.expectEqual(server.records.spawns, [], 'Enter started nothing');
      await page.key('ArrowDown');
      t.expectEqual(await page.evaluate(EXPANDED), 'true', '↓ opens it again');
      await page.key('Escape');
      t.expectEqual(await page.evaluate(EXPANDED), 'false', 'Escape closes the list');
      t.expectEqual(await page.evaluate(dialogName), 'New session', 'and leaves the dialog open');
    });

    await t.step('starts a session in the chosen directory, sending its absolute path', async () => {
      await page.click('First prompt', PROMPT);
      await page.type(FIRST_PROMPT);
      await page.click('Start session', dialogButton('Start session'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expectEqual(server.records.spawns, [{ cwd: DEMO_APP_WEB, promptLength: FIRST_PROMPT.length }], 'the fake server got the start, in the absolute path');
      t.expectEqual(listRequests(server.records.requests).length, 1, 'one list for the whole opening');
    });

    await t.step('Attach files takes files from the picker, uploads each, and lists it with its size, and a thumbnail for an image', async () => {
      await t.fresh({ search: '?view=all' });
      await openDialog(t, 'New session');
      t.expect(await page.evaluate(`!!${dialogButton('Attach files')}`), 'Attach files is there');
      t.expectEqual(
        await page.evaluate(describedText(dialogButton('Attach files'))),
        'Or drop or paste them into the prompt: images, PDFs and text files, up to 10 MB each.',
        'it says what it takes',
      );
      await pick(t, await pickerFiles(t));
      await page.waitFor('both uploaded', `${settledRows(2)} && ${ROWS}.every((row) => row.dataset.state === 'uploaded')`);
      t.expectEqual(
        await page.evaluate(LISTED),
        [
          ['pitwall-test-diagram.png', 'uploaded'],
          ['pitwall-test-notes.txt', 'uploaded'],
        ],
        'each listed, in order',
      );
      t.expectEqual(
        await page.evaluate(`${ROWS}.map((row) => row.querySelector('.attachment-meta').textContent)`),
        [`${PNG.length} B`, `${PICKED[1]!.bytes.length} B`],
        'with its size',
      );
      // Both go at once, so the fake server may answer them in either order.
      t.expectEqual(
        server.records.uploads.map(({ name, type, size, status }) => ({ name, type, size, status })).sort((a, b) => a.name.localeCompare(b.name)),
        PICKED.map(({ name, type, bytes }) => ({ name, type, size: bytes.length, status: 201 })),
        'the fake server got each, with its type, its name and its bytes',
      );
      await page.waitFor('the thumbnail', `${ROWS}[0].querySelector('img')?.getAttribute('src')?.startsWith('data:image/png;base64,')`);
      t.expect(await page.evaluate(`!${ROWS}[1].querySelector('img') && !!${ROWS}[1].querySelector('.attachment-tile svg')`), 'a text file has its type icon');
      const fits = await page.evaluate<boolean>(`(() => { const card = ${DIALOG}.getBoundingClientRect(); return ${ROWS}.every((row) => { const r = row.getBoundingClientRect(); return r.left >= card.left && r.right <= card.right; }); })()`);
      t.expect(fits, 'each row fits the dialog');
      t.expect(!(await page.evaluate<boolean>(START_OFF)), 'Start session is on');
      await t.shot('attached');
    });

    await t.step('a drop on the first prompt attaches the files, with the drop target over it while they are dragged', async () => {
      const types = await page.evaluate<string[]>(dragOnPrompt([{ name: 'pitwall-test-plan.md', type: 'text/markdown', text: '# A made-up plan\n' }]));
      t.expect(types.includes('Files'), 'the drag carries files', types);
      await page.waitFor('the drop target', `!!${DIALOG}.querySelector('.prompt-drop-target.over')`);
      const covers = await page.evaluate<boolean>(`(() => { const a = ${DIALOG}.querySelector('.prompt-drop-target').getBoundingClientRect(), b = ${PROMPT}.getBoundingClientRect(); return Math.abs(a.top - b.top) < 1 && Math.abs(a.bottom - b.bottom) < 1 && Math.abs(a.left - b.left) < 1 && Math.abs(a.right - b.right) < 1; })()`);
      t.expect(covers, 'it covers the prompt');
      t.expectEqual(await page.evaluate(`${DIALOG}.querySelector('.prompt-drop-target').textContent`), 'Drop files to attach them', 'it says what to do');
      await t.shot('drop-target');
      t.expect(await page.evaluate(DROP_ON_PROMPT), 'the page took the drop, so the browser opens nothing');
      await page.waitFor('it to upload', settledRows(3));
      t.expect(await page.evaluate(`!${DIALOG}.querySelector('.prompt-drop-target')`), 'the drop target has gone');
      t.expectEqual((await page.evaluate<string[][]>(LISTED))[2], ['pitwall-test-plan.md', 'uploaded'], 'it is listed, uploaded');
    });

    await t.step('pasting an image attaches it, and pasted text is left to paste as text', async () => {
      t.expect(await page.evaluate(pasteIntoPrompt([{ name: 'image.png', type: 'image/png', base64: PNG.toString('base64') }])), 'the page took the paste');
      await page.waitFor('it to upload', settledRows(4));
      t.expectEqual((await page.evaluate<string[][]>(LISTED))[3], ['image.png', 'uploaded'], 'it is listed, uploaded');
      t.expectEqual(await page.evaluate(`${PROMPT}.value`), '', 'no text went into the prompt');
      t.expect(!(await page.evaluate(pasteIntoPrompt([], 'Some made-up text'))), 'text alone is left to the browser');
      t.expect(!(await page.evaluate(pasteIntoPrompt([{ name: 'cells.png', type: 'image/png', base64: PNG.toString('base64') }], 'Region\tTotal'))), "and so is text with a picture of it, as a spreadsheet's copy has");
      await page.settle();
      t.expectEqual(await page.evaluate(`${ROWS}.length`), 4, 'neither attached anything');
    });

    await t.step("refuses a file over 10 MB and one of a type pitwall doesn't take, saying why, and uploads the rest", async () => {
      const before = server.records.uploads.length;
      await dropOnPrompt(t, [
        { name: 'pitwall-test-recording.png', type: 'image/png', size: MAX_BYTES + 1 },
        { name: 'pitwall-test-report.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text: 'made up' },
        { name: 'pitwall-test-data.json', type: 'application/json', text: '{"made":"up"}' },
      ]);
      await page.waitFor('them to settle', settledRows(7));
      t.expectEqual(
        (await page.evaluate<string[][]>(LISTED)).slice(4),
        [
          ['pitwall-test-recording.png', 'refused'],
          ['pitwall-test-report.docx', 'refused'],
          ['pitwall-test-data.json', 'uploaded'],
        ],
        'two refused, the third uploaded',
      );
      t.expectEqual(await page.evaluate(problemOf('pitwall-test-recording.png')), "Couldn't attach it. It's 10.1 MB, over the 10 MB limit.", 'why the large one');
      t.expectEqual(await page.evaluate(problemOf('pitwall-test-report.docx')), "Couldn't attach it. Only images, PDFs and text files can be attached.", 'why the other');
      t.expectEqual(server.records.uploads.slice(before).map((upload) => upload.name), ['pitwall-test-data.json'], 'only the third was sent');
      t.expect(!(await page.evaluate<boolean>(START_OFF)), "the refused ones don't hold up Start session");
      await t.shot('refused');
    });

    await t.step("the server's refusal of bytes that aren't the type's is listed, with its reason", async () => {
      t.allow(/\/api\/attachments$/, "the fake server refuses a PNG whose bytes aren't one, with 415, as W79's route does");
      await dropOnPrompt(t, [{ name: 'pitwall-test-fake.png', type: 'image/png', text: 'not a PNG' }]);
      await page.waitFor('it to settle', settledRows(8));
      t.expectEqual(await page.evaluate(problemOf('pitwall-test-fake.png')), "Couldn't attach it. Made up: its first bytes aren't those of image/png.", "the server's reason");
      t.expectEqual(server.records.uploads.at(-1)?.status, 415, 'the fake server answered 415');
    });

    await t.step("a 503, attachments unavailable on this machine, says the session can still start without them", async () => {
      t.allow(/\/api\/attachments$/, 'the fake server answers 503, as a pitwall that keeps no attachments does');
      await dropOnPrompt(t, [{ name: `${UNAVAILABLE_UPLOAD}.txt`, type: 'text/plain', text: 'made up' }]);
      await page.waitFor('it to settle', settledRows(9));
      t.expectEqual(
        await page.evaluate(problemOf(`${UNAVAILABLE_UPLOAD}.txt`)),
        "Couldn't attach it. Files can't be attached on this machine. You can still start the session without them. Made up: this pitwall doesn't keep attachments.",
        'what it says',
      );
      t.expectEqual(server.records.uploads.at(-1)?.status, 503, 'the fake server answered 503');
      t.expect(!(await page.evaluate<boolean>(START_OFF)), "it doesn't hold up Start session");
    });

    await t.step('Remove takes a file off the list, asks the server to remove it, and puts focus on the next one', async () => {
      const id = server.records.uploads.find((upload) => upload.name === 'pitwall-test-diagram.png')?.id;
      await page.click('Remove pitwall-test-diagram.png', dialogButton('Remove pitwall-test-diagram.png'));
      await page.waitFor('the row to go', `${ROW_COUNT} === 8`);
      t.expect((await page.evaluate(`document.activeElement?.getAttribute('aria-label')`)) === 'Remove pitwall-test-notes.txt', 'focus is on the next one', await page.evaluate(focused));
      const deadline = Date.now() + 3000;
      while (server.records.deletes.length === 0 && Date.now() < deadline) await page.settle(50);
      t.expectEqual(server.records.deletes, [{ id, status: 204 }], 'the fake server removed it, with DELETE attachmentPath()');
      // A refused file was never kept: its Remove asks nothing of the server.
      await page.click(`Remove ${UNAVAILABLE_UPLOAD}.txt`, dialogButton(`Remove ${UNAVAILABLE_UPLOAD}.txt`));
      await page.waitFor('the row to go', `${ROW_COUNT} === 7`);
      await page.settle(200);
      t.expectEqual(server.records.deletes.length, 1, 'a refused one asked nothing');
    });

    await t.step('Start session waits for an upload, saying why, and Remove aborts one on its way', async () => {
      await dropOnPrompt(t, [{ name: `${SLOW_UPLOAD}-one.txt`, type: 'text/plain', text: 'slow' }]);
      await page.waitFor('it to be uploading', `${ROWS}.at(-1)?.dataset.state === 'uploading'`);
      t.expect(await page.evaluate(START_OFF), 'Start session is off');
      t.expectEqual(await page.evaluate(describedText(dialogButton('Start session'))), 'Wait for the file to upload, or remove it.', 'and says why');
      t.expect((await page.evaluate<string>(`${ROWS}.at(-1).querySelector('.attachment-meta').textContent`)).endsWith('Uploading…'), 'the row says it is uploading');
      await t.shot('uploading');
      await page.waitFor('it to upload', `${ROWS}.at(-1)?.dataset.state === 'uploaded'`, 4000);
      t.expect(!(await page.evaluate<boolean>(START_OFF)), 'Start session is on again');

      await dropOnPrompt(t, [{ name: `${SLOW_UPLOAD}-two.txt`, type: 'text/plain', text: 'slow' }]);
      await page.waitFor('it to be uploading', `${ROWS}.at(-1)?.dataset.state === 'uploading'`);
      await page.click(`Remove ${SLOW_UPLOAD}-two.txt`, dialogButton(`Remove ${SLOW_UPLOAD}-two.txt`));
      await page.waitFor('the row to go', `${ROW_COUNT} === 8`);
      const deadline = Date.now() + 3000;
      while (!server.records.uploads.some((upload) => upload.name === `${SLOW_UPLOAD}-two.txt`) && Date.now() < deadline) await page.settle(50);
      t.expectEqual(server.records.uploads.find((upload) => upload.name === `${SLOW_UPLOAD}-two.txt`)?.status, 'aborted', 'its upload was aborted');
      t.expect(!(await page.evaluate<boolean>(START_OFF)), 'Start session is on');
    });

    await t.step('a failed upload says so, with Try again, and Start session waits for it', async () => {
      t.allow(/\/api\/attachments$/, 'the fake server fails a file the first time it is sent, with 500');
      await dropOnPrompt(t, [{ name: `${FAIL_UPLOAD}-notes.txt`, type: 'text/plain', text: 'fails once' }]);
      await page.waitFor('it to fail', `${ROWS}.at(-1)?.dataset.state === 'failed'`);
      t.expectEqual(await page.evaluate(problemOf(`${FAIL_UPLOAD}-notes.txt`)), "Couldn't upload it. Made up: pitwall couldn't write it.", 'why');
      t.expectEqual(await page.evaluate(describedText(dialogButton('Start session'))), "A file didn't upload. Try it again, or remove it.", 'Start session says why it is off');
      await t.shot('failed');
      await page.click('Try again', `${ROWS}.at(-1).querySelector('button.button')`);
      await page.waitFor('it to upload', `${ROWS}.at(-1)?.dataset.state === 'uploaded'`);
      t.expect((await page.evaluate(`document.activeElement?.getAttribute('aria-label')`)) === `Remove ${FAIL_UPLOAD}-notes.txt`, 'focus is on its Remove', await page.evaluate(focused));
      t.expect(!(await page.evaluate<boolean>(START_OFF)), 'Start session is on');
    });

    await t.step("Start session sends the uploaded files' ids, in the list's order", async () => {
      const listed = (await page.evaluate<string[][]>(LISTED)).filter(([, state]) => state === 'uploaded').map(([name]) => name);
      const ids = listed.map((name) => server.records.uploads.find((upload) => upload.name === name && upload.status === 201)?.id);
      t.expectEqual(listed, ['pitwall-test-notes.txt', 'pitwall-test-plan.md', 'image.png', 'pitwall-test-data.json', `${SLOW_UPLOAD}-one.txt`, `${FAIL_UPLOAD}-notes.txt`], 'the uploaded files');
      const cwd = await page.evaluate<string>(`${DIRECTORY}.value`);
      await page.click('First prompt', PROMPT);
      await page.type(FIRST_PROMPT);
      await page.click('Start session', dialogButton('Start session'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expectEqual(server.records.spawns, [{ cwd, promptLength: FIRST_PROMPT.length, attachments: ids }], 'the fake server got the start, with their ids');
      await page.settle(300);
      t.expectEqual(server.records.deletes.length, 1, "closing after the start asked the server to remove none of the session's files");
    });

    await t.step('closing without starting asks the server to remove the files it kept', async () => {
      await t.fresh({ search: '?view=all' });
      await openDialog(t, 'New session');
      t.expect(
        await page.evaluate(
          pasteIntoPrompt([
            { name: 'pitwall-test-left-1.txt', type: 'text/plain', text: 'made up' },
            { name: 'pitwall-test-left-2.txt', type: 'text/plain', text: 'made up' },
          ]),
        ),
        'the page took the paste',
      );
      await page.waitFor('both uploaded', `${settledRows(2)} && ${ROWS}.every((row) => row.dataset.state === 'uploaded')`);
      const ids = server.records.uploads.map((upload) => upload.id).sort();
      await page.click('Cancel', dialogButton('Cancel'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      const deadline = Date.now() + 3000;
      while (server.records.deletes.length < 2 && Date.now() < deadline) await page.settle(50);
      t.expectEqual(
        server.records.deletes.map((removed) => removed.id).sort(),
        ids,
        'each one, with DELETE attachmentPath()',
      );
      t.expect(server.records.deletes.every((removed) => removed.status === 204), 'and the fake server removed each', server.records.deletes);
    });

    await t.step('Cancel closes it, with focus back on New session', async () => {
      await t.fresh({ search: '?view=all' });
      await openDialog(t, 'New session');
      await page.click('Cancel', dialogButton('Cancel'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expect(await page.evaluate(`document.activeElement === ${headerButton('New session')}`), 'focus is back on New session', await page.evaluate(focused));
    });

    await t.step('n opens it', async () => {
      await page.evaluate(`(document.activeElement?.blur(), true)`);
      await page.key('n');
      await page.waitFor('the dialog', `${dialogName} === 'New session'`);
      await page.key('Escape');
      await page.waitFor('the dialog to close', `!${DIALOG}`);
    });
  },
};

export default part;
