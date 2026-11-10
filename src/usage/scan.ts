// The usage report's transcript reads (W131): the token usage Claude Code records in its
// transcripts, `<config>/projects/<encoded cwd>/<sessionId>.jsonl`, with sub-agents' runs under
// `<sessionId>/subagents/`. Internal and undocumented, so every read fails soft: a line that isn't
// JSON, or an entry without the fields, is skipped and counted, never fatal.
//
// It keeps numbers only: token counts, the model, timestamps, a tool's name and a tool result's
// size in characters. Never a prompt, a message's text, a tool's input or output, or a file's
// contents, so nothing it returns can leak what a session said.
//
// Files are streamed line by line, since some are tens of MB, and a line is parsed only when it
// could be one of the entries read here, which skips the large request blobs.
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { isRecord } from '../index/guards.js';
import { setNameOf } from '../index/transcripts.js';

export interface CallRecord {
  /** The API response's `message.id`; the same response is written on several lines. */
  id: string;
  /** Milliseconds since the epoch. */
  at: number;
  model: string;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** False when the usage didn't split cache writes by TTL, so all of them count as 5-minute writes. */
  splitKnown: boolean;
  cacheRead: number;
  output: number;
  speed?: string | undefined;
  geo?: string | undefined;
  effort?: string | undefined;
  /** True for an `isSidechain` entry in a main session's file, the older place for a sub-agent's calls. */
  sidechain: boolean;
  /** A rough count of the tool results' tokens in the context this call sent: characters / 4 since the last compaction. */
  toolContext: number;
}

export interface ToolResultRecord {
  /** The `tool_use_id`, so a result copied into another file is counted once. */
  id: string;
  at: number;
  /** Characters of text the model was sent. */
  chars: number;
  images: number;
  /** The tool's name, from the call that asked for it, or undefined when it isn't in the file. */
  tool?: string | undefined;
}

export interface FileScan {
  file: string;
  /** The session id: the file's name for a main session, its parent's for a sub-agent's run. */
  sessionId: string;
  subagent: boolean;
  /** A sub-agent's type, from its `.meta.json`, when it's a plain name. */
  agentType?: string | undefined;
  cwd?: string | undefined;
  /** Names the session was given with `--name`, used only to tell pitwall's own calls apart. */
  names: string[];
  calls: CallRecord[];
  toolResults: ToolResultRecord[];
  lines: number;
  parsed: number;
  malformed: number;
  noTimestamp: number;
  outsideWindow: number;
  noUsage: number;
  synthetic: number;
  /** Lines repeating a response already seen in this file. */
  sameFileDuplicates: number;
  /** Repeats whose usage differed from the first; the larger output is kept. */
  usageDiffered: number;
  unreadable: boolean;
}

export interface FoundFile {
  file: string;
  sessionId: string;
  subagent: boolean;
  mtimeMs: number;
  /** Its size in bytes and inode, when found by findTranscripts(), so the ledger can tell it grew or was replaced. */
  size?: number;
  ino?: number;
}

export interface FindResult {
  files: FoundFile[];
  /** Files skipped because they were last written before the window. */
  olderThanWindow: number;
  /** Directories or files that couldn't be listed or stat'ed. */
  unreadable: number;
}

const SESSION_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,79}$/;

/**
 * Every transcript under `projectsDir` written to since `since`: each project's `<id>.jsonl`, and
 * each `.jsonl` under a session's `subagents/` folder, at any depth. Symlinks aren't followed.
 */
export async function findTranscripts(projectsDir: string, since: number): Promise<FindResult> {
  const result: FindResult = { files: [], olderThanWindow: 0, unreadable: 0 };
  const list = async (dir: string) => {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      result.unreadable++;
      return [];
    }
  };
  const consider = async (file: string, sessionId: string, subagent: boolean) => {
    try {
      const info = await stat(file);
      if (info.mtimeMs < since) result.olderThanWindow++;
      else result.files.push({ file, sessionId, subagent, mtimeMs: info.mtimeMs, size: info.size, ino: info.ino });
    } catch {
      result.unreadable++;
    }
  };
  const walkSubagents = async (dir: string, sessionId: string) => {
    for (const entry of await list(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walkSubagents(full, sessionId);
      else if (entry.isFile() && SESSION_FILE.test(entry.name)) await consider(full, sessionId, true);
    }
  };
  for (const project of await list(projectsDir)) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(projectsDir, project.name);
    for (const entry of await list(projectDir)) {
      const full = path.join(projectDir, entry.name);
      if (entry.isFile() && SESSION_FILE.test(entry.name)) {
        await consider(full, entry.name.slice(0, -'.jsonl'.length), false);
      } else if (entry.isDirectory()) {
        const subagents = path.join(full, 'subagents');
        try {
          if ((await stat(subagents)).isDirectory()) await walkSubagents(subagents, entry.name);
        } catch {
          // No sub-agents for this session.
        }
      }
    }
  }
  result.files.sort((a, b) => a.file.localeCompare(b.file));
  return result;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function plainName(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_NAME.test(value) ? value : undefined;
}

/** A tool result's size: characters of text and the number of images, never the text itself. */
function resultSize(content: unknown): { chars: number; images: number } {
  if (typeof content === 'string') return { chars: content.length, images: 0 };
  let chars = 0;
  let images = 0;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length;
      else if (block.type === 'image') images++;
    }
  }
  return { chars, images };
}

export async function agentTypeOf(file: string): Promise<string | undefined> {
  try {
    const meta: unknown = JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return isRecord(meta) ? plainName(meta.agentType) : undefined;
  } catch {
    return undefined;
  }
}

export const MARKERS = ['"assistant"', '"tool_result"', '"custom-title"', '"agent-name"', 'isCompactSummary', 'compact_boundary'];

/**
 * One transcript's reading so far, fed a line at a time: scanTranscript() feeds it a whole file, and
 * the Usage view's ledger (W158, ledger.ts) feeds it what's new since its last read, so each file is
 * read on from where the last read stopped. `scan` is up to date after every line.
 */
export interface TranscriptState {
  scan: FileScan;
  /** One line, without its newline. */
  feed(line: string): void;
  /**
   * Drops the calls and tool results before `cutoff`, and their ids, so a file followed for weeks
   * holds only what a window can still ask for.
   */
  prune(cutoff: number): void;
}

/** An empty reading of `found`, keeping only the entries at or after `since` and before `until`. */
export function createTranscriptState(found: FoundFile, since: number, until: number = Number.POSITIVE_INFINITY, agentType?: string): TranscriptState {
  const scan: FileScan = {
    file: found.file,
    sessionId: found.sessionId,
    subagent: found.subagent,
    ...(agentType === undefined ? {} : { agentType }),
    names: [],
    calls: [],
    toolResults: [],
    lines: 0,
    parsed: 0,
    malformed: 0,
    noTimestamp: 0,
    outsideWindow: 0,
    noUsage: 0,
    synthetic: 0,
    sameFileDuplicates: 0,
    usageDiffered: 0,
    unreadable: false,
  };
  const byId = new Map<string, CallRecord>();
  const toolNames = new Map<string, string>();
  const names = new Set<string>();
  let toolChars = 0;

  function feed(line: string): void {
    scan.lines++;
    if (!MARKERS.some((marker) => line.includes(marker))) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      scan.malformed++;
      return;
    }
    if (!isRecord(entry)) {
      scan.malformed++;
      return;
    }
    scan.parsed++;
    const name = setNameOf(entry);
    if (name !== undefined && !names.has(name)) {
      names.add(name);
      scan.names = [...names];
    }
    if (scan.cwd === undefined && typeof entry.cwd === 'string' && path.isAbsolute(entry.cwd)) scan.cwd = entry.cwd;
    if (entry.isCompactSummary === true || (entry.type === 'system' && entry.subtype === 'compact_boundary')) {
      toolChars = 0;
      return;
    }
    const message = entry.message;
    if (!isRecord(message)) return;

    if (entry.type === 'assistant') {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string') {
            toolNames.set(block.id, plainName(block.name) ?? 'other');
          }
        }
      }
      if (typeof message.id !== 'string' || message.id === '') return;
      if (message.model === '<synthetic>') {
        scan.synthetic++;
        return;
      }
      const usage = message.usage;
      if (!isRecord(usage) || typeof message.model !== 'string' || message.model === '') {
        scan.noUsage++;
        return;
      }
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
      if (!Number.isFinite(at)) {
        scan.noTimestamp++;
        return;
      }
      const writes = count(usage.cache_creation_input_tokens);
      const split = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
      const write1h = split === undefined ? 0 : Math.min(count(split.ephemeral_1h_input_tokens), writes);
      const call: CallRecord = {
        id: message.id,
        at,
        model: message.model,
        input: count(usage.input_tokens),
        cacheWrite5m: writes - write1h,
        cacheWrite1h: write1h,
        splitKnown: split !== undefined || writes === 0,
        cacheRead: count(usage.cache_read_input_tokens),
        output: count(usage.output_tokens),
        speed: typeof usage.speed === 'string' ? usage.speed : undefined,
        geo: typeof usage.inference_geo === 'string' ? usage.inference_geo : undefined,
        effort: plainName(entry.effort),
        sidechain: entry.isSidechain === true,
        toolContext: Math.round(toolChars / 4),
      };
      const seen = byId.get(call.id);
      if (seen !== undefined) {
        scan.sameFileDuplicates++;
        if (seen.input !== call.input || seen.cacheRead !== call.cacheRead || seen.output !== call.output || seen.cacheWrite5m + seen.cacheWrite1h !== writes) {
          scan.usageDiffered++;
          if (call.output > seen.output) Object.assign(seen, { ...call, toolContext: seen.toolContext, at: seen.at });
        }
        return;
      }
      byId.set(call.id, call);
      if (at < since || at >= until) {
        scan.outsideWindow++;
        return;
      }
      scan.calls.push(call);
      return;
    }

    if (entry.type === 'user' && Array.isArray(message.content)) {
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const size = resultSize(block.content);
        toolChars += size.chars;
        if (!Number.isFinite(at)) {
          scan.noTimestamp++;
          continue;
        }
        if (at < since || at >= until) continue;
        scan.toolResults.push({ id: block.tool_use_id, at, chars: size.chars, images: size.images, tool: toolNames.get(block.tool_use_id) });
      }
    }
  }

  function prune(cutoff: number): void {
    if (scan.calls.some((call) => call.at < cutoff)) {
      const kept: CallRecord[] = [];
      for (const call of scan.calls) {
        if (call.at >= cutoff) kept.push(call);
        else byId.delete(call.id);
      }
      scan.calls = kept;
    }
    for (const [id, call] of byId) if (call.at < cutoff) byId.delete(id);
    if (scan.toolResults.some((result) => result.at < cutoff)) scan.toolResults = scan.toolResults.filter((result) => result.at >= cutoff);
    since = Math.max(since, cutoff);
  }

  return { scan, feed, prune };
}

/** Reads one transcript, keeping only the entries at or after `since` and before `until`. */
export async function scanTranscript(found: FoundFile, since: number, until: number = Number.POSITIVE_INFINITY): Promise<FileScan> {
  const state = createTranscriptState(found, since, until, found.subagent ? await agentTypeOf(found.file) : undefined);
  try {
    const lines = createInterface({ input: createReadStream(found.file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) state.feed(line);
  } catch {
    state.scan.unreadable = true;
  }
  return state.scan;
}
