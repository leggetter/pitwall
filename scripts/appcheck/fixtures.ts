// The made-up world the fake server serves: sessions under /Users/example/code (and, for two root
// tabs, /Users/example/oss), their conversations, and what spawn, the relay and resume change, and
// your made-up open pull requests (M4, W95), with the sessions' links to them and where the server
// placed each one (W106). Nothing here comes
// from a real session, transcript or pull request: every name is pitwall-test-*, every path is under
// /Users/example, every link goes to example.com or github.com/example, and the PRs are in made-up
// repos or public ones, such as example/event-relay, with invented titles.
//
// Parts refer to sessions by the names in NAMES, so a fixture can change without touching a part.

import type {
  ConversationEntry,
  ConversationPage,
  DirectoryList,
  IndexSnapshot,
  PrLink,
  PullRequestList,
  PullRequestPlace,
  PullRequestRelation,
  PullRequestSummary,
  RelayExchange,
  SessionGroup,
  SessionSummary,
  SpawnRequest,
  SubagentList,
  SubagentSummary,
} from '../../src/shared/protocol.js';

export const CODE = '/Users/example/code';
export const OSS = '/Users/example/oss';
export const API_SERVER = `${CODE}/api-server`;
export const DEMO_APP = `${CODE}/demo-app`;
export const BLOG = `${OSS}/blog`;
/** A directory whose only session ended long ago (W67), so it's in the repo list only with Show older on. */
export const DOCS_SITE = `${CODE}/docs-site`;
/** A directory no session has worked in, which New session's autocomplete offers (W70). */
export const DEMO_APP_WEB = `${DEMO_APP}/web`;
/** A cloned repo with no session (W106): the server places its PRs under it, so the page builds its group. */
export const EVENT_RELAY = `${CODE}/event-relay`;

/** The sessions parts use, by role. */
export const NAMES = {
  /** Interactive, waiting on a permission prompt: needs you ('prompt'). */
  waiting: 'pitwall-test-docs',
  /** Interactive, idle, ended its turn with a question: needs you ('asked'). */
  asked: 'pitwall-test-review',
  /** Interactive and idle, with every kind of conversation entry and links: the message box's session. It has no sub-agents (W77). */
  conversation: 'pitwall-test-api',
  /**
   * Background and running: Terminal opens and attaches. Its turn is running, with a command still out,
   * so its Conversation tab ends with the working line (W102), until `world.endTurn()`.
   */
  running: 'pitwall-test-nightly-export',
  running2: 'pitwall-test-retry-worker',
  running3: 'pitwall-test-index-rebuild',
  /** Background, running and waiting on a permission prompt, where Enter would approve. */
  prompting: 'pitwall-test-deploy-check',
  /** Background and finished: opens on Conversation, and attaching would restart it. */
  finished: 'pitwall-test-old-migration',
  /** Started in the root itself; worked in two repos, so Group sessions by moves it. */
  fromRoot: 'pitwall-test-from-root',
  /**
   * In api-server, interactive and idle, with sub-agents (W77): two running, one started by the
   * other, then done, failed and stopped ones. Its conversation names them (SUBAGENTS).
   */
  inApi: 'pitwall-test-in-api',
  /** Under the second root, waiting, so its tab has a need-you badge. */
  blog: 'pitwall-test-blog-notes',
  /**
   * Ended interactive sessions (W67), in demo-app's Finished section, all from the last 7 days. The
   * fake server's resume answers each by its name, in W66's words: `ended` resumes, and is listed a
   * moment later as a running background session under the same id; the rest fail, one way each.
   */
  ended: 'pitwall-test-ended-notes',
  /** Ended, having asked something, so never in Needs you. Resume: refused, with the command that trusts the directory. */
  endedAsked: 'pitwall-test-ended-asked',
  /** Resume: Claude Code started a copy instead. */
  endedCopy: 'pitwall-test-ended-copy',
  /** Resume: 429, with Retry-After. */
  endedBusy: 'pitwall-test-ended-busy',
  /** Resume: 409, it's running again. */
  endedRefused: 'pitwall-test-ended-refused',
  /** Resume: 504, `claude --resume` didn't finish in time. */
  endedSlow: 'pitwall-test-ended-slow',
  /** Resume: no answer at all, the connection closed. */
  endedNoAnswer: 'pitwall-test-ended-no-answer',
  /** Ended, and its directory has gone, so it can't be resumed. */
  endedGone: 'pitwall-test-ended-gone',
  /** Ended ten days ago: behind Show older, in demo-app. */
  endedOld: 'pitwall-test-ended-old',
  /** Ended twenty days ago, alone in docs-site: the group is in the repo list only with Show older on. */
  endedOldOnly: 'pitwall-test-ended-old-docs',
  /**
   * Ended three days ago in api-server, having opened PRS.endedWork, which is still open (W106): its work
   * isn't finished, so it's listed with the rest, not in Finished.
   */
  endedPr: 'pitwall-test-ended-pr',
} as const;

/** The short id the copy Claude Code starts in place of NAMES.endedCopy has. */
export const COPY_SHORT_ID = 'pt67copy';

/**
 * NAMES.inApi's sub-agents (W77), by role, as the tab sorts them: running ones first, the newest started
 * first, then the rest by start. Ids are letters and digits, as Claude Code's are.
 */
export const SUBAGENTS = {
  /** Running, started by `reading`: the newest. */
  checking: { agentId: 'pt77check', description: 'Check the made-up route tests' },
  /** Running, started by the session. */
  reading: { agentId: 'pt77read', description: 'Read the made-up routes' },
  /** Done, with a page behind Load earlier; the session's conversation has its Agent call and its report. */
  drafting: { agentId: 'pt77draft', description: 'Draft the made-up changelog entry' },
  failed: { agentId: 'pt77flaky', description: 'Look for a made-up flaky test' },
  stopped: { agentId: 'pt77docs', description: 'Search the made-up docs' },
} as const;

/** What a link in the conversation says and where it goes (the links part). */
export const LINKS = {
  bare: 'http://example.com/ci/runs/1234',
  misleadingText: 'https://github.com/example/demo-app/pull/51',
  misleadingHref: 'http://example.com/demo-app/pull/51',
  ownAddress: 'http://example.com/changelog',
  lookAlike: 'https://exämple.com/login',
  lookAlikePunycode: 'https://xn--exmple-cua.com/login',
  lookAlikeHost: 'xn--exmple-cua.com',
} as const;

const MINUTE = 60_000;

/**
 * Your made-up open pull requests (W95), by role, as their keys (`owner/name/number`). Three aren't
 * yours (W101): two ask your review, of you and of a made-up team, and one mentions you. Where each is
 * listed (W106): a session owns six, which are listed with it; the rest are rows of their own, under
 * demo-app, api-server, event-relay, which is cloned but has no session, and example/sdk-docs, which
 * isn't cloned; two older ones are behind the Pull requests view's Show older; and no root claims two.
 */
export const PRS = {
  /**
   * example/demo-app #51: checks failing, three named and five in all. pitwall-test-api opened it, then
   * pitwall-test-docs pushed its branch, so pitwall-test-docs owns it; pitwall-test-review named it in a reply.
   */
  failing: 'example/demo-app/51',
  /** example/demo-app #48: approved and passing. pitwall-test-review opened it; pitwall-test-nightly-export pushed its branch since, and owns it. */
  approved: 'example/demo-app/48',
  /** example/event-relay #612: conflicts and changes requested. pitwall-test-review opened it and owns it; pitwall-test-in-api named it in a reply. */
  conflicts: 'example/event-relay/612',
  /** example/event-relay #605: a draft, checks pending, GitHub still checking for conflicts. No session: a row under event-relay. */
  draft: 'example/event-relay/605',
  /** example/api-server #19: passing, no review needed. pitwall-test-from-root pushed it and owns it; the ended pitwall-test-ended-notes was given it. */
  quiet: 'example/api-server/19',
  /** example/docs-site #7, updated 120 days ago: review required. Not cloned, and behind Show older. */
  older: 'example/docs-site/7',
  /** example/event-relay #41, updated 200 days ago: checks failing, which nothing counts until Show older. */
  olderFailing: 'example/event-relay/41',
  /** example/demo-app #57, 40 minutes ago: your review requested, of you by name. It needs you. No session: a row under demo-app. */
  review: 'example/demo-app/57',
  /** example/event-relay #618, 2 hours ago: your review requested through example/reviewers, with its author's failing checks. It needs you. A row under event-relay. */
  teamReview: 'example/event-relay/618',
  /** example/api-server #23, 5 hours ago: it mentions you; not yours, and your review isn't asked. It never needs you. A row under api-server. */
  mentioned: 'example/api-server/23',
  /** example/sdk-docs #9, 3 hours ago: passing. The repo isn't cloned, and the root claims its owner: a row under example/sdk-docs, not cloned. */
  notCloned: 'example/sdk-docs/9',
  /** example/api-server #31, a day ago: passing. The ended pitwall-test-ended-pr opened it, and owns it. */
  endedWork: 'example/api-server/31',
  /** other-org/made-up-tool #4: no root claims its owner, so it's only counted. */
  unclaimed: 'other-org/made-up-tool/4',
  /** third-org/made-up-lib #2: placed nowhere, as by a server that doesn't place PRs, so it's only counted too. */
  unplaced: 'third-org/made-up-lib/2',
} as const;

/** The made-up team example/event-relay #618 asks a review of (W101). */
export const PR_TEAM = 'example/reviewers';

/**
 * What the PR source says (W95), for the steps that check each state: 'ok', the list; 'mine', the
 * list with only your own PRs, as once you've reviewed each one asked and nothing mentions you
 * (W101); 'partial', a fetch in which your own search worked and the other two failed, the
 * review-requested one with its list from two hours ago kept, the mentions one never listed
 * (W101's review); 'loading', before the first fetch has finished; 'off', `--no-prs`; 'gh-missing',
 * 'gh-auth' and 'error', a fetch that failed with no list; 'stale', one that failed after a list,
 * which is kept, two hours old.
 */
export type PrsState = 'ok' | 'mine' | 'partial' | 'loading' | 'off' | 'gh-missing' | 'gh-auth' | 'error' | 'stale';

/** The error each failed state says, in pitwall's made-up words. */
export const PRS_ERRORS: Readonly<Record<Exclude<PrsState, 'ok' | 'mine' | 'partial' | 'loading'>, string>> = {
  off: 'Pull requests are off: pitwall was started with --no-prs.',
  'gh-missing': "gh isn't on pitwall's PATH.",
  'gh-auth': "gh isn't logged in to github.com.",
  error: 'Made up: gh took longer than 30 seconds.',
  stale: 'Made up: no network.',
};

/** What 'partial' says of the two searches that failed (W101's review), in made-up words. */
export const PRS_SEARCH_ERRORS = {
  'review-requested': 'Made up: GitHub ended the request after 10 seconds.',
  mentioned: 'Made up: gh api failed with exit code 1.',
} as const;

/** The cursor of SUBAGENTS.drafting's newest page, for its Load earlier. */
const SUBAGENT_CURSOR = 'pt77-older';

interface Spawned {
  summary: SessionSummary;
  root: string;
}

export interface ResetOptions {
  /** One root, /Users/example/code, or two, with /Users/example/oss as well. */
  roots?: 1 | 2;
  /** What the PR source says (W95): 'ok', the list, by default. */
  prs?: PrsState;
  /** Group labels by key, in place of the made-up ones, such as a longer name for a heading. */
  labels?: Readonly<Record<string, string>>;
}

/** The made-up index: a snapshot, conversations, and what POSTs have changed since the last reset. */
export class World {
  #now = Date.now();
  #roots: 1 | 2 = 1;
  #labels: Readonly<Record<string, string>> = {};
  #sessions = new Map<string, SessionSummary>();
  #spawned: Spawned[] = [];
  #nextSpawn = 0;
  /** NAMES.inApi has the most sub-agents a list carries, and more (manySubagents()). */
  #manySubagents = false;
  /** The sessions whose running turn `endTurn()` has ended, until the next reset (W102). */
  #turnsEnded = new Set<string>();
  /** What the PR source says, and whether a fetch is running (W95). */
  #prs: PrsState = 'ok';
  #prsRefreshing = false;
  /** When the latest fetch finished, and started: a refresh within PRS_REFRESH_MIN_MS of the start gets 429. */
  #prsFetchedAt = 0;
  #prsFetchStarted = 0;
  /** The repos Clone and start has cloned since the last reset (W107), by repo, with where. */
  #cloned = new Map<string, string>();
  /** Whether a clone fails, as gh does for a repo you can't see (W107). */
  #cloneFails = false;
  /** PRs listed with another relation than their own until the next reset, by key (W108): `notYours()`. */
  #relations = new Map<string, PullRequestRelation>();

  constructor() {
    this.reset();
  }

  reset(options: ResetOptions = {}): void {
    this.#now = Date.now();
    this.#roots = options.roots ?? 1;
    this.#labels = options.labels ?? {};
    this.#spawned = [];
    this.#manySubagents = false;
    this.#turnsEnded = new Set();
    this.#prs = options.prs ?? 'ok';
    this.#prsRefreshing = false;
    // Fetched two minutes ago, by the poll, so a refresh now is allowed.
    this.#prsFetchedAt = this.#now - 2 * MINUTE;
    this.#prsFetchStarted = this.#prsFetchedAt - 8_500;
    this.#cloned = new Map();
    this.#cloneFails = false;
    this.#relations = new Map();
    this.#sessions = new Map(this.#baseSessions().map((each) => [each.sessionId, each]));
  }

  /**
   * Until the next reset, NAMES.inApi has more sub-agents than a list carries (W77): its five, then
   * done ones up to SUBAGENTS_MAX, 200, with `truncated` set, so its tab reads "Sub-agents (200+)".
   */
  manySubagents(): void {
    this.#manySubagents = true;
  }

  get roots(): string[] {
    return this.#roots === 2 ? [CODE, OSS] : [CODE];
  }

  snapshot(): IndexSnapshot {
    // A group's sessions: those started in its directory, or in a worktree of it under .claude/, as a removed one was (W67).
    const pick = (cwd: string) => [...this.#sessions.values()].filter((each) => (each.cwd === cwd || each.cwd.startsWith(`${cwd}/.claude/`)) && !this.#isSpawned(each));
    const groups: SessionGroup[] = [
      { key: CODE, label: 'code', kind: 'directory', root: CODE, sessions: pick(CODE) },
      { key: API_SERVER, label: 'api-server', kind: 'git', root: CODE, sessions: pick(API_SERVER) },
      { key: DEMO_APP, label: 'demo-app', kind: 'git', root: CODE, sessions: pick(DEMO_APP) },
      { key: DOCS_SITE, label: 'docs-site', kind: 'directory', root: CODE, sessions: pick(DOCS_SITE) },
      ...(this.#roots === 2 ? [{ key: BLOG, label: 'blog', kind: 'git' as const, root: OSS, sessions: pick(BLOG) }] : []),
    ];
    // A started session is listed in the group of its directory, or its root's own, as the index lists it.
    for (const { summary, root } of this.#spawned) {
      const home = groups.find((group) => group.key === summary.cwd) ?? groups.find((group) => group.key === root);
      if (home) home.sessions.unshift(summary);
      else groups.push({ key: summary.cwd, label: summary.cwd.slice(root.length + 1), kind: 'directory', root, sessions: [summary] });
    }
    const named = groups.map((group) => ({ ...group, label: this.#labels[group.key] ?? group.label }));
    return { generatedAt: new Date().toISOString(), roots: this.roots, groups: named.filter((group) => group.sessions.length > 0), source: { ok: true } };
  }

  /**
   * Your open PRs (W95), as GET PRS_PATH and the 'prs' message have them: the list in the state the
   * world is in. A failed state other than 'stale' has no list, and no fetchedAt; 'stale' keeps the
   * list from two hours ago; 'loading' has neither, and a fetch running.
   */
  prList(): PullRequestList {
    const refreshing = this.#prsRefreshing || this.#prs === 'loading';
    const fetchedAt = new Date(this.#prsFetchedAt).toISOString();
    const worked = (at: string) => ({ authored: { fetchedAt: at }, 'review-requested': { fetchedAt: at }, mentioned: { fetchedAt: at } });
    // Which owners each root claims (W106): example for the code root, from its clones; none for the second.
    const roots = [{ root: CODE, owners: ['example'], source: 'clones' as const }, ...(this.#roots === 2 ? [{ root: OSS, owners: 'none' as const, source: 'config' as const }] : [])];
    if (this.#prs === 'ok') return { fetchedAt, source: { ok: true }, refreshing, searches: worked(fetchedAt), prs: this.#pullRequests(), roots };
    if (this.#prs === 'mine') {
      return { fetchedAt, source: { ok: true }, refreshing, searches: worked(fetchedAt), prs: this.#pullRequests().filter((pr) => pr.relation === 'authored'), roots };
    }
    if (this.#prs === 'partial') {
      const searches = {
        authored: { fetchedAt },
        'review-requested': { fetchedAt: this.#ago(125), failed: { reason: 'error' as const, error: PRS_SEARCH_ERRORS['review-requested'] } },
        mentioned: { failed: { reason: 'error' as const, error: PRS_SEARCH_ERRORS.mentioned } },
      };
      return { fetchedAt, source: { ok: true }, refreshing, searches, prs: this.#pullRequests().filter((pr) => pr.relation !== 'mentioned'), roots };
    }
    if (this.#prs === 'loading') return { source: { ok: true }, refreshing, prs: [] };
    const reason = this.#prs === 'stale' ? 'error' : this.#prs;
    const source = { ok: false as const, reason, error: PRS_ERRORS[this.#prs] };
    if (this.#prs === 'stale') {
      const failed = { fetchedAt: this.#ago(125), failed: { reason: 'error' as const, error: source.error } };
      return { fetchedAt: this.#ago(125), source, refreshing, searches: { authored: failed, 'review-requested': failed, mentioned: failed }, prs: this.#pullRequests(), roots };
    }
    return { source, refreshing, prs: [] };
  }

  /** Until the next reset, the PR source says `state` (W95). The server sends the list to the page. */
  /**
   * Clone and start (W107), as src/server/clone.ts answers it: the repo of a PR placed 'not-cloned' is
   * cloned to `<root>/<name>`, and its PRs are placed under the clone from then on, until the next
   * reset; 'missing' for a repo with no PR in the list, 'placed' for one that isn't placed 'not-cloned',
   * and 'failed' while failClones() is on. Nothing is written anywhere.
   */
  clone(repo: string): { result: 'cloned'; cwd: string; label: string } | { result: 'missing' | 'placed' | 'failed' } {
    const prs = this.#pullRequests().filter((pr) => pr.repo === repo.toLowerCase());
    if (prs.length === 0) return { result: 'missing' };
    const pr = prs.find((each) => each.place?.kind === 'not-cloned');
    if (pr?.place?.kind !== 'not-cloned') return { result: 'placed' };
    if (this.#cloneFails) return { result: 'failed' };
    const cwd = `${pr.place.root}/${pr.repoLabel.slice(pr.repoLabel.indexOf('/') + 1)}`;
    this.#cloned.set(pr.repo, cwd);
    return { result: 'cloned', cwd, label: pr.repoLabel };
  }

  /** Until the next reset, every clone fails, as gh does for a repo you can't see (W107). */
  failClones(): void {
    this.#cloneFails = true;
  }

  /** Until the next reset, the PR `key` (PRS) is listed as `relation`, as one of yours mentioned by someone else's would be (W108). The server sends the list to the page. */
  listAs(key: string, relation: PullRequestRelation): void {
    this.#relations.set(key, relation);
  }

  setPrs(state: PrsState): void {
    this.#prs = state;
    this.#prsRefreshing = false;
  }

  /**
   * A refresh (W95), in the order W93's poller answers it (src/prs/poller.ts, refresh()): 'off' with
   * pull requests off; 'running' while a fetch runs, before the first included; 'soon', with the
   * seconds left, within PRS_REFRESH_MIN_MS of the latest fetch's start; otherwise 'started', and
   * `done`, which ends the fetch, as it works and the source is ok again.
   */
  refreshPrs(minMs: number): { result: 'off' } | { result: 'running' } | { result: 'soon'; seconds: number } | { result: 'started'; done: () => void } {
    if (this.#prs === 'off') return { result: 'off' };
    if (this.#prsRefreshing || this.#prs === 'loading') return { result: 'running' };
    const now = Date.now();
    const since = now - this.#prsFetchStarted;
    if (since < minMs) return { result: 'soon', seconds: Math.max(1, Math.ceil((minMs - since) / 1000)) };
    this.#prsFetchStarted = now;
    this.#prsRefreshing = true;
    return {
      result: 'started',
      done: () => {
        this.#prsRefreshing = false;
        this.#prs = 'ok';
        this.#prsFetchedAt = Date.now();
      },
    };
  }

  /** The directories under each root, as GET DIRECTORIES_PATH lists them (W70): shallower first, then by path. */
  directories(): DirectoryList {
    const code = { root: CODE, dirs: [{ path: 'api-server', repo: true as const }, { path: 'demo-app', repo: true as const }, { path: 'docs-site', repo: true as const }, { path: 'notes' }, { path: 'api-server/cmd' }, { path: 'demo-app/docs' }, { path: 'demo-app/web' }, { path: 'api-server/cmd/server' }], truncated: false };
    const oss = { root: OSS, dirs: [{ path: 'blog', repo: true as const }, { path: 'blog/drafts' }], truncated: false };
    return { roots: this.#roots === 2 ? [code, oss] : [code] };
  }

  /** The session with this id, if the snapshot lists it. */
  session(sessionId: string): SessionSummary | undefined {
    return this.#sessions.get(sessionId);
  }

  byName(name: string): SessionSummary {
    const found = [...this.#sessions.values()].find((each) => each.name === name);
    if (!found) throw new Error(`no made-up session named ${name}`);
    return found;
  }

  conversation(sessionId: string): ConversationPage | undefined {
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    if (session.name === NAMES.running) return { sessionId, ...this.#working(sessionId) };
    const entries = session.name === NAMES.conversation ? this.#everyKind() : session.name === NAMES.inApi ? this.#namingSubagents() : this.#short(session);
    return { sessionId, entries };
  }

  /**
   * Until the next reset, the session's running turn ends (W102), as the index lists it on its next
   * poll: a background job is done, with its process still there, and its activity moves; its newest
   * page has the command's result and Claude's reply, and says the turn has ended.
   */
  endTurn(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#turnsEnded.add(sessionId);
    this.#sessions.set(sessionId, { ...session, state: 'done', lastActivityAt: new Date().toISOString() });
  }

  /** A listed session's sub-agents (W77): NAMES.inApi's, and none for the rest. */
  subagents(sessionId: string): SubagentList | undefined {
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    if (session.name !== NAMES.inApi) return { sessionId, subagents: [], truncated: false };
    if (!this.#manySubagents) return { sessionId, subagents: this.#subagents(), truncated: false };
    const more = Array.from({ length: 195 }, (_, i): SubagentSummary => ({
      agentId: `pt77more${i}`,
      description: `A made-up older task, number ${i + 1}`,
      state: 'done',
      startedAt: this.#ago(31 + i),
      lastActivityAt: this.#ago(30.5 + i),
      toolCalls: i % 9,
    }));
    return { sessionId, subagents: [...this.#subagents(), ...more], truncated: true };
  }

  /**
   * One of NAMES.inApi's sub-agents' transcripts (W77): the newest page, or, for SUBAGENTS.drafting,
   * the older one behind its cursor. Undefined for anyone else's, as the server's 404 is.
   */
  subagentConversation(sessionId: string, agentId: string, before: string | undefined): ConversationPage | undefined {
    if (this.#sessions.get(sessionId)?.name !== NAMES.inApi) return undefined;
    const agent = this.#subagents().find((each) => each.agentId === agentId);
    if (!agent) return undefined;
    if (before !== undefined) return agentId === SUBAGENTS.drafting.agentId && before === SUBAGENT_CURSOR ? { sessionId, entries: [{ kind: 'user', at: this.#ago(21), text: `The made-up task: ${agent.description}.` }] } : undefined;
    // Its task, from the session or the sub-agent that started it, opens its transcript; SUBAGENTS.drafting's is behind Load earlier.
    const task: ConversationEntry[] = agentId === SUBAGENTS.drafting.agentId ? [] : [{ kind: 'user', at: this.#ago(19.5), text: `The made-up task: ${agent.description}.` }];
    const entries: ConversationEntry[] = [
      ...task,
      { kind: 'assistant', at: this.#ago(19), markdown: true, text: `Working on it: **${agent.description}**.` },
      { kind: 'tool', at: this.#ago(18.5), toolName: 'Read', text: 'Read: src/routes.ts' },
      // Its own Agent call, on its own rather than folded with the Read: the sub-agent it started.
      ...(agentId === SUBAGENTS.reading.agentId
        ? [
            { kind: 'assistant' as const, at: this.#ago(4.5), markdown: true as const, text: 'Starting a made-up check of the tests.' },
            { kind: 'tool' as const, at: this.#ago(4), toolName: 'Agent', text: `Agent: ${SUBAGENTS.checking.description}`, subagent: SUBAGENTS.checking },
          ]
        : []),
      { kind: 'assistant', at: this.#ago(15), markdown: true, text: 'A made-up report: done.' },
    ];
    return agentId === SUBAGENTS.drafting.agentId ? { sessionId, entries, before: SUBAGENT_CURSOR } : { sessionId, entries };
  }

  /** The root a spawn's directory is under, or undefined when it's under none. */
  rootFor(cwd: string): string | undefined {
    return this.roots.filter((root) => cwd === root || cwd.startsWith(`${root}/`)).sort((a, b) => b.length - a.length)[0];
  }

  /** A made-up background session for a spawn, which `list` puts in the snapshot later. */
  spawn(request: SpawnRequest, root: string): { summary: SessionSummary; list: () => void } {
    this.#nextSpawn += 1;
    const n = String(this.#nextSpawn).padStart(3, '0');
    const now = new Date().toISOString();
    const summary: SessionSummary = {
      sessionId: `00000000-0000-4000-8000-000000064${n}`,
      shortId: `pt64s${n}`,
      name: request.name !== undefined && request.name !== '' ? request.name : `pitwall-test-started-${n}`,
      kind: 'background',
      cwd: request.cwd,
      pid: 41_000 + this.#nextSpawn,
      alive: true,
      state: 'working',
      startedAt: now,
      stale: false,
      finished: false,
      lastActivityAt: now,
      lastUserPrompt: 'A made-up first prompt.',
      transcript: 'ok',
    };
    return {
      summary,
      list: () => {
        this.#spawned.push({ summary, root });
        this.#sessions.set(summary.sessionId, summary);
      },
    };
  }

  /**
   * NAMES.ended, resumed (W67): `list` puts it in the snapshot as the index lists one on a later poll,
   * under the same id, as a running background session waiting for a prompt (spike 006). Blocked with
   * Claude Code's "send a prompt to start", which asks nothing, but you resumed it in this run, so it
   * needs you until you prompt it (NeedsYou's 'restarted', W69).
   */
  resume(sessionId: string): { shortId: string; list: () => void } {
    // A background job wakes under its own short id (W107); an ended session takes its id's first 8.
    const shortId = this.#sessions.get(sessionId)?.shortId ?? sessionId.slice(0, 8);
    return {
      shortId,
      list: () => {
        const was = this.#sessions.get(sessionId);
        if (!was) return;
        const resumed: SessionSummary = { ...was };
        delete resumed.ended;
        this.#sessions.set(sessionId, {
          ...resumed,
          kind: 'background',
          shortId,
          pid: 42_000,
          alive: true,
          status: 'idle',
          state: 'blocked',
          finished: false,
          needsYou: { reason: 'restarted' },
          lastActivityAt: new Date().toISOString(),
        });
      },
    };
  }

  /**
   * A running interactive session, ended (W90): listed as an ended one is (W67), finished, with no
   * process, status or need, as the index lists it from its transcript once its process has exited.
   */
  end(sessionId: string): void {
    const was = this.#sessions.get(sessionId);
    if (!was) return;
    const ended: SessionSummary = { ...was, ended: true, finished: true, alive: false, lastActivityAt: new Date().toISOString() };
    for (const key of ['pid', 'status', 'waitingFor', 'needsYou', 'subagentsRunning'] as const) delete ended[key];
    this.#sessions.set(sessionId, ended);
  }

  /**
   * NAMES.endedCopy's original, open in a terminal again (W67): listed under the same id as a running
   * interactive session, as the index lists it once a resume has started a copy (spike 006, finding 5).
   */
  reopen(sessionId: string): void {
    const was = this.#sessions.get(sessionId);
    if (!was) return;
    const open: SessionSummary = { ...was };
    delete open.ended;
    this.#sessions.set(sessionId, { ...open, pid: 42_001, alive: true, status: 'idle', finished: false, lastActivityAt: new Date().toISOString() });
  }

  /**
   * Until the next reset, the session's directory is `cwd`, as for one whose path has a `'` (W87). A
   * path under its group's `.claude/` keeps it in that group, as a worktree's does.
   */
  move(sessionId: string, cwd: string): void {
    const session = this.#sessions.get(sessionId);
    if (session) this.#sessions.set(sessionId, { ...session, cwd });
  }

  /**
   * Until the next reset, what the session needs changes (W88): a new question, a new line from Claude
   * Code, a prompt on screen or a new reason, any of which brings a session marked not needed now back
   * to Needs you.
   */
  need(sessionId: string, change: Partial<Pick<SessionSummary, 'needsYou' | 'askedYou' | 'state' | 'status' | 'waitingFor'>>): void {
    const session = this.#sessions.get(sessionId);
    if (session) this.#sessions.set(sessionId, { ...session, ...change });
  }

  /** What the index shows on a session's row after a relayed message: its latest exchange. */
  relayed(sessionId: string, exchange: RelayExchange): void {
    const session = this.#sessions.get(sessionId);
    if (session) this.#sessions.set(sessionId, { ...session, relay: exchange });
  }

  #isSpawned(session: SessionSummary): boolean {
    return this.#spawned.some((each) => each.summary.sessionId === session.sessionId);
  }

  #ago(minutes: number): string {
    return new Date(this.#now - minutes * MINUTE).toISOString();
  }

  #baseSessions(): SessionSummary[] {
    let n = 0;
    const session = (name: string, extra: Partial<SessionSummary> = {}): SessionSummary => {
      n += 1;
      return {
        sessionId: `00000000-0000-4000-8000-0000000064${String(n).padStart(2, '0')}`,
        name,
        kind: 'interactive',
        cwd: DEMO_APP,
        pid: 40_000 + n,
        alive: true,
        status: 'idle',
        startedAt: this.#ago(180),
        stale: false,
        finished: false,
        lastActivityAt: this.#ago(n * 3),
        lastUserPrompt: 'Tidy the made-up export job.',
        transcript: 'ok',
        ...extra,
      };
    };
    // An ended interactive session (W67), last active `days` ago: finished, with no process, status or state.
    const ended = (name: string, days: number, extra: Partial<SessionSummary> = {}): SessionSummary =>
      session(name, { ended: true, finished: true, alive: false, pid: undefined, status: undefined, lastUserPrompt: 'Tidy the made-up guide.', lastActivityAt: this.#ago(days * 24 * 60), ...extra });
    const job = (name: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
      session(name, { kind: 'background', shortId: `pt64${String(n + 1).padStart(2, '0')}`, status: undefined, state: 'working', ...extra });
    const worked = (label: string, changes: number, calls: number) => ({ key: `${CODE}/${label}`, label, root: CODE, calls, changes, lastAt: this.#ago(2) });
    const all = [
      session(NAMES.waiting, {
        title: 'Update the getting started guide',
        status: 'waiting',
        waitingFor: 'permission prompt',
        needsYou: { reason: 'prompt' },
        lastUserPrompt: 'Update the made-up getting started guide.',
        // It pushed #51's branch after pitwall-test-api opened it, so it owns #51 now (W106).
        prLinks: [this.#link('pushed', PRS.failing, 20)],
      }),
      session(NAMES.asked, {
        title: 'Review the retry change',
        askedYou: { reason: 'question', excerpt: 'Should I retry the failed batch now, or wait for tonight?' },
        needsYou: { reason: 'asked' },
        relay: { sentAt: this.#ago(30), status: 'delivered', reply: { at: this.#ago(29), text: 'Thanks, looking at it now.' } },
        prLinks: [this.#link('opened', PRS.conflicts, 70), this.#link('opened', PRS.approved, 9 * 60), this.#link('mentioned', PRS.failing, 15)],
      }),
      session(NAMES.conversation, { title: 'Add a made-up health route', lastUserPrompt: 'Add a made-up health route to the API, with a test.', prLinks: [this.#link('opened', PRS.failing, 26)] }),
      job(NAMES.running, { prLinks: [this.#link('pushed', PRS.approved, 8 * 60)] }),
      job(NAMES.running2),
      job(NAMES.running3),
      job(NAMES.prompting, { status: 'waiting', state: 'blocked', waitingFor: 'permission prompt', needsYou: { reason: 'prompt' } }),
      job(NAMES.finished, { state: 'done', alive: false, pid: undefined, finished: true, lastActivityAt: this.#ago(95) }),
      session(NAMES.fromRoot, { cwd: CODE, title: 'Tidy both made-up services', workedIn: [worked('api-server', 12, 140), worked('demo-app', 3, 60)], prLinks: [this.#link('pushed', PRS.quiet, 3 * 60)] }),
      session(NAMES.inApi, { cwd: API_SERVER, title: 'Add a made-up route', subagentsRunning: 2, prLinks: [this.#link('mentioned', PRS.conflicts, 60)] }),
      session(NAMES.blog, { cwd: BLOG, title: 'Draft the made-up release notes', status: 'waiting', waitingFor: 'input needed', needsYou: { reason: 'prompt' } }),
      ended(NAMES.ended, 2, { title: 'Tidy the made-up release notes', prLinks: [this.#link('prompted', PRS.quiet, 2 * 24 * 60)] }),
      ended(NAMES.endedAsked, 1, { askedYou: { reason: 'question', excerpt: 'Should the made-up guide keep the old screenshots?' } }),
      ended(NAMES.endedCopy, 3),
      ended(NAMES.endedBusy, 3.5),
      ended(NAMES.endedRefused, 4),
      ended(NAMES.endedNoAnswer, 4.5),
      ended(NAMES.endedGone, 5, { cwd: `${DEMO_APP}/.claude/worktrees/pitwall-test-gone`, cwdMissing: true }),
      ended(NAMES.endedSlow, 4.75),
      ended(NAMES.endedOld, 10),
      ended(NAMES.endedOldOnly, 20, { cwd: DOCS_SITE }),
      ended(NAMES.endedPr, 3, { cwd: API_SERVER, title: 'Add a made-up retry header', prLinks: [this.#link('opened', PRS.endedWork, 3 * 24 * 60)] }),
    ];
    return all;
  }

  /** The made-up open PRs, newest updated first, as the search returns them. */
  #pullRequests(): PullRequestSummary[] {
    // Where the server places each one (W106): under its clone, or not cloned under the root that claims example.
    const clones: Readonly<Record<string, string>> = { 'example/demo-app': DEMO_APP, 'example/api-server': API_SERVER, 'example/event-relay': EVENT_RELAY, ...Object.fromEntries(this.#cloned) };
    const placeOf = (repo: string): PullRequestPlace | undefined => {
      const clone = clones[repo];
      if (clone) return { kind: 'cloned', root: CODE, key: clone, label: clone.slice(CODE.length + 1) };
      if (repo.startsWith('example/')) return { kind: 'not-cloned', root: CODE };
      return repo.startsWith('other-org/') ? { kind: 'unclaimed' } : undefined;
    };
    const make = (key: string, minutes: number, extra: Partial<PullRequestSummary>): PullRequestSummary => {
      const [owner = '', name = '', number = '0'] = key.split('/');
      const repo = `${owner}/${name}`;
      const place = placeOf(repo);
      return {
        ...(place ? { place } : {}),
        url: `https://github.com/${repo}/pull/${number}`,
        repo,
        repoLabel: repo,
        number: Number(number),
        title: 'A made-up change',
        draft: false,
        createdAt: this.#ago(minutes + 3 * 24 * 60),
        updatedAt: this.#ago(minutes),
        head: { repo, branch: `pitwall-test/${name}-${number}` },
        checks: 'passing',
        mergeable: 'clean',
        relation: 'authored',
        ...extra,
        ...(this.#relations.has(key) ? { relation: this.#relations.get(key) as PullRequestRelation } : {}),
      };
    };
    const day = 24 * 60;
    return [
      make(PRS.failing, 25, { title: 'Add a made-up health route', checks: 'failing', failingChecks: ['test (22.x)', 'lint', 'e2e (chrome)'], failingCount: 5, review: 'review-required' }),
      make(PRS.conflicts, 70, { title: 'Retry made-up deliveries with backoff', mergeable: 'conflicts', review: 'changes-requested' }),
      make(PRS.quiet, 3 * 60, { title: 'Add a made-up rate limit to the API' }),
      make(PRS.approved, 9 * 60, { title: 'Tidy the made-up export job', review: 'approved' }),
      make(PRS.draft, 4 * day, { title: 'Document the made-up retry headers', draft: true, checks: 'pending', mergeable: 'unknown' }),
      make(PRS.older, 120 * day, { title: 'Move the made-up guide to its own page', review: 'review-required' }),
      make(PRS.olderFailing, 200 * day, { title: 'A made-up old experiment with queues', checks: 'failing', failingChecks: ['build'] }),
      make(PRS.review, 40, { title: 'Add a made-up retry budget', review: 'review-required', relation: 'review-requested', reviewRequest: { via: 'direct' } }),
      make(PRS.teamReview, 2 * 60, {
        title: 'Rename the made-up delivery states',
        checks: 'failing',
        failingChecks: ['lint'],
        review: 'review-required',
        relation: 'review-requested',
        reviewRequest: { via: 'team', team: PR_TEAM },
      }),
      make(PRS.mentioned, 5 * 60, { title: 'Ask about the made-up rate limit headers', review: 'review-required', relation: 'mentioned' }),
      make(PRS.notCloned, 3 * 60, { title: 'Add a made-up example to the SDK docs' }),
      make(PRS.endedWork, day, { title: 'Add a made-up retry header' }),
      make(PRS.unclaimed, 6 * 60, { title: 'A made-up fix elsewhere' }),
      make(PRS.unplaced, 7 * 60, { title: 'A made-up fix in another org' }),
    ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  /** A session's link to one of PRS (W95): by repo and number, or for 'pushed', by its head branch. */
  #link(kind: PrLink['kind'], key: string, minutes: number): PrLink {
    const [owner = '', name = '', number = '0'] = key.split('/');
    const repo = `${owner}/${name}`;
    if (kind === 'pushed') return { kind, repo, branch: `pitwall-test/${name}-${number}`, lastAt: this.#ago(minutes) };
    return { kind, repo, number: Number(number), lastAt: this.#ago(minutes) };
  }

  #subagents(): SubagentSummary[] {
    return [
      { ...SUBAGENTS.checking, agentType: 'Explore', state: 'running', startedBy: SUBAGENTS.reading.agentId, startedAt: this.#ago(4), lastActivityAt: this.#ago(0.2), toolCalls: 3 },
      { ...SUBAGENTS.reading, agentType: 'general-purpose', state: 'running', background: true, startedAt: this.#ago(6), lastActivityAt: this.#ago(0.1), toolCalls: 7 },
      { ...SUBAGENTS.drafting, agentType: 'general-purpose', state: 'done', startedAt: this.#ago(20), lastActivityAt: this.#ago(15), toolCalls: 12 },
      { ...SUBAGENTS.failed, agentType: 'Explore', state: 'failed', startedAt: this.#ago(25), lastActivityAt: this.#ago(24), toolCalls: 2 },
      { ...SUBAGENTS.stopped, state: 'stopped', startedAt: this.#ago(30), lastActivityAt: this.#ago(29), toolCalls: 0 },
    ];
  }

  /** NAMES.inApi's conversation: the call that started a sub-agent and its report, then two calls folded, one starting another and one messaging it. */
  #namingSubagents(): ConversationEntry[] {
    return [
      { kind: 'user', at: this.#ago(22), text: 'Add a made-up route, and draft its changelog entry.' },
      { kind: 'tool', at: this.#ago(20), toolName: 'Agent', text: `Agent: ${SUBAGENTS.drafting.description}`, subagent: SUBAGENTS.drafting },
      { kind: 'cross-session', at: this.#ago(15), from: SUBAGENTS.drafting.agentId, markdown: true, text: 'The made-up changelog entry is drafted.', subagent: SUBAGENTS.drafting },
      { kind: 'assistant', at: this.#ago(14), markdown: true, text: 'The entry is in. Starting on the routes.' },
      { kind: 'tool', at: this.#ago(6), toolName: 'Agent', text: `Agent: ${SUBAGENTS.reading.description}`, subagent: SUBAGENTS.reading },
      { kind: 'tool', at: this.#ago(2), toolName: 'SendMessage', text: 'SendMessage', subagent: SUBAGENTS.reading },
    ];
  }

  /**
   * NAMES.running's turn (W102): your prompt 3 minutes ago, a test run that failed, a prompt you typed
   * mid-turn, which doesn't restart the turn's time, and a command still waiting on its result, as
   * the server sends them, a call's `toolError` set once its result is in. After endTurn(), the
   * command's result, Claude's reply, and the turn's end.
   */
  #working(sessionId: string): Pick<ConversationPage, 'entries' | 'turnEnded'> {
    const entries: ConversationEntry[] = [
      { kind: 'user', at: this.#ago(3.4), text: 'Run the made-up export tests and fix what fails.' },
      { kind: 'assistant', at: this.#ago(3.3), markdown: true, text: "I'll run the export tests first." },
      { kind: 'tool', at: this.#ago(3.2), toolName: 'Bash', text: 'Bash: npm test -- export', toolError: true },
      { kind: 'user', at: this.#ago(1.5), text: 'Skip the slow ones for now.', midTurn: true },
      { kind: 'tool', at: this.#ago(0.5), toolName: 'Bash', text: 'Bash: npm test -- export --skip-slow' },
    ];
    if (!this.#turnsEnded.has(sessionId)) return { entries, turnEnded: false };
    const done = { ...entries[entries.length - 1], toolError: false } as ConversationEntry;
    return { entries: [...entries.slice(0, -1), done, { kind: 'assistant', at: new Date().toISOString(), markdown: true, text: 'The made-up export tests pass now.' }], turnEnded: true };
  }

  #short(session: SessionSummary): ConversationEntry[] {
    return [
      { kind: 'user', at: this.#ago(12), text: `A made-up prompt for ${session.name}: tidy the export job.` },
      { kind: 'assistant', at: this.#ago(11), text: 'A made-up reply: the export job now retries **three times**, with backoff.', markdown: true },
    ];
  }

  /** Every kind of entry the session view shows, oldest first. */
  #everyKind(): ConversationEntry[] {
    return [
      { kind: 'user', at: this.#ago(40), text: 'Add a made-up health route to the API, with a test.' },
      { kind: 'assistant', at: this.#ago(39), markdown: true, text: "I'll start with the routes file.\n\n- read `src/routes.ts`\n- add `GET /health`\n- add a test" },
      { kind: 'tool', at: this.#ago(38), toolName: 'Read', text: 'Read: src/routes.ts' },
      { kind: 'assistant', at: this.#ago(37), markdown: true, text: 'The route is in. Running the tests now.' },
      { kind: 'tool', at: this.#ago(36), toolName: 'Bash', text: 'Bash: npm test', toolError: true },
      { kind: 'tool', at: this.#ago(35), toolName: 'Edit', text: 'Edit: src/routes.test.ts' },
      { kind: 'tool', at: this.#ago(34), toolName: 'Bash', text: 'Bash: npm test' },
      {
        kind: 'question',
        at: this.#ago(33),
        text: 'Which status should the health route return?',
        questions: [
          {
            header: 'Status',
            question: 'Which status should the health route return?',
            options: [{ label: '200 OK', description: 'With a small JSON body.' }, { label: '204 No Content' }],
            answer: '200 OK',
          },
        ],
      },
      { kind: 'cross-session', at: this.#ago(30), from: 'pitwall-test-reviewer', markdown: true, text: 'Please check the made-up CI run before merging.' },
      { kind: 'to-pitwall', at: this.#ago(28), markdown: true, text: 'Checked: both flows pass, and the run is green.' },
      { kind: 'notice', at: this.#ago(26), text: 'Conversation compacted.' },
      {
        kind: 'assistant',
        at: this.#ago(25),
        markdown: true,
        text: [
          `The pull request is up: [${LINKS.misleadingText}](${LINKS.misleadingHref}), and its run is ${LINKS.bare}.`,
          '',
          `The notes are at <${LINKS.ownAddress}>, and you can sign in at [the dashboard](${LINKS.lookAlike}) to see the logs.`,
        ].join('\n'),
      },
    ];
  }
}

/** A terminal's size, as the page sends it with `open` and `resize`. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * What ends the made-up screen's last row, in its last column, in a colour of its own, so the page
 * draws it in an element of its own (W74).
 */
export const FOOTER_END = 'last column';

/**
 * The screen a made-up attached session shows at `size`, as a PTY would send it, drawn afresh on a
 * cleared screen, as Claude Code redraws it on every resize. Like Claude Code's, it fills the screen
 * (W74): a prompt box across every column above a footer pinned to the last row, which ends with
 * FOOTER_END in the last column. The cursor is left in the prompt.
 */
export function terminalScreen(session: SessionSummary, { cols, rows }: TerminalSize): string {
  const at = (row: number, col = 1) => `\u001b[${row};${col}H`;
  const dim = (text: string) => `\u001b[2m${text}\u001b[0m`;
  const lines = [`${at(1)}\u001b[1m${session.name}\u001b[0m, a made-up session for the app check`];
  if (session.status === 'waiting') {
    lines.push(`${at(3)}Allow the made-up deploy check to run?`, `${at(4)}\u001b[36m❯ 1. Yes\u001b[0m`, `${at(5)}  2. No, and tell Claude what to do differently`);
  }
  const inside = Math.max(0, cols - 2);
  lines.push(`${at(rows - 2)}${dim(`╭${'─'.repeat(inside)}╮`)}`, `${at(rows - 1)}${dim('│')}${at(rows - 1, cols)}${dim('│')}`);
  const end = FOOTER_END.slice(0, cols);
  lines.push(`${at(rows)}${'  ? for made-up shortcuts'.slice(0, cols - end.length).padEnd(cols - end.length)}\u001b[36m${end}\u001b[0m`);
  return `\u001b[H\u001b[2J${lines.join('')}${at(rows - 1, 3)}\u001b[32m>\u001b[0m `;
}
