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
  ApprovalProfile,
  ConversationEntry,
  ConversationPage,
  DirectoryList,
  IndexSnapshot,
  PrLink,
  PullRequestList,
  PullRequestPlace,
  PullRequestRelation,
  PullRequestSummary,
  RecapHealth,
  RelayExchange,
  SessionGroup,
  SessionRecap,
  SessionSummary,
  SpawnRequest,
  SpinOff,
  SubagentList,
  SubagentSummary,
  SupervisorApproval,
  SupervisorHandoff,
  SupervisorDecision,
  SupervisorState,
  SupervisorStatus,
  UsageTokens,
  UsageView,
  UsageWindowKey,
  RunRate,
} from '../../src/shared/protocol.js';
import { withSupervisorFooter } from '../../src/shared/protocol.js';
import { DEFAULT_RUN_RATE_TARGET, levelOf, paceAt, project, WEEK_MS, type WeekReading } from '../../src/usage/runRate.js';
import { REFUSED_TO_SUPERVISOR_NOTICE } from '../../src/index/conversation.js';

export const CODE = '/Users/example/code';
export const OSS = '/Users/example/oss';
export const API_SERVER = `${CODE}/api-server`;
export const DEMO_APP = `${CODE}/demo-app`;
export const BLOG = `${OSS}/blog`;
/** A directory whose only session ended long ago (W67), so it's in the repo list only with Show older on. */
export const DOCS_SITE = `${CODE}/docs-site`;
/** A directory no session has worked in, which New session's autocomplete offers (W70). */
export const DEMO_APP_WEB = `${DEMO_APP}/web`;
/**
 * A made-up proposal for a new session (W163), which a part puts on NAMES.conversation with
 * world.spinOff(): in demo-app/web, named, with a prompt of twelve lines, so its card's box scrolls.
 */
export const SPIN_OFF_PROMPT = [
  'Rework the made-up web app’s settings page so each section saves on its own.',
  '',
  ...Array.from({ length: 9 }, (_, index) => `- Step ${index + 1}: a made-up step for the app check.`),
  'Run npm test in web/ when it’s done, and tell me what changed.',
].join('\n');
export const SPIN_OFF: SpinOff = { kind: 'proposal', key: '5f1a0c7e9b3d2a41', folder: DEMO_APP_WEB, name: 'pitwall-test-spin-off', prompt: SPIN_OFF_PROMPT };
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
  /**
   * With `cloned` only (W145): started in docs-site, a directory below the root in no repo, then
   * cloned sdk-cli there and worked in it alone, so Main repo lists it under sdk-cli, which nothing
   * started in.
   */
  cloned: 'pitwall-test-cloned',
} as const;

/** The repo NAMES.cloned cloned and worked in (W145): it has no group in the snapshot. */
export const SDK_CLI = `${CODE}/sdk-cli`;

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

/**
 * What recaps say (M5, W111): 'off', the default, as with --no-recaps, so the parts before W111 see
 * the session view as they did; 'ok', with some calls made today and made-up recaps for some
 * sessions (RECAPPED); 'spent', the day's budget used up; 'failing', the latest call failed, and so
 * does each one asked for.
 */
export type RecapsState = 'off' | 'ok' | 'spent' | 'failing';

/** The error 'failing' says, in pitwall's made-up words. */
export const RECAPS_ERROR = "Made up: claude -p didn't answer within 60 seconds.";

/** How long a made-up recap call takes, so Refresh shows its spinner. */
export const RECAP_CALL_MS = 600;

/**
 * The picture of RECAPPED.you's recap (W150): the goal, what it's on and why, and the plan's line,
 * with the plan's items and how it changed (W172).
 */
export const RECAP_PICTURE = {
  goal: 'Give the made-up API a health route that the load balancer can check.',
  workingOn: '#51: the health route and its test, which the load balancer needs before the old ping can go.',
  plan: 'The made-up API plan: #51, then the load balancer, then retiring the ping; on #51 now',
  planItems: [
    { text: 'W1: the route and its test', state: 'done' },
    { text: 'W2: fix the lint errors on #51', state: 'now' },
    { text: 'W3: rate limit the route', state: 'dropped' },
    { text: 'W4: point the made-up load balancer at the route', state: 'next' },
    { text: 'W5: retire the old ping and document the route in the made-up API guide', state: 'next' },
  ],
  planChanges: 'W3 was dropped: the made-up gateway already limits the route.',
} as const;

/** The picture of RECAPPED.anotherSession's recap: a plan with items and no changes (W172). */
export const RECAP_PICTURE_STEADY = {
  goal: 'Add a made-up route on top of the health route, so the load balancer can check both.',
  workingOn: 'Step 2: drafting the route and its tests, which need the health route from pitwall-test-api first.',
  plan: 'The made-up route plan, in three steps; on step 2 now',
  planItems: [
    { text: 'Step 1: agree the route with the health route session', state: 'done' },
    { text: 'Step 2: draft the route and its tests', state: 'now' },
    { text: 'Step 3: open the PR once the health route lands', state: 'next' },
  ],
} as const;

/**
 * The sessions with a recap while recaps are on, by role: what each waits on, and whether it's
 * current. A current recap that waits on you adds Needs you's 'recap' reason, as the index does
 * (W110), unless the session needs you for another reason already. The rest have none, and a view
 * opened on one asks for one.
 */
export const RECAPPED = {
  /** NAMES.conversation: current, waiting on you. */
  you: NAMES.conversation,
  /** NAMES.asked: waiting on you, but older than its latest turn, so its view asks for a new one. */
  stale: NAMES.asked,
  /** NAMES.fromRoot: current, waiting on someone else, so its row says so quietly. */
  someoneElse: NAMES.fromRoot,
  /** NAMES.inApi: current, waiting on another session. */
  anotherSession: NAMES.inApi,
  /** NAMES.running2: current, waiting on CI; it works, so its row says nothing of it. */
  ci: NAMES.running2,
  /** NAMES.finished: current, nothing pending: Done. */
  done: NAMES.finished,
  /** NAMES.running3: only Claude Code's own recap. */
  claudeCode: NAMES.running3,
} as const;

/**
 * The supervisor (M5, W114): 'none', the default, as with --no-supervisor, so the parts before W114
 * see the repo list and the page as they did; otherwise its status as the page finds it. A message
 * sent to it while it's off or idle starts a made-up turn: 'starting' for a moment when it was off,
 * then 'working', with your message in its conversation, then 'idle', with its made-up reply.
 */
export type SupervisorWorldState = 'none' | SupervisorStatus;

/** How long a made-up supervisor turn's steps take, so the page shows each one. */
export const SUPERVISOR_STEP_MS = 700;

/** What a held supervisor's made-up error says, naming the claude stop command, as the contract has it. */
export const SUPERVISOR_HELD_ERROR =
  "A background session is running the supervisor's conversation, so pitwall can't resume it. Run `claude stop pt114bg1` to hand it back, then press Start. pitwall won't stop it for you.";
export const SUPERVISOR_FAILED_ERROR = 'The supervisor stopped as it started (exit code 1). Press Start to try again.';

/** What its error adds while a message of yours waits for its next start (W114's review), and what New conversation's refusal then says (W136). */
export const SUPERVISOR_QUEUED_NOTE = 'Your message waits to be sent when it starts.';
/** New conversation's refusal when the snapshot didn't predict it: another tab pressed Start in between (W136). */
export const SUPERVISOR_RACE_REFUSAL = 'The supervisor is starting. Start a new conversation once it has started.';

/** The made-up context of a conversation with history (W136): "Context 84K" in its header. */
export const SUPERVISOR_CONTEXT = 84_010;

/** The made-up reply each message gets, in markdown, naming made-up sessions and example/* repos. */
export const SUPERVISOR_REPLY =
  'Two sessions need you:\n\n1. **pitwall-test-docs** waits on a permission prompt to run the made-up docs build.\n2. **pitwall-test-review** asked whether to retry the failed batch on `example/api-server` now or tonight.\n\nNothing else needs you.';

/** Its made-up drafts, oldest first: a message to a session, and a new session for a PR. */
export const SUPERVISOR_APPROVALS = {
  message: 'pt114-approval-message',
  spawn: 'pt114-approval-spawn',
  resume: 'pt127-approval-resume',
  longer: 'pt136-approval-longer',
} as const;

/** The profiles a new session's and a resume's card offer (W156), resolved as pitwall's built-ins are, Review with a made-up skill. */
export const APPROVAL_PROFILES: readonly ApprovalProfile[] = [
  { name: 'Build', model: 'claude-opus-5-5', effort: 'high', subagentModel: 'sonnet' },
  { name: 'Review', model: 'sonnet', effort: 'high', subagentModel: 'sonnet', skill: 'agent-roles:role-reviewer' },
  { name: 'Security review', model: 'claude-opus-5-5', effort: 'xhigh', subagentModel: 'opus' },
  { name: 'Docs', model: 'sonnet', effort: 'medium', subagentModel: 'sonnet' },
];

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
  /** What recaps say (W111): 'off', as with --no-recaps, by default. */
  recaps?: RecapsState;
  /** The supervisor (W114): 'none', as with --no-supervisor, by default. */
  supervisor?: SupervisorWorldState;
  /**
   * Whether it has made-up drafts waiting on you, a message and a new session (W114), or 'long', a
   * message of 14 lines with a no-break space, which the card draws as its code (W120), then one of 60
   * lines, longer than half the window (W136).
   */
  approvals?: boolean | 'long' | 'resume';
  /** Whether its conversation has made-up turns already, with a page behind Load earlier, or none, a new one. */
  supervisorHistory?: boolean;
  /** Whether a message of yours waits for its next start, as after it failed mid-turn: New conversation drops it (W136's review). */
  supervisorQueued?: boolean;
  /** Whether New conversation is refused as if another tab had pressed Start in between: a refusal the snapshot didn't show (W136). */
  supervisorRaced?: boolean;
  /** Whether NAMES.cloned is listed too (W145), a session that started in docs-site and worked in sdk-cli alone. */
  cloned?: boolean;
  /**
   * What GET USAGE_PATH answers (W158): 'ok', made-up figures with the plan's week; 'unavailable',
   * the same figures without it, the last 7 days; 'empty', the plan's week with no calls in it;
   * 'failing', HTTP 500.
   */
  usage?: UsageWorldState;
  /**
   * The header's run rate (W159): 'off', the default, as with --no-usage, so the snapshot has no
   * planUsage and the header no figures; 'normal', under the line; 'ahead', over it; 'amber' at 74%
   * with the five hours at 35%; 'red' at 93%; 'old', a reading 25 minutes old; 'unavailable'.
   */
  runRate?: RunRateWorldState;
}

export type UsageWorldState = 'ok' | 'unavailable' | 'empty' | 'failing';
export type RunRateWorldState = 'off' | 'normal' | 'ahead' | 'amber' | 'red' | 'old' | 'unavailable';

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
  /** What the Usage view's route answers (W158), and the windows asked for since the last reset. */
  #usage: UsageWorldState = 'ok';
  /** What the run rate's route answers (W159). */
  #runRate: RunRateWorldState = 'off';
  /** The sessions whose running turn `endTurn()` has ended, until the next reset (W102). */
  #turnsEnded = new Set<string>();
  /** What the PR source says, and whether a fetch is running (W95). */
  #prs: PrsState = 'ok';
  #prsRefreshing = false;
  /** When the latest fetch finished, and started: a refresh within PRS_REFRESH_MIN_MS of the start gets 429. */
  #prsFetchedAt = 0;
  #prsFetchStarted = 0;
  /** Recaps (W111): their state, the recaps by session id, today's calls, the calls running, and the day's budget. */
  #recapsState: RecapsState = 'off';
  #recaps = new Map<string, SessionRecap>();
  #recapCalls = 0;
  #recapping = new Set<string>();
  #recapBudget = 200;
  /** When the latest made-up call failed, for RecapHealth.errorAt, with 'failing'. */
  #recapErrorAt = 0;
  /** The repos Clone and start has cloned since the last reset (W107), by repo, with where. */
  #cloned = new Map<string, string>();
  /** Whether a clone fails, as gh does for a repo you can't see (W107). */
  #cloneFails = false;
  /** PRs listed with another relation than their own until the next reset, by key (W108): `notYours()`. */
  #relations = new Map<string, PullRequestRelation>();
  /** The supervisor (W114): its status, drafts, conversation and cost, and its timers' generation. */
  #supervisor: SupervisorWorldState = 'none';
  #approvals: SupervisorApproval[] = [];
  /** What you approved (W124): each message sent and session started, oldest first. */
  #handoffs: SupervisorHandoff[] = [];
  #supervisorEntries: ConversationEntry[] = [];
  #supervisorOlder: ConversationEntry[] = [];
  #supervisorCost = 0;
  #supervisorTurnAt: string | undefined;
  /** Its newest call's context (W136), once a turn has said. */
  #supervisorContext: number | undefined;
  /** A message of yours waits for its next start (W136's refusal). */
  #supervisorQueued = false;
  #supervisorRaced = false;
  /** Each made-up turn's number: Stop and a reset end the one running, so its later steps do nothing. */
  #supervisorTurn = 0;

  constructor() {
    this.reset();
  }

  /** The day's recap budget, from the build's RECAP_DAILY_BUDGET, which the fake server passes. */
  setRecapBudget(budget: number): void {
    this.#recapBudget = budget;
    if (this.#recapsState === 'spent') this.#recapCalls = budget;
  }

  reset(options: ResetOptions = {}): void {
    this.#now = Date.now();
    this.#roots = options.roots ?? 1;
    this.#labels = options.labels ?? {};
    this.#spawned = [];
    this.#manySubagents = false;
    this.#usage = options.usage ?? 'ok';
    this.#runRate = options.runRate ?? 'off';
    this.#turnsEnded = new Set();
    this.#prs = options.prs ?? 'ok';
    this.#prsRefreshing = false;
    // Fetched two minutes ago, by the poll, so a refresh now is allowed.
    this.#prsFetchedAt = this.#now - 2 * MINUTE;
    this.#prsFetchStarted = this.#prsFetchedAt - 8_500;
    this.#cloned = new Map();
    this.#cloneFails = false;
    this.#relations = new Map();
    this.#sessions = new Map(this.#baseSessions(options.cloned ?? false).map((each) => [each.sessionId, each]));
    this.#recapsState = options.recaps ?? 'off';
    this.#recapCalls = this.#recapsState === 'spent' ? this.#recapBudget : 37;
    this.#recapping = new Set();
    this.#recapErrorAt = this.#now - 3 * MINUTE;
    this.#recaps = new Map(this.#recapsState === 'off' ? [] : this.#baseRecaps().map((each) => [this.byName(each.name).sessionId, each.recap]));
    this.#supervisorTurn += 1;
    this.#supervisor = options.supervisor ?? 'none';
    this.#handoffs = [];
    this.#approvals = options.approvals === 'long' ? [this.#longApproval(), this.#longerApproval()] : options.approvals === 'resume' ? [this.#resumeApproval()] : options.approvals ? this.#baseApprovals() : [];
    const history = options.supervisorHistory ?? (this.#supervisor !== 'none' && this.#supervisor !== 'off');
    this.#supervisorEntries = history ? this.#supervisorTurns() : [];
    this.#supervisorOlder = history ? this.#supervisorOlderTurns() : [];
    this.#supervisorCost = history ? 0.0425 : 0;
    this.#supervisorTurnAt = history ? this.#ago(4) : undefined;
    this.#supervisorContext = history ? SUPERVISOR_CONTEXT : undefined;
    this.#supervisorQueued = options.supervisorQueued ?? false;
    this.#supervisorRaced = options.supervisorRaced ?? false;
  }

  // --- The supervisor (W114) ---------------------------------------------------------------------

  /** Its state, as the snapshot carries it: absent with 'none', as with --no-supervisor. */
  supervisorState(): SupervisorState | undefined {
    if (this.#supervisor === 'none') return undefined;
    const state: SupervisorState = { status: this.#supervisor, approvals: [...this.#approvals] };
    if (this.#supervisorEntries.length > 0) state.sessionId = 'pt114-supervisor-session';
    if (this.#supervisor === 'held') state.error = SUPERVISOR_HELD_ERROR;
    if (this.#supervisor === 'failed') state.error = this.#supervisorQueued ? `${SUPERVISOR_FAILED_ERROR} ${SUPERVISOR_QUEUED_NOTE}` : SUPERVISOR_FAILED_ERROR;
    if (this.#supervisorTurnAt !== undefined) state.lastTurnAt = this.#supervisorTurnAt;
    if (this.#supervisorCost > 0) state.costUsd = this.#supervisorCost;
    if (this.#handoffs.length > 0) state.handoffs = [...this.#handoffs];
    if (this.#supervisorContext !== undefined) state.contextTokens = this.#supervisorContext;
    return state;
  }

  /** Its conversation's newest page, or the older one behind Load earlier; undefined for none yet, a 404, or a cursor it doesn't know. */
  supervisorConversation(before: string | undefined): ConversationPage | undefined {
    if (this.#supervisor === 'none' || this.#supervisorEntries.length === 0) return undefined;
    const sessionId = 'pt114-supervisor-session';
    if (before === undefined) return { sessionId, entries: [...this.#supervisorEntries], ...(this.#supervisorOlder.length > 0 ? { before: 'pt114-older' } : {}) };
    return before === 'pt114-older' ? { sessionId, entries: [...this.#supervisorOlder] } : undefined;
  }

  /**
   * A message to it (SUPERVISOR_MESSAGE_PATH), as the contract answers: 'refused' with none or while
   * it's held (409); otherwise taken, and `steps`, which the server runs a moment apart: starting, if it
   * was off or failed, then working with your message in its conversation, then idle with its reply.
   */
  supervisorMessage(text: string): { result: 'refused' } | { result: 'taken'; steps: Array<() => void> } {
    if (this.#supervisor === 'none' || this.#supervisor === 'held') return { result: 'refused' };
    const steps: Array<() => void> = [];
    if (this.#supervisor === 'off' || this.#supervisor === 'failed') {
      this.#supervisor = 'starting';
    }
    const turn = ++this.#supervisorTurn;
    const live = () => turn === this.#supervisorTurn;
    steps.push(() => {
      if (!live()) return;
      this.#supervisor = 'working';
      this.#supervisorEntries.push({ kind: 'user', text, at: new Date().toISOString() });
      this.#supervisorEntries.push({ kind: 'tool', text: 'mcp__pitwall__list_sessions', toolName: 'mcp__pitwall__list_sessions', at: new Date().toISOString() });
    });
    steps.push(() => {
      if (!live()) return;
      this.#supervisorEntries.push({ kind: 'assistant', text: SUPERVISOR_REPLY, markdown: true, at: new Date().toISOString() });
      this.#supervisor = 'idle';
      this.#supervisorTurnAt = new Date().toISOString();
      this.#supervisorCost += 0.0099;
      // Its newest call read the conversation again, a little longer each turn.
      this.#supervisorContext = (this.#supervisorContext ?? 18_000) + 3_200;
    });
    return { result: 'taken', steps };
  }

  /** Start (SUPERVISOR_START_PATH): 'refused' with none or while it's held; otherwise starting, then idle a moment later. */
  supervisorStart(): { result: 'refused' } | { result: 'taken'; steps: Array<() => void> } {
    if (this.#supervisor === 'none' || this.#supervisor === 'held') return { result: 'refused' };
    if (this.#supervisor !== 'off' && this.#supervisor !== 'failed') return { result: 'taken', steps: [] };
    this.#supervisor = 'starting';
    return {
      result: 'taken',
      steps: [
        () => {
          this.#supervisor = 'idle';
        },
      ],
    };
  }

  /**
   * New conversation (SUPERVISOR_NEW_CONVERSATION_PATH, W136), as src/supervisor/supervisor.ts answers:
   * refused, with its reason, while it's held, starting or working, while drafts wait, your messages waiting dropped;
   * otherwise off, with the conversation, its last turn, its context and its hand-offs gone, and this
   * run's cost kept.
   */
  supervisorNewConversation(): { result: 'refused'; error: string } | { result: 'done' } {
    if (this.#supervisor === 'none') return { result: 'refused', error: 'The supervisor is off: pitwall was started with --no-supervisor.' };
    if (this.#supervisor === 'held') return { result: 'refused', error: "Another session is running the supervisor's conversation, so pitwall leaves it alone. Free it as the alert says, then start a new conversation." };
    if (this.#supervisor === 'starting') return { result: 'refused', error: 'The supervisor is starting. Start a new conversation once it has started.' };
    if (this.#supervisor === 'working') return { result: 'refused', error: 'The supervisor is working on a turn of this conversation. Stop it, or wait for it to end, then start a new conversation.' };
    if (this.#approvals.length > 0) return { result: 'refused', error: `${this.#approvals.length} drafts from this conversation wait for you. Send or don't send each one first, then start a new conversation.` };
    if (this.#supervisorRaced) return { result: 'refused', error: SUPERVISOR_RACE_REFUSAL };
    this.#supervisorQueued = false;
    this.#supervisorTurn += 1;
    this.#supervisor = 'off';
    this.#supervisorEntries = [];
    this.#supervisorOlder = [];
    this.#supervisorTurnAt = undefined;
    this.#supervisorContext = undefined;
    this.#handoffs = [];
    return { result: 'done' };
  }

  /** Stop (SUPERVISOR_INTERRUPT_PATH): its running turn stops, with Claude Code's notice. */
  supervisorInterrupt(): boolean {
    if (this.#supervisor !== 'working') return false;
    this.#supervisorTurn += 1;
    this.#supervisorEntries.push({ kind: 'notice', text: '[Request interrupted by user]', at: new Date().toISOString() });
    this.#supervisor = 'idle';
    this.#supervisorTurnAt = new Date().toISOString();
    return true;
  }

  /** A decision for one approval (supervisorApprovalPath()): 'missing' for one it doesn't have (404), else it goes, `done` a moment later, as pitwall acts on it. */
  supervisorDecide(id: string, decision: SupervisorDecision): { result: 'missing' } | { result: 'taken'; done: () => void } {
    const approval = this.#approvals.find((each) => each.id === id);
    if (!approval) return { result: 'missing' };
    return {
      result: 'taken',
      done: () => {
        this.#approvals = this.#approvals.filter((each) => each.id !== id);
        const what = decision.decision === 'decline' ? "You didn't send it." : decision.decision === 'edit' ? 'You sent your edit.' : 'You sent it.';
        const named = approval.kind === 'message' ? `Message to ${approval.to}` : approval.kind === 'resume' ? `Resume ${approval.name}` : `New session in ${approval.directory}`;
        this.#supervisorEntries.push({ kind: 'notice', text: `${named}: ${what}`, at: new Date().toISOString() });
        // What went, for the panel's Sent and started (W124): a message to the session of that name, or
        // a new background session, listed at once, that needs you, as one that has a question would.
        if (decision.decision !== 'decline') {
          const at = new Date().toISOString();
          if (approval.kind === 'message') {
            const to = [...this.#sessions.values()].find((each) => each.name === approval.to);
            this.#handoffs.push({ id: `pt124-handoff-${this.#handoffs.length + 1}`, kind: 'message', name: approval.to, at, ...(to === undefined ? {} : { sessionId: to.sessionId }) });
          } else if (approval.kind === 'resume') {
            // W127: resumed with the message as its next turn, so it's working, not waiting for a prompt.
            const resumed = this.resume(approval.sessionId);
            resumed.list();
            const now = this.#sessions.get(approval.sessionId);
            if (now !== undefined) {
              const working: SessionSummary = { ...now, status: 'busy', state: 'working' };
              delete working.needsYou;
              this.#sessions.set(approval.sessionId, working);
            }
            this.#handoffs.push({ id: `pt127-handoff-${this.#handoffs.length + 1}`, kind: 'resume', name: approval.name, sessionId: approval.sessionId, shortId: resumed.shortId, at });
          } else {
            const started = this.spawn({ cwd: approval.directory, prompt: approval.prompt, ...(approval.name === undefined ? {} : { name: approval.name }) }, CODE);
            started.summary.needsYou = { reason: 'claude-code', text: 'Which base branch should the made-up review compare against?' };
            started.summary.state = 'blocked';
            started.list();
            this.#handoffs.push({ id: `pt124-handoff-${this.#handoffs.length + 1}`, kind: 'spawn', name: started.summary.name, shortId: started.summary.shortId!, at });
          }
        }
        // Told what you decided, it takes a short turn, so its last turn moves.
        this.#supervisorTurnAt = new Date().toISOString();
      },
    };
  }

  /** Puts the supervisor in `status`, as its process would, for a step that needs it there. */
  setSupervisor(status: Exclude<SupervisorWorldState, 'none'>): void {
    this.#supervisor = status;
  }

  #baseApprovals(): SupervisorApproval[] {
    return [
      {
        id: SUPERVISOR_APPROVALS.message,
        kind: 'message',
        to: NAMES.asked,
        text: 'Please retry the made-up failed batch on example/api-server tonight, in the nightly window, not now. Tell me here when it has run.',
        at: this.#ago(5),
        expiresAt: this.#ago(-24),
      },
      {
        id: SUPERVISOR_APPROVALS.spawn,
        kind: 'spawn',
        directory: DEMO_APP,
        name: 'pr-57',
        prompt: 'Review https://github.com/example/demo-app/pull/57. Say what blocks it, if anything.',
        at: this.#ago(2),
        expiresAt: this.#ago(-27),
        // W156: the supervisor's pick, and every profile as pitwall resolves them, one with a skill.
        profile: 'Review',
        profiles: APPROVAL_PROFILES.map((each) => ({ ...each })),
      },
    ];
  }

  /** W127: NAMES.ended, a finished session, resumed with a message as its next turn. */
  #resumeApproval(): SupervisorApproval {
    const ended = this.byName(NAMES.ended);
    return {
      id: SUPERVISOR_APPROVALS.resume,
      kind: 'resume',
      sessionId: ended.sessionId,
      name: ended.name,
      directory: ended.cwd,
      text: 'The user asked me to pass this on: please finish the made-up guide’s last section, then open a draft PR for it.',
      at: this.#ago(1),
      expiresAt: this.#ago(-28),
      // W129: its folder and last activity, a name another listed session shares, and a mode that skips the prompts, so the card shows each line.
      ...(ended.lastActivityAt === undefined ? {} : { lastActivityAt: ended.lastActivityAt }),
      sameName: 2,
      permission: { kind: 'mode', mode: 'bypassPermissions' },
      // W155, W156: the profile it started on, kept, and every profile to resume it on instead.
      launch: { profile: 'Build', model: 'claude-opus-5-5', effort: 'high', subagentModel: 'sonnet' },
      profiles: APPROVAL_PROFILES.map((each) => ({ ...each })),
    };
  }

  /** A message taller than its card shows, with a character drawn as its code (W120). */
  #longApproval(): SupervisorApproval {
    const steps = Array.from({ length: 12 }, (_, index) => `${index + 1}. Check the made-up step ${index + 1} of the nightly batch.`);
    return {
      id: SUPERVISOR_APPROVALS.message,
      kind: 'message',
      to: NAMES.asked,
      text: ['Please work through these before tonight\u00a0and tell me what failed:', ...steps, 'Thanks.'].join('\n'),
      at: this.#ago(3),
      expiresAt: this.#ago(-26),
    };
  }

  /** A message longer than half the window shows (W136): 60 made-up lines, which scroll, with the length note. */
  #longerApproval(): SupervisorApproval {
    const steps = Array.from({ length: 58 }, (_, index) => `${index + 1}. Re-run the made-up check ${index + 1} and note what it says.`);
    return {
      id: SUPERVISOR_APPROVALS.longer,
      kind: 'message',
      to: NAMES.asked,
      text: ['Here is the whole made-up checklist:', ...steps, 'Thanks.'].join('\n'),
      at: this.#ago(2),
      expiresAt: this.#ago(-27),
    };
  }

  #supervisorTurns(): ConversationEntry[] {
    return [
      { kind: 'user', text: "What's running, in a sentence each?", at: this.#ago(6) },
      { kind: 'tool', text: 'mcp__pitwall__list_sessions', toolName: 'mcp__pitwall__list_sessions', at: this.#ago(5.9) },
      {
        kind: 'assistant',
        markdown: true,
        at: this.#ago(5.8),
        text: '- **pitwall-test-nightly-export** is running the made-up export tests.\n- **pitwall-test-retry-worker** is waiting on CI for its backoff change on `example/api-server`.\n- **pitwall-test-index-rebuild** is half way through the made-up index rebuild.',
      },
      { kind: 'user', text: 'Ask pitwall-test-review to retry the batch tonight, and start a session to review example/demo-app#57.', at: this.#ago(5.2) },
      { kind: 'assistant', markdown: true, at: this.#ago(5), text: "I've drafted both for you: a message to **pitwall-test-review**, and a session to review example/demo-app#57. They're in the cards below, and go only when you send them. `pitwall-test-review` in code stays text." },
    ];
  }

  #supervisorOlderTurns(): ConversationEntry[] {
    return [
      { kind: 'user', text: 'Which sessions need me, and why?', at: this.#ago(40) },
      { kind: 'assistant', markdown: true, at: this.#ago(39.8), text: 'Only **pitwall-test-docs**: it waits on a permission prompt.' },
    ];
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
    const named = groups.map((group) => ({ ...group, label: this.#labels[group.key] ?? group.label, sessions: group.sessions.map((each) => this.#withRecap(each)) }));
    const health = this.recapHealth();
    return {
      generatedAt: new Date().toISOString(),
      roots: this.roots,
      groups: named.filter((group) => group.sessions.length > 0),
      source: { ok: true },
      ...(health ? { recaps: health } : {}),
      ...(this.#supervisor === 'none' ? {} : { supervisor: this.supervisorState() }),
      ...(this.#runRate === 'off' ? {} : { planUsage: 'on' as const }),
    };
  }

  /** How recaps are doing (W111), as the snapshot carries it: absent with recaps off. */
  recapHealth(): RecapHealth | undefined {
    if (this.#recapsState === 'off') return undefined;
    const health: RecapHealth = { calls: this.#recapCalls, budget: this.#recapBudget, costUsd: Math.round(this.#recapCalls * 11) / 10_000 };
    return this.#recapsState === 'failing' ? { ...health, error: RECAPS_ERROR, errorAt: new Date(this.#recapErrorAt).toISOString() } : health;
  }

  /** A listed session's whole recap (W111), as GET recapPath() answers it, with `stale` from its activity; undefined without one. */
  recap(sessionId: string): SessionRecap | undefined {
    const recap = this.#recaps.get(sessionId);
    const session = this.#sessions.get(sessionId);
    if (!recap || !session) return undefined;
    return this.#isStale(recap, session) ? { ...recap, stale: true } : recap;
  }

  /**
   * Refresh (W111), in the order the contract gives recapRefreshPath()'s answers: 'off' with recaps
   * off (409); 'not-recapped' for a session with no transcript (404), none here, since every made-up
   * session has one, ended ones included (D26); 'spent' with the day's budget used up, and 'running'
   * while a call for it runs (429); otherwise 'started', and `done`, which ends the call: a new recap,
   * through its latest activity, or with 'failing' none.
   */
  refreshRecap(sessionId: string): { result: 'off' } | { result: 'not-recapped' } | { result: 'spent' } | { result: 'running' } | { result: 'started'; done: () => void } {
    if (this.#recapsState === 'off') return { result: 'off' };
    const session = this.#sessions.get(sessionId);
    if (!session || session.transcript !== 'ok') return { result: 'not-recapped' };
    if (this.#recapCalls >= this.#recapBudget) return { result: 'spent' };
    if (this.#recapping.has(sessionId)) return { result: 'running' };
    this.#recapping.add(sessionId);
    this.#recapCalls += 1;
    return {
      result: 'started',
      done: () => {
        this.#recapping.delete(sessionId);
        if (this.#recapsState === 'failing') {
          this.#recapErrorAt = Date.now();
          return;
        }
        const now = new Date().toISOString();
        const through = this.#sessions.get(sessionId)?.lastActivityAt ?? now;
        const was = this.#recaps.get(sessionId);
        const made = was && was.source === 'pitwall' ? was : this.#firstRecap(session);
        this.#recaps.set(sessionId, { ...made, at: now, throughAt: through });
      },
    };
  }

  /** The session as the snapshot lists it with its recap (W111): the summary, the title from it, and Needs you's 'recap' while it's current and waits on you. */
  #withRecap(session: SessionSummary): SessionSummary {
    const recap = this.#recapsState === 'off' ? undefined : this.recap(session.sessionId);
    if (!recap) return session;
    const yours = recap.todos.filter((todo) => todo.owner === 'you');
    const next = yours[0]?.text;
    const summary = { waitingOn: recap.waitingOn, title: recap.title, forYou: yours.length, at: recap.at, source: recap.source, ...(next === undefined ? {} : { next }), ...(recap.stale ? { stale: true as const } : {}) };
    const listed: SessionSummary = { ...session, recap: summary };
    if (recap.source === 'pitwall') Object.assign(listed, { title: recap.title, titleSource: 'pitwall' });
    const needs = recap.source === 'pitwall' && recap.waitingOn === 'you' && next !== undefined && !recap.stale && !session.stale && !session.finished && session.needsYou === undefined;
    return needs ? { ...listed, needsYou: { reason: 'recap', text: next } } : listed;
  }

  /** Older than the session's latest activity. */
  #isStale(recap: SessionRecap, session: SessionSummary): boolean {
    return session.lastActivityAt !== undefined && Date.parse(session.lastActivityAt) > Date.parse(recap.throughAt);
  }

  /** The made-up recaps, by session name (RECAPPED). */
  #baseRecaps(): { name: string; recap: SessionRecap }[] {
    const through = (name: string) => this.byName(name).lastActivityAt ?? this.#ago(10);
    const made = (name: string, extra: Partial<SessionRecap>): { name: string; recap: SessionRecap } => ({
      name,
      recap: {
        summary: 'You asked it to add a made-up health route to the API, with a test. The route and its test are in, and the made-up CI run on #51 is red on lint.',
        todos: [
          { text: 'Say whether to fix the lint errors on #51 now, or leave them for the made-up follow-up', owner: 'you' },
          { text: 'Fix the lint errors, if you say now', owner: 'session' },
          { text: 'Say whether to mark #51 ready', owner: 'you' },
        ],
        waitingOn: 'you',
        title: 'Add a made-up health route',
        at: through(name),
        throughAt: through(name),
        source: 'pitwall',
        ...extra,
      },
    });
    return [
      // W150's picture: the goal, what it's on and why, and the plan's line, with W172's items and changes.
      made(RECAPPED.you, { ...RECAP_PICTURE, planItems: RECAP_PICTURE.planItems.map((item) => ({ ...item })) }),
      made(RECAPPED.stale, {
        summary: 'You asked it to review the made-up retry change. It reviewed it and asked whether to retry the failed batch now.',
        todos: [{ text: 'Say whether to retry the made-up failed batch now, or wait for tonight', owner: 'you' }],
        title: 'Review the made-up retry change',
        at: this.#ago(19),
        throughAt: this.#ago(20),
      }),
      made(RECAPPED.someoneElse, {
        summary: 'You asked it to tidy both made-up services. It pushed #19 and asked for a review.',
        todos: [{ text: 'Approve #19', owner: 'someone else' }],
        waitingOn: 'someone else',
        title: 'Tidy both made-up services',
        // A picture with no plan (W150): no Plan section (W172).
        goal: 'Tidy both made-up services so they share one config loader.',
        workingOn: '#19: the shared loader, which both services need before the old one can go.',
        plan: '',
      }),
      made(RECAPPED.anotherSession, {
        summary: 'You asked it to add a made-up route. Its sub-agents are drafting the route and its tests.',
        todos: [
          { text: "Land pitwall-test-api's made-up health route first", owner: 'someone else' },
          { text: 'Add the route on top of it', owner: 'session' },
        ],
        waitingOn: 'another session',
        title: 'Add a made-up route',
        // A plan with items and no changes (W172).
        ...RECAP_PICTURE_STEADY,
        planItems: RECAP_PICTURE_STEADY.planItems.map((item) => ({ ...item })),
      }),
      made(RECAPPED.ci, {
        summary: 'You asked it to make the made-up retry worker back off. It pushed the backoff to its branch.',
        todos: [
          { text: 'Finish the made-up CI run on its branch', owner: 'CI' },
          { text: 'Say whether to open the PR once it passes', owner: 'you' },
        ],
        waitingOn: 'CI',
        title: 'Back off the made-up retry worker',
      }),
      made(RECAPPED.done, { summary: 'You asked it to run the made-up migration. It ran, and every table checks out.', todos: [], waitingOn: 'nothing', title: 'Run the made-up migration' }),
      made(RECAPPED.claudeCode, { summary: 'The made-up index rebuild is half done; it runs until the last shard is in.', todos: [], waitingOn: 'nothing', title: '', source: 'claude-code' }),
    ];
  }

  /** A first recap for a session that had none, made up from its role. */
  #firstRecap(session: SessionSummary): SessionRecap {
    const now = new Date().toISOString();
    const base = { at: now, throughAt: now, source: 'pitwall' as const };
    if (session.name === NAMES.waiting) {
      return {
        ...base,
        summary: 'You asked it to update the made-up getting started guide. It rewrote the install steps and wants to run the made-up docs build.',
        todos: [{ text: 'Answer its permission prompt to run the made-up docs build', owner: 'you' }],
        waitingOn: 'you',
        title: 'Update the getting started guide',
      };
    }
    if (session.ended) {
      return {
        ...base,
        summary: 'You asked it to tidy the made-up release notes. It tidied them, and the session ended before you said whether to publish them.',
        todos: [{ text: 'Say whether to publish the made-up release notes', owner: 'you' }],
        waitingOn: 'you',
        title: 'Tidy the made-up release notes',
      };
    }
    return { ...base, summary: `You asked it to tidy the made-up export job, in ${session.name}. It retries three times now, with backoff.`, todos: [], waitingOn: 'nothing', title: 'Tidy the made-up export job' };
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

  /**
   * GET USAGE_PATH's answer (W158): made-up figures for the window, shaped as src/usage/view.ts builds
   * them. Three listed sessions, one not listed, and pitwall's own recap calls; a kept day in 30 days.
   */
  usage(key: UsageWindowKey): { status: number; body?: UsageView } {
    if (this.#usage === 'failing') return { status: 500 };
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    const midnight = (ms: number) => {
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };
    const plan = this.#usage !== 'unavailable';
    // The plan's week reset 4 days ago at 14:00, so it resets in 3 days; with the run rate on, its week (W159).
    const reset = this.#runRate === 'off' ? midnight(this.#now - 4 * DAY) + 14 * HOUR : this.#runRateWeek().resetsAt - WEEK_MS;
    const since =
      key === '24h' ? Math.floor((this.#now - 23 * HOUR) / HOUR) * HOUR : key === 'week' && plan ? reset : midnight(this.#now) - ((key === '30d' ? 30 : key === '14d' ? 14 : 7) - 1) * DAY;
    const bucket = key === '24h' ? 'hour' : 'day';
    const scale = this.#usage === 'empty' ? 0 : key === '24h' ? 0.2 : key === '30d' ? 3.5 : key === '14d' ? 1.8 : 1;
    const t = (cost: number, calls: number): UsageTokens => ({
      calls: Math.round(calls * scale),
      input: Math.round(calls * 37 * scale),
      cacheWrite: Math.round(calls * 4_100 * scale),
      cacheRead: Math.round(calls * 182_000 * scale),
      output: Math.round(calls * 610 * scale),
      cost: cost * scale,
    });
    const starts: number[] = [];
    if (bucket === 'hour') for (let at = since; at < this.#now; at += HOUR) starts.push(at);
    else for (let at = midnight(since); at < this.#now; at = midnight(at + DAY + 2 * HOUR)) starts.push(at);
    // A made-up shape: quiet nights and a busy middle, a quiet day here and there.
    const weight = (i: number) => (bucket === 'hour' ? [0.1, 0.1, 0.05, 0, 0, 0, 0.2, 0.6, 1, 1.4, 1.2, 0.9][i % 12]! : [1, 1.6, 0.4, 2.1, 1.2, 0.2, 0.9][i % 7]!);
    const buckets = starts.map((start, i) => ({
      start: new Date(start).toISOString(),
      ...t(scale === 0 ? 0 : (42 * weight(i)) / scale / (bucket === 'hour' ? 6 : 1), 300 * weight(i)),
      ...(key === '30d' && i === 1 ? { history: true as const } : {}),
    }));
    const id = (name: string) => this.byName(name).sessionId;
    const sessions = [
      { sessionId: id(NAMES.conversation), repo: '~/code/api-server', kind: 'main' as const, model: 'claude-opus-5-5', subagentRuns: 6, subagentCost: 31.4 * scale, ...t(96.2, 2_100) },
      { sessionId: id(NAMES.running), repo: '~/code/data-pipeline', kind: 'main' as const, model: 'claude-sonnet-5-5', subagentRuns: 0, subagentCost: 0, ...t(41.75, 1_350) },
      { sessionId: '00000000-0000-4000-8000-00000000dead', repo: '~/code/docs-site', kind: 'main' as const, model: 'claude-opus-5-5', subagentRuns: 2, subagentCost: 4.1 * scale, ...t(18.3, 640) },
      { sessionId: id(NAMES.waiting), repo: '~/code/docs-site', kind: 'main' as const, model: 'claude-opus-5-5', subagentRuns: 1, subagentCost: 0.9 * scale, ...t(7.06, 230) },
      { sessionId: '00000000-0000-4000-8000-0000000000aa', repo: "pitwall's own: recap", kind: 'pitwall' as const, model: 'claude-haiku-5-5', subagentRuns: 0, subagentCost: 0, ...t(0.004, 190) },
    ];
    const view: UsageView = {
      window: { key, since: new Date(since).toISOString(), until: new Date(this.#now).toISOString(), from: key === '24h' ? 'hours' : key === 'week' && plan ? 'reset' : 'days', bucket },
      plan: plan
        ? { status: 'available', readAt: new Date(this.#now - MINUTE).toISOString(), fiveHour: null, sevenDay: { usedPercentage: 63, resetsAt: new Date(reset + 7 * DAY).toISOString() } }
        : { status: 'unavailable', readAt: new Date(this.#now - MINUTE).toISOString(), reason: 'no-report' },
      costLabel: "API list price, a stand-in: how your plan's usage limits weigh tokens isn't published",
      totals: t(163.3, 4_510),
      buckets,
      byRepo: {
        rows: [
          { repo: '~/code/api-server', sessions: 3, ...t(96.2, 2_100) },
          { repo: '~/code/data-pipeline', sessions: 1, ...t(41.75, 1_350) },
          { repo: '~/code/docs-site', sessions: 2, ...t(25.36, 870) },
          { repo: "pitwall's own: recap", sessions: 41, ...t(0.004, 190) },
        ],
        ...(key === '30d' ? { rest: { count: 3, ...t(2.2, 80) } } : {}),
      },
      bySession: { rows: sessions },
      byModel: [
        { model: 'claude-opus-5-5', ...t(121.5, 2_970) },
        { model: 'claude-sonnet-5-5', ...t(41.75, 1_350) },
        { model: 'claude-haiku-5-5', ...t(0.004, 190) },
      ],
      split: { main: { sessions: 46, ...t(127.0, 3_900) }, subagent: { runs: 9, ...t(36.3, 610) } },
      ...(key === '30d' ? { history: { days: 1, ...t(12.4, 300) } } : {}),
      scan: { at: new Date(this.#now - 2_000).toISOString(), files: 865, unreadable: 0, malformed: 0 },
    };
    if (this.#runRate !== 'off') {
      const rate = this.runRate();
      view.runRate = rate;
      // The plan's week is the run rate's, so the view's two figures agree.
      if (rate.status === 'available' && rate.sevenDay !== null && view.plan.status === 'available') {
        view.plan = { ...view.plan, sevenDay: { usedPercentage: rate.sevenDay.usedPercentage, resetsAt: rate.sevenDay.resetsAt } };
      }
    }
    if (this.#usage === 'empty') return { status: 200, body: { ...view, byRepo: { rows: [] }, bySession: { rows: [] }, byModel: [] } };
    return { status: 200, body: view };
  }

  /**
   * GET RUN_RATE_PATH's answer (W159), worked out by pitwall's own runRate.ts from made-up readings:
   * a week that resets on the next Sunday at 12:00, as Phil's does (spike 013), so the reserve's Friday
   * 18:00 falls late in it, with hourly readings at a steady rate up to the state's percentage. The
   * Usage view's plan's week shows the same week then.
   */
  /** The run rate's week: it resets on the next Sunday at 12:00, local time. */
  #runRateWeek(): { resetsAt: number } {
    const reset = new Date(this.#now);
    reset.setHours(12, 0, 0, 0);
    while (reset.getDay() !== 0 || reset.getTime() <= this.#now) reset.setDate(reset.getDate() + 1);
    return { resetsAt: reset.getTime() };
  }

  runRate(): RunRate {
    if (this.#runRate === 'off') return { status: 'off' };
    if (this.#runRate === 'unavailable') return { status: 'unavailable', readAt: new Date(this.#now).toISOString(), reason: 'timeout' };
    const HOUR = 60 * MINUTE;
    const { resetsAt } = this.#runRateWeek();
    const start = new Date(resetsAt - WEEK_MS);
    const readAt = this.#runRate === 'old' ? this.#now - 25 * MINUTE : this.#now - MINUTE;
    const line = paceAt(readAt, 0, resetsAt, DEFAULT_RUN_RATE_TARGET).line;
    const used = { normal: Math.max(1, Math.round(line - 6)), old: Math.max(1, Math.round(line - 6)), ahead: Math.min(99, Math.round(line + 12)), amber: 74, red: 93 }[this.#runRate];
    const elapsed = readAt - start.getTime();
    const history: WeekReading[] = [];
    for (let at = readAt - 30 * HOUR; at <= readAt; at += HOUR) history.push({ at, used: Math.round((used * (at - start.getTime())) / elapsed), resetsAt });
    const reading: WeekReading = { at: readAt, used, resetsAt };
    return {
      status: 'available',
      readAt: new Date(readAt).toISOString(),
      target: DEFAULT_RUN_RATE_TARGET,
      sevenDay: { usedPercentage: used, resetsAt: new Date(resetsAt).toISOString(), level: levelOf(used), pace: paceAt(readAt, used, resetsAt, DEFAULT_RUN_RATE_TARGET), projection: project(reading, history) },
      fiveHour: this.#runRate === 'amber' ? { usedPercentage: 35, resetsAt: new Date(this.#now + 2 * HOUR).toISOString(), level: levelOf(35) } : null,
    };
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
    const entries =
      session.name === NAMES.conversation
        ? this.#everyKind()
        : session.name === NAMES.inApi
          ? this.#namingSubagents()
          : session.name === NAMES.asked
            ? [...this.#short(session), ...this.#repliedToSupervisor()]
            : this.#short(session);
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
  need(sessionId: string, change: Partial<Pick<SessionSummary, 'needsYou' | 'askedYou' | 'state' | 'status' | 'waitingFor' | 'jobPr'>>): void {
    const session = this.#sessions.get(sessionId);
    if (session) this.#sessions.set(sessionId, { ...session, ...change });
  }

  /**
   * Until the next reset, the session is flagged as not needing you (W153), or not. The real server
   * drops a flag once what the session needs changes; need() leaves that to the part.
   */
  /** Snoozes it (W154), or takes the snooze off; with `ended`, as when the server ended it by itself. */
  snooze(sessionId: string, snoozed: SessionSummary['snoozed'], ended?: SessionSummary['snoozeEnded']): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    const { snoozed: _old, snoozeEnded: _end, ...rest } = session;
    this.#sessions.set(sessionId, { ...rest, ...(snoozed === undefined ? {} : { snoozed }), ...(ended === undefined ? {} : { snoozeEnded: ended }) });
  }

  /** Until the next reset, the session proposes a new session (W163), or proposes nothing. */
  spinOff(sessionId: string, spinOff: SessionSummary['spinOff']): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    const { spinOff: _old, ...rest } = session;
    this.#sessions.set(sessionId, spinOff === undefined ? rest : { ...rest, spinOff });
  }

  flag(sessionId: string, flagged: SessionSummary['flagged']): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    const { flagged: _old, ...rest } = session;
    this.#sessions.set(sessionId, flagged === undefined ? rest : { ...rest, flagged });
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

  #baseSessions(cloned: boolean): SessionSummary[] {
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
      // Context (W133): below the 200K threshold here, between the two on running2, over 400K on
      // running3, and none on the rest, so their session view says "unavailable".
      session(NAMES.conversation, { title: 'Add a made-up health route', lastUserPrompt: 'Add a made-up health route to the API, with a test.', contextTokens: 85_000, prLinks: [this.#link('opened', PRS.failing, 26)] }),
      job(NAMES.running, { prLinks: [this.#link('pushed', PRS.approved, 8 * 60)] }),
      job(NAMES.running2, { contextTokens: 245_000 }),
      job(NAMES.running3, { contextTokens: 612_000 }),
      job(NAMES.prompting, { status: 'waiting', state: 'blocked', waitingFor: 'permission prompt', needsYou: { reason: 'prompt' } }),
      job(NAMES.finished, { state: 'done', alive: false, pid: undefined, finished: true, lastActivityAt: this.#ago(95) }),
      // With two roots it changed two repos under ~/oss most too, one with a long name, and runs 12 sub-agents (W149): Main repo still lists it
      // under api-server, in ~/code's tab, its line 2 ending "also in" that repo "+1", which gives way rather than overflow at 375.
      session(NAMES.fromRoot, {
        cwd: CODE,
        title: 'Tidy both made-up services',
        workedIn: [
          worked('api-server', 12, 140),
          worked('demo-app', 3, 60),
          ...(this.#roots === 2
            ? [
                { key: BLOG, label: 'blog', root: OSS, calls: 90, changes: 30, lastAt: this.#ago(2) },
                { key: `${OSS}/pitwall-test-a-made-up-repository-with-a-long-name`, label: 'pitwall-test-a-made-up-repository-with-a-long-name', root: OSS, calls: 95, changes: 40, lastAt: this.#ago(2) },
              ]
            : []),
        ],
        ...(this.#roots === 2 ? { subagentsRunning: 12 } : {}),
        prLinks: [this.#link('pushed', PRS.quiet, 3 * 60)],
      }),
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
    // Last, so every other session keeps its id.
    if (cloned) all.push(session(NAMES.cloned, { cwd: DOCS_SITE, title: 'Try the made-up CLI', lastUserPrompt: 'Clone the made-up CLI here and run its tests.', workedIn: [worked('sdk-cli', 2, 40)] }));
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

  /**
   * NAMES.asked's exchange with the supervisor (W138), as the server reads it from a transcript: its
   * message, ending with pitwall's line; the session's reply to it, To pitwall-supervisor; Claude
   * Code's refusal, in pitwall's words; and the question the session ended its turn with.
   */
  #repliedToSupervisor(): ConversationEntry[] {
    return [
      { kind: 'cross-session', at: this.#ago(10), from: 'pitwall-supervisor', markdown: true, text: withSupervisorFooter('The user asked me to pass this on: please check the made-up CI run.') },
      { kind: 'to-pitwall', recipient: 'supervisor', at: this.#ago(9), markdown: true, text: 'Checked: the made-up CI run is **green**.' },
      { kind: 'notice', at: this.#ago(9), text: REFUSED_TO_SUPERVISOR_NOTICE },
      { kind: 'assistant', at: this.#ago(8), markdown: true, text: 'The made-up CI run is green. Shall I merge it?' },
    ];
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
      {
        kind: 'assistant',
        at: this.#ago(37),
        markdown: true,
        // A code block with a line longer than any window, which wraps rather than scrolling sideways (W137).
        text: "The route is in. Running the tests now:\n\n```sh\nnpx vitest run src/routes.test.ts --reporter=verbose --testNamePattern='GET /health answers 200 with a small JSON body, and 405 for any other method'\n  # indented, kept as typed\n```",
      },
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
