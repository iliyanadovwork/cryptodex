/**
 * HOW MANY DECIMALS A /history ROW GETS.
 *
 * REPORTED: "/history -> Spot Trade History shows a DIFFERENT QUANTITY from the
 * trade page for the same trade (0.0155 vs 0.01553693)."
 *
 * The trade page prints `formatQty(tradeQty, tradePair.firstFloatDigit)`; the
 * /history table printed `toFixed(tradeQty, 4)` - a fixed four places that also
 * ROUNDS. Two screens, one fill, two numbers, and the smaller screen's was not
 * even a truncation of the larger.
 *
 * Guards:
 *   H1  a row that describes its own precision is believed;
 *   H2  a row that does not is resolved against the live pair list, matched on
 *       tikerRoot (which is what a trade row's `pairName` holds);
 *   H3  an unresolvable row falls back to a floor that still shows a satoshi,
 *       rather than to something that truncates;
 *   H4  a nonsense precision never reaches the formatter.
 */

import {
  findPair,
  qtyDigitsFor,
  priceDigitsFor,
  FALLBACK_QTY_DIGITS,
  FALLBACK_PRICE_DIGITS,
} from "@/lib/historyPrecision";

const PAIRS = [
  { tikerRoot: "BTCUSD", firstFloatDigit: 8, secondFloatDigit: 2 },
  { tikerRoot: "ETHUSD", firstFloatDigit: 18, secondFloatDigit: 2 },
];

describe("H1 a row that carries its own precision", () => {
  it("uses the row's own digits for size and price", () => {
    const row = { firstFloatDigit: 6, secondFloatDigit: 4 };
    expect(qtyDigitsFor(row, PAIRS)).toBe(6);
    expect(priceDigitsFor(row, PAIRS)).toBe(4);
  });

  it("prefers the row over the pair list when they disagree", () => {
    const row = { pairName: "BTCUSD", firstFloatDigit: 3 };
    expect(qtyDigitsFor(row, PAIRS)).toBe(3);
  });

  it("accepts zero decimals as a real answer, not as missing", () => {
    expect(qtyDigitsFor({ firstFloatDigit: 0 }, PAIRS)).toBe(0);
    expect(priceDigitsFor({ secondFloatDigit: 0 }, PAIRS)).toBe(0);
  });
});

describe("H2 a row resolved through the pair list", () => {
  it("matches a trade row's pairName against tikerRoot", () => {
    expect(qtyDigitsFor({ pairName: "BTCUSD" }, PAIRS)).toBe(8);
    expect(priceDigitsFor({ pairName: "BTCUSD" }, PAIRS)).toBe(2);
  });

  it("the pair list is really consulted, not shadowed by the fallback", () => {
    // BTC's configured precision happens to equal the floor, so asserting on
    // it alone cannot tell "looked the pair up" from "gave up". ETH is 18.
    expect(qtyDigitsFor({ pairName: "ETHUSD" }, PAIRS)).toBe(18);
    expect(qtyDigitsFor({ pairName: "ETHUSD" }, PAIRS)).not.toBe(
      FALLBACK_QTY_DIGITS
    );
  });

  it("the same for the price column", () => {
    const pairs = [{ tikerRoot: "XRPUSD", secondFloatDigit: 5 }];
    expect(priceDigitsFor({ pairName: "XRPUSD" }, pairs)).toBe(5);
    expect(priceDigitsFor({ pairName: "XRPUSD" }, pairs)).not.toBe(
      FALLBACK_PRICE_DIGITS
    );
  });

  it("is case-insensitive and trims", () => {
    expect(findPair(PAIRS, " btcusd ")?.tikerRoot).toBe("BTCUSD");
  });

  it("does not match on the pair's display name", () => {
    // The pair document's own `pairName` is "BTC/USD"; a trade row's is
    // "BTCUSD". Matching the wrong one would silently pick no pair.
    expect(findPair([{ pairName: "BTC/USD" } as any], "BTC/USD")).toBeNull();
  });

  it("returns null rather than a partial match", () => {
    expect(findPair(PAIRS, "BTC")).toBeNull();
    expect(findPair(PAIRS, "BTCUSDT")).toBeNull();
  });
});

describe("H3 nothing resolvable still shows the real number", () => {
  it.each([
    ["no pair list", undefined],
    ["a non-list", {} as any],
    ["an empty list", []],
  ])("%s falls back to the floor", (_l, list) => {
    expect(qtyDigitsFor({ pairName: "BTCUSD" }, list)).toBe(
      FALLBACK_QTY_DIGITS
    );
    expect(priceDigitsFor({ pairName: "BTCUSD" }, list)).toBe(
      FALLBACK_PRICE_DIGITS
    );
  });

  it("a delisted pair still gets 8 places, not 4", () => {
    // THE BUG, in one line: 4 places rounded 0.01553693 to 0.0155 and anything
    // under 0.00005 BTC to a flat zero.
    expect(qtyDigitsFor({ pairName: "OLDUSD" }, PAIRS)).toBeGreaterThanOrEqual(
      8
    );
  });

  it.each([
    ["undefined row", undefined],
    ["null row", null],
    ["empty row", {}],
    ["a non-string pairName", { pairName: 42 }],
  ])("%s falls back rather than throwing", (_l, row) => {
    expect(qtyDigitsFor(row, PAIRS)).toBe(FALLBACK_QTY_DIGITS);
    expect(priceDigitsFor(row, PAIRS)).toBe(FALLBACK_PRICE_DIGITS);
  });
});

describe("H4 a nonsense precision never reaches the formatter", () => {
  it.each([
    ["negative", -2],
    ["NaN", NaN],
    ["a word", "eight"],
    ["null", null],
    ["empty string", ""],
  ])("%s is ignored", (_l, value) => {
    expect(qtyDigitsFor({ firstFloatDigit: value }, PAIRS)).toBe(
      FALLBACK_QTY_DIGITS
    );
    expect(priceDigitsFor({ secondFloatDigit: value }, PAIRS)).toBe(
      FALLBACK_PRICE_DIGITS
    );
  });

  it("falls through the row to the pair when the row's value is nonsense", () => {
    expect(qtyDigitsFor({ pairName: "BTCUSD", firstFloatDigit: -1 }, PAIRS)).toBe(
      8
    );
  });

  it("ignores a nonsense value on the PAIR too", () => {
    const bad = [{ tikerRoot: "BTCUSD", firstFloatDigit: "x" }];
    expect(qtyDigitsFor({ pairName: "BTCUSD" }, bad)).toBe(
      FALLBACK_QTY_DIGITS
    );
  });
});
