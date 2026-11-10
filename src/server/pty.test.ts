import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSpawnHelper, makeExecutable, ptySpawner, type PtyProcess } from './pty.js';

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A made-up node-pty install with spawn-helper at each of `dirs`, mode 0644 as 1.1.0's macOS prebuilds ship it. */
function fakeInstall(dirs: string[]): string {
  dir = mkdtempSync(join(tmpdir(), 'pitwall-pty-'));
  for (const sub of dirs) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, 'spawn-helper'), '');
    chmodSync(join(dir, sub, 'spawn-helper'), 0o644);
  }
  return dir;
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe('findSpawnHelper', () => {
  it('prefers node-pty’s own build to the prebuild', () => {
    const root = fakeInstall(['build/Release', 'prebuilds/darwin-arm64']);
    expect(findSpawnHelper(root, 'darwin-arm64')).toBe(join(root, 'build/Release/spawn-helper'));
  });

  it('falls back to the prebuild for this platform and architecture', () => {
    const root = fakeInstall(['prebuilds/darwin-x64', 'prebuilds/darwin-arm64']);
    expect(findSpawnHelper(root, 'darwin-arm64')).toBe(join(root, 'prebuilds/darwin-arm64/spawn-helper'));
  });

  it('is undefined when there is no helper', () => {
    expect(findSpawnHelper(fakeInstall([]), 'darwin-arm64')).toBeUndefined();
  });
});

describe('makeExecutable', () => {
  it('sets the execute bit when a reinstall has taken it away again (W169)', () => {
    const helper = join(fakeInstall(['prebuilds/darwin-arm64']), 'prebuilds/darwin-arm64/spawn-helper');
    makeExecutable(helper);
    expect(mode(helper)).toBe(0o755);
    // npm ci under a running server: the file comes back as 0644.
    chmodSync(helper, 0o644);
    makeExecutable(helper);
    expect(mode(helper)).toBe(0o755);
  });

  it('leaves an executable helper as it is', () => {
    const helper = join(fakeInstall(['build/Release']), 'build/Release/spawn-helper');
    chmodSync(helper, 0o700);
    makeExecutable(helper);
    expect(mode(helper)).toBe(0o700);
  });

  it('never follows a link, and adds execute bits only, never read ones (W180, F1)', () => {
    const root = fakeInstall(['prebuilds/darwin-arm64']);
    const helper = join(root, 'prebuilds/darwin-arm64/spawn-helper');
    // A private file of the user's, with a link to it where the helper is.
    const secret = join(root, 'secret');
    writeFileSync(secret, 'made up');
    chmodSync(secret, 0o600);
    rmSync(helper);
    symlinkSync(secret, helper);
    makeExecutable(helper);
    expect(mode(secret)).toBe(0o600);
    expect(lstatSync(helper).isSymbolicLink()).toBe(true);
    // A helper of 0600 gets its execute bits, and no read bit.
    rmSync(helper);
    writeFileSync(helper, '');
    chmodSync(helper, 0o600);
    makeExecutable(helper);
    expect(mode(helper)).toBe(0o711);
  });

  it('does not throw when the helper is gone', () => {
    expect(() => makeExecutable(join(fakeInstall([]), 'spawn-helper'))).not.toThrow();
  });
});

describe('ptySpawner', () => {
  it('makes the helper executable before every spawn, not only the first (W169)', () => {
    const helper = join(fakeInstall(['prebuilds/darwin-arm64']), 'prebuilds/darwin-arm64/spawn-helper');
    const modesAtSpawn: number[] = [];
    let loads = 0;
    const spawn = ptySpawner(() => {
      loads += 1;
      return {
        helper,
        spawn: (() => {
          modesAtSpawn.push(mode(helper));
          return {} as PtyProcess;
        }) as never,
      };
    });
    const options = { cols: 80, rows: 24, cwd: '/', env: {}, name: 'xterm-256color' };
    spawn('/bin/echo', [], options);
    // npm ci under a running server: the file comes back as 0644.
    chmodSync(helper, 0o644);
    spawn('/bin/echo', [], options);
    expect(modesAtSpawn).toEqual([0o755, 0o755]);
    expect(loads).toBe(1);
  });
});
