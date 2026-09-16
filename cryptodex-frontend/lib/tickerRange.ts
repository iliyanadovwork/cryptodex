/**
 * 24H HIGH / LOW THAT CANNOT CONTRADICT THE PRICE PRINTED NEXT TO IT.
 *
 * THE BUG THIS EXISTS TO KILL
 * The spot header's 24H High and 24H Low refresh only as often as the venue
 * republishes them - the 30s cron (spotapi binance.controller
 * .updateBinancePrices). Between those beats the price beside them keeps moving
 * off the matching engine, so the header could show a "24H High" the current
 * price had already passed, or a "24H Low" above it: two numbers on one line,
 * one of which the other proves false.
 *
 * (An earlier version of this note claimed the tick carries no high/low at all.
 * It does - binance.controller emits the whole updated pair - so the window is
 * refreshed rather than frozen, and what this closes is the gap BETWEEN beats,
 * not a permanent freeze.)
 *
 * WHAT THIS DOES, AND WHAT IT DOES NOT
 * It does NOT invent a 24-hour statistic; the client has not been running for
 * 24 hours and cannot know one. It takes the server's figures as the starting
 * range and then WIDENS that range to include every price this session has
 * actually observed. That is a strictly weaker claim than the server's and it
 * is always true: a price we watched trade at 74.30 is proof the 24H high is at
 * least 74.30, whatever the stale snapshot says.
 *
 * The range only ever grows, never shrinks, so a single odd tick cannot erase
 * the server's real high — and the header can never again print a high below
 * the price sitting next to it.
 *
 * That one-way growth is also this module's sharp edge, and why displayRange
 * bounds what it will accept: a sample from ANOTHER market (every pair's
 * marketPrice and recentTrade is broadcast to every client) is a number this
 * would otherwise keep for ever. See PLAUSIBLE_FACTOR.
 */

export interface TickerRange {
  /** Highest price known this session, or null when nothing is known. */
  high: number | null;
  /** Lowest price known this session, or null when nothing is known. */
  low: number | null;
}

export const EMPTY_RANGE: TickerRange = { high: null, low: null };

/**
 * How far outside the server's own 24h window an observed price may sit before
 * it is treated as another market's number rather than a new extreme. See
 * displayRange.
 */
const PLAUSIBLE_FACTOR = 4;

const asPrice = (raw: any): number | null => {
  const n = parseFloat(raw);
  // Zero is the backend's "I have no figure" placeholder for high/low, and a
  // real traded price is never zero or negative, so both are "unknown".
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Widen `range` so it contains every price in `observed`.
 *
 * Returns the SAME object when nothing changed, so a component can assign the
 * result to state on every tick without forcing a re-render each time.
 */
export function widenRange(
  range: TickerRange | null | undefined,
  observed: any[]
): TickerRange {
  const current: TickerRange = range || EMPTY_RANGE;
  let high = current.high;
  let low = current.low;
  let changed = false;

  for (const raw of observed || []) {
    const price = asPrice(raw);
    if (price === null) continue;
    if (high === null || price > high) {
      high = price;
      changed = true;
    }
    if (low === null || price < low) {
      low = price;
      changed = true;
    }
  }

  return changed ? { high, low } : current;
}

/**
 * The range to PRINT: the server's snapshot, widened by what we have seen.
 *
 * `serverHigh`/`serverLow` are whatever the pair payload last said; either may
 * be missing or zero, in which case the observed range stands alone.
 */
export function displayRange(
  serverHigh: any,
  serverLow: any,
  observed: TickerRange | null | undefined
): TickerRange {
  const sHigh = asPrice(serverHigh);
  const sLow = asPrice(serverLow);
  const oHigh = observed?.high ?? null;
  const oLow = observed?.low ?? null;

  // AN OBSERVED PRICE THIS FAR OUTSIDE THE SERVER'S OWN WINDOW IS NOT THIS
  // MARKET'S PRICE.
  //
  // Reported: a BTC/USD header printing "24H Low 96.48" while the server's own
  // figure - in mongo AND in the redis cache - was 76,670.01. 96 is a SOL price,
  // and `marketPrice`/`recentTrade` are broadcast for EVERY listed pair, so a
  // sample belonging to another market only has to be read once. widenRange then
  // never lets go: it only ever widens, and the observed range is cleared only on
  // a pair change, so a single stray number owned the cell for the whole session.
  //
  // A real 24h extreme moves the window by a few percent. A factor of four is
  // far outside anything a genuine intraday move produces and far inside the
  // three orders of magnitude that separate one market's price from another's,
  // so it discards contamination without ever suppressing a true new extreme.
  // With no server figure to compare against, the observed value stands - there
  // is nothing to judge it by, and a missing high/low is worse than a loose one.
  const plausibleLow =
    sLow === null || oLow === null || oLow >= sLow / PLAUSIBLE_FACTOR
      ? oLow
      : null;
  const plausibleHigh =
    sHigh === null || oHigh === null || oHigh <= sHigh * PLAUSIBLE_FACTOR
      ? oHigh
      : null;

  const high =
    sHigh === null
      ? plausibleHigh
      : plausibleHigh === null
        ? sHigh
        : Math.max(sHigh, plausibleHigh);
  const low =
    sLow === null
      ? plausibleLow
      : plausibleLow === null
        ? sLow
        : Math.min(sLow, plausibleLow);

  return { high, low };
}
