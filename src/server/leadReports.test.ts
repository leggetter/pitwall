// A worker's newest report, held and read again in the background (W218 piece 2): one read at a time,
// again only once the session is active again or its lead's name changes, failures read as none.
import { describe, expect, it } from 'vitest';
import { LeadReports, REPORTS_HELD_MAX, type ReadReport } from './leadReports.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const T1 = '2026-11-27T10:42:00.000Z';

const worker = (sessionId: string, lastActivityAt?: string) => ({
  sessionId,
  cwd: '/tmp/pitwall-test-root/repo',
  startedAt: '2026-11-27T09:00:00.000Z',
  ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
});

function setup(read: ReadReport) {
  let changes = 0;
  const reports = new LeadReports({ read, onChange: () => changes++ });
  return { reports, changes: () => changes };
}

describe('LeadReports', () => {
  it('answers nothing at first, reads in the background, then answers what it read and says so once', async () => {
    const calls: string[] = [];
    const { reports, changes } = setup(async (id, _cwd, name) => (calls.push(`${id}:${name}`), { at: T1 }));
    expect(reports.reportedAt(worker('w1'), 'pitwall-test-lead')).toBeUndefined();
    await settle();
    expect(calls).toEqual(['w1:pitwall-test-lead']);
    expect(changes()).toBe(1);
    expect(reports.reportedAt(worker('w1'), 'pitwall-test-lead')).toBe(T1);
    await settle();
    // Nothing new: no read.
    expect(calls).toHaveLength(1);
    expect(changes()).toBe(1);
  });

  it('reads again once the session is active again, or its lead’s name changes', async () => {
    let calls = 0;
    const { reports } = setup(async () => (calls++, { at: T1 }));
    reports.reportedAt(worker('w1'), 'pitwall-test-lead');
    await settle();
    reports.reportedAt(worker('w1', '2026-11-27T11:00:00.000Z'), 'pitwall-test-lead');
    await settle();
    expect(calls).toBe(2);
    // A new name: what's held was for the old one, so nothing until it's read.
    expect(reports.reportedAt(worker('w1', '2026-11-27T11:00:00.000Z'), 'pitwall-test-renamed')).toBeUndefined();
    await settle();
    expect(calls).toBe(3);
  });

  it('reads one at a time', async () => {
    let running = 0;
    let most = 0;
    const { reports } = setup(async () => {
      running++;
      most = Math.max(most, running);
      await settle();
      running--;
      return {};
    });
    for (const id of ['w1', 'w2', 'w3']) reports.reportedAt(worker(id), 'pitwall-test-lead');
    for (let i = 0; i < 6; i++) await settle();
    expect(most).toBe(1);
  });

  it('reads a failed or unreadable read as none, without telling, until the session is active again', async () => {
    let calls = 0;
    const { reports, changes } = setup(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return undefined;
    });
    reports.reportedAt(worker('w1'), 'pitwall-test-lead');
    await settle();
    expect(reports.reportedAt(worker('w1'), 'pitwall-test-lead')).toBeUndefined();
    await settle();
    expect(calls).toBe(1);
    expect(changes()).toBe(0);
    reports.reportedAt(worker('w1', '2026-11-27T11:00:00.000Z'), 'pitwall-test-lead');
    await settle();
    expect(calls).toBe(2);
  });

  it('holds at most REPORTS_HELD_MAX workers', async () => {
    let calls = 0;
    const { reports } = setup(async () => (calls++, { at: T1 }));
    for (let i = 0; i <= REPORTS_HELD_MAX; i++) reports.reportedAt(worker(`w${i}`), 'pitwall-test-lead');
    for (let i = 0; i < 4; i++) await settle();
    expect(calls).toBe(REPORTS_HELD_MAX + 1);
    // The first went, so it's read again; the last is held.
    expect(reports.reportedAt(worker(`w${REPORTS_HELD_MAX}`), 'pitwall-test-lead')).toBe(T1);
    expect(reports.reportedAt(worker('w0'), 'pitwall-test-lead')).toBeUndefined();
  });
});
