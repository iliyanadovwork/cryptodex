/**
 * 24-HOUR TICKER STATISTICS - THE ONE PLACE THEY ARE DEFINED
 * ==========================================================
 *
 * WHAT THE FOUR HEADER FIELDS MEAN
 * --------------------------------
 * The spot header, /market and every pair-list consumer render four numbers
 * that only mean something together:
 *
 *   high          the HIGHEST price the pair traded in the last 24h
 *   low           the LOWEST price the pair traded in the last 24h
 *   firstVolume   24h volume in the BASE coin        ("24H Volume (BTC)")
 *   secondVolume  24h turnover in the QUOTE currency ("24H Turnover (USD)")
 *
 * They are not four independent readings. Three identities have to hold or the
 * header is printing numbers that disprove each other:
 *
 *   1. low <= last <= high        the day's range contains the current price
 *   2. secondVolume ~= firstVolume * weightedAvgPrice
 *                                 turnover IS volume valued at the day's
 *                                 average traded price - the same trades
 *                                 counted in two units, not two measurements
 *   3. high >= low                a range, not a pair of unrelated prices
 *
 * WHAT WAS PUBLISHED INSTEAD
 * --------------------------
 * binance.controller.updateBinancePrices called /api/v3/ticker/price, which
 * returns a price and nothing else, and then INVENTED the rest:
 *
 *     high: price > prevPrice ? price : prevPrice * 1.01
 *     low:  price < prevPrice ? price : prevPrice * 0.99
 *     firstVolume:  (Math.random() * 1000 + 100).toFixed(2)
 *     secondVolume: (Math.random() * 1000000 + 10000).toFixed(2)
 *
 * Two independent Math.random() draws, so identity 2 failed by 4x-1400x; a
 * range rebuilt from the PREVIOUS TICK every 30s, so identity 1 held only by
 * accident and "24H High" was routinely just the last price, and a 24h low
 * could rise $660 in 14 seconds because it was never a 24h anything.
 *
 * WHERE THE REAL NUMBERS COME FROM
 * --------------------------------
 * /api/v3/ticker/24hr - the endpoint that answers exactly this question -
 * returns highPrice, lowPrice, volume (base), quoteVolume (quote),
 * weightedAvgPrice, priceChange and priceChangePercent, all measured over the
 * same rolling 24h window on the same trades. Because they come from one
 * window they satisfy all three identities by construction.
 *
 * WHY THIS MODULE REFUSES RATHER THAN REPAIRS
 * -------------------------------------------
 * normalize() checks the identities anyway and returns `ok: false` when they
 * do not hold. A rejected pair keeps its previous, coherent snapshot: a stale
 * true statistic is worth more than a fresh invented one, and silently
 * "fixing" a feed that disagrees with itself would put us back to publishing a
 * number no trade supports. The single exception is a MISSING quoteVolume,
 * which is derived from volume * weightedAvgPrice - that is not an invention,
 * it is identity 2 solved for the term the feed omitted.
 *
 * Pure and I/O-free so the identities can be tested directly.
 */

/**
 * How far quoteVolume may sit from volume * weightedAvgPrice before the
 * payload is treated as self-contradictory. Binance derives all three from the
 * same trades, so real drift is rounding-sized; 2% is loose enough to never
 * reject a live tick and tight enough that two independent random draws (the
 * bug this pins) can essentially never pass.
 */
export const TURNOVER_TOLERANCE = 0.02;

const num = (value) => {
  if (value === null || value === undefined || value === '') return NaN;
  return typeof value === 'number' ? value : parseFloat(value);
};

const finitePositive = (value) => Number.isFinite(value) && value > 0;

/**
 * Normalize a raw Binance /api/v3/ticker/24hr payload into the pair-document
 * field names the rest of the service uses.
 *
 * @returns {{ok: true, stats: object} | {ok: false, reason: string}}
 */
export const normalize = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'no-payload' };
  }

  const last = num(raw.lastPrice);
  if (!finitePositive(last)) {
    return { ok: false, reason: 'last-price-invalid' };
  }

  const high = num(raw.highPrice);
  const low = num(raw.lowPrice);
  if (!finitePositive(high) || !finitePositive(low)) {
    return { ok: false, reason: 'range-invalid' };
  }
  // Identity 3: a range, not two unrelated prices.
  if (high < low) {
    return { ok: false, reason: 'range-inverted' };
  }
  // Identity 1: the day's range contains the price printed beside it. This is
  // the one a user can see is false at a glance.
  if (last < low || last > high) {
    return { ok: false, reason: 'range-excludes-last' };
  }

  const firstVolume = num(raw.volume);
  if (!Number.isFinite(firstVolume) || firstVolume < 0) {
    return { ok: false, reason: 'base-volume-invalid' };
  }

  const weightedAvgPrice = num(raw.weightedAvgPrice);
  const impliedTurnover = finitePositive(weightedAvgPrice)
    ? firstVolume * weightedAvgPrice
    : NaN;

  let secondVolume = num(raw.quoteVolume);
  if (!Number.isFinite(secondVolume)) {
    // Identity 2 solved for the missing term - not an invented number.
    if (!Number.isFinite(impliedTurnover)) {
      return { ok: false, reason: 'quote-volume-invalid' };
    }
    secondVolume = impliedTurnover;
  }
  if (secondVolume < 0) {
    return { ok: false, reason: 'quote-volume-invalid' };
  }

  // Identity 2: turnover is the same trades in the quote unit. Checked only
  // when there is something to check against - a pair that genuinely did not
  // trade has volume 0 and no weighted average, and 0 == 0 is coherent.
  if (Number.isFinite(impliedTurnover) && impliedTurnover > 0) {
    const drift = Math.abs(secondVolume - impliedTurnover) / impliedTurnover;
    if (drift > TURNOVER_TOLERANCE) {
      return { ok: false, reason: 'turnover-incoherent' };
    }
  }

  // Binance reports both the absolute and the percentage 24h change against
  // the window's open. Fall back to deriving them only when the feed omits
  // them, and only from the open price it did send.
  const openPrice = num(raw.openPrice);
  let changePrice = num(raw.priceChange);
  let change = num(raw.priceChangePercent);
  if (!Number.isFinite(changePrice)) {
    changePrice = finitePositive(openPrice) ? last - openPrice : 0;
  }
  if (!Number.isFinite(change)) {
    change = finitePositive(openPrice) ? (changePrice / openPrice) * 100 : 0;
  }

  return {
    ok: true,
    stats: {
      last,
      markPrice: last,
      high,
      low,
      firstVolume,
      secondVolume,
      change,
      changePrice,
      weightedAvgPrice: finitePositive(weightedAvgPrice) ? weightedAvgPrice : null
    }
  };
};

/**
 * The identities, as an assertion over an ALREADY-PUBLISHED snapshot. Used by
 * the tests to check what the service actually put on the wire, and available
 * to any consumer that wants to know whether a pair document it is holding is
 * self-consistent.
 */
export const isCoherent = (stats) => {
  if (!stats) return false;
  const last = num(stats.last);
  const high = num(stats.high);
  const low = num(stats.low);
  const base = num(stats.firstVolume);
  const quote = num(stats.secondVolume);

  if (!finitePositive(last) || !finitePositive(high) || !finitePositive(low)) return false;
  if (high < low) return false;
  if (last < low || last > high) return false;
  if (!Number.isFinite(base) || base < 0) return false;
  if (!Number.isFinite(quote) || quote < 0) return false;

  // Turnover has to be volume valued somewhere inside the day's range. This is
  // the weakest true statement available without the weighted average, and it
  // is still enough to reject two independent random draws.
  if (base > 0) {
    if (quote < base * low * (1 - TURNOVER_TOLERANCE)) return false;
    if (quote > base * high * (1 + TURNOVER_TOLERANCE)) return false;
  } else if (quote > 0) {
    return false; // turnover without volume
  }

  return true;
};

/**
 * Everything a coherent tick has to be written to, built once from ONE stats
 * object so the three sinks cannot disagree:
 *
 *   updatedPair  the `spotPairdata` cache entry and the SpotPair document
 *   changeData   the `spot24hrsChange` cache entry
 *   socketData   the `marketPrice` socket payload
 *
 * The socket payload matters as much as the caches: the market table REPLACES
 * its row's 24h cells from whatever the tick carries, so a tick that carried
 * only markPrice/change blanked every 24h high/low/volume cell on /market 30
 * seconds after it loaded, while the spot header (which merges) sat on a
 * frozen snapshot instead. One payload, all three.
 *
 * Returns `{ ok: false, reason }` for a tick that fails normalize(), and the
 * caller publishes NOTHING - see the module header.
 */
export const buildPairPayloads = (pair, raw) => {
  const result = normalize(raw);
  if (!result.ok) return result;

  const { last, markPrice, high, low, firstVolume, secondVolume, change, changePrice } =
    result.stats;

  const stats = {
    markPrice,
    last,
    high,
    low,
    firstVolume,
    secondVolume,
    change,
    changePrice
  };

  const pairId = pair && pair._id ? pair._id.toString() : null;

  return {
    ok: true,
    stats,
    updatedPair: { ...(pair || {}), ...stats },
    changeData: {
      ...stats,
      botstatus: 'binance',
      firstCurrencySymbol: pair ? pair.firstCurrencySymbol : undefined,
      secondCurrencySymbol: pair ? pair.secondCurrencySymbol : undefined,
      _id: pairId
    },
    socketData: { ...stats, price: last }
  };
};

export default { normalize, isCoherent, buildPairPayloads, TURNOVER_TOLERANCE };
