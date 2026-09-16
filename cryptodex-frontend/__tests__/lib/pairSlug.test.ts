/**
 * `/spot/<slug>` RESOLVES TO THE MARKET IT NAMES (CRITICAL)
 * ========================================================
 *
 * REPORTED, and reproduced in a real browser: `/spot/BTCUSD` showed SOL/USD.
 * Not an error, not an empty screen - a working SOL/USD trading page, with the
 * SOL/USD book, the SOL/USD ticket and the URL silently rewritten. `BTCUSD` is
 * the pair's own `tikerRoot`, the name spotapi, the socket topics and
 * /api/spot/health all use for that market, so a user typing what they had read
 * would have been trading the wrong instrument with nothing on screen to say
 * so.
 *
 * The cause: the page split the slug on "_" and required exactly two halves.
 * One half matched nothing, and "matched nothing" fell into a branch that
 * replaced the pair with `pairList[0]` - which is SOL/USD here, because that is
 * the order spotapi returns the list in.
 *
 * Guards:
 *   P1  the separated form still resolves, in any casing and any separator;
 *   P2  the TICKER form resolves - the actual regression;
 *   P3  a slug naming no listed market is reported as NOT MATCHED, so the
 *       caller can say so instead of swapping the market silently;
 *   P4  the fallback is still a usable market (never a blank screen);
 *   P5  the message names both what was asked for and what is being shown.
 */

import {
  resolvePairSlug,
  pairLabel,
  unknownPairMessage,
} from "@/lib/pairSlug";

// The venue's real list, in the order spotapi returns it: SOL first, which is
// what made the bug invisible - the fallback looked like a plausible page.
const PAIRS = [
  { _id: "1", firstCurrencySymbol: "SOL", secondCurrencySymbol: "USD" },
  { _id: "2", firstCurrencySymbol: "BTC", secondCurrencySymbol: "USD" },
  { _id: "3", firstCurrencySymbol: "ETH", secondCurrencySymbol: "USD" },
];

describe("P1 the separated form", () => {
  it.each([
    "BTC_USD",
    "btc_usd",
    "Btc_Usd",
    "BTC-USD",
    "BTC/USD",
  ])("%s resolves to BTC/USD", (slug) => {
    const { pair, matched } = resolvePairSlug(slug, PAIRS);
    expect({ matched, id: pair?._id }).toEqual({ matched: true, id: "2" });
  });
});

describe("P2 the ticker form - the reported regression", () => {
  it.each(["BTCUSD", "btcusd", "BtcUsd"])("%s resolves to BTC/USD", (slug) => {
    const { pair, matched } = resolvePairSlug(slug, PAIRS);
    expect({ matched, id: pair?._id }).toEqual({ matched: true, id: "2" });
  });

  it("does not answer BTCUSD with the first pair in the list", () => {
    // The precise defect: SOL/USD is PAIRS[0], so a fallback and a correct
    // answer would have been indistinguishable if the list order were the only
    // thing checked.
    const { pair } = resolvePairSlug("BTCUSD", PAIRS);
    expect(pairLabel(pair)).toBe("BTC/USD");
  });

  it("resolves every listed market by its ticker, not just BTC", () => {
    expect(pairLabel(resolvePairSlug("ETHUSD", PAIRS).pair)).toBe("ETH/USD");
    expect(pairLabel(resolvePairSlug("SOLUSD", PAIRS).pair)).toBe("SOL/USD");
  });
});

describe("P3 a slug that names nothing is reported as such", () => {
  it.each(["DOGEUSD", "DOGE_USD", "BTC_EUR", "nonsense", "BTC", "", "   "])(
    "%s does not claim a match",
    (slug) => {
      expect(resolvePairSlug(slug, PAIRS).matched).toBe(false);
    }
  );

  it("a non-string slug is not a match either", () => {
    expect(resolvePairSlug(undefined, PAIRS).matched).toBe(false);
    expect(resolvePairSlug(null, PAIRS).matched).toBe(false);
    expect(resolvePairSlug(42 as any, PAIRS).matched).toBe(false);
  });
});

describe("P4 the fallback is a usable market", () => {
  it("an unknown slug still lands on a real pair", () => {
    const { pair, matched } = resolvePairSlug("DOGEUSD", PAIRS);
    expect(matched).toBe(false);
    expect(pair).toEqual(PAIRS[0]);
  });

  it("the caller may name the fallback itself", () => {
    const { pair } = resolvePairSlug("DOGEUSD", PAIRS, PAIRS[1]);
    expect(pairLabel(pair)).toBe("BTC/USD");
  });

  it("an empty list yields no pair at all rather than an invented one", () => {
    expect(resolvePairSlug("BTCUSD", [])).toEqual({ pair: null, matched: false });
    expect(resolvePairSlug("BTCUSD", undefined)).toEqual({
      pair: null,
      matched: false,
    });
  });
});

describe("P5 the message a user actually reads", () => {
  it("names what was asked for and what is on screen", () => {
    const msg = unknownPairMessage("DOGEUSD", PAIRS[0]);
    expect(msg).toContain("DOGEUSD");
    expect(msg).toContain("SOL/USD");
  });

  it("is still a sentence when there is nothing to show", () => {
    expect(unknownPairMessage("DOGEUSD", null)).toContain("DOGEUSD");
  });
});
