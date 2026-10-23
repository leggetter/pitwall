import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectCwd, isWithin, matchRoot, resolveCwd, resolveRoots } from './roots.js';

describe('isWithin', () => {
  it('matches the directory itself and anything below it', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c/d')).toBe(true);
  });

  it('does not treat a shared string prefix as containment', () => {
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
    expect(isWithin('/a/b', '/a/b-c/d')).toBe(false);
  });

  it('rejects parents and siblings', () => {
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/a/c')).toBe(false);
    expect(isWithin('/a/b', '/')).toBe(false);
  });

  it('accepts names that only start with two dots', () => {
    expect(isWithin('/a', '/a/..hidden')).toBe(true);
  });

  it('works for the filesystem root', () => {
    expect(isWithin('/', '/anything/at/all')).toBe(true);
  });
});

describe('matchRoot', () => {
  const roots = ['/work', '/work/projects', '/other'];

  it('returns the root a directory sits in', () => {
    expect(matchRoot('/other/x', roots)).toBe('/other');
    expect(matchRoot('/work', roots)).toBe('/work');
  });

  it('prefers the longest of nested roots', () => {
    expect(matchRoot('/work/projects/site', roots)).toBe('/work/projects');
    expect(matchRoot('/work/projects', roots)).toBe('/work/projects');
    expect(matchRoot('/work/projectsX', roots)).toBe('/work');
  });

  it('prefers the longest root whatever order the roots are in', () => {
    expect(matchRoot('/work/projects/site', ['/work/projects', '/work'])).toBe('/work/projects');
  });

  it('drops directories outside every root', () => {
    expect(matchRoot('/elsewhere', roots)).toBeUndefined();
    expect(matchRoot('/workshop', roots)).toBeUndefined();
  });
});

describe('resolveRoots and resolveCwd', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-roots-')));
    await mkdir(path.join(dir, 'real', 'repo'), { recursive: true });
    await symlink(path.join(dir, 'real'), path.join(dir, 'link'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves symlinks and drops duplicates, keeping order', async () => {
    const roots = await resolveRoots([path.join(dir, 'link'), path.join(dir, 'real'), dir]);
    expect(roots).toEqual([path.join(dir, 'real'), dir]);
  });

  it('keeps a root that does not exist as its absolute path', async () => {
    const missing = path.join(dir, 'not-yet');
    expect(await resolveRoots([missing])).toEqual([missing]);
  });

  it('resolves a cwd that exists, and keeps one that does not as given', async () => {
    expect(await resolveCwd(path.join(dir, 'link', 'repo'))).toBe(path.join(dir, 'real', 'repo'));
    expect(await resolveCwd(path.join(dir, 'link', 'gone'))).toBe(path.join(dir, 'link', 'gone'));
  });

  it('says a cwd is missing only when realpath fails with ENOENT', async () => {
    expect(await inspectCwd(path.join(dir, 'link', 'repo'))).toEqual({ path: path.join(dir, 'real', 'repo'), missing: false });
    expect(await inspectCwd(path.join(dir, 'gone'))).toEqual({ path: path.join(dir, 'gone'), missing: true });

    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(await inspectCwd('/work/locked', () => Promise.reject(denied))).toEqual({ path: '/work/locked', missing: false });
    expect(await inspectCwd('/work/odd', () => Promise.reject('not an error'))).toEqual({ path: '/work/odd', missing: false });
  });

  it('matches a session reached through a symlink to the real root', async () => {
    const roots = await resolveRoots([path.join(dir, 'link')]);
    const cwd = await resolveCwd(path.join(dir, 'link', 'repo'));
    expect(matchRoot(cwd, roots)).toBe(path.join(dir, 'real'));
  });
});
