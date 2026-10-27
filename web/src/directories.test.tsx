// The directory list's helpers (W70): reading the server's answer, the options a root tab offers,
// matching and ranking, and what a typed directory sends. Made-up directories only.
import { describe, expect, it } from 'vitest';
import type { DirectoryList } from '../../src/shared/protocol.js';
import {
  directoryCount,
  directoryOptions,
  matchDirectories,
  MAX_SHOWN,
  parseDirectoryList,
  resolveTypedDirectory,
  typedDirectoryProblem,
} from './directories.js';

const CODE = '/Users/example/code';
const OSS = '/Users/example/oss';
const SRV = '/srv/projects';

const LIST: DirectoryList = {
  roots: [
    {
      root: CODE,
      dirs: [
        { path: 'outpost', repo: true },
        { path: 'outpost-docs', repo: true },
        { path: 'pitwall', repo: true },
        { path: 'scratch' },
        { path: 'outpost/docs' },
        { path: 'pitwall/web' },
        { path: 'scratch/my-outpost' },
        { path: 'scratch/old/Outpost' },
      ],
      truncated: false,
    },
    { root: OSS, dirs: [{ path: 'blog', repo: true }, { path: 'blog/outpost-notes' }], truncated: true },
  ],
};

const labels = (text: string, list = LIST, roots = [CODE, OSS], tab?: string) =>
  matchDirectories(directoryOptions(list, roots, tab).options, text).shown.map((option) => option.label);

describe('reading the list', () => {
  it('takes a well-formed list as it is', () => {
    expect(parseDirectoryList(JSON.parse(JSON.stringify(LIST)))).toEqual(LIST);
  });

  it('refuses anything that is not one', () => {
    for (const body of [undefined, null, [], 'roots', { roots: {} }, { roots: [{ root: 'relative', dirs: [], truncated: false }] }, { roots: [{ root: CODE, dirs: [] }] }]) {
      expect(parseDirectoryList(body)).toBeUndefined();
    }
  });

  it('drops entries that are not clean relative paths, or have control or bidi characters', () => {
    const list = parseDirectoryList({
      roots: [
        {
          root: CODE,
          dirs: [
            { path: 'ok' },
            { path: '/abs' },
            { path: 'a/../b' },
            { path: 'a//b' },
            { path: 'trailing/' },
            { path: 'bell\u0007' },
            { path: 'rtl\u202e' },
            { path: 'c1\u0085' },
            { path: 7 },
            'text',
            { path: 'repo', repo: 'yes' },
          ],
          truncated: false,
        },
      ],
    });
    expect(list?.roots[0]?.dirs).toEqual([{ path: 'ok' }, { path: 'repo' }]);
  });
});

describe('the options', () => {
  it('read as the root with home shortened, then the path, absolute underneath, with repos marked', () => {
    const { options, truncated } = directoryOptions(LIST, [CODE, OSS]);
    expect(truncated).toBe(true);
    expect(options[0]).toMatchObject({ path: `${CODE}/outpost`, label: '~/code/outpost', rel: 'outpost', root: CODE, repo: true, depth: 1 });
    expect(options.find((option) => option.rel === 'scratch')).toMatchObject({ repo: false });
    expect(options.find((option) => option.rel === 'blog/outpost-notes')).toMatchObject({ label: '~/oss/blog/outpost-notes', depth: 2 });
  });

  it("with a root tab open, offer that root's alone, and say truncated only for it (W38)", () => {
    const code = directoryOptions(LIST, [CODE, OSS], CODE);
    expect(code.options.every((option) => option.root === CODE)).toBe(true);
    expect(code.truncated).toBe(false);
    const oss = directoryOptions(LIST, [CODE, OSS], OSS);
    expect(oss.options.map((option) => option.label)).toEqual(['~/oss/blog', '~/oss/blog/outpost-notes']);
    expect(oss.truncated).toBe(true);
  });

  it("leave out a root the page doesn't have, and an inner root's directories from the outer root's walk", () => {
    const inner = `${CODE}/pitwall`;
    const list: DirectoryList = {
      roots: [
        { root: CODE, dirs: [{ path: 'pitwall' }, { path: 'pitwall/web' }, { path: 'scratch' }], truncated: false },
        { root: inner, dirs: [{ path: 'web' }], truncated: false },
        { root: '/elsewhere', dirs: [{ path: 'x' }], truncated: true },
      ],
    };
    // The inner root itself is the inner tab's, as the index lists a session started there under it; the select offers it.
    expect(directoryOptions(list, [CODE, inner], CODE).options.map((option) => option.label)).toEqual(['~/code/scratch']);
    expect(directoryOptions(list, [CODE, inner], inner).options.map((option) => option.label)).toEqual(['~/code/pitwall/web']);
    expect(directoryOptions(list, [CODE, inner]).truncated).toBe(false);
  });

  it('keep a root outside home as it is', () => {
    const list: DirectoryList = { roots: [{ root: SRV, dirs: [{ path: 'api' }], truncated: false }] };
    expect(directoryOptions(list, [SRV]).options[0]).toMatchObject({ label: `${SRV}/api`, path: `${SRV}/api` });
  });
});

describe('matching', () => {
  it('with nothing typed, lists every one, shallower first, then alphabetically ignoring case', () => {
    expect(labels('', LIST, [CODE])).toEqual([
      '~/code/outpost',
      '~/code/outpost-docs',
      '~/code/pitwall',
      '~/code/scratch',
      '~/code/outpost/docs',
      '~/code/pitwall/web',
      '~/code/scratch/my-outpost',
      '~/code/scratch/old/Outpost',
    ]);
  });

  it('is case-insensitive, and ranks the last segment equal, then starting with it, then any segment starting with it, then the rest', () => {
    expect(labels('OUTPOST', LIST, [CODE])).toEqual([
      // The last segment is the text: shallower first.
      '~/code/outpost',
      '~/code/scratch/old/Outpost',
      // The last segment starts with it.
      '~/code/outpost-docs',
      // A segment starts with it.
      '~/code/outpost/docs',
      // It's in there somewhere.
      '~/code/scratch/my-outpost',
    ]);
  });

  it('needs every term, in the path under the root, not the root', () => {
    // Ranked on the last term: Outpost starts with "out"; my-outpost only has it inside.
    expect(labels('scratch out', LIST, [CODE])).toEqual(['~/code/scratch/old/Outpost', '~/code/scratch/my-outpost']);
    expect(labels('code', LIST, [CODE])).toEqual([]);
    expect(labels('  pit   web ', LIST, [CODE])).toEqual(['~/code/pitwall/web']);
  });

  it('matches the whole shortened path when the text starts with ~ or /, ranking on what follows its last /', () => {
    expect(labels('~/code/out', LIST, [CODE])).toEqual(['~/code/outpost', '~/code/outpost-docs', '~/code/outpost/docs']);
    expect(labels('~/oss', LIST, [CODE, OSS])).toEqual(['~/oss/blog', '~/oss/blog/outpost-notes']);
    expect(labels('/code/pitwall', LIST, [CODE])).toEqual(['~/code/pitwall', '~/code/pitwall/web']);
    // A pasted absolute path finds its option too.
    expect(labels(`${CODE}/pitwall/web`, LIST, [CODE])).toEqual(['~/code/pitwall/web']);
    expect(labels('~/code/', LIST, [CODE])).toHaveLength(8);
  });

  it(`shows at most ${MAX_SHOWN}, and says how many matched`, () => {
    const many: DirectoryList = {
      roots: [{ root: CODE, dirs: Array.from({ length: 312 }, (_, i) => ({ path: `project-${String(i).padStart(3, '0')}` })), truncated: false }],
    };
    const { options } = directoryOptions(many, [CODE]);
    const all = matchDirectories(options, '');
    expect(all.total).toBe(312);
    expect(all.shown).toHaveLength(MAX_SHOWN);
    expect(all.shown[0]?.label).toBe('~/code/project-000');
    const some = matchDirectories(options, 'project-01');
    expect(some.total).toBe(10);
    expect(some.shown.map((option) => option.rel)).toEqual(Array.from({ length: 10 }, (_, i) => `project-01${i}`));
  });

  it('counts directories', () => {
    expect(directoryCount(1)).toBe('1 directory');
    expect(directoryCount(1340)).toBe('1,340 directories');
  });
});

describe('a typed directory', () => {
  it('is sent as typed when absolute, and a ~/ path under the root whose shortened form starts it, the longest winning', () => {
    const roots = [CODE, `${CODE}/pitwall`, SRV];
    expect(resolveTypedDirectory(`  ${CODE}/outpost  `, roots)).toBe(`${CODE}/outpost`);
    expect(resolveTypedDirectory('~/code/outpost', roots)).toBe(`${CODE}/outpost`);
    expect(resolveTypedDirectory('~/code', roots)).toBe(CODE);
    expect(resolveTypedDirectory('~/code/pitwall/web', roots)).toBe(`${CODE}/pitwall/web`);
    // Not a root: left for the problem to explain.
    expect(resolveTypedDirectory('~/codex/outpost', roots)).toBe('~/codex/outpost');
    expect(resolveTypedDirectory('~/elsewhere', roots)).toBe('~/elsewhere');
    expect(resolveTypedDirectory('relative/path', roots)).toBe('relative/path');
  });

  it('maps ~/ alone under a root that is the home directory itself', () => {
    expect(resolveTypedDirectory('~/notes', ['/Users/example'])).toBe('/Users/example/notes');
    expect(resolveTypedDirectory('~', ['/Users/example'])).toBe('/Users/example');
  });

  it("says what's wrong, with the open tab's rule (W38)", () => {
    const roots = [CODE, OSS];
    const problem = (text: string, tab?: string) => typedDirectoryProblem(text, resolveTypedDirectory(text, roots), roots, tab);
    expect(problem('  ')).toBe('Choose a directory.');
    expect(problem('outpost')).toBe('Use an absolute path, or one that starts with ~/.');
    expect(problem('~/elsewhere')).toBe('Use a directory under ~/code or ~/oss.');
    expect(problem('~/elsewhere', CODE)).toBe('Use a directory under ~/code.');
    expect(problem('~/oss/blog', CODE)).toBe('Use a directory under ~/code. ~/oss has its own tab.');
    expect(problem('~/code/outpost/deep/er/than/three', CODE)).toBeUndefined();
    expect(problem('/etc')).toBe('Use a directory under ~/code or ~/oss.');
  });
});
