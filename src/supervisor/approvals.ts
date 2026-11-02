// The supervisor's approvals (M5, W115; spike 009, finding 6 and its recommendation): what it wants
// to do that waits on your click, in memory only. Claude Code asks pitwall's permission prompt tool,
// mcp__pitwall__approve, before each SendMessage and spawn_session call (src/server/supervisorActions.ts
// checks it and adds a card here); the call waits until you decide, the card runs out, the request
// goes away or pitwall closes. Every way out but your Send or Edit is a denial.
//
//   add()      a card, SupervisorApproval, with the answer Claude Code is waiting for
//   begin()    a decision starts: the card is held while pitwall checks it again, so a second
//              decision can't run beside it; end() lets it go when the check refused it
//   settle()   the answer, once: allow with the input to run, or deny with what the supervisor reads
//   expiry     SUPERVISOR_APPROVAL_TIMEOUT_MS after it was added: denied, saying you didn't answer
//   abort      the request's signal (the call was cancelled, or its connection closed): withdrawn
//   cancelAll  the supervisor stopped, or pitwall is closing: every card denied
//
// Two more things live here, both for one call or one message:
//
//   passes     a spawn_session call runs only with exactly the input an approval just allowed: each
//              allow adds one pass, keyed on that input in canonical JSON (the directory's real path,
//              the name, the prompt), each call takes one, and a pass lasts PASS_MS. When the call
//              carries Claude Code's tool_use_id, it must be the approval's too (grantPass(), takePass())
//   notes      after an Edit, what was actually sent, for pitwall to put before your next message to
//              the supervisor, so it isn't left believing its own text went (note(), takeNotes())
//
// Nothing here is written to disk: approvals, passes and notes go when pitwall does.
import { randomBytes } from 'node:crypto';
import { SUPERVISOR_APPROVAL_TIMEOUT_MS, SUPERVISOR_HANDOFFS_MAX, type SupervisorApproval, type SupervisorHandoff } from '../shared/protocol.js';

/** The permission prompt tool's answer, as Claude Code documents it for `--permission-prompt-tool`. */
export type PermissionAnswer = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

/** What a card shows, before it has an id and times. */
export type ApprovalDraft = { kind: 'message'; to: string; text: string } | { kind: 'spawn'; directory: string; name?: string; prompt: string };

/** One card waiting, with the call it's for. */
export interface PendingApproval {
  approval: SupervisorApproval;
  /** As Claude Code named it: `SendMessage` or `mcp__pitwall__spawn_session`. */
  toolName: string;
  toolUseId: string;
  /** The call's input as Claude Code gave it, which Send allows as it is. */
  input: Record<string, unknown>;
}

/** The most cards waiting at once; one more is denied at once. */
export const MAX_PENDING_APPROVALS = 10;

/** How long a spawn_session call has, after its approval allowed it, to run. */
export const PASS_MS = 60_000;

/** The most notes kept for the next message. */
const MAX_NOTES = 5;

/** What the supervisor reads when you don't answer in time. */
export function timeoutMessage(ms: number = SUPERVISOR_APPROVAL_TIMEOUT_MS): string {
  const minutes = Math.round(ms / 60_000);
  return `The user didn't answer this in pitwall within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, so it wasn't sent. If it still matters, ask the user again in your reply, saying why.`;
}

/** What the supervisor reads when you press Don't send. */
export const DECLINED_MESSAGE = "The user declined this in pitwall, so it wasn't sent. Don't propose it again unless the user asks.";

export interface ApprovalQueue {
  /** Adds a card for a call, or says why not. The answer resolves exactly once, and never rejects. */
  add(request: { draft: ApprovalDraft; toolName: string; toolUseId: string; input: Record<string, unknown> }, signal?: AbortSignal): { ok: true; id: string; answer: Promise<PermissionAnswer> } | { ok: false; error: string };
  /** The cards waiting, oldest first, as the snapshot carries them. */
  list(): SupervisorApproval[];
  /** Holds a card for a decision: undefined when it's gone, 'busy' while another decision runs. */
  begin(id: string): PendingApproval | 'busy' | undefined;
  /** Lets a held card go again, its decision refused. */
  end(id: string): void;
  /** Answers a card, once. False when it had gone. */
  settle(id: string, answer: PermissionAnswer): boolean;
  /** Denies every card with `message`. */
  cancelAll(message: string): void;
  /** Lets one spawn_session call with exactly this input run, within PASS_MS. Returns what revokePass() takes. */
  grantPass(toolUseId: string, input: Record<string, unknown>): number;
  /** Takes back a pass grantPass() gave, unused. */
  revokePass(pass: number): void;
  /**
   * Takes one pass for a call with these arguments, and returns the input it allowed, or undefined
   * when none matches. With a tool_use_id, only a pass from that call's approval matches, and that
   * approval's pass is spent even when the arguments differ.
   */
  takePass(toolUseId: string | undefined, args: Record<string, unknown>): Record<string, unknown> | undefined;
  /** Records something you approved that went (W124): a message sent, or a session started. */
  handoff(done: Omit<SupervisorHandoff, 'id' | 'at'>): void;
  /** What handoff() recorded, oldest first, at most SUPERVISOR_HANDOFFS_MAX. */
  handoffs(): SupervisorHandoff[];
  /** Keeps a note for the supervisor's next message from you. */
  note(text: string): void;
  /** The notes kept, oldest first, and forgets them. */
  takeNotes(): string[];
  /** Changes whenever list() or handoffs() could answer differently. */
  version(): number;
  /** Called when list() may have changed. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface ApprovalQueueOptions {
  /** Default SUPERVISOR_APPROVAL_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Default MAX_PENDING_APPROVALS. */
  maxPending?: number;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Card ids, for tests. */
  randomId?: () => string;
}

interface Entry extends PendingApproval {
  resolve: (answer: PermissionAnswer) => void;
  timer: NodeJS.Timeout;
  offAbort?: () => void;
  deciding: boolean;
}

export function createApprovalQueue(options: ApprovalQueueOptions = {}): ApprovalQueue {
  const timeoutMs = options.timeoutMs ?? SUPERVISOR_APPROVAL_TIMEOUT_MS;
  const maxPending = options.maxPending ?? MAX_PENDING_APPROVALS;
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => randomBytes(12).toString('hex'));
  const entries = new Map<string, Entry>();
  const passes: { id: number; toolUseId: string; input: string; until: number }[] = [];
  let passIds = 0;
  const dropExpired = () => {
    const at = now();
    for (let index = passes.length - 1; index >= 0; index--) if (passes[index]!.until <= at) passes.splice(index, 1);
  };
  const notes: string[] = [];
  const done: SupervisorHandoff[] = [];
  const listeners = new Set<() => void>();
  let changes = 0;

  function changed(): void {
    changes++;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  function settle(id: string, answer: PermissionAnswer): boolean {
    const entry = entries.get(id);
    if (entry === undefined) return false;
    entries.delete(id);
    clearTimeout(entry.timer);
    entry.offAbort?.();
    entry.resolve(answer);
    changed();
    return true;
  }

  return {
    add(request, signal) {
      if (signal?.aborted === true) return { ok: false, error: 'The request was withdrawn.' };
      if (entries.size >= maxPending) return { ok: false, error: `${maxPending} drafts are waiting for the user already. Wait for answers before proposing more.` };
      if ([...entries.values()].some((each) => each.toolUseId === request.toolUseId)) return { ok: false, error: 'pitwall is already asking about this call.' };
      const id = randomId();
      const at = now();
      const times = { at: new Date(at).toISOString(), expiresAt: new Date(at + timeoutMs).toISOString() };
      const approval: SupervisorApproval =
        request.draft.kind === 'message'
          ? { id, kind: 'message', to: request.draft.to, text: request.draft.text, ...times }
          : { id, kind: 'spawn', directory: request.draft.directory, ...(request.draft.name === undefined ? {} : { name: request.draft.name }), prompt: request.draft.prompt, ...times };
      let resolve!: (answer: PermissionAnswer) => void;
      const answer = new Promise<PermissionAnswer>((done) => {
        resolve = done;
      });
      const timer = setTimeout(() => settle(id, { behavior: 'deny', message: timeoutMessage(timeoutMs) }), timeoutMs);
      timer.unref?.();
      const entry: Entry = { approval, toolName: request.toolName, toolUseId: request.toolUseId, input: request.input, resolve, timer, deciding: false };
      if (signal !== undefined) {
        const onAbort = () => settle(id, { behavior: 'deny', message: 'The request was withdrawn before the user answered.' });
        signal.addEventListener('abort', onAbort, { once: true });
        entry.offAbort = () => signal.removeEventListener('abort', onAbort);
      }
      entries.set(id, entry);
      changed();
      return { ok: true, id, answer };
    },
    list() {
      return [...entries.values()].map((entry) => ({ ...entry.approval }));
    },
    begin(id) {
      const entry = entries.get(id);
      if (entry === undefined) return undefined;
      if (entry.deciding) return 'busy';
      entry.deciding = true;
      return { approval: { ...entry.approval }, toolName: entry.toolName, toolUseId: entry.toolUseId, input: structuredClone(entry.input) };
    },
    end(id) {
      const entry = entries.get(id);
      if (entry !== undefined) entry.deciding = false;
    },
    settle,
    cancelAll(message) {
      for (const id of [...entries.keys()]) settle(id, { behavior: 'deny', message });
    },
    grantPass(toolUseId, input) {
      dropExpired();
      const id = ++passIds;
      passes.push({ id, toolUseId, input: canonicalJson(input), until: now() + PASS_MS });
      return id;
    },
    revokePass(pass) {
      const index = passes.findIndex((each) => each.id === pass);
      if (index !== -1) passes.splice(index, 1);
    },
    takePass(toolUseId, args) {
      dropExpired();
      const wanted = canonicalJson(args);
      if (toolUseId !== undefined) {
        const index = passes.findIndex((each) => each.toolUseId === toolUseId);
        if (index === -1) return undefined;
        // Spent whatever its arguments: one call per approval.
        const [pass] = passes.splice(index, 1);
        return pass!.input === wanted ? (JSON.parse(pass!.input) as Record<string, unknown>) : undefined;
      }
      // Without Claude Code's tool_use_id, which isn't documented: the oldest pass for exactly these arguments.
      const index = passes.findIndex((each) => each.input === wanted);
      if (index === -1) return undefined;
      const [pass] = passes.splice(index, 1);
      return JSON.parse(pass!.input) as Record<string, unknown>;
    },
    handoff(each) {
      done.push({ ...each, id: randomId(), at: new Date(now()).toISOString() });
      if (done.length > SUPERVISOR_HANDOFFS_MAX) done.splice(0, done.length - SUPERVISOR_HANDOFFS_MAX);
      changed();
    },
    handoffs() {
      return done.map((each) => ({ ...each }));
    },
    note(text) {
      notes.push(text);
      if (notes.length > MAX_NOTES) notes.splice(0, notes.length - MAX_NOTES);
    },
    takeNotes() {
      return notes.splice(0);
    },
    version: () => changes,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** JSON with every object's keys sorted, so two equal inputs compare equal as text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = sortKeys((value as Record<string, unknown>)[key]);
    return result;
  }
  return value;
}
