/**
 * THE IN-ORDER RESERVATION ROUND TRIP (CRITICAL - REGRESSION)
 *
 * `walletbalance_spot_inOrder` is the counter that says how much of a user's
 * spot balance is escrowed behind their own resting limit orders. Every client
 * subtracts it from the balance it shows, so a number that is too high is money
 * the user cannot see and cannot spend.
 *
 * THE DEFECT
 * ----------
 * The credit and the debits were computed from DIFFERENT numbers:
 *
 *     reserve   inOrder += P * Q            once, at placement
 *     release   inOrder -= P * q1, P * q2   once per fill
 *               inOrder -= P * Qrem         on the cancel / last fill
 *
 * Those are equal in real arithmetic and not in binary floating point, and the
 * matcher makes it worse by REWRITING the resting quantity through
 * `toFixed(..., firstFloatDigit)` after every partial fill - so the remainder
 * that gets released is a rounded version of the one the reservation was taken
 * on. releaseInOrder clamps at zero, which makes the drift one-directional:
 * over-releases are absorbed, under-releases are kept forever.
 *
 * MEASURED ON THE RUNNING STACK before the fix:
 * `cryptodex_walletbalance_spot_inOrder` held
 * `6a70f1c287c92c7218ac37fc_695bf0e2b9aba016fb8ce3c4` (USD) =
 * 0.00000000000090949 - exactly 2**-40 - for an account with NO open orders at
 * all, after 147 limit placements and 132 cancels.
 *
 * THE FIX, and what each test below pins:
 *   - the exact number credited is stamped on the order (`inOrderReserved`),
 *   - the release that RETIRES the order gives back exactly what is left of it,
 *   - and a bounded sweep returns the last unowned residue once nothing of the
 *     user's still reserves that currency.
 *
 * The equality assertions here are deliberately `toBe(0)` and not
 * `toBeCloseTo(0)`: "close to neutral" is precisely the bug.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

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
      },
      // cancelOrderForDeactiveAcc marks every pending/open order cancelled in
      // mongo before it walks the redis book.
      updateMany: async (filter, update) => {
        savedOrders.push({ filter, update });
        return { modifiedCount: 0 };
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
  const ledgers = new Map();
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
    // Plain IEEE-754 addition, exactly like redis' own HINCRBYFLOAT on the
    // values this service stores. The drift under test is arithmetic, so the
    // stand-in must not be more exact than the real thing.
    hincbyfloat: async (key, field, increment) => {
      const map = hash(key);
      const current = parseFloat(map.get(String(field)) || 0);
      const next = current + parseFloat(increment);
      map.set(String(field), String(next));
      return String(next);
    },
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
  return { __esModule: true, __state: state, getDepthSnapshot: () => state.book };
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
  limitOrderPlace,
  cancelOrder,
  cancelMarketOrder,
  createTradeHistory,
  cancelOrderForDeactiveAcc,
  releaseInOrder,
  reservationRemaining,
  sweepResidualInOrder,
  reservedCurrencyOf,
  RESIDUAL_IN_ORDER_DUST,
} from '../../controllers/spot.controller.js';
import * as redisMock from '../../controllers/redis.controller.js';
import * as wsMock from '../../lib/binanceWebSocket.js';

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

const inOrder = (userId, currencyId) => {
  const map = redisMock.__hashes.get('walletbalance_spot_inOrder');
  return parseFloat((map && map.get(`${userId}_${currencyId}`)) || 0);
};

const userOrders = (side) => {
  const map = redisMock.__hashes.get(`${side}OpenOrders_${PAIR_ID}`);
  if (!map) return [];
  return Array.from(map.values())
    .map((v) => JSON.parse(v))
    .filter((o) => !o.isPaper);
};

const seed = async () => {
  redisMock.__reset();
  await redisMock.hset('spotPairdata', PAIR_ID, pairFixture);
  await redisMock.hset('admin_liquidity', 'liquidation', {
    _id: ADMIN_ID,
    userId: '12024756'
  });
  await redisMock.hincbyfloat('walletbalance_spot', `${USER_ID}_${USD_ID}`, 300000);
  await redisMock.hincbyfloat('walletbalance_spot', `${USER_ID}_${BTC_ID}`, 5);
  await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 0);
  await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`, 0);
  wsMock.__state.book = {
    lastUpdateId: 1,
    updatedAt: Date.now(),
    bids: [{ price: 63499, quantity: 0.5 }],
    asks: [{ price: 63500, quantity: 0.5 }]
  };
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

const cancel = async (orderId, side) => {
  const res = mockRes();
  await cancelOrder(
    {
      body: { id: { tableId: `${side}OpenOrders_${PAIR_ID}`, orderId } },
      user: { id: USER_ID }
    },
    res
  );
  return res;
};

/** A limit order as the book stores one, with a reservation already stamped. */
const restingOrder = (over = {}) => ({
  _id: 'o1',
  userId: USER_ID,
  pairId: PAIR_ID,
  firstCurrencyId: BTC_ID,
  secondCurrencyId: USD_ID,
  orderType: 'limit',
  buyorsell: 'buy',
  flag: false,
  isPaper: false,
  ...over
});

beforeEach(async () => {
  await seed();
});

// ===========================================================================
// THE ARITHMETIC THE BUG IS MADE OF
// ===========================================================================

describe('the drift this file exists for is real (CRITICAL)', () => {
  test('P*q1 + P*q2 is NOT P*(q1+q2) - the premise, stated so it cannot silently stop being true', () => {
    const P = 63500.17;
    const q1 = 0.1;
    const q2 = 0.2;
    const perFill = P * q1 + P * q2;
    const reserved = P * (q1 + q2);
    // If this ever becomes exact the fix is still correct, but the measured
    // residue below would no longer be reproducible from these operands.
    expect(perFill).not.toBe(reserved);
    expect(Math.abs(perFill - reserved)).toBeLessThan(1e-9);
  });
});

// ===========================================================================
// THE RESERVATION IS CARRIED ON THE ORDER
// ===========================================================================

describe('the exact reservation is stamped on the order (CRITICAL)', () => {
  test('a placed limit BUY carries inOrderReserved equal to the credit it made', async () => {
    const price = 63500.17;
    const quantity = 0.3;
    expect((await placeLimit('buy', price, quantity)).statusCode).toBe(200);

    const order = userOrders('buy')[0];
    expect(order.inOrderReserved).toBe(price * quantity);
    expect(order.inOrderReleased).toBe(0);
    // and it is exactly what the ledger was credited with
    expect(inOrder(USER_ID, USD_ID)).toBe(price * quantity);
  });

  test('a placed limit SELL reserves the QUANTITY, in the base currency', async () => {
    expect((await placeLimit('sell', 64000, 0.125)).statusCode).toBe(200);
    const order = userOrders('sell')[0];
    expect(order.inOrderReserved).toBe(0.125);
    expect(inOrder(USER_ID, BTC_ID)).toBe(0.125);
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
  });

  test('reservationRemaining reports what is left, and null for an order that never had one', () => {
    expect(reservationRemaining(restingOrder({ inOrderReserved: 100, inOrderReleased: 30 }))).toBe(70);
    expect(reservationRemaining(restingOrder({ inOrderReserved: 100 }))).toBe(100);
    // never over-reports, even if the released total has run past the reserve
    expect(reservationRemaining(restingOrder({ inOrderReserved: 100, inOrderReleased: 140 }))).toBe(0);
    // a legacy order, written before the field existed
    expect(reservationRemaining(restingOrder())).toBe(null);
    expect(reservationRemaining(null)).toBe(null);
  });

  test('reservedCurrencyOf names the coin the reservation is denominated in', () => {
    expect(reservedCurrencyOf(restingOrder({ buyorsell: 'buy' }))).toBe(USD_ID);
    expect(reservedCurrencyOf(restingOrder({ buyorsell: 'sell' }))).toBe(BTC_ID);
  });
});

// ===========================================================================
// THE ROUND TRIP IS EXACTLY NEUTRAL
// ===========================================================================

describe('a full reserve/release round trip leaves EXACTLY zero (CRITICAL)', () => {
  test('place then cancel returns the ledger to zero to the last bit', async () => {
    // A price and quantity whose product is not representable, so that any
    // re-derived release would leave a residue.
    expect((await placeLimit('buy', 63500.17, 0.3)).statusCode).toBe(200);
    const order = userOrders('buy')[0];
    expect(inOrder(USER_ID, USD_ID)).toBeGreaterThan(0);

    expect((await cancel(order._id, 'buy')).statusCode).toBe(200);

    // toBe, not toBeCloseTo: 2**-40 left behind IS the bug.
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
    // And the cancel gave back the WHOLE reservation on its own, before the
    // sweep could ever be asked to help: the two guards are independent, and
    // this is the one that has to be exact.
    const cancelled = JSON.parse(
      redisMock.__hashes.get(`orderHistory_${USER_ID}`).get(order._id)
    );
    expect(cancelled.inOrderReleased).toBe(cancelled.inOrderReserved);
  });

  test('partial releases followed by the retiring one still land exactly on zero', async () => {
    const price = 63500.17;
    const quantity = 0.3;
    expect((await placeLimit('buy', price, quantity)).statusCode).toBe(200);
    const order = userOrders('buy')[0];

    // Two small partial fills, then the fill that empties it. Every amount is
    // the same re-derived product the matcher passes in - and this particular
    // schedule is one where the three products do NOT sum to the reserve
    // (63500.17 * 0.01 + * 0.02 + * 0.26999999999999996 falls 3.6e-12 short of
    // 63500.17 * 0.3), which is exactly the residue that used to be kept.
    await releaseInOrder(order, USD_ID, price * 0.01);
    await releaseInOrder(order, USD_ID, price * 0.02);
    expect(inOrder(USER_ID, USD_ID)).toBeGreaterThan(0);

    await releaseInOrder(order, USD_ID, price * (quantity - 0.01 - 0.02), {
      final: true,
    });

    expect(inOrder(USER_ID, USD_ID)).toBe(0);
    expect(reservationRemaining(order)).toBe(0);
    // Independently of the ledger and of the sweep: what the order gave back
    // over its whole life is exactly what it took.
    expect(order.inOrderReleased).toBe(order.inOrderReserved);
  });

  /**
   * THE ROUNDED-REMAINDER CASE, which is not float dust at all.
   *
   * After every partial fill the matcher rewrites the resting quantity as
   * `toFixed(remaining, firstFloatDigit)` (buyExcAmount / sellExcAmount). The
   * cancel path then refunds `price * that rounded quantity`, so whenever the
   * rounding went DOWN the difference - a real, visible amount of quote
   * currency, not a last-bit residue - stayed escrowed behind an order that no
   * longer existed. It is far above any dust ceiling, so nothing swept it.
   */
  test('a partially filled order cancelled after the matcher rounded its remainder is still exactly neutral', async () => {
    const price = 63500.17;
    const quantity = 0.1234499;
    const floatDigit = 4; // the pair's firstFloatDigit, as the matcher uses it

    expect((await placeLimit('buy', price, quantity)).statusCode).toBe(200);
    const order = userOrders('buy')[0];
    const reserved = order.inOrderReserved;
    expect(reserved).toBe(price * quantity);

    // A partial fill of 0.05, settled exactly as the matcher settles one.
    await releaseInOrder(order, USD_ID, price * 0.05);
    order.quantity = parseFloat((quantity - 0.05).toFixed(floatDigit));
    expect(order.quantity).toBe(0.0734); // rounded DOWN, by 0.0000499
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, order._id, order);

    // The cancel's own arithmetic under-states the remainder by
    // 63500.17 * 0.0000499 = 3.17 USD - which used to stay escrowed forever.
    expect((await cancel(order._id, 'buy')).statusCode).toBe(200);

    expect(inOrder(USER_ID, USD_ID)).toBe(0);
  });

  test('the retiring release is the WHOLE remainder, not the amount the caller asked for', async () => {
    const order = restingOrder({ inOrderReserved: 500, inOrderReleased: 200 });
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 300);

    // The caller's number is wrong in the direction that used to strand money:
    // it under-states the remainder by 50.
    await releaseInOrder(order, USD_ID, 250, { final: true });

    expect(inOrder(USER_ID, USD_ID)).toBe(0);
  });

  test('a NON-retiring release can never give back more than the order still holds', async () => {
    const order = restingOrder({ inOrderReserved: 100, inOrderReleased: 0 });
    // Another of this user's orders is holding 400 of the same currency.
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 500);

    // A caller asking for 999 must not be able to eat the other order's escrow.
    await releaseInOrder(order, USD_ID, 999);

    expect(inOrder(USER_ID, USD_ID)).toBe(400);
    expect(reservationRemaining(order)).toBe(0);
  });

  test('two partial releases cannot double-count: the second sees what the first gave back', async () => {
    const order = restingOrder({ inOrderReserved: 100 });
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 100);

    await releaseInOrder(order, USD_ID, 60);
    expect(reservationRemaining(order)).toBe(40);
    await releaseInOrder(order, USD_ID, 60);

    expect(inOrder(USER_ID, USD_ID)).toBe(0);
    expect(reservationRemaining(order)).toBe(0);
  });
});

// ===========================================================================
// THE EXEMPTIONS SURVIVE (they are the reason this helper exists at all)
// ===========================================================================

describe('market orders and paper liquidity still never release (CRITICAL)', () => {
  test('a MARKET order releases nothing even when it carries a reservation field', async () => {
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 500);
    const out = await releaseInOrder(
      restingOrder({ flag: true, inOrderReserved: 500 }),
      USD_ID,
      500,
      { final: true }
    );
    expect(out).toBe(null);
    expect(inOrder(USER_ID, USD_ID)).toBe(500);
  });

  test('PAPER ladder liquidity releases nothing, retiring or not', async () => {
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${ADMIN_ID}_${BTC_ID}`, 0);
    const out = await releaseInOrder(
      restingOrder({ userId: ADMIN_ID, isPaper: true, inOrderReserved: 2 }),
      BTC_ID,
      2,
      { final: true }
    );
    expect(out).toBe(null);
    expect(inOrder(ADMIN_ID, BTC_ID)).toBe(0);
  });

  test('an order written before inOrderReserved existed behaves exactly as it used to', async () => {
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 100);
    // No reservation on the order: the caller's amount is authoritative, and
    // the clamp at the ledger is the only bound - the old behaviour.
    await releaseInOrder(restingOrder(), USD_ID, 30);
    expect(inOrder(USER_ID, USD_ID)).toBe(70);
    await releaseInOrder(restingOrder(), USD_ID, 999);
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
  });
});

// ===========================================================================
// THE BOUNDED SWEEP
// ===========================================================================

describe('the residual sweep returns unowned dust, and only dust (CRITICAL)', () => {
  test('dust is returned once nothing of the user reserves that currency', async () => {
    await redisMock.hincbyfloat(
      'walletbalance_spot_inOrder',
      `${USER_ID}_${USD_ID}`,
      9.0949e-13
    );
    const out = await sweepResidualInOrder(USER_ID, USD_ID);
    expect(out).not.toBe(null);
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
  });

  test('a resting limit order of the SAME user in the SAME currency blocks the sweep', async () => {
    expect((await placeLimit('buy', 63000, 0.001)).statusCode).toBe(200);
    const held = inOrder(USER_ID, USD_ID);
    expect(held).toBeGreaterThan(0);

    // Dust on top of a live reservation is not sweepable: the ledger is above
    // the ceiling, and even if it were not, the order is still resting.
    await sweepResidualInOrder(USER_ID, USD_ID);
    expect(inOrder(USER_ID, USD_ID)).toBe(held);
  });

  test('a resting order blocks the sweep even when the residue is BELOW the ceiling', async () => {
    // The window the ceiling exists for, made explicit: the ledger is credited
    // before the order reaches the book, so the scan is what proves ownership.
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'live1', {
      _id: 'live1',
      userId: USER_ID,
      orderType: 'limit',
      buyorsell: 'buy',
      firstCurrencyId: BTC_ID,
      secondCurrencyId: USD_ID,
      isPaper: false,
      flag: false
    });
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 5e-8);

    await sweepResidualInOrder(USER_ID, USD_ID);
    expect(inOrder(USER_ID, USD_ID)).toBe(5e-8);
  });

  test('anything ABOVE the dust ceiling is left alone - a real reservation is never swept', async () => {
    const real = RESIDUAL_IN_ORDER_DUST * 10;
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, real);
    await sweepResidualInOrder(USER_ID, USD_ID);
    expect(inOrder(USER_ID, USD_ID)).toBe(real);
  });

  test('an order in a DIFFERENT currency does not block the sweep', async () => {
    // A resting SELL reserves BTC, so it says nothing about the USD residue.
    expect((await placeLimit('sell', 64000, 0.01)).statusCode).toBe(200);
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 1e-12);

    await sweepResidualInOrder(USER_ID, USD_ID);
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
    // and the BTC reservation behind the live order is untouched
    expect(inOrder(USER_ID, BTC_ID)).toBe(0.01);
  });

  test('ANOTHER user\'s resting order does not block, and their ledger is untouched', async () => {
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'other1', {
      _id: 'other1',
      userId: '6a70fe409c46d957cd45ba3a',
      orderType: 'limit',
      buyorsell: 'buy',
      firstCurrencyId: BTC_ID,
      secondCurrencyId: USD_ID,
      isPaper: false,
      flag: false
    });
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 1e-12);
    await redisMock.hincbyfloat(
      'walletbalance_spot_inOrder',
      `6a70fe409c46d957cd45ba3a_${USD_ID}`,
      63
    );

    await sweepResidualInOrder(USER_ID, USD_ID);
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
    expect(inOrder('6a70fe409c46d957cd45ba3a', USD_ID)).toBe(63);
  });

  test('a zero or negative ledger is not "dust" - the sweep writes nothing', async () => {
    expect(await sweepResidualInOrder(USER_ID, USD_ID)).toBe(null);
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
    expect(await sweepResidualInOrder(null, USD_ID)).toBe(null);
    expect(await sweepResidualInOrder(USER_ID, null)).toBe(null);
  });

  test('with no pair cache the sweep refuses: ownership cannot be proven', async () => {
    redisMock.__hashes.delete('spotPairdata');
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 1e-12);
    expect(await sweepResidualInOrder(USER_ID, USD_ID)).toBe(null);
    expect(inOrder(USER_ID, USD_ID)).toBe(1e-12);
  });

  test('the sweep moves the RESERVATION counter only - walletbalance_spot is untouched', async () => {
    const map = redisMock.__hashes.get('walletbalance_spot');
    const before = map.get(`${USER_ID}_${USD_ID}`);
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 1e-12);
    await sweepResidualInOrder(USER_ID, USD_ID);
    expect(map.get(`${USER_ID}_${USD_ID}`)).toBe(before);
  });

  test('the retiring release sweeps on its way out - a cancel leaves nothing behind', async () => {
    expect((await placeLimit('buy', 63500.17, 0.3)).statusCode).toBe(200);
    const order = userOrders('buy')[0];
    // Plant residue from an EARLIER order of the same user, of the kind the old
    // code accumulated. Retiring this order must clear the whole field.
    //
    // 5e-8 rather than the 2**-40 measured live: one ULP of 19050.051 is about
    // 3.6e-12, so a residue that small would be absorbed by the addition itself
    // and the test would assert nothing. It is still an order of magnitude
    // under RESIDUAL_IN_ORDER_DUST, which is what the sweep is bounded by.
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 5e-8);

    expect((await cancel(order._id, 'buy')).statusCode).toBe(200);
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
  });
});

// ===========================================================================
// THE DEACTIVATION CANCEL PATH (CRITICAL - REGRESSION)
// ===========================================================================
//
// `cancelOrderForDeactiveAcc` -> `createTradeHistory` is `cancelOrder` for
// orders the user is not cancelling themselves. It credited
// `walletbalance_spot` by the retrieved value and NEVER released
// `walletbalance_spot_inOrder`, so every cancellation down that path returned
// the money to the total while leaving the reservation standing. Free balance
// is total-minus-in-order everywhere it is shown, so the user permanently lost
// the use of it.
//
// REPRODUCED ON THE RUNNING STACK before the fix: a 30 USD resting limit buy on
// BTC/USD, cancelled through the service's own gRPC
// `Req.cancelOrderForDeactiveAcc`, put `walletbalance_spot` back to 20000 and
// left `walletbalance_spot_inOrder` at 30 with an empty open-order hash.
//
// The assertions are `toBe`, not `toBeCloseTo`, for the reason stated at the
// top of this file.

const spotBalance = (userId, currencyId) => {
  const map = redisMock.__hashes.get('walletbalance_spot');
  return parseFloat((map && map.get(`${userId}_${currencyId}`)) || 0);
};

/** A resting order as limitOrderPlace writes one, with its reservation stamped. */
const restingLimit = (over = {}) => ({
  _id: 'd1',
  userId: USER_ID,
  pairId: PAIR_ID,
  firstCurrencyId: BTC_ID,
  secondCurrencyId: USD_ID,
  firstCurrency: 'BTC',
  secondCurrency: 'USD',
  firstFloatDigit: 8,
  orderType: 'limit',
  buyorsell: 'buy',
  price: 30000,
  quantity: 0.001,
  amount: 0.001,
  liquidityType: 'off',
  flag: false,
  isPaper: false,
  inOrderReserved: 30,
  inOrderReleased: 0,
  ...over
});

describe('the deactivation cancel releases the reservation too (CRITICAL)', () => {
  test('a limit BUY cancelled for a deactivated account leaves BOTH ledgers where they started', async () => {
    expect((await placeLimit('buy', 30000, 0.001)).statusCode).toBe(200);
    const order = userOrders('buy')[0];
    const balanceAfterPlace = spotBalance(USER_ID, USD_ID);
    expect(inOrder(USER_ID, USD_ID)).toBe(30);
    expect(balanceAfterPlace).toBe(300000 - 30);

    expect(await cancelOrderForDeactiveAcc({ userId: USER_ID })).toEqual({
      status: true
    });

    // The money came back...
    expect(spotBalance(USER_ID, USD_ID)).toBe(300000);
    // ...and so did the use of it. This is the assertion that used to fail: the
    // reservation stayed at 30 behind an order that no longer existed.
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
    expect(userOrders('buy')).toHaveLength(0);
  });

  test('a limit SELL cancelled for a deactivated account releases the BASE currency', async () => {
    expect((await placeLimit('sell', 99000, 0.0011)).statusCode).toBe(200);
    expect(inOrder(USER_ID, BTC_ID)).toBe(0.0011);

    await cancelOrderForDeactiveAcc({ userId: USER_ID });

    expect(spotBalance(USER_ID, BTC_ID)).toBe(5);
    expect(inOrder(USER_ID, BTC_ID)).toBe(0);
    // the quote ledger of the same user is untouched
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
  });

  test('several orders across pairs and currencies are all released in one sweep', async () => {
    expect((await placeLimit('buy', 30000, 0.0004)).statusCode).toBe(200);
    expect((await placeLimit('buy', 30001.17, 0.0007)).statusCode).toBe(200);
    expect((await placeLimit('sell', 99000, 0.0009)).statusCode).toBe(200);
    expect(inOrder(USER_ID, USD_ID)).toBeGreaterThan(0);
    expect(inOrder(USER_ID, BTC_ID)).toBeGreaterThan(0);

    await cancelOrderForDeactiveAcc({ userId: USER_ID });

    expect(spotBalance(USER_ID, USD_ID)).toBe(300000);
    expect(spotBalance(USER_ID, BTC_ID)).toBe(5);
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
    expect(inOrder(USER_ID, BTC_ID)).toBe(0);
  });

  test('ANOTHER user resting on the same book is not cancelled and keeps their reservation', async () => {
    const OTHER = '6a70fe409c46d957cd45ba3a';
    expect((await placeLimit('buy', 30000, 0.001)).statusCode).toBe(200);
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'other1', {
      ...restingLimit({ _id: 'other1', userId: OTHER })
    });
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${OTHER}_${USD_ID}`, 30);

    await cancelOrderForDeactiveAcc({ userId: USER_ID });

    expect(inOrder(USER_ID, USD_ID)).toBe(0);
    expect(inOrder(OTHER, USD_ID)).toBe(30);
    expect(spotBalance(OTHER, USD_ID)).toBe(0);
    const book = redisMock.__hashes.get(`buyOpenOrders_${PAIR_ID}`);
    expect(book.has('other1')).toBe(true);
  });

  test('the retired order records the release, so a second pass gives nothing back twice', async () => {
    expect((await placeLimit('buy', 30000, 0.001)).statusCode).toBe(200);
    const placed = userOrders('buy')[0];

    await cancelOrderForDeactiveAcc({ userId: USER_ID });
    expect(inOrder(USER_ID, USD_ID)).toBe(0);

    // What was persisted into orderHistory carries the closed book, which is
    // what makes the double-release impossible rather than merely unlikely.
    const settled = JSON.parse(
      redisMock.__hashes.get(`orderHistory_${USER_ID}`).get(placed._id)
    );
    expect(settled.inOrderReleased).toBe(settled.inOrderReserved);

    // Another of the user's orders is holding 500 of the same currency; a
    // replayed cancel of the retired order must not eat it.
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 500);
    await createTradeHistory(settled);
    expect(inOrder(USER_ID, USD_ID)).toBe(500);
  });

  test('a partially filled order whose remainder the matcher ROUNDED is still exactly neutral', async () => {
    // The same case the user-facing cancel is pinned on above: the refund
    // arithmetic under-states the remainder by 63500.17 * 0.0000499 = 3.17 USD,
    // which is far above any dust ceiling and would simply stay escrowed.
    const price = 63500.17;
    const quantity = 0.1234499;

    expect((await placeLimit('buy', price, quantity)).statusCode).toBe(200);
    const order = userOrders('buy')[0];
    expect(order.inOrderReserved).toBe(price * quantity);

    await releaseInOrder(order, USD_ID, price * 0.05);
    order.quantity = parseFloat((quantity - 0.05).toFixed(4));
    expect(order.quantity).toBe(0.0734);
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, order._id, order);

    await cancelOrderForDeactiveAcc({ userId: USER_ID });

    expect(inOrder(USER_ID, USD_ID)).toBe(0);
  });

  test('the exemptions survive the deactivation path: a MARKET order releases nothing', async () => {
    // A market order debited walletbalance_spot and never credited in-order.
    // Releasing one here would drive the reservation ledger NEGATIVE - and this
    // user has 400 legitimately escrowed behind another order.
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 400);
    await createTradeHistory(
      restingLimit({
        orderType: 'market',
        flag: true,
        price: 'market',
        orderValue: 30,
        inOrderReserved: undefined,
        inOrderReleased: undefined
      })
    );
    expect(inOrder(USER_ID, USD_ID)).toBe(400);
  });

  test('the exemptions survive the deactivation path: PAPER ladder liquidity releases nothing', async () => {
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${ADMIN_ID}_${USD_ID}`, 0);
    await createTradeHistory(
      restingLimit({ userId: ADMIN_ID, isPaper: true, inOrderReserved: 30 })
    );
    expect(inOrder(ADMIN_ID, USD_ID)).toBe(0);
  });

  test('a release can never exceed what the ledger actually holds', async () => {
    // A legacy order (no inOrderReserved) whose recomputed value is larger than
    // anything reserved: the clamp inside releaseInOrder is the only bound.
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 5);
    await createTradeHistory(
      restingLimit({ inOrderReserved: undefined, inOrderReleased: undefined })
    );
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
  });
});

// ===========================================================================
// cancelMarketOrder - THE SAME INVARIANT, MADE STRUCTURAL
// ===========================================================================

describe('cancelMarketOrder keeps the two ledgers together (CRITICAL)', () => {
  test('a MARKET order refund credits the balance and does NOT touch the reservation', async () => {
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 400);
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'm1', {
      ...restingLimit({
        _id: 'm1',
        orderType: 'market',
        flag: true,
        price: 'market',
        orderValue: 30,
        inOrderReserved: undefined,
        inOrderReleased: undefined
      })
    });
    const before = spotBalance(USER_ID, USD_ID);

    expect(await cancelMarketOrder(`buyOpenOrders_${PAIR_ID}`, 'm1')).toBe(true);

    expect(spotBalance(USER_ID, USD_ID)).toBe(before + 30);
    expect(inOrder(USER_ID, USD_ID)).toBe(400);
  });

  test('handed a resting LIMIT order it refunds the reservation and releases it exactly once', async () => {
    // No live call site passes one today; the function computes the limit
    // refund itself, so the invariant may not depend on that staying true.
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 30);
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'l1', restingLimit({ _id: 'l1' }));
    const before = spotBalance(USER_ID, USD_ID);

    expect(await cancelMarketOrder(`buyOpenOrders_${PAIR_ID}`, 'l1')).toBe(true);

    expect(spotBalance(USER_ID, USD_ID)).toBe(before + 30);
    expect(inOrder(USER_ID, USD_ID)).toBe(0);

    // The claim is what makes it once: the row is gone, so a replay refunds
    // nothing and releases nothing.
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 30);
    expect(await cancelMarketOrder(`buyOpenOrders_${PAIR_ID}`, 'l1')).toBe(true);
    expect(spotBalance(USER_ID, USD_ID)).toBe(before + 30);
    expect(inOrder(USER_ID, USD_ID)).toBe(30);
  });
});

// ===========================================================================
// THE GUARD IS `orderType`, NOT `flag` - and it has to be
// ===========================================================================
//
// Both refund paths decide WHAT to give back from `orderType`: a "limit" order
// is refunded `price * quantity` (the reservation), anything else is refunded
// `orderValue` / `amount` (the raw debit). The release has to be gated on the
// same field, because the amount it would release is the one `orderType`
// selected.
//
// `releaseInOrder`'s own `flag === true` exemption is NOT a substitute. It is a
// property of orders that marketOrderPlace wrote; nothing guarantees it on an
// order that reaches these functions from anywhere else - the SpotOrder schema
// (models/) has no `flag` field at all, and neither does any row written before
// it was introduced. Gate the release on the same field the refund was gated
// on, or a market order refunded `orderValue` releases `orderValue` out of
// somebody else's escrow.

describe('a NON-limit order releases nothing, whatever else it carries (CRITICAL)', () => {
  /** Market order as a document with no `flag` field - the shape the exemption misses. */
  const flaglessMarket = (over = {}) => ({
    _id: 'nf1',
    userId: USER_ID,
    pairId: PAIR_ID,
    firstCurrencyId: BTC_ID,
    secondCurrencyId: USD_ID,
    firstCurrency: 'BTC',
    secondCurrency: 'USD',
    firstFloatDigit: 8,
    orderType: 'market',
    buyorsell: 'buy',
    price: 'market',
    quantity: 0.001,
    amount: 0.001,
    orderValue: 30,
    liquidityType: 'off',
    isPaper: false,
    ...over
  });

  test('deactivation cancel of a flagless MARKET order does not touch the reservation ledger', async () => {
    // 400 is escrowed behind a DIFFERENT, still-resting order of this user.
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 400);
    const before = spotBalance(USER_ID, USD_ID);

    await createTradeHistory(flaglessMarket());

    expect(spotBalance(USER_ID, USD_ID)).toBe(before + 30);
    expect(inOrder(USER_ID, USD_ID)).toBe(400);
  });

  test('cancelMarketOrder of a flagless MARKET order does not touch the reservation ledger', async () => {
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 400);
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'nf1', flaglessMarket());
    const before = spotBalance(USER_ID, USD_ID);

    expect(await cancelMarketOrder(`buyOpenOrders_${PAIR_ID}`, 'nf1')).toBe(true);

    expect(spotBalance(USER_ID, USD_ID)).toBe(before + 30);
    expect(inOrder(USER_ID, USD_ID)).toBe(400);
  });
});

describe('cancelMarketOrder releases the REMAINDER, not the recomputed product', () => {
  test('a matcher-rounded partial remainder is still exactly neutral', async () => {
    // Same shape as the cancelOrder case above: after a partial fill the
    // matcher rewrote the resting quantity as toFixed(remaining, 4), rounding
    // it DOWN by 0.0000499 - so price * quantity under-states what is still
    // escrowed by 63500.17 * 0.0000499 = 3.17 USD. Only a RETIRING release,
    // which gives back the whole remainder of the order's own reservation,
    // lands on zero.
    const price = 63500.17;
    const quantity = 0.1234499;
    const reserved = price * quantity;
    const releasedSoFar = price * 0.05;

    await redisMock.hincbyfloat(
      'walletbalance_spot_inOrder',
      `${USER_ID}_${USD_ID}`,
      reserved - releasedSoFar
    );
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'r1', {
      ...restingLimit({
        _id: 'r1',
        price,
        quantity: parseFloat((quantity - 0.05).toFixed(4)),
        inOrderReserved: reserved,
        inOrderReleased: releasedSoFar
      })
    });

    expect(await cancelMarketOrder(`buyOpenOrders_${PAIR_ID}`, 'r1')).toBe(true);

    expect(inOrder(USER_ID, USD_ID)).toBe(0);
  });

  test('for a LEGACY order with no stamped reservation the refunded amount is the release', async () => {
    // Written before `inOrderReserved` existed: there is no remainder to read,
    // so the amount handed to the helper is the only authority it has, and the
    // ledger clamp is the only bound. Refund 30 against a ledger holding 5.
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`, 5);
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'g1', {
      ...restingLimit({
        _id: 'g1',
        inOrderReserved: undefined,
        inOrderReleased: undefined
      })
    });
    const before = spotBalance(USER_ID, USD_ID);

    expect(await cancelMarketOrder(`buyOpenOrders_${PAIR_ID}`, 'g1')).toBe(true);

    expect(spotBalance(USER_ID, USD_ID)).toBe(before + 30);
    expect(inOrder(USER_ID, USD_ID)).toBe(0);
  });
});
