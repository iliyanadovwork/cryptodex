/**
 * THE PER-FILL AUDIT TRAIL IS APPEND-ONLY (DATA-INTEGRITY REGRESSION)
 * ===================================================================
 *
 * THE DEFECT THIS EXISTS TO EXCLUDE
 * ---------------------------------
 * A position-keeping engine on this stack used to re-price its whole fill
 * history on every new fill: it pushed the new lot onto the position's
 * `filled` array and then rewrote EVERY lot with
 *
 *     price: <the position's new truncated VWAP>
 *
 * so after a second fill the position no longer contained a record of what the
 * FIRST fill executed at. The audit trail is destroyed by the act of adding to
 * the position: 1 BTC at 60,000 then 1 at 70,000 leaves two lots that both
 * claim 65,000, and there is nothing left on the document from which the real
 * two prices could be recovered.
 *
 * The question these tests answer is whether SPOT does the same thing to any
 * per-fill record IT keeps. It keeps two:
 *
 *   1. `spotOrder.filled[]` - the per-fill lots on the order-history document
 *      (models/spotTrade.js filledSchema: price, filledQuantity, Fees, Type,
 *      isMaker, createdAt, and the two order ids).
 *   2. `tradehistory` rows - one immutable document per execution, carrying
 *      `execPrice` / `tradePrice`.
 *
 * IT DOES NOT. Spot appends and never rewrites, and these pin that so a future
 * "let's show the average on every lot" change cannot quietly reintroduce that
 * defect:
 *
 *   - `newOrderHistory` - the function that persists the order-history row on
 *     EVERY fill - must not write `filled` at all. It $sets a fixed field list,
 *     and `filled` is not on it, so lots already recorded survive untouched.
 *   - `averagePrice` (a cumulative filled NOTIONAL on the order document, see
 *     the invariant note in spot.controller.js) must never be written into a
 *     lot's `price`.
 *   - two fills at different prices must leave two trade-history rows at those
 *     two prices, not two rows at their average.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';

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


import {
  newOrderHistory,
  newTradeHistory,
} from '../../controllers/spot.controller.js';
import * as redisMock from '../../controllers/redis.controller.js';
import * as modelsMock from '../../models/index.js';

const PAIR_ID = '695bf1017573eeb15a749c9d';
const USD_ID = '695bf0e2b9aba016fb8ce3c4';
const BTC_ID = '695bf0e2b9aba016fb8ce3c1';
const BUYER_ID = '6a70f1c287c92c7218ac37fc';
const SELLER_ID = '6a70fe409c46d957cd45ba3a';

beforeEach(() => {
  redisMock.__reset();
  modelsMock.__trades.length = 0;
  modelsMock.__savedOrders.length = 0;
});

const orderFixture = (overrides = {}) => ({
  _id: '6a70f1c287c92c7218ac3801',
  orderCode: 12345,
  userId: BUYER_ID,
  userCode: '1000001',
  pairId: PAIR_ID,
  pairName: 'BTC/USD',
  firstCurrencyId: BTC_ID,
  firstCurrency: 'BTC',
  firstFloatDigit: 8,
  secondCurrencyId: USD_ID,
  secondCurrency: 'USD',
  secondFloatDigit: 2,
  makerFee: 0.02,
  takerFee: 0.1,
  orderType: 'limit',
  buyorsell: 'buy',
  price: 60000,
  quantity: 2,
  orderValue: 130000,
  openQuantity: 0,
  filledQuantity: 2,
  // A CUMULATIVE FILLED NOTIONAL, not a price: 1*60000 + 1*70000.
  averagePrice: 130000,
  openOrderValue: 130000,
  status: 'completed',
  orderDate: new Date('2026-08-07T00:00:00.000Z'),
  liquidityType: 'off',
  ...overrides
});

/** Two fills at two genuinely different prices, exactly as the matcher writes them. */
const twoLots = () => [
  {
    pairId: PAIR_ID,
    userId: BUYER_ID,
    buyUserId: BUYER_ID,
    sellUserId: SELLER_ID,
    uniqueId: 'fill-1',
    price: 60000,
    filledQuantity: 1,
    orderValue: 60000,
    Type: 'buy',
    Fees: 12,
    isMaker: true,
    createdAt: new Date('2026-08-07T00:00:01.000Z')
  },
  {
    pairId: PAIR_ID,
    userId: BUYER_ID,
    buyUserId: BUYER_ID,
    sellUserId: SELLER_ID,
    uniqueId: 'fill-2',
    price: 70000,
    filledQuantity: 1,
    orderValue: 70000,
    Type: 'buy',
    Fees: 70,
    isMaker: false,
    createdAt: new Date('2026-08-07T00:00:02.000Z')
  }
];

describe('spotOrder.filled[] is append-only', () => {
  test('newOrderHistory does not write `filled` at all, so lots already recorded cannot be re-priced', async () => {
    await newOrderHistory(orderFixture({ filled: twoLots() }));

    expect(modelsMock.__savedOrders).toHaveLength(1);
    const { update } = modelsMock.__savedOrders[0];
    expect(Object.keys(update.$set)).not.toContain('filled');
    expect(update.$push).toBeUndefined();
    // Nothing else in the update may reach the array either.
    expect(JSON.stringify(update)).not.toContain('"filled"');
  });

  test('the cumulative averagePrice is carried as averagePrice and is never written as a price', async () => {
    const order = orderFixture({ filled: twoLots() });
    await newOrderHistory(order);

    const { update } = modelsMock.__savedOrders[0];
    expect(update.$set.averagePrice).toBe(130000);
    // 130000 is a NOTIONAL. If it ever appears as the order's `price` the
    // invariant documented in spot.controller.js has been broken.
    expect(update.$set.price).toBe(60000);
  });

  test('running it again after a second fill still leaves the lots alone - the rewrite would be here if it existed anywhere', async () => {
    const order = orderFixture({ filled: twoLots() });
    await newOrderHistory(order);
    order.filledQuantity = 2;
    order.averagePrice = 130000;
    await newOrderHistory(order);

    expect(modelsMock.__savedOrders).toHaveLength(2);
    for (const saved of modelsMock.__savedOrders) {
      expect(Object.keys(saved.update.$set)).not.toContain('filled');
    }
    // The caller's own array is not mutated either.
    expect(order.filled.map((l) => l.price)).toEqual([60000, 70000]);
  });

  test('the only writes to filled[] in the whole controller are $push and a fresh array on a NEW document', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'controllers', 'spot.controller.js'),
      'utf8'
    );
    // Any assignment INTO the array - `filled[i].price = ...`, `.filled =
    // somethingDerivedFromAnAverage`, a `$set: { filled: ... }` - is that
    // defect arriving here.
    expect(src).not.toMatch(/\.filled\s*=\s*/);
    expect(src).not.toMatch(/\$set\s*:\s*\{[^}]*\bfilled\b/);
    expect(src).not.toMatch(/filled\[\s*\w+\s*\]\s*\.\s*\w+\s*=/);
  });
});

describe('tradehistory rows keep their own execution price', () => {
  const fill = (execPrice, uniqueId) =>
    newTradeHistory({
      buyOrderData: {
        _id: '6a70f1c287c92c7218ac3801',
        userId: BUYER_ID,
        userCode: '1000001',
        pairId: PAIR_ID,
        firstCurrency: 'BTC',
        secondCurrency: 'USD',
        firstCurrencyId: BTC_ID,
        secondCurrencyId: USD_ID,
        orderType: 'limit',
        price: 70000
      },
      sellOrderData: {
        _id: '6a70f1c287c92c7218ac3802',
        userId: SELLER_ID,
        userCode: '1000002',
        pairId: PAIR_ID,
        firstCurrency: 'BTC',
        secondCurrency: 'USD',
        firstCurrencyId: BTC_ID,
        secondCurrencyId: USD_ID,
        orderType: 'limit',
        price: execPrice
      },
      uniqueId,
      execPrice,
      Maker: 'ask',
      buyerFee: 0.0002,
      sellerFee: 12,
      execQuantity: 1,
      ordertype: 'Limit',
      buyerFeeCurrency: 'BTC',
      buyerFeeCurrencyId: BTC_ID,
      buyerOrgFee: 0.0002,
      buyerFeeExcRate: 1,
      sellerFeeCurrency: 'USD',
      sellerFeeCurrencyId: USD_ID,
      sellerOrgFee: 12,
      sellerFeeExcRate: 1
    });

  test('two fills at two prices produce two rows at those two prices, not two rows at their average', async () => {
    await fill(60000, 'fill-1');
    await fill(70000, 'fill-2');

    expect(modelsMock.__trades).toHaveLength(2);
    expect(modelsMock.__trades.map((t) => t.execPrice)).toEqual([60000, 70000]);
    expect(modelsMock.__trades.map((t) => t.tradePrice)).toEqual([60000, 70000]);
    // 65000 is the average. It must appear nowhere.
    expect(modelsMock.__trades.map((t) => t.execPrice)).not.toContain(65000);
  });

  test('each fill is its own redis row, keyed by its own uniqueId - the second does not overwrite the first', async () => {
    await fill(60000, 'fill-1');
    await fill(70000, 'fill-2');

    const rows = redisMock.__hashes.get('tradeHistory_' + PAIR_ID);
    expect(rows.size).toBe(2);
    expect(JSON.parse(rows.get('fill-1')).execPrice).toBe(60000);
    expect(JSON.parse(rows.get('fill-2')).execPrice).toBe(70000);
  });

  test('the row records the notional of ITS OWN fill', async () => {
    await fill(60000, 'fill-1');
    expect(modelsMock.__trades[0].orderValue).toBe(60000);
  });
});
