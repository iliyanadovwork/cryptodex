/**
 * Where a user's money actually lives, and how to add it up.
 *
 * THE RULE THIS MODULE ENCODES
 * "The headline is the sum of the lines printed under it, and every bucket the
 * headline counts is one of those lines." The wallet page once printed "Total
 * Assets Value" over the balance of whichever tab was selected, so moving money
 * between the user's own wallets made the headline drop and switching tabs made
 * it jump — a user watching that number would reasonably conclude the venue had
 * created or destroyed their funds. The rule is what keeps the page honest with
 * any number of buckets, including one.
 *
 * WHICH FIELDS ADD UP (and which would double count)
 * The wallet API (walletapi controllers/wallet.controller.js getWallet) returns
 * one asset row per coin carrying several buckets. They are NOT all disjoint:
 *
 *   spotBal          available spot balance
 *   spotInOrder      spot funds committed to resting orders   -> disjoint, add
 *   spotLockedBal    spot funds locked by the venue           -> disjoint, add
 *
 * WALLET_BUCKETS below is the whole list of what is counted, and anything on
 * the payload that is not named there is deliberately NOT summed. Counting a
 * balance the user cannot reach into "Total Assets Value" would overstate what
 * they can trade with, which is the same class of lie as understating it.
 */

/**
 * THE ONE CAPTION FOR THE TOTAL.
 *
 * The /wallet headline and the navbar dropdown are visible at the same moment
 * on that page. They were captioned "Total Assets Value (all wallets)" and
 * "Total Assets Value" over two different numbers. Both now render this
 * constant over the same computation, so a future edit cannot re-word one of
 * them without re-wording both.
 *
 * The "(all wallets)" qualifier was there to say the figure was not scoped to
 * the tab on screen. There are no wallet tabs left to be scoped to, so it would
 * now raise a question rather than answer one.
 */
export const TOTAL_ASSETS_LABEL = "Total Assets Value";

/**
 * The buckets the wallet page counts, in the order they are printed.
 *
 * There is exactly one left. The MAP is kept rather than collapsed into a plain
 * sum because the rule this module exists to enforce — the headline is the sum
 * of the lines printed under it — is a statement about a SET of buckets, and
 * flattening it to one addition is what would have to be undone the first time
 * this venue grows a second pot. The per-bucket API costs nothing while the set
 * has one member.
 */
export const WALLET_BUCKETS = {
  spot: ["spotBal", "spotInOrder", "spotLockedBal"],
} as const;

export type WalletBucket = keyof typeof WALLET_BUCKETS;


/**
 * Balances arrive as strings ("0", "10000.5") and sometimes as undefined for a
 * coin the user has never touched. Anything unparseable is zero, never NaN — a
 * single NaN would poison an entire total.
 */
export const toAmount = (raw: any): number => {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
};

/**
 * THE SPOT ROW'S "SUB TOTAL" AND ITS "ESTIMATED VALUE" ARE THE SAME QUANTITY.
 *
 * The /wallet spot table used to compute Sub Total from spotBal + spotInOrder
 * while Estimated Value was priced off spotBal ALONE. With 600 of a 9000 USD
 * balance resting in an order the row read "SUB TOTAL 9000.00 / ESTIMATED
 * VALUE(USD) 8400.00" — for a coin priced 1:1 against the quote. The 600 was
 * neither missing nor extra; one column simply counted a bucket the other did
 * not, and the row contradicted itself.
 *
 * Both now come from `bucketBalance(asset, "spot")`, which is also what the
 * headline sums, so the row, the tab figure and the headline cannot disagree.
 */
export function bucketBalance(asset: any, bucket: WalletBucket): number {
  if (!asset) return 0;
  const fields: readonly string[] = WALLET_BUCKETS[bucket];
  if (!fields) return 0;
  return fields.reduce(
    (sum: number, field: string) => sum + toAmount(asset[field]),
    0
  );
}

/**
 * Everything the user owns of one coin, across every wallet.
 *
 * This is the figure that must not change when money moves between the user's
 * own wallets — that is the whole point.
 */
export function totalBalance(asset: any): number {
  return (Object.keys(WALLET_BUCKETS) as WalletBucket[]).reduce(
    (sum, bucket) => sum + bucketBalance(asset, bucket),
    0
  );
}

/**
 * Convert a coin amount into the quote asset.
 *
 * A missing conversion rate falls back to 1:1 rather than to zero: pricing an
 * unknown coin at nothing understates the user's holdings, and for the quote
 * coin itself (USD priced in USD) 1:1 is exactly right.
 */
export function valueInQuote(amount: number, convertPrice: any): number {
  const rate = parseFloat(convertPrice);
  return Number.isFinite(rate) && rate > 0 ? amount * rate : amount;
}

/**
 * THE VENUE'S DEMO DOLLARS ARE WORTH A DOLLAR.
 * ============================================
 *
 * REPORTED: a brand-new account, seeded 1,000 USDC + 1,000 USD and never
 * traded, printed
 *
 *     TOTAL ASSETS VALUE   0.03156989 BTC ≈ 2000.90 USD
 *
 * The 90 cents is USDC, valued from `cryptodex_wallet.priceconversion`, whose
 * USDC/USD row is fetched from an OUTSIDE market (walletapi
 * controllers/priceCNV.controller.js `priceCNV`, binance/cryptocompare) and sat
 * at 1.00092 when this was measured.
 *
 * WHY THAT RATE DOES NOT BELONG HERE. This venue lists three markets - BTCUSD,
 * ETHUSD, SOLUSD - and USDC is in none of them. There is no order book to sell
 * USDC on, no pair that quotes it and no way for a user to realise 1.00092 or
 * any other number for it. The faucet issues USDC and USD together as one grant
 * of demo cash. So the rate was not describing this venue at all: it was
 * importing the price of an asset the user does not hold - real USDC - into the
 * scoreboard of one they do.
 *
 * And it MOVED. A fresh account that had never placed an order watched its
 * "Total Assets Value" drift with an outside market, which on a paper venue -
 * where the only honest reason for the number to change is that you traded - is
 * the number lying about what happened.
 *
 * SO: the coins this venue issues as dollars are valued at a dollar, and every
 * other coin is valued from the feed exactly as before. 1,000 + 1,000 reads
 * 2,000.00.
 *
 * THIS REVERSES PART OF AN EARLIER DECISION, KNOWINGLY. An earlier round found
 * /wallet and the navbar dropdown printing two different totals under one
 * caption, and one cause was that the navbar valued USDC at 1.00 while /wallet
 * valued it from the feed. That fix was right about the important half - there
 * must be ONE computation, which is this module, and there still is - but it
 * settled the tie in favour of the feed. It is settled the other way here, in
 * the one place both surfaces read, so the two figures still cannot disagree.
 * See __tests__/lib/totalAssetsAgreement.test.ts, which pins both properties.
 *
 * NOT A GENERIC "STABLECOIN" RULE. It is a list of the coins THIS venue issues
 * as its unit of account. A stablecoin that could actually be traded here would
 * have a market price on this venue, and that price is what it would be worth.
 */
// USDC was here too, while the faucet issued it. It had no market on a venue
// that lists only BTC/USD, so it could not be traded, converted or spent, and
// it is gone entirely - currency, balances and all. USD is the quote currency
// of the only market and the one thing the faucet now issues.
export const DEMO_DOLLAR_COINS = ["USD"];

/** Is `coin` one of the dollars this venue issues from the faucet? */
export const isDemoDollar = (coin: any): boolean =>
  typeof coin === "string" &&
  DEMO_DOLLAR_COINS.includes(coin.trim().toUpperCase());

/**
 * The rate to value one coin at, given whatever the price feed says.
 *
 * The single place the peg is applied. Both the /wallet row ("Estimated
 * Value") and the headline go through it, so a row can never disagree with the
 * total it is part of - the rule this whole module exists to keep.
 */
export function quoteRate(coin: any, feedRate: any): any {
  return isDemoDollar(coin) ? 1 : feedRate;
}

export interface WalletTotals {
  /** Value of everything the user owns, across every wallet. */
  total: number;
  /** Value held in each individual wallet. */
  byBucket: Record<WalletBucket, number>;
}

/**
 * Value a whole asset list, both in total and per wallet.
 *
 * `priceOf(coin)` returns the conversion rate into the quote asset, or
 * undefined when there is none.
 */
export function walletTotals(
  assets: any[],
  priceOf: (coin: string) => any
): WalletTotals {
  const byBucket = {
    spot: 0,
  } as Record<WalletBucket, number>;
  let total = 0;

  if (!Array.isArray(assets)) return { total, byBucket };

  for (const asset of assets) {
    if (!asset) continue;
    // The peg is applied HERE rather than by each caller, so no surface can
    // value a coin differently from the total it contributes to.
    const rate = quoteRate(asset.coin, priceOf(asset.coin));
    for (const bucket of Object.keys(WALLET_BUCKETS) as WalletBucket[]) {
      const value = valueInQuote(bucketBalance(asset, bucket), rate);
      byBucket[bucket] += value;
      total += value;
    }
  }

  return { total, byBucket };
}

/**
 * THE PRINTED FIGURES MUST ADD UP AS PRINTED.
 *
 * The headline and each wallet line are shown to the cent. Truncating four
 * exact numbers independently and then printing their EXACT sum leaves the page
 * off by up to a few cents — 18005.66 + 1999.81 + 8795.29 = 28800.76 under a
 * headline reading 28800.77. To a reader with a calculator that is the same
 * complaint all over again: the total does not equal the numbers beneath it.
 *
 * So the components are rounded first and the headline is their SUM. Everything
 * on screen is then internally consistent, and the discarded fraction of a cent
 * is smaller than the smallest unit the page displays.
 *
 * The unrounded `walletTotals().total` remains the right figure for anything
 * doing arithmetic rather than rendering.
 */
export function roundedTotals(
  byBucket: Record<WalletBucket, number>,
  decimals = 2
): { byBucket: Record<WalletBucket, number>; total: number } {
  const factor = Math.pow(10, decimals);
  const rounded = {} as Record<WalletBucket, number>;
  let total = 0;
  for (const bucket of Object.keys(WALLET_BUCKETS) as WalletBucket[]) {
    const raw = byBucket?.[bucket];
    const value = Number.isFinite(raw) ? Math.round(raw * factor) / factor : 0;
    rounded[bucket] = value;
    total += value;
  }
  // Re-round the sum: adding four values that each ended in .005 can reintroduce
  // a binary-float tail (0.1 + 0.2 = 0.30000000000000004).
  return { byBucket: rounded, total: Math.round(total * factor) / factor };
}
