// PR links (M4, W94): what in a transcript links a session to a pull request (PrLink), for the
// worked-in scanner (workedIn.ts), which reads every session's transcript and its sub-agents' and
// finds these in the same pass. Pure: it reads no files and runs nothing. The index doesn't know
// which PRs are open; the web UI matches the links against the PR list (prLinkMatches()).
//
// The five kinds (PrLinkKind), each from its own place, since a PR URL anywhere in a transcript
// would link the wrong sessions (`gh pr list`'s output names many):
// - opened: a successful result of a call that creates a PR: a failed `gh pr create` prints the
//   URL of the PR that already exists. For a Bash `gh pr create` (or `gh pr new`), each line of its
//   output that is a PR URL and nothing else, as gh prints the new PR's. For a GitHub MCP tool whose
//   name ends in `create_pull_request`, a JSON result's `html_url`, else its `url`: the GitHub MCP
//   server returns only `url`, and older releases the whole PR, whose `body` comes before
//   `html_url` and may name other PRs. A result that isn't JSON gives its first PR URL.
// - pushed: the result of a Bash `git push`, failed ones included, since git marks each ref: each
//   `To <remote>` line naming a GitHub repo, and the ref lines under it for a new branch, a
//   fast-forward or a forced update. Rejected (atomic failures too), deleted and up-to-date refs,
//   tags, other refs, and a later `git fetch` or `git pull`'s lines, after `From`, are left out.
// - prompted: a PR URL in a prompt you typed, by the rule behind lastUserPrompt (promptTextOf()),
//   in the main transcript: a sub-agent's prompts are its parent's.
// - linked: Claude Code's own `pr-link` entry (M4 redesign, W105), `{"type":"pr-link","prNumber",
//   "prRepository","prUrl","sessionId","timestamp"}`, in any of the session's files: Claude Code
//   writes a sub-agent's in its parent's transcript. Internal, so read defensively (claudeLinkOf()):
//   kept only when its URL is exactly https://github.com/<owner>/<name>/pull/<n> for the repo and
//   number it names, by the contract's patterns, its time is one, and it's the session's own.
// - mentioned: a PR URL in Claude's own text blocks in the main transcript.
// A call's input and every other tool result count for nothing.
//
// Caps (W105): strong links up to PR_LINKS_STRONG_MAX and mentioned ones up to PR_LINKS_MAX, each
// the newest of its own, so mentions never push out a strong link, nor strong links a mention.
//
// Every step is linear in the text's size, and ref lines over MAX_OUTPUT_LINE aren't read: the
// scanner runs these on the main thread.

import {
  GITHUB_OWNER_PATTERN,
  GITHUB_REPO_NAME_PATTERN,
  PR_LINKS_MAX,
  PR_LINKS_STRONG_MAX,
  type PrLink,
  type PrLinkKind,
} from '../shared/protocol.js';
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
 * `https://github.com/<owner>/<name>/pull/<n>`, and the same with a tab (`/changes`, the Files
 * changed tab since January 2026, `/files`, as it was, `/commits` and `/checks`, with a commit's sha
 * after any of them), a trailing `/`, `#...` or `?...`. Not a longer path, such as
 * `/pull/12/merge`, nor `/pull/12.diff`. Bounded, so it's linear.
 */
const PR_URL =
  /(?<![\w.+-])https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})(?:\/(?:files|commits|checks|changes)(?:\/[0-9a-f]{7,40})?)?\/?(?![\w/-]|\.\w)/g;
/** The same, as a whole line or field: what `gh pr create` prints and a PR's `html_url` holds. */
const PR_URL_LINE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})$/;
/** `To <remote>`, the line git push writes before a remote's ref lines. */
const TO_LINE = /^To (\S+)$/;
/** `From <remote>`, the line git fetch and git pull write before theirs, which aren't pushes. */
const FROM_LINE = /^From \S/;
/**
 * A ref line: its flag, summary, `from -> to`, and an optional `(reason)`. The flag is ` ` for a
 * fast-forward, `+` forced, `*` new, `-` deleted, `!` rejected and `=` up to date.
 */
const REF_LINE = /^\s*(?:([+*=!-])\s+)?(\[[a-z ]{1,40}\]|[0-9a-f]{4,64}\.\.\.?[0-9a-f]{4,64})\s+(\S{1,255}) -> (\S{1,255})(?: \(.{1,200}\))?$/;
const HASH_RANGE = /^[0-9a-f]+\.\.\.?[0-9a-f]+$/;
/** A `pr-link` entry's `prRepository`, by the contract's patterns. */
const LINK_REPO = new RegExp(`^(${GITHUB_OWNER_PATTERN})/(${GITHUB_REPO_NAME_PATTERN})$`);
/** A `pr-link` entry's `prUrl`: exactly a PR's URL, nothing before or after. */
const LINK_URL = new RegExp(`^https://github\\.com/(${GITHUB_OWNER_PATTERN})/(${GITHUB_REPO_NAME_PATTERN})/pull/([1-9][0-9]{0,9})$`);

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

/**
 * The PR a GitHub MCP create-pull-request tool's result names: a JSON object's `html_url`, else its
 * `url`, when it's a PR URL and nothing else, as the GitHub MCP server returns `{ id, url }` and
 * older releases the whole PR, with its `body` before `html_url`. Only for a result that isn't
 * JSON, the first PR URL in it.
 */
export function openedByMcp(output: string): PrRef[] {
  if (!mayNamePr(output)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    for (const match of output.matchAll(PR_URL)) {
      const ref = prRef(match[1] ?? '', match[2] ?? '', match[3] ?? '');
      if (ref !== undefined) return [ref];
    }
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const fields = parsed as Record<string, unknown>;
  for (const value of [fields.html_url, fields.url]) {
    const match = typeof value === 'string' ? PR_URL_LINE.exec(value) : null;
    const ref = match ? prRef(match[1] ?? '', match[2] ?? '', match[3] ?? '') : undefined;
    if (ref !== undefined) return [ref];
  }
  return [];
}

/**
 * The branches a `git push`'s output says it pushed, to which GitHub repos: under each `To` line
 * that names one, the ref lines for a new branch (`* [new branch]`), a fast-forward (`a1..b2`) or a
 * forced update (`+ a1...b2`). The branch is the right-hand side, without `refs/heads/`; a ref
 * outside `refs/heads/` isn't a branch. Rejected (`[rejected]`, `[remote rejected]`, an atomic
 * push's), deleted, up to date and new tag lines are left out, and "Everything up-to-date" has no
 * ref lines. A `To` line for a remote that isn't GitHub's leaves out the ref lines under it, and a
 * `From` line, as a `git pull` after the push writes, those under it.
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
    if (FROM_LINE.test(line)) {
      repo = undefined;
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

/**
 * How a line holding a `pr-link` entry starts: all 10,440 of Claude Code's on 2026-10-29 did, with
 * `type` first, 206 to 264 bytes each. The scanner tests only a line's start, which costs the same
 * whatever its length, so it never searches inside one. One with its keys in another order isn't
 * read, and W94's links stand in for it.
 */
export const PR_LINK_PREFIX = '{"type":"pr-link"';

/**
 * The link a `pr-link` entry makes, Claude Code's own (PrLinkKind 'linked'), or undefined for any
 * other entry and for one that isn't well formed: `prUrl` must be exactly
 * `https://github.com/<owner>/<name>/pull/<n>` (GITHUB_OWNER_PATTERN, GITHUB_REPO_NAME_PATTERN, but
 * not `.` or `..`), naming the repo `prRepository` names, in any case, and the number `prNumber`
 * is, a positive whole number; `timestamp` a time. When `sessionId` is given, the entry's must be
 * it, so a link copied from another session's transcript isn't this one's. The repo is lowercase.
 */
export function claudeLinkOf(entry: Record<string, unknown>, sessionId?: string): FoundLink | undefined {
  if (entry.type !== 'pr-link') return undefined;
  if (sessionId !== undefined && entry.sessionId !== sessionId) return undefined;
  const { prNumber, prRepository, prUrl, timestamp } = entry;
  if (typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber <= 0) return undefined;
  if (typeof prRepository !== 'string' || typeof prUrl !== 'string' || typeof timestamp !== 'string') return undefined;
  const repo = LINK_REPO.exec(prRepository);
  const url = LINK_URL.exec(prUrl);
  if (!repo || !url) return undefined;
  const name = repo[2] ?? '';
  if (name === '.' || name === '..' || NOT_OWNERS.has((repo[1] ?? '').toLowerCase())) return undefined;
  const slug = prRepository.toLowerCase();
  if (`${url[1]}/${url[2]}`.toLowerCase() !== slug || Number(url[3]) !== prNumber) return undefined;
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at) || at <= 0) return undefined;
  return { kind: 'linked', repo: slug, number: prNumber, at };
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

const KIND_ORDER: Readonly<Record<PrLinkKind, number>> = { opened: 0, pushed: 1, linked: 2, prompted: 3, mentioned: 4 };

/** Newest first; ties by kind, repo, then number or branch, so the order never flips between scans. */
function newestFirst(a: FoundLink, b: FoundLink): number {
  return b.at - a.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || order(a.repo, b.repo) || (a.number ?? 0) - (b.number ?? 0) || order(a.branch ?? '', b.branch ?? '');
}

function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The links to keep, newest first: the newest `strongMax` strong links (prLinkIsStrong()) and the
 * newest `mentionedMax` mentioned ones, each cap on its own (W105), so neither kind crowds out the
 * other.
 */
export function newestLinks(links: Iterable<FoundLink>, strongMax = PR_LINKS_STRONG_MAX, mentionedMax = PR_LINKS_MAX): FoundLink[] {
  let strong = 0;
  let mentioned = 0;
  return [...links].sort(newestFirst).filter((link) => (link.kind === 'mentioned' ? ++mentioned <= mentionedMax : ++strong <= strongMax));
}

/**
 * Drops what newestLinks() could never keep from one file's links: beyond the newest `strongMax`
 * strong links and the newest `mentionedMax` mentioned ones. Merging files' pruned links then keeps
 * what merging them whole would, so a transcript that names thousands of PRs holds a bounded number.
 */
export function pruneLinks(links: Map<string, FoundLink>, strongMax = PR_LINKS_STRONG_MAX, mentionedMax = PR_LINKS_MAX): void {
  const kept = new Set(newestLinks(links.values(), strongMax, mentionedMax));
  for (const [key, link] of links) if (!kept.has(link)) links.delete(key);
}

/** A found link as SessionSummary.prLinks carries it. */
export function toPrLink(link: FoundLink): PrLink {
  const lastAt = new Date(link.at).toISOString();
  return link.kind === 'pushed'
    ? { kind: link.kind, repo: link.repo, branch: link.branch ?? '', lastAt }
    : { kind: link.kind, repo: link.repo, number: link.number ?? 0, lastAt };
}
