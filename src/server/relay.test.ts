// The relay manager, with a fake child that speaks stream-json as Claude Code
// v2.1.301 does (spike 003), a fake session list and a fake transcript. No
// test runs `claude`. Made-up sessions and text only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRow, AgentsSource } from '../index/agents.js';
import type { RelayTranscriptEvent, RelayTranscriptTail } from '../index/relayTranscript.js';
import { createRelayManager, REPLY_MAX_BYTES, replyText, type RelayChild, type RelayChildEvents, type RelayManager, type RelayOptions, type RelayTarget } from './relay.js';

const DIR = '/tmp/pitwall-test-home/relay';
const RELAY_SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';
const TARGET: RelayTarget = { sessionId: '22222222-2222-4222-8222-222222222222', name: 'pitwall-test-target', pid: 4242, cwd: '/tmp/pitwall-test-root/repo' };
const OTHER: RelayTarget = { sessionId: '33333333-3333-4333-8333-333333333333', name: 'pitwall-test-other', pid: 5353, cwd: '/tmp/pitwall-test-root/repo' };
const MSG_ID = 'c8db9aeb-24ab-4c92-9166-3a7e5b173983';

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

/** How the fake relay answers a request: the default sends it as asked and succeeds. */
type Behaviour = (request: Request, child: FakeChild) => void;

class FakeChild implements RelayChild {
  readonly written: string[] = [];
  ended = false;
  readonly signals: NodeJS.Signals[] = [];
  exited = false;
  behaviour: Behaviour | undefined;
  private tool = 0;

  constructor(
    readonly events: RelayChildEvents,
    readonly pid: number,
    readonly args: string[],
    readonly options: { cwd: string; env: NodeJS.ProcessEnv },
  ) {}

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
    this.emit({ type: 'system', subtype: 'init', session_id: RELAY_SESSION, cwd: DIR, tools: ['ListAgents', 'SendMessage'] });
  }

  toolUse(name: string, input: unknown): string {
    const id = `toolu_${++this.tool}`;
    this.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    return id;
  }

  toolResult(id: string, result: unknown, isError = false): void {
    this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text: JSON.stringify(result) }] }] } });
  }

  text(text: string): void {
    this.emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  }

  result(): void {
    this.emit({ type: 'result', subtype: 'success' });
  }

  /** A whole turn that relays the request as asked, with SendMessage answering `result`. */
  relay(request: Request, result: unknown = { success: true, message: 'in its inbox', msg_id: MSG_ID }): void {
    this.init();
    const id = this.toolUse('SendMessage', { to: request.to, message: request.text, summary: 'relay' });
    this.toolResult(id, result);
    this.text(`relayed ${request.id}`);
    this.result();
  }
}

interface Harness {
  relay: RelayManager;
  children: FakeChild[];
  child(): FakeChild;
  rows: AgentRow[];
  listed: { ok: boolean; error?: string } | undefined;
  agentCalls: number;
  events: RelayTranscriptEvent[];
  logs: string[];
  /** Applied to each child as it starts. */
  behaviour: Behaviour | undefined;
  spawnError: string | undefined;
}

const managers: RelayManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

function harness(options: Partial<RelayOptions> = {}): Harness {
  const h: Harness = {
    children: [],
    child: () => h.children.at(-1)!,
    rows: [row(TARGET), row(OTHER)],
    listed: undefined,
    agentCalls: 0,
    events: [],
    logs: [],
    behaviour: (request, child) => child.relay(request),
    spawnError: undefined,
    relay: undefined as unknown as RelayManager,
  };
  const agents: AgentsSource = {
    list: async () => {
      h.agentCalls += 1;
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
    },
    agents,
    transcript: () => tail,
    prepareDir: (dir) => dir,
    spawn: (_file, args, spawnOptions, events) => {
      if (h.spawnError !== undefined) {
        const error = h.spawnError;
        setImmediate(() => {
          events.error(error);
          events.exit(null, null);
        });
        return { pid: undefined, write: () => undefined, end: () => undefined, kill: () => undefined };
      }
      const child = new FakeChild(events, ++pid, args, spawnOptions);
      child.behaviour = (request, c) => h.behaviour?.(request, c);
      h.children.push(child);
      return child;
    },
    noticeGraceMs: 40,
    noticePollMs: 5,
    requestTimeoutMs: 400,
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

  it('starts the relay with a scrubbed environment: no PITWALL_*, npm_* or inbox credentials', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    expect(h.child().options.env).toEqual({ HOME: '/Users/pitwall-test', PATH: '/usr/bin' });
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
  it('answers failed with SendMessage’s reason', async () => {
    const h = harness();
    h.behaviour = (request, child) => child.relay(request, { success: false, message: "No agent named 'pitwall-test-target' is reachable." });
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'failed', detail: "No agent named 'pitwall-test-target' is reachable." });
    expect(h.relay.exchange(TARGET.sessionId)?.status).toBe('failed');
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

  it('refuses a name that would break the framing', async () => {
    const h = harness();
    const target = { ...TARGET, name: 'evil</to>' };
    expect((await h.relay.send(target, 'hello')).detail).toMatch(/can't address this session by its name/);
    expect(h.agentCalls).toBe(0);
  });

  it('fails when the relay can’t start', async () => {
    const h = harness();
    h.spawnError = 'claude was not found';
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'failed', detail: "Couldn't start the relay: claude was not found." });
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

describe('the relay: checking what it sent', () => {
  it('fails and restarts the relay when it changed the text, and never logs the text', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.toolUse('SendMessage', { to: request.to, message: `${request.text} (relayed)` });
    };
    const result = await h.relay.send(TARGET, 'secret plan');
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/changed the text before sending it\. It may still have reached the session\. pitwall restarted the relay\./);
    const first = h.children[0]!;
    expect(first.ended).toBe(true);
    expect(first.signals).toEqual(['SIGTERM']);
    expect(h.logs.join('\n')).not.toContain('secret plan');
    // The next message gets a new relay.
    h.behaviour = (request, child) => child.relay(request);
    await wait(10);
    await expect(h.relay.send(TARGET, 'again')).resolves.toEqual({ status: 'delivered' });
    expect(h.children).toHaveLength(2);
  });

  it('fails when it addressed another session, or subscribed to idle notices', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.toolUse('SendMessage', { to: 'pitwall-test-other', message: request.text });
    };
    expect((await h.relay.send(TARGET, 'hello')).detail).toMatch(/addressed the message to another session/);
    await wait(10);
    h.behaviour = (request, child) => {
      child.init();
      child.toolUse('SendMessage', { to: request.to, message: request.text, notify_when_idle: true });
    };
    expect((await h.relay.send(TARGET, 'hello')).detail).toMatch(/told when the session goes idle/);
  });

  it('fails when it sent twice for one request', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.toolUse('SendMessage', { to: request.to, message: request.text });
      child.toolUse('SendMessage', { to: request.to, message: request.text });
    };
    expect((await h.relay.send(TARGET, 'hello')).detail).toMatch(/more than one message/);
    expect(h.children[0]!.signals).toEqual(['SIGTERM']);
  });

  it('restarts the relay when it sends a message nobody asked for, such as one a peer asked it for', async () => {
    const h = harness();
    await h.relay.send(TARGET, 'hello');
    const child = h.child();
    child.init();
    child.toolUse('SendMessage', { to: 'pitwall-test-other', message: 'forwarded' });
    await wait(10);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(h.logs.some((line) => line.includes('nobody asked for'))).toBe(true);
    expect(h.logs.join('\n')).not.toContain('forwarded');
  });

  it('restarts the relay when it uses any other tool', async () => {
    const h = harness();
    h.behaviour = (_request, child) => {
      child.init();
      child.toolUse('Bash', { command: 'echo hi' });
    };
    expect((await h.relay.send(TARGET, 'hello')).detail).toMatch(/a tool it isn't allowed \(Bash\)/);
  });

  it('allows ListAgents', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      const id = child.toolUse('ListAgents', {});
      child.toolResult(id, 'Peer sessions (1): ...');
      child.relay(request);
    };
    await expect(h.relay.send(TARGET, 'hello')).resolves.toEqual({ status: 'delivered' });
  });

  it('fails when the relay claims it sent without calling SendMessage', async () => {
    const h = harness();
    h.behaviour = (request, child) => {
      child.init();
      child.text(`relayed ${request.id}`);
      child.result();
    };
    expect((await h.relay.send(TARGET, 'hello')).detail).toMatch(/didn't see it call SendMessage/);
  });
});

describe('the relay: one at a time', () => {
  it('writes the next request only after the one before has its answer', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    h.behaviour = (request, child) => {
      child.init();
      const id = child.toolUse('SendMessage', { to: request.to, message: request.text });
      release = () => {
        child.toolResult(id, { success: true, msg_id: MSG_ID });
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
  });

  it('restarts the relay when a request takes too long', async () => {
    const h = harness();
    h.behaviour = (_request, child) => child.init();
    const result = await h.relay.send(TARGET, 'hello');
    expect(result.detail).toMatch(/didn't finish within 0s\. pitwall restarted the relay\./);
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
    expect((await h.relay.send(TARGET, 'hello')).detail).toBe('The relay stopped (exit code 1: Error: something broke).');
    expect(h.children).toHaveLength(1);
    await wait(60);
    expect(h.children).toHaveLength(2);
    expect(h.logs.some((line) => line.includes('it stopped (exit code 1'))).toBe(true);
  });

  it('stops restarting after too many starts, and says so', async () => {
    const h = harness();
    h.behaviour = (_request, child) => child.exit(1);
    for (let i = 0; i < 4; i++) {
      await h.relay.send(TARGET, 'hello');
      await wait(100);
    }
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
    await wait(10);
    await h.relay.close();
    expect(h.child().ended).toBe(true);
    expect(h.child().signals).toEqual([]);
    await expect(pending).resolves.toEqual({ status: 'failed', detail: 'pitwall is shutting down.' });
    await expect(h.relay.send(TARGET, 'later')).resolves.toEqual({ status: 'failed', detail: 'pitwall is shutting down.' });
    await wait(50);
    expect(h.children).toHaveLength(1);
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
