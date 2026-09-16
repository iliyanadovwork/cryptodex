import { lastTradePrice } from "@/lib/lastPrice";

/**
 * The spot page paints "the price" in four places. Two of them (the headline
 * and the order book's last-price marker) were reading the 30s venue cron while
 * the ladder and the trade log were reading the matching engine, so during any
 * sustained move the two biggest numbers on the page were a whole cron cycle
 * out of date — sitting above every ask, or below every bid.
 */
describe("lastTradePrice", () => {
  const VENUE = 64697.62; // the stale 30s cron figure
  const TRADED = 64730.0; // what actually just traded

  it("prefers the executed price over the venue tick", () => {
    expect(lastTradePrice({ pairId: "p1", price: TRADED }, "p1", VENUE)).toBe(TRADED);
  });

  it("ignores a price belonging to a different pair", () => {
    // A BTC price left over from the previously viewed pair must never be
    // printed on a SOL header — that is worse than being 30 seconds late.
    expect(lastTradePrice({ pairId: "BTC", price: TRADED }, "SOL", VENUE)).toBe(VENUE);
  });

  it("compares pair ids across string/ObjectId shapes", () => {
    expect(lastTradePrice({ pairId: 12, price: TRADED }, "12", VENUE)).toBe(TRADED);
  });

  it("falls back when there is no trade yet", () => {
    expect(lastTradePrice(null, "p1", VENUE)).toBe(VENUE);
    expect(lastTradePrice(undefined, "p1", VENUE)).toBe(VENUE);
    expect(lastTradePrice({}, "p1", VENUE)).toBe(VENUE);
  });

  it("rejects prices that are not usable numbers", () => {
    expect(lastTradePrice({ pairId: "p1", price: 0 }, "p1", VENUE)).toBe(VENUE);
    expect(lastTradePrice({ pairId: "p1", price: -5 }, "p1", VENUE)).toBe(VENUE);
    expect(lastTradePrice({ pairId: "p1", price: null }, "p1", VENUE)).toBe(VENUE);
    expect(lastTradePrice({ pairId: "p1", price: "abc" }, "p1", VENUE)).toBe(VENUE);
    expect(lastTradePrice({ pairId: "p1", price: Infinity }, "p1", VENUE)).toBe(VENUE);
  });

  it("accepts a numeric string price", () => {
    expect(lastTradePrice({ pairId: "p1", price: "64730.00" }, "p1", VENUE)).toBe(TRADED);
  });

  it("falls back when the pair on screen is unknown", () => {
    expect(lastTradePrice({ pairId: "p1", price: TRADED }, undefined, VENUE)).toBe(VENUE);
    expect(lastTradePrice({ pairId: "p1", price: TRADED }, "", VENUE)).toBe(VENUE);
  });

  it("does not treat two unknown pair ids as a match", () => {
    // The identity test is String(a) !== String(b), and String(undefined) is
    // equal to String(undefined) — so without an explicit unknown-pair guard a
    // price with no pair would be adopted by a page with no pair. Both are
    // "I do not know which market this is", which is never a reason to print
    // a number.
    expect(lastTradePrice({ pairId: undefined, price: TRADED }, undefined, VENUE)).toBe(VENUE);
    expect(lastTradePrice({ pairId: null, price: TRADED }, null, VENUE)).toBe(VENUE);
    expect(lastTradePrice({ pairId: "", price: TRADED }, "", VENUE)).toBe(VENUE);
  });

  it("passes the fallback through untouched so callers keep their placeholder", () => {
    // OrderBook renders "—" when there is no price at all; the helper must not
    // substitute a number of its own.
    expect(lastTradePrice(null, "p1", undefined)).toBeUndefined();
    expect(lastTradePrice({ pairId: "p1", price: "x" }, "p1", undefined)).toBeUndefined();
  });
});
