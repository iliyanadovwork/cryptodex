/**
 * WHICH MARKET A `/spot/<slug>` URL NAMES.
 * ========================================
 *
 * THE BUG THIS EXISTS TO KILL
 * ---------------------------
 * `pages/spot/[id].tsx` read the slug as `slug.split("_")` and looked for a
 * pair whose two currency symbols matched the two halves. Anything that did not
 * split into two halves matched nothing, and the "matched nothing" branch
 * silently replaced the URL with `pairList[0]` - which on this venue is SOL/USD.
 *
 * So `/spot/BTCUSD` showed a SOL/USD order book, with SOL/USD depth, a SOL/USD
 * ticket and no message of any kind. `BTCUSD` is not a typo: it is the pair's
 * own `tikerRoot`, the string the API, the websocket topics and the health
 * endpoint all identify that market by. A user who typed the name they had
 * read, or followed a link written in that spelling, would have been placing
 * orders in the wrong market with the page reading correct at a glance -
 * SOL/USD in the corner, and nothing saying "that is not what you asked for".
 *
 * WHAT IT DOES NOW
 * ----------------
 * Both spellings resolve, because both are names this product uses for the same
 * thing:
 *
 *     BTC_USD  BTC-USD  btc_usd  BTCUSD  btcusd
 *
 * `resolvePairSlug` returns the market, and how it was found. A slug that names
 * NO listed market resolves to `{ pair: fallback, matched: false }`, and the
 * caller is expected to say so out loud rather than quietly swapping the market
 * under the user. The two halves are reported separately so that a fallback can
 * never again be indistinguishable from a hit.
 *
 * Matching by concatenation is unambiguous only because a symbol is never a
 * prefix of another symbol plus a valid quote on this venue's list; where two
 * candidates would tie, the SEPARATED form wins, since it says explicitly where
 * the split is.
 */

export interface PairLike {
  firstCurrencySymbol?: string;
  secondCurrencySymbol?: string;
  [key: string]: any;
}

export interface PairSlugResolution<T> {
  /** The market to show. Null only when there are no markets at all. */
  pair: T | null;
  /** True when the slug named this market; false when it named nothing. */
  matched: boolean;
}

const clean = (value: any): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/** Letters and digits only: "BTC_USD", "btc-usd" and "BTCUSD" all collapse. */
const squash = (value: any): string => clean(value).replace(/[^a-z0-9]/g, "");

/** "BTC_USD" -> ["btc", "usd"]. Any of _ - / . may be the separator. */
const split = (slug: string): string[] =>
  clean(slug)
    .split(/[_\-/.]/)
    .filter((part) => part.length > 0);

/**
 * The market a `/spot/` slug names, if any.
 *
 * `fallback` is what to show when it names nothing - the caller's choice, so
 * this module never has an opinion about which market is "default".
 */
export function resolvePairSlug<T extends PairLike>(
  slug: any,
  pairList: T[] | null | undefined,
  fallback?: T | null
): PairSlugResolution<T> {
  const list = Array.isArray(pairList) ? pairList.filter(Boolean) : [];
  const backstop = fallback !== undefined ? fallback : list[0] || null;

  if (list.length === 0) return { pair: null, matched: false };
  if (typeof slug !== "string" || slug.trim() === "") {
    return { pair: backstop, matched: false };
  }

  const parts = split(slug);

  // 1. The separated form, which states where the split is.
  if (parts.length >= 2) {
    const [base, quote] = parts;
    const hit = list.find(
      (pair) =>
        clean(pair.firstCurrencySymbol) === base &&
        clean(pair.secondCurrencySymbol) === quote
    );
    if (hit) return { pair: hit, matched: true };
  }

  // 2. The ticker form - BTCUSD - which is what the API, the socket topics and
  //    the health endpoint call this market.
  const squashed = squash(slug);
  if (squashed) {
    const hit = list.find(
      (pair) =>
        `${clean(pair.firstCurrencySymbol)}${clean(pair.secondCurrencySymbol)}` ===
        squashed
    );
    if (hit) return { pair: hit, matched: true };
  }

  return { pair: backstop, matched: false };
}

/** "BTC/USD", for saying out loud which market is actually on screen. */
export const pairLabel = (pair: PairLike | null | undefined): string =>
  pair ? `${pair.firstCurrencySymbol}/${pair.secondCurrencySymbol}` : "";

/**
 * What to tell a user whose URL named no listed market.
 *
 * Names the thing they asked for AND the thing they got, because a message that
 * says only "not found" leaves them to work out what the screen in front of
 * them is now showing.
 */
export const unknownPairMessage = (
  slug: any,
  shown: PairLike | null | undefined
): string => {
  const asked = typeof slug === "string" && slug.trim() !== "" ? slug.trim() : "That market";
  const label = pairLabel(shown);
  return label
    ? `${asked} is not a market on this venue. Showing ${label} instead.`
    : `${asked} is not a market on this venue.`;
};
