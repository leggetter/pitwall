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
import { createReplyLoader, ReplyLoaderContext } from '../lastMessage.js';
import { Icons, ThemeSwitches, Tokens, Type } from './foundations.js';
import { SettleContext } from './kit.js';
import { GroupSections, SessionRows } from './lists.js';
import { Dialogs, Notices, Pages } from './pages.js';
import { scriptedAttach, stubApi } from './stubs.js';
import { Confirmations, MessageBoxes, SessionViews, Terminals } from './views.js';
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
  { id: 'icons', title: 'Icons', intro: 'The Icon component, and the inline icons it will replace.', Content: Icons },
  { id: 'theme-switch', title: 'Theme switch', intro: "ThemeSwitch: System, Light and Dark. It's the real one, so pressing it changes this page's theme.", Content: ThemeSwitches },
  { id: 'session-rows', title: 'Session rows', intro: 'SessionRow, inside the GroupSection it always sits in.', Content: SessionRows },
  { id: 'groups', title: 'Group sections', intro: 'GroupSection: its header, count and Finished list.', Content: GroupSections },
  { id: 'session-view', title: 'Session view', intro: 'SessionView, framed as the window it overlays.', Content: SessionViews },
  { id: 'message-box', title: 'Message box', intro: "RelayBox, in the session view's footer, in each send state.", Content: MessageBoxes },
  { id: 'confirmations', title: 'Stop and remove', intro: 'SessionActions and its confirmations.', Content: Confirmations },
  { id: 'terminal', title: 'Terminal', intro: 'The Terminal tab, attached to a scripted server instead of pitwall.', Content: Terminals },
  { id: 'new-session', title: 'New session dialog', intro: 'NewSessionDialog, empty, filled, with errors and after a failure.', Content: Dialogs },
  { id: 'page-states', title: 'Page states', intro: 'The whole Dashboard: loading, connection, alerts and empty states.', Content: Pages },
  { id: 'notices', title: 'Badges and notices', intro: 'The connection badge, and the notices that replace the page.', Content: Notices },
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
  // One stub API, reply loader and attach for anything not given its own, such as a session view
  // opened from a row on one of the page specimens.
  const [defaults] = useState(() => {
    const api = stubApi();
    return { api, loader: createReplyLoader({ api }), attach: scriptedAttach('attached') };
  });

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
      <ApiContext.Provider value={defaults.api}>
        <ReplyLoaderContext.Provider value={defaults.loader}>
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
        </ReplyLoaderContext.Provider>
      </ApiContext.Provider>
    </SettleContext.Provider>
  );
}
