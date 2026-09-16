/**
 * /history -> Spot -> Order History columns.
 *
 * THE REPORTED FAULT
 * "prints the literal string 'Market' in the Price column and truncates
 * quantity to 4dp."
 *
 * "Market" in the Price column is not a price — and the Trade Type column one
 * cell to the left already says it. So the one screen a user goes to in order
 * to find out what a market order FILLED AT showed no price at all, for every
 * market order they had ever placed. Meanwhile 4dp erased ordinary BTC sizes:
 * an 0.00008 BTC fill (about $5 at $64k) rendered as "0.0001", and anything
 * smaller as a flat "0.0000".
 */

import {
  executedPrice,
  priceDigits,
  qtyDigits,
  remainingQuantity,
} from "@/components/History/OrderHistory";

/** A filled market buy, exactly as spotapi's orderHistory collection stores it. */
const marketBuy = (over: any = {}) => ({
  orderType: "market",
  buyorsell: "buy",
  price: 0,
  openQuantity: 200,
  filledQuantity: 0.0031,
  // averagePrice is the TOTAL consideration for the fills, not a unit price.
  averagePrice: 0.0031 * 63976,
  firstFloatDigit: 8,
  secondFloatDigit: 2,
  status: "completed",
  ...over,
});

describe("the Price column", () => {
  it('THE BUG: no longer prints the literal string "Market"', () => {
    expect(executedPrice(marketBuy())).not.toBe("Market");
  });

  it("prints what the order actually filled at", () => {
    const shown = executedPrice(marketBuy());
    expect(parseFloat(shown.replace(/,/g, ""))).toBeCloseTo(63976, 0);
  });

  it("keeps a limit order's own price", () => {
    const limit = marketBuy({
      orderType: "limit",
      price: 40000,
      filledQuantity: 0,
      averagePrice: 0,
    });
    expect(parseFloat(executedPrice(limit).replace(/,/g, ""))).toBeCloseTo(
      40000,
      2
    );
  });

  it("prefers the executed price over the limit price once filled", () => {
    const filledLimit = marketBuy({
      orderType: "limit",
      price: 40000,
      filledQuantity: 0.001,
      averagePrice: 0.001 * 39990,
    });
    expect(parseFloat(executedPrice(filledLimit).replace(/,/g, ""))).toBeCloseTo(
      39990,
      0
    );
  });

  it("shows a dash for a market order with nothing to report", () => {
    // Not "Market" — there is genuinely no price, and saying so is honest.
    expect(
      executedPrice(marketBuy({ filledQuantity: 0, averagePrice: 0 }))
    ).toBe("—");
  });

  it("does not divide by zero", () => {
    expect(
      executedPrice(marketBuy({ filledQuantity: 0, averagePrice: 100 }))
    ).toBe("—");
  });
});

describe("precision", () => {
  it("THE BUG: an 0.00008 BTC fill is not rounded to 0.0001", () => {
    const row = marketBuy({ filledQuantity: 0.00008 });
    expect(qtyDigits(row)).toBe(8);
    expect((0.00008).toFixed(4)).toBe("0.0001"); // what it used to show
  });

  it("uses the pair precision recorded on the row", () => {
    expect(qtyDigits({ firstFloatDigit: 9 })).toBe(9);
    expect(priceDigits({ secondFloatDigit: 4 })).toBe(4);
  });

  it("falls back to satoshi precision, not to 4dp", () => {
    expect(qtyDigits({})).toBe(8);
    expect(qtyDigits({ firstFloatDigit: "oops" })).toBe(8);
    expect(priceDigits({})).toBe(2);
  });

  it("accepts the numeric-string form the record may carry", () => {
    expect(qtyDigits({ firstFloatDigit: "8" })).toBe(8);
  });
});

describe("Filled / Remaining", () => {
  it("is zero for a market buy — its size is in the QUOTE currency", () => {
    // openQuantity for a market buy is dollars, filledQuantity is coins;
    // subtracting them mixes units and means nothing.
    expect(remainingQuantity(marketBuy())).toBe(0);
  });

  it("is the unfilled remainder of a limit order", () => {
    expect(
      remainingQuantity({ orderType: "limit", openQuantity: 1, filledQuantity: 0.25 })
    ).toBeCloseTo(0.75, 12);
  });

  it("never goes negative when a fill overshoots", () => {
    expect(
      remainingQuantity({ orderType: "limit", openQuantity: 1, filledQuantity: 1.0001 })
    ).toBe(0);
  });

  it("survives a missing openQuantity", () => {
    expect(remainingQuantity({ orderType: "limit" })).toBe(0);
  });
});
