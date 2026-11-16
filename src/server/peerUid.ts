// Who is on the other end of a request's socket (W175's F2, D7): whether the client process of a
// loopback TCP connection belongs to the server's own user.
//
// The threat in D7 is another OS account: its process served a page on this port earlier, and that page is
// still open. If a local process of that account forges Fetch Metadata, linkCodes.ts would give it a link
// code. So a code goes only to a client whose process is owned by pitwall's own uid. A process running as
// the same user is out of scope: it can read ~/.pitwall/ and the launch file anyway.
//
// - macOS: `lsof -nP -F pufn -iTCP:<peer port>` (absolute path, no shell). The entry whose local port is the
//   peer's and whose remote port is ours is the client end. Pitwall's own pid is ignored (it holds the
//   server end). Every process holding the client end must have our uid. lsof run by an ordinary user lists
//   only that user's processes, so another account's process is not found, which also says no.
// - Linux: the uid column of the /proc/net/tcp and /proc/net/tcp6 rows for that connection, no subprocess.
// - Anything else, an error, a timeout, output that can't be read, or no match: false. Callers show the
//   sign-in notice, as before W175. It never throws.
//
// Residual: the process could exit and another take its port between the check and the request, and a
// process of another account that can inject into one of this user's processes is out of scope.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const LSOF_PATH = '/usr/sbin/lsof';
/** A check that takes longer than this says no. */
export const PEER_CHECK_TIMEOUT_MS = 2000;
/** At most this many checks run at once; more say no without starting one. */
export const MAX_PEER_CHECKS = 4;

export interface PeerSocket {
  remoteAddress?: string | undefined;
  remotePort?: number | undefined;
  localPort?: number | undefined;
}

/** Whether the process at the other end of this socket is the server's own user's. */
export type PeerCheck = (socket: PeerSocket) => Promise<boolean>;

export interface PeerCheckOptions {
  platform?: NodeJS.Platform;
  /** The server's uid. Default process.getuid(); none (Windows) means no. */
  uid?: number | undefined;
  /** Pitwall's own pid, ignored in lsof's output. Default process.pid. */
  pid?: number;
  /** Runs lsof with these arguments and returns its stdout; rejects on an error or the timeout. */
  runLsof?: (args: string[], timeoutMs: number) => Promise<string>;
  /** Reads a /proc file as text. */
  readProc?: (file: string) => Promise<string>;
  timeoutMs?: number;
  maxConcurrent?: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function defaultRunLsof(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      LSOF_PATH,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, windowsHide: true },
      (error, stdout) => (error === null ? resolve(String(stdout)) : reject(error)),
    );
  });
}

function portOf(endpoint: string): number {
  const match = /:(\d{1,5})$/.exec(endpoint);
  return match === null ? -1 : Number(match[1]);
}

/**
 * The uids of the processes holding the client end (local port `peerPort`, remote port `serverPort`) in
 * `lsof -F pufn` output, leaving out `ownPid`. Undefined when the output isn't lsof field output.
 */
export function parseLsofClientUids(output: string, peerPort: number, serverPort: number, ownPid: number): number[] | undefined {
  const uids: number[] = [];
  let pid = -1;
  let uid = -1;
  let sawProcess = false;
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      if (!/^\d+$/.test(value)) return undefined;
      pid = Number(value);
      uid = -1;
      sawProcess = true;
    } else if (tag === 'u') {
      if (!/^\d+$/.test(value)) return undefined;
      uid = Number(value);
    } else if (tag === 'n') {
      if (!sawProcess) return undefined;
      const arrow = value.indexOf('->');
      if (arrow < 0) continue;
      if (portOf(value.slice(0, arrow)) !== peerPort || portOf(value.slice(arrow + 2).replace(/\s*\(.*\)$/, '')) !== serverPort) continue;
      if (pid === ownPid) continue;
      // A process with no readable uid is a candidate with an unknown owner: -1 never equals ours.
      uids.push(uid);
    } else if (tag !== 'f') {
      // Other fields are not asked for; ignore them rather than fail.
      continue;
    }
  }
  return sawProcess ? uids : undefined;
}

/** Hex-encoded `address:port` from /proc/net/tcp; the port alone is read. */
function hexPort(endpoint: string): number {
  const match = /:([0-9A-Fa-f]{4})$/.exec(endpoint);
  return match === null ? -1 : parseInt(match[1]!, 16);
}

/** The uids of the ESTABLISHED rows of a /proc/net/tcp or tcp6 table for this connection's client end. */
export function parseProcNetUids(table: string, peerPort: number, serverPort: number): number[] {
  const uids: number[] = [];
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    if (fields[3] !== '01') continue;
    if (hexPort(fields[1]!) !== peerPort || hexPort(fields[2]!) !== serverPort) continue;
    uids.push(/^\d+$/.test(fields[7]!) ? Number(fields[7]) : -1);
  }
  return uids;
}

export function createPeerCheck(options: PeerCheckOptions = {}): PeerCheck {
  const platform = options.platform ?? process.platform;
  const uid = 'uid' in options ? options.uid : typeof process.getuid === 'function' ? process.getuid() : undefined;
  const pid = options.pid ?? process.pid;
  const runLsof = options.runLsof ?? defaultRunLsof;
  const readProc = options.readProc ?? ((file: string) => readFile(file, 'utf8'));
  const timeoutMs = options.timeoutMs ?? PEER_CHECK_TIMEOUT_MS;
  const maxConcurrent = options.maxConcurrent ?? MAX_PEER_CHECKS;
  let running = 0;

  const all = (uids: number[] | undefined): boolean => uids !== undefined && uids.length > 0 && uids.every((found) => found === uid);

  async function check(peerPort: number, serverPort: number): Promise<boolean> {
    if (platform === 'darwin') {
      const out = await runLsof(['-nP', '-F', 'pufn', `-iTCP:${peerPort}`], timeoutMs);
      return all(parseLsofClientUids(out, peerPort, serverPort, pid));
    }
    if (platform === 'linux') {
      const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((file) => readProc(file).catch(() => '')));
      return all(tables.flatMap((table) => parseProcNetUids(table, peerPort, serverPort)));
    }
    return false;
  }

  return async (socket) => {
    try {
      if (uid === undefined) return false;
      const { remoteAddress, remotePort, localPort } = socket;
      if (remoteAddress === undefined || !LOOPBACK.has(remoteAddress)) return false;
      if (!Number.isInteger(remotePort) || !Number.isInteger(localPort) || remotePort! <= 0 || localPort! <= 0) return false;
      if (running >= maxConcurrent) return false;
      running += 1;
      try {
        return await check(remotePort!, localPort!);
      } finally {
        running -= 1;
      }
    } catch {
      return false;
    }
  };
}
