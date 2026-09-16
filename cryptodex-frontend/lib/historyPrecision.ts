/**
 * TWO SCREENS, ONE TRADE, TWO DIFFERENT QUANTITIES
 * ================================================
 *
 * REPORTED: "/history -> Spot -> Trade History shows 0.0155 for a trade the
 * trade page shows as 0.01553693."
 *
 * The trade page's own Trade History panel prints
 *
 *   formatQty(item.tradeQty, tradePair.firstFloatDigit)   -> 0.01553693
 *
 * while the /history version printed
 *
 *   toFixed(item.tradeQty, 4)                             -> 0.0155
 *
 * `toFixed` is `Number.prototype.toFixed`: a fixed FOUR places, and it ROUNDS.
 * So the two screens disagreed about the size of the same fill, and the /history
 * figure was not merely coarse — it was wrong in the direction of "you traded
 * more than you did" as often as not. Below about 0.00005 BTC every fill
 * rendered as a flat "0.0000", and the price column, capped the same way,
 * printed BTC at four decimals of a two-decimal quote currency.
 *
 * This is the same defect the sibling ORDER History tab already had fixed
 * (see components/History/OrderHistory qtyDigits/priceDigits); the Trade
 * History tab beside it was missed. That is this codebase's signature failure —
 * a fix landing in one of two near-identical places — so the resolution lives
 * in a module both can import instead of in a third copy of the logic.
 *
 * WHERE THE PRECISION COMES FROM
 * ------------------------------
 * Spot ORDER history rows carry `firstFloatDigit`/`secondFloatDigit`, written
 * onto the record at order time. Spot TRADE history rows (the `tradeHistory`
 * collection) do not — they carry `pairName`, which is the pair's `tikerRoot`
 * ("BTCUSD"). So the row is preferred when it describes itself, and the live
 * pair list is the fallback, and a hardcoded floor is the fallback to that.
 *
 * The floor is 8 for a size and 2 for a price: a satoshi is the smallest thing
 * this venue trades and cents are the smallest thing it quotes. Both are
 * MAXIMUMS handed to `formatQty`/`formatPrice`, which trim trailing zeros, so
 * a round number still prints round.
 */

/** Size fallback: one satoshi is the finest thing traded here. */
export const FALLBACK_QTY_DIGITS = 8;

/** Price fallback: this venue quotes in cents. */
export const FALLBACK_PRICE_DIGITS = 2;

/**
 * A non-negative integer, or null.
 *
 * `parseInt` is deliberate and matches OrderHistory's already-shipped helpers:
 * a float digit count of "8.9" is a configuration mistake, not a request for
 * 8.9 decimal places. NaN, negatives, null, "" and undefined all fail the
 * finite/non-negative test and yield null so the caller can fall through.
 */
const digits = (value: any): number | null => {
  const n = parseInt(value as any, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * The pair a history row belongs to, from the live pair list.
 *
 * Matched on `tikerRoot` because that is what a trade row's `pairName` holds
 * ("BTCUSD", no separator) — NOT the pair's own `pairName`, which is
 * "BTC/USD". Comparison is case-insensitive and trimmed; anything that is not
 * a list, or a name that is not on it (a delisted pair still has history),
 * yields null rather than an exception.
 */
export function findPair(pairList: any, pairName: any): any | null {
  if (!Array.isArray(pairList)) return null;
  if (typeof pairName !== "string") return null;
  const wanted = pairName.trim().toUpperCase();
  if (wanted === "") return null;
  return (
    pairList.find(
      (p: any) =>
        typeof p?.tikerRoot === "string" &&
        p.tikerRoot.trim().toUpperCase() === wanted
    ) || null
  );
}

/**
 * Decimals to print a SIZE to, for one history row.
 *
 * Order: the row's own precision, then the live pair's, then the floor.
 */
export function qtyDigitsFor(row: any, pairList?: any): number {
  const own = digits(row?.firstFloatDigit);
  if (own !== null) return own;
  const fromPair = digits(findPair(pairList, row?.pairName)?.firstFloatDigit);
  if (fromPair !== null) return fromPair;
  return FALLBACK_QTY_DIGITS;
}

/** Decimals to print a PRICE (or a quote-currency value) to, for one row. */
export function priceDigitsFor(row: any, pairList?: any): number {
  const own = digits(row?.secondFloatDigit);
  if (own !== null) return own;
  const fromPair = digits(findPair(pairList, row?.pairName)?.secondFloatDigit);
  if (fromPair !== null) return fromPair;
  return FALLBACK_PRICE_DIGITS;
}
