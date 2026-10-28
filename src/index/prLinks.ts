// PR links (M4, W94): what in a transcript links a session to a pull request (PrLink), for the
// worked-in scanner (workedIn.ts), which reads every session's transcript and its sub-agents' and
// finds these in the same pass. Pure: it reads no files and runs nothing. The index doesn't know
// which PRs are open; the web UI matches the links against the PR list (prLinkMatches()).
//
// The four kinds (PrLinkKind), each from its own place, since a PR URL anywhere in a transcript
// would link the wrong sessions (`gh pr list`'s output names many):
// - opened: a successful result of a call that creates a PR. For a Bash `gh pr create`, each line
//   of its output that is a PR URL and nothing else, as gh prints the new PR's. For a GitHub MCP
//   tool whose name ends in `create_pull_request`, the first PR URL in its result: the PR's
//   `html_url` comes before its body, and the GitHub MCP server returns only the URL.
// - pushed: a successful result of a Bash `git push`: each `To <remote>` line naming a GitHub
//   repo, and the ref lines under it for a new branch, a fast-forward or a forced update. Rejected,
//   deleted and up-to-date refs, tags and other refs are left out.
// - prompted: a PR URL in a prompt you typed, by the rule behind lastUserPrompt (promptTextOf()),
//   in the main transcript: a sub-agent's prompts are its parent's.
// - mentioned: a PR URL in Claude's own text blocks in the main transcript.
// A call's input and every other tool result count for nothing.
//
// Every step is linear in the text's size, and ref lines over MAX_OUTPUT_LINE aren't read: the
// scanner runs these on the main thread.

import { PR_LINKS_MAX, type PrLink, type PrLinkKind } from '../shared/protocol.js';
import { NOT_OWNERS, prCommandsOf, slugsIn } from './toolCalls.js';

/** A PR, by its repo, lowercase `owner/name`, and number. */
export interface PrRef {
  repo: string;
  number: number;
}

/** A branch pushed to a repo, lowercase `owner/name`. */
export interface PushRef {
  repo: string;
  branch: string;
}

/** What a call's result can link, when it succeeds. Undefined from linkingCall() for every other call. */
export interface LinkingCall {
  /** 'gh' for a Bash `gh pr create`, 'mcp' for a GitHub MCP create-pull-request tool. */
  opens?: 'gh' | 'mcp';
  /** A Bash `git push`. */
  pushes?: true;
}

/** The longest output line read as a `To` or ref line. git's are a few hundred characters at most. */
export const MAX_OUTPUT_LINE = 1024;

/**
 * `https://github.com/<owner>/<name>/pull/<n>`, and the same with a tab (`/files`, `/commits`,
 * `/checks`, and a commit's sha after the first two), a trailing `/`, `#...` or `?...`. Not a
 * longer path, such as `/pull/12/merge`, nor `/pull/12.diff`. Bounded, so it's linear.
 */
const PR_URL =
  /(?<![\w.+-])https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})(?:\/(?:files|commits|checks)(?:\/[0-9a-f]{7,40})?)?\/?(?![\w/-]|\.\w)/g;
/** The same, as a whole line: what `gh pr create` prints. */
const PR_URL_LINE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})$/;
/** `To <remote>`, the line git push writes before a remote's ref lines. */
const TO_LINE = /^To (\S+)$/;
/**
 * A ref line: its flag, summary, `from -> to`, and an optional `(reason)`. The flag is ` ` for a
 * fast-forward, `+` forced, `*` new, `-` deleted, `!` rejected and `=` up to date.
 */
const REF_LINE = /^\s*(?:([+*=!-])\s+)?(\[[a-z ]{1,40}\]|[0-9a-f]{4,64}\.\.\.?[0-9a-f]{4,64})\s+(\S{1,255}) -> (\S{1,255})(?: \(.{1,200}\))?$/;
const HASH_RANGE = /^[0-9a-f]+\.\.\.?[0-9a-f]+$/;

function prRef(owner: string, name: string, digits: string): PrRef | undefined {
  if (NOT_OWNERS.has(owner.toLowerCase())) return undefined;
  const number = Number(digits);
  return Number.isSafeInteger(number) && number > 0 ? { repo: `${owner}/${name}`.toLowerCase(), number } : undefined;
}

/** Every PR URL in `text`, in order, repeats included. */
export function prUrlsIn(text: string): PrRef[] {
  const found: PrRef[] = [];
  for (const match of text.matchAll(PR_URL)) {
    const ref = prRef(match[1] ?? '', match[2] ?? '', match[3] ?? '');
    if (ref !== undefined) found.push(ref);
  }
  return found;
}

/** True when `text` may hold a PR URL: the cheap test before prUrlsIn(). */
export function mayNamePr(text: string): boolean {
  return text.includes('github.com/') && text.includes('/pull/');
}

/** The PRs a `gh pr create`'s output names on a line of their own, as gh prints the PR it created. */
export function openedByGh(output: string): PrRef[] {
  const found: PrRef[] = [];
  for (const raw of output.split('\n')) {
    if (raw.length > MAX_OUTPUT_LINE) continue;
    const match = PR_URL_LINE.exec(raw.trim());
    const ref = match ? prRef(match[1] ?? '', match[2] ?? '', match[3] ?? '') : undefined;
    if (ref !== undefined) found.push(ref);
  }
  return found;
}

/** The PR a GitHub MCP create-pull-request tool's result names first, which is the one it created. */
export function openedByMcp(output: string): PrRef[] {
  if (!mayNamePr(output)) return [];
  for (const match of output.matchAll(PR_URL)) {
    const ref = prRef(match[1] ?? '', match[2] ?? '', match[3] ?? '');
    if (ref !== undefined) return [ref];
  }
  return [];
}

/**
 * The branches a `git push`'s output says it pushed, to which GitHub repos: under each `To` line
 * that names one, the ref lines for a new branch (`* [new branch]`), a fast-forward (`a1..b2`) or a
 * forced update (`+ a1...b2`). The branch is the right-hand side, without `refs/heads/`; a ref
 * outside `refs/heads/` isn't a branch. Rejected (`[rejected]`, `[remote rejected]`), deleted, up to
 * date and new tag lines are left out, and "Everything up-to-date" has no ref lines. A `To` line
 * for a remote that isn't GitHub's leaves out the ref lines under it.
 */
export function pushedIn(output: string): PushRef[] {
  const found: PushRef[] = [];
  let repo: string | undefined;
  for (const raw of output.split('\n')) {
    if (raw.length > MAX_OUTPUT_LINE) continue;
    const line = raw.trimEnd();
    const to = TO_LINE.exec(line);
    if (to) {
      repo = slugsIn(to[1] ?? '')[0];
      continue;
    }
    if (repo === undefined) continue;
    const ref = REF_LINE.exec(line);
    if (!ref) continue;
    const [, flag, summary = '', , target = ''] = ref;
    if (flag === '!' || (summary !== '[new branch]' && !HASH_RANGE.test(summary))) continue;
    const branch = target.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : target;
    if (branch === '' || branch.startsWith('refs/')) continue;
    found.push({ repo, branch });
  }
  return found;
}

/** What a tool call's result could link, from its name and input; undefined for a call whose result can't. */
export function linkingCall(name: string, input: unknown): LinkingCall | undefined {
  if (name.endsWith('create_pull_request')) return { opens: 'mcp' };
  if (name !== 'Bash' || input === null || typeof input !== 'object') return undefined;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== 'string') return undefined;
  const { push, prCreate } = prCommandsOf(command);
  if (!push && !prCreate) return undefined;
  return { ...(prCreate ? { opens: 'gh' as const } : {}), ...(push ? { pushes: true as const } : {}) };
}

/** A link as the scanner keeps it: a PrLink with its time as epoch milliseconds. */
export interface FoundLink {
  kind: PrLinkKind;
  repo: string;
  number?: number;
  branch?: string;
  at: number;
}

/** One key per kind and PR, or pushed branch: what "the newest per link" is kept by. */
export function linkKey(link: Omit<FoundLink, 'at'>): string {
  return `${link.kind}\n${link.repo}\n${link.kind === 'pushed' ? (link.branch ?? '') : String(link.number ?? '')}`;
}

/** Keeps the newer of `link` and the one `links` has under its key. */
export function addLink(links: Map<string, FoundLink>, link: FoundLink): void {
  const key = linkKey(link);
  const known = links.get(key);
  if (known === undefined || link.at > known.at) links.set(key, link);
}

const KIND_ORDER: Readonly<Record<PrLinkKind, number>> = { opened: 0, pushed: 1, prompted: 2, mentioned: 3 };

/** Newest first; ties by kind, repo, then number or branch, so the order never flips between scans. */
function newestFirst(a: FoundLink, b: FoundLink): number {
  return b.at - a.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || order(a.repo, b.repo) || (a.number ?? 0) - (b.number ?? 0) || order(a.branch ?? '', b.branch ?? '');
}

function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The links to keep, newest first, at most `max`: over that, the oldest 'mentioned' links go first,
 * then the oldest of the rest. So with `max` or more strong links, the newest `max` of those.
 */
export function newestLinks(links: Iterable<FoundLink>, max = PR_LINKS_MAX): FoundLink[] {
  const sorted = [...links].sort(newestFirst);
  let over = sorted.length - max;
  if (over <= 0) return sorted;
  const kept: FoundLink[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const link = sorted[i] as FoundLink;
    if (over > 0 && link.kind === 'mentioned') over--;
    else kept.push(link);
  }
  return kept.reverse().slice(0, max);
}

/**
 * Drops what newestLinks() could never keep from one file's links: beyond the newest `max` strong
 * links and the newest `max` mentioned ones. Merging files' pruned links then keeps what merging
 * them whole would, so a transcript that names thousands of PRs holds a bounded number.
 */
export function pruneLinks(links: Map<string, FoundLink>, max = PR_LINKS_MAX): void {
  const sorted = [...links.values()].sort(newestFirst);
  let strong = 0;
  let mentioned = 0;
  for (const link of sorted) {
    const keep = link.kind === 'mentioned' ? ++mentioned <= max : ++strong <= max;
    if (!keep) links.delete(linkKey(link));
  }
}

/** A found link as SessionSummary.prLinks carries it. */
export function toPrLink(link: FoundLink): PrLink {
  const lastAt = new Date(link.at).toISOString();
  return link.kind === 'pushed'
    ? { kind: link.kind, repo: link.repo, branch: link.branch ?? '', lastAt }
    : { kind: link.kind, repo: link.repo, number: link.number ?? 0, lastAt };
}
