// The global jest.setup.js mocks @/lib/roundOf with a simplified stub (it rounds
// via toFixed). This suite must exercise the REAL implementation that ships, so
// it pulls the actual module (which also runs the Number.prototype patch).
const { toFixedDown, priceFixed } = jest.requireActual("@/lib/roundOf") as typeof import("@/lib/roundOf");

// Regression tests for the money-truncation defect class: a helper that silently
// returns a DIFFERENT number (sign flipped / exponent dropped / Infinity handed
// back whole) rather than the truncated value it was asked for.
describe("priceFixed (real impl) — the precision ladder covers every value", () => {
  // The ladder used `item > 1 && item < 50`, so exactly 1.0 - a pegged/stable
  // pair at par - matched no band and the function returned undefined.
  test("a value sitting exactly at 1 returns a defined string, not undefined", () => {
    expect(priceFixed(1)).toBeDefined();
    expect(typeof priceFixed(1)).toBe("string");
    expect(priceFixed(1)).toBe("1.000");
  });

  test("the bands around 1 are unchanged", () => {
    expect(priceFixed(49.9)).toBe("49.900");
    expect(priceFixed(50)).toBe("50.00");
    expect(priceFixed(0.5)).toBeDefined();
  });
});

describe("toFixedDown (real impl) — truncation must not change the number", () => {
  test("truncates toward zero at the requested precision", () => {
    expect(toFixedDown(1.239, 2)).toBe(1.23);
    expect(toFixedDown(63499.999, 2)).toBe(63499.99);
  });

  test("PRESERVES the sign of a negative (the 24H-change regression)", () => {
    expect(toFixedDown(-1.234, 2)).toBe(-1.23);
    expect(toFixedDown(-0.019, 2)).toBe(-0.01);
  });

  test("a negative with fewer decimals than the precision is unchanged", () => {
    expect(toFixedDown(-0.5, 1)).toBe(-0.5);
  });

  test("reads exponent notation instead of returning it untruncated", () => {
    expect(toFixedDown(0.000000109, 8)).toBeCloseTo(0.0000001, 12);
    expect(toFixedDown(5e-8, 8)).toBeCloseTo(5e-8, 12);
  });

  test("Infinity/NaN/empty return '' rather than a fabricated number", () => {
    expect(toFixedDown(Infinity, 2)).toBe("");
    expect(toFixedDown(-Infinity, 2)).toBe("");
    expect(toFixedDown(NaN, 2)).toBe("");
    expect(toFixedDown("", 2)).toBe("");
  });
});

describe("Number.prototype.toFixedNoRounding (real impl) — exponent handling", () => {
  test("de-exponents a small magnitude instead of dropping the exponent", () => {
    // was the bug: 5e-8 returned "5.00000000" (~1e8 too large)
    expect((5e-8).toFixedNoRounding(8)).toBe("0.00000005");
  });
  test("plain values are unchanged", () => {
    expect((1.23456).toFixedNoRounding(2)).toBe("1.23");
  });
});
