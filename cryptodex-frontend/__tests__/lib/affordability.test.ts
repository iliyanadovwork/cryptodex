/**
 * THE TICKET'S OWN BALANCE PRE-FLIGHT.
 *
 * Reported: "an unaffordable order is rejected with a liquidity excuse instead
 * of an insufficient-balance message."
 *
 * The spot API owns the server-side message and sends the right one on every
 * path that could be driven from the UI — EXCEPT when the account's Redis
 * balance row has never been written, where its affordability check
 * deliberately fails open and the liquidity verdict is returned instead. This
 * check is on the number the ticket is already displaying; it never rewrites a
 * server message.
 *
 * Its most important property is that it does NOT fire: a false "you are broke"
 * would break every 100%-of-balance order.
 */

import { affordabilityError } from "@/lib/affordability";

describe("when it must refuse", () => {
  it("refuses an order that plainly exceeds the shown balance", () => {
    const msg = affordabilityError({
      required: 999999999,
      available: "8575.00168354",
      symbol: "USD",
    });
    expect(msg).toMatch(/insufficient balance/i);
  });

  it("says both figures, in the currency they are in", () => {
    const msg = affordabilityError({
      required: 500,
      available: 100,
      symbol: "USD",
    })!;
    expect(msg).toContain("500");
    expect(msg).toContain("100");
    expect(msg).toContain("USD");
  });

  it("does not blame liquidity", () => {
    const msg = affordabilityError({ required: 500, available: 100, symbol: "USD" })!;
    expect(msg).not.toMatch(/liquidit/i);
  });

  it("keeps small coin amounts legible instead of printing 0", () => {
    const msg = affordabilityError({
      required: 0.5,
      available: 0.02215316,
      symbol: "BTC",
    })!;
    expect(msg).toContain("0.02215316");
    expect(msg).not.toMatch(/e-/);
  });
});

describe("when it must stay out of the way", () => {
  it("passes an order the balance exactly covers (the 100% slider)", () => {
    expect(
      affordabilityError({ required: 8575.00168354, available: 8575.00168354 })
    ).toBeNull();
  });

  it("tolerates the last binary place after toFixedDown / parseFloat", () => {
    const balance = 8575.00168354;
    const nudged = balance * (1 + 1e-12);
    expect(affordabilityError({ required: nudged, available: balance })).toBeNull();
  });

  it("REGRESSION: accepts the exact figure the ticket printed", () => {
    // Live failure this allowance exists for: the ticket showed
    // "Available 0.03062327 BTC" (Intl ROUNDS to the pair precision) over a
    // real balance of 0.030623265. Typing back what the screen said was
    // refused as unaffordable.
    const real = 0.030623265;
    const displayed = 0.03062327;
    expect(
      affordabilityError({ required: displayed, available: real, precision: 8 })
    ).toBeNull();
  });

  it("the display allowance is only half a displayed unit, not a blank cheque", () => {
    // One whole unit of the last digit past the balance IS unaffordable.
    expect(
      affordabilityError({ required: 0.03062328, available: 0.030623265, precision: 8 })
    ).not.toBeNull();
  });

  it("scales the allowance with the currency's precision", () => {
    // USD shows 2dp, so half a cent of slack — and no more.
    expect(
      affordabilityError({ required: 8575.004, available: 8575, precision: 2 })
    ).toBeNull();
    expect(
      affordabilityError({ required: 8575.02, available: 8575, precision: 2 })
    ).not.toBeNull();
  });

  it("passes anything comfortably affordable", () => {
    expect(affordabilityError({ required: 1, available: 8575 })).toBeNull();
  });

  it("says nothing when the balance is UNKNOWN — that is not 'zero'", () => {
    expect(affordabilityError({ required: 100, available: undefined })).toBeNull();
    expect(affordabilityError({ required: 100, available: null })).toBeNull();
    expect(affordabilityError({ required: 100, available: "" })).toBeNull();
    expect(affordabilityError({ required: 100, available: "n/a" })).toBeNull();
  });

  it("still refuses against a genuine zero balance", () => {
    // "unknown" passes; a balance actually READ as 0 does not.
    expect(affordabilityError({ required: 100, available: 0 })).not.toBeNull();
    expect(affordabilityError({ required: 100, available: "0" })).not.toBeNull();
  });

  it("says nothing when the requirement is not a judgeable number", () => {
    expect(affordabilityError({ required: "", available: 10 })).toBeNull();
    expect(affordabilityError({ required: "abc", available: 10 })).toBeNull();
    expect(affordabilityError({ required: 0, available: 10 })).toBeNull();
    expect(affordabilityError({ required: -5, available: 10 })).toBeNull();
  });

  it("compares like with like when both arrive as strings", () => {
    expect(affordabilityError({ required: "100", available: "8575" })).toBeNull();
    expect(
      affordabilityError({ required: "9000", available: "8575" })
    ).not.toBeNull();
  });
});
