// The New session dialog (docs/design-system.md, 4: Dialogs): starts a background session with
// `claude --bg` in a directory under a root, with an optional name and model, and the first prompt.
// The API call and the server's checks are M2's (spawn.ts); the dialog repeats the checks so it can
// say what's wrong before sending.
//
// - Fields: Directory, a select of the groups' directories plus "Another directory under a root…",
//   which reveals a combobox of the directories under the roots (W70), fetched once per opening, the
//   first time it's chosen, and narrowed as you type (directories.ts); Name and Model, optional,
//   Model's "Other…" revealing a field; and the first prompt. With a root tab open (W38), the
//   directories are that tab's, and a typed one must be in that tab, so the session is listed where
//   it was started from. A chosen directory is sent as its absolute path; a typed one as before, or
//   from a `~/` path under a root.
// - Problems show after the first submit, then follow the typing; a submit puts focus on the first
//   field with one. ⌘/Ctrl + Enter submits from any field.
// - While the request is out, Start session is busy, every other control is aria-disabled, and
//   Escape, Close and the backdrop do nothing.
// - A failure is an inline danger alert at the end of the body. When Claude Code hasn't trusted the
//   directory, it has the command to run, in a command chip with its copy button.

import { useContext, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { DirectoryList, IndexSnapshot, SpawnRequest } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import {
  directoryCount,
  directoryOptions,
  fetchDirectories,
  matchDirectories,
  MAX_SHOWN,
  resolveTypedDirectory,
  typedDirectoryProblem,
  type DirectoryOption,
} from '../directories.js';
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
import { Combobox } from './Combobox.js';
import { CopyCommand } from './CopyCommand.js';
import { Dialog } from './Dialog.js';
import { Icon } from './Icon.js';
import { KeyCaps, modEnter } from './KeyCaps.js';
import { Spinner } from './Spinner.js';
import '../actions.css';

/** The picker's "type one" choice. No path can contain a NUL, so it can't collide with one. */
const OTHER = '\u0000other';
const MODELS = ['sonnet', 'opus', 'haiku'] as const;

/** The sentence before the trust command (4: Dialogs, New session dialog). */
export const TRUST_TEXT = "pitwall never trusts a directory for you. Run this in a terminal, accept Claude Code's trust prompt, then start the session again:";

type Failure = { kind: 'refused'; error: string; hint?: string } | { kind: 'failed'; error: string };

/** The directory list, fetched the first time "Another directory under a root…" is chosen. */
type Listing = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; list: DirectoryList } | { kind: 'failed' };

/** What the field says under the list while it loads, when it's cut short, and when nothing matches (4: Combobox). */
export const DIRECTORY_TEXT = {
  loading: 'Loading directories…',
  failed: "Couldn't list the directories. Type a path.",
  truncated: 'Not every directory is listed. You can type a path.',
  none: 'No directories match. A typed path still works.',
  empty: 'No directories to list. You can type a path.',
  narrow: 'Keep typing to narrow them.',
} as const;

export interface NewSessionDialogProps {
  /** For the roots and the groups' directories. */
  snapshot: Pick<IndexSnapshot, 'roots' | 'groups'>;
  onClose: () => void;
  /** The server started a session. The dialog is done; the caller closes it. */
  onStarted: (started: StartedSession) => void;
  /** With two or more roots, the open root tab, whose directories alone it offers (W38). */
  tab?: string | undefined;
}

/**
 * The lines under the directory list: loading, how many of how many, none to list or none match, and
 * not every one listed. `listed` is how many the root or roots offer, `total` how many match.
 */
function directoryStatus(listing: Listing, truncated: boolean, listed: number, total: number) {
  if (listing.kind === 'loading') {
    return (
      <p className="combobox-status-line">
        <Spinner /> {DIRECTORY_TEXT.loading}
      </p>
    );
  }
  if (listing.kind !== 'ready') return undefined;
  const lines: string[] = [];
  if (listed === 0) lines.push(DIRECTORY_TEXT.empty);
  else if (total === 0) lines.push(DIRECTORY_TEXT.none);
  else if (total > MAX_SHOWN) lines.push(`${MAX_SHOWN} of ${total.toLocaleString('en')}. ${DIRECTORY_TEXT.narrow}`);
  if (truncated) lines.push(DIRECTORY_TEXT.truncated);
  if (lines.length === 0) return undefined;
  return lines.map((line) => (
    <p key={line} className="combobox-status-line">
      {line}
    </p>
  ));
}

/** What a screen reader hears once the typing stops: the same, with the count always. */
function directoryAnnouncement(listing: Listing, truncated: boolean, listed: number, total: number): string | undefined {
  if (listing.kind === 'loading') return DIRECTORY_TEXT.loading;
  if (listing.kind !== 'ready') return undefined;
  const count =
    listed === 0
      ? 'No directories to list.'
      : total === 0
      ? 'No directories match.'
      : total > MAX_SHOWN
        ? `${MAX_SHOWN} of ${directoryCount(total)}. ${DIRECTORY_TEXT.narrow}`
        : `${directoryCount(total)}.`;
  return truncated ? `${count} Not every directory is listed.` : count;
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
  // The option chosen from the list, while the field still shows it.
  const [accepted, setAccepted] = useState<{ label: string; path: string }>();
  const [listing, setListing] = useState<Listing>({ kind: 'idle' });
  const listAbort = useRef<AbortController | undefined>(undefined);
  const combobox = useRef<HTMLInputElement>(null);
  // Set when a choice reveals the combobox, so focus moves into it once it's there.
  const revealing = useRef(false);
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
      listAbort.current?.abort();
    };
  }, []);

  /** Fetches the directory list, once per opening of the dialog. */
  const listDirectories = () => {
    if (listing.kind !== 'idle') return;
    if (!api) {
      setListing({ kind: 'failed' });
      return;
    }
    const controller = new AbortController();
    listAbort.current = controller;
    setListing({ kind: 'loading' });
    void fetchDirectories(api, controller.signal).then((list) => {
      if (alive.current) setListing(list ? { kind: 'ready', list } : { kind: 'failed' });
    });
  };

  // With no directory to choose but a typed one, the field is there from the start.
  useEffect(() => {
    if (dirChoice === OTHER) listDirectories();
    // Only as the dialog opens: a later choice fetches from its change handler.
  }, []);

  useEffect(() => {
    if (dirChoice !== OTHER || !revealing.current) return;
    revealing.current = false;
    combobox.current?.focus();
  }, [dirChoice]);

  const chooseDirectory = (event: ChangeEvent<HTMLSelectElement>) => {
    if (busy) return;
    const value = event.target.value;
    if (value === OTHER && dirChoice !== OTHER) {
      revealing.current = true;
      listDirectories();
    }
    setDirChoice(value);
  };

  const offered = useMemo(() => (listing.kind === 'ready' ? directoryOptions(listing.list, snapshot.roots, tab) : undefined), [listing, snapshot.roots, tab]);
  const matches = useMemo(() => (offered ? matchDirectories(offered.options, customDir) : undefined), [offered, customDir]);
  const comboOptions = useMemo(
    () => (matches?.shown ?? []).map((option): DirectoryOption & { marker: string | undefined } => ({ ...option, marker: option.repo ? 'repo' : undefined })),
    [matches],
  );

  const typed = customDir.trim();
  const cwd = dirChoice !== OTHER ? dirChoice : accepted !== undefined && typed === accepted.label ? accepted.path : resolveTypedDirectory(typed, snapshot.roots);
  const model = modelChoice === OTHER ? customModel.trim() : modelChoice;
  const problems = {
    cwd: dirChoice !== OTHER ? directoryProblem(cwd, snapshot.roots, tab) : typedDirectoryProblem(typed, cwd, snapshot.roots, tab),
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
            onChange={chooseDirectory}
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
          <Combobox
            id={ids.customDir}
            inputRef={combobox}
            label="Directory path"
            listLabel="Directories"
            placeholder={`${roots[0] === undefined ? '' : shortenHome(roots[0])}/…`}
            value={customDir}
            onInput={setCustomDir}
            options={comboOptions}
            onAccept={(option) => {
              setCustomDir(option.label);
              setAccepted({ label: option.label, path: option.path });
            }}
            status={directoryStatus(listing, offered?.truncated ?? false, offered?.options.length ?? 0, matches?.total ?? 0)}
            announcement={directoryAnnouncement(listing, offered?.truncated ?? false, offered?.options.length ?? 0, matches?.total ?? 0)}
            openOnMount
            busy={busy}
            invalid={shown.cwd !== undefined}
            describedBy={describedBy(`${ids.dir}-roots`, listing.kind === 'failed' && `${ids.dir}-list`, shown.cwd && `${ids.dir}-problem`)}
          />
        )}
        <p className="field-hint" id={`${ids.dir}-roots`}>
          Under {roots.map((root) => plainText(shortenHome(root))).join(' or ')}.
        </p>
        {dirChoice === OTHER && listing.kind === 'failed' && (
          <p className="field-hint" id={`${ids.dir}-list`}>
            {DIRECTORY_TEXT.failed}
          </p>
        )}
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
