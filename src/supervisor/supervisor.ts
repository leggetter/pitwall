// The supervisor (M5, W113, W115; spike 009; D4): one headless `claude -p` session that pitwall
// starts, owns and resumes, with stream-json on stdin and stdout, on SUPERVISOR_MODEL. It reads
// through the read-only tools of pitwall's own MCP server (W112), and can propose a message to a
// session (SendMessage), a new session (the MCP server's spawn_session) or resuming a finished one
// with a message (resume_session, W127), each sent only after your
// click: Claude Code asks pitwall's permission prompt tool, approve, before each call, and approve
// holds the call as a card until you decide (approvals.ts, src/server/supervisorActions.ts). It
// can't run a command or change a file.
//
// When it runs:
//
//   start       when the web UI asks (SUPERVISOR_START_PATH), or with your first message. Never by
//               itself: it doesn't start with pitwall, and isn't restarted when it exits. The next
//               message or Start tries again
//   resume      with `--resume <id>`, from the state file's session id (state.ts), when the
//               conversation started on this SUPERVISOR_PROMPT_VERSION and its transcript is still
//               there. A new prompt version starts a new conversation, since Claude Code freezes
//               the appended prompt at the first request (spike 009, finding 2)
//   held        a running session already has that id, such as a background session Phil resumed
//               it as while pitwall was down: by a fresh `claude agents --json --all` before the
//               resume, or by Claude Code's refusal on stderr after it (spike 009, finding 3).
//               SupervisorState 'held', with `claude stop <id>` in `error`. pitwall never stops it
//   failed      it exited, or couldn't start: 'failed', with why in pitwall's words, never
//               claude's output
//   new         New conversation (W136): stops it if it runs and forgets the conversation on file
//               (state.ts' clear()), so the next start begins a new one. Refused while it starts,
//               a turn runs, cards or your messages wait for that conversation, or it's held. The
//               old transcript stays on disk, and its session id stays in sessionIds, so it's never
//               listed; in later runs its folder hides it, as it hides every supervisor conversation
//   stop        with pitwall: stdin closed, then SIGTERM after a second, then SIGKILL
//
// Where:
//
//   $PITWALL_HOME/supervisor/           0700   its folder
//     state.json                        0600   the session id and the prompt's version (state.ts)
//     mcp-<pid>.json                    0600   the MCP config, with this process's bearer token, one
//                                              per pitwall, removed when the supervisor exits; one a
//                                              pitwall that died left is removed at the next start
//     session/                          0700   the empty folder claude runs in, where nothing is written
//     gate/                             0700   the recipient gate's files (gate.ts): per process, its
//                                              ready marker and the names it may message, 0600, removed
//                                              when it exits
//
// The MCP server's bearer token is new for each process (crypto random) and valid only while that
// process runs: the server compares it in constant time (src/server/mcp.ts). It's in the 0600
// config file alone, never in claude's arguments or environment, so `ps` never shows it.
//
// The stream (spike 009, findings 1, 7 and 10):
//
//   control_request initialize    written at start; its answer says the process reads stdin, so
//                                 the supervisor is 'idle', and that its permission mode is default
//   system/init                   at the start of every turn: the session id, kept in the state
//                                 file, and its tools, permission mode, MCP server and gate, checked again
//   assistant, user               a turn running
//   result                        a turn's end: its cost, from model_usage_since_last_result, and
//                                 the next message, if one is queued
//   control_request (from claude) answered with a denial or an error: permission prompts go to the
//                                 approve tool, so one on the stream is refused, never allowed
//
// Your messages are written one at a time as stream-json user messages, never on a command line;
// one sent while a turn runs waits in pitwall's queue until its `result`, and one sent while it's
// stopped waits for the next start (W115, W114's review). After you edit one of its proposals, your
// next message starts with pitwall's note of what was sent. Stop sends the stream's `interrupt`
// control request. Messages from other sessions are refused.
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentsSource, type AgentRow, type AgentsSource } from '../index/agents.js';
import { ConversationCursorError, readConversationPage } from '../index/conversation.js';
import { runFile } from '../index/exec.js';
import { isRecord } from '../index/guards.js';
import { contextTokensOf, defaultConfigDir, encodeProjectDir, isSessionUuid } from '../index/transcripts.js';
import { MCP_SERVER_NAME, type ConversationPage, type SupervisorState, type WorkChoice } from '../shared/protocol.js';
import { createApprovalQueue, type ApprovalQueue } from './approvals.js';
import { createSupervisorGate, SUPERVISOR_GATE_DIR_NAME, type SupervisorGate } from './gate.js';
import { connectorLaunch, connectorOf, type SupervisorConnector } from './connectors.js';
import { type ConnectorLauncher, defaultConnectorLauncher } from './connectorServer.js';
import { isModelRejection, modelRejectedMessage } from '../server/work.js';
import { ensureLaunchDir, pitwallHome } from '../server/launch.js';
import { checkClaudeVersion, spawnRelayChild, type RelayChild, type RelayChildEvents, type RelaySpawner } from '../server/relay.js';
import { nameKey, oneLine, userMessageLine } from '../server/relayPrompt.js';
import { randomSecret } from '../server/security.js';
import {
  mcpConfigText,
  MIN_SUPERVISOR_CLAUDE_VERSION,
  SUPERVISOR_DIR_NAME,
  supervisorInitTools,
  SUPERVISOR_NAME,
  SUPERVISOR_PERMISSION_MODE,
  SUPERVISOR_PROMPT_VERSION,
  SUPERVISOR_MAX_TURNS,
  SUPERVISOR_SESSION_DIR_NAME,
  supervisorArgs,
  supervisorEnvironment,
  supervisorSettings,
} from './prompt.js';
import { supervisorStateFile, type SupervisorStateStore } from './state.js';

/**
 * The MCP config file's name in the supervisor's folder: one per pitwall process, by its pid, so two
 * pitwalls on one home never write or remove each other's (W113's review).
 */
export function supervisorMcpConfigFile(pid: number = process.pid): string {
  return `mcp-${pid}.json`;
}

const MCP_CONFIG_FILE = /^mcp-(\d+)\.json$/;

/**
 * Removes the MCP config files that pitwall processes which are gone left in `dir`, as a crash or
 * SIGKILL does: only regular files named as supervisorMcpConfigFile() names them, owned by this user,
 * for a pid that isn't running. Never throws.
 */
export function sweepMcpConfigs(dir: string, alive: (pid: number) => boolean = pidAlive): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  for (const name of names) {
    const pid = Number(MCP_CONFIG_FILE.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
    const file = path.join(dir, name);
    try {
      const stats = lstatSync(file);
      if (!stats.isFile() || (uid !== undefined && stats.uid !== uid)) continue;
      unlinkSync(file);
    } catch {
      // Left for the next start.
    }
  }
}

/** Whether a process with this pid is running: one that exists but isn't ours (EPERM) counts. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** start()'s and send()'s answer, which the routes turn into a status (src/server/supervisorRoutes.ts). */
export type SupervisorOutcome =
  /** Running: started, resumed or already up, and for send(), the message written or queued. */
  | { kind: 'ok' }
  /** A running session has its id (SupervisorState 'held'). `error` says what to do. */
  | { kind: 'held'; error: string }
  /** It couldn't start, or exited as it started (SupervisorState 'failed'). */
  | { kind: 'failed'; error: string }
  /** send(): too many messages are waiting already. */
  | { kind: 'busy' }
  /** pitwall is closing. */
  | { kind: 'closed' };

/** interrupt()'s answer. */
export type InterruptOutcome = { kind: 'ok' } | { kind: 'idle' };

/** newConversation()'s answer (W136): done, refused with why in pitwall's words, or pitwall is closing. */
export type NewConversationOutcome = { kind: 'ok' } | { kind: 'refused'; error: string } | { kind: 'closed' };

/** What the stream showed in this run, for the live check and tests: counts and names, never text. */
export interface SupervisorStats {
  /** Processes started. */
  starts: number;
  /** Turns ended (`result` events). */
  turns: number;
  /** Tool calls the model made, by tool name. */
  toolCalls: Record<string, number>;
}

export interface Supervisor {
  /** As the snapshot carries it (IndexSnapshot.supervisor). */
  state(): SupervisorState;
  /** Called once pitwall's server is listening, with its MCP server's URL. Until then, nothing starts. */
  bind(options: { mcpUrl: string }): void;
  /** Starts or resumes it, unless it's running. Resolves once it reads stdin, or with why not. Never rejects. */
  start(): Promise<SupervisorOutcome>;
  /** Your message, as you: starts it first if needed; written now, or queued while a turn runs. Never rejects. */
  send(text: string): Promise<SupervisorOutcome>;
  /** Stops the running turn with the stream's interrupt control request. */
  interrupt(): InterruptOutcome;
  /**
   * New conversation (W136): stops it if it runs, forgets the conversation on file and what belongs
   * to it in the snapshot, and resolves once the process has gone. The next message or Start begins
   * a new conversation; this starts nothing. Refused while it starts, a turn runs, cards or your
   * messages wait for this conversation, or it's held. Never rejects.
   */
  newConversation(): Promise<NewConversationOutcome>;
  /** The running process's bearer token for the MCP server, or undefined while none runs. */
  mcpToken(): string | undefined;
  /** The supervisor's session ids, this run's and the state file's: its own conversations, which no tool lists. */
  ownSessionIds(): ReadonlySet<string>;
  /**
   * True for a `claude agents` row that is the supervisor: by its pid, by its folder, by its name
   * on an interactive row, as a `-p` session lists, or by its session id on a row with no process,
   * as the index lists an ended one. A background session that holds its id stays listed, so you
   * can see it and stop it yourself.
   */
  isOwn(row: Pick<AgentRow, 'sessionId' | 'name' | 'kind' | 'cwd' | 'pid'>): boolean;
  /** A page of its own transcript, as the index pages a session's (supervisorConversationPath()). Undefined with no conversation yet. */
  conversation(before?: string): Promise<ConversationPage | undefined>;
  stats(): SupervisorStats;
  /** Its approvals: the cards waiting on your click, the spawn passes and the notes for its next message (W115). */
  approvals(): ApprovalQueue;
  /**
   * The names its SendMessage may go on to an approval for: the live, listed sessions with a name no
   * other has, never pitwall's own. The recipient gate (gate.ts) denies any other. Until it's called,
   * none.
   */
  setRecipients(names: readonly string[]): void;
  /** Changes whenever state() could answer differently. */
  version(): number;
  /** Called when state() may have changed. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Denies every approval waiting, stops it, if it runs, and drops what's queued. Resolves within about 2 seconds. */
  close(): Promise<void>;
}

export interface SupervisorOptions {
  /** pitwall's folder. Default pitwallHome(). The supervisor's is SUPERVISOR_DIR_NAME in it. */
  home?: string;
  /** Default 'claude'. */
  claudeBin?: string;
  /** Default SUPERVISOR_MODEL. */
  model?: string;
  /** The model and effort, read at each start (W119's WorkStore). Wins over `model`. */
  work?: () => WorkChoice;
  /** What its environment is made from, before supervisorEnvironment(). Default process.env, read at each start. */
  env?: NodeJS.ProcessEnv;
  /** Starts its process, without a shell. Tests pass a fake that speaks stream-json. */
  spawn?: RelaySpawner;
  /** The fresh session list, for a session that holds the supervisor's id. Default `claude agents --json --all`. */
  agents?: Pick<AgentsSource, 'list'>;
  /** What `claude --version` prints. Default: runs it. Rejects when it can't. */
  claudeVersion?: () => Promise<string>;
  /** Default the state file in the supervisor's folder. */
  store?: SupervisorStateStore;
  /** Creates a folder if needed, checks it's safe, and returns its realpath. Throws when it isn't safe. Default ensureLaunchDir(). */
  prepareDir?: (dir: string) => string;
  /** Claude Code's folder, for the supervisor's transcript. Default `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  configDir?: string;
  /** Default SUPERVISOR_PROMPT_VERSION. */
  promptVersion?: number;
  /** How long a new process has to answer the initialize request before it's taken as reading stdin anyway. Default 15 seconds. */
  readyMs?: number;
  /** Messages that can wait behind a running turn. Default 5. */
  maxQueue?: number;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Default: console.error with a `pitwall: supervisor:` prefix. Never given a message's text or an answer's. */
  log?: (message: string) => void;
  /** Control request ids, for tests. */
  randomId?: () => string;
  /** Its approvals (W115). Default: a new queue. */
  approvals?: ApprovalQueue;
  /** The recipient gate (W115). Default: gate.ts's, in the supervisor's folder. */
  gate?: SupervisorGate;
  /**
   * The connectors you turned on (W184, D28): the config file's `supervisor.connectors`, none with
   * `--no-connectors`. Read at each start, with their variables from `env`. Default none.
   */
  connectors?: readonly SupervisorConnector[];
  /** How a stdio connector is run. Default node and connectorLauncher.mjs beside connectorServer.ts. */
  connectorLauncher?: ConnectorLauncher;
}

/** The longest stderr kept from a process, for the held check. */
const STDERR_KEEP = 4096;

interface Proc {
  child: RelayChild;
  pid?: number;
  token: string;
  /** Started with --resume. */
  resumed: boolean;
  /** It answered initialize, or readyMs passed: it reads stdin. */
  ready: boolean;
  /** A turn is running: a message was written and its result hasn't come, or a turn started by itself. */
  busy: boolean;
  /** pitwall asked it to stop. */
  stopping: boolean;
  exited: boolean;
  stderr: string;
  /** Why it couldn't start, from the spawner. */
  spawnError?: string;
  initRequestId: string;
  /** Its recipient gate's id (gate.ts). */
  gateId: string;
  /** What its system/init may list: SUPERVISOR_INIT_TOOLS and this start's connectors' chosen tools (W184). */
  initTools: ReadonlySet<string>;
  /** This start's connectors, by name. */
  connectors: string[];
  /** The connectors' statuses already logged, `<name>:<status>`. */
  reported: Set<string>;
  readyTimer?: NodeJS.Timeout;
  /** Called once: with the start's outcome, when it's ready or exits first. */
  onSettled: ((outcome: SupervisorOutcome) => void)[];
  onExit: (() => void)[];
  /** The latest `total_cost_usd` this process reported, for a turn whose result has no per-turn usage. */
  lastTotalCost?: number;
  /** Why pitwall stopped it, when that's to be shown as 'failed'. */
  trippedBy?: string;
  /** The start's outcome, once it's ready or has exited. */
  settled?: SupervisorOutcome;
}

interface Queued {
  text: string;
}

export function createSupervisor(options: SupervisorOptions = {}): Supervisor {
  const home = path.resolve(options.home ?? pitwallHome());
  const dir = path.join(home, SUPERVISOR_DIR_NAME);
  const sessionDir = path.join(dir, SUPERVISOR_SESSION_DIR_NAME);
  const configFile = path.join(dir, supervisorMcpConfigFile());
  const claudeBin = options.claudeBin ?? 'claude';
  const spawn = options.spawn ?? spawnRelayChild;
  const agents = options.agents ?? createAgentsSource(options.claudeBin === undefined ? {} : { claudeBin: options.claudeBin });
  const claudeVersion =
    options.claudeVersion ??
    (() => runFile(claudeBin, ['--version'], { cwd: os.tmpdir(), timeoutMs: 10_000, ...(options.env === undefined ? {} : { env: options.env }) }));
  const log = options.log ?? ((message: string) => console.error(`pitwall: supervisor: ${message}`));
  const store = options.store ?? supervisorStateFile(dir, log);
  const prepareDir =
    options.prepareDir ??
    ((folder: string) => {
      ensureLaunchDir(folder);
      return realpathSync(folder);
    });
  const configDir = options.configDir ?? defaultConfigDir();
  const promptVersion = options.promptVersion ?? SUPERVISOR_PROMPT_VERSION;
  const readyMs = options.readyMs ?? 15_000;
  const maxQueue = Math.max(1, options.maxQueue ?? 5);
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => randomBytes(8).toString('hex'));
  const approvals = options.approvals ?? createApprovalQueue({ now });
  const gate = options.gate ?? createSupervisorGate({ dir: path.join(dir, SUPERVISOR_GATE_DIR_NAME) });
  /** The names the gate lets through to an approval, as the server last gave them. */
  let recipients: readonly string[] = [];

  let closed = false;
  let mcpUrl: string | undefined;
  let proc: Proc | undefined;
  /** The process that last wrote the MCP config file, which removes it when it exits. */
  let configOwner: Proc | undefined;
  let launching: Promise<SupervisorOutcome> | undefined;
  /** Why it isn't running, once a start or a run failed: shown as 'held' or 'failed' until the next start. */
  let problem: { status: 'held' | 'failed'; error: string } | undefined;
  /** The conversation's session id, once known. */
  let sessionId: string | undefined;
  let lastTurnAt: string | undefined;
  let costUsd: number | undefined;
  /** The tokens of context its newest call carried, in this run (W136). */
  let contextTokens: number | undefined;
  /** Conversations New conversation left in this run (W136): never resumed again, even if the state file couldn't be removed. */
  const left = new Set<string>();
  let versionOk = false;
  const queue: Queued[] = [];
  const pids = new Set<number>();
  const sessionIds = new Set<string>();
  const dirs = new Set<string>([path.resolve(dir), path.resolve(sessionDir)]);
  addRealpath(dir);
  addRealpath(sessionDir);
  const remembered = store.read()?.sessionId;
  if (remembered !== undefined) sessionIds.add(remembered);
  /** Transcripts found, by session id. */
  const transcripts = new Map<string, string>();
  const stats: SupervisorStats = { starts: 0, turns: 0, toolCalls: {} };
  let changes = 0;
  const listeners = new Set<() => void>();
  approvals.subscribe(() => changed());

  function addRealpath(candidate: string): void {
    try {
      dirs.add(realpathSync(candidate));
    } catch {
      // Not created yet.
    }
  }

  function changed(): void {
    changes++;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log(`a listener threw: ${oneLine((error as Error).message)}`);
      }
    }
  }

  // ---------------------------------------------------------------- what's shown

  function state(): SupervisorState {
    const result: SupervisorState = { status: 'off', approvals: approvals.list() };
    if (proc !== undefined && !proc.stopping) result.status = !proc.ready ? 'starting' : proc.busy ? 'working' : 'idle';
    else if (launching !== undefined) result.status = 'starting';
    else if (problem !== undefined) {
      result.status = problem.status;
      result.error = problem.error;
      // Your messages kept for the next start (W114's review): say so, so none seems lost.
      if (queue.length > 0) result.error = `${problem.error} ${queue.length === 1 ? 'Your message waits' : `Your ${queue.length} messages wait`} to be sent when it starts.`;
    }
    if (sessionId !== undefined) result.sessionId = sessionId;
    if (lastTurnAt !== undefined) result.lastTurnAt = lastTurnAt;
    if (costUsd !== undefined) result.costUsd = Math.round(costUsd * 1e6) / 1e6;
    const handoffs = approvals.handoffs();
    if (handoffs.length > 0) result.handoffs = handoffs;
    if (contextTokens !== undefined) result.contextTokens = contextTokens;
    return result;
  }

  // ---------------------------------------------------------------- starting

  function ensureRunning(): Promise<SupervisorOutcome> {
    if (closed) return Promise.resolve({ kind: 'closed' });
    if (proc !== undefined && !proc.stopping && proc.ready) return Promise.resolve({ kind: 'ok' });
    if (launching !== undefined) return launching;
    const attempt = launch().catch((error: unknown) => {
      log(`a start failed unexpectedly: ${oneLine(error instanceof Error ? error.message : String(error))}`);
      return fail('pitwall hit an unexpected error starting the supervisor.');
    });
    launching = attempt;
    changed();
    void attempt.finally(() => {
      if (launching === attempt) launching = undefined;
      changed();
    });
    return attempt;
  }

  async function launch(): Promise<SupervisorOutcome> {
    // One that pitwall is stopping, as after a tripwire: let it go first.
    if (proc !== undefined && proc.stopping) await exitedWithin(proc, 3000);
    if (closed) return { kind: 'closed' };
    if (proc !== undefined && !proc.stopping) return settledOf(proc);
    problem = undefined;
    if (mcpUrl === undefined) return fail("pitwall's server isn't listening yet, so the supervisor didn't start. Try again in a moment.");
    const version = await checkVersion();
    if (closed) return { kind: 'closed' };
    if (version !== undefined) return fail(version);

    let cwd: string;
    const gateId = gate.newId();
    try {
      ensureLaunchDir(home);
      prepareDir(dir);
      sweepMcpConfigs(dir);
      cwd = prepareDir(sessionDir);
      dirs.add(cwd);
      gate.prepare();
      gate.setRecipients(gateId, recipients);
    } catch {
      gate.forget(gateId);
      return fail(`pitwall couldn't prepare the supervisor's folder, ${dir}, so it didn't start.`);
    }

    // Which conversation: the one on file, if it started on this prompt and its transcript is there.
    const record = store.read();
    let resume: string | undefined;
    if (record !== undefined) {
      sessionIds.add(record.sessionId);
      if (left.has(record.sessionId)) {
        log("its state file still names the conversation you left, so pitwall starts a new conversation.");
      } else if (record.promptVersion !== promptVersion) {
        log(`its system prompt is version ${promptVersion} now, and its conversation started on version ${record.promptVersion}, so pitwall starts a new conversation.`);
      } else if (findTranscript(record.sessionId, cwd) === undefined) {
        log("its conversation's transcript is gone, so pitwall starts a new conversation.");
      } else {
        resume = record.sessionId;
      }
    }
    sessionId = resume;
    // A new conversation: the last one's size and newest turn aren't this one's (W136's review).
    if (resume === undefined) {
      contextTokens = undefined;
      lastTurnAt = undefined;
    }
    if (resume !== undefined) {
      const holder = await holderOf(resume);
      if (closed) return { kind: 'closed' };
      if (holder !== undefined) return hold(holder);
    }

    // The connectors (W184, D28): their servers, with their variables' values, go in the 0600 MCP config
    // alone; one whose variables aren't all in pitwall's environment is left out of this start.
    const env = options.env ?? process.env;
    const connectors = connectorLaunch(options.connectors ?? [], env, options.connectorLauncher ?? defaultConnectorLauncher());
    for (const skipped of connectors.skipped) {
      log(`its connector ${skipped.name} is off for this start: ${skipped.why}.`);
    }

    const token = randomSecret();
    try {
      writeConfig(mcpConfigText(mcpUrl, token, connectors.servers));
    } catch (error) {
      log(`couldn't write its MCP config (${oneLine((error as Error).message)}).`);
      gate.forget(gateId);
      return fail(`pitwall couldn't write the supervisor's MCP config in ${dir}, so it didn't start.`);
    }

    const p: Proc = {
      child: undefined as unknown as RelayChild,
      token,
      resumed: resume !== undefined,
      ready: false,
      busy: false,
      stopping: false,
      exited: false,
      stderr: '',
      initRequestId: `pitwall-init-${randomId()}`,
      gateId,
      initTools: supervisorInitTools(connectors.allowed),
      connectors: connectors.names,
      reported: new Set(),
      onSettled: [],
      onExit: [],
    };
    const events: RelayChildEvents = {
      line: (line) => onLine(p, line),
      stderr: (text) => {
        p.stderr = (p.stderr + text).slice(-STDERR_KEEP);
      },
      error: (message) => {
        p.spawnError = message;
      },
      exit: (code, signal) => onExit(p, code, signal),
    };
    // Before the spawn, so a process that exits at once still removes the file it was given.
    configOwner = p;
    try {
      const settings = supervisorSettings(gate.hooks(gateId));
      p.child = spawn(
        claudeBin,
        supervisorArgs({
          mcpConfig: configFile,
          settings,
          ...(resume === undefined ? {} : { resume }),
          ...(connectors.names.length === 0 ? {} : { connectors: { allowed: connectors.allowed, disallowed: connectors.disallowed } }),
          ...(options.work?.() ?? (options.model === undefined ? {} : { model: options.model })),
        }),
        {
        cwd,
        env: supervisorEnvironment(env),
      }, events);
    } catch (error) {
      log(`couldn't start it: ${oneLine((error as Error).message)}`);
      removeConfig(p);
      gate.forget(gateId);
      return fail("pitwall couldn't start claude for the supervisor.");
    }
    stats.starts++;
    if (p.child.pid !== undefined) {
      p.pid = p.child.pid;
      pids.add(p.pid);
    }
    // A spawn error is reported, with the exit, before spawn() returns when the program isn't there.
    if (p.exited) return p.settled ?? fail("pitwall couldn't start claude for the supervisor.");
    proc = p;
    changed();
    const settled = settledOf(p);
    p.readyTimer = setTimeout(() => {
      if (p.ready || p.exited || p.stopping) return;
      // It didn't answer the initialize request, but it's running: a message will reach it.
      log(`it didn't answer pitwall's initialize request within ${Math.round(readyMs / 1000)}s; taking it as started.`);
      markReady(p);
    }, readyMs);
    p.child.write(controlRequestLine(p.initRequestId, { subtype: 'initialize' }));
    return settled;
  }

  function settledOf(p: Proc): Promise<SupervisorOutcome> {
    if (p.ready) return Promise.resolve({ kind: 'ok' });
    if (p.exited) return Promise.resolve(p.settled ?? { kind: 'failed', error: problem?.error ?? 'The supervisor stopped.' });
    return new Promise((resolve) => p.onSettled.push(resolve));
  }

  function settle(p: Proc, outcome: SupervisorOutcome): void {
    p.settled ??= outcome;
    for (const resolve of p.onSettled.splice(0)) resolve(outcome);
  }

  function fail(error: string): SupervisorOutcome {
    problem = { status: 'failed', error };
    log(error);
    return { kind: 'failed', error };
  }

  function hold(error: string): SupervisorOutcome {
    problem = { status: 'held', error };
    log('a running session holds its conversation, so pitwall left it alone.');
    return { kind: 'held', error };
  }

  /** Undefined when Claude Code is new enough, else why not, in pitwall's words. Asked again at each start until it is. */
  async function checkVersion(): Promise<string | undefined> {
    if (versionOk) return undefined;
    let output: string;
    try {
      output = await claudeVersion();
    } catch {
      return "pitwall couldn't run claude --version, so the supervisor didn't start.";
    }
    const checked = checkClaudeVersion(output, MIN_SUPERVISOR_CLAUDE_VERSION);
    if (checked.ok) {
      versionOk = true;
      return undefined;
    }
    const which = checked.version === undefined ? "pitwall couldn't read which version this is" : `this is ${checked.version}`;
    return `The supervisor needs Claude Code ${MIN_SUPERVISOR_CLAUDE_VERSION} or later, and ${which}. Update Claude Code, then try again.`;
  }

  /**
   * What to say when a running session other than pitwall's holds `id`, by a fresh listing, or
   * undefined when none does. A listing that fails says nothing: the resume itself then finds out.
   */
  async function holderOf(id: string): Promise<string | undefined> {
    let listed;
    try {
      listed = await agents.list();
    } catch {
      return undefined;
    }
    if (!listed.ok) return undefined;
    const row = listed.rows.find((each) => each.sessionId === id && each.pid !== undefined && !pids.has(each.pid));
    if (row === undefined) return undefined;
    return heldError(row.kind === 'background' ? row.shortId : undefined, row.kind, row.name);
  }

  /** Why New conversation can't run now, in pitwall's words, or undefined when it can (W136). */
  function newConversationRefusal(): string | undefined {
    if (problem?.status === 'held') {
      return "Another session is running the supervisor's conversation, so pitwall leaves it alone. Free it as the alert says, then start a new conversation.";
    }
    const p = proc;
    if (launching !== undefined || (p !== undefined && !p.stopping && !p.ready)) return 'The supervisor is starting. Start a new conversation once it has started.';
    if (p !== undefined && !p.stopping && p.busy) return 'The supervisor is working on a turn of this conversation. Stop it, or wait for it to end, then start a new conversation.';
    const cards = approvals.list().length;
    if (cards > 0) {
      return `${cards === 1 ? 'A draft from this conversation waits' : `${cards} drafts from this conversation wait`} for you. Send or don't send ${cards === 1 ? 'it' : 'each one'} first, then start a new conversation.`;
    }
    // Your messages waiting don't refuse it (W136's review): a queue is only left while it's failed or
    // off, where Start may fail again, so a refusal would leave no way out. The reset drops them.
    return undefined;
  }

  // ---------------------------------------------------------------- the process

  function onExit(p: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    if (p.exited) return;
    p.exited = true;
    clearTimeout(p.readyTimer);
    if (p.pid !== undefined) pids.delete(p.pid);
    removeConfig(p);
    gate.forget(p.gateId);
    const wasReady = p.ready;
    const why = p.spawnError ?? (code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`);
    // An older process that exits after a newer one started says nothing about the newer one.
    const current = proc === p || proc === undefined;
    let outcome: SupervisorOutcome;
    if (p.trippedBy !== undefined) {
      outcome = { kind: 'failed', error: p.trippedBy };
    } else if (closed || p.stopping || !current) {
      outcome = { kind: 'closed' };
    } else if (p.spawnError !== undefined) {
      outcome = fail(p.spawnError === 'not-found' || /not found/i.test(p.spawnError) ? "claude wasn't found, so the supervisor didn't start." : "pitwall couldn't start claude for the supervisor.");
    } else if (!wasReady) {
      const background = heldBy(p.stderr);
      if (background !== undefined) outcome = hold(heldError(background.id, 'background'));
      else if (p.resumed) {
        outcome = fail(
          `pitwall couldn't resume the supervisor's conversation: claude stopped as it started (${why}). Press Start to try again, or New conversation to start a new one instead.`,
        );
      } else outcome = fail(`The supervisor stopped as it started (${why}). Press Start to try again.`);
    } else {
      outcome = fail(`The supervisor stopped (${why}). Send it a message, or press Start, to start it again.`);
    }
    // Your messages waiting for it stay queued for the next start, and the snapshot's error says so
    // (W114's review: one sent while a tripped process stopped got a 200, then was dropped here).
    if (current && outcome.kind !== 'closed' && queue.length > 0) {
      log(`${queue.length} queued ${queue.length === 1 ? 'message waits' : 'messages wait'} for its next start.`);
    }
    // Nothing can answer its approvals now: each is denied, and its card goes.
    if (current) approvals.cancelAll('The supervisor stopped before the user answered, so this wasn\'t sent.');
    settle(p, outcome);
    for (const resolve of p.onExit.splice(0)) resolve();
    if (proc === p) proc = undefined;
    changed();
  }

  function stopProcess(p: Proc): void {
    if (p.stopping || p.exited) return;
    p.stopping = true;
    p.child.end();
    p.child.kill('SIGTERM');
    changed();
  }

  /** Stops `p` because it isn't what pitwall started: shown as 'failed', with `why`. */
  function trip(p: Proc, why: string): void {
    if (p.trippedBy !== undefined || p.exited) return;
    p.trippedBy = why;
    // Shown at once, and its token taken back, while it goes.
    problem = { status: 'failed', error: why };
    log(why);
    stopProcess(p);
  }

  function markReady(p: Proc): void {
    if (p.ready || p.exited) return;
    p.ready = true;
    clearTimeout(p.readyTimer);
    settle(p, { kind: 'ok' });
    changed();
    pump();
  }

  /** Writes the next queued message, if it's idle. */
  function pump(): void {
    const p = proc;
    if (p === undefined || !p.ready || p.busy || p.stopping || p.exited) return;
    const next = queue.shift();
    if (next === undefined) return;
    p.busy = true;
    // What pitwall must tell it first, such as what was sent after you edited its proposal (W115).
    p.child.write(userMessageLine(withNotes(approvals.takeNotes(), next.text)));
    changed();
  }

  function writeConfig(text: string): void {
    const temporary = `${configFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, configFile);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // It wasn't made.
      }
      throw error;
    }
  }

  /** Removes the MCP config file, when `p` wrote it last (or, with undefined, when no process did). */
  function removeConfig(p: Proc | undefined): void {
    if (configOwner !== p) return;
    configOwner = undefined;
    try {
      unlinkSync(configFile);
    } catch {
      // Already gone.
    }
  }

  // ---------------------------------------------------------------- stream-json

  function onLine(p: Proc, line: string): void {
    if (p.exited || line.trim() === '') return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    // A message from another session, which the supervisor refuses (SUPERVISOR_SETTINGS): if one
    // reaches it anyway, fail closed (W113's review).
    if (isRecord(event.origin) && event.origin.kind === 'peer') {
      return trip(p, 'A message from another session reached the supervisor, though it refuses them, so pitwall stopped it. Press Start to start it again.');
    }
    switch (event.type) {
      case 'control_response':
        return onControlResponse(p, event);
      case 'control_request':
        return onControlRequest(p, event);
      case 'system':
        if (event.subtype === 'init') onTurnStart(p, event);
        return;
      case 'assistant': {
        if (!p.busy) {
          p.busy = true;
          changed();
        }
        // Its context (W136), as W133 reads a session's: the newest call's, never a sub-agent's.
        const tokens = p.stopping ? undefined : streamContextTokens(event);
        if (tokens !== undefined && tokens !== contextTokens) {
          contextTokens = tokens;
          changed();
        }
        for (const block of blocksOf(event)) {
          if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
          const name = oneLine(block.name, 120);
          stats.toolCalls[name] = (stats.toolCalls[name] ?? 0) + 1;
          // Claude Code asks the approve tool about it, which denies it; say so.
          if (!p.initTools.has(name)) log(`it tried a tool pitwall doesn't give it (${name}); pitwall's approve tool denies it.`);
        }
        return;
      }
      case 'result':
        return onTurnEnd(p, event);
      default:
        return;
    }
  }

  function onControlResponse(p: Proc, event: Record<string, unknown>): void {
    const response = isRecord(event.response) ? event.response : undefined;
    if (response === undefined || response.request_id !== p.initRequestId) return;
    const answer = isRecord(response.response) ? response.response : undefined;
    const mode = answer?.current_permission_mode;
    if (response.subtype === 'success' && mode !== undefined && mode !== SUPERVISOR_PERMISSION_MODE) {
      return trip(p, "The supervisor started in a permission mode pitwall didn't ask for, so pitwall stopped it.");
    }
    markReady(p);
  }

  /**
   * A request from claude on the stream, such as a permission prompt, which pitwall never asks for:
   * prompts go to the approve tool (`--permission-prompt-tool`), never here. A permission prompt is
   * denied, anything else answered with an error, so nothing waits on pitwall and nothing is allowed.
   */
  function onControlRequest(p: Proc, event: Record<string, unknown>): void {
    const id = event.request_id;
    if (typeof id !== 'string' || id.length > 200) return;
    const request = isRecord(event.request) ? event.request : undefined;
    if (request?.subtype === 'can_use_tool') {
      log('it asked on the stream to use a tool, which pitwall refused: approvals go through the approve tool.');
      p.child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'deny', message: 'pitwall answers permission prompts only through its approve tool.' } } })}\n`);
      return;
    }
    p.child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: "pitwall doesn't handle this request." } })}\n`);
  }

  /** system/init, at the start of every turn: the session id, and the tools and mode checked against what pitwall gave it. */
  function onTurnStart(p: Proc, event: Record<string, unknown>): void {
    if (!p.ready) markReady(p);
    p.busy = true;
    const tools = Array.isArray(event.tools) ? event.tools.filter((tool): tool is string => typeof tool === 'string') : [];
    const extra = tools.find((tool) => !p.initTools.has(tool) && !TOLERATED_TOOLS.has(tool));
    if (extra !== undefined) {
      // A connector's tool you didn't choose, such as one its server added since (D28): fail closed.
      const connector = connectorOf(extra, p.connectors);
      if (connector !== undefined) {
        return trip(
          p,
          `The supervisor's connector ${connector} offers a tool you haven't chosen (${oneLine(extra, 80)}), so pitwall stopped it. Run pitwall --connector-tools ${connector}, update its "tools" and "otherTools" in the config file, and restart pitwall.`,
        );
      }
      return trip(p, `The supervisor started with a tool pitwall didn't give it (${oneLine(extra, 80)}), so pitwall stopped it.`);
    }
    if (event.permissionMode !== undefined && event.permissionMode !== SUPERVISOR_PERMISSION_MODE) {
      return trip(p, "The supervisor started in a permission mode pitwall didn't ask for, so pitwall stopped it.");
    }
    // The recipient gate's SessionStart hook ran before the first turn (spike 009, finding 1): without
    // it, its hooks didn't load, and a SendMessage would reach approval unchecked by it (W115).
    if (!gate.isReady(p.gateId)) {
      return trip(p, "The supervisor started without pitwall's message gate, so pitwall stopped it. Press Start to try again.");
    }
    // pitwall's MCP server, its only way to read anything (W113's review): missing or failed, it would
    // answer from nothing. Another status, such as pending, is only logged.
    if (Array.isArray(event.mcp_servers)) {
      const own = event.mcp_servers.find((server) => isRecord(server) && server.name === MCP_SERVER_NAME);
      const status = isRecord(own) ? own.status : undefined;
      if (own === undefined || status === 'failed') {
        return trip(p, "The supervisor started without pitwall's tools connected, so it couldn't read your sessions; pitwall stopped it. Press Start to try again.");
      }
      if (status !== 'connected') log(`pitwall's MCP server is ${oneLine(String(status), 40)} for the supervisor.`);
      // A connector that didn't connect only loses its own tools; the supervisor goes on without them (W184).
      // Said once a process, for each connector and status.
      for (const name of p.connectors) {
        const server = event.mcp_servers.find((entry) => isRecord(entry) && entry.name === name);
        const state = oneLine(String((isRecord(server) ? server.status : undefined) ?? 'missing'), 40);
        if (state === 'connected' || p.reported.has(`${name}:${state}`)) continue;
        p.reported.add(`${name}:${state}`);
        // An OAuth connector not signed in (spike 017, finding 3): Claude Code keeps the sign-in, not pitwall.
        if (state === 'needs-auth') log(`its connector ${name} needs a sign-in, so its tools aren't there. Run pitwall --connector-tools ${name} for how.`);
        else log(`its connector ${name} is ${state}, so its tools aren't there.`);
      }
    }
    const id = event.session_id;
    // Not from a process New conversation is stopping (W136): that conversation was left.
    if (typeof id === 'string' && isSessionUuid(id) && id !== sessionId && !p.stopping && !left.has(id)) {
      sessionId = id;
      sessionIds.add(id);
      store.write({ sessionId: id, promptVersion });
    }
    changed();
  }

  function onTurnEnd(p: Proc, event: Record<string, unknown>): void {
    p.busy = false;
    stats.turns++;
    lastTurnAt = new Date(now()).toISOString();
    const cost = turnCost(event, p.resumed, p.lastTotalCost);
    const total = event.total_cost_usd;
    if (typeof total === 'number' && Number.isFinite(total) && total >= 0) p.lastTotalCost = total;
    if (cost !== undefined) costUsd = (costUsd ?? 0) + cost;
    // Past SUPERVISOR_MAX_TURNS (W120): the turn ended with no answer. It's told before your next message.
    if (event.subtype === 'error_max_turns') {
      log(`a turn reached its limit of ${SUPERVISOR_MAX_TURNS} steps, so Claude Code ended it.`);
      approvals.note(`your last turn reached pitwall's limit of ${SUPERVISOR_MAX_TURNS} steps for one message, so it ended before you answered. Answer with what you have, or say what you'd still read.`);
    }
    // A model Claude Code refused (W119): every turn would fail the same way, so it stops, saying which setting to change.
    if (event.is_error === true && typeof event.result === 'string' && isModelRejection(event.result)) return trip(p, modelRejectedMessage('supervisor'));
    changed();
    pump();
  }

  // ---------------------------------------------------------------- its transcript

  /**
   * The supervisor's transcript: in the project folder of the folder it runs in, as Claude Code
   * names it, or, failing that, in any project folder (a background session that held its id wrote
   * to the same file; spike 009, finding 3). Only a regular file, never a symbolic link.
   */
  function findTranscript(id: string, cwd?: string): string | undefined {
    if (!isSessionUuid(id)) return undefined;
    const projects = path.join(configDir, 'projects');
    const known = transcripts.get(id);
    if (known !== undefined && isRegularFile(known)) return known;
    const candidates: string[] = [];
    for (const folder of new Set([cwd, ...dirs].filter((each): each is string => each !== undefined))) {
      candidates.push(path.join(projects, encodeProjectDir(folder), `${id}.jsonl`));
    }
    let found = candidates.find(isRegularFile);
    if (found === undefined) {
      try {
        for (const entry of readdirSync(projects, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidate = path.join(projects, entry.name, `${id}.jsonl`);
          if (isRegularFile(candidate)) {
            found = candidate;
            break;
          }
        }
      } catch {
        // No projects folder.
      }
    }
    if (found !== undefined) transcripts.set(id, found);
    return found;
  }

  // ---------------------------------------------------------------- the manager

  return {
    state,
    bind(given) {
      mcpUrl = given.mcpUrl;
    },
    start() {
      return ensureRunning();
    },
    async send(text) {
      if (closed) return { kind: 'closed' };
      if (queue.length >= maxQueue) return { kind: 'busy' };
      const entry: Queued = { text };
      queue.push(entry);
      const outcome = await ensureRunning();
      if (outcome.kind !== 'ok') {
        const at = queue.indexOf(entry);
        if (at !== -1) queue.splice(at, 1);
        return outcome;
      }
      pump();
      return { kind: 'ok' };
    },
    interrupt() {
      const p = proc;
      if (p === undefined || !p.ready || !p.busy || p.stopping || p.exited) return { kind: 'idle' };
      p.child.write(controlRequestLine(`pitwall-interrupt-${randomId()}`, { subtype: 'interrupt' }));
      return { kind: 'ok' };
    },
    async newConversation() {
      if (closed) return { kind: 'closed' };
      const refusal = newConversationRefusal();
      if (refusal !== undefined) return { kind: 'refused', error: refusal };
      // Forgotten first, all at once, so a message or Start that comes while the process goes
      // starts a new conversation rather than resuming this one.
      const leaving = sessionId ?? store.read()?.sessionId;
      if (leaving !== undefined) {
        left.add(leaving);
        // Kept, so the old conversation is never listed as a session in this run (isOwn()).
        sessionIds.add(leaving);
      }
      store.clear();
      // What the snapshot carries of the conversation that's left, field by field:
      //   sessionId      that conversation's: gone, until the new one's first turn names its own
      //   lastTurnAt     that conversation's newest turn, "Last turn 4m ago": gone with it
      //   contextTokens  that conversation's size: unknown until the new one's first call
      //   handoffs       what you approved from its drafts: its "Sent and started" list goes, since
      //                  the new conversation proposed none of it; the sessions stay in the list
      //   notes          what pitwall would tell it before your next message, such as what an Edit
      //                  sent, or that a turn reached its limit: about that conversation, so dropped
      //   problem        a failure, such as a resume that couldn't start: about that conversation,
      //                  or a start the next one tries again anyway. 'held' was refused above
      //   costUsd        "$x this run" is this pitwall run's, every conversation in it: kept
      sessionId = undefined;
      lastTurnAt = undefined;
      contextTokens = undefined;
      approvals.forgetConversation();
      problem = undefined;
      //   queue          your messages waiting, written to that conversation: dropped, as the
      //                  confirmation says, rather than sent to a new one without what they answer
      if (queue.length > 0) log(`${queue.length} queued ${queue.length === 1 ? 'message was' : 'messages were'} dropped with the conversation.`);
      queue.length = 0;
      changed();
      const p = proc;
      if (p !== undefined && !p.exited) {
        stopProcess(p);
        if (!(await exitedWithin(p, 2000))) {
          p.child.kill('SIGKILL');
          await exitedWithin(p, 1000);
        }
      }
      log('you started a new conversation: the next message or Start begins it. The one you left stays on disk.');
      return closed ? { kind: 'closed' } : { kind: 'ok' };
    },
    mcpToken() {
      const p = proc;
      // Taken back as soon as pitwall stops it, before it has gone.
      return p === undefined || p.exited || p.stopping ? undefined : p.token;
    },
    ownSessionIds() {
      return new Set(sessionIds);
    },
    isOwn(row) {
      if (row.pid !== undefined && pids.has(row.pid)) return true;
      if (dirs.has(path.resolve(row.cwd))) return true;
      // By its name only in a supervisor's folder, another pitwall's included (an `npm run dev` one on
      // another PITWALL_HOME), as recaps limit theirs (D26): a session of yours that took the name
      // anywhere else stays listed (W120, W116's F4).
      if (row.kind === 'interactive' && nameKey(row.name.trim()) === nameKey(SUPERVISOR_NAME) && isSupervisorFolder(row.cwd)) return true;
      return row.pid === undefined && sessionIds.has(row.sessionId);
    },
    async conversation(before) {
      const id = sessionId ?? store.read()?.sessionId;
      // A conversation New conversation left shows as none: the view's empty state (W136).
      if (id === undefined || left.has(id)) return undefined;
      const file = findTranscript(id);
      if (file === undefined) return undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return (await readConversationPage(file, id, before))?.page;
        } catch (error) {
          // A cursor that can't be used is the route's to answer; the file shrinking while read is tried again once.
          if (error instanceof ConversationCursorError) throw error;
          if (before !== undefined) return undefined;
        }
      }
      return undefined;
    },
    stats() {
      return { starts: stats.starts, turns: stats.turns, toolCalls: { ...stats.toolCalls } };
    },
    approvals: () => approvals,
    setRecipients(names) {
      if (names.length === recipients.length && names.every((name, index) => name === recipients[index])) return;
      recipients = [...names];
      const p = proc;
      if (p === undefined || p.exited) return;
      try {
        gate.setRecipients(p.gateId, recipients);
      } catch (error) {
        // The gate keeps the list before; approve checks every call against the snapshot anyway.
        log(`couldn't update its message gate (${oneLine((error as Error).message)}).`);
      }
    },
    version() {
      return changes;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      // Answered first, while the process can still read the denials.
      approvals.cancelAll("pitwall is closing, so this wasn't sent.");
      queue.length = 0;
      const p = proc;
      if (p !== undefined && !p.exited) {
        p.stopping = true;
        p.child.end();
        if (!(await exitedWithin(p, 1000))) {
          p.child.kill('SIGTERM');
          if (!(await exitedWithin(p, 1000))) p.child.kill('SIGKILL');
        }
      }
      removeConfig(configOwner);
      listeners.clear();
    },
  };
}

/**
 * Tools Claude Code may list that pitwall accepts beyond SUPERVISOR_INIT_TOOLS: none so far.
 * Anything else in system/init's `tools` stops the supervisor.
 */
export const TOLERATED_TOOLS: ReadonlySet<string> = new Set<string>();

/**
 * Your message with pitwall's notes before it, each on a line of its own in brackets, so the
 * supervisor reads them in the same turn rather than one of their own (W115).
 */
export function withNotes(notes: readonly string[], text: string): string {
  if (notes.length === 0) return text;
  return `${notes.map((note) => `[pitwall: ${note}]`).join('\n')}\n\n${text}`;
}

/**
 * The tokens of context an `assistant` event's call carried (W136): as contextTokensOf() reads a
 * transcript's entry (W133), the message's `input_tokens + cache_read_input_tokens +
 * cache_creation_input_tokens`. Undefined for a sub-agent's message (`parent_tool_use_id` set), a
 * `<synthetic>` one, and one with no id or usage.
 */
export function streamContextTokens(event: Record<string, unknown>): number | undefined {
  if (typeof event.parent_tool_use_id === 'string') return undefined;
  return contextTokensOf(event)?.tokens;
}

/** One stream-json control request line. */
export function controlRequestLine(requestId: string, request: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`;
}

/**
 * A turn's own cost, from `result`: the sum of model_usage_since_last_result's costUSD, which
 * covers this turn alone; else the change in total_cost_usd since this process's last result;
 * else, on a process that didn't resume, total_cost_usd itself. total_cost_usd alone covers the
 * whole conversation, earlier processes included (spike 009, finding 2), so a resumed process's
 * first turn without the per-turn figure counts nothing.
 */
export function turnCost(event: Record<string, unknown>, resumed: boolean, lastTotal: number | undefined): number | undefined {
  const usage = event.model_usage_since_last_result;
  if (isRecord(usage)) {
    let sum = 0;
    let seen = false;
    for (const model of Object.values(usage)) {
      if (!isRecord(model)) continue;
      const cost = model.costUSD;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
        sum += cost;
        seen = true;
      }
    }
    if (seen) return sum;
  }
  const total = event.total_cost_usd;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return undefined;
  if (lastTotal !== undefined) return total >= lastTotal ? total - lastTotal : undefined;
  return resumed ? undefined : total;
}

/**
 * Claude Code's refusal to resume a session that runs in the background (spike 009, finding 3):
 * "That session is running in the background (<id8>). Run `claude attach <id8>` to open it, or
 * `claude stop <id8>` first to resume it here." Its short id, when stderr says so.
 */
export function heldBy(stderr: string): { id?: string } | undefined {
  const match = /running in the background \(([^)\s]{1,80})\)/i.exec(stderr);
  if (match === null) return /running in the background/i.test(stderr) ? {} : undefined;
  const id = match[1]!;
  return /^[A-Za-z0-9_-]{4,64}$/.test(id) ? { id } : {};
}

/**
 * Whether `cwd` is shaped like a supervisor's folder, `<pitwall home>/supervisor/session`, which
 * pitwall makes empty and at 0700 and runs nothing else in.
 */
export function isSupervisorFolder(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  return path.basename(resolved) === SUPERVISOR_SESSION_DIR_NAME && path.basename(path.dirname(resolved)) === SUPERVISOR_DIR_NAME;
}

/**
 * What 'held' says: whose session it is, the command that frees it, and that pitwall won't run it.
 * An interactive row with the supervisor's name is most likely another pitwall's supervisor, on the
 * same home, as an `npm run dev` pitwall beside an installed one is; or you, resuming it by hand.
 */
export function heldError(shortId: string | undefined, kind: AgentRow['kind'], name?: string): string {
  if (kind !== 'background' && name !== undefined && nameKey(name.trim()) === nameKey(SUPERVISOR_NAME)) {
    return "Another pitwall, or a terminal where you resumed it, is running the supervisor's conversation, so this one can't resume it. Close that, then press Start.";
  }
  if (kind !== 'background') {
    return "Another Claude Code session is running the supervisor's conversation, so pitwall can't resume it. Exit that session, then press Start. pitwall won't end it for you.";
  }
  const stop = shortId === undefined ? '`claude stop` with its id, from `claude agents`,' : `\`claude stop ${shortId}\``;
  return `A background session is running the supervisor's conversation, so pitwall can't resume it. Run ${stop} to hand it back, then press Start. pitwall won't stop it for you.`;
}

function blocksOf(event: Record<string, unknown>): Record<string, unknown>[] {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function isRegularFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function exitedWithin(p: Proc, ms: number): Promise<boolean> {
  if (p.exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.onExit.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
