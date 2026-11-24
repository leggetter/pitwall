// useFileLinks (W211): the choose-an-editor dialog, the outside-your-workspaces dialog and the toasts.
// A made-up api; no editor is run.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../api.js';
import { EditorsContext } from '../editors.js';
import { lastEditor } from '../fileLinks.js';
import type { Editor } from '../../../src/shared/protocol.js';
import { toastMessages } from '../test/toasts.js';
import { CHOOSE_TITLE, MISMATCH_TITLE, NO_EDITOR, OUTSIDE_TITLE, useFileLinks } from './FileLinks.js';
import { ToastProvider } from './Toast.js';

const two: Editor[] = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'cursor', label: 'Cursor' },
];

function setup(editors: Editor[], results: ApiResult[]) {
  const post = vi.fn(async () => results.shift() ?? ({ kind: 'failed', status: 500 } as ApiResult));
  const api = { post } as unknown as ApiClient;
  function Probe() {
    const { links, dialog } = useFileLinks(api, 'abc', true);
    return (
      <>
        <button onClick={() => links?.open({ path: 'src/a.ts', line: 3 })}>go</button>
        <button onClick={() => links?.open({ path: 'src/a.ts', line: 3 }, 'NOTES.md')}>mismatch</button>
        {dialog}
      </>
    );
  }
  render(
    <ToastProvider>
      <EditorsContext.Provider value={editors}>
        <Probe />
      </EditorsContext.Provider>
    </ToastProvider>,
  );
  const click = async (name: string | RegExp) => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
    });
  };
  return { post, click };
}

const ok: ApiResult = { kind: 'ok', status: 200, body: { ok: true } };

beforeEach(() => {
  window.localStorage.clear();
});

describe('useFileLinks', () => {
  it('asks which editor with two found and none remembered, then remembers the choice', async () => {
    const { post, click } = setup(two, [ok]);
    await click('go');
    expect(screen.getByText(CHOOSE_TITLE)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    await click('Open in Cursor');
    expect(post).toHaveBeenCalledWith('/api/sessions/abc/open-file', { editor: 'cursor', path: 'src/a.ts', line: 3 });
    expect(lastEditor()).toBe('cursor');
    expect(toastMessages()).toEqual(['Opened a.ts in Cursor.']);
    expect(screen.queryByText(CHOOSE_TITLE)).toBeNull();
  });

  it('opens straight away with the remembered editor, without asking', async () => {
    window.localStorage.setItem('pitwall.editor', 'vscode');
    const { post, click } = setup(two, [ok]);
    await click('go');
    expect(screen.queryByText(CHOOSE_TITLE)).toBeNull();
    expect(post).toHaveBeenCalledWith('/api/sessions/abc/open-file', { editor: 'vscode', path: 'src/a.ts', line: 3 });
  });

  it('shows the server’s realpath outside the roots, and sends outside: true only on Open', async () => {
    window.localStorage.setItem('pitwall.editor', 'vscode');
    const outside: ApiResult = { kind: 'failed', status: 409, body: { ok: false, error: 'outside', outside: true, path: '/real/elsewhere/a.ts' } };
    const { post, click } = setup(two, [outside, ok]);
    await click('go');
    expect(screen.getByText(OUTSIDE_TITLE)).toBeTruthy();
    expect(screen.getByText('/real/elsewhere/a.ts')).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
    await click('Open in VS Code');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith('/api/sessions/abc/open-file', { editor: 'vscode', path: '/real/elsewhere/a.ts', line: 3, outside: true });
  });

  it('asks first for a link whose text is not its file, naming the path it opens, and opens only on Open', async () => {
    window.localStorage.setItem('pitwall.editor', 'vscode');
    const { post, click } = setup(two, [ok]);
    await click('mismatch');
    expect(screen.getByText(MISMATCH_TITLE)).toBeTruthy();
    expect(screen.getByText('NOTES.md')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    await click('Cancel');
    expect(post).not.toHaveBeenCalled();
    await click('mismatch');
    await click('Open');
    expect(post).toHaveBeenCalledWith('/api/sessions/abc/open-file', { editor: 'vscode', path: 'src/a.ts', line: 3 });
  });

  it('sends nothing more on Cancel', async () => {
    window.localStorage.setItem('pitwall.editor', 'vscode');
    const outside: ApiResult = { kind: 'failed', status: 409, body: { ok: false, error: 'outside', outside: true, path: '/real/a.ts' } };
    const { post, click } = setup(two, [outside]);
    await click('go');
    await click('Cancel');
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(OUTSIDE_TITLE)).toBeNull();
  });

  it('toasts a 404 in the server’s words, and says so when there is no editor', async () => {
    window.localStorage.setItem('pitwall.editor', 'vscode');
    const missing: ApiResult = { kind: 'failed', status: 404, body: { ok: false, error: 'No such file.' } };
    const { click } = setup(two, [missing]);
    await click('go');
    expect(toastMessages().join(' ')).toContain('No such file.');
  });

  it('toasts that no editor was found', async () => {
    const { post, click } = setup([], []);
    await click('go');
    expect(toastMessages()).toEqual([NO_EDITOR]);
    expect(post).not.toHaveBeenCalled();
  });
});
