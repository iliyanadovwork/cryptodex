/**
 * THE ELEVENTH RESTING ORDER, AND THE MONEY BEHIND IT
 * ==================================================
 *
 * `GET /api/spot/openOrder/:pairId` answered
 *
 *     count:    data.length            <- measured AFTER the slice
 *     nextPage: data.length <= 0       <- "there is more" when there is nothing
 *
 * Both halves point the same way. `count` equal to the page size makes the
 * client's own guard (`data.length >= count` in components/spot/OpenOrder.tsx)
 * pass on every full page, and `nextPage` false on a full page makes
 * InfiniteScroll's `if (atBottom && hasMore)` never fire. So the table was
 * pinned to its first ten rows permanently.
 *
 * On a history table that is an annoyance. On THIS table it is money: it is the
 * only place a resting spot order can be cancelled, spot has no `cancelAllOpen`
 * to fall back on, and there is no page-number control. A user with twelve
 * resting orders had two that were invisible,
 * uncancellable, and holding their reservation in the in-order ledger with no
 * way to release it.
 *
 * ALSO GUARDED HERE, because they are the same defect wearing other clothes:
 *
 *  - `getOrderHistory` and `getTradeHistory` echoed `currentPage: 1` from a
 *    handler that reads `page` off the query. The client stores that and asks
 *    for `currentPage + 1`, so every "load more" on those tables re-requested
 *    page 2 for ever.
 *  - `getOpenOrderSocket` sent `{pairId, data, count}` and nothing else, while
 *    the client assigns the payload over its WHOLE state. `nextPage` landed as
 *    `undefined` (a falsy `hasMore`) and `currentPage` as `undefined` (so the
 *    next request was for page `NaN`) on the first push after mount - which is
 *    to say the moment the user placed their first order.
 *
 * MUTATION-CHECKED - each of these makes named cases here fail:
 *   M1  restore `nextPage: data.length <= 0 ? true : false`
 *   M2  move `count = data.length` back below the slice
 *   M3  over-correct to `nextPage: count > data.length` (true on every short
 *       last page)
 *   M4  over-correct to `nextPage: true` (always another page)
 *   M5  put `currentPage: 1` back on the two history readers
 *   M6  drop the paging fields from the socket payload again
 * The per-mutant table is in the round summary.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

jest.mock('node-cron', () => ({ schedule: () => ({ stop: () => {} }) }));

jest.mock('../../models/index.js', () => ({
  __esModule: true,
  SpotPair: { find: async () => [], findOne: () => ({ lean: async () => null }) },
  SpotOrder: {},
  TradeHistory: Object.assign(class {}, { aggregate: async () => [] }),
  OrderHistory: { countDocuments: async () => 0, aggregate: async () => [] },
  SequenceId: { findOneAndUpdate: async () => ({ lastIndex: 1000 }) }
}));

const emitted = [];
jest.mock('../../config/socketIO.js', () => ({
  __esModule: true,
  socketEmitOne: (event, result, userId) => emitted.push({ event, result, userId }),
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
jest.mock('../../controllers/redis.controller.js', () => {
  const hashes = new Map();
  const hash = (key) => {
    const k = String(key);
    if (!hashes.has(k)) hashes.set(k, new Map());
    return hashes.get(k);
  };
  return {
    __esModule: true,
    __reset: () => hashes.clear(),
    __seed: (key, field, value) =>
      hash(key).set(String(field), typeof value === 'string' ? value : JSON.stringify(value)),
    set: async () => true,
    get: async () => null,
    del: async () => true,
    hset: async (key, field, data) => {
      hash(key).set(String(field), JSON.stringify(data));
    },
    hget: async (key, field) => {
      const map = hashes.get(String(key));
      const value = map && map.get(String(field));
      return value === undefined ? null : value;
    },
    hgetall: async (key) => {
      const map = hashes.get(String(key));
      if (!map || map.size === 0) return null;
      const out = {};
      for (const [field, value] of map) out[field] = value;
      return out;
    },
    hdel: async () => 1,
    hgetdel: async () => null,
    hincbyfloat: async () => '0',
    hincrbyfloatIfEnough: async () => null,
    hincby: async () => {},
    hlen: async () => 0,
    hmget: async (key, fields) => fields.map(() => null),
    hmset: async () => {},
    rpush: async () => {},
    lrange: async () => null,
    lpop: async () => {},
    rpop: async () => {}
  };
});

import {
  getOpenOrder,
  getOpenOrderSocket,
  getOrderHistory,
  getTradeHistory,
} from '../../controllers/spot.controller.js';
import * as redis from '../../controllers/redis.controller.js';

const USER = '6a7696575c3ed9629adcb3df';
const OTHER_USER = '6a7696575c3ed9629adcb3e0';
const PAIR = '695bf1017573eeb15a749c9d';

const pair = {
  _id: PAIR,
  status: 'active',
  tikerRoot: 'BTCUSD',
  firstCurrencySymbol: 'BTC',
  secondCurrencySymbol: 'USD'
};

/** An express double that records exactly one response, and says so. */
const response = () => {
  const res = { statusCode: null, body: null, writes: 0 };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.writes += 1;
    res.body = payload;
    return res;
  };
  return res;
};

const restingOrder = (id, overrides = {}) => ({
  _id: id,
  orderCode: id,
  userId: USER,
  pairId: PAIR,
  buyorsell: 'buy',
  orderType: 'limit',
  status: 'open',
  price: 64000,
  quantity: 0.1,
  filledQuantity: 0,
  orderDate: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
  createdAt: 1,
  ...overrides
});

/** `n` resting buy orders, oldest first, seeded into the live book. */
const seedOpenOrders = (n, userId = USER) => {
  for (let i = 0; i < n; i += 1) {
    redis.__seed(
      'buyOpenOrders_' + PAIR,
      'o' + i,
      restingOrder('o' + i, {
        userId,
        orderDate: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
      })
    );
  }
};

beforeEach(() => {
  redis.__reset();
  emitted.length = 0;
  redis.__seed('spotPairdata', PAIR, pair);
});

describe('spot open orders: every resting order is reachable', () => {
  test('a full first page reports the WHOLE set in `count`, not the page size', async () => {
    seedOpenOrders(12);
    const res = response();
    await getOpenOrder(
      { params: { pairId: PAIR }, query: { page: 1, limit: 10 }, user: { id: USER } },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.result.data).toHaveLength(10);
    // M2: was `data.length` taken after the slice, i.e. 10 - which is also the
    // number the client compares against before asking for more.
    expect(res.body.result.count).toBe(12);
  });

  test('a full first page with more behind it says so', async () => {
    seedOpenOrders(12);
    const res = response();
    await getOpenOrder(
      { params: { pairId: PAIR }, query: { page: 1, limit: 10 }, user: { id: USER } },
      res
    );
    // M1/M4: `data.length <= 0` gave false here - the exact reading that made
    // the eleventh and twelfth orders unreachable.
    expect(res.body.result.nextPage).toBe(true);
  });

  test('the last page says there is nothing after it', async () => {
    seedOpenOrders(12);
    const res = response();
    await getOpenOrder(
      { params: { pairId: PAIR }, query: { page: 2, limit: 10 }, user: { id: USER } },
      res
    );

    expect(res.body.result.data).toHaveLength(2);
    // M3: `count > data.length` is 12 > 2 - true - so an over-correction sends
    // the scroller after a page 3 that does not exist, for ever.
    expect(res.body.result.nextPage).toBe(false);
  });

  test('an exactly-full single page claims no second page', async () => {
    seedOpenOrders(10);
    const res = response();
    await getOpenOrder(
      { params: { pairId: PAIR }, query: { page: 1, limit: 10 }, user: { id: USER } },
      res
    );

    expect(res.body.result.data).toHaveLength(10);
    expect(res.body.result.count).toBe(10);
    // M3/M4 both make this true, and a true `hasMore` is what mounts the
    // "no records found" illustration underneath ten live rows.
    expect(res.body.result.nextPage).toBe(false);
  });

  test('no orders at all is an empty 200, and there is no next page', async () => {
    const res = response();
    await getOpenOrder(
      { params: { pairId: PAIR }, query: {}, user: { id: USER } },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.result.data).toEqual([]);
    expect(res.body.result.count).toBe(0);
    // M1: this is where the old expression said TRUE.
    expect(res.body.result.nextPage).toBe(false);
  });

  test('paging twice yields every order exactly once, and no order twice', async () => {
    seedOpenOrders(12);

    const seen = [];
    for (const page of [1, 2]) {
      const res = response();
      await getOpenOrder(
        { params: { pairId: PAIR }, query: { page, limit: 10 }, user: { id: USER } },
        res
      );
      for (const row of res.body.result.data) seen.push(row._id);
    }

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    for (let i = 0; i < 12; i += 1) expect(seen).toContain('o' + i);
  });

  test('the page echoes the page that was asked for', async () => {
    seedOpenOrders(12);
    const res = response();
    await getOpenOrder(
      { params: { pairId: PAIR }, query: { page: 2, limit: 10 }, user: { id: USER } },
      res
    );
    expect(res.body.result.currentPage).toBe(2);
  });

  test("another user's resting orders are neither counted nor paged over", async () => {
    seedOpenOrders(3, USER);
    for (let i = 0; i < 5; i += 1) {
      redis.__seed(
        'buyOpenOrders_' + PAIR,
        'x' + i,
        restingOrder('x' + i, { userId: OTHER_USER })
      );
    }

    const res = response();
    await getOpenOrder(
      { params: { pairId: PAIR }, query: { page: 1, limit: 10 }, user: { id: USER } },
      res
    );

    expect(res.body.result.count).toBe(3);
    expect(res.body.result.data.map((o) => o._id).sort()).toEqual(['o0', 'o1', 'o2']);
    expect(res.body.result.nextPage).toBe(false);
  });
});

describe('spot open orders: the socket push carries the same contract', () => {
  test('the push names every field the client assigns from it', async () => {
    seedOpenOrders(12);
    await getOpenOrderSocket(USER, PAIR);

    expect(emitted).toHaveLength(1);
    const { event, result, userId } = emitted[0];
    expect(event).toBe('openOrder');
    expect(userId).toBe(USER);
    // M6: `currentPage` and `limit` were absent, and the client writes the
    // payload over its whole state - so it stored undefined for both and then
    // asked for page `undefined + 1`.
    expect(result.currentPage).toBe(1);
    expect(result.limit).toBe(10);
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(['pairId', 'data', 'count', 'currentPage', 'nextPage', 'limit'])
    );
  });

  test('the push carries the WHOLE set, so it claims no page after it', async () => {
    seedOpenOrders(12);
    await getOpenOrderSocket(USER, PAIR);

    const { result } = emitted[0];
    expect(result.data).toHaveLength(12);
    expect(result.count).toBe(12);
    // Not `hasNextPage(...)`: there is no slice above it. A computed flag would
    // be false here anyway, but for the wrong reason, and would flip the moment
    // somebody added one.
    expect(result.nextPage).toBe(false);
  });

  test('an empty push does not claim there is more', async () => {
    await getOpenOrderSocket(USER, PAIR);
    expect(emitted[0].result.data).toEqual([]);
    expect(emitted[0].result.nextPage).toBe(false);
  });
});

describe('the history readers echo the page they were asked for', () => {
  const seedHistory = (n) => {
    for (let i = 0; i < n; i += 1) {
      redis.__seed(
        'orderHistory_' + USER,
        'h' + i,
        restingOrder('h' + i, {
          status: 'completed',
          orderDate: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString()
        })
      );
    }
  };

  test('getOrderHistory returns page 2 and SAYS page 2', async () => {
    seedHistory(12);
    const res = response();
    await getOrderHistory(
      { params: { pairId: PAIR }, query: { page: 2, limit: 10 }, user: { id: USER } },
      res
    );

    expect(res.body.result.count).toBe(12);
    expect(res.body.result.data).toHaveLength(2);
    // M5: hardcoded `1`, so the client's "load more" asked for page 2 again.
    expect(res.body.result.currentPage).toBe(2);
    expect(res.body.result.nextPage).toBe(false);
  });

  test('getOrderHistory page 1 of 12 rows says there is more', async () => {
    seedHistory(12);
    const res = response();
    await getOrderHistory(
      { params: { pairId: PAIR }, query: { page: 1, limit: 10 }, user: { id: USER } },
      res
    );
    expect(res.body.result.currentPage).toBe(1);
    expect(res.body.result.nextPage).toBe(true);
  });

  test('getTradeHistory echoes its page and pages to the end', async () => {
    // A trade row, not an order row: getvalueObjbyId(_, _, "trade") selects on
    // `buyUserId`/`sellUserId` and rebuilds the row from the trade's own
    // fields.
    for (let i = 0; i < 12; i += 1) {
      redis.__seed('tradeHistory_' + PAIR, 't' + i, {
        _id: 't' + i,
        buyUserId: USER,
        sellUserId: OTHER_USER,
        pairId: PAIR,
        firstCurrency: 'BTC',
        secondCurrency: 'USD',
        tradePrice: 64000,
        tradeQty: 0.1,
        buyerFee: 0,
        sellerFee: 0,
        buyOrdCode: 'b' + i,
        sellOrdCode: 's' + i,
        buyerFeeCurrency: 'USD',
        sellerFeeCurrency: 'BTC',
        createdAt: i
      });
    }

    const first = response();
    await getTradeHistory(
      { params: { pairId: PAIR }, query: { page: 1, limit: 10 }, user: { id: USER } },
      first
    );
    expect(first.body.result.currentPage).toBe(1);
    expect(first.body.result.count).toBe(12);
    expect(first.body.result.nextPage).toBe(true);

    const second = response();
    await getTradeHistory(
      { params: { pairId: PAIR }, query: { page: 2, limit: 10 }, user: { id: USER } },
      second
    );
    expect(second.body.result.currentPage).toBe(2);
    expect(second.body.result.data).toHaveLength(2);
    expect(second.body.result.nextPage).toBe(false);
  });

  test('an empty history is an empty page, not a claim that there is more', async () => {
    const res = response();
    await getOrderHistory(
      { params: { pairId: PAIR }, query: { page: 1, limit: 10 }, user: { id: USER } },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.result.data).toEqual([]);
    expect(res.body.result.nextPage).toBe(false);
  });
});

describe('every reader writes exactly one response', () => {
  test('getOpenOrder answers once on the empty path', async () => {
    const res = response();
    await getOpenOrder({ params: { pairId: PAIR }, query: {}, user: { id: USER } }, res);
    expect(res.writes).toBe(1);
  });

  test('getTradeHistory answers once on the empty path', async () => {
    const res = response();
    await getTradeHistory({ params: { pairId: PAIR }, query: {}, user: { id: USER } }, res);
    expect(res.writes).toBe(1);
  });
});

/**
 * WHAT THE "Open Orders(N)" BADGE IS COUNTING
 * ===========================================
 *
 * The badge beside this table is meant to say how many open orders the user
 * has on the market they are looking at. The client had no such figure - the
 * response carried only `count`, the whole-set total - so it counted the rows
 * of the PAGE it had loaded, and under-reported until the user scrolled.
 *
 * `pairCount` is that figure, taken before the slice for the same reason
 * `count` is. `count` remains the all-markets total, which is what the badge
 * wants when the user has "show all markets" on.
 */
describe('open orders: the per-pair total the badge needs', () => {
  const OTHER_PAIR = '695bf1017573eeb15a749c9e';
  const otherPair = { ...pair, _id: OTHER_PAIR, tikerRoot: 'ETHUSD' };

  test('pairCount counts every order on the requested pair, not the page', async () => {
    seedOpenOrders(23);
    const res = response();
    await getOpenOrder(
      { user: { id: USER }, params: { pairId: PAIR }, query: { page: 1, limit: 10 } },
      res
    );

    expect(res.body.result.data).toHaveLength(10);
    expect(res.body.result.pairCount).toBe(23);
    expect(res.body.result.count).toBe(23);
  });

  test('it is unchanged by which page was asked for', async () => {
    seedOpenOrders(23);
    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = response();
      await getOpenOrder(
        { user: { id: USER }, params: { pairId: PAIR }, query: { page, limit: 10 } },
        res
      );
      seen.push(res.body.result.pairCount);
    }
    expect(seen).toEqual([23, 23, 23]);
  });

  test('orders on OTHER markets are in count but not in pairCount', async () => {
    redis.__seed('spotPairdata', OTHER_PAIR, otherPair);
    seedOpenOrders(4);
    for (let i = 0; i < 6; i += 1) {
      redis.__seed(
        'buyOpenOrders_' + OTHER_PAIR,
        'x' + i,
        restingOrder('x' + i, { pairId: OTHER_PAIR })
      );
    }

    const res = response();
    await getOpenOrder(
      { user: { id: USER }, params: { pairId: PAIR }, query: { page: 1, limit: 10 } },
      res
    );

    expect(res.body.result.count).toBe(10);
    expect(res.body.result.pairCount).toBe(4);
  });

  test("another user's orders are in neither figure", async () => {
    seedOpenOrders(3);
    for (let i = 0; i < 5; i += 1) {
      redis.__seed(
        'buyOpenOrders_' + PAIR,
        'z' + i,
        restingOrder('z' + i, { userId: OTHER_USER })
      );
    }

    const res = response();
    await getOpenOrder(
      { user: { id: USER }, params: { pairId: PAIR }, query: { page: 1, limit: 10 } },
      res
    );

    expect(res.body.result.count).toBe(3);
    expect(res.body.result.pairCount).toBe(3);
  });

  test('an empty book reports zero rather than omitting the field', async () => {
    const res = response();
    await getOpenOrder(
      { user: { id: USER }, params: { pairId: PAIR }, query: { page: 1, limit: 10 } },
      res
    );
    expect(res.body.result.pairCount).toBe(0);
  });

  test('the socket push carries the same figure', async () => {
    redis.__seed('spotPairdata', OTHER_PAIR, otherPair);
    seedOpenOrders(2);
    for (let i = 0; i < 3; i += 1) {
      redis.__seed(
        'buyOpenOrders_' + OTHER_PAIR,
        'x' + i,
        restingOrder('x' + i, { pairId: OTHER_PAIR })
      );
    }

    await getOpenOrderSocket(USER, PAIR);

    const push = emitted.find((e) => e.event === 'openOrder');
    expect(push.result.count).toBe(5);
    expect(push.result.pairCount).toBe(2);
  });
});

