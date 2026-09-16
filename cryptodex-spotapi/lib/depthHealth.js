/**
 * SHARED DEPTH HEALTH GATE + BOOK LEVEL ALGEBRA
 *
 * THE BUG THIS FILE EXISTS TO PREVENT
 * -----------------------------------
 * The displayed order book and the liquidity the matcher actually trades
 * against used to be derived twice, independently:
 *
 *   lib/binanceWebSocket.js  -> raw depth cache -> socketEmitAll("orderBook")
 *   paperBook.controller.js  -> raw depth cache -> synthetic resting ladder
 *
 * Same ultimate origin, but two lifetimes and two copies of "is this depth
 * usable". When the ladder was purged by a circuit breaker the display kept
 * rendering a full, pretty, 20-level book - so every visible signal said
 * "healthy" while nothing on the exchange could fill.
 *
 * The verdict is therefore computed exactly ONCE, here, by a pure function that
 * the ladder build, the display publish AND the fill canary all call. There is
 * no second copy to drift - not of the function, and not of the thresholds it
 * compares against (controllers/fillCanary.js used to re-declare both while
 * carrying a comment claiming they were shared; it now imports them).
 *
 * PURE by construction: no redis, no sockets, no clock of its own (the caller
 * passes `now`). That is what makes it cheap enough for the display to run at
 * websocket rate and safe enough for the matcher to bet money on.
 */

// Depth older than this -> unusable. This MUST exceed the slowest path that
// refreshes the book, otherwise the ladder is stale more often than not and
// nothing can ever fill. The depth websocket updates every 100ms; when it drops
// the watchdog in lib/binanceWebSocket.js re-snapshots over REST, so 45s leaves
// a healthy feed comfortably inside the window and still condemns a genuinely
// dead one inside a minute.
export const DEPTH_STALE_MS = Number(process.env.PAPER_BOOK_STALE_MS || 45000);

// Reject if the best ask deviates more than this fraction from markPrice.
export const PRICE_DEVIATION_GUARD = Number(
  process.env.PAPER_BOOK_CROSS_GUARD || 0.05
);

/**
 * A synthetic ladder that nothing has rewritten for this long is no longer
 * trustworthy as tradable liquidity. syncPaperBook only ever runs from inside
 * matchingcall(), on the 2s matcher cron, so 15s is over seven missed cycles -
 * not jitter, a matcher that has stopped visiting the pair.
 *
 * ONE DEFINITION, ONE ENV VAR. This threshold used to exist twice under two
 * different names: `LADDER_STALE_MS`/PAPER_BOOK_LADDER_STALE_MS in
 * controllers/paperBook.controller.js (the verdict the display and the order
 * gate act on) and `LADDER_MAX_AGE_MS`/SPOT_CANARY_LADDER_MAX_AGE_MS in
 * controllers/fillCanary.js (the verdict the operator is shown). Same number,
 * same meaning, two knobs - so tuning the documented one moved the gate and
 * left the monitor reporting against the old value, i.e. the canary would call
 * a ladder fine that the gate had already condemned. That is the exact
 * blindness this whole subsystem exists to end, so there is now one constant
 * and one env var: PAPER_BOOK_LADDER_STALE_MS.
 *
 * Distinct from PAPER_BOOK_ORPHAN_MS, which is when a ladder is physically
 * swept out of redis. This is when it stops COUNTING as liquidity.
 */
export const LADDER_STALE_MS = Number(
  process.env.PAPER_BOOK_LADDER_STALE_MS || 15000
);

// Price levels published per side.
export const ORDER_BOOK_DEPTH = 20;

/**
 * How many GROUPED rows to publish per side. components/spot/OrderBook draws 8;
 * a small margin means a display that shows a couple more does not starve,
 * without paying for rows nobody renders (each row is bytes on every publish).
 */
export const GROUPED_ROWS = 10;

/**
 * The price-grouping steps offered for a pair, finest first.
 *
 * WHY THE SERVER OWNS THE GROUPING.
 * Grouping only the 20 PUBLISHED levels client-side collapses them into almost
 * nothing. Measured against live Binance data, the top 20 BTC levels span just
 * $2.67 - a single bucket at a $10 step, which is exactly why the book rendered
 * as two rows and a row of dashes at coarse groupings. Filling 8 rows at $10
 * needs roughly 500 levels ($88 of span), and 500 RAW levels is a 68 KB payload
 * at ten publishes a second. So the aggregation happens here, over the whole
 * cached book, and only the handful of rows the display actually draws goes on
 * the wire - which is both fuller AND cheaper than shipping the raw depth.
 *
 * The client builds its dropdown from the steps present in the payload, so this
 * list is the single source of truth and the two cannot drift.
 */
export const groupingStepsFor = (quoteSymbol) => {
  const quote = String(quoteSymbol || "").toUpperCase();
  return quote === "USD" || quote === "USDT" || quote === "USDC"
    ? [0.5, 1, 5, 10]
    : [0.01, 0.05, 0.1, 0.5];
};

/**
 * Aggregate price levels into `step`-sized buckets, best price first.
 *
 * Bids round DOWN and asks round UP, so a bucket is never advertised at a better
 * price than the liquidity inside it actually rests at. This must stay identical
 * to the client's own groupPrice(), which is still used as a fallback when a
 * payload carries no pre-grouped ladder.
 */
export const groupLevels = (levels, step, side, limit = GROUPED_ROWS) => {
  if (!Array.isArray(levels) || levels.length === 0) return [];
  if (!(step > 0)) return levels.slice(0, limit);

  const buckets = new Map();
  for (const level of levels) {
    const price = Number(level?.price);
    const quantity = Number(level?.quantity);
    if (!Number.isFinite(price) || !Number.isFinite(quantity)) continue;
    if (price <= 0 || quantity <= 0) continue;
    const k = price / step;
    // toFixed(8) then back: 77080.00000000001 and 77080 must be ONE bucket.
    const bucketPrice = Number(
      ((side === "bid" ? Math.floor(k) : Math.ceil(k)) * step).toFixed(8)
    );
    const existing = buckets.get(bucketPrice);
    if (existing) existing.quantity += quantity;
    else buckets.set(bucketPrice, { price: bucketPrice, quantity });
  }

  return Array.from(buckets.values())
    .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price))
    .slice(0, limit);
};

// Orders in `{buy|sell}OpenOrders_<pairId>` that are no longer liquidity: they
// can linger in the hash until something hdel's them.
const RESTING_STATUS = ["open", "pending", "conditional"];

const unhealthy = (reason) => ({ healthy: false, reason });

/**
 * Is this depth snapshot usable - to quote against, and therefore to show?
 *
 * `book` is the shape lib/depthSource.js resolves:
 *   { lastUpdateId, updatedAt, bids: [{price, quantity}], asks: [...] }
 * with both sides sorted best-first.
 *
 * Returns { healthy, reason }. `reason` is one of the strings below and is what
 * the socket payload carries as `healthReason`, so the UI can say WHY the book
 * is empty instead of silently showing nothing.
 */
export const assessDepthHealth = (book, pairData, now = Date.now()) => {
  if (!book) {
    return unhealthy("no_depth");
  }
  // `|| 0` rather than a raw subtraction: an absent/garbage timestamp used to
  // produce NaN, and `NaN > DEPTH_STALE_MS` is false, so a snapshot that could
  // not say when it was taken was silently accepted as fresh. A book with no
  // usable timestamp is exactly the thing this check exists to condemn.
  if (now - (Number(book.updatedAt) || 0) > DEPTH_STALE_MS) {
    return unhealthy("stale_depth");
  }
  if (
    !Array.isArray(book.bids) ||
    !Array.isArray(book.asks) ||
    book.bids.length === 0 ||
    book.asks.length === 0
  ) {
    return unhealthy("empty_side");
  }
  // Strict >, so a NaN on either side is condemned rather than accepted.
  if (!(book.asks[0].price > book.bids[0].price)) {
    return unhealthy("crossed_book");
  }
  const markPrice = pairData ? parseFloat(pairData.markPrice) : NaN;
  // A pair document without a usable markPrice cannot be checked against one;
  // that is not evidence the depth is bad, so it is not treated as such.
  if (
    markPrice > 0 &&
    Math.abs(book.asks[0].price - markPrice) / markPrice > PRICE_DEVIATION_GUARD
  ) {
    return unhealthy("price_deviation");
  }
  return { healthy: true, reason: null };
};

/**
 * How old this snapshot is, in ms, for REPORTING (the health endpoint, the
 * canary's log lines). Clamped at 0 because the feed's timestamp comes from
 * another clock and can land a millisecond in the future, and "depthAgeMs=-1"
 * in an alert reads as a bug in the alert. Clamping cannot mask staleness - it
 * only ever moves a value further from the threshold, and the verdict is
 * assessDepthHealth's to make either way.
 */
export const depthAgeMs = (book, now = Date.now()) =>
  Math.max(0, now - (Number(book && book.updatedAt) || 0));

/**
 * Iterate the parsed orders of a raw `{buy|sell}OpenOrders_<pairId>` hgetall
 * reply, skipping anything unparseable. Shared so every reader of these hashes
 * agrees on what a row is.
 */
export const parseOrders = function* (orders) {
  if (!orders) return;
  for (const value of Object.values(orders)) {
    let order = value;
    if (typeof order === "string") {
      try {
        order = JSON.parse(order);
      } catch (e) {
        continue;
      }
    }
    if (order) yield order;
  }
};

/**
 * How many SYNTHETIC ladder orders are actually resting in this hash right now.
 *
 * This is the redis-side answer to the question paperBook.getLadderState answers
 * from memory. The publish path already reads both open-order hashes to merge
 * real user orders in, so asking it costs no extra I/O.
 */
export const countPaperOrders = (orders) => {
  let count = 0;
  for (const order of parseOrders(orders)) {
    if (order.isPaper === true) count += 1;
  }
  return count;
};

/**
 * Aggregate the REAL resting orders of one side into price levels.
 *
 * `orders` is the raw hgetall reply of `{buy|sell}OpenOrders_<pairId>`: keyed by
 * order id, the serialised order as the VALUE.
 *
 * The synthetic paper ladder is EXCLUDED: it is itself a mirror of the very
 * depth levels being merged into, so counting it would double the whole book.
 */
export const bookLevels = (orders) => {
  const levels = new Map();
  if (!orders) return [];
  for (const order of parseOrders(orders)) {
    if (order.isPaper === true) continue;
    if (order.status && !RESTING_STATUS.includes(order.status)) continue;
    const price = parseFloat(order.price);
    // A market order rests with price "market" and has no place on a price
    // ladder at all.
    if (!isFinite(price) || price <= 0) continue;
    // WHAT IS STILL RESTING IS `quantity`, AND ONLY `quantity`.
    //
    // Both halves of the expression this replaces were wrong, and the wrong one
    // was the one that ran.
    //
    //   `openQuantity` is stamped ONCE at placement (spot.controller.js:1567
    //   limit, :2026 market) and is never decremented by either matcher branch
    //   - only `quantity` and `filledQuantity` move. It is the size the order
    //   was OPENED at, not what is open now, so a 0.5 order that is 0.2 filled
    //   went on advertising 0.5 until it was fully filled or cancelled.
    //
    //   `quantity - filledQuantity` looks like the careful answer and is worse.
    //   The matcher assigns `quantity` THE REMAINDER (`current_buy.quantity =
    //   buyExcAmount`, which is quantity minus the executed amount) while
    //   `filledQuantity` ACCUMULATES, so subtracting one from the other counts
    //   the fill twice: the same order reports 0.1. It never ran, because
    //   `openQuantity` is always present.
    //
    // `quantity` alone is the live remainder and needs no arithmetic.
    //
    // Every consumer of this function was affected: buildPublishedBook (the
    // REST /api/spot/ordeBook and the `orderBook` socket emit) advertised
    // liquidity that was not there, and the fill canary's fillable-depth
    // simulation over-estimated how much could fill - so the one thing
    // watching for a dead venue was reading an inflated book.
    const quantity = parseFloat(order.quantity);
    if (!isFinite(quantity) || quantity <= 0) continue;
    levels.set(price, (levels.get(price) || 0) + quantity);
  }
  return Array.from(levels, ([price, quantity]) => ({ price, quantity }));
};

/**
 * Merge level arrays INTO one another. A real venue ADDS a user's order to the
 * book at its own price level, it does not replace the book with it, so one
 * small user order can never blank the display.
 */
export const mergeBookLevels = (...sides) => {
  const levels = new Map();
  for (const side of sides) {
    if (!Array.isArray(side)) continue;
    for (const level of side) {
      const price = parseFloat(level.price != null ? level.price : level._id);
      const quantity = parseFloat(level.quantity);
      if (!isFinite(price) || price <= 0) continue;
      if (!isFinite(quantity) || quantity <= 0) continue;
      levels.set(price, (levels.get(price) || 0) + quantity);
    }
  }
  return Array.from(levels, ([price, quantity]) => ({ price, quantity }));
};

/**
 * Display rows: running cumulative notional, best price first. The UI draws its
 * depth bars from `cumulativeNotional / max*Notional`, and identifies a row by
 * `_id` (which is the price).
 */
export const withNotionals = (levels) => {
  let cumulative = 0;
  const rows = levels.map((level) => {
    const notional = level.price * level.quantity;
    cumulative += notional;
    return {
      _id: level.price,
      price: level.price,
      quantity: level.quantity,
      notional,
      cumulativeNotional: cumulative,
    };
  });
  // Cumulative notional is monotonic, so the running max IS the final total.
  return { rows, maxNotional: cumulative };
};
