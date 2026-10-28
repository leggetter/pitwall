// README screenshot: the production build on the app check's fake server, with a made-up world in
// place of its fixtures: public repo names under ~/work, made-up sessions, and one made-up
// conversation open on its Conversation tab. No real session or transcript is read.
//   npm run build && npx tsx scripts/readme-screenshot.ts <outDir> [light|dark]
// then copy <outDir>/hero-light.png to docs/images/pitwall-light.png. Needs the app check's pinned
// chrome-headless-shell (npm run appcheck:install-shell).
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultHeadlessShell, launchChrome } from './appcheck/chrome.js';
import { Page } from './appcheck/page.js';
import { importBuilt, madeUpToken, startFakeServer } from './appcheck/server.js';
import type { ConversationEntry, IndexSnapshot, SessionGroup, SessionSummary } from '../src/shared/protocol.js';

const [out, theme = 'light'] = process.argv.slice(2) as [string, 'light' | 'dark'];
const DIST = join(import.meta.dirname, '../dist');
const ROOT = '/Users/example/work';
const MINUTE = 60_000;
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * MINUTE).toISOString();

let n = 0;
const make = (repo: string, name: string, minutes: number, extra: Partial<SessionSummary> = {}): SessionSummary => {
  n += 1;
  return {
    sessionId: `00000000-0000-4000-8000-0000000087${String(n).padStart(2, '0')}`,
    name,
    kind: 'interactive',
    cwd: repo === '' ? ROOT : `${ROOT}/${repo}`,
    pid: 50_000 + n,
    alive: true,
    status: 'idle',
    startedAt: ago(minutes + 90),
    stale: false,
    finished: false,
    lastActivityAt: ago(minutes),
    transcript: 'ok',
    ...extra,
  };
};
const job = (repo: string, name: string, minutes: number, extra: Partial<SessionSummary> = {}) =>
  make(repo, name, minutes, { kind: 'background', shortId: `ab12cd${String(n + 1).padStart(2, '0')}`, status: undefined, state: 'working', ...extra });

const docs = make('quickstarts', 'Docs link check', 2, {
  askedYou: { reason: 'question', excerpt: 'Fix both links now, or open an issue for each?' },
  needsYou: { reason: 'asked' },
  lastUserPrompt: 'Check the docs for broken links, and tell me what you find before fixing anything.',
});
const starred = [
  job('mcp-events-bridge', 'Bridge release', 4, { state: 'blocked', needsYou: { reason: 'claude-code', text: 'May I push the branch and open the PR?' } }),
  make('hookdeck-cli', 'CLI release prep', 7, { askedYou: { reason: 'question', excerpt: 'Tag the release now, or wait for the docs?' }, needsYou: { reason: 'asked' } }),
  make('hookdeck-go-sdk', 'Fix a flaky test', 9, { status: 'waiting', waitingFor: 'permission prompt', needsYou: { reason: 'prompt' }, lastUserPrompt: 'Find out why the retry test fails one run in ten.' }),
  docs,
  job('outpost', 'Dependency updates', 16, { state: 'blocked', needsYou: { reason: 'claude-code', text: 'Merge the minor bumps, or review each one?' } }),
  make('hookdeck-typescript-sdk', 'Build fix', 25, { lastUserPrompt: 'Open the PR once the build passes.' }),
  job('n8n-nodes-hookdeck', 'Node docs refresh', 140, { state: 'done', alive: false, pid: undefined, finished: true }),
];
const others = [
  job('evals', 'Nightly eval run', 1, { subagentsRunning: 2 }),
  make('hookdeck-demos', 'Demo refresh', 3, { status: 'busy', lastUserPrompt: 'Update the demo to the new SDK.' }),
  make('agent-skills', 'Skill review', 60 * 26, { ended: true, finished: true, alive: false, pid: undefined, status: undefined }),
  make('', 'Tidy the workspace', 45, { lastUserPrompt: 'List the repos with uncommitted changes.' }),
];
const sessions = [...starred, ...others];

const repos = ['agent-skills', 'evals', 'hookdeck-cli', 'hookdeck-demos', 'hookdeck-go-sdk', 'hookdeck-typescript-sdk', 'mcp-events-bridge', 'n8n-nodes-hookdeck', 'outpost', 'quickstarts'];
const snapshot = (): IndexSnapshot => {
  const groups: SessionGroup[] = [
    { key: ROOT, label: 'work', kind: 'directory', root: ROOT, sessions: sessions.filter((s) => s.cwd === ROOT) },
    ...repos.map((repo): SessionGroup => ({ key: `${ROOT}/${repo}`, label: repo, kind: 'git', root: ROOT, sessions: sessions.filter((s) => s.cwd === `${ROOT}/${repo}`) })),
  ];
  return { generatedAt: new Date().toISOString(), roots: [ROOT], groups: groups.filter((g) => g.sessions.length > 0), source: { ok: true } };
};

const conversation: ConversationEntry[] = [
  { kind: 'user', at: ago(9), text: 'Check the docs for broken links, and tell me what you find before fixing anything.' },
  { kind: 'assistant', at: ago(8.8), markdown: true, text: "I'll build the docs site, then check every link in the output, internal and external." },
  { kind: 'tool', at: ago(8.6), toolName: 'Bash', text: 'Bash: npm run build' },
  { kind: 'tool', at: ago(7), toolName: 'Bash', text: 'Bash: npx linkinator dist --recurse --skip "^mailto:"' },
  { kind: 'tool', at: ago(4), toolName: 'Grep', text: 'Grep: retry-policy' },
  {
    kind: 'assistant',
    at: ago(2),
    markdown: true,
    text: [
      'Two of 1,284 links are broken:',
      '',
      '| Page | Link | Status |',
      '| --- | --- | --- |',
      '| `guides/retries.md` | `/docs/api/retry-policy` | 404 |',
      '| `quickstart.md` | `https://example.com/sdk/v1` | 404 |',
      '',
      '- **The first** moved to `/docs/api/retries` when the API reference was reorganised. Two other pages already link to the new path.',
      '- **The second** points at the old SDK page, which was removed. The current one is `https://example.com/sdk`',
      '',
      'Both are one-line fixes. Should I fix both links now, or open an issue for each?',
    ].join('\n'),
  },
];

await mkdir(out, { recursive: true });
const token = madeUpToken();
const server = await startFakeServer({ port: 4620, webRoot: join(DIST, 'web'), built: await importBuilt(DIST), token });
const world = server.world as unknown as Record<string, unknown>;
world.snapshot = snapshot;
world.session = (id: string) => sessions.find((s) => s.sessionId === id);
world.conversation = (id: string) => (sessions.some((s) => s.sessionId === id) ? { sessionId: id, entries: id === docs.sessionId ? conversation : [] } : undefined);
world.subagents = (id: string) => ({ sessionId: id, subagents: [], truncated: false });
world.directories = () => ({ roots: [{ root: ROOT, dirs: repos.map((path) => ({ path, repo: true as const })), truncated: false }] });

const path = defaultHeadlessShell();
if (!path) throw new Error('no chrome-headless-shell');
const chrome = await launchChrome({ path, debugPort: 9335, profileParent: out });
let page: Page | undefined;
try {
  page = await Page.open(chrome.cdp, server, token, { keys: chrome.silent });
  const storage = { 'pitwall.starred.v1': JSON.stringify({ v: 1, ids: starred.map((s) => s.sessionId) }), 'pitwall.theme.v1': theme };
  page.step = 'open starred';
  await page.fresh({ name: 'readme', width: 1440, height: 900 }, theme, { search: `?view=starred&session=${docs.sessionId}`, storage });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await page.settle(2500);
  console.log('open view:', await page.evaluate(`document.querySelector('[aria-current="true"]')?.textContent ?? null`));
  await page.shot(`${out}/hero-${theme}.png`);
} catch (error) {
  console.log('FAILED:', (error as Error).message);
  process.exitCode = 1;
} finally {
  console.log('problems:', JSON.stringify(page?.problems ?? []));
  await page?.close().catch(() => {});
  await chrome.stop();
  await server.close();
}
