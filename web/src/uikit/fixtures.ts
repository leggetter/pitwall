// Made-up data for the #uikit gallery (W19). Nothing here comes from a real session or from this
// machine: every session is named pitwall-test-*, every path is under /Users/example, and all the
// text is invented. Built once, when the gallery loads, so each session keeps one id.

import type {
  ConversationEntry,
  IndexSnapshot,
  RelayAlert,
  RelayExchange,
  RelayOff,
  SessionGroup,
  SessionSummary,
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

/** Every status a row can show, one row each, named after it. */
export const STATUS_ROWS: SessionSummary[] = [
  session('waiting', {
    status: 'waiting',
    waitingFor: 'permission prompt',
    lastUserPrompt: 'Add a retry with backoff to the export job.',
    lastActivityAt: ago(1),
  }),
  background('blocked', {
    state: 'blocked',
    status: 'idle',
    waitingFor: 'input needed',
    lastUserPrompt: 'Move failed exports somewhere we can inspect them.',
    lastActivityAt: ago(2),
  }),
  session('asked-you', {
    title: 'CSV export for projects',
    titleSource: 'claude-code',
    askedYou: { reason: 'open-questions', excerpt: 'Should the CSV export include archived projects?' },
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
    lastActivityAt: ago(2),
  }),
  session('long-reason', {
    status: 'waiting',
    waitingFor: 'permission prompt for a command that writes outside the working directory',
    lastActivityAt: ago(1),
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
  needsYou: session('needs-you', { status: 'waiting', waitingFor: 'dialog open', lastUserPrompt: 'Pick the export format for the archive.' }),
  needsYouOpen: session('needs-you-open', {
    status: 'waiting',
    waitingFor: 'permission prompt',
    lastUserPrompt: 'Delete the old export files.',
  }),
  finished: finished('finished', 'done', { cwd: JOBS_DIR }),
};

// Groups, for the group sections and the dashboards.

const appSessions = [STATUS_ROWS[0]!, STATUS_ROWS[1]!, STATUS_ROWS[3]!, STATUS_ROWS[5]!];
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
  lastUserPrompt: 'Make the API retry the export too, and update the docs.',
  lastActivityAt: ago(1),
  workedIn: touched(API_DIR, DOCS_DIR),
});
/** Started in the root itself, then worked in the API and the docs: under the root's own group. */
export const WORKED_FROM_ROOT = session('from-root', {
  cwd: ROOT,
  askedYou: { reason: 'question', excerpt: 'Should the API return 429 or 503 while an export retries?' },
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

// View preferences (W42): two roots, ~/code and ~/work. pitwall-test-delivery-plan started in ~/code
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

export const RELAY_ALERT_SENT: RelayAlert = {
  at: ago(2),
  detail: 'a SendMessage to pitwall-test-relay-delivered with no request waiting for it',
  count: 1,
  blocked: false,
};
export const RELAY_ALERT_BLOCKED: RelayAlert = {
  at: ago(1),
  detail: 'a SendMessage to pitwall-test-idle that no request asked for',
  count: 3,
  blocked: true,
};
/** The alert that comes with the relay going off: its gate let a call through unchecked. */
export const RELAY_ALERT_OFF: RelayAlert = {
  at: ago(2),
  detail: "The relay's SendMessage ran without pitwall's gate checking it. It was the message you sent, but the relay isn't safe to use.",
  count: 1,
  blocked: false,
};
/** The relay is off until pitwall restarts: the app strip shows. */
export const RELAY_OFF: RelayOff = { since: ago(2), reason: "its gate didn't check a SendMessage call." };

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

/** The trust failure's command, as the server would send it. */
export const TRUST_HINT = `cd ${APP_DIR} && claude`;
