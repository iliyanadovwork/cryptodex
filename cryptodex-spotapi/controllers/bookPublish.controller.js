/**
 * THE PUBLISHED ORDER BOOK - one derivation, shared health gate.
 *
 * WHAT WENT WRONG BEFORE
 * ----------------------
 * The book the UI drew came straight off the raw Binance depth mirror
 * (lib/binanceWebSocket.js -> socketEmitAll("orderBook")). The book the matcher
 * traded came off the synthetic ladder (controllers/paperBook.controller.js).
 * Two paths, two lifetimes, two copies of "is this depth usable". When a
 * circuit breaker purged the ladder, the display carried on rendering a full,
 * fresh-looking 20-level book and NOTHING COULD FILL - for five and a half
 * hours, with every visible signal saying healthy.
 *
 * THE RULE THIS MODULE ENFORCES
 * -----------------------------
 * The displayed book is built from the SAME snapshot the ladder is built from
 * (lib/depthSource.js) and gated by the SAME verdict the ladder is gated by
 * (lib/depthHealth.assessDepthHealth) PLUS the ladder's own presence
 * (paperBook.getLadderState, re-checked against redis here). If nothing can
 * fill, the book is EMPTY and says why. It may publish faster than the 2s
 * matcher cadence - a lively book is fine - but it can never publish a
 * healthier picture than the truth.
 *
 * Everything that emits an "orderBook" payload goes through here: the websocket
 * depth callback, the 1s heartbeat, the REST snapshot the UI fetches on mount,
 * the per-order emits in spot.controller.js, and the admin-triggered partial
 * depth stream in binance.controller.js (which used to emit a raw, ungated
 * Binance book of its own).
 */

// import controller
import { hgetall, hget } from "./redis.controller.js";
import { getLadderState } from "./paperBook.controller.js";
// import config
import { socketEmitAll } from "../config/socketIO.js";
// import lib
import { resolveDepthSnapshot } from "../lib/depthSource.js";
import {
  assessDepthHealth,
  bookLevels,
  countPaperOrders,
  mergeBookLevels,
  withNotionals,
  groupLevels,
  groupingStepsFor,
  ORDER_BOOK_DEPTH,
} from "../lib/depthHealth.js";

// pairId -> monotonic sequence number. The old publisher called initSeq() on
// every emit, so every payload carried seq 0 and no consumer could ever detect
// a gap.
const seqNumbers = new Map();
const nextSeq = (pairId) => {
  const seq = (seqNumbers.get(pairId) || 0) + 1;
  seqNumbers.set(pairId, seq);
  return seq;
};

// pairId -> in-flight publish promise. Building a payload is async (redis), and
// depth events arrive every 100ms; without this, two builds could interleave
// and emit out of order.
const inFlight = new Map();
const pendingRepublish = new Map();

/**
 * The pair document, from the redis cache only.
 *
 * Deliberately NOT a mongo fallback: this runs on the websocket path at 100ms
 * and must never turn a depth tick into a database query. A pair missing from
 * the cache publishes an unhealthy book, which is the truth - the matcher
 * cannot build a ladder for it either.
 */
const cachedPairData = async (pairId) => {
  try {
    const raw = await hget("spotPairdata", String(pairId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
};

const emptyBook = (pairId, pairData, reason, extra = {}) => ({
  pairId: String(pairId),
  symbol: pairData ? pairData.tikerRoot : undefined,
  buyOrder: [],
  sellOrder: [],
  maxBidNotional: 0,
  maxAskNotional: 0,
  type: "SNAPSHOT",
  timestamp: Date.now(),
  healthy: false,
  healthReason: reason,
  // Always present, in both branches, so the UI never has to distinguish
  // "absent" from "false".
  ladderPresent: false,
  bookUpdateId: 0,
  ...extra,
});

/**
 * Build the payload the UI renders. Returns the exact shape
 * components/Spot/OrderBook.tsx already consumes, plus `healthy` /
 * `healthReason` / `bookUpdateId`.
 *
 * `pairData` may be passed by a caller that already has it (the REST path);
 * omit it and the redis pair cache is read.
 */
export const buildPublishedBook = async (
  pairId,
  pairData = undefined,
  { type = "DELTA", seq = null, now = Date.now() } = {}
) => {
  const pid = String(pairId);
  const pair =
    pairData === undefined ? await cachedPairData(pid) : pairData;

  if (!pair) {
    return emptyBook(pid, null, "no_pair", { seq: seq == null ? 0 : seq });
  }

  // ONE snapshot. The ladder is rebuilt from this same resolver on the 2s
  // matcher tick, so the display can be fresher but never different in kind.
  const book = await resolveDepthSnapshot(pid);

  // ONE verdict, the same function the ladder build calls.
  const depth = assessDepthHealth(book, pair, now);
  // ...AND the ladder's own state, because depth health is only half of "can
  // this fill": the ladder is also purged for an ineligible pair, a missing
  // admin liquidity account, a failed write, or a pair the matcher stopped
  // visiting. The display has to go empty for every one of those too.
  const ladder = getLadderState(pid, now);

  const reason = !depth.healthy
    ? depth.reason
    : !ladder.present
      ? ladder.reason
      : null;

  const seqNo = seq == null ? nextSeq(pid) : seq;

  if (reason) {
    return emptyBook(pid, pair, reason, {
      seq: seqNo,
      ladderPresent: false,
    });
  }

  // Real resting user orders are merged INTO the mirrored depth. A venue adds
  // a user's order to the book at its own level; it does not replace the book
  // with it. The synthetic ladder is excluded by bookLevels() because it is
  // itself a mirror of these very depth levels.
  let userBuy = [];
  let userSell = [];
  // Did REDIS agree that a ladder is resting? null = we could not ask.
  let restingPaperOrders = null;
  try {
    const buyHash = await hgetall(`buyOpenOrders_${pid}`);
    const sellHash = await hgetall(`sellOpenOrders_${pid}`);
    userBuy = bookLevels(buyHash);
    userSell = bookLevels(sellHash);
    // getLadderState is an in-memory assertion by the ladder's writer, and
    // there is a window in which it can be ahead of redis (another process, a
    // fill that consumed the last synthetic order, a purge in flight). These
    // are the very hashes the matcher reads at match time, and they are already
    // in hand - so verify instead of trusting, at zero extra I/O.
    restingPaperOrders = countPaperOrders(buyHash) + countPaperOrders(sellHash);
  } catch (err) {
    // A redis hiccup must not blank a book that is otherwise healthy: the
    // venue depth alone is still a true (if incomplete) picture, and an
    // unreadable hash is NOT evidence the ladder is gone.
    userBuy = [];
    userSell = [];
    restingPaperOrders = null;
  }

  if (restingPaperOrders === 0) {
    // Memory said present, redis says the book is empty of synthetic
    // liquidity. Redis wins: it is what the matcher will read.
    //
    // Deliberately TOTAL, not per side. A side that is momentarily thin - the
    // last order at a level consumed by a fill, a level group that fell under
    // MIN_NOTIONAL - is not a dead market, and blanking the whole display for
    // it would flicker the book on every large trade. A ladder with nothing on
    // either side is unambiguous. The one-sided case is a real fault and is
    // reported as `one_sided_ladder` by the fill canary, which runs on a
    // schedule and can afford to say so without strobing the UI.
    return emptyBook(pid, pair, "ladder_not_built", { seq: seqNo });
  }

  // A resting user order that is MARKETABLE against the venue depth (a buy at or
  // above the best ask, a sell at or below the best bid) is not a resting quote -
  // it is about to be filled on the next matcher tick. assessDepthHealth ran on
  // the pre-merge venue depth and said healthy, so merging such an order in would
  // publish a CROSSED book (best bid >= best ask) still flagged healthy - the
  // exact frame the crossed_book gate exists to prevent, and a display an
  // attacker could grief for every viewer by resting one aggressive limit.
  // Exclude those levels; only genuinely-resting user liquidity belongs here.
  // (The matcher clears the marketable order on its own tick; it is never shown.)
  const venueBestAsk = book.asks.length
    ? Math.min(...book.asks.map((a) => a.price))
    : Infinity;
  const venueBestBid = book.bids.length
    ? Math.max(...book.bids.map((b) => b.price))
    : -Infinity;
  userBuy = userBuy.filter((o) => o.price < venueBestAsk);
  userSell = userSell.filter((o) => o.price > venueBestBid);

  // Kept UNSLICED for the grouped ladders below: a $10 bucket needs hundreds of
  // levels behind it, so grouping the top-20 slice is what produced an almost
  // empty book at coarse steps. The raw ladder the ungrouped view draws is still
  // the top ORDER_BOOK_DEPTH of the same list.
  const allBids = mergeBookLevels(book.bids, userBuy).sort(
    (a, b) => b.price - a.price
  );
  const allAsks = mergeBookLevels(book.asks, userSell).sort(
    (a, b) => a.price - b.price
  );
  const bids = allBids.slice(0, ORDER_BOOK_DEPTH);
  const asks = allAsks.slice(0, ORDER_BOOK_DEPTH);

  // Belt-and-suspenders: two user orders resting INSIDE the spread can still
  // cross each other (a user sell that tightened the ask, then a user buy above
  // it) - a case the per-side venue filter above cannot see. A crossed book must
  // never be published, so blank it rather than emit best bid >= best ask.
  if (bids.length && asks.length && bids[0].price >= asks[0].price) {
    return emptyBook(pid, pair, "crossed_book", { seq: seqNo });
  }

  const buy = withNotionals(bids);
  const sell = withNotionals(asks);

  // PRE-GROUPED LADDERS, one per step the pair offers. Only the rows the display
  // draws are sent (GROUPED_ROWS each side), and only the three fields it reads,
  // so all four steps together cost less than shipping the raw depth they were
  // aggregated from. The client renders these directly instead of grouping the
  // top-20 itself; see groupingStepsFor for the measurements behind this.
  const grouped = {};
  for (const step of groupingStepsFor(pair?.secondCurrencySymbol)) {
    const gBids = withNotionals(groupLevels(allBids, step, "bid"));
    const gAsks = withNotionals(groupLevels(allAsks, step, "ask"));
    // Only the three fields the display reads, at display precision: a raw
    // float notional serialises as ~17 digits, and this ships on every publish.
    const compact = (row) => ({
      _id: row._id,
      quantity: Number(row.quantity.toFixed(8)),
      notional: Number(row.notional.toFixed(2)),
    });
    grouped[String(step)] = {
      buyOrder: gBids.rows.map(compact),
      sellOrder: gAsks.rows.map(compact),
    };
  }

  return {
    pairId: pid,
    symbol: pair.tikerRoot,
    buyOrder: buy.rows,
    sellOrder: sell.rows,
    grouped,
    maxBidNotional: buy.maxNotional,
    maxAskNotional: sell.maxNotional,
    seq: seqNo,
    type,
    timestamp: Date.now(),
    healthy: true,
    healthReason: null,
    ladderPresent: true,
    bookUpdateId: book.lastUpdateId || 0,
  };
};

/**
 * Build and broadcast. Serialised per pair so a burst of depth events cannot
 * emit two payloads out of order; a tick that arrives while a build is in
 * flight collapses into a single follow-up publish (the newest state is the
 * only one worth sending).
 */
export const publishOrderBook = async (pairId, type = "DELTA") => {
  const pid = String(pairId);
  if (inFlight.has(pid)) {
    pendingRepublish.set(pid, type);
    return inFlight.get(pid);
  }

  const run = (async () => {
    let payload = null;
    let nextType = type;
    try {
      // Drained in a LOOP, not by recursion: at 100ms depth ticks a recursive
      // drain would build an unbounded promise chain for as long as the feed
      // stays fast.
      do {
        pendingRepublish.delete(pid);
        payload = await buildPublishedBook(pid, undefined, { type: nextType });
        socketEmitAll("orderBook", payload);
        nextType = pendingRepublish.get(pid);
      } while (nextType !== undefined);
    } catch (err) {
      console.log("err on publishOrderBook---", err && err.message);
    } finally {
      inFlight.delete(pid);
      pendingRepublish.delete(pid);
    }
    return payload;
  })();

  inFlight.set(pid, run);
  return await run;
};

/**
 * Test/ops seam: forget the per-pair sequence counters.
 */
export const resetPublishState = () => {
  seqNumbers.clear();
  inFlight.clear();
  pendingRepublish.clear();
};
