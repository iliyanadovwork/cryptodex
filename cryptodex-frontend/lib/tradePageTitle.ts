/**
 * THE BROWSER TAB ON A TRADE PAGE.
 * ================================
 *
 * THE BUG THIS EXISTS TO KILL
 * ---------------------------
 * Every trade page built its <title> by hand, identically:
 *
 *     `${marketData && marketData.markPrice} | ${marketData && marketData.baseCoinSymbol
 *      }${marketData && marketData.quoteCoinSymbol} | ${config.SITE_NAME}`
 *
 * `marketData` starts as an empty object — TRUTHY — so `marketData && x` is not
 * a guard at all: it evaluates to `undefined`, and template interpolation
 * renders that as the six letters "undefined". MEASURED in Chrome, the tab on
 * a trade page read, on every load until the socket delivered a
 * price:
 *
 *     0 | undefinedundefined | Cryptodex Exchange
 *
 * That is the string a user sees in the tab, in their history, and in a
 * bookmark saved before the feed arrives. The `&&` was clearly meant to guard,
 * which is exactly why it is worth removing: it looks like a check and is not
 * one.
 *
 * WHAT A TAB SHOULD SAY WHEN IT DOES NOT KNOW YET
 * ----------------------------------------------
 * The pair, if the pair is known, and the site name — never a placeholder for a
 * price that has not arrived. A tab is an identifier, so the parts that ARE
 * known should still identify it; dropping only the unknown segment keeps
 * "BTCUSD | Cryptodex Exchange" useful while the price is in flight, and the
 * price slots in without the title ever having lied.
 *
 * Pair objects from different sources name their symbol fields differently
 * (spot uses firstCurrencySymbol/secondCurrencySymbol; other shapes use
 * baseCoinSymbol/quoteCoinSymbol), which is why this takes the already-resolved
 * pair rather than guessing: each call site knows its own shape.
 */

/** A finite, positive price is worth printing; anything else is not known yet. */
function priceSegment(markPrice: any): string {
  const price = typeof markPrice === "number" ? markPrice : parseFloat(markPrice);
  // 0 is the pre-feed value this defect actually shipped, and a zero price is
  // never a real quote on these venues, so it is treated as "not yet" rather
  // than printed as a price.
  if (!Number.isFinite(price) || price <= 0) return "";
  return String(markPrice);
}

/** "BTCUSD" from the two symbol halves, or "" when either is missing. */
function pairSegment(base: any, quote: any): string {
  const b = typeof base === "string" ? base.trim() : "";
  const q = typeof quote === "string" ? quote.trim() : "";
  // A half-known pair ("BTC" with no quote) is not a symbol anyone would
  // recognise, so it is dropped rather than printed as a fragment.
  if (b === "" || q === "") return "";
  return `${b}${q}`;
}

/**
 * `"64285 | BTCUSDC | Cryptodex Exchange"`, dropping whatever is not yet known.
 *
 * Falls all the way back to `siteName` alone, which is what the tab said before
 * any of this was interpolated and is always a truthful title.
 */
export function tradePageTitle(
  markPrice: any,
  baseSymbol: any,
  quoteSymbol: any,
  siteName: any
): string {
  const site = typeof siteName === "string" ? siteName.trim() : "";
  const parts = [priceSegment(markPrice), pairSegment(baseSymbol, quoteSymbol)]
    .filter((part) => part !== "");
  if (site !== "") parts.push(site);
  return parts.join(" | ");
}
