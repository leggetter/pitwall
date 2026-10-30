// The supervisor (M5, W113; spike 009; D4): one headless `claude -p` session that pitwall starts,
// owns and resumes, with stream-json on stdin and stdout, on SUPERVISOR_MODEL, with no built-in
// tools and only the read-only tools of pitwall's own MCP server (W112). It can only read: it
// can't message a session, start one, run a command or change a file. W115 adds acting, behind
// your approval.
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
//   stop        with pitwall: stdin closed, then SIGTERM after a second, then SIGKILL
//
// Where:
//
//   $PITWALL_HOME/supervisor/           0700   its folder
//     state.json                        0600   the session id and the prompt's version (state.ts)
//     mcp.json                          0600   the MCP config, with this process's bearer token,
//                                              removed when the process exits
//     session/                          0700   the empty folder claude runs in, where nothing is written
//
// The MCP server's bearer token is new for each process (crypto random) and valid only while that
// process runs: the server compares it in constant time (src/server/mcp.ts). It's in the 0600
// config file alone, never in claude's arguments or environment, so `ps` never shows it.
//
// The stream (spike 009, findings 1, 7 and 10):
//
//   control_request initialize    written at start; its answer says the process reads stdin, so
//                                 the supervisor is 'idle', and that its permission mode is dontAsk
//   system/init                   at the start of every turn: the session id, kept in the state
//                                 file, and its tools and permission mode, checked again
//   assistant, user               a turn running
//   result                        a turn's end: its cost, from model_usage_since_last_result, and
//                                 the next message, if one is queued
//   control_request (from claude) answered with a denial or an error: pitwall asks for nothing,
//                                 so a permission prompt is refused, never allowed
//
// Your messages are written one at a time as stream-json user messages, never on a command line;
// one sent while a turn runs waits in pitwall's queue until its `result`. Stop sends the stream's
// `interrupt` control request. A session's reply, once the supervisor can message (W115), starts a
// turn by itself: `working` until its result.
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentsSource, type AgentRow, type AgentsSource } from '../index/agents.js';
import { ConversationCursorError, readConversationPage } from '../index/conversation.js';
import { runFile } from '../index/exec.js';
import { isRecord } from '../index/guards.js';
import { defaultConfigDir, encodeProjectDir, isSessionUuid } from '../index/transcripts.js';
import type { ConversationPage, SupervisorState } from '../shared/protocol.js';
import { ensureLaunchDir, pitwallHome } from '../server/launch.js';
import { checkClaudeVersion, spawnRelayChild, type RelayChild, type RelayChildEvents, type RelaySpawner } from '../server/relay.js';
import { nameKey, oneLine, userMessageLine } from '../server/relayPrompt.js';
import { randomSecret } from '../server/security.js';
import {
  mcpConfigText,
  MIN_SUPERVISOR_CLAUDE_VERSION,
  SUPERVISOR_ALLOWED_TOOLS,
  SUPERVISOR_DIR_NAME,
  SUPERVISOR_NAME,
  SUPERVISOR_PROMPT_VERSION,
  SUPERVISOR_SESSION_DIR_NAME,
  supervisorArgs,
  supervisorEnvironment,
} from './prompt.js';
import { supervisorStateFile, SUPERVISOR_STATE_FILE, type SupervisorStateStore } from './state.js';

/** The MCP config file's name in the supervisor's folder. */
export const SUPERVISOR_MCP_CONFIG_FILE = 'mcp.json';

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
  /** Changes whenever state() could answer differently. */
  version(): number;
  /** Called when state() may have changed. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Stops it, if it runs, and drops what's queued. Resolves within about 2 seconds. */
  close(): Promise<void>;
}

export interface SupervisorOptions {
  /** pitwall's folder. Default pitwallHome(). The supervisor's is SUPERVISOR_DIR_NAME in it. */
  home?: string;
  /** Default 'claude'. */
  claudeBin?: string;
  /** Default SUPERVISOR_MODEL. */
  model?: string;
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
  const configFile = path.join(dir, SUPERVISOR_MCP_CONFIG_FILE);
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
    const result: SupervisorState = { status: 'off', approvals: [] };
    if (proc !== undefined && !proc.stopping) result.status = !proc.ready ? 'starting' : proc.busy ? 'working' : 'idle';
    else if (launching !== undefined) result.status = 'starting';
    else if (problem !== undefined) {
      result.status = problem.status;
      result.error = problem.error;
    }
    if (sessionId !== undefined) result.sessionId = sessionId;
    if (lastTurnAt !== undefined) result.lastTurnAt = lastTurnAt;
    if (costUsd !== undefined) result.costUsd = Math.round(costUsd * 1e6) / 1e6;
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
    try {
      ensureLaunchDir(home);
      prepareDir(dir);
      cwd = prepareDir(sessionDir);
      dirs.add(cwd);
    } catch {
      return fail(`pitwall couldn't prepare the supervisor's folder, ${dir}, so it didn't start.`);
    }

    // Which conversation: the one on file, if it started on this prompt and its transcript is there.
    const record = store.read();
    let resume: string | undefined;
    if (record !== undefined) {
      sessionIds.add(record.sessionId);
      if (record.promptVersion !== promptVersion) {
        log(`its system prompt is version ${promptVersion} now, and its conversation started on version ${record.promptVersion}, so pitwall starts a new conversation.`);
      } else if (findTranscript(record.sessionId, cwd) === undefined) {
        log("its conversation's transcript is gone, so pitwall starts a new conversation.");
      } else {
        resume = record.sessionId;
      }
    }
    sessionId = resume;
    if (resume !== undefined) {
      const holder = await holderOf(resume);
      if (closed) return { kind: 'closed' };
      if (holder !== undefined) return hold(holder);
    }

    const token = randomSecret();
    try {
      writeConfig(mcpConfigText(mcpUrl, token));
    } catch (error) {
      log(`couldn't write its MCP config (${oneLine((error as Error).message)}).`);
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
      p.child = spawn(claudeBin, supervisorArgs({ mcpConfig: configFile, ...(resume === undefined ? {} : { resume }), ...(options.model === undefined ? {} : { model: options.model }) }), {
        cwd,
        env: supervisorEnvironment(options.env ?? process.env),
      }, events);
    } catch (error) {
      log(`couldn't start it: ${oneLine((error as Error).message)}`);
      removeConfig(p);
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

  // ---------------------------------------------------------------- the process

  function onExit(p: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    if (p.exited) return;
    p.exited = true;
    clearTimeout(p.readyTimer);
    if (p.pid !== undefined) pids.delete(p.pid);
    removeConfig(p);
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
          `pitwall couldn't resume the supervisor's conversation: claude stopped as it started (${why}). Press Start to try again. To start a new conversation instead, delete ${path.join(dir, SUPERVISOR_STATE_FILE)}.`,
        );
      } else outcome = fail(`The supervisor stopped as it started (${why}). Press Start to try again.`);
    } else {
      outcome = fail(`The supervisor stopped (${why}). Send it a message, or press Start, to start it again.`);
    }
    // What was waiting for it can't reach it now. Whoever sent it was told it was taken; the snapshot says it stopped.
    if (current && wasReady && outcome.kind !== 'closed' && queue.length > 0) {
      log(`${queue.length} queued ${queue.length === 1 ? 'message' : 'messages'} didn't reach it.`);
      queue.length = 0;
    }
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
    p.child.write(userMessageLine(next.text));
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
    switch (event.type) {
      case 'control_response':
        return onControlResponse(p, event);
      case 'control_request':
        return onControlRequest(p, event);
      case 'system':
        if (event.subtype === 'init') onTurnStart(p, event);
        return;
      case 'assistant':
        if (!p.busy) {
          p.busy = true;
          changed();
        }
        for (const block of blocksOf(event)) {
          if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
          const name = oneLine(block.name, 120);
          stats.toolCalls[name] = (stats.toolCalls[name] ?? 0) + 1;
          // dontAsk denies it, since only the read-only tools are allowed; say so.
          if (!SUPERVISOR_ALLOWED_TOOLS.includes(name)) log(`it tried a tool pitwall doesn't allow (${name}); Claude Code denies it.`);
        }
        return;
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
    if (response.subtype === 'success' && mode !== undefined && mode !== 'dontAsk') {
      return trip(p, "The supervisor started in a permission mode pitwall didn't ask for, so pitwall stopped it.");
    }
    markReady(p);
  }

  /**
   * A request from claude, such as a permission prompt, which pitwall never asks for (it runs in
   * dontAsk mode, with no prompt tool): a permission prompt is denied, anything else answered with
   * an error, so nothing waits on pitwall and nothing is allowed.
   */
  function onControlRequest(p: Proc, event: Record<string, unknown>): void {
    const id = event.request_id;
    if (typeof id !== 'string' || id.length > 200) return;
    const request = isRecord(event.request) ? event.request : undefined;
    if (request?.subtype === 'can_use_tool') {
      log('it asked to use a tool, which pitwall refused: the supervisor can only read.');
      p.child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'deny', message: "pitwall's supervisor can only read." } } })}\n`);
      return;
    }
    p.child.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: "pitwall doesn't handle this request." } })}\n`);
  }

  /** system/init, at the start of every turn: the session id, and the tools and mode checked against what pitwall gave it. */
  function onTurnStart(p: Proc, event: Record<string, unknown>): void {
    if (!p.ready) markReady(p);
    p.busy = true;
    const tools = Array.isArray(event.tools) ? event.tools.filter((tool): tool is string => typeof tool === 'string') : [];
    const extra = tools.find((tool) => !SUPERVISOR_ALLOWED_TOOLS.includes(tool) && !TOLERATED_TOOLS.has(tool));
    if (extra !== undefined) {
      return trip(p, `The supervisor started with a tool pitwall didn't give it (${oneLine(extra, 80)}), so pitwall stopped it.`);
    }
    if (event.permissionMode !== undefined && event.permissionMode !== 'dontAsk') {
      return trip(p, "The supervisor started in a permission mode pitwall didn't ask for, so pitwall stopped it.");
    }
    const id = event.session_id;
    if (typeof id === 'string' && isSessionUuid(id) && id !== sessionId) {
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
      if (row.kind === 'interactive' && nameKey(row.name.trim()) === nameKey(SUPERVISOR_NAME)) return true;
      return row.pid === undefined && sessionIds.has(row.sessionId);
    },
    async conversation(before) {
      const id = sessionId ?? store.read()?.sessionId;
      if (id === undefined) return undefined;
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
 * Built-in tools Claude Code may list in a `--tools ""` session that pitwall accepts: none so far.
 * Anything else in system/init's `tools` but the read-only MCP tools stops the supervisor.
 */
export const TOLERATED_TOOLS: ReadonlySet<string> = new Set<string>();

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
 * What 'held' says: whose session it is, the command that frees it, and that pitwall won't run it.
 * An interactive row with the supervisor's name is another pitwall's supervisor, on the same home,
 * as an `npm run dev` pitwall beside an installed one is.
 */
export function heldError(shortId: string | undefined, kind: AgentRow['kind'], name?: string): string {
  if (kind !== 'background' && name !== undefined && nameKey(name.trim()) === nameKey(SUPERVISOR_NAME)) {
    return "Another pitwall is running the supervisor's conversation, so this one can't resume it. Close the other pitwall, then press Start.";
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
