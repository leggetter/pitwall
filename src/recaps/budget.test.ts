// The day's recap count on disk (budget.ts, W110's review): only the day, the calls and the cost, a
// 0600 file written by rename beside the empty recap folder, and anything odd read as no count.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetFile, parseDayCount, RECAP_BUDGET_FILE } from './budget.js';

let tmp: string;
let n = 0;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-budget-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = join(tmp, `home-${++n}`);
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

describe('budgetFile', () => {
  it('writes the day, the calls and the cost alone, 0600, by rename, and reads them back', async () => {
    const dir = await home();
    await mkdir(join(dir, 'recap'), { mode: 0o700 });
    const store = budgetFile(dir);
    expect(store.read()).toBeUndefined();
    store.write({ day: '2026-10-29', calls: 12, costUsd: 0.0131 });
    expect(store.read()).toEqual({ day: '2026-10-29', calls: 12, costUsd: 0.0131 });
    expect(JSON.parse(await readFile(join(dir, RECAP_BUDGET_FILE), 'utf8'))).toEqual({ day: '2026-10-29', calls: 12, costUsd: 0.0131 });
    if (process.platform !== 'win32') expect((await stat(join(dir, RECAP_BUDGET_FILE))).mode & 0o777).toBe(0o600);
    // No temporary file left, and nothing in the recap calls' folder.
    expect((await readdir(dir)).sort()).toEqual(['recap', RECAP_BUDGET_FILE]);
    expect(await readdir(join(dir, 'recap'))).toEqual([]);
    store.write({ day: '2026-10-29', calls: 13, costUsd: 0.0142 });
    expect(budgetFile(dir).read()).toEqual({ day: '2026-10-29', calls: 13, costUsd: 0.0142 });
  });

  it("reads anything odd as no count: a symbolic link, a directory, a big file or one that isn't the shape", async () => {
    const dir = await home();
    const file = join(dir, RECAP_BUDGET_FILE);
    const store = budgetFile(dir);
    for (const text of ['not json', '[]', '{"day":"today","calls":1,"costUsd":0}', '{"day":"2026-10-29","calls":-1,"costUsd":0}', '{"day":"2026-10-29","calls":1.5,"costUsd":0}', '{"day":"2026-10-29","calls":1}', `{"day":"2026-10-29","calls":1,"costUsd":0,"pad":"${'x'.repeat(5000)}"}`]) {
      await writeFile(file, text);
      expect(store.read(), text.slice(0, 40)).toBeUndefined();
    }
    await rm(file);
    const elsewhere = join(dir, 'elsewhere.json');
    await writeFile(elsewhere, '{"day":"2026-10-29","calls":1,"costUsd":0}');
    await symlink(elsewhere, file);
    expect(store.read()).toBeUndefined();
    await rm(file);
    await mkdir(file);
    expect(store.read()).toBeUndefined();
  });

  it("fails soft when it can't write, and says so once", async () => {
    const logs: string[] = [];
    const store = budgetFile(join(tmp, 'missing-parent', 'home'), (message) => logs.push(message));
    store.write({ day: '2026-10-29', calls: 1, costUsd: 0 });
    store.write({ day: '2026-10-29', calls: 2, costUsd: 0 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/couldn't save today's recap count/);
  });
});

describe('parseDayCount', () => {
  it('takes a day, a whole number of calls and a cost, and nothing else matters', () => {
    expect(parseDayCount('{"day":"2026-1-9","calls":0,"costUsd":0}')).toEqual({ day: '2026-1-9', calls: 0, costUsd: 0 });
    expect(parseDayCount('{"day":"2026-10-29","calls":3,"costUsd":0.003,"other":true}')).toEqual({ day: '2026-10-29', calls: 3, costUsd: 0.003 });
  });
});
