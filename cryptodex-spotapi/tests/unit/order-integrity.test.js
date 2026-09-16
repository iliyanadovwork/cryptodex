/**
 * ORDER INTEGRITY REGRESSION TESTS (CRITICAL)
 *
 * Pins the three defects found by adversarial review of the paper book:
 *   1. cancelOrder had no ownership check and was not isPaper-gated, so any
 *      authenticated caller could cancel an ADMIN-OWNED synthetic ladder
 *      order, crediting walletbalance_spot from nothing and driving
 *      walletbalance_spot_inOrder negative.
 *   2. The in-order ledger must never go negative: market orders and paper
 *      liquidity never reserve, so no fill or cancel of theirs may release.
 *   3. averagePrice is a CUMULATIVE FILLED NOTIONAL. Every consumer renders
 *      averagePrice / filledQuantity, so a seeded price corrupted it.
 *   4. Every cancel path was a read-modify-delete that MOVED MONEY between the
 *      read and the delete, with nothing making it exclusive. N concurrent
 *      cancels of one order all saw it still present, all passed the (entirely
 *      stateless) ownership / isPaper / side checks, and all refunded - one
 *      reservation paid out N times. The refund is now gated on an atomic
 *      claim (hgetdel), so it can happen at most once per order.
 */


import { describe, test, expect, beforeEach } from '@jest/globals';

// ---- I/O mocks. Plain functions (not jest.fn) so jest's resetMocks between
// ---- tests cannot strip the behaviour these flows depend on.

jest.mock('node-cron', () => ({ schedule: () => ({ stop: () => {} }) }));

jest.mock('../../models/index.js', () => {
  const trades = [];
  const savedOrders = [];
  return {
    __esModule: true,
    __trades: trades,
    __savedOrders: savedOrders,
    SpotPair: {
      find: async () => [],
      findOne: async () => null,
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
    // Real HGETDEL/Lua semantics: read+delete as ONE step, so of N callers
    // exactly one gets the value back. Node is single threaded, so an `async`
    // body with no await inside is genuinely indivisible here, exactly as the
    // Lua script is on the server.
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

jest.mock('../../grpc/walletService.js', () => {
  // The passbook is the audit trail of every balance move, so recording it lets
  // a test assert the refund was BOOKED once, not just that the arithmetic
  // happened to land on the right number.
  const entries = [];
  return {
    __esModule: true,
    __passbook: entries,
    getUserAsset: async () => {},
    updateUserWallet: async () => true,
    updateUserAsset: async () => {},
    passbook: (entry) => {
      entries.push(entry);
    }
  };
});

jest.mock('../../grpc/adminService.js', () => ({
  __esModule: true,
  saveAdminprofit: () => {}
}));

import { syncPaperBook } from '../../controllers/paperBook.controller.js';
import {
  matchingcall,
  limitOrderPlace,
  marketOrderPlace,
  cancelOrder,
  cancelMarketOrder,
  releaseInOrder,
  OPEN_ORDER_TABLE,
} from '../../controllers/spot.controller.js';
import * as redisMock from '../../controllers/redis.controller.js';
import * as wsMock from '../../lib/binanceWebSocket.js';
import * as modelsMock from '../../models/index.js';
import * as walletMock from '../../grpc/walletService.js';

const PAIR_ID = '695bf1017573eeb15a749c9d';
const USD_ID = '695bf0e2b9aba016fb8ce3c4';
const BTC_ID = '695bf0e2b9aba016fb8ce3c1';
const USER_ID = '6a70f1c287c92c7218ac37fc';
const OTHER_ID = '6a70fe409c46d957cd45ba3a';
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
const paperOrders = (side) => openOrders(side).filter((o) => o.isPaper);
const inOrderLedger = () => {
  const map = redisMock.__hashes.get('walletbalance_spot_inOrder');
  return map ? Array.from(map.entries()) : [];
};
const expectNoNegativeInOrder = () => {
  for (const [field, value] of inOrderLedger()) {
    if (parseFloat(value) < 0) {
      throw new Error(`in-order ledger went negative: ${field} = ${value}`);
    }
  }
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

const seed = async ({ usd = 300000, btc = 5 } = {}) => {
  redisMock.__reset();
  modelsMock.__trades.length = 0;
  modelsMock.__savedOrders.length = 0;
  walletMock.__passbook.length = 0;
  await redisMock.hset('spotPairdata', PAIR_ID, pairFixture);
  await redisMock.hset('admin_liquidity', 'liquidation', adminLiq);
  for (const id of [USER_ID, OTHER_ID]) {
    await redisMock.hincbyfloat('walletbalance_spot', `${id}_${USD_ID}`, usd);
    await redisMock.hincbyfloat('walletbalance_spot', `${id}_${BTC_ID}`, btc);
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${id}_${USD_ID}`, 0);
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${id}_${BTC_ID}`, 0);
  }
  // The admin liquidity account owns the synthetic ladder but holds no coin.
  await redisMock.hincbyfloat('walletbalance_spot', `${ADMIN_ID}_${BTC_ID}`, 0);
  await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${ADMIN_ID}_${BTC_ID}`, 0);
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

// tradeMatching breaks out of its loop after a single limit trade, so a
// multi-level limit fill needs one tick per level. Drop the level that was just
// consumed so the next tick prices off the next one, exactly as a real book
// would after its top level was lifted.
const advanceBookOneLevel = () => {
  wsMock.__state.book.asks.shift();
  wsMock.__state.book.bids.shift();
  wsMock.__state.book.updatedAt = Date.now();
};

const placeLimit = async (user, buyorsell, price, quantity) => {
  const res = mockRes();
  await limitOrderPlace(
    {
      body: { orderType: 'limit', buyorsell, spotPairId: PAIR_ID, price, quantity },
      user: { id: user, userCode: '11286524' }
    },
    res
  );
  return res;
};

const placeMarket = async (user, buyorsell, body) => {
  const res = mockRes();
  await marketOrderPlace(
    {
      body: { orderType: 'market', buyorsell, spotPairId: PAIR_ID, ...body },
      user: { id: user, userCode: '11286524' }
    },
    res
  );
  return res;
};

const cancel = async (user, tableId, orderId) => {
  const res = mockRes();
  await cancelOrder(
    { body: { id: { tableId, orderId } }, user: { id: user } },
    res
  );
  return res;
};

// ===========================================================================
// DEFECT 1 - cancelOrder ownership / paper gating
// ===========================================================================

describe('cancelOrder authorisation (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  test('refuses to cancel an ADMIN-OWNED paper ladder order and creates no balance', async () => {
    await syncPaperBook(pairFixture);
    const ladder = paperOrders('sell');
    expect(ladder.length).toBeGreaterThan(0);
    const target = ladder[0];
    expect(target.userId).toBe(ADMIN_ID);

    const adminBtcBefore = balance('walletbalance_spot', `${ADMIN_ID}_${BTC_ID}`);

    const res = await cancel(USER_ID, `sellOpenOrders_${PAIR_ID}`, target._id);

    expect(res.statusCode).toBe(400);
    expect(res.payload.status).toBe(false);
    // No balance conjured, no ledger damage, order still resting.
    expect(balance('walletbalance_spot', `${ADMIN_ID}_${BTC_ID}`)).toBe(adminBtcBefore);
    expect(balance('walletbalance_spot_inOrder', `${ADMIN_ID}_${BTC_ID}`)).toBe(0);
    expect(paperOrders('sell').some((o) => o._id === target._id)).toBe(true);
    expectNoNegativeInOrder();
  });

  test('refuses to cancel ANOTHER USER\'s resting limit order', async () => {
    expect((await placeLimit(OTHER_ID, 'buy', 63000, 0.001)).statusCode).toBe(200);
    const victim = userOrders('buy')[0];
    expect(victim.userId).toBe(OTHER_ID);

    const usdBefore = balance('walletbalance_spot', `${OTHER_ID}_${USD_ID}`);
    const inOrderBefore = balance('walletbalance_spot_inOrder', `${OTHER_ID}_${USD_ID}`);
    expect(inOrderBefore).toBeCloseTo(63, 6);

    const res = await cancel(USER_ID, `buyOpenOrders_${PAIR_ID}`, victim._id);

    expect(res.statusCode).toBe(400);
    expect(res.payload.message).toBe('Order not found');
    expect(balance('walletbalance_spot', `${OTHER_ID}_${USD_ID}`)).toBe(usdBefore);
    expect(balance('walletbalance_spot_inOrder', `${OTHER_ID}_${USD_ID}`)).toBeCloseTo(63, 6);
    expect(userOrders('buy')).toHaveLength(1);
    expectNoNegativeInOrder();
  });

  test('still lets the OWNER cancel their own order', async () => {
    expect((await placeLimit(USER_ID, 'buy', 63000, 0.001)).statusCode).toBe(200);
    const own = userOrders('buy')[0];
    const res = await cancel(USER_ID, `buyOpenOrders_${PAIR_ID}`, own._id);
    expect(res.statusCode).toBe(200);
    expect(userOrders('buy')).toHaveLength(0);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBe(0);
    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBeCloseTo(300000, 6);
  });

  test('rejects a tableId that is not an open-order hash (no double refund of history)', async () => {
    expect((await placeLimit(USER_ID, 'buy', 63000, 0.001)).statusCode).toBe(200);
    const own = userOrders('buy')[0];
    expect((await cancel(USER_ID, `buyOpenOrders_${PAIR_ID}`, own._id)).statusCode).toBe(200);
    const usdAfterCancel = balance('walletbalance_spot', `${USER_ID}_${USD_ID}`);

    // The cancelled order now lives in orderHistory_<userId>. Naming that hash
    // as the tableId must not refund it a second time.
    const replay = await cancel(USER_ID, `orderHistory_${USER_ID}`, own._id);
    expect(replay.statusCode).toBe(400);
    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBe(usdAfterCancel);
    expectNoNegativeInOrder();
  });

  test('rejects a side/table mismatch', async () => {
    expect((await placeLimit(USER_ID, 'buy', 63000, 0.001)).statusCode).toBe(200);
    const own = userOrders('buy')[0];
    // Plant the buy order under the sell hash: the refund currency would flip.
    await redisMock.hset(`sellOpenOrders_${PAIR_ID}`, own._id, own);
    const res = await cancel(USER_ID, `sellOpenOrders_${PAIR_ID}`, own._id);
    expect(res.statusCode).toBe(400);
    expect(balance('walletbalance_spot', `${USER_ID}_${BTC_ID}`)).toBe(5);
  });

  test('OPEN_ORDER_TABLE only admits the two open-order hashes', () => {
    expect(OPEN_ORDER_TABLE.test(`buyOpenOrders_${PAIR_ID}`)).toBe(true);
    expect(OPEN_ORDER_TABLE.test(`sellOpenOrders_${PAIR_ID}`)).toBe(true);
    expect(OPEN_ORDER_TABLE.test(`orderHistory_${USER_ID}`)).toBe(false);
    expect(OPEN_ORDER_TABLE.test('walletbalance_spot')).toBe(false);
    expect(OPEN_ORDER_TABLE.test(`buyOpenOrders_${PAIR_ID}_x`)).toBe(false);
  });
});

// ===========================================================================
// DEFECT 2 - the in-order ledger invariant
// ===========================================================================

describe('in-order ledger invariant (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  test('releaseInOrder is a no-op for a MARKET order (it never reserved)', async () => {
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 500);
    const out = await releaseInOrder(
      { _id: 'm1', userId: USER_ID, flag: true },
      USD_ID,
      500
    );
    expect(out).toBe(null);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBe(500);
  });

  test('releaseInOrder is a no-op for PAPER liquidity (it was never debited)', async () => {
    const out = await releaseInOrder(
      { _id: 'p1', userId: ADMIN_ID, flag: false, isPaper: true },
      BTC_ID,
      0.5
    );
    expect(out).toBe(null);
    expect(balance('walletbalance_spot_inOrder', `${ADMIN_ID}_${BTC_ID}`)).toBe(0);
  });

  test('releaseInOrder clamps at zero and never goes negative', async () => {
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 10);
    await releaseInOrder({ _id: 'l1', userId: USER_ID, flag: false }, USD_ID, 999);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBe(0);
    await releaseInOrder({ _id: 'l1', userId: USER_ID, flag: false }, USD_ID, 999);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBe(0);
  });

  test('a PARTIALLY FILLED market buy (bigger than the top ladder level) leaves in-order non-negative', async () => {
    // Top ask level is 0.5 BTC @ 63500 = 31750 USD. 120000 USD has to walk
    // several levels, so the market order is reopened mid-flight at least once.
    const res = await placeMarket(USER_ID, 'buy', { orderValue: 120000, quantity: 0 });
    expect(res.statusCode).toBe(200);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBe(0);

    await matchingcall(PAIR_ID);
    await flush();

    // More than one fill really happened.
    expect(modelsMock.__trades.length).toBeGreaterThan(1);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBe(0);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`)).toBe(0);
    expect(balance('walletbalance_spot_inOrder', `${ADMIN_ID}_${BTC_ID}`)).toBe(0);
    expectNoNegativeInOrder();
  });

  test('a PARTIALLY FILLED market sell leaves in-order non-negative', async () => {
    // Top bid level is 0.5 BTC @ 63499; selling 2 BTC walks past it.
    const res = await placeMarket(USER_ID, 'sell', { amount: 2, quantity: 2 });
    expect(res.statusCode).toBe(200);

    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades.length).toBeGreaterThan(1);
    expectNoNegativeInOrder();
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`)).toBe(0);
  });

  test('a limit buy filled across TWO ticks releases exactly what each fill consumed', async () => {
    // 1.2 BTC @ 63600. tradeMatching breaks after one limit trade per tick, so
    // this takes two ticks: 0.5 @ 63500, then (book moved on) 0.7 @ 63501.
    expect((await placeLimit(USER_ID, 'buy', 63600, 1.2)).statusCode).toBe(200);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(
      63600 * 1.2,
      4
    );

    await matchingcall(PAIR_ID);
    await flush();
    // Half released, half still reserved: no more, no less.
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(
      63600 * 0.7,
      2
    );
    expectNoNegativeInOrder();

    advanceBookOneLevel();
    await matchingcall(PAIR_ID);
    await flush();

    expect(userOrders('buy')).toHaveLength(0);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(0, 4);
    expectNoNegativeInOrder();
  });

  test('a resting limit order that is only PARTLY filled keeps the unfilled reservation', async () => {
    // 0.8 BTC @ 63500 can only take the 0.5 top level; 0.3 stays reserved.
    expect((await placeLimit(USER_ID, 'buy', 63500, 0.8)).statusCode).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    const resting = userOrders('buy')[0];
    expect(resting).toBeDefined();
    expect(resting.filledQuantity).toBeCloseTo(0.5, 8);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(
      63500 * 0.3,
      2
    );
    expectNoNegativeInOrder();

    // Cancelling the remainder releases exactly the remainder, no more.
    expect((await cancel(USER_ID, `buyOpenOrders_${PAIR_ID}`, resting._id)).statusCode).toBe(200);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(0, 6);
    expectNoNegativeInOrder();
  });
});

// ===========================================================================
// DEFECT 3 - averagePrice is a cumulative filled notional
// ===========================================================================

// The exact expression the frontend renders
// (components/Spot/OrderHistory.tsx) and the admin report computes
// (report.controller.js execPrice).
const renderedAvgPrice = (order) => order.averagePrice / order.filledQuantity;

describe('averagePrice renders as the real execution price (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  const savedOrder = (id) => {
    const rows = modelsMock.__savedOrders.filter((r) => r.filter._id === id);
    return rows.length ? rows[rows.length - 1].update.$set : null;
  };

  test('a new limit order is seeded with a ZERO notional, not with its price', async () => {
    expect((await placeLimit(USER_ID, 'buy', 63000, 0.001)).statusCode).toBe(200);
    const resting = userOrders('buy')[0];
    expect(resting.averagePrice).toBe(0);
    // The "execute at markPrice" reference lives in its own field now.
    expect(resting.refPrice).toBe(63000);
  });

  test('a SINGLE-fill limit order renders at the real trade price', async () => {
    expect((await placeLimit(USER_ID, 'buy', 63600, 0.4)).statusCode).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades).toHaveLength(1);
    const trade = modelsMock.__trades[0];
    expect(trade.tradePrice).toBe(63500);

    const persisted = savedOrder(trade.buyOrderId || trade.buyorderId) ||
      modelsMock.__savedOrders
        .map((r) => r.update.$set)
        .filter((o) => o && o.userId === USER_ID && o.status === 'completed')
        .pop();
    expect(persisted).toBeTruthy();
    expect(persisted.filledQuantity).toBeCloseTo(0.4, 8);
    // THE BUG: this used to be 63600 + 63500*0.4 = 89000, rendering as 222500.
    expect(persisted.averagePrice).toBeCloseTo(63500 * 0.4, 4);
    expect(renderedAvgPrice(persisted)).toBeCloseTo(63500, 6);
  });

  test('a MULTI-fill limit order renders the volume-weighted average of its fills', async () => {
    // 0.5 @ 63500 then 0.7 @ 63501 -> VWAP 63500.5833...
    expect((await placeLimit(USER_ID, 'buy', 63600, 1.2)).statusCode).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();
    advanceBookOneLevel();
    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades.length).toBe(2);
    expect(modelsMock.__trades.map((t) => t.tradePrice)).toEqual([63500, 63501]);
    const completed = modelsMock.__savedOrders
      .map((r) => r.update.$set)
      .filter((o) => o && o.userId === USER_ID && o.status === 'completed')
      .pop();
    expect(completed).toBeTruthy();
    expect(completed.filledQuantity).toBeCloseTo(1.2, 8);

    const expectedNotional = 63500 * 0.5 + 63501 * 0.7;
    expect(completed.averagePrice).toBeCloseTo(expectedNotional, 2);
    expect(renderedAvgPrice(completed)).toBeCloseTo(expectedNotional / 1.2, 6);
    // Sanity: the rendered average sits between the two fill prices.
    expect(renderedAvgPrice(completed)).toBeGreaterThan(63500);
    expect(renderedAvgPrice(completed)).toBeLessThan(63501);
  });

  test('a filled MARKET buy still renders a sane average, and its notional drives the refund', async () => {
    const res = await placeMarket(USER_ID, 'buy', { orderValue: 20000, quantity: 0 });
    expect(res.statusCode).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    const completed = modelsMock.__savedOrders
      .map((r) => r.update.$set)
      .filter((o) => o && o.userId === USER_ID && o.orderType === 'market')
      .pop();
    expect(completed).toBeTruthy();
    expect(completed.filledQuantity).toBeGreaterThan(0);
    expect(renderedAvgPrice(completed)).toBeCloseTo(63500, 2);
  });

  test('the paper ladder itself carries a zero notional', async () => {
    await syncPaperBook(pairFixture);
    paperOrders('sell').forEach((o) => expect(o.averagePrice).toBe(0));
    paperOrders('buy').forEach((o) => expect(o.averagePrice).toBe(0));
  });
});

// ===========================================================================
// A settled trade must be readable through EVERY field that claims to hold it
// ===========================================================================

/**
 * tradeHistory carries the executed price and size twice, under two pairs of
 * names: tradePrice/tradeQty and execPrice/quantity. newTradeHistory only ever
 * wrote the first pair, so every row in the collection landed with the schema
 * defaults - execPrice: 0, quantity: 0 - and the readers of the second pair
 * (report.controller.js spotTradeUserHistory and the history export) rendered a
 * zero for the price and size of a real trade.
 */
describe('settled trades are written to every field the readers project', () => {
  beforeEach(async () => {
    await seed();
  });

  test('execPrice/quantity hold the execution, not the schema default of 0', async () => {
    expect((await placeLimit(USER_ID, 'buy', 63600, 0.4)).statusCode).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades).toHaveLength(1);
    const trade = modelsMock.__trades[0];

    expect(trade.tradePrice).toBe(63500);
    expect(trade.tradeQty).toBeCloseTo(0.4, 8);
    // THE DEFECT: these two used to be absent from the write entirely.
    expect(trade.execPrice).toBe(trade.tradePrice);
    expect(trade.quantity).toBe(trade.tradeQty);
    expect(trade.execPrice).toBeGreaterThan(0);
    expect(trade.quantity).toBeGreaterThan(0);
    // ...and the row is internally consistent, not merely non-zero: the
    // notional the same views total is the product of exactly these numbers.
    expect(trade.orderValue).toBeCloseTo(trade.execPrice * trade.quantity, 6);
  });

  test('a market order books the same way', async () => {
    expect(
      (await placeMarket(USER_ID, 'buy', { orderValue: 20000, quantity: 0 })).statusCode
    ).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades.length).toBeGreaterThan(0);
    for (const trade of modelsMock.__trades) {
      expect(trade.execPrice).toBe(trade.tradePrice);
      expect(trade.quantity).toBe(trade.tradeQty);
      expect(trade.execPrice).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// DEFECT 4 - the cancel refund must be EXACTLY ONCE
// ===========================================================================

/**
 * These are true concurrency tests, not sequential replays.
 *
 * Node is single threaded, so the interleaving that mattered in production is
 * reproduced exactly: every cancel runs up to its first `await` and yields, so
 * all N of them complete their pre-read before any of them reaches the write
 * that moves money. That is precisely the window the live reproduction used
 * (N HTTP requests landing on one event loop). Under the old
 * read -> refund -> delete order every one of them refunded; the only thing
 * that makes them exclusive now is that removing the order and reading it are
 * a single indivisible Redis step, and only the caller who gets a value back
 * is allowed to pay.
 */
describe('cancel is exactly-once (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  const CONCURRENCY = 8;

  test('N concurrent cancels of ONE resting limit BUY refund exactly one reservation', async () => {
    // 0.001 BTC @ 40000 = 40 USD reserved - the live reproduction's order.
    expect((await placeLimit(USER_ID, 'buy', 40000, 0.001)).statusCode).toBe(200);
    const resting = userOrders('buy')[0];
    expect(resting).toBeDefined();

    const usdAfterPlace = balance('walletbalance_spot', `${USER_ID}_${USD_ID}`);
    expect(usdAfterPlace).toBeCloseTo(300000 - 40, 6);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(40, 6);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        cancel(USER_ID, `buyOpenOrders_${PAIR_ID}`, resting._id)
      )
    );

    // Exactly one winner; every loser is told the order is gone and pays nothing.
    const ok = results.filter((r) => r.statusCode === 200);
    const denied = results.filter((r) => r.statusCode === 400);
    expect(ok).toHaveLength(1);
    expect(denied).toHaveLength(CONCURRENCY - 1);
    denied.forEach((r) => expect(r.payload.message).toBe('Order not found'));

    // THE MONEY. One reservation back, not eight: the old code landed on
    // 300000 + 40*7 here.
    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBeCloseTo(300000, 6);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(0, 8);
    expect(userOrders('buy')).toHaveLength(0);
    expectNoNegativeInOrder();
  });

  test('N concurrent cancels of ONE resting limit SELL return exactly one reservation in the BASE coin', async () => {
    expect((await placeLimit(USER_ID, 'sell', 90000, 0.5)).statusCode).toBe(200);
    const resting = userOrders('sell')[0];
    expect(resting).toBeDefined();
    expect(balance('walletbalance_spot', `${USER_ID}_${BTC_ID}`)).toBeCloseTo(4.5, 8);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`)).toBeCloseTo(0.5, 8);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        cancel(USER_ID, `sellOpenOrders_${PAIR_ID}`, resting._id)
      )
    );

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    // 5 BTC exactly - not 5 + 0.5*7.
    expect(balance('walletbalance_spot', `${USER_ID}_${BTC_ID}`)).toBeCloseTo(5, 8);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`)).toBeCloseTo(0, 8);
    expect(userOrders('sell')).toHaveLength(0);
    expectNoNegativeInOrder();
  });

  test('the refund is booked to the passbook exactly once', async () => {
    expect((await placeLimit(USER_ID, 'buy', 40000, 0.001)).statusCode).toBe(200);
    const resting = userOrders('buy')[0];

    await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        cancel(USER_ID, `buyOpenOrders_${PAIR_ID}`, resting._id)
      )
    );

    const credits = walletMock.__passbook.filter(
      (entry) => entry.type === 'order_Cancel' && String(entry.tableId) === String(resting._id)
    );
    expect(credits).toHaveLength(1);
    expect(parseFloat(credits[0].amount)).toBeCloseTo(40, 6);
  });

  test('concurrent cancels of MANY distinct orders each refund once (the claim is per order)', async () => {
    const ids = [];
    for (const price of [40000, 41000, 42000, 43000]) {
      expect((await placeLimit(USER_ID, 'buy', price, 0.001)).statusCode).toBe(200);
    }
    userOrders('buy').forEach((o) => ids.push(o._id));
    expect(ids).toHaveLength(4);
    const reserved = 0.001 * (40000 + 41000 + 42000 + 43000);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(reserved, 6);

    // Two cancels per order, all in flight together.
    const results = await Promise.all(
      ids.flatMap((id) => [
        cancel(USER_ID, `buyOpenOrders_${PAIR_ID}`, id),
        cancel(USER_ID, `buyOpenOrders_${PAIR_ID}`, id)
      ])
    );

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(4);
    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBeCloseTo(300000, 6);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(0, 8);
    expect(userOrders('buy')).toHaveLength(0);
  });

  test('a PARTIALLY FILLED order cancelled concurrently refunds only the UNFILLED remainder, once', async () => {
    // 0.8 @ 63500 takes the 0.5 top ask; 0.3 keeps resting, 63500*0.3 reserved.
    expect((await placeLimit(USER_ID, 'buy', 63500, 0.8)).statusCode).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    const resting = userOrders('buy')[0];
    expect(resting).toBeDefined();
    expect(resting.filledQuantity).toBeCloseTo(0.5, 8);
    const usdBefore = balance('walletbalance_spot', `${USER_ID}_${USD_ID}`);
    const remainder = 63500 * 0.3;
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(remainder, 2);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        cancel(USER_ID, `buyOpenOrders_${PAIR_ID}`, resting._id)
      )
    );

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBeCloseTo(
      usdBefore + remainder,
      2
    );
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(0, 6);
    expectNoNegativeInOrder();
  });

  test('N concurrent cancelMarketOrder calls refund the market order value exactly once', async () => {
    const usdBefore = balance('walletbalance_spot', `${USER_ID}_${USD_ID}`);
    expect((await placeMarket(USER_ID, 'buy', { orderValue: 20000, quantity: 0 })).statusCode).toBe(
      200
    );
    const resting = userOrders('buy')[0];
    expect(resting).toBeDefined();
    expect(resting.price).toBe('market');
    const usdAfterPlace = balance('walletbalance_spot', `${USER_ID}_${USD_ID}`);
    expect(usdAfterPlace).toBeLessThan(usdBefore);

    // The matcher fires these without awaiting, from several branches at once.
    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        cancelMarketOrder(`buyOpenOrders_${PAIR_ID}`, resting._id)
      )
    );
    outcomes.forEach((o) => expect(o).toBe(true));

    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBeCloseTo(usdBefore, 6);
    expect(userOrders('buy')).toHaveLength(0);
    expectNoNegativeInOrder();
  });

  test('a cancel racing a FILL yields exactly one outcome, over many attempts', async () => {
    // 0.4 BTC @ 63600 sits fully inside the 0.5 top ask, so the matcher either
    // fills the whole thing or the cancel takes the whole thing - a partial is
    // impossible, which makes "exactly one outcome" a sharp assertion.
    for (let attempt = 0; attempt < 8; attempt++) {
      await seed();
      expect((await placeLimit(USER_ID, 'buy', 63600, 0.4)).statusCode).toBe(200);
      const resting = userOrders('buy')[0];

      const [, cancelRes] = await Promise.all([
        matchingcall(PAIR_ID),
        cancel(USER_ID, `buyOpenOrders_${PAIR_ID}`, resting._id)
      ]);
      await flush();

      const cancelled = cancelRes.statusCode === 200;
      const filled = modelsMock.__trades.length > 0;

      // Never both, never neither.
      expect(cancelled !== filled).toBe(true);

      const usd = balance('walletbalance_spot', `${USER_ID}_${USD_ID}`);
      const btc = balance('walletbalance_spot', `${USER_ID}_${BTC_ID}`);
      if (cancelled) {
        // Reservation returned once, nothing bought.
        expect(usd).toBeCloseTo(300000, 4);
        expect(btc).toBeCloseTo(5, 8);
      } else {
        // Paid for the fill and kept nothing back; the refund never happened.
        expect(usd).toBeLessThan(300000);
        expect(usd).toBeGreaterThan(300000 - 63600 * 0.4 - 1);
        expect(btc).toBeGreaterThan(5);
      }
      // Whichever way it went, the order is gone and nothing stays reserved.
      expect(userOrders('buy')).toHaveLength(0);
      expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(0, 4);
      expectNoNegativeInOrder();
    }
  });
});
