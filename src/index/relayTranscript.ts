// Reads the relay's own transcript (W11, D8) for the two things its
// stream-json output doesn't carry: delivery notices, which say a message
// was held or refused, and replies from the sessions it messaged. Both
// arrive as peer messages, which start a turn on stdout but don't show
// their text there (spike 003).
//
// Transcript JSONL is an internal Claude Code format, so this fails soft:
// a missing file, a line that doesn't parse or an entry of another shape
// gives nothing, never an exception. What it reads (Claude Code v2.1.301):
//
//   {"type":"queue-operation","operation":"enqueue","content":"[Cross-session delivery notice] ..."}
//   {"type":"user","isMeta":true,"message":{"content":"[Cross-session delivery notice] ..."}}
//   {"type":"user","isMeta":true,"origin":{"kind":"peer","verifiedPeerPid":123,"name":"...","body":"..."}}
//
// A notice names the message's msg_id, which SendMessage's result gave.
// A reply carries the sender's pid as Claude Code verified it, which is
// what ties it to a session, whatever name the sender uses.

import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from './guards.js';
import { defaultConfigDir, encodeProjectDir, isSafeSessionId } from './transcripts.js';

/** What a delivery notice said about the message with `msgId`. */
export type NoticeOutcome = 'held' | 'refused' | 'expired' | 'released' | 'denied' | 'other';

export interface NoticeEvent {
  kind: 'notice';
  msgId: string;
  outcome: NoticeOutcome;
  at?: string;
}

/** A message from another session. `pid` is the sender's, as Claude Code verified it, when it could. */
export interface PeerEvent {
  kind: 'peer';
  pid?: number;
  name?: string;
  body: string;
  at?: string;
}

export type RelayTranscriptEvent = NoticeEvent | PeerEvent;

export interface RelayTranscriptOptions {
  /** The relay's session id, from its stream-json `init` event. */
  sessionId: string;
  /** The relay's working directory, as its `init` event reports it. */
  cwd: string;
  /** Default `$CLAUDE_CONFIG_DIR`, or `~/.claude`. */
  configDir?: string;
  /** The most read in one call; anything older is skipped. Default 4 MiB. */
  maxReadBytes?: number;
}

export interface RelayTranscriptTail {
  /** The events written since the last call, oldest first. Never rejects. */
  read(): Promise<RelayTranscriptEvent[]>;
}

const NOTICE_PREFIX = '[Cross-session delivery notice]';
const MIB = 1024 * 1024;
/**
 * How many bytes before the read offset are remembered, to notice a file
 * rewritten in place with the same inode, as the conversation reader does.
 */
const FINGERPRINT_BYTES = 64;
/** How often a transcript that hasn't been found is searched for across every project. */
const SEARCH_EVERY_MS = 2000;
/** A peer message's body is kept up to this many characters; the relay keeps only 2 KiB of a reply. */
const BODY_KEEP = 16 * 1024;

export function createRelayTranscriptTail(options: RelayTranscriptOptions): RelayTranscriptTail {
  const projectsDir = path.join(options.configDir ?? defaultConfigDir(), 'projects');
  const maxReadBytes = options.maxReadBytes ?? 4 * MIB;
  const fileName = `${options.sessionId}.jsonl`;
  let file: string | undefined;
  let searchedAt = -Infinity;
  let offset = 0;
  let ino: number | undefined;
  /** The bytes just before `offset`, as last read. A file that only grew still has them there. */
  let fingerprint = Buffer.alloc(0);
  let carry = '';
  let skipToNewline = false;

  async function locate(): Promise<string | undefined> {
    if (file !== undefined) return file;
    if (!isSafeSessionId(options.sessionId)) return undefined;
    const candidate = path.join(projectsDir, encodeProjectDir(options.cwd), fileName);
    if (await isFile(candidate)) return (file = candidate);
    // A long directory name is truncated and hashed, so look everywhere, now and then.
    if (Date.now() - searchedAt < SEARCH_EVERY_MS) return undefined;
    searchedAt = Date.now();
    try {
      for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const found = path.join(projectsDir, entry.name, fileName);
        if (await isFile(found)) return (file = found);
      }
    } catch {
      // No projects directory yet.
    }
    return undefined;
  }

  return {
    async read() {
      try {
        const found = await locate();
        if (found === undefined) return [];
        let handle: FileHandle;
        try {
          handle = await open(found, 'r');
        } catch {
          file = undefined;
          return [];
        }
        try {
          const info = await handle.stat();
          if (!info.isFile()) return [];
          let rewritten = false;
          if (fingerprint.length > 0 && info.size >= offset) {
            const now = Buffer.alloc(fingerprint.length);
            await handle.read(now, 0, now.length, offset - fingerprint.length);
            rewritten = !now.equals(fingerprint);
          }
          if (ino !== info.ino || info.size < offset || rewritten) {
            // A new or rewritten file: start again from its beginning.
            ino = info.ino;
            offset = 0;
            carry = '';
            skipToNewline = false;
            fingerprint = Buffer.alloc(0);
          }
          if (info.size === offset) return [];
          let from = offset;
          if (info.size - from > maxReadBytes) {
            from = info.size - maxReadBytes;
            carry = '';
            skipToNewline = true;
          }
          const buffer = Buffer.alloc(info.size - from);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
          offset = from + bytesRead;
          const kept = Math.min(FINGERPRINT_BYTES, offset);
          fingerprint = Buffer.from(bytesRead >= kept ? buffer.subarray(bytesRead - kept, bytesRead) : await readAt(handle, offset - kept, kept));
          return consume(buffer.subarray(0, bytesRead).toString('utf8'));
        } finally {
          await handle.close().catch(() => undefined);
        }
      } catch {
        return [];
      }
    },
  };

  function consume(chunk: string): RelayTranscriptEvent[] {
    let text = carry + chunk;
    if (skipToNewline) {
      const newline = text.indexOf('\n');
      if (newline === -1) {
        carry = '';
        return [];
      }
      text = text.slice(newline + 1);
      skipToNewline = false;
    }
    const lines = text.split('\n');
    carry = lines.pop() ?? '';
    if (carry.length > maxReadBytes) {
      carry = '';
      skipToNewline = true;
    }
    const events: RelayTranscriptEvent[] = [];
    for (const line of lines) {
      const event = eventOfLine(line);
      if (event !== undefined) events.push(event);
    }
    return events;
  }
}

/** The event one transcript line holds, if any. */
export function eventOfLine(line: string): RelayTranscriptEvent | undefined {
  // Cheap pre-filter: the relay's transcript is mostly request records.
  if (!line.includes(NOTICE_PREFIX) && !line.includes('"peer"')) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry)) return undefined;
  const at = typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : undefined;

  if (entry.type === 'queue-operation') {
    if (entry.operation !== 'enqueue' || typeof entry.content !== 'string') return undefined;
    return noticeOf(entry.content, at);
  }
  if (entry.type !== 'user' || entry.isMeta !== true || entry.isSidechain === true) return undefined;

  const origin = entry.origin;
  if (isRecord(origin) && origin.kind === 'peer') {
    const body = typeof origin.body === 'string' ? origin.body : undefined;
    if (body === undefined) return undefined;
    const event: PeerEvent = { kind: 'peer', body: body.slice(0, BODY_KEEP) };
    const pid = origin.verifiedPeerPid;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) event.pid = pid;
    if (typeof origin.name === 'string' && origin.name !== '') event.name = origin.name.slice(0, 300);
    if (at !== undefined) event.at = at;
    return event;
  }
  const message = entry.message;
  if (!isRecord(message)) return undefined;
  const text = textOf(message.content);
  return text === undefined ? undefined : noticeOf(text, at);
}

/**
 * A delivery notice: its msg_id and what it says happened. Claude Code's
 * wording, as seen on v2.1.301:
 *   "... Your message to another session was held by that session (recipient: ...; msg_id: <id>). NOT delivered ..."
 *   "... Your message to another session was refused (recipient: ...; msg_id: <id>): ..."
 * The held notice says another follows "on release, denial or expiry"; those
 * weren't observed, so they're matched by those words and otherwise 'other'.
 */
export function noticeOf(text: string, at?: string): NoticeEvent | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(NOTICE_PREFIX)) return undefined;
  // Bounded, so a hostile notice can't make the patterns below slow.
  const head = trimmed.slice(0, 2000);
  const msgId = /msg_id:\s*([A-Za-z0-9-]{8,64})/.exec(head)?.[1];
  if (msgId === undefined) return undefined;
  const first = head.slice(NOTICE_PREFIX.length, head.indexOf(msgId));
  let outcome: NoticeOutcome = 'other';
  if (/\bwas held\b/i.test(first)) outcome = 'held';
  else if (/\bwas refused\b/i.test(first)) outcome = 'refused';
  else if (/\bexpired\b/i.test(first)) outcome = 'expired';
  else if (/\bdenied\b/i.test(first)) outcome = 'denied';
  else if (/\breleased\b|\bwas delivered\b/i.test(first)) outcome = 'released';
  const event: NoticeEvent = { kind: 'notice', msgId, outcome };
  if (at !== undefined) event.at = at;
  return event;
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return undefined;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
