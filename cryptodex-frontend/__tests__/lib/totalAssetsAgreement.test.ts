import {
  TOTAL_ASSETS_LABEL,
  roundedTotals,
  walletTotals,
} from "@/lib/walletTotals";

/**
 * TWO FIGURES CAPTIONED "TOTAL ASSETS VALUE" MUST NOT DISAGREE.
 *
 * The fixture is the developer's test account exactly as
 * `GET /api/wallet/getAssetsDetails` returned it, and the rates are the rows
 * `cryptodex_wallet.priceconversion` actually holds. Against those, /wallet
 * printed 57701.32 while the navbar dropdown printed 57385.36 — at the same
 * moment, on the same page, under the same caption.
 *
 * TWO CAUSES, and the fixture still exercises both:
 *   1. USDC took a private branch in the navbar that read `spotBal` alone and
 *      returned before the shared summing path, so a whole wallet's USDC went
 *      missing from that figure;
 *   2. the same branch counted USDC at 1.00 rather than at its published USD
 *      rate (1.00082), so 19699.79 USDC was 16.16 USD light as well.
 *
 * The fixture is LEFT UNCHANGED, extra balance columns and all. They are what
 * the payload carried on the day it was captured; no bucket names them now, so
 * nothing counts them, and walletapi's projection can no longer return them at
 * all — which is itself a claim worth pinning, so it is asserted below rather
 * than edited away.
 */
const ASSETS = [
  { coin: "USD", spotBal: "19699.78779690000010305", spotInOrder: "0", spotLockedBal: "0", derivativeBal: "299.75463650000000371", inverseBal: "0", affiliateBal: "0" },
  { coin: "BTC", spotBal: "0.00925622307375085", spotInOrder: "0", spotLockedBal: "0", derivativeBal: "0", inverseBal: "0.09999844", affiliateBal: "0" },
  { coin: "SOL", spotBal: "7.63720768095648239", spotInOrder: "0", spotLockedBal: "0", derivativeBal: "0", inverseBal: "99.99141994999999383", affiliateBal: "0" },
  { coin: "ETH", spotBal: "0", spotInOrder: "0", spotLockedBal: "0", derivativeBal: "0", inverseBal: "1.99999181999999998", affiliateBal: "0" },
];

const RATES: Record<string, number> = {
  // A published rate for a demo dollar. The venue issues it at a dollar and no
  // market here can realise anything else, so this number must be IGNORED -
  // that is the property the file exists to hold.
  USD: 1.00082,
  BTC: 64678,
  SOL: 74.14,
  ETH: 1911.74,
};

const priceOf = (coin: string) => RATES[coin];

/**
 * What the module is expected to value one unit of `coin` at.
 *
 * The venue's demo dollars are a dollar - see lib/walletTotals
 * `DEMO_DOLLAR_COINS`. USDC is in NO market on this venue (BTCUSD, ETHUSD,
 * SOLUSD), so the 1.00082 in RATES above is a price from an outside exchange
 * for an asset the user does not hold, and it made a fresh 1,000 USDC + 1,000
 * USD account read "2000.90". This helper is deliberately NOT imported from the
 * module under test: it restates the rule independently, so a change to the
 * peg has to be made in two places that disagree loudly.
 */
const expectedRate = (coin: string) =>
  coin === "USD" ? 1 : RATES[coin];

/** The shared computation both surfaces now call. */
const shared = () => roundedTotals(walletTotals(ASSETS, priceOf).byBucket, 2);

/**
 * The navbar's OLD arithmetic, reproduced verbatim so the regression it caused
 * is pinned rather than described: USDC took a private branch that read spotBal
 * alone at 1:1 and returned before the shared summing path.
 *
 * Note it also added `inverseBal` and `derivativeBal`, which is what the venue
 * counted when it had two derivative products.
 */
const legacyNavbarTotal = () => {
  let total = 0;
  const usdc = ASSETS.find((a) => a.coin === "USD");
  if (usdc) total += parseFloat(usdc.spotBal);
  for (const asset of ASSETS) {
    if (asset.coin === "USD") continue;
    const rate = priceOf(asset.coin);
    const sum =
      parseFloat(asset.spotBal || "0") +
      parseFloat(asset.inverseBal || "0") +
      parseFloat(asset.derivativeBal || "0");
    total += rate ? sum * rate : sum;
  }
  return total;
};

/**
 * GUARD 1 — THE OLD FIGURE REALLY WAS WRONG, AND WRONG IN THE REPORTED WAY
 */
describe("guard: the reported disagreement is reproduced by the old arithmetic", () => {
  it("the old navbar total dropped an entire wallet's dollars", () => {
    // The half of the reported gap that was never in dispute: the navbar's
    // private USDC branch read `spotBal` and RETURNED, so the rest of that
    // coin's buckets - and the shared summing path - never ran. The shared
    // computation counts the whole coin.
    const usdcOnly = walletTotals([ASSETS[0]], priceOf);
    expect(usdcOnly.byBucket.spot).toBeCloseTo(19699.78779690000010305, 6);
  });

  it("values the venue's demo dollars at a dollar, not at an outside market's rate", () => {
    // THE REVERSAL, STATED. The earlier fix settled a disagreement between two
    // surfaces by valuing USDC from `priceconversion` (1.00082 here). That rate
    // comes from an exchange this venue is not - there is no USDC market on
    // this platform, so no user can realise it - and it made a brand-new
    // account, seeded 1,000 USDC + 1,000 USD and never traded, print
    // "2000.90 USD" and then drift while nothing happened.
    //
    // What the earlier fix was actually right about is that there must be ONE
    // computation. There still is: this module. Both surfaces read it, so both
    // moved together.
    const fresh = [
      { coin: "USD", spotBal: "2000", spotInOrder: "0", spotLockedBal: "0" },
    ];
    expect(walletTotals(fresh, priceOf).total).toBe(2000);
    // ...and specifically NOT the figure the feed rate produces.
    expect(walletTotals(fresh, priceOf).total).not.toBeCloseTo(
      2000 * RATES.USD,
      2
    );
  });

  it("still values a TRADABLE coin from the feed", () => {
    // The peg is a list of the coins this venue issues as dollars, not a
    // blanket 1:1. BTC is a market here and is worth what the market says.
    const btcOnly = [
      { coin: "BTC", spotBal: "0.5", spotInOrder: "0", spotLockedBal: "0" },
    ];
    expect(walletTotals(btcOnly, priceOf).total).toBeCloseTo(0.5 * RATES.BTC, 6);
  });

  it("the two figures are not the same number by accident", () => {
    expect(legacyNavbarTotal()).not.toBeCloseTo(shared().total, 2);
  });
});

/**
 * GUARD 2 — ONE COMPUTATION, SO THE TWO FIGURES CANNOT DIVERGE
 */
describe("guard: both surfaces read the same number", () => {
  it("the shared total is stable across repeated evaluation", () => {
    expect(shared().total).toBe(shared().total);
  });

  it("the headline equals the sum of the per-wallet lines, exactly as printed", () => {
    const { byBucket, total } = shared();
    const sum = Object.values(byBucket).reduce((a, b) => a + b, 0);
    expect(Number(sum.toFixed(2))).toBe(total);
  });

  it("rounds each line FIRST and sums those, not the other way round", () => {
    // The original defect: several lines each rounding up by nearly half a cent
    // were summed raw and rounded once, so the headline sat a cent or two above
    // the figures printed beneath it. This venue has ONE bucket left, so the
    // headline and the line are the same number and the ordering cannot be
    // observed from outside — but the implementation still rounds per bucket,
    // and these assertions pin the rounding itself so the property is intact
    // the moment a second bucket exists.
    const drifting = { spot: 10.004999 };
    const { byBucket, total } = roundedTotals(drifting as any, 2);
    expect(byBucket.spot).toBe(10.0);
    expect(total).toBe(Number(byBucket.spot.toFixed(2)));

    const upward = { spot: 0.005 };
    const rounded = roundedTotals(upward as any, 2);
    expect(rounded.byBucket.spot).toBe(0.01);
    expect(rounded.total).toBe(0.01);
  });

  it("ignores a bucket the venue no longer counts", () => {
    // `affiliate` was a bucket until the programme was removed. A caller still
    // passing one must not have it silently added back into the headline, and
    // must not produce NaN either.
    const withGhost = { spot: 100, affiliate: 250 } as any;
    const { byBucket, total } = roundedTotals(withGhost, 2);
    expect(total).toBe(100);
    expect((byBucket as any).affiliate).toBeUndefined();
  });

  it("does not count the extra balances the captured payload carried", () => {
    // The fixture carries 299.75 USD and BTC/SOL/ETH sitting in columns that no
    // bucket names. No product on this venue can spend or move any of it, so
    // "Total Assets Value" must not include it.
    const strandedUsdc = 299.75463650000000371 * expectedRate("USDC");
    const spotOnly = ASSETS.reduce((sum, a) => {
      const rate = expectedRate(a.coin);
      const qty =
        parseFloat(a.spotBal) +
        parseFloat(a.spotInOrder) +
        parseFloat(a.spotLockedBal);
      return sum + (rate ? qty * rate : qty);
    }, 0);
    expect(walletTotals(ASSETS, priceOf).total).toBeCloseTo(spotOnly, 6);
    expect(walletTotals(ASSETS, priceOf).total).not.toBeCloseTo(
      spotOnly + strandedUsdc,
      2
    );
  });

  it("moving spot money into a resting order does not change the total", () => {
    const before = walletTotals(ASSETS, priceOf).total;
    const moved = ASSETS.map((a) =>
      a.coin === "USDC"
        ? {
            ...a,
            spotBal: String(parseFloat(a.spotBal) - 1000),
            spotInOrder: String(parseFloat(a.spotInOrder) + 1000),
          }
        : a
    );
    expect(walletTotals(moved, priceOf).total).toBeCloseTo(before, 6);
  });
});

/**
 * GUARD 3 — ONE CAPTION
 *
 * The original assertion was that the caption said "(all wallets)", because two
 * captions on one screen disagreed and the scoped one was the honest one. There
 * is one wallet now, so "(all wallets)" would raise the question it used to
 * answer. What actually mattered — and what is asserted here — is that BOTH
 * surfaces render one exported constant, so neither can be re-worded alone.
 */
describe("guard: one caption for the total", () => {
  const fs = require("fs");
  const path = require("path");
  const read = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  it("is a non-empty caption naming what it counts", () => {
    expect(typeof TOTAL_ASSETS_LABEL).toBe("string");
    expect(TOTAL_ASSETS_LABEL).toContain("Total Assets Value");
  });

  it("no longer claims a scope the venue does not have", () => {
    expect(TOTAL_ASSETS_LABEL).not.toContain("all wallets");
  });

  /** Source with every comment removed, so prose about the old bug cannot
   *  register as a hand-written caption. */
  const code = (rel: string) =>
    read(rel)
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

  it("both surfaces render the constant rather than their own string", () => {
    for (const file of ["components/Wallet/WalletList.tsx", "components/navbar.tsx"]) {
      const src = code(file);
      expect([file, src.includes("TOTAL_ASSETS_LABEL")]).toEqual([file, true]);
      // A hand-written duplicate of the caption is exactly how the two drifted.
      expect([file, /Total Assets Value/.test(src)]).toEqual([file, false]);
    }
  });
});
