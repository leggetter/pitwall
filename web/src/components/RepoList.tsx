// The repo list (docs/design-system.md, 3 and 4: Repo list and Repo list items): the Needs you and
// All sessions views, a divider, then every group. Each item is a link to its selection, one count at
// the right, and the list is one Tab stop: ↓ and ↑ move between items, Home and End jump to the ends,
// and Enter selects. Before the first snapshot, four skeleton items stand in for the groups (4:
// Skeletons and spinners).
//
// With two or more roots, the list is the open root tab's (W38): the dashboard passes that root's
// groups and hidden groups alone, so the views, their counts and the Hidden section are the root's
// too, and every link names the root, so the URL says which tab it opens.
//
// Groups hidden from the list (W35, hidden.ts) are left out of it and listed at its foot instead,
// behind a "Hidden (n)" disclosure, collapsed by default, which carries the needs-you badge when any
// of their sessions need you, each counted once (4: Hidden groups). Opened, each hidden group is a
// link that selects it, muted, with its count, and an Unhide button. The disclosure, the links and
// the buttons are Tab stops of their own, outside the list's one, and ↓ and ↑ don't reach them. A
// hidden group that has left the snapshot is listed with "No sessions", so it can still be unhidden.
//
// Focus never drops to the page. After Unhide it goes to the group's item, back in the list; a group
// with no sessions has none, so it goes to the next entry's Unhide, or the one before, or the list's
// Tab stop once the section has gone. A focused item that a snapshot takes out of the list hands
// focus to the item that took its place, or the one before it.

import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { SessionGroup } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { absentGroup, sameGroup, type HiddenGroup } from '../hidden.js';
import { groupSelection, sameSelection, selectionHref, viewIn, type Selection } from '../selection.js';
import { allFinished, countAttention, groupId, groupLabel, repoListGroups, sessionsIn } from '../sessions.js';
import { Icon } from './Icon.js';
import { MiddleEllipsis } from './MiddleEllipsis.js';
import { Tooltip } from './Tooltip.js';
import { SkeletonItems } from './Waiting.js';

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

/** A group's item: its sessions, which are the ones started in it (W39), and how many of them need you. */
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

/** "Unhide pitwall-test-old": an Unhide button's name and tooltip, saying which group it unhides. */
export const unhideLabel = (label: string) => `Unhide ${label}`;

export interface HiddenListProps {
  /** The hidden groups under the roots pitwall watches, whether or not they're in the snapshot. */
  groups: readonly HiddenGroup[];
  /** Whether the Hidden section is open. */
  open: boolean;
  onToggle: () => void;
  onUnhide: (group: HiddenGroup) => void;
}

export interface RepoListProps {
  /** The snapshot's groups, or undefined before the first one, when only the views show. */
  groups: readonly SessionGroup[] | undefined;
  roots: readonly string[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
  /** Focus the list's tab stop when it mounts, as the drawer does when it opens. */
  autoFocus?: boolean;
  /** Before the first snapshot, once --pw-delay-spinner has passed: four skeleton items below the views. */
  skeletons?: boolean;
  /** Covered, in part, by the session view over the list: nothing in it can take focus or a click (Dashboard.tsx). */
  inert?: boolean;
  /** The groups hidden from the list, listed at its foot (W35). Nothing is hidden when it's undefined. */
  hidden?: HiddenListProps | undefined;
  /** With two or more roots, the open root tab: `groups` and `hidden` are its alone, and the views' links name it too (W38). */
  tab?: string | undefined;
}

/** Where focus was in the list, to hand it on if what had it goes. */
type FocusedPart = { zone: 'items'; index: number } | { zone: 'hidden'; part: 'link' | 'unhide'; index: number };

export function RepoList({ groups, roots, selection, onSelect, autoFocus = false, skeletons = false, inert = false, hidden, tab }: RepoListProps) {
  const hiddenId = useId();
  const nav = useRef<HTMLElement>(null);
  // Each session is in one group (W39), so the groups' counts under a root add up to its sessions, and All sessions' to every root's.
  const sessions = sessionsIn(groups ?? []);
  const views: Item[] = [
    { id: 'view:needs-you', selection: viewIn('needs-you', tab), label: 'Needs you', attention: countAttention(sessions), count: undefined, muted: false },
    // The total, never a badge: Needs you, just above, has that.
    { id: 'view:all', selection: viewIn('all', tab), label: 'All sessions', attention: 0, count: groups ? sessions.length : undefined, muted: false },
  ];
  // Before the first snapshot there's nothing to hide yet.
  const hiddenGroups = groups ? (hidden?.groups ?? []) : [];
  const sections = repoListGroups(
    (groups ?? []).filter((group) => !hiddenGroups.some((entry) => sameGroup(entry, group))),
    roots,
  ).map(({ root, groups: rootGroups }) => ({ root, entries: rootGroups.map((group) => groupItem(group, roots)) }));
  const items = [...views, ...sections.flatMap((section) => section.entries)];

  // The hidden groups as the snapshot has them, or with no sessions when it hasn't, in the list's order.
  const listedHidden = hiddenGroups.map((entry) => ({ entry, group: (groups ?? []).find((group) => sameGroup(entry, group)) }));
  const hiddenSections = repoListGroups(
    listedHidden.map(({ entry, group }) => group ?? absentGroup(entry)),
    roots,
  ).map(({ root, groups: rootGroups }) => ({
    root,
    entries: rootGroups.flatMap((group) => {
      const listed = listedHidden.find(({ entry }) => sameGroup(entry, group));
      return listed ? [{ item: groupItem(group, roots), entry: listed.entry, present: listed.group !== undefined }] : [];
    }),
  }));
  const hiddenEntries = hiddenSections.flatMap((section) => section.entries);
  // The hidden groups' sessions that need you, so nothing that needs you is out of sight.
  const hiddenAttention = countAttention(sessionsIn(listedHidden.flatMap(({ group }) => (group ? [group] : []))));

  // The one item in the Tab order: the last one focused, else the selection, else the first.
  const [focused, setFocused] = useState<string>();
  const selected = items.find((item) => sameSelection(item.selection, selection))?.id;
  const tabStop = items.some((item) => item.id === focused) ? focused : (selected ?? items[0]?.id);

  useEffect(() => {
    if (autoFocus) nav.current?.querySelector<HTMLElement>('a[tabindex="0"]')?.focus();
    // Only as it opens.
  }, []);

  const itemLinks = () => [...(nav.current?.querySelectorAll<HTMLAnchorElement>('a[data-repo-item]') ?? [])];
  const hiddenRows = () => [...(nav.current?.querySelectorAll<HTMLElement>('[data-hidden-entry]') ?? [])];
  const unhideButtons = () => [...(nav.current?.querySelectorAll<HTMLButtonElement>('button[data-unhide]') ?? [])];

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const links = itemLinks();
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at === -1) return;
    const to = { ArrowDown: Math.min(at + 1, links.length - 1), ArrowUp: Math.max(at - 1, 0), Home: 0, End: links.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    links[to]?.focus();
  };

  // Where focus is in the list, and, after Unhide, which entry it was on (see the top of this file).
  const focusIn = useRef<FocusedPart | undefined>(undefined);
  const afterUnhide = useRef<{ id: string; index: number } | undefined>(undefined);
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const target = event.target;
    const row = target.closest<HTMLElement>('[data-hidden-entry]');
    if (target instanceof HTMLAnchorElement && target.dataset.repoItem !== undefined) focusIn.current = { zone: 'items', index: itemLinks().indexOf(target) };
    else if (row) focusIn.current = { zone: 'hidden', part: target.dataset.unhide !== undefined ? 'unhide' : 'link', index: hiddenRows().indexOf(row) };
    else focusIn.current = undefined;
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) focusIn.current = undefined;
  };
  useLayoutEffect(() => {
    const unhid = afterUnhide.current;
    afterUnhide.current = undefined;
    const was = focusIn.current;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    if (unhid === undefined && (was === undefined || !lost)) return;
    const links = itemLinks();
    const stop = links.find((link) => link.tabIndex === 0) ?? links[0];
    let next: HTMLElement | undefined;
    if (unhid !== undefined) {
      const buttons = unhideButtons();
      next = links.find((link) => link.dataset.repoId === unhid.id) ?? buttons[unhid.index] ?? buttons[unhid.index - 1] ?? stop;
    } else if (was?.zone === 'items') {
      next = links[Math.min(was.index, links.length - 1)] ?? stop;
    } else if (was?.zone === 'hidden') {
      const rows = hiddenRows();
      const row = rows[Math.min(was.index, rows.length - 1)];
      next = row?.querySelector<HTMLElement>(was.part === 'unhide' ? 'button[data-unhide]' : 'a') ?? nav.current?.querySelector<HTMLElement>('.repo-hidden-toggle') ?? stop;
    }
    next?.focus();
  });

  // Hiding the selected group opens the section, and its entry is scrolled into view, so it shows where it went.
  const wasHidden = useRef(new Set(hiddenEntries.map(({ item }) => item.id)));
  useLayoutEffect(() => {
    const appeared = hiddenEntries.find(({ item }) => !wasHidden.current.has(item.id) && sameSelection(item.selection, selection));
    wasHidden.current = new Set(hiddenEntries.map(({ item }) => item.id));
    if (!appeared || !hidden?.open) return;
    hiddenRows()
      .find((row) => row.dataset.hiddenEntry === appeared.item.id)
      ?.scrollIntoView?.({ block: 'nearest' });
  });

  const select = (target: Selection) => (event: MouseEvent<HTMLAnchorElement>) => {
    // A new tab or window, as the link would open one, is the browser's business.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onSelect(target);
  };

  /**
   * What a link holds: its kind's icon, its label, and its count. A hidden group the snapshot hasn't
   * says "No sessions" under its label instead, so the label keeps the item's width: hidden groups stay
   * until they're unhidden, so most of them may come to have no sessions.
   */
  const content = (item: Item, absent = false) => {
    const label = (
      <span className="repo-item-label">
        <MiddleEllipsis text={item.label} />
      </span>
    );
    // After the label, so the link's name starts with what it shows.
    const kind = item.kind && <span className="visually-hidden">, {item.kind === 'git' ? 'git repo' : 'directory'}</span>;
    return (
      <>
        {item.kind && <Icon name={item.kind === 'git' ? 'repo' : 'directory'} className="repo-item-icon" />}
        {absent ? (
          <span className="repo-item-text">
            {label}
            {kind}
            <span className="repo-item-note">No sessions</span>
          </span>
        ) : (
          <>
            {label}
            {kind}
          </>
        )}
        {item.attention > 0 ? (
          <span className="badge badge-attention">
            {item.attention}
            <span className="visually-hidden"> {item.attention === 1 ? 'needs' : 'need'} you</span>
          </span>
        ) : (
          !absent &&
          item.count !== undefined && (
            <span className="repo-item-count">
              {item.count}
              <span className="visually-hidden"> {item.count === 1 ? 'session' : 'sessions'}</span>
            </span>
          )
        )}
      </>
    );
  };

  const render = (item: Item) => {
    const isSelected = item.id === selected;
    const className = ['repo-item', isSelected && 'selected', item.muted && 'finished'].filter(Boolean).join(' ');
    return (
      <li key={item.id}>
        {/* The whole label, when the middle ellipsis has cut it: on hover, and on focus from ↓ and ↑. */}
        <Tooltip content={item.label} relation="none" onlyIfCut>
          <a
            className={className}
            href={selectionHref(item.selection)}
            aria-current={isSelected ? 'page' : undefined}
            tabIndex={item.id === tabStop ? 0 : -1}
            data-repo-item=""
            data-repo-id={item.id}
            onClick={select(item.selection)}
            onFocus={() => setFocused(item.id)}
          >
            {content(item)}
          </a>
        </Tooltip>
      </li>
    );
  };

  const renderHidden = ({ item, entry, present }: (typeof hiddenEntries)[number]) => {
    const isSelected = sameSelection(item.selection, selection);
    return (
      <li key={item.id} className="repo-hidden-entry" data-hidden-entry={item.id}>
        <Tooltip content={item.label} relation="none" onlyIfCut>
          <a
            className={isSelected ? 'repo-item hidden-item selected' : 'repo-item hidden-item'}
            href={selectionHref(item.selection)}
            aria-current={isSelected ? 'page' : undefined}
            onClick={select(item.selection)}
          >
            {content(item, !present)}
          </a>
        </Tooltip>
        <Tooltip content={unhideLabel(item.label)} relation="label">
          <button
            type="button"
            className="icon-button ghost sm repo-unhide"
            data-unhide=""
            onClick={() => {
              afterUnhide.current = { id: item.id, index: hiddenEntries.findIndex((candidate) => candidate.item.id === item.id) };
              hidden?.onUnhide(entry);
            }}
          >
            <Icon name="show" />
          </button>
        </Tooltip>
      </li>
    );
  };

  /** Each root's entries, root by root: one root's, the open tab's, when pitwall watches several. */
  function rooted<T>(list: readonly { root: string; entries: readonly T[] }[], each: (entry: T, index: number) => ReactNode) {
    return list.map(({ root, entries }) => (
      <ul key={root} className="repo-items">
        {entries.map(each)}
      </ul>
    ));
  }

  return (
    <nav ref={nav} className="repo-list" aria-label="Repos" onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur} inert={inert || undefined}>
      <ul className="repo-items">{views.map((item) => render(item))}</ul>
      {(sections.length > 0 || (skeletons && !groups)) && <hr className="repo-divider" />}
      {skeletons && !groups && <SkeletonItems />}
      {rooted(sections, (item) => render(item))}
      {hidden && hiddenEntries.length > 0 && (
        <div className="repo-hidden">
          <hr className="repo-divider" />
          <button type="button" className="repo-hidden-toggle" aria-expanded={hidden.open} aria-controls={hiddenId} onClick={hidden.onToggle}>
            <Icon name="expand" className="chevron" />
            <span className="repo-hidden-title">Hidden ({hiddenEntries.length})</span>
            {hiddenAttention > 0 && (
              <span className="badge badge-attention">
                {hiddenAttention}
                <span className="visually-hidden"> {hiddenAttention === 1 ? 'needs' : 'need'} you</span>
              </span>
            )}
          </button>
          <div className="repo-hidden-list" id={hiddenId} hidden={!hidden.open}>
            {rooted(hiddenSections, renderHidden)}
          </div>
        </div>
      )}
    </nav>
  );
}
