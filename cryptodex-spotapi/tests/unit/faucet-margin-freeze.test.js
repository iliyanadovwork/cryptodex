/**
 * THE FAUCET RESET'S MARGIN FREEZE AND ITS OBLIGATION GATES
 * =========================================================
 *
 * WHAT WENT WRONG, MEASURED LIVE
 * ------------------------------
 * `POST /api/spot/faucet/reset` writes ABSOLUTE balances and zeroes the spot
 * `_locked` and `_inOrder` reservation counters. It decided whether it was
 * ALLOWED to by asking MONGO which of the account's orders were open - and the
 * order path writes mongo LAST, without awaiting the write, so that gate is
 * structurally blind to an order in flight.
 *
 * The freeze was honoured by NOTHING in this service either: spot's reservation
 * (`hincrbyfloatIfEnough`) had no freeze key at all. Measured through the
 * ordinary API, no admin access: an account taken from 10,000 to 48,039.52 in
 * four consecutive wins, 12 of 32 races.
 *
 * WHAT IS PINNED HERE
 * -------------------
 * The properties the fix rests on, each of which a plausible mistake breaks:
 *
 *   1. the freeze is taken, and it is taken BEFORE anything is read or written;
 *   2. a REGISTERED VALUE FLIGHT refuses the reset - a request that has already
 *      taken money and not yet published what it took it for is invisible to
 *      every store, so the only way to see it is to have it say so
 *      (lib/valueFlight.js). Expired registrations do not refuse; unreadable
 *      ones do;
 *   3. an order RESTING IN A REDIS BOOK refuses the reset, and it is the BOOK
 *      that is read - mongo lags it by an unbounded amount. Market orders count
 *      too; other users' orders and the house ladder do not;
 *   4. the freeze is ALWAYS given back - on success, on each refusal, and when
 *      the body throws;
 *   5. a reset that cannot take the freeze, or cannot enumerate the books,
 *      changes nothing at all.
 *
 * An ordinary flat account still resets exactly as before.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import mongoose from 'mongoose';

jest.mock('redis', () => {
  const client = {
    on: () => {},
    set: (...args) => args.pop()(null, 'OK'),
    ttl: (...args) => args.pop()(null, 3600),
    del: (...args) => args.pop()(null, 1)
  };
  return { createClient: () => client };
});

jest.mock('../../config/index.js', () => ({
  __esModule: true,
  default: { REDIS_URL: 'redis://127.0.0.1:6379', REDIS_PREFIX: 'cryptodex_' }
}));

jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  hset: jest.fn(),
  hget: jest.fn(),
  hgetall: jest.fn(),
  hincbyfloat: jest.fn(),
  // The ledger-writing mutations. The reset writes absolute balances and the
  // faucet credits; both now go through the ledger, so both must exist here or
  // the controller fails with "not a function" and every assertion below reads
  // as a policy failure rather than a missing stub.
  moveBalanceLogged: jest.fn(async (k, f, amt, o = {}) => ({
    balance: String(amt),
    entryId: '1-0'
  })),
  moveBalanceSigned: jest.fn(async (k, f, d) => String(d)),
  setBalanceLogged: jest.fn(async (k, f, v) => String(v)),
  hdel: jest.fn(),
  beginFlight: jest.fn(),
  claimOnce: jest.fn(),
  releaseClaim: jest.fn(),
  FROZEN: 'FROZEN'
}));

jest.mock('../../grpc/walletService.js', () => ({
  __esModule: true,
  updateUserAsset: jest.fn(),
  getUserAsset: jest.fn()
}));

jest.mock('../../models/currency.js', () => {
  const assetsCollection = {
    find: jest.fn(),
    findOne: jest.fn(),
    insertOne: jest.fn(),
    updateOne: jest.fn()
  };
  const walletCollection = { findOne: jest.fn() };
  const Currency = {
    find: jest.fn(),
    findOne: jest.fn(),
    db: {
      collection: (name) => (name === 'wallet' ? walletCollection : assetsCollection)
    }
  };
  return {
    __esModule: true,
    default: Currency,
    __assetsCollection: assetsCollection,
    __walletCollection: walletCollection
  };
});

jest.mock('../../models/index.js', () => ({
  __esModule: true,
  DepositEvent: { create: jest.fn() },
  OrderHistory: { find: jest.fn(), updateMany: jest.fn() }
}));


import { resetFaucet } from '../../controllers/faucet.controller.js';
import {
  hset,
  hget,
  hgetall,
  hincbyfloat,
  hdel,
  claimOnce,
  releaseClaim,
} from '../../controllers/redis.controller.js';
import { updateUserAsset } from '../../grpc/walletService.js';
import Currency, {
  __assetsCollection as assetsCollection,
  __walletCollection as walletCollection
} from '../../models/currency.js';
// The reset no longer writes OrderHistory at all - it refuses instead of
// cancelling - and the two assertions below are what keep it that way.
import { OrderHistory } from '../../models/index.js';
import { marginFreezeKey } from '../../lib/marginFreeze.js';
import { valueFlightKey, VALUE_FLIGHT_TTL_MS } from '../../lib/valueFlight.js';


const USER_ID = new mongoose.Types.ObjectId().toString();
const USDC_ID = new mongoose.Types.ObjectId();
const USD_ID = new mongoose.Types.ObjectId();
const BTC_ID = new mongoose.Types.ObjectId();
/** The flat `assets` document id - the WALLET API's field style for USDC. */
const USDC_ASSET_ID = new mongoose.Types.ObjectId();

const hashKey = (key, field) => `${key}|${field}`;
const FREEZE_KEY = marginFreezeKey(USER_ID);
const FLIGHT_KEY = valueFlightKey(USER_ID);
const PAIR_ID = new mongoose.Types.ObjectId().toString();

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};
const makeReq = () => ({ user: { id: USER_ID } });

describe('faucet reset: margin freeze + obligation gates', () => {
  let hash;
  let claims;
  /** Every mutating call, in order, so ORDERING can be asserted. */
  let trace;

  beforeEach(() => {
    hash = {};
    claims = {};
    trace = [];

    hset.mockImplementation(async (key, field, value) => {
      trace.push(`hset:${key}`);
      hash[hashKey(key, field)] = value;
    });
    hget.mockImplementation(async (key, field) => {
      // READS ARE TRACED TOO. The ordering that matters is "freeze, THEN look",
      // and a test that only watches writes cannot tell that apart from "look,
      // then freeze" - which is the whole defect, one step removed.
      trace.push(`hget:${key}`);
      const k = hashKey(key, field);
      return k in hash ? hash[k] : null;
    });
    hincbyfloat.mockImplementation(async (key, field, inc) => {
      trace.push(`hincbyfloat:${key}`);
      const k = hashKey(key, field);
      const next = parseFloat(hash[k] != null ? hash[k] : 0) + parseFloat(inc);
      hash[k] = next.toString();
      return next.toString();
    });
    hdel.mockResolvedValue(1);
    // Whole-hash reads, derived from the SAME store the field writes land in,
    // so a test can seed a book with hset and this sees it.
    hgetall.mockImplementation(async (key) => {
      trace.push(`hgetall:${key}`);
      const out = {};
      for (const [k, v] of Object.entries(hash)) {
        const at = k.indexOf('|');
        if (k.slice(0, at) === key) out[k.slice(at + 1)] = v;
      }
      return out;
    });

    // A pair cache with one pair in it: without one the reset cannot prove the
    // account has nothing resting and refuses (503), which is its own test
    // below. Seeded directly rather than through hset so it does not appear in
    // the ordering trace.
    hash[hashKey('spotPairdata', PAIR_ID)] = JSON.stringify({
      _id: PAIR_ID,
      pairName: 'BTCUSD'
    });

    claimOnce.mockImplementation(async (key, token) => {
      trace.push(`claim:${key}`);
      if (Object.prototype.hasOwnProperty.call(claims, key)) return false;
      claims[key] = token;
      return true;
    });
    releaseClaim.mockImplementation(async (key, token) => {
      trace.push(`release:${key}`);
      if (claims[key] !== token) return false;
      delete claims[key];
      return true;
    });

    const usdc = { _id: USDC_ID, coin: 'USDC' };
    const usd = { _id: USD_ID, coin: 'USD' };
    Currency.find.mockImplementation(async (filter) => {
      const wanted = filter?.coin?.$in || [];
      return [usdc, usd].filter((c) => wanted.includes(c.coin));
    });
    Currency.findOne.mockResolvedValue(usdc);

    // The account holds USDC (both field styles) and BTC.
    assetsCollection.find.mockReturnValue({
      toArray: async () => [
        {
          _id: USDC_ASSET_ID,
          userId: new mongoose.Types.ObjectId(USER_ID),
          currencyId: USDC_ID,
          coin: 'USDC',
          spotBal: '0'
        }
      ]
    });
    assetsCollection.findOne.mockResolvedValue(null);
    assetsCollection.insertOne.mockResolvedValue({ acknowledged: true });
    assetsCollection.updateOne.mockResolvedValue({ acknowledged: true });
    walletCollection.findOne.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(USER_ID),
      assets: [
        { _id: USDC_ID, currencyId: USDC_ID, coin: 'USDC' },
        { _id: USD_ID, currencyId: USD_ID, coin: 'USD' },
        { _id: BTC_ID, currencyId: BTC_ID, coin: 'BTC' }
      ]
    });

    updateUserAsset.mockResolvedValue({ status: true });
    OrderHistory.find.mockReturnValue({ lean: async () => [] });
    OrderHistory.updateMany.mockResolvedValue({ acknowledged: true });
  });

  // ---------------------------------------------------------------- 1. taken

  test('takes the margin freeze, and takes it before it reads or writes anything', async () => {
    const res = await (async () => {
      const r = makeRes();
      await resetFaucet(makeReq(), r);
      return r;
    })();

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(claimOnce).toHaveBeenCalledWith(FREEZE_KEY, expect.any(String), expect.any(Number));

    // The claim is the FIRST thing that happens. Anything before it - a read of
    // the counters, a cancel, a write - is a window in which a reservation can
    // land unseen, which is the whole defect.
    expect(trace[0]).toBe(`claim:${FREEZE_KEY}`);

    const claimAt = trace.indexOf(`claim:${FREEZE_KEY}`);
    const firstWrite = trace.findIndex((t) => t.startsWith('hset:'));
    expect(claimAt).toBeLessThan(firstWrite);

    // AND before the OBLIGATION CHECK is read. A freeze taken after the look
    // answers a question about a moment that has already passed: an order
    // landing between the read and the freeze is invisible and then destroyed.
    //
    // The obligation that is checked is the SPOT BOOK, read through hgetall on
    // the open-order hashes (lib/restingSpotOrders.js).
    const firstBookRead = trace.findIndex((t) => /^hgetall:(buy|sell)OpenOrders_/.test(t));
    expect(firstBookRead).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(firstBookRead);
  });

  test('the TTL it asks for is a real, bounded number of milliseconds', async () => {
    await resetFaucet(makeReq(), makeRes());
    const ttl = claimOnce.mock.calls[0][2];
    expect(Number.isFinite(ttl)).toBe(true);
    expect(ttl).toBeGreaterThan(0);
    // A freeze that outlives the reset refuses the user's own orders for its
    // whole life, so it must not be minutes.
    expect(ttl).toBeLessThanOrEqual(60000);
  });

  // ------------------------------------------------------- 2. always released

  test('releases the freeze on success', async () => {
    await resetFaucet(makeReq(), makeRes());
    expect(claims).toEqual({});
    expect(releaseClaim).toHaveBeenCalledWith(FREEZE_KEY, claimOnce.mock.calls[0][1]);
  });

  test('releases the freeze when the body throws', async () => {
    // A reset that dies holding the freeze would refuse the user's orders for
    // the whole TTL, with nothing to show for it. The throw is injected at the
    // first LEDGER WRITE, which is past every gate and inside the freeze.
    hset.mockImplementationOnce(async () => {
      throw new Error('redis is down');
    });

    const res = makeRes();
    await resetFaucet(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(claims).toEqual({});
  });

  // ------------------------------------------ 3. cannot take it -> do nothing

  test('refuses and touches nothing when the freeze cannot be taken', async () => {
    // Both cases at once: somebody else holds it, or redis is unreachable -
    // claimOnce answers false either way, and neither is a state in which this
    // endpoint may start zeroing ledgers.
    claimOnce.mockResolvedValue(false);

    const res = makeRes();
    await resetFaucet(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'RESET_IN_PROGRESS' })
    );
    expect(trace.some((t) => t.startsWith('hset:'))).toBe(false);
    // And it must NOT delete a freeze it never took.
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  test('two concurrent resets: exactly one runs, the other is refused', async () => {
    const res1 = makeRes();
    const res2 = makeRes();
    await Promise.all([resetFaucet(makeReq(), res1), resetFaucet(makeReq(), res2)]);

    const codes = [res1, res2].map(
      (r) => (r.json.mock.calls[0][0] || {}).code || 'OK'
    );
    expect(codes.filter((c) => c === 'RESET_IN_PROGRESS')).toHaveLength(1);
    expect(codes.filter((c) => c === 'OK')).toHaveLength(1);
    expect(claims).toEqual({});
  });

  // --------------------------------- 4. the SPOT half: flights, books, refusal

  /**
   * WHAT THESE PIN
   * --------------
   * The reset's spot gate failed in its own way: `cancelOpenSpotOrders` asked
   * MONGO which orders were open, and `limitOrderPlace` writes mongo LAST (and
   * does not await the write), so an order in flight was invisible and its
   * reservation was refunded on top of the restored total. 10,000 -> 48,039.52
   * in four wins.
   *
   * Three properties, each of which a plausible mistake breaks:
   *   - a registered VALUE FLIGHT refuses the reset, before anything is read or
   *     written, because a flight is a request that has already taken money and
   *     not yet published what it took it for;
   *   - an order RESTING IN A REDIS BOOK refuses the reset - and it is the book
   *     that is read, not mongo;
   *   - books that cannot be enumerated refuse the reset (503) rather than
   *     being read as "nothing is resting".
   */

  test('a registered value flight refuses the reset, with nothing written', async () => {
    hash[hashKey(FLIGHT_KEY, 'token-a')] = String(Date.now() + VALUE_FLIGHT_TTL_MS);

    const res = makeRes();
    await resetFaucet(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'RESET_BUSY' })
    );
    expect(trace.some((t) => t.startsWith('hset:'))).toBe(false);
    // ...and the freeze is handed back, or the user's next order is refused for
    // the whole TTL because of a reset that did nothing.
    expect(claims).toEqual({});
  });

  test('an EXPIRED flight does not refuse the reset', async () => {
    // A request that died holding a registration must not lock the account out
    // of its own reset forever; the deadline is what makes the leak self-healing.
    hash[hashKey(FLIGHT_KEY, 'stale')] = String(Date.now() - 1);

    const res = makeRes();
    await resetFaucet(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('an UNPARSEABLE flight deadline counts as live - "cannot tell" is not "idle"', async () => {
    hash[hashKey(FLIGHT_KEY, 'corrupt')] = 'not-a-number';

    const res = makeRes();
    await resetFaucet(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RESET_BUSY' })
    );
  });

  test('the flight registry is read AFTER the freeze and BEFORE any write', async () => {
    const res = makeRes();
    await resetFaucet(makeReq(), res);

    const claimAt = trace.indexOf(`claim:${FREEZE_KEY}`);
    const flightAt = trace.indexOf(`hgetall:${FLIGHT_KEY}`);
    const firstWrite = trace.findIndex((t) => t.startsWith('hset:'));

    // Read before the freeze, the answer is about a moment that has passed: a
    // request can register itself in the gap and then finish under the reset.
    expect(flightAt).toBeGreaterThan(claimAt);
    expect(flightAt).toBeLessThan(firstWrite);
  });

  test('an order RESTING IN A REDIS BOOK refuses the reset and names itself', async () => {
    hash[hashKey(`buyOpenOrders_${PAIR_ID}`, 'order-1')] = JSON.stringify({
      _id: 'order-1',
      userId: USER_ID,
      pairName: 'BTCUSD',
      buyorsell: 'buy',
      orderType: 'limit'
    });

    const res = makeRes();
    await resetFaucet(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('OPEN_SPOT_ORDERS');
    // Shaped so the page's existing describeResetRefusal renders
    // "Cancel your 1 resting order - Spot BTCUSD".
    expect(body.orders).toEqual([
      expect.objectContaining({ productLabel: 'Spot', pairName: 'BTCUSD' })
    ]);
    expect(trace.some((t) => t.startsWith('hset:'))).toBe(false);
    expect(claims).toEqual({});
  });

  test('a MARKET order resting in a book refuses too - its debit is in no counter', async () => {
    // Market orders never credit walletbalance_spot_inOrder (THE IN-ORDER
    // LEDGER INVARIANT), so a gate that only looked at reservation counters
    // would let this one through and pay its fill out on top of the grant.
    hash[hashKey(`sellOpenOrders_${PAIR_ID}`, 'order-m')] = JSON.stringify({
      _id: 'order-m',
      userId: USER_ID,
      pairName: 'BTCUSD',
      buyorsell: 'sell',
      orderType: 'market',
      flag: true
    });

    const res = makeRes();
    await resetFaucet(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'OPEN_SPOT_ORDERS' })
    );
  });

  test("another user's resting order, and the house ladder, do NOT refuse the reset", async () => {
    hash[hashKey(`buyOpenOrders_${PAIR_ID}`, 'someone-else')] = JSON.stringify({
      _id: 'someone-else',
      userId: new mongoose.Types.ObjectId().toString(),
      pairName: 'BTCUSD'
    });
    hash[hashKey(`sellOpenOrders_${PAIR_ID}`, 'ladder')] = JSON.stringify({
      _id: 'ladder',
      userId: USER_ID,
      pairName: 'BTCUSD',
      isPaper: true
    });

    const res = makeRes();
    await resetFaucet(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test('books that cannot be enumerated refuse the reset rather than reading as empty', async () => {
    delete hash[hashKey('spotPairdata', PAIR_ID)];

    const res = makeRes();
    await resetFaucet(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SPOT_BOOK_UNAVAILABLE' })
    );
    expect(trace.some((t) => t.startsWith('hset:'))).toBe(false);
    expect(claims).toEqual({});
  });

  test('a clean account still resets exactly as before, and says so honestly', async () => {
    const res = makeRes();
    await resetFaucet(makeReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    // The reset no longer cancels anything, and the receipt must not claim it
    // did. This value is the one honest number left.
    expect(body.cleared.cancelledSpotOrders).toBe(0);
    expect(body.headline).not.toMatch(/cancel/i);
  });
});
