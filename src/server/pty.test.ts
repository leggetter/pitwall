import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeStrayTerminals, findSpawnHelper, makeExecutable, ptySpawner, type FdTable, type PtyProcess } from './pty.js';

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
    // Never keeps a setuid or setgid bit (W180, N6).
    chmodSync(helper, 0o6600);
    makeExecutable(helper);
    expect(statSync(helper).mode & 0o7777).toBe(0o711);
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

/**
 * A made-up descriptor table: `open` maps each descriptor to whether it's a terminal. A spawn
 * adds what node-pty 1.1.0's macOS spawn leaves (W202): the master, the slave and a spare /dev/ptmx.
 */
function fakeFds(open: Map<number, boolean>) {
  const closed: number[] = [];
  const fds: FdTable = {
    list: () => [...open.keys()],
    isTerminal: (fd) => open.get(fd) ?? false,
    close: (fd) => {
      closed.push(fd);
      open.delete(fd);
    },
  };
  return { fds, closed };
}

const OPTIONS = { cols: 80, rows: 24, cwd: '/', env: {}, name: 'xterm-256color' };

describe('closing the terminals node-pty leaves open (W202)', () => {
  /** A spawner whose spawn opens `opened` (descriptor, is a terminal) and returns a PTY whose master is `master`. */
  function leakySpawner(open: Map<number, boolean>, fds: FdTable, opened: [number, boolean][], master: unknown) {
    return ptySpawner(
      () => ({
        helper: undefined,
        spawn: (() => {
          for (const [fd, terminal] of opened) open.set(fd, terminal);
          return { fd: master } as unknown as PtyProcess;
        }) as never,
      }),
      fds,
    );
  }

  it('closes each terminal the spawn opened except the master, and nothing else', () => {
    // Already open: stdio, a terminal pitwall was started from, another attach's master.
    const open = new Map<number, boolean>([[0, true], [1, true], [2, true], [5, false], [9, true]]);
    const { fds, closed } = fakeFds(open);
    // The spare /dev/ptmx (11), the master (12), the slave (13), and the exit watcher's kqueue (14).
    const spawn = leakySpawner(open, fds, [[11, true], [12, true], [13, true], [14, false]], 12);
    spawn('claude', ['attach', 'abc'], OPTIONS);
    expect(closed.sort()).toEqual([11, 13]);
    expect([...open.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 5, 9, 12, 14]);
  });

  it('closes nothing when the master is not known, since it could be any of them', () => {
    const open = new Map<number, boolean>([[0, true]]);
    const { fds, closed } = fakeFds(open);
    leakySpawner(open, fds, [[11, true], [12, true]], undefined)('claude', [], OPTIONS);
    expect(closed).toEqual([]);
  });

  it('closes nothing when the descriptors cannot be listed, before the spawn or after', () => {
    const open = new Map<number, boolean>();
    const { fds, closed } = fakeFds(open);
    const unlistable: FdTable = { ...fds, list: () => { throw new Error('no /dev/fd'); } };
    expect(() => leakySpawner(open, unlistable, [[11, true], [12, true]], 12)('claude', [], OPTIONS)).not.toThrow();
    expect(closed).toEqual([]);
    let calls = 0;
    const failsAfter: FdTable = { ...fds, list: () => (calls++ === 0 ? [] : (() => { throw new Error('gone'); })()) };
    leakySpawner(open, failsAfter, [[21, true], [22, true]], 22)('claude', [], OPTIONS);
    expect(closed).toEqual([]);
  });

  it('never throws when a check or a close fails, and still closes the rest', () => {
    const open = new Map<number, boolean>();
    const { fds, closed } = fakeFds(open);
    const flaky: FdTable = {
      ...fds,
      isTerminal: (fd) => {
        if (fd === 11) throw new Error('EBADF');
        return fds.isTerminal(fd);
      },
      close: (fd) => {
        if (fd === 13) throw new Error('EBADF');
        fds.close(fd);
      },
    };
    const spawn = leakySpawner(open, flaky, [[11, true], [12, true], [13, true], [15, true]], 12);
    expect(() => spawn('claude', [], OPTIONS)).not.toThrow();
    expect(closed).toEqual([15]);
  });

  it('closeStrayTerminals leaves everything when there was no list from before the spawn', () => {
    const open = new Map<number, boolean>([[11, true], [12, true]]);
    const { fds, closed } = fakeFds(open);
    closeStrayTerminals(fds, undefined, { fd: 12 } as unknown as PtyProcess);
    expect(closed).toEqual([]);
  });
});
