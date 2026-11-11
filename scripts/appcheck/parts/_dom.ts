// What the parts share: expressions that find pitwall's elements in the page, by role, name and the
// classes docs/design-system.md gives them, and the moves several parts make. A file whose name
// starts with `_` is a helper, not a part.

import type { Case } from '../runner.js';

const q = JSON.stringify;

/** The modal dialog that's open: a dialog, or the repo drawer. */
export const DIALOG = `document.querySelector('[role="dialog"][aria-modal="true"]')`;
/** The open dialog's name, from its title. */
export const dialogName = `(() => { const d = ${DIALOG}; if (!d) return undefined; return d.getAttribute('aria-label') ?? document.getElementById(d.getAttribute('aria-labelledby'))?.textContent; })()`;
/** The open dialog's box. */
export const dialogBox = `(() => { const r = ${DIALOG}.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()`;
/** A button in the open dialog, by its text or name. */
export const dialogButton = (label: string) => `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${q(label)})`;

/** A header button, by its name. */
export const headerButton = (label: string) => `document.querySelector(${q(`header button[aria-label="${label}"]`)})`;

/** A session row's open button, by the session's name, in the list as shown. */
export const row = (name: string) => `[...document.querySelectorAll('.session-list [data-open-session]')].find((el) => el.textContent.trim() === ${q(name)} && !el.closest('[hidden]'))`;
/** The names of the rows shown, in order, the Finished section's when it's open included. */
export const rowNames = `[...document.querySelectorAll('.session-list [data-open-session]')].filter((el) => !el.closest('[hidden]')).map((el) => el.textContent.trim())`;
/** The session list's heading. */
export const listHeading = `document.querySelector('.session-list .session-list-label')?.textContent`;

/** A repo list item, by its label, in the columns or the drawer. */
export const repoItem = (label: string) => `[...document.querySelectorAll('nav[aria-label="Repos"] a[data-repo-item]')].find((a) => a.querySelector('.repo-item-label')?.textContent === ${q(label)})`;
export const repoLabels = `[...document.querySelectorAll('nav[aria-label="Repos"] a[data-repo-item] .repo-item-label')].map((el) => el.textContent)`;
export const selectedRepo = `document.querySelector('nav[aria-label="Repos"] a[aria-current="page"] .repo-item-label')?.textContent`;

/** The session view that's shown. */
export const VIEW = `document.querySelector('section.session-view:not([hidden])')`;
export const viewName = `${VIEW}?.querySelector('.session-view-name')?.textContent`;
export const viewHeading = `${VIEW}?.querySelector('h2')`;
/** The view's selected tab, without ", attached". */
export const viewTab = `${VIEW}?.querySelector('[role="tab"][aria-selected="true"]')?.textContent.replace(', attached', '').trim()`;
export const viewTabButton = (label: string) => `[...(${VIEW}?.querySelectorAll('[role="tab"]') ?? [])].find((el) => el.textContent.replace(', attached', '').trim() === ${q(label)})`;
/** Close, or Back to sessions at 600 px and narrower. */
export const viewClose = `(${VIEW}?.querySelector('.session-view-back') ?? ${VIEW}?.querySelector('button[aria-label="Close"]'))`;

/** The terminal's status, such as "attached", from its data-status. */
export const attachStatus = `${VIEW}?.querySelector('.attach-status')?.dataset.status`;
export const terminalText = `${VIEW}?.querySelector('.xterm-rows')?.textContent ?? ''`;
export const inTerminal = `!!document.activeElement?.closest('.attach-terminal')`;
/** Which of the terminal bar's two hints shows: 'type' (how to type to it) or 'leave' (F6). */
export const shownHint = `(() => { const t = ${VIEW}?.querySelector('.attach-type-hint'); return t ? (t.dataset.shown === 'true' ? 'type' : 'leave') : undefined; })()`;

/** What has focus, in words. */
export const focused = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'the page';
  if (el.closest('.attach-terminal')) return 'the terminal';
  if (el.matches('section.session-view h2')) return 'the view heading';
  if (el.type === 'radio') return el.closest('fieldset').querySelector('legend').textContent + '/' + el.labels[0].textContent;
  // A select in Preferences' Models and effort (W119) by its row and label, such as Recaps/Effort; another by its label.
  if (el.tagName === 'SELECT' && el.labels.length > 0) {
    const row = el.closest('.work-row')?.querySelector('.work-row-name')?.textContent;
    const label = el.labels[0].textContent.trim();
    return row ? row + '/' + label : label;
  }
  return (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 60);
})()`;

export const toasts = `[...document.querySelectorAll('.toasts .toast:not(.leaving) .toast-message')].map((el) => el.textContent)`;

/** Whether the repo list is in the drawer: below 900 px, or folded by the supervisor's column from 1,200 to 1,519 px (W187). */
const REPOS_IN_DRAWER = `!document.querySelector('.columns > .repo-list')`;

/**
 * Opens the repo drawer below 900 px, or while the supervisor's column has folded the repo list into
 * it (W187); nothing to do where the list is a column.
 */
export async function openRepoList(t: Case): Promise<void> {
  if (!(await t.page.evaluate<boolean>(REPOS_IN_DRAWER)) || (await t.page.evaluate<boolean>(`!!document.querySelector('.repo-drawer')`))) return;
  await t.page.click('Repos', headerButton('Repos'));
  await t.page.waitFor('the repo drawer', `!!document.querySelector('.repo-drawer nav[aria-label="Repos"]')`);
}

/** Chooses a repo list item, through the drawer below 900 px, which closes as the item is chosen. */
export async function chooseInRepoList(t: Case, label: string): Promise<void> {
  const inDrawer = await t.page.evaluate<boolean>(REPOS_IN_DRAWER);
  await openRepoList(t);
  await t.page.click(label, repoItem(label));
  await t.page.waitFor(`${label} as the list's heading`, `${listHeading} === ${q(label)}`);
  if (inDrawer) await t.page.waitFor('the drawer to close', `!document.querySelector('.repo-drawer')`);
}

/** Opens a session from its row, as a click does, and waits for its view. */
export async function openFromRow(t: Case, name: string): Promise<void> {
  await t.page.click(`the ${name} row`, row(name));
  await t.page.waitFor(`the ${name} view`, `${viewName} === ${q(name)}`);
}

/** Opens the Finished section of the list, if it's shut. */
export async function openFinished(t: Case): Promise<void> {
  const toggle = `document.querySelector('.session-list .finished-toggle')`;
  if ((await t.page.evaluate(`${toggle}?.getAttribute('aria-expanded')`)) === 'false') await t.page.click('Finished', toggle);
}

/** Opens a dialog from its header button and waits for it, named `name`. */
export async function openDialog(t: Case, button: string, name = button): Promise<void> {
  await t.page.click(button, headerButton(button));
  await t.page.waitFor(`the ${name} dialog`, `${dialogName} === ${q(name)}`);
}

/** The width a dialog card should be (docs/design-system.md, 2.12): at most the window less 32 px. */
export function dialogWidth(t: Case, card: number): number {
  return Math.min(card, t.viewport.width - 32);
}

/** A made-up path with the made-up home as `~`, as the page shows it (shortenHome()). */
export const shortPath = (path: string): string => path.replace(/^\/Users\/example(?=\/|$)/, '~');

/**
 * Chooses `path`, absolute, in a directory combobox (W140): puts it in the field, as a paste would,
 * which highlights its best option, the first (W142), and Enter takes it. Resolves to what the field
 * then shows.
 */
export async function chooseDirectory(t: Case, combobox: string, path: string): Promise<string> {
  await t.page.evaluate(`(() => {
    const field = ${combobox};
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${q(path)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await t.page.key('Enter');
  return t.page.evaluate<string>(`${combobox}.value`);
}

/** Sets a native select's value as a choice in its list would, since headless Chrome draws no list to click. */
export function chooseOption(select: string, value: string): string {
  return `(() => {
    const select = ${select};
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${q(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`;
}
