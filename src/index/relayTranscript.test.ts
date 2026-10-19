// The relay transcript adapter, against synthetic JSONL in a temporary config
// directory. The entries copy the shapes Claude Code v2.1.301 wrote in spike
// 003; the text is made up.
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRelayTranscriptTail, eventOfLine, noticeOf } from './relayTranscript.js';
import { encodeProjectDir } from './transcripts.js';

const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';
const CWD = '/Users/someone/.pitwall/relay';
const MSG = 'c8db9aeb-24ab-4c92-9166-3a7e5b173983';

const held = `[Cross-session delivery notice] Your message to another session was held by that session (recipient: uds:/tmp/cc-socks/1.sock; msg_id: ${MSG}). NOT delivered: its Claude has not seen it. Another notice follows on release, denial or expiry.`;
const refused = `[Cross-session delivery notice] Your message to another session was refused (recipient: uds:/tmp/cc-socks/2.sock; msg_id: ${MSG}): that session is not accepting cross-session messages.`;

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const enqueue = (content: string) => line({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-19T10:00:01.000Z', content });
const metaUser = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', isMeta: true, timestamp: '2026-10-19T10:00:02.000Z', message: { role: 'user', content }, ...extra });
const peer = (body: string, pid: number | null = 4242, name = 'pitwall-test-target') =>
  metaUser(`Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/${pid}.sock" from-name="${name}">\n${body}\n</cross-session-message>`, {
    origin: { kind: 'peer', from: `uds:/tmp/cc-socks/${pid}.sock`, ...(pid === null ? {} : { verifiedPeerPid: pid }), name, msg_id: 'x', body },
  });

describe('noticeOf', () => {
  it('reads held and refused notices, with their msg_id', () => {
    expect(noticeOf(held)).toEqual({ kind: 'notice', msgId: MSG, outcome: 'held' });
    expect(noticeOf(refused, '2026-10-19T10:00:01.000Z')).toEqual({ kind: 'notice', msgId: MSG, outcome: 'refused', at: '2026-10-19T10:00:01.000Z' });
  });

  it('matches later notices by their words, without reading the held notice’s “release, denial or expiry” as one', () => {
    expect(noticeOf(`[Cross-session delivery notice] Your held message expired undelivered (msg_id: ${MSG}).`)?.outcome).toBe('expired');
    expect(noticeOf(`[Cross-session delivery notice] Your held message was released and delivered (msg_id: ${MSG}).`)?.outcome).toBe('released');
    expect(noticeOf(`[Cross-session delivery notice] The user denied your message (msg_id: ${MSG}).`)?.outcome).toBe('denied');
    expect(noticeOf(`[Cross-session delivery notice] Something new (msg_id: ${MSG}).`)?.outcome).toBe('other');
  });

  it('ignores anything that isn’t a notice, or has no msg_id', () => {
    expect(noticeOf('hello')).toBeUndefined();
    expect(noticeOf('[Cross-session delivery notice] no id here')).toBeUndefined();
  });
});

describe('eventOfLine', () => {
  it('reads a notice from the queue and from the meta user entry', () => {
    expect(eventOfLine(enqueue(held))).toMatchObject({ kind: 'notice', outcome: 'held', msgId: MSG });
    expect(eventOfLine(metaUser(refused))).toMatchObject({ kind: 'notice', outcome: 'refused' });
    expect(eventOfLine(metaUser([{ type: 'text', text: refused }]))).toMatchObject({ kind: 'notice', outcome: 'refused' });
  });

  it('reads a peer message’s body, verified pid and name', () => {
    expect(eventOfLine(peer('echo: done'))).toEqual({ kind: 'peer', pid: 4242, name: 'pitwall-test-target', body: 'echo: done', at: '2026-10-19T10:00:02.000Z' });
    expect(eventOfLine(peer('no pid', null))).toEqual({ kind: 'peer', name: 'pitwall-test-target', body: 'no pid', at: '2026-10-19T10:00:02.000Z' });
  });

  it('ignores a peer message’s queue entry, which has no verified pid, and the relay’s own prompts', () => {
    expect(eventOfLine(enqueue('<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="peer">x</cross-session-message>'))).toBeUndefined();
    expect(eventOfLine(line({ type: 'user', message: { content: held } }))).toBeUndefined();
    expect(eventOfLine(line({ type: 'assistant', message: { content: [{ type: 'text', text: held }] } }))).toBeUndefined();
  });

  it('fails soft on lines it can’t read', () => {
    expect(eventOfLine('{"type":"user","peer"')).toBeUndefined();
    expect(eventOfLine('[]')).toBeUndefined();
    expect(eventOfLine(line({ type: 'user', isMeta: true, origin: { kind: 'peer', verifiedPeerPid: 'x', body: 7 } }))).toBeUndefined();
  });
});

describe('createRelayTranscriptTail', () => {
  let config: string;
  let file: string;

  beforeEach(async () => {
    config = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-relay-transcript-'));
    file = path.join(config, 'projects', encodeProjectDir(CWD), `${SESSION}.jsonl`);
  });

  afterEach(async () => {
    await rm(config, { recursive: true, force: true });
  });

  it('gives nothing until the file exists, then only what’s new on each read', async () => {
    const tail = createRelayTranscriptTail({ sessionId: SESSION, cwd: CWD, configDir: config });
    expect(await tail.read()).toEqual([]);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, line({ type: 'api-request', big: 'x'.repeat(1000) }) + enqueue(held));
    expect(await tail.read()).toEqual([expect.objectContaining({ kind: 'notice', outcome: 'held' })]);
    expect(await tail.read()).toEqual([]);
    await appendFile(file, peer('first'));
    // Half a line: kept until the rest arrives.
    const second = peer('second');
    await appendFile(file, second.slice(0, 40));
    expect(await tail.read()).toEqual([expect.objectContaining({ kind: 'peer', body: 'first' })]);
    await appendFile(file, second.slice(40));
    expect(await tail.read()).toEqual([expect.objectContaining({ kind: 'peer', body: 'second' })]);
  });

  it('finds the file in another project directory, as when a long path is hashed', async () => {
    const elsewhere = path.join(config, 'projects', 'hashed-name-1234', `${SESSION}.jsonl`);
    await mkdir(path.dirname(elsewhere), { recursive: true });
    await writeFile(elsewhere, enqueue(refused));
    const tail = createRelayTranscriptTail({ sessionId: SESSION, cwd: CWD, configDir: config });
    expect(await tail.read()).toEqual([expect.objectContaining({ kind: 'notice', outcome: 'refused' })]);
  });

  it('reads at most maxReadBytes of a backlog, from a line boundary', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, peer('old one') + line({ type: 'filler', x: 'y'.repeat(4000) }) + peer('new one'));
    const tail = createRelayTranscriptTail({ sessionId: SESSION, cwd: CWD, configDir: config, maxReadBytes: 1000 });
    expect(await tail.read()).toEqual([expect.objectContaining({ body: 'new one' })]);
  });

  it('starts again when the file is replaced', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, peer('one'));
    const tail = createRelayTranscriptTail({ sessionId: SESSION, cwd: CWD, configDir: config });
    expect(await tail.read()).toHaveLength(1);
    await rm(file);
    await writeFile(file, peer('two'));
    expect(await tail.read()).toEqual([expect.objectContaining({ body: 'two' })]);
  });

  it('starts again when the file is rewritten in place, with the same inode and size', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, enqueue(held));
    const tail = createRelayTranscriptTail({ sessionId: SESSION, cwd: CWD, configDir: config });
    expect(await tail.read()).toHaveLength(1);
    // Same length, different end: writeFile truncates and rewrites the same inode.
    await writeFile(file, enqueue(held.replace('denial or expiry.', 'DENIAL OR EXPIRY.')));
    expect(await tail.read()).toEqual([expect.objectContaining({ kind: 'notice', outcome: 'held' })]);
  });

  it('doesn’t take a short file that grew for a rewritten one', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{}\n');
    const tail = createRelayTranscriptTail({ sessionId: SESSION, cwd: CWD, configDir: config });
    expect(await tail.read()).toEqual([]);
    await appendFile(file, peer('later'));
    expect(await tail.read()).toEqual([expect.objectContaining({ body: 'later' })]);
    expect(await tail.read()).toEqual([]);
  });

  it('refuses a session id that could escape the projects directory', async () => {
    const tail = createRelayTranscriptTail({ sessionId: '../../etc/passwd', cwd: CWD, configDir: config });
    expect(await tail.read()).toEqual([]);
  });
});
