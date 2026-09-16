/**
 * SOCKET PRIVATE ROOMS AUTHENTICATE NOTHING (BLOCKER REGRESSION)
 * =============================================================
 *
 * THE DEFECT THESE PIN
 * --------------------
 * Every trading screen renders its live private data - open orders, fills,
 * order and trade history, positions, balance deltas - out of a per-user
 * socket.io room. The server delivers into it with
 *
 *     socketEmitOne(type, data, userId)   ->  io.sockets.in(userId).emit(...)
 *
 * and the ONLY way into that room was
 *
 *     socket.on('CREATEROOM', (userId) => socket.join(userId.toString()))
 *
 * The client named the room and the server joined it, with no check that the
 * socket belonged to that user. A client that knew (or guessed) another user's
 * _id received that user's entire private stream. This was proved live on
 * spotapi.
 *
 * `subscribe` was the same hole one door along: it also called socket.join()
 * with an arbitrary client-supplied string, so gating CREATEROOM alone would
 * have moved the exploit rather than closed it.
 *
 * WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY
 * ------------------------------------------------
 * config/socketAuth.js is exercised as the real module against a real
 * jsonwebtoken and a doubled redis, so these fail if the check is bypassed,
 * weakened or deleted - not merely if a mock stops being called. The socket is
 * a hand-written double that RECORDS joins and leaves, so "did user A end up in
 * user B's room" is answered by looking at room membership, which is the thing
 * that actually decides who receives the data.
 *
 * THE LINE THESE HOLD, IN BOTH DIRECTIONS
 * ---------------------------------------
 * A SOCKET MAY JOIN EXACTLY THE ROOM ITS OWN CREDENTIAL NAMES, AND PUBLIC
 * MARKET DATA MUST STAY OPEN TO A CLIENT WITH NO CREDENTIAL AT ALL. The
 * over-correction mutants are as load-bearing as the under-correction ones: a
 * "tightening" that made `subscribe` require a token, or refused a valid own
 * join, would blank the chart and the depth widget for logged-out visitors and
 * freeze the position list for logged-in ones, and these fail on it.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';

const SERVICE_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(SERVICE_ROOT, '..');

// The services that run a socket.io server. walletapi has no socket layer at
// all - asserted below rather than assumed.
//
// There were FOUR: two further trading services have since been removed with
// the products they served, so the cross-service invariants below now hold
// across two rather than four - weaker as a consistency check, no weaker as a
// guard on the code that is left. Every assertion still applies in full to
// spotapi, which is the only trading surface on the venue.
const SOCKET_SERVICES = [
  'cryptodex-spotapi',
  'cryptodex-userapi'
];

// The signing secret the service itself uses. tests/env.setup.js puts an
// obviously-fake value in the environment; nothing real is committed here.
const SECRET = process.env.SECRET_KEY;

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

// The redis `userToken` hash: the live-session record config/passport.js reads
// for every authenticated REST call. Keyed by user _id.
var mockSessions = new Map();

// NOT a jest.fn: jest.config.js sets resetMocks, which would strip the
// implementation off a mock function before every test and leave the module
// under test reading `undefined` from redis.
jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  hget: async (key, id) => {
    if (key !== 'userToken') {
      return null;
    }
    const doc = mockSessions.get(String(id));
    return doc ? JSON.stringify(doc) : null;
  }
}));

import {
  verifySocketCredential,
  extractSocketToken,
  isPrivateRoomName,
  stripBearer,
  handleCreateRoom,
  evictPrivateRoom,
  startPrivateRoomRecheck,
} from '../../config/socketAuth.js';

/** A socket double that records what it is actually a member of. */
const makeSocket = (handshakeToken) => ({
  id: 'sock-' + Math.random().toString(16).slice(2),
  data: {},
  rooms: new Set(),
  emitted: [],
  handshake: { auth: handshakeToken ? { token: handshakeToken } : {} },
  join(room) {
    this.rooms.add(room);
  },
  leave(room) {
    this.rooms.delete(room);
  },
  emit(event, payload) {
    this.emitted.push({ event, payload });
  }
});

const ALICE = '6a769e139029e856d64332a3';
const BOB = '6a769e139029e856d64332bd';

const login = (userId, { locked = 'false' } = {}) => {
  const tokenId = 'tok' + userId.slice(3);
  mockSessions.set(userId, { tokenId, userLocked: locked, userCode: '1' + userId.slice(0, 6) });
  return (
    'Bearer ' +
    jwt.sign({ _id: userId, tokenId, role: 'user' }, SECRET, { expiresIn: 3600 })
  );
};

beforeEach(() => {
  mockSessions.clear();
});

// ---------------------------------------------------------------------------
// THE DEFECT ITSELF: joining somebody else's room
// ---------------------------------------------------------------------------

describe('CREATEROOM joins the room the CREDENTIAL names, never the room the client names', () => {
  test('a valid credential joins its own room and only its own room', async () => {
    const token = login(ALICE);
    const socket = makeSocket();

    const result = await handleCreateRoom(socket, { token });

    expect(result).toEqual({ success: true, userId: ALICE });
    expect([...socket.rooms]).toEqual([ALICE]);
  });

  test('THE EXPLOIT: a bare victim userId, the legacy payload, joins nothing', async () => {
    login(BOB);
    const socket = makeSocket();

    const result = await handleCreateRoom(socket, BOB);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('missing_token');
    expect(socket.rooms.has(BOB)).toBe(false);
    expect(socket.rooms.size).toBe(0);
  });

  test("THE EXPLOIT: A's own valid token plus B's userId still lands in A's room", async () => {
    const token = login(ALICE);
    login(BOB);
    const socket = makeSocket();

    const result = await handleCreateRoom(socket, { token, userId: BOB });

    expect(result).toEqual({ success: true, userId: ALICE });
    expect([...socket.rooms]).toEqual([ALICE]);
    expect(socket.rooms.has(BOB)).toBe(false);
  });

  test('a forged token signed with the wrong key joins nothing', async () => {
    login(BOB);
    const forged =
      'Bearer ' +
      jwt.sign({ _id: BOB, tokenId: 'tok' + BOB.slice(3), role: 'user' }, 'not-the-secret');
    const socket = makeSocket();

    const result = await handleCreateRoom(socket, { token: forged });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('bad_token');
    expect(socket.rooms.size).toBe(0);
  });

  test('a well-formed token for a session that no longer exists joins nothing', async () => {
    const token = login(ALICE);
    mockSessions.delete(ALICE); // account deleted: userapi hdel()s the row
    const socket = makeSocket();

    const result = await handleCreateRoom(socket, { token });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('session_revoked');
    expect(socket.rooms.size).toBe(0);
  });

  test('a token whose tokenId was rotated by a later login joins nothing', async () => {
    const stale = login(ALICE);
    // A later login elsewhere hset()s a fresh tokenId over the old row.
    mockSessions.set(ALICE, { tokenId: 'rotated', userLocked: 'false' });
    const socket = makeSocket();

    const result = await handleCreateRoom(socket, { token: stale });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('session_revoked');
    expect(socket.rooms.size).toBe(0);
  });

  test('a locked account joins nothing', async () => {
    const token = login(ALICE, { locked: 'true' });
    const socket = makeSocket();

    const result = await handleCreateRoom(socket, { token });

    expect(result.success).toBe(false);
    expect(socket.rooms.size).toBe(0);
  });

  test('an expired token joins nothing and says so distinctly', async () => {
    const tokenId = 'tokexp';
    mockSessions.set(ALICE, { tokenId, userLocked: 'false' });
    const expired =
      'Bearer ' + jwt.sign({ _id: ALICE, tokenId, role: 'user' }, SECRET, { expiresIn: -10 });
    const socket = makeSocket();

    const result = await handleCreateRoom(socket, { token: expired });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('token_expired');
    expect(socket.rooms.size).toBe(0);
  });

  test('an admin token cannot claim a user room', async () => {
    mockSessions.set(ALICE, { tokenId: 'a', userLocked: 'false' });
    const adminToken =
      'Bearer ' + jwt.sign({ _id: ALICE, tokenId: 'a', role: 'admin' }, SECRET, { expiresIn: 3600 });
    const socket = makeSocket();

    const result = await handleCreateRoom(socket, { token: adminToken });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('bad_token');
    expect(socket.rooms.size).toBe(0);
  });

  test('a refused re-join EVICTS a room the socket already held', async () => {
    const token = login(ALICE);
    const socket = makeSocket();
    await handleCreateRoom(socket, { token });
    expect(socket.rooms.has(ALICE)).toBe(true);

    mockSessions.set(ALICE, { tokenId: 'rotated', userLocked: 'false' });
    const result = await handleCreateRoom(socket, { token });

    expect(result.success).toBe(false);
    expect(socket.rooms.has(ALICE)).toBe(false);
  });

  test('re-joining as a different user leaves the previous room behind', async () => {
    const aliceToken = login(ALICE);
    const bobToken = login(BOB);
    const socket = makeSocket();

    await handleCreateRoom(socket, { token: aliceToken });
    await handleCreateRoom(socket, { token: bobToken });

    expect([...socket.rooms]).toEqual([BOB]);
  });
});

// ---------------------------------------------------------------------------
// THE OTHER HALF: a refusal must be audible, and an acceptance too
// ---------------------------------------------------------------------------

describe('the client is told the outcome, so a refusal is not a frozen panel', () => {
  test('a refusal both acks and emits ROOMREJECTED with a reason', async () => {
    const socket = makeSocket();
    const ack = jest.fn();

    await handleCreateRoom(socket, BOB, ack);

    expect(ack).toHaveBeenCalledWith({ success: false, reason: 'missing_token' });
    expect(socket.emitted).toEqual([
      { event: 'ROOMREJECTED', payload: { success: false, reason: 'missing_token' } }
    ]);
  });

  test('an acceptance both acks and emits ROOMJOINED', async () => {
    const token = login(ALICE);
    const socket = makeSocket();
    const ack = jest.fn();

    await handleCreateRoom(socket, { token }, ack);

    expect(ack).toHaveBeenCalledWith({ success: true, userId: ALICE });
    expect(socket.emitted).toEqual([
      { event: 'ROOMJOINED', payload: { success: true, userId: ALICE } }
    ]);
  });

  test('a missing ack callback is not an error - the emit still happens', async () => {
    const token = login(ALICE);
    const socket = makeSocket();

    await expect(handleCreateRoom(socket, { token })).resolves.toEqual({
      success: true,
      userId: ALICE
    });
    expect(socket.emitted[0].event).toBe('ROOMJOINED');
  });
});

// ---------------------------------------------------------------------------
// PUBLIC MARKET DATA MUST NOT NEED A CREDENTIAL
// ---------------------------------------------------------------------------

describe('public channels stay open, private ones stay shut (the over-correction line)', () => {
  test.each([
    ['spot'],
    ['perpetual'],
    ['inverse'],
    ['depthChart'],
    ['BTCUSD'],
    ['BTCUSDT'],
    ['BTCUSDTperp'],
    ['BTCUSDinv'],
    ['ETHUSDC']
  ])('%s is a public channel name and is joinable with no credential', (name) => {
    expect(isPrivateRoomName(name)).toBe(false);
  });

  test.each([[ALICE], [BOB], [ALICE.toUpperCase()]])(
    '%s is ObjectId-shaped and is refused by subscribe',
    (name) => {
      expect(isPrivateRoomName(name)).toBe(true);
    }
  );

  test('EVERY room name emitted to by this service is classified correctly', () => {
    // The public names this service actually emits into, read off the
    // socketEmitOne/socketEmitAll call sites in controllers/.
    const publicNames = ['spot', 'depthChart', 'BTCUSD', 'ETHUSD', 'SOLUSD'];
    publicNames.forEach((n) => expect(isPrivateRoomName(n)).toBe(false));
    // ...and the private ones are always mongo _ids.
    [ALICE, BOB].forEach((n) => expect(isPrivateRoomName(n)).toBe(true));
  });

  test('a non-string, or an empty name, is not treated as private', () => {
    expect(isPrivateRoomName(undefined)).toBe(false);
    expect(isPrivateRoomName(null)).toBe(false);
    expect(isPrivateRoomName(42)).toBe(false);
    expect(isPrivateRoomName('')).toBe(false);
  });

  test('a name that merely CONTAINS an ObjectId is not mistaken for one', () => {
    expect(isPrivateRoomName(ALICE + 'perp')).toBe(false);
    expect(isPrivateRoomName('x' + ALICE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CREDENTIAL EXTRACTION
// ---------------------------------------------------------------------------

describe('the credential is read the way the REST layer reads it', () => {
  test('"Bearer <jwt>" and a bare "<jwt>" are the same credential', () => {
    expect(stripBearer('Bearer abc')).toBe('abc');
    expect(stripBearer('bearer abc')).toBe('abc');
    expect(stripBearer('abc')).toBe('abc');
    expect(stripBearer(undefined)).toBe('');
    expect(stripBearer(null)).toBe('');
  });

  test('a bare string payload yields NO token - it is a userId, not a credential', () => {
    expect(extractSocketToken(BOB, makeSocket())).toBe('');
  });

  test('the handshake auth token is used when the payload carries none', () => {
    expect(extractSocketToken({ userId: BOB }, makeSocket('Bearer hs'))).toBe('hs');
    expect(extractSocketToken(undefined, makeSocket('Bearer hs'))).toBe('hs');
  });

  test('the payload token wins over the handshake token', () => {
    expect(extractSocketToken({ token: 'Bearer p' }, makeSocket('Bearer hs'))).toBe('p');
  });

  test('an array payload is not mined for a token', () => {
    expect(extractSocketToken([BOB], makeSocket())).toBe('');
  });

  test('a socket with no handshake at all does not throw', () => {
    expect(extractSocketToken({ userId: BOB }, {})).toBe('');
    expect(extractSocketToken({ userId: BOB }, undefined)).toBe('');
  });
});

describe('verifySocketCredential', () => {
  test('an empty credential is refused without touching redis', async () => {
    await expect(verifySocketCredential('')).resolves.toEqual({
      ok: false,
      reason: 'missing_token'
    });
  });

  test('a valid credential returns the subject and its expiry', async () => {
    const token = login(ALICE);
    const verdict = await verifySocketCredential(stripBearer(token));
    expect(verdict.ok).toBe(true);
    expect(verdict.userId).toBe(ALICE);
    expect(typeof verdict.expiresAt).toBe('number');
  });

  test('a token with no subject is refused', async () => {
    const token = jwt.sign({ tokenId: 'x', role: 'user' }, SECRET, { expiresIn: 3600 });
    await expect(verifySocketCredential(token)).resolves.toEqual({
      ok: false,
      reason: 'bad_token'
    });
  });

  // The mobile-app login controllers that were the only writers of "app-user"
  // were never mounted by a route file and have been deleted, so the role can
  // no longer be minted. A token still carrying it is therefore either stale or
  // forged, and the socket refuses it exactly as REST does.
  test('the app-user role is refused, as it is for REST', async () => {
    mockSessions.set(ALICE, { tokenId: 'a', userLocked: 'false' });
    const token = jwt.sign({ _id: ALICE, tokenId: 'a', role: 'app-user' }, SECRET, {
      expiresIn: 3600
    });
    const verdict = await verifySocketCredential(token);
    expect(verdict).toEqual({ ok: false, reason: 'bad_token' });
  });
});

// ---------------------------------------------------------------------------
// MID-SESSION REVOCATION
// ---------------------------------------------------------------------------

describe('a session that dies mid-flight loses the room it already holds', () => {
  // advanceTimersByTimeAsync, not advanceTimersByTime: the sweep callback is
  // async and awaits a redis read, and modern fake timers also fake
  // setImmediate - so a hand-rolled microtask flush would never resolve.
  const makeIo = (sockets) => ({ sockets: { sockets: new Map(sockets.map((s) => [s.id, s])) } });

  test('a socket whose tokenId was rotated is evicted and told why', async () => {
    jest.useFakeTimers();
    try {
      const token = login(ALICE);
      const socket = makeSocket();
      await handleCreateRoom(socket, { token });
      expect(socket.rooms.has(ALICE)).toBe(true);

      startPrivateRoomRecheck(makeIo([socket]), 1000);
      mockSessions.set(ALICE, { tokenId: 'rotated', userLocked: 'false' });

      await jest.advanceTimersByTimeAsync(1000);

      expect(socket.rooms.has(ALICE)).toBe(false);
      expect(socket.emitted.map((e) => e.event)).toContain('ROOMREJECTED');
      expect(socket.emitted.at(-1).payload.reason).toBe('session_revoked');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a socket whose session is still live is LEFT ALONE (over-correction guard)', async () => {
    jest.useFakeTimers();
    try {
      const token = login(ALICE);
      const socket = makeSocket();
      await handleCreateRoom(socket, { token });

      startPrivateRoomRecheck(makeIo([socket]), 1000);
      await jest.advanceTimersByTimeAsync(5000);

      expect(socket.rooms.has(ALICE)).toBe(true);
      expect(socket.emitted.filter((e) => e.event === 'ROOMREJECTED')).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a socket holding NO private room is never touched by the sweep', async () => {
    jest.useFakeTimers();
    try {
      const anonymous = makeSocket();
      anonymous.join('spot'); // a public channel, joined with no credential
      startPrivateRoomRecheck(makeIo([anonymous]), 1000);

      await jest.advanceTimersByTimeAsync(5000);

      expect(anonymous.rooms.has('spot')).toBe(true);
      expect(anonymous.emitted).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('evictPrivateRoom clears the bookkeeping so a later sweep is a no-op', () => {
    const socket = makeSocket();
    socket.data.privateRoom = ALICE;
    socket.join(ALICE);

    evictPrivateRoom(socket, 'session_revoked');

    expect(socket.rooms.has(ALICE)).toBe(false);
    expect(socket.data.privateRoom).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// THE WIRING, ACROSS EVERY SERVICE THAT HAS A SOCKET LAYER
// ---------------------------------------------------------------------------

const readSocketIO = (service) =>
  fs.readFileSync(path.join(REPO_ROOT, service, 'config', 'socketIO.js'), 'utf8');

describe('every service with a socket layer is wired the same way', () => {
  test.each(SOCKET_SERVICES)('%s: CREATEROOM no longer joins a client-supplied id', (service) => {
    const source = readSocketIO(service);
    expect(source).not.toMatch(/socket\.join\(\s*userId\.toString\(\)\s*\)/);
    expect(source).toMatch(/handleCreateRoom\(socket, payload, ack\)/);
  });

  test.each(SOCKET_SERVICES)('%s: has a config/socketAuth.js', (service) => {
    expect(fs.existsSync(path.join(REPO_ROOT, service, 'config', 'socketAuth.js'))).toBe(true);
  });

  // Only the TRADING services expose subscribe/unSubscribe on a pair room;
  // userapi's socket layer has no pair concept, and spot is the only trading
  // service left.
  test.each([
    'cryptodex-spotapi'
  ])('%s: subscribe cannot be used as a back door into a private room', (service) => {
    const source = readSocketIO(service);
    // Both subscribe and unSubscribe must be guarded; an unguarded unSubscribe
    // would let one client eject another from their own room.
    const guards = source.match(/!isPrivateRoomName\(pair\)/g) || [];
    expect(guards.length).toBe(2);
  });

  test.each(SOCKET_SERVICES)('%s: the sweep is started, not merely mentioned', (service) => {
    // Anchored to the start of a line so a commented-out call does not pass:
    // a mutant that only turns the call into `// startPrivateRoomRecheck(...)`
    // leaves a socket in a room whose session has been revoked.
    expect(readSocketIO(service)).toMatch(/^[ \t]*startPrivateRoomRecheck\(socketIO\);/m);
  });

  test.each(SOCKET_SERVICES)(
    '%s: the client-driven relays that wrote into other users rooms are gone',
    (service) => {
      const source = readSocketIO(service);
      [
        "socket.on('pendingOrder'",
        'socket.on("pendingOrder"',
        "socket.on('filledOrder'",
        'socket.on("filledOrder"',
        "socket.on('orderHistory'",
        'socket.on("orderHistory"',
        "socket.on('orderBook'",
        'socket.on("orderBook"',
        "socket.on('recentTrades'",
        'socket.on("recentTrades"'
      ].forEach((needle) => expect(source).not.toContain(needle));
    }
  );

  test('walletapi has no socket layer to guard', () => {
    ['cryptodex-walletapi'].forEach(
      (service) => {
        expect(fs.existsSync(path.join(REPO_ROOT, service, 'config', 'socketIO.js'))).toBe(false);
        const pkg = JSON.parse(
          fs.readFileSync(path.join(REPO_ROOT, service, 'package.json'), 'utf8')
        );
        expect(Object.keys(pkg.dependencies || {})).not.toContain('socket.io');
      }
    );
  });

  test('every surviving socketAuth.js copy is the same check, not several different ones', () => {
    const normalise = (s) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, '') // doc comments differ per service by design
        .replace(/\.js(['"])/g, '$1') // babel services import without the extension
        .replace(/\s+/g, ' ')
        .trim();
    const canonical = normalise(
      fs.readFileSync(path.join(REPO_ROOT, SOCKET_SERVICES[0], 'config', 'socketAuth.js'), 'utf8')
    );
    SOCKET_SERVICES.slice(1).forEach((service) => {
      expect(
        normalise(fs.readFileSync(path.join(REPO_ROOT, service, 'config', 'socketAuth.js'), 'utf8'))
      ).toBe(canonical);
    });
  });
});

// ---------------------------------------------------------------------------
// THE FRONTEND HALF
// ---------------------------------------------------------------------------

describe('the frontend sends the credential and reacts to a refusal', () => {
  const FRONTEND = path.join(REPO_ROOT, 'cryptodex-frontend');
  const connectivity = fs.readFileSync(
    path.join(FRONTEND, 'config', 'socketConnectivity.js'),
    'utf8'
  );

  test('CREATEROOM carries a token, not a bare userId', () => {
    expect(connectivity).toMatch(/emit\("CREATEROOM", \{ token \}\)/);
    expect(connectivity).not.toMatch(/emit\("CREATEROOM", userId\)/);
  });

  test('the join is re-sent on connect, which is the only time an emit can land', () => {
    expect(connectivity).toMatch(/socket\.on\("connect", \(\) => \{\s*createSocketUser\(\);/);
    // The old code re-emitted from "disconnect", where the emit is dropped.
    expect(connectivity).not.toMatch(/on\("disconnect"[\s\S]{0,200}createSocketUser/);
  });

  test('a credential-shaped refusal ends the session instead of freezing the screen', () => {
    expect(connectivity).toMatch(/ROOMREJECTED/);
    expect(connectivity).toMatch(/CREDENTIAL_REASONS\.includes\(data\?\.reason\)/);
    expect(connectivity).toMatch(/endSession/);
    expect(connectivity).toMatch(/window\.location\.href = "\/login"/);
  });

  test('a logged-out visitor sends no join at all', () => {
    expect(connectivity).toMatch(/if \(!token\) \{\s*return false;/);
  });

  test('the credential is read from where the REST layer reads it', () => {
    const cred = fs.readFileSync(path.join(FRONTEND, 'config', 'socketCredential.js'), 'utf8');
    expect(cred).toMatch(/auth\.session\.token/);
    expect(cred).toMatch(/CookiesLib\.get\("userToken"\)/);
  });
});
