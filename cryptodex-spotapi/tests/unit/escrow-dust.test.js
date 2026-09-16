/**
 * THE UNSOLD REMAINDER OF A RETIRING ORDER (CRITICAL - MONEY DESTROYED)
 * ====================================================================
 *
 * THE DEFECT. A resting order that is partly filled has its remaining
 * `quantity` rewritten by the matcher through `toFixedDown(...,
 * firstFloatDigit)` - correct, and the fix from d35e676: a remainder must only
 * ever shrink. But the ESCROW counter, `walletbalance_spot_inOrder`, keeps the
 * EXACT remainder, so from that moment the two disagree by up to one unit of
 * the pair's precision.
 *
 * On the fill that RETIRES the order, spot.controller.js releases the whole
 * remaining reservation out of the escrow counter
 * (`releaseInOrder(..., {final: true})`) and - before this change - credited
 * nothing back to `walletbalance_spot` for the part that was never sold. The
 * base coin had really been debited at placement, so it was not released, it
 * was DESTROYED: the seller neither sold it nor got it back.
 * `sweepResidualInOrder` then zeroed what was left of the counter, under a
 * comment asserting that "nothing was actually owed" - which is true of
 * HINCRBYFLOAT round-trip residue and false of this.
 *
 * MEASURED LIVE, BTCUSD: reconstructing an account from seed + faucet + every
 * tradeHistory row left it short by exactly 9.87588606428608e-9 BTC after one
 * such fill, while the same reconciliation over 22 ordinary trades on another
 * account closed to 3.5e-18. Bounded by 10^-firstFloatDigit per retiring fill
 * (~$0.00064 on BTC), so it is dust - and it is the exact mirror of d35e676,
 * where the same disagreement pointed the other way and CREATED money.
 *
 * IT WAS NOT ONLY THE SELL SIDE, and this file is what established that. The
 * buy side was believed to be covered by the `spot_limit_bal_retrieve` credit
 * sitting beside its release - but that credit is the PRICE-IMPROVEMENT refund,
 * (limitPrice - execPrice) * executed quantity: it settles the price of the
 * coin that WAS bought and has nothing to say about the quantity that was not.
 * Run against HEAD, the buy case below destroys 0.0006320567335933447 USD on
 * exactly the shape that costs the sell case 9.875885673485407e-9 BTC.
 *
 * THE INVARIANT THESE TESTS PIN, in one sentence:
 *
 *     A seller's base coin leaves `spot + inOrder` only by being SOLD, and a
 *     buyer's quote leaves it only by being SPENT.
 *
 * so `(spot + inOrder) before - (spot + inOrder) after` must equal exactly what
 * the trade rows say was traded. Every other outcome is either money destroyed
 * (the defect) or money created (its mirror).
 *
 * WHY THE RESTING ORDER IS PUT INTO THE BOOK MID-LIFE. The state under test -
 * a resting order whose truncated `quantity` is smaller than the escrow still
 * held against it - is the state the matcher ITSELF writes after every partial
 * fill of that shape; it is `current_sell.quantity = sellExcAmount` at
 * spot.controller.js in tradeMatching, with `inOrderReserved` /
 * `inOrderReleased` untouched beside it. Reaching it through two ticks of the
 * live matcher would make the size of the dust depend on how the paper ladder
 * happened to be grouped that tick, which is not something a regression test
 * should be measuring. The numbers below are the ones measured on the running
 * stack, imposed directly.
 *
 * NOTE ON THE ORDER-PRECISION FIX in the same change: quantising a limit
 * quantity and a market sell's `amount` at the door (see PRICE IS REFUSED, SIZE
 * IS QUANTISED) makes this state far rarer, because a user can no longer submit
 * a 16-decimal size on an 8-decimal pair. It does NOT close it - the live
 * ETHUSD pair carries `firstFloatDigit: 18`, where no quantity is quantised at
 * all and ordinary float arithmetic produces the same disagreement - which is
 * why the credit-back exists as well as the validation.
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


// paperBook is NOT mocked: the counterparty on these fills is the real
// synthetic ladder, built from the depth snapshot below, exactly as it is live.
import { matchingcall, limitOrderPlace, marketOrderPlace } from '../../controllers/spot.controller.js';
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

// The live BTCUSD pair, field for field.
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

/** spot + inOrder: everything the venue says this account owns of one coin. */
const held = (currencyId, userId = USER_ID) =>
  balance('walletbalance_spot', `${userId}_${currencyId}`) +
  balance('walletbalance_spot_inOrder', `${userId}_${currencyId}`);

const openOrders = (side) => {
  const map = redisMock.__hashes.get(`${side}OpenOrders_${PAIR_ID}`);
  if (!map) return [];
  return Array.from(map.values()).map((v) => JSON.parse(v));
};
const userOrders = (side) => openOrders(side).filter((o) => !o.isPaper);

/**
 * Base quantity traded across every fill recorded this run. `tradeQty` is the
 * field newTradeHistory writes the executed size into.
 */
const tradedQuantity = () =>
  modelsMock.__trades.reduce((sum, t) => sum + parseFloat(t.tradeQty || 0), 0);

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const seed = async () => {
  redisMock.__reset();
  modelsMock.__trades.length = 0;
  modelsMock.__savedOrders.length = 0;
  walletMock.__passbook.length = 0;
  await redisMock.hset('spotPairdata', PAIR_ID, pairFixture);
  await redisMock.hset('admin_liquidity', 'liquidation', {
    _id: ADMIN_ID,
    userId: '12024756'
  });
  for (const id of [USER_ID, OTHER_ID]) {
    await redisMock.hincbyfloat('walletbalance_spot', `${id}_${USD_ID}`, 300000);
    await redisMock.hincbyfloat('walletbalance_spot', `${id}_${BTC_ID}`, 5);
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${id}_${USD_ID}`, 0);
    await redisMock.hincbyfloat('walletbalance_spot_inOrder', `${id}_${BTC_ID}`, 0);
  }
  wsMock.__state.book = {
    lastUpdateId: 1,
    updatedAt: Date.now(),
    bids: [
      { price: 63499, quantity: 0.5 },
      { price: 63498, quantity: 1 }
    ],
    asks: [
      { price: 63500, quantity: 0.5 },
      { price: 63501, quantity: 1 }
    ]
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

const placeMarket = async (buyorsell, body, userId = USER_ID) => {
  const res = mockRes();
  await marketOrderPlace(
    {
      body: { orderType: 'market', buyorsell, spotPairId: PAIR_ID, ...body },
      user: { id: userId, userCode: '11286524' }
    },
    res
  );
  return res;
};

/**
 * Put a resting order into the state a partial fill leaves it in: `quantity`
 * truncated to the pair's precision, the reservation ledger carrying the exact
 * numbers, and the escrow counter holding what the ledger says.
 *
 *   reserved   what limitOrderPlace really debited and escrowed
 *   released   what earlier fills really gave back
 *   quantity   the TRUNCATED remainder the matcher wrote
 *
 * The gap - (reserved - released) - quantity - is the coin at issue.
 */
const restAtMidLife = async (side, order, { reserved, released, quantity }) => {
  const currencyId = side === 'sell' ? BTC_ID : USD_ID;
  order.quantity = quantity;
  order.openQuantity = reserved;
  order.filledQuantity = side === 'sell' ? released : released / order.price;
  order.inOrderReserved = reserved;
  order.inOrderReleased = released;
  await redisMock.hset(`${side}OpenOrders_${PAIR_ID}`, order._id, order);
  // The escrow counter agrees with the order's own ledger, which is the
  // invariant limitOrderPlace/releaseInOrder maintain.
  const field = `${USER_ID}_${currencyId}`;
  const current = balance('walletbalance_spot_inOrder', field);
  await redisMock.hincbyfloat(
    'walletbalance_spot_inOrder',
    field,
    reserved - released - current
  );
  return order;
};

// The numbers measured on the running stack: a 0.10000000987588606 BTC sell
// (a "sell everything I hold" balance, which is what carries that many
// decimals), 0.09 of it already filled, leaving 0.010000009875886062 escrowed
// behind a resting quantity of 0.01.
const RESERVED = 0.10000000987588606;
const RELEASED = 0.09;
const REMAINDER = 0.01;
const DUST = RESERVED - RELEASED - REMAINDER; // 9.875886062e-9 BTC

describe('a retiring SELL returns the base coin its truncated quantity left behind (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  test('a LIMIT fill that retires the order destroys no coin', async () => {
    // A real placement, so every field, the debit and the escrow are the
    // engine's own; then wound forward to mid-life.
    expect((await placeLimit('sell', 63000, 0.1)).statusCode).toBe(200);
    const resting = userOrders('sell')[0];
    expect(resting).toBeDefined();
    await restAtMidLife('sell', resting, {
      reserved: RESERVED,
      released: RELEASED,
      quantity: REMAINDER
    });

    // 0.1 debited at placement, of which (RESERVED - RELEASED) is now escrowed
    // behind a resting quantity of only REMAINDER - the disagreement itself.
    const btcBefore = held(BTC_ID);
    expect(btcBefore).toBeCloseTo(4.9 + REMAINDER + DUST, 15);

    // One tick: the ladder's top bid (63499) lifts the whole 0.01 remainder,
    // and the order retires.
    await matchingcall(PAIR_ID);
    await flush();

    expect(userOrders('sell')).toHaveLength(0);
    const sold = tradedQuantity();
    expect(sold).toBeCloseTo(REMAINDER, 12);

    // THE INVARIANT. Coin leaves the account only by being sold.
    const btcAfter = held(BTC_ID);
    expect(btcBefore - btcAfter - sold).toBeCloseTo(0, 15);
    // ...and said in the units of the defect: the dust is still there, having
    // been returned to the SPENDABLE balance rather than released into nothing.
    expect(btcAfter).toBeCloseTo(btcBefore - REMAINDER, 15);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`)).toBe(0);
  });

  test('the return is written to the passbook, so an audit can find it', async () => {
    expect((await placeLimit('sell', 63000, 0.1)).statusCode).toBe(200);
    await restAtMidLife('sell', userOrders('sell')[0], {
      reserved: RESERVED,
      released: RELEASED,
      quantity: REMAINDER
    });

    await matchingcall(PAIR_ID);
    await flush();

    const rows = walletMock.__passbook.filter(
      (r) => r.type === 'spot_escrow_dust_retrieve'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('credit');
    expect(rows[0].currencyId).toBe(BTC_ID);
    expect(rows[0].amount).toBeCloseTo(DUST, 15);
  });

  test('a MARKET buy that retires the order destroys no coin either', async () => {
    // The other matching path - marketMatching, not tradeMatching. Same shape,
    // same invariant, and the path the task's note is about: a market order's
    // size is the one that can still be finer than the resting order's
    // precision.
    //
    // Priced INSIDE the ladder's spread (best bid 63499, best ask 63500) so it
    // rests without crossing on the way in and is still the best ask when the
    // market buy arrives.
    expect((await placeLimit('sell', 63499.5, 0.1)).statusCode).toBe(200);
    // One tick first: the market-order gate refuses anything until the
    // synthetic ladder exists, and matchingcall is what syncs it.
    await matchingcall(PAIR_ID);
    await flush();
    expect(userOrders('sell')[0].quantity).toBe(0.1);

    await restAtMidLife('sell', userOrders('sell')[0], {
      reserved: RESERVED,
      released: RELEASED,
      quantity: REMAINDER
    });
    modelsMock.__trades.length = 0;
    const btcBefore = held(BTC_ID);

    // A DIFFERENT account buys, so the seller's coin is the only thing moving
    // in this assertion.
    expect(
      (await placeMarket('buy', { orderValue: 1000 }, OTHER_ID)).statusCode
    ).toBe(200);
    await matchingcall(PAIR_ID);
    await flush();

    expect(userOrders('sell')).toHaveLength(0);
    const sold = modelsMock.__trades
      .filter((t) => t.sellUserId === USER_ID)
      .reduce((sum, t) => sum + parseFloat(t.tradeQty), 0);
    expect(sold).toBeCloseTo(REMAINDER, 12);
    expect(held(BTC_ID)).toBeCloseTo(btcBefore - sold, 15);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`)).toBe(0);
  });
});

describe('a retiring BUY returns the quote its truncated quantity never spent', () => {
  beforeEach(async () => {
    await seed();
  });

  test('a limit BUY retired by a fill destroys no quote currency', async () => {
    // The mirror of the sell case: a buy escrows price * quantity of the quote,
    // and the same truncation leaves part of it bought by nobody.
    expect((await placeLimit('buy', 64000, 0.1)).statusCode).toBe(200);
    const resting = userOrders('buy')[0];
    const reserved = 64000 * RESERVED;
    const released = 64000 * RELEASED;
    await restAtMidLife('buy', resting, {
      reserved,
      released,
      quantity: REMAINDER
    });

    const usdBefore = held(USD_ID);

    await matchingcall(PAIR_ID);
    await flush();

    expect(userOrders('buy')).toHaveLength(0);
    // What the fills actually cost, at the executed price.
    const spent = modelsMock.__trades.reduce(
      (sum, t) => sum + parseFloat(t.tradeQty) * parseFloat(t.tradePrice),
      0
    );
    expect(spent).toBeGreaterThan(0);
    const usdAfter = held(USD_ID);
    expect(usdBefore - usdAfter - spent).toBeCloseTo(0, 8);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${USD_ID}`)).toBe(0);
  });
});

describe('the credit-back cannot become a mint', () => {
  beforeEach(async () => {
    await seed();
  });

  test('an order filled EXACTLY returns nothing extra', async () => {
    // Nothing was left over, so nothing may come back. A credit here would be
    // money created out of a rounding decision - d35e676 in reverse.
    expect((await placeLimit('sell', 63000, 0.02)).statusCode).toBe(200);
    const btcBefore = held(BTC_ID);

    await matchingcall(PAIR_ID);
    await flush();

    const sold = tradedQuantity();
    expect(sold).toBeCloseTo(0.02, 12);
    expect(btcBefore - held(BTC_ID) - sold).toBeCloseTo(0, 15);
    expect(
      walletMock.__passbook.filter((r) => r.type === 'spot_escrow_dust_retrieve')
    ).toHaveLength(0);
  });

  test('the synthetic paper ladder is never credited - it was never debited', async () => {
    expect((await placeLimit('sell', 63000, 0.02)).statusCode).toBe(200);

    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades.length).toBeGreaterThan(0);
    expect(balance('walletbalance_spot', `${ADMIN_ID}_${BTC_ID}`)).toBe(0);
    expect(balance('walletbalance_spot', `${ADMIN_ID}_${USD_ID}`)).toBe(0);
    expect(
      walletMock.__passbook.filter((r) => r.userId === ADMIN_ID)
    ).toHaveLength(0);
  });

  test('a MARKET order is never credited - it escrows nothing to be left over', async () => {
    expect((await placeMarket('sell', { amount: 0.02, quantity: 0.02 })).statusCode).toBe(200);

    await matchingcall(PAIR_ID);
    await flush();

    expect(modelsMock.__trades.length).toBeGreaterThan(0);
    expect(
      walletMock.__passbook.filter((r) => r.type === 'spot_escrow_dust_retrieve')
    ).toHaveLength(0);
    expect(balance('walletbalance_spot_inOrder', `${USER_ID}_${BTC_ID}`)).toBe(0);
  });
});
