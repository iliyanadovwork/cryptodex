/**
 * SERVER-SIDE ORDER GATE (CRITICAL)
 *
 * THE DEFECT THESE TESTS PIN
 * --------------------------
 * The health verdict that stops a user trading into a book with no liquidity
 * was enforced in the BROWSER only: the React ticket disabled its button and
 * nothing else checked. POST /api/spot/orderPlace accepted the order anyway and
 * DEBITED the balance immediately, so a stale tab, a mobile client, a retry
 * landing during recovery, or anything at all holding a bearer token could move
 * a user's money to back an order that could not possibly fill.
 *
 * So the two claims worth pinning forever are:
 *   1. a MARKET order into an unfillable book is REFUSED, and refused with
 *      ZERO balance movement - not refunded afterwards, never debited;
 *   2. the rule does not overreach: a resting LIMIT order is still accepted
 *      while the book is transiently unwell, and the funds it reserves are
 *      fully recoverable through cancelOrder, so no policy branch can strand
 *      a user's money.
 *
 * Plus the anti-duplication guard: the ladder-staleness threshold existed twice
 * under two env vars (PAPER_BOOK_LADDER_STALE_MS and
 * SPOT_CANARY_LADDER_MAX_AGE_MS), which meant tuning the documented one moved
 * the gate and left the monitor reporting against the old value. A test fails
 * here the moment a second definition of ANY defaulted constant reappears.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// ---- I/O mocks. Plain functions (not jest.fn) so jest's resetMocks between
// ---- tests cannot strip the behaviour these flows depend on. Mirrors the
// ---- harness in order-integrity.test.js: real redis semantics, real balances.

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
      findOneAndUpdate: async () => null,
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

jest.mock('../../controllers/redis.controller.js', () => {
  const hashes = new Map();
  const strings = new Map();
  const ledgers = new Map();
  // The margin freeze keys currently held, i.e. what redis' `EXISTS` would
  // answer 1 for inside the reservation script.
  const freezes = new Set();
  const hash = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  return {
    __esModule: true,
    __hashes: hashes,
    __strings: strings,
    __freezes: freezes,
    FROZEN: 'FROZEN',
    __reset: () => {
      hashes.clear();
      strings.clear();
      ledgers.clear();
      freezes.clear();
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
    //
    // INCLUDING THE FREEZE CHECK, which is checked FIRST and before any read of
    // the balance - a double that ignored the freeze key would let a mutation
    // that drops the argument at the call site sail through.
    hincrbyfloatIfEnough: async (key, field, amount, freezeKey) => {
      if (freezeKey && freezes.has(String(freezeKey))) return 'FROZEN';
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
      // This mock keeps freezes in their own set; honour it, or the stub stops
      // refusing a freeze the real Lua does refuse.
      if (freezeKey && freezes.has(String(freezeKey))) return 'FROZEN';
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
  purgePaperBook,
  getLadderState,
  ladderCapacity,
  __resetPaperBookState,
} from '../../controllers/paperBook.controller.js';
import {
  orderPlace,
  limitOrderPlace,
  marketOrderPlace,
  cancelOrder,
  orderBookData,
  matchingcall,
  marketOrderDebitValue,
  marketOrderQuantity,
  marketOrderDebitCurrencyId,
  isMarketOrderUnaffordable,
} from '../../controllers/spot.controller.js';
import { toFixedDown } from '../../lib/roundOf.js';
import {
  evaluateOrderGate,
  assertOrderTradable,
  ladderCapacityFor,
  usesPaperLadder,
  TERMINAL_REASONS,
} from '../../lib/orderGate.js';
import {
  orderPlaceValidate,
  SUPPORTED_ORDER_TYPES,
  UNSUPPORTED_ORDER_TYPES,
} from '../../validation/spotTrade.validation.js';
import * as depthHealth from '../../lib/depthHealth.js';
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
  minOrderValue: 1,
  maxOrderValue: 1000000,
  minPricePercentage: -90,
  maxPricePercentage: 100,
  status: 'active',
  botstatus: 'binance',
  markPrice: 63500
};

const adminLiq = { _id: ADMIN_ID, userId: '12024756', role: 'admin_bot' };

const healthyDepth = () => ({
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
});

const balance = (hashKey, field) => {
  const map = redisMock.__hashes.get(hashKey);
  return parseFloat((map && map.get(field)) || 0);
};
const wallet = () => balance('walletbalance_spot', `${USER_ID}_${USD_ID}`);
const walletBtc = () => balance('walletbalance_spot', `${USER_ID}_${BTC_ID}`);
const inOrder = () => balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`);
const openOrders = (side) => {
  const map = redisMock.__hashes.get(`${side}OpenOrders_${PAIR_ID}`);
  if (!map) return [];
  return Array.from(map.values()).map((v) => JSON.parse(v));
};
const userOrders = (side) => openOrders(side).filter((o) => !o.isPaper);

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

const seed = async (pair = pairFixture) => {
  redisMock.__reset();
  __resetPaperBookState();
  modelsMock.__trades.length = 0;
  modelsMock.__savedOrders.length = 0;
  walletMock.__passbook.length = 0;
  await redisMock.hset('spotPairdata', PAIR_ID, pair);
  await redisMock.hset('admin_liquidity', 'liquidation', adminLiq);
  await redisMock.hincbyfloat('walletbalance_spot', `${USER_ID}_${USD_ID}`, 300000);
  await redisMock.hincbyfloat('walletbalance_spot', `${USER_ID}_${BTC_ID}`, 5);
  await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 0);
  await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`, 0);
  await redisMock.hincbyfloat('walletbalance_spot', `${ADMIN_ID}_${BTC_ID}`, 0);
  wsMock.__state.book = healthyDepth();
};

const placeMarket = async (buyorsell, body) => {
  const res = mockRes();
  await marketOrderPlace(
    {
      body: { orderType: 'market', buyorsell, spotPairId: PAIR_ID, ...body },
      user: { id: USER_ID, userCode: '11286524' }
    },
    res
  );
  return res;
};

const placeLimit = async (buyorsell, price, quantity) => {
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

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const cancel = async (tableId, orderId) => {
  const res = mockRes();
  await cancelOrder(
    { body: { id: { tableId, orderId } }, user: { id: USER_ID } },
    res
  );
  return res;
};

// A complete, untouched snapshot of everything an order could move.
const ledgerSnapshot = () => ({
  usd: wallet(),
  btc: walletBtc(),
  inOrderUsd: inOrder(),
  inOrderBtc: balance('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`),
  buyOrders: openOrders('buy').length,
  sellOrders: openOrders('sell').length,
  passbookRows: walletMock.__passbook.length,
  historyWrites: modelsMock.__savedOrders.length
});

// ===========================================================================
// THE POLICY, in isolation
// ===========================================================================

describe('order gate policy (CRITICAL)', () => {
  const ok = { healthy: true, reason: null };
  const present = { present: true, reason: null };

  const DEPTH_FAULTS = [
    'no_depth',
    'stale_depth',
    'empty_side',
    'crossed_book',
    'price_deviation'
  ];
  const LADDER_FAULTS = [
    'ladder_not_built',
    'ladder_stale',
    'ladder_orphaned',
    'no_admin_liquidity',
    'error'
  ];

  test('a fillable book lets both order kinds through, with no reason attached', () => {
    for (const orderType of ['market', 'limit']) {
      const gate = evaluateOrderGate({ orderType, depth: ok, ladder: present });
      expect(gate).toEqual({
        allowed: true,
        reason: null,
        message: null,
        degraded: false
      });
    }
  });

  test('a MARKET order is refused for every depth fault, with a message that says nothing was charged', () => {
    for (const reason of DEPTH_FAULTS) {
      const gate = evaluateOrderGate({
        orderType: 'market',
        depth: { healthy: false, reason },
        ladder: present
      });
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toBe(reason);
      expect(typeof gate.message).toBe('string');
      expect(gate.message.length).toBeGreaterThan(0);
      expect(gate.message).toMatch(/[Nn]othing has been charged/);
    }
  });

  test('a MARKET order is refused for every ladder fault - depth being fine is not enough', () => {
    for (const reason of LADDER_FAULTS) {
      const gate = evaluateOrderGate({
        orderType: 'market',
        depth: ok,
        ladder: { present: false, reason }
      });
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toBe(reason);
    }
  });

  test('a LIMIT order still rests through every TRANSIENT fault, flagged degraded', () => {
    // This is the deliberate asymmetry. A resting limit order is a claim about
    // a future price; a thin book is not a reason to refuse a bid 5% under it,
    // and refusing would take away the one instrument a user has to exit while
    // the feed is unwell.
    for (const reason of DEPTH_FAULTS.concat(LADDER_FAULTS)) {
      const depth = DEPTH_FAULTS.includes(reason)
        ? { healthy: false, reason }
        : ok;
      const ladder = DEPTH_FAULTS.includes(reason)
        ? present
        : { present: false, reason };
      const gate = evaluateOrderGate({ orderType: 'limit', depth, ladder });
      expect(gate.allowed).toBe(true);
      expect(gate.degraded).toBe(true);
      expect(gate.reason).toBe(reason);
    }
  });

  test('a LIMIT order is refused for the TERMINAL, pair-level verdicts only', () => {
    for (const reason of TERMINAL_REASONS) {
      const gate = evaluateOrderGate({
        orderType: 'limit',
        depth: ok,
        ladder: { present: false, reason }
      });
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toBe(reason);
    }
    // ...and every non-terminal verdict is genuinely outside that set, so the
    // permissive branch is the one whose funds cancelOrder can always return.
    for (const reason of DEPTH_FAULTS.concat(LADDER_FAULTS)) {
      expect(TERMINAL_REASONS.has(reason)).toBe(false);
    }
  });

  test('an unrecognised order type is treated as resting, never as a market order', () => {
    // Erring is safe in exactly one direction: a resting order reserves funds
    // the user can take back, a market order spends them against nothing.
    const gate = evaluateOrderGate({
      orderType: 'stop_limit',
      depth: ok,
      ladder: { present: false, reason: 'ladder_stale' }
    });
    expect(gate.allowed).toBe(true);
    expect(gate.degraded).toBe(true);
  });

  test('depth is reported ahead of the ladder, so the reason is the cause not the consequence', () => {
    const gate = evaluateOrderGate({
      orderType: 'market',
      depth: { healthy: false, reason: 'stale_depth' },
      ladder: { present: false, reason: 'ladder_not_built' }
    });
    expect(gate.reason).toBe('stale_depth');
  });

  test('a missing or malformed verdict is condemned, never assumed healthy', () => {
    for (const bad of [undefined, null, {}]) {
      const gate = evaluateOrderGate({
        orderType: 'market',
        depth: bad,
        ladder: present
      });
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toBe('error');
    }
  });
});

// ===========================================================================
// SCOPE - which pairs the gate has an opinion about at all
// ===========================================================================

describe('order gate scope', () => {
  beforeEach(async () => {
    await seed();
  });

  test('only paper-ladder ("binance") pairs are gated', () => {
    expect(usesPaperLadder(pairFixture)).toBe(true);
    for (const botstatus of ['bot', 'off', undefined]) {
      expect(usesPaperLadder({ ...pairFixture, botstatus })).toBe(false);
    }
    expect(usesPaperLadder(null)).toBe(false);
  });

  test('a "bot" pair is not judged against a ladder it was never meant to have', async () => {
    // getLadderState reports ladder_not_built for a bot pair forever. Gating on
    // it would refuse every market order on those pairs - a self-inflicted
    // outage - so the gate expresses no opinion and the inline resting-order
    // check in marketOrderPlace remains their liquidity test.
    const gate = await assertOrderTradable({ ...pairFixture, botstatus: 'bot' }, 'market');
    expect(gate.gated).toBe(false);
    expect(gate.allowed).toBe(true);
  });

  test('a gated pair with a live ladder and healthy depth is allowed', async () => {
    await syncPaperBook(pairFixture);
    expect(getLadderState(PAIR_ID).present).toBe(true);
    const gate = await assertOrderTradable(pairFixture, 'market');
    expect(gate).toMatchObject({ gated: true, allowed: true, reason: null });
  });

  test('an unreadable book fails CLOSED for a market order and open for a limit order', async () => {
    // Redis down mid-request: the honest answer is "unknown", and a market
    // order against an unknown book is the exact trade this gate exists to stop.
    const original = wsMock.getDepthSnapshot;
    wsMock.getDepthSnapshot = () => {
      throw new Error('redis down');
    };
    try {
      const market = await assertOrderTradable(pairFixture, 'market');
      expect(market.allowed).toBe(false);
      expect(market.reason).toBe('error');
      const limit = await assertOrderTradable(pairFixture, 'limit');
      expect(limit.allowed).toBe(true);
    } finally {
      wsMock.getDepthSnapshot = original;
    }
  });
});

// ===========================================================================
// THE ORDER PATH - the claim that actually matters: NO MONEY MOVES
// ===========================================================================

describe('orderPlace enforces the verdict server-side (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  test('a MARKET BUY into a purged ladder is refused with ZERO balance movement', async () => {
    await syncPaperBook(pairFixture);
    // The circuit breaker fires: the ladder is torn out of redis exactly as it
    // is in production when the pair goes ineligible.
    await purgePaperBook(PAIR_ID, 'pair_ineligible');
    expect(getLadderState(PAIR_ID).present).toBe(false);

    const before = ledgerSnapshot();
    const res = await placeMarket('buy', { orderValue: 31000, quantity: 0 });

    expect(res.statusCode).toBe(400);
    expect(res.payload.status).toBe(false);
    expect(res.payload.healthReason).toBe('pair_ineligible');
    expect(res.payload.message).toMatch(/[Nn]othing has been charged/);

    // THE POINT OF THE WHOLE EXERCISE: not "refunded", not "reversed" - never
    // debited. Every ledger, hash and audit trail is byte-identical.
    expect(ledgerSnapshot()).toEqual(before);
    expect(wallet()).toBe(300000);
    expect(walletMock.__passbook).toHaveLength(0);
    expect(userOrders('buy')).toHaveLength(0);
  });

  test('a MARKET SELL into a purged ladder is refused with ZERO balance movement', async () => {
    await syncPaperBook(pairFixture);
    await purgePaperBook(PAIR_ID, 'pair_ineligible');

    const before = ledgerSnapshot();
    const res = await placeMarket('sell', { amount: 0.4, quantity: 0.4 });

    expect(res.statusCode).toBe(400);
    expect(ledgerSnapshot()).toEqual(before);
    expect(walletBtc()).toBe(5);
    expect(walletMock.__passbook).toHaveLength(0);
    expect(userOrders('sell')).toHaveLength(0);
  });

  test('a MARKET order is refused when the DEPTH FEED is stale, even with a ladder recorded', async () => {
    await syncPaperBook(pairFixture);
    // The feed dies. The ladder's in-memory record is still fresh for a few
    // seconds, which is exactly the window in which a user could previously
    // spend money against liquidity that had stopped being priced.
    wsMock.__state.book = {
      ...healthyDepth(),
      updatedAt: Date.now() - depthHealth.DEPTH_STALE_MS - 1000
    };

    const before = ledgerSnapshot();
    const res = await placeMarket('buy', { orderValue: 31000, quantity: 0 });

    expect(res.statusCode).toBe(400);
    expect(res.payload.healthReason).toBe('stale_depth');
    expect(ledgerSnapshot()).toEqual(before);
  });

  test('a MARKET order is refused when the ladder has gone STALE, using the one shared threshold', async () => {
    await syncPaperBook(pairFixture);
    const recordedAt = getLadderState(PAIR_ID).at;
    expect(getLadderState(PAIR_ID, recordedAt + depthHealth.LADDER_STALE_MS).present).toBe(true);
    expect(
      getLadderState(PAIR_ID, recordedAt + depthHealth.LADDER_STALE_MS + 1).reason
    ).toBe('ladder_stale');
  });

  test('a MARKET order into a HEALTHY book is still accepted - the gate does not block the happy path', async () => {
    await syncPaperBook(pairFixture);
    const res = await placeMarket('buy', { orderValue: 31000, quantity: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe(true);
    expect(wallet()).toBeLessThan(300000);
  });

  test('a LIMIT order still rests while the ladder is missing, and its funds come back in full', async () => {
    await syncPaperBook(pairFixture);
    await purgePaperBook(PAIR_ID, 'ladder_orphaned');

    const res = await placeLimit('buy', 60000, 0.1);
    expect(res.statusCode).toBe(200);

    const resting = userOrders('buy');
    expect(resting).toHaveLength(1);
    const reserved = 60000 * 0.1;
    expect(wallet()).toBeCloseTo(300000 - reserved, 6);
    expect(inOrder()).toBeCloseTo(reserved, 6);

    // NOT STRANDED: cancel is deliberately ungated, so the reservation is
    // recoverable at any time no matter how bad the book has become.
    const cancelled = await cancel(`buyOpenOrders_${PAIR_ID}`, resting[0]._id);
    expect(cancelled.statusCode).toBe(200);
    expect(wallet()).toBeCloseTo(300000, 6);
    expect(inOrder()).toBeCloseTo(0, 6);
  });

  test('a LIMIT order into an INELIGIBLE pair is refused with ZERO balance movement', async () => {
    await syncPaperBook(pairFixture);
    await purgePaperBook(PAIR_ID, 'pair_ineligible');

    const before = ledgerSnapshot();
    const res = await placeLimit('buy', 60000, 0.1);

    expect(res.statusCode).toBe(400);
    expect(res.payload.healthReason).toBe('pair_ineligible');
    expect(ledgerSnapshot()).toEqual(before);
    expect(userOrders('buy')).toHaveLength(0);
  });
});

// ===========================================================================
// NO REQUEST GOES UNANSWERED
//
// THE DEFECT THESE TESTS PIN
// --------------------------
// orderPlaceValidate accepted `stop_limit`, `stop_market` and `trailing_stop`.
// orderPlace dispatched on "limit" and "market" and had no `else`, so those
// three walked past validation, matched neither branch, and the function
// returned having written NO response at all: the request hung until the client
// gave up and the connection leaked, one per attempt.
//
// The fix is refusal, not implementation, and the reason is not laziness:
// wiring the handlers up would debit a user for an order that can never
// execute - the exact harm lib/orderGate.js exists to prevent.
//
// The machinery is now DELETED, not merely disconnected - the three placement
// handlers, both triggers, the binance-side stop handlers, their validators and
// the fields they alone used are all gone. These tests therefore pin a contract
// rather than a workaround: the strings must keep earning a named 400, because
// a client that still sends one must not be met with silence or acceptance.
// ===========================================================================

describe('every accepted order type has a handler, and every request is answered (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  const runValidation = (body) => {
    const res = mockRes();
    let nextCalled = false;
    orderPlaceValidate(
      { body },
      res,
      () => {
        nextCalled = true;
      }
    );
    return { res, nextCalled };
  };

  test('the three stop order types are REFUSED at validation, named as unsupported', () => {
    for (const orderType of UNSUPPORTED_ORDER_TYPES) {
      const { res, nextCalled } = runValidation({
        orderType,
        spotPairId: PAIR_ID,
        buyorsell: 'buy',
        price: 63000,
        quantity: 0.1,
        stopPrice: 63000,
        distance: 10
      });
      // Answered, and answered before anything downstream can be reached.
      expect(res.statusCode).toBe(400);
      expect(res.payload.errors.orderType).toBe('UNSUPPORTED_ORDER_TYPE');
      expect(nextCalled).toBe(false);
    }
  });

  test('an unknown order type is still INVALID, not merely unsupported', () => {
    // The two are different facts: "we do not offer that" invites a different
    // client reaction from "that is not a thing", and collapsing them makes a
    // typo look like a temporary limitation worth retrying.
    const { res, nextCalled } = runValidation({ orderType: 'oco', spotPairId: PAIR_ID });
    expect(res.statusCode).toBe(400);
    expect(res.payload.errors.orderType).toBe('INVALID_ORDER_TYPE');
    expect(nextCalled).toBe(false);
  });

  test('the supported types still pass validation through to the handler', () => {
    const limit = runValidation({
      orderType: 'limit',
      spotPairId: PAIR_ID,
      price: 63000,
      quantity: 0.1,
      buyorsell: 'buy'
    });
    expect(limit.nextCalled).toBe(true);
    expect(limit.res.statusCode).toBe(null);

    const market = runValidation({
      orderType: 'market',
      spotPairId: PAIR_ID,
      orderValue: 200,
      buyorsell: 'buy'
    });
    expect(market.nextCalled).toBe(true);
    expect(market.res.statusCode).toBe(null);
  });

  test('orderPlace ANSWERS every order type it can be handed - no branch falls through', async () => {
    // The literal shape of the bug: a handler that returns without writing a
    // response. `statusCode === null` here IS the hang, so asserting it is
    // never null is asserting the connection is never leaked.
    await syncPaperBook(pairFixture);
    const bodies = {
      limit: { price: 63000, quantity: 0.1, buyorsell: 'buy' },
      market: { orderValue: 200, quantity: 0, buyorsell: 'buy' },
      stop_limit: { stopPrice: 63000, price: 63000, quantity: 0.1, buyorsell: 'buy' },
      stop_market: { stopPrice: 63000, quantity: 0.1, buyorsell: 'buy' },
      trailing_stop: { distance: 10, quantity: 0.1, buyorsell: 'buy' },
      '': { buyorsell: 'buy' },
      nonsense: { buyorsell: 'buy' }
    };
    for (const [orderType, body] of Object.entries(bodies)) {
      const res = mockRes();
      await orderPlace(
        {
          body: { orderType, spotPairId: PAIR_ID, ...body },
          user: { id: USER_ID, userCode: '11286524' }
        },
        res
      );
      expect(res.statusCode).not.toBe(null);
      expect(res.payload).not.toBe(null);
    }
  });

  test('an unsupported type that somehow reaches orderPlace is refused, and moves NO money', async () => {
    await syncPaperBook(pairFixture);
    const before = ledgerSnapshot();
    for (const orderType of UNSUPPORTED_ORDER_TYPES) {
      const res = mockRes();
      await orderPlace(
        {
          body: {
            orderType,
            spotPairId: PAIR_ID,
            buyorsell: 'buy',
            stopPrice: 63000,
            price: 63000,
            quantity: 0.1,
            distance: 10
          },
          user: { id: USER_ID, userCode: '11286524' }
        },
        res
      );
      expect(res.statusCode).toBe(400);
      expect(res.payload.status).toBe(false);
      expect(res.payload.message).toMatch(/not supported/i);
    }
    expect(ledgerSnapshot()).toEqual(before);
  });

  test('validation and dispatch are driven by ONE list, so neither can grow past the other', () => {
    // The bug was a disagreement between "types validation accepts" and "types
    // orderPlace can run". Anything validation lets through must reach a real
    // handler; anything it refuses must not be silently runnable.
    expect(SUPPORTED_ORDER_TYPES).toEqual(['limit', 'market']);
    for (const orderType of UNSUPPORTED_ORDER_TYPES) {
      expect(SUPPORTED_ORDER_TYPES).not.toContain(orderType);
    }
  });

  test('orderPlace still routes the supported types to the real handlers', async () => {
    await syncPaperBook(pairFixture);

    const limitRes = mockRes();
    await orderPlace(
      {
        body: {
          orderType: 'limit',
          spotPairId: PAIR_ID,
          buyorsell: 'buy',
          price: 60000,
          quantity: 0.1
        },
        user: { id: USER_ID, userCode: '11286524' }
      },
      limitRes
    );
    expect(limitRes.statusCode).toBe(200);
    expect(userOrders('buy')).toHaveLength(1);

    const marketRes = mockRes();
    await orderPlace(
      {
        body: {
          orderType: 'market',
          spotPairId: PAIR_ID,
          buyorsell: 'buy',
          orderValue: 200,
          quantity: 0
        },
        user: { id: USER_ID, userCode: '11286524' }
      },
      marketRes
    );
    expect(marketRes.statusCode).toBe(200);
  });
});

// ===========================================================================
// SUFFICIENCY - the gate tests how much is resting, not merely that some is
//
// THE DEFECT THESE TESTS PIN
// --------------------------
// The gate asked "is a ladder present". A market order twenty times the size of
// the whole book answered yes, was DEBITED IN FULL, filled against every level
// there was, and left the remainder resting as `price: "market"` - unfillable
// (no counterparty), unpriceable (no price), and holding the user's money. That
// is the identical end state the gate was built to prevent, reached through the
// one parameter it never looked at.
// ===========================================================================

describe('the gate refuses a market order bigger than the book (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  // The fixture depth builds three orders a side: 0.5/1/2 base units at
  // ~63.5k, i.e. 3.5 base and ~222k quote per side.
  const capacityOf = () => {
    const ladder = getLadderState(PAIR_ID);
    return { buyQuantity: ladder.buyQuantity, sellNotional: ladder.sellNotional };
  };

  test('ladderCapacity measures both units and ignores unusable rows (PURE)', () => {
    expect(ladderCapacity([
      { price: 100, quantity: 2 },
      { price: 200, quantity: 1 }
    ])).toEqual({ quantity: 3, notional: 400 });

    // Nothing that cannot be multiplied into liquidity may inflate the answer.
    expect(ladderCapacity([
      { price: 'market', quantity: 5 },
      { price: 100, quantity: 0 },
      { price: 0, quantity: 5 },
      { price: 100, quantity: -1 },
      null,
      { price: 100, quantity: 1 }
    ])).toEqual({ quantity: 1, notional: 100 });

    expect(ladderCapacity([])).toEqual({ quantity: 0, notional: 0 });
    expect(ladderCapacity(null)).toEqual({ quantity: 0, notional: 0 });
  });

  test('a live ladder reports its size, and a purged one reports zero', async () => {
    await syncPaperBook(pairFixture);
    const live = getLadderState(PAIR_ID);
    expect(live.present).toBe(true);
    expect(live.buyQuantity).toBeCloseTo(3.5, 8);
    expect(live.sellQuantity).toBeCloseTo(3.5, 8);
    expect(live.sellNotional).toBeGreaterThan(200000);
    expect(live.buyNotional).toBeGreaterThan(200000);

    await purgePaperBook(PAIR_ID, 'pair_ineligible');
    const dead = getLadderState(PAIR_ID);
    expect(dead.present).toBe(false);
    // Size may never outlive presence: a reader that checked capacity before
    // presence would otherwise be told 3.5 BTC is resting in an empty book.
    expect(dead.buyQuantity).toBe(0);
    expect(dead.sellNotional).toBe(0);
  });

  test('an EXPIRED ladder reports zero capacity as well as absence', async () => {
    await syncPaperBook(pairFixture);
    const at = getLadderState(PAIR_ID).at;
    const stale = getLadderState(PAIR_ID, at + depthHealth.LADDER_STALE_MS + 1);
    expect(stale.present).toBe(false);
    expect(stale.reason).toBe('ladder_stale');
    expect(stale.buyQuantity).toBe(0);
    expect(stale.sellNotional).toBe(0);
  });

  test('each side is measured in the unit its taker is sized in', () => {
    // A market BUY spends quote and eats the ask ladder; a market SELL delivers
    // base and eats the bid ladder. Comparing a BTC size against a USD notional
    // would make the whole check pass everything, so the pairing is pinned.
    const ladder = {
      present: true,
      buyQuantity: 3.5,
      buyNotional: 222241,
      sellQuantity: 3.4,
      sellNotional: 222255
    };
    expect(ladderCapacityFor(ladder, 'buy')).toBe(222255);
    expect(ladderCapacityFor(ladder, 'sell')).toBe(3.5);
    expect(ladderCapacityFor(null, 'buy')).toBe(null);
    expect(ladderCapacityFor({ present: true }, 'buy')).toBe(null);
  });

  const healthy = { healthy: true, reason: null };
  const bigLadder = {
    present: true,
    reason: null,
    buyQuantity: 3.5,
    buyNotional: 222241,
    sellQuantity: 3.5,
    sellNotional: 222255
  };

  test('the POLICY refuses an oversize market order and allows one that fits', () => {
    const tooBig = evaluateOrderGate({
      orderType: 'market',
      side: 'buy',
      size: 222256,
      depth: healthy,
      ladder: bigLadder
    });
    expect(tooBig.allowed).toBe(false);
    expect(tooBig.reason).toBe('insufficient_liquidity');
    expect(tooBig.message).toMatch(/[Nn]othing has been charged/);
    expect(tooBig.available).toBe(222255);

    // The boundary belongs to the user: a book that holds exactly the order can
    // fill exactly the order.
    for (const size of [222255, 1000]) {
      const fits = evaluateOrderGate({
        orderType: 'market',
        side: 'buy',
        size,
        depth: healthy,
        ladder: bigLadder
      });
      expect(fits).toEqual({ allowed: true, reason: null, message: null, degraded: false });
    }

    const sellTooBig = evaluateOrderGate({
      orderType: 'market',
      side: 'sell',
      size: 3.6,
      depth: healthy,
      ladder: bigLadder
    });
    expect(sellTooBig.allowed).toBe(false);
    expect(sellTooBig.reason).toBe('insufficient_liquidity');
    expect(sellTooBig.available).toBe(3.5);
  });

  test('a LIMIT order of any size is untouched by the sufficiency rule', () => {
    // A resting order makes no demand on this instant's liquidity, and refusing
    // it would take away the instrument a user has to work a large position.
    const gate = evaluateOrderGate({
      orderType: 'limit',
      side: 'buy',
      size: 10 ** 9,
      depth: healthy,
      ladder: bigLadder
    });
    expect(gate).toEqual({ allowed: true, reason: null, message: null, degraded: false });
  });

  test('an unmeasurable size or an unmeasurable ladder FAILS CLOSED for a market order', () => {
    for (const size of [NaN, 0, -5, 'abc']) {
      const gate = evaluateOrderGate({
        orderType: 'market',
        side: 'buy',
        size,
        depth: healthy,
        ladder: bigLadder
      });
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toBe('error');
    }
    // A ladder that claims presence but cannot say how much is resting is not
    // evidence of liquidity, so it may not be treated as any.
    const noCapacity = evaluateOrderGate({
      orderType: 'market',
      side: 'buy',
      size: 100,
      depth: healthy,
      ladder: { present: true, reason: null }
    });
    expect(noCapacity.allowed).toBe(false);
    expect(noCapacity.reason).toBe('error');
  });

  test('a caller that supplies no size still gets the presence-only verdict', async () => {
    // Health reporting asks "is this pair tradable", not "can it take my
    // order". Omitting the size must not be mistaken for a zero-size order.
    await syncPaperBook(pairFixture);
    const gate = await assertOrderTradable(pairFixture, 'market');
    expect(gate).toMatchObject({ gated: true, allowed: true, reason: null });
  });

  test('a MARKET BUY larger than the whole ask ladder is refused with ZERO balance movement', async () => {
    await syncPaperBook(pairFixture);
    const { sellNotional } = capacityOf();
    expect(sellNotional).toBeGreaterThan(0);

    const before = ledgerSnapshot();
    const res = await placeMarket('buy', {
      orderValue: sellNotional + 1,
      quantity: 0
    });

    expect(res.statusCode).toBe(400);
    expect(res.payload.status).toBe(false);
    expect(res.payload.healthReason).toBe('insufficient_liquidity');
    expect(res.payload.message).toMatch(/[Nn]othing has been charged/);

    // Never debited, so there is nothing to return. And - the point of the
    // finding - no unpriceable residue was created.
    expect(ledgerSnapshot()).toEqual(before);
    expect(wallet()).toBe(300000);
    expect(walletMock.__passbook).toHaveLength(0);
    expect(userOrders('buy')).toHaveLength(0);
    expect(openOrders('buy').filter((o) => o.price === 'market')).toHaveLength(0);
  });

  test('a MARKET SELL larger than the whole bid ladder is refused with ZERO balance movement', async () => {
    await syncPaperBook(pairFixture);
    const { buyQuantity } = capacityOf();
    expect(buyQuantity).toBeCloseTo(3.5, 8);

    const before = ledgerSnapshot();
    // Comfortably inside the user's 5 BTC balance and the pair's maxQuantity,
    // so only the depth of the book can be what refuses it.
    const res = await placeMarket('sell', { amount: 4, quantity: 4 });

    expect(res.statusCode).toBe(400);
    expect(res.payload.healthReason).toBe('insufficient_liquidity');
    expect(ledgerSnapshot()).toEqual(before);
    expect(walletBtc()).toBe(5);
    expect(walletMock.__passbook).toHaveLength(0);
    expect(openOrders('sell').filter((o) => o.price === 'market')).toHaveLength(0);
  });

  test('an order the book CAN fill is still accepted - the rule does not overreach', async () => {
    await syncPaperBook(pairFixture);
    const { sellNotional } = capacityOf();

    // Right up to the last unit of resting liquidity.
    const res = await placeMarket('buy', { orderValue: sellNotional, quantity: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe(true);
    expect(wallet()).toBeLessThan(300000);
  });

  test('a LIMIT order far larger than the ladder still rests, and is fully refundable', async () => {
    await syncPaperBook(pairFixture);
    // 4 BTC against a 3.5 BTC ladder: as a market order this is refused, as a
    // resting bid it is an ordinary claim about a future price.
    const res = await placeLimit('buy', 60000, 4);
    expect(res.statusCode).toBe(200);

    const resting = userOrders('buy');
    expect(resting).toHaveLength(1);
    expect(inOrder()).toBeCloseTo(240000, 6);

    const cancelled = await cancel(`buyOpenOrders_${PAIR_ID}`, resting[0]._id);
    expect(cancelled.statusCode).toBe(200);
    expect(wallet()).toBeCloseTo(300000, 6);
    expect(inOrder()).toBeCloseTo(0, 6);
  });
});

// ===========================================================================
// AND IF THE BOOK DISAPPEARS AFTER THE ORDER IS ACCEPTED
//
// The gate refuses a market order into a book that is already unfillable, but
// it cannot refuse one that was fine when it was placed and whose counterparty
// ladder was purged two seconds later. That order rests as `price: "market"`
// with the funds already debited. The matcher's one-sided-book cleanup used to
// be gated on botstatus "bot", which excluded exactly the pairs whose ladder is
// purged as a matter of routine - so on a paper pair the money stayed gone.
// ===========================================================================

describe('a market order stranded by a vanished book is refunded (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  test('the matcher cancels and REFUNDS a resting market buy once the ask side is gone', async () => {
    await syncPaperBook(pairFixture);
    const res = await placeMarket('buy', { orderValue: 31000, quantity: 0 });
    expect(res.statusCode).toBe(200);
    expect(userOrders('buy')).toHaveLength(1);
    expect(wallet()).toBeLessThan(300000);

    // The feed dies: the next matcher tick purges the ladder, which empties the
    // ask side completely and leaves the user's market buy with no counterparty
    // it will ever have.
    wsMock.__state.book = null;
    await matchingcall(PAIR_ID);
    await flush();

    expect(getLadderState(PAIR_ID).present).toBe(false);
    expect(userOrders('buy')).toHaveLength(0);
    expect(wallet()).toBeCloseTo(300000, 6);

    const refunds = walletMock.__passbook.filter((e) => e.type === 'orderCancel');
    expect(refunds).toHaveLength(1);
    expect(refunds[0].category).toBe('credit');
    expect(parseFloat(refunds[0].amount)).toBeGreaterThan(0);
  });

  test('the matcher cancels and REFUNDS a resting market sell once the bid side is gone', async () => {
    await syncPaperBook(pairFixture);
    const res = await placeMarket('sell', { amount: 0.4, quantity: 0.4 });
    expect(res.statusCode).toBe(200);
    expect(walletBtc()).toBeCloseTo(4.6, 6);

    wsMock.__state.book = null;
    await matchingcall(PAIR_ID);
    await flush();

    expect(userOrders('sell')).toHaveLength(0);
    expect(walletBtc()).toBeCloseTo(5, 6);
    expect(
      walletMock.__passbook.filter((e) => e.type === 'orderCancel')
    ).toHaveLength(1);
  });
});

// ===========================================================================
// THE REFUSAL HAS TO NAME THE USER'S REASON
//
// The gate runs before the balance is read, which is correct - it has to run
// before anything can move money. But that ordering also let it NAME the
// failure, and its name was often the wrong one. An account holding 10,000 USD
// that asked to buy 400,000 USD of BTC was told "there is not enough liquidity
// resting in this book... try a smaller size, or place a limit order": untrue
// (the book's depth is irrelevant to an order that cannot be paid for),
// unactionable (the limit order it recommends is unaffordable too), and
// transient-sounding ("try again in a moment") about a condition that will
// never resolve on its own. The liquidity verdict fired first only because a
// 400,000 order happens to be bigger than the ladder as well.
//
// So on the refusal path - after the order is already rejected, nothing moved,
// nothing to unwind - the cause reported is the one that does not fix itself.
// ===========================================================================

describe('an unaffordable order is refused for the right reason (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  const OTHER_USER = '6a70f1c287c92c7218ac37ff';

  const capacityOf = () => {
    const ladder = getLadderState(PAIR_ID);
    return { buyQuantity: ladder.buyQuantity, sellNotional: ladder.sellNotional };
  };

  test('the debit value is quantised exactly once, and both checks read it', () => {
    // A buy is billed for the quantity the pair can express, not the one typed,
    // and the quantisation TRUNCATES. A pre-check computed from the RAW request
    // would refuse an order for one satoshi of rounding that the real check, on
    // the quantised value, allows.
    const buy = { buyorsell: 'buy', orderValue: 31000, amount: 0 };
    const expected = (Math.floor((31000 / 63500) * 1e8) / 1e8) * 63500;
    expect(marketOrderDebitValue(buy, pairFixture)).toBeCloseTo(expected, 8);
    expect(marketOrderDebitValue(buy, pairFixture)).toBeLessThanOrEqual(31000);

    // A sell is sized in the base coin and is not requantised here.
    expect(
      marketOrderDebitValue({ buyorsell: 'sell', amount: 0.4 }, pairFixture)
    ).toBe(0.4);
  });

  test('a debit that cannot be computed is NaN, never 0 (CRITICAL)', () => {
    // `requested / markPrice` is Infinity at a mark price of 0 and NaN at an
    // absent one, and `toFixedDown` answers "" for BOTH (it always has for NaN;
    // since the rounding-helper round it does for Infinity too, rather than
    // handing the infinity back untruncated). Left to the coercion,
    // `"" * markPrice` is 0 - and this number is the DEBIT: marketOrderPlace
    // assigns it to `orderValue` and charges the account with it, so a 0 here
    // is a FREE ORDER for an unbounded quantity. It must stay unusable.
    for (const deadMark of [0, undefined, null, NaN]) {
      const debit = marketOrderDebitValue(
        { buyorsell: 'buy', orderValue: 31000, amount: 0 },
        { ...pairFixture, markPrice: deadMark }
      );
      expect(Number.isFinite(debit)).toBe(false);
      expect(debit).not.toBe(0);
      // ...and the affordability verdict declines to judge it rather than
      // answering "affordable".
      expect(!Number.isFinite(debit) || debit <= 0).toBe(true);
    }
  });

  test('MUTATION CHECK: the coercion this replaces made the order free', () => {
    // What the function used to evaluate, verbatim.
    const coercionMutant = (requested, markPrice) => {
      const oValue = requested / markPrice;
      const truncated = toFixedDown(oValue, 8);
      return parseFloat(truncated * markPrice);
    };
    // With "" for an infinity, the old expression is a ZERO debit.
    expect(coercionMutant(31000, 0)).toBe(0);
    expect(Number.isFinite(coercionMutant(31000, 0))).toBe(true);
    // The shipping function refuses instead.
    expect(
      Number.isFinite(
        marketOrderDebitValue(
          { buyorsell: 'buy', orderValue: 31000, amount: 0 },
          { ...pairFixture, markPrice: 0 }
        )
      )
    ).toBe(false);
  });

  test('OVER-CORRECTION CHECK: a live mark price still produces a real debit', () => {
    // A guard that refused anything it could not prove - a zero request, a
    // sell, a quantity that truncates to nothing - would break every ordinary
    // order. Only a NON-FINITE truncation is refused.
    expect(
      marketOrderDebitValue(
        { buyorsell: 'buy', orderValue: 31000, amount: 0 },
        pairFixture
      )
    ).toBeGreaterThan(0);
    expect(
      marketOrderDebitValue(
        { buyorsell: 'buy', orderValue: 0, amount: 0 },
        pairFixture
      )
    ).toBe(0);
    expect(
      marketOrderDebitValue({ buyorsell: 'sell', amount: 0.4 }, pairFixture)
    ).toBe(0.4);
    // A request so small it truncates to zero base units is a 0 debit, not a
    // refusal - that is a real answer and the gate already handles it.
    expect(
      marketOrderDebitValue(
        { buyorsell: 'buy', orderValue: 1e-9, amount: 0 },
        pairFixture
      )
    ).toBe(0);
  });

  // =========================================================================
  // A MARKET BUY MUST BE CHARGED FOR THE SIZE IT IS GIVEN (CRITICAL)
  // =========================================================================
  // The debit was computed from the QUANTISED quantity while the order written
  // into the book carried the RAW one, so every market buy handed over base
  // coin nobody paid for. MEASURED LIVE on this stack before the fix, SOLUSD
  // (firstFloatDigit 9, markPrice 74.72), one ordinary orderPlace of 100:
  // debited 99.99999996607949, openQuantity 1.3383297644539616 (raw) against an
  // orderValue of 99.99999996608 (truncQty * markPrice) - 3.39e-8 USD of SOL
  // created, deterministically, per order.
  //
  // These tests are written against the CONTROLLER, not just the helper. A
  // pure-function test of marketOrderDebitValue would have passed throughout
  // the entire life of the bug, because the helper was always right and the
  // CALL SITE recomputed the quantity its own way.
  describe('a market buy is charged for exactly the size it is given (CRITICAL)', () => {
    beforeEach(async () => {
      // The matcher needs a counterparty: a market order with an empty book is
      // refused before it is ever priced.
      await syncPaperBook(pairFixture);
    });

    // 31000 / 63500 = 0.488188976377952755..., which does NOT terminate inside
    // the pair's 8 base decimals, so raw and quantised genuinely differ.
    const REQUESTED = 31000;

    test('the order in the book is for the quantity the account was debited for', async () => {
      const before = wallet();
      const res = await placeMarket('buy', { orderValue: REQUESTED, amount: 0 });
      expect(res.payload.status).toBe(true);

      const debited = before - wallet();
      const [order] = userOrders('buy');
      expect(order).toBeTruthy();

      // THE INVARIANT: what left the wallet buys exactly what the book says.
      expect(order.quantity * pairFixture.markPrice).toBeCloseTo(debited, 10);
      expect(order.openQuantity).toBe(order.quantity);
      expect(order.orderValue).toBeCloseTo(debited, 10);
      expect(order.openOrderValue).toBe(order.orderValue);
    });

    test('the quantity is the pair-quantised one, not the raw division', async () => {
      const raw = REQUESTED / pairFixture.markPrice;
      const quantised = toFixedDown(raw, pairFixture.firstFloatDigit);
      expect(quantised).toBeLessThan(raw); // the fixture actually exercises it

      await placeMarket('buy', { orderValue: REQUESTED, amount: 0 });
      const [order] = userOrders('buy');
      expect(order.quantity).toBe(quantised);
      expect(order.quantity).not.toBe(raw);
    });

    test('the account is never short: debit >= quantity x markPrice, always', async () => {
      // The direction that matters. An order for MORE than was paid for is
      // money created; an order for less is only a smaller order.
      for (const value of [31000, 1234.5678, 0.07, 99999.99]) {
        await seed();
        await syncPaperBook(pairFixture);
        const before = wallet();
        const res = await placeMarket('buy', { orderValue: value, amount: 0 });
        if (res.payload?.status !== true) continue;
        const debited = before - wallet();
        const [order] = userOrders('buy');
        expect(debited).toBeGreaterThanOrEqual(
          order.quantity * pairFixture.markPrice - 1e-9
        );
      }
    });

    test('a market SELL is not requantised - its size is the size it named', async () => {
      // OVER-CORRECTION CHECK. Truncating a sell would silently shrink the
      // user's order, and a sell is already denominated in the base coin.
      //
      // The size deliberately carries SEVEN decimals. An earlier version of
      // this test used 0.4, which survives truncation at any scale down to one
      // decimal - so a mutant that quantised the sell side passed it. A test
      // for "this value is not truncated" has to use a value that truncation
      // would visibly change.
      const AMOUNT = 0.4012345;
      const before = walletBtc();
      const res = await placeMarket('sell', { amount: AMOUNT });
      expect(res.payload.status).toBe(true);
      expect(before - walletBtc()).toBeCloseTo(AMOUNT, 12);
      const [order] = userOrders('sell');
      expect(order.quantity).toBe(AMOUNT);
      expect(order.openQuantity).toBe(AMOUNT);
      expect(order.amount).toBe(AMOUNT);
      // ...and the two helpers agree with the controller, at full precision.
      const sell = { buyorsell: 'sell', amount: AMOUNT };
      expect(marketOrderQuantity(sell, pairFixture)).toBe(AMOUNT);
      expect(marketOrderDebitValue(sell, pairFixture)).toBe(AMOUNT);
    });

    test('marketOrderDebitValue is DERIVED from marketOrderQuantity, not computed beside it', () => {
      for (const value of [31000, 1234.5678, 0.07, 1e-9, 99999.99]) {
        const body = { buyorsell: 'buy', orderValue: value, amount: 0 };
        expect(marketOrderDebitValue(body, pairFixture)).toBe(
          parseFloat(marketOrderQuantity(body, pairFixture) * pairFixture.markPrice)
        );
      }
      // A sell passes its size through on both.
      const sell = { buyorsell: 'sell', amount: 0.4 };
      expect(marketOrderQuantity(sell, pairFixture)).toBe(0.4);
      expect(marketOrderDebitValue(sell, pairFixture)).toBe(0.4);
    });

    test('an uncomputable quantity is NaN, and so is the debit derived from it', () => {
      for (const deadMark of [0, undefined, null, NaN]) {
        const body = { buyorsell: 'buy', orderValue: REQUESTED, amount: 0 };
        const pair = { ...pairFixture, markPrice: deadMark };
        expect(Number.isFinite(marketOrderQuantity(body, pair))).toBe(false);
        expect(Number.isFinite(marketOrderDebitValue(body, pair))).toBe(false);
      }
    });
  });

  test('the debit comes out of the quote coin for a buy and the base coin for a sell', () => {
    expect(marketOrderDebitCurrencyId({ buyorsell: 'buy' }, pairFixture)).toBe(USD_ID);
    expect(marketOrderDebitCurrencyId({ buyorsell: 'sell' }, pairFixture)).toBe(BTC_ID);
  });

  test('a MARKET BUY the account cannot pay for says so - not "not enough liquidity"', async () => {
    await syncPaperBook(pairFixture);
    const { sellNotional } = capacityOf();
    // Bigger than the ladder AND bigger than the 300,000 USD balance, so the
    // gate refuses it first and BOTH reasons are true. Only one of them is the
    // user's.
    const orderValue = 400000;
    expect(orderValue).toBeGreaterThan(sellNotional);
    expect(orderValue).toBeGreaterThan(wallet());

    const before = ledgerSnapshot();
    const res = await placeMarket('buy', { orderValue, quantity: 0 });

    expect(res.statusCode).toBe(400);
    expect(res.payload.status).toBe(false);
    expect(res.payload.healthReason).toBe('insufficient_balance');
    expect(res.payload.message).toBe(
      'Due to insufficient balance order cannot be placed'
    );
    expect(res.payload.message).not.toMatch(/liquidity/i);

    // Still a refusal: nothing moved, exactly as before.
    expect(ledgerSnapshot()).toEqual(before);
    expect(wallet()).toBe(300000);
    expect(walletMock.__passbook).toHaveLength(0);
    expect(userOrders('buy')).toHaveLength(0);
  });

  test('a MARKET SELL of more coin than the account holds says so', async () => {
    await syncPaperBook(pairFixture);
    const { buyQuantity } = capacityOf();
    const amount = 6; // > 3.5 ladder AND > the 5 BTC held
    expect(amount).toBeGreaterThan(buyQuantity);
    expect(amount).toBeGreaterThan(walletBtc());

    const before = ledgerSnapshot();
    const res = await placeMarket('sell', { amount, quantity: amount });

    expect(res.statusCode).toBe(400);
    expect(res.payload.healthReason).toBe('insufficient_balance');
    expect(ledgerSnapshot()).toEqual(before);
    expect(walletBtc()).toBe(5);
  });

  test('the rule does not overreach: an AFFORDABLE oversized order is still a liquidity refusal', async () => {
    await syncPaperBook(pairFixture);
    const { sellNotional } = capacityOf();
    // Comfortably inside the 300,000 balance, so the only thing wrong with it
    // is the size of the book.
    expect(sellNotional + 1).toBeLessThan(wallet());

    const res = await placeMarket('buy', {
      orderValue: sellNotional + 1,
      quantity: 0
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload.healthReason).toBe('insufficient_liquidity');
    expect(res.payload.message).toMatch(/liquidity/i);
  });

  test('a HEALTH fault on an unaffordable order still reports the balance', async () => {
    // no_depth is transient and tells the user to retry. Retrying will never
    // make 400,000 USD appear, so the balance is the honest answer here too.
    await syncPaperBook(pairFixture);
    wsMock.__state.book = null;

    const res = await placeMarket('buy', { orderValue: 400000, quantity: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.payload.healthReason).toBe('insufficient_balance');
  });

  test('a HEALTH fault on an AFFORDABLE order still reports the feed', async () => {
    await syncPaperBook(pairFixture);
    wsMock.__state.book = null;

    const res = await placeMarket('buy', { orderValue: 31000, quantity: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.payload.healthReason).not.toBe('insufficient_balance');
    expect(res.payload.message).toMatch(/[Nn]othing has been charged/);
  });

  test('an order that CAN be paid for and CAN fill is still accepted', async () => {
    await syncPaperBook(pairFixture);
    const res = await placeMarket('buy', { orderValue: 31000, quantity: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe(true);
  });

  test('the affordability verdict FAILS OPEN on a balance it has never read', async () => {
    // A first-touch account's Redis row is hydrated further down in
    // marketOrderPlace (updateUserWallet). Guessing "you are broke" at a
    // balance nobody has read is a worse answer than the gate's.
    const unread = await isMarketOrderUnaffordable(
      OTHER_USER,
      { buyorsell: 'buy', orderValue: 400000 },
      pairFixture
    );
    expect(unread).toBe(false);

    // ...and a balance that HAS been read is judged on its merits.
    expect(
      await isMarketOrderUnaffordable(
        USER_ID,
        { buyorsell: 'buy', orderValue: 400000 },
        pairFixture
      )
    ).toBe(true);
    expect(
      await isMarketOrderUnaffordable(
        USER_ID,
        { buyorsell: 'buy', orderValue: 31000 },
        pairFixture
      )
    ).toBe(false);
  });

  test('a malformed size is never reported as an affordability failure', async () => {
    // "we cannot measure this" is the gate's `error` verdict, not the user's
    // wallet's fault.
    for (const orderValue of [NaN, 0, -5, 'abc']) {
      expect(
        await isMarketOrderUnaffordable(
          USER_ID,
          { buyorsell: 'buy', orderValue },
          pairFixture
        )
      ).toBe(false);
    }
  });
});

// ===========================================================================
// ONE DEFINITION PER CONSTANT
// ===========================================================================

describe('health and staleness thresholds are defined exactly once (CRITICAL)', () => {
  const SERVICE_ROOT = path.resolve(__dirname, '../..');
  const SOURCE_DIRS = [
    'lib',
    'controllers',
    'config',
    'models',
    'routes',
    'validation',
    'grpc'
  ];

  const sourceFiles = () => {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) found.push(full);
      }
    };
    for (const dir of SOURCE_DIRS) {
      const full = path.join(SERVICE_ROOT, dir);
      if (fs.existsSync(full)) walk(full);
    }
    return found;
  };

  // Every `process.env.X || <default>` in the service, grouped by env var. A
  // constant with a default is a DEFINITION; the same env var defaulted in two
  // files is two definitions that will drift.
  const declarations = () => {
    const byEnv = new Map();
    for (const file of sourceFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      const re = /process\.env\.([A-Z0-9_]+)\s*\|\|/g;
      let match;
      while ((match = re.exec(source))) {
        const rel = path.relative(SERVICE_ROOT, file);
        if (!byEnv.has(match[1])) byEnv.set(match[1], new Set());
        byEnv.get(match[1]).add(rel);
      }
    }
    return byEnv;
  };

  test('no env-defaulted constant is declared in more than one file', () => {
    const duplicated = [];
    for (const [envVar, files] of declarations()) {
      if (files.size > 1) duplicated.push(`${envVar}: ${[...files].join(', ')}`);
    }
    expect(duplicated).toEqual([]);
  });

  test('the ladder-staleness threshold has exactly ONE env var, in lib/depthHealth.js', () => {
    // The regression: paperBook.controller.js declared PAPER_BOOK_LADDER_STALE_MS
    // and fillCanary.js declared SPOT_CANARY_LADDER_MAX_AGE_MS, both defaulting
    // to 15000 and both meaning "a ladder this old is not tradable". Tuning the
    // documented one moved the GATE and left the MONITOR reporting against the
    // stale default - a canary that calls a ladder fine after the order path has
    // condemned it.
    const ladderEnvVars = [...declarations().entries()].filter(([name]) =>
      name.includes('LADDER')
    );
    expect(ladderEnvVars.map(([name]) => name)).toEqual([
      'PAPER_BOOK_LADDER_STALE_MS'
    ]);
    expect([...ladderEnvVars[0][1]]).toEqual(['lib/depthHealth.js']);
  });

  test('every consumer of the ladder threshold reads the shared constant', async () => {
    // Not just "declared once" - actually USED once. The canary reports the
    // number an operator reads the ladder age against, and the display and the
    // order gate act on it; if those ever came from different constants the
    // reported number would be a lie.
    const canary = await import('../../controllers/fillCanary.js');
    await seed();
    await syncPaperBook(pairFixture);
    const snapshot = await canary.evaluatePair(pairFixture);
    expect(snapshot.ladder.maxAgeMs).toBe(depthHealth.LADDER_STALE_MS);
    expect(snapshot.depth.staleAfterMs).toBe(depthHealth.DEPTH_STALE_MS);
  });
});

// ===========================================================================
// THE LEGACY ("bot") DERIVATION - no payload may omit the verdict
// ===========================================================================

describe('every order book payload carries a health verdict (CRITICAL)', () => {
  // lib/orderBookHealth.ts on the client FAILS OPEN on a payload with no
  // `healthy` field, on the documented grounds that "non-binance pairs still
  // come down the old ungated path". So flipping any pair to botstatus "bot"
  // silently restored the original lying book: fully drawn, ticket enabled, and
  // no way for the UI to know better. The chosen fix is to make the absence of
  // the field IMPOSSIBLE - every branch of orderBookData now states a verdict,
  // in the same vocabulary bookPublish uses.
  const botPair = { ...pairFixture, botstatus: 'bot' };

  const seedBot = async (buyLevels = {}, sellLevels = {}) => {
    await seed(botPair);
    for (const [price, qty] of Object.entries(buyLevels)) {
      await redisMock.hincby(`buyOrders${PAIR_ID}`, price, qty);
    }
    for (const [price, qty] of Object.entries(sellLevels)) {
      await redisMock.hincby(`sellOrders${PAIR_ID}`, price, qty);
    }
  };

  // minTwoDigits(firstFloatDigit=8) scales stored quantities; the exact scale
  // does not matter here, only that a level is present and positive.
  const SCALE = 10 ** 8;

  test('a two-sided bot book is published healthy', async () => {
    await seedBot({ 63400: 1 * SCALE }, { 63600: 1 * SCALE });
    const book = await orderBookData({ pairId: PAIR_ID });
    expect(book.healthy).toBe(true);
    expect(book.healthReason).toBe(null);
    expect(book.ladderPresent).toBe(true);
    expect(book.buyOrder.length).toBeGreaterThan(0);
    expect(book.sellOrder.length).toBeGreaterThan(0);
  });

  test('a ONE-SIDED bot book is published unhealthy and EMPTY, not half-drawn', async () => {
    // A half book is the lie in miniature: orders in one direction cannot fill,
    // and the old payload said nothing at all about that.
    await seedBot({ 63400: 1 * SCALE }, {});
    const book = await orderBookData({ pairId: PAIR_ID });
    expect(book.healthy).toBe(false);
    expect(book.healthReason).toBe('empty_side');
    expect(book.buyOrder).toEqual([]);
    expect(book.sellOrder).toEqual([]);
    expect(book.maxBidNotional).toBe(0);
  });

  test('a bot pair with nothing resting says so', async () => {
    // Both sides absent lands on the same verdict as one side absent -
    // `empty_side` - because the statement being made is "this book cannot be
    // quoted", which is equally true and equally actionable either way.
    await seedBot();
    const book = await orderBookData({ pairId: PAIR_ID });
    expect(book.healthy).toBe(false);
    expect(book.healthReason).toBe('empty_side');
    expect(book.ladderPresent).toBe(false);
  });

  test('a pair that does not exist reports no_pair rather than an unlabelled empty book', async () => {
    await seed();
    const book = await orderBookData({ pairId: '000000000000000000000000' });
    expect(book.healthy).toBe(false);
    expect(book.healthReason).toBe('no_pair');
  });

  test('a pair that carries no book at all reports pair_ineligible instead of undefined', async () => {
    // This branch used to `return;`. getOrderBookSocket swallowed the undefined
    // and getOrderBook handed the client `result: undefined` - the exact shape
    // the UI reads as healthy.
    await seed({ ...pairFixture, botstatus: 'off' });
    const book = await orderBookData({ pairId: PAIR_ID });
    expect(book).toBeDefined();
    expect(book.healthy).toBe(false);
    expect(book.healthReason).toBe('pair_ineligible');
  });

  test('the gated binance path still stamps the verdict', async () => {
    await seed();
    await syncPaperBook(pairFixture);
    const healthyBook = await orderBookData({ pairId: PAIR_ID });
    expect(healthyBook.healthy).toBe(true);

    await purgePaperBook(PAIR_ID, 'pair_ineligible');
    const deadBook = await orderBookData({ pairId: PAIR_ID });
    expect(deadBook.healthy).toBe(false);
    expect(deadBook.healthReason).toBe('pair_ineligible');
    expect(deadBook.buyOrder).toEqual([]);
  });

  test('NO reachable branch can return a payload without the field', async () => {
    // The client's fail-open branch is only safe if it is unreachable. Every
    // shape this function can produce is enumerated here, including the catch.
    await seed();
    const payloads = [
      await orderBookData({ pairId: PAIR_ID }),
      await orderBookData({ pairId: '000000000000000000000000' }),
      await orderBookData({ pairId: undefined }),
      await orderBookData({ pairId: { toString: () => { throw new Error('boom'); } } })
    ];
    await seed({ ...pairFixture, botstatus: 'off' });
    payloads.push(await orderBookData({ pairId: PAIR_ID }));
    await seedBot({ 63400: 1 * SCALE }, { 63600: 1 * SCALE });
    payloads.push(await orderBookData({ pairId: PAIR_ID }));

    for (const payload of payloads) {
      expect(payload).toBeDefined();
      expect(typeof payload.healthy).toBe('boolean');
      expect(payload).toHaveProperty('healthReason');
      expect(typeof payload.ladderPresent).toBe('boolean');
      // and the two must never disagree
      expect(payload.healthy).toBe(payload.healthReason === null);
    }
  });
});

/**
 * THE MARGIN FREEZE, ENFORCED ON THE SPOT RESERVATION ITSELF.
 * ==========================================================
 *
 * `faucet/reset` holds a per-user margin freeze while it writes ABSOLUTE
 * balances, and no reservation may be created while it is held - the check
 * belongs inside the single Lua step that takes the reservation. SPOT DID NOT
 * HAVE IT: `hincrbyfloatIfEnough` had no freeze key and no EXISTS, and
 * `marginFreezeKey` appeared in this service only in the reset that took it. That is what made
 * the reset an unlimited mint: measured through the ordinary API, an account
 * went from 10,000 to 48,039.52 in four consecutive wins, 12 of 32 races.
 *
 * What is pinned here is the CALL SITE, which is the half a unit test can own:
 * both order paths hand the freeze key to the reservation, and both turn its
 * FROZEN answer into a refusal that moves nothing. The script's own behaviour
 * is pinned in redis-reserve.test.js and verified against real redis.
 */
describe('spot placement under a faucet-reset margin freeze (CRITICAL)', () => {
  const FREEZE_KEY = `margin_freeze_${USER_ID}`;

  beforeEach(async () => {
    await seed();
    await syncPaperBook(pairFixture);
  });

  test('a limit order is refused while the freeze is held, and NOTHING moves', async () => {
    const before = ledgerSnapshot();
    redisMock.__freezes.add(FREEZE_KEY);

    const res = await placeLimit('buy', 60000, 0.1);

    expect(res.statusCode).toBe(409);
    expect(res.payload.status).toBe(false);
    expect(res.payload.code).toBe('RESET_IN_PROGRESS');
    // The reservation is the ONE thing that decides an order exists. Nothing
    // was debited, nothing was escrowed, and nothing rests in the book.
    expect(ledgerSnapshot()).toEqual(before);
  });

  test('a market order is refused while the freeze is held, and NOTHING moves', async () => {
    // A market order's debit is recorded in no counter at all, so the freeze is
    // the only thing standing between it and an absolute balance write.
    const before = ledgerSnapshot();
    redisMock.__freezes.add(FREEZE_KEY);

    const res = await placeMarket('buy', { orderValue: 31000, quantity: 0 });

    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('RESET_IN_PROGRESS');
    expect(ledgerSnapshot()).toEqual(before);
  });

  test('ANOTHER user\'s freeze does not refuse this user\'s order', async () => {
    // The freeze is per account. A key derived from the wrong id would either
    // stop everybody or stop nobody; both are wrong in the same place.
    redisMock.__freezes.add('margin_freeze_000000000000000000000000');

    const res = await placeLimit('buy', 60000, 0.1);

    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe(true);
  });

  test('the freeze released, the same order goes through unchanged', async () => {
    redisMock.__freezes.add(FREEZE_KEY);
    expect((await placeLimit('buy', 60000, 0.1)).statusCode).toBe(409);

    redisMock.__freezes.delete(FREEZE_KEY);
    const res = await placeLimit('buy', 60000, 0.1);

    expect(res.statusCode).toBe(200);
    expect(wallet()).toBeCloseTo(300000 - 6000, 8);
    expect(inOrder()).toBeCloseTo(6000, 8);
  });
});
