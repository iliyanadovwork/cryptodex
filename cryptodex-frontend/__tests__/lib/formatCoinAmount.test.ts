/**
 * PRECISION THAT ACTUALLY CONVEYS THE NUMBER.
 *
 * Reported: "open-position Unrealized P&L is shown to 4 decimal places of BTC,
 * so it reads '-0.0000 BTC' for the life of most positions."
 *
 * Four decimals of BTC is one step per ~$6.40. A $100 paper position moves in
 * cents, so the cell never left zero and could not be told apart from flat.
 */

import { formatCoinAmount } from "@/lib/numberFormat";

describe("the reported case", () => {
  it("THE BUG: a realistic small coin-denominated P&L is no longer -0.0000", () => {
    // $100 of BTCUSD, entry 64000, mark 63900:
    //   (1/64000 - 1/63900) * 100 = -2.445e-5 BTC
    const pnl = (1 / 64000 - 1 / 63900) * 100;
    expect(pnl.toFixed(4)).toBe("-0.0000"); // what the screen used to print
    const shown = formatCoinAmount(pnl);
    expect(shown).not.toMatch(/^-?0\.0+$/);
    // Within a satoshi of the truth, and carrying real information rather than
    // a rounded-away zero.
    expect(Math.abs(parseFloat(shown) - pnl)).toBeLessThan(1e-8);
    expect(parseFloat(shown)).toBeLessThan(0);
  });

  it("moves when the position moves", () => {
    const at = (mark: number) => formatCoinAmount((1 / 64000 - 1 / mark) * 100);
    expect(at(63900)).not.toBe(at(63800));
    expect(at(63900)).not.toBe(at(64100));
  });

  it("keeps the sign", () => {
    expect(formatCoinAmount(-0.00001563).startsWith("-")).toBe(true);
    expect(formatCoinAmount(0.00001563).startsWith("-")).toBe(false);
  });
});

describe("across magnitudes", () => {
  it("stays short for values above 1", () => {
    expect(formatCoinAmount(12.3456789)).toBe("12.35");
    expect(formatCoinAmount(1234.5)).toBe("1234.5");
  });

  it("widens for small values until four significant digits show", () => {
    expect(formatCoinAmount(0.00001563)).toBe("0.00001563");
    expect(formatCoinAmount(0.1234567)).toBe("0.1235");
  });

  it("never exceeds the satoshi floor", () => {
    const shown = formatCoinAmount(0.0000000012345);
    const decimals = (shown.split(".")[1] || "").length;
    expect(decimals).toBeLessThanOrEqual(8);
  });

  it("trims padding rather than printing eight zeros", () => {
    expect(formatCoinAmount(0.5)).toBe("0.5");
    expect(formatCoinAmount(2)).toBe("2");
  });

  it("never uses exponent notation", () => {
    [1e-7, 1e-8, 1.2e-6, 5e-5].forEach((v) =>
      expect(formatCoinAmount(v)).not.toMatch(/e/i)
    );
  });
});

describe("edges", () => {
  it("a true zero is '0', not a smear of decimals", () => {
    expect(formatCoinAmount(0)).toBe("0");
    expect(formatCoinAmount(-0)).toBe("0");
  });

  it("falls back for values that are not numbers", () => {
    expect(formatCoinAmount(undefined)).toBe("—");
    expect(formatCoinAmount(null)).toBe("—");
    expect(formatCoinAmount("abc")).toBe("—");
    expect(formatCoinAmount(NaN, { fallback: "n/a" })).toBe("n/a");
  });

  it("accepts strings", () => {
    expect(formatCoinAmount("0.00001563")).toBe("0.00001563");
  });

  it("honours an explicit precision window", () => {
    expect(formatCoinAmount(0.00001563, { maxPrecision: 4 })).toBe("0");
    expect(formatCoinAmount(1.5, { minPrecision: 0 })).toBe("1.5");
  });
});
