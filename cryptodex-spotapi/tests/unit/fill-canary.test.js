/**
 * FILL CANARY TESTS
 *
 * The canary exists because spot stopped filling for 5.5 hours while every
 * other signal said healthy. These tests therefore pin the two things that make
 * it worth having:
 *   1. it turns each way live liquidity can die into the RIGHT verdict (the
 *      root cause, not the symptom one cycle later), and
 *   2. it can never damage user state, because it never writes.
 *
 * The whole canary runs against an in-memory redis holding a real ladder, so
 * "would this fill" is answered by walking real order JSON rather than a stub.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('node-cron', () => ({ schedule: () => ({ stop: () => {} }) }));

// Mongo: only TradeHistory.findOne is ever reached (the reported last-fill time).
jest.mock('../../models/index.js', () => {
  const state = { lastTrade: null, spotPairs: [], findOneCalls: 0 };
  return {
    __esModule: true,
    __state: state,
    SpotPair: {
      find: () => {
        const query = Promise.resolve(state.spotPairs);
        query.lean = async () => state.spotPairs;
        return query;
      }
    },
    TradeHistory: {
      findOne: () => {
        state.findOneCalls += 1;
        const chain = {
          sort: () => chain,
          lean: async () => state.lastTrade
        };
        return chain;
      }
    }
  };
});

// In-memory redis. Writes are recorded so a test can assert the canary made none.
jest.mock('../../controllers/redis.controller.js', () => {
  const hashes = new Map();
  const strings = new Map();
  const ledgers = new Map();
  const writes = [];
  const hash = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  return {
    __esModule: true,
    __hashes: hashes,
    __strings: strings,
    __writes: writes,
    __reset: () => {
      hashes.clear();
      strings.clear();
      ledgers.clear();
      writes.length = 0;
    },
    set: async (key, value) => {
      writes.push(['set', key]);
      strings.set(key, value);
      return true;
    },
    get: async (key) => (strings.has(key) ? strings.get(key) : null),
    del: async (key) => {
      writes.push(['del', key]);
      strings.delete(key);
    },
    hset: async (key, field, data) => {
      writes.push(['hset', key, String(field)]);
      hash(key).set(String(field), JSON.stringify(data));
    },
    hget: async (key, field) => {
      const map = hashes.get(key);
      const value = map && map.get(String(field));
      return value === undefined ? null : value;
    },
    hgetall: async (key) => {
      const map = hashes.get(key);
      if (!map || map.size === 0) return null; // node-redis v3 returns null
      const out = {};
      for (const [field, value] of map) out[field] = value;
      return out;
    },
    hdel: async (key, field) => {
      writes.push(['hdel', key, String(field)]);
      const map = hashes.get(key);
      return map && map.delete(String(field)) ? 1 : 0;
    },
    hgetdel: async () => null,
    hincbyfloat: async (key, field, increment) => {
      writes.push(['hincbyfloat', key, String(field)]);
      return String(increment);
    },
    hincrbyfloatIfEnough: async (key, field, amount) => {
      writes.push(['hincrbyfloatIfEnough', key, String(field)]);
      return String(amount);
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
    hincby: async (key, field) => {
      writes.push(['hincby', key, String(field)]);
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

// The in-memory depth cache. Tests drive it directly to simulate the feed.
jest.mock('../../lib/binanceWebSocket.js', () => {
  const state = { snapshot: null, streams: [], streamsThrow: false };
  return {
    __esModule: true,
    __state: state,
    getDepthSnapshot: () => state.snapshot,
    getDepthStreamHealth: () => {
      if (state.streamsThrow) throw new Error('stream health unavailable');
      return state.streams;
    },
    startBinanceWebSockets: async () => {},
    stopBinanceWebSockets: () => {}
  };
});

const redisMock = require('../../controllers/redis.controller.js');
const wsMock = require('../../lib/binanceWebSocket.js');
const modelsMock = require('../../models/index.js');
const canary = require('../../controllers/fillCanary.js');
const paperBook = require('../../controllers/paperBook.controller.js');
const depthHealth = require('../../lib/depthHealth.js');

const PAIR_ID = '695bf1017573eeb15a749c9d';

const pairDoc = (over = {}) => ({
  _id: PAIR_ID,
  pairName: 'BTCUSD',
  botstatus: 'binance',
  status: 'active',
  markPrice: 64000,
  firstCurrencySymbol: 'BTC',
  secondCurrencySymbol: 'USD',
  firstFloatDigit: 8,
  secondFloatDigit: 2,
  ...over
});

const depth = (over = {}) => ({
  lastUpdateId: 1,
  updatedAt: Date.now(),
  bids: [
    { price: 63990, quantity: 2 },
    { price: 63980, quantity: 5 }
  ],
  asks: [
    { price: 64010, quantity: 2 },
    { price: 64020, quantity: 5 }
  ],
  ...over
});

/**
 * A synthetic ladder order shaped exactly like buildPaperOrders writes one,
 * including the id/orderDate pair the canary reads the write time out of.
 */
const paperOrder = (side, price, qty, writtenAt = Date.now()) => ({
  _id:
    Math.floor(writtenAt / 1000).toString(16) +
    Math.random().toString(16).slice(2).padEnd(16, '0').slice(0, 16),
  userId: 'admin-liquidity',
  pairId: PAIR_ID,
  buyorsell: side,
  orderType: 'limit',
  price,
  quantity: qty,
  openQuantity: qty,
  status: 'open',
  isMaker: true,
  isPaper: true,
  orderDate: new Date(writtenAt - 60000).toISOString()
});

const seedLadder = async (orders) => {
  for (const order of orders) {
    await redisMock.hset(`${order.buyorsell}OpenOrders_${PAIR_ID}`, order._id, order);
  }
  redisMock.__writes.length = 0; // seeding is not the canary's doing
};

const seedPair = async (pair = pairDoc()) => {
  await redisMock.hset('spotPairdata', String(pair._id), pair);
  redisMock.__writes.length = 0;
};

const healthyLadder = (writtenAt = Date.now()) => [
  paperOrder('buy', 63990, 2, writtenAt),
  paperOrder('buy', 63980, 5, writtenAt),
  paperOrder('sell', 64010, 2, writtenAt),
  paperOrder('sell', 64020, 5, writtenAt)
];

beforeEach(async () => {
  redisMock.__reset();
  canary.__resetCanaryState();
  wsMock.__state.snapshot = depth();
  wsMock.__state.streams = [];
  wsMock.__state.streamsThrow = false;
  // paperBook's ladder record is what the canary reads for the CAUSE of a
  // missing ladder; every case starts from "nothing has ever synced".
  paperBook.__resetPaperBookState();
  modelsMock.__state.lastTrade = { createdAt: new Date(), pairName: 'BTCUSD' };
  modelsMock.__state.spotPairs = [];
  modelsMock.__state.findOneCalls = 0;
  await seedPair();
});

afterEach(() => {
  canary.stopFillCanary();
});

// ---------------------------------------------------------------------------

describe('simulateMarketFill (pure dry run)', () => {
  test('fills a probe by walking the asks best price first', () => {
    const result = canary.simulateMarketFill(
      [
        { buyorsell: 'sell', price: 64020, openQuantity: 5, quantity: 5, status: 'open' },
        { buyorsell: 'sell', price: 64010, openQuantity: 5, quantity: 5, status: 'open' }
      ],
      'buy',
      100
    );
    expect(result.fillable).toBe(true);
    expect(result.bestPrice).toBe(64010); // cheapest ask consumed first
    expect(result.avgPrice).toBe(64010);
    expect(result.levelsConsumed).toBe(1);
  });

  test('walks the bids high price first for a sell probe', () => {
    const result = canary.simulateMarketFill(
      [
        { buyorsell: 'buy', price: 63980, openQuantity: 5, quantity: 5, status: 'open' },
        { buyorsell: 'buy', price: 63990, openQuantity: 5, quantity: 5, status: 'open' }
      ],
      'sell',
      100
    );
    expect(result.fillable).toBe(true);
    expect(result.bestPrice).toBe(63990);
  });

  test('reports unfillable when the book cannot absorb the probe', () => {
    const result = canary.simulateMarketFill(
      [{ buyorsell: 'sell', price: 100, openQuantity: 0.01, quantity: 0.01, status: 'open' }],
      'buy',
      100
    );
    expect(result.fillable).toBe(false);
    expect(result.availableNotional).toBe(1);
  });

  test('an empty book is never fillable', () => {
    expect(canary.simulateMarketFill([], 'buy', 10).fillable).toBe(false);
    expect(canary.simulateMarketFill(null, 'sell', 10).fillable).toBe(false);
  });

  test('ignores closed orders and orders with no open quantity', () => {
    const result = canary.simulateMarketFill(
      [
        { buyorsell: 'sell', price: 10, openQuantity: 100, quantity: 100, status: 'completed' },
        { buyorsell: 'sell', price: 10, openQuantity: 0, quantity: 0, status: 'open' }
      ],
      'buy',
      10
    );
    expect(result.fillable).toBe(false);
    expect(result.restingLevels).toBe(0);
  });

  test('spans multiple levels and prices the walk, not just the top', () => {
    const result = canary.simulateMarketFill(
      [
        { buyorsell: 'sell', price: 100, openQuantity: 0.05, quantity: 0.05, status: 'open' },
        { buyorsell: 'sell', price: 200, openQuantity: 1, quantity: 1, status: 'open' }
      ],
      'buy',
      10
    );
    expect(result.fillable).toBe(true);
    expect(result.levelsConsumed).toBe(2);
    expect(result.avgPrice).toBeGreaterThan(100);
    expect(result.avgPrice).toBeLessThan(200);
  });
});

describe('ladderWrittenAt (matcher liveness signal)', () => {
  test('recovers the write time from a ladder order', () => {
    const writtenAt = Date.now();
    const order = paperOrder('buy', 1, 1, writtenAt);
    // Whole-second id granularity means up to 1s of pessimism, never optimism.
    expect(canary.ladderWrittenAt(order)).toBeGreaterThan(writtenAt - 1500);
    expect(canary.ladderWrittenAt(order)).toBeLessThanOrEqual(writtenAt + 1);
  });

  test('still works when only orderDate is readable', () => {
    const writtenAt = Date.now();
    const order = { _id: 'not-hex', orderDate: new Date(writtenAt - 60000) };
    expect(canary.ladderWrittenAt(order)).toBe(writtenAt);
  });

  test('returns 0 rather than a bogus timestamp when nothing is readable', () => {
    expect(canary.ladderWrittenAt({})).toBe(0);
    expect(canary.ladderWrittenAt(null)).toBe(0);
  });
});

describe('evaluateDepth does not own the rule, it reports on it', () => {
  // The canary used to re-declare DEPTH_STALE_MS and the 5% deviation guard as
  // its own constants, under a comment claiming they were shared with the
  // ladder. Two copies of a threshold WILL drift, and the drift is invisible:
  // the canary would go on reporting healthy about a feed the ladder is
  // purging on, which is precisely the blindness it was built to end.

  test('the threshold it reports to operators is the gate\'s own, not a second copy', async () => {
    // The health endpoint publishes staleAfterMs so an operator can read the
    // depth age against the rule that judges it. If the two ever come from
    // different constants, that number is a lie and this fails.
    const reported = await canary.evaluatePair(pairDoc());
    expect(reported.depth.staleAfterMs).toBe(depthHealth.DEPTH_STALE_MS);
  });

  test('agrees with the shared gate on every book, healthy or not', () => {
    const now = Date.now();
    const books = [
      null,
      depth(),
      depth({ updatedAt: now - depthHealth.DEPTH_STALE_MS - 1 }),
      depth({ updatedAt: now - depthHealth.DEPTH_STALE_MS + 1000 }),
      depth({ asks: [] }),
      depth({ bids: [] }),
      depth({ asks: [{ price: 63000, quantity: 1 }] }),
      depth({ updatedAt: undefined })
    ];
    const pairs = [pairDoc(), pairDoc({ markPrice: 10000 }), pairDoc({ markPrice: 0 })];
    for (const book of books) {
      for (const pair of pairs) {
        const gate = depthHealth.assessDepthHealth(book, pair, now);
        const reported = canary.evaluateDepth(book, pair, now).verdict;
        expect(reported).toBe(gate.healthy ? 'ok' : gate.reason);
      }
    }
  });

  test('a snapshot with no usable timestamp is condemned, not assumed fresh', () => {
    // `now - undefined` is NaN and every comparison against it is false, so a
    // book that could not say when it was taken used to sail through the
    // staleness check on both sides.
    expect(canary.evaluateDepth(depth({ updatedAt: undefined }), pairDoc()).verdict).toBe(
      'stale_depth'
    );
    expect(
      depthHealth.assessDepthHealth(depth({ updatedAt: undefined }), pairDoc()).reason
    ).toBe('stale_depth');
  });
});

describe('evaluateDepth mirrors the ladder circuit breakers', () => {
  test('healthy depth passes', () => {
    expect(evaluateVerdict(depth())).toBe('ok');
  });
  test('missing depth', () => {
    expect(canary.evaluateDepth(null, pairDoc()).verdict).toBe('no_depth');
  });
  test('stale depth', () => {
    expect(evaluateVerdict(depth({ updatedAt: Date.now() - 120000 }))).toBe('stale_depth');
  });
  test('empty side', () => {
    expect(evaluateVerdict(depth({ asks: [] }))).toBe('empty_side');
  });
  test('crossed book', () => {
    expect(
      evaluateVerdict(depth({ asks: [{ price: 63000, quantity: 1 }] }))
    ).toBe('crossed_book');
  });
  test('price deviation from markPrice', () => {
    expect(
      canary.evaluateDepth(depth(), pairDoc({ markPrice: 10000 })).verdict
    ).toBe('price_deviation');
  });

  function evaluateVerdict(book) {
    return canary.evaluateDepth(book, pairDoc()).verdict;
  }
});

describe('evaluatePair reports the ROOT CAUSE', () => {
  test('healthy platform: a probe would fill both ways', async () => {
    await seedLadder(healthyLadder());
    const result = await canary.evaluatePair(pairDoc());
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('ok');
    expect(result.ladder.buy).toBe(2);
    expect(result.ladder.sell).toBe(2);
    expect(result.simulation.buy.fillable).toBe(true);
    expect(result.simulation.sell.fillable).toBe(true);
  });

  test('dead depth feed is reported as the feed, not as the empty ladder it causes', async () => {
    wsMock.__state.snapshot = null; // websocket down AND no redis fallback
    const result = await canary.evaluatePair(pairDoc());
    expect(result.verdict).toBe('no_depth');
    expect(result.ok).toBe(false);
  });

  test('stale depth beats every downstream symptom', async () => {
    wsMock.__state.snapshot = depth({ updatedAt: Date.now() - 300000 });
    await seedLadder(healthyLadder());
    expect((await canary.evaluatePair(pairDoc())).verdict).toBe('stale_depth');
  });

  test('a short-circuited check reports the ladder as unchecked, never as empty', async () => {
    // The ladder is fine here; only the feed is dead. Reporting "0 orders"
    // would invent a second fault and point the reader at the wrong file.
    await seedLadder(healthyLadder());
    wsMock.__state.snapshot = depth({ updatedAt: Date.now() - 300000 });
    const result = await canary.evaluatePair(pairDoc());
    expect(result.verdict).toBe('stale_depth');
    expect(result.ladder.checked).toBe(false);
    expect(result.ladder.buy).toBeNull();
  });

  test('a depth timestamp from a slightly fast clock never reports a negative age', async () => {
    wsMock.__state.snapshot = depth({ updatedAt: Date.now() + 500 });
    await seedLadder(healthyLadder());
    const result = await canary.evaluatePair(pairDoc());
    expect(result.depth.ageMs).toBe(0);
    expect(result.ok).toBe(true);
  });

  test('healthy depth but no ladder means the matcher never wrote one', async () => {
    const result = await canary.evaluatePair(pairDoc());
    expect(result.verdict).toBe('no_ladder');
  });

  test('an old ladder is a stalled matcher, even with a perfect book', async () => {
    await seedLadder(healthyLadder(Date.now() - 120000));
    const result = await canary.evaluatePair(pairDoc());
    expect(result.verdict).toBe('matcher_stalled');
    expect(result.ladder.stalled).toBe(true);
  });

  test('one-sided ladder is caught before the dry run', async () => {
    await seedLadder([paperOrder('sell', 64010, 2), paperOrder('sell', 64020, 5)]);
    expect((await canary.evaluatePair(pairDoc())).verdict).toBe('one_sided_ladder');
  });

  test('a ladder too thin to absorb the probe is a failure', async () => {
    await seedLadder([
      paperOrder('buy', 63990, 0.00000001),
      paperOrder('sell', 64010, 0.00000001)
    ]);
    const result = await canary.evaluatePair(pairDoc());
    expect(result.verdict).toBe('insufficient_liquidity');
  });

  test('depth read from the redis fallback still counts as depth', async () => {
    wsMock.__state.snapshot = null;
    const book = depth();
    await redisMock.set(
      `depth_meta_binance_${PAIR_ID}`,
      JSON.stringify({ ts: Date.now(), lastUpdateId: 9 })
    );
    await redisMock.set(`buy_depth_binance_${PAIR_ID}`, JSON.stringify(book.bids));
    await redisMock.set(`sell_depth_binance_${PAIR_ID}`, JSON.stringify(book.asks));
    await seedLadder(healthyLadder());
    const result = await canary.evaluatePair(pairDoc());
    expect(result.depth.source).toBe('redis');
    expect(result.ok).toBe(true);
  });

  test('a user limit order is liquidity too', async () => {
    // Real orders are matchable, so the dry run must count them - but only the
    // synthetic ones prove the ladder is alive.
    await seedLadder(healthyLadder());
    const userOrder = { ...paperOrder('sell', 64005, 1), isPaper: false, userId: 'user-1' };
    await redisMock.hset(`sellOpenOrders_${PAIR_ID}`, userOrder._id, userOrder);
    const result = await canary.evaluatePair(pairDoc());
    expect(result.ladder.sell).toBe(2); // paper only
    expect(result.ladder.userOrders).toBe(1);
    expect(result.simulation.buy.bestPrice).toBe(64005);
  });
});

// ---------------------------------------------------------------------------
// THE MISDIAGNOSIS. An empty ladder is a symptom with five different causes,
// and paperBook recorded which one at the instant it purged. The canary used to
// report every one of them as "no_ladder", whose remedy sends the operator to
// the 2s matching cron - a subsystem that, in four of the five cases, is
// working perfectly. The right answer was already in memory, unread.
// ---------------------------------------------------------------------------

describe('an empty ladder is reported by its CAUSE, not by its symptom', () => {
  const seedDepthForLadder = async () => {
    // paperBook resolves depth through the same mocked cache the canary does.
    wsMock.__state.snapshot = depth();
  };

  test('a missing admin liquidity account names the account, not the cron', async () => {
    await seedDepthForLadder();
    // No admin_liquidity/liquidation in redis: paperBook cannot build a ladder
    // and records exactly that.
    const sync = await paperBook.syncPaperBook(pairDoc());
    expect(sync.reason).toBe('no_admin_liquidity');
    redisMock.__writes.length = 0;

    const result = await canary.evaluatePair(pairDoc());
    expect(result.verdict).toBe('no_admin_liquidity');
    expect(result.ladder.checked).toBe(true);
    expect(result.ladder.claimedPresent).toBe(false);
    expect(result.ladder.claimedReason).toBe('no_admin_liquidity');
  });

  test('the operator-facing remedy follows the verdict', async () => {
    const logged = [];
    jest.spyOn(console, 'error').mockImplementation((...args) => logged.push(args.join(' ')));
    canary.emitVerdict('BTCUSD', false, 'no_admin_liquidity', 'ladder=0b/0s');
    const line = logged.join('\n');
    expect(line).toContain('verdict=no_admin_liquidity');
    expect(line).toContain('admin_liquidity');
    // The wrong answer it used to give: chase the matching cron.
    expect(line).not.toContain('2s matching cron');
    jest.restoreAllMocks();
  });

  test('a pair that may not carry a ladder is not a broken matcher', async () => {
    await seedDepthForLadder();
    await redisMock.hset('admin_liquidity', 'liquidation', { _id: 'admin-1', userId: '1' });
    await paperBook.syncPaperBook(pairDoc());
    // ...then an admin flips it away from binance.
    const sync = await paperBook.syncPaperBook(pairDoc({ botstatus: 'off' }));
    expect(sync.ok).toBe(false);
    redisMock.__writes.length = 0;

    const result = await canary.evaluatePair(pairDoc());
    expect(result.verdict).toBe('pair_ineligible');
    expect(canary.ladderVerdict({ reason: 'pair_ineligible', at: Date.now() })).toBe(
      'pair_ineligible'
    );
  });

  test('a ladder nothing ever built is still the canary\'s own no_ladder', async () => {
    // Nothing recorded at all: paperBook has never run for this pair, which
    // genuinely IS "the matcher has not visited it" - the one case where the
    // cron remedy is the right one.
    const result = await canary.evaluatePair(pairDoc());
    expect(result.verdict).toBe('no_ladder');
    expect(canary.ladderVerdict({ reason: 'ladder_not_built', at: 0 })).toBe('no_ladder');
  });

  test('an unrecognised ladder reason degrades to no_ladder, never to a bare code', async () => {
    // A verdict with no remedy behind it prints "unrecognised verdict" at an
    // operator who is already having a bad day.
    expect(canary.ladderVerdict({ reason: 'something_new', at: Date.now() })).toBe(
      'no_ladder'
    );
    expect(canary.ladderVerdict(null)).toBe('no_ladder');
  });

  test('every ladder reason paperBook can record has remedy text behind it', () => {
    // paperBook's vocabulary, from its own purge sites. If a new purge reason
    // is added there without a remedy here, the canary silently loses the
    // ability to explain it.
    const reasons = [
      'pair_ineligible',
      'no_admin_liquidity',
      'ladder_not_built',
      'ladder_stale',
      'ladder_orphaned',
      'error',
      'no_pair',
      'stale_depth',
      'no_depth',
      'empty_side',
      'crossed_book',
      'price_deviation'
    ];
    const logged = [];
    jest.spyOn(console, 'error').mockImplementation((...args) => logged.push(args.join(' ')));
    for (const reason of reasons) {
      logged.length = 0;
      canary.emitVerdict(`pair-${reason}`, false, reason, '');
      expect(logged.join('\n')).not.toContain('unrecognised verdict');
    }
    jest.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// The connection-level view. During the outage this was measured and never
// surfaced: every operator-visible signal was downstream of the feed.
// ---------------------------------------------------------------------------

describe('the depth feed connection state is surfaced, not just its symptoms', () => {
  const stream = (over = {}) => ({
    pairId: PAIR_ID,
    pairName: 'BTCUSD',
    symbol: 'BTCUSDT',
    connected: true,
    readyState: 1,
    silentForMs: 120,
    protocolSilentForMs: 120,
    reconnectPending: false,
    lastUpdateId: 99,
    depthAgeMs: 120,
    bufferedEvents: 0,
    ...over
  });

  const call = async () => {
    const res = { code: null, body: null };
    res.status = (code) => {
      res.code = code;
      return res;
    };
    res.json = (body) => {
      res.body = body;
      return res;
    };
    await canary.healthCheck({}, res);
    return res;
  };

  test('GET /api/spot/health carries every stream and a summary of them', async () => {
    wsMock.__state.streams = [
      stream(),
      stream({ pairId: 'p2', pairName: 'ETHUSD', connected: false, reconnectPending: true, silentForMs: 90000 })
    ];
    await seedLadder(healthyLadder());
    const res = await call();

    expect(res.body.depthFeed.streams).toHaveLength(2);
    expect(res.body.depthFeed.summary).toEqual({
      total: 2,
      connected: 1,
      reconnecting: 1,
      desynced: 0,
      buffered: 0,
      maxSilentForMs: 90000,
      allConnected: false
    });
  });

  test('a desynced stream buffering events is visible before it starves the book', async () => {
    // The shape that is invisible from the depth age alone: connected, frames
    // arriving, but stuck at lastUpdateId 0 with events piling into the resync
    // buffer. The cache stays fresh right up until it does not.
    wsMock.__state.streams = [stream({ lastUpdateId: 0, bufferedEvents: 412 })];
    const summary = canary.summariseStreams(wsMock.__state.streams);
    expect(summary.desynced).toBe(1);
    expect(summary.buffered).toBe(412);
    expect(summary.allConnected).toBe(true); // connected, and still broken
  });

  test('a stream that ticked after the clock was sampled never reports a negative silence', () => {
    // `now` is taken once at the top of the evaluation and the feed keeps
    // ticking underneath it, so the raw numbers can go slightly negative on a
    // perfectly healthy stream. "silent for -2ms" reads as a broken dashboard.
    wsMock.__state.streams = [
      stream({ silentForMs: -2, protocolSilentForMs: -2, depthAgeMs: -2 })
    ];
    const [read] = canary.readDepthStreams();
    expect(read.silentForMs).toBe(0);
    expect(read.protocolSilentForMs).toBe(0);
    expect(read.depthAgeMs).toBe(0);
    expect(canary.summariseStreams([read]).maxSilentForMs).toBe(0);
  });

  test('an unmeasured feed reports null, not a fabricated zero', () => {
    expect(canary.summariseStreams([])).toBeNull();
    expect(canary.summariseStreams(null)).toBeNull();
  });

  test('a failure to read stream health never takes down the health endpoint', async () => {
    wsMock.__state.streamsThrow = true;
    await seedLadder(healthyLadder());
    const res = await call();
    expect(res.code).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.depthFeed.streams).toEqual([]);
    expect(res.body.depthFeed.summary).toBeNull();
  });

  test('the stream view exposes system state only', async () => {
    wsMock.__state.streams = [stream()];
    const res = await call();
    const body = JSON.stringify(res.body.depthFeed);
    expect(body).not.toContain('userId');
    expect(body).not.toContain('walletbalance');
  });
});

describe('the canary never writes', () => {
  test('a full healthy run performs zero redis writes', async () => {
    await seedLadder(healthyLadder());
    await canary.runCanary();
    expect(redisMock.__writes).toEqual([]);
  });

  test('every failure path is also write-free', async () => {
    // The dangerous case: a broken platform must not tempt the canary into
    // "fixing" the book. It has no write path at all, on any verdict.
    for (const breakIt of [
      async () => {
        wsMock.__state.snapshot = null;
      },
      async () => {
        wsMock.__state.snapshot = depth({ updatedAt: 0 });
      },
      async () => {
        wsMock.__state.snapshot = depth();
        await seedLadder(healthyLadder(Date.now() - 300000));
      }
    ]) {
      redisMock.__reset();
      canary.__resetCanaryState();
      await seedPair();
      await breakIt();
      await canary.runCanary();
      expect(redisMock.__writes).toEqual([]);
    }
  });

  test('the ladder it inspected is left exactly as it found it', async () => {
    await seedLadder(healthyLadder());
    const before = await redisMock.hgetall(`sellOpenOrders_${PAIR_ID}`);
    await canary.runCanary();
    expect(await redisMock.hgetall(`sellOpenOrders_${PAIR_ID}`)).toEqual(before);
  });
});

describe('failure output is loud, actionable and rate limited', () => {
  let logged;
  beforeEach(() => {
    logged = [];
    jest.spyOn(console, 'error').mockImplementation((...args) => logged.push(args.join(' ')));
    jest.spyOn(console, 'log').mockImplementation((...args) => logged.push(args.join(' ')));
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a new failure logs immediately with the verdict and a remedy', () => {
    const emitted = canary.emitVerdict('BTCUSD', false, 'stale_depth', 'depthAgeMs=90000');
    expect(emitted).toBe(true);
    const line = logged.join('\n');
    expect(line).toContain('[FILL-CANARY] CANNOT FILL BTCUSD');
    expect(line).toContain('verdict=stale_depth');
    expect(line).toContain('depthAgeMs=90000');
    expect(line).toContain('WHY:'); // actionable, not just a code
  });

  test('an unchanged failure is suppressed until the repeat window elapses', () => {
    const t0 = Date.now();
    expect(canary.emitVerdict('BTCUSD', false, 'no_depth', 'x', t0)).toBe(true);
    expect(canary.emitVerdict('BTCUSD', false, 'no_depth', 'x', t0 + 60000)).toBe(false);
    expect(canary.emitVerdict('BTCUSD', false, 'no_depth', 'x', t0 + 120000)).toBe(false);
    // ...and re-states itself once the window is up, with how long it has been down
    logged.length = 0;
    expect(canary.emitVerdict('BTCUSD', false, 'no_depth', 'x', t0 + 700000)).toBe(true);
    expect(logged.join('\n')).toContain('still failing after 700s');
  });

  test('a CHANGED verdict is never suppressed', () => {
    const t0 = Date.now();
    canary.emitVerdict('BTCUSD', false, 'no_depth', 'x', t0);
    expect(canary.emitVerdict('BTCUSD', false, 'matcher_stalled', 'x', t0 + 1000)).toBe(true);
  });

  test('failures are throttled per pair, not globally', () => {
    const t0 = Date.now();
    expect(canary.emitVerdict('BTCUSD', false, 'no_depth', 'x', t0)).toBe(true);
    expect(canary.emitVerdict('ETHUSD', false, 'no_depth', 'x', t0 + 1)).toBe(true);
  });

  test('recovery is announced exactly once', () => {
    const t0 = Date.now();
    canary.emitVerdict('BTCUSD', false, 'no_depth', 'x', t0);
    logged.length = 0;
    expect(canary.emitVerdict('BTCUSD', true, 'ok', '', t0 + 30000)).toBe(true);
    expect(logged.join('\n')).toContain('RECOVERED BTCUSD');
    logged.length = 0;
    canary.emitVerdict('BTCUSD', true, 'ok', '', t0 + 60000);
    expect(logged.join('\n')).toBe('');
  });

  test('a healthy platform logs nothing at all', async () => {
    await seedLadder(healthyLadder());
    logged.length = 0;
    await canary.runCanary();
    await canary.runCanary();
    expect(logged.join('\n')).toBe('');
  });
});

describe('health endpoint', () => {
  const call = async () => {
    const res = { code: null, body: null };
    res.status = (code) => {
      res.code = code;
      return res;
    };
    res.json = (body) => {
      res.body = body;
      return res;
    };
    await canary.healthCheck({}, res);
    return res;
  };

  test('reports healthy with depth, ladder, last fill and last canary result', async () => {
    await seedLadder(healthyLadder());
    await canary.runCanary();
    const res = await call();
    expect(res.code).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.pairs[0].symbol).toBe('BTCUSD');
    expect(res.body.pairs[0].depth.ageMs).not.toBeNull();
    expect(res.body.pairs[0].ladder.buy).toBe(2);
    expect(res.body.matcher.running).toBe(true);
    expect(res.body.lastFill.at).not.toBeNull();
    expect(res.body.canary.lastVerdict).toBe('ok');
    expect(res.body.canary.consecutiveFailures).toBe(0);
  });

  test('returns 503 and the reason when nothing can fill', async () => {
    wsMock.__state.snapshot = null;
    await canary.runCanary();
    const res = await call();
    expect(res.code).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(res.body.pairs[0].verdict).toBe('no_depth');
    expect(res.body.canary.consecutiveFailures).toBe(1);
  });

  test('never exposes user data', async () => {
    await seedLadder(healthyLadder());
    const userOrder = { ...paperOrder('sell', 64005, 1), isPaper: false, userId: 'user-secret' };
    await redisMock.hset(`sellOpenOrders_${PAIR_ID}`, userOrder._id, userOrder);
    const res = await call();
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('user-secret');
    expect(body).not.toContain('userId');
    expect(body).not.toContain('walletbalance');
  });

  test('a burst of requests collapses onto one cached evaluation', async () => {
    await seedLadder(healthyLadder());
    modelsMock.__state.findOneCalls = 0;
    await Promise.all([call(), call(), call(), call(), call()]);
    // The last-fill lookup is the only mongo query in the whole check.
    expect(modelsMock.__state.findOneCalls).toBeLessThanOrEqual(1);
  });

  test('degrades to a verdict instead of throwing when redis dies', async () => {
    jest
      .spyOn(redisMock, 'hgetall')
      .mockImplementation(async () => {
        throw new Error('redis down');
      });
    const res = await call();
    expect([200, 503]).toContain(res.code);
    expect(res.body.status).toBe('unhealthy');
    jest.restoreAllMocks();
  });
});

describe('roll-up status', () => {
  test('no eligible pairs is unhealthy, not healthy-by-vacuum', () => {
    expect(canary.summarise([]).status).toBe('unhealthy');
    expect(canary.summarise([]).verdict).toBe('no_pairs');
  });
  test('one dead market out of two is degraded', () => {
    const status = canary.summarise([
      { ok: true, verdict: 'ok' },
      { ok: false, verdict: 'no_depth' }
    ]);
    expect(status.status).toBe('degraded');
    expect(status.verdict).toBe('no_depth');
  });
  test('every market dead is unhealthy', () => {
    expect(
      canary.summarise([{ ok: false, verdict: 'stale_depth' }]).status
    ).toBe('unhealthy');
  });
});

describe('lifecycle', () => {
  test('start is a no-op under NODE_ENV=test so tests never spawn a timer', () => {
    expect(canary.startFillCanary()).toBeNull();
  });
});
