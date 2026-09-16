/**
 * 24H STATISTICS FOR A LOCALLY-MATCHED PAIR - ONE WINDOW, ONE ANSWER
 *
 * `marketPrice()` computes the 24h line for a pair whose trades are our own
 * (botstatus "off"/"bot") by walking the trade history. It has TWO branches
 * over the SAME trades: the redis one (`tradeHistory_<pairId>`) and the mongo
 * one (`TradeHistory.aggregate`), chosen by whether the redis hash is there.
 *
 * They disagreed about what "24H Change" means. Redis:
 *
 *     change = (diff / openPrice) * 100     <- a percentage
 *
 * Mongo:
 *
 *     change = (diff * openPrice) / 100     <- not a percentage of anything
 *
 * On a $64,000 pair, a $1 move published "+0.0016%" through one branch and
 * "+640" through the other, and the second is what the header prints as a
 * percent - the same trades reported two ways, overstating in the direction of
 * the move, always in the user's favour on a rally.
 *
 * These run BOTH branches over identical trades and require identical numbers,
 * plus the identities the 24h line has to satisfy either way.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

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

import { marketPrice } from '../../controllers/spot.controller.js';
import * as redisMock from '../../controllers/redis.controller.js';
import * as modelsMock from '../../models/index.js';

const PAIR_ID = '695bf1017573eeb15a749c9d';

const PAIR = {
  _id: PAIR_ID,
  tikerRoot: 'BTCUSD',
  status: 'active',
  botstatus: 'bot',
  markPrice: 64500,
  firstCurrencySymbol: 'BTC',
  secondCurrencySymbol: 'USD'
};

/**
 * Three trades inside the window: open 64,000, a dip to 63,500, close 64,001.
 * One dollar up on the day - small enough that a formula which multiplies by
 * the open instead of dividing by it is off by seven orders of magnitude.
 */
const TRADES = [
  { tradePrice: 64000, tradeQty: 0.5, createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
  { tradePrice: 63500, tradeQty: 0.25, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
  { tradePrice: 64001, tradeQty: 1.25, createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000) }
];

/**
 * Yesterday's trade, 25 hours old: outside the window by an hour, and priced
 * far enough outside the day's range that including it moves the high, the
 * low, the open and both volumes. "24H" has to mean 24h.
 */
const STALE_TRADE = {
  tradePrice: 70000,
  tradeQty: 3,
  createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000)
};

const EXPECTED = {
  last: 64001,
  high: 64001,
  low: 63500,
  changePrice: 1,
  change: (1 / 64000) * 100,
  firstVolume: 0.5 + 0.25 + 1.25,
  secondVolume: 64000 * 0.5 + 63500 * 0.25 + 64001 * 1.25
};

/**
 * Seeded in the WRONG order on purpose. A redis hash has no ordering worth
 * relying on, so the open price of the window - and therefore the 24h change -
 * is only right if the trades are genuinely sorted by when they happened.
 */
const seedRedisTrades = () => {
  const map = new Map();
  [TRADES[2], STALE_TRADE, TRADES[0], TRADES[1]].forEach((trade, index) => {
    map.set(String(index), JSON.stringify(trade));
  });
  redisMock.__hashes.set(`tradeHistory_${PAIR_ID}`, map);
};

const seedPairCache = () => {
  redisMock.__hashes.set(
    'spotPairdata',
    new Map([[PAIR_ID, JSON.stringify(PAIR)]])
  );
};

beforeEach(() => {
  redisMock.__reset();
  modelsMock.__state.pair = PAIR;
  modelsMock.__state.trades = [];
});

describe('marketPrice - the redis branch', () => {
  beforeEach(() => {
    seedPairCache();
    seedRedisTrades();
  });

  test('reports the window it walked', async () => {
    const { status, result } = await marketPrice(PAIR_ID);
    expect(status).toBe(true);
    expect(result.last).toBe(EXPECTED.last);
    expect(result.high).toBe(EXPECTED.high);
    expect(result.low).toBe(EXPECTED.low);
    expect(result.changePrice).toBeCloseTo(EXPECTED.changePrice, 9);
    expect(result.change).toBeCloseTo(EXPECTED.change, 9);
    expect(result.firstVolume).toBeCloseTo(EXPECTED.firstVolume, 9);
    expect(result.secondVolume).toBeCloseTo(EXPECTED.secondVolume, 6);
  });

  test('the change is a percentage, small enough to be one', async () => {
    const { result } = await marketPrice(PAIR_ID);
    expect(Math.abs(result.change)).toBeLessThan(1);
    expect(result.change).toBeCloseTo(
      (result.changePrice / (result.last - result.changePrice)) * 100,
      9
    );
  });
});

describe('marketPrice - the mongo branch', () => {
  beforeEach(() => {
    // no redis pair cache and no redis trade hash: the same trades have to be
    // read out of mongo instead
    modelsMock.__state.trades = TRADES;
  });

  test('reports the same window as the redis branch', async () => {
    const { status, result } = await marketPrice(PAIR_ID);
    expect(status).toBe(true);
    expect(result.last).toBe(EXPECTED.last);
    expect(result.high).toBe(EXPECTED.high);
    expect(result.low).toBe(EXPECTED.low);
    expect(result.changePrice).toBeCloseTo(EXPECTED.changePrice, 9);
    expect(result.firstVolume).toBeCloseTo(EXPECTED.firstVolume, 9);
    expect(result.secondVolume).toBeCloseTo(EXPECTED.secondVolume, 6);
  });

  test('the change is the same percentage, not a number times the open', async () => {
    const { result } = await marketPrice(PAIR_ID);
    expect(result.change).toBeCloseTo(EXPECTED.change, 9);
    // what it used to publish for this window
    expect(result.change).not.toBeCloseTo((1 * 64000) / 100, 6);
    expect(Math.abs(result.change)).toBeLessThan(1);
  });
});

describe('the two branches are one statistic', () => {
  test('identical trades produce identical 24h lines', async () => {
    seedPairCache();
    seedRedisTrades();
    const fromRedis = (await marketPrice(PAIR_ID)).result;

    redisMock.__reset();
    modelsMock.__state.trades = TRADES;
    const fromMongo = (await marketPrice(PAIR_ID)).result;

    for (const field of [
      'last',
      'high',
      'low',
      'change',
      'changePrice',
      'firstVolume',
      'secondVolume'
    ]) {
      expect(fromMongo[field]).toBeCloseTo(fromRedis[field], 9);
    }
  });

  test('both lines are internally coherent', async () => {
    seedPairCache();
    seedRedisTrades();
    const fromRedis = (await marketPrice(PAIR_ID)).result;
    redisMock.__reset();
    modelsMock.__state.trades = TRADES;
    const fromMongo = (await marketPrice(PAIR_ID)).result;

    for (const line of [fromRedis, fromMongo]) {
      // the range contains the price printed beside it
      expect(line.low).toBeLessThanOrEqual(line.last);
      expect(line.last).toBeLessThanOrEqual(line.high);
      // turnover is the volume valued inside that range
      const impliedPrice = line.secondVolume / line.firstVolume;
      expect(impliedPrice).toBeGreaterThanOrEqual(line.low);
      expect(impliedPrice).toBeLessThanOrEqual(line.high);
      // and the change is consistent with the open the window implies
      const open = line.last - line.changePrice;
      expect(line.change).toBeCloseTo((line.changePrice / open) * 100, 9);
    }
  });
});
