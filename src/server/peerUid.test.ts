import { createServer, connect, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createPeerCheck, parseLsofClientUids, parseProcNetUids, type PeerSocket } from './peerUid.js';

const OWN = 501;
const OTHER = 502;
const PEER = 51234;
const SERVER = 4517;
const SOCKET: PeerSocket = { remoteAddress: '127.0.0.1', remotePort: PEER, localPort: SERVER };

/** lsof -F pufn output: a client process and pitwall's own server end. */
function lsofOutput(clientUid: number, extra = ''): string {
  return [
    'p4242', `u${clientUid}`, 'f19', `n127.0.0.1:${PEER}->127.0.0.1:${SERVER}`,
    'p999', `u${OWN}`, 'f20', `n127.0.0.1:${SERVER}->127.0.0.1:${PEER}`,
    extra,
  ].join('\n');
}

function lsofCheck(output: string | Error, overrides: Parameters<typeof createPeerCheck>[0] = {}) {
  return createPeerCheck({
    platform: 'darwin',
    uid: OWN,
    pid: 999,
    runLsof: async () => {
      if (output instanceof Error) throw output;
      return output;
    },
    ...overrides,
  });
}

describe('parseLsofClientUids', () => {
  it('finds the client end, leaves out pitwall’s own pid, and reads ::1', () => {
    expect(parseLsofClientUids(lsofOutput(OTHER), PEER, SERVER, 999)).toEqual([OTHER]);
    expect(parseLsofClientUids(`p7\nu501\nf3\nn[::1]:${PEER}->[::1]:${SERVER}\n`, PEER, SERVER, 999)).toEqual([OWN]);
  });

  it('is empty for an unrelated connection, and undefined for garbage', () => {
    expect(parseLsofClientUids('p1\nu501\nf3\nn127.0.0.1:1->127.0.0.1:2\n', PEER, SERVER, 999)).toEqual([]);
    expect(parseLsofClientUids('', PEER, SERVER, 999)).toBeUndefined();
    expect(parseLsofClientUids('lsof: WARNING: nothing\n', PEER, SERVER, 999)).toBeUndefined();
    expect(parseLsofClientUids('pnot-a-pid\n', PEER, SERVER, 999)).toBeUndefined();
    expect(parseLsofClientUids(`n127.0.0.1:${PEER}->127.0.0.1:${SERVER}\n`, PEER, SERVER, 999)).toBeUndefined();
  });
});

describe('parseProcNetUids', () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const row = (local: string, remote: string, st: string, uid: number) =>
    `   0: ${local} ${remote} ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 12345 1 0000000000000000 100 0 0 10 0`;
  const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0');

  it('reads the uid of the client row only', () => {
    const table = [header, row(`0100007F:${hex(PEER)}`, `0100007F:${hex(SERVER)}`, '01', OTHER), row(`0100007F:${hex(SERVER)}`, `0100007F:${hex(PEER)}`, '01', OWN)].join('\n');
    expect(parseProcNetUids(table, PEER, SERVER)).toEqual([OTHER]);
  });

  it('skips rows that are not established, and garbage', () => {
    const table = [header, row(`0100007F:${hex(PEER)}`, `0100007F:${hex(SERVER)}`, '06', OWN), 'nonsense'].join('\n');
    expect(parseProcNetUids(table, PEER, SERVER)).toEqual([]);
    expect(parseProcNetUids('', PEER, SERVER)).toEqual([]);
  });
});

describe('createPeerCheck on macOS (lsof stubbed)', () => {
  it('says yes for a client of the server’s own uid, and no for another uid', async () => {
    expect(await lsofCheck(lsofOutput(OWN))(SOCKET)).toBe(true);
    expect(await lsofCheck(lsofOutput(OTHER))(SOCKET)).toBe(false);
  });

  it('says no when any process holding the socket has another uid', async () => {
    expect(await lsofCheck(lsofOutput(OWN, `p4343\nu${OTHER}\nf5\nn127.0.0.1:${PEER}->127.0.0.1:${SERVER}\n`))(SOCKET)).toBe(false);
  });

  it('says no for no match, an error, a timeout, garbage, or a socket that is not loopback', async () => {
    expect(await lsofCheck(`p999\nu${OWN}\nf20\nn127.0.0.1:${SERVER}->127.0.0.1:${PEER}\n`)(SOCKET)).toBe(false);
    expect(await lsofCheck(new Error('spawn failed'))(SOCKET)).toBe(false);
    expect(await lsofCheck(Object.assign(new Error('timed out'), { killed: true }))(SOCKET)).toBe(false);
    expect(await lsofCheck('???')(SOCKET)).toBe(false);
    expect(await lsofCheck(lsofOutput(OWN))({ ...SOCKET, remoteAddress: '192.168.1.5' })).toBe(false);
    expect(await lsofCheck(lsofOutput(OWN))({ remoteAddress: '127.0.0.1' })).toBe(false);
  });

  it('asks lsof for that port with field output, no shell', async () => {
    let seen: string[] = [];
    await lsofCheck(lsofOutput(OWN), { runLsof: async (args) => ((seen = args), lsofOutput(OWN)) })(SOCKET);
    expect(seen).toEqual(['-nP', '-F', 'pufn', `-iTCP:${PEER}`]);
  });

  it('starts no more than the cap at once', async () => {
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const check = lsofCheck('', { maxConcurrent: 2, runLsof: async () => { started += 1; await gate; return lsofOutput(OWN); } });
    const first = [check(SOCKET), check(SOCKET)];
    expect(await check(SOCKET)).toBe(false);
    expect(started).toBe(2);
    release();
    expect(await Promise.all(first)).toEqual([true, true]);
  });
});

describe('createPeerCheck on Linux (/proc stubbed) and elsewhere', () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0');
  const row = (uid: number) => `   0: 0100007F:${hex(PEER)} 0100007F:${hex(SERVER)} 01 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0 100 0 0 10 0`;
  const linux = (tcp: string, tcp6 = '', fail = false) =>
    createPeerCheck({ platform: 'linux', uid: OWN, readProc: async (file) => { if (fail) throw new Error('EACCES'); return file.endsWith('tcp6') ? tcp6 : tcp; } });

  it('says yes for the same uid and no for another, none, an unreadable table or differing rows', async () => {
    expect(await linux(`${header}\n${row(OWN)}`)(SOCKET)).toBe(true);
    expect(await linux(header, `${header}\n${row(OWN)}`)(SOCKET)).toBe(true);
    expect(await linux(`${header}\n${row(OTHER)}`)(SOCKET)).toBe(false);
    expect(await linux(header)(SOCKET)).toBe(false);
    expect(await linux('', '', true)(SOCKET)).toBe(false);
    expect(await linux(`${header}\n${row(OWN)}\n${row(OTHER)}`)(SOCKET)).toBe(false);
  });

  it('says no on any other platform, and with no uid', async () => {
    expect(await createPeerCheck({ platform: 'win32', uid: OWN })(SOCKET)).toBe(false);
    expect(await createPeerCheck({ platform: 'darwin', uid: undefined, runLsof: async () => lsofOutput(OWN) })(SOCKET)).toBe(false);
  });
});

// The real thing: connects to a listener in this process and expects the check to find this process.
// It runs the system's lsof on macOS, or reads /proc on Linux. Skipped elsewhere.
describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('createPeerCheck, live', () => {
  it('finds this process as the client of its own loopback connection', async () => {
    const accepted: Socket[] = [];
    const server = createServer((socket) => accepted.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const client = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => client.once('connect', resolve));
    while (accepted.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const serverSide = accepted[0]!;
    try {
      // This process holds both ends, so on macOS its own pid is ignored and nothing else is found: no.
      // A pid that isn't this one's makes the client end count, and it has this uid: yes.
      const started = Date.now();
      const yes = await createPeerCheck({ pid: process.pid + 1 })({ remoteAddress: serverSide.remoteAddress, remotePort: serverSide.remotePort, localPort: serverSide.localPort });
      // eslint-disable-next-line no-console
      console.log(`peer check took ${Date.now() - started} ms`);
      expect(yes).toBe(true);
      expect(await createPeerCheck({ uid: (process.getuid?.() ?? 0) + 1000, pid: process.pid + 1 })({ remoteAddress: serverSide.remoteAddress, remotePort: serverSide.remotePort, localPort: serverSide.localPort })).toBe(false);
    } finally {
      client.destroy();
      serverSide.destroy();
      server.close();
    }
  });
});
