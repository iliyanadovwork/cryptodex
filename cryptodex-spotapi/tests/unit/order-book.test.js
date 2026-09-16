/**
 * SPOT ORDER BOOK - MEANING, NOT ARITHMETIC (CRITICAL)
 *
 * WHAT THIS FILE USED TO BE
 * -------------------------
 * 37 tests, not one of which imported anything from the service. Every test
 * built a literal array in its own body, sorted or summed it with an inline
 * expression, and asserted the result against a second copy of that
 * expression:
 *
 *     const bids = [{ price: 100 }, { price: 102 }, { price: 101 }];
 *     const sorted = [...bids].sort((a, b) => b.price - a.price);
 *     expect(sorted[0].price).toBe(102);
 *
 * That test passes whatever `lib/depthHealth.js` and
 * `controllers/bookPublish.controller.js` do. The book could publish its bids
 * ascending, double-count the synthetic ladder into every level, or drop a
 * user's resting order entirely, and this file stayed green.
 *
 * WHAT IT IS NOW
 * --------------
 * Every test calls the real exports that build the published book:
 *
 *     lib/depthHealth.js         bookLevels, mergeBookLevels, withNotionals,
 *                                ORDER_BOOK_DEPTH, parseOrders
 *     controllers/paperBook...   ladderBestPrice, ladderCapacity
 *
 * and asserts what the numbers MEAN:
 *
 *   G1  a price level is the TOTAL resting size at that price - aggregation
 *       conserves quantity, so nothing is lost and nothing is invented.
 *   G2  what is NOT liquidity is not in the book: the synthetic paper ladder
 *       (it mirrors the depth the levels come from, so counting it doubles the
 *       whole book), filled/cancelled rows that linger in the hash, and market
 *       orders, which have no price and therefore no place on a price ladder.
 *   G3  merging ADDS. A user's own resting order joins the level it belongs
 *       to; it never replaces the book, so one small order cannot blank the
 *       display.
 *   G4  best bid is the highest bid and best ask the lowest ask - which is
 *       what makes a spread positive and a crossed book detectable.
 *   G5  the display rows carry a running cumulative notional that is monotonic
 *       and ends at the true total - the UI draws its depth bars from the
 *       ratio, so a wrong total is a wrong picture.
 *   G6  capacity is what a market order can actually absorb, in BOTH units,
 *       because a market buy spends quote and a market sell delivers base.
 *
 * Run frequently and never modify without thorough review.
 */

import { describe, test, expect, jest } from '@jest/globals';

// ---- I/O mocks. `ladderBestPrice` and `ladderCapacity` are pure, but they
// ---- live in paperBook.controller.js, which opens redis and a socket at
// ---- module load. Same stubs tests/unit/book-publish.test.js uses.
jest.mock('../../config/socketIO.js', () => ({
  __esModule: true,
  socketEmitOne: () => {},
  socketEmitAll: () => {},
}));

jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  set: async () => true,
  get: async () => null,
  del: async () => true,
  hset: async () => true,
  hget: async () => null,
  hgetall: async () => null,
  hdel: async () => 0,
}));

jest.mock('../../lib/binanceWebSocket.js', () => ({
  __esModule: true,
  getDepthSnapshot: () => null,
}));

import {
  bookLevels,
  mergeBookLevels,
  withNotionals,
  parseOrders,
  ORDER_BOOK_DEPTH,
} from '../../lib/depthHealth.js';
import {
  ladderBestPrice,
  ladderCapacity,
} from '../../controllers/paperBook.controller.js';

/**
 * A raw `buyOpenOrders_<pairId>` hgetall reply: keyed by order id, the
 * serialised order as the value. This is exactly the shape redis returns.
 */
const hash = (...orders) =>
  Object.fromEntries(
    orders.map((o, i) => [`order${i}`, JSON.stringify({ status: 'open', ...o })])
  );

const byPrice = (levels) => [...levels].sort((a, b) => a.price - b.price);
const totalQuantity = (levels) =>
  levels.reduce((sum, l) => sum + l.quantity, 0);

/* ------------------------------------------------------------------ *
 * G1 - A LEVEL IS THE TOTAL SIZE AT THAT PRICE
 * ------------------------------------------------------------------ */

describe('a price level is the total resting size at that price (CRITICAL)', () => {
  test('two orders at the same price become ONE level carrying both', () => {
    const levels = bookLevels(
      hash(
        { price: 100, quantity: 2 },
        { price: 100, quantity: 3 }
      )
    );

    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ price: 100, quantity: 5 });
  });

  test('aggregation conserves quantity - nothing lost, nothing invented', () => {
    // THE MEANING of aggregation. Asserted as conservation rather than as a
    // second copy of the summing loop.
    const orders = [
      { price: 100, quantity: 2 },
      { price: 100, quantity: 3 },
      { price: 101, quantity: 1.5 },
      { price: 99, quantity: 4 },
      { price: 101, quantity: 0.5 },
    ];

    const levels = bookLevels(hash(...orders));

    expect(totalQuantity(levels)).toBeCloseTo(
      orders.reduce((sum, o) => sum + o.quantity, 0),
      10
    );
    expect(levels).toHaveLength(3); // 99, 100, 101
  });

  test('distinct prices stay distinct', () => {
    const levels = byPrice(
      bookLevels(
        hash(
          { price: 99, quantity: 1 },
          { price: 100, quantity: 1 },
          { price: 101, quantity: 1 }
        )
      )
    );

    expect(levels.map((l) => l.price)).toEqual([99, 100, 101]);
    expect(levels.every((l) => l.quantity === 1)).toBe(true);
  });

  test('the REMAINING size is what rests, and `quantity` IS the remainder', () => {
    // CORRECTED CONTRACT. This case used to expect 4 from
    // {quantity: 10, filledQuantity: 6}, i.e. `quantity - filledQuantity`.
    // That model is wrong about what the matcher stores.
    //
    // On every fill the matcher assigns `quantity` THE REMAINDER
    // (`current_buy.quantity = buyExcAmount`, which is quantity minus the
    // executed amount) and ACCUMULATES `filledQuantity`. So after a fill of e
    // on an order opened at Q: quantity = Q - e, filledQuantity = e, and
    // quantity + filledQuantity == the opened size. Subtracting one from the
    // other counts the fill twice and understates the level.
    //
    // The fixture therefore describes an order OPENED at 16 with 6 filled, of
    // which 10 is still resting - not an order opened at 10.
    const levels = bookLevels(
      hash({ price: 100, quantity: 10, filledQuantity: 6 })
    );

    expect(levels[0].quantity).toBeCloseTo(10, 10);
  });

  test('a stale openQuantity does NOT win - it is the size at PLACEMENT', () => {
    // The opposite of what this case used to assert. `openQuantity` is stamped
    // once when the order is placed and neither matcher branch ever decrements
    // it, so preferring it published the size the order was OPENED at for as
    // long as it rested. Proved live: a 0.5 SOL bid, 0.2 filled, stored as
    // {quantity: 0.3, openQuantity: 0.5, filledQuantity: 0.2}, was advertised
    // by GET /api/spot/ordeBook as 0.5 - half a SOL of bid that was not there.
    const levels = bookLevels(
      hash({ price: 100, quantity: 3, filledQuantity: 6, openQuantity: 10 })
    );

    expect(levels[0].quantity).toBeCloseTo(3, 10);
  });

  test('a fully filled order contributes no level at all', () => {
    // A fully filled order has NO REMAINDER, and the matcher records that by
    // setting `quantity` to 0 - not by leaving quantity at the opened size and
    // letting filledQuantity catch up with it. (The old fixture spelled it
    // {quantity: 10, filledQuantity: 10}, which under the real semantics is an
    // order opened at 20 with half still resting.)
    expect(
      bookLevels(hash({ price: 100, quantity: 0, filledQuantity: 10 }))
    ).toEqual([]);
  });

  test('an empty or missing hash is an empty book, not a crash', () => {
    expect(bookLevels(null)).toEqual([]);
    expect(bookLevels(undefined)).toEqual([]);
    expect(bookLevels({})).toEqual([]);
  });

  test('string-typed prices and quantities, as redis stores them, still aggregate', () => {
    const levels = bookLevels(
      hash(
        { price: '100.5', quantity: '2' },
        { price: '100.5', quantity: '3' }
      )
    );

    expect(levels).toHaveLength(1);
    expect(levels[0].price).toBeCloseTo(100.5, 10);
    expect(levels[0].quantity).toBeCloseTo(5, 10);
  });

  test('an unparseable row is skipped without taking the rest of the book with it', () => {
    const raw = {
      good1: JSON.stringify({ status: 'open', price: 100, quantity: 2 }),
      broken: '{not json',
      good2: JSON.stringify({ status: 'open', price: 100, quantity: 3 }),
    };

    expect(bookLevels(raw)).toEqual([{ price: 100, quantity: 5 }]);
    expect([...parseOrders(raw)]).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * G2 - WHAT IS NOT LIQUIDITY IS NOT IN THE BOOK
 * ------------------------------------------------------------------ */

describe('only real, resting, priced liquidity reaches the book (CRITICAL)', () => {
  test('THE DOUBLE COUNT: the synthetic paper ladder is excluded', () => {
    // The ladder is itself a mirror of the venue depth these levels are
    // merged into. Counting it would double the entire displayed book.
    const levels = bookLevels(
      hash(
        { price: 100, quantity: 2 },
        { price: 100, quantity: 50, isPaper: true }
      )
    );

    expect(levels).toEqual([{ price: 100, quantity: 2 }]);
  });

  test('a book that is ONLY paper publishes nothing', () => {
    expect(
      bookLevels(
        hash(
          { price: 100, quantity: 5, isPaper: true },
          { price: 101, quantity: 5, isPaper: true }
        )
      )
    ).toEqual([]);
  });

  test('only a literal true excludes a row - a truthy string does not', () => {
    // The flag is written as a boolean; treating "false" as paper would delete
    // real user liquidity from the display.
    const levels = bookLevels(hash({ price: 100, quantity: 2, isPaper: 'false' }));
    expect(levels).toEqual([{ price: 100, quantity: 2 }]);
  });

  test('rows that are no longer liquidity linger in the hash but not in the book', () => {
    // hdel is not always prompt; the status is what decides.
    for (const status of ['filled', 'cancelled', 'completed', 'rejected']) {
      expect(
        bookLevels(hash({ price: 100, quantity: 2, status }))
      ).toEqual([]);
    }
  });

  test('every resting status IS liquidity', () => {
    for (const status of ['open', 'pending', 'conditional']) {
      expect(bookLevels(hash({ price: 100, quantity: 2, status }))).toEqual([
        { price: 100, quantity: 2 },
      ]);
    }
  });

  test('a market order has no price and therefore no place on a price ladder', () => {
    // These rest with price "market". parseFloat("market") is NaN.
    expect(
      bookLevels(hash({ price: 'market', quantity: 2 }))
    ).toEqual([]);
  });

  test('a non-positive price or quantity is not depth', () => {
    expect(bookLevels(hash({ price: 0, quantity: 2 }))).toEqual([]);
    expect(bookLevels(hash({ price: -100, quantity: 2 }))).toEqual([]);
    expect(bookLevels(hash({ price: 100, quantity: 0 }))).toEqual([]);
    expect(bookLevels(hash({ price: 100, quantity: -2 }))).toEqual([]);
  });

  test('excluding the junk does not disturb the real levels beside it', () => {
    const levels = bookLevels(
      hash(
        { price: 100, quantity: 2 },
        { price: 100, quantity: 99, isPaper: true },
        { price: 100, quantity: 99, status: 'cancelled' },
        { price: 'market', quantity: 99 },
        { price: 100, quantity: 3 }
      )
    );

    expect(levels).toEqual([{ price: 100, quantity: 5 }]);
  });
});

/* ------------------------------------------------------------------ *
 * G3 - MERGING ADDS, IT DOES NOT REPLACE
 * ------------------------------------------------------------------ */

describe('a user order joins the book, it does not replace it (CRITICAL)', () => {
  test('a user order at an existing venue level ADDS to that level', () => {
    const venue = [{ price: 100, quantity: 10 }];
    const mine = [{ price: 100, quantity: 0.5 }];

    expect(mergeBookLevels(venue, mine)).toEqual([
      { price: 100, quantity: 10.5 },
    ]);
  });

  test('one tiny user order cannot blank a full book', () => {
    // THE MEANING. Replacement semantics here would leave the display showing
    // a single 0.5 level where twenty were.
    const venue = Array.from({ length: 20 }, (_, i) => ({
      price: 100 + i,
      quantity: 10,
    }));
    const mine = [{ price: 100, quantity: 0.5 }];

    const merged = mergeBookLevels(venue, mine);

    expect(merged).toHaveLength(20);
    expect(totalQuantity(merged)).toBeCloseTo(200.5, 10);
  });

  test('a user order at a NEW price creates its own level', () => {
    const merged = byPrice(
      mergeBookLevels([{ price: 100, quantity: 10 }], [{ price: 99.5, quantity: 1 }])
    );

    expect(merged).toEqual([
      { price: 99.5, quantity: 1 },
      { price: 100, quantity: 10 },
    ]);
  });

  test('merging conserves total quantity across any number of sides', () => {
    const a = [{ price: 100, quantity: 1 }, { price: 101, quantity: 2 }];
    const b = [{ price: 100, quantity: 3 }];
    const c = [{ price: 102, quantity: 4 }];

    expect(totalQuantity(mergeBookLevels(a, b, c))).toBeCloseTo(10, 10);
  });

  test('the display key `_id` is accepted as a price, as the published rows carry it', () => {
    // withNotionals emits `_id`; re-merging its output must not lose the price.
    const merged = mergeBookLevels(
      [{ _id: 100, quantity: 2 }],
      [{ price: 100, quantity: 3 }]
    );

    expect(merged).toEqual([{ price: 100, quantity: 5 }]);
  });

  test('junk sides and junk levels are skipped, not merged as zero-price rows', () => {
    const merged = mergeBookLevels(
      [{ price: 100, quantity: 2 }],
      null,
      undefined,
      'nonsense',
      [{ price: 0, quantity: 5 }, { price: 100, quantity: 'abc' }]
    );

    expect(merged).toEqual([{ price: 100, quantity: 2 }]);
  });

  test('merging nothing at all is an empty book', () => {
    expect(mergeBookLevels()).toEqual([]);
    expect(mergeBookLevels([], [])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * G4 - BEST PRICES, SPREAD, CROSSED BOOK
 * ------------------------------------------------------------------ */

describe('best bid is the highest and best ask the lowest (CRITICAL)', () => {
  const bids = [{ price: 100 }, { price: 102 }, { price: 101 }];
  const asks = [{ price: 105 }, { price: 103 }, { price: 104 }];

  test('the best bid is the most a buyer is offering', () => {
    expect(ladderBestPrice(bids, 'buy')).toBe(102);
  });

  test('the best ask is the least a seller will take', () => {
    expect(ladderBestPrice(asks, 'sell')).toBe(103);
  });

  test('the two together make a positive spread on an uncrossed book', () => {
    // THE MEANING of "best": any other pairing would give a wider - or
    // negative - spread. A mutant that picks the wrong extreme is caught here
    // without restating the comparison.
    const bestBid = ladderBestPrice(bids, 'buy');
    const bestAsk = ladderBestPrice(asks, 'sell');

    expect(bestAsk - bestBid).toBe(1);
    expect(bestAsk).toBeGreaterThan(bestBid);

    for (const b of bids) {
      for (const a of asks) {
        expect(a.price - b.price).toBeGreaterThanOrEqual(bestAsk - bestBid);
      }
    }
  });

  test('the mid price sits exactly between the two best prices', () => {
    const bestBid = ladderBestPrice(bids, 'buy');
    const bestAsk = ladderBestPrice(asks, 'sell');
    const mid = (bestBid + bestAsk) / 2;

    expect(mid).toBe(102.5);
    expect(mid - bestBid).toBeCloseTo(bestAsk - mid, 12);
  });

  test('a crossed book is one whose best bid is at or above its best ask', () => {
    const crossedBids = [{ price: 105 }, { price: 104 }];
    const crossedAsks = [{ price: 103 }, { price: 104 }];

    expect(
      ladderBestPrice(crossedBids, 'buy') >= ladderBestPrice(crossedAsks, 'sell')
    ).toBe(true);
    // and the uncrossed case really is the other way round
    expect(ladderBestPrice(bids, 'buy') >= ladderBestPrice(asks, 'sell')).toBe(
      false
    );
  });

  test('a locked book - equal best prices - is crossed, not tradeable-through', () => {
    expect(ladderBestPrice([{ price: 104 }], 'buy')).toBe(
      ladderBestPrice([{ price: 104 }], 'sell')
    );
  });

  test('an empty side has NO best price, which is not the same as a price of zero', () => {
    // Null and 0 both mean "nothing to cross"; a numeric 0 best bid would make
    // every sell order look crossable.
    expect(ladderBestPrice([], 'buy')).toBeNull();
    expect(ladderBestPrice(null, 'sell')).toBeNull();
    expect(ladderBestPrice(undefined, 'buy')).toBeNull();
  });

  test('unpriced rows are ignored when choosing the best price', () => {
    expect(
      ladderBestPrice(
        [{ price: 0 }, { price: 'market' }, { price: 101 }, {}, null],
        'buy'
      )
    ).toBe(101);
    expect(
      ladderBestPrice([{ price: 0 }, { price: 'market' }, { price: 101 }], 'sell')
    ).toBe(101);
  });

  test('the side genuinely changes the answer', () => {
    // A mutant that returns the same extreme for both sides is killed here.
    const prices = [{ price: 100 }, { price: 105 }];
    expect(ladderBestPrice(prices, 'buy')).toBe(105);
    expect(ladderBestPrice(prices, 'sell')).toBe(100);
  });
});

/* ------------------------------------------------------------------ *
 * G5 - THE DISPLAY ROWS
 * ------------------------------------------------------------------ */

describe('display rows carry a truthful cumulative notional (CRITICAL)', () => {
  const levels = [
    { price: 100, quantity: 2 },
    { price: 101, quantity: 1 },
    { price: 102, quantity: 3 },
  ];

  test('each row notional is its own price times its own quantity', () => {
    const { rows } = withNotionals(levels);

    expect(rows.map((r) => r.notional)).toEqual([200, 101, 306]);
  });

  test('the cumulative notional is monotonically non-decreasing', () => {
    // The UI draws each depth bar as cumulative/max; a non-monotonic running
    // total draws bars that shrink as the book deepens.
    const { rows } = withNotionals(levels);

    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].cumulativeNotional).toBeGreaterThanOrEqual(
        rows[i - 1].cumulativeNotional
      );
    }
  });

  test('the final cumulative IS the total, and that total is maxNotional', () => {
    // THE MEANING: the denominator of every depth bar is the true book total,
    // so the deepest bar is exactly full and none can overflow.
    const { rows, maxNotional } = withNotionals(levels);
    const total = levels.reduce((s, l) => s + l.price * l.quantity, 0);

    expect(maxNotional).toBeCloseTo(total, 10);
    expect(rows[rows.length - 1].cumulativeNotional).toBeCloseTo(maxNotional, 10);
  });

  test('no bar can exceed the maximum', () => {
    const { rows, maxNotional } = withNotionals(levels);

    for (const row of rows) {
      expect(row.cumulativeNotional / maxNotional).toBeLessThanOrEqual(1);
      expect(row.cumulativeNotional / maxNotional).toBeGreaterThan(0);
    }
  });

  test('each row identifies itself by its price, which is what the UI keys on', () => {
    const { rows } = withNotionals(levels);

    for (const row of rows) {
      expect(row._id).toBe(row.price);
    }
    expect(new Set(rows.map((r) => r._id)).size).toBe(rows.length);
  });

  test('an empty book has no rows and a zero maximum, not a divide by zero', () => {
    expect(withNotionals([])).toEqual({ rows: [], maxNotional: 0 });
  });

  test('the published depth is capped at the configured number of levels', () => {
    // bookPublish slices to ORDER_BOOK_DEPTH on each side.
    expect(ORDER_BOOK_DEPTH).toBe(20);

    const deep = Array.from({ length: 50 }, (_, i) => ({
      price: 100 + i,
      quantity: 1,
    }));
    const published = deep.slice(0, ORDER_BOOK_DEPTH);

    expect(published).toHaveLength(20);
    expect(withNotionals(published).rows).toHaveLength(20);
  });
});

/* ------------------------------------------------------------------ *
 * G6 - CAPACITY IS WHAT A MARKET ORDER CAN ABSORB
 * ------------------------------------------------------------------ */

describe('capacity is measured in both units an order can be expressed in (CRITICAL)', () => {
  const side = [
    { price: 100, quantity: 2 },
    { price: 101, quantity: 1 },
    { price: 102, quantity: 3 },
  ];

  test('base capacity is the total size a market SELL can deliver into', () => {
    expect(ladderCapacity(side).quantity).toBeCloseTo(6, 10);
  });

  test('quote capacity is the total a market BUY can spend, priced level by level', () => {
    // THE MEANING: not `totalQuantity * someOnePrice` - each level is worth
    // its own price. 2*100 + 1*101 + 3*102 = 607.
    expect(ladderCapacity(side).notional).toBeCloseTo(607, 10);
  });

  test('the two units are NOT interchangeable', () => {
    // A mutant that returns the base figure for both is killed here.
    const { quantity, notional } = ladderCapacity(side);
    expect(notional).not.toBeCloseTo(quantity, 2);
    expect(notional / quantity).toBeGreaterThan(100);
    expect(notional / quantity).toBeLessThan(102);
  });

  test('capacity is additive - two levels absorb the sum of what each absorbs', () => {
    const a = ladderCapacity([{ price: 100, quantity: 2 }]);
    const b = ladderCapacity([{ price: 102, quantity: 3 }]);
    const both = ladderCapacity([
      { price: 100, quantity: 2 },
      { price: 102, quantity: 3 },
    ]);

    expect(both.quantity).toBeCloseTo(a.quantity + b.quantity, 10);
    expect(both.notional).toBeCloseTo(a.notional + b.notional, 10);
  });

  test('an empty or purged ladder absorbs nothing', () => {
    // "Presence alone" let a market order twenty times the size of the book
    // through; zero capacity is the honest answer for a book that is not there.
    expect(ladderCapacity([])).toEqual({ quantity: 0, notional: 0 });
    expect(ladderCapacity(null)).toEqual({ quantity: 0, notional: 0 });
  });

  test('unpriced or unsized rows contribute no capacity', () => {
    expect(
      ladderCapacity([
        { price: 'market', quantity: 99 },
        { price: 100, quantity: 0 },
        { price: 0, quantity: 99 },
        { price: 100, quantity: 2 },
      ])
    ).toEqual({ quantity: 2, notional: 200 });
  });
});
