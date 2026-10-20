// The #uikit gallery (W19): the design system's living reference (docs/design-system.md). It renders
// the web UI's real components in every state, from made-up fixtures, with stubs in place of the
// API and the attach sockets. It never reads the token, opens the WebSocket or calls fetch.
//
// Dev builds only: App.tsx imports this lazily, and only when Vite's mode is development or test.
// Every M3 PR adds the components and states it introduces here.

import { memo, useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { ApiContext } from '../api.js';
import { AttachContext } from '../attach.js';
import { ThemeSwitch } from '../components/ThemeSwitch.js';
import { ClipboardContext } from '../copy.js';
import { ShortcutsStoreContext } from '../shortcuts.js';
import { Alerts, Buttons } from './controls.js';
import { Icons, ThemeSwitches, Tokens, Type } from './foundations.js';
import { SettleContext } from './kit.js';
import { FinishedSections, SessionRows } from './lists.js';
import { Dialogs, Layouts, Notices, Pages, ShortcutsDialogs } from './pages.js';
import { CopyButtons, Timestamps, Toasts, Tooltips } from './overlays.js';
import { FilterSpecimens, Headers, RepoDrawers, RepoLists, SessionListHeads } from './shell.js';
import { memoryShortcuts, scriptedAttach, stubApi, stubClipboard } from './stubs.js';
import { Confirmations, Conversations, Menus, MessageBoxes, SessionViews, Terminals } from './views.js';
import './gallery.css';

interface Section {
  id: string;
  title: string;
  intro: string;
  Content: ComponentType;
}

const SECTIONS: Section[] = [
  { id: 'tokens', title: 'Tokens', intro: 'Every --pw-* token on :root, for the theme shown.', Content: Tokens },
  { id: 'type', title: 'Type', intro: 'Inter and JetBrains Mono, bundled by fonts.css, at the sizes in 2.7.', Content: Type },
  { id: 'icons', title: 'Icons', intro: 'The Icon component: every icon pitwall uses.', Content: Icons },
  { id: 'theme-switch', title: 'Theme switch', intro: "ThemeSwitch: System, Light and Dark. It's the real one, so pressing it changes this page's theme.", Content: ThemeSwitches },
  { id: 'buttons', title: 'Buttons', intro: 'Button in each variant, idle, disabled and busy, at each size; the spinner; key caps.', Content: Buttons },
  { id: 'header', title: 'Header', intro: 'Header: the Repos button, the wordmark, the roots, New session, the connection, the update time, the theme switch and the keyboard shortcuts button, at each width.', Content: Headers },
  { id: 'repo-list', title: 'Repo list', intro: 'RepoList: the two views, then every group. Each one keeps its own selection, so click or use ↓, ↑, Home and End.', Content: RepoLists },
  { id: 'repo-drawer', title: 'Repo drawer', intro: 'RepoDrawer: the repo list below 900 px.', Content: RepoDrawers },
  { id: 'session-list', title: 'Session list header', intro: "SessionList's header for each selection: its name, its summary, the filters and the Sort setting.", Content: SessionListHeads },
  { id: 'filters', title: 'Filters and Sort', intro: 'FilterControls: the filter field, the filter chips and Clear filters, then the Sort setting. Each one keeps its own state.', Content: FilterSpecimens },
  { id: 'session-rows', title: 'Session rows', intro: 'SessionRow, two lines, in the session list it always sits in: in a group, and in Needs you and All sessions.', Content: SessionRows },
  { id: 'finished', title: 'Finished section', intro: 'FinishedSection, at the foot of the session list.', Content: FinishedSections },
  {
    id: 'session-view',
    title: 'Session view',
    intro: 'SessionView, framed as the window it overlays: its header, actions menu, tabs, body and footer, in each state. The Layouts section shows it as the third column.',
    Content: SessionViews,
  },
  {
    id: 'conversation',
    title: 'Conversation',
    intro: "The session view's Conversation tab: every kind of entry, folded tool calls closed and open, Load earlier idle and busy, and Jump to latest.",
    Content: Conversations,
  },
  { id: 'menus', title: 'Menus', intro: 'MenuButton: an icon button and its menu, which the session view\'s actions use.', Content: Menus },
  { id: 'message-box', title: 'Message box', intro: "RelayBox, in the session view's footer: typing, at and over the limit, sending, each send's result, the latest exchange, and a session that can't be messaged.", Content: MessageBoxes },
  {
    id: 'confirmations',
    title: 'Inline confirmations',
    intro: 'Stop session and Remove session, from the actions menu, and the restart before attaching, each asking, busy, and with its result.',
    Content: Confirmations,
  },
  { id: 'terminal', title: 'Terminal', intro: 'The Terminal tab, attached to a scripted server instead of pitwall.', Content: Terminals },
  { id: 'alerts', title: 'Alerts and the app strip', intro: 'Alert in each tone, as the page alerts use it, and AppStrip, for while the relay is off until restart.', Content: Alerts },
  { id: 'new-session', title: 'New session dialog', intro: 'NewSessionDialog, on Dialog: empty, filled, with errors, starting, and after a failure.', Content: Dialogs },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts dialog',
    intro: 'ShortcutsDialog, on Dialog: the keyboard map in 6.2 and the off switch for the single-key shortcuts. Each keeps its own setting here; in the app it is one, kept in pitwall.shortcuts.v1.',
    Content: ShortcutsDialogs,
  },
  { id: 'tooltips', title: 'Tooltips', intro: 'Tooltip on each kind of control it is on in the app, each opened by hovering it.', Content: Tooltips },
  { id: 'toasts', title: 'Toasts', intro: 'ToastProvider and its stack: a success, an error, three at most, and full width at 600 px and narrower.', Content: Toasts },
  { id: 'copy', title: 'Copy buttons', intro: 'CopyButton idle, copied and refused, against a stub clipboard, and CopyCommand, the command chip.', Content: CopyButtons },
  { id: 'timestamps', title: 'Timestamps', intro: 'Timestamp, on the one shared clock, with the absolute time in its tooltip.', Content: Timestamps },
  { id: 'page-states', title: 'Page states', intro: 'The whole Dashboard in a window 560 px tall, at the gallery\'s width: loading, the selections, alerts, filters and empty states. Each column scrolls.', Content: Pages },
  {
    id: 'layouts',
    title: 'Layouts',
    intro: 'The whole Dashboard in windows of set widths, for one, two and three columns, with the session view in each, and the divider at its limits. A window wider than the gallery scrolls sideways.',
    Content: Layouts,
  },
  { id: 'notices', title: 'Badges and notices', intro: 'The status badges, the other badges and the connection badge, and the notices that replace the page.', Content: Notices },
];

/** The sections, rendered once: the gallery's own state changing doesn't re-render a specimen. */
const Sections = memo(function Sections() {
  return SECTIONS.map(({ id, title, intro, Content }) => (
    <section key={id} id={`uikit/${id}`} className="uikit-section" aria-labelledby={`uikit-${id}-title`}>
      <h2 id={`uikit-${id}-title`}>{title}</h2>
      <p className="uikit-note">{intro}</p>
      <Content />
    </section>
  ));
});

/** Scrolls to the section the address names (#uikit/<id>), or to the top. */
function showTarget(): void {
  let id = window.location.hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // Not percent-encoded properly: look it up as it is.
  }
  const target = id.startsWith('uikit/') ? document.getElementById(id) : null;
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

export default function Gallery() {
  // One stub API, attach and clipboard for anything not given its own, such as a session view opened
  // from a row on one of the page specimens. Nothing in the gallery writes to the real clipboard. The
  // single-key shortcuts are on, in memory, whatever the app's own setting is.
  const [defaults] = useState(() => ({ api: stubApi(), attach: scriptedAttach('attached'), clipboard: stubClipboard('copied'), shortcuts: memoryShortcuts() }));

  // Specimens take focus as they open (a session view's Close button, a dialog's first field),
  // which scrolls the page. Once every scenario has settled, put the page back where the address says.
  const pending = useRef<Promise<unknown>[]>([]);
  const settle = useCallback((work: Promise<unknown>) => {
    pending.current.push(work);
  }, []);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const title = document.title;
    document.title = 'pitwall UI kit';
    showTarget();
    let alive = true;
    void Promise.allSettled(pending.current).then(() => {
      if (!alive) return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      // A window wider than the gallery scrolls sideways to whatever took focus; start each at its left edge.
      for (const stage of document.querySelectorAll<HTMLElement>('.uikit-widths')) stage.scrollLeft = 0;
      showTarget();
      setReady(true);
    });
    return () => {
      alive = false;
      document.title = title;
    };
  }, []);

  return (
    <SettleContext.Provider value={settle}>
      <ShortcutsStoreContext.Provider value={defaults.shortcuts}>
      <ClipboardContext.Provider value={defaults.clipboard}>
      <ApiContext.Provider value={defaults.api}>
        <AttachContext.Provider value={defaults.attach}>
            <div className="uikit" data-ready={ready || undefined}>
              <header className="uikit-bar">
                <h1>pitwall UI kit</h1>
                {/* The app's own switch: the gallery shows, and stores, the theme the app uses. */}
                <ThemeSwitch />
                <a href="#">Back to pitwall</a>
              </header>
              <p className="uikit-note uikit-intro">
                The web UI&apos;s components in every state, from made-up sessions. Dev builds only; nothing here talks to pitwall.
                See docs/design-system.md.
              </p>
              <nav className="uikit-index" aria-label="Sections">
                <ol>
                  {SECTIONS.map(({ id, title }) => (
                    <li key={id}>
                      <a href={`#uikit/${id}`}>{title}</a>
                    </li>
                  ))}
                </ol>
              </nav>
              <Sections />
            </div>
        </AttachContext.Provider>
      </ApiContext.Provider>
      </ClipboardContext.Provider>
      </ShortcutsStoreContext.Provider>
    </SettleContext.Provider>
  );
}
