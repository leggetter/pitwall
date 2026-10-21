// The New session dialog (docs/design-system.md, 4: Dialogs): starts a background session with
// `claude --bg` in a directory under a root, with an optional name and model, and the first prompt.
// The API call and the server's checks are M2's (spawn.ts); the dialog repeats the checks so it can
// say what's wrong before sending.
//
// - Fields: Directory, a select of the groups' directories plus "Another directory under a root…",
//   which reveals a path field; Name and Model, optional, Model's "Other…" revealing a field; and the
//   first prompt. With a root tab open (W38), the directories are that tab's, and a typed one must be
//   in that tab, so the session is listed where it was started from.
// - Problems show after the first submit, then follow the typing; a submit puts focus on the first
//   field with one. ⌘/Ctrl + Enter submits from any field.
// - While the request is out, Start session is busy, every other control is aria-disabled, and
//   Escape, Close and the backdrop do nothing.
// - A failure is an inline danger alert at the end of the body. When Claude Code hasn't trusted the
//   directory, it has the command to run, in a command chip with its copy button.

import { useContext, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { IndexSnapshot, SpawnRequest } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { plainText, shortenHome } from '../format.js';
import {
  directoryChoices,
  directoryProblem,
  MAX_PROMPT_LENGTH,
  modelProblem,
  nameProblem,
  promptProblem,
  spawnSession,
  type StartedSession,
} from '../spawn.js';
import { Alert, Detail } from './Alert.js';
import { Button } from './Button.js';
import { CopyCommand } from './CopyCommand.js';
import { Dialog } from './Dialog.js';
import { Icon } from './Icon.js';
import { KeyCaps, modEnter } from './KeyCaps.js';
import '../actions.css';

/** The picker's "type one" choice. No path can contain a NUL, so it can't collide with one. */
const OTHER = '\u0000other';
const MODELS = ['sonnet', 'opus', 'haiku'] as const;

/** The sentence before the trust command (4: Dialogs, New session dialog). */
export const TRUST_TEXT = "pitwall never trusts a directory for you. Run this in a terminal, accept Claude Code's trust prompt, then start the session again:";

type Failure = { kind: 'refused'; error: string; hint?: string } | { kind: 'failed'; error: string };

export interface NewSessionDialogProps {
  /** For the roots and the groups' directories. */
  snapshot: Pick<IndexSnapshot, 'roots' | 'groups'>;
  onClose: () => void;
  /** The server started a session. The dialog is done; the caller closes it. */
  onStarted: (started: StartedSession) => void;
  /** With two or more roots, the open root tab, whose directories alone it offers (W38). */
  tab?: string | undefined;
}

export function NewSessionDialog({ snapshot, onClose, onStarted, tab }: NewSessionDialogProps) {
  const api = useContext(ApiContext);
  const ids = { dir: useId(), customDir: useId(), name: useId(), model: useId(), customModel: useId(), prompt: useId() };
  const alive = useRef(true);
  const submitting = useRef(false);

  const choices = useMemo(() => directoryChoices(snapshot, tab), [snapshot, tab]);
  // The roots it offers directories under: the open tab's, or every one.
  const roots = tab === undefined ? snapshot.roots : [tab];
  const [dirChoice, setDirChoice] = useState(() => choices[0]?.path ?? OTHER);
  const [customDir, setCustomDir] = useState('');
  const [name, setName] = useState('');
  const [modelChoice, setModelChoice] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  // Problems show once a submit has been tried, then follow the typing.
  const [checked, setChecked] = useState(false);
  const [failure, setFailure] = useState<Failure>();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const cwd = dirChoice === OTHER ? customDir.trim() : dirChoice;
  const model = modelChoice === OTHER ? customModel.trim() : modelChoice;
  const problems = {
    cwd: directoryProblem(cwd, snapshot.roots, tab),
    name: nameProblem(name),
    model: modelChoice === OTHER && model === '' ? 'Type a model alias, or choose the default.' : modelProblem(model),
    prompt: promptProblem(prompt),
  };
  const shown: Partial<typeof problems> = checked ? problems : {};
  // Something typed: a click on the backdrop leaves the dialog open.
  const dirty = customDir !== '' || name !== '' || customModel !== '' || prompt !== '';

  const submit = async () => {
    if (submitting.current) return;
    setChecked(true);
    const firstProblem = (['cwd', 'name', 'model', 'prompt'] as const).find((field) => problems[field] !== undefined);
    if (firstProblem) {
      const target = { cwd: dirChoice === OTHER ? ids.customDir : ids.dir, name: ids.name, model: ids.customModel, prompt: ids.prompt }[firstProblem];
      document.getElementById(target)?.focus();
      return;
    }
    if (!api) {
      setFailure({ kind: 'failed', error: "Sessions can't be started from here." });
      return;
    }
    const request: SpawnRequest = { cwd, prompt };
    if (name !== '') request.name = name;
    if (model !== '') request.model = model;
    submitting.current = true;
    setBusy(true);
    setFailure(undefined);
    const outcome = await spawnSession(api, request);
    submitting.current = false;
    if (!alive.current) return;
    setBusy(false);
    switch (outcome.kind) {
      case 'started':
        onStarted({ shortId: outcome.shortId, name: outcome.name });
        return;
      case 'refused':
        setFailure(outcome.hint === undefined ? { kind: 'refused', error: outcome.error } : { kind: 'refused', error: outcome.error, hint: outcome.hint });
        return;
      case 'failed':
        setFailure({ kind: 'failed', error: outcome.error });
        return;
      case 'unauthorized':
        // The app has already replaced the dashboard with the token notice.
        return;
    }
  };

  // ⌘/Ctrl + Enter starts the session from any field (6.2).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    void submit();
  };

  /** While the request is out, the fields keep what they have. */
  const edit = (set: (value: string) => void) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    if (!busy) set(event.target.value);
  };
  const disabled = { 'aria-disabled': busy || undefined };
  const describedBy = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ') || undefined;
  const keys = modEnter();

  return (
    <Dialog
      title="New session"
      subtitle={
        <>
          Starts a background session with <code>claude --bg</code>, which you can open from the list.
        </>
      }
      onClose={onClose}
      busy={busy}
      dirty={dirty}
      onSubmit={() => void submit()}
      onKeyDown={onKeyDown}
      className="new-session"
      footerMeta={
        <>
          <KeyCaps keys={keys.keys} label={keys.label} /> to start
        </>
      }
      actions={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} busyLabel="Starting…">
            Start session
          </Button>
        </>
      }
    >
      <div className="field">
        <label className="field-label" htmlFor={ids.dir}>
          Directory
        </label>
        <span className="select">
          <select
            id={ids.dir}
            className="select-input"
            value={dirChoice}
            onChange={edit(setDirChoice)}
            {...disabled}
            aria-invalid={(dirChoice !== OTHER && shown.cwd !== undefined) || undefined}
            aria-describedby={describedBy(`${ids.dir}-roots`, dirChoice !== OTHER && shown.cwd && `${ids.dir}-problem`)}
          >
            {choices.map((choice) => (
              <option key={choice.path} value={choice.path}>
                {plainText(choice.label)}
              </option>
            ))}
            <option value={OTHER}>Another directory under a root…</option>
          </select>
          <Icon name="select" className="select-icon" />
        </span>
        {dirChoice === OTHER && (
          <input
            id={ids.customDir}
            type="text"
            className="field-input mono"
            aria-label="Directory path"
            placeholder={`${roots[0] ?? '/'}/…`}
            autoComplete="off"
            spellCheck={false}
            value={customDir}
            onChange={edit(setCustomDir)}
            readOnly={busy}
            {...disabled}
            aria-invalid={shown.cwd !== undefined || undefined}
            aria-describedby={describedBy(`${ids.dir}-roots`, shown.cwd && `${ids.dir}-problem`)}
          />
        )}
        <p className="field-hint" id={`${ids.dir}-roots`}>
          Under {roots.map((root) => plainText(shortenHome(root))).join(' or ')}.
        </p>
        {shown.cwd && (
          <p className="field-problem" id={`${ids.dir}-problem`}>
            {shown.cwd}
          </p>
        )}
      </div>

      <div className="field">
        <label className="field-label" htmlFor={ids.name}>
          Name <span className="field-optional">optional</span>
        </label>
        <input
          id={ids.name}
          type="text"
          className="field-input"
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          placeholder="Claude Code names it from the prompt"
          value={name}
          onChange={edit(setName)}
          readOnly={busy}
          {...disabled}
          aria-invalid={shown.name !== undefined || undefined}
          aria-describedby={describedBy(shown.name && `${ids.name}-problem`)}
        />
        {shown.name && (
          <p className="field-problem" id={`${ids.name}-problem`}>
            {shown.name}
          </p>
        )}
      </div>

      <div className="field">
        <label className="field-label" htmlFor={ids.model}>
          Model <span className="field-optional">optional</span>
        </label>
        <span className="select">
          <select id={ids.model} className="select-input" value={modelChoice} onChange={edit(setModelChoice)} {...disabled}>
            <option value="">Default</option>
            {MODELS.map((alias) => (
              <option key={alias} value={alias}>
                {alias}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
          <Icon name="select" className="select-icon" />
        </span>
        {modelChoice === OTHER && (
          <input
            id={ids.customModel}
            type="text"
            className="field-input mono"
            aria-label="Model alias"
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
            value={customModel}
            onChange={edit(setCustomModel)}
            readOnly={busy}
            {...disabled}
            aria-invalid={shown.model !== undefined || undefined}
            aria-describedby={describedBy(shown.model && `${ids.model}-problem`)}
          />
        )}
        {shown.model && (
          <p className="field-problem" id={`${ids.model}-problem`}>
            {shown.model}
          </p>
        )}
      </div>

      <div className="field">
        <label className="field-label" htmlFor={ids.prompt}>
          First prompt
        </label>
        <textarea
          id={ids.prompt}
          className="field-input field-prompt"
          rows={6}
          maxLength={MAX_PROMPT_LENGTH}
          value={prompt}
          onChange={edit(setPrompt)}
          readOnly={busy}
          {...disabled}
          aria-invalid={shown.prompt !== undefined || undefined}
          aria-describedby={describedBy(shown.prompt && `${ids.prompt}-problem`)}
        />
        {shown.prompt && (
          <p className="field-problem" id={`${ids.prompt}-problem`}>
            {shown.prompt}
          </p>
        )}
      </div>

      {failure && (
        <Alert tone="danger" role="alert" className="spawn-failure">
          {failure.kind === 'refused' ? (
            <>
              Couldn&apos;t start the session. <Detail>{plainText(failure.error)}</Detail>
            </>
          ) : (
            plainText(failure.error)
          )}
          {failure.kind === 'refused' && failure.hint !== undefined && (
            <>
              <p className="spawn-trust">{TRUST_TEXT}</p>
              <CopyCommand command={failure.hint} />
            </>
          )}
        </Alert>
      )}
    </Dialog>
  );
}
