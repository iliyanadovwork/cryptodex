/**
 * The trade tabs read "0 | undefinedundefined | Cryptodex Exchange" until the
 * price feed arrived. These hold the title to never printing a value it does
 * not have.
 */
import { tradePageTitle } from "@/lib/tradePageTitle";

const SITE = "Cryptodex Exchange";

describe("tradePageTitle — the loaded case", () => {
  it("prints price | pair | site once everything is known", () => {
    expect(tradePageTitle(64285, "BTC", "USDC", SITE)).toBe(
      "64285 | BTCUSDC | Cryptodex Exchange"
    );
  });

  it("accepts a numeric string price and prints it verbatim", () => {
    // The feed sends strings; the title must not reformat or round them.
    expect(tradePageTitle("64364.42", "BTC", "USD", SITE)).toBe(
      "64364.42 | BTCUSD | Cryptodex Exchange"
    );
  });

  it("trims symbol whitespace rather than baking it into the pair", () => {
    expect(tradePageTitle(1, " BTC ", " USD ", SITE)).toBe(
      "1 | BTCUSD | Cryptodex Exchange"
    );
  });
});

describe("tradePageTitle — never renders a value it does not have", () => {
  it("the exact measured regression: empty marketData", () => {
    // marketData starts {} and `marketData && marketData.markPrice` is
    // undefined, which interpolated to the literal "undefined".
    const title = tradePageTitle(undefined, undefined, undefined, SITE);
    expect(title).toBe("Cryptodex Exchange");
    expect(title).not.toContain("undefined");
  });

  it("a zero price is 'not yet', not a quote of zero", () => {
    expect(tradePageTitle(0, "BTC", "USD", SITE)).toBe(
      "BTCUSD | Cryptodex Exchange"
    );
  });

  it.each([
    ["null", null],
    ["NaN", NaN],
    ["empty string", ""],
    ["nonsense", "abc"],
    ["negative", -5],
  ])("drops a %s price but keeps the pair", (_label, price) => {
    const title = tradePageTitle(price as any, "BTC", "USD", SITE);
    expect(title).toBe("BTCUSD | Cryptodex Exchange");
    expect(title).not.toMatch(/undefined|null|NaN/);
  });

  it("drops a half-known pair rather than printing a fragment", () => {
    expect(tradePageTitle(100, "BTC", undefined, SITE)).toBe(
      "100 | Cryptodex Exchange"
    );
    expect(tradePageTitle(100, undefined, "USD", SITE)).toBe(
      "100 | Cryptodex Exchange"
    );
    expect(tradePageTitle(100, "BTC", "   ", SITE)).toBe(
      "100 | Cryptodex Exchange"
    );
  });

  it("never emits a leading, trailing or doubled separator", () => {
    for (const args of [
      [undefined, undefined, undefined, SITE],
      [0, "BTC", "USD", SITE],
      [100, undefined, undefined, SITE],
      [undefined, "BTC", "USD", SITE],
    ] as const) {
      const title = tradePageTitle(...(args as any));
      expect(title).not.toMatch(/^\s*\|/);
      expect(title).not.toMatch(/\|\s*$/);
      expect(title).not.toMatch(/\|\s*\|/);
    }
  });

  it("falls back to the pair alone when even the site name is missing", () => {
    expect(tradePageTitle(100, "BTC", "USD", undefined)).toBe("100 | BTCUSD");
    expect(tradePageTitle(undefined, undefined, undefined, undefined)).toBe("");
  });

  it("non-string symbols are dropped, never stringified", () => {
    // An object here used to render "[object Object]".
    expect(tradePageTitle(100, {} as any, [] as any, SITE)).toBe(
      "100 | Cryptodex Exchange"
    );
  });
});
