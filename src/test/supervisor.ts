// A stand-in supervisor for server tests (M5, W113): it runs nothing, records what it's asked, and
// answers as the test sets it. Test-only: tsconfig.build.json leaves src/test/ out of the build.
import type { ConversationPage, SupervisorState } from '../shared/protocol.js';
import { createApprovalQueue, type ApprovalQueue } from '../supervisor/approvals.js';
import type { InterruptOutcome, Supervisor, SupervisorOutcome } from '../supervisor/supervisor.js';

export interface FakeSupervisor extends Supervisor {
  /** What send() was given, in order. */
  readonly sent: string[];
  /** How many times start() was called. */
  starts: number;
  /** The MCP URL bind() was given. */
  boundUrl?: string;
  /** What start() and send() answer. */
  outcome: SupervisorOutcome;
  interruptOutcome: InterruptOutcome;
  interrupts: number;
  /** What mcpToken() answers: undefined as while no process runs. */
  token: string | undefined;
  /** What conversation() answers, by `before`. */
  pages: Map<string | undefined, ConversationPage>;
  closed: boolean;
  /** Its approvals: a real queue, whose cards state() carries (W115). */
  queue: ApprovalQueue;
  /** What setRecipients() was last given. */
  recipients: readonly string[];
  /** Changes state(), and tells subscribers. */
  set(state: SupervisorState): void;
}

export function fakeSupervisor(token?: string, queue: ApprovalQueue = createApprovalQueue()): FakeSupervisor {
  let current: SupervisorState = { status: 'off', approvals: [] };
  let changes = 0;
  const listeners = new Set<() => void>();
  const fake: FakeSupervisor = {
    sent: [],
    starts: 0,
    outcome: { kind: 'ok' },
    interruptOutcome: { kind: 'ok' },
    interrupts: 0,
    token,
    pages: new Map(),
    closed: false,
    queue,
    recipients: [],
    state: () => ({ ...current, approvals: queue.list() }),
    bind(options) {
      fake.boundUrl = options.mcpUrl;
    },
    async start() {
      fake.starts++;
      return fake.outcome;
    },
    async send(text) {
      fake.sent.push(text);
      return fake.outcome;
    },
    interrupt() {
      fake.interrupts++;
      return fake.interruptOutcome;
    },
    mcpToken: () => fake.token,
    ownSessionIds: () => new Set(),
    isOwn: () => false,
    async conversation(before) {
      return fake.pages.get(before);
    },
    stats: () => ({ starts: fake.starts, turns: 0, toolCalls: {} }),
    approvals: () => queue,
    setRecipients(names) {
      fake.recipients = [...names];
    },
    version: () => changes + queue.version(),
    subscribe(listener) {
      listeners.add(listener);
      const off = queue.subscribe(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
    async close() {
      fake.closed = true;
    },
    set(state) {
      current = state;
      changes++;
      for (const listener of [...listeners]) listener();
    },
  };
  return fake;
}
