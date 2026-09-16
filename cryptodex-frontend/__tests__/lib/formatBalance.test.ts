/**
 * A DISPLAYED BALANCE MUST BE SPENDABLE.
 *
 * Found while verifying the insufficient-balance fix: the spot ticket's
 * "Available" figure went through `formatQty`, which rounds. A real balance of
 * 0.030623265 BTC was printed as "0.03062327" — more than the account holds —
 * and typing that number back into the amount field (the obvious way to sell
 * everything) was refused by the server for insufficient balance. The ticket
 * had quoted a balance that did not exist.
 */

import { formatBalance, formatQty } from "@/lib/numberFormat";

describe("the reported case", () => {
  const real = 0.030623265;

  it("formatQty ROUNDS UP past the real balance", () => {
    // Pinning the behaviour that caused it, so the reason for this function
    // does not get lost.
    expect(parseFloat(formatQty(real, 8))).toBeGreaterThan(real);
  });

  it("formatBalance never exceeds the real balance", () => {
    expect(parseFloat(formatBalance(real, 8))).toBeLessThanOrEqual(real);
    expect(formatBalance(real, 8)).toBe("0.03062326");
  });

  it("is off by less than one unit of the last digit shown", () => {
    expect(real - parseFloat(formatBalance(real, 8))).toBeLessThan(1e-8);
  });
});

describe("across precisions", () => {
  it("truncates USD to cents rather than rounding up", () => {
    expect(formatBalance(8575.009, 2)).toBe("8575");
    expect(formatBalance(8575.999, 2)).toBe("8575.99");
  });

  it("never invents digits an exact value does not have", () => {
    expect(formatBalance(100, 2)).toBe("100");
    expect(formatBalance(0.5, 8)).toBe("0.5");
  });

  it("accepts strings, as the API sends them", () => {
    expect(formatBalance("8575.00168354", 2)).toBe("8575");
  });

  it("shows 0 rather than a rounded-up dust figure", () => {
    // 0.000000009 BTC is not 0.00000001 BTC of spendable balance.
    expect(formatBalance(0.000000009, 8)).toBe("0");
  });

  it("does not make a negative balance look smaller than it is", () => {
    expect(parseFloat(formatBalance(-0.030623265, 8))).toBeGreaterThanOrEqual(
      -0.030623265
    );
  });
});

describe("clean decimals survive the float-multiply error (regression)", () => {
  // Each of these rendered a whole unit of the last digit LOW before the fix,
  // because `value * 10**digits` carries IEEE-754 noise (0.29 * 100 =
  // 28.999999999999996) that a bare `Math.floor` then dropped.
  it("does not drop a unit at two decimals", () => {
    expect(formatBalance(0.29, 2)).toBe("0.29"); // was "0.28"
    expect(formatBalance(1.15, 2)).toBe("1.15"); // was "1.14"
    expect(formatBalance(2.01, 2)).toBe("2.01"); // was "2"
  });

  it("does not drop a unit at eight decimals", () => {
    expect(formatBalance(4.1, 8)).toBe("4.1"); // was "4.09999999"
    expect(formatBalance(2.3, 8)).toBe("2.3"); // was "2.29999999"
  });

  it("still truncates a genuine sub-precision remainder toward zero", () => {
    expect(formatBalance(0.286, 2)).toBe("0.28");
    expect(formatBalance(4.109999999, 8)).toBe("4.10999999");
  });
});

describe("edges", () => {
  it("falls back for unusable input", () => {
    expect(formatBalance(undefined, 8)).toBe("—");
    expect(formatBalance("abc", 8)).toBe("—");
    expect(formatBalance(null, 8, "0")).toBe("0");
  });

  it("treats a missing precision conservatively (8dp)", () => {
    expect(formatBalance(0.123456789)).toBe("0.12345678");
  });

  it("handles a zero balance", () => {
    expect(formatBalance(0, 8)).toBe("0");
  });
});
