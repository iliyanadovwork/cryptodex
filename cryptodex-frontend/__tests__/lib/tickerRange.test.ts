/**
 * 24H HIGH / LOW THAT CANNOT CONTRADICT THE LIVE PRICE.
 *
 * Reported: "/spot 24H High/Low are stale and routinely contradict the live
 * price and order book on the same screen." They arrive once on the REST pair
 * payload; the 30s live tick carries no high/low at all, so they freeze while
 * the price keeps moving.
 */

import { widenRange, displayRange, EMPTY_RANGE } from "@/lib/tickerRange";

describe("widenRange", () => {
  it("takes the first observation as both ends", () => {
    expect(widenRange(EMPTY_RANGE, [73.5])).toEqual({ high: 73.5, low: 73.5 });
  });

  it("only ever grows", () => {
    let r = widenRange(EMPTY_RANGE, [100]);
    r = widenRange(r, [110]);
    r = widenRange(r, [90]);
    r = widenRange(r, [95]); // inside — must not narrow anything
    expect(r).toEqual({ high: 110, low: 90 });
  });

  it("returns the SAME object when nothing moved outside the range", () => {
    // Identity matters: this runs on every tick, and a new object each time
    // would re-render the header twice a minute forever.
    const r = widenRange(EMPTY_RANGE, [100]);
    expect(widenRange(r, [100])).toBe(r);
    expect(widenRange(r, [])).toBe(r);
    expect(widenRange(r, [null, undefined, 0, -1, "x"])).toBe(r);
  });

  it("ignores zero, negative and unparseable prices", () => {
    const r = widenRange(EMPTY_RANGE, [0, -3, "", null, "abc", NaN]);
    expect(r).toEqual(EMPTY_RANGE);
  });

  it("accepts the strings the socket sends", () => {
    expect(widenRange(EMPTY_RANGE, ["73.53"])).toEqual({
      high: 73.53,
      low: 73.53,
    });
  });

  it("handles several prices in one tick", () => {
    expect(widenRange(EMPTY_RANGE, [100, 105, 98])).toEqual({
      high: 105,
      low: 98,
    });
  });
});

describe("displayRange", () => {
  it("uses the server's figures when nothing has been observed", () => {
    expect(displayRange(74.25, 73.1, EMPTY_RANGE)).toEqual({
      high: 74.25,
      low: 73.1,
    });
  });

  it("THE BUG: a live price above the frozen high raises the high", () => {
    // Server snapshot said the day topped out at 74.25; we then watched it
    // trade at 74.90. Printing 74.25 next to 74.90 is the contradiction.
    const observed = widenRange(EMPTY_RANGE, [74.9]);
    expect(displayRange(74.25, 73.1, observed).high).toBe(74.9);
  });

  it("THE BUG: a live price below the frozen low lowers the low", () => {
    const observed = widenRange(EMPTY_RANGE, [72.5]);
    expect(displayRange(74.25, 73.1, observed).low).toBe(72.5);
  });

  it("never narrows the server's range", () => {
    const observed = widenRange(EMPTY_RANGE, [73.5]); // strictly inside
    expect(displayRange(74.25, 73.1, observed)).toEqual({
      high: 74.25,
      low: 73.1,
    });
  });

  it("stands alone when the server has no figures (the 0 placeholder)", () => {
    const observed = widenRange(EMPTY_RANGE, [73.5, 74.0]);
    expect(displayRange(0, 0, observed)).toEqual({ high: 74, low: 73.5 });
  });

  it("survives a missing server payload entirely", () => {
    expect(displayRange(undefined, null, EMPTY_RANGE)).toEqual({
      high: null,
      low: null,
    });
  });

  it("the printed range always contains every observed price", () => {
    // The property that makes the header impossible to contradict.
    const prices = [73.9, 74.8, 72.2, 73.1, 75.6];
    const observed = prices.reduce(
      (r, p) => widenRange(r, [p]),
      EMPTY_RANGE as any
    );
    const range = displayRange(74.25, 73.1, observed);
    prices.forEach((p) => {
      expect(range.high).toBeGreaterThanOrEqual(p);
      expect(range.low).toBeLessThanOrEqual(p);
    });
  });
});

/**
 * A PRICE FROM ANOTHER MARKET MUST NOT BECOME THIS MARKET'S 24H LOW.
 *
 * REPORTED: a BTC/USD header printing "24H Low 96.48" while the server's own
 * figure - in mongo and in the redis cache alike - was 76,670.01. 96 is a SOL
 * price, and `marketPrice`/`recentTrade` are broadcast for EVERY listed pair, so
 * a sample belonging to another market only has to be read once.
 *
 * widenRange then never let go: it only widens, and the observed range is
 * cleared only on a pair change, so one stray number owned that cell for the
 * rest of the session.
 */
describe("an observed price far outside the server's window is not an extreme", () => {
  it("ignores another market's price instead of printing it as the low", () => {
    // The reported case, to the digit.
    const r = displayRange(80000, 76670.01, { high: 80000, low: 96.48 });
    expect(r.low).toBe(76670.01);
  });

  it("ignores a wildly high sample too", () => {
    const r = displayRange(80000, 76670.01, { high: 4_000_000, low: 76670.01 });
    expect(r.high).toBe(80000);
  });

  it("STILL accepts a genuine new extreme", () => {
    // A real intraday move: the price traded below the server's snapshot low.
    const r = displayRange(80000, 76670.01, { high: 80500, low: 74000 });
    expect(r.low).toBe(74000);
    expect(r.high).toBe(80500);
  });

  it("accepts a large but believable move", () => {
    // 30% below the server low is dramatic, and still a real market.
    const r = displayRange(80000, 76670.01, { high: 80000, low: 53669 });
    expect(r.low).toBe(53669);
  });

  it("trusts the observed value when the server offers nothing to judge it by", () => {
    // No server figure: a loose high/low beats no high/low at all.
    const r = displayRange(0, 0, { high: 120, low: 96.48 });
    expect(r).toEqual({ high: 120, low: 96.48 });
  });
});
