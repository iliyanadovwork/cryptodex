/**
 * WHEN A CACHED TRADE HAPPENED
 * ============================
 *
 * A trade written to `tradeHistory_<pairId>` goes through JSON, so `createdAt`
 * comes back a STRING. The same trade read out of mongo comes back a DATE.
 * `marketPrice()` walks both, and it walked them with the same two lines:
 *
 *     tradeDoc.sort((a, b) => a.createdAt - b.createdAt);
 *     if (trade.createdAt >= new Date(Date.now() - 24h) && ...)
 *
 * On dates both work. On strings neither does, and neither fails loudly:
 *
 *   - `"2026-08-05T19:00:00.000Z" - "2026-08-05T18:00:00.000Z"` is NaN, so the
 *     sort is a no-op and "the first trade of the window" is whichever one
 *     redis happened to hand back first - the open price, and therefore the
 *     24h change, was decided by hash ordering.
 *   - `"2026-08-05T19:00:00.000Z" >= new Date(...)` compares the ISO string
 *     against the Date's OWN string form, "Wed Aug 05 2026 22:00:00 GMT+0300".
 *     "2" < "W" in every such comparison, so the test is false for every trade
 *     ever cached: the pair's 24h volume, turnover, high, low and change all
 *     came out 0 while the trades were sitting right there in the hash.
 *
 * Two representations of one instant, compared as if they were one - the same
 * defect as reading a contract count as a coin count, in the time dimension.
 *
 * So the comparison happens on epoch milliseconds, which both forms convert to
 * unambiguously, and a trade whose timestamp cannot be read at all is left out
 * rather than silently sorted to the front.
 */

/** The window the 24h statistics describe. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Epoch milliseconds for a trade's `createdAt`, whether it arrived as a Date,
 * an ISO string or an epoch number. NaN when there is no readable timestamp -
 * callers must treat that as "not in the window", never as 0 (the epoch).
 */
export const tradeTime = (trade) => {
  if (!trade || trade.createdAt === null || trade.createdAt === undefined) {
    return NaN;
  }
  const at = trade.createdAt;
  if (at instanceof Date) return at.getTime();
  if (typeof at === "number") return Number.isFinite(at) ? at : NaN;
  const parsed = new Date(at).getTime();
  return Number.isNaN(parsed) ? NaN : parsed;
};

/** Oldest-first, by the instant the trade happened. */
export const byTradeTime = (a, b) => {
  const left = tradeTime(a);
  const right = tradeTime(b);
  // Undateable rows sort last rather than becoming the window's open price.
  if (Number.isNaN(left) && Number.isNaN(right)) return 0;
  if (Number.isNaN(left)) return 1;
  if (Number.isNaN(right)) return -1;
  return left - right;
};

/**
 * Did this trade happen inside the 24h window ending at `now`? Trades stamped
 * in the future are excluded, as they were before - a clock ahead of ours must
 * not be able to add volume to today.
 */
export const inLast24h = (trade, now = Date.now()) => {
  const at = tradeTime(trade);
  if (Number.isNaN(at)) return false;
  return at >= now - WINDOW_MS && at <= now;
};

export default { WINDOW_MS, tradeTime, byTradeTime, inLast24h };
