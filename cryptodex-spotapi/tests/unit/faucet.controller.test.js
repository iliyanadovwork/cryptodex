/**
 * Faucet Controller Tests (CRITICAL - Paper Trading)
 *
 * Exercises the REAL controllers/faucet.controller.js with mocked I/O
 * (Redis, Mongo collections, gRPC wallet ledger).
 *
 * Pins the fixed stale-ledger bug: a claim must ATOMICALLY INCREMENT the
 * live Redis balance (HINCRBYFLOAT), never overwrite it from the stale
 * flat `assets` ledger.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import mongoose from 'mongoose';

// ---- I/O mocks (must be declared before importing the controller) ----

// Cooldown redis client (SET NX EX / TTL / DEL). Plain functions + shared
// state so behavior survives jest resetMocks between tests.
jest.mock('redis', () => {
  const state = {
    store: {},          // key -> value (emulates NX semantics)
    ttlResult: 3600,    // what TTL returns for an existing cooldown key
    setError: null,     // force SET to fail
    calls: { set: [], ttl: [], del: [] }
  };
  const client = {
    on: () => {},
    set: (...args) => {
      const cb = args.pop();
      state.calls.set.push([...args]);
      if (state.setError) return cb(state.setError);
      const [key, value, ...flags] = args;
      if (flags.includes('NX') && Object.prototype.hasOwnProperty.call(state.store, key)) {
        return cb(null, null); // NX: key exists -> not set
      }
      state.store[key] = value;
      return cb(null, 'OK');
    },
    ttl: (...args) => {
      const cb = args.pop();
      state.calls.ttl.push([...args]);
      return cb(null, state.ttlResult);
    },
    del: (...args) => {
      const cb = args.pop();
      state.calls.del.push([...args]);
      delete state.store[args[0]];
      return cb(null, 1);
    }
  };
  return { createClient: () => client, __state: state };
});

jest.mock('../../config/index.js', () => ({
  __esModule: true,
  default: {
    REDIS_URL: 'redis://127.0.0.1:6379',
    REDIS_PREFIX: 'cryptodex_'
  }
}));

// `claimOnce`/`releaseClaim` are the MARGIN FREEZE the reset now takes before
// it reads anything - see lib/marginFreeze.js. They are mocked with real
// SETNX/token-compared-DEL semantics against an in-memory store so the tests
// can assert both that the freeze is held across the gate and that it is always
// given back.
jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  hset: jest.fn(),
  hget: jest.fn(),
  hgetall: jest.fn(),
  hincbyfloat: jest.fn(),
  moveBalanceLogged: jest.fn(),
  setBalanceLogged: jest.fn(),
  readLedger: jest.fn(async () => []),
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
  // wallet.assets is where every non-USD coin lives (the flat `assets`
  // collection is USD-only), so the reset sweep reads it too.
  const walletCollection = {
    findOne: jest.fn()
  };
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

import { claimFaucet, resetFaucet, faucetStatus } from '../../controllers/faucet.controller.js';
import {
  hset,
  hget,
  hgetall,
  hincbyfloat,
  moveBalanceLogged,
  setBalanceLogged,
  hdel,
  claimOnce,
  releaseClaim,
} from '../../controllers/redis.controller.js';
import { updateUserAsset } from '../../grpc/walletService.js';
import Currency, {
  __assetsCollection as assetsCollection,
  __walletCollection as walletCollection
} from '../../models/currency.js';
import { DepositEvent, OrderHistory } from '../../models/index.js';
import redisPkg from 'redis';
// NOT mocked: the real base-unit codec, so a persisted amount is asserted by
// decoding it the way the history endpoint does.
import { fromBaseUnits } from '../../lib/depositUnits.js';

const redisState = redisPkg.__state;

const USER_ID = new mongoose.Types.ObjectId().toString();
const CURRENCY_ID = new mongoose.Types.ObjectId();
const ASSET_ID = new mongoose.Types.ObjectId();
const USD_CURRENCY_ID = new mongoose.Types.ObjectId();

const ENGINE_FIELD = `${USER_ID}_${CURRENCY_ID.toString()}`;   // trading-engine key style
const WALLET_FIELD = `${USER_ID}_${ASSET_ID.toString()}`;      // wallet-API key style
const USD_FIELD = `${USER_ID}_${USD_CURRENCY_ID.toString()}`;  // quote currency the engine reads
const COOLDOWN_KEY = `cryptodex_faucet_cooldown_${USER_ID}`;

const hashKey = (key, field) => `${key}|${field}`;

/**
 * The reset now enumerates this user's RESTING SPOT ORDERS out of the redis
 * books before it writes anything, and refuses if it cannot (see
 * lib/restingSpotOrders.js). Every reset case therefore needs a pair cache with
 * at least one pair in it, and an account that is not holding anything.
 */
const PAIR_ID = new mongoose.Types.ObjectId().toString();

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const makeReq = () => ({ user: { id: USER_ID } });

describe('Faucet Controller (CRITICAL - Paper Trading)', () => {
  let hash;         // in-memory walletbalance_spot hash
  let claims;       // in-memory SETNX store backing the margin freeze
  let currencyDoc;
  let usdCurrencyDoc;
  let assetDoc;

  beforeEach(() => {
    // Reset cooldown redis mock state
    redisState.store = {};
    redisState.ttlResult = 3600;
    redisState.setError = null;
    redisState.calls.set.length = 0;
    redisState.calls.ttl.length = 0;
    redisState.calls.del.length = 0;

    // Fresh in-memory Redis hash behaviour (jest resetMocks wipes impls each test)
    hash = {};
    hset.mockImplementation(async (key, field, value) => {
      hash[hashKey(key, field)] = value;
    });
    hget.mockImplementation(async (key, field) => {
      const k = hashKey(key, field);
      return k in hash ? hash[k] : null;
    });
    hincbyfloat.mockImplementation(async (key, field, inc) => {
      const k = hashKey(key, field);
      const next = parseFloat(hash[k] != null ? hash[k] : 0) + parseFloat(inc);
      hash[k] = next.toString();
      return next.toString();
    });
    // The faucet credits through paperLedger.adjustSpotBalance, which now moves
    // the engine field through the LEDGER rather than a bare increment, so the
    // credit and the record of it are one atomic step. Same arithmetic, same
    // store; what changed is that a movement now leaves an entry behind.
    moveBalanceLogged.mockImplementation(async (key, field, amount, opts = {}) => {
      const k = hashKey(key, field);
      const before = parseFloat(hash[k] != null ? hash[k] : 0);
      const amt = parseFloat(amount);
      if (!Number.isFinite(amt) || amt <= 0) return null;
      if (opts.direction === 'debit' && before < amt) return null;
      const after = opts.direction === 'debit' ? before - amt : before + amt;
      hash[k] = after.toString();
      return { balance: after.toString(), entryId: '1-0' };
    });
    // The reset writes ABSOLUTE balances, and now does so through the ledger so
    // the overwrite is recorded as the movement it implies. Same effect on the
    // hash as the hset it replaced.
    setBalanceLogged.mockImplementation(async (key, field, value) => {
      const k = hashKey(key, field);
      hash[k] = String(value);
      return String(value);
    });
    // Whole-hash reads over the SAME store, so a test can seed a book with hset.
    hgetall.mockImplementation(async (key) => {
      const out = {};
      for (const [k, v] of Object.entries(hash)) {
        const at = k.indexOf('|');
        if (k.slice(0, at) === key) out[k.slice(at + 1)] = v;
      }
      return out;
    });
    hash[hashKey('spotPairdata', PAIR_ID)] = JSON.stringify({
      _id: PAIR_ID,
      pairName: 'BTCUSD'
    });
    // Real SETNX / token-compared-DEL semantics for the margin freeze.
    claims = {};
    claimOnce.mockImplementation(async (key, token) => {
      if (Object.prototype.hasOwnProperty.call(claims, key)) return false;
      claims[key] = token;
      return true;
    });
    releaseClaim.mockImplementation(async (key, token) => {
      if (claims[key] !== token) return false;
      delete claims[key];
      return true;
    });

    currencyDoc = { _id: CURRENCY_ID, coin: 'USD' };
    usdCurrencyDoc = currencyDoc;
    // The flat `assets` document that stood here held USD in smallest units.
    // That ledger is deleted with the coin, so a user's balance lives in the
    // engine field alone and the collection is empty.
    assetDoc = null;

    // USD is the venue's only currency: quote of its only market, and the one
    // thing the faucet issues.
    Currency.findOne.mockResolvedValue(currencyDoc);
    Currency.find.mockResolvedValue([currencyDoc]);
    // A user's coins come from wallet.assets now. They used to be collected
    // from the flat `assets` collection first, which is why this could be null.
    walletCollection.findOne.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(USER_ID),
      assets: [
        {
          _id: CURRENCY_ID,
          currencyId: CURRENCY_ID,
          coin: 'USD',
          spotBal: 0
        }
      ]
    });
    assetsCollection.find.mockReturnValue({ toArray: async () => [] });
    assetsCollection.findOne.mockResolvedValue(assetDoc);
    assetsCollection.insertOne.mockResolvedValue({ acknowledged: true });
    assetsCollection.updateOne.mockResolvedValue({ acknowledged: true });
    updateUserAsset.mockResolvedValue({ status: true });
    DepositEvent.create.mockResolvedValue({});
    OrderHistory.find.mockReturnValue({ lean: async () => [] });
    OrderHistory.updateMany.mockResolvedValue({ acknowledged: true });
  });

  describe('claimFaucet', () => {
    test('should credit on top of the live Redis balance rather than overwriting it', async () => {
      // Live engine balance in Redis: 12,345 (trading has moved it since the
      // flat ledger recorded 5,000). The fixed bug overwrote Redis with
      // stale-mongo + 10,000 = 15,000. Correct result is 12,345 + 10,000.
      hash[hashKey('walletbalance_spot', ENGINE_FIELD)] = '12345';
      hash[hashKey('walletbalance_spot', WALLET_FIELD)] = '12345';

      const res = makeRes();
      await claimFaucet(makeReq(), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, amount: 1000, balance: 13345 })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.balance).not.toBe(6000); // 1,000 + stale mongo 5,000
      expect(body.balance).not.toBe(1000); // plain overwrite

      // Atomic increment on the live balance, not a seed/overwrite - and now
      // through the ledger, so the credit leaves a replayable entry.
      expect(moveBalanceLogged).toHaveBeenCalledWith(
        'walletbalance_spot',
        ENGINE_FIELD,
        1000,
        expect.objectContaining({ direction: 'credit' })
      );
      expect(hset).not.toHaveBeenCalledWith('walletbalance_spot', ENGINE_FIELD, expect.anything());

      // The engine field ends at the incremented total
      expect(parseFloat(hash[hashKey('walletbalance_spot', ENGINE_FIELD)])).toBe(13345);


      // gRPC wallet ledger sync in regular units
      expect(updateUserAsset).toHaveBeenCalledWith({
        id: USER_ID,
        currencyId: CURRENCY_ID.toString(),
        spotBal: '13345'
      });
    });

    /* A test seeding a claim from the flat ledger and writing BOTH redis key
       styles stood here. The flat `assets` ledger and its second key style held
       USDC alone and went with it: a claim now writes one field. */

    test('should acquire the 24h cooldown via SET NX EX and reject the second claim with retryAfter', async () => {
      const res1 = makeRes();
      await claimFaucet(makeReq(), res1);
      expect(res1.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

      // SET called with NX + EX 86400 on the prefixed cooldown key
      expect(redisState.calls.set[0]).toEqual([
        COOLDOWN_KEY,
        expect.any(String),
        'EX',
        24 * 60 * 60,
        'NX'
      ]);

      const creditCallsAfterFirst = moveBalanceLogged.mock.calls.length + hset.mock.calls.length;
      const depositCallsAfterFirst = DepositEvent.create.mock.calls.length;

      const res2 = makeRes();
      await claimFaucet(makeReq(), res2);

      expect(res2.status).toHaveBeenCalledWith(429);
      expect(res2.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          retryAfter: 3600,
          message: expect.stringContaining('already claimed')
        })
      );

      // Second claim must not credit anything or write history
      expect(moveBalanceLogged.mock.calls.length + hset.mock.calls.length).toBe(creditCallsAfterFirst);
      expect(DepositEvent.create.mock.calls.length).toBe(depositCallsAfterFirst);
    });

    test('should fall back to the full cooldown when TTL is not positive', async () => {
      redisState.store[COOLDOWN_KEY] = Date.now().toString(); // already claimed
      redisState.ttlResult = -1;

      const res = makeRes();
      await claimFaucet(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ retryAfter: 24 * 60 * 60 })
      );
    });

    test('should record a DepositEvent with signature faucet-<ts>-<userId>-<wallet>-<coin> and a base-unit string amount', async () => {
      const res = makeRes();
      await claimFaucet(makeReq(), res);

      // The wallet is IN the signature: a coin credited to two wallets in one
      // claim must produce two rows, not collide on the unique index.
      const sigPattern = new RegExp(`^faucet-\\d+-${USER_ID}-spot-USD$`);
      expect(DepositEvent.create).toHaveBeenCalledTimes(1);
      // A faucet credit does not happen on a chain. The schema used to require
      // one and permit a single value, so every claim was stamped with a chain
      // this venue does not use and a currency that has been deleted.
      expect(DepositEvent.create.mock.calls[0][0]).not.toHaveProperty('chain');
      expect(DepositEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          signature: expect.stringMatching(sigPattern),
          fromAddress: 'faucet',
          toAddress: 'faucet',
          asset: 'USD',
          wallet: 'spot',
          amount: '100000000000', // 1,000 * 1e8, string
          decimals: 8,
          status: 'credited',
          userId: USER_ID
        })
      );

      // Response echoes the same signature
      const body = res.json.mock.calls[0][0];
      expect(body.signature).toMatch(sigPattern);
      expect(body.signature).toBe(DepositEvent.create.mock.calls[0][0].signature);
    });

    test('should return 500 and release the cooldown key when the Redis increment fails', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      hash[hashKey('walletbalance_spot', ENGINE_FIELD)] = '12345';
      // The failing write is now the LEDGER move, since that is the one step
      // that credits the engine field. A refusal there must still surface as a
      // 500 and release the cooldown - the user must not lose their daily claim
      // to a write that did not land.
      moveBalanceLogged.mockImplementation(async () => null);

      const res = makeRes();
      await claimFaucet(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, message: 'Failed to credit spot balance' })
      );

      // Cooldown released so the user can retry
      expect(redisState.calls.del).toContainEqual([COOLDOWN_KEY]);
      expect(redisState.store).not.toHaveProperty(COOLDOWN_KEY);
      expect(DepositEvent.create).not.toHaveBeenCalled();

      // Retry with a healthy Redis succeeds
      hincbyfloat.mockImplementation(async (key, field, inc) => {
        const k = hashKey(key, field);
        const next = parseFloat(hash[k] != null ? hash[k] : 0) + parseFloat(inc);
        hash[k] = next.toString();
        return next.toString();
      });
      moveBalanceLogged.mockImplementation(async (key, field, amount, opts = {}) => {
        const k = hashKey(key, field);
        const before = parseFloat(hash[k] != null ? hash[k] : 0);
        const amt = parseFloat(amount);
        const after = opts.direction === 'debit' ? before - amt : before + amt;
        hash[k] = after.toString();
        return { balance: after.toString(), entryId: '1-0' };
      });
      const res2 = makeRes();
      await claimFaucet(makeReq(), res2);
      expect(res2.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, balance: 13345 })
      );
    });

    test('should NOT fail the claim when the gRPC ledger sync fails (logs instead)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      hash[hashKey('walletbalance_spot', ENGINE_FIELD)] = '12345';
      hash[hashKey('walletbalance_spot', WALLET_FIELD)] = '12345';
      updateUserAsset.mockRejectedValue(new Error('grpc down'));

      const res = makeRes();
      await claimFaucet(makeReq(), res);

      expect(res.status).not.toHaveBeenCalled(); // no error status
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, amount: 1000, balance: 13345 })
      );
      expect(DepositEvent.create).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('LEDGER SYNC FAILURE'),
        expect.any(Object),
        expect.any(Error)
      );
      // Cooldown stays: the claim succeeded
      expect(redisState.store).toHaveProperty(COOLDOWN_KEY);
    });

    test('should NOT fail the claim when saving the DepositEvent fails', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      DepositEvent.create.mockRejectedValue(new Error('mongo down'));

      const res = makeRes();
      await claimFaucet(makeReq(), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(errorSpy).toHaveBeenCalled();
    });

    test('should return 401 without touching Redis when unauthenticated', async () => {
      const res = makeRes();
      await claimFaucet({ user: undefined }, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, message: 'Unauthorized' })
      );
      expect(redisState.calls.set).toHaveLength(0);
      expect(hincbyfloat).not.toHaveBeenCalled();
      expect(hset).not.toHaveBeenCalled();
      expect(setBalanceLogged).not.toHaveBeenCalled();
    });

    test('should return 500 and release the cooldown when no faucet currency exists', async () => {
      Currency.find.mockResolvedValue([]);

      const res = makeRes();
      await claimFaucet(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: expect.stringContaining('currency not found')
        })
      );
      expect(redisState.calls.del).toContainEqual([COOLDOWN_KEY]);
      expect(redisState.store).not.toHaveProperty(COOLDOWN_KEY);
    });
  });

  describe('resetFaucet', () => {
    test('should set the balance to exactly the seed regardless of the live balance', async () => {
      hash[hashKey('walletbalance_spot', ENGINE_FIELD)] = '55555';
      hash[hashKey('walletbalance_spot', WALLET_FIELD)] = '44444';

      const res = makeRes();
      await resetFaucet(makeReq(), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, balance: 1000 })
      );

      // Absolute set, not an increment
      expect(hincbyfloat).not.toHaveBeenCalled();
      expect(setBalanceLogged).toHaveBeenCalledWith(
        'walletbalance_spot',
        ENGINE_FIELD,
        1000,
        expect.objectContaining({ reason: 'faucet_reset' })
      );
      expect(parseFloat(hash[hashKey('walletbalance_spot', ENGINE_FIELD)])).toBe(1000);

      // Flat ledger + gRPC wallet ledger both reset
      expect(updateUserAsset).toHaveBeenCalledWith({
        id: USER_ID,
        currencyId: CURRENCY_ID.toString(),
        spotBal: '1000'
      });
    });

    test('should zero every other ledger so funds parked outside spot USD cannot survive the reset (regression)', async () => {
      // 5,000 USD parked in a retired, non-spot ledger, plus 1,200
      // reserved by an open order. The 1,200 used to survive the reset and be
      // added on top of the fresh 10,000.
      hash[hashKey('walletbalance_legacy', ENGINE_FIELD)] = '5000';
      hash[hashKey('walletbalance_legacyWB', ENGINE_FIELD)] = '5000';
      hash[hashKey('walletbalance_spot_inOrder', ENGINE_FIELD)] = '1200';

      const res = makeRes();
      await resetFaucet(makeReq(), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, balance: 1000 })
      );

      // THE LEDGERS THE RESET STILL OWNS. A balance parked anywhere the reset
      // does not clear survives it and lands on top of the fresh grant, so
      // every ledger spot can still move value into has to be on this list.
      const clearedLedgers = [
        'walletbalance_spot_locked',
        'walletbalance_spot_inOrder'
      ];
      for (const ledger of clearedLedgers) {
        expect(parseFloat(hash[hashKey(ledger, ENGINE_FIELD)])).toBe(0);
      }

      // LEDGERS SPOT CANNOT REACH ARE DELIBERATELY LEFT ALONE. Nothing can
      // move spendable balance into them and the transfer endpoint refuses,
      // so their contents cannot come back into spot. Zeroing them would be
      // this endpoint deciding to discard stored numbers that are the venue
      // owner's to keep or drop.
      expect(parseFloat(hash[hashKey('walletbalance_legacy', ENGINE_FIELD)])).toBe(5000);
      expect(parseFloat(hash[hashKey('walletbalance_legacyWB', ENGINE_FIELD)])).toBe(5000);

      // `walletbalance_p2p` IS NOW PROTECTED ON THE SAME TERMS. The p2p
      // remnants have been removed from walletapi, so nothing writes this hash
      // and no value can reach it - which is precisely the condition that took
      // the other retired ledgers off the list. A balance left in it from before
      // the removal is the owner's to keep, and the reset no longer discards it.
      hash[hashKey('walletbalance_p2p', ENGINE_FIELD)] = '750';
      const res2 = makeRes();
      await resetFaucet(makeReq(), res2);
      expect(parseFloat(hash[hashKey('walletbalance_p2p', ENGINE_FIELD)])).toBe(750);

      // Net worth in the only wallet that can trade is exactly the faucet
      // amount, not 10,000 + 1,200.
      expect(parseFloat(hash[hashKey('walletbalance_spot', ENGINE_FIELD)])).toBe(1000);
    });

    test('should zero non-USD spot balances so they cannot be sold back into USD after a reset', async () => {
      const btcAsset = {
        _id: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(USER_ID),
        currencyId: new mongoose.Types.ObjectId().toString(),
        coin: 'BTC',
        spotBal: '250000000'
      };
      // A non-faucet coin reaches the sweep through wallet.assets: the flat
      // `assets` collection that used to carry it went with USDC.
      walletCollection.findOne.mockResolvedValue({
        _id: new mongoose.Types.ObjectId(USER_ID),
        assets: [
          { _id: CURRENCY_ID, currencyId: CURRENCY_ID, coin: 'USD', spotBal: 0 },
          {
            _id: btcAsset._id,
            currencyId: btcAsset.currencyId,
            coin: 'BTC',
            spotBal: 2.5
          }
        ]
      });

      const btcEngineField = `${USER_ID}_${btcAsset.currencyId}`;
      hash[hashKey('walletbalance_spot', btcEngineField)] = '2.5';

      const res = makeRes();
      await resetFaucet(makeReq(), res);

      expect(parseFloat(hash[hashKey('walletbalance_spot', btcEngineField)])).toBe(0);

      // USD is skipped by the sweep and then set to the faucet amount
      expect(parseFloat(hash[hashKey('walletbalance_spot', ENGINE_FIELD)])).toBe(1000);
    });

    /**
     * THIS TEST USED TO ASSERT THE CANCELLATION, AND THE CANCELLATION WAS THE BUG.
     * ---------------------------------------------------------------------------
     * The reset asked MONGO which of this user's orders were open, dropped those
     * from the redis books and marked the rows cancelled. `limitOrderPlace`
     * writes mongo LAST - and `newOrderHistory` does not even await the write -
     * so an order placed while the reset ran was invisible to the query, kept its
     * reservation, and had it refunded on top of the restored 10,000. Measured
     * through the ordinary API: 10,000 -> 48,039.52 in four consecutive wins.
     *
     * A resting order can also FILL, and no exclusion this endpoint takes can
     * cover a settlement the matcher is already performing. So the reset refuses
     * while anything is resting instead of trying to clear it.
     */
    test('should REFUSE while a spot order is resting, rather than cancelling it', async () => {
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
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, code: 'OPEN_SPOT_ORDERS' })
      );
      // NOTHING was written: not the balance, not the ledgers, not mongo.
      expect(hash[hashKey('walletbalance_spot', ENGINE_FIELD)]).toBeUndefined();
      expect(OrderHistory.updateMany).not.toHaveBeenCalled();
    });

    test('a clean account resets, and the receipt no longer claims a cancellation', async () => {
      const res = makeRes();
      await resetFaucet(makeReq(), res);

      const body = res.json.mock.calls[0][0];
      expect(body).toEqual(
        expect.objectContaining({ success: true, balance: 1000 })
      );
      expect(body.cleared.cancelledSpotOrders).toBe(0);
      expect(body.headline).not.toMatch(/cancel/i);
      expect(OrderHistory.updateMany).not.toHaveBeenCalled();
    });

    /* A test creating the flat `assets` document stood here. That collection is
       deleted with USDC, the only coin it ever held. */

    test('should NOT fail the reset when the gRPC ledger sync fails (Redis stays authoritative)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      updateUserAsset.mockRejectedValue(new Error('grpc down'));

      const res = makeRes();
      await resetFaucet(makeReq(), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, balance: 1000 })
      );
      expect(parseFloat(hash[hashKey('walletbalance_spot', ENGINE_FIELD)])).toBe(1000);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('LEDGER SYNC FAILURE'),
        expect.any(Object),
        expect.any(Error)
      );
    });

    test('should return 401 when unauthenticated', async () => {
      const res = makeRes();
      await resetFaucet({}, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(hset).not.toHaveBeenCalled();
      expect(setBalanceLogged).not.toHaveBeenCalled();
    });

    test('should return 500 when no faucet currency exists', async () => {
      Currency.find.mockResolvedValue([]);

      const res = makeRes();
      await resetFaucet(makeReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: expect.stringContaining('currency not found')
        })
      );
    });
  });

  /**
   * The live spot pairs (BTCUSD / ETHUSD / SOLUSD) quote in USD, and orderPlace
   * reads the buy-side balance from `walletbalance_spot <userId>_<secondCurrencyId>`
   * - the USD currency id. A USD-only faucet therefore credits money the order
   * engine cannot see, and the user still cannot BUY. The faucet must cover the
   * same currency set walletapi's registration seed does.
   */
  /*
   * A 'faucet currency set (USD + USD)' describe stood here. It existed to
   * prove the faucet credited the USD quote currency the order engine reads
   * and not only USD, because a USD-only faucet left a user unable to buy.
   * USD had no market of its own and is deleted; the faucet issues the quote
   * currency alone, so there is no second coin for it to be missing.
   */

  describe('the reset restores the SIGNUP SEED, in both directions (CRITICAL)', () => {
    const BTC_ID = new mongoose.Types.ObjectId();
    const ETH_ID = new mongoose.Types.ObjectId();
    const SOL_ID = new mongoose.Types.ObjectId();

    // PINNED LITERALS. These must equal DEMO_SEED_AMOUNT in walletapi
    // controllers/createAsset.js, whose own suite pins the same number and
    // names this file. Editing one side fails that side; editing both to
    // different values is caught by nothing short of a shared module, and that
    // limitation is stated rather than papered over.
    //
    // THE SEED IS NOW SPOT ONLY. It had a second leg - 0.05 BTC + 1 ETH + 50
    // SOL of collateral in a non-spot wallet - and that leg was dropped from
    // BOTH ends together with the wallet it funded. Dropping it from one end
    // alone is precisely the drift these paired tests exist to catch.
    const SEED_SPOT = 1000;

    const baseCoins = [
      { _id: BTC_ID, coin: 'BTC' },
      { _id: ETH_ID, coin: 'ETH' },
      { _id: SOL_ID, coin: 'SOL' }
    ];
    const field = (id) => `${USER_ID}_${id.toString()}`;
    const read = (ledger, id) =>
      parseFloat(hash[hashKey(ledger, field(id))] ?? 0);

    beforeEach(() => {
      Currency.find.mockImplementation(async (filter) => {
        const wanted = filter?.coin?.$in || [];
        return [...[currencyDoc], ...baseCoins].filter((c) =>
          wanted.includes(c.coin)
        );
      });
      walletCollection.findOne.mockResolvedValue({
        _id: new mongoose.Types.ObjectId(USER_ID),
        assets: [
          ...baseCoins.map((c) => ({
            _id: c._id,
            currencyId: c._id,
            coin: c.coin,
            spotBal: 0
          })),
          { _id: CURRENCY_ID, currencyId: CURRENCY_ID, coin: 'USD' },
          { _id: USD_CURRENCY_ID, currencyId: USD_CURRENCY_ID, coin: 'USD' }
        ]
      });
    });

    /** The whole seed, as one comparable object. */
    const seedState = () => ({
      spotUSD: read('walletbalance_spot', CURRENCY_ID),
      spotBTC: read('walletbalance_spot', BTC_ID),
      spotETH: read('walletbalance_spot', ETH_ID),
      spotSOL: read('walletbalance_spot', SOL_ID),
    });

    const THE_SEED = {
      spotUSD: SEED_SPOT,
      spotBTC: 0,
      spotETH: 0,
      spotSOL: 0,
    };

    test('1. an EMPTY account is restored to the seed - it creates the shortfall', async () => {
      // Every ledger at zero: the blown-up account the button exists for.
      const res = makeRes();
      await resetFaucet(makeReq(), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(seedState()).toEqual(THE_SEED);
    });

    test('2. a RICH account is cut back to the seed - it destroys the excess', async () => {
      // The direction "a reset creates none" was groping at, and the only
      // direction in which it was ever true. If the reset only ever topped up,
      // it would be a grant and would need the claim's 24h rule.
      hash[hashKey('walletbalance_spot', field(CURRENCY_ID))] = '999999';
      hash[hashKey('walletbalance_spot', field(USD_CURRENCY_ID))] = '750000';
      hash[hashKey('walletbalance_spot', field(BTC_ID))] = '12';
      hash[hashKey('walletbalance_legacy2', field(BTC_ID))] = '3';
      hash[hashKey('walletbalance_legacy2', field(SOL_ID))] = '9000';
      hash[hashKey('walletbalance_legacy', field(CURRENCY_ID))] = '4321';

      const res = makeRes();
      await resetFaucet(makeReq(), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(seedState()).toEqual(THE_SEED);
      // Stated explicitly, because "restore" without this is just "top up".
      expect(read('walletbalance_spot', CURRENCY_ID)).toBeLessThan(999999);

      // AND THE RETIRED, FROZEN LEDGERS ARE LEFT EXACTLY ALONE. The reset used
      // to zero these. Nothing reads or writes these hashes any more, and
      // whether the stored numbers are discarded is the venue owner's decision
      // - so a reset must not make it for them. This is the assertion that the
      // removal did not quietly turn into a data wipe.
      expect(read('walletbalance_legacy2', BTC_ID)).toBe(3);
      expect(read('walletbalance_legacy2', SOL_ID)).toBe(9000);
      expect(read('walletbalance_legacy', CURRENCY_ID)).toBe(4321);
    });

    test('3. it is IDEMPOTENT - reset(reset(x)) == reset(x)', async () => {
      hash[hashKey('walletbalance_spot', field(CURRENCY_ID))] = '137';
      await resetFaucet(makeReq(), makeRes());
      const once = seedState();
      await resetFaucet(makeReq(), makeRes());
      await resetFaucet(makeReq(), makeRes());
      expect(seedState()).toEqual(once);
      expect(once).toEqual(THE_SEED);
    });

    test('4. it can never put the account ABOVE the seed, however often it runs', async () => {
      // This is what makes "spamming reset buys nothing" true, and it is the
      // only bound the endpoint actually provides. It is NOT a bound on the
      // venue's demo-money supply - losing the seed to a counterparty and
      // resetting is unbounded, and the comment says so.
      for (let i = 0; i < 5; i++) {
        await resetFaucet(makeReq(), makeRes());
      }
      expect(read('walletbalance_spot', CURRENCY_ID)).toBe(SEED_SPOT);
    });

    test('5. no cooldown key is taken, read or honoured by the reset', async () => {
      // The endpoint is deliberately uncapped, and the reason is written out at
      // resetFaucet. If a cooldown is ever added, this test is the one that
      // fails and forces the reason to be rewritten with it.
      redisState.calls.set.length = 0;
      redisState.calls.ttl.length = 0;
      await resetFaucet(makeReq(), makeRes());
      await resetFaucet(makeReq(), makeRes());
      expect(redisState.calls.set).toHaveLength(0);
      expect(redisState.calls.ttl).toHaveLength(0);
    });

    test('6. the fixed point IS the signup seed, coin for coin', async () => {
      // The twin of "the seed is the faucet reset fixed point, coin for coin"
      // in walletapi tests/integration/paper-demo-seed.integration.test.js.
      const res = makeRes();
      await resetFaucet(makeReq(), res);
      const body = res.json.mock.calls[0][0];

      expect(SEED_SPOT).toBe(1000);
      expect(body.balances).toEqual({ USD: SEED_SPOT });
      // No second leg. `inverseBalances` was a key of this response and went
      // with the wallet it described. The NAME stays as written: this asserts
      // the old key never comes back, so renaming it would guard nothing.
      expect(body.inverseBalances).toBeUndefined();
    });
  });

  /**
   * THE RECEIPT HAS TO NAME EVERYTHING THAT MOVED.
   *
   * The claim advertised its USD grant and silently also credited 0.05 BTC +
   * 1 ETH + 50 SOL into a second, non-spot wallet - roughly $8,834 that no
   * copy anywhere named. That second leg has since gone with the wallet it
   * funded, so the receipt and the advertised copy now describe the same
   * coins. These still pin the response as the SINGLE
   * source the UI renders its receipt from - the property that made the silent
   * leg a defect is the one that stops a new one being added silently, and the
   * "no wallet other than spot appears" assertions below are what enforce it
   * now that there is only one wallet to appear.
   */
  describe('honest receipt', () => {
    const BTC_ID = new mongoose.Types.ObjectId();
    const ETH_ID = new mongoose.Types.ObjectId();
    const SOL_ID = new mongoose.Types.ObjectId();
    const SEED = { BTC: 0.05, ETH: 1, SOL: 50 };

    const baseCoins = [
      { _id: BTC_ID, coin: 'BTC' },
      { _id: ETH_ID, coin: 'ETH' },
      { _id: SOL_ID, coin: 'SOL' }
    ];

    beforeEach(() => {
      Currency.find.mockImplementation(async (filter) => {
        const wanted = filter?.coin?.$in || [];
        return [...[currencyDoc], ...baseCoins].filter((c) =>
          wanted.includes(c.coin)
        );
      });
      walletCollection.findOne.mockResolvedValue({
        _id: new mongoose.Types.ObjectId(USER_ID),
        assets: [
          ...baseCoins.map((c) => ({ _id: c._id, currencyId: c._id, coin: c.coin, spotBal: 0 })),
          { _id: USD_CURRENCY_ID, currencyId: USD_CURRENCY_ID, coin: 'USD' }
        ]
      });
    });

    test('a claim reports EVERY credit, and every credit is a SPOT credit', async () => {
      const res = makeRes();
      await claimFaucet(makeReq(), res);

      const body = res.json.mock.calls[0][0];
      expect(Array.isArray(body.credited)).toBe(true);

      const spotCredits = body.credited.filter((c) => c.wallet === 'spot');
      expect(spotCredits.map((c) => c.coin)).toEqual(['USD']);
      for (const credit of spotCredits) {
        expect(credit.amount).toBe(1000);
      }

      // NOTHING ELSE. A credit to any other wallet would mean this endpoint had
      // started funding a product the venue does not have - which is exactly
      // the shape of the defect this block was written for, in reverse.
      expect(body.credited).toHaveLength(1);
      expect([...new Set(body.credited.map((c) => c.wallet))]).toEqual(['spot']);
    });

    test('every credit in the receipt was actually written to a ledger', async () => {
      const res = makeRes();
      await claimFaucet(makeReq(), res);

      const body = res.json.mock.calls[0][0];
      const ledgerFor = { spot: 'walletbalance_spot' };

      for (const credit of body.credited) {
        const written = [
          ...moveBalanceLogged.mock.calls.filter((call) => call[0] === ledgerFor[credit.wallet]),
          ...hincbyfloat.mock.calls.filter((call) => call[0] === ledgerFor[credit.wallet]),
          ...hset.mock.calls.filter((call) => call[0] === ledgerFor[credit.wallet])
        ].some((call) => parseFloat(call[2]) === credit.amount);
        expect(written).toBe(true);
      }
    });

    test('the claim headline names exactly what was credited, and nothing else', async () => {
      const res = makeRes();
      await claimFaucet(makeReq(), res);

      const body = res.json.mock.calls[0][0];
      expect(body.headline).toEqual(expect.any(String));
      expect(body.headline).toContain('1,000 USD');
      expect(body.headline).toContain('1,000 USD');
      // The collateral leg is gone, so the sentence must not still promise it.
      expect(body.headline).not.toMatch(/BTC|ETH|SOL/);
      // The message the toast shows is the same sentence - they cannot drift.
      expect(body.message).toBe(body.headline);
    });

    test('the reset receipt claims no wallet it did not clear', async () => {
      const res = makeRes();
      await resetFaucet(makeReq(), res);

      const body = res.json.mock.calls[0][0];
      expect([...new Set(body.credited.map((c) => c.wallet))]).toEqual(['spot']);
      // `cleared.wallets` used to name a second, non-spot wallet, because the
      // reset zeroed it. It no longer touches that wallet, so naming it would
      // be a receipt for something that did not happen - the same class of
      // untruth as the silent credit this block was written for.
      expect(body.cleared.wallets).toEqual([]);
      expect(body.cleared).toHaveProperty('cancelledSpotOrders');
    });

    test('the reset receipt reports the balance each coin actually ended at', async () => {
      const res = makeRes();
      await resetFaucet(makeReq(), res);

      const body = res.json.mock.calls[0][0];
      for (const credit of body.credited) {
        const key = 'walletbalance_spot';
        const coinId =
          credit.coin === 'USD' ? CURRENCY_ID
            : credit.coin === 'USD' ? USD_CURRENCY_ID
              : baseCoins.find((c) => c.coin === credit.coin)._id;
        const stored = hash[hashKey(key, `${USER_ID}_${coinId.toString()}`)];
        expect(parseFloat(stored)).toBe(parseFloat(credit.balance));
      }
    });
  });

  /**
   * THE RECEIPT IS NOT THE HISTORY.
   * ===============================
   *
   * The receipt above proved the RESPONSE told the truth. It reaches exactly
   * one device: the browser that made the call. The claim used to credit
   * 0.05 BTC + 1 ETH + 50 SOL into a second, non-spot wallet and write deposit
   * rows for the spot half only, so on any second device - or a plain API read
   * - the user's own history was missing money they had been given.
   *
   * That second leg is gone with the wallet it funded, so the two halves now
   * describe the same coins. These still pin the persistence: every leg of the
   * receipt is a row, at the right wallet, coin and amount.
   */
  describe('persisted history covers every credited leg', () => {
    const BTC_ID = new mongoose.Types.ObjectId();
    const ETH_ID = new mongoose.Types.ObjectId();
    const SOL_ID = new mongoose.Types.ObjectId();
    const SEED = { BTC: 0.05, ETH: 1, SOL: 50 };

    const baseCoins = [
      { _id: BTC_ID, coin: 'BTC' },
      { _id: ETH_ID, coin: 'ETH' },
      { _id: SOL_ID, coin: 'SOL' }
    ];

    beforeEach(() => {
      Currency.find.mockImplementation(async (filter) => {
        const wanted = filter?.coin?.$in || [];
        return [...[currencyDoc], ...baseCoins].filter((c) =>
          wanted.includes(c.coin)
        );
      });
      walletCollection.findOne.mockResolvedValue({
        _id: new mongoose.Types.ObjectId(USER_ID),
        assets: [
          ...baseCoins.map((c) => ({ _id: c._id, currencyId: c._id, coin: c.coin, spotBal: 0 })),
          { _id: USD_CURRENCY_ID, currencyId: USD_CURRENCY_ID, coin: 'USD' }
        ]
      });
    });

    const savedRows = () => DepositEvent.create.mock.calls.map(([doc]) => doc);

    test('a claim writes a deposit row for EVERY credited coin, and for no other wallet', async () => {
      // The regression this replaces: the claim credited a second, non-spot
      // wallet and wrote rows for the spot half only, so the user's own history
      // was missing money they had been given. That leg is gone, so the
      // property inverts - every row must be a SPOT row, because a row for any
      // other wallet would be history for a credit that did not happen.
      const res = makeRes();
      await claimFaucet(makeReq(), res);

      const rows = savedRows();
      expect(rows.map((r) => r.asset)).toEqual(['USD']);
      expect([...new Set(rows.map((r) => r.wallet))]).toEqual(['spot']);
      for (const row of rows) {
        expect(fromBaseUnits(row.amount, row.decimals)).toBe('1000');
      }
    });

    test('every leg of the receipt is a persisted row with the same wallet, coin and amount', async () => {
      const res = makeRes();
      await claimFaucet(makeReq(), res);

      const body = res.json.mock.calls[0][0];
      const rows = savedRows();
      expect(body.credited).toHaveLength(1);
      expect(rows).toHaveLength(body.credited.length);

      for (const credit of body.credited) {
        const row = rows.find((r) => r.asset === credit.coin && r.wallet === credit.wallet);
        expect(row).toBeDefined();
        expect(Number(fromBaseUnits(row.amount, row.decimals))).toBe(Number(credit.amount));
        expect(row.status).toBe('credited');
        expect(row.userId).toBe(USER_ID);
      }
    });

    test('the credited amount survives the round trip through the stored base units', async () => {
      const res = makeRes();
      await claimFaucet(makeReq(), res);

      const usdc = savedRows().find((r) => r.asset === 'USD');
      // Base units, an INTEGER string - never a float tail like the ones a
      // naive `* 1eN` produces (0.07 * 1e8 is 7000000.000000001).
      expect(usdc.amount).not.toContain('.');
      expect(fromBaseUnits(usdc.amount, usdc.decimals)).toBe('1000');
    });

    test('the legs of one claim share one creditedAt so they sort as one group', async () => {
      const res = makeRes();
      await claimFaucet(makeReq(), res);

      const stamps = new Set(savedRows().map((r) => r.creditedAt.getTime()));
      expect(stamps.size).toBe(1);
    });

    test('every leg gets its own signature (the collection has a unique index)', async () => {
      const res = makeRes();
      await claimFaucet(makeReq(), res);

      const signatures = savedRows().map((r) => r.signature);
      expect(new Set(signatures).size).toBe(signatures.length);
      // The signature names the wallet as well as the coin, which is what kept
      // two wallets' credits of the SAME coin apart under the unique index.
      expect(signatures.some((sig) => sig.endsWith('-spot-USD'))).toBe(true);
      expect(signatures.some((sig) => sig.endsWith('-spot-USD'))).toBe(true);
    });

    test('each credit line carries the signature its own row was written under', async () => {
      const res = makeRes();
      await claimFaucet(makeReq(), res);

      const body = res.json.mock.calls[0][0];
      const rows = savedRows();
      for (const credit of body.credited) {
        const row = rows.find((r) => r.asset === credit.coin && r.wallet === credit.wallet);
        expect(credit.signature).toBe(row.signature);
      }
    });

    test('a failing row write leaves the claim, the balances and the cooldown intact', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      DepositEvent.create.mockImplementation(async (doc) => {
        if (doc.asset === 'USD') throw new Error('mongo down');
        return doc;
      });

      const res = makeRes();
      await claimFaucet(makeReq(), res);

      expect(res.status).not.toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      // The credit still happened and is still reported...
      const usd = body.credited.find((c) => c.coin === 'USD');
      expect(usd.amount).toBe(1000);
      // ...it just has no row, and says so by carrying no signature.
      expect(usd.signature).toBeUndefined();
      expect(redisState.store).toHaveProperty(COOLDOWN_KEY);
    });

    test('a reset writes NO deposit rows - it sets balances, it does not credit them', async () => {
      const res = makeRes();
      await resetFaucet(makeReq(), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(DepositEvent.create).not.toHaveBeenCalled();
    });
  });

});

/**
 * THE COOLDOWN, ASKED ABOUT RATHER THAN DISCOVERED
 * ================================================
 *
 * The 24h cooldown is a product rule, and the claim page had no way to read it:
 * the Claim button stayed enabled all day and the user found out by pressing it
 * and being handed a 429. GET /api/spot/faucet/status returns the same
 * `retryAfter` the 429 carries, before the click.
 *
 * The one thing it must never do is CHANGE anything: a page that polls it must
 * not thereby start, extend or clear a cooldown.
 */
describe('faucetStatus - GET /api/spot/faucet/status', () => {
  beforeEach(() => {
    redisState.store = {};
    redisState.ttlResult = 3600;
    redisState.calls.set.length = 0;
    redisState.calls.ttl.length = 0;
    redisState.calls.del.length = 0;
  });

  test('an account inside its cooldown is told how long is left', async () => {
    redisState.ttlResult = 7200;
    const res = makeRes();
    await faucetStatus(makeReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.canClaim).toBe(false);
    expect(body.retryAfter).toBe(7200);
  });

  test('the TTL it reports is the COOLDOWN key, not some other key', async () => {
    const res = makeRes();
    await faucetStatus(makeReq(), res);
    expect(redisState.calls.ttl[0][0]).toBe(COOLDOWN_KEY);
  });

  test.each([
    ['-2, the key does not exist', -2],
    ['-1, the key has no expiry', -1],
    ['0', 0]
  ])('redis TTL %s means claimable now', async (_label, ttl) => {
    redisState.ttlResult = ttl;
    const res = makeRes();
    await faucetStatus(makeReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.canClaim).toBe(true);
    expect(body.retryAfter).toBe(0);
  });

  test('asking does not start, extend or clear a cooldown', async () => {
    const res = makeRes();
    await faucetStatus(makeReq(), res);

    expect(redisState.calls.set).toHaveLength(0);
    expect(redisState.calls.del).toHaveLength(0);
    expect(redisState.store).toEqual({});
  });

  test('asking twice does not change the answer', async () => {
    redisState.ttlResult = 500;
    const first = makeRes();
    await faucetStatus(makeReq(), first);
    const second = makeRes();
    await faucetStatus(makeReq(), second);

    expect(second.json.mock.calls[0][0]).toEqual(first.json.mock.calls[0][0]);
  });

  test('it reports the cooldown length the claim route actually applies', async () => {
    const res = makeRes();
    await faucetStatus(makeReq(), res);
    expect(res.json.mock.calls[0][0].cooldownSeconds).toBe(24 * 60 * 60);
  });

  test('an unauthenticated caller is refused, not answered with a wait', async () => {
    const res = makeRes();
    await faucetStatus({}, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'later'],
    ['NaN', NaN]
  ])('a TTL that is not a positive number (%s) reads as claimable, not as a wait', async (
    _label,
    ttl
  ) => {
    // The failure mode that matters here is the opposite of the bug being
    // fixed: a garbage TTL must not disable the user's Claim button forever.
    redisState.ttlResult = ttl;
    const res = makeRes();
    await faucetStatus(makeReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.canClaim).toBe(true);
    expect(body.retryAfter).toBe(0);
  });

  test('every call answers - the handler never returns without touching res', async () => {
    for (const ttl of [7200, 0, -2, undefined]) {
      redisState.ttlResult = ttl;
      const res = makeRes();
      await faucetStatus(makeReq(), res);
      // `json` is the ONLY way this handler can end; a path that returned
      // without it is what the sweep this round was about.
      expect(res.json).toHaveBeenCalledTimes(1);
    }
  });
});
