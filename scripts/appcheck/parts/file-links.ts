// Open a file in your editor from a link in a message (W211; docs/design-system.md, 4: Markdown in
// messages, and Dialogs): a path in text, in a code span, or a markdown link to one is a link button;
// the first click, with two editors found and none chosen, asks "Open in which editor?"; choosing one
// POSTs the open and remembers it; a file outside the workspaces asks first, showing the server's path,
// and sends outside: true only on Open; Cancel sends nothing. Nothing is opened: the fake server
// records each accepted request.

import { FILE_LINKS, NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { DIALOG, dialogButton, dialogName, openFromRow, toasts, VIEW } from './_dom.js';

const q = JSON.stringify;
const fileButton = (path: string) => `[...${VIEW}.querySelectorAll('.entry-markdown button.md-file')].find((b) => b.dataset.filePath === ${q(path)})`;

const part: Part = {
  name: 'file-links',
  title: 'File links in messages: the link buttons, the editor choice, and the outside-your-workspaces question',
  async run(t) {
    const { page, server } = t;

    await t.step('a path in text, in a code span, and a markdown link to a file are link buttons', async () => {
      await t.fresh({ search: '?view=all' });
      await page.evaluate(`(() => { try { localStorage.removeItem('pitwall.editor'); } catch {} })()`);
      await openFromRow(t, NAMES.conversation);
      await page.waitFor('the file links', `!!${fileButton('src/server/health.ts')}`);
      for (const path of ['src/server/health.ts', FILE_LINKS.inCode, FILE_LINKS.markdown, FILE_LINKS.outside, FILE_LINKS.mismatch]) {
        t.expect(await page.evaluate<boolean>(`!!${fileButton(path)}`), `${path} is a link button`);
      }
      t.expectEqual(await page.evaluate(`${fileButton('src/server/health.ts')}.textContent`), FILE_LINKS.inText, 'with the text as written, line and all');
      await t.shot('links');
    });

    await t.step('the first click, with two editors and none chosen, asks which editor, and choosing one opens the file and is remembered', async () => {
      server.clearRecords();
      await page.click('the path in text', fileButton('src/server/health.ts'));
      await page.waitFor('the dialog', `${dialogName} === 'Open in which editor?'`);
      t.expectEqual(server.records.fileOpens, [], 'nothing sent yet');
      await t.shot('choose');
      await page.click('Open in Cursor', dialogButton('Open in Cursor'));
      await page.waitFor('the toast', `${toasts}.includes('Opened health.ts in Cursor.')`);
      t.expectEqual(server.records.fileOpens, [{ editor: 'cursor', path: 'src/server/health.ts', line: 12 }], 'one open, in Cursor, at line 12');
      t.expectEqual(await page.evaluate<string | null>(`localStorage.getItem('pitwall.editor')`), 'cursor', 'Cursor is the last used');
      t.expect(!(await page.evaluate<boolean>(`!!${DIALOG}`)), 'the dialog closed');
    });

    await t.step('a file outside the workspaces asks first with the server’s path; Cancel sends nothing more', async () => {
      server.clearRecords();
      t.allow(/\/open-file$/, 'the 409 that asks first, as the server answers a file outside the roots');
      await page.click('the outside path', fileButton(FILE_LINKS.outside));
      await page.waitFor('the dialog', `${dialogName} === 'Open a file outside your workspaces?'`);
      t.expect((await page.evaluate<string>(`${DIALOG}.textContent`)).includes(`/private${FILE_LINKS.outside}`), 'it shows the path the server resolved');
      await t.shot('outside');
      await page.click('Cancel', dialogButton('Cancel'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expectEqual(server.records.fileOpens, [], 'nothing opened');
    });

    await t.step('Open sends the request again with outside: true, and the file opens', async () => {
      t.allow(/\/open-file$/, 'the 409 that asks first');
      await page.click('the outside path', fileButton(FILE_LINKS.outside));
      await page.waitFor('the dialog', `${dialogName} === 'Open a file outside your workspaces?'`);
      await page.click('Open in Cursor', dialogButton('Open in Cursor'));
      await page.waitFor('the toast', `${toasts}.includes('Opened run.log in Cursor.')`);
      t.expectEqual(server.records.fileOpens, [{ editor: 'cursor', path: `/private${FILE_LINKS.outside}`, outside: true }], 'one open, with the realpath the server named, and outside');
    });

    await t.step('a link whose text is not its file asks first, naming the file it opens; Cancel sends nothing, Open opens it', async () => {
      server.clearRecords();
      await page.waitFor('the earlier toast to go', `${toasts}.length === 0`);
      await page.click('the mismatched link', fileButton(FILE_LINKS.mismatch));
      await page.waitFor('the dialog', `${dialogName} === "Open a file this link doesn't name?"`);
      const text = await page.evaluate<string>(`${DIALOG}.textContent`);
      t.expect(text.includes('the notes') && text.includes(FILE_LINKS.mismatch), 'it shows the link’s text and the file it opens');
      t.expectEqual(server.records.fileOpens, [], 'nothing sent yet');
      await t.shot('mismatch');
      await page.click('Cancel', dialogButton('Cancel'));
      await page.waitFor('the dialog to close', `!${DIALOG}`);
      t.expectEqual(server.records.fileOpens, [], 'Cancel opened nothing');
      await page.click('the mismatched link', fileButton(FILE_LINKS.mismatch));
      await page.waitFor('the dialog', `${dialogName} === "Open a file this link doesn't name?"`);
      await page.click('Open', dialogButton('Open'));
      await page.waitFor('the toast', `${toasts}.includes('Opened runbook.md in Cursor.')`);
      t.expectEqual(server.records.fileOpens, [{ editor: 'cursor', path: FILE_LINKS.mismatch }], 'opened once');
    });
  },
};

export default part;
