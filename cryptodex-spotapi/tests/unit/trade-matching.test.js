/**
 * THE BOOK THE MATCHER TRADES AGAINST - AGAINST THE IMPLEMENTATION
 * ===============================================================
 *
 * WHY THIS FILE WAS REWRITTEN
 * ---------------------------
 * It held 61 tests and imported nothing but `@jest/globals`. Every one asserted
 * an expression against itself:
 *
 *     const bidPrice = 50100;
 *     const askPrice = 50000;
 *     const canMatch = bidPrice >= askPrice;
 *     expect(canMatch).toBe(true);
 *
 * Nothing in `lib/depthHealth.js` - the module that decides what liquidity
 * exists, aggregates it into price levels and hands the result to both the
 * matcher's gate and the display - was ever called. The file was green through
 * the entire five-and-a-half-hour outage in which the UI rendered a full,
 * fresh-looking 20-level book while the ladder the matcher trades against had
 * been purged and nothing could fill.
 *
 * Most of what it described does not exist here either: OCO groups, FOK, IOC,
 * GTT expiry, stop triggers, a trade-persistence layer with its own indexes.
 * The engine has limit and market orders (see
 * validation/spotTrade.validation.js UNSUPPORTED_ORDER_TYPES for why the rest
 * are refused outright), and its liquidity is the synthetic ladder mirrored
 * from Binance depth. Asserting invented behaviour is worse than asserting
 * nothing, because it reads like coverage.
 *
 * WHAT IS ASSERTED, AND HOW
 * -------------------------
 * `tests/unit/book-publish.test.js` owns `assessDepthHealth` and the publisher.
 * This file owns the ALGEBRA underneath them - the part the old file was
 * pretending to test when it wrote "Price Level Aggregation" and then added two
 * numbers - and it asserts it through CONSERVATION IDENTITIES rather than by
 * re-adding the same numbers a second time:
 *
 *     bookLevels        total quantity in  ==  total quantity out
 *     mergeBookLevels   total(a) + total(b) == total(merge(a, b))
 *     withNotionals     maxNotional == sum of every level's notional
 *                       and each row's notional == price * quantity
 *
 * A conservation law is the right shape here because the defect these functions
 * exist to prevent is DOUBLE COUNTING (the synthetic ladder is itself a mirror
 * of the depth being merged into, so counting it counts the whole book twice)
 * and its opposite, a small user order REPLACING the book instead of adding to
 * it. Both are violations of conservation; neither is visible to a test that
 * checks one hand-computed level.
 *
 * MUTATION SUMMARY at the foot of the file.
 */

import { describe, test, expect } from '@jest/globals';

import {
  bookLevels,
  mergeBookLevels,
  withNotionals,
  parseOrders,
  countPaperOrders,
  assessDepthHealth,
  depthAgeMs,
  ORDER_BOOK_DEPTH,
  DEPTH_STALE_MS,
  PRICE_DEVIATION_GUARD,
  LADDER_STALE_MS,
} from '../../lib/depthHealth.js';

/** The raw shape of a `{buy|sell}OpenOrders_<pairId>` hgetall reply. */
const hash = (...orders) =>
  Object.fromEntries(orders.map((o, i) => [`id${i}`, JSON.stringify(o)]));

const order = (over = {}) => ({
  price: 63000,
  quantity: 1,
  status: 'open',
  ...over
});

const totalQuantity = (levels) =>
  levels.reduce((sum, level) => sum + level.quantity, 0);

// ===========================================================================
// WHAT COUNTS AS A ROW
// ===========================================================================

describe('parseOrders - one definition of what a row in these hashes is', () => {
  test('it parses the serialised values and skips the unparseable', () => {
    const raw = {
      a: JSON.stringify(order({ price: 1 })),
      b: 'not json at all',
      c: JSON.stringify(order({ price: 2 })),
      d: '',
      e: null
    };
    const prices = [...parseOrders(raw)].map((o) => o.price);
    // The two good rows survive; the garbage does not take the read down with
    // it, and does not silently become a level either.
    expect(prices).toEqual([1, 2]);
  });

  test('an already-parsed object is passed through, and nothing is nothing', () => {
    expect([...parseOrders({ a: order({ price: 7 }) })].map((o) => o.price)).toEqual([7]);
    expect([...parseOrders(null)]).toEqual([]);
    expect([...parseOrders(undefined)]).toEqual([]);
    expect([...parseOrders({})]).toEqual([]);
  });
});

// ===========================================================================
// AGGREGATION
// ===========================================================================

describe('bookLevels aggregates REAL resting orders into price levels (CRITICAL)', () => {
  test('IDENTITY - quantity is conserved, and orders at one price become one level', () => {
    const orders = hash(
      order({ price: 63000, quantity: 1 }),
      order({ price: 63000, quantity: 2.5 }),
      order({ price: 62900, quantity: 0.5 })
    );
    const levels = bookLevels(orders);
    // Two prices out of three orders...
    expect(levels).toHaveLength(2);
    // ...and not one unit of size created or destroyed on the way.
    expect(totalQuantity(levels)).toBeCloseTo(4, 12);
    expect(levels.find((l) => l.price === 63000).quantity).toBeCloseTo(3.5, 12);
    expect(levels.find((l) => l.price === 62900).quantity).toBeCloseTo(0.5, 12);
  });

  test('THE SYNTHETIC LADDER IS EXCLUDED - counting it counts the book twice', () => {
    // The paper ladder is itself a mirror of the very depth these levels get
    // merged into. This is the double-count that would show a book of twice
    // the liquidity the venue actually has.
    const levels = bookLevels(
      hash(
        order({ price: 63000, quantity: 1 }),
        order({ price: 63000, quantity: 99, isPaper: true }),
        order({ price: 62900, quantity: 50, isPaper: true })
      )
    );
    expect(totalQuantity(levels)).toBeCloseTo(1, 12);
    expect(levels).toHaveLength(1);
  });

  test('only RESTING statuses are liquidity - a filled order is not a bid', () => {
    // These hashes are not swept synchronously; a cancelled or filled order can
    // linger until something hdel's it, and it must not be quoted meanwhile.
    for (const status of ['open', 'pending', 'conditional']) {
      expect(bookLevels(hash(order({ status })))).toHaveLength(1);
    }
    for (const status of ['filled', 'cancelled', 'completed', 'rejected', 'expired']) {
      expect(bookLevels(hash(order({ status })))).toHaveLength(0);
    }
  });

  test('an order with no status at all is still liquidity', () => {
    // `order.status && !RESTING_STATUS.includes(...)` - absent means "not
    // disqualified", which is what keeps a row written before the field
    // existed on the book rather than silently removing it.
    const orders = hash({ price: 63000, quantity: 1 });
    expect(bookLevels(orders)).toHaveLength(1);
  });

  test('A MARKET ORDER HAS NO PLACE ON A PRICE LADDER', () => {
    // It rests as `price: "market"` when it cannot fill. It is real, and it is
    // unpriceable - putting it on the ladder would put NaN in a price column.
    const levels = bookLevels(
      hash(
        order({ price: 'market' }),
        order({ price: 63000, quantity: 2 })
      )
    );
    expect(levels).toHaveLength(1);
    expect(levels[0].price).toBe(63000);
  });

  test('unusable prices and quantities are dropped, never coerced', () => {
    const levels = bookLevels(
      hash(
        order({ price: 0 }),
        order({ price: -1 }),
        order({ price: 'abc' }),
        order({ price: Infinity }),
        order({ quantity: 0 }),
        order({ quantity: -5 }),
        order({ quantity: 'abc' }),
        order({ price: 63000, quantity: 3 })
      )
    );
    expect(levels).toEqual([{ price: 63000, quantity: 3 }]);
  });

  test('OPEN quantity is what rests, and `quantity` IS the remainder', () => {
    // CORRECTED CONTRACT. Every assertion this replaces encoded a model of
    // `quantity` that the matcher does not implement.
    //
    // On each fill the matcher assigns `quantity` THE REMAINDER
    // (`current_buy.quantity = buyExcAmount`, quantity minus the executed
    // amount) and ACCUMULATES `filledQuantity`. So `quantity` alone is what
    // rests; `quantity - filledQuantity` counts the fill twice, and
    // `openQuantity` is the size at PLACEMENT and is never decremented.
    //
    // Proved live: a 0.5 SOL bid, 0.2 filled, is stored as
    // {quantity: 0.3, openQuantity: 0.5, filledQuantity: 0.2} and the
    // published book advertised 0.5.

    // The remainder is published, whatever a stale openQuantity says.
    expect(
      bookLevels(hash(order({ quantity: 4, openQuantity: 10 })))[0].quantity
    ).toBeCloseTo(4, 12);

    // filledQuantity is NOT subtracted: this is an order opened at 16 with 6
    // filled and 10 still resting.
    expect(
      bookLevels(hash(order({ quantity: 10, filledQuantity: 6 })))[0].quantity
    ).toBeCloseTo(10, 12);

    // A fully filled order has no remainder, and the matcher records that by
    // zeroing `quantity`.
    expect(bookLevels(hash(order({ quantity: 0, filledQuantity: 10 })))).toHaveLength(0);

    // `quantity` wins when both are present - openQuantity is a placement
    // record, not an authority on what is left.
    expect(
      bookLevels(hash(order({ quantity: 4, filledQuantity: 9, openQuantity: 10 })))[0]
        .quantity
    ).toBeCloseTo(4, 12);
  });

  test('nothing in, nothing out', () => {
    expect(bookLevels(null)).toEqual([]);
    expect(bookLevels(undefined)).toEqual([]);
    expect(bookLevels({})).toEqual([]);
  });
});

describe('countPaperOrders counts exactly what bookLevels refuses to (CRITICAL)', () => {
  test('IDENTITY - the two functions partition the same hash', () => {
    // One asks "how much real liquidity is here", the other "is the synthetic
    // ladder actually resting". Between them they must account for every
    // priced row and overlap on none of them.
    const orders = hash(
      order({ price: 63000, quantity: 1 }),
      order({ price: 62900, quantity: 2 }),
      order({ price: 63001, quantity: 5, isPaper: true }),
      order({ price: 63002, quantity: 5, isPaper: true }),
      order({ price: 63003, quantity: 5, isPaper: true })
    );
    expect(countPaperOrders(orders)).toBe(3);
    expect(bookLevels(orders)).toHaveLength(2);
    expect(totalQuantity(bookLevels(orders))).toBeCloseTo(3, 12);
  });

  test('only an explicit `true` is a paper order', () => {
    // A truthy string or a 1 from a redis round trip is not the flag.
    expect(countPaperOrders(hash(order({ isPaper: 'true' })))).toBe(0);
    expect(countPaperOrders(hash(order({ isPaper: 1 })))).toBe(0);
    expect(countPaperOrders(hash(order({ isPaper: true })))).toBe(1);
    expect(countPaperOrders(hash(order()))).toBe(0);
    expect(countPaperOrders(null)).toBe(0);
  });
});

// ===========================================================================
// MERGING
// ===========================================================================

describe('mergeBookLevels ADDS - a user order never blanks the book (CRITICAL)', () => {
  test('IDENTITY - total quantity is conserved across a merge', () => {
    // A real venue adds a user's order to the book at its own price level. The
    // defect this prevents is REPLACEMENT: one small user order overwriting a
    // whole depth side, which is a blank display and a gate that thinks there
    // is no liquidity.
    const depth = [
      { price: 63000, quantity: 5 },
      { price: 62900, quantity: 3 }
    ];
    const users = [
      { price: 63000, quantity: 0.25 },
      { price: 62800, quantity: 1 }
    ];
    const merged = mergeBookLevels(depth, users);
    expect(totalQuantity(merged)).toBeCloseTo(
      totalQuantity(depth) + totalQuantity(users),
      12
    );
    // ...and the shared price is summed, not replaced.
    expect(merged.find((l) => l.price === 63000).quantity).toBeCloseTo(5.25, 12);
    expect(merged).toHaveLength(3);
  });

  test('merging is order-independent and associative in total', () => {
    const a = [{ price: 100, quantity: 1 }];
    const b = [{ price: 100, quantity: 2 }];
    const c = [{ price: 101, quantity: 4 }];
    expect(totalQuantity(mergeBookLevels(a, b, c))).toBeCloseTo(7, 12);
    expect(totalQuantity(mergeBookLevels(c, b, a))).toBeCloseTo(7, 12);
    expect(totalQuantity(mergeBookLevels(mergeBookLevels(a, b), c))).toBeCloseTo(7, 12);
  });

  test('it accepts a level keyed by `_id` as well as by `price`', () => {
    // Display rows carry the price as `_id`; merging must read both spellings
    // or a re-merged published book silently loses every level.
    expect(
      mergeBookLevels([{ _id: 63000, quantity: 2 }], [{ price: 63000, quantity: 1 }])
    ).toEqual([{ price: 63000, quantity: 3 }]);
  });

  test('unusable levels and non-arrays are skipped, not fatal', () => {
    expect(
      totalQuantity(
        mergeBookLevels(
          [{ price: 0, quantity: 5 }, { price: 100, quantity: 0 }],
          null,
          undefined,
          'nonsense',
          [{ price: 100, quantity: 2 }]
        )
      )
    ).toBeCloseTo(2, 12);
    expect(mergeBookLevels()).toEqual([]);
  });
});

// ===========================================================================
// DISPLAY ROWS
// ===========================================================================

describe('withNotionals builds the display rows the depth bars are drawn from', () => {
  const levels = [
    { price: 63000, quantity: 1 },
    { price: 62900, quantity: 2 },
    { price: 62800, quantity: 0.5 }
  ];

  test('IDENTITY - each row\'s notional is its own price times its own quantity', () => {
    const { rows } = withNotionals(levels);
    for (let i = 0; i < levels.length; i++) {
      expect(rows[i].notional).toBeCloseTo(levels[i].price * levels[i].quantity, 8);
    }
  });

  test('IDENTITY - maxNotional is the sum of every level\'s notional', () => {
    // The UI divides each row's cumulative notional by this to size its bar,
    // so a maxNotional that is not the true total draws bars that overflow or
    // never fill.
    const { rows, maxNotional } = withNotionals(levels);
    const summed = rows.reduce((sum, row) => sum + row.notional, 0);
    expect(maxNotional).toBeCloseTo(summed, 8);
    expect(maxNotional).toBeCloseTo(rows[rows.length - 1].cumulativeNotional, 8);
  });

  test('the running total is monotonic and never exceeds the max', () => {
    const { rows, maxNotional } = withNotionals(levels);
    let previous = 0;
    for (const row of rows) {
      expect(row.cumulativeNotional).toBeGreaterThanOrEqual(previous);
      expect(row.cumulativeNotional).toBeLessThanOrEqual(maxNotional + 1e-9);
      previous = row.cumulativeNotional;
    }
  });

  test('a row identifies itself by its price, in both fields the UI reads', () => {
    const { rows } = withNotionals(levels);
    for (const row of rows) {
      expect(row._id).toBe(row.price);
    }
  });

  test('an empty book is an empty book, not a division by zero', () => {
    expect(withNotionals([])).toEqual({ rows: [], maxNotional: 0 });
  });
});

// ===========================================================================
// THE VERDICT THE MATCHER AND THE DISPLAY SHARE
// ===========================================================================

describe('assessDepthHealth condemns a book the matcher cannot trade on (CRITICAL)', () => {
  const pair = { markPrice: 63000 };
  const NOW = 1_700_000_000_000;
  const book = (over = {}) => ({
    updatedAt: NOW,
    bids: [{ price: 62999, quantity: 1 }],
    asks: [{ price: 63001, quantity: 1 }],
    ...over
  });

  test('a healthy book is healthy, and says so with no reason', () => {
    expect(assessDepthHealth(book(), pair, NOW)).toEqual({
      healthy: true,
      reason: null
    });
  });

  test('A CROSSED BOOK IS NOT A BOOK - and NaN does not sneak through it', () => {
    // Strict `>` so a NaN on either side is condemned rather than accepted:
    // `NaN > x` is false, which is the one comparison that fails safe here.
    expect(assessDepthHealth(book({ asks: [{ price: 62998 }] }), pair, NOW).reason)
      .toBe('crossed_book');
    expect(assessDepthHealth(book({ asks: [{ price: 62999 }] }), pair, NOW).reason)
      .toBe('crossed_book');
    expect(assessDepthHealth(book({ asks: [{ price: NaN }] }), pair, NOW).reason)
      .toBe('crossed_book');
    expect(assessDepthHealth(book({ bids: [{ price: NaN }] }), pair, NOW).reason)
      .toBe('crossed_book');
  });

  test('A SNAPSHOT THAT CANNOT SAY WHEN IT WAS TAKEN IS STALE, not fresh', () => {
    // `now - NaN > DEPTH_STALE_MS` is FALSE, so a garbage timestamp used to be
    // accepted as fresh - a dead feed reading as healthy forever.
    expect(assessDepthHealth(book({ updatedAt: undefined }), pair, NOW).reason)
      .toBe('stale_depth');
    expect(assessDepthHealth(book({ updatedAt: 'nonsense' }), pair, NOW).reason)
      .toBe('stale_depth');
    expect(assessDepthHealth(book({ updatedAt: null }), pair, NOW).reason)
      .toBe('stale_depth');
  });

  test('the staleness boundary is DEPTH_STALE_MS exactly', () => {
    const atLimit = NOW - DEPTH_STALE_MS;
    expect(assessDepthHealth(book({ updatedAt: atLimit }), pair, NOW).healthy).toBe(true);
    expect(
      assessDepthHealth(book({ updatedAt: atLimit - 1 }), pair, NOW).reason
    ).toBe('stale_depth');
  });

  test('an empty side is no book at all', () => {
    expect(assessDepthHealth(book({ bids: [] }), pair, NOW).reason).toBe('empty_side');
    expect(assessDepthHealth(book({ asks: [] }), pair, NOW).reason).toBe('empty_side');
    expect(assessDepthHealth(book({ bids: null }), pair, NOW).reason).toBe('empty_side');
    expect(assessDepthHealth(null, pair, NOW).reason).toBe('no_depth');
  });

  test('depth too far from the reference price is refused', () => {
    const far = 63000 * (1 + PRICE_DEVIATION_GUARD * 2);
    expect(
      assessDepthHealth(
        book({ asks: [{ price: far }], bids: [{ price: far - 1 }] }),
        pair,
        NOW
      ).reason
    ).toBe('price_deviation');
  });

  test('A PAIR WITH NO MARK PRICE IS NOT EVIDENCE THE DEPTH IS BAD', () => {
    // There is nothing to check against; condemning the feed for the pair
    // document's gap would stop trading on a perfectly good book.
    for (const pairData of [null, {}, { markPrice: 0 }, { markPrice: 'abc' }]) {
      expect(assessDepthHealth(book(), pairData, NOW).healthy).toBe(true);
    }
  });

  test('depthAgeMs reports age and never reports a negative one', () => {
    expect(depthAgeMs({ updatedAt: NOW - 5000 }, NOW)).toBe(5000);
    // The feed's clock is not ours; "depthAgeMs=-1" in an alert reads as a bug
    // in the alert. Clamping only ever moves a value further from the
    // threshold - the verdict stays assessDepthHealth's to make.
    expect(depthAgeMs({ updatedAt: NOW + 5000 }, NOW)).toBe(0);
    expect(depthAgeMs({ updatedAt: 'nonsense' }, NOW)).toBe(NOW);
    expect(depthAgeMs(null, NOW)).toBe(NOW);
  });
});

describe('the thresholds exist once, and are numbers', () => {
  test('every published threshold is a usable positive number', () => {
    for (const value of [
      DEPTH_STALE_MS,
      PRICE_DEVIATION_GUARD,
      LADDER_STALE_MS,
      ORDER_BOOK_DEPTH
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  test('the depth window is wider than the ladder window', () => {
    // The ladder is rewritten by the 2s matcher cron; the depth feed by a
    // websocket with a REST watchdog behind it. If the ladder window were the
    // wider of the two, a dead feed would be reported as a ladder fault and
    // the operator would be sent to the wrong subsystem.
    expect(DEPTH_STALE_MS).toBeGreaterThan(LADDER_STALE_MS);
  });
});

/**
 * MUTATION SUMMARY - each applied to lib/depthHealth.js in a shadow tree,
 * reverted after each, with the guards that went red.
 *
 *  T1  bookLevels: drop the `isPaper` skip (double-count the ladder) ... ladder
 *                                            excluded, partition identity
 *  T2  bookLevels: `levels.set(price, quantity)` instead of adding to the
 *      existing level (last order at a price wins) ....... conservation
 *                                                          identity
 *  T3  bookLevels: drop the RESTING_STATUS filter ......... resting statuses
 *  T4  bookLevels: treat an absent status as NOT resting .. absent-status guard
 *  T5  bookLevels: use `order.quantity` and ignore
 *      openQuantity/filledQuantity ......................... open-quantity
 *  T6  bookLevels: prefer filledQuantity over openQuantity  open-quantity
 *  T7  bookLevels: drop `isFinite(price)` (let "market" in) market-order guard,
 *                                                          unusable-values
 *  T8  bookLevels: allow quantity <= 0 ................... unusable-values,
 *                                                          open-quantity
 *  T9  mergeBookLevels: `set` instead of add (replace) .... merge conservation,
 *                                                          order-independence
 *  T10 mergeBookLevels: read only `level.price`, not `_id`  `_id` spelling
 *  T11 withNotionals: `notional = quantity` .............. per-row notional,
 *                                                          maxNotional identity
 *  T12 withNotionals: return the LAST level's notional as
 *      maxNotional instead of the running total .......... maxNotional identity
 *  T13 withNotionals: reset `cumulative` each row ........ monotonic,
 *                                                          maxNotional identity
 *  T14 withNotionals: `_id: index` instead of the price ... row identity
 *  T15 assessDepthHealth: `>=` -> `>` on the crossed check crossed book
 *  T16 assessDepthHealth: drop the `|| 0` on updatedAt .... unusable timestamp
 *  T17 assessDepthHealth: `>=` on the staleness compare ... staleness boundary
 *  T18 assessDepthHealth: condemn a pair with no markPrice no-mark-price guard
 *  T19 assessDepthHealth: drop the empty-side check ...... empty side
 *  T20 depthAgeMs: drop the Math.max clamp ............... negative age
 *  T21 countPaperOrders: count any truthy isPaper ........ explicit-true guard
 *  T22 parseOrders: let a JSON.parse throw ............... unparseable rows
 */
