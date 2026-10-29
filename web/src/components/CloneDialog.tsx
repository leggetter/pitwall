// Clone and start's confirmation (W107, D25; docs/design-system.md, 4: Pull requests, Starting a
// session for a PR): a small dialog that says exactly what will happen before anything does, "Clone
// example/sdk-docs into ~/code/sdk-docs", then New session there, with Cancel and Clone. Clone sends
// only the PR's repo (cloneRepo()); the server picks the root and the directory, and says where it
// cloned, which the caller opens New session in.
//
// - While it clones, Clone is busy ("Cloning…"), the rest aria-disabled, and Escape, Close and the
//   backdrop do nothing, as for New session: the clone runs to its end on the server either way.
// - Refused or failed, an inline danger alert at the end of the body: "Couldn't clone
//   example/sdk-docs." then the server's reason, in pitwall's words, never gh's output.
// - Cloned, onCloned() gets the new directory and the command that trusts it.

import { Fragment, useContext, useEffect, useRef, useState } from 'react';
import type { PullRequestSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { plainText, shortenHome } from '../format.js';
import { cloneRepo, cloneTarget } from '../prStart.js';
import { Alert, Detail } from './Alert.js';
import { Button } from './Button.js';
import { CopyCommand } from './CopyCommand.js';
import { Dialog } from './Dialog.js';
import '../actions.css';

export const CLONE_TITLE = 'Clone and start a session';
export const CLONE_LABEL = 'Clone';
export const CLONING = 'Cloning…';

/** The alert's sentence before the server's reason. */
export const cloneRefused = (repo: string) => `Couldn't clone ${plainText(repo)}.`;

export interface CloneDialogProps {
  pr: PullRequestSummary;
  onClose: () => void;
  /** Cloned: the new directory, and the command that trusts it, when there is one. */
  onCloned: (cloned: { cwd: string; hint?: string }) => void;
}

export function CloneDialog({ pr, onClose, onCloned }: CloneDialogProps) {
  const api = useContext(ApiContext);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ error: string; detail: boolean }>();
  const alive = useRef(true);
  const sending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const where = cloneTarget(pr);
  const repo = pr.repoLabel;

  const submit = async () => {
    if (sending.current) return;
    if (!api) {
      setFailure({ error: "Repos can't be cloned from here.", detail: false });
      return;
    }
    sending.current = true;
    setBusy(true);
    setFailure(undefined);
    const outcome = await cloneRepo(api, pr);
    sending.current = false;
    if (!alive.current) return;
    setBusy(false);
    switch (outcome.kind) {
      case 'cloned':
        onCloned(outcome.hint === undefined ? { cwd: outcome.cwd } : { cwd: outcome.cwd, hint: outcome.hint });
        return;
      case 'refused':
        setFailure({ error: outcome.error, detail: true });
        return;
      case 'failed':
        setFailure({ error: outcome.error, detail: false });
        return;
      case 'unauthorized':
        // The app has already replaced the dashboard with the token notice.
        return;
    }
  };

  return (
    <Dialog
      title={CLONE_TITLE}
      size="sm"
      subtitle={
        <>
          For <bdi>{plainText(`${repo} #${pr.number}`)}</bdi>, whose repo isn&apos;t cloned under your roots.
        </>
      }
      onClose={onClose}
      busy={busy}
      onSubmit={() => void submit()}
      className="clone-dialog"
      actions={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} busyLabel={CLONING}>
            {CLONE_LABEL}
          </Button>
        </>
      }
    >
      <p className="clone-what">
        Clone <bdi className="clone-repo">{plainText(repo)}</bdi> into <code className="clone-target">{plainText(shortenHome(where?.target ?? ''))}</code>
      </p>
      <ol className="clone-steps">
        <li>
          pitwall clones it with <code>gh repo clone</code>, using your <code>gh</code> login.
        </li>
        <li>New session opens in the new folder, with a prompt for #{pr.number} you can change.</li>
      </ol>
      {failure && (
        <Alert tone="danger" role="alert" className="clone-failure">
          {failure.detail ? (
            <>
              {cloneRefused(repo)} <Detail>{plainText(failure.error)}</Detail>
            </>
          ) : (
            plainText(failure.error)
          )}
        </Alert>
      )}
    </Dialog>
  );
}

/** The trust sentence after a clone (W107): Claude Code doesn't trust a new clone until you've run claude in it once. */
export const CLONED_TRUST_TEXT =
  "Claude Code doesn't trust a new clone until you've run claude in it once, even under a folder you trust. Run this in a terminal, accept its trust prompt, then start the session:";

/** In its place for a path with a `'` or `\`, which has no command to copy (W87). */
export const CLONED_NO_COMMAND_TEXT =
  "Claude Code doesn't trust a new clone until you've run claude in it once, even under a folder you trust. Run claude there and accept its trust prompt, then start the session. There's no command to copy: its path has a ' or \\, which shells don't all read the same way.";

/** "Cloned example/sdk-docs into ~/code/sdk-docs.": the notice's title, in New session. */
export const clonedText = (repo: string, cwd: string) => `Cloned ${plainText(repo)} into ${plainText(shortenHome(cwd))}.`;

/** `text`, with each " claude " in code style, as a command is (5: Casing and style): the same text. */
function WithCommand({ text }: { text: string }) {
  const parts = text.split(' claude ');
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <>
              {' '}
              <code>claude</code>{' '}
            </>
          )}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/**
 * New session's notice after a clone: what was cloned, then how to trust the new folder, with the
 * command to copy, since Claude Code won't start a background session there until you have (W107's
 * check). pitwall never trusts a folder for you, so New session's own trust failure follows if you
 * start it first.
 */
export function ClonedNotice({ repo, cwd, hint }: { repo: string; cwd: string; hint?: string | undefined }) {
  return (
    <Alert tone="success" title={clonedText(repo, cwd)} className="cloned-notice">
      {hint !== undefined ? (
        <>
          <p className="spawn-trust">
            <WithCommand text={CLONED_TRUST_TEXT} />
          </p>
          <CopyCommand command={hint} label="Copy trust command" />
        </>
      ) : (
        <p className="spawn-trust">
          <WithCommand text={CLONED_NO_COMMAND_TEXT} />
        </p>
      )}
    </Alert>
  );
}
