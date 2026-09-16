/**
 * PASSBOOK + ORDER-ROW INTEGRITY REGRESSION TESTS (CRITICAL)
 *
 * Pins three defects found by live inspection of the running stack:
 *
 *   1. NaN PASSBOOK ROWS. tradeMatching/marketMatching read the counterparty
 *      balance with parseFloat(HGET(...)) for the passbook `beforeBalance`. A
 *      walletbalance_spot field only EXISTS once something has written it, and
 *      the paper ladder`s admin account is only ever moved by HINCRBYFLOAT
 *      (which creates a missing field from 0). So the FIRST fill in each coin
 *      read null -> NaN -> walletapi rejected the row -> the audit record for a
 *      balance move that really happened was silently lost. /tmp/wallet-api.log
 *      showed exactly four such losses: one per coin, all on the admin account.
 *
 *   2. UNRESOLVABLE PAPER ORDER ROWS. A partially filled synthetic was
 *      persisted with status "pending", but the ladder is REPLACED wholesale
 *      from live depth every cycle, so that row could never be resolved by
 *      anything - one permanent "pending" order per partial fill.
 *
 *   3. getFilledOrder read SpotOrder (collection `spotOrder`), which the paper
 *      matcher never writes: the endpoint returned 0 rows for every user.
 */




import { describe, test, expect, beforeEach } from '@jest/globals';

// ---- I/O mocks. Plain functions (not jest.fn) so jest's resetMocks between
// ---- tests cannot strip the behaviour these flows depend on.

jest.mock('node-cron', () => ({ schedule: () => ({ stop: () => {} }) }));

jest.mock('../../models/index.js', () => {
  const trades = [];
  const savedOrders = [];
  const historyQueries = [];
  const historyRows = [];
  return {
    __esModule: true,
    __trades: trades,
    __savedOrders: savedOrders,
    __historyQueries: historyQueries,
    __historyRows: historyRows,
    SpotPair: {
      find: async () => [],
      findOne: async () => null,
      updateOne: () => ({ exec: async () => {} })
    },
    // The `spotOrder` collection this maps to is never written by the paper
    // matcher: any read of it is the defect this file pins.
    SpotOrder: {
      countDocuments: async () => {
        throw new Error('getFilledOrder must not read SpotOrder (`spotOrder` is empty)');
      },
      aggregate: async () => {
        throw new Error('getFilledOrder must not read SpotOrder (`spotOrder` is empty)');
      }
    },
    // The collection the matcher REALLY writes fills to (`orderHistory`).
    //
    // This used to be TWO keys - `SpotOrder` and `spotOrderHistory` - which the
    // barrel exported as two names for ONE model. Merged here, because they were
    // always the same object: as two keys in one literal the second silently
    // overwrote the first, so whichever methods came last were the only ones the
    // mock actually had.
    OrderHistory: {
      findOneAndUpdate: (filter, update) => {
        savedOrders.push({ filter, update });
        return { exec: () => ({ then: (cb) => { cb(); return { catch: () => {} }; } }) };
      },
      countDocuments: async (filter) => {
        historyQueries.push({ op: 'countDocuments', filter });
        return historyRows.length;
      },
      aggregate: async (pipeline) => {
        historyQueries.push({ op: 'aggregate', pipeline });
        return historyRows;
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
  marketOrderPlace,
  limitOrderPlace,
  readSpotBalanceNumber,
  orderHistoryStatus,
  newOrderHistory,
  getFilledOrder,
} from '../../controllers/spot.controller.js';
import * as redisMock from '../../controllers/redis.controller.js';
import * as wsMock from '../../lib/binanceWebSocket.js';
import * as modelsMock from '../../models/index.js';
import * as walletMock from '../../grpc/walletService.js';

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

/**
 * Seed WITHOUT touching the admin account.
 *
 * This is the whole point: the admin owns the paper ladder but has never held a
 * balance, so neither `<admin>_<BTC>` nor `<admin>_<USD>` exists in
 * walletbalance_spot when the first fill against it settles. That is the state
 * the live NaN rows were produced from.
 */
const seed = async () => {
  redisMock.__reset();
  modelsMock.__trades.length = 0;
  modelsMock.__savedOrders.length = 0;
  modelsMock.__historyQueries.length = 0;
  modelsMock.__historyRows.length = 0;
  walletMock.__passbook.length = 0;
  await redisMock.hset('spotPairdata', PAIR_ID, pairFixture);
  await redisMock.hset('admin_liquidity', 'liquidation', adminLiq);
  await redisMock.hincbyfloat('walletbalance_spot', `${USER_ID}_${USD_ID}`, 300000);
  await redisMock.hincbyfloat('walletbalance_spot', `${USER_ID}_${BTC_ID}`, 5);
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

const NUMERIC_FIELDS = ['beforeBalance', 'afterBalance', 'amount'];

/** Every passbook row must be storable: walletapi will not accept a NaN. */
const expectEveryPassbookRowNumeric = () => {
  for (const entry of walletMock.__passbook) {
    for (const field of NUMERIC_FIELDS) {
      const value = parseFloat(entry[field]);
      if (!Number.isFinite(value)) {
        throw new Error(
          `passbook row would be DROPPED by walletapi: ${field}=${entry[field]} ` +
          `(userId=${entry.userId} coin=${entry.coin} type=${entry.type})`
        );
      }
    }
  }
};

const paperOrders = (side) => {
  const map = redisMock.__hashes.get(`${side}OpenOrders_${PAIR_ID}`);
  if (!map) return [];
  return Array.from(map.values()).map((v) => JSON.parse(v)).filter((o) => o.isPaper);
};

const savedStatuses = (userId) =>
  modelsMock.__savedOrders
    .filter((row) => String(row.update.$set.userId) === userId)
    .map((row) => row.update.$set.status);

// ===========================================================================
// DEFECT 1 - NaN passbook rows on a first-touch balance field
// ===========================================================================

describe('passbook numeric integrity (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  test('readSpotBalanceNumber treats a field that does not exist yet as 0, never NaN', async () => {
    const missing = await readSpotBalanceNumber(ADMIN_ID, USD_ID);
    expect(missing).toBe(0);
    expect(Number.isFinite(missing)).toBe(true);
  });

  test('readSpotBalanceNumber returns the stored number when the field exists', async () => {
    expect(await readSpotBalanceNumber(USER_ID, USD_ID)).toBe(300000);
  });

  test('readSpotBalanceNumber degrades an unparseable field to 0 rather than NaN', async () => {
    const map = redisMock.__hashes.get('walletbalance_spot');
    map.set(`${USER_ID}_${BTC_ID}`, 'not-a-number');
    expect(await readSpotBalanceNumber(USER_ID, BTC_ID)).toBe(0);
  });

  test('a MARKET BUY against the ladder books every passbook row with real numbers', async () => {
    // The synthetic counterparty has no walletbalance_spot field at all, and
    // after this fill it still must not have one - see the synthetic-ledger
    // block below and settlementCredit in spot.controller.js.
    expect(await redisMock.hget('walletbalance_spot', `${ADMIN_ID}_${USD_ID}`)).toBe(null);

    // The ladder has to be resting BEFORE the order is placed, exactly as it is
    // in production (syncPaperBook runs at the top of every 2s matchingcall).
    // marketOrderPlace now refuses a market order into a pair with no ladder -
    // see lib/orderGate.js - so a test that placed one first would be asserting
    // against the gate rather than against the fill it means to exercise.
    await syncPaperBook(pairFixture);

    const res = await placeMarket(USER_ID, 'buy', { orderValue: 31000, quantity: 0 });
    expect(res.statusCode).toBe(200);

    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades.length).toBeGreaterThan(0);
    expect(walletMock.__passbook.length).toBeGreaterThan(0);
    expectEveryPassbookRowNumeric();

    // The USER really was one of the credited parties - the rows this case
    // exists to measure have to actually be there.
    const userRows = walletMock.__passbook.filter((e) => e.userId === USER_ID);
    expect(userRows.length).toBeGreaterThan(0);
    for (const row of userRows) {
      expect(Number.isFinite(parseFloat(row.beforeBalance))).toBe(true);
      expect(Number.isFinite(parseFloat(row.afterBalance))).toBe(true);
    }
  });

  test('a MARKET SELL against the ladder books every passbook row with real numbers', async () => {
    expect(await redisMock.hget('walletbalance_spot', `${ADMIN_ID}_${BTC_ID}`)).toBe(null);

    // Ladder first - see the market-buy case above.
    await syncPaperBook(pairFixture);

    const res = await placeMarket(USER_ID, 'sell', { amount: 0.4, quantity: 0.4 });
    expect(res.statusCode).toBe(200);

    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades.length).toBeGreaterThan(0);
    expectEveryPassbookRowNumeric();
  });

  test('a LIMIT fill against the ladder books every passbook row with real numbers', async () => {
    expect((await placeLimit(USER_ID, 'buy', 63600, 0.3)).statusCode).toBe(200);

    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades.length).toBeGreaterThan(0);
    expectEveryPassbookRowNumeric();
  });

  test('the beforeBalance booked for a first-touch USER account is 0 - what HINCRBYFLOAT assumed', async () => {
    // A first-touch field is the shape that used to reach the passbook as NaN:
    // HGET returns null and parseFloat(null) is NaN, which walletapi's schema
    // rejects, losing the whole audit row. The user has never held BTC here, so
    // the credit leg of this fill is exactly that case.
    await syncPaperBook(pairFixture);
    const map = redisMock.__hashes.get('walletbalance_spot');
    map.delete(`${USER_ID}_${BTC_ID}`);
    expect(await redisMock.hget('walletbalance_spot', `${USER_ID}_${BTC_ID}`)).toBe(null);

    expect((await placeMarket(USER_ID, 'buy', { orderValue: 31000, quantity: 0 })).statusCode).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    const firstUserRow = walletMock.__passbook.find(
      (e) => e.userId === USER_ID && e.type.endsWith('_match')
    );
    expect(firstUserRow).toBeDefined();
    expect(parseFloat(firstUserRow.beforeBalance)).toBe(0);
    // afterBalance = 0 + the credited amount, i.e. the row is internally consistent.
    expect(parseFloat(firstUserRow.afterBalance)).toBeCloseTo(
      parseFloat(firstUserRow.amount),
      8
    );
  });
});

// ===========================================================================
// DEFECT 2 - paper ladder rows that can never leave "pending"
// ===========================================================================

describe('paper ladder order rows reach a terminal status (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  test('orderHistoryStatus rewrites ONLY a pending paper order', () => {
    expect(orderHistoryStatus({ isPaper: true, status: 'pending' })).toBe('cancel');
    expect(orderHistoryStatus({ isPaper: true, status: 'completed' })).toBe('completed');
    expect(orderHistoryStatus({ isPaper: true, status: 'open' })).toBe('open');
    // A real user's partially filled order is genuinely still resting.
    expect(orderHistoryStatus({ isPaper: false, status: 'pending' })).toBe('pending');
    expect(orderHistoryStatus({ status: 'pending' })).toBe('pending');
  });

  test('newOrderHistory never persists a paper order as pending', async () => {
    await newOrderHistory({
      _id: 'synthetic-1',
      userId: ADMIN_ID,
      pairId: PAIR_ID,
      isPaper: true,
      status: 'pending',
      orderCode: 7,
      orderType: 'limit',
      price: 63500,
      quantity: 0.2
    });
    expect(modelsMock.__savedOrders).toHaveLength(1);
    expect(modelsMock.__savedOrders[0].update.$set.status).toBe('cancel');
  });

  test('a PARTIALLY consumed ladder level leaves no permanently pending admin row', async () => {
    // 31000 USD lifts most of the 0.5 BTC top ask level but not all of it, so
    // the synthetic is left partially filled - the case that used to persist a
    // "pending" row nothing could ever resolve.
    const res = await placeMarket(USER_ID, 'buy', { orderValue: 31000, quantity: 0 });
    expect(res.statusCode).toBe(200);

    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__savedOrders.length).toBeGreaterThan(0);
    expect(savedStatuses(ADMIN_ID)).not.toContain('pending');

    // The ladder is rebuilt wholesale on the next cycle, which is exactly why a
    // "pending" synthetic row could never be resolved.
    const before = paperOrders('sell').map((o) => o._id);
    await syncPaperBook(pairFixture);
    const after = paperOrders('sell').map((o) => o._id);
    expect(before.some((id) => after.includes(id))).toBe(false);
  });

  test("a real user's partially filled order is still recorded as pending", async () => {
    // 1.2 BTC at 63600 walks past the 0.5 BTC top ask: the USER's own order is
    // genuinely still resting afterwards and must keep saying so.
    expect((await placeLimit(USER_ID, 'buy', 63600, 1.2)).statusCode).toBe(200);

    await matchingcall(PAIR_ID);
    await flush();

    expect(savedStatuses(USER_ID)).toContain('pending');
  });
});

// ===========================================================================
// DEFECT 3 - getFilledOrder read a collection nothing writes
// ===========================================================================

describe('getFilledOrder reads the collection fills are actually in', () => {
  beforeEach(async () => {
    await seed();
  });

  test('queries OrderHistory (`orderHistory`), never SpotOrder (`spotOrder`)', async () => {
    const res = mockRes();
    // SpotOrder throws if touched (see the models mock).
    await getFilledOrder(
      { params: { pairId: PAIR_ID }, query: {}, user: { id: USER_ID } },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload.success).toBe(true);
    expect(modelsMock.__historyQueries.map((q) => q.op)).toEqual([
      'countDocuments',
      'aggregate'
    ]);
  });

  test('scopes both the count and the page to this user, this pair, completed only', async () => {
    const res = mockRes();
    await getFilledOrder(
      { params: { pairId: PAIR_ID }, query: {}, user: { id: USER_ID } },
      res
    );

    const count = modelsMock.__historyQueries.find((q) => q.op === 'countDocuments');
    expect(String(count.filter.userId)).toBe(USER_ID);
    expect(String(count.filter.pairId)).toBe(PAIR_ID);
    expect(count.filter.status).toBe('completed');

    const agg = modelsMock.__historyQueries.find((q) => q.op === 'aggregate');
    const match = agg.pipeline.find((stage) => stage.$match).$match;
    expect(String(match.userId)).toBe(USER_ID);
    expect(String(match.pairId)).toBe(PAIR_ID);
    expect(match.status).toBe('completed');
  });

  test('returns the rows the fills collection holds', async () => {
    modelsMock.__historyRows.push(
      { orderDate: '2026-08-04 06:17', buyorsell: 'buy', filledQuantity: 0.4 },
      { orderDate: '2026-08-04 06:18', buyorsell: 'sell', filledQuantity: 0.1 }
    );
    const res = mockRes();
    await getFilledOrder(
      { params: { pairId: PAIR_ID }, query: {}, user: { id: USER_ID } },
      res
    );
    expect(res.payload.result.data).toHaveLength(2);
    expect(res.payload.result.count).toBe(2);
  });
});
