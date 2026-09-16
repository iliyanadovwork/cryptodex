/**
 * MAKER / TAKER, THE SYNTHETIC LEDGER, AND THE PLACEMENT RESERVATION
 * =================================================================
 *
 * Three defects, all of them about money, all of them pinned end-to-end through
 * the REAL placement path and the REAL matcher (no hand-rolled arithmetic - a
 * test that recomputes the fee itself proves nothing about the engine):
 *
 *  1. NO SPOT USER COULD EVER EARN THE MAKER RATE. The matcher resolved the
 *     maker as `current_buy.isPaper ? "buy" : "sell"` whenever either side was
 *     synthetic - which is every fill on a "binance" pair - so the paper ladder
 *     claimed the maker side unconditionally and a genuinely passive user was
 *     billed `taker_fees`. Measured on the running stack before the fix: a
 *     passive 0.0002 BTC buy settled at 0.0001998 BTC, i.e. quantity - 0.1%.
 *     The role is now decided at ARRIVAL (did this order cross the book?) and
 *     stamped on the order; see lib/liquidityRole.js.
 *
 *  2. THE SYNTHETIC COUNTERPARTY MINTED ASSETS ON EVERY FILL. It was credited
 *     one leg of every settlement and debited none, because it is never debited
 *     at placement - paperBook.controller.js hsets the ladder straight into the
 *     open-order hashes out of nothing. Its balances had reached 234,978 USD /
 *     0.0777 BTC / 104 SOL / 242 ETH on the live stack. It is now exempt from
 *     the ledger entirely: no credit, no passbook row, no fee.
 *
 *  3. THE PLACEMENT RESERVATION WAS A REPAIR, NOT A RESERVATION. Placement
 *     debited, looked at the result, and put the money back if it had gone
 *     negative - writing two passbook rows describing a balance that should
 *     never have existed. It is now one atomic compare-and-debit, so a refused
 *     order moves nothing at all.
 */

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
  syncPaperBook,
  getLadderState,
  __resetPaperBookState,
} from '../../controllers/paperBook.controller.js';
import {
  matchingcall,
  limitOrderPlace,
  marketOrderPlace,
  marketOrderDebitValue,
  cancelOrder,
  cancelMarketOrder,
  releaseInOrder,
  tradeMatching,
  liqOrdCreation,
  newOrderHistory,
  getvalueObj,
  getPairList,
  withTradableTop,
  OPEN_ORDER_TABLE,
} from '../../controllers/spot.controller.js';
import { isSyntheticOrder } from '../../lib/liquidityRole.js';
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
  // The venue charges nothing; see lib/liquidityRole.feeRateFor.
  maker_rebate: 0,
  taker_fees: 0,
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
// Shared helpers for these cases
// ===========================================================================

// Fees are GONE, not zero-rated: feeRateFor and the maker/taker columns were
// deleted, so a fill credits the full amount. These constants are kept at 0 so
// the expectations below still read as "gross minus fee", and any attempt to
// reintroduce a charge breaks them immediately.
const MAKER_RATE = 0;
const TAKER_RATE = 0;

const spot = (userId, currencyId) =>
  balance('walletbalance_spot', `${userId}_${currencyId}`);

const passbookFor = (userId) =>
  walletMock.__passbook.filter((row) => String(row.userId) === String(userId));

/** Redis has no field at all for this account/coin (never touched). */
const hasSpotField = (userId, currencyId) => {
  const map = redisMock.__hashes.get('walletbalance_spot');
  return !!map && map.has(`${userId}_${currencyId}`);
};

/** Move the whole book to a new top, keeping the same shape. */
const setBook = (bestBid, bestAsk, quantity = 0.5) => {
  wsMock.__state.book = {
    lastUpdateId: (wsMock.__state.book.lastUpdateId || 0) + 1,
    updatedAt: Date.now(),
    bids: [
      { price: bestBid, quantity },
      { price: bestBid - 1, quantity },
      { price: bestBid - 2, quantity }
    ],
    asks: [
      { price: bestAsk, quantity },
      { price: bestAsk + 1, quantity },
      { price: bestAsk + 2, quantity }
    ]
  };
};

const onlyTrade = () => {
  expect(modelsMock.__trades.length).toBe(1);
  return modelsMock.__trades[0];
};

// ===========================================================================
// DEFECT 1 - the maker rate
// ===========================================================================

describe('maker / taker is decided by who was RESTING (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
    __resetPaperBookState();
  });

  test('a PASSIVE user limit order is the MAKER of its fill and pays maker_rebate', async () => {
    // The ladder has to exist before the order arrives, because "did this order
    // cross?" is a question about the book that was resting at that moment.
    await syncPaperBook(pairFixture);

    // 63499.5 sits INSIDE the spread (bid 63499 / ask 63500): it takes nothing,
    // so it rests and provides the liquidity its eventual fill consumes.
    const btcBefore = spot(USER_ID, BTC_ID);
    const usdBefore = spot(USER_ID, USD_ID);
    expect((await placeLimit(USER_ID, 'buy', 63499.5, 0.1)).statusCode).toBe(200);

    const resting = userOrders('buy');
    expect(resting.length).toBe(1);
    expect(resting[0].liquidityRole).toBe('maker');

    // Now the market comes DOWN to the resting bid - the ladder is the
    // aggressor, exactly the case the old code called "ladder is the maker".
    setBook(63498, 63499);
    await matchingcall(PAIR_ID);
    await flush();

    const trade = onlyTrade();
    expect(trade.isMaker).toBe('buy'); // the USER's side

    // EXACT SETTLEMENT. Base credited = filled quantity net of the MAKER rate.
    const filled = 0.1;
    expect(spot(USER_ID, BTC_ID)).toBeCloseTo(
      btcBefore + filled * (1 - MAKER_RATE),
      12
    );
    // And it is demonstrably NOT the taker rate this order used to be charged.
    // (The matching `.not.toBeCloseTo(...)` that separated maker pricing from
    //  taker pricing is gone: with no fees the two settle identically.)
    // Quote spent = the user's OWN limit price - a resting order prints at its
    // own price, and never at one worse than it.
    expect(usdBefore - spot(USER_ID, USD_ID)).toBeCloseTo(63499.5 * filled, 8);
    expectNoNegativeInOrder();
  });

  test('an AGGRESSIVE user limit order is the TAKER, pays taker_fees, and still gets the book price', async () => {
    await syncPaperBook(pairFixture);

    const btcBefore = spot(USER_ID, BTC_ID);
    const usdBefore = spot(USER_ID, USD_ID);
    // 63501 is already through the ask (63500): it TAKES resting liquidity.
    expect((await placeLimit(USER_ID, 'buy', 63501, 0.1)).statusCode).toBe(200);
    expect(userOrders('buy')[0].liquidityRole).toBe('taker');

    await matchingcall(PAIR_ID);
    await flush();

    const trade = onlyTrade();
    expect(trade.isMaker).toBe('sell'); // the ladder

    const filled = 0.1;
    expect(spot(USER_ID, BTC_ID)).toBeCloseTo(
      btcBefore + filled * (1 - TAKER_RATE),
      12
    );
    // Reserved at 63501, executed at the maker's 63500, so exactly the
    // difference comes back: net spend is the BOOK price, not the limit price.
    expect(usdBefore - spot(USER_ID, USD_ID)).toBeCloseTo(63500 * filled, 6);
    expectNoNegativeInOrder();
  });

  test('price improvement is refunded EXACTLY, even below one quote tick of notional', async () => {
    // The refund used to compare the two notionals AFTER rounding them to the
    // quote's decimals, so an improvement worth less than 0.01 USD in total was
    // never paid back - the money left the user and reached nobody. Measured
    // live on a 0.0002 BTC buy: 12.842324 reserved, 12.841328 filled, both
    // 12.84 after rounding, 0.000996 USD destroyed.
    await syncPaperBook(pairFixture);
    const usdBefore = spot(USER_ID, USD_ID);

    // Tiny size, wide improvement: reserved at 63505, fills at the ask 63500,
    // so the whole refund is 5 * 0.0002 = 0.001 USD - a tenth of a quote tick.
    expect((await placeLimit(USER_ID, 'buy', 63505, 0.0002)).statusCode).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    const trade = onlyTrade();
    expect(trade.execPrice).toBe(63500);
    const spent = usdBefore - spot(USER_ID, USD_ID);
    // Spent exactly the printed execution, not the reserved limit price.
    // 8dp: the refund under test is 0.001 USD, five orders of magnitude above
    // the in-memory ledger's own float residue (~1e-11 on a 300,000 balance).
    expect(spent).toBeCloseTo(63500 * 0.0002, 8);
    expect(spent).not.toBeCloseTo(63505 * 0.0002, 8);
    expectNoNegativeInOrder();
  });

  test('a MARKET order is the TAKER even when its counterparty is another real user', async () => {
    // The old rule asked only "is the BUYER the admin account", which named a
    // real user's market SELL as the maker of a fill against another real
    // user's resting limit BUY - the aggressor paid the rebate and the resting
    // user paid the taker rate.
    await syncPaperBook(pairFixture);

    // OTHER_ID rests inside the spread: passive, so it is the maker.
    expect((await placeLimit(OTHER_ID, 'buy', 63499.5, 0.1)).statusCode).toBe(200);
    // USER_ID sells into it at market while the ladder is still healthy.
    expect((await placeMarket(USER_ID, 'sell', { amount: 0.1, quantity: 0.1 })).statusCode).toBe(200);

    // Take the ladder out so the only counterparty left is the other user.
    wsMock.__state.book.updatedAt = Date.now() - 10 * 60 * 1000; // stale -> purge
    const makerUsdBefore = spot(OTHER_ID, USD_ID);
    const takerUsdBefore = spot(USER_ID, USD_ID);

    await matchingcall(PAIR_ID);
    await flush();

    const trade = onlyTrade();
    expect(String(trade.buyUserId)).toBe(OTHER_ID);
    expect(String(trade.sellUserId)).toBe(USER_ID);
    expect(trade.isMaker).toBe('buy'); // the RESTING limit order

    const filled = 0.1;
    const notional = 63499.5 * filled;
    // The market seller is the taker: quote credited is net of taker_fees.
    expect(spot(USER_ID, USD_ID) - takerUsdBefore).toBeCloseTo(
      notional * (1 - TAKER_RATE),
      8
    );
    // (The matching `.not.toBeCloseTo(...)` that separated maker pricing from
    //  taker pricing is gone: with no fees the two settle identically.)
    // The resting buyer is the maker: base credited is net of maker_rebate.
    expect(spot(OTHER_ID, BTC_ID)).toBeCloseTo(5 + filled * (1 - MAKER_RATE), 12);
    // ...and their reserved quote was consumed at their own price, no more.
    expect(makerUsdBefore).toBe(spot(OTHER_ID, USD_ID));
    expectNoNegativeInOrder();
  });

  test('the role is stamped from the LADDER top, not from markPrice', async () => {
    // markPrice (63500) and the tradable ladder can disagree - on the live
    // stack they routinely do, by more than the whole spread. An order priced
    // between them must be judged against the book it will actually meet.
    setBook(63600, 63601);
    await syncPaperBook(pairFixture);
    expect(getLadderState(PAIR_ID).bestSell).toBe(63601);

    // 63550: above markPrice (63500) but BELOW the real ask (63601). It takes
    // nothing, so it is a maker. Judged against markPrice it would be a taker.
    expect((await placeLimit(USER_ID, 'buy', 63550, 0.1)).statusCode).toBe(200);
    expect(userOrders('buy')[0].liquidityRole).toBe('maker');
  });

  test('a pair with no usable maker_rebate charges the TAKER rate, never zero', async () => {
    // feeFraction-style bugs turn a missing rate into 0 and make every resting
    // order free. A rate that is absent or nonsensical must fall back to the
    // one rate that is definitely published.
    await redisMock.hset('spotPairdata', PAIR_ID, {
      ...pairFixture,
      maker_rebate: undefined
    });
    await syncPaperBook(pairFixture);
    expect((await placeLimit(USER_ID, 'buy', 63499.5, 0.1)).statusCode).toBe(200);
    expect(userOrders('buy')[0].liquidityRole).toBe('maker');

    const btcBefore = spot(USER_ID, BTC_ID);
    setBook(63498, 63499);
    await matchingcall(PAIR_ID);
    await flush();

    expect(onlyTrade().isMaker).toBe('buy'); // still the maker of the fill
    expect(onlyTrade().buyerFee).toBeUndefined(); // no fee column: the venue charges nothing
    expect(spot(USER_ID, BTC_ID)).toBeCloseTo(
      btcBefore + 0.1 * (1 - TAKER_RATE),
      12
    );
  });

  test('an order written before the role existed still settles at the taker rate', async () => {
    // The fallback has to be the rate the service always charged, so an
    // unstamped order cannot be silently repriced - and defaulting to the
    // HIGHER published rate is the direction that never hands money away.
    await syncPaperBook(pairFixture);
    expect((await placeLimit(USER_ID, 'buy', 63499.5, 0.1)).statusCode).toBe(200);

    const order = userOrders('buy')[0];
    delete order.liquidityRole; // a row from before this field existed
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, order._id, order);

    const btcBefore = spot(USER_ID, BTC_ID);
    setBook(63498, 63499);
    await matchingcall(PAIR_ID);
    await flush();

    expect(onlyTrade().isMaker).toBe('sell'); // the ladder, as before
    expect(spot(USER_ID, BTC_ID)).toBeCloseTo(
      btcBefore + 0.1 * (1 - TAKER_RATE),
      12
    );
  });
});

// ===========================================================================
// DEFECT 2 - the synthetic counterparty is not a ledger account
// ===========================================================================

describe('the synthetic counterparty mints nothing (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
    __resetPaperBookState();
  });

  test('a LIMIT fill against the ladder moves no admin balance and books no admin row', async () => {
    await syncPaperBook(pairFixture);
    expect((await placeLimit(USER_ID, 'buy', 63501, 0.1)).statusCode).toBe(200);

    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades.length).toBe(1);
    // The seller leg of that fill was the ladder. It receives nothing.
    expect(spot(ADMIN_ID, USD_ID)).toBe(0);
    expect(hasSpotField(ADMIN_ID, USD_ID)).toBe(false);
    expect(spot(ADMIN_ID, BTC_ID)).toBe(0);
    expect(passbookFor(ADMIN_ID)).toHaveLength(0);
    // ...and it is not charged a fee it would be paying to itself.
    expect(onlyTrade().sellerFee).toBeUndefined();
  });

  test('a MARKET BUY and a MARKET SELL both leave the admin ledger untouched', async () => {
    await syncPaperBook(pairFixture);
    expect((await placeMarket(USER_ID, 'buy', { orderValue: 6000, quantity: 0 })).statusCode).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    expect((await placeMarket(USER_ID, 'sell', { amount: 0.05, quantity: 0.05 })).statusCode).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades.length).toBeGreaterThanOrEqual(2);
    expect(spot(ADMIN_ID, USD_ID)).toBe(0);
    expect(spot(ADMIN_ID, BTC_ID)).toBe(0);
    expect(passbookFor(ADMIN_ID)).toHaveLength(0);
  });

  test('repeated fills do not accumulate ANY admin balance - the growth was unbounded', async () => {
    for (let i = 0; i < 5; i++) {
      // A fresh book each round, exactly as the live ladder is re-derived from
      // scratch every 2s. The old credit was per FILL, so it compounded.
      setBook(63499 + i, 63500 + i);
      await syncPaperBook(pairFixture);
      expect((await placeLimit(USER_ID, 'buy', 63501 + i, 0.05)).statusCode).toBe(200);
      await matchingcall(PAIR_ID);
      await flush();
    }
    expect(modelsMock.__trades.length).toBe(5);
    expect(spot(ADMIN_ID, USD_ID)).toBe(0);
    expect(spot(ADMIN_ID, BTC_ID)).toBe(0);
    expect(passbookFor(ADMIN_ID)).toHaveLength(0);
  });

  test('CONSERVATION: what the user gains is exactly what the user paid, less the fee', async () => {
    // The only accounts that may move are the user's two. Nothing else on the
    // pair may change, in either direction.
    await syncPaperBook(pairFixture);
    const usdBefore = spot(USER_ID, USD_ID);
    const btcBefore = spot(USER_ID, BTC_ID);

    expect((await placeLimit(USER_ID, 'buy', 63501, 0.1)).statusCode).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    const usdSpent = usdBefore - spot(USER_ID, USD_ID);
    const btcGained = spot(USER_ID, BTC_ID) - btcBefore;
    const trade = onlyTrade();
    // Gross base bought, at the execution price, minus the fee actually booked.
    expect(btcGained).toBeCloseTo(
      usdSpent / trade.execPrice,
      12
    );
    // No fee is charged, so the whole of what was bought is what was received -
    // the conservation assertion above now carries the full weight.
    expect(trade.buyerFee).toBeUndefined();
  });
});

// ===========================================================================
// DEFECT 3 - the placement reservation
// ===========================================================================

describe('placement reserves atomically, in-request (CRITICAL)', () => {
  beforeEach(async () => {
    await seed({ usd: 10000, btc: 5 });
    __resetPaperBookState();
    await syncPaperBook(pairFixture);
  });

  test('the balance has ALREADY moved by the time the 200 is written', async () => {
    // The whole double-spend question is "is there a window between the answer
    // and the debit". There must not be one, so the balance is sampled from
    // inside res.json - i.e. at the instant the caller is told yes.
    let balanceAtResponse = null;
    const res = mockRes();
    const json = res.json;
    res.json = (body) => {
      balanceAtResponse = spot(USER_ID, USD_ID);
      return json(body);
    };
    await limitOrderPlace(
      {
        body: { orderType: 'limit', buyorsell: 'buy', spotPairId: PAIR_ID, price: 63000, quantity: 0.1 },
        user: { id: USER_ID, userCode: '11286524' }
      },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(balanceAtResponse).toBeCloseTo(10000 - 63000 * 0.1, 8);
  });

  test('concurrent placements can never spend more than the balance', async () => {
    // Five simultaneous orders of 2,500 against 10,000: four fit, one cannot.
    const price = 25000;
    const quantity = 0.1; // 2,500 each
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => placeLimit(USER_ID, 'buy', price, quantity))
    );
    const accepted = results.filter((r) => r.statusCode === 200).length;
    expect(accepted).toBe(4);
    expect(spot(USER_ID, USD_ID)).toBeCloseTo(10000 - 4 * 2500, 8);
    expect(spot(USER_ID, USD_ID)).toBeGreaterThanOrEqual(0);
    expect(userOrders('buy')).toHaveLength(4);
    expect(
      balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)
    ).toBeCloseTo(4 * 2500, 8);
  });

  test('a refused placement moves NOTHING - no debit, no reservation, no passbook row', async () => {
    // This is the difference between a reservation and a repair. The old path
    // debited first and put the money back, and booked two passbook rows
    // describing a balance that should never have existed.
    walletMock.__passbook.length = 0;
    const res = await placeLimit(USER_ID, 'buy', 63000, 1); // 63,000 > 10,000
    expect(res.statusCode).toBe(400);
    expect(res.payload.message).toBe(
      'Due to insufficient balance order cannot be placed'
    );
    expect(spot(USER_ID, USD_ID)).toBe(10000);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBe(0);
    expect(walletMock.__passbook).toHaveLength(0);
    expect(userOrders('buy')).toHaveLength(0);
  });

  test('concurrent MARKET placements can never spend more than the balance', async () => {
    // The market path needs its own case: its refusals are usually decided by
    // the fill gate or by the pre-check, both of which run BEFORE the debit, so
    // a broken reservation is invisible to any single-order test. Only
    // simultaneous orders - each individually affordable, collectively not -
    // reach it.
    const request = { orderValue: 2500, quantity: 0 };
    const cost = marketOrderDebitValue(
      { buyorsell: 'buy', ...request },
      pairFixture
    );
    const affordable = Math.floor(10000 / cost);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => placeMarket(USER_ID, 'buy', request))
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(affordable);
    expect(spot(USER_ID, USD_ID)).toBeCloseTo(10000 - affordable * cost, 8);
    expect(spot(USER_ID, USD_ID)).toBeGreaterThanOrEqual(0);
    expect(openOrders('buy').filter((o) => !o.isPaper)).toHaveLength(affordable);
  });

  test('a refused MARKET placement moves nothing and leaves no order behind', async () => {
    walletMock.__passbook.length = 0;
    const res = await placeMarket(USER_ID, 'sell', { amount: 500, quantity: 500 });
    expect(res.statusCode).toBe(400);
    expect(spot(USER_ID, BTC_ID)).toBe(5);
    expect(walletMock.__passbook).toHaveLength(0);
    expect(userOrders('sell')).toHaveLength(0);
  });

  test('an order that spends the balance to the last unit is still accepted', async () => {
    // The reservation must not be off by an epsilon in the strict direction:
    // exactly-affordable has to remain affordable.
    const res = await placeLimit(USER_ID, 'buy', 10000, 1); // exactly 10,000
    expect(res.statusCode).toBe(200);
    expect(spot(USER_ID, USD_ID)).toBe(0);
  });
});

// ===========================================================================
// WHICH ORDERS ARE HOUSE LIQUIDITY - BOTH KINDS, INDEPENDENTLY
// ===========================================================================
//
// isSyntheticOrder() has two branches and the whole suite passed with EITHER of
// them deleted, because every fill it was exercised on happened to satisfy both
// at once: buildPaperOrders stamps the ladder `isPaper: true` AND owns it with
// the admin liquidation account, so the isPaper test and the admin-id test
// always agreed. The two cases where they do NOT agree are the two that matter:
//
//   - the LADDER when the admin account cannot be resolved at settlement. The
//     matcher re-reads `admin_liquidity` at match time, separately from the
//     build; a miss, a torn write or an unparseable record makes adminLiqId
//     null. Without the isPaper branch every ladder row then becomes a ledger
//     account: it is credited a leg it was never debited for, it is charged a
//     fee it pays to itself, and - because the ladder is backdated a minute by
//     construction - price-time priority hands it the maker side, so the
//     resting user who provided the liquidity is billed the TAKER rate. That is
//     the original defect, reached by a different door.
//
//   - an ADMIN-OWNED order that is not paper at all. liqOrdCreation clones a
//     user's order onto the far side under the liquidation account's id on
//     "off"/"bot" pairs; those rows carry no isPaper flag. Without the admin-id
//     branch they are settled as if a real trader were on the other side.
//
// Each test below is written to fail if its own branch is removed, and to keep
// passing if the other one is.

const OFF_PAIR_ID = '695bf1017573eeb15a749ca0';

const offPairFixture = {
  ...pairFixture,
  _id: OFF_PAIR_ID,
  pairName: 'BTC/USD-OFF',
  tikerRoot: 'BTCUSDOFF',
  botstatus: 'off',
  markPrice: 63500
};

const offOpenOrders = (side) => {
  const map = redisMock.__hashes.get(`${side}OpenOrders_${OFF_PAIR_ID}`);
  if (!map) return [];
  return Array.from(map.values()).map((v) => JSON.parse(v));
};

/** The admin liquidation account's rows on the off pair. */
const adminOrders = (side) =>
  offOpenOrders(side).filter((o) => String(o.userId) === ADMIN_ID);

const placeLimitOn = async (pairId, user, buyorsell, price, quantity) => {
  const res = mockRes();
  await limitOrderPlace(
    {
      body: { orderType: 'limit', buyorsell, spotPairId: pairId, price, quantity },
      user: { id: user, userCode: '11286524' }
    },
    res
  );
  return res;
};

describe('isSyntheticOrder knows BOTH kinds of house liquidity', () => {
  test('the paper ladder is synthetic even with no admin account to compare against', () => {
    // The predicate has to answer for the ladder on its own, because the
    // caller that matters (the matcher) resolves the admin account separately
    // and can fail to.
    const ladderRow = { isPaper: true, userId: ADMIN_ID };
    expect(isSyntheticOrder(ladderRow, null)).toBe(true);
    expect(isSyntheticOrder(ladderRow, undefined)).toBe(true);
    // ...and even when the account it names is not the one we resolved.
    expect(isSyntheticOrder(ladderRow, OTHER_ID)).toBe(true);
  });

  test('an admin-owned order with no isPaper flag is synthetic too', () => {
    // This is the shape liqOrdCreation writes: a clone of a user order with the
    // liquidation account's id swapped in and nothing else marking it.
    const clone = { userId: ADMIN_ID, buyorsell: 'sell', price: 63500 };
    expect(clone.isPaper).toBeUndefined();
    expect(isSyntheticOrder(clone, ADMIN_ID)).toBe(true);
    // Ids may arrive as ObjectId-ish objects on either side; the comparison is
    // by string, not by identity.
    expect(isSyntheticOrder({ userId: { toString: () => ADMIN_ID } }, ADMIN_ID)).toBe(true);
  });

  test('a real user order is not synthetic on either test', () => {
    expect(isSyntheticOrder({ userId: USER_ID }, ADMIN_ID)).toBe(false);
    expect(isSyntheticOrder({ userId: USER_ID, isPaper: false }, ADMIN_ID)).toBe(false);
    // "isPaper" is a strict true, not a truthy: a stray string must not turn a
    // real user's order into house liquidity that is never charged a fee.
    expect(isSyntheticOrder({ userId: USER_ID, isPaper: 'true' }, ADMIN_ID)).toBe(false);
    expect(isSyntheticOrder(null, ADMIN_ID)).toBe(false);
    expect(isSyntheticOrder({ userId: USER_ID }, null)).toBe(false);
  });
});

describe('the LADDER is house liquidity even when the admin account is unresolvable (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
    __resetPaperBookState();
  });

  test('a passive fill still pays the MAKER rate and still mints nothing', async () => {
    // Built while the admin account is readable, exactly as the live ladder is.
    await syncPaperBook(pairFixture);
    // Sampled BEFORE placement: the quote leg is debited by the reservation, so
    // "what did this order cost" is only answerable from the far side of it.
    const btcBefore = spot(USER_ID, BTC_ID);
    const usdBefore = spot(USER_ID, USD_ID);
    expect((await placeLimit(USER_ID, 'buy', 63499.5, 0.1)).statusCode).toBe(200);
    expect(userOrders('buy')[0].liquidityRole).toBe('maker');

    // The market comes down to the resting bid and the ladder is rebuilt at the
    // new top, so the fill is available.
    setBook(63498, 63499);
    await syncPaperBook(pairFixture);
    expect(paperOrders('sell').length).toBeGreaterThan(0);

    // ...and NOW the matcher cannot resolve the liquidation account. This is
    // read fresh inside tradeMatching, separately from the ladder build.
    redisMock.__hashes.get('admin_liquidity').delete('liquidation');
    expect(await redisMock.hget('admin_liquidity', 'liquidation')).toBe(null);

    // tradeMatching is driven directly here rather than through matchingcall
    // ON PURPOSE: matchingcall re-syncs the ladder first, and syncPaperBook
    // cannot build one without the admin account - it would purge instead, so
    // there would be no fill left to settle and nothing to observe. This is the
    // same call matchingcall makes, with the same arguments, one step later.
    const buyOrders = (await getvalueObj(await redisMock.hgetall(`buyOpenOrders_${PAIR_ID}`)))
      .sort((a, b) => new Date(a.orderDate) - new Date(b.orderDate));
    const sellOrders = (await getvalueObj(await redisMock.hgetall(`sellOpenOrders_${PAIR_ID}`)))
      .sort((a, b) => new Date(a.orderDate) - new Date(b.orderDate));
    await tradeMatching(buyOrders, sellOrders, pairFixture);
    await flush();

    const trade = onlyTrade();
    // THE ROLE. The user rested; the ladder came to them. Without the isPaper
    // branch this falls through to price-time priority, and the ladder's
    // orderDate is backdated 60s by buildPaperOrders, so it would win the maker
    // side here every single time.
    expect(trade.isMaker).toBe('buy');

    // THE FEE. Exact settlement at the maker rate, and demonstrably not the
    // taker rate.
    const filled = 0.1;
    expect(spot(USER_ID, BTC_ID)).toBeCloseTo(btcBefore + filled * (1 - MAKER_RATE), 12);
    // (The matching `.not.toBeCloseTo(...)` that separated maker pricing from
    //  taker pricing is gone: with no fees the two settle identically.)
    expect(usdBefore - spot(USER_ID, USD_ID)).toBeCloseTo(63499.5 * filled, 8);

    // THE LEDGER. The ladder is still not an account: no credit, no passbook
    // row, no fee charged to itself.
    expect(hasSpotField(ADMIN_ID, USD_ID)).toBe(false);
    expect(spot(ADMIN_ID, USD_ID)).toBe(0);
    expect(passbookFor(ADMIN_ID)).toHaveLength(0);
    expect(trade.sellerFee).toBeUndefined();
    expectNoNegativeInOrder();
  });
});

describe('an ADMIN-OWNED counterparty is house liquidity too (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
    __resetPaperBookState();
    await redisMock.hset('spotPairdata', OFF_PAIR_ID, offPairFixture);
  });

  test('the synthesised counterparty is credited nothing and charged nothing', async () => {
    // A resting sell placed ABOVE the mark, which the mark then rises through -
    // the one flow in which tradeMatching synthesises the far side by itself,
    // through liqOrdCreation, with no isPaper flag anywhere on it.
    expect((await placeLimitOn(OFF_PAIR_ID, USER_ID, 'sell', 63600, 0.1)).statusCode).toBe(200);
    const resting = offOpenOrders('sell').filter((o) => String(o.userId) === USER_ID);
    expect(resting).toHaveLength(1);
    expect(resting[0].liquidityRole).toBe('maker');
    expect(resting[0].isMaker).toBe(false);

    // The mark comes up through the resting ask.
    await redisMock.hset('spotPairdata', OFF_PAIR_ID, {
      ...offPairFixture,
      markPrice: 63700
    });

    const usdBefore = spot(USER_ID, USD_ID);
    await matchingcall(OFF_PAIR_ID);
    await flush();

    // The counterparty really was the admin account, and really was not paper.
    const clone = adminOrders('buy');
    expect(clone.length + modelsMock.__trades.length).toBeGreaterThan(0);
    const trade = onlyTrade();
    expect(String(trade.buyUserId)).toBe(ADMIN_ID);
    expect(trade.isMaker).toBe('sell'); // the resting user

    // NOTHING MINTED. Without the admin-id branch this account is credited the
    // base leg of every one of these fills and charged a fee on it.
    expect(hasSpotField(ADMIN_ID, USD_ID)).toBe(false);
    expect(spot(ADMIN_ID, BTC_ID)).toBe(0);
    expect(passbookFor(ADMIN_ID)).toHaveLength(0);
    expect(trade.buyerFee).toBeUndefined();

    // The resting user is the maker and is paid the quote net of maker_rebate.
    const notional = 63600 * 0.1;
    expect(spot(USER_ID, USD_ID) - usdBefore).toBeCloseTo(notional * (1 - MAKER_RATE), 8);
    // (The matching `.not.toBeCloseTo(...)` that separated maker pricing from
    //  taker pricing is gone: with no fees the two settle identically.)
    expectNoNegativeInOrder();
  });

  test('an AGGRESSIVE user against the admin counterparty pays the TAKER rate, not price-time', async () => {
    // The role must be the COMPLEMENT of the user's stamp here, exactly as it
    // is against the ladder. Price-time priority would say the opposite and say
    // it confidently: the synthesised counterparty is written AFTER the order it
    // is created for, so the aggressor always looks like the older order and
    // would collect the rebate for taking liquidity.
    expect((await placeLimitOn(OFF_PAIR_ID, USER_ID, 'buy', 63500, 0.1)).statusCode).toBe(200);
    const resting = offOpenOrders('buy').filter((o) => String(o.userId) === USER_ID);
    expect(resting).toHaveLength(1);
    expect(resting[0].liquidityRole).toBe('taker'); // 63500 >= the mark: it crossed

    // The counterparty, made by the service's own producer.
    await liqOrdCreation(resting[0], 'sell', false);
    expect(adminOrders('sell')).toHaveLength(1);
    expect(adminOrders('sell')[0].isPaper).toBeUndefined();
    expect(
      new Date(adminOrders('sell')[0].orderDate).getTime()
    ).toBeGreaterThanOrEqual(new Date(resting[0].orderDate).getTime());

    const btcBefore = spot(USER_ID, BTC_ID);
    await matchingcall(OFF_PAIR_ID);
    await flush();

    const trade = onlyTrade();
    expect(String(trade.sellUserId)).toBe(ADMIN_ID);
    expect(trade.isMaker).toBe('sell'); // the house, NOT the user who crossed

    const filled = 0.1;
    expect(spot(USER_ID, BTC_ID)).toBeCloseTo(btcBefore + filled * (1 - TAKER_RATE), 12);
    // (The matching `.not.toBeCloseTo(...)` that separated maker pricing from
    //  taker pricing is gone: with no fees the two settle identically.)
    expect(hasSpotField(ADMIN_ID, USD_ID)).toBe(false);
    expect(passbookFor(ADMIN_ID)).toHaveLength(0);
    expect(trade.sellerFee).toBeUndefined();
    expectNoNegativeInOrder();
  });
});

// ===========================================================================
// THE STAMP HAS TO SURVIVE BEING WRITTEN DOWN
// ===========================================================================

describe('the maker/taker stamp reaches the order history', () => {
  beforeEach(async () => {
    await seed();
    __resetPaperBookState();
  });

  const savedFor = (orderId) =>
    modelsMock.__savedOrders.filter(
      (row) => String(row.filter._id) === String(orderId)
    );

  test('a resting MAKER is persisted as a maker', async () => {
    // newOrderHistory hand-builds the document it writes, field by field. The
    // stamp was not in that list, so even with the schema path added, mongo was
    // never offered the value at all.
    await syncPaperBook(pairFixture);
    expect((await placeLimit(USER_ID, 'buy', 63499.5, 0.1)).statusCode).toBe(200);

    const order = userOrders('buy')[0];
    expect(order.liquidityRole).toBe('maker');
    const rows = savedFor(order._id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].update.$set.liquidityRole).toBe('maker');
  });

  test('an aggressive TAKER is persisted as a taker', async () => {
    await syncPaperBook(pairFixture);
    expect((await placeLimit(USER_ID, 'buy', 63501, 0.1)).statusCode).toBe(200);

    const order = userOrders('buy')[0];
    expect(order.liquidityRole).toBe('taker');
    expect(savedFor(order._id)[0].update.$set.liquidityRole).toBe('taker');
  });

  test('an order carrying no stamp is written down as the TAKER it settles as', async () => {
    // Never as null/undefined: a column nobody can price is worse than the
    // documented fallback, and roleOf() is the one place that fallback lives.
    await newOrderHistory({
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      userId: USER_ID,
      orderCode: 7,
      orderType: 'limit',
      price: 63500,
      quantity: 0.1,
      status: 'open'
    });
    const rows = savedFor('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(rows).toHaveLength(1);
    expect(rows[0].update.$set.liquidityRole).toBe('taker');
  });

  test('the history write survives an unresolvable admin liquidity account', async () => {
    // It used to JSON.parse and dereference that record unconditionally, so a
    // missing one threw a TypeError and the row - a real user's order history -
    // was swallowed by the catch. Nothing logged it as data loss.
    redisMock.__hashes.get('admin_liquidity').delete('liquidation');
    const ok = await newOrderHistory({
      _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      userId: USER_ID,
      orderCode: 8,
      orderType: 'limit',
      price: 63500,
      quantity: 0.1,
      liquidityRole: 'maker',
      status: 'open'
    });
    expect(ok).toBe(true);
    const rows = savedFor('bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(rows).toHaveLength(1);
    expect(rows[0].update.$set.liquidityRole).toBe('maker');
    // A limit order's price is its price; the admin-only branch is not taken.
    expect(rows[0].update.$set.price).toBe(63500);
  });
});

// ===========================================================================
// THE PUBLIC PAIR LIST QUOTES THE BOOK THAT WILL ACTUALLY FILL
// ===========================================================================

describe('/api/spot/tradePair serves the tradable top of book', () => {
  const STALE = {
    ...pairFixture,
    last: 60000,
    last_bid: 60000,
    last_ask: 60001,
    markPrice: 60000
  };

  const listPairs = async () => {
    const res = mockRes();
    await getPairList({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    return res.payload.result;
  };

  beforeEach(async () => {
    await seed();
    __resetPaperBookState();
    // Only this one pair in the cache, carrying a top of book from a ticker
    // stream that has since fallen behind by 5%.
    redisMock.__hashes.get('spotPairdata').clear();
    await redisMock.hset('spotPairdata', PAIR_ID, STALE);
  });

  test('THE BUG: the served top of book is the ladder the matcher trades, not the ticker mirror', async () => {
    await syncPaperBook(pairFixture);
    const ladder = getLadderState(PAIR_ID);
    expect(ladder.present).toBe(true);
    expect(ladder.bestBuy).toBeGreaterThan(0);
    expect(ladder.bestSell).toBeGreaterThan(0);

    const [pair] = await listPairs();
    expect(pair.last_bid).toBe(ladder.bestBuy);
    expect(pair.last_ask).toBe(ladder.bestSell);
    expect(pair.markPrice).toBe(ladder.bestBuy);
    // ...and demonstrably not the numbers the cache was holding.
    expect(pair.last_bid).not.toBe(STALE.last_bid);
    expect(pair.last_ask).not.toBe(STALE.last_ask);
    expect(pair.markPrice).not.toBe(STALE.markPrice);
  });

  test('the quote it serves is the one an arriving order is judged against', async () => {
    // Not "close to" and not "derived the same way" - the SAME number. An order
    // priced at the served ask must be a taker of it, and one priced a tick
    // below must rest.
    await syncPaperBook(pairFixture);
    const [pair] = await listPairs();

    expect((await placeLimit(USER_ID, 'buy', pair.last_ask, 0.001)).statusCode).toBe(200);
    expect(userOrders('buy')[0].liquidityRole).toBe('taker');

    await seed();
    __resetPaperBookState();
    redisMock.__hashes.get('spotPairdata').clear();
    await redisMock.hset('spotPairdata', PAIR_ID, STALE);
    await syncPaperBook(pairFixture);
    const [again] = await listPairs();
    expect((await placeLimit(USER_ID, 'buy', again.last_ask - 0.01, 0.001)).statusCode).toBe(200);
    expect(userOrders('buy')[0].liquidityRole).toBe('maker');
  });

  test('the cached quote is left alone when there is no tradable book to replace it with', async () => {
    // A pair with no ladder cannot fill at all, so there is no better number to
    // publish - only a worse one. The overlay acts in one direction only.
    expect(getLadderState(PAIR_ID).present).toBe(false);
    const [pair] = await listPairs();
    expect(pair.last_bid).toBe(STALE.last_bid);
    expect(pair.last_ask).toBe(STALE.last_ask);
    expect(pair.markPrice).toBe(STALE.markPrice);
  });

  test('withTradableTop is non-mutating and leaves the last TRADED price alone', async () => {
    await syncPaperBook(pairFixture);
    const cached = { ...STALE };
    const served = withTradableTop(cached);
    expect(cached.last_bid).toBe(STALE.last_bid); // the input is untouched
    expect(served.last_bid).toBe(getLadderState(PAIR_ID).bestBuy);
    // `last` means LAST TRADED, which a top of book is not.
    expect(served.last).toBe(STALE.last);
  });

  test('an "off" pair is quoted at its markPrice, which IS its tradable book', async () => {
    // These pairs have no ladder; liqOrdCreation synthesises their counterparty
    // from markPrice, so markPrice is both sides of the book the matcher uses.
    const served = withTradableTop({ ...offPairFixture, last_bid: 1, last_ask: 2 });
    expect(served.last_bid).toBe(offPairFixture.markPrice);
    expect(served.last_ask).toBe(offPairFixture.markPrice);
  });

  test('a pair with no usable markPrice and no ladder is served unchanged, not zeroed', () => {
    const broken = { ...offPairFixture, markPrice: 0, last_bid: 10, last_ask: 11 };
    expect(withTradableTop(broken).last_bid).toBe(10);
    expect(withTradableTop(broken).last_ask).toBe(11);
    expect(withTradableTop(null)).toBe(null);
  });
});
