// Who is on the other end of a request's socket (W175's F2, D7): whether the client process of a
// loopback TCP connection belongs to the server's own user.
//
// The threat in D7 is another OS account: its process served a page on this port earlier, and that page is
// still open. If a local process of that account forges Fetch Metadata, linkCodes.ts would give it a link
// code. So a code goes only to a client whose process is owned by pitwall's own uid. A process running as
// the same user is out of scope: it can read ~/.pitwall/ and the launch file anyway.
//
// - macOS: `lsof -nP -F pufn -iTCP:<peer port>` (absolute path, no shell). The entry whose name is exactly
//   this connection, `<client address>:<client port>-><server address>:<server port>`, is the client end:
//   the addresses as well as the ports, so a socket of the same user's browser on the other address family
//   with the same port numbers (a decoy, `[::1]:P->[::1]:Q` beside another account's `127.0.0.1:P`) never
//   counts (W175's re-review). Pitwall's own pid is ignored (it holds the
//   server end). Every process holding the client end must have our uid. lsof run by an ordinary user lists
//   only that user's processes, so another account's process is not found, which also says no.
// - Linux: the uid column of the /proc/net/tcp and /proc/net/tcp6 rows whose addresses and ports are exactly
//   that connection's, in any state, so a half-closed socket of another account still counts; at least one
//   must be ESTABLISHED. No subprocess.
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
  localAddress?: string | undefined;
  localPort?: number | undefined;
}

/** One loopback TCP connection, seen from its client end. Addresses are '127.0.0.1' or '::1'. */
export interface Connection {
  clientAddress: string;
  clientPort: number;
  serverAddress: string;
  serverPort: number;
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

/** A loopback address as lsof and /proc name it: an IPv4-mapped one is plain IPv4. Undefined otherwise. */
function loopback(address: string | undefined): string | undefined {
  if (address === '127.0.0.1' || address === '::ffff:127.0.0.1') return '127.0.0.1';
  if (address === '::1') return '::1';
  return undefined;
}

/** `address:port` as lsof's `n` field writes it: IPv6 in brackets. */
function lsofEndpoint(address: string, port: number): string {
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}

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

/**
 * The uids of the processes holding the client end of `connection`, its exact addresses and ports, in
 * `lsof -F pufn` output, leaving out `ownPid`. Undefined when the output isn't lsof field output.
 */
export function parseLsofClientUids(output: string, connection: Connection, ownPid: number): number[] | undefined {
  const name = `${lsofEndpoint(connection.clientAddress, connection.clientPort)}->${lsofEndpoint(connection.serverAddress, connection.serverPort)}`;
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
      if (value.replace(/\s*\(.*\)$/, '') !== name) continue;
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

/** How /proc/net/tcp (IPv4) and tcp6 (IPv6, IPv4-mapped too) write a loopback address, in hex. */
const PROC_ADDRESSES: Record<string, string[]> = {
  '127.0.0.1': ['0100007F', '0000000000000000FFFF00000100007F'],
  '::1': ['00000000000000000000000001000000'],
};

function procEndpoints(address: string, port: number): Set<string> {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  return new Set((PROC_ADDRESSES[address] ?? []).map((hex) => `${hex}:${hexPort}`));
}

/**
 * The rows of a /proc/net/tcp or tcp6 table for `connection`'s client end, its exact addresses and ports,
 * in any state: each one's uid and whether it's ESTABLISHED.
 */
export function parseProcNetUids(table: string, connection: Connection): { uid: number; established: boolean }[] {
  const locals = procEndpoints(connection.clientAddress, connection.clientPort);
  const remotes = procEndpoints(connection.serverAddress, connection.serverPort);
  const rows: { uid: number; established: boolean }[] = [];
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    if (!locals.has(fields[1]!.toUpperCase()) || !remotes.has(fields[2]!.toUpperCase())) continue;
    rows.push({ uid: /^\d+$/.test(fields[7]!) ? Number(fields[7]) : -1, established: fields[3] === '01' });
  }
  return rows;
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

  async function check(connection: Connection): Promise<boolean> {
    if (platform === 'darwin') {
      const out = await runLsof(['-nP', '-F', 'pufn', `-iTCP:${connection.clientPort}`], timeoutMs);
      return all(parseLsofClientUids(out, connection, pid));
    }
    if (platform === 'linux') {
      const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((file) => readProc(file).catch(() => '')));
      const rows = tables.flatMap((table) => parseProcNetUids(table, connection));
      return rows.some((row) => row.established) && all(rows.map((row) => row.uid));
    }
    return false;
  }

  return async (socket) => {
    try {
      if (uid === undefined) return false;
      const { remotePort, localPort } = socket;
      const clientAddress = loopback(socket.remoteAddress);
      const serverAddress = loopback(socket.localAddress);
      if (clientAddress === undefined || serverAddress === undefined) return false;
      if (!Number.isInteger(remotePort) || !Number.isInteger(localPort) || remotePort! <= 0 || localPort! <= 0) return false;
      if (running >= maxConcurrent) return false;
      running += 1;
      try {
        return await check({ clientAddress, clientPort: remotePort!, serverAddress, serverPort: localPort! });
      } finally {
        running -= 1;
      }
    } catch {
      return false;
    }
  };
}
