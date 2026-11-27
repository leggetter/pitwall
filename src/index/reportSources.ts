// The transcript side of a worker's reports to its lead (W218 piece 2, spike 021), behind the adapter
// rules: transcript JSONL and the `SendMessage` tool call's shape are Claude Code's internal formats,
// so everything that reads them for reports is here and fails soft.
//
//   readNewestReport()  the newest `SendMessage` call in the last REPORT_TAIL_BYTES of a worker's
//                       transcript that is addressed to the lead's name and that Claude Code says went
//                       through: the call's `input.to`, trimmed, with a trailing ` [ref]` taken off,
//                       equal to the name ignoring case (cross-session messages are addressed by the
//                       name `ListAgents` prints, never a session id: spike 021, "Piece 2 checks"), and
//                       its result's `toolUseResult.success` true. Shapes seen on Claude Code 2.1.332:
//                         {"type":"assistant","timestamp":"…","message":{"content":[
//                           {"type":"tool_use","id":"toolu_…","name":"SendMessage","input":{"to":"<name>","message":"…"}}]}}
//                         {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_…",…}]},
//                          "toolUseResult":{"success":true,"message":"…","msg_id":"…"}}
//
// Nothing here returns the message or any other transcript text: only the call's time, as ISO 8601.

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isRecord } from './guards.js';

/** How much of a transcript's end is read: a report is usually among the session's last entries. */
export const REPORT_TAIL_BYTES = 1024 * 1024;
/** A line longer than this is skipped unread: a SendMessage call or its result is a few KiB. */
export const REPORT_LINE_MAX = 64 * 1024;
/** The longest `to` read; SendMessage takes up to 300 characters. */
const TO_MAX = 512;
/** The most calls held while their results are looked for. */
const PENDING_MAX = 256;
const SEND_MESSAGE = 'SendMessage';

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** A SendMessage `to` as the name it addresses: trimmed, without a trailing ` [ref]`, in lower case. */
export function addressedName(to: string): string {
  return to
    .trim()
    .replace(/\s*\[[0-9a-z]{1,32}\]$/i, '')
    .trim()
    .toLowerCase();
}

/** An ISO 8601 time, normalized, a future one read as `nowMs` (the review's F7, as leads.json does), or undefined. */
function timeOf(value: unknown, nowMs: number): string | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(Math.min(ms, nowMs)).toISOString();
}

/**
 * The time of the newest report to `leadName` in `text`, JSONL as Claude Code writes it, or undefined
 * when there's none. The first line is skipped when `cut` says the text starts mid-line. A time later
 * than `now` is read as `now`, so a transcript can't claim a report from the future. Pure.
 */
export function parseNewestReport(text: string, leadName: string, cut = false, now: () => Date = () => new Date()): string | undefined {
  const want = addressedName(leadName);
  const nowMs = now().getTime();
  if (want === '') return undefined;
  const pending = new Map<string, string>();
  let newest: string | undefined;
  const lines = text.split('\n');
  for (let index = cut ? 1 : 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.length === 0 || line.length > REPORT_LINE_MAX) continue;
    const call = line.includes(`"${SEND_MESSAGE}"`);
    const result = pending.size > 0 && line.includes('"tool_result"');
    if (!call && !result) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || !isRecord(entry.message) || !Array.isArray(entry.message.content)) continue;
    if (entry.type === 'assistant') {
      const at = timeOf(entry.timestamp, nowMs);
      if (at === undefined) continue;
      for (const block of entry.message.content) {
        if (!isRecord(block) || block.type !== 'tool_use' || block.name !== SEND_MESSAGE || typeof block.id !== 'string' || !isRecord(block.input)) continue;
        const to = block.input.to;
        if (typeof to !== 'string' || to.length > TO_MAX || addressedName(to) !== want) continue;
        if (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value as string);
        pending.set(block.id, at);
      }
    } else if (entry.type === 'user') {
      const sent = isRecord(entry.toolUseResult) && entry.toolUseResult.success === true;
      for (const block of entry.message.content) {
        if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const at = pending.get(block.tool_use_id);
        if (at === undefined) continue;
        pending.delete(block.tool_use_id);
        if (sent && block.is_error !== true && (newest === undefined || at >= newest)) newest = at;
      }
    }
  }
  return newest;
}

/**
 * The newest report to `leadName` in the transcript at `file`: `{ at }`, `{}` when there's none, or
 * undefined when the file couldn't be read as a regular file. Never rejects.
 */
export async function readNewestReport(file: string, leadName: string, now: () => Date = () => new Date()): Promise<{ at?: string } | undefined> {
  let handle;
  try {
    handle = await open(file, OPEN_FLAGS);
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const start = Math.max(0, info.size - REPORT_TAIL_BYTES);
    const size = info.size - start;
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const { bytesRead } = await handle.read(buffer, read, size - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const at = parseNewestReport(buffer.subarray(0, read).toString('utf8'), leadName, start > 0, now);
    return at === undefined ? {} : { at };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
