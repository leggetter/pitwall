// Attachments (W79): the upload route through the real HTTP server and its
// /api/* checks, the store and its clean-up, and spawn's argv with a fake
// command runner, so no test ever runs `claude`. Every pitwall home is a
// fresh temporary folder, never the real ~/.pitwall.
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentsResult } from '../index/agents.js';
import type { Indexer } from '../index/index.js';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  ATTACHMENTS_MAX_PENDING,
  ATTACHMENTS_MAX_PER_SESSION,
  ATTACHMENTS_PATH,
  attachmentPath,
  SPAWN_PATH,
  WS_PATH,
  type AttachmentResult,
  type AttachmentType,
  type IndexSnapshot,
  type ServerMessage,
  type SpawnResult,
} from '../shared/protocol.js';
import { MAX_PROMPT_LENGTH, spawnArgs, type ActionOptions } from './actions.js';
import {
  ATTACHMENT_NAME_MAX,
  AttachmentStore,
  attachmentName,
  attachmentType,
  storedName,
  TypeCheck,
  UNUSED_TTL_MS,
  USED_MARKER,
  USED_TTL_MS,
} from './attachments.js';
import type { CommandOptions, CommandResult, RunCommand } from './command.js';
import type { RunningServer } from './index.js';
import { startServerWithInternals, type ServerInternals } from './server.js';
import { pitwallOrigin, proofFor } from '../test/proof.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** What every stored name must look like: a slug, then an extension. */
const STORED = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.[a-z0-9]{1,16}$/;

// ---------------------------------------------------------------- fixtures

let tmp: string;
let root: string;
let repo: string;
let webRoot: string;
let n = 0;

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-test-attachments-')));
  root = join(tmp, 'root');
  repo = join(root, 'repo');
  webRoot = join(tmp, 'web');
  await mkdir(repo, { recursive: true });
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A path for a pitwall home that doesn't exist yet, in the temp folder. */
const freshHome = () => join(tmp, `home-${++n}`);

const ascii = (text: string) => Buffer.from(text, 'latin1');

/** The first bytes of each type, and a little more: enough for the checks, which read signatures only. */
const SAMPLES: Record<AttachmentType, Buffer> = {
  'image/png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ascii('\0\0\0\rIHDR\0\0\0\x01')]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  'image/gif': ascii('GIF89a\x01\0\x01\0\x80\0\0'),
  'image/webp': ascii('RIFF\x24\0\0\0WEBPVP8 '),
  'application/pdf': ascii('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'),
  'text/plain': Buffer.from('hello, world\n', 'utf8'),
  'text/markdown': Buffer.from('# Notes\n\n- café ☕\n', 'utf8'),
  'text/csv': Buffer.from('a,b\n1,2\n', 'utf8'),
  'application/json': Buffer.from('{"ok":true}\n', 'utf8'),
};

const EXTENSIONS: Record<AttachmentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
};

function snapshot(): IndexSnapshot {
  return { generatedAt: '2026-10-28T00:00:00.000Z', roots: [root], groups: [], source: { ok: true } };
}

function fakeIndexer(): Indexer {
  return {
    latest: () => snapshot(),
    subscribe: () => () => {},
    conversation: async () => undefined,
    subagents: async () => undefined,
    subagentConversation: async () => undefined,
    pollSoon: vi.fn(),
    noteRestart: vi.fn(),
    stop: () => {},
  };
}

function fakeAgents(result: AgentsResult = { ok: true, rows: [] }) {
  return { list: vi.fn(async () => result) };
}

interface Call {
  file: string;
  args: readonly string[];
  options: CommandOptions;
}

/** A runner that records each call and answers with the next of `answers`, the last one again after that. */
function fakeRunner(...answers: Array<CommandResult | (() => Promise<CommandResult>)>): RunCommand & { calls: Call[] } {
  const calls: Call[] = [];
  let next = 0;
  const run = vi.fn(async (file: string, args: readonly string[], options: CommandOptions) => {
    calls.push({ file, args, options });
    const answer = answers[Math.min(next, answers.length - 1)];
    next += 1;
    if (!answer) throw new Error('no answer');
    return typeof answer === 'function' ? answer() : answer;
  });
  return Object.assign(run, { calls });
}

const exited = (code: number, stdout = '', stderr = ''): CommandResult => ({ kind: 'exited', code, stdout, stderr });
const backgrounded = (id = 'c0ffee12', name = 'pitwall-test-attachments') => exited(0, `backgrounded · ${id} · ${name}\n`);

// ---------------------------------------------------------------- clients

const running: RunningServer[] = [];
const stores: AttachmentStore[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

interface Started {
  server: RunningServer;
  apiKey: string;
  run: ReturnType<typeof fakeRunner>;
  home: string | undefined;
}

interface StartOptions {
  home?: string | undefined;
  run?: ReturnType<typeof fakeRunner>;
  actions?: ActionOptions;
  attachments?: ServerInternals['attachments'];
}

async function start(options: StartOptions = {}): Promise<Started> {
  const home = 'home' in options ? options.home : freshHome();
  const run = options.run ?? fakeRunner(backgrounded());
  const server = await startServerWithInternals(
    { indexer: fakeIndexer(), token: TOKEN, webRoot, port: 0, ...(home === undefined ? {} : { pitwallHome: home }) },
    { actions: { run, env: {}, agents: fakeAgents(), ...options.actions }, ...(options.attachments ? { attachments: options.attachments } : {}) },
  );
  running.push(server);
  return { server, apiKey: await apiKeyOf(server.port), run, home };
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  json: unknown;
}

function send(port: number, path: string, body: Buffer | string | undefined, headers: Record<string, string>, method = 'POST'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const origin = (port: number) => `http://127.0.0.1:${port}`;

/** The apiKey and this server's Origin, as the web UI sends them. */
const asPage = (started: Started) => ({ authorization: `Bearer ${started.apiKey}`, origin: origin(started.server.port) });

/** Uploads `bytes` as the web UI does: its type, its name URL-encoded, the apiKey and this Origin. */
function upload(started: Started, bytes: Buffer, type: string | null = 'text/plain', name: string | null = 'notes.txt', extra: Record<string, string> = {}) {
  return send(started.server.port, ATTACHMENTS_PATH, bytes, {
    ...asPage(started),
    // null for none: the header is left out.
    ...(type === null ? {} : { 'content-type': type }),
    ...(name === null ? {} : { 'x-pitwall-filename': encodeURIComponent(name) }),
    ...extra,
  });
}

/** Uploads one of SAMPLES and returns its id, failing the test on anything but 201. */
async function uploaded(started: Started, type: AttachmentType = 'text/plain', name = `sample.${EXTENSIONS[type]}`): Promise<string> {
  const res = await upload(started, SAMPLES[type], type, name);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return (res.json as Extract<AttachmentResult, { ok: true }>).attachment.id;
}

/** DELETE attachmentPath(id), as the web UI sends it unless `headers` say otherwise. */
function discard(started: Started, id: string, headers: Record<string, string> = asPage(started)) {
  return send(started.server.port, attachmentPath(id), undefined, headers, 'DELETE');
}

function spawn(started: Started, body: unknown) {
  return send(started.server.port, SPAWN_PATH, JSON.stringify(body), { ...asPage(started), 'content-type': 'application/json' });
}

const spawnBody = (attachments?: unknown, prompt = 'Describe the attached files.') => ({
  cwd: repo,
  prompt,
  name: 'pitwall-test-attachments',
  model: 'haiku',
  ...(attachments === undefined ? {} : { attachments }),
});

/** The apiKey, from W8's challenge-response handshake. */
async function apiKeyOf(port: number): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: origin(port) });
  const messages: ServerMessage[] = [];
  const waiters: ((message: ServerMessage) => void)[] = [];
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const next = () => {
    const queued = messages.shift();
    return queued ? Promise.resolve(queued) : new Promise<ServerMessage>((resolve) => waiters.push(resolve));
  };
  const challenge = await next();
  if (challenge.type !== 'challenge') throw new Error(`expected a challenge, got ${challenge.type}`);
  ws.send(JSON.stringify({ type: 'auth', proof: proofFor(TOKEN, challenge.nonce, pitwallOrigin(port)) }));
  const reply = await next();
  ws.close();
  if (reply.type !== 'authenticated') throw new Error(`expected authenticated, got ${reply.type}`);
  return reply.apiKey;
}

/** The upload folders in a home's attachments folder. */
async function folders(home: string): Promise<string[]> {
  try {
    return (await readdir(join(home, 'attachments'))).sort();
  } catch {
    return [];
  }
}

const errorOf = (res: HttpResult) => (res.json as { ok: false; error: string }).error;

// ---------------------------------------------------------------- the route's checks

describe('the upload route: credentials, Host and Origin', () => {
  it('refuses a request without credentials, with 401, and writes nothing', async () => {
    const started = await start();
    const res = await send(started.server.port, ATTACHMENTS_PATH, SAMPLES['text/plain'], {
      origin: origin(started.server.port),
      'content-type': 'text/plain',
      'x-pitwall-filename': 'notes.txt',
    });
    expect(res.status).toBe(401);
    expect(existsSync(started.home as string)).toBe(false);
  });

  it('refuses the raw token, even from this Origin, with 403', async () => {
    const started = await start();
    const res = await upload(started, SAMPLES['text/plain'], 'text/plain', 'notes.txt', { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
    expect(existsSync(started.home as string)).toBe(false);
  });

  it('refuses the apiKey without an Origin, or with another one, with 403', async () => {
    const started = await start();
    const base = { authorization: `Bearer ${started.apiKey}`, 'content-type': 'text/plain', 'x-pitwall-filename': 'notes.txt' };
    expect((await send(started.server.port, ATTACHMENTS_PATH, SAMPLES['text/plain'], base)).status).toBe(403);
    for (const other of ['http://localhost:' + started.server.port, 'http://evil.example', 'null']) {
      expect((await send(started.server.port, ATTACHMENTS_PATH, SAMPLES['text/plain'], { ...base, origin: other })).status, other).toBe(403);
    }
    expect(existsSync(started.home as string)).toBe(false);
  });

  it('refuses another Host, with 403, before any route', async () => {
    const started = await start();
    for (const host of [`localhost:${started.server.port}`, `evil.example:${started.server.port}`]) {
      const res = await upload(started, SAMPLES['text/plain'], 'text/plain', 'notes.txt', { host });
      expect(res.status, host).toBe(403);
    }
    expect(existsSync(started.home as string)).toBe(false);
  });
});

describe('the upload route: what it answers', () => {
  it('keeps a file with 201, its id, cleaned name, type and size, and never caches the answer', async () => {
    const started = await start();
    const res = await upload(started, SAMPLES['image/png'], 'image/png', 'Screenshot 2026-10-28 at 09.41.png');
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { attachment } = res.json as Extract<AttachmentResult, { ok: true }>;
    expect(attachment).toEqual({ id: expect.stringMatching(UUID), name: 'Screenshot 2026-10-28 at 09.41.png', type: 'image/png', size: SAMPLES['image/png'].length });
    const dir = join(started.home as string, 'attachments', attachment.id);
    expect(await readdir(dir)).toEqual(['Screenshot-2026-10-28-at-09.41.png']);
    expect(await readFile(join(dir, 'Screenshot-2026-10-28-at-09.41.png'))).toEqual(SAMPLES['image/png']);
  });

  it('takes Content-Type parameters and any case', async () => {
    const started = await start();
    expect((await upload(started, SAMPLES['text/plain'], 'Text/Plain; charset=utf-8')).status).toBe(201);
  });

  it('answers 400 for a name that is missing, empty, too long, or has a separator, control or bidi character', async () => {
    const started = await start();
    const bytes = SAMPLES['text/plain'];
    const port = started.server.port;
    const raw = (filename: string | undefined) =>
      send(port, ATTACHMENTS_PATH, bytes, { ...asPage(started), 'content-type': 'text/plain', ...(filename === undefined ? {} : { 'x-pitwall-filename': filename }) });
    const cases: Array<[string, string | undefined]> = [
      ['missing', undefined],
      ['empty after trimming', '%20%20'],
      ['too long', encodeURIComponent('a'.repeat(ATTACHMENT_NAME_MAX) + '.txt')],
      ['a slash', encodeURIComponent('../../etc/passwd')],
      ['a backslash', encodeURIComponent('..\\evil.txt')],
      ['a line feed', encodeURIComponent('notes\n.txt')],
      ['a trailing tab', encodeURIComponent('notes.txt\t')],
      ['an escape', encodeURIComponent('\u001b[2Jnotes.txt')],
      ['a C1 control', encodeURIComponent('csi\u009bnotes.txt')],
      ['a right-to-left override', encodeURIComponent('safe‮txt.exe')],
      ['an isolate', encodeURIComponent('a⁦b.txt')],
      ['bad URL-encoding', '%E0%A4%A'],
      ['raw non-ASCII', 'café.txt'],
    ];
    for (const [what, filename] of cases) {
      const res = await raw(filename);
      expect(res.status, what).toBe(400);
      expect(errorOf(res), what).toMatch(/name/);
    }
    expect(await folders(started.home as string)).toEqual([]);
  });

  it('answers 400 for an empty file, and leaves nothing behind', async () => {
    const started = await start();
    const res = await upload(started, Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('The file is empty.');
    expect(await folders(started.home as string)).toEqual([]);
  });

  it('answers 415 for a type it does not take, or a Content-Encoding', async () => {
    const started = await start();
    for (const type of [null, 'application/octet-stream', 'image/svg+xml', 'text/html', 'image/png-ish', 'application/json5']) {
      const res = await upload(started, SAMPLES['text/plain'], type);
      expect(res.status, String(type)).toBe(415);
    }
    const gzip = await upload(started, SAMPLES['text/plain'], 'text/plain', 'notes.txt', { 'content-encoding': 'gzip' });
    expect(gzip.status).toBe(415);
    expect(await folders(started.home as string)).toEqual([]);
  });

  it('answers 503 when the server keeps no attachments, as without a pitwall home', async () => {
    const started = await start({ home: undefined });
    const res = await upload(started, SAMPLES['text/plain']);
    expect(res.status).toBe(503);
    expect(errorOf(res)).toMatch(/doesn't keep attachments/);
  });

  it('answers 500 when the folder for an upload cannot be made, and keeps nothing', async () => {
    const started = await start();
    await uploaded(started);
    const attachments = join(started.home as string, 'attachments');
    await chmod(attachments, 0o500);
    try {
      const res = await upload(started, SAMPLES['text/plain']);
      expect(res.status).toBe(500);
      expect(errorOf(res)).toMatch(/couldn't make a folder/);
    } finally {
      await chmod(attachments, 0o700);
    }
    expect(await folders(started.home as string)).toHaveLength(1);
  });
});

describe('the upload route: the size cap', () => {
  it('answers 413 at once for a Content-Length over the cap, without reading the body', async () => {
    const started = await start();
    const res = await new Promise<HttpResult>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: started.server.port,
          path: ATTACHMENTS_PATH,
          method: 'POST',
          agent: false,
          headers: { ...asPage(started), 'content-type': 'text/plain', 'x-pitwall-filename': 'big.txt', 'content-length': String(ATTACHMENT_MAX_BYTES + 1) },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (text += chunk));
          response.on('end', () => {
            req.destroy();
            resolve({ status: response.statusCode ?? 0, headers: response.headers, json: JSON.parse(text) });
          });
        },
      );
      req.on('error', (error) => reject(error));
      // Headers only: nothing of the body is ever sent.
      req.flushHeaders();
    });
    expect(res.status).toBe(413);
    expect(errorOf(res)).toMatch(/over 10 MiB/);
    expect(existsSync(started.home as string)).toBe(false);
  });

  it('answers 413 while streaming, as soon as the bytes pass the cap, without waiting for the rest, and leaves nothing behind', async () => {
    const started = await start();
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    // Three times the cap, and never ended: an answer can only come from the cap.
    const total = ATTACHMENT_MAX_BYTES * 3;
    const outcome = await new Promise<{ status: number; error: string; sent: number }>((resolve, reject) => {
      let sent = 0;
      let answered = false;
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: started.server.port,
          path: ATTACHMENTS_PATH,
          method: 'POST',
          agent: false,
          // Chunked, with no Content-Length, so only the bytes themselves can trip the cap.
          headers: { ...asPage(started), 'content-type': 'text/plain', 'x-pitwall-filename': 'stream.txt', 'transfer-encoding': 'chunked' },
        },
        (response) => {
          answered = true;
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (part: string) => (text += part));
          response.on('end', () => {
            req.destroy();
            resolve({ status: response.statusCode ?? 0, error: (JSON.parse(text) as { error: string }).error, sent });
          });
        },
      );
      req.on('error', (error) => {
        if (!answered) reject(error);
      });
      const pump = () => {
        while (!answered && sent < total) {
          sent += chunk.length;
          if (!req.write(chunk)) {
            req.once('drain', pump);
            return;
          }
        }
      };
      pump();
    });
    expect(outcome.status).toBe(413);
    expect(outcome.error).toMatch(/over 10 MiB/);
    // About 12 MiB of the 30 on this Mac: the cap, and what the sockets buffered.
    expect(outcome.sent).toBeLessThan(ATTACHMENT_MAX_BYTES * 2);
    // Removed before the answer was sent.
    expect(await folders(started.home as string)).toEqual([]);
    // And the server still works.
    expect((await upload(started, SAMPLES['text/plain'])).status).toBe(201);
  });

  it('keeps a file of exactly the cap', async () => {
    const started = await start();
    const res = await upload(started, Buffer.alloc(ATTACHMENT_MAX_BYTES, 0x62), 'text/plain', 'exact.txt');
    expect(res.status).toBe(201);
    expect((res.json as Extract<AttachmentResult, { ok: true }>).attachment.size).toBe(ATTACHMENT_MAX_BYTES);
  });

  it('removes what arrived of an upload the client abandons', async () => {
    const started = await start();
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: started.server.port,
        path: ATTACHMENTS_PATH,
        method: 'POST',
        agent: false,
        headers: { ...asPage(started), 'content-type': 'text/plain', 'x-pitwall-filename': 'abandoned.txt', 'content-length': String(4 * 1024 * 1024) },
      });
      req.on('error', () => {});
      req.write(Buffer.alloc(1024 * 1024, 0x61), () => {
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 100);
      });
    });
    await vi.waitFor(async () => expect(await folders(started.home as string)).toEqual([]), { timeout: 5000 });
  });
});

describe('the upload route: type sniffing', () => {
  it('keeps each type, under its own extension', async () => {
    const started = await start();
    for (const type of ATTACHMENT_TYPES) {
      const res = await upload(started, SAMPLES[type], type, `sample.${EXTENSIONS[type]}`);
      expect(res.status, type).toBe(201);
      const { id } = (res.json as Extract<AttachmentResult, { ok: true }>).attachment;
      expect(await readdir(join(started.home as string, 'attachments', id)), type).toEqual([`sample.${EXTENSIONS[type]}`]);
    }
  });

  it('answers 415 when the first bytes contradict the type, and leaves nothing behind', async () => {
    const started = await start();
    const cases: Array<[AttachmentType, Buffer]> = [
      ['image/png', SAMPLES['image/jpeg']],
      ['image/jpeg', SAMPLES['image/png']],
      ['image/gif', ascii('GIF90a\0\0\0\0\0\0')],
      ['image/webp', ascii('RIFF\x24\0\0\0WAVEfmt ')],
      ['application/pdf', ascii('<html>%PDF-1.7')],
      ['image/png', ascii('\x89PNG')],
      ['text/plain', SAMPLES['image/png']],
      ['text/markdown', Buffer.from([0x23, 0x20, 0xc3, 0x28])],
      ['text/csv', Buffer.from('a,b\n1,\0\n')],
      ['application/json', Buffer.from([0x7b, 0xed, 0xa0, 0x80, 0x7d])],
      ['text/plain', Buffer.from([0x68, 0x69, 0xe2, 0x82])],
    ];
    for (const [type, bytes] of cases) {
      const res = await upload(started, bytes, type, 'mismatch');
      expect(res.status, `${type} ${bytes.toString('hex')}`).toBe(415);
    }
    expect(await folders(started.home as string)).toEqual([]);
  });
});

describe('TypeCheck', () => {
  const check = (type: AttachmentType, ...chunks: Buffer[]) => {
    const typeCheck = new TypeCheck(type);
    for (const chunk of chunks) {
      const wrong = typeCheck.push(chunk);
      if (wrong !== undefined) return wrong;
    }
    return typeCheck.end();
  };

  it('passes each type, its signature split across chunks too', () => {
    for (const type of ATTACHMENT_TYPES) {
      const bytes = SAMPLES[type];
      expect(check(type, bytes), type).toBeUndefined();
      const chunks = [...bytes].map((byte) => Buffer.from([byte]));
      expect(check(type, ...chunks), `${type}, a byte at a time`).toBeUndefined();
    }
  });

  it('refuses each image and PDF type for another one, and for a file shorter than its signature', () => {
    const binary = ATTACHMENT_TYPES.filter((type) => !type.startsWith('text/') && type !== 'application/json');
    for (const type of binary) {
      for (const other of binary) if (other !== type) expect(check(type, SAMPLES[other]), `${type} as ${other}`).toMatch(/first bytes/);
      expect(check(type, SAMPLES[type].subarray(0, 2)), `${type}, cut short`).toMatch(/first bytes/);
    }
    expect(check('image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))).toBeUndefined();
    expect(check('image/gif', ascii('GIF87a'))).toBeUndefined();
  });

  it('takes UTF-8 text, a character split across chunks too, and refuses invalid UTF-8, NUL and a cut-off character', () => {
    const text = Buffer.from('snow ☃ and 🦀\n', 'utf8');
    const split = text.indexOf(0xe2) + 1;
    for (const type of ['text/plain', 'text/markdown', 'text/csv', 'application/json'] as const) {
      expect(check(type, text.subarray(0, split), text.subarray(split)), type).toBeUndefined();
      expect(check(type, Buffer.from('﻿{}', 'utf8')), `${type} with a BOM`).toBeUndefined();
      expect(check(type, Buffer.from([0x61, 0x00, 0x62])), `${type} with NUL`).toMatch(/NUL/);
      expect(check(type, Buffer.from([0xc0, 0xaf])), `${type}, overlong`).toMatch(/isn't UTF-8/);
      expect(check(type, Buffer.from([0xed, 0xa0, 0x80])), `${type}, a surrogate`).toMatch(/isn't UTF-8/);
      expect(check(type, Buffer.from([0xff])), `${type}, 0xFF`).toMatch(/isn't UTF-8/);
      expect(check(type, text.subarray(0, split)), `${type}, cut off`).toMatch(/partway/);
    }
  });
});

// ---------------------------------------------------------------- names

describe('names', () => {
  it('attachmentName keeps a cleaned name for display, and refuses separators, controls and bidi', () => {
    const ok = (header: string) => {
      const result = attachmentName(header);
      return result.ok ? result.name : `refused: ${result.error}`;
    };
    expect(ok(encodeURIComponent('my file (1).png'))).toBe('my file (1).png');
    expect(ok(encodeURIComponent('  spaced.md  '))).toBe('spaced.md');
    expect(ok(encodeURIComponent('résumé 日本語 🦀.pdf'))).toBe('résumé 日本語 🦀.pdf');
    // NFD, as macOS names files, shown as NFC.
    expect(ok(encodeURIComponent('café.txt'))).toBe('café.txt');
    expect(ok(encodeURIComponent('..'))).toBe('..');
    expect(ok(encodeURIComponent('a'.repeat(ATTACHMENT_NAME_MAX)))).toBe('a'.repeat(ATTACHMENT_NAME_MAX));
    for (const bad of ['a/b', '/etc/passwd', '..\\x', 'a\u0000b', 'a\rb', 'a\u007fb', 'a\u0085b', '‏abc', 'a؜b', 'a‪b', 'a⁩b', ' ', 'a'.repeat(ATTACHMENT_NAME_MAX + 1)]) {
      expect(ok(encodeURIComponent(bad)), JSON.stringify(bad)).toMatch(/^refused/);
    }
    expect(ok('')).toMatch(/^refused/);
    expect(ok('%')).toMatch(/^refused/);
  });

  it('storedName makes a safe slug that keeps the extension', () => {
    const cases: Array<[string, AttachmentType, string]> = [
      ['my file (1).png', 'image/png', 'my-file-1.png'],
      ['résumé.PDF', 'application/pdf', 'resume.pdf'],
      ['日本語.png', 'image/png', 'attachment.png'],
      ['..', 'text/plain', 'attachment.txt'],
      ['...txt', 'text/plain', 'attachment.txt'],
      ['.env', 'text/plain', 'env.txt'],
      ['-rf.txt', 'text/plain', 'rf.txt'],
      ['$(rm -rf ~).txt', 'text/plain', 'rm-rf.txt'],
      ['photo.JPEG', 'image/jpeg', 'photo.jpeg'],
      ['notes', 'text/markdown', 'notes.md'],
      ['script.ts', 'text/plain', 'script.ts'],
      ['data.CSV', 'text/csv', 'data.csv'],
      // An image's extension must fit its type, since Claude Code goes by it, and text never gets one.
      ['photo.jpg', 'image/png', 'photo.jpg.png'],
      ['image.png', 'text/plain', 'image.png.txt'],
      ['report.pdf', 'text/markdown', 'report.pdf.md'],
      ['weird.ext!', 'text/plain', 'weird.ext.txt'],
      ['spaced  name .md', 'text/markdown', 'spaced-name.md'],
      ['@mention me.txt', 'text/plain', 'mention-me.txt'],
    ];
    for (const [name, type, stored] of cases) expect(storedName(name, type), name).toBe(stored);
    expect(storedName(`${'a'.repeat(150)}.txt`, 'text/plain')).toBe(`${'a'.repeat(100)}.txt`);
  });

  it('never stores a name with anything but letters, digits, ".", "-" and "_", whatever was uploaded', () => {
    const nasty = ['..', '.', '-', '--help', '~', '~/x', '@x', 'a b', 'a\tb', '😀', '́', 'CON', 'x'.repeat(250), '. .', '-.-', 'a.b.c.d', 'a..b', '%2e%2e'];
    for (const name of nasty) {
      for (const type of ATTACHMENT_TYPES) expect(storedName(name, type), `${name} as ${type}`).toMatch(STORED);
    }
  });

  it('keeps the name for display and a slug on disk, through the route', async () => {
    const started = await start();
    const cases: Array<[string, string]> = [
      ['..', 'attachment.txt'],
      ['my notes ☕.txt', 'my-notes.txt'],
      ['naïve résumé.txt', 'naive-resume.txt'],
      ['日本語のメモ.txt', 'attachment.txt'],
    ];
    for (const [name, stored] of cases) {
      const res = await upload(started, SAMPLES['text/plain'], 'text/plain', name);
      expect(res.status, name).toBe(201);
      const { attachment } = res.json as Extract<AttachmentResult, { ok: true }>;
      expect(attachment.name).toBe(name);
      expect(await readdir(join(started.home as string, 'attachments', attachment.id)), name).toEqual([stored]);
    }
  });

  it('attachmentType takes only the contract types', () => {
    for (const type of ATTACHMENT_TYPES) expect(attachmentType(type)).toBe(type);
    expect(attachmentType('IMAGE/PNG; q=1')).toBe('image/png');
    for (const type of [undefined, '', 'image/svg+xml', 'text', 'text/plain-x', ' ; text/plain']) expect(attachmentType(type)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the folders

describe('the folders and their modes', () => {
  it.skipIf(process.platform === 'win32')('makes the home, the attachments folder and each upload folder 0700, and each file 0600', async () => {
    const started = await start();
    const id = await uploaded(started, 'image/png');
    const home = started.home as string;
    const mode = async (target: string) => (await stat(target)).mode & 0o777;
    expect(await mode(home)).toBe(0o700);
    expect(await mode(join(home, 'attachments'))).toBe(0o700);
    expect(await mode(join(home, 'attachments', id))).toBe(0o700);
    expect(await mode(join(home, 'attachments', id, 'sample.png'))).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked attachments folder with 503, and writes nothing through it', async () => {
    const home = freshHome();
    const elsewhere = join(tmp, `elsewhere-${++n}`);
    await mkdir(home, { mode: 0o700 });
    await mkdir(elsewhere, { mode: 0o700 });
    await symlink(elsewhere, join(home, 'attachments'));
    const started = await start({ home });
    const res = await upload(started, SAMPLES['text/plain']);
    expect(res.status).toBe(503);
    expect(errorOf(res)).toMatch(/symbolic link/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked pitwall home, too', async () => {
    const target = join(tmp, `target-${++n}`);
    await mkdir(target, { mode: 0o700 });
    const home = join(tmp, `home-link-${n}`);
    await symlink(target, home);
    const started = await start({ home });
    expect((await upload(started, SAMPLES['text/plain'])).status).toBe(503);
    expect(await readdir(target)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('refuses an attachments folder others can enter, and leaves its mode alone', async () => {
    const home = freshHome();
    await mkdir(join(home, 'attachments'), { recursive: true, mode: 0o700 });
    await chmod(join(home, 'attachments'), 0o755);
    const started = await start({ home });
    const res = await upload(started, SAMPLES['text/plain']);
    expect(res.status).toBe(503);
    expect(errorOf(res)).toMatch(/chmod 700/);
    expect((await stat(join(home, 'attachments'))).mode & 0o777).toBe(0o755);
  });

  it('refuses a home whose path an @ mention cannot carry', async () => {
    const parent = join(tmp, `with space ${++n}`);
    await mkdir(parent);
    const started = await start({ home: join(parent, 'home') });
    const res = await upload(started, SAMPLES['text/plain']);
    expect(res.status).toBe(503);
    expect(errorOf(res)).toMatch(/@ mention/);
    expect(await folders(join(parent, 'home'))).toEqual([]);
  });
});

// ---------------------------------------------------------------- the pending cap

describe('the pending cap', () => {
  it(`answers 429 past ${ATTACHMENTS_MAX_PENDING} unused uploads, with Retry-After, until some are used or expire`, async () => {
    let clock = Date.parse('2026-10-28T09:00:00.000Z');
    const started = await start({ attachments: { now: () => clock } });
    const ids: string[] = [];
    for (let i = 0; i < ATTACHMENTS_MAX_PENDING; i += 1) {
      ids.push(await uploaded(started));
      clock += 1000;
    }
    const refused = await upload(started, SAMPLES['text/plain']);
    expect(refused.status).toBe(429);
    expect(errorOf(refused)).toMatch(/at most 30 attachments/);
    // The first expires an hour after it arrived, 30 seconds ago.
    expect(refused.headers['retry-after']).toBe(String(UNUSED_TTL_MS / 1000 - 30));
    expect(await folders(started.home as string)).toHaveLength(ATTACHMENTS_MAX_PENDING);

    // Two used by a session: two places free.
    expect((await spawn(started, spawnBody(ids.slice(0, 2)))).status).toBe(201);
    await uploaded(started);
    await uploaded(started);
    expect((await upload(started, SAMPLES['text/plain'])).status).toBe(429);

    // An hour on, the unused ones have expired.
    clock += UNUSED_TTL_MS;
    expect((await upload(started, SAMPLES['text/plain'])).status).toBe(201);
  });

  it('counts uploads still arriving, so concurrent ones cannot pass the cap together', async () => {
    const started = await start();
    const results = await Promise.all(Array.from({ length: ATTACHMENTS_MAX_PENDING + 5 }, () => upload(started, SAMPLES['text/plain'])));
    const statuses = results.map((res) => res.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(ATTACHMENTS_MAX_PENDING);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------- clean-up

describe('clean-up', () => {
  /** A store on `home` with a clock the test moves, not started, so only sweep() removes anything. */
  function storeAt(home: string, at: number) {
    const clock = { now: at };
    const store = new AttachmentStore({ home, now: () => clock.now });
    stores.push(store);
    return { store, clock };
  }

  const body = (bytes: Buffer) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });

  async function keep(store: AttachmentStore): Promise<string> {
    const outcome = await store.upload(body(SAMPLES['text/plain']), 'notes.txt', 'text/plain');
    if (!outcome.result.ok) throw new Error(outcome.result.error);
    return outcome.result.attachment.id;
  }

  /** A folder as an earlier run left it, its mtimes `ageMs` before `now`, with `.used` when used. */
  async function leftover(home: string, id: string, now: number, ageMs: number, used = false): Promise<string> {
    const dir = join(home, 'attachments', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'left.txt'), 'left behind', { mode: 0o600 });
    const at = new Date(now - ageMs);
    await utimes(join(dir, 'left.txt'), at, at);
    if (used) {
      await writeFile(join(dir, USED_MARKER), '', { mode: 0o600 });
      await utimes(join(dir, USED_MARKER), at, at);
      // The upload was older than its use.
      const uploadedAt = new Date(now - ageMs - UNUSED_TTL_MS * 2);
      await utimes(join(dir, 'left.txt'), uploadedAt, uploadedAt);
    }
    await utimes(dir, at, at);
    return dir;
  }

  it('removes an unused upload an hour after it arrived, not before', async () => {
    const home = freshHome();
    const t0 = Date.now();
    const { store, clock } = storeAt(home, t0);
    const id = await keep(store);
    clock.now = t0 + UNUSED_TTL_MS - 1;
    await store.sweep();
    expect(await folders(home)).toEqual([id]);
    expect((await store.lookup([id])).ok).toBe(true);
    clock.now = t0 + UNUSED_TTL_MS;
    await store.sweep();
    expect(await folders(home)).toEqual([]);
    expect(await store.lookup([id])).toEqual({ ok: false, error: expect.stringMatching(/isn't one pitwall knows/) });
  });

  it('refuses an unused upload past its hour even before a sweep', async () => {
    const t0 = Date.now();
    const { store, clock } = storeAt(freshHome(), t0);
    const id = await keep(store);
    clock.now = t0 + UNUSED_TTL_MS;
    expect(await store.lookup([id])).toEqual({ ok: false, error: expect.stringMatching(/unused for an hour/) });
    expect(store.pending()).toBe(0);
  });

  it('removes a used upload 7 days after the spawn that used it, not before, and marks its folder', async () => {
    const home = freshHome();
    const t0 = Date.now();
    const { store, clock } = storeAt(home, t0);
    const id = await keep(store);
    clock.now = t0 + 50 * 60 * 1000;
    const usedAt = clock.now;
    expect(store.claim([id]).ok).toBe(true);
    await store.markUsed([id]);
    expect((await lstat(join(home, 'attachments', id, USED_MARKER))).isFile()).toBe(true);
    clock.now = usedAt + USED_TTL_MS - 1;
    await store.sweep();
    expect(await folders(home)).toEqual([id]);
    clock.now = usedAt + USED_TTL_MS;
    await store.sweep();
    expect(await folders(home)).toEqual([]);
  });

  it("goes by each folder's own mtimes for what an earlier run left, and leaves everything else alone", async () => {
    const home = freshHome();
    const now = Date.now();
    const hour = UNUSED_TTL_MS;
    const id = (i: number) => `0000000${i}-0000-4000-8000-000000000000`;
    const unusedOld = await leftover(home, id(1), now, hour + 60_000);
    const unusedNew = await leftover(home, id(2), now, hour - 60_000);
    const usedOld = await leftover(home, id(3), now, USED_TTL_MS + 60_000, true);
    const usedNew = await leftover(home, id(4), now, USED_TTL_MS - 60_000, true);
    // Not pitwall's: a name that isn't an upload id, a symlink with one, and a file with one.
    const notOurs = await leftover(home, 'not-an-upload', now, USED_TTL_MS * 2);
    const outside = join(tmp, `outside-${++n}`);
    await mkdir(outside);
    await writeFile(join(outside, 'precious.txt'), 'keep me');
    await symlink(outside, join(home, 'attachments', id(5)));
    await writeFile(join(home, 'attachments', id(6)), 'a file');
    const old = new Date(now - USED_TTL_MS * 2);
    await utimes(join(home, 'attachments', id(6)), old, old);
    await chmod(home, 0o700);
    await chmod(join(home, 'attachments'), 0o700);

    const { store } = storeAt(home, now);
    await store.sweep();
    expect(existsSync(unusedOld)).toBe(false);
    expect(existsSync(usedOld)).toBe(false);
    for (const kept of [unusedNew, usedNew, notOurs, join(home, 'attachments', id(6))]) expect(existsSync(kept), kept).toBe(true);
    expect((await lstat(join(home, 'attachments', id(5)))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('removes nothing through a symlinked attachments folder', async () => {
    const home = freshHome();
    const elsewhere = join(tmp, `elsewhere-${++n}`);
    const now = Date.now();
    await leftover(elsewhere, '00000001-0000-4000-8000-000000000000', now, USED_TTL_MS * 2);
    await mkdir(home, { mode: 0o700 });
    await symlink(join(elsewhere, 'attachments'), join(home, 'attachments'));
    const { store } = storeAt(home, now);
    await store.sweep();
    expect(await readdir(join(elsewhere, 'attachments'))).toEqual(['00000001-0000-4000-8000-000000000000']);
  });

  it("sweeps at startup, without making the home when there's none", async () => {
    const empty = freshHome();
    await start({ home: empty });
    // Give the startup sweep a moment: it must only look.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(empty)).toBe(false);

    const home = freshHome();
    const dir = await leftover(home, '00000001-0000-4000-8000-000000000000', Date.now(), UNUSED_TTL_MS + 60_000);
    await chmod(home, 0o700);
    await start({ home });
    await vi.waitFor(() => expect(existsSync(dir)).toBe(false), { timeout: 5000 });
  });

  it('sweeps on a timer', async () => {
    let clock = Date.now();
    const started = await start({ attachments: { now: () => clock, sweepIntervalMs: 20 } });
    const id = await uploaded(started);
    expect(await folders(started.home as string)).toEqual([id]);
    clock += UNUSED_TTL_MS;
    await vi.waitFor(async () => expect(await folders(started.home as string)).toEqual([]), { timeout: 5000 });
  });
});

// ---------------------------------------------------------------- DELETE attachmentPath(id)

describe('DELETE attachmentPath(id)', () => {
  it('removes an unused upload with 204, and frees its pending place at once', async () => {
    const started = await start();
    const ids: string[] = [];
    for (let i = 0; i < ATTACHMENTS_MAX_PENDING; i += 1) ids.push(await uploaded(started));
    expect((await upload(started, SAMPLES['text/plain'])).status).toBe(429);
    const gone = ids[0] as string;
    const res = await discard(started, gone);
    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(existsSync(join(started.home as string, 'attachments', gone))).toBe(false);
    expect(await folders(started.home as string)).toHaveLength(ATTACHMENTS_MAX_PENDING - 1);
    expect((await upload(started, SAMPLES['text/plain'])).status).toBe(201);
    // And a spawn can't use it any more.
    const spawned = await spawn(started, spawnBody([gone]));
    expect(spawned.status).toBe(400);
    expect(errorOf(spawned)).toMatch(/isn't one pitwall knows/);
    expect(started.run.calls).toEqual([]);
  });

  it('answers 404 for an id it does not hold, a second delete included, and removes nothing', async () => {
    const started = await start();
    const kept = await uploaded(started);
    const gone = await uploaded(started);
    expect((await discard(started, gone)).status).toBe(204);
    for (const id of [gone, '00000000-0000-4000-8000-000000000000', 'nope', '..', '../' + kept, `${kept}/sample.txt`, kept.toUpperCase()]) {
      const res = await discard(started, id);
      expect(res.status, id).toBe(404);
      // `/api/attachments/..` is normalized to `/api/` before routing, so the catch-all answers it, with no body.
      if (id !== '..') expect(errorOf(res), id).toMatch(/isn't one pitwall holds/);
    }
    expect(await folders(started.home as string)).toEqual([kept]);
  });

  it('answers 409 for one a spawn has used, and keeps it for the sweep', async () => {
    const started = await start();
    const id = await uploaded(started);
    expect((await spawn(started, spawnBody([id]))).status).toBe(201);
    const res = await discard(started, id);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatch(/A session has used/);
    expect(existsSync(join(started.home as string, 'attachments', id, 'sample.txt'))).toBe(true);
    expect(existsSync(join(started.home as string, 'attachments', id, USED_MARKER))).toBe(true);
  });

  it('answers 409 while a starting spawn has claimed it, and the spawn still gets it', async () => {
    let finish: (result: CommandResult) => void = () => {};
    const slow = () => new Promise<CommandResult>((resolve) => (finish = resolve));
    const started = await start({ run: fakeRunner(slow) });
    const id = await uploaded(started);
    const first = spawn(started, spawnBody([id]));
    await vi.waitFor(() => expect(started.run.calls).toHaveLength(1));
    expect((await discard(started, id)).status).toBe(409);
    finish(backgrounded());
    expect((await first).status).toBe(201);
    const file = join(started.home as string, 'attachments', id, 'sample.txt');
    expect(existsSync(file)).toBe(true);
    expect((started.run.calls[0] as Call).args.at(-1)).toMatch(/\n\n@\/.*\/sample\.txt$/);
    expect((await discard(started, id)).status).toBe(409);
  });

  it('removes one a failed spawn gave back, and a delete before a spawn leaves the spawn nothing to start', async () => {
    let finish: (result: CommandResult) => void = () => {};
    const slow = () => new Promise<CommandResult>((resolve) => (finish = resolve));
    const started = await start({ run: fakeRunner(slow) });
    const id = await uploaded(started);
    const failing = spawn(started, spawnBody([id]));
    await vi.waitFor(() => expect(started.run.calls).toHaveLength(1));
    expect((await discard(started, id)).status).toBe(409);
    finish(exited(1, '', 'Error: something went wrong\n'));
    expect((await failing).status).toBe(502);
    expect((await discard(started, id)).status).toBe(204);

    const other = await uploaded(started);
    // Sent together: whichever the server takes first, never both a session with it and a removed folder.
    const spawning = spawn(started, spawnBody([other]));
    const removed = await discard(started, other);
    if (removed.status === 204) {
      expect((await spawning).status).toBe(400);
      expect(started.run.calls).toHaveLength(1);
      expect(existsSync(join(started.home as string, 'attachments', other))).toBe(false);
    } else {
      expect(removed.status).toBe(409);
      await vi.waitFor(() => expect(started.run.calls).toHaveLength(2));
      finish(backgrounded());
      expect((await spawning).status).toBe(201);
      expect(existsSync(join(started.home as string, 'attachments', other, 'sample.txt'))).toBe(true);
    }
  });

  it('refuses no credentials with 401, and the raw token, no Origin, another Origin or another Host with 403, removing nothing', async () => {
    const started = await start();
    const id = await uploaded(started);
    const port = started.server.port;
    expect((await discard(started, id, { origin: origin(port) })).status).toBe(401);
    expect((await discard(started, id, { authorization: `Bearer ${TOKEN}`, origin: origin(port) })).status).toBe(403);
    expect((await discard(started, id, { authorization: `Bearer ${started.apiKey}` })).status).toBe(403);
    expect((await discard(started, id, { authorization: `Bearer ${started.apiKey}`, origin: 'http://evil.example' })).status).toBe(403);
    expect((await discard(started, id, { ...asPage(started), host: `localhost:${port}` })).status).toBe(403);
    expect(await folders(started.home as string)).toEqual([id]);
    expect((await spawn(started, spawnBody([id]))).status).toBe(201);
  });

  it('forgets an upload without touching the disk through a symlinked attachments folder', async () => {
    const t0 = Date.now();
    const home = freshHome();
    const store = new AttachmentStore({ home, now: () => t0 });
    stores.push(store);
    const outcome = await store.upload(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(SAMPLES['text/plain']));
          controller.close();
        },
      }),
      'notes.txt',
      'text/plain',
    );
    if (!outcome.result.ok) throw new Error(outcome.result.error);
    const { id } = outcome.result.attachment;
    // The real folder moves away, and a symlink to it takes its place.
    const moved = join(tmp, `moved-${++n}`);
    await rename(join(home, 'attachments'), moved);
    await symlink(moved, join(home, 'attachments'));
    expect(await store.discard(id)).toBe('removed');
    expect(await readdir(moved)).toEqual([id]);
    expect(await store.discard(id)).toBe('unknown');
  });
});

// ---------------------------------------------------------------- spawn

describe('spawn with attachments', () => {
  it('appends an @ line per file after a blank line, passes --add-dir=<folder> for each, and keeps the prompt last', async () => {
    const started = await start();
    const png = await uploaded(started, 'image/png', 'Screenshot 1.png');
    const text = await uploaded(started, 'text/plain', 'notes.txt');
    const res = await spawn(started, spawnBody([png, text]));
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ ok: true, shortId: 'c0ffee12', name: 'pitwall-test-attachments' } satisfies SpawnResult);

    const attachments = await realpath(join(started.home as string, 'attachments'));
    const pngDir = join(attachments, png);
    const textDir = join(attachments, text);
    expect(started.run.calls).toHaveLength(1);
    const call = started.run.calls[0] as Call;
    expect(call.file).toBe('claude');
    expect(call.args).toEqual([
      '--bg',
      '--name',
      'pitwall-test-attachments',
      '--model',
      'haiku',
      `--add-dir=${pngDir}`,
      `--add-dir=${textDir}`,
      '--',
      `Describe the attached files.\n\n@${join(pngDir, 'Screenshot-1.png')}\n@${join(textDir, 'notes.txt')}`,
    ]);
    // Never `--add-dir <dir>`, which would take the prompt as a directory.
    expect(call.args.filter((arg) => arg.startsWith('--add-dir'))).toEqual([`--add-dir=${pngDir}`, `--add-dir=${textDir}`]);
    expect(call.args.at(-2)).toBe('--');
    expect(call.args.at(-1)).toMatch(/^Describe the attached files\.\n\n@\//);
    // The files are there, under their stored names.
    expect(await readFile(join(pngDir, 'Screenshot-1.png'))).toEqual(SAMPLES['image/png']);
    // And marked used, for a later run's sweep.
    expect(existsSync(join(pngDir, USED_MARKER))).toBe(true);
  });

  it('spawns as before without attachments, or with none', async () => {
    const started = await start({ run: fakeRunner(backgrounded(), backgrounded()) });
    expect((await spawn(started, spawnBody())).status).toBe(201);
    expect((await spawn(started, spawnBody([]))).status).toBe(201);
    const plain = ['--bg', '--name', 'pitwall-test-attachments', '--model', 'haiku', '--', 'Describe the attached files.'];
    expect(started.run.calls.map((call) => call.args)).toEqual([plain, plain]);
  });

  it('refuses an id already used, with 400, and starts nothing', async () => {
    const started = await start();
    const id = await uploaded(started);
    expect((await spawn(started, spawnBody([id]))).status).toBe(201);
    const again = await spawn(started, spawnBody([id]));
    expect(again.status).toBe(400);
    expect(errorOf(again)).toMatch(/"sample.txt" was already used/);
    expect(started.run.calls).toHaveLength(1);
  });

  it('refuses unknown, expired and malformed ids, too many, or the same one twice, with 400, and starts nothing', async () => {
    let clock = Date.now();
    const started = await start({ attachments: { now: () => clock } });
    const id = await uploaded(started);
    const ten = await Promise.all(Array.from({ length: ATTACHMENTS_MAX_PER_SESSION }, () => uploaded(started)));
    const cases: Array<[string, unknown, RegExp]> = [
      ['unknown', ['00000000-0000-4000-8000-000000000000'], /isn't one pitwall knows/],
      ['not a uuid', ['../../etc'], /isn't one pitwall knows/],
      ['a known one and an unknown one', [id, 'nope'], /isn't one pitwall knows/],
      ['not a list', id, /list of attachment ids/],
      ['a number in it', [id, 7], /list of attachment ids/],
      ['twice', [id, id], /used once/],
      ['eleven', [...ten, id], /at most 10 attachments/],
    ];
    for (const [what, attachments, error] of cases) {
      const res = await spawn(started, spawnBody(attachments));
      expect(res.status, what).toBe(400);
      expect(errorOf(res), what).toMatch(error);
    }
    clock += UNUSED_TTL_MS;
    const expired = await spawn(started, spawnBody([id]));
    expect(expired.status).toBe(400);
    expect(errorOf(expired)).toMatch(/unused for an hour/);
    expect(started.run.calls).toEqual([]);
  });

  it('refuses ids when the server keeps no attachments', async () => {
    const started = await start({ home: undefined });
    const res = await spawn(started, spawnBody(['00000000-0000-4000-8000-000000000000']));
    expect(res.status).toBe(400);
    expect(started.run.calls).toEqual([]);
  });

  it('refuses an id whose file has gone since, and starts nothing', async () => {
    const started = await start();
    const id = await uploaded(started);
    await rm(join(started.home as string, 'attachments', id, 'sample.txt'));
    const res = await spawn(started, spawnBody([id]));
    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatch(/no longer where pitwall kept it/);
    expect(started.run.calls).toEqual([]);
  });

  it('marks ids used only when the session started: a failed spawn gives them back', async () => {
    const run = fakeRunner(exited(1, '', 'Error: something went wrong\n'), { kind: 'failed', reason: 'timeout', message: "didn't finish within 30s" }, backgrounded());
    const started = await start({ run });
    const id = await uploaded(started);
    expect((await spawn(started, spawnBody([id]))).status).toBe(502);
    expect((await spawn(started, spawnBody([id]))).status).toBe(504);
    expect(existsSync(join(started.home as string, 'attachments', id, USED_MARKER))).toBe(false);
    expect((await spawn(started, spawnBody([id]))).status).toBe(201);
    expect(run.calls).toHaveLength(3);
    expect(existsSync(join(started.home as string, 'attachments', id, USED_MARKER))).toBe(true);
  });

  it('lets only one of two spawns that run at once use an attachment', async () => {
    let finish: (result: CommandResult) => void = () => {};
    const slow = () => new Promise<CommandResult>((resolve) => (finish = resolve));
    const started = await start({ run: fakeRunner(slow), actions: { maxConcurrentSpawns: 2 } });
    const id = await uploaded(started);
    const first = spawn(started, spawnBody([id]));
    await vi.waitFor(() => expect(started.run.calls).toHaveLength(1));
    const second = await spawn(started, spawnBody([id]));
    expect(second.status).toBe(400);
    expect(errorOf(second)).toMatch(/being used by a session that's starting/);
    finish(backgrounded());
    expect((await first).status).toBe(201);
    expect(started.run.calls).toHaveLength(1);
  });

  it("doesn't count the @ lines toward the prompt's limit: a prompt at the limit with ten files starts", async () => {
    const started = await start();
    const ids = await Promise.all(Array.from({ length: ATTACHMENTS_MAX_PER_SESSION }, () => uploaded(started)));
    const prompt = 'p'.repeat(MAX_PROMPT_LENGTH);
    const res = await spawn(started, spawnBody(ids, prompt));
    expect(res.status).toBe(201);
    const last = (started.run.calls[0] as Call).args.at(-1) as string;
    expect(last.startsWith(`${prompt}\n\n@`)).toBe(true);
    expect(last.split('\n').filter((line) => line.startsWith('@'))).toHaveLength(ATTACHMENTS_MAX_PER_SESSION);
    // Still refused one character over, attachments or not.
    expect((await spawn(started, spawnBody([], `${prompt}p`))).status).toBe(400);
  });

  it('spawnArgs puts every --add-dir= before -- and the prompt', () => {
    const files = [
      { id: 'a', name: 'a.png', file: '/h/attachments/a/a.png', dir: '/h/attachments/a' },
      { id: 'b', name: 'b.txt', file: '/h/attachments/b/b.txt', dir: '/h/attachments/b' },
    ];
    expect(spawnArgs({ cwd: '/w', prompt: '-starts with a dash', attachments: files })).toEqual([
      '--bg',
      '--add-dir=/h/attachments/a',
      '--add-dir=/h/attachments/b',
      '--',
      '-starts with a dash\n\n@/h/attachments/a/a.png\n@/h/attachments/b/b.txt',
    ]);
  });
});
