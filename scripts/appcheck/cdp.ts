// A small Chrome DevTools Protocol client over the `ws` package pitwall already depends on: one
// connection to the browser, with flat sessions for each page it attaches to. Every command has a
// time limit, so a stuck browser fails the run instead of hanging it.

import { WebSocket } from 'ws';

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const COMMAND_TIMEOUT_MS = 30_000;

export class Cdp {
  readonly #ws: WebSocket;
  #next = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<Listener>>();
  #closed = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data) => this.#receive(String(data)));
    ws.on('close', () => {
      this.#closed = true;
      for (const [id, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`${pending.method}: the browser's connection closed`));
        this.#pending.delete(id);
      }
    });
  }

  /** Connects to a browser's DevTools socket, `ws://127.0.0.1:<port>/devtools/browser/<id>`. */
  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      ws.once('open', () => resolve(new Cdp(ws)));
      ws.once('error', reject);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(`${method}: the browser's connection is closed`));
    const id = (this.#next += 1);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no answer from the browser in ${COMMAND_TIMEOUT_MS / 1000} s`));
      }, COMMAND_TIMEOUT_MS);
      this.#pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  /** Calls `listener` for every `method` event, from any session. Returns a function that stops it. */
  on(method: string, listener: Listener): () => void {
    const set = this.#listeners.get(method) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(method, set);
    return () => set.delete(listener);
  }

  close(): void {
    if (!this.#closed) this.#ws.close();
  }

  #receive(text: string) {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? 'failed'}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === undefined) return;
    for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
  }
}
