// Tooltips, toasts, copy buttons and timestamps (W25): the real Tooltip on each kind of control it's
// on in the app, the real ToastProvider and its stack, CopyButton and CopyCommand against a stub
// clipboard, and Timestamp on the shared clock. Each is put into its state by a scenario, as a person
// would: hovering, clicking. A lasting specimen keeps its toasts and copied icons (kit.tsx).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge } from '../components/Badge.js';
import { CopyButton } from '../components/CopyButton.js';
import { CopyCommand } from '../components/CopyCommand.js';
import { startedText } from '../components/Dashboard.js';
import { Header } from '../components/Header.js';
import { InfoTip } from '../components/InfoTip.js';
import { MenuButton, type MenuEntry } from '../components/Menu.js';
import { MiddleEllipsis } from '../components/MiddleEllipsis.js';
import { LIMITS_NOTE, RelayBox, SEND_EMPTY } from '../components/RelayBox.js';
import { STOPPED, removedText } from '../components/SessionActions.js';
import { SessionRow, STALE_HINT } from '../components/SessionRow.js';
import { SessionView, TERMINAL_INTERACTIVE_NOTE } from '../components/SessionView.js';
import { ThemeSwitch } from '../components/ThemeSwitch.js';
import { Timestamp } from '../components/Timestamp.js';
import { ToastProvider, useToast, type ToastInput } from '../components/Toast.js';
import { Tooltip } from '../components/Tooltip.js';
import { ClipboardContext } from '../copy.js';
import { ShortcutsStoreContext } from '../shortcuts.js';
import { shortenHome } from '../format.js';
import { ago, APP_DIR, APP_GROUP, LONG_ROOT, LONG_ROOTS, NOW, session, TRUST_HINT } from './fixtures.js';
import { element, hoverFor, laidOut, Scenario, Specimen, specimenOf, text, until } from './kit.js';
import { memoryShortcuts, stubClipboard } from './stubs.js';
import { TabbedHeader } from './shell.js';
import { Stubbed } from './views.js';

const noop = () => {};

/** The single-key shortcuts off, for the tooltips that leave their key caps out then. */
const SHORTCUTS_OFF = memoryShortcuts(false);

const MENU: MenuEntry[] = [
  { id: 'copy', label: 'Copy session ID', icon: 'copy', onSelect: noop },
  { id: 'off', label: 'Stop session', icon: 'stop', disabled: true, hint: "It isn't running, so there's nothing to stop.", onSelect: noop },
  { kind: 'separator', id: 'separator' },
  { id: 'danger', label: 'Remove session', icon: 'remove', danger: true, onSelect: noop },
];

const TIP_INTERACTIVE = session('tip-interactive', { title: 'Export retries' });
const TIP_ROW = session('tip-row-with-a-long-name', {
  title: 'Retry each failed export batch three times with backoff, keeping the 30 second timeout',
  titleSource: 'claude-code',
});
const TIP_PATH = `${APP_DIR}/packages/exports/src/jobs/retry`;

/** Room above the trigger for its tooltip, as the app has. */
function TipStage({ children }: { children: ReactNode }) {
  return <div className="uikit-tip-stage">{children}</div>;
}

/** Hovers `selector` and waits for its tooltip, saying `wanted` when it's given. */
const hoverOn = (selector: string, wanted?: string) => (root: HTMLElement) => hoverFor(root, selector, wanted);

/** As hoverOn, for a tooltip that shows only when its text is cut short: without layout (the tests), nothing is cut. */
const hoverOnCut = (selector: string) => async (root: HTMLElement) => {
  if (!laidOut(root)) return;
  await hoverFor(root, selector);
};

export function Tooltips() {
  return (
    <>
      <Specimen
        title="An icon button, with its shortcut"
        note="The session view's Close. Its aria-label is the tooltip's text; Escape's key cap follows it. On hover after --pw-delay-tooltip, at once on keyboard focus; Escape, blur or leaving closes it. Over the tooltip itself, it stays."
        frame="short"
      >
        <Stubbed>
          <Scenario run={hoverOn('button[aria-label="Close"]', 'Close')}>
            <SessionView session={TIP_INTERACTIVE} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="The header's keyboard shortcuts button"
        note="Named by its tooltip, with ? as its key caps. It opens the keyboard shortcuts dialog."
        width={1100}
      >
        <Scenario run={hoverOn('button[aria-label="Keyboard shortcuts"]', 'Keyboard shortcuts')}>
          <div className="uikit-tip-stage">
            <Header state="live" roots={[LONG_ROOT]} updatedAt={ago(0.1)} onNewSession={noop} onShortcuts={noop} />
          </div>
        </Scenario>
      </Specimen>
      <Specimen title="New session, with its shortcut" note="A text button: its tooltip repeats its label only to show n." width={1100}>
        <Scenario run={hoverOn('.app-header .button.primary', 'New session')}>
          <div className="uikit-tip-stage">
            <Header state="live" roots={[LONG_ROOT]} updatedAt={ago(0.1)} onNewSession={noop} onShortcuts={noop} />
          </div>
        </Scenario>
      </Specimen>
      <Specimen
        title="With the single-key shortcuts off"
        note="Tooltips leave out single-key caps such as ?, and New session has no tooltip, since it would only repeat its label. Esc, the arrows and ⌘ combinations still show."
        width={1100}
      >
        <ShortcutsStoreContext.Provider value={SHORTCUTS_OFF}>
          <Scenario run={hoverOn('button[aria-label="Keyboard shortcuts"]', 'Keyboard shortcuts')}>
            <div className="uikit-tip-stage">
              <Header state="live" roots={[LONG_ROOT]} updatedAt={ago(0.1)} onNewSession={noop} onShortcuts={noop} />
            </div>
          </Scenario>
        </ShortcutsStoreContext.Provider>
      </Specimen>
      <Specimen title="A toggle in a group" note="The theme switch: each option is named by its tooltip.">
        <TipStage>
          <Scenario run={hoverOn('button[aria-label="Dark theme"]', 'Dark theme')}>
            <ThemeSwitch />
          </Scenario>
        </TipStage>
      </Specimen>
      <Specimen title="A menu button" note="Its tooltip goes as the menu opens, and doesn't come back when focus returns to it.">
        <TipStage>
          <Scenario run={hoverOn('button[aria-haspopup="menu"]', 'Session actions')}>
            <MenuButton label="Session actions" icon="more" entries={MENU} />
          </Scenario>
        </TipStage>
      </Specimen>
      <Specimen title="An info button" note="A long explanation, wrapping at 344 px. A button, so Tab reaches it; a click or a tap pins it, since touch screens can't hover.">
        <TipStage>
          <Scenario run={hoverOn('.info-tip', LIMITS_NOTE)}>
            <p className="uikit-row uikit-meta">
              ⌘ ↵ to send <InfoTip text={LIMITS_NOTE} />
            </p>
          </Scenario>
        </TipStage>
      </Specimen>
      <Specimen title="A disabled button says why" note="Send is aria-disabled while there's nothing to send. Its tooltip describes it (aria-describedby), so it's in the DOM before it shows.">
        <Stubbed>
          <Scenario run={hoverOn('button[type="submit"]', SEND_EMPTY)}>
            <footer className="session-view-foot uikit-tip-stage">
              <RelayBox session={session('tip-send')} />
            </footer>
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="A disabled tab says why" note="An interactive session's Terminal tab, and how /bg changes that." frame="short">
        <Stubbed>
          <Scenario run={hoverOn('[role="tab"][aria-disabled="true"]', TERMINAL_INTERACTIVE_NOTE)}>
            <SessionView session={session('tip-terminal')} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="A disabled menu item says why" note="On hover, and when ↑ ↓ reach it. Escape closes the menu and its tooltip together.">
        <Scenario
          run={async (root) => {
            (await element<HTMLButtonElement>(root, 'button[aria-haspopup="menu"]')).click();
            await hoverFor(root, '[role="menuitem"][aria-disabled="true"]', "It isn't running, so there's nothing to stop.");
          }}
        >
          <div className="uikit-menu-stage uikit-menu-stage-tall">
            <MenuButton label="Session actions" icon="more" entries={MENU} />
          </div>
        </Scenario>
      </Specimen>
      <Specimen
        title="A row's title, and where it came from"
        note="On hover only: nothing in a row but its name is focusable. The whole title is in the DOM, so screen readers have it, and the session view shows it."
      >
        <TipStage>
          <Scenario run={hoverOn('.session-title')}>
            <div className="session-list uikit-rows uikit-row-width">
              <ul className="sessions">
                <SessionRow session={TIP_ROW} group={APP_GROUP} onOpen={noop} />
              </ul>
            </div>
          </Scenario>
        </TipStage>
      </Specimen>
      <Specimen title="A badge's explanation" note="Stale, on hover. Badges aren't focusable, so it only explains the label.">
        <TipStage>
          <Scenario run={hoverOn('.badge.has-hint', STALE_HINT)}>
            <p className="uikit-row">
              <Badge look="subtle-neutral" hint={STALE_HINT}>
                Stale
              </Badge>
            </p>
          </Scenario>
        </TipStage>
      </Specimen>
      <Specimen title="Paths in full" note="The header's root, home and all; on screen, home is ~ and the path may be cut in the middle." width={600}>
        <Scenario run={hoverOn('.roots')}>
          <div className="uikit-tip-stage">
            <Header state="live" roots={[LONG_ROOT]} updatedAt={ago(0.1)} onNewSession={noop} onShortcuts={noop} />
          </div>
        </Scenario>
      </Specimen>
      <Specimen title="A root tab's path in full" note="With several roots, each tab's tooltip is its root's path, home and all, and describes the tab (W38)." width={800}>
        <Scenario run={hoverOn('.root-tab[aria-selected="false"]', LONG_ROOTS[1])}>
          <div className="uikit-tip-stage">
            <TabbedHeader roots={LONG_ROOTS} repos />
          </div>
        </Scenario>
      </Specimen>
      <Specimen title="Text cut short" note="A tooltip that only repeats text shows only when the text is cut: here a path in a narrow box. A short one has none.">
        <TipStage>
          <Scenario run={hoverOnCut('.uikit-cut .session-view-path')}>
            <p className="uikit-row uikit-meta uikit-cut">
              <CutPath path={TIP_PATH} />
            </p>
          </Scenario>
        </TipStage>
      </Specimen>
    </>
  );
}

/** A path in a box too narrow for it, as the session view shows one, with its tooltip when it's cut. */
function CutPath({ path }: { path: string }) {
  return (
    <span className="session-view-cwd">
      <Tooltip content={shortenHome(path)} relation="none" onlyIfCut>
        <span className="session-view-path">
          <MiddleEllipsis text={shortenHome(path)} />
        </span>
      </Tooltip>
    </span>
  );
}

/** Shows `toasts` through useToast(), one after the other, as the app's results would. */
function ShowToasts({ toasts }: { toasts: ToastInput[] }) {
  const toast = useToast();
  useEffect(() => {
    for (const shown of toasts) toast(shown);
    // Once, as it mounts.
  }, []);
  return null;
}

/** A frame with its own toasts' stack, fixed to the frame's bottom right as the app's is to the window's. */
function Toasted({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

export function Toasts() {
  return (
    <>
      <Specimen
        title="Success"
        note="Copy path, copied: the icon becomes copied for --pw-copied-timeout, and a toast says so. Success and info toasts go after --pw-toast-timeout, which stops while the pointer is over the stack or focus is in it. These stay, for the gallery."
        frame="toasts"
        lasting
      >
        <ClipboardContext.Provider value={stubClipboard('copied')}>
          <Toasted>
            <Scenario
              run={async (root) => {
                (await element<HTMLButtonElement>(root, 'button[aria-label="Copy path"]')).click();
                await text(specimenOf(root), 'Copied');
              }}
            >
              <p className="uikit-row uikit-meta">
                <code>{shortenHome(APP_DIR)}</code> <CopyButton text={APP_DIR} label="Copy path" />
              </p>
            </Scenario>
          </Toasted>
        </ClipboardContext.Provider>
      </Specimen>
      <Specimen title="Error" note="The clipboard refused: the text is selected, and the toast stays until dismissed. role=&quot;alert&quot;." frame="toasts" lasting>
        <ClipboardContext.Provider value={stubClipboard('refused')}>
          <Toasted>
            <Scenario
              run={async (root) => {
                (await element<HTMLButtonElement>(root, 'button[aria-label="Copy path"]')).click();
                await text(specimenOf(root), "Couldn't copy");
              }}
            >
              <p className="uikit-row uikit-meta">
                <code>{shortenHome(APP_DIR)}</code> <CopyButton text={APP_DIR} label="Copy path" />
              </p>
            </Scenario>
          </Toasted>
        </ClipboardContext.Provider>
      </Specimen>
      <Specimen
        title="Three at most, newest at the bottom"
        note="Four results in a row: the oldest has gone. The stack is an aria-live=&quot;polite&quot; region that's always there, so each is announced as it arrives."
        frame="toasts-tall"
        lasting
      >
        <Toasted>
          <ShowToasts
            toasts={[
              { message: 'Copied' },
              { message: startedText('pitwall-test-started') },
              { message: STOPPED },
              { message: removedText('pitwall-test-old-export') },
            ]}
          />
        </Toasted>
      </Specimen>
      <Specimen title="At 600 px and narrower" note="16 px from the edges, and full width." frame="toasts-tall" width={375} lasting>
        <Toasted>
          <ShowToasts toasts={[{ message: STOPPED }, { tone: 'error', message: "Couldn't copy; the text is selected" }]} />
        </Toasted>
      </Specimen>
    </>
  );
}

export function CopyButtons() {
  return (
    <>
      <Specimen title="Idle" note="A ghost sm icon button, named for what it copies.">
        <ClipboardContext.Provider value={stubClipboard('copied')}>
          <p className="uikit-row uikit-meta">
            <code>{shortenHome(APP_DIR)}</code> <CopyButton text={APP_DIR} label="Copy path" />
          </p>
        </ClipboardContext.Provider>
      </Specimen>
      <Specimen title="Copied" note="The copied icon, for --pw-copied-timeout (2 s; it stays here), and a Copied toast." frame="toasts" lasting>
        <ClipboardContext.Provider value={stubClipboard('copied')}>
          <Toasted>
            <Scenario
              run={async (root) => {
                (await element<HTMLButtonElement>(root, 'button[aria-label="Copy path"]')).click();
                await until('the copied icon', () => root.querySelector('.copy-button.copied'));
              }}
            >
              <p className="uikit-row uikit-meta">
                <code>{shortenHome(APP_DIR)}</code> <CopyButton text={APP_DIR} label="Copy path" />
              </p>
            </Scenario>
          </Toasted>
        </ClipboardContext.Provider>
      </Specimen>
      <Specimen
        title="Refused"
        note="The text on screen is selected, so it can be copied by hand; the button's tooltip says so, and describes it, until the next copy."
        frame="toasts"
        lasting
      >
        <ClipboardContext.Provider value={stubClipboard('refused')}>
          <Toasted>
            <Scenario
              run={async (root) => {
                (await element<HTMLButtonElement>(root, 'button[aria-label="Copy path"]')).click();
                await until('the refusal', () => root.querySelector('.copy-button[data-copy="failed"]'));
                await hoverFor(root, 'button[aria-label="Copy path"]', "Couldn't copy; the text is selected");
              }}
            >
              <p className="uikit-row uikit-meta uikit-tip-stage">
                <RefusedPath />
              </p>
            </Scenario>
          </Toasted>
        </ClipboardContext.Provider>
      </Specimen>
      <Specimen
        title="A command chip"
        note="Code style on --pw-surface-sunken, one line with a middle ellipsis and the whole command in a tooltip when it's cut. A click selects it all. Its copy button follows."
      >
        <ClipboardContext.Provider value={stubClipboard('copied')}>
          <Scenario run={hoverOnCut('.command-chip')}>
            <div className="uikit-tip-stage uikit-narrow">
              <CopyCommand command={TRUST_HINT} />
            </div>
          </Scenario>
        </ClipboardContext.Provider>
      </Specimen>
    </>
  );
}

/** A path and its copy button, with the path's element as the text to select. */
function RefusedPath() {
  const ref = useRef<HTMLElement>(null);
  return (
    <>
      <code ref={ref}>{shortenHome(APP_DIR)}</code> <CopyButton text={APP_DIR} label="Copy path" target={ref} />
    </>
  );
}

const TIMES: [string, string][] = [
  ['Under 5 s', ago(0.05)],
  ['Seconds', ago(0.7)],
  ['Minutes', ago(5)],
  ['Hours, under 48', ago(60 * 3)],
  ['Days', ago(60 * 24 * 2)],
];

export function Timestamps() {
  const [header] = useState(() => new Date(NOW - 7_000).toISOString());
  return (
    <>
      <Specimen
        title="Relative times"
        note="Meta size, tabular, in <time datetime>, ticking every second on one shared clock, and never announced. The absolute time, in the user's locale with seconds, is in the tooltip."
      >
        <table className="uikit-table">
          <tbody>
            {TIMES.map(([label, at]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td className="uikit-meta">
                  <Timestamp className="activity" at={at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Specimen>
      <Specimen title="The header's update time" note="In seconds below a minute, so it visibly ticks.">
        <p className="uikit-meta">
          <Timestamp className="updated" at={header} format="updated" />
        </p>
      </Specimen>
      <Specimen title="With its tooltip" note="On hover: times aren't focusable, and the absolute time is never the only way to know when.">
        <TipStage>
          <Scenario run={hoverOn('time')}>
            <p className="uikit-meta">
              <Timestamp className="activity" at={ago(5)} prefix="Active " />
            </p>
          </Scenario>
        </TipStage>
      </Specimen>
    </>
  );
}
