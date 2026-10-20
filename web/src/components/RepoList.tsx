// The repo list (docs/design-system.md, 3 and 4: Repo list and Repo list items): the Needs you and
// All sessions views, a divider, then every group, under its root's path when pitwall watches more
// than one root. Each item is a link to its selection, one count at the right, and the list is one
// Tab stop: ↓ and ↑ move between items, Home and End jump to the ends, and Enter selects.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { SessionGroup } from '../../../src/shared/protocol.js';
import { plainText, shortenHome } from '../format.js';
import { ALL_SESSIONS, groupSelection, NEEDS_YOU, sameSelection, selectionHref, type Selection } from '../selection.js';
import { allFinished, countAttention, groupId, groupLabel, repoListGroups } from '../sessions.js';
import { Icon } from './Icon.js';
import { MiddleEllipsis } from './MiddleEllipsis.js';

interface Item {
  id: string;
  selection: Selection;
  label: string;
  kind?: SessionGroup['kind'];
  /** How many need you: a badge when there are any. */
  attention: number;
  /** How many sessions, shown when nothing needs you; undefined shows nothing. */
  count: number | undefined;
  /** Every session has finished. */
  muted: boolean;
}

function groupItem(group: SessionGroup, roots: readonly string[]): Item {
  return {
    id: groupId(group),
    selection: groupSelection(group, roots),
    label: plainText(groupLabel(group)),
    kind: group.kind,
    attention: countAttention(group.sessions),
    count: group.sessions.length,
    muted: allFinished(group),
  };
}

export interface RepoListProps {
  /** The snapshot's groups, or undefined before the first one, when only the views show. */
  groups: readonly SessionGroup[] | undefined;
  roots: readonly string[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
  /** Focus the list's tab stop when it mounts, as the drawer does when it opens. */
  autoFocus?: boolean;
}

export function RepoList({ groups, roots, selection, onSelect, autoFocus = false }: RepoListProps) {
  const rootId = useId();
  const nav = useRef<HTMLElement>(null);
  const sessions = groups?.flatMap((group) => group.sessions) ?? [];
  const views: Item[] = [
    { id: 'view:needs-you', selection: NEEDS_YOU, label: 'Needs you', attention: countAttention(sessions), count: undefined, muted: false },
    // The total, never a badge: Needs you, just above, has that.
    { id: 'view:all', selection: ALL_SESSIONS, label: 'All sessions', attention: 0, count: groups ? sessions.length : undefined, muted: false },
  ];
  const sections = repoListGroups(groups ?? [], roots).map(({ root, groups: rootGroups }) => ({
    root,
    items: rootGroups.map((group) => groupItem(group, roots)),
  }));
  const items = [...views, ...sections.flatMap((section) => section.items)];

  // The one item in the Tab order: the last one focused, else the selection, else the first.
  const [focused, setFocused] = useState<string>();
  const selected = items.find((item) => sameSelection(item.selection, selection))?.id;
  const tabStop = items.some((item) => item.id === focused) ? focused : (selected ?? items[0]?.id);

  useEffect(() => {
    if (autoFocus) nav.current?.querySelector<HTMLElement>('a[tabindex="0"]')?.focus();
    // Only as it opens.
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const links = [...(nav.current?.querySelectorAll<HTMLAnchorElement>('a[data-repo-item]') ?? [])];
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at === -1) return;
    const to = { ArrowDown: Math.min(at + 1, links.length - 1), ArrowUp: Math.max(at - 1, 0), Home: 0, End: links.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    links[to]?.focus();
  };

  const render = (item: Item) => {
    const isSelected = item.id === selected;
    const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
      // A new tab or window, as the link would open one, is the browser's business.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onSelect(item.selection);
    };
    const className = ['repo-item', isSelected && 'selected', item.muted && 'finished'].filter(Boolean).join(' ');
    return (
      <li key={item.id}>
        <a
          className={className}
          href={selectionHref(item.selection)}
          aria-current={isSelected ? 'page' : undefined}
          tabIndex={item.id === tabStop ? 0 : -1}
          data-repo-item=""
          onClick={onClick}
          onFocus={() => setFocused(item.id)}
        >
          {item.kind && <Icon name={item.kind === 'git' ? 'repo' : 'directory'} className="repo-item-icon" />}
          {/* Until the design system's tooltips exist (W25), the browser's shows the whole label. */}
          <span className="repo-item-label" title={item.label}>
            <MiddleEllipsis text={item.label} />
          </span>
          {/* After the label, so the link's name starts with what it shows. */}
          {item.kind && <span className="visually-hidden">, {item.kind === 'git' ? 'git repo' : 'directory'}</span>}
          {item.attention > 0 ? (
            <span className="badge badge-attention">
              {item.attention}
              <span className="visually-hidden"> {item.attention === 1 ? 'needs' : 'need'} you</span>
            </span>
          ) : (
            item.count !== undefined && (
              <span className="repo-item-count">
                {item.count}
                <span className="visually-hidden"> {item.count === 1 ? 'session' : 'sessions'}</span>
              </span>
            )
          )}
        </a>
      </li>
    );
  };

  return (
    <nav ref={nav} className="repo-list" aria-label="Repos" onKeyDown={onKeyDown}>
      <ul className="repo-items">{views.map(render)}</ul>
      {sections.length > 0 && <hr className="repo-divider" />}
      {sections.map(({ root, items: rootItems }, index) =>
        roots.length > 1 ? (
          <div key={root} className="repo-root-section">
            <p className="repo-root" id={`${rootId}-${index}`}>
              {plainText(shortenHome(root))}
            </p>
            <ul className="repo-items" aria-labelledby={`${rootId}-${index}`}>
              {rootItems.map(render)}
            </ul>
          </div>
        ) : (
          <ul key={root} className="repo-items">
            {rootItems.map(render)}
          </ul>
        ),
      )}
    </nav>
  );
}
