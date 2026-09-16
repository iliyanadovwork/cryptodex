/**
 * THE SPOT PAIR PUBLISHED A MAKER FEE FIVE TIMES THE ONE IT CHARGED.
 * =================================================================
 *
 * REPORTED: "spot advertises a maker fee 5x the one it charges."
 *
 * A spot pair document carries five fee fields and only two of them are ever
 * charged:
 *
 *   maker_rebate 0.02   taker_fees 0.1     <- the matcher's rates
 *   makerFee     0.1    takerFee   0.1     spotFee 0.1   <- charged by nothing
 *
 * Every order-placing path in this service stamps its order with
 * `makerFee: pairData.maker_rebate` / `takerFee: pairData.taker_fees`, and
 * lib/liquidityRole.feeRateFor prices each fill off the ORDER. Confirmed
 * against the running venue: trade 6a75229e6220fea640848bdf is a maker buy of
 * 0.0002 BTC that moved 4e-8 BTC of fee, i.e. 0.02% - `maker_rebate` exactly.
 *
 * `GET /api/spot/tradePair` served the document raw, so it published
 * `makerFee: 0.1` under the field name every other product on this venue uses
 * for the maker rate - and which the frontend's own pair type declares while
 * declaring neither `maker_rebate` nor `taker_fees`. Five times the truth,
 * available to anything that read the obvious name.
 *
 * `withChargedFees` makes the published names carry the charged numbers.
 *
 * Guards:
 *   W1  the published maker/taker rates equal the charged ones;
 *   W2  the charged fields themselves are never altered - the matcher reads
 *       those, and a display overlay must not be able to reprice a fill;
 *   W3  a rate that is not a usable number leaves the published field alone
 *       rather than replacing a stale quote with NaN;
 *   W4  it is non-mutating, so the redis cache it is handed is untouched.
 */



import { describe, test, expect } from '@jest/globals';

jest.mock('node-cron', () => ({ schedule: () => ({ stop: () => {} }) }));

jest.mock('../../models/index.js', () => {
  const state = { pair: null, trades: [] };
  return {
    __esModule: true,
    __state: state,
    SpotPair: {
      find: async () => [],
      findOne: () => {
        const query = Promise.resolve(state.pair);
        query.lean = async () => state.pair;
        return query;
      },
      updateOne: () => ({ exec: async () => {} })
    },
    SpotOrder: {},
    OrderHistory: {
      findOneAndUpdate: () => ({
        exec: () => ({ then: (cb) => { cb(); return { catch: () => {} }; } })
      })
    },
    TradeHistory: Object.assign(
      class {
        constructor(data) {
          Object.assign(this, data);
        }
        async save() {
          return this;
        }
      },
      { aggregate: async () => state.trades }
    ),
    SequenceId: { findOneAndUpdate: async () => ({ lastIndex: 1000 }) }
  };
});

jest.mock('../../config/socketIO.js', () => ({
  __esModule: true,
  socketEmitOne: () => {},
  socketEmitAll: () => {}
}));

jest.mock('../../controllers/binance.controller.js', () => ({ __esModule: true }));

jest.mock('../../controllers/chart/chart.controller.js', () => ({
  __esModule: true,
  ChartDocHistory: () => {}
}));

jest.mock('../../lib/cryptoJS.js', () => ({
  __esModule: true,
  decryptObject: (value) => value,
  encryptObject: (value) => value,
  decryptJs: (value) => value,
  encryptJs: (value) => value
}));

jest.mock('../../controllers/redis.controller.js', () => {
  const hashes = new Map();
  const strings = new Map();
  const hash = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  return {
    __esModule: true,
    __hashes: hashes,
    __reset: () => {
      hashes.clear();
      strings.clear();
    },
    set: async (key, value) => {
      strings.set(key, value);
      return true;
    },
    get: async (key) => (strings.has(key) ? strings.get(key) : null),
    del: async (key) => {
      strings.delete(key);
    },
    hset: async (key, field, data) => {
      hash(key).set(String(field), JSON.stringify(data));
    },
    hget: async (key, field) => {
      const map = hashes.get(key);
      const value = map && map.get(String(field));
      return value === undefined ? null : value;
    },
    hgetall: async (key) => {
      const map = hashes.get(key);
      if (!map || map.size === 0) return null;
      const out = {};
      for (const [field, value] of map) out[field] = value;
      return out;
    },
    hdel: async (key, field) => {
      const map = hashes.get(key);
      if (map && map.delete(String(field))) return 1;
      return 0;
    },
    hgetdel: async (key, field) => {
      const map = hashes.get(key);
      const value = map && map.get(String(field));
      if (value === undefined) return null;
      map.delete(String(field));
      return value;
    },
    hincbyfloat: async () => '0',
    hincrbyfloatIfEnough: async () => null,
    hincby: async () => {},
    hlen: async (key) => (hashes.get(key) ? hashes.get(key).size : 0),
    hmget: async (key, fields) => fields.map(() => null),
    hmset: async () => {},
    rpush: async () => {},
    lrange: async () => null,
    lpop: async () => {},
    rpop: async () => {}
  };
});

jest.mock('../../lib/binanceWebSocket.js', () => ({
  __esModule: true,
  getDepthSnapshot: () => null
}));

jest.mock('../../grpc/currencyService.js', () => ({
  __esModule: true,
  priceConversionGrpc: async () => ({ status: false })
}));

jest.mock('../../grpc/walletService.js', () => ({
  __esModule: true,
  getUserAsset: async () => {},
  updateUserWallet: async () => true,
  updateUserAsset: async () => {},
  passbook: () => {}
}));

jest.mock('../../grpc/adminService.js', () => ({
  __esModule: true,
  saveAdminprofit: () => {}
}));


import { getPairList } from '../../controllers/spot.controller.js';
import * as redisMock from '../../controllers/redis.controller.js';

/**
 * The BTC/USD document AS IT IS ACTUALLY STORED, fee fields and all.
 *
 * This is the whole point of the fixture. `makerFee` / `takerFee` / `spotFee`
 * were never schema paths - they are raw properties on documents written before
 * fees were withdrawn - and every read feeding getPairList uses `.lean()`, so
 * they survive removal of the schema and come straight through.
 *
 * A fixture without them would make the assertions below pass vacuously while
 * a real pair still advertised `makerFee: 0.1` on a venue that charges nothing.
 */
const PAIR = () => ({
  _id: 'pair-btc',
  pairName: 'BTC/USD',
  tikerRoot: 'BTCUSD',
  maker_rebate: 0.02,
  taker_fees: 0.1,
  makerFee: 0.1,
  takerFee: 0.1,
  spotFee: 0.1,
  markPrice: 64283.45
});


/**
 * THIS FILE USED TO PIN A FEE-PUBLICATION BUG.
 *
 * The venue published `makerFee: 0.1` while charging makers 0.02, and
 * `withChargedFees` was the overlay that reconciled the two on the way out.
 *
 * Both the discrepancy and the overlay are gone: every fee on this venue was
 * deleted, not zero-rated. `withChargedFees`, `feeRateFor`, `feeForSide`,
 * `withoutServiceFee` and `calculateServiceFee` no longer exist, no order
 * carries `makerFee`/`takerFee`, and no trade row records a fee.
 *
 * What is worth pinning now is the ABSENCE. A served pair must advertise no fee
 * of any kind, from EITHER arm of getPairList - the cached fast path and the
 * refresh path - because a pair that advertises a rate nothing charges is the
 * same class of lie the original bug was.
 */
describe('a served pair advertises no fee at all', () => {
  const served = async () => {
    const res = {
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await getPairList({}, res);
    return res.body;
  };

  const FEE_KEYS = ['makerFee', 'takerFee', 'spotFee', 'maker_rebate', 'taker_fees'];

  test('the cached-price arm publishes no fee field', async () => {
    await redisMock.hset('spotPairdata', 'pair-btc', {
      ...PAIR(),
      status: 'active',
      botstatus: 'binance',
      last: 64283.45,
    });
    const body = await served();
    const pair = body.result.find((p) => p._id === 'pair-btc');
    expect(pair).toBeTruthy();
    for (const k of FEE_KEYS) expect(pair[k]).toBeUndefined();
  });

  test('the refresh arm publishes no fee field either', async () => {
    const body = await served();
    const pair = body.result.find((p) => p._id === 'pair-btc');
    expect(pair).toBeTruthy();
    for (const k of FEE_KEYS) expect(pair[k]).toBeUndefined();
  });
});
