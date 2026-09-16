/**
 * SPOT ACCOUNT STAND-DOWN (BLOCKER REGRESSION)
 * ============================================
 *
 * THE DEFECT THESE PIN
 * --------------------
 * spotapi honoured NO freeze of any kind. walletapi sets `wallet.frozen` and
 * refuses value-moving routes while it is set; spot - the product most users
 * reach first - had no check anywhere: not in the
 * router, not in orderPlace, not in the faucet, not in the paper withdrawal
 * path. A frozen wallet whose owner still held a live session could place spot
 * orders, lock spot balance into `walletbalance_spot_inOrder`, keep trading as
 * the 2s matcher filled those orders, re-fund itself from `/faucet/claim` or
 * `/faucet/reset`, and drain the account through `/requestWithdrawal`.
 *
 * Deactivation reached spot only as a ONE-SHOT SWEEP
 * (`cancelOrderForDeactiveAcc`). A sweep cancels what is resting at that
 * instant and says nothing about the next request; it is not a gate.
 *
 * WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY
 * ------------------------------------------------
 * The verdict and the guard are exercised against the REAL modules with only
 * redis and the walletapi channel doubled, so a test fails if the policy is
 * bypassed, weakened or deleted - not merely if a mock stops being called. The
 * route wiring is asserted against the route file's own text, because "the
 * guard is mounted on /orderPlace, after auth and before the decrypt chain" is
 * a fact about that file and nothing else can be asked about it without booting
 * the matching engine.
 *
 * THE LINE THESE HOLD, IN BOTH DIRECTIONS
 * ---------------------------------------
 * NOTHING MAY CREATE OR SETTLE EXPOSURE OR MOVE VALUE; RELEASING AN UNFILLED
 * RESERVATION IS ALWAYS ALLOWED. Both halves are pinned. The OVER-CORRECTION
 * mutants are as load-bearing as the under-correction ones: a "tightening" that
 * gates /cancelOrder, or the reads, or the deactivation sweep, would trap a
 * user's margin behind an order they can no longer cancel, and these fail on
 * it. So does a guard that refuses a LIVE account, and so does any writer added
 * to the shared `account_standdown` mark, which spot reads and must never
 * write.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// doubles
// ---------------------------------------------------------------------------

let redisStore = {};
let redisFail = { hget: false };
let writeAttempts = [];

const redisImpl = {
  hget: async (hash, field) => {
    if (redisFail.hget) throw new Error('redis down');
    const h = redisStore[hash];
    return h && h[String(field)] !== undefined ? h[String(field)] : null;
  },
  // hset/hdel exist ONLY so that a spot module which starts writing the shared
  // mark is caught red-handed by the assertions below, rather than silently
  // succeeding against a module that does not export them.
  hset: async (hash, field, value) => {
    writeAttempts.push({ op: 'hset', hash, field: String(field), value });
    if (!redisStore[hash]) redisStore[hash] = {};
    redisStore[hash][String(field)] =
      typeof value === 'string' ? value : JSON.stringify(value);
    return 1;
  },
  hdel: async (hash, field) => {
    writeAttempts.push({ op: 'hdel', hash, field: String(field) });
    if (redisStore[hash]) delete redisStore[hash][String(field)];
    return 1;
  }
};

const mockRedis = {
  hget: jest.fn(redisImpl.hget),
  hset: jest.fn(redisImpl.hset),
  hdel: jest.fn(redisImpl.hdel)
};

jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  hget: (...a) => mockRedis.hget(...a),
  hset: (...a) => mockRedis.hset(...a),
  hdel: (...a) => mockRedis.hdel(...a)
}));

let walletVerdict = { known: true, frozen: false };
const mockCheckWalletFrozen = jest.fn(async () => walletVerdict);
jest.mock('../../grpc/walletStandDownService.js', () => ({
  __esModule: true,
  checkWalletFrozen: (...a) => mockCheckWalletFrozen(...a)
}));

import {
  STAND_DOWN_HASH,
  STAND_DOWN_HTTP_STATUS,
  STAND_DOWN_MESSAGE,
  STAND_DOWN_STATUS,
  STAND_DOWN_UNKNOWN_HTTP_STATUS,
  STAND_DOWN_UNKNOWN_MESSAGE,
  STAND_DOWN_UNKNOWN_STATUS,
  isCorruptRecord,
  isStoodDown,
  makeStandDownGuard,
  normaliseUserId,
  parseStandDownRecord,
  readStandDownMark,
  resolveStandDown,
} from '../../lib/accountStandDown.js';

import * as standDownLib from '../../lib/accountStandDown.js';
import * as standDownState from '../../controllers/standDownState.js';

const USER_ID = '6a70f1c287c92c7218ac37fc';
const OTHER_ID = '6a70fe409c46d957cd45ba3a';

const deps = () => ({ hget: mockRedis.hget, hset: mockRedis.hset, hdel: mockRedis.hdel });

const freezeInRedis = (userId, record = { frozen: true, frozenAt: '2026-08-07T00:00:00.000Z' }) => {
  if (!redisStore[STAND_DOWN_HASH]) redisStore[STAND_DOWN_HASH] = {};
  redisStore[STAND_DOWN_HASH][userId] = JSON.stringify(record);
};

const rawInRedis = (userId, raw) => {
  if (!redisStore[STAND_DOWN_HASH]) redisStore[STAND_DOWN_HASH] = {};
  redisStore[STAND_DOWN_HASH][userId] = raw;
};

const mockRes = () => {
  const res = { statusCode: null, body: null, ended: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.ended = true;
    return res;
  };
  return res;
};

beforeEach(() => {
  redisStore = {};
  redisFail = { hget: false };
  writeAttempts = [];
  walletVerdict = { known: true, frozen: false };
  mockRedis.hget.mockImplementation(redisImpl.hget);
  mockRedis.hset.mockImplementation(redisImpl.hset);
  mockRedis.hdel.mockImplementation(redisImpl.hdel);
  mockCheckWalletFrozen.mockImplementation(async () => walletVerdict);
});

// ---------------------------------------------------------------------------
// 1. THE SHARED MARK
// ---------------------------------------------------------------------------

describe('the shared account_standdown mark', () => {
  test('is the SAME hash walletapi reads - renaming it silently un-freezes every already-stood-down account', () => {
    expect(STAND_DOWN_HASH).toBe('account_standdown');
  });

  test('reads the mark out of that hash, keyed by the raw user id', async () => {
    freezeInRedis(USER_ID);
    const mark = await readStandDownMark(deps(), USER_ID);
    expect(mark).toEqual(expect.objectContaining({ known: true, frozen: true }));
    expect(mockRedis.hget).toHaveBeenCalledWith('account_standdown', USER_ID);
  });

  test('an account with no record at all is LIVE', async () => {
    const mark = await readStandDownMark(deps(), USER_ID);
    expect(mark).toEqual(expect.objectContaining({ known: true, frozen: false }));
  });

  test('one user\'s freeze does not stand another user down', async () => {
    freezeInRedis(OTHER_ID);
    const mark = await readStandDownMark(deps(), USER_ID);
    expect(mark.frozen).toBe(false);
  });

  test('an explicit { frozen: false } record is LIVE, not frozen', async () => {
    freezeInRedis(USER_ID, { frozen: false });
    const mark = await readStandDownMark(deps(), USER_ID);
    expect(mark).toEqual(expect.objectContaining({ known: true, frozen: false }));
  });

  test('"stood down" is strictly === true, so no truthy near-miss locks an account out by accident', () => {
    expect(isStoodDown({ frozen: true })).toBe(true);
    expect(isStoodDown({ frozen: 'true' })).toBe(false);
    expect(isStoodDown({ frozen: 1 })).toBe(false);
    expect(isStoodDown({ frozen: false })).toBe(false);
    expect(isStoodDown({})).toBe(false);
    expect(isStoodDown(null)).toBe(false);
    expect(isStoodDown(undefined)).toBe(false);
  });

  test('a record that cannot be parsed is UNKNOWN - never quietly treated as live', async () => {
    rawInRedis(USER_ID, '{"frozen":tr');
    const mark = await readStandDownMark(deps(), USER_ID);
    expect(mark.known).toBe(false);
    expect(mark.frozen).toBe(false);
  });

  test('a bare non-JSON string is UNKNOWN, not live', async () => {
    rawInRedis(USER_ID, 'frozen');
    const mark = await readStandDownMark(deps(), USER_ID);
    expect(mark.known).toBe(false);
  });

  test('a JSON scalar is UNKNOWN, not live', async () => {
    rawInRedis(USER_ID, 'false');
    const mark = await readStandDownMark(deps(), USER_ID);
    expect(mark.known).toBe(false);
  });

  test('redis throwing is UNKNOWN, not live', async () => {
    redisFail.hget = true;
    const mark = await readStandDownMark(deps(), USER_ID);
    expect(mark).toEqual(expect.objectContaining({ known: false, frozen: false }));
  });

  test('an id that is not a mongo id has no field in the hash, so redis is not even asked', async () => {
    const mark = await readStandDownMark(deps(), 'not-an-id');
    expect(mark).toEqual(
      expect.objectContaining({ known: true, frozen: false, invalidId: true })
    );
    expect(mockRedis.hget).not.toHaveBeenCalled();
  });

  test('an ObjectId-like object is normalised to its hex string', async () => {
    freezeInRedis(USER_ID);
    const objectId = { toString: () => USER_ID };
    expect(normaliseUserId(objectId)).toBe(USER_ID);
    const mark = await readStandDownMark(deps(), objectId);
    expect(mark.frozen).toBe(true);
  });

  test('parseStandDownRecord distinguishes absent from corrupt', () => {
    expect(parseStandDownRecord(null)).toBeNull();
    expect(parseStandDownRecord(undefined)).toBeNull();
    expect(parseStandDownRecord('')).toBeNull();
    expect(parseStandDownRecord('{"frozen":true}')).toEqual({ frozen: true });
    expect(parseStandDownRecord({ frozen: true })).toEqual({ frozen: true });
    expect(isCorruptRecord(parseStandDownRecord('nonsense'))).toBe(true);
    expect(isCorruptRecord(parseStandDownRecord(null))).toBe(false);
    expect(isCorruptRecord({ frozen: true, corrupt: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. THE VERDICT: TWO SOURCES, AND IT FAILS CLOSED
// ---------------------------------------------------------------------------

describe('resolveStandDown', () => {
  const resolve = (mark, wallet) =>
    resolveStandDown({
      readMark: typeof mark === 'function' ? mark : async () => mark,
      readWallet: typeof wallet === 'function' ? wallet : async () => wallet
    });

  test('a frozen mark refuses, and walletapi is not even consulted - so a walletapi outage can never un-freeze anybody', async () => {
    const readWallet = jest.fn(async () => ({ known: true, frozen: false }));
    const verdict = await resolve({ known: true, frozen: true }, readWallet);
    expect(verdict).toEqual({ frozen: true, known: true, source: 'local' });
    expect(readWallet).not.toHaveBeenCalled();
  });

  test('a frozen WALLET refuses even with no local mark - the operator-freeze case that has no mark at all', async () => {
    const verdict = await resolve(
      { known: true, frozen: false },
      { known: true, frozen: true }
    );
    expect(verdict).toEqual({ frozen: true, known: true, source: 'wallet' });
  });

  test('both live and both readable lets the request through', async () => {
    const verdict = await resolve(
      { known: true, frozen: false },
      { known: true, frozen: false }
    );
    expect(verdict).toEqual({ frozen: false, known: true, source: 'none' });
  });

  test('an unreadable mark is UNKNOWN even when walletapi says live', async () => {
    const verdict = await resolve(
      { known: false, frozen: false },
      { known: true, frozen: false }
    );
    expect(verdict.frozen).toBe(false);
    expect(verdict.known).toBe(false);
  });

  test('an unreachable walletapi is UNKNOWN even when the mark says live', async () => {
    const verdict = await resolve(
      { known: true, frozen: false },
      { known: false, frozen: false }
    );
    expect(verdict.known).toBe(false);
  });

  test('neither source readable is UNKNOWN', async () => {
    const verdict = await resolve(
      { known: false, frozen: false },
      { known: false, frozen: false }
    );
    expect(verdict.known).toBe(false);
  });

  test('the two sources can only disagree in the SAFE direction: an unreadable mark plus a frozen wallet still refuses', async () => {
    const verdict = await resolve(
      { known: false, frozen: false },
      { known: true, frozen: true }
    );
    expect(verdict).toEqual({ frozen: true, known: true, source: 'wallet' });
  });

  test('a mark reader that THROWS is UNKNOWN, not live', async () => {
    const verdict = await resolve(
      async () => {
        throw new Error('redis down');
      },
      { known: true, frozen: false }
    );
    expect(verdict.known).toBe(false);
  });

  test('a wallet reader that THROWS is UNKNOWN, not live', async () => {
    const verdict = await resolve({ known: true, frozen: false }, async () => {
      throw new Error('grpc down');
    });
    expect(verdict.known).toBe(false);
  });

  test('a reader that answers undefined is UNKNOWN, not live', async () => {
    const verdict = await resolve(async () => undefined, async () => undefined);
    expect(verdict.known).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. THE WIRED VERDICT (real lib + real state module, redis and grpc doubled)
// ---------------------------------------------------------------------------

describe('resolveAccountStandDown, as the service actually wires it', () => {
  test('a mark already present in the shared hash stands the account down on SPOT', async () => {
    freezeInRedis(USER_ID);
    const verdict = await standDownState.resolveAccountStandDown(USER_ID);
    expect(verdict.frozen).toBe(true);
    expect(verdict.source).toBe('local');
  });

  test('a wallet frozen by walletapi ALONE - a live session, no deactivation - stands the account down on SPOT', async () => {
    walletVerdict = { known: true, frozen: true };
    const verdict = await standDownState.resolveAccountStandDown(USER_ID);
    expect(verdict.frozen).toBe(true);
    expect(verdict.source).toBe('wallet');
    expect(mockCheckWalletFrozen).toHaveBeenCalledWith(USER_ID);
  });

  test('a live account is allowed', async () => {
    const verdict = await standDownState.resolveAccountStandDown(USER_ID);
    expect(verdict).toEqual({ frozen: false, known: true, source: 'none' });
  });

  test('redis down + walletapi live is UNKNOWN, which is a refusal', async () => {
    redisFail.hget = true;
    const verdict = await standDownState.resolveAccountStandDown(USER_ID);
    expect(verdict.known).toBe(false);
  });

  test('assertAccountMayAct reports the same three outcomes to a non-HTTP caller', async () => {
    expect(await standDownState.assertAccountMayAct(USER_ID)).toEqual(
      expect.objectContaining({ allowed: true })
    );

    freezeInRedis(USER_ID);
    expect(await standDownState.assertAccountMayAct(USER_ID)).toEqual(
      expect.objectContaining({ allowed: false, reason: STAND_DOWN_STATUS })
    );

    redisStore = {};
    redisFail.hget = true;
    expect(await standDownState.assertAccountMayAct(USER_ID)).toEqual(
      expect.objectContaining({ allowed: false, reason: STAND_DOWN_UNKNOWN_STATUS })
    );
  });

  // OVER-CORRECTION MUTANT. Spot is a READER of the account-level freeze. It has
  // no deactivation flow, no operator surface and no compensating action, so a
  // trading service that can MINT or CLEAR an account freeze is strictly worse
  // than one that cannot. Adding an hset/hdel here fails this.
  test('reading the verdict NEVER writes the shared mark - not on the frozen path, not on the live path, not on the unreadable path', async () => {
    await standDownState.resolveAccountStandDown(USER_ID);

    freezeInRedis(USER_ID);
    await standDownState.resolveAccountStandDown(USER_ID);

    redisStore = {};
    redisFail.hget = true;
    await standDownState.resolveAccountStandDown(USER_ID);

    expect(writeAttempts).toEqual([]);
    expect(mockRedis.hset).not.toHaveBeenCalled();
    expect(mockRedis.hdel).not.toHaveBeenCalled();
  });

  test('neither module exports a writer for the shared mark, so there is none to call by mistake', () => {
    for (const name of ['markStandDown', 'clearStandDown', 'applyStandDownMode']) {
      expect(standDownLib[name]).toBeUndefined();
    }
    for (const name of ['freezeAccount', 'unfreezeAccount', 'checkAccountStandDown']) {
      expect(standDownState[name]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. THE GUARD
// ---------------------------------------------------------------------------

describe('blockStoodDownAccount', () => {
  const runGuard = async (guard, userId = USER_ID) => {
    const req = { user: userId === null ? undefined : { id: userId }, originalUrl: '/api/spot/orderPlace' };
    const res = mockRes();
    const next = jest.fn();
    await guard(req, res, next);
    return { res, next };
  };

  test('refuses a stood-down account with 423 and the documented reason code', async () => {
    freezeInRedis(USER_ID);
    const { res, next } = await runGuard(standDownState.blockStoodDownAccount);
    expect(res.statusCode).toBe(STAND_DOWN_HTTP_STATUS);
    expect(res.statusCode).toBe(423);
    expect(res.body).toEqual({
      status: false,
      success: false,
      reason: STAND_DOWN_STATUS,
      message: STAND_DOWN_MESSAGE
    });
    expect(res.body.reason).toBe('ACCOUNT_STOOD_DOWN');
    expect(next).not.toHaveBeenCalled();
  });

  test('refuses an UNREADABLE state with 503 - it fails CLOSED', async () => {
    redisFail.hget = true;
    const { res, next } = await runGuard(standDownState.blockStoodDownAccount);
    expect(res.statusCode).toBe(STAND_DOWN_UNKNOWN_HTTP_STATUS);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      status: false,
      success: false,
      reason: STAND_DOWN_UNKNOWN_STATUS,
      message: STAND_DOWN_UNKNOWN_MESSAGE
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('the refusal tells the user their orders and balances are untouched and that cancel still works', () => {
    expect(STAND_DOWN_MESSAGE).toMatch(/unchanged/i);
    expect(STAND_DOWN_MESSAGE).toMatch(/cancel/i);
  });

  // OVER-CORRECTION MUTANT: a guard that refuses everybody is not a guard.
  test('lets a LIVE account through, calling next() exactly once and writing no response', async () => {
    const { res, next } = await runGuard(standDownState.blockStoodDownAccount);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(res.ended).toBe(false);
  });

  test('an unauthenticated request is refused with 401, never passed through', async () => {
    const guard = makeStandDownGuard({ resolve: async () => ({ frozen: false, known: true }) });
    const { res, next } = await runGuard(guard, null);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('a resolve that THROWS is 503, not an unhandled rejection and not a pass', async () => {
    const guard = makeStandDownGuard({
      resolve: async () => {
        throw new Error('boom');
      }
    });
    const { res, next } = await runGuard(guard);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  test('a resolve that answers a shape the guard does not understand is 503, not a pass', async () => {
    const guard = makeStandDownGuard({ resolve: async () => undefined });
    const { res, next } = await runGuard(guard);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  test('a frozen verdict wins over an unknown one', async () => {
    const guard = makeStandDownGuard({
      resolve: async () => ({ frozen: true, known: false, source: 'local' })
    });
    const { res } = await runGuard(guard);
    expect(res.statusCode).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// 5. ROUTE WIRING - the half of the change no unit can reach
// ---------------------------------------------------------------------------

const ROUTE_FILE = path.join(process.cwd(), 'routes', 'spot.route.js');
const routeSource = fs.readFileSync(ROUTE_FILE, 'utf8');

/**
 * The route table WITHOUT comments. Every claim below is about executable
 * wiring, so a comment that merely mentions `blockStoodDownAccount` next to
 * /cancelOrder must not be able to satisfy - or to break - any of it.
 */
const strippedSource = routeSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const routeTable = (() => {
  const table = [];
  const re = /router\s*\.\s*route\(\s*(["'`])(.*?)\1\s*\)\s*\.\s*(\w+)\(([^;]*?)\)\s*;/g;
  let match;
  while ((match = re.exec(strippedSource)) !== null) {
    table.push({
      path: match[2],
      method: match[3],
      chain: match[4]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    });
  }
  return table;
})();

const chainFor = (routePath, method) => {
  const row = routeTable.find((r) => r.path === routePath && r.method === method);
  if (!row) throw new Error(`route not found in spot.route.js: ${method.toUpperCase()} ${routePath}`);
  return row.chain;
};

// `/requestWithdrawal` was the fourth gated route. It is DELETED, along with
// /getDepositInfo, /getDepositHistory, /getWithdrawalStatus and
// /getWithdrawalHistory: they described money arriving from and leaving to
// somewhere off-venue, and there is nowhere off-venue. It already answered 410;
// a route that no longer exists cannot lose its gate, and DELETED below asserts
// that stronger fact.
const GATED = [
  ['/orderPlace', 'post'],
  ['/faucet/claim', 'post'],
  ['/faucet/reset', 'post'],
];

// `/getDepositHistory` was in this list and has been taken out of it, because
// deleting that route was wrong and the frontend proved it: a faucet claim
// writes one DepositEvent per credited leg (faucet.controller.js
// `recordCreditedLegs`), and with no route to read them the claim page's own
// "Demo credit history" table showed "No Records Found" for an account that had
// just claimed. The reader is back as `/faucet/history` - see UNGATED below,
// which pins both that it is authenticated and that it is not gated. The OLD
// spelling stays asserted-absent here: it named a deposit, and nothing is ever
// deposited on this venue.
const DELETED = [
  '/requestWithdrawal',
  '/getWithdrawalStatus',
  '/getWithdrawalHistory',
  '/getDepositInfo',
  '/getDepositHistory',
  '/chartUpdateToDB',
  '/chartUpdateToRedis',
];

const UNGATED = [
  // THE RELEASE ROUTE. Never gated - see below.
  ['/cancelOrder', 'post'],
  // Reads. A read cannot move a balance, and a stood-down user still has to be
  // able to SEE the orders they are still allowed to cancel.
  ['/tradePair', 'get'],
  ['/ordeBook/:pairId', 'get'],
  ['/openOrder/:pairId', 'get'],
  ['/filledOrder/:pairId', 'get'],
  ['/orderHistory/:pairId', 'get'],
  ['/tradeHistory/:pairId', 'get'],
  ['/marketPrice/:pairId', 'get'],
  ['/recentTrade/:pairId', 'get'],
  ['/depth-chart', 'post'],
  ['/getMySpotHistory', 'get'],
  ['/getFilledOrderHistory', 'get'],
  // The demo-credit history. A read of rows the claim already wrote: a
  // stood-down account may not claim and may still see what it was given.
  ['/faucet/history', 'get'],
  ['/get-trends', 'get'],
  ['/health', 'get']
];

describe('route wiring: what the stand-down stops', () => {
  test.each(DELETED)('%s is not in the router at all', (routePath) => {
    // The two chart writers are here for a different reason: they were
    // UNAUTHENTICATED POSTs that rewrote every pair's candle history, and they
    // took no (req, res), so express ran the rewrite and then held the
    // connection open until the client gave up.
    expect(strippedSource).not.toContain(`"${routePath}"`);
    expect(strippedSource).not.toContain(`'${routePath}'`);
  });

  test('the guard is imported from the one module that owns the verdict', () => {
    expect(strippedSource).toMatch(
      /import\s*\{\s*blockStoodDownAccount\s*\}\s*from\s*["']\.\.\/controllers\/standDownState\.js["']/
    );
  });

  test.each(GATED)('%s %s is GATED', (routePath, method) => {
    expect(chainFor(routePath, method)).toContain('blockStoodDownAccount');
  });

  test.each(GATED)('%s %s gates AFTER authentication - an anonymous caller is a 401, not a 423', (routePath, method) => {
    const chain = chainFor(routePath, method);
    expect(chain.indexOf('passportAuth')).toBeGreaterThanOrEqual(0);
    expect(chain.indexOf('blockStoodDownAccount')).toBeGreaterThan(
      chain.indexOf('passportAuth')
    );
  });

  test('/orderPlace refuses BEFORE the payload is decrypted or validated, so nothing reads or writes a balance first', () => {
    const chain = chainFor('/orderPlace', 'post');
    const guardAt = chain.indexOf('blockStoodDownAccount');
    for (const later of [
      'spotTradeValid.decryptValidate',
      'spotTradeCtrl.decryptTradeOrder',
      'spotTradeValid.orderPlaceValidate',
      'spotTradeCtrl.orderPlace'
    ]) {
      expect(chain.indexOf(later)).toBeGreaterThan(guardAt);
    }
  });

  test('every order TYPE is covered by that single gate, because they all dispatch through the one handler', () => {
    const controller = fs.readFileSync(
      path.join(process.cwd(), 'controllers', 'spot.controller.js'),
      'utf8'
    );
    // orderPlace is the only entry point the router exposes; limit / market /
    // stop_limit / stop_market / trailing_stop are dispatched inside it, so a
    // guard on the route covers all of them. If a new order route is ever added
    // it will not be caught by this file's other assertions, so the invariant
    // that matters is that the router has exactly ONE order-placing route.
    const orderRoutes = routeTable.filter((r) =>
      /spotTradeCtrl\.(limitOrderPlace|marketOrderPlace|stopLimitOrderPlace|stopMarketOrderPlace|trailingStopOrderPlace|orderPlace)/.test(
        r.chain.join(',')
      )
    );
    expect(orderRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['post /orderPlace']);
    expect(controller).toMatch(/export const orderPlace = async \(req, res\) => \{/);
  });

  // ------------------------------------------------------------------
  // OVER-CORRECTION MUTANTS. These fail if somebody "tightens" the gate.
  // ------------------------------------------------------------------

  test.each(UNGATED)('%s %s is NOT gated', (routePath, method) => {
    expect(chainFor(routePath, method)).not.toContain('blockStoodDownAccount');
  });

  test('/faucet/history is mounted, and is a READ OF ONE USER\'S OWN ROWS - so it is authenticated', () => {
    // Not gated (above), but it must never be anonymous: the handler scopes
    // every query to `req.user.id`, so without passportAuth there is no user to
    // scope to and the endpoint would answer 401 by accident rather than by
    // design. This route only exists again because deleting it left the claim
    // page's "Demo credit history" empty for accounts that had just claimed.
    const chain = chainFor('/faucet/history', 'get');
    expect(chain).toEqual(['passportAuth', 'depositCtrl.getDepositHistory']);
  });

  test('/cancelOrder stays open: a stand-down must never trap margin behind an unfilled order', () => {
    const chain = chainFor('/cancelOrder', 'post');
    // `trackValueFlight` is present and is NOT the stand-down. It registers the
    // request for the few milliseconds a `faucet/reset` of this same account
    // could otherwise write an absolute balance over its refund; it consults no
    // account state and refuses nothing outside that window. The property this
    // test owns is that the STAND-DOWN is absent.
    expect(chain).not.toContain('blockStoodDownAccount');
    expect(chain).toEqual([
      'passportAuth',
      'trackValueFlight',
      'spotTradeCtrl.cancelOrder'
    ]);
  });

  test('the deactivation sweep is not gated either - a stand-down must not be able to block its own cleanup', () => {
    const grpcServer = fs.readFileSync(
      path.join(process.cwd(), 'grpc', 'server.js'),
      'utf8'
    );
    expect(grpcServer).toContain('cancelOrderForDeactiveAcc');
    expect(grpcServer).not.toContain('blockStoodDownAccount');
    expect(grpcServer).not.toContain('assertAccountMayAct');
  });

  test('exactly the three value-moving routes are gated - no more, no fewer', () => {
    const gated = routeTable
      .filter((r) => r.chain.includes('blockStoodDownAccount'))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(gated).toEqual(
      [
        'post /faucet/claim',
        'post /faucet/reset',
        'post /orderPlace'
      ].sort()
    );
  });

  // The admin router and the public /v1 aggregator router used to be checked
  // here too. Both have since been DELETED outright - see
  // tests/unit/public-market-data-units.test.js for the /v1 removal - so what
  // is left to assert is that the stand-down guard did not leak into the one
  // other router that survives, and that the two deleted ones stay deleted.
  test('the surviving dashboard router is untouched by this change', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'routes', 'dashboard.route.js'), 'utf8');
    expect(src).not.toContain('blockStoodDownAccount');
  });

  test('the admin and public-v1 routers are gone', () => {
    for (const file of ['admin.route.js', 'v1.route.js']) {
      expect(fs.existsSync(path.join(process.cwd(), 'routes', file))).toBe(false);
    }
  });
});
