/**
 * THE PAIR'S PRECISION IS A RULE, NOT A DISPLAY PREFERENCE
 * ========================================================
 *
 * THE DEFECT, MEASURED LIVE on this stack with an ordinary account. A BTCUSD
 * limit order priced 63510.631 - three decimals on a pair whose
 * `secondFloatDigit` is 2 - and sized 0.0012345678912345 BTC - sixteen decimals
 * on a pair whose `firstFloatDigit` is 8 - was accepted, escrowed, rested, and
 * PUBLISHED at the top of the public order book. Nothing anywhere on the order
 * path compared either number against the pair's stated precision: the
 * validator refused zero, negative, NaN, Infinity, booleans, arrays, objects
 * and null, and enforced minQuantity/maxQuantity, but never counted decimals.
 *
 * WHY IT MATTERS, in the two ways it matters:
 *
 *   THE QUEUE. Price orders the book. A price finer than the tick puts one
 *   order in front of the entire resting ladder for a fraction of a cent the
 *   venue cannot quote - a queue jump available to anyone who can type a third
 *   decimal, on a venue whose whole product is the fairness of that queue.
 *
 *   THE ADVERTISEMENT. The published book then quotes a level the pair cannot
 *   express, so the price the venue shows is not a price it can trade at.
 *
 * THE RULE, and the asymmetry that is the whole design (argued in full above
 * `quantiseOrderSize` in controllers/spot.controller.js, under PRICE IS
 * REFUSED, SIZE IS QUANTISED):
 *
 *   PRICE  -> REFUSED. A limit price is an instruction about terms, there is no
 *             safe direction to move it in, and it is the field that carries
 *             the queue-jump.
 *   SIZE   -> TRUNCATED DOWN, and the response says so. The engine already
 *             truncates every size it handles (market-buy quantisation, every
 *             partial-fill remainder); truncation can only ever shrink an
 *             order; and "sell everything I hold" has to stay expressible when
 *             the holding is 0.10000000987588606 BTC.
 *
 * These tests are written against the mistakes that would undo it - refusing a
 * price the pair CAN express, truncating with the wrong pair field, letting a
 * missing precision default to two decimal places, or charging for a size that
 * differs from the one that rests.
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
  marketOrderPlace,
  matchingcall,
  quantiseOrderSize,
} from '../../controllers/spot.controller.js';
import {
  decimalPlaces,
  precisionDigits,
  exceedsPrecision,
} from '../../validation/numericField.validation.js';
import * as redisMock from '../../controllers/redis.controller.js';
import * as wsMock from '../../lib/binanceWebSocket.js';
import * as modelsMock from '../../models/index.js';
import * as walletMock from '../../grpc/walletService.js';

const PAIR_ID = '695bf1017573eeb15a749c9d';
const USD_ID = '695bf0e2b9aba016fb8ce3c4';
const BTC_ID = '695bf0e2b9aba016fb8ce3c1';
const USER_ID = '6a70f1c287c92c7218ac37fc';
const ADMIN_ID = '695af33fe64f3be062b77bb4';

// The live BTCUSD pair: 8 decimals of BTC, 2 of USD.
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

const seed = async (pair = pairFixture) => {
  redisMock.__reset();
  modelsMock.__trades.length = 0;
  modelsMock.__savedOrders.length = 0;
  walletMock.__passbook.length = 0;
  await redisMock.hset('spotPairdata', PAIR_ID, pair);
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

// ===========================================================================
// The counting itself
// ===========================================================================

describe('decimalPlaces counts what the number IS, not how it was spelled', () => {
  test('plain decimals', () => {
    expect(decimalPlaces(63510.63)).toBe(2);
    expect(decimalPlaces(63510.631)).toBe(3);
    expect(decimalPlaces(63510)).toBe(0);
    expect(decimalPlaces(0.0012345678912345)).toBe(16);
  });

  test('trailing zeros are not decimal places - a padded form field is fine', () => {
    // Counted on the parsed VALUE, so a client that pads its input to the
    // pair's width ("63510.60") is not refused for the padding, and
    // "63510.6300" is the two decimals it actually names rather than four.
    expect(decimalPlaces('63510.60')).toBe(1);
    expect(decimalPlaces('63510.6300')).toBe(2);
    expect(decimalPlaces('  0.50  ')).toBe(1);
  });

  test('exponent notation is counted as the decimals it means', () => {
    // JavaScript spells anything below 1e-6 exponentially, and a regex over
    // toString() is exactly how sub-satoshi values used to slip past
    // truncation (see plainDecimal in lib/roundOf.js).
    expect(decimalPlaces(5e-8)).toBe(8);
    expect(decimalPlaces(1.5e-7)).toBe(8);
    expect(decimalPlaces('1e-9')).toBe(9);
    expect(decimalPlaces(1e21)).toBe(0);
  });

  test('a negative value is counted by magnitude, not by its minus sign', () => {
    expect(decimalPlaces(-1.234)).toBe(3);
  });

  test('anything that is not a number answers null, not zero', () => {
    // A zero here would read as "no decimals" and quietly ACCEPT the value.
    for (const bad of [null, undefined, '', 'abc', true, [1], {}, NaN, Infinity]) {
      expect(decimalPlaces(bad)).toBeNull();
    }
  });
});

describe('precisionDigits refuses to invent a precision the pair did not state', () => {
  test('a stated precision is used', () => {
    expect(precisionDigits(8)).toBe(8);
    expect(precisionDigits('2')).toBe(2);
    expect(precisionDigits(0)).toBe(0);
  });

  test('an absent or nonsense precision is null, never a number', () => {
    // The trap this exists for: `toFixedDown(x, undefined)` truncates to TWO
    // decimal places, which on a BTC quantity is a far larger money defect
    // than the one being fixed.
    for (const bad of [undefined, null, '', 'eight', -1, 2.5, NaN]) {
      expect(precisionDigits(bad)).toBeNull();
    }
  });

  test('exceedsPrecision is false whenever either side is unknown', () => {
    expect(exceedsPrecision(63510.631, 2)).toBe(true);
    expect(exceedsPrecision(63510.63, 2)).toBe(false);
    expect(exceedsPrecision(63510.631, undefined)).toBe(false);
    expect(exceedsPrecision('abc', 2)).toBe(false);
  });
});

describe('quantiseOrderSize truncates DOWN, and only when it must', () => {
  test('a size finer than the pair is truncated toward zero', () => {
    expect(quantiseOrderSize(0.0012345678912345, 8)).toBe(0.00123456);
    // Never rounded up: 0.999999999 must not become 1.
    expect(quantiseOrderSize(0.999999999, 8)).toBe(0.99999999);
  });

  test('a size the pair can express is returned untouched, bit for bit', () => {
    expect(quantiseOrderSize(0.001, 8)).toBe(0.001);
    expect(quantiseOrderSize(1.5, 8)).toBe(1.5);
  });

  test('an unstated precision truncates NOTHING', () => {
    expect(quantiseOrderSize(0.0012345678912345, undefined)).toBe(0.0012345678912345);
    expect(quantiseOrderSize(0.0012345678912345, null)).toBe(0.0012345678912345);
  });

  test('a size that cannot be quantised is handed back, never turned into 0', () => {
    // toFixedDown answers "" for these, and "" coerces to 0 - a free order.
    expect(quantiseOrderSize(Infinity, 8)).toBe(Infinity);
    expect(quantiseOrderSize(NaN, 8)).toBeNaN();
  });
});

// ===========================================================================
// The order path
// ===========================================================================

describe('a limit PRICE finer than the pair is refused outright (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  test('63510.631 on a 2-decimal quote is a 400, and nothing moved', async () => {
    const usdBefore = balance('walletbalance_spot', `${USER_ID}_${USD_ID}`);
    const res = await placeLimit('buy', 63510.631, 0.001);

    expect(res.statusCode).toBe(400);
    expect(res.payload.status).toBe(false);
    expect(res.payload.message).toMatch(/decimal place/i);
    // Refused before anything touches money or the book: no debit, no escrow,
    // no resting order - and therefore nothing to publish.
    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBe(usdBefore);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBe(0);
    expect(userOrders('buy')).toHaveLength(0);
    expect(walletMock.__passbook).toHaveLength(0);
  });

  test('the sub-tick queue jump is what this closes: no such price can rest', async () => {
    // The exploit in one line - a sell one hundredth of a cent inside the
    // ladder's best ask, which would have become the whole book's best offer.
    expect((await placeLimit('sell', 63499.999, 0.001)).statusCode).toBe(400);
    expect(userOrders('sell')).toHaveLength(0);
    // ...and the same price at the tick the pair CAN express is fine.
    expect((await placeLimit('sell', 63499.99, 0.001)).statusCode).toBe(200);
    expect(userOrders('sell')).toHaveLength(1);
    expect(userOrders('sell')[0].price).toBe(63499.99);
  });

  test('a price the pair CAN express is not refused - including a whole one', async () => {
    expect((await placeLimit('buy', 63510.63, 0.001)).statusCode).toBe(200);
    expect((await placeLimit('buy', 63510.6, 0.001)).statusCode).toBe(200);
    expect((await placeLimit('buy', 63510, 0.001)).statusCode).toBe(200);
    expect(userOrders('buy')).toHaveLength(3);
  });

  test('the price is judged against the QUOTE precision, not the base one', async () => {
    // Using firstFloatDigit here (8) would accept 63510.631 and refuse
    // nothing; using secondFloatDigit on the quantity would truncate BTC to
    // two decimals. The two fields are not interchangeable.
    expect((await placeLimit('buy', 63510.631, 0.001)).statusCode).toBe(400);
    const res = await placeLimit('buy', 63510.63, 0.00123456);
    expect(res.statusCode).toBe(200);
    expect(userOrders('buy')[0].quantity).toBe(0.00123456);
  });
});

describe('a limit QUANTITY finer than the pair is truncated down, and reported', () => {
  beforeEach(async () => {
    await seed();
  });

  test('0.0012345678912345 BTC rests as 0.00123456, and is charged as such', async () => {
    const res = await placeLimit('buy', 63000, 0.0012345678912345);

    expect(res.statusCode).toBe(200);
    expect(res.payload.quantity).toBe(0.00123456);
    expect(res.payload.quantityRounded).toBe(true);
    expect(res.payload.requestedQuantity).toBe(0.0012345678912345);
    expect(res.payload.message).toMatch(/rounded down to 0.00123456 BTC/);

    const resting = userOrders('buy')[0];
    expect(resting.quantity).toBe(0.00123456);
    expect(resting.openQuantity).toBe(0.00123456);
    // THE CHARGE AND THE ORDER ARE THE SAME NUMBER. A debit computed from the
    // requested size and an order written with the truncated one is how the
    // market-buy defect handed out unpaid-for coin.
    expect(resting.inOrderReserved).toBe(63000 * 0.00123456);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBeCloseTo(
      63000 * 0.00123456,
      10
    );
    expect(balance('walletbalance_spot', `${USER_ID}_${USD_ID}`)).toBeCloseTo(
      300000 - 63000 * 0.00123456,
      10
    );
  });

  test('a size the pair can express is placed silently, with no adjustment claimed', async () => {
    const res = await placeLimit('sell', 64000, 0.001);
    expect(res.statusCode).toBe(200);
    expect(res.payload.message).toBe('Your order placed successfully.');
    expect(res.payload.quantity).toBe(0.001);
    expect(res.payload.quantityRounded).toBeUndefined();
  });

  test('a size smaller than one unit of precision is refused, not silently zeroed', async () => {
    // 1e-9 BTC truncates to 0. Placing a zero-quantity order - or escrowing
    // for one - is worse than saying no.
    const res = await placeLimit('sell', 64000, 1e-9);
    expect(res.statusCode).toBe(400);
    expect(res.payload.message).toMatch(/smallest size this pair can trade/);
    expect(userOrders('sell')).toHaveLength(0);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`)).toBe(0);
  });

  test('the truncated size is what the min/max bounds are measured against', async () => {
    // 0.000109 truncates to 0.0001 on an 8-decimal pair, which is exactly
    // minQuantity - so the bound must be applied AFTER the truncation, or the
    // venue accepts an order it then shrinks below its own floor.
    const res = await placeLimit('sell', 64000, 0.00010999999999);
    expect(res.statusCode).toBe(200);
    expect(userOrders('sell')[0].quantity).toBe(0.00010999);
  });
});

describe('a market order is quantised on the side that names a SIZE', () => {
  beforeEach(async () => {
    await seed();
    // The market gate needs a ladder, and matchingcall is what builds it.
    await matchingcall(PAIR_ID);
  });

  test('a market SELL truncates `amount` and is charged for the truncated size', async () => {
    const btcBefore = balance('walletbalance_spot', `${USER_ID}_${BTC_ID}`);
    const res = await placeMarket('sell', { amount: 0.0012345678912345 });

    expect(res.statusCode).toBe(200);
    expect(res.payload.quantityRounded).toBe(true);
    expect(res.payload.quantity).toBe(0.00123456);
    const resting = userOrders('sell')[0];
    expect(resting.quantity).toBe(0.00123456);
    expect(resting.amount).toBe(0.00123456);
    expect(btcBefore - balance('walletbalance_spot', `${USER_ID}_${BTC_ID}`)).toBeCloseTo(
      0.00123456,
      12
    );
  });

  test("a market BUY's orderValue is a budget and is NOT refused for its decimals", async () => {
    // "Spend my whole balance" is a real request whose exact number carries
    // float residue. The quantity it buys is quantised by marketOrderQuantity,
    // which is where the protection belongs.
    const res = await placeMarket('buy', { orderValue: 999.9999999999999 });
    expect(res.statusCode).toBe(200);
    const resting = userOrders('buy')[0];
    expect(resting.quantity).toBe(0.01574803);
  });
});

describe('a pair that states no precision is left alone', () => {
  test('a missing firstFloatDigit does not truncate a BTC quantity to 2 decimals', async () => {
    const { firstFloatDigit, ...noBasePrecision } = pairFixture;
    await seed(noBasePrecision);

    const res = await placeLimit('sell', 63000, 0.0012345678912345);
    expect(res.statusCode).toBe(200);
    expect(userOrders('sell')[0].quantity).toBe(0.0012345678912345);
  });

  test('a missing secondFloatDigit refuses no price', async () => {
    const { secondFloatDigit, ...noQuotePrecision } = pairFixture;
    await seed(noQuotePrecision);

    expect((await placeLimit('buy', 63510.631, 0.001)).statusCode).toBe(200);
  });
});
