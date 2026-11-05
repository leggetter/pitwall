// A session row's "also in" (W149): the repos a session worked in under another root than its group's,
// which Main repo no longer moves it to, quietly at the end of line 2. Made-up sessions only.

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SessionSummary, WorkedIn } from '../../../src/shared/protocol.js';
import { group, minutesAgo, session } from '../test/fixtures.js';
import { elsewhereText, SessionRow } from './SessionRow.js';

const WORK = '/Users/example/work';
const PERSONAL = '/Users/example/personal';
const repo = (root: string, name: string, changes: number): WorkedIn => ({ key: `${root}/${name}`, label: name, root, calls: changes, changes, lastAt: minutesAgo(1) });
const home = { key: WORK, label: 'work', kind: 'directory' as const, root: WORK };

function line2(s: SessionSummary, showGroup = false) {
  render(
    <ul>
      <SessionRow session={s} group={group({ ...home, sessions: [s] })} showGroup={showGroup} />
    </ul>,
  );
  return document.querySelector<HTMLElement>('li.session .session-what');
}

describe('elsewhereText', () => {
  it('names the most changed repo under another root, with +N for more, and nothing for none', () => {
    const s = session({ cwd: WORK, workedIn: [repo(PERSONAL, 'blog', 1), repo(WORK, 'api', 9), repo(PERSONAL, 'skills', 6), repo(PERSONAL, 'notes', 2)] });
    expect(elsewhereText(s, { root: WORK })).toBe('also in skills +2');
    expect(elsewhereText(s, { root: PERSONAL })).toBe('also in api');
    expect(elsewhereText(session({ cwd: WORK, workedIn: [repo(WORK, 'api', 9)] }), { root: WORK })).toBeUndefined();
    expect(elsewhereText(session({ cwd: WORK }), { root: WORK })).toBeUndefined();
  });

  it("names a root that is itself the repo by the root's path", () => {
    const s = session({ cwd: WORK, workedIn: [{ ...repo(PERSONAL, 'x', 1), key: PERSONAL, label: 'personal' }] });
    expect(elsewhereText(s, { root: WORK })).toBe('also in ~/personal');
  });
});

describe('the row', () => {
  it('ends line 2 with it, after what comes before and a hidden " · ", in a group list too', () => {
    const s = session({ cwd: WORK, workedIn: [repo(PERSONAL, 'skills', 6)] });
    const withLabel = line2(s, true);
    expect(withLabel?.querySelector('.session-elsewhere')?.textContent).toBe(' · also in skills');
    expect(withLabel?.querySelector('.session-elsewhere .session-what-sep')?.getAttribute('aria-hidden')).toBe('true');
    document.body.innerHTML = '';
    const inGroup = line2(s);
    expect(inGroup?.querySelector('.session-group')).toBeNull();
    expect(inGroup?.textContent?.endsWith('also in skills')).toBe(true);
  });

  it('shows "+2" and reads it out as "and 2 more repos"', () => {
    const el = line2(session({ cwd: WORK, workedIn: [repo(PERSONAL, 'skills', 6), repo(PERSONAL, 'blog', 2), repo(PERSONAL, 'notes', 1)] }))?.querySelector('.session-elsewhere');
    expect(el?.querySelector('[aria-hidden="true"]:not(.session-what-sep)')?.textContent).toBe(' +2');
    expect(el?.querySelector('.visually-hidden')?.textContent).toBe(' and 2 more repos');
  });

  it('has none for a session that worked only under its own root', () => {
    expect(line2(session({ cwd: WORK, workedIn: [repo(WORK, 'api', 6)] }), true)?.querySelector('.session-elsewhere')).toBeNull();
  });
});
