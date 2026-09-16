/**
 * PUBLISHED ORDER BOOK vs TRADABLE LADDER (CRITICAL)
 *
 * Pins the failure that cost five and a half hours of silent breakage: the UI
 * rendered a full, fresh-looking 20-level book while the synthetic ladder the
 * matcher trades against had been purged, so nothing could fill and every
 * visible signal said healthy. The book and the ladder were derived twice, from
 * two caches, behind two copies of "is this depth usable".
 *
 * What is pinned here:
 *   1. ONE health verdict. For every circuit-breaker condition, the pure gate,
 *      the ladder build and the display publish must all name the SAME reason -
 *      there is no second copy that can drift.
 *   2. EMPTY ON UNHEALTHY. When the ladder is gone, the published book is empty
 *      and says why. Including when the DEPTH is perfectly healthy and the
 *      ladder was purged for something else entirely, which is exactly the case
 *      the old design could not represent.
 *   3. ONE SNAPSHOT. The payload carries the same venue update id the ladder was
 *      built from.
 *   4. Real resting user orders are merged INTO the book; the synthetic ladder
 *      is not double counted.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

// ---- I/O mocks. Plain functions (not jest.fn) so jest's resetMocks between
// ---- tests cannot strip the behaviour these flows depend on.

jest.mock('../../config/socketIO.js', () => {
  const emitted = [];
  return {
    __esModule: true,
    __emitted: emitted,
    socketEmitOne: () => {},
    socketEmitAll: (type, data) => {
      emitted.push({ type, data });
    }
  };
});

jest.mock('../../controllers/redis.controller.js', () => {
  const hashes = new Map();
  const strings = new Map();
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
    hdel: async (key, field) => {
      const map = hashes.get(key);
      if (map && map.delete(String(field))) return 1;
      return 0;
    }
  };
});

// The depth cache module is heavy (models, sockets, ws); only the snapshot
// accessor matters here, and it is the same accessor lib/depthSource.js uses
// for BOTH the ladder and the display.
jest.mock('../../lib/binanceWebSocket.js', () => {
  const state = { book: null };
  return {
    __esModule: true,
    __state: state,
    getDepthSnapshot: () => state.book
  };
});

import {
  syncPaperBook,
  purgePaperBook,
  getLadderState,
} from '../../controllers/paperBook.controller.js';
import {
  buildPublishedBook,
  publishOrderBook,
  resetPublishState,
} from '../../controllers/bookPublish.controller.js';
import { assessDepthHealth, bookLevels } from '../../lib/depthHealth.js';
import * as redisMock from '../../controllers/redis.controller.js';
import * as socketMock from '../../config/socketIO.js';
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
  status: 'active',
  botstatus: 'binance',
  markPrice: 63500
};

const adminLiq = { _id: ADMIN_ID, userId: '12024756', role: 'admin_bot' };

const healthyBook = () => ({
  lastUpdateId: 4242,
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

const seed = async () => {
  redisMock.__reset();
  socketMock.__emitted.length = 0;
  resetPublishState();
  await redisMock.hset('spotPairdata', PAIR_ID, pairFixture);
  await redisMock.hset('admin_liquidity', 'liquidation', adminLiq);
  wsMock.__state.book = healthyBook();
  // A pair whose ladder has never been synced is a DIFFERENT state from one
  // whose ladder was purged; start every test from a clean, purged slate.
  await purgePaperBook(PAIR_ID, 'test_reset');
};

const paperOrders = (side) => {
  const map = redisMock.__hashes.get(`${side}OpenOrders_${PAIR_ID}`);
  if (!map) return [];
  return Array.from(map.values())
    .map((v) => JSON.parse(v))
    .filter((o) => o.isPaper);
};

// ===========================================================================

describe('assessDepthHealth (PURE - the one gate)', () => {
  test('a live, two-sided, uncrossed book near markPrice is healthy', () => {
    expect(assessDepthHealth(healthyBook(), pairFixture)).toEqual({
      healthy: true,
      reason: null
    });
  });

  test('names each unusable condition', () => {
    expect(assessDepthHealth(null, pairFixture).reason).toBe('no_depth');

    const stale = healthyBook();
    stale.updatedAt = Date.now() - 60000;
    expect(assessDepthHealth(stale, pairFixture).reason).toBe('stale_depth');

    const oneSided = healthyBook();
    oneSided.asks = [];
    expect(assessDepthHealth(oneSided, pairFixture).reason).toBe('empty_side');

    const crossed = healthyBook();
    crossed.asks[0].price = 63000;
    expect(assessDepthHealth(crossed, pairFixture).reason).toBe('crossed_book');

    const runaway = healthyBook();
    runaway.asks = runaway.asks.map((a) => ({ ...a, price: a.price * 2 }));
    runaway.bids = runaway.bids.map((b) => ({ ...b, price: b.price * 2 }));
    expect(assessDepthHealth(runaway, pairFixture).reason).toBe(
      'price_deviation'
    );
  });

  test('a crossed book with a NaN price is condemned, not accepted', () => {
    const nanBook = healthyBook();
    nanBook.asks[0].price = NaN;
    expect(assessDepthHealth(nanBook, pairFixture).healthy).toBe(false);
  });

  test('a pair with no usable markPrice is not failed for deviation', () => {
    // Not knowing the mark is not evidence the depth is bad.
    expect(
      assessDepthHealth(healthyBook(), { ...pairFixture, markPrice: undefined })
        .healthy
    ).toBe(true);
  });

  test('is pure: same inputs, same verdict, no clock of its own', () => {
    const book = healthyBook();
    const at = Date.now();
    expect(assessDepthHealth(book, pairFixture, at)).toEqual(
      assessDepthHealth(book, pairFixture, at)
    );
    expect(assessDepthHealth(book, pairFixture, at + 60000).reason).toBe(
      'stale_depth'
    );
  });
});

// ===========================================================================
// THE REGRESSION. Before the fix these two answers came from two different
// code paths reading two different caches, and they disagreed for hours.
// ===========================================================================

describe('the ladder and the display share ONE verdict (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  const breakers = [
    [
      'stale_depth',
      () => {
        wsMock.__state.book.updatedAt = Date.now() - 60000;
      }
    ],
    [
      'no_depth',
      () => {
        wsMock.__state.book = null;
      }
    ],
    [
      'empty_side',
      () => {
        wsMock.__state.book.asks = [];
      }
    ],
    [
      'crossed_book',
      () => {
        wsMock.__state.book.asks[0].price = 63000;
      }
    ],
    [
      'price_deviation',
      () => {
        wsMock.__state.book.bids = wsMock.__state.book.bids.map((b) => ({
          ...b,
          price: b.price * 2
        }));
        wsMock.__state.book.asks = wsMock.__state.book.asks.map((a) => ({
          ...a,
          price: a.price * 2
        }));
      }
    ]
  ];

  test.each(breakers)(
    '%s: gate, ladder and published book all agree',
    async (reason, breakIt) => {
      // healthy first, so there is a ladder and a book to lose
      await syncPaperBook(pairFixture);
      const before = await buildPublishedBook(PAIR_ID, pairFixture);
      expect(before.healthy).toBe(true);
      expect(before.buyOrder.length).toBeGreaterThan(0);

      breakIt();

      // 1. the pure gate
      expect(assessDepthHealth(wsMock.__state.book, pairFixture).reason).toBe(
        reason
      );
      // 2. the tradable ladder
      const sync = await syncPaperBook(pairFixture);
      expect(sync).toEqual({ ok: false, reason });
      expect(paperOrders('buy')).toHaveLength(0);
      expect(paperOrders('sell')).toHaveLength(0);
      // 3. the displayed book - empty, and it says why
      const after = await buildPublishedBook(PAIR_ID, pairFixture);
      expect(after.healthy).toBe(false);
      expect(after.healthReason).toBe(reason);
      expect(after.buyOrder).toEqual([]);
      expect(after.sellOrder).toEqual([]);
      expect(after.maxBidNotional).toBe(0);
      expect(after.maxAskNotional).toBe(0);
    }
  );

  test('published book carries the same venue update id the ladder was built from', async () => {
    await syncPaperBook(pairFixture);
    const published = await buildPublishedBook(PAIR_ID, pairFixture);

    expect(published.bookUpdateId).toBe(4242);
    expect(getLadderState(PAIR_ID).bookUpdateId).toBe(4242);
    expect(paperOrders('sell')[0].bookUpdateId).toBe(4242);
  });

  test('healthy again after the depth recovers - ladder AND display together', async () => {
    await syncPaperBook(pairFixture);
    wsMock.__state.book.updatedAt = Date.now() - 60000;
    await syncPaperBook(pairFixture);
    expect((await buildPublishedBook(PAIR_ID, pairFixture)).healthy).toBe(false);

    wsMock.__state.book = healthyBook();
    const sync = await syncPaperBook(pairFixture);
    const published = await buildPublishedBook(PAIR_ID, pairFixture);

    expect(sync.ok).toBe(true);
    expect(paperOrders('sell').length).toBeGreaterThan(0);
    expect(published.healthy).toBe(true);
    expect(published.buyOrder.length).toBeGreaterThan(0);
    expect(published.sellOrder.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Depth health is only HALF of "can this fill". The ladder is also purged for
// reasons the depth knows nothing about, and the old display had no way to
// represent any of them: the depth looked perfect, so the book looked perfect.
// ===========================================================================

describe('the display goes empty for every purge, not just the depth ones (CRITICAL)', () => {
  beforeEach(async () => {
    await seed();
  });

  test('admin liquidity account disappears: depth is perfect, book is empty', async () => {
    await syncPaperBook(pairFixture);
    await redisMock.hdel('admin_liquidity', 'liquidation');

    const sync = await syncPaperBook(pairFixture);
    const published = await buildPublishedBook(PAIR_ID, pairFixture);

    // the depth itself never stopped being healthy...
    expect(assessDepthHealth(wsMock.__state.book, pairFixture).healthy).toBe(
      true
    );
    // ...but nothing can fill, so nothing is shown.
    expect(sync.reason).toBe('no_admin_liquidity');
    expect(published.healthy).toBe(false);
    expect(published.healthReason).toBe('no_admin_liquidity');
    expect(published.buyOrder).toEqual([]);
  });

  test('pair flipped away from binance', async () => {
    await syncPaperBook(pairFixture);
    await syncPaperBook({ ...pairFixture, botstatus: 'off' });

    const published = await buildPublishedBook(PAIR_ID, {
      ...pairFixture,
      botstatus: 'off'
    });

    expect(published.healthy).toBe(false);
    expect(published.healthReason).toBe('pair_ineligible');
    expect(published.buyOrder).toEqual([]);
  });

  test('before the matcher has ever run there is no book to show', async () => {
    // Fresh process, matcher has not ticked yet: the depth may be beautiful,
    // but no ladder exists, so nothing can fill.
    expect(getLadderState('695bf1017573eeb15a749c9e').reason).toBe(
      'ladder_not_built'
    );
    const published = await buildPublishedBook(
      '695bf1017573eeb15a749c9e',
      pairFixture
    );
    expect(published.healthy).toBe(false);
    expect(published.healthReason).toBe('ladder_not_built');
    expect(published.buyOrder).toEqual([]);
  });

  test('a ladder nothing has refreshed stops being displayed as tradable', async () => {
    await syncPaperBook(pairFixture);
    const later = Date.now() + 60000;
    // The DEPTH keeps flowing - only the matcher stopped. The redis ladder is
    // still sitting there until a sweep removes it, and this is the exact shape
    // of the outage: a perfect feed, a book nobody is quoting from.
    wsMock.__state.book.updatedAt = later - 100;

    expect(getLadderState(PAIR_ID, later).present).toBe(false);
    expect(getLadderState(PAIR_ID, later).reason).toBe('ladder_stale');
    expect(
      assessDepthHealth(wsMock.__state.book, pairFixture, later).healthy
    ).toBe(true);

    const published = await buildPublishedBook(PAIR_ID, pairFixture, {
      now: later
    });
    expect(published.healthy).toBe(false);
    expect(published.healthReason).toBe('ladder_stale');
    expect(published.buyOrder).toEqual([]);
  });

  test('a ladder that is gone from REDIS is not published because memory says otherwise', async () => {
    // getLadderState is an in-memory assertion by the ladder's writer. This is
    // the window the reviewer measured: memory still says "present" (nothing
    // has purged, the record is seconds old) while redis holds no synthetic
    // order at all - a fill consumed the last of it, or another process removed
    // it. The matcher reads REDIS, so redis is what the display must believe.
    await syncPaperBook(pairFixture);
    expect(getLadderState(PAIR_ID).present).toBe(true);
    expect((await buildPublishedBook(PAIR_ID, pairFixture)).healthy).toBe(true);

    for (const side of ['buy', 'sell']) {
      const map = redisMock.__hashes.get(`${side}OpenOrders_${PAIR_ID}`);
      for (const [field, value] of Array.from(map)) {
        if (JSON.parse(value).isPaper) map.delete(field);
      }
    }
    // Memory has NOT been told; it still claims a ladder is resting.
    expect(getLadderState(PAIR_ID).present).toBe(true);

    const published = await buildPublishedBook(PAIR_ID, pairFixture);
    expect(published.healthy).toBe(false);
    expect(published.healthReason).toBe('ladder_not_built');
    expect(published.ladderPresent).toBe(false);
    expect(published.buyOrder).toEqual([]);
    expect(published.sellOrder).toEqual([]);
  });

  test('the verification costs no extra redis reads', async () => {
    // The whole reason this check can run on the 100ms websocket path: the two
    // hashes it counts are the two hashes the publish already had to read to
    // merge user orders in.
    await syncPaperBook(pairFixture);
    const reads = [];
    const spy = jest
      .spyOn(redisMock, 'hgetall')
      .mockImplementation(async (key) => {
        reads.push(key);
        const map = redisMock.__hashes.get(key);
        if (!map || map.size === 0) return null;
        const out = {};
        for (const [field, value] of map) out[field] = value;
        return out;
      });
    await buildPublishedBook(PAIR_ID, pairFixture);
    spy.mockRestore();
    expect(reads).toEqual([
      `buyOpenOrders_${PAIR_ID}`,
      `sellOpenOrders_${PAIR_ID}`
    ]);
  });

  test('an unreadable hash is not treated as proof the ladder is gone', async () => {
    // The failure mode to avoid while fixing the one above: a redis hiccup must
    // blank nothing. Not knowing is not the same as knowing it is empty.
    await syncPaperBook(pairFixture);
    const spy = jest.spyOn(redisMock, 'hgetall').mockImplementation(async () => {
      throw new Error('redis down');
    });
    const published = await buildPublishedBook(PAIR_ID, pairFixture);
    spy.mockRestore();

    expect(published.healthy).toBe(true);
    expect(published.buyOrder.length).toBeGreaterThan(0);
  });

  test('a purge marks the ladder gone BEFORE it starts deleting, never after', async () => {
    // Deleting a ladder is two hgetalls and N hdels. For the whole of that
    // window the old code still reported the ladder as present, so a publish
    // landing mid-purge advertised liquidity that was being torn out from under
    // it. Recording first makes the claim pessimistic instead.
    await syncPaperBook(pairFixture);
    expect(getLadderState(PAIR_ID).present).toBe(true);

    const seenDuringDelete = [];
    const spy = jest.spyOn(redisMock, 'hdel').mockImplementation(async (key, field) => {
      seenDuringDelete.push(getLadderState(PAIR_ID).present);
      const map = redisMock.__hashes.get(key);
      return map && map.delete(String(field)) ? 1 : 0;
    });
    await purgePaperBook(PAIR_ID, 'pair_ineligible');
    spy.mockRestore();

    expect(seenDuringDelete.length).toBeGreaterThan(0);
    expect(seenDuringDelete.every((present) => present === false)).toBe(true);
    expect(getLadderState(PAIR_ID).reason).toBe('pair_ineligible');
  });

  test('a sync that completes but writes NO orders does not claim a ladder', async () => {
    // buildPaperOrders emits nothing until a level group clears MIN_NOTIONAL,
    // so depth this thin produces an empty ladder from a cycle that succeeded.
    // "The function reached its end" is not evidence that liquidity exists.
    const dustPair = { ...pairFixture, markPrice: 1 };
    wsMock.__state.book = {
      lastUpdateId: 7,
      updatedAt: Date.now(),
      bids: [{ price: 0.99, quantity: 0.0001 }],
      asks: [{ price: 1.01, quantity: 0.0001 }]
    };

    await syncPaperBook(dustPair);
    expect(paperOrders('buy')).toHaveLength(0);
    expect(paperOrders('sell')).toHaveLength(0);
    expect(getLadderState(PAIR_ID).present).toBe(false);
    expect(getLadderState(PAIR_ID).reason).toBe('ladder_not_built');

    const published = await buildPublishedBook(PAIR_ID, dustPair);
    expect(published.healthy).toBe(false);
    expect(published.healthReason).toBe('ladder_not_built');
    expect(published.buyOrder).toEqual([]);
  });

  test('an unknown pair publishes an empty book instead of throwing', async () => {
    const published = await buildPublishedBook('not-a-pair', undefined);
    expect(published.healthy).toBe(false);
    expect(published.healthReason).toBe('no_pair');
    expect(published.buyOrder).toEqual([]);
    expect(published.sellOrder).toEqual([]);
  });
});

// ===========================================================================

describe('publishOrderBook broadcast', () => {
  beforeEach(async () => {
    await seed();
  });

  const lastEmit = () => {
    const books = socketMock.__emitted.filter((e) => e.type === 'orderBook');
    return books[books.length - 1];
  };

  test('emits on the "orderBook" event with the shape the UI consumes', async () => {
    await syncPaperBook(pairFixture);
    await publishOrderBook(PAIR_ID, 'SNAPSHOT');

    const emit = lastEmit();
    expect(emit.type).toBe('orderBook');
    expect(emit.data).toEqual(
      expect.objectContaining({
        pairId: PAIR_ID,
        symbol: 'BTCUSD',
        type: 'SNAPSHOT',
        healthy: true,
        healthReason: null
      })
    );
    expect(emit.data.buyOrder[0]).toEqual(
      expect.objectContaining({
        _id: expect.any(Number),
        price: expect.any(Number),
        quantity: expect.any(Number),
        notional: expect.any(Number),
        cumulativeNotional: expect.any(Number)
      })
    );
    // best price first on both sides
    expect(emit.data.buyOrder[0]._id).toBe(63499);
    expect(emit.data.sellOrder[0]._id).toBe(63500);
    expect(emit.data.maxBidNotional).toBeCloseTo(
      emit.data.buyOrder[emit.data.buyOrder.length - 1].cumulativeNotional
    );
  });

  test('a purged ladder is broadcast as an EMPTY book, not silence', async () => {
    await syncPaperBook(pairFixture);
    await publishOrderBook(PAIR_ID);
    expect(lastEmit().data.buyOrder.length).toBeGreaterThan(0);

    wsMock.__state.book.updatedAt = Date.now() - 60000;
    await syncPaperBook(pairFixture);
    await publishOrderBook(PAIR_ID);

    // The whole point: the UI is TOLD the book is empty. Before the fix the
    // publisher simply stopped having anything new to say and the last healthy
    // payload stayed on screen forever.
    expect(lastEmit().data.buyOrder).toEqual([]);
    expect(lastEmit().data.sellOrder).toEqual([]);
    expect(lastEmit().data.healthy).toBe(false);
    expect(lastEmit().data.healthReason).toBe('stale_depth');
  });

  test('sequence numbers advance (they were pinned at 0 for every payload)', async () => {
    await syncPaperBook(pairFixture);
    await publishOrderBook(PAIR_ID);
    const first = lastEmit().data.seq;
    await publishOrderBook(PAIR_ID);
    expect(lastEmit().data.seq).toBe(first + 1);
  });

  test('concurrent publishes emit in order and do not interleave', async () => {
    await syncPaperBook(pairFixture);
    await Promise.all([
      publishOrderBook(PAIR_ID),
      publishOrderBook(PAIR_ID),
      publishOrderBook(PAIR_ID)
    ]);
    const seqs = socketMock.__emitted
      .filter((e) => e.type === 'orderBook')
      .map((e) => e.data.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

// ===========================================================================

describe('real resting user orders are merged into the published book', () => {
  beforeEach(async () => {
    await seed();
  });

  test('a user order adds size at its own level, it does not replace the book', async () => {
    await syncPaperBook(pairFixture);
    const before = await buildPublishedBook(PAIR_ID, pairFixture);
    const beforeLevel = before.buyOrder.find((l) => l._id === 63499);

    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'user-1', {
      _id: 'user-1',
      userId: USER_ID,
      price: 63499,
      quantity: 3,
      openQuantity: 3,
      status: 'open',
      buyorsell: 'buy'
    });

    const after = await buildPublishedBook(PAIR_ID, pairFixture);
    const afterLevel = after.buyOrder.find((l) => l._id === 63499);

    expect(afterLevel.quantity).toBeCloseTo(beforeLevel.quantity + 3);
    // one small user order must never blank the rest of the book
    expect(after.buyOrder.length).toBe(before.buyOrder.length);
  });

  test('a user order at a price of its own becomes a new level', async () => {
    await syncPaperBook(pairFixture);
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'user-2', {
      _id: 'user-2',
      userId: USER_ID,
      price: 63450,
      quantity: 2,
      openQuantity: 2,
      status: 'open'
    });

    const published = await buildPublishedBook(PAIR_ID, pairFixture);
    expect(published.buyOrder.map((l) => l._id)).toContain(63450);
  });

  test('the synthetic ladder is NOT double counted', async () => {
    await syncPaperBook(pairFixture);
    // The ladder is a mirror of these very depth levels; counting it as a
    // resting order too would show twice the liquidity that exists.
    expect(paperOrders('buy').length).toBeGreaterThan(0);

    const published = await buildPublishedBook(PAIR_ID, pairFixture);
    const top = published.buyOrder.find((l) => l._id === 63499);
    expect(top.quantity).toBeCloseTo(0.5);
  });

  test('bookLevels ignores paper, non-resting and non-priced orders', () => {
    const levels = bookLevels({
      paper: JSON.stringify({ price: 100, quantity: 1, isPaper: true }),
      filled: JSON.stringify({ price: 100, quantity: 1, status: 'completed' }),
      market: JSON.stringify({ price: 'market', quantity: 1, status: 'open' }),
      // `quantity` is the live remainder (see lib/depthHealth.js#bookLevels):
      // this is an order opened at 5 with 1 filled and 4 still resting.
      good: JSON.stringify({ price: 100, quantity: 4, filledQuantity: 1, status: 'open' })
    });
    expect(levels).toEqual([{ price: 100, quantity: 4 }]);
  });

  // The crossed-book gate (assessDepthHealth) runs on the RAW venue depth,
  // BEFORE resting user orders are merged in. A resting user order priced
  // through the venue best (a buy >= best ask, a sell <= best bid) is
  // marketable - it fills on the next matcher tick and is not a resting quote.
  // Merging it would publish a crossed book (best bid >= best ask) still flagged
  // healthy, which the gate exists to prevent. It must be excluded from the
  // published book. Best venue bid is 63499, best venue ask is 63500.
  test('a marketable resting BUY (>= best ask) is excluded, never crossing the book', async () => {
    await syncPaperBook(pairFixture);
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'aggr-buy', {
      _id: 'aggr-buy',
      userId: USER_ID,
      price: 63600, // above the venue ask 63500 -> marketable
      quantity: 2,
      openQuantity: 2,
      status: 'open',
      buyorsell: 'buy'
    });
    const published = await buildPublishedBook(PAIR_ID, pairFixture);
    expect(published.buyOrder.map((l) => l._id)).not.toContain(63600);
    expect(published.healthy).toBe(true);
    // and the published book is NOT crossed
    expect(published.buyOrder[0]._id).toBeLessThan(published.sellOrder[0]._id);
  });

  test('a marketable resting SELL (<= best bid) is excluded, never crossing the book', async () => {
    await syncPaperBook(pairFixture);
    await redisMock.hset(`sellOpenOrders_${PAIR_ID}`, 'aggr-sell', {
      _id: 'aggr-sell',
      userId: USER_ID,
      price: 63400, // below the venue bid 63499 -> marketable
      quantity: 2,
      openQuantity: 2,
      status: 'open',
      buyorsell: 'sell'
    });
    const published = await buildPublishedBook(PAIR_ID, pairFixture);
    expect(published.sellOrder.map((l) => l._id)).not.toContain(63400);
    expect(published.healthy).toBe(true);
    expect(published.buyOrder[0]._id).toBeLessThan(published.sellOrder[0]._id);
  });

  test('a resting BUY just inside the spread (< best ask) still shows as a new best bid', async () => {
    await syncPaperBook(pairFixture);
    await redisMock.hset(`buyOpenOrders_${PAIR_ID}`, 'inside-buy', {
      _id: 'inside-buy',
      userId: USER_ID,
      price: 63499.5, // between bid 63499 and ask 63500 -> a legitimate resting quote
      quantity: 1,
      openQuantity: 1,
      status: 'open',
      buyorsell: 'buy'
    });
    const published = await buildPublishedBook(PAIR_ID, pairFixture);
    expect(published.buyOrder.map((l) => l._id)).toContain(63499.5);
    expect(published.healthy).toBe(true);
    expect(published.buyOrder[0]._id).toBeLessThan(published.sellOrder[0]._id);
  });
});
