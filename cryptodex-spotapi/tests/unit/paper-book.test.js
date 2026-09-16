/**
 * Paper Trading Liquidity Book Tests (CRITICAL)
 *
 * Pins the three bugs that made this a paper exchange whose orders never filled:
 *   1. botstatus "binance" pairs had no counterparty source at all, so every
 *      order rested forever (controllers/paperBook.controller.js now mirrors the
 *      live Binance depth as admin-owned resting limit orders).
 *   2. The limit price band was computed by SUBTRACTING a negative
 *      minPricePercentage, which inverted the window to "90-100% above market"
 *      and rejected every realistic limit price.
 *   3. cancelOrder released walletbalance_spot_inOrder for market orders that
 *      never reserved any, driving the in-order ledger negative.
 *
 * The matcher is exercised for real (controllers/spot.controller.js) against an
 * in-memory redis, so a market order genuinely has to fill.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

// ---- I/O mocks. Plain functions (not jest.fn) so jest's resetMocks between
// ---- tests cannot strip the behaviour these flows depend on.

jest.mock('node-cron', () => ({ schedule: () => ({ stop: () => {} }) }));

jest.mock('../../models/index.js', () => {
  const trades = [];
  const savedOrders = [];
  // Query counters: a pair lookup must never fan out into a collection scan.
  const calls = { spotPairFind: 0, spotPairFindOne: 0 };
  return {
    __esModule: true,
    __trades: trades,
    __savedOrders: savedOrders,
    __calls: calls,
    SpotPair: {
      find: async () => {
        calls.spotPairFind += 1;
        return [];
      },
      // Thenable AND chainable, so `await findOne(...)` and
      // `await findOne(...).lean()` both resolve to null exactly as mongoose's
      // would for a pairId that does not exist.
      findOne: () => {
        calls.spotPairFindOne += 1;
        const query = Promise.resolve(null);
        query.lean = async () => null;
        return query;
      },
      updateOne: () => ({ exec: async () => {} })
    },
    SpotOrder: {},
    OrderHistory: {
      findOneAndUpdate: (filter, update) => {
        savedOrders.push({ filter, update });
        return { exec: () => ({ then: (cb) => { cb(); return { catch: () => {} }; } }) };
      }
    },
    TradeHistory: class {
      constructor(data) {
        Object.assign(this, data);
        trades.push(data);
      }
      async save() {
        return this;
      }
    },
    SequenceId: {
      findOneAndUpdate: async () => ({ lastIndex: 1000 })
    }
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

// In-memory redis so balances, ledgers and the open-order hashes really move.
jest.mock('../../controllers/redis.controller.js', () => {
  const hashes = new Map();
  const strings = new Map();
  const ledgers = new Map();
  const hash = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  return {
    __esModule: true,
    __hashes: hashes,
    __strings: strings,
    __reset: () => {
      hashes.clear();
      strings.clear();
      ledgers.clear();
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
      // node-redis v3 returns null (not {}) for a missing key
      if (!map || map.size === 0) return null;
      const out = {};
      for (const [field, value] of map) out[field] = value;
      return out;
    },
    // Real HDEL semantics: the reply is the number of fields actually removed.
    hdel: async (key, field) => {
      const map = hashes.get(key);
      if (map && map.delete(String(field))) return 1;
      return 0;
    },
    // Real HGETDEL/Lua semantics: read+delete as ONE indivisible step.
    hgetdel: async (key, field) => {
      const map = hashes.get(key);
      const value = map && map.get(String(field));
      if (value === undefined) return null;
      map.delete(String(field));
      return value;
    },
    hincbyfloat: async (key, field, increment) => {
      const map = hash(key);
      const current = parseFloat(map.get(String(field)) || 0);
      const next = current + parseFloat(increment);
      map.set(String(field), String(next));
      return String(next);
    },
    // Real Lua semantics: compare and debit as ONE indivisible step, so the
    // balance is never transiently negative and a refused reservation moves
    // nothing at all. Node is single threaded, so an `async` body with no
    // await inside is genuinely atomic here, exactly as the script is on the
    // server.
    hincrbyfloatIfEnough: async (key, field, amount) => {
      const amt = parseFloat(amount);
      if (!Number.isFinite(amt) || amt <= 0) return null;
      const map = hash(key);
      const current = parseFloat(map.get(String(field)) || 0);
      if (!Number.isFinite(current) || current < amt) return null;
      const next = current - amt;
      map.set(String(field), String(next));
      return String(next);
    },
    // The ledger-writing mutation. Mirrors the real Lua: a credit always lands,
    // a debit refuses rather than overdrawing, a freeze refuses, and an entry is
    // appended ONLY on the branch that actually moved the balance - so a replay
    // can never count money that never moved.
    moveBalanceLogged: async (key, field, amount, opts = {}) => {
      const { direction = 'credit', reason = 'unspecified', ref = '', freezeKey = null } = opts;
      const amt = parseFloat(amount);
      if (!Number.isFinite(amt) || amt <= 0) return null;
      // This mock keeps freezes in the plain string store.
      if (freezeKey && strings.has(String(freezeKey))) return 'FROZEN';
      const map = hash(key);
      const before = parseFloat(map.get(String(field)) || 0);
      if (direction === 'debit' && (!Number.isFinite(before) || before < amt)) return null;
      const after = direction === 'debit' ? before - amt : before + amt;
      map.set(String(field), String(after));
      const stream = ledgers.get(String(field)) || [];
      stream.push({
        id: `${Date.now()}-${stream.length}`,
        field: String(field),
        delta: String(direction === 'debit' ? -amt : amt),
        before: String(before),
        after: String(after),
        reason: String(reason),
        ref: String(ref),
      });
      ledgers.set(String(field), stream);
      return { balance: String(after), entryId: stream[stream.length - 1].id };
    },
    // The unconditional signed apply: the faithful stand-in for a bare
    // hincbyfloat. No affordability check, CAN take a balance negative, always
    // logs. A stub that refused here would make the matcher's refund paths
    // silently no-op, which surfaces as a hang rather than a failure.
    moveBalanceSigned: async (key, field, delta, opts = {}) => {
      const d = parseFloat(delta);
      if (!Number.isFinite(d) || d === 0) return null;
      const map = hash(key);
      const before = parseFloat(map.get(String(field)) || 0);
      const after = before + d;
      map.set(String(field), String(after));
      const stream = ledgers.get(String(field)) || [];
      stream.push({
        id: `${Date.now()}-${stream.length}`,
        field: String(field),
        delta: String(d),
        before: String(before),
        after: String(after),
        reason: String(opts.reason || 'unspecified'),
        ref: String(opts.ref || ''),
      });
      ledgers.set(String(field), stream);
      // A STRING, like the real one and like the hincbyfloat it replaced. Every
      // caller does parseFloat() on this; an object here becomes a silent NaN.
      return String(after);
    },
    readLedger: async (field) => (ledgers.get(String(field)) || []).slice(),
    ledgerLength: async (field) => (ledgers.get(String(field)) || []).length,
    ledgerStreamKey: (field) => `ledger_${field}`,
    hincby: async (key, field, increment) => {
      const map = hash(key);
      const current = parseFloat(map.get(String(field)) || 0);
      map.set(String(field), String(current + parseFloat(increment)));
    },
    hlen: async (key) => (hashes.get(key) ? hashes.get(key).size : 0),
    hmget: async (key, fields) => fields.map(() => null),
    hmset: async () => {},
    rpush: async () => {},
    lrange: async () => null,
    lpop: async () => {},
    rpop: async () => {}
  };
});

jest.mock('../../lib/binanceWebSocket.js', () => {
  const state = { book: null };
  return {
    __esModule: true,
    __state: state,
    getDepthSnapshot: () => state.book
  };
});

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

import {
  buildPaperOrders,
  syncPaperBook,
  purgePaperBook,
  sweepOrphanLadders,
} from '../../controllers/paperBook.controller.js';
import {
  matchingcall,
  limitOrderPlace,
  marketOrderPlace,
  cancelOrder,
  orderBookData,
  assetUpdate,
} from '../../controllers/spot.controller.js';
import * as redisMock from '../../controllers/redis.controller.js';
import * as wsMock from '../../lib/binanceWebSocket.js';
import * as modelsMock from '../../models/index.js';

const PAIR_ID = '695bf1017573eeb15a749c9d';
const USD_ID = '695bf0e2b9aba016fb8ce3c4';
const BTC_ID = '695bf0e2b9aba016fb8ce3c1';
const USER_ID = '6a70f1c287c92c7218ac37fc';
const ADMIN_ID = '695af33fe64f3be062b77bb4';

const pairFixture = {
  _id: PAIR_ID,
  pairName: 'BTC/USD',
  tikerRoot: 'BTCUSD',
  firstCurrencyId: BTC_ID,
  secondCurrencyId: USD_ID,
  firstCurrencySymbol: 'BTC',
  secondCurrencySymbol: 'USD',
  firstFloatDigit: 8,
  secondFloatDigit: 2,
  maker_rebate: 0.02,
  taker_fees: 0.1,
  minQuantity: 0.0001,
  maxQuantity: 1000,
  minPricePercentage: -90,
  maxPricePercentage: 100,
  status: 'active',
  botstatus: 'binance',
  markPrice: 63500
};

const adminLiq = { _id: ADMIN_ID, userId: '12024756', role: 'admin_bot' };

const balance = (hashKey, field) => {
  const map = redisMock.__hashes.get(hashKey);
  return parseFloat((map && map.get(field)) || 0);
};
const openOrders = (side) => {
  const map = redisMock.__hashes.get(`${side}OpenOrders_${PAIR_ID}`);
  if (!map) return [];
  return Array.from(map.values()).map((v) => JSON.parse(v));
};
const userOrders = (side) => openOrders(side).filter((o) => !o.isPaper);

const seed = async ({ usd = 10000, btc = 1 } = {}) => {
  redisMock.__reset();
  modelsMock.__trades.length = 0;
  modelsMock.__savedOrders.length = 0;
  await redisMock.hset('spotPairdata', PAIR_ID, pairFixture);
  await redisMock.hset('admin_liquidity', 'liquidation', adminLiq);
  await redisMock.hincbyfloat('walletbalance_spot', `${USER_ID}_${USD_ID}`, usd);
  await redisMock.hincbyfloat('walletbalance_spot', `${USER_ID}_${BTC_ID}`, btc);
  await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 0);
  await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`, 0);
  wsMock.__state.book = {
    lastUpdateId: 1,
    updatedAt: Date.now(),
    bids: [
      { price: 63499, quantity: 0.5 },
      { price: 63498, quantity: 1 },
      { price: 63497, quantity: 2 }
    ],
    asks: [
      { price: 63500, quantity: 0.5 },
      { price: 63501, quantity: 1 },
      { price: 63502, quantity: 2 }
    ]
  };
};

const mockRes = () => {
  const res = { statusCode: null, payload: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.payload = body;
    return res;
  };
  return res;
};

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// ---------------------------------------------------------------------------

describe('buildPaperOrders (PURE)', () => {
  const levels = [
    { price: 100, quantity: 1 },
    { price: 101, quantity: 2 },
    { price: 102, quantity: 3 }
  ];

  test('quotes one synthetic order per depth level', () => {
    const orders = buildPaperOrders(pairFixture, levels, 'sell', adminLiq);
    expect(orders).toHaveLength(3);
  });

  // averagePrice is a CUMULATIVE FILLED NOTIONAL, not a price: every consumer
  // (frontend Spot/OrderHistory.tsx, admin report execPrice) divides it by
  // filledQuantity. A brand new order has filled nothing, so it must start at 0
  // on the ladder exactly as it does on a user order.
  test('averagePrice starts at zero (it is a filled notional, not a price)', () => {
    const orders = buildPaperOrders(pairFixture, levels, 'sell', adminLiq);
    orders.forEach((o) => expect(o.averagePrice).toBe(0));
  });

  test('carries the flags every matcher branch is gated on', () => {
    const orders = buildPaperOrders(pairFixture, levels, 'sell', adminLiq);
    orders.forEach((o) => {
      expect(o.liquidityType).toBe('off');
      expect(o.flag).toBe(false);
      expect(o.orderType).toBe('limit');
      expect(o.isPaper).toBe(true);
      expect(o.status).toBe('open');
    });
  });

  test('is owned by the admin liquidation account', () => {
    const orders = buildPaperOrders(pairFixture, levels, 'sell', adminLiq);
    orders.forEach((o) => {
      expect(o.userId).toBe(ADMIN_ID);
      expect(o.userCode).toBe(adminLiq.userId);
    });
  });

  test('price is numeric, never the string "market"', () => {
    const orders = buildPaperOrders(pairFixture, levels, 'sell', adminLiq);
    orders.forEach((o) => {
      expect(typeof o.price).toBe('number');
      expect(o.price).not.toBe('market');
    });
  });

  test('orderValue and openOrderValue equal price * quantity', () => {
    const orders = buildPaperOrders(pairFixture, levels, 'sell', adminLiq);
    orders.forEach((o) => {
      expect(o.orderValue).toBeCloseTo(o.price * o.quantity, 8);
      expect(o.openOrderValue).toBe(o.orderValue);
    });
  });

  test('carries no orderCode, so the ladder costs no mongo counter writes', () => {
    const orders = buildPaperOrders(pairFixture, levels, 'sell', adminLiq);
    orders.forEach((o) => expect(o.orderCode).toBe(0));
  });

  test('merges sub-minimum-notional dust levels', () => {
    const dust = [
      { price: 100, quantity: 0.05 }, // 5
      { price: 101, quantity: 0.05 }, // 5.05
      { price: 102, quantity: 0.2 } // 20.4 -> group clears 25
    ];
    const orders = buildPaperOrders(pairFixture, dust, 'sell', adminLiq);
    expect(orders).toHaveLength(1);
    expect(orders[0].quantity).toBeCloseTo(0.3, 8);
  });

  test('aggregated ask takes the WORST (highest) price of its group', () => {
    const dust = [
      { price: 100, quantity: 0.05 },
      { price: 101, quantity: 0.05 },
      { price: 102, quantity: 0.2 }
    ];
    const orders = buildPaperOrders(pairFixture, dust, 'sell', adminLiq);
    expect(orders[0].price).toBe(102);
  });

  test('aggregated bid takes the WORST (lowest) price of its group', () => {
    const dust = [
      { price: 102, quantity: 0.05 },
      { price: 101, quantity: 0.05 },
      { price: 100, quantity: 0.2 }
    ];
    const orders = buildPaperOrders(pairFixture, dust, 'buy', adminLiq);
    expect(orders[0].price).toBe(100);
  });

  test('caps the ladder depth', () => {
    const deep = [];
    for (let i = 0; i < 60; i++) deep.push({ price: 100 + i, quantity: 1 });
    const orders = buildPaperOrders(pairFixture, deep, 'sell', adminLiq);
    expect(orders.length).toBeLessThanOrEqual(12);
  });

  test('returns [] for empty depth', () => {
    expect(buildPaperOrders(pairFixture, [], 'sell', adminLiq)).toEqual([]);
    expect(buildPaperOrders(pairFixture, null, 'sell', adminLiq)).toEqual([]);
  });

  test('returns [] without an admin liquidation account', () => {
    expect(buildPaperOrders(pairFixture, levels, 'sell', null)).toEqual([]);
  });
});

describe('syncPaperBook (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  test('writes a ladder into both open-order hashes', async () => {
    const result = await syncPaperBook(pairFixture);
    expect(result.ok).toBe(true);
    expect(openOrders('buy').length).toBeGreaterThan(0);
    expect(openOrders('sell').length).toBeGreaterThan(0);
    expect(openOrders('sell').every((o) => o.isPaper)).toBe(true);
  });

  test('replaces the previous ladder instead of stacking it', async () => {
    await syncPaperBook(pairFixture);
    const first = openOrders('sell').length;
    await syncPaperBook(pairFixture);
    expect(openOrders('sell')).toHaveLength(first);
  });

  test('never touches real user orders', async () => {
    await redisMock.hset('buyOpenOrders_' + PAIR_ID, 'user-1', {
      _id: 'user-1',
      userId: USER_ID,
      price: 60000,
      quantity: 1
    });
    await syncPaperBook(pairFixture);
    expect(userOrders('buy').map((o) => o._id)).toEqual(['user-1']);
    await purgePaperBook(PAIR_ID);
    expect(userOrders('buy').map((o) => o._id)).toEqual(['user-1']);
    expect(openOrders('sell')).toHaveLength(0);
  });

  test('purges and quotes nothing when the depth cache is stale', async () => {
    await syncPaperBook(pairFixture);
    expect(openOrders('sell').length).toBeGreaterThan(0);
    wsMock.__state.book.updatedAt = Date.now() - 60000;
    const result = await syncPaperBook(pairFixture);
    expect(result).toEqual({ ok: false, reason: 'stale_depth' });
    expect(openOrders('sell')).toHaveLength(0);
  });

  test('purges when the cached book is crossed', async () => {
    wsMock.__state.book.asks[0].price = 63000;
    const result = await syncPaperBook(pairFixture);
    expect(result.reason).toBe('crossed_book');
    expect(openOrders('sell')).toHaveLength(0);
  });

  test('purges when depth has run away from markPrice', async () => {
    wsMock.__state.book.bids = wsMock.__state.book.bids.map((b) => ({
      ...b,
      price: b.price * 2
    }));
    wsMock.__state.book.asks = wsMock.__state.book.asks.map((a) => ({
      ...a,
      price: a.price * 2
    }));
    const result = await syncPaperBook(pairFixture);
    expect(result.reason).toBe('price_deviation');
    expect(openOrders('sell')).toHaveLength(0);
  });

  test('does nothing for non-binance pairs', async () => {
    const result = await syncPaperBook({ ...pairFixture, botstatus: 'off' });
    expect(result).toEqual({ ok: false, reason: 'not_binance' });
    expect(openOrders('sell')).toHaveLength(0);
  });
});

// ===========================================================================
// The ladder is admin-owned liquidity that was never debited from any wallet.
// Every path that makes a pair stop being eligible must take it out of the
// book: leaving it resting means the matcher can keep filling users against
// house orders nobody is refreshing any more.
// ===========================================================================

describe('syncPaperBook purges the ladder when the pair stops being eligible (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  const ladderSize = () =>
    openOrders('buy').filter((o) => o.isPaper).length +
    openOrders('sell').filter((o) => o.isPaper).length;

  test('botstatus flipped away from binance (ordinary admin action)', async () => {
    await syncPaperBook(pairFixture);
    expect(ladderSize()).toBeGreaterThan(0);

    const result = await syncPaperBook({ ...pairFixture, botstatus: 'off' });

    expect(result).toEqual({ ok: false, reason: 'not_binance' });
    // Was 24 stranded, never-debited, fillable admin orders before the fix.
    expect(ladderSize()).toBe(0);
  });

  test('pair deactivated', async () => {
    await syncPaperBook(pairFixture);
    expect(ladderSize()).toBeGreaterThan(0);

    const result = await syncPaperBook({ ...pairFixture, status: 'deactive' });

    expect(result).toEqual({ ok: false, reason: 'pair_inactive' });
    expect(ladderSize()).toBe(0);
  });

  test('purging an ineligible pair leaves real user orders alone', async () => {
    await redisMock.hset('buyOpenOrders_' + PAIR_ID, 'user-1', {
      _id: 'user-1',
      userId: USER_ID,
      price: 60000,
      quantity: 1
    });
    await syncPaperBook(pairFixture);

    await syncPaperBook({ ...pairFixture, botstatus: 'off' });

    expect(ladderSize()).toBe(0);
    expect(userOrders('buy').map((o) => o._id)).toEqual(['user-1']);
  });

  test('admin liquidity account disappears (ladder cannot be rebuilt)', async () => {
    await syncPaperBook(pairFixture);
    expect(ladderSize()).toBeGreaterThan(0);

    await redisMock.hdel('admin_liquidity', 'liquidation');
    const result = await syncPaperBook(pairFixture);

    expect(result).toEqual({ ok: false, reason: 'no_admin_liquidity' });
    expect(ladderSize()).toBe(0);
  });

  test('a pair the matcher has stopped visiting is swept by another pair cycle', async () => {
    await syncPaperBook(pairFixture);
    expect(ladderSize()).toBeGreaterThan(0);

    // The pair is deleted / deactivated / dropped from the cron's pair list:
    // syncPaperBook is simply never called for it again, so nobody but the
    // sweep can ever remove its ladder.
    const swept = await sweepOrphanLadders(null, Date.now() + 120000);

    expect(swept).toContain(PAIR_ID);
    expect(ladderSize()).toBe(0);
  });

  test('a pair that is still being refreshed is never swept', async () => {
    await syncPaperBook(pairFixture);
    const before = ladderSize();

    const swept = await sweepOrphanLadders(null, Date.now());

    expect(swept).toEqual([]);
    expect(ladderSize()).toBe(before);
  });
});

// ===========================================================================
// orderBookData used to dereference an undefined pair for any pairId that
// names no pair - an unauthenticated GET - and every one of those requests
// paid for a full SpotPair collection scan on the way to the exception.
// ===========================================================================

describe('orderBookData for a pairId that names no pair', () => {
  beforeEach(async () => {
    await seed();
    modelsMock.__calls.spotPairFind = 0;
    modelsMock.__calls.spotPairFindOne = 0;
  });

  test('returns an empty book instead of throwing, with no collection scan', async () => {
    const result = await orderBookData({ pairId: '695bf1017573eeb15a749999' });

    expect(result).toEqual(
      expect.objectContaining({ buyOrder: [], sellOrder: [] })
    );
    // The indexed _id lookup is allowed; the collection scan is the defect.
    expect(modelsMock.__calls.spotPairFind).toBe(0);
    expect(modelsMock.__calls.spotPairFindOne).toBe(1);
  });

  test('a malformed pairId costs no database query at all', async () => {
    const result = await orderBookData({ pairId: 'not-an-object-id' });

    expect(result).toEqual(
      expect.objectContaining({ buyOrder: [], sellOrder: [] })
    );
    expect(modelsMock.__calls.spotPairFind).toBe(0);
    expect(modelsMock.__calls.spotPairFindOne).toBe(0);
  });

  // The cache-hit path (a real pair) is exercised by every matcher/order test
  // in this file, all of which resolve their pair through FetchpairData.
});

// ===========================================================================
// assetUpdate read `req.user.id` in a scope that has no `req`, so it threw a
// ReferenceError into an empty catch on every call: its callers' wallet credit
// silently never happened, and had it resolved it would have paid the balance
// to the requester instead of to the userId argument.
// ===========================================================================

describe('assetUpdate credits the user it was handed', () => {
  beforeEach(async () => {
    await seed();
  });

  test('moves walletbalance_spot for the userId argument', async () => {
    const before = balance('walletbalance_spot', `${USER_ID}_${USD_ID}`);

    const ok = await assetUpdate({
      currencyId: USD_ID,
      userId: USER_ID,
      balance: 25.5
    });

    expect(ok).toBe(true);
    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBeCloseTo(
      before + 25.5,
      6
    );
  });

  test('is a no-op (never a throw) for a missing user, currency or amount', async () => {
    await expect(
      assetUpdate({ currencyId: USD_ID, userId: USER_ID, balance: 0 })
    ).resolves.toBe(false);
    await expect(
      assetUpdate({ currencyId: USD_ID, userId: USER_ID })
    ).resolves.toBe(false);
    await expect(assetUpdate({ balance: 10 })).resolves.toBe(false);

    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBe(10000);
  });
});

describe('Market order FILLS against the paper book (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  test('a market buy fills at the live ask and settles both sides', async () => {
    const res = mockRes();
    await marketOrderPlace(
      {
        body: {
          orderType: 'market',
          buyorsell: 'buy',
          spotPairId: PAIR_ID,
          orderValue: 200,
          quantity: 0
        },
        user: { id: USER_ID, userCode: '11286524' }
      },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(userOrders('buy')).toHaveLength(1);

    await matchingcall(PAIR_ID);
    await flush();

    // Order is gone from the book and the buyer holds BTC
    expect(userOrders('buy')).toHaveLength(0);
    const btc = balance('walletbalance_spot', `${USER_ID}_${BTC_ID}`);
    expect(btc).toBeGreaterThan(1);

    // Exactly one trade, printed at the live best ask, with the paper side maker
    expect(modelsMock.__trades).toHaveLength(1);
    const trade = modelsMock.__trades[0];
    expect(trade.tradePrice).toBe(63500);
    expect(trade.isMaker).toBe('sell');
    expect(trade.buyUserId).toBe(USER_ID);
    expect(trade.sellUserId).toBe(ADMIN_ID);

    // ~200 USD spent, filled quantity net of the 0.1% taker fee
    const usd = balance('walletbalance_spot', `${USER_ID}_${USD_ID}`);
    expect(10000 - usd).toBeCloseTo(200 / 63500 * 63500, 2);
    // The FULL base bought, not 99.9% of it: the venue withdrew every fee, so
    // nothing is skimmed off the fill (the * 0.999 here was the 0.1% taker rate).
    expect(btc - 1).toBeCloseTo(200 / 63500, 6);
  });

  test('a market sell fills at the live bid', async () => {
    const res = mockRes();
    await marketOrderPlace(
      {
        body: {
          orderType: 'market',
          buyorsell: 'sell',
          spotPairId: PAIR_ID,
          amount: 0.01,
          quantity: 0.01
        },
        user: { id: USER_ID, userCode: '11286524' }
      },
      res
    );
    expect(res.statusCode).toBe(200);

    await matchingcall(PAIR_ID);
    await flush();

    expect(userOrders('sell')).toHaveLength(0);
    expect(modelsMock.__trades).toHaveLength(1);
    const trade = modelsMock.__trades[0];
    expect(trade.tradePrice).toBe(63499); // best bid, not markPrice
    expect(trade.isMaker).toBe('buy');
    expect(trade.buyUserId).toBe(ADMIN_ID);
    expect(trade.sellUserId).toBe(USER_ID);
  });

  test('the in-order ledger is untouched by a market fill and never negative', async () => {
    const res = mockRes();
    await marketOrderPlace(
      {
        body: {
          orderType: 'market',
          buyorsell: 'buy',
          spotPairId: PAIR_ID,
          orderValue: 200,
          quantity: 0
        },
        user: { id: USER_ID, userCode: '11286524' }
      },
      res
    );
    await matchingcall(PAIR_ID);
    await flush();
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBe(0);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`)).toBe(0);
  });

  test('the house ladder never drives the in-order ledger negative', async () => {
    const res = mockRes();
    await marketOrderPlace(
      {
        body: {
          orderType: 'market',
          buyorsell: 'buy',
          spotPairId: PAIR_ID,
          orderValue: 200,
          quantity: 0
        },
        user: { id: USER_ID, userCode: '11286524' }
      },
      res
    );
    await matchingcall(PAIR_ID);
    await flush();
    const ledger = redisMock.__hashes.get('walletbalance_spot_inOrder');
    for (const [field, value] of ledger) {
      expect(parseFloat(value)).toBeGreaterThanOrEqual(0);
      expect(field).toBeDefined();
    }
  });
});

describe('Limit order price band (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  const placeLimit = async (price, buyorsell = 'buy', quantity = 0.001) => {
    const res = mockRes();
    await limitOrderPlace(
      {
        body: { orderType: 'limit', buyorsell, spotPairId: PAIR_ID, price, quantity },
        user: { id: USER_ID, userCode: '11286524' }
      },
      res
    );
    return res;
  };

  test('accepts a realistic price 0.5% below market', async () => {
    const res = await placeLimit(pairFixture.markPrice * 0.995);
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe(true);
  });

  test('accepts a realistic price 0.5% above market', async () => {
    // ROUNDED TO THE QUOTE'S PRECISION BEFORE IT IS SENT, because the raw
    // product is not a price this pair can express: 63500 * 1.005 is
    // 63817.49999999999 in binary floating point, i.e. eleven decimals on a
    // pair with two, and limitOrderPlace now refuses those outright (see
    // tests/unit/order-precision.test.js, and PRICE IS REFUSED, SIZE IS
    // QUANTISED in spot.controller.js). What this test is about is the price
    // BAND, and 63817.50 is inside it.
    const res = await placeLimit(
      Number((pairFixture.markPrice * 1.005).toFixed(pairFixture.secondFloatDigit)),
      'sell'
    );
    expect(res.statusCode).toBe(200);
  });

  test('band bounds follow the signed percentages (-90% .. +100%)', async () => {
    expect((await placeLimit(pairFixture.markPrice * 0.11)).statusCode).toBe(200);
    const tooLow = await placeLimit(pairFixture.markPrice * 0.05);
    expect(tooLow.statusCode).toBe(400);
    expect(tooLow.payload.message).toMatch(/must not be lesser/);
    const tooHigh = await placeLimit(pairFixture.markPrice * 2.5);
    expect(tooHigh.statusCode).toBe(400);
    expect(tooHigh.payload.message).toMatch(/must not be higher/);
  });

  test('does not throw the "Limit order match error" TDZ failure', async () => {
    const res = await placeLimit(pairFixture.markPrice * 0.995);
    expect(res.payload.message).not.toBe('Limit order match error');
  });

  test('records the balances around the debit on the resting order', async () => {
    await placeLimit(pairFixture.markPrice * 0.995);
    const resting = userOrders('buy')[0];
    expect(resting).toBeDefined();
    expect(resting.beforeBalance).toBe(10000);
    expect(resting.afterBalance).toBeCloseTo(10000 - resting.orderValue, 6);
  });

  test('a resting limit order below the bid does not fill', async () => {
    await placeLimit(pairFixture.markPrice * 0.995);
    await matchingcall(PAIR_ID);
    await flush();
    expect(userOrders('buy')).toHaveLength(1);
    expect(modelsMock.__trades).toHaveLength(0);
  });

  test('an aggressive limit buy fills AT THE ASK, not at its own price', async () => {
    await placeLimit(63600); // 100 above the 63500 ask
    await matchingcall(PAIR_ID);
    await flush();
    expect(modelsMock.__trades).toHaveLength(1);
    expect(modelsMock.__trades[0].tradePrice).toBe(63500);
    expect(modelsMock.__trades[0].isMaker).toBe('sell');
  });
});

describe('In-order ledger across place + cancel (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  const inOrderUsd = () =>
    balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`);

  test('a limit order reserves and then releases exactly its order value', async () => {
    const res = mockRes();
    await limitOrderPlace(
      {
        body: {
          orderType: 'limit',
          buyorsell: 'buy',
          spotPairId: PAIR_ID,
          price: 63000,
          quantity: 0.001
        },
        user: { id: USER_ID, userCode: '11286524' }
      },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(inOrderUsd()).toBeCloseTo(63, 6);

    const resting = userOrders('buy')[0];
    const cancelled = mockRes();
    await cancelOrder(
      {
        body: { id: { tableId: `buyOpenOrders_${PAIR_ID}`, orderId: resting._id } },
        user: { id: USER_ID }
      },
      cancelled
    );
    expect(cancelled.statusCode).toBe(200);
    expect(inOrderUsd()).toBe(0);
    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBeCloseTo(10000, 6);
  });

  test('cancelling a market order leaves the in-order ledger at zero', async () => {
    const res = mockRes();
    await marketOrderPlace(
      {
        body: {
          orderType: 'market',
          buyorsell: 'buy',
          spotPairId: PAIR_ID,
          orderValue: 200,
          quantity: 0
        },
        user: { id: USER_ID, userCode: '11286524' }
      },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(inOrderUsd()).toBe(0);

    const resting = userOrders('buy')[0];
    const cancelled = mockRes();
    await cancelOrder(
      {
        body: { id: { tableId: `buyOpenOrders_${PAIR_ID}`, orderId: resting._id } },
        user: { id: USER_ID }
      },
      cancelled
    );
    expect(cancelled.statusCode).toBe(200);
    // Was -orderValue before the fix: market orders never reserved in-order.
    expect(inOrderUsd()).toBe(0);
    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBeCloseTo(10000, 6);
  });
});
