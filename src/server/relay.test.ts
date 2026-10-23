// The relay manager, with a fake child that speaks stream-json as Claude Code
// v2.1.301 to v2.1.303 does (spike 003 and the gate's spike), a fake gate
// that makes the real hook's decision in memory, a fake session list and a
// fake transcript. No test runs `claude`. Made-up sessions and text only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRow, AgentsSource } from '../index/agents.js';
import type { RelayTranscriptEvent, RelayTranscriptTail } from '../index/relayTranscript.js';
import {
  checkClaudeVersion,
  createRelayManager,
  relayEnvironment,
  REPLY_MAX_BYTES,
  replyText,
  type RelayChild,
  type RelayChildEvents,
  type RelayManager,
  type RelayOptions,
  type RelayTarget,
} from './relay.js';
import type { GateExpectation, RelayGate } from './relayGate.js';
import { decide, textHash } from './relayGateHook.mjs';

const DIR = '/tmp/pitwall-test-home/relay';
const RELAY_SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';
const TARGET: RelayTarget = { sessionId: '22222222-2222-4222-8222-222222222222', name: 'pitwall-test-target', pid: 4242, cwd: '/tmp/pitwall-test-root/repo' };
const OTHER: RelayTarget = { sessionId: '33333333-3333-4333-8333-333333333333', name: 'pitwall-test-other', pid: 5353, cwd: '/tmp/pitwall-test-root/repo' };
const MSG_ID = 'c8db9aeb-24ab-4c92-9166-3a7e5b173983';
const SENT = { success: true, message: 'in its inbox', msg_id: MSG_ID };

function row(target: RelayTarget, overrides: Partial<AgentRow> = {}): AgentRow {
  return { sessionId: target.sessionId, name: target.name, kind: 'interactive', cwd: target.cwd, pid: target.pid, startedAt: '2026-10-19T00:00:00.000Z', ...overrides };
}

/** What a request prompt carried. */
interface Request {
  id: string;
  to: string;
  text: string;
}

function parseRequest(line: string): Request {
  const content = (JSON.parse(line) as { message: { content: string } }).message.content;
  const match = /^<relay-request id="([0-9a-f]+)">\n<to>(.*)<\/to>\n<text-\1>([\s\S]*)<\/text-\1>\n<\/relay-request>$/.exec(content);
  if (!match) throw new Error(`not a relay request: ${content}`);
  return { id: match[1]!, to: match[2]!, text: match[3]! };
}

/**
 * The gate, in memory. Its hook makes the real hook's decision (decide()),
 * claiming the expectation first, as relayGateHook.mjs does.
 */
class FakeGate implements RelayGate {
  /** Whether new relays' hooks load and mark the gate ready. */
  loads = true;
  /** False: the hook isn't in SendMessage's way, and every call runs. */
  hookRuns = true;
  readonly ready = new Set<string>();
  readonly expectations = new Map<string, { v: number; request: string; to: string; sha256: string; expiresAt: number }>();
  /** Each expectation written, without its text. */
  readonly written: Omit<GateExpectation, 'text'>[] = [];
  private ids = 0;

  constructor(private readonly now: () => number) {}

  prepare(): void {}
  newId(): string {
    const id = (++this.ids).toString(16).padStart(32, '0');
    if (this.loads) this.ready.add(id);
    return id;
  }
  settings(id: string): string {
    return JSON.stringify({ gate: id });
  }
  isReady(id: string): boolean {
    return this.ready.has(id);
  }
  expect(id: string, expectation: GateExpectation): void {
    const { text, ...rest } = expectation;
    this.written.push(rest);
    this.expectations.set(id, { v: 1, request: expectation.request, to: expectation.to, sha256: textHash(text), expiresAt: expectation.expiresAt });
  }
  pending(id: string): boolean {
    return this.expectations.has(id);
  }
  clear(id: string): void {
    this.expectations.delete(id);
  }
  forget(id: string): void {
    this.expectations.delete(id);
    this.ready.delete(id);
  }
  /** The PreToolUse hook, for one SendMessage call. */
  check(id: string, input: Record<string, unknown>) {
    if (!this.hookRuns) return { allow: true as const, reason: '' };
    const expectation = this.expectations.get(id);
    this.expectations.delete(id);
    return decide({ hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: input }, expectation, this.now());
  }
}

/** How the fake relay answers a request: the default sends it as asked. */
type Behaviour = (request: Request, child: FakeChild) => void;

class FakeChild implements RelayChild {
  readonly written: string[] = [];
  ended = false;
  readonly signals: NodeJS.Signals[] = [];
  exited = false;
  behaviour: Behaviour | undefined;
  readonly gateId: string;
  private tool = 0;

  constructor(
    readonly events: RelayChildEvents,
    readonly pid: number,
    readonly args: string[],
    readonly options: { cwd: string; env: NodeJS.ProcessEnv },
    readonly gate: FakeGate,
  ) {
    this.gateId = (JSON.parse(args[args.indexOf('--settings') + 1]!) as { gate: string }).gate;
  }

  write(data: string): void {
    this.written.push(data);
    const request = parseRequest(data);
    setImmediate(() => this.behaviour?.(request, this));
  }

  /** Like `claude -p`, it exits at end-of-file on stdin, unless a test says otherwise. */
  exitOnEnd = true;

  end(): void {
    this.ended = true;
    if (this.exitOnEnd) setImmediate(() => this.exit(0));
  }

  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    // A relay asked to stop goes, as `claude -p` does on SIGTERM.
    setImmediate(() => this.exit(null, signal));
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.events.exit(code, signal);
  }

  emit(event: unknown): void {
    if (!this.exited) this.events.line(JSON.stringify(event));
  }

  init(): void {
    this.emit({ type: 'system', subtype: 'init', session_id: RELAY_SESSION, cwd: DIR, tools: ['SendMessage'] });
  }

  toolUse(name: string, input: unknown): string {
    const id = `toolu_${++this.tool}`;
    this.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    return id;
  }

  toolResult(id: string, result: unknown, isError = false): void {
    this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text: JSON.stringify(result) }] }] } });
  }

  /** A call the gate denied with exit 2, as Claude Code v2.1.303 reports it: the hook's command line, then its stderr. */
  denied(id: string, reason: string): void {
    this.blocked(id, `PreToolUse:SendMessage hook error: [/usr/bin/node /x/relayGateHook.mjs /h/relay-gate ${this.gateId}]: ${reason}`);
  }

  /** A tool result that's an error, as plain text. */
  blocked(id: string, text: string): void {
    this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } });
  }

  /**
   * A SendMessage call as Claude Code makes it: the tool_use, then the gate's
   * hook, then the result unless `hold` is set. Returns what the gate decided,
   * and a function that emits the result later.
   */
  send(input: Record<string, unknown>, result: unknown = SENT, hold = false): { allowed: boolean; finish: () => void } {
    const id = this.toolUse('SendMessage', input);
    const decision = this.gate.check(this.gateId, input);
    const finish = () => (decision.allow ? this.toolResult(id, result) : this.denied(id, decision.reason));
    if (!hold) finish();
    return { allowed: decision.allow, finish };
  }

  text(text: string): void {
    this.emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  }

  result(): void {
    this.emit({ type: 'result', subtype: 'success' });
  }

  /** A whole turn that relays the request as asked, with SendMessage answering `result`. */
  relay(request: Request, result: unknown = SENT): void {
    this.init();
    const { allowed } = this.send({ to: request.to, message: request.text, summary: 'relay' }, result);
    this.text(allowed ? `relayed ${request.id}` : `not relayed ${request.id}: denied`);
    this.result();
  }

  /** A turn a peer's message started, in which the relay tries to send a message of its own. */
  peerTurn(input: Record<string, unknown> = { to: 'pitwall-test-other', message: 'forwarded' }): boolean {
    this.init();
    const { allowed } = this.send(input);
    this.text('noted');
    this.result();
    return allowed;
  }
}

interface Harness {
  relay: RelayManager;
  gate: FakeGate;
  children: FakeChild[];
  child(): FakeChild;
  /** For each relay started, how many earlier ones hadn't exited yet. Never two at once: all zeros. */
  runningAtStart: number[];
  rows: AgentRow[];
  listed: { ok: boolean; error?: string } | undefined;
  agentCalls: number;
  /** Called on each listing, after it's counted. */
  onList: (() => void) | undefined;
  events: RelayTranscriptEvent[];
  logs: string[];
  /** Applied to each child as it starts. */
  behaviour: Behaviour | undefined;
  spawnError: string | undefined;
  /** What `claude --version` prints, or an error it fails with. */
  version: string | Error;
  versionCalls: number;
}

const managers: RelayManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

function harness(options: Partial<RelayOptions> = {}): Harness {
  const now = options.now ?? Date.now;
  const h: Harness = {
    children: [],
    gate: new FakeGate(now),
    child: () => h.children.at(-1)!,
    runningAtStart: [],
    rows: [row(TARGET), row(OTHER)],
    listed: undefined,
    agentCalls: 0,
    onList: undefined,
    events: [],
    logs: [],
    behaviour: (request, child) => child.relay(request),
    spawnError: undefined,
    version: '2.1.303 (Claude Code)',
    versionCalls: 0,
    relay: undefined as unknown as RelayManager,
  };
  const agents: AgentsSource = {
    list: async () => {
      h.agentCalls += 1;
      h.onList?.();
      if (h.listed && !h.listed.ok) return { ok: false, error: h.listed.error ?? 'failed' };
      return { ok: true, rows: h.rows };
    },
  };
  const tail: RelayTranscriptTail = { read: async () => h.events.splice(0) };
  let pid = 9000;
  h.relay = createRelayManager({
    dir: DIR,
    env: {
      HOME: '/Users/pitwall-test',
      PATH: '/usr/bin',
      PITWALL_TOKEN: 'secret-token',
      PITWALL_HOME: '/tmp/pitwall-test-home',
      npm_config_registry: 'https://example.invalid',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'inbox-token',
      CLAUDE_JOB_DIR: '/tmp/job',
      NODE_OPTIONS: '--require /tmp/preload.cjs',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem',
    },
    agents,
    claudeVersion: async () => {
      h.versionCalls += 1;
      if (h.version instanceof Error) throw h.version;
      return h.version;
    },
    transcript: () => tail,
    prepareDir: (dir) => dir,
    gate: h.gate,
    gateReadyMs: 60,
    gatePollMs: 5,
    spawn: (_file, args, spawnOptions, events) => {
      if (h.spawnError !== undefined) {
        const error = h.spawnError;
        setImmediate(() => {
          events.error(error);
          events.exit(null, null);
        });
        return { pid: undefined, write: () => undefined, end: () => undefined, kill: () => undefined };
      }
      const child = new FakeChild(events, ++pid, args, spawnOptions, h.gate);
      child.behaviour = (request, c) => h.behaviour?.(request, c);
      h.runningAtStart.push(h.children.filter((earlier) => !earlier.exited).length);
      h.children.push(child);
      return child;
    },
    noticeGraceMs: 40,
    noticePollMs: 5,
    // As long as pitwall's own. It starts at each write, before a test's own waits, so a loaded test machine that
    // stalls for longer than a short one lets it fire first: it stops the relay itself, mid-turn or before the relay
    // has answered, and a new one starts (W56). Tests of the timer set a short one.
    requestTimeoutMs: 60_000,
    idleWaitMs: 300,
    retryIdleMs: 30,
    restart: { baseMs: 20, maxMs: 80, max: 4, windowMs: 60_000 },
    log: (message) => h.logs.push(message),
    ...options,
  });
  managers.push(h.relay);
  return h;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for `check` to hold, rather than for a margin of wall-clock time that a slow CI machine can miss. */
async function eventually(what: string, check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(2);
  }
}

describe('the relay: a message delivered', () => {
  it('starts the relay on first use, writes a framed request to its stdin, and answers delivered', async () => {
    const h = harness();
    expect(h.children).toHaveLength(0);
    const text = 'Please run the tests.\nThen "report" <back> & stop.';
    await expect(h.relay.send(TARGET, text)).resolves.toEqual({ status: 'delivered' });
    expect(h.children).toHaveLength(1);
    const child = h.child();
    expect(child.written).toHaveLength(1);
    expect(parseRequest(child.written[0]!)).toMatchObject({ to: 'pitwall-test-target', text });
    expect(child.options.cwd).toBe(DIR);
    expect(child.args).not.toContain(text);
  });

  it('starts the relay with its gate’s settings, and a scrubbed environment with no preloads and auto memory off', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    const { args } = h.child();
    expect(args[args.indexOf('--settings') + 1]).toBe(h.gate.settings(h.child().gateId));
    expect(args[args.indexOf('--tools') + 1]).toBe('SendMessage');
    expect(h.child().options.env).toEqual({
      HOME: '/Users/pitwall-test',
      PATH: '/usr/bin',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    });
  });

  it('writes the expectation before the request, without the text, and clears it when the request is done', async () => {
    const h = harness();
    let pendingAtWrite = false;
    h.behaviour = (request, child) => {
      pendingAtWrite = h.gate.pending(child.gateId);
      child.relay(request);
    };
    await h.relay.send(TARGET, 'hello there');
    expect(pendingAtWrite).toBe(true);
    expect(h.gate.written).toHaveLength(1);
    expect(h.gate.written[0]).toMatchObject({ request: parseRequest(h.child().written[0]!).id, to: 'pitwall-test-target' });
    expect(JSON.stringify(h.gate.written)).not.toContain('hello there');
    expect(h.gate.pending(h.child().gateId)).toBe(false);
  });

  it('records the exchange for the snapshot, and hands out copies', async () => {
    const h = harness({ now: () => Date.parse('2026-10-19T10:00:00.000Z') });
    await h.relay.send(TARGET, 'hello');
    const exchange = h.relay.exchange(TARGET.sessionId);
    expect(exchange).toEqual({ sentAt: '2026-10-19T10:00:00.000Z', status: 'delivered' });
    exchange!.status = 'failed';
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('delivered');
    expect(h.relay.exchange(OTHER.sessionId)).toBeUndefined();
  });

  it('keeps one relay for many messages', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'one');
    await h.relay.send(OTHER, 'two');
    expect(h.children).toHaveLength(1);
    expect(h.child().written).toHaveLength(2);
    expect(h.relay.alert()).toBeUndefined();
  });
});

describe('the relay: its gate', () => {
  it('writes nothing to a relay whose gate never marks ready, stops it, and doesn’t restart it', async () => {
    const h = harness();
    h.gate.loads = false;
    const result = await h.relay.send(TARGET, 'hello');
    expect(result).toEqual({
      status: 'failed',
      detail: "pitwall's gate for the relay didn't start, so pitwall stopped the relay and nothing was sent. Try again in a moment.",
    });
    expect(h.child().written).toEqual([]);
    expect(h.child().signals).toEqual(['SIGTERM']);
    await wait(60);
    expect(h.children).toHaveLength(1);
    // The next request starts a new relay, whose gate does load.
    h.gate.loads = true;
    await expect(h.relay.send(TARGET, 'again')).resolves.toEqual({ status: 'delivered' });
    expect(h.children).toHaveLength(2);
  });

  it('answers failed, and nothing was sent, when the gate denies the request’s own call', async () => {
    const h = harness();
    // The expectation expired before the relay got to it.
    h.behaviour = (request, child) => {
      h.gate.expectations.get(child.gateId)!.expiresAt = 0;
      child.relay(request);
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result).toEqual({
      status: 'failed',
      detail: "pitwall's gate didn't let the relay send it, because pitwall's request for this message has expired. Nothing was sent.",
    });
    expect(h.relay.exchange(TARGET.sessionId)).toBeUndefined();
    expect(h.relay.alert()).toBeUndefined();
  });

  it('answers failed when the gate’s hook couldn’t run, which blocks the call', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      const id = child.toolUse('SendMessage', { to: request.to, message: request.text });
      child.blocked(id, 'PreToolUse:SendMessage hook error: [/usr/bin/node /x/relayGateHook.mjs]: failed; blocking because onFailure is "block"\nNo stderr output');
      child.result();
    };
    expect((await h.relay.send(TARGET, 'hello')).detail).toBe("pitwall's gate couldn't check the relay's send, so it was blocked and nothing was sent.");
  });

  it('stops using the relay, with relayOff and no alert, when your own send ran without the gate claiming it', async () => {
    const h = harness();
    h.gate.hookRuns = false;
    expect(h.relay.off()).toBeUndefined();
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'delivered' });
    // The message you sent, as asked: nothing unrequested or changed went, so no alert. relayOff says messaging is off, and why.
    expect(h.relay.alert()).toBeUndefined();
    expect(h.logs).toContain("The relay's SendMessage ran without pitwall's gate checking it. It was the message you sent, but the relay isn't safe to use.");
    expect(h.relay.off()).toEqual({ since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), reason: "its gate didn't check a SendMessage call." });
    await wait(20);
    expect(h.children[0]!.signals).toEqual(['SIGTERM']);
    const next = await h.relay.send(TARGET, 'again');
    expect(next).toEqual({ status: 'failed', detail: "pitwall stopped using its relay for this run: its gate didn't check a SendMessage call. Restart pitwall to use it again." });
    expect(h.children).toHaveLength(1);
  });
});

describe('the relay: which blocked calls restart it', () => {
  it('keeps the relay after a blocked call nobody asked for', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    h.child().peerTurn();
    await wait(10);
    expect(h.relay.alert()).toMatchObject({ blocked: true, cause: 'unrequested' });
    expect(h.relay.off()).toBeUndefined();
    expect(h.child().signals).toEqual([]);
    expect(h.children).toHaveLength(1);
  });

  it('restarts the relay once its turn ends, after a blocked call for pitwall’s own request that didn’t match it', async () => {
    // The first write's timer runs on while the request waits for the turn to end, by design. A loaded CI machine once
    // stalled this test past the 400 ms the harness gave it, so that timer stopped the relay mid-turn and a new one
    // started (W56). That path has a test of its own, after the one more try tests.
    const h = harness();
    const endTurn: (() => void)[] = [];
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: request.to, message: `${request.text}\n` });
      endTurn.push(() => child.result());
    };
    const result = h.relay.send(TARGET, 'hello');
    await eventually('the first call', () => endTurn.length === 1);
    await wait(20);
    // Not mid-turn: only once the turn has ended. Then a changed text is tried once more, on a new relay.
    expect(h.children[0]!.signals).toEqual([]);
    expect(h.children).toHaveLength(1);
    endTurn[0]!();
    expect(h.children[0]!.signals).toEqual(['SIGTERM']);
    await eventually('the second call', () => endTurn.length === 2);
    expect(h.children).toHaveLength(2);
    // Started once the old relay had gone: never two at once.
    expect(h.runningAtStart).toEqual([0, 0]);
    expect(h.children[1]!.signals).toEqual([]);
    endTurn[1]!();
    expect(h.children[1]!.signals).toEqual(['SIGTERM']);
    expect((await result).status).toBe('failed');
    // A changed text, blocked, so nothing was sent: no alert. The message's own result says why.
    expect(h.relay.alert()).toBeUndefined();
  });

  it('restarts the relay once its turn ends, as before W43, after a blocked call that differs in more than its text, and never tries it again (W52)', async () => {
    const h = harness();
    const endTurn: (() => void)[] = [];
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: request.to, message: request.text, attachments: [] });
      endTurn.push(() => child.result());
    };
    // Answered as soon as the gate blocks it: there's no second try to wait for.
    expect(await h.relay.send(TARGET, 'hello')).toEqual({
      status: 'failed',
      detail:
        "pitwall's gate stopped the relay's copy of your message, because it didn't match, so nothing was sent. The relay's SendMessage call had a field pitwall doesn't check. More than its text differed, so pitwall didn’t try again.",
    });
    expect(h.relay.alert()).toMatchObject({ blocked: true, cause: 'changed', count: 1 });
    await wait(20);
    expect(h.child().signals).toEqual([]);
    endTurn[0]!();
    expect(h.children[0]!.signals).toEqual(['SIGTERM']);
    await wait(60);
    expect(endTurn).toHaveLength(1);
    expect(allWritten(h)).toHaveLength(1);
  });
});

describe('the relay: the Claude Code version', () => {
  it('checks claude --version once, before the first start', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'one');
    await h.relay.send(TARGET, 'two');
    expect(h.versionCalls).toBe(1);
  });

  it.each([
    ['older than 2.1.295', '2.1.294 (Claude Code)', "pitwall's relay needs Claude Code 2.1.295 or later for its gate, and this is 2.1.294. Update Claude Code, then try again. Nothing was sent."],
    ['unreadable', 'Claude Code, some new format', "pitwall's relay needs Claude Code 2.1.295 or later for its gate, and pitwall couldn't read which version this is. Update Claude Code, then try again. Nothing was sent."],
  ])('refuses to start the relay on a version that’s %s', async (_what, version, detail) => {
    const h = harness();
    h.version = version;
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'failed', detail });
    expect(h.children).toHaveLength(0);
  });

  it('refuses when claude --version can’t run, and checks again next time, so an update needs no restart', async () => {
    const h = harness();
    h.version = new Error('claude was not found');
    expect((await h.relay.send(TARGET, 'hello')).detail).toBe("Couldn't run claude --version to check that its gate will work, so nothing was sent: claude was not found");
    h.version = '2.1.303 (Claude Code)';
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'delivered' });
    expect(h.versionCalls).toBe(2);
  });
});

describe('checkClaudeVersion', () => {
  it.each([
    ['2.1.295 (Claude Code)', true, '2.1.295'],
    ['2.1.303 (Claude Code)', true, '2.1.303'],
    ['2.2.0', true, '2.2.0'],
    ['3.0.0', true, '3.0.0'],
    ['2.1.294 (Claude Code)', false, '2.1.294'],
    ['2.0.999', false, '2.0.999'],
    ['1.9.400', false, '1.9.400'],
  ])('reads %j as new enough: %s', (output, ok, version) => {
    expect(checkClaudeVersion(output)).toEqual({ ok, version });
  });

  it('counts output that doesn’t start with a version as too old', () => {
    expect(checkClaudeVersion('')).toEqual({ ok: false });
    expect(checkClaudeVersion('Claude Code 2.1.303')).toEqual({ ok: false });
  });
});

describe('relayEnvironment', () => {
  it('drops what makes node or the linker load other code, and keeps trust settings', () => {
    const env = relayEnvironment({
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require /tmp/x.cjs',
      node_options: '--import /tmp/y.mjs',
      NODE_REPL_EXTERNAL_MODULE: '/tmp/z.js',
      NODE_PATH: '/tmp/modules',
      NODE_COMPILE_CACHE: '/tmp/cache',
      OPENSSL_CONF: '/tmp/openssl.cnf',
      OPENSSL_ENGINES: '/tmp/engines',
      OPENSSL_MODULES: '/tmp/providers',
      LD_PRELOAD: '/tmp/x.so',
      LD_AUDIT: '/tmp/a.so',
      DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem',
      NODE_TLS_REJECT_UNAUTHORIZED: '1',
    });
    expect(env).toEqual({ PATH: '/usr/bin', NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem', NODE_TLS_REJECT_UNAUTHORIZED: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });
});

describe('the relay: a message nobody asked for', () => {
  it('raises a blocked alert when another session talks the relay into sending, and keeps the relay, which is still sound', async () => {
    const h = harness({ now: () => Date.parse('2026-10-19T10:00:00.000Z') });
    await h.relay.send(TARGET, 'hello');
    const child = h.child();
    expect(child.peerTurn()).toBe(false);
    await wait(10);
    expect(h.relay.alert()).toEqual({
      at: '2026-10-19T10:00:00.000Z',
      detail: "The relay tried to send a message when pitwall hadn’t asked it to. pitwall's gate blocked it, so nothing was sent.",
      count: 1,
      blocked: true,
      cause: 'unrequested',
    });
    expect(child.signals).toEqual([]);
    expect(h.logs.join('\n')).not.toContain('forwarded');
    // The same relay takes the next message.
    await expect(h.relay.send(TARGET, 'again')).resolves.toEqual({ status: 'delivered' });
    expect(h.children).toHaveLength(1);
    h.child().peerTurn();
    await wait(10);
    expect(h.relay.alert()?.count).toBe(2);
  });

  it('can’t be used up by a peer: blocked calls never count toward the restart limit', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    // More than the limit of 4 starts in the window, with a send between each.
    for (let i = 0; i < 6; i++) {
      h.child().peerTurn();
      await wait(5);
      await expect(h.relay.send(TARGET, `message ${i}`)).resolves.toEqual({ status: 'delivered' });
    }
    expect(h.children).toHaveLength(1);
    expect(h.relay.alert()).toMatchObject({ count: 6, blocked: true });
  });

  it('restarts the relay when a turn ends before a call nobody asked for had its result', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    const child = h.child();
    child.init();
    child.toolUse('SendMessage', { to: 'pitwall-test-other', message: 'forwarded' });
    child.result();
    await wait(10);
    expect(h.relay.alert()).toMatchObject({ blocked: false, cause: 'unrequested', detail: expect.stringMatching(/turn ended before pitwall saw whether its gate blocked it/) });
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('blocks a second send for one request, and keeps the first one delivered', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: request.to, message: request.text });
      child.send({ to: request.to, message: request.text });
      child.text(`relayed ${request.id}`);
      child.result();
    };
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'delivered' });
    expect(h.relay.alert()).toMatchObject({ blocked: true, cause: 'unrequested', detail: expect.stringMatching(/^The relay tried to send a second message for one request\./) });
    expect(h.children[0]!.signals).toEqual([]);
  });

  it('raises an alert that wasn’t blocked, and stops using the relay, when one got past the gate', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    h.gate.hookRuns = false;
    h.child().peerTurn();
    await wait(10);
    expect(h.relay.alert()).toMatchObject({ blocked: false, cause: 'unrequested', detail: expect.stringMatching(/gate didn't stop it, so pitwall stopped the relay/) });
    expect(h.relay.off()?.reason).toBe('its gate let through a SendMessage call nobody asked for.');
    expect((await h.relay.send(TARGET, 'again')).detail).toMatch(/^pitwall stopped using its relay for this run: its gate let through a SendMessage call nobody asked for\./);
  });

  it('raises an alert that wasn’t blocked when the relay stops before the call’s result', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    const child = h.child();
    child.init();
    child.toolUse('SendMessage', { to: 'pitwall-test-other', message: 'forwarded' });
    child.exit(1);
    await wait(10);
    expect(h.relay.alert()).toMatchObject({ blocked: false, cause: 'unrequested', detail: expect.stringMatching(/stopped before pitwall saw whether its gate blocked it/) });
    // Not blocked, but the relay is only restarted, not off.
    expect(h.relay.off()).toBeUndefined();
  });

  it('hands out copies of the alert', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    h.child().peerTurn();
    await wait(10);
    const alert = h.relay.alert()!;
    alert.count = 99;
    expect(h.relay.alert()?.count).toBe(1);
  });
});

describe('the relay: held and refused', () => {
  it('answers held when a notice with the same msg_id arrives within the grace period', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.relay(request);
      h.events.push({ kind: 'notice', msgId: MSG_ID, outcome: 'held' });
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.status).toBe('held');
    expect(result.detail).toMatch(/approval in that session's own terminal/);
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('held');
  });

  it('answers refused for a refusal notice', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.relay(request);
      h.events.push({ kind: 'notice', msgId: MSG_ID, outcome: 'refused' });
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.status).toBe('refused');
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('refused');
  });

  it('ignores a notice for another message', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.relay(request);
      h.events.push({ kind: 'notice', msgId: 'ffffffff-0000-4000-8000-000000000000', outcome: 'refused' });
    };
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'delivered' });
  });

  it('updates the exchange when a notice comes after the answer', async () => {
    const h = harness();
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'delivered' });
    h.events.push({ kind: 'notice', msgId: MSG_ID, outcome: 'held' });
    // Every peer message starts a turn, and the turn's end reads the transcript.
    h.child().init();
    h.child().text('noted');
    h.child().result();
    await wait(10);
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('held');
    h.events.push({ kind: 'notice', msgId: MSG_ID, outcome: 'released' });
    h.child().result();
    await wait(10);
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('delivered');
  });
});

describe('the relay: not sent', () => {
  it('answers failed with SendMessage’s reason, and records nothing', async () => {
    const h = harness();
    h.behaviour = (request, child) => child.relay(request, { success: false, message: "No agent named 'pitwall-test-target' is reachable." });
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'failed', detail: "No agent named 'pitwall-test-target' is reachable." });
    expect(h.relay.exchange(TARGET.sessionId)).toBeUndefined();
  });

  it('answers failed when the relay says it didn’t send, without calling SendMessage', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.text(`not relayed ${request.id}: the tool is unavailable`);
      child.result();
    };
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'failed', detail: 'Not sent: the tool is unavailable' });
  });

  it('fails as ambiguous when two live sessions have the name, without starting the relay', async () => {
    const h = harness();
    h.rows = [row(TARGET), row(TARGET, { sessionId: '44444444-4444-4444-8444-444444444444', pid: 6464, cwd: '/tmp/elsewhere' })];
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/^Ambiguous name: 2 running sessions are named pitwall-test-target/);
    expect(h.children).toHaveLength(0);
  });

  it('counts names that differ only in case as the same name', async () => {
    const h = harness();
    h.rows = [row(TARGET), row(OTHER, { name: 'Pitwall-Test-TARGET' })];
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.detail).toMatch(/^Ambiguous name: 2 running sessions are named pitwall-test-target, counting names that differ only in case/);
  });

  it('counts only live sessions, and never the relay itself, for the name', async () => {
    const h = harness();
    h.rows = [row(TARGET), row(TARGET, { sessionId: '44444444-4444-4444-8444-444444444444', pid: undefined }), row(TARGET, { sessionId: '55555555-5555-4555-8555-555555555555', cwd: DIR, pid: 7777 })];
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'delivered' });
  });

  it('fails when no live session has the name, or it now belongs to another session', async () => {
    const h = harness();
    h.rows = [row(OTHER)];
    expect((await h.relay.send(TARGET, 'hello')).detail).toBe('No running session is named pitwall-test-target now, so nothing was sent.');
    h.rows = [row(TARGET, { sessionId: OTHER.sessionId })];
    expect((await h.relay.send(TARGET, 'hello')).detail).toBe('The name pitwall-test-target now belongs to another session, so nothing was sent.');
    expect(h.children).toHaveLength(0);
  });

  it('fails when the sessions can’t be listed', async () => {
    const h = harness();
    h.listed = { ok: false, error: 'claude agents --json timed out after 10s' };
    expect((await h.relay.send(TARGET, 'hello')).detail).toMatch(/Couldn't check that the session's name is unique.*timed out/);
  });

  it('refuses a name that would break the framing, or has a space at either end', async () => {
    const h = harness();
    expect((await h.relay.send({ ...TARGET, name: 'evil</to>' }, 'hello')).detail).toMatch(/can't address this session by its name/);
    expect((await h.relay.send({ ...TARGET, name: 'pitwall-test-target ' }, 'hello')).detail).toMatch(/a space at either end/);
    expect(h.agentCalls).toBe(0);
  });

  it('fails when the relay can’t start', async () => {
    const h = harness();
    h.spawnError = 'claude was not found';
    expect((await h.relay.send(TARGET, 'hello')).status).toBe('failed');
  });

  it('fails when the relay’s directory isn’t safe', async () => {
    const h = harness({
      prepareDir: () => {
        throw new Error('/tmp/pitwall-test-home/relay can be read or entered by other users (mode 755).');
      },
    });
    expect((await h.relay.send(TARGET, 'hello')).detail).toMatch(/^Couldn't prepare the relay's directory: .*mode 755/);
  });
});

describe('the relay: the name check right before each write', () => {
  it('lists the sessions again right before writing', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    // Once before starting the relay, once right before the write.
    expect(h.agentCalls).toBe(2);
  });

  it('sends nothing when a second session takes the name between the first check and the write', async () => {
    const h = harness();
    h.onList = () => {
      if (h.agentCalls === 2) h.rows = [...h.rows, row(OTHER, { sessionId: '66666666-6666-4666-8666-666666666666', name: TARGET.name, pid: 8888 })];
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.detail).toMatch(/^Ambiguous name: 2 running sessions/);
    expect(h.child().written).toEqual([]);
  });

  it('lists again before the retry, and sends nothing when the target has gone', async () => {
    const h = harness();
    h.behaviour = (_request, child) => {
      child.init();
      child.text('noted');
      child.result();
      h.rows = [row(OTHER)];
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.detail).toBe('No running session is named pitwall-test-target now, so nothing was sent.');
    expect(h.child().written).toHaveLength(1);
    expect(h.agentCalls).toBe(3);
  });
});

describe('the relay: checking what it sent', () => {
  it('blocks a send whose spacing was changed, twice, says nothing was sent and where, raises no alert, and never logs the text', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: request.to, message: `${request.text}\n\n` });
      child.text(`not relayed ${request.id}: denied`);
      child.result();
    };
    const result = await h.relay.send(TARGET, 'secret plan');
    expect(result).toEqual({
      status: 'failed',
      detail:
        "pitwall's gate stopped the relay's copy of your message twice, because it didn't match, so nothing was sent. Both times, the relay changed the text before sending it, first at line 1: the copy has 2 more characters from here, including 2 line breaks.",
    });
    expect(h.relay.alert()).toBeUndefined();
    expect(h.relay.exchange(TARGET.sessionId)).toBeUndefined();
    // Its conversation may have been poisoned, so each relay is restarted once its turn ends, and a new relay takes the next message.
    expect(h.children[0]!.signals).toEqual(['SIGTERM']);
    expect(h.children[1]!.signals).toEqual(['SIGTERM']);
    expect(h.logs.join('\n')).not.toContain('secret');
    expect(h.logs.filter((line) => line.includes('first at line 1: the copy has 2 more characters from here, including 2 line breaks'))).toHaveLength(2);
    h.behaviour = (request, child) => child.relay(request);
    await expect(h.relay.send(TARGET, 'again')).resolves.toEqual({ status: 'delivered' });
    expect(h.children).toHaveLength(3);
  });

  it('blocks a send to another session, or one that subscribes to idle notices, with today’s reasons, an alert, and no second try (W52)', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: 'pitwall-test-other', message: request.text });
      child.result();
    };
    expect(await h.relay.send(TARGET, 'hello')).toEqual({
      status: 'failed',
      detail:
        "pitwall's gate stopped the relay's copy of your message, because it didn't match, so nothing was sent. The relay addressed the message to another session. More than its text differed, so pitwall didn’t try again.",
    });
    expect(h.relay.alert()).toMatchObject({
      blocked: true,
      cause: 'changed',
      count: 1,
      detail: "The relay addressed the message to another session. pitwall's gate blocked it, so nothing was sent.",
    });
    await wait(20);
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: request.to, message: request.text, notify_when_idle: true });
      child.result();
    };
    expect(await h.relay.send(TARGET, 'hello')).toEqual({
      status: 'failed',
      detail:
        "pitwall's gate stopped the relay's copy of your message, because it didn't match, so nothing was sent. The relay asked to be told when the session goes idle. More than its text differed, so pitwall didn’t try again.",
    });
    expect(h.relay.alert()).toMatchObject({ blocked: true, cause: 'changed', count: 2, detail: expect.stringMatching(/^The relay asked to be told when the session goes idle\./) });
    await wait(20);
    expect(allWritten(h)).toHaveLength(2);
  });

  it('answers uncertain, and stops using the relay, when a send that didn’t match got past the gate', async () => {
    const h = harness();
    h.gate.hookRuns = false;
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: request.to, message: `${request.text}\n` });
      child.result();
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result).toEqual({
      status: 'uncertain',
      detail:
        'The relay changed the text before sending it, first at line 1: the copy adds a line break (U+000A). It may have reached the session: check its conversation before sending again.',
    });
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('uncertain');
    expect(h.relay.alert()).toMatchObject({ blocked: false, cause: 'changed' });
    expect((await h.relay.send(TARGET, 'again')).detail).toMatch(/stopped using its relay/);
  });

  it('restarts the relay when it uses any other tool, ListAgents included', async () => {
    const h = harness();
    h.behaviour = (_request, child) => {
      child.init();
      child.toolUse('ListAgents', {});
    };
    expect((await h.relay.send(TARGET, 'hello')).detail).toMatch(/a tool it isn't allowed \(ListAgents\)\. pitwall restarted the relay\. Nothing was sent\./);
  });

  it('fails when the relay claims it sent without calling SendMessage', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.text(`relayed ${request.id}`);
      child.result();
    };
    expect((await h.relay.send(TARGET, 'hello')).detail).toMatch(/didn't see it call SendMessage.*Nothing was sent\./);
  });

  it('answers uncertain for an error that isn’t the gate’s, because the call may have run', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      const id = child.toolUse('SendMessage', { to: request.to, message: request.text });
      h.gate.check(child.gateId, { to: request.to, message: request.text });
      child.blocked(id, 'Not sent — too many messages');
      child.result();
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.status).toBe('uncertain');
    expect(result.detail).toMatch(/^SendMessage failed in a way pitwall doesn’t recognize\. It may have reached the session/);
  });

  it('answers uncertain for an answer from SendMessage it doesn’t recognize', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      const id = child.toolUse('SendMessage', { to: request.to, message: request.text });
      h.gate.check(child.gateId, { to: request.to, message: request.text });
      child.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'something new' }] } });
      child.result();
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.status).toBe('uncertain');
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('uncertain');
  });
});

/** Every request written to any relay, in order. */
const allWritten = (h: Harness) => h.children.flatMap((child) => child.written.map(parseRequest));

/** A turn whose SendMessage call has `message` in place of the request's text. */
const copies =
  (message: (text: string) => string): Behaviour =>
  (request, child) => {
    child.init();
    const { allowed } = child.send({ to: request.to, message: message(request.text) });
    child.text(allowed ? `relayed ${request.id}` : `not relayed ${request.id}: denied`);
    child.result();
  };

describe('the relay: look-alike spaces made plain (W43)', () => {
  const text = 'Line one,\u00a0with a no-break space.\r\nLine two, with\u202fa narrow one and\u2009a thin one.\r\n';
  const plain = 'Line one, with a no-break space.\nLine two, with a narrow one and a thin one.\n';

  it('frames the request, sets the gate’s expectation and checks the call with the plain text, and answers delivered', async () => {
    const h = harness();
    let expected: string | undefined;
    h.behaviour = (request, child) => {
      expected = h.gate.expectations.get(child.gateId)?.sha256;
      child.relay(request);
    };
    await expect(h.relay.send(TARGET, text)).resolves.toEqual({ status: 'delivered' });
    expect(allWritten(h).map((request) => request.text)).toEqual([plain]);
    expect(expected).toBe(textHash(plain));
    expect(h.relay.alert()).toBeUndefined();
    expect(h.logs).toEqual([]);
  });

  it('counts a copy of the text as received, look-alike spaces and all, as changed', async () => {
    const h = harness();
    h.behaviour = copies(() => text);
    const result = await h.relay.send(TARGET, text);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('first at line 1: a space (U+0020) became a no-break space (U+00A0).');
  });

  it('picks a request id from the plain text', async () => {
    const h = harness({ randomId: () => 'deadbeefdeadbeef' });
    await expect(h.relay.send(TARGET, 'one\u00a0two')).resolves.toEqual({ status: 'delivered' });
    expect(allWritten(h)[0]).toEqual({ id: 'deadbeefdeadbeef', to: TARGET.name, text: 'one two' });
  });
});

/** A reason as the rest of a sentence, as relay.ts writes it after "The first time, ". */
const lowerFirst = (reason: string) => reason.charAt(0).toLowerCase() + reason.slice(1);

/** The detail of a delivered message whose first copy the gate blocked, in front of where that copy differed. */
const RETRIED =
  "pitwall's gate stopped the relay's first copy of your message, because it didn't match, so pitwall tried once more, on a new relay, and the second copy went through. The first time, ";

describe('the relay: one more try for a changed text the gate blocked (W43, W52)', () => {
  it('tries a blocked changed text once more on a new relay, with a new request id and expectation, and answers delivered, saying so', async () => {
    const h = harness();
    let attempt = 0;
    h.behaviour = (request, child) => (++attempt === 1 ? copies((t) => t.replace(' ', '　'))(request, child) : child.relay(request));
    const result = await h.relay.send(TARGET, 'A made-up note about the export.');
    // The result says the first copy was blocked, and where it differed, never with the text (W52).
    expect(result).toEqual({
      status: 'delivered',
      detail: `${RETRIED}the relay changed the text before sending it, first at line 1: a space (U+0020) became an ideographic space (U+3000).`,
    });
    expect(h.children).toHaveLength(2);
    expect(h.children[0]!.signals).toEqual(['SIGTERM']);
    expect(h.runningAtStart).toEqual([0, 0]);
    const [first, second] = allWritten(h);
    expect(first!.text).toBe(second!.text);
    expect(first!.id).not.toBe(second!.id);
    expect(h.children.map((child) => child.written.length)).toEqual([1, 1]);
    expect(h.gate.written.map((written) => written.request)).toEqual([first!.id, second!.id]);
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('delivered');
    // Blocked, so nothing was sent: no alert, and the log says where, never the text.
    expect(h.relay.alert()).toBeUndefined();
    expect(h.logs).toContain(
      "The relay changed the text before sending it, first at line 1: a space (U+0020) became an ideographic space (U+3000). pitwall's gate blocked it, so nothing was sent. pitwall will try once more, on a new relay.",
    );
    expect(`${h.logs.join('\n')}\n${result.detail}`).not.toMatch(/made-up|note|export/);
  });

  describe('tries each kind of slip in the spacing once more, with no alert', () => {
    const text = 'Line one, with words.\nLine two,​ with a zero-width space.\n';
    it.each([
      ['a line break added', (t: string) => `${t}\n`],
      ['the last line break left out', (t: string) => t.slice(0, -1)],
      ['a CRLF for a line break', (t: string) => t.replace('\n', '\r\n')],
      ['a tab for a space', (t: string) => t.replace(' ', '\t')],
      ['two spaces for one', (t: string) => t.replace(' ', '  ')],
      ['a line break for a space', (t: string) => t.replace(' ', '\n')],
      ['a no-break space for a space', (t: string) => t.replace(' ', ' ')],
      ['an ideographic space for a space', (t: string) => t.replace(' ', '　')],
      ['a zero-width space the text has, left out', (t: string) => t.replace('​', '')],
      ['a zero-width space the text has, moved', (t: string) => t.replace('​ ', ' ​')],
    ])('%s', async (_name, copy) => {
      const h = harness();
      let attempt = 0;
      h.behaviour = (request, child) => (++attempt === 1 ? copies(copy)(request, child) : child.relay(request));
      const result = await h.relay.send(TARGET, text);
      expect(result.status).toBe('delivered');
      expect(result.detail).toMatch(new RegExp(`^${RETRIED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}the relay changed the text before sending it, first at line \\d: `));
      expect(h.relay.alert()).toBeUndefined();
      expect(allWritten(h)).toHaveLength(2);
    });
  });

  it('waits for the relay’s turn to end, and for it to go, before the second try', async () => {
    const h = harness();
    const endTurn: (() => void)[] = [];
    h.behaviour = (request, child) => {
      if (h.children.length === 1) {
        child.init();
        child.send({ to: request.to, message: `${request.text}\n` });
        endTurn.push(() => child.result());
      } else child.relay(request);
    };
    const result = h.relay.send(TARGET, 'hello');
    await eventually('the first call', () => endTurn.length === 1);
    await wait(30);
    expect(h.children).toHaveLength(1);
    expect(h.children[0]!.signals).toEqual([]);
    endTurn[0]!();
    await expect(result).resolves.toEqual({ status: 'delivered', detail: `${RETRIED}the relay changed the text before sending it, first at line 1: the copy adds a line break (U+000A).` });
    expect(h.children).toHaveLength(2);
    expect(h.runningAtStart).toEqual([0, 0]);
  });

  it('lets the first try’s own timer end a turn that doesn’t, with no second try, and starts the next relay only once that one has gone', async () => {
    // The first write's timer runs on while the request waits for the turn to end, so a turn that never ends can't hold
    // the message up. A stalled CI machine once sent "restarts the relay once its turn ends, …" down this path (W56).
    const h = harness({ requestTimeoutMs: 400 });
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: request.to, message: `${request.text}\n` });
      // The turn never ends.
    };
    expect(await h.relay.send(TARGET, 'hello')).toEqual({
      status: 'failed',
      detail:
        "pitwall's gate stopped the relay's copy of your message, because it didn't match, so nothing was sent. The relay changed the text before sending it, first at line 1: the copy adds a line break (U+000A). pitwall couldn’t try again: The relay didn't finish within 0s. pitwall restarted the relay, and nothing was sent.",
    });
    expect(h.children[0]!.signals).toEqual(['SIGTERM']);
    // Restarted once it has gone, as after any stop, with nothing written to the new relay.
    await eventually('the restart', () => h.children.length === 2);
    expect(h.runningAtStart).toEqual([0, 0]);
    await wait(20);
    expect(allWritten(h)).toHaveLength(1);
    expect(h.relay.alert()).toBeUndefined();
  });

  it('says so when the relay stops while waiting for a notice after the second copy, which still went through', async () => {
    const h = harness({ noticeGraceMs: 2000 });
    let attempt = 0;
    h.behaviour = (request, child) => {
      if (++attempt === 1) return copies((t) => `${t}\n`)(request, child);
      child.relay(request);
      setTimeout(() => child.exit(1), 20);
    };
    expect(await h.relay.send(TARGET, 'hello')).toEqual({
      status: 'delivered',
      detail: `${RETRIED}the relay changed the text before sending it, first at line 1: the copy adds a line break (U+000A).`,
    });
  });

  it('answers failed when the second copy is blocked too, says where each first differed, and never tries a third time', async () => {
    const h = harness();
    let attempt = 0;
    h.behaviour = (request, child) => copies((t) => (++attempt === 1 ? t.replace('\n', '\r\n') : `${t}\n`))(request, child);
    const result = await h.relay.send(TARGET, 'One line.\nTwo lines.');
    expect(result).toEqual({
      status: 'failed',
      detail:
        "pitwall's gate stopped the relay's copy of your message twice, because it didn't match, so nothing was sent. The first time, the relay changed the text before sending it, first at line 1: the copy adds a carriage return (U+000D). The second time, the relay changed the text before sending it, first at line 2: the copy adds a line break (U+000A).",
    });
    await wait(60);
    // The relay that blocked the second copy is restarted as before, but nothing is written to the new one.
    expect(allWritten(h)).toHaveLength(2);
    expect(h.children.length).toBeGreaterThanOrEqual(2);
    expect(h.relay.alert()).toBeUndefined();
    expect(h.logs.filter((line) => line.endsWith('pitwall will try once more, on a new relay.'))).toHaveLength(1);
    expect(h.logs).toContain(
      "The relay changed the text before sending it, first at line 2: the copy adds a line break (U+000A). pitwall's gate blocked it again, so nothing was sent.",
    );
  });

  it('raises an alert when the gate blocks a second copy that differs in more than its text, and never tries a third time (W52)', async () => {
    const h = harness();
    let attempt = 0;
    h.behaviour = (request, child) => {
      child.init();
      child.send(++attempt === 1 ? { to: request.to, message: `${request.text}\n` } : { to: OTHER.name, message: request.text });
      child.result();
    };
    expect(await h.relay.send(TARGET, 'hello')).toEqual({
      status: 'failed',
      detail:
        "pitwall's gate stopped the relay's copy of your message twice, because it didn't match, so nothing was sent. The first time, the relay changed the text before sending it, first at line 1: the copy adds a line break (U+000A). The second time, the relay addressed the message to another session.",
    });
    expect(h.relay.alert()).toMatchObject({ blocked: true, cause: 'changed', count: 1, detail: "The relay addressed the message to another session. pitwall's gate blocked it, so nothing was sent." });
    await wait(60);
    expect(allWritten(h)).toHaveLength(2);
  });

  it('gives each try its own request timer, so two tries and a restart can take longer than one timer', async () => {
    const h = harness({ requestTimeoutMs: 250, gateReadyMs: 2000 });
    h.behaviour = (request, child) => {
      if (h.children.length > 1) return child.relay(request);
      // The new relay's gate is slow to be ready: the restart outlasts the first try's timer.
      h.gate.loads = false;
      copies((t) => `${t}\n`)(request, child);
    };
    const started = Date.now();
    const result = h.relay.send(TARGET, 'hello');
    await eventually('the new relay', () => h.children.length === 2);
    // Each relay answers at once, so a timer can run out only in a stall right after a write, not in a slow turn (W56).
    // The new relay's gate, polled rather than timed, is ready only once the first try's timer would have run out.
    await eventually('the first try’s timer to have run out', () => Date.now() - started > 250 + 50);
    h.gate.ready.add(h.children[1]!.gateId);
    expect((await result).status).toBe('delivered');
    expect(h.runningAtStart).toEqual([0, 0]);
  });

  it('answers failed, as before, when the restart limit stops the relay starting again', async () => {
    const h = harness({ restart: { baseMs: 20, maxMs: 80, max: 1, windowMs: 60_000 } });
    h.behaviour = copies((t) => `${t}\n`);
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.status).toBe('failed');
    expect(result.detail).toBe(
      "pitwall's gate stopped the relay's copy of your message, because it didn't match, so nothing was sent. The relay changed the text before sending it, first at line 1: the copy adds a line break (U+000A). pitwall tried once more, and that wasn’t sent either: The relay stopped 1 times in 1 minutes, so pitwall stopped restarting it for now. Last: exit code 0",
    );
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.children).toHaveLength(1);
    expect(allWritten(h)).toHaveLength(1);
  });

  it('counts one restart toward the limit for a call that differs in more than its text, as before W43, never a second (W52)', async () => {
    // Room for the first start and three restarts. Two tries a message, as W43 made them, would run out in the second.
    const h = harness({ restart: { baseMs: 20, maxMs: 80, max: 4, windowMs: 60_000 } });
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: OTHER.name, message: request.text });
      child.result();
    };
    for (let i = 1; i <= 3; i++) {
      const result = await h.relay.send(TARGET, `message ${i}`);
      expect(result.detail).toMatch(/More than its text differed, so pitwall didn’t try again\.$/);
      // One restart, once its turn has ended: a relay for the next message, and no second try.
      await eventually(`the restart after message ${i}`, () => h.children.length === i + 1);
    }
    expect(allWritten(h)).toHaveLength(3);
    expect(h.relay.alert()).toMatchObject({ blocked: true, cause: 'changed', count: 3 });
    // The fourth start was the last the limit allows: that relay takes a fourth message, and then isn't restarted.
    expect((await h.relay.send(TARGET, 'message 4')).detail).toMatch(/didn’t try again\.$/);
    await eventually('the restart refused', () => h.logs.some((line) => line.startsWith("couldn't restart it: The relay stopped 4 times in 1 minutes")));
    expect(h.children).toHaveLength(4);
    expect(allWritten(h)).toHaveLength(4);
  });

  it('says both when the second try fails for another reason', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      copies((t) => `${t}\n`)(request, child);
      h.rows = [row(OTHER)];
    };
    expect((await h.relay.send(TARGET, 'hello')).detail).toBe(
      "pitwall's gate stopped the relay's copy of your message, because it didn't match, so nothing was sent. The relay changed the text before sending it, first at line 1: the copy adds a line break (U+000A). pitwall tried once more, and that wasn’t sent either: No running session is named pitwall-test-target now, so nothing was sent.",
    );
    expect(allWritten(h)).toHaveLength(1);
  });

  describe('never tries again', () => {
    /** Sends with `behaviour` on the first relay, then gives any second try the time to happen. */
    async function once(h: Harness, behaviour: Behaviour) {
      h.behaviour = (request, child) => (h.children.length === 1 ? behaviour(request, child) : child.relay(request));
      const result = await h.relay.send(TARGET, 'hello');
      await wait(60);
      expect(allWritten(h), 'one request written').toHaveLength(1);
      return result;
    }

    it('after a call that matched, whatever its result', async () => {
      const sent = harness();
      expect(await once(sent, (request, child) => child.relay(request))).toEqual({ status: 'delivered' });
      const notSent = harness();
      expect((await once(notSent, (request, child) => child.relay(request, { success: false, message: 'nope' }))).status).toBe('failed');
      const unknown = harness();
      expect(
        (
          await once(unknown, (request, child) => {
            child.init();
            const id = child.toolUse('SendMessage', { to: request.to, message: request.text });
            unknown.gate.check(child.gateId, { to: request.to, message: request.text });
            child.blocked(id, 'Not sent — too many messages');
            child.result();
          })
        ).status,
      ).toBe('uncertain');
      // A matching call the gate denied: here, because the expectation expired.
      const denied = harness();
      const result = await once(denied, (request, child) => {
        denied.gate.expectations.get(child.gateId)!.expiresAt = 0;
        child.relay(request);
      });
      expect(result.detail).toMatch(/has expired\. Nothing was sent\.$/);
    });

    it('after a changed call the gate didn’t stop, which may have been sent', async () => {
      const sent = harness();
      sent.gate.hookRuns = false;
      expect((await once(sent, copies((t) => `${t}\n`))).status).toBe('uncertain');
      expect(sent.relay.alert()).toMatchObject({ blocked: false, cause: 'changed', detail: expect.stringMatching(/first at line 1: the copy adds a line break \(U\+000A\)\. pitwall's gate didn't stop it\.$/) });
      expect(sent.relay.off()).toBeDefined();
      const notSent = harness();
      notSent.gate.hookRuns = false;
      const result = await once(notSent, (request, child) => {
        child.init();
        child.send({ to: request.to, message: `${request.text}\n` }, { success: false, message: 'nope' });
        child.result();
      });
      expect(result).toEqual({ status: 'failed', detail: 'nope' });
      expect(notSent.relay.alert()).toMatchObject({ blocked: false, cause: 'changed', detail: expect.stringMatching(/though SendMessage didn’t send it\.$/) });
    });

    it('after a changed call with a result pitwall doesn’t recognize', async () => {
      const h = harness();
      const result = await once(h, (request, child) => {
        child.init();
        const id = child.toolUse('SendMessage', { to: request.to, message: `${request.text}\n` });
        child.blocked(id, 'Not sent — too many messages');
        child.result();
      });
      expect(result.status).toBe('uncertain');
      expect(h.relay.alert()).toMatchObject({ blocked: false, cause: 'changed' });
    });

    it('after a changed call pitwall couldn’t confirm, which may have been sent', async () => {
      const h = harness();
      const result = await once(h, (request, child) => {
        child.init();
        child.send({ to: request.to, message: `${request.text}\n` }, SENT, true);
        child.exit(1);
      });
      expect(result.status).toBe('uncertain');
      expect(h.relay.alert()).toMatchObject({ blocked: false, cause: 'changed', detail: expect.stringMatching(/couldn't tell whether its gate stopped it\.$/) });
    });

    it('after a changed text pitwall stopped before it ran, which raises no alert and says where in the result', async () => {
      const h = harness();
      const result = await once(h, (request, child) => {
        child.init();
        child.toolUse('SendMessage', { to: request.to, message: `${request.text}\n` });
        child.exit(1);
      });
      expect(result).toEqual({
        status: 'failed',
        detail:
          'The relay stopped (exit code 1). The relay changed the text before sending it, first at line 1: the copy adds a line break (U+000A). pitwall stopped it before it ran, so nothing was sent.',
      });
      expect(h.relay.alert()).toBeUndefined();
      expect(h.logs).toContain('The relay changed the text before sending it, first at line 1: the copy adds a line break (U+000A). pitwall stopped the relay before it ran.');
      // Any text, not only spacing (W52).
      const words = harness();
      await once(words, (request, child) => {
        child.init();
        child.toolUse('SendMessage', { to: request.to, message: `${request.text}.` });
        child.exit(1);
      });
      expect(words.relay.alert()).toBeUndefined();
    });

    it('after a call to another session, which pitwall stopped before it ran, which raises a blocked alert (W52)', async () => {
      const h = harness();
      const result = await once(h, (request, child) => {
        child.init();
        child.toolUse('SendMessage', { to: OTHER.name, message: request.text });
        child.exit(1);
      });
      expect(result).toEqual({
        status: 'failed',
        detail: 'The relay stopped (exit code 1). The relay addressed the message to another session. pitwall stopped it before it ran, so nothing was sent.',
      });
      expect(h.relay.alert()).toMatchObject({
        blocked: true,
        cause: 'changed',
        detail: 'The relay addressed the message to another session. pitwall stopped the relay before it ran, so nothing was sent.',
      });
    });
  });
});

// W48's proof of concept (F3), made-up data: a first call that a peer could have caused. W43 tried each
// once more, with no alert, and answered delivered. Now (W52) one that differs in more than its text
// raises a blocked alert and isn't tried again. One whose text alone differs is still tried once more,
// with no alert, as the relay's model does that in long copies, and the result says so.
describe('the relay: a blocked call for your message (W52, W48’s F3)', () => {
  const firstCall = (input: (request: Request) => Record<string, unknown>) => (request: Request, child: FakeChild) => {
    if (child !== h0.children[0]) return child.relay(request);
    child.init();
    child.send(input(request));
    child.text('done');
    child.result();
  };
  let h0: Harness;

  describe('more than its text differs: an alert, and no second try', () => {
    const cases: [string, (request: Request) => Record<string, unknown>, string][] = [
      ['addressed to another session', (request) => ({ to: OTHER.name, message: request.text }), 'The relay addressed the message to another session.'],
      ['asking to be told when the target goes idle', (request) => ({ to: request.to, message: request.text, notify_when_idle: true }), 'The relay asked to be told when the session goes idle.'],
      ['with a field the gate doesn’t know', (request) => ({ to: request.to, message: request.text, made_up_field: 'x' }), "The relay's SendMessage call had a field pitwall doesn't check."],
      ['with a changed text, and asking for idle notices', (request) => ({ to: request.to, message: `${request.text}\n`, notify_when_idle: true }), 'The relay asked to be told when the session goes idle.'],
      ['with other words, and another session', () => ({ to: OTHER.name, message: 'A made-up instruction the user never wrote.' }), 'The relay addressed the message to another session.'],
    ];
    for (const [name, input, reason] of cases) {
      it(`W48: a first call ${name} is blocked, raises a blocked alert, and isn’t tried again`, async () => {
        h0 = harness();
        h0.behaviour = firstCall(input);
        const result = await h0.relay.send(TARGET, 'A made-up note.');
        expect(result).toEqual({
          status: 'failed',
          detail: `pitwall's gate stopped the relay's copy of your message, because it didn't match, so nothing was sent. ${reason} More than its text differed, so pitwall didn’t try again.`,
        });
        expect(h0.relay.alert()).toMatchObject({ blocked: true, cause: 'changed', count: 1, detail: `${reason} pitwall's gate blocked it, so nothing was sent.` });
        expect(h0.relay.off()).toBeUndefined();
        expect(h0.relay.exchange(TARGET.sessionId)).toBeUndefined();
        await wait(60);
        // Restarted once its turn ended, as before W43, and nothing more written.
        expect(h0.children[0]!.signals).toEqual(['SIGTERM']);
        expect(allWritten(h0)).toHaveLength(1);
        expect(`${h0.logs.join('\n')}\n${result.detail}\n${h0.relay.alert()?.detail}`).not.toMatch(/made-up|note|instruction/i);
      });
    }
  });

  describe('only its text differs: no alert, and one more try', () => {
    const cases: [string, (request: Request) => Record<string, unknown>, string][] = [
      ['with a different text entirely', () => ({ to: TARGET.name, message: 'A made-up instruction the user never wrote.' }), 'line 1: the copy differs from here, with U+0069 in place of U+006E'],
      // W43's own cases: slips a model makes when it copies.
      ['with an accent dropped', (request) => ({ to: request.to, message: request.text.replace('ć', 'c') }), 'line 1: U+0107 became U+0063'],
      ['with a full stop added', (request) => ({ to: request.to, message: `${request.text}.` }), 'line 1: the copy adds U+002E'],
      ['with an exclamation mark added', (request) => ({ to: request.to, message: `${request.text}!` }), 'line 1: the copy adds U+0021'],
      ['with 10 characters added', (request) => ({ to: request.to, message: `${request.text} (relayed)` }), 'line 1: the copy has 10 more characters from here'],
      ['with a word added', (request) => ({ to: request.to, message: request.text.replace('note', 'urgent note') }), 'line 1: the copy has 7 more characters from here'],
      ['with tag characters', (request) => ({ to: request.to, message: `${request.text}\u{e0052}\u{e0055}\u{e004e}` }), 'line 1: the copy has 3 more characters from here'],
      ['with a zero-width joiner the text doesn’t have', (request) => ({ to: request.to, message: request.text.replace('up', 'u‍p') }), 'line 1: the copy adds a zero-width joiner (U+200D)'],
    ];
    for (const [name, input, where] of cases) {
      it(`W48: a first call ${name} is blocked, raises no alert, and the second copy goes`, async () => {
        h0 = harness();
        h0.behaviour = firstCall(input);
        const result = await h0.relay.send(TARGET, 'A made-up note about krać.');
        const reason = `The relay changed the text before sending it, first at ${where}.`;
        expect(result).toEqual({ status: 'delivered', detail: `${RETRIED}${lowerFirst(reason)}` });
        expect(h0.relay.alert()).toBeUndefined();
        expect(h0.relay.off()).toBeUndefined();
        expect(h0.relay.exchange(TARGET.sessionId)?.status).toBe('delivered');
        // One more try, on a new relay, with the same text, as W43 does it.
        expect(h0.children[0]!.signals).toEqual(['SIGTERM']);
        const written = allWritten(h0);
        expect(written).toHaveLength(2);
        expect(written[1]!.text).toBe(written[0]!.text);
        expect(h0.logs).toContain(`${reason} pitwall's gate blocked it, so nothing was sent. pitwall will try once more, on a new relay.`);
        expect(`${h0.logs.join('\n')}\n${result.detail}`).not.toMatch(/made-up|note|instruction|kra/i);
      });
    }

    it('W52’s live check: a long copy that dropped 447 characters is tried once more, with no alert, and goes', async () => {
      // About 6,000 made-up characters on 74 lines, as in the live check, and a first copy missing 447 of them from line 34.
      const long = Array.from({ length: 74 }, (_, i) => `Line ${String(i + 1).padStart(2, '0')} of a made-up note about the export job, and its retries.`.padEnd(80, '.')).join('\n');
      const at = long.split('\n').slice(0, 33).join('\n').length + 1 + 10;
      const h = harness();
      h.behaviour = (request, child) => (h.children.length === 1 ? copies((t) => t.slice(0, at) + t.slice(at + 447))(request, child) : child.relay(request));
      const result = await h.relay.send(TARGET, long);
      expect(result).toEqual({
        status: 'delivered',
        detail: `${RETRIED}the relay changed the text before sending it, first at line 34: the copy is missing 447 characters from here, including 5 line breaks.`,
      });
      expect(h.relay.alert()).toBeUndefined();
      expect(allWritten(h)).toHaveLength(2);
    });

    it('answers failed when the second copy is changed too, says where each first differed, and raises no alert', async () => {
      const h = harness();
      h.behaviour = copies((t) => `${t} (relayed)`);
      expect(await h.relay.send(TARGET, 'secret plan')).toEqual({
        status: 'failed',
        detail:
          "pitwall's gate stopped the relay's copy of your message twice, because it didn't match, so nothing was sent. Both times, the relay changed the text before sending it, first at line 1: the copy has 10 more characters from here.",
      });
      expect(h.relay.alert()).toBeUndefined();
      await wait(60);
      expect(allWritten(h)).toHaveLength(2);
      expect(h.relay.exchange(TARGET.sessionId)).toBeUndefined();
      expect(h.logs.join('\n')).not.toContain('secret');
    });

    it('counts one restart for the first copy, as W43 did, and one for a second the gate blocks too', async () => {
      // Room for the first start and two restarts: one message blocked twice uses both.
      const h = harness({ restart: { baseMs: 20, maxMs: 80, max: 3, windowMs: 60_000 } });
      h.behaviour = copies((t) => `${t}.`);
      expect((await h.relay.send(TARGET, 'hello')).status).toBe('failed');
      await eventually('the restart after the second copy', () => h.children.length === 3);
      expect(allWritten(h)).toHaveLength(2);
    });
  });
});

describe('the relay: a repeat after a denial (W52, W48’s F8)', () => {
  const REPEATED = 'The relay tried again to send one of your messages, in the same turn, after pitwall’s gate had blocked its copy.';

  it('calls a send the relay repeats after the gate blocked a changed text a repeat, never another session’s, and still delivers the second try', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      if (h.children.length > 1) return child.relay(request);
      child.init();
      child.send({ to: request.to, message: `${request.text}\n` });
      child.send({ to: request.to, message: `${request.text}\n` });
      child.result();
    };
    expect((await h.relay.send(TARGET, 'hello')).status).toBe('delivered');
    expect(h.relay.alert()).toMatchObject({ blocked: true, cause: 'repeated', count: 1, detail: `${REPEATED} pitwall's gate blocked it, so nothing was sent.` });
  });

  it('calls one after a call to another session a repeat, after that call’s own alert', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: OTHER.name, message: request.text });
      child.send({ to: OTHER.name, message: request.text });
      child.result();
    };
    expect((await h.relay.send(TARGET, 'hello')).status).toBe('failed');
    await eventually('the repeat’s alert', () => h.relay.alert()?.count === 2);
    expect(h.relay.alert()).toMatchObject({ blocked: true, cause: 'repeated', detail: `${REPEATED} pitwall's gate blocked it, so nothing was sent.` });
  });

  it('calls one after a matching call the gate denied a repeat, though that request has its answer', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      h.gate.expectations.get(child.gateId)!.expiresAt = 0;
      child.init();
      child.send({ to: request.to, message: request.text });
      child.send({ to: request.to, message: request.text });
      child.result();
    };
    expect((await h.relay.send(TARGET, 'hello')).detail).toMatch(/has expired\. Nothing was sent\.$/);
    await eventually('the repeat’s alert', () => h.relay.alert() !== undefined);
    expect(h.relay.alert()).toMatchObject({ blocked: true, cause: 'repeated', count: 1 });
  });

  it('calls a second call in the same message a repeat once the first one’s denial arrives, whatever order the results come in', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      if (h.children.length > 1) return child.relay(request);
      child.init();
      const input = { to: request.to, message: `${request.text}\n` };
      // Both calls in one assistant message, then the gate's decisions and their results.
      child.emit({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_a', name: 'SendMessage', input },
            { type: 'tool_use', id: 'toolu_b', name: 'SendMessage', input },
          ],
        },
      });
      child.denied('toolu_a', child.gate.check(child.gateId, input).reason);
      child.denied('toolu_b', child.gate.check(child.gateId, input).reason);
      child.result();
    };
    expect((await h.relay.send(TARGET, 'hello')).status).toBe('delivered');
    expect(h.relay.alert()).toMatchObject({ blocked: true, cause: 'repeated', count: 1 });
  });

  it('calls a repeat whose result never came a repeat too, which may have been sent', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      h.gate.expectations.get(child.gateId)!.expiresAt = 0;
      child.init();
      child.send({ to: request.to, message: request.text });
      child.toolUse('SendMessage', { to: request.to, message: request.text });
      child.result();
    };
    await h.relay.send(TARGET, 'hello');
    await eventually('the alert', () => h.relay.alert() !== undefined);
    expect(h.relay.alert()).toMatchObject({ blocked: false, cause: 'repeated', detail: `${REPEATED} Its turn ended before pitwall saw whether its gate blocked it.` });
  });

  it('only in the same turn: a call in a later turn is one nobody asked for', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      h.gate.expectations.get(child.gateId)!.expiresAt = 0;
      child.relay(request);
    };
    await h.relay.send(TARGET, 'hello');
    h.child().peerTurn();
    await eventually('the alert', () => h.relay.alert() !== undefined);
    expect(h.relay.alert()).toMatchObject({ blocked: true, cause: 'unrequested', detail: expect.stringMatching(/^The relay tried to send a message when pitwall hadn’t asked it to\./) });
  });
});

describe('the relay: uncertain, never failed, once a call may have run', () => {
  it('answers uncertain when the relay stops after the gate allowed the call, before its result', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: request.to, message: request.text }, SENT, true);
      child.exit(1);
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.status).toBe('uncertain');
    expect(result.detail).toMatch(/^The relay stopped \(exit code 1\)\. It may have reached the session/);
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('uncertain');
  });

  it('answers failed when the relay stops before its call reached the gate', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.toolUse('SendMessage', { to: request.to, message: request.text });
      child.exit(1);
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result).toEqual({ status: 'failed', detail: 'The relay stopped (exit code 1). Nothing was sent.' });
    expect(h.relay.exchange(TARGET.sessionId)).toBeUndefined();
  });

  it('answers uncertain when a request times out after the gate allowed its call', async () => {
    const h = harness({ requestTimeoutMs: 400 });
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: request.to, message: request.text }, SENT, true);
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.status).toBe('uncertain');
    expect(result.detail).toMatch(/didn't finish within 0s\. pitwall restarted the relay\. It may have reached the session/);
  });
});

describe('the relay: the exchange it records', () => {
  it('keeps a delivered exchange, and its reply, when a later message fails before anything was sent', async () => {
    const h = harness();
    await expect(h.relay.send(TARGET, 'first')).resolves.toEqual({ status: 'delivered' });
    const delivered = h.relay.exchange(TARGET.sessionId);
    h.rows = [row(OTHER)];
    expect((await h.relay.send(TARGET, 'second')).status).toBe('failed');
    expect(h.relay.exchange(TARGET.sessionId)).toEqual(delivered);
    // A late reply to the first still finds it, by its msg_id and the target's pid.
    h.events.push({ kind: 'peer', pid: TARGET.pid, body: 'done', at: new Date(Date.now() + 1000).toISOString() });
    h.child().result();
    await wait(10);
    expect(h.relay.exchange(TARGET.sessionId)?.reply?.text).toBe('done');
  });

  it('records nothing for a message the gate denied', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'first');
    h.behaviour = (request, child) => {
      h.gate.expectations.get(child.gateId)!.expiresAt = 0;
      child.relay(request);
    };
    expect((await h.relay.send(TARGET, 'second')).status).toBe('failed');
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('delivered');
  });
});

describe('the relay: one at a time', () => {
  it('writes the next request only after the one before has its answer', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    h.behaviour = (request, child) => {
      child.init();
      const { finish } = child.send({ to: request.to, message: request.text }, SENT, true);
      release = () => {
        finish();
        child.text(`relayed ${request.id}`);
        child.result();
      };
    };
    const first = h.relay.send(TARGET, 'one');
    const second = h.relay.send(OTHER, 'two');
    await wait(20);
    expect(h.child().written).toHaveLength(1);
    release!();
    await expect(first).resolves.toEqual({ status: 'delivered' });
    await wait(20);
    expect(h.child().written).toHaveLength(2);
    expect(parseRequest(h.child().written[1]!).text).toBe('two');
    release!();
    await expect(second).resolves.toEqual({ status: 'delivered' });
  });

  it('waits while the relay is in a turn of its own, such as one a reply started', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'one');
    const child = h.child();
    child.init();
    const next = h.relay.send(OTHER, 'two');
    await wait(20);
    expect(child.written).toHaveLength(1);
    child.text('noted');
    child.result();
    await expect(next).resolves.toEqual({ status: 'delivered' });
    expect(child.written).toHaveLength(2);
  });

  it('answers busy, with a wait, beyond the queue', async () => {
    const h = harness({ maxQueue: 1 });
    h.behaviour = () => undefined;
    const pending = [h.relay.send(TARGET, 'one'), h.relay.send(TARGET, 'two')];
    await wait(5);
    await expect(h.relay.send(TARGET, 'three')).resolves.toEqual({
      status: 'failed',
      detail: 'The relay is busy with other messages. Try again in a moment.',
      retryAfterSeconds: 5,
    });
    await h.relay.close();
    await Promise.all(pending);
  });

  it('writes a request once more when the relay’s turn ended without acting on it, then gives up', async () => {
    const h = harness();
    h.behaviour = (_request, child) => {
      child.init();
      child.text('noted');
      child.result();
    };
    const result = await h.relay.send(TARGET, 'hello');
    expect(result).toEqual({ status: 'failed', detail: "The relay didn't act on the message, so nothing was sent." });
    expect(h.child().written).toHaveLength(2);
    expect(h.child().written[1]).toBe(h.child().written[0]);
    expect(h.gate.written).toHaveLength(2);
  });

  it('restarts the relay when a request takes too long', async () => {
    const h = harness({ requestTimeoutMs: 400 });
    h.behaviour = (_request, child) => child.init();
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.detail).toBe("The relay didn't finish within 0s. pitwall restarted the relay. Nothing was sent.");
    expect(h.children[0]!.signals).toEqual(['SIGTERM']);
  });
});

describe('the relay: replies', () => {
  it('attaches a reply whose verified pid is the target’s, as plain text', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    h.events.push({ kind: 'peer', pid: TARGET.pid, name: 'pitwall-test-target', body: '\u001b[31mdone\u001b[0m, tests pass', at: new Date(Date.now() + 1000).toISOString() });
    h.child().result();
    await wait(10);
    expect(h.relay.exchange(TARGET.sessionId)?.reply?.text).toBe('done, tests pass');
  });

  it('ignores a reply from another pid, even with the target’s name, and one from before the message', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    h.events.push({ kind: 'peer', pid: 9999, name: 'pitwall-test-target', body: 'not me', at: new Date(Date.now() + 1000).toISOString() });
    h.events.push({ kind: 'peer', name: 'pitwall-test-target', body: 'no pid' });
    h.events.push({ kind: 'peer', pid: TARGET.pid, body: 'too early', at: '2020-01-01T00:00:00.000Z' });
    h.child().result();
    await wait(10);
    expect(h.relay.exchange(TARGET.sessionId)?.reply).toBeUndefined();
  });

  it('doesn’t attach a reply to a message that wasn’t sent', async () => {
    const h = harness();
    h.behaviour = (request, child) => child.relay(request, { success: false, message: 'nope' });
    await h.relay.send(TARGET, 'hello');
    h.events.push({ kind: 'peer', pid: TARGET.pid, body: 'hi' });
    h.child().result();
    await wait(10);
    expect(h.relay.exchange(TARGET.sessionId)?.reply).toBeUndefined();
  });
});

describe('the relay: its process', () => {
  it('fails the request in flight when the relay stops, and starts it again after a backoff', async () => {
    const h = harness();
    h.behaviour = (_request, child) => {
      child.init();
      child.events.stderr('Error: something broke\n');
      child.exit(1);
    };
    expect((await h.relay.send(TARGET, 'hello')).detail).toBe('The relay stopped (exit code 1: Error: something broke). Nothing was sent.');
    expect(h.children).toHaveLength(1);
    await eventually('the relay to start again', () => h.children.length === 2);
    expect(h.logs.some((line) => line.includes('it stopped (exit code 1'))).toBe(true);
  });

  it('still answers delivered when the relay stops after SendMessage succeeded', async () => {
    const h = harness({ noticeGraceMs: 200, noticePollMs: 20 });
    h.behaviour = (request, child) => {
      child.init();
      child.send({ to: request.to, message: request.text });
      setTimeout(() => child.exit(1), 30);
    };
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'delivered' });
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('delivered');
    expect(h.relay.alert()).toBeUndefined();
  });

  it('stops restarting after too many starts, and says so', async () => {
    const h = harness();
    h.behaviour = (_request, child) => child.exit(1);
    for (let i = 0; i < 4; i++) {
      await h.relay.send(TARGET, 'hello');
      // After each of the first three, the restart timer starts the next relay. After the fourth, it can't.
      if (i < 3) await eventually(`restart ${i + 1}`, () => h.children.length === i + 2);
    }
    await eventually('the restart to be refused', () => h.logs.some((line) => line.startsWith("couldn't restart it")));
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/stopped 4 times in 1 minutes, so pitwall stopped restarting it for now/);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('closes stdin on close(), then signals only its own process if it doesn’t go', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    const child = h.child();
    child.exitOnEnd = false;
    child.kill = (signal) => {
      child.signals.push(signal);
      if (signal === 'SIGKILL') child.exit(null, signal);
    };
    await h.relay.close();
    expect(child.ended).toBe(true);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('fails what’s waiting on close(), and everything after', async () => {
    const h = harness();
    h.behaviour = () => undefined;
    const pending = h.relay.send(TARGET, 'hello');
    await wait(20);
    await h.relay.close();
    expect(h.child().ended).toBe(true);
    expect(h.child().signals).toEqual([]);
    await expect(pending).resolves.toEqual({ status: 'failed', detail: 'pitwall is shutting down. Nothing was sent.' });
    await expect(h.relay.send(TARGET, 'later')).resolves.toEqual({ status: 'failed', detail: 'pitwall is shutting down.' });
    await wait(50);
    expect(h.children).toHaveLength(1);
    expect(h.gate.expectations.size).toBe(0);
    expect(h.gate.ready.size).toBe(0);
  });

  it('knows its own session by pid, session id and directory, never by name alone', async () => {
    const h = harness();
    expect(h.relay.isRelay({ sessionId: 'x', cwd: DIR })).toBe(true);
    expect(h.relay.isRelay({ sessionId: 'x', cwd: `${DIR}/` })).toBe(true);
    await h.relay.send(TARGET, 'hello');
    expect(h.relay.isRelay({ sessionId: 'x', pid: h.child().pid, cwd: '/elsewhere' })).toBe(true);
    expect(h.relay.isRelay({ sessionId: RELAY_SESSION, cwd: '/elsewhere' })).toBe(true);
    expect(h.relay.isRelay({ sessionId: TARGET.sessionId, pid: TARGET.pid, cwd: TARGET.cwd })).toBe(false);
  });

  it('forgets a pid once its process has gone, so a reused pid isn’t hidden', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    const { pid } = h.child();
    await h.relay.close();
    expect(h.relay.isRelay({ sessionId: 'x', pid, cwd: '/elsewhere' })).toBe(false);
  });
});

describe('replyText', () => {
  it('keeps text, tabs and newlines, and removes escapes and other controls', () => {
    expect(replyText('  one\r\ntwo\tthree\u0007\u001b]0;title\u0007 ')).toBe('one\ntwo\tthree');
  });

  it('keeps at most 2 KiB of UTF-8, without splitting a character', () => {
    const text = replyText('é'.repeat(5000));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(REPLY_MAX_BYTES);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toContain('�');
  });
});

vi.setConfig({ testTimeout: 5000 });
