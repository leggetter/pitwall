import { useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
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
import { CopyCommand } from './CopyCommand.js';
import '../actions.css';

/** The picker's "type one" choice. No path can contain a NUL, so it can't collide with one. */
const OTHER = '\u0000other';
const MODELS = ['sonnet', 'opus', 'haiku'] as const;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]';

export interface NewSessionDialogProps {
  /** For the roots and the groups' directories. */
  snapshot: Pick<IndexSnapshot, 'roots' | 'groups'>;
  onClose: () => void;
  /** The server started a session. The dialog is done; the caller closes it. */
  onStarted: (started: StartedSession) => void;
}

/**
 * Starts a background session with `claude --bg`: a directory under a root,
 * an optional name and model, and the first prompt. Closes with Cancel or
 * Escape, except while the request is out.
 */
export function NewSessionDialog({ snapshot, onClose, onStarted }: NewSessionDialogProps) {
  const api = useContext(ApiContext);
  const ids = { title: useId(), dir: useId(), customDir: useId(), name: useId(), model: useId(), customModel: useId(), prompt: useId() };
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLSelectElement>(null);
  const alive = useRef(true);

  const choices = useMemo(() => directoryChoices(snapshot), [snapshot]);
  const [dirChoice, setDirChoice] = useState(() => choices[0]?.path ?? OTHER);
  const [customDir, setCustomDir] = useState('');
  const [name, setName] = useState('');
  const [modelChoice, setModelChoice] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Problems show once a submit has been tried, then follow the typing.
  const [checked, setChecked] = useState(false);
  const [failure, setFailure] = useState<{ error: string; hint?: string }>();

  // The focused element when the dialog opened, normally the New session button, gets focus back on close.
  useEffect(() => {
    alive.current = true;
    const returnTo = document.activeElement;
    firstRef.current?.focus();
    return () => {
      alive.current = false;
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    };
  }, []);

  const cwd = dirChoice === OTHER ? customDir.trim() : dirChoice;
  const model = modelChoice === OTHER ? customModel.trim() : modelChoice;
  const problems = {
    cwd: directoryProblem(cwd, snapshot.roots),
    name: nameProblem(name),
    model: modelChoice === OTHER && model === '' ? 'Type a model alias, or choose the default.' : modelProblem(model),
    prompt: promptProblem(prompt),
  };
  const shown: Partial<typeof problems> = checked ? problems : {};

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setChecked(true);
    const firstProblem = (['cwd', 'name', 'model', 'prompt'] as const).find((field) => problems[field] !== undefined);
    if (firstProblem) {
      const target = { cwd: dirChoice === OTHER ? ids.customDir : ids.dir, name: ids.name, model: ids.customModel, prompt: ids.prompt }[firstProblem];
      document.getElementById(target)?.focus();
      return;
    }
    if (!api) {
      setFailure({ error: "Sessions can't be started from here." });
      return;
    }
    const request: SpawnRequest = { cwd, prompt };
    if (name !== '') request.name = name;
    if (model !== '') request.model = model;
    setSubmitting(true);
    setFailure(undefined);
    const outcome = await spawnSession(api, request);
    if (!alive.current) return;
    setSubmitting(false);
    switch (outcome.kind) {
      case 'started':
        onStarted({ shortId: outcome.shortId, name: outcome.name });
        return;
      case 'refused':
        setFailure(outcome.hint === undefined ? { error: outcome.error } : { error: outcome.error, hint: outcome.hint });
        return;
      case 'failed':
        setFailure({ error: outcome.error });
        return;
      case 'unauthorized':
        // The app has already replaced the dashboard with the token notice.
        return;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // Handled here, so the session view behind doesn't close too.
      event.preventDefault();
      event.stopPropagation();
      if (!submitting) onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    // Keep Tab inside the dialog.
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const describedBy = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ') || undefined;

  return (
    <div className="modal-backdrop">
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={ids.title} onKeyDown={onKeyDown}>
        <form className="modal-form" onSubmit={(event) => void submit(event)} noValidate>
          <h2 className="modal-title" id={ids.title}>
            New session
          </h2>
          <p className="field-hint">
            Starts a background session with <code>claude --bg</code>, which you can open from the list.
          </p>

          <div className="field">
            <label className="field-label" htmlFor={ids.dir}>
              Directory
            </label>
            <select
              ref={firstRef}
              id={ids.dir}
              value={dirChoice}
              onChange={(event) => setDirChoice(event.target.value)}
              aria-invalid={(dirChoice !== OTHER && shown.cwd !== undefined) || undefined}
              aria-describedby={describedBy(dirChoice !== OTHER && shown.cwd && `${ids.dir}-problem`)}
            >
              {choices.map((choice) => (
                <option key={choice.path} value={choice.path}>
                  {plainText(choice.label)}
                </option>
              ))}
              <option value={OTHER}>Another directory under a root…</option>
            </select>
            {dirChoice === OTHER && (
              <input
                id={ids.customDir}
                type="text"
                className="field-input"
                aria-label="Directory path"
                placeholder={`${snapshot.roots[0] ?? '/'}/…`}
                autoComplete="off"
                spellCheck={false}
                value={customDir}
                onChange={(event) => setCustomDir(event.target.value)}
                aria-invalid={shown.cwd !== undefined || undefined}
                aria-describedby={describedBy(`${ids.dir}-roots`, shown.cwd && `${ids.dir}-problem`)}
              />
            )}
            <p className="field-hint" id={`${ids.dir}-roots`}>
              Under {snapshot.roots.map((root) => plainText(shortenHome(root))).join(' or ')}.
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
              onChange={(event) => setName(event.target.value)}
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
            <select id={ids.model} value={modelChoice} onChange={(event) => setModelChoice(event.target.value)}>
              <option value="">Default</option>
              {MODELS.map((alias) => (
                <option key={alias} value={alias}>
                  {alias}
                </option>
              ))}
              <option value={OTHER}>Other…</option>
            </select>
            {modelChoice === OTHER && (
              <input
                id={ids.customModel}
                type="text"
                className="field-input"
                aria-label="Model alias"
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                value={customModel}
                onChange={(event) => setCustomModel(event.target.value)}
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
              onChange={(event) => setPrompt(event.target.value)}
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
            <div className="banner error spawn-failure" role="alert">
              <p>{plainText(failure.error)}</p>
              {failure.hint && (
                <>
                  <p>
                    pitwall never trusts a directory for you. Run this in a terminal, accept Claude Code&apos;s trust prompt, then
                    start the session again:
                  </p>
                  <CopyCommand command={failure.hint} />
                </>
              )}
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={submitting} aria-busy={submitting || undefined}>
              {submitting ? 'Starting…' : 'Start session'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
