/**
 * ONE ANSWER TO "WHAT IS THE PRICE?".
 *
 * A spot pair page paints the price in several places at once: the headline
 * beside the pair name, the last-price marker wedged between the bids and the
 * asks, the top row of the trade log, and the ladder itself. They were not all
 * reading the same thing.
 *
 * `marketData.markPrice` is the VENUE tick. spotapi publishes it from a 30
 * second cron (config/cron.js -> binance.controller.updateBinancePrices), and
 * it heartbeats on that schedule whether or not anything moved. The order book
 * and the trade log, meanwhile, come straight off the matching engine and
 * update continuously.
 *
 * So for up to thirty seconds at a time the two largest numbers on the page
 * were a cron cycle out of date. In a rising market that parks them below every
 * bid; in a falling one, above every ask and above the most recent trade —
 * which is exactly the shape this was reported in. Nothing was miscalculated:
 * two clocks were being read as one.
 *
 * `lastTradePrice` prefers the newest executed trade for THE PAIR ON SCREEN and
 * falls back to the venue tick. The pair check is the important half: a stale
 * entry left over from the previously viewed pair would otherwise print a
 * BTC-sized price on a SOL header, which is worse than being thirty seconds
 * late.
 */

export type LastTradeState = {
  pairId?: any;
  price?: any;
  at?: number;
};

/**
 * The price to display for `pairId`.
 *
 * @param lastTrade  the store's `spot.lastTrade` slot, written by the live
 *                   `recentTrade` stream
 * @param pairId     the pair currently on screen
 * @param fallback   the venue tick (`marketData.markPrice`)
 * @returns the executed price when there is a usable one for this pair,
 *          otherwise `fallback` unchanged — including when `fallback` is itself
 *          absent, so callers keep their own "—" placeholder behaviour.
 */
export function lastTradePrice(
  lastTrade: LastTradeState | null | undefined,
  pairId: any,
  fallback: any
): any {
  if (pairId === null || pairId === undefined || pairId === "") return fallback;
  if (!lastTrade) return fallback;
  if (String(lastTrade.pairId) !== String(pairId)) return fallback;
  const price = parseFloat(lastTrade.price);
  if (!Number.isFinite(price) || price <= 0) return fallback;
  return price;
}
