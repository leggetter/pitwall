// File references (W211): a link's target, path-like text, the terminal's link provider, the request
// and the choice of editor. Made-up paths only.
import { describe, expect, it, vi } from 'vitest';
import type { ILink } from '@xterm/xterm';
import type { ApiClient, ApiResult } from './api.js';
import { chooseEditor, findFileRefs, lastEditor, openFile, openFileRequest, parseFileTarget, rememberEditor, terminalFileLinks } from './fileLinks.js';

describe('parseFileTarget', () => {
  it('reads a file: link, with an encoded space, and a localhost host', () => {
    expect(parseFileTarget('file:///abs/a%20file.md')).toEqual({ path: '/abs/a file.md' });
    expect(parseFileTarget('file://localhost/abs/NOW.md')).toEqual({ path: '/abs/NOW.md' });
    expect(parseFileTarget('file:///abs/a.ts#L12')).toEqual({ path: '/abs/a.ts', line: 12 });
  });

  it('refuses a file: link to another host, with no path, or with a bad escape or a control character', () => {
    for (const target of ['file://evil.example/abs/a.md', 'file:///abs/%00a', 'file:///abs/%E0%A4%A', 'file:/abs/a.md', 'file://host', 'file:///a%0Ab']) {
      expect(parseFileTarget(target), target).toBeUndefined();
    }
  });

  it('reads a relative target with #L12, #L12C3 and #L12-L20, and the path:line form', () => {
    expect(parseFileTarget('src/server/editors.ts#L12')).toEqual({ path: 'src/server/editors.ts', line: 12 });
    expect(parseFileTarget('src/a.ts#L12C3')).toEqual({ path: 'src/a.ts', line: 12, column: 3 });
    expect(parseFileTarget('src/a.ts#L12-L20')).toEqual({ path: 'src/a.ts', line: 12 });
    expect(parseFileTarget('src/a.ts:12:3')).toEqual({ path: 'src/a.ts', line: 12, column: 3 });
    expect(parseFileTarget('NOW.md')).toEqual({ path: 'NOW.md' });
    expect(parseFileTarget('~/notes/a.md')).toEqual({ path: '~/notes/a.md' });
    expect(parseFileTarget('a.ts:7')).toEqual({ path: 'a.ts', line: 7 });
    expect(parseFileTarget('src/a.ts#section')).toBeUndefined();
  });

  it('refuses any other scheme, a network path, and a path that is empty, too long or has a control character', () => {
    for (const target of ['http://example.com/a', 'javascript:alert(1)', 'vscode://file/etc/passwd', 'data:text/plain,x', '//host/share/a.txt', '\\\\host\\a', '', '#L1', `${'a'.repeat(1030)}.ts`, 'a\u0000b.ts', 'a\nb.ts']) {
      expect(parseFileTarget(target), target).toBeUndefined();
    }
  });
});

describe('findFileRefs', () => {
  const refs = (text: string) => findFileRefs(text).map(({ start, end, ...ref }) => ({ ...ref, text: text.slice(start, end) }));

  it('finds absolute, ~/ and relative paths with an extension, and a bare name with a known one', () => {
    expect(refs('See /Users/me/oss/pitwall/NOW.md and ~/notes/todo.md, ./a/b.ts or ../c.json and NOW.md.')).toEqual([
      { path: '/Users/me/oss/pitwall/NOW.md', text: '/Users/me/oss/pitwall/NOW.md' },
      { path: '~/notes/todo.md', text: '~/notes/todo.md' },
      { path: './a/b.ts', text: './a/b.ts' },
      { path: '../c.json', text: '../c.json' },
      { path: 'NOW.md', text: 'NOW.md' },
    ]);
  });

  it('reads :line and :line:column, strips the sentence’s punctuation and quotes, and finds a path in backticks or brackets', () => {
    expect(refs('(src/server/editors.ts:12).')).toEqual([{ path: 'src/server/editors.ts', line: 12, text: 'src/server/editors.ts:12' }]);
    expect(refs('`src/a.tsx:3:9`, then "web/b.ts".')).toEqual([
      { path: 'src/a.tsx', line: 3, column: 9, text: 'src/a.tsx:3:9' },
      { path: 'web/b.ts', text: 'web/b.ts' },
    ]);
    expect(refs('**docs/decisions.md**')).toEqual([{ path: 'docs/decisions.md', text: 'docs/decisions.md' }]);
    expect(refs('at src/a.ts:12-20')).toEqual([{ path: 'src/a.ts', line: 12, text: 'src/a.ts:12-20' }]);
  });

  it('leaves URLs, domains, versions, words and directories alone', () => {
    expect(refs('https://example.com/docs/a.md example.com v2.1.331 and/or e.g. 3.14 src/server/ http://x/a.ts npm_config_x foo.bar')).toEqual([{ path: 'foo.bar', text: 'foo.bar' }].filter(() => false));
  });

  it('gives each reference its place in the text, for a link provider', () => {
    const [found] = findFileRefs('  edit src/a.ts:4 now');
    expect(found).toMatchObject({ start: 7, end: 17, path: 'src/a.ts', line: 4 });
  });
});

describe('terminalFileLinks', () => {
  it('makes a link for each path on the line, 1-based and inclusive, which opens its reference', () => {
    const open = vi.fn();
    const provider = terminalFileLinks((y) => (y === 3 ? 'edit src/a.ts:4 now' : undefined), open);
    let links: ILink[] | undefined;
    provider.provideLinks(3, (found) => (links = found));
    expect(links).toHaveLength(1);
    expect(links?.[0]?.range).toEqual({ start: { x: 6, y: 3 }, end: { x: 15, y: 3 } });
    expect(links?.[0]?.text).toBe('src/a.ts:4');
    links?.[0]?.activate({} as MouseEvent, 'src/a.ts:4');
    expect(open).toHaveBeenCalledWith({ path: 'src/a.ts', line: 4 });
    let none: ILink[] | undefined = [];
    provider.provideLinks(9, (found) => (none = found));
    expect(none).toBeUndefined();
  });
});

describe('the editor', () => {
  const both = [{ id: 'vscode' as const }, { id: 'cursor' as const }];
  it('is the last used, else the config file’s, else the only one, else none', () => {
    expect(chooseEditor(both, 'cursor', 'vscode')).toBe('cursor');
    expect(chooseEditor(both, undefined, 'vscode')).toBe('vscode');
    expect(chooseEditor([{ id: 'vscode' }], 'cursor', undefined)).toBe('vscode');
    expect(chooseEditor(both, undefined, undefined)).toBeUndefined();
    expect(chooseEditor([], 'cursor', 'cursor')).toBeUndefined();
  });

  it('is kept in storage that may be missing or throw', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(lastEditor(storage)).toBeUndefined();
    rememberEditor('cursor', storage);
    expect(lastEditor(storage)).toBe('cursor');
    store.set('pitwall.editor', 'vim');
    expect(lastEditor(storage)).toBeUndefined();
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(lastEditor(broken)).toBeUndefined();
    expect(() => rememberEditor('vscode', broken)).not.toThrow();
  });
});

describe('openFile', () => {
  const api = (result: ApiResult) => ({ post: vi.fn(async () => result) }) as unknown as ApiClient & { post: ReturnType<typeof vi.fn> };

  it('sends the reference and editor, with outside only when set', async () => {
    expect(openFileRequest({ path: 'a.ts', line: 2 }, 'cursor')).toEqual({ editor: 'cursor', path: 'a.ts', line: 2 });
    expect(openFileRequest({ path: 'a.ts' }, 'cursor', true)).toEqual({ editor: 'cursor', path: 'a.ts', outside: true });
    const client = api({ kind: 'ok', status: 200, body: { ok: true } });
    expect(await openFile(client, 'abc', { editor: 'cursor', path: 'a.ts' })).toEqual({ kind: 'opened' });
    expect(client.post).toHaveBeenCalledWith('/api/sessions/abc/open-file', { editor: 'cursor', path: 'a.ts' });
  });

  it('reads the 409 that asks first, a refusal in the server’s words, and anything else as failed', async () => {
    expect(await openFile(api({ kind: 'failed', status: 409, body: { ok: false, error: 'outside', outside: true, path: '/x/y.txt' } }), 'a', { editor: 'cursor', path: 'p' })).toEqual({ kind: 'outside', path: '/x/y.txt' });
    expect(await openFile(api({ kind: 'failed', status: 404, body: { ok: false, error: 'No such file.' } }), 'a', { editor: 'cursor', path: 'p' })).toEqual({ kind: 'refused', error: 'No such file.', status: 404 });
    expect(await openFile(api({ kind: 'failed', status: 502 }), 'a', { editor: 'cursor', path: 'p' })).toEqual({ kind: 'failed', status: 502 });
    expect(await openFile(api({ kind: 'unauthorized' }), 'a', { editor: 'cursor', path: 'p' })).toEqual({ kind: 'unauthorized' });
  });
});
