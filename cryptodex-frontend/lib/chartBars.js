/**
 * FOLDING A TRADE TAPE INTO CANDLES.
 * ==================================
 *
 * The chart's history comes from controllers/chart/, which builds candles in
 * mongo by grouping raw trades. Nothing built the CURRENT candle: the library
 * hands us an `onTick` callback in `subscribeBars` and we never called it, so
 * the chart drew history and then stood still until something re-created the
 * widget.
 *
 * This is the arithmetic for that, kept away from the socket and the library so
 * it can be tested as plain functions.
 *
 * TWO PROPERTIES OF THE FEED SHAPE EVERYTHING HERE
 * ------------------------------------------------
 * 1. `recentTrade` REPUBLISHES. spot.controller.js recentTradeSocket re-emits
 *    the whole top-25 window on every fill, so most of each message is rows we
 *    have already counted. High and low survive that (a max is idempotent);
 *    VOLUME DOES NOT. Without a dedupe the volume bars read many times the
 *    truth. Hence `accept` refuses a trade it has already seen.
 *
 * 2. Trades arrive out of order. Two producers feed this event - a Binance
 *    trade buffer on a throttle, and the republish above - so a message can
 *    carry prints older than ones already folded in. A trade older than the
 *    open bar is dropped rather than applied, because the library requires bar
 *    times to be non-decreasing and a backwards bar is rejected outright.
 */

/** Bucket width for the fixed-span resolutions, in milliseconds. */
const RESOLUTION_MS = {
  1: 60 * 1000,
  5: 5 * 60 * 1000,
  15: 15 * 60 * 1000,
  30: 30 * 60 * 1000,
  60: 60 * 60 * 1000,
  D: 24 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The start of the bucket a timestamp belongs to, MATCHING THE BACKEND.
 *
 * controllers/chart/chart.controller.js groups by UTC calendar fields
 * (`$year`/`$month`/`$dayOfMonth`/`$hour`/`$minute`, with `$mod` for the 5, 15
 * and 30 minute buckets). For every fixed-span resolution that is the same
 * thing as flooring the epoch, because the epoch begins on a UTC hour boundary
 * and 60 divides by 5, 15 and 30 exactly. The two calendar resolutions are not
 * a fixed span and are computed as calendar dates.
 *
 * THE WEEK IS ODD ON PURPOSE. The aggregation groups by `year + month + week`,
 * so a week that straddles the end of a month is split into two buckets. That
 * is reproduced rather than corrected: a live bar that disagreed with the
 * history bar it is meant to extend would draw as a second candle.
 *
 * @param {number|string} ms epoch milliseconds
 * @param {string} resolution a TradingView resolution, e.g. "15", "1D", "1M"
 * @returns {number|null} bucket start in epoch ms, or null if unusable
 */
export const barTimeFor = (ms, resolution) => {
  const t = Number(ms);
  if (!Number.isFinite(t)) return null;

  const key = String(resolution == null ? '' : resolution).toUpperCase();

  // Calendar month.
  if (key === '1M' || key === 'M') {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }

  // Week, clamped to the start of the month - see the note above.
  if (key === '1W' || key === 'W') {
    const d = new Date(t);
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const sunday = midnight - d.getUTCDay() * DAY_MS; // $week counts from Sunday
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    return Math.max(sunday, monthStart);
  }

  const span = RESOLUTION_MS[key];
  if (!span) return null;
  return Math.floor(t / span) * span;
};

/**
 * A trade's time as a number, from either form the feeds use.
 *
 * The REST seed sends an ISO-8601 string; the socket push passes Binance's `T`
 * through as epoch milliseconds. Both land here. A trade with neither is
 * refused rather than defaulted to now, because inventing a timestamp would
 * put a fill in the wrong candle.
 */
export const tradeTimeValue = (trade) => {
  const raw = trade == null ? null : trade.createdAt;
  if (raw == null) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * A stable identity for a trade, so a republished window is not counted twice.
 *
 * Binance's own trade id arrives as `_id` and is the only field that separates
 * the fills of one sweep: an aggressive order crossing several makers at one
 * price prints several trades sharing millisecond, price, size and side. The
 * composite fallback is for rows that reach us without one.
 */
export const tradeKey = (trade) => {
  const id = trade == null ? null : trade._id;
  if (id !== undefined && id !== null && id !== '') return String(id);
  return [
    trade && trade.createdAt,
    trade && trade.tradePrice,
    trade && trade.tradeQty,
    (trade && trade.Type) || '',
  ].join('|');
};

/** A fresh candle, opened by its first trade. */
export const startBar = (time, price, qty) => ({
  time: time,
  open: price,
  high: price,
  low: price,
  close: price,
  volume: Number.isFinite(qty) ? qty : 0,
});

/** The same candle with one more trade in it. */
export const foldTrade = (bar, price, qty) => ({
  time: bar.time,
  open: bar.open,
  high: Math.max(bar.high, price),
  low: Math.min(bar.low, price),
  close: price,
  volume: (Number.isFinite(bar.volume) ? bar.volume : 0) + (Number.isFinite(qty) ? qty : 0),
});

/** How many trade identities to remember. Bounded so a long session cannot grow without limit. */
const SEEN_LIMIT = 1000;

/**
 * Builds the in-progress candle for one chart subscription.
 *
 * @param {string} resolution
 */
export function LiveBarBuilder(resolution) {
  this._resolution = resolution;
  this._bar = null;
  this._seen = new Set();
  this._seenOrder = [];
}

/**
 * Adopt the newest bar from history as the one being extended.
 *
 * WHY THE SEED KEEPS ITS OWN TIMESTAMP, RATHER THAN BEING RE-ALIGNED.
 * The backend stamps each bar with `Date: { $last: "$createdAt" }` - the time
 * of the LAST trade in the bucket, not the bucket's start. So the newest
 * history bar sits at some time inside its bucket. If the first live tick were
 * emitted at the bucket start instead, the library would see a new, earlier
 * time and reject it; emitted at the next aligned time, it would draw a second
 * candle beside the one it is meant to be extending. Keeping the seed's own
 * time means an update lands ON the history bar, which is what the library
 * treats as "the same bar, changed".
 *
 * Bars opened from here on ARE bucket-aligned, which is what the library
 * expects; the quirk is confined to the one bar that came from history.
 */
LiveBarBuilder.prototype.seed = function (bar) {
  if (!bar || !Number.isFinite(Number(bar.time))) return;
  // Never move backwards: getBars is called repeatedly as the user scrolls back
  // through history, and those older pages must not replace a newer seed.
  if (this._bar && Number(bar.time) <= this._bar.time) return;
  this._bar = {
    time: Number(bar.time),
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : 0,
  };
};

/** The candle currently being built, or null before the first trade. */
LiveBarBuilder.prototype.current = function () {
  return this._bar;
};

LiveBarBuilder.prototype._remember = function (key) {
  this._seen.add(key);
  this._seenOrder.push(key);
  if (this._seenOrder.length > SEEN_LIMIT) {
    this._seen.delete(this._seenOrder.shift());
  }
};

/**
 * Apply one trade.
 *
 * @returns {object|null} the bar to hand the library, or null when the trade
 *   changed nothing - a duplicate, a malformed row, or a print older than the
 *   bar already open.
 */
LiveBarBuilder.prototype.accept = function (trade) {
  const key = tradeKey(trade);
  if (this._seen.has(key)) return null;

  const price = Number(trade && trade.tradePrice);
  const qty = Number(trade && trade.tradeQty);
  const time = tradeTimeValue(trade);
  // A trade without a usable price or time cannot be placed in a candle. It is
  // not remembered either, so a later well-formed copy of it still counts.
  if (!Number.isFinite(price) || time === null) return null;

  const bucket = barTimeFor(time, this._resolution);
  if (bucket === null) return null;

  this._remember(key);

  if (this._bar === null) {
    this._bar = startBar(bucket, price, qty);
    return this._bar;
  }

  const openBucket = barTimeFor(this._bar.time, this._resolution);

  // Older than the open bar. Dropped: the library requires non-decreasing bar
  // times, and rewriting a closed candle from a late print would be a lie about
  // a period the chart has already drawn.
  if (bucket < openBucket) return null;

  // Same bucket - extend it, KEEPING ITS EXISTING TIMESTAMP (see `seed`).
  if (bucket === openBucket) {
    this._bar = foldTrade(this._bar, price, qty);
    return this._bar;
  }

  // A later bucket: the previous candle is finished.
  this._bar = startBar(bucket, price, qty);
  return this._bar;
};

export default LiveBarBuilder;
