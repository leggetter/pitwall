// Open a file in an editor from a link (W211): what the session view does when a link in the Terminal
// or Conversation tab names a file. useFileLinks() returns the opener the links call (FileLinksContext)
// and the dialogs it may need:
//
// - Which editor: the one last used in this browser (a file link, or the actions menu's Open in), else
//   the config file's `editor`, else the only one found. With two found and none chosen yet, a small
//   dialog asks, and the choice becomes the last used. With none found, a toast says so.
// - A file outside every workspace root: the server answers 409 with the file's realpath, and the page
//   asks "This file is outside your workspaces: <path>. Open it in <editor>?" in a dialog (docs/design-
//   system.md, 4: Dialogs, as New session and Clone and start ask), and sends the request again with
//   `outside: true` only on Open, and then with the realpath the server named, which the server holds it to. The link's own text is never what the question shows: it's the path
//   the server resolved.
// - A link whose visible text isn't the file it opens (a markdown link's text, an OSC 8 link's cells) asks
//   first, in a dialog that names the path it opens, as an http link does (W55). A bare path or a code span
//   doesn't: there the text is the path.
// - The result is a toast, from the app's stack, so it still arrives when the view has gone.
//
// Nothing here reads the file system or decides what's safe: the server checks every path (src/server/editors.ts).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Editor, EditorId } from '../../../src/shared/protocol.js';
import type { ApiClient } from '../api.js';
import { DefaultEditorContext, EditorsContext } from '../editors.js';
import { chooseEditor, lastEditor, openFile, openFileRequest, rememberEditor, type FileLinks, type FileRef } from '../fileLinks.js';
import { couldNot, plainText, tryAgainIn } from '../format.js';
import { Button } from './Button.js';
import { Dialog } from './Dialog.js';
import { useToast } from './Toast.js';

/** The opener for file links in the session view. None outside it, or while its directory is gone: links are then plain text. With no editor found, it says so in a toast. */
export const FileLinksContext = createContext<FileLinks | undefined>(undefined);

/** The dialog that asks which editor, and its subtitle's lead. */
export const CHOOSE_TITLE = 'Open in which editor?';
/** The question for a file outside your workspaces; the path follows, then the editor. */
export const OUTSIDE_TITLE = 'Open a file outside your workspaces?';
/** The question for a link whose text isn't its file; the link's text and the path follow. */
export const MISMATCH_TITLE = "Open a file this link doesn't name?";
export const outsideQuestion = (editor: Editor) => `Open it in ${editor.label}?`;
export const NO_EDITOR = "pitwall didn't find VS Code or Cursor when it started, so it can't open a file.";

type Step =
  | { kind: 'mismatch'; ref: FileRef; shown: string; target: string }
  | { kind: 'choose'; ref: FileRef }
  | { kind: 'outside'; ref: FileRef; editor: Editor; path: string; busy: boolean };

const fileName = (path: string) => plainText(path.slice(path.lastIndexOf('/') + 1) || path);

/**
 * The opener and its dialogs for session `sessionId`. `enabled` is false while the session's directory
 * is gone or it isn't listed, as the actions menu's Open in is then: a relative path has nothing to be
 * read against, so links stay plain text.
 */
export function useFileLinks(api: ApiClient | undefined, sessionId: string, enabled: boolean): { links: FileLinks | undefined; dialog: ReactNode } {
  const editors = useContext(EditorsContext);
  const configured = useContext(DefaultEditorContext);
  const toast = useToast();
  const [step, setStep] = useState<Step>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const running = useRef(false);

  const run = useCallback(
    async (ref: FileRef, editor: Editor, outside: boolean) => {
      if (!api || running.current) return;
      running.current = true;
      const outcome = await openFile(api, sessionId, openFileRequest(ref, editor.id, outside));
      running.current = false;
      const what = `open ${fileName(ref.path)} in ${editor.label}`;
      if (outcome.kind === 'opened') {
        rememberEditor(editor.id);
        if (alive.current) setStep(undefined);
        toast({ tone: 'success', message: `Opened ${fileName(ref.path)} in ${editor.label}.` });
      } else if (outcome.kind === 'outside') {
        if (alive.current) setStep({ kind: 'outside', ref, editor, path: outcome.path, busy: false });
      } else {
        if (alive.current) setStep(undefined);
        if (outcome.kind === 'refused') toast({ tone: 'error', message: `${couldNot(what, undefined)} ${plainText(outcome.error)}` });
        else if (outcome.kind === 'failed') toast({ tone: 'error', message: `${couldNot(what, outcome.status)}${tryAgainIn(outcome.retryAfter)}` });
      }
    },
    [api, sessionId, toast],
  );

  const proceed = useCallback(
    (ref: FileRef) => {
      if (editors.length === 0) {
        toast({ tone: 'error', message: NO_EDITOR });
        return;
      }
      const id = chooseEditor(editors, lastEditor(), configured);
      const editor = editors.find((each) => each.id === id);
      if (editor) void run(ref, editor, false);
      else setStep({ kind: 'choose', ref });
    },
    [editors, configured, run, toast],
  );

  const open = useCallback(
    (ref: FileRef, shown?: string) => {
      // `shown` is passed only by a link whose text isn't its own file (isOwnFileTarget): it asks.
      if (shown !== undefined) setStep({ kind: 'mismatch', ref, shown, target: ref.path });
      else proceed(ref);
    },
    [proceed],
  );

  const links = useMemo<FileLinks | undefined>(() => (api && enabled ? { open } : undefined), [api, enabled, open]);

  const close = () => setStep(undefined);
  let dialog: ReactNode = null;
  if (step?.kind === 'mismatch') {
    const { ref, shown } = step;
    dialog = (
      <Dialog
        title={MISMATCH_TITLE}
        size="sm"
        onClose={close}
        className="file-link-dialog"
        actions={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                setStep(undefined);
                proceed(ref);
              }}
            >
              Open
            </Button>
          </>
        }
      >
        <p className="file-link-what">
          The link says <code className="file-link-path">{plainText(shown.length > 120 ? `${shown.slice(0, 120)}…` : shown)}</code>, but it opens{' '}
          <code className="file-link-path">{plainText(ref.path)}</code>
          {ref.line === undefined ? '' : `:${ref.line}`}. Open it in your editor?
        </p>
      </Dialog>
    );
  } else if (step?.kind === 'choose') {
    const { ref } = step;
    dialog = (
      <Dialog
        title={CHOOSE_TITLE}
        size="sm"
        subtitle={<code className="file-link-path">{plainText(ref.path)}</code>}
        onClose={close}
        actions={<Button onClick={close}>Cancel</Button>}
        className="file-link-dialog"
      >
        <div className="file-link-choices">
          {editors.map((editor: Editor) => (
            <Button
              key={editor.id}
              icon="external"
              onClick={() => {
                rememberEditor(editor.id as EditorId);
                setStep(undefined);
                void run(ref, editor, false);
              }}
            >
              {`Open in ${editor.label}`}
            </Button>
          ))}
        </div>
      </Dialog>
    );
  } else if (step?.kind === 'outside') {
    const { ref, editor, path, busy } = step;
    dialog = (
      <Dialog
        title={OUTSIDE_TITLE}
        size="sm"
        onClose={close}
        busy={busy}
        className="file-link-dialog"
        actions={
          <>
            <Button disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              busyLabel="Opening…"
              onClick={() => {
                setStep({ ...step, busy: true });
                void run({ ...ref, path }, editor, true);
              }}
            >
              {`Open in ${editor.label}`}
            </Button>
          </>
        }
      >
        <p className="file-link-what">
          This file is outside your workspaces: <code className="file-link-path">{plainText(path)}</code>. {outsideQuestion(editor)}
        </p>
      </Dialog>
    );
  }
  return { links, dialog };
}
