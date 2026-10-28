// Open in an editor (W72): the editors pitwall's server found at startup, fetched once per
// connection, after the WebSocket has authenticated, and the request that opens a session's own
// directory in one. A browser can't tell what's installed, or start an app, so the server does both
// (src/server/editors.ts); the page names only the session and the editor, never a path.
//
// The session view's actions menu has "Open in VS Code" and "Open in Cursor", one per editor found,
// while the session is listed and its directory exists. With none found, or the list not had, it has
// neither. The result is a toast: "Opened name's directory in Cursor.", a success one, or an error toast with the
// server's reason after pitwall's sentence.

import { createContext, useEffect, useState } from 'react';
import { EDITORS_PATH, openInEditorPath, type Editor, type EditorId } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { couldNot, plainText, tryAgainIn } from './format.js';
import type { ToastInput } from './components/Toast.js';

const IDS: ReadonlySet<string> = new Set<EditorId>(['vscode', 'cursor']);

/** The editors in `body`, an EditorList, in its order: each known id once, with a short label. Undefined when it isn't one. */
export function parseEditorList(body: unknown): Editor[] | undefined {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { editors?: unknown }).editors)) return undefined;
  const editors: Editor[] = [];
  for (const item of (body as { editors: unknown[] }).editors) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, label } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !IDS.has(id) || editors.some((editor) => editor.id === id)) continue;
    if (typeof label !== 'string' || label.trim() === '' || label.length > 40) continue;
    editors.push({ id: id as EditorId, label: plainText(label) });
  }
  return editors;
}

/** GETs the list, waiting for the apiKey as every request does. None when it couldn't be had. */
export async function fetchEditors(api: ApiClient, signal?: AbortSignal): Promise<Editor[]> {
  const result = await api.get(EDITORS_PATH, signal ? { signal } : {});
  return (result.kind === 'ok' ? parseEditorList(result.body) : undefined) ?? [];
}

/** The editors found, for the session view's actions menu. App provides it; none outside it, as in most tests. */
export const EditorsContext = createContext<readonly Editor[]>([]);

const NONE: readonly Editor[] = [];

/** The editors, fetched once for `api`, the connection's client, once it has authenticated. None until then. */
export function useEditorList(api: ApiClient): readonly Editor[] {
  const [editors, setEditors] = useState<readonly Editor[]>(NONE);
  useEffect(() => {
    const controller = new AbortController();
    void fetchEditors(api, controller.signal).then((list) => {
      if (!controller.signal.aborted) setEditors(list.length === 0 ? NONE : list);
    });
    return () => controller.abort();
  }, [api]);
  return editors;
}

export type OpenOutcome =
  | { kind: 'opened' }
  /** The server refused, or the editor didn't open, with why, in the server's words. */
  | { kind: 'refused'; error: string }
  /** The connection was refused (WebSocket 4401): the app is already showing it. */
  | { kind: 'unauthorized' }
  /**
   * No answer pitwall understands. `status` is the HTTP status, when the server answered, and
   * `retryAfter` a 429's Retry-After, in seconds, as resume's failure has it.
   */
  | { kind: 'failed'; status?: number; retryAfter?: number };

/**
 * Opens the session's own directory in `editor` with POST openInEditorPath(). Never rejects. A 429,
 * past the commands at once or the opens a minute (W87), is the server's reason, as any refusal is,
 * which says when to try again; one with no reason of its own keeps its Retry-After, as resume's does.
 */
export async function openInEditor(api: ApiClient, sessionId: string, editor: EditorId): Promise<OpenOutcome> {
  const result = await api.post(openInEditorPath(sessionId), { editor });
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  const body = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : undefined;
  if (result.kind === 'ok' && body?.ok === true) return { kind: 'opened' };
  if (result.kind === 'failed' && body?.ok === false && typeof body.error === 'string' && body.error !== '') return { kind: 'refused', error: body.error };
  const failed: OpenOutcome = result.status === undefined ? { kind: 'failed' } : { kind: 'failed', status: result.status };
  return result.kind === 'failed' && result.retryAfter !== undefined ? { ...failed, retryAfter: result.retryAfter } : failed;
}

/** The menu item's label: "Open in Cursor". */
export const openLabel = (editor: Editor) => `Open in ${editor.label}`;

/** The toast for an open's outcome, naming the session and the editor; none for 'unauthorized', which the app already shows. */
export function openToast(name: string, editor: Editor, outcome: OpenOutcome): ToastInput | undefined {
  const what = `open ${plainText(name)}'s directory in ${editor.label}`;
  switch (outcome.kind) {
    case 'opened':
      return { tone: 'success', message: `Opened ${plainText(name)}'s directory in ${editor.label}.` };
    case 'refused':
      return { tone: 'error', message: `${couldNot(what, undefined)} ${plainText(outcome.error)}` };
    case 'failed':
      return { tone: 'error', message: `${couldNot(what, outcome.status)}${tryAgainIn(outcome.retryAfter)}` };
    case 'unauthorized':
      return undefined;
  }
}
