// Made-up data for the #uikit gallery (W19). Nothing here comes from a real session or from this
// machine: every session is named pitwall-test-*, every path is under /Users/example, and all the
// text is invented. Built once, when the gallery loads, so each session keeps one id.

import type {
  ConversationEntry,
  DirectoryList,
  IndexSnapshot,
  RelayAlert,
  RelayExchange,
  RelayOff,
  SessionGroup,
  SessionSummary,
  SubagentSummary,
} from '../../../src/shared/protocol.js';

/** The gallery's clock. Fixture times are set back from it, so "4m ago" reads as written. */
export const NOW = Date.now();

export function ago(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

export const ROOT = '/Users/example/code';
export const OTHER_ROOT = '/Users/example/work';
/** A third root, for the root tabs (W38). */
export const THIRD_ROOT = '/Users/example/personal';
export const APP_DIR = `${ROOT}/pitwall-test-app`;
export const JOBS_DIR = `${ROOT}/pitwall-test-jobs`;
export const NOTES_DIR = `${ROOT}/pitwall-test-notes`;
export const SERVICE_DIR = `${OTHER_ROOT}/pitwall-test-service`;

let count = 0;

/**
 * A session named `pitwall-test-<name>`: an idle interactive session in APP_DIR unless `overrides`
 * say otherwise. Overrides set to `undefined` remove the field, as JSON would.
 */
export function session(name: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  count += 1;
  const merged: SessionSummary = {
    sessionId: `00000000-0000-4000-8000-${String(count).padStart(12, '0')}`,
    name: `pitwall-test-${name}`,
    kind: 'interactive',
    cwd: APP_DIR,
    pid: 41_000 + count,
    alive: true,
    status: 'idle',
    startedAt: ago(180),
    stale: false,
    finished: false,
    lastActivityAt: ago(4),
    lastUserPrompt: 'Add a retry with backoff to the export job.',
    transcript: 'ok',
    ...overrides,
  };
  for (const key of Object.keys(merged) as (keyof SessionSummary)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged;
}

/** A background session, with a short id for `claude attach`. */
export function background(name: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session(name, { kind: 'background', shortId: `pt${String(count + 1).padStart(6, '0')}`, status: undefined, ...overrides });
}

/** A background session that has finished: no process, and done, stopped or failed. */
export function finished(name: string, state: 'done' | 'stopped' | 'failed', overrides: Partial<SessionSummary> = {}): SessionSummary {
  return background(name, { state, alive: false, pid: undefined, finished: true, lastActivityAt: ago(95), ...overrides });
}

/**
 * An interactive session that has ended (W67): its process exited, as when its terminal closed, so it's
 * finished, with no process, status or state, and listed from its transcript. Ended two days ago unless
 * `overrides` say otherwise.
 */
export function endedSession(name: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session(name, { ended: true, finished: true, alive: false, pid: undefined, status: undefined, lastActivityAt: ago(2 * 24 * 60), ...overrides });
}

export function group(label: string, sessions: SessionSummary[], overrides: Partial<SessionGroup> = {}): SessionGroup {
  return { key: `${ROOT}/${label}`, label, kind: 'git', root: ROOT, sessions, ...overrides };
}

export function snapshot(groups: SessionGroup[], overrides: Partial<IndexSnapshot> = {}): IndexSnapshot {
  return { generatedAt: ago(0.05), roots: [ROOT], groups, source: { ok: true }, ...overrides };
}

const LONG_REPLY =
  'The export job now retries a failed batch three times, waiting 1, 4 and 16 seconds, and gives up with the ' +
  'error from the last attempt. Retries reuse the batch id, so a batch that half-wrote before failing is ' +
  'replaced rather than duplicated. I added tests for a batch that fails once, one that fails every time, and ' +
  'one that times out, and the full suite passes. I left the timeout at 30 seconds, as you asked.';

/**
 * Every status a row can show, one row each, named after it. The index sets needsYou from each
 * session's context (W69); a blocked job whose own line asks nothing, as a resumed one's "send a
 * prompt to start", has none, and shows as idle.
 */
export const STATUS_ROWS: SessionSummary[] = [
  session('waiting', {
    status: 'waiting',
    waitingFor: 'permission prompt',
    needsYou: { reason: 'prompt' },
    lastUserPrompt: 'Add a retry with backoff to the export job.',
    lastActivityAt: ago(1),
  }),
  background('blocked', {
    state: 'blocked',
    status: 'idle',
    needsYou: { reason: 'claude-code', text: 'Should failed exports go to a quarantine folder, or back on the queue?' },
    lastUserPrompt: 'Move failed exports somewhere we can inspect them.',
    lastActivityAt: ago(2),
  }),
  session('asked-you', {
    title: 'CSV export for projects',
    titleSource: 'claude-code',
    askedYou: { reason: 'open-questions', excerpt: 'Should the CSV export include archived projects?' },
    needsYou: { reason: 'asked' },
    lastUserPrompt: 'Add a CSV export to the projects page.',
    lastActivityAt: ago(3),
  }),
  session('busy', { status: 'busy', lastActivityAt: ago(0.1) }),
  background('working', { state: 'working', lastActivityAt: ago(0.4) }),
  session('idle', { lastActivityAt: ago(6) }),
  session('unknown', { status: undefined, lastActivityAt: ago(9) }),
  session('not-running', {
    alive: false,
    pid: undefined,
    status: undefined,
    lastActivityAt: ago(40),
  }),
  background('done', { state: 'done', lastActivityAt: ago(12) }),
  background('stopped', { state: 'stopped', lastActivityAt: ago(14) }),
  background('failed', { state: 'failed', lastActivityAt: ago(16) }),
  background('stale', {
    state: 'blocked',
    waitingFor: 'permission prompt',
    stale: true,
    alive: false,
    pid: undefined,
    startedAt: ago(60 * 24 * 30),
    lastActivityAt: ago(60 * 24 * 12),
  }),
  endedSession('ended', { lastActivityAt: ago(60 * 20) }),
  // W69: resumed from pitwall in this run, waiting for your first prompt.
  background('restarted', { state: 'blocked', status: 'idle', needsYou: { reason: 'restarted' }, lastUserPrompt: 'Tidy the export docs.', lastActivityAt: ago(60 * 3) }),
  // W69: blocked, and pitwall couldn't read the job's file, so it still needs you.
  background('blocked-unread', { state: 'blocked', status: 'idle', needsYou: { reason: 'blocked' }, lastUserPrompt: 'Rotate the export bucket keys.', lastActivityAt: ago(5) }),
  // W69: blocked with Claude Code's "send a prompt to start", after pitwall restarted: nothing needs you, so no badge.
  background('blocked-idle', { state: 'blocked', status: 'idle', lastUserPrompt: 'Check the export queue depth.', lastActivityAt: ago(60 * 4) }),
];

/** Finished rows, which sit in a group's "Finished" list. */
export const FINISHED_ROWS: SessionSummary[] = [
  finished('finished-done', 'done', { cwd: JOBS_DIR }),
  finished('finished-asked', 'done', {
    cwd: JOBS_DIR,
    askedYou: { reason: 'question', excerpt: 'Do you want the old fixtures kept in a backup folder?' },
  }),
  finished('finished-stopped', 'stopped', { cwd: JOBS_DIR, lastActivityAt: ago(240) }),
  finished('finished-failed', 'failed', { cwd: JOBS_DIR, lastActivityAt: ago(60 * 26) }),
];

export function exchange(status: RelayExchange['status'], reply?: string): RelayExchange {
  return reply === undefined ? { sentAt: ago(7), status } : { sentAt: ago(7), status, reply: { at: ago(5), text: reply } };
}

/** A directory that has gone, as a removed worktree's has. */
const GONE_WORKTREE = `${APP_DIR}/.claude/worktrees/pitwall-test-export-fix`;

/**
 * A Finished section's rows with ended sessions in it (W67), all from the last ENDED_SHOWN_DAYS: one
 * that asked something, a finished background session among them, and one whose directory has gone.
 */
export const ENDED_ROWS: SessionSummary[] = [
  endedSession('ended-docs', { title: 'Update the getting started guide', titleSource: 'claude-code', lastActivityAt: ago(60 * 20), lastUserPrompt: 'Update the made-up getting started guide.' }),
  finished('done-beside-ended', 'done', { lastActivityAt: ago(60 * 30) }),
  endedSession('ended-asked', {
    lastActivityAt: ago(60 * 24 * 2),
    askedYou: { reason: 'question', excerpt: 'Should the made-up export keep archived projects?' },
  }),
  endedSession('ended-gone', { cwd: GONE_WORKTREE, cwdMissing: true, lastActivityAt: ago(60 * 24 * 5) }),
];

/** Ended sessions older than ENDED_SHOWN_DAYS, behind Show older (W67). */
export const OLDER_ENDED_ROWS: SessionSummary[] = [
  endedSession('ended-last-week', { lastActivityAt: ago(60 * 24 * 9) }),
  endedSession('ended-last-month', { lastActivityAt: ago(60 * 24 * 26) }),
];

/** Rows with long or awkward text, and the transcript notes. */
export const AWKWARD_ROWS: SessionSummary[] = [
  session('long-title', {
    title:
      'Investigate why the nightly export sometimes writes duplicate rows when two workers pick up the same batch after a retry',
    titleSource: 'claude-code',
  }),
  session('a-session-name-that-is-much-longer-than-most-names-are', {
    title: 'A title pitwall generated',
    titleSource: 'pitwall',
    cwd: `${APP_DIR}/packages/exporter/src/workers/batch/retry/strategies/exponential-backoff-with-jitter`,
  }),
  session('long-asked', {
    title: 'Retention for exported files',
    titleSource: 'claude-code',
    askedYou: {
      reason: 'open-questions',
      excerpt:
        'Should exported files older than 30 days be deleted by the nightly job, moved to the archive bucket first, or kept until someone removes them by hand?',
    },
    needsYou: { reason: 'asked' },
    lastActivityAt: ago(2),
  }),
  session('long-reason', {
    status: 'waiting',
    waitingFor: 'permission prompt for a command that writes outside the working directory',
    needsYou: { reason: 'prompt' },
    lastActivityAt: ago(1),
  }),
  background('long-needs', {
    state: 'blocked',
    status: 'idle',
    needsYou: {
      reason: 'claude-code',
      text: 'Which of the three made-up retention rules should the nightly export follow: delete after 30 days, archive after 30 days, or keep until someone removes the files by hand?',
    },
    lastActivityAt: ago(2),
  }),
  background('unbroken', {
    state: 'working',
    lastUserPrompt: `Check this id: pitwall-test-${'0123456789abcdef'.repeat(8)}`,
  }),
  session('no-prompt', { lastUserPrompt: undefined }),
  session('transcript-missing', { transcript: 'missing', lastUserPrompt: undefined }),
  session('transcript-unreadable', { transcript: 'unreadable', lastUserPrompt: undefined }),
];

/** A row in each of the states in the Session rows table, named after it. */
export const STATE_ROWS = {
  default: session('default', { status: 'busy', lastActivityAt: ago(0.2) }),
  hover: session('hover', { status: 'busy', lastActivityAt: ago(0.3) }),
  open: session('open', { status: 'busy', lastActivityAt: ago(2) }),
  needsYou: session('needs-you', { status: 'waiting', waitingFor: 'dialog open', needsYou: { reason: 'prompt' }, lastUserPrompt: 'Pick the export format for the archive.' }),
  needsYouOpen: session('needs-you-open', {
    status: 'waiting',
    waitingFor: 'permission prompt',
    needsYou: { reason: 'prompt' },
    lastUserPrompt: 'Delete the old export files.',
  }),
  finished: finished('finished', 'done', { cwd: JOBS_DIR }),
  ended: endedSession('state-ended', { lastActivityAt: ago(60 * 26) }),
};

// Groups, for the group sections and the dashboards.

/** A status row by its name, after pitwall-test-. */
export function statusRow(name: string): SessionSummary {
  const row = STATUS_ROWS.find((candidate) => candidate.name === `pitwall-test-${name}`);
  if (!row) throw new Error(`no status row ${name}`);
  return row;
}

const appSessions = [statusRow('waiting'), statusRow('blocked'), statusRow('busy'), statusRow('idle')];
export const APP_GROUP = group('pitwall-test-app', appSessions);
export const NOTES_GROUP = group('pitwall-test-notes', [session('notes', { cwd: NOTES_DIR, lastActivityAt: ago(30) })], {
  key: NOTES_DIR,
  kind: 'directory',
});
export const JOBS_GROUP = group('pitwall-test-jobs', [background('nightly', { cwd: JOBS_DIR, state: 'working', lastActivityAt: ago(1) }), ...FINISHED_ROWS], {
  key: JOBS_DIR,
});
export const ALL_FINISHED_GROUP = group('pitwall-test-archive', [
  finished('archive-done', 'done', { cwd: `${ROOT}/pitwall-test-archive` }),
  finished('archive-stopped', 'stopped', { cwd: `${ROOT}/pitwall-test-archive` }),
]);
export const SERVICE_GROUP = group('pitwall-test-service', [session('service', { cwd: SERVICE_DIR, status: 'busy' })], {
  key: SERVICE_DIR,
  root: OTHER_ROOT,
});
export const LONG_LABEL_GROUP = group(
  'pitwall-test-app/packages/a-package-directory-with-a-long-name-for-wrapping',
  [session('deep', { cwd: `${APP_DIR}/packages/a-package-directory-with-a-long-name-for-wrapping` })],
  { key: `${APP_DIR}/packages/a-package-directory-with-a-long-name-for-wrapping` },
);

/** The dashboard's list: groups in several states, with sessions that need you. */
export const LIST_SNAPSHOT = snapshot([APP_GROUP, JOBS_GROUP, NOTES_GROUP]);
/** The same, with nothing that needs you. */
const CALM_DIR = `${ROOT}/pitwall-test-calm`;
export const CALM_SNAPSHOT = snapshot([
  NOTES_GROUP,
  group('pitwall-test-calm', [session('calm-idle', { cwd: CALM_DIR }), session('calm-busy', { cwd: CALM_DIR, status: 'busy' })]),
]);
export const TWO_ROOTS_SNAPSHOT = snapshot([APP_GROUP, SERVICE_GROUP], { roots: [ROOT, OTHER_ROOT] });
/** Three roots, the third with no sessions: a tab each, ~/code's sessions needing you (W38). */
export const THREE_ROOTS = [ROOT, OTHER_ROOT, THIRD_ROOT];
export const THREE_ROOTS_SNAPSHOT = snapshot([APP_GROUP, NOTES_GROUP, SERVICE_GROUP], { roots: THREE_ROOTS });
export const EMPTY_SNAPSHOT = snapshot([]);
export const POLL_FAILED_SNAPSHOT = snapshot([NOTES_GROUP], {
  source: { ok: false, error: 'claude exited with code 1: pitwall-test made-up failure' },
});

/** The root's own directory, which the repo list labels with its path. */
export const ROOT_GROUP = group('code', [session('in-root', { cwd: ROOT, lastActivityAt: ago(12) })], { key: ROOT, kind: 'directory' });

/** Every kind of repo list item: a need-you badge, counts, the root's own directory, a finished-only group and a long label. */
export const REPO_LIST_SNAPSHOT = snapshot([APP_GROUP, JOBS_GROUP, NOTES_GROUP, ALL_FINISHED_GROUP, LONG_LABEL_GROUP, ROOT_GROUP]);

/** Two roots, each with groups: the repo list of one root's tab. */
export const TWO_ROOTS_LIST_SNAPSHOT = snapshot([APP_GROUP, NOTES_GROUP, SERVICE_GROUP, ROOT_GROUP], { roots: [ROOT, OTHER_ROOT] });

/** A hidden group that's in no snapshot (W35): a clone of another project's repo, last worked in weeks ago. */
export const GONE_HIDDEN = { root: ROOT, key: `${ROOT}/pitwall-test-old-clone`, label: 'pitwall-test-old-clone', kind: 'git' } as const;

/** Sessions whose names, titles and paths all have "export" in them, for the filter's highlight. */
const EXPORTS_DIR = `${ROOT}/pitwall-test-exports`;
export const HIGHLIGHT_SNAPSHOT = snapshot([
  group(
    'pitwall-test-exports',
    [
      session('export-retry', { title: 'Retry a failed export batch', titleSource: 'claude-code', cwd: `${EXPORTS_DIR}/packages/export`, status: 'busy' }),
      background('csv', { title: 'CSV exports for projects', state: 'working', cwd: `${EXPORTS_DIR}/jobs/nightly-export` }),
      session('docs', { title: 'Document the export format', titleSource: 'pitwall', cwd: `${EXPORTS_DIR}/docs` }),
      session('unrelated', { title: 'Tidy the README', cwd: `${EXPORTS_DIR}/docs` }),
    ],
    { key: EXPORTS_DIR },
  ),
  group('pitwall-test-exporter', [session('exporter', { cwd: `${ROOT}/pitwall-test-exporter` })]),
]);

// Each session in one group (W39): every group lists the sessions started in it and only those, the
// root's own included. The repos a session worked in beyond that are in its workedIn, each with its
// label, for the session view's worked-in line and the filter; pitwall-test-docs, which sessions only
// worked in, has no group.

export const API_DIR = `${ROOT}/pitwall-test-api`;
export const DOCS_DIR = `${ROOT}/pitwall-test-docs`;
export const SCRATCH_DIR = `${ROOT}/pitwall-test-scratch`;
const touched = (...keys: string[]) =>
  keys.map((key, index) => ({ key, label: key.slice(ROOT.length + 1), root: ROOT, calls: 40 - 10 * index, changes: index === 0 ? 3 : 0, lastAt: ago(2 + 20 * index) }));

/** Started in the app, then changed the API and read the docs: under the app alone. */
export const WORKED_MULTI = session('across-repos', {
  title: 'Retry exports end to end',
  titleSource: 'claude-code',
  status: 'waiting',
  waitingFor: 'permission prompt',
  needsYou: { reason: 'prompt' },
  lastUserPrompt: 'Make the API retry the export too, and update the docs.',
  lastActivityAt: ago(1),
  workedIn: touched(API_DIR, DOCS_DIR),
});
/** Started in the root itself, then worked in the API and the docs: under the root's own group. */
export const WORKED_FROM_ROOT = session('from-root', {
  cwd: ROOT,
  askedYou: { reason: 'question', excerpt: 'Should the API return 429 or 503 while an export retries?' },
  needsYou: { reason: 'asked' },
  lastUserPrompt: 'Look at how the API reports a retrying export.',
  lastActivityAt: ago(6),
  workedIn: touched(API_DIR, DOCS_DIR),
});
/** Started in a directory below the root that's in no repo, then wrote the docs: under the directory alone. */
export const WORKED_FROM_SCRATCH = session('scratch-notes', {
  cwd: SCRATCH_DIR,
  lastUserPrompt: 'Turn these notes into a page in the docs.',
  lastActivityAt: ago(9),
  workedIn: touched(DOCS_DIR),
});
const WORKED_APP_ONLY = session('app-only', { lastActivityAt: ago(3) });
const WORKED_API_ONLY = session('api-only', { cwd: API_DIR, status: 'busy', lastActivityAt: ago(0.2) });
/** Started in the root, and worked in no repo. */
export const WORKED_ROOT_ALONE = session('root-alone', { cwd: ROOT, lastUserPrompt: 'What is in this folder?', lastActivityAt: ago(30) });

export const WORKED_APP_GROUP = group('pitwall-test-app', [WORKED_MULTI, WORKED_APP_ONLY], { key: APP_DIR });
export const WORKED_API_GROUP = group('pitwall-test-api', [WORKED_API_ONLY], { key: API_DIR });
export const WORKED_SCRATCH_GROUP = group('pitwall-test-scratch', [WORKED_FROM_SCRATCH], { key: SCRATCH_DIR, kind: 'directory' });
export const WORKED_ROOT_GROUP = group('code', [WORKED_FROM_ROOT, WORKED_ROOT_ALONE], { key: ROOT, kind: 'directory' });

/** Six sessions, two of which need you, in four groups: none for pitwall-test-docs, where three of them worked. */
export const WORKED_SNAPSHOT = snapshot([WORKED_API_GROUP, WORKED_APP_GROUP, WORKED_SCRATCH_GROUP, WORKED_ROOT_GROUP]);

// Group sessions by (W42): two roots, ~/code and ~/work. pitwall-test-delivery-plan started in ~/code
// itself, worked most in pitwall-test-docs, which has no group, and less in pitwall-test-service,
// under ~/work. So Main repo lists it under pitwall-test-docs, Where it started under ~/code, and Every
// repo it worked in under both repos, one in each root's tab.

/** Started in ~/code itself: 180 changes in pitwall-test-docs, 3 in pitwall-test-service, under ~/work. */
export const PREFS_DELIVERY = session('delivery-plan', {
  title: 'Build the delivery plan',
  titleSource: 'claude-code',
  cwd: ROOT,
  status: 'waiting',
  waitingFor: 'permission prompt',
  needsYou: { reason: 'prompt' },
  lastUserPrompt: 'Draft the delivery plan in the docs, and check the service for the dates.',
  lastActivityAt: ago(1),
  workedIn: [
    { key: DOCS_DIR, label: 'pitwall-test-docs', root: ROOT, calls: 1600, changes: 180, lastAt: ago(1) },
    { key: SERVICE_DIR, label: 'pitwall-test-service', root: OTHER_ROOT, calls: 140, changes: 3, lastAt: ago(40) },
  ],
});
/** Started in ~/code itself, and worked in no repo: it stays in the root's own group in every mode. */
export const PREFS_ROOT_ALONE = session('prefs-root-alone', { cwd: ROOT, lastUserPrompt: 'What is in this folder?', lastActivityAt: ago(20) });
const PREFS_APP = session('prefs-app', { lastActivityAt: ago(5) });
const PREFS_SERVICE = session('prefs-service', { cwd: SERVICE_DIR, status: 'busy', lastActivityAt: ago(0.5) });

/** Two roots: ~/code's own group, pitwall-test-app, and pitwall-test-service under ~/work; none for pitwall-test-docs. */
export const PREFS_SNAPSHOT = snapshot(
  [
    group('code', [PREFS_DELIVERY, PREFS_ROOT_ALONE], { key: ROOT, kind: 'directory' }),
    group('pitwall-test-app', [PREFS_APP], { key: APP_DIR }),
    group('pitwall-test-service', [PREFS_SERVICE], { key: SERVICE_DIR, root: OTHER_ROOT }),
  ],
  { roots: [ROOT, OTHER_ROOT] },
);

/** One root with a long path, for the header's middle ellipsis. */
export const LONG_ROOT = '/Users/example/projects/pitwall-test-project-with-a-long-name/repositories';

/** More roots than the header has room for on one line, as tabs. */
export const LONG_ROOTS = [
  ROOT,
  OTHER_ROOT,
  '/Users/example/projects/pitwall-test-project-with-a-long-name/repositories',
  '/srv/pitwall-test/shared/checkouts',
];

/** A message nobody asked for, which may have been sent. */
export const RELAY_ALERT_SENT: RelayAlert = {
  at: ago(2),
  detail: 'The relay tried to send a message when pitwall hadn’t asked it to. The relay stopped before pitwall saw whether its gate blocked it.',
  count: 1,
  blocked: false,
  cause: 'unrequested',
};
/** A message nobody asked for, which the gate blocked. */
export const RELAY_ALERT_BLOCKED: RelayAlert = {
  at: ago(1),
  detail: "The relay tried to send a message when pitwall hadn’t asked it to. pitwall's gate blocked it, so nothing was sent.",
  count: 3,
  blocked: true,
  cause: 'unrequested',
};
/** A changed copy of your message, which may have been sent (W43). */
export const RELAY_ALERT_CHANGED: RelayAlert = {
  at: ago(1),
  detail: "The relay changed the text before sending it, first at line 33: the copy has 25 more characters from here, including a line break. pitwall couldn't tell whether its gate stopped it.",
  count: 1,
  blocked: false,
  cause: 'changed',
};
/** A changed copy the gate blocked that differed in more than its text, here one to another session, which pitwall doesn't try again (W52). */
export const RELAY_ALERT_CHANGED_BLOCKED: RelayAlert = {
  at: ago(1),
  detail: "The relay addressed the message to another session. pitwall's gate blocked it, so nothing was sent.",
  count: 2,
  blocked: true,
  cause: 'changed',
};
/** The relay trying your message again in the same turn, after the gate blocked its copy, which the gate blocked too (W52). */
export const RELAY_ALERT_REPEATED_BLOCKED: RelayAlert = {
  at: ago(1),
  detail: "The relay tried again to send one of your messages, in the same turn, after pitwall’s gate had blocked its copy. pitwall's gate blocked it, so nothing was sent.",
  count: 1,
  blocked: true,
  cause: 'repeated',
};
/** A repeat whose result pitwall never saw, so it may have been sent (W52). */
export const RELAY_ALERT_REPEATED_SENT: RelayAlert = {
  at: ago(1),
  detail: 'The relay tried again to send one of your messages, in the same turn, after pitwall’s gate had blocked its copy. Its turn ended before pitwall saw whether its gate blocked it.',
  count: 1,
  blocked: false,
  cause: 'repeated',
};
/** What a message delivered on pitwall's one more try says after Delivered (W52). */
export const RETRIED_DETAIL =
  "pitwall's gate stopped the relay's first copy of your message, because it didn't match, so pitwall tried once more, on a new relay, and the second copy went through. The first time, the relay changed the text before sending it, first at line 33: a space (U+0020) became a tab (U+0009).";
/** The alert that comes with the relay going off: its gate let a changed copy through. */
export const RELAY_ALERT_OFF: RelayAlert = {
  at: ago(2),
  detail: "The relay changed the text before sending it, first at line 4: U+2013 became U+002D. pitwall's gate didn't stop it.",
  count: 1,
  blocked: false,
  cause: 'changed',
};
/** The relay is off until pitwall restarts: the app strip shows. */
export const RELAY_OFF: RelayOff = { since: ago(2), reason: 'its gate let through a SendMessage call that didn’t match the request.' };

// Sessions for the session view, the message box and the terminal.

export const VIEW_INTERACTIVE = session('view-interactive', {
  title: 'Export retries',
  titleSource: 'claude-code',
  relay: exchange('delivered', 'Yes: the export job retries now, and the tests pass.'),
});
export const VIEW_BACKGROUND = background('view-background', { state: 'working', lastActivityAt: ago(1) });
export const VIEW_BACKGROUND_DONE = background('view-background-done', {
  state: 'done',
  alive: false,
  pid: undefined,
  finished: true,
});

/** A path with no break in it, longer than any line it sits on. */
const UNBROKEN = `/Users/example/code/pitwall-test-app/packages/exports/src/jobs/retry/${'batches-'.repeat(14)}backoff.test.ts`;

/**
 * The conversation every session view shows: one of each kind of entry, three tool calls folded with
 * an error, two folded without, one on its own, a reply cut short, a line with no break in it, and
 * markup, which shows as the text it is. Claude's messages and the other session's are markdown, as
 * the server sends them (W36).
 */
export const CONVERSATION: ConversationEntry[] = [
  { kind: 'user', at: ago(30), text: 'Add a retry with backoff to the export job. Keep the existing 30 second timeout.' },
  { kind: 'assistant', at: ago(29.5), text: "I'll read how the export job runs a batch before changing it.", markdown: true },
  { kind: 'tool', at: ago(29), toolName: 'Read', text: 'Read: src/export/job.ts' },
  { kind: 'tool', at: ago(28.8), toolName: 'Grep', text: 'Grep: retry in src/export' },
  { kind: 'tool', at: ago(28), toolName: 'Bash', text: 'Bash: npm test -- export', toolError: true },
  {
    kind: 'assistant',
    at: ago(27),
    text: 'One test fails before any change: it expects a batch to be written **once**.\nI kept that, and made a retry replace the batch rather than append to it.',
    markdown: true,
  },
  { kind: 'tool', at: ago(26), toolName: 'Edit', text: 'Edit: src/export/job.ts' },
  { kind: 'tool', at: ago(25.5), toolName: 'Bash', text: `Bash: npx vitest run src/export --reporter=verbose --testNamePattern="retries a failed batch" ${UNBROKEN}` },
  { kind: 'cross-session', at: ago(20), from: 'pitwall-test-reviewer', text: 'Please log each retry at `debug` level, with the attempt number.', markdown: true },
  { kind: 'notice', at: ago(18), text: 'Conversation compacted.' },
  { kind: 'assistant', at: ago(10), text: LONG_REPLY, truncated: true, markdown: true },
  { kind: 'user', at: ago(8), text: `Does the log line escape <b>tags</b> and <script>alert(1)</script> in a batch name? The test file is ${UNBROKEN}` },
  { kind: 'tool', at: ago(7.5), toolName: 'Bash', text: 'Bash: npm test -- export' },
  { kind: 'user', at: ago(6), text: 'Looks good. Any open questions?' },
  { kind: 'assistant', at: ago(5), text: 'None.', markdown: true },
];

/** What arrives after the conversation above, for "Jump to latest". */
export const NEWER_CONVERSATION: ConversationEntry[] = [
  { kind: 'user', at: ago(3), text: 'Then open a pull request for it.' },
  { kind: 'tool', at: ago(2.5), toolName: 'Bash', text: 'Bash: git push -u origin pitwall-test-export-retries' },
  { kind: 'assistant', at: ago(2), text: 'Pushed. The pull request is open, with the retry tests in its description.', markdown: true },
];

/** An older page, for "Load earlier". */
export const OLDER_CONVERSATION: ConversationEntry[] = [
  { kind: 'user', at: ago(90), text: 'What does the export job do when a batch fails?' },
  { kind: 'assistant', at: ago(89), text: 'It logs the error and moves on, so a failed batch is lost.', markdown: true },
];

// Markdown in messages (W36). Made up, in the shape of Claude's replies.

/** A message from Claude with every element of the subset in it. */
export const EVERY_ELEMENT = [
  '## Export retries',
  '',
  'The export job now retries a failed batch **three times**, waiting *1, 4 and 16 seconds*, and ***gives up*** with the last error. ~~It used to retry forever.~~',
  'A single newline is a line break, as in the terminal. `withRetry()` is inline code, and so is ``a `tick` inside``; an escaped \\*star\\* stays a star.',
  '',
  '### What changed',
  '',
  '1. `src/export/job.ts` calls `withRetry()`:',
  '   - each attempt reuses the batch id,',
  '   - so a half-written batch is replaced.',
  '2. Tests, with task markers left as text:',
  '   - [x] a batch that fails once',
  '   - [ ] a batch that times out',
  '',
  '```ts',
  'export const DELAYS_MS = [1_000, 4_000, 16_000]; // a long line, so the block scrolls sideways on its own, not the page',
  'for (const delay of DELAYS_MS) await sleep(delay);',
  '```',
  '',
  '| Attempt | Wait | Outcome | Batch file |',
  '|:--|--:|:-:|:--|',
  '| 1 | 1 s | failed | `/Users/example/code/pitwall-test-app/exports/batch-0042.csv` |',
  '| 2 | 4 s | **passed** | the same file, replaced |',
  '',
  '> The 30 second timeout is unchanged, as you asked.',
  '> > A quote inside a quote.',
  '',
  '---',
  '',
  'See [the retry notes](https://example.com/docs/retries), <https://example.com/changelog>, or https://example.com/export-retries.',
].join('\n');

/** A long message the server cut short inside a code block: the block runs to the end. */
export const CUT_IN_CODE = [
  'Here is the draft for the channel, ready to copy:',
  '',
  '```text',
  'Export retries are merged.',
  'A failed batch is retried three times, waiting 1, 4 and 16 seconds, and',
].join('\n');

/** Raw HTML and syntax the renderer doesn't support, all shown as the text it is. */
export const AS_TEXT = [
  'Raw HTML is text: <b>not bold</b> <img src=x onerror="alert(1)"> <details><summary>not a summary</summary></details>',
  '',
  'So are links to anything but http and https: [a script](javascript:alert(1)), [a file](src/export/job.ts), [data](data:text/html,hi), and <mailto:someone@example.com>. An image is its alt text, never loaded: ![a chart of retries](chart.png).',
  '',
  'Setext headings',
  '===',
  '',
  'Reference links [like this][1], footnotes[^1], entities &amp; and a ~single tilde~.',
].join('\n');

/** A prompt you typed, shown as typed: its indents and blank lines kept, and no markdown. */
export const TYPED_PROMPT = [
  'Please post this to the channel exactly as laid out:',
  '',
  '    Export retries: merged',
  '      - three attempts',
  '      - waits of 1, 4 and 16 s',
  '',
  '',
  '**Not bold**: what you type is shown as you typed it.',
].join('\n');

/** Your prompt as typed, then Claude's message with every element. */
export const MARKDOWN_ELEMENTS: ConversationEntry[] = [
  { kind: 'user', at: ago(12), text: TYPED_PROMPT },
  { kind: 'assistant', at: ago(11), text: EVERY_ELEMENT, markdown: true },
];

/** A message cut short in a code block, one whose HTML and other syntax is text, and another session's message in markdown. */
export const MARKDOWN_EDGES: ConversationEntry[] = [
  { kind: 'assistant', at: ago(10), text: CUT_IN_CODE, markdown: true, truncated: true },
  { kind: 'assistant', at: ago(9), text: AS_TEXT, markdown: true },
  {
    kind: 'cross-session',
    at: ago(8),
    from: 'pitwall-test-reviewer',
    text: 'Looks good. Could you also log **each** retry with its `attempt`?\n\n```sh\nnpm test -- export\n```',
    markdown: true,
  },
];

/** All of markdown in messages, as one conversation. */
export const MARKDOWN_CONVERSATION: ConversationEntry[] = [...MARKDOWN_ELEMENTS, ...MARKDOWN_EDGES];

// Links in code (W37). Made up, in the shape of a draft Claude wrote for a chat channel.

/**
 * A draft in a code block, with its pull requests' URLs: one at a line's end, one in brackets, one
 * before a full stop; a javascript: URL and markdown's own link syntax, which stay text; and a line
 * long enough to scroll sideways. Then inline code holding a URL.
 */
export const DRAFT_WITH_LINKS = [
  "Here's the draft for the channel, with the three pull requests in it:",
  '',
  '```text',
  'Export retries are ready for review:',
  '- the retry loop: https://github.com/example/export-app/pull/41',
  '- its tests (https://github.com/example/export-app/pull/42)',
  '- and the docs, last: https://github.com/example/export-app/pull/43.',
  'Not a link: javascript:alert(1)',
  'Markdown stays as written in code: [the notes](https://example.com/notes) and <https://example.com/changelog>',
  '```',
  '',
  'The CI run is `https://example.com/ci/runs/1234`, and `npm test -- export` runs the tests here.',
].join('\n');

/** The draft from Claude, then another session's message with links in its code, which is on --pw-surface there. */
export const LINKS_IN_CODE: ConversationEntry[] = [
  { kind: 'user', at: ago(7), text: 'Draft the review request for the channel, with the pull requests.' },
  { kind: 'assistant', at: ago(6), text: DRAFT_WITH_LINKS, markdown: true },
  {
    kind: 'cross-session',
    at: ago(5),
    from: 'pitwall-test-reviewer',
    text: 'Reviewed the first one. Open it with:\n\n```sh\ngh pr view https://github.com/example/export-app/pull/41 --web\n```\n\nor see `https://github.com/example/export-app/pull/41/files`.',
    markdown: true,
  },
];

// Links that ask first (W55, W48's F6). Made up.

/**
 * A reply with links that ask before they open: one whose text is words, one whose text is another
 * address, and one to an internationalised host; links that open on one click: a bare URL, an
 * autolink and one whose text is its own address; and a URL with a username before its host, which is
 * text, in text and in code.
 */
export const LINKS_THAT_ASK_TEXT = [
  'The fix is in [the pull request](https://github.com/example/export-app/pull/51), and its run is https://example.com/ci/runs/1234.',
  '',
  "A link whose text is another address asks too: [https://github.com/example/export-app/pull/51](https://example.com/export-app/pull/51). One whose text is its own address doesn't: [github.com/example/export-app](https://github.com/example/export-app), or <https://example.com/changelog>.",
  '',
  'Sign in at [the dashboard](https://exämple.com/login) to see it.',
  '',
  'A URL with a username before its host is text: https://github.com@example.com/export-app/pull/51, and in code, `gh pr view https://github.com@example.com/export-app/pull/51`.',
].join('\n');

/** Your question, then the reply with links that ask. */
export const LINKS_THAT_ASK: ConversationEntry[] = [
  { kind: 'user', at: ago(4), text: 'Where is the fix for the export retries?' },
  { kind: 'assistant', at: ago(3), text: LINKS_THAT_ASK_TEXT, markdown: true },
];

// Messages to pitwall (W46). Made up, in the shape of a session's SendMessage replies to pitwall's relay.

/** A short reply to pitwall. */
export const TO_PITWALL_SHORT = 'Both flows: the **export** and the import. The tests pass for each.';

/** A long reply, several paragraphs and a list, as long as a footer could never show. */
export const TO_PITWALL_LONG = [
  'Here is where the export work stands.',
  '',
  'The export job now retries a failed batch three times, waiting 1, 4 and 16 seconds, and gives up with the error from the last attempt. Retries reuse the batch id, so a batch that half-wrote before failing is replaced rather than duplicated.',
  '',
  'What changed:',
  '',
  '1. `src/export/job.ts` wraps each batch in `withRetry()`.',
  '2. `src/export/retry.ts` is new: the delays, and the check for errors worth retrying.',
  '3. Three new tests: a batch that fails once, one that fails every time, and one that times out.',
  '',
  'The 30 second timeout is unchanged, as you asked. Nothing is left open, except whether the import job should retry the same way; I left it alone for now.',
].join('\n');

/** A reply with a code block and links, one in text and one in the code. */
export const TO_PITWALL_CODE = [
  'Run this to check it yourself:',
  '',
  '```sh',
  'npm test -- export',
  'gh pr view https://github.com/example/export-app/pull/41 --web',
  '```',
  '',
  'The pull request is [#41](https://github.com/example/export-app/pull/41), and the CI run is https://example.com/ci/runs/1234.',
].join('\n');

/** A message from pitwall, the session's tool calls, its replies to pitwall in full, and what it said after. */
export const TO_PITWALL_CONVERSATION: ConversationEntry[] = [
  { kind: 'user', at: ago(40), text: 'Add a retry with backoff to the export job.' },
  { kind: 'cross-session', at: ago(7), from: 'pitwall-relay', text: 'Which flows did you change, and do the tests pass?', markdown: true },
  { kind: 'tool', at: ago(6.8), toolName: 'Bash', text: 'Bash: git diff --stat' },
  { kind: 'tool', at: ago(6.6), toolName: 'Bash', text: 'Bash: npm test -- export' },
  { kind: 'to-pitwall', at: ago(6.5), text: TO_PITWALL_SHORT, markdown: true },
  { kind: 'assistant', at: ago(6.4), text: 'So I sent it both flows.', markdown: true },
  { kind: 'to-pitwall', at: ago(6), text: TO_PITWALL_LONG, markdown: true },
  { kind: 'tool', at: ago(5.8), toolName: 'Bash', text: 'Bash: gh pr view 41' },
  { kind: 'to-pitwall', at: ago(5.5), text: TO_PITWALL_CODE, markdown: true },
];

/** The exchange that conversation answers: sent before its replies, so the footer keeps only its status line. */
export const TO_PITWALL_EXCHANGE: RelayExchange = { sentAt: ago(7), status: 'delivered', reply: { at: ago(6.5), text: TO_PITWALL_SHORT } };

/**
 * Questions Claude Code asked in its dialog (W49), between tool calls and messages: a dialog of two,
 * an answered single choice and a multi-select; an answer typed in place of an option; an answer with
 * notes; and a dismissed dialog, its result an error.
 */
export const QUESTION_CONVERSATION: ConversationEntry[] = [
  { kind: 'user', at: ago(20), text: 'Add a retry with backoff to the export job. Ask me whatever you need to.' },
  { kind: 'tool', at: ago(19.8), toolName: 'Read', text: 'Read: src/export/job.ts' },
  { kind: 'tool', at: ago(19.6), toolName: 'Grep', text: 'Grep: retry in src' },
  {
    kind: 'question',
    at: ago(19),
    text: 'Which job should retry first?',
    toolError: false,
    questions: [
      {
        question: 'Which job should retry first?',
        header: 'Job',
        options: [
          { label: 'Export', description: 'Retries each batch, replacing what a failed attempt wrote.' },
          { label: 'Import', description: 'Retries each file from its start.' },
        ],
        answer: 'Export',
      },
      {
        question: 'Which errors should it retry?',
        header: 'Errors',
        multiSelect: true,
        options: [
          { label: 'Timeouts', description: 'A batch that took longer than 30 seconds.' },
          { label: 'Rate limits', description: 'Waiting as long as the server asks.' },
          { label: 'Server errors', description: 'Any 5xx answer.' },
        ],
        answer: 'Timeouts, Server errors',
      },
    ],
  },
  { kind: 'assistant', at: ago(18.5), text: 'The export job, then, retrying timeouts and server errors.', markdown: true },
  {
    kind: 'question',
    at: ago(18),
    text: 'How many attempts should a batch get?',
    toolError: false,
    questions: [
      {
        question: 'How many attempts should a batch get?',
        header: 'Attempts',
        options: [
          { label: 'Three', description: 'Waiting 1, 4 and 16 seconds.' },
          { label: 'Five', description: 'Waiting up to a minute in all.' },
        ],
        answer: 'Four, and no more than a minute in all.',
      },
    ],
  },
  {
    kind: 'question',
    at: ago(17.5),
    text: 'Which level should each retry log at?',
    toolError: false,
    questions: [
      {
        question: 'Which level should each retry log at?',
        header: 'Logging',
        options: [
          { label: 'Debug', description: 'Only when the job runs with --verbose.' },
          { label: 'Info', description: 'Always, with the batch id.' },
        ],
        answer: 'Debug',
        notes: 'Put the attempt number in each line, so a batch that keeps failing is easy to spot.',
      },
    ],
  },
  { kind: 'tool', at: ago(12), toolName: 'Edit', text: 'Edit: src/export/job.ts' },
  { kind: 'tool', at: ago(11), toolName: 'Bash', text: 'Bash: npm test -- export' },
  {
    kind: 'question',
    at: ago(9),
    text: 'Open a pull request now?',
    toolError: true,
    questions: [
      {
        question: 'Open a pull request now?',
        header: 'Next',
        options: [
          { label: 'Yes', description: 'Push the branch and open it as a draft.' },
          { label: 'Not yet', description: 'Retry the import job the same way first.' },
        ],
      },
    ],
  },
  { kind: 'user', at: ago(8), text: 'Not yet. Run the whole test suite first.' },
];

/** What the terminal shows once attached: made up, with colours, in the shape of Claude Code's output. */
export const TERMINAL_OUTPUT =
  '\x1b[1mpitwall-test-terminal\x1b[0m · Export retries\r\n\r\n' +
  '\x1b[32m✔\x1b[0m Read src/export/job.ts\r\n' +
  '\x1b[32m✔\x1b[0m Read src/export/retry.ts\r\n' +
  '\x1b[31m✘\x1b[0m npm test -- export \x1b[2m(1 failed)\x1b[0m\r\n' +
  '\x1b[33m●\x1b[0m Making a retry replace the batch…\r\n\r\n' +
  '> ';

/** The New session dialog's roots and directories. */
export const DIALOG_SNAPSHOT: Pick<IndexSnapshot, 'roots' | 'groups'> = { roots: [ROOT], groups: [APP_GROUP, JOBS_GROUP, NOTES_GROUP] };

/**
 * The directories under the dialog's root, for "Another directory under a root…" (W70): the groups'
 * repos and some folders around them, three levels deep at most, as the server lists them.
 */
export const DIALOG_DIRECTORIES: DirectoryList = {
  roots: [
    {
      root: ROOT,
      dirs: [
        { path: 'pitwall-test-api', repo: true },
        { path: 'pitwall-test-app', repo: true },
        { path: 'pitwall-test-jobs', repo: true },
        { path: 'pitwall-test-notes', repo: true },
        { path: 'pitwall-test-scratch' },
        { path: 'pitwall-test-app/docs' },
        { path: 'pitwall-test-app/web' },
        { path: 'pitwall-test-jobs/export' },
        { path: 'pitwall-test-scratch/pitwall-test-spike' },
        { path: 'pitwall-test-app/web/src' },
        { path: 'pitwall-test-scratch/a-much-longer-folder-name-for-the-middle-ellipsis/and-then-some-more' },
      ],
      truncated: false,
    },
  ],
};

/** 312 directories, more than the list shows at once. */
export const MANY_DIRECTORIES: DirectoryList = {
  roots: [{ root: ROOT, dirs: Array.from({ length: 312 }, (_, i) => ({ path: `pitwall-test-project-${String(i + 1).padStart(3, '0')}` })), truncated: false }],
};

/** The trust failure's command, as the server would send it. */
export const TRUST_HINT = `cd ${APP_DIR} && claude`;

// Sub-agents (W77): a session's sub-agents for the Sub-agents tab, each state, nested ones, many and a
// list cut short, a sub-agent's own transcript, and a conversation whose entries name them.

let agents = 0;

/** A made-up sub-agent: done, a general-purpose one, unless `overrides` say otherwise. Ids are letters and digits, as Claude Code's are. */
export function subagent(description: string, overrides: Partial<SubagentSummary> = {}): SubagentSummary {
  agents += 1;
  const merged: SubagentSummary = {
    agentId: `pt77${String(agents).padStart(4, '0')}`,
    description,
    agentType: 'general-purpose',
    state: 'done',
    startedAt: ago(40),
    lastActivityAt: ago(30),
    toolCalls: 8,
    ...overrides,
  };
  for (const key of Object.keys(merged) as (keyof SubagentSummary)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged;
}

/** Running, started by the session: the transcript specimen opens it. */
export const REVIEW = subagent('Review the made-up export job for retries', { agentType: 'Explore', state: 'running', startedAt: ago(9), lastActivityAt: ago(0.1), toolCalls: 23 });
/** Done: the conversation has its Agent call and its report. */
const DRAFT = subagent('Draft the made-up changelog entry', { startedAt: ago(50), lastActivityAt: ago(44), toolCalls: 6 });
/** Running, started by REVIEW. */
const SEARCH_DOCS = subagent('Search the made-up docs for the timeout', { state: 'running', agentType: 'Explore', startedBy: REVIEW.agentId, startedAt: ago(3), lastActivityAt: ago(0.3), toolCalls: 2 });

/** One of each state, and one another started, in the server's order: running ones first, then the newest started first. */
export const SUBAGENTS: SubagentSummary[] = [
  SEARCH_DOCS,
  REVIEW,
  subagent('Run the made-up export tests', { state: 'failed', startedAt: ago(30), lastActivityAt: ago(27), toolCalls: 4 }),
  subagent('Look for a made-up flaky test', { state: 'stopped', startedAt: ago(35), lastActivityAt: ago(33), toolCalls: 0 }),
  DRAFT,
  subagent('Summarise the made-up logs', { state: 'unknown', agentType: undefined, startedAt: ago(70), lastActivityAt: ago(66), toolCalls: 11 }),
];

const TASKS = ['Read', 'Check', 'Review', 'Search', 'Summarise', 'Draft', 'Test', 'Trace'];
const THINGS = ['the made-up export job', 'the retry tests', 'the made-up routes', 'the batch writer', 'the made-up docs', 'the queue worker', 'the made-up changelog', 'the timeout handling', 'the CSV export'];

/** 72 sub-agents, the most one of Phil's sessions started in a week (PLAN.md): three running, and every eighth started by another. */
export const MANY_SUBAGENTS: SubagentSummary[] = (() => {
  const made: SubagentSummary[] = [];
  for (let i = 0; i < 72; i++) {
    const parent = i % 8 === 7 ? made[i - 3] : undefined;
    made.push(
      subagent(`${TASKS[i % TASKS.length]} ${THINGS[i % THINGS.length]}, part ${i + 1}`, {
        state: i < 3 ? 'running' : i % 11 === 5 ? 'failed' : i % 13 === 6 ? 'stopped' : 'done',
        agentType: i % 3 === 0 ? 'Explore' : 'general-purpose',
        startedAt: ago(5 + i * 9),
        lastActivityAt: ago(i < 3 ? 0.2 : 1 + i * 9),
        toolCalls: (i * 7) % 40,
        ...(parent ? { startedBy: parent.agentId } : {}),
      }),
    );
  }
  return made;
})();

/** A list the server cut short: here twelve stand in for its SUBAGENTS_MAX, 200. */
export const TRUNCATED_SUBAGENTS: SubagentSummary[] = MANY_SUBAGENTS.slice(0, 12);

/** A sub-agent's own transcript: the task it was given, its steps and its report. */
export const SUBAGENT_TRANSCRIPT: ConversationEntry[] = [
  { kind: 'user', at: ago(9), text: 'Review the made-up export job for retries. Report what retries, what doesn’t, and any test that is missing.' },
  { kind: 'assistant', at: ago(8.8), text: "I'll start with the job and its tests.", markdown: true },
  { kind: 'tool', at: ago(8.6), toolName: 'Read', text: 'Read: src/export/job.ts' },
  { kind: 'tool', at: ago(8.5), toolName: 'Grep', text: 'Grep: retry in src/export' },
  {
    kind: 'tool',
    at: ago(3),
    toolName: 'Agent',
    text: 'Agent: Search the made-up docs for the timeout',
    subagent: { agentId: SEARCH_DOCS.agentId, description: SEARCH_DOCS.description },
  },
  { kind: 'assistant', at: ago(0.2), text: 'The batch writer retries **three times**; the CSV export doesn’t retry at all.', markdown: true },
];

/** What's behind its Load earlier. */
export const SUBAGENT_OLDER: ConversationEntry[] = [{ kind: 'notice', at: ago(9.2), text: 'A made-up earlier notice.' }];

/** A session's conversation whose entries name its sub-agents: the call that started one, its report, and a message sent to another. */
export const SUBAGENT_CONVERSATION: ConversationEntry[] = [
  { kind: 'user', at: ago(52), text: 'Draft the changelog entry, then check the export job retries.' },
  { kind: 'tool', at: ago(50), toolName: 'Agent', text: 'Agent: Draft the made-up changelog entry', subagent: { agentId: DRAFT.agentId, description: DRAFT.description } },
  {
    kind: 'cross-session',
    at: ago(44),
    from: DRAFT.agentId,
    markdown: true,
    text: 'The changelog entry is drafted under **Unreleased**.',
    subagent: { agentId: DRAFT.agentId, description: DRAFT.description },
  },
  { kind: 'assistant', at: ago(43), markdown: true, text: 'The entry is in. Now the retries.' },
  { kind: 'tool', at: ago(9), toolName: 'Agent', text: `Agent: ${REVIEW.description}`, subagent: { agentId: REVIEW.agentId, description: REVIEW.description } },
  { kind: 'tool', at: ago(2), toolName: 'SendMessage', text: 'SendMessage', subagent: { agentId: REVIEW.agentId, description: REVIEW.description } },
];

/** An interactive session with sub-agents, two of them running. */
export const VIEW_SUBAGENTS = session('view-subagents', { title: 'Export retries', subagentsRunning: 2, lastActivityAt: ago(0.1) });
