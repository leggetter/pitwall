# pitwall UI map

The names of the web UI's regions, so a request, a plan item or a review can say exactly where a change goes (W222, Phil, 2026-11-27). Use these names in conversation, `PLAN.md`, `docs/design-system.md`, code and tests. `docs/design-system.md` says how each region looks and behaves; this file says only what each one is called and where its code is.

## The app shell

Three columns from 1,200 px wide:

```
┌─ App strip ──────────────────────────────────────────────────────────────────────┐
├─ Header ─────────────────────────────────────────────────────────────────────────┤
│ Repo list      │ Session list       ┃ Session pane                                │
│                │                    ┃ ┌─ Session view ──────────────────────────┐ │
│ Needs you      │ Page alerts        ┃ │ View header                             │ │
│ All sessions   │ List header        ┃ │ Recap strip                             │ │
│ Starred        │ Rows               ┃ │ Session tabs                            │ │
│ Pull requests  │ Finished section   ┃ │ View foot (message box)                 │ │
│ ── groups ──   │                    ┃ └─────────────────────────────────────────┘ │
│ Hidden section │                    ┃                          Supervisor panel → │
└────────────────┴────────────────────┸─────────────────────────────────────────────┘
                                      ┃ the divider
```

| Name | What it is | Code |
|---|---|---|
| **App shell** | The whole page: the app strip, the header and the three columns. `data-layout` on it says which layout is in use. | `AppShell`, `.app` |
| **App strip** | A line above the header while something affects the whole app: the relay is off, recaps are paused, or the supervisor stopped. | `AppStrips`, `AppStrip`, `RecapsStrip`, `SupervisorStrip` |
| **Header** | The wordmark, the root or the root tabs, New session, the connection badge, Usage, shortcuts, Preferences, the theme switch and the Supervisor button. | `Header`, `.app-header-*` |
| **Root tabs** | One tab per root, in the header, when pitwall watches two or more. | `RootTabs` |
| **Repo list** | The first column: the views (Needs you, All sessions, Starred, Pull requests), then a group for each repo or directory, then the Hidden section. "Sidebar" names only the layout mode in which the repo list is a column (`data-layout="sidebar"`). | `RepoList`, `nav.repo-list`, `--pw-repo-list-w` |
| **Repo drawer** | The repo list's form below 900 px, opened from the header's Repos button, and when W187 folds the repo list to give the supervisor panel room. | `RepoDrawer` |
| **Session list** | The second column: the sessions of what the repo list selected. With Pull requests selected, it is the PR list. | `SessionList`, `.session-list-*`; `PrList`, `.pr-list` |
| **Page alerts** | Alerts at the top of the session list: the poll failed, a server error, the relay alert, "Lost the connection". | `.session-list-alerts` |
| **List header** | The session list's heading, its summary, the filter field, the chips and the sort menu. | `.session-list-head`, `FilterControls`, `SortMenu` |
| **Rows** | One per session, or per pull request in the PR list. | `SessionRow`, `PrRow` |
| **Finished section** | The finished sessions, collapsed, at the session list's foot. | `.finished-list` |
| **Session pane** | The third column. It holds one thing: a session view, a PR view, or the "Select a session" empty state. Below 1,200 px it has no box of its own, and the session view lies over the session list. | `.session-pane`, `.pane-views`, `--pw-session-pane-w`, `sessionPaneWidth` |
| **Column rail** | The 40 px strip a collapsed repo list or session list leaves, with a button that opens it again (W224). The view header's Fill the window control collapses both. | `PaneRail`, `.pane-rail`, `--pw-rail-w`, `usePaneFill` |
| **Divider** | The line between the session list and the session pane, dragged to set the session pane's width. | `Divider` |
| **Supervisor panel** | The supervisor's conversation: a column beside the session view from 1,200 px, and over it below that. | `SupervisorPanel`, `--pw-supervisor-col` |

## The session view

```
┌─ Session view ──────────────────────────────────────────────┐
│ View header: Back, name, star, meta line, actions, Close     │
│ Recap strip                                                  │
│ Session tabs: Conversation | Terminal | Sub-agents | Pull requests │
│ ┌─ the open tab's panel ───────────────────────────────────┐ │
│ └──────────────────────────────────────────────────────────┘ │
│ View foot: the message box, or Resume for an ended session   │
└──────────────────────────────────────────────────────────────┘
```

| Name | What it is | Code |
|---|---|---|
| **Session view** | One session, in the session pane. `PrView`, `WaitingSessionView` and `UnlistedSessionView` take its place in the same frame. | `SessionView`, `Frame`, `.session-view` |
| **View header** | Back at narrow widths, the session's name, the star, the meta line, lineage, the actions menu and Close. | `.session-view-head`, `Top`, `.session-view-meta`, `SessionActions`, `SessionLineage` |
| **Recap strip** | The session's recap: the summary, then Goal, Done, Working on, Plan, For you and Next. | `RecapStrip` |
| **Session tabs** | Conversation, Terminal, Sub-agents and Pull requests. | `.session-tabs` |
| **Conversation tab** | The transcript, paged from the end. | `ConversationPanel` (`Conversation.tsx`) |
| **Terminal tab** | The attached terminal. | `SessionTerminal` (`Terminal.tsx`) |
| **Sub-agents tab** | The session's sub-agents. | `SubagentsPanel` |
| **Pull requests tab** | The session's pull requests. | `SessionPrsPanel` |
| **View foot** | The message box for a live session, or Resume for an ended one. | `.session-view-foot`, `EndedFooter` |
| **Message box** | Where you type a message to the session. | `MessageBox` |

## Naming rules

- **One region, one name.** A new region gets a name here in the same PR that adds it, and its component and CSS class use that name.
- **"Panel" is the supervisor panel's.** The session pane is a pane. A tab's content is that tab's panel only in ARIA terms (`role="tabpanel"`).
- **"Sidebar" is a layout mode, not a region.** The region is the repo list, whatever layout it is in.
