// The supervisor's state file (M5, W113): the session id and the prompt's version, 0600, read strictly.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSupervisorRecord, supervisorStateFile } from './state.js';

const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-supervisor-state-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let dirs = 0;
const fresh = () => {
  const dir = path.join(tmp, `dir-${++dirs}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
};

describe('parseSupervisorRecord()', () => {
  it('takes exactly a UUID session id and a positive whole version', () => {
    expect(parseSupervisorRecord(JSON.stringify({ sessionId: SESSION, promptVersion: 1 }))).toEqual({ sessionId: SESSION, promptVersion: 1 });
    for (const text of [
      '',
      'null',
      '[]',
      JSON.stringify({ sessionId: SESSION }),
      JSON.stringify({ sessionId: SESSION, promptVersion: 1, text: 'a message' }),
      JSON.stringify({ sessionId: 'deploy', promptVersion: 1 }),
      JSON.stringify({ sessionId: SESSION.toUpperCase(), promptVersion: 1 }),
      JSON.stringify({ sessionId: SESSION, promptVersion: 0 }),
      JSON.stringify({ sessionId: SESSION, promptVersion: 1.5 }),
      JSON.stringify({ sessionId: SESSION, promptVersion: '1' }),
    ]) {
      expect(parseSupervisorRecord(text)).toBeUndefined();
    }
  });
});

describe('supervisorStateFile()', () => {
  it('writes the record at 0600 by rename, holding nothing else, and reads it back', () => {
    const dir = fresh();
    const store = supervisorStateFile(dir);
    expect(store.read()).toBeUndefined();
    expect(store.write({ sessionId: SESSION, promptVersion: 1 })).toBe(true);
    const file = path.join(dir, 'state.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ sessionId: SESSION, promptVersion: 1 });
    expect(store.read()).toEqual({ sessionId: SESSION, promptVersion: 1 });
  });

  it('counts a symbolic link, a folder, a big file or another shape as none', () => {
    const dir = fresh();
    const target = path.join(dir, 'elsewhere.json');
    writeFileSync(target, JSON.stringify({ sessionId: SESSION, promptVersion: 1 }));
    symlinkSync(target, path.join(dir, 'state.json'));
    expect(supervisorStateFile(dir).read()).toBeUndefined();
    const big = fresh();
    writeFileSync(path.join(big, 'state.json'), JSON.stringify({ sessionId: SESSION, promptVersion: 1, pad: 'x'.repeat(5000) }));
    expect(supervisorStateFile(big).read()).toBeUndefined();
    const folder = fresh();
    mkdirSync(path.join(folder, 'state.json'));
    expect(supervisorStateFile(folder).read()).toBeUndefined();
  });

  it('fails soft when it can’t write, and says so in pitwall’s words', () => {
    const logs: string[] = [];
    const store = supervisorStateFile(path.join(tmp, 'missing', 'dir'), (message) => logs.push(message));
    expect(store.write({ sessionId: SESSION, promptVersion: 1 })).toBe(false);
    expect(logs[0]).toContain("couldn't save the supervisor's session id");
  });
});
