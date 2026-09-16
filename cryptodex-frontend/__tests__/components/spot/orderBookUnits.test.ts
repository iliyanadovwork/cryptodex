/**
 * THE ORDER BOOK'S SIZE / TOTAL COLUMNS ARE DENOMINATED BY THE UNIT SELECTOR.
 *
 * A standard exchange book shows, per level, how much is resting (Size) and the
 * cumulative amount (Total), with the price in the QUOTE currency. Those two
 * columns can be read in either side of the pair, which is what the selector
 * beside the grouping dropdown switches:
 *
 *   base  (the DEFAULT) - item.quantity / item.cumulativeQuantity, base precision
 *   quote               - item.notional / item.cumulativeNotional, 2dp money
 *
 * The header's unit row follows the same selection. Nothing is a hardcoded coin
 * literal: every symbol is derived from the pair, and the selector renders
 * `unitSymbol`, which resolves to the base symbol until the user switches.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const strip = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const SPOT = "components/spot/OrderBook.tsx";

/** The unit row of the two-line column header (comments stripped). */
const unitRowOf = (file: string) => {
  const src = strip(read(file));
  const at = src.indexOf("ob_colhead_units");
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, at + 500);
};

describe("spot order book column units", () => {
  test("baseSymbol/baseDigits are derived from the pair's base coin", () => {
    const src = read(SPOT);
    expect(src).toMatch(/const baseSymbol\s*=\s*tradePair\?\.firstCurrencySymbol/);
    expect(src).toMatch(/const baseDigits\s*=/);
  });

  test("Size/Total units follow the selector and Price the quote symbol - all derived, not hardcoded", () => {
    const unit = unitRowOf(SPOT);
    // rendered from expressions, not literals
    expect(unit).toContain("{unitSymbol}");
    expect(unit).toContain("{tradePair?.secondCurrencySymbol}");
    // no hardcoded coin literal sitting as text in the unit cells
    expect(unit).not.toMatch(/>\s*(USD|USDT|BTC|ETH|SOL|BNB)\s*</);
  });

  test("unitSymbol defaults to the BASE coin, so the book still reads in base", () => {
    const src = read(SPOT);
    expect(src).toMatch(/useState<"base" \| "quote">\("base"\)/);
    expect(src).toMatch(
      /const unitSymbol\s*=\s*sizeUnit === "base" \? baseSymbol : quoteSymbol/
    );
  });

  test("the Size and Total CELLS render the selected unit at its own precision", () => {
    const src = read(SPOT);
    expect(src).toContain("formatQty(size, sizeDigits");
    expect(src).toContain("formatQty(cumSize, sizeDigits");
    // base -> quantity/cumulativeQuantity, quote -> notional/cumulativeNotional
    expect(src).toMatch(/sizeUnit === "base"\s*\?\s*item\.cumulativeQuantity/);
    expect(src).toMatch(/sizeUnit === "base" \? item\.quantity : item\.notional/);
    // and the quote side is money, not base precision
    expect(src).toMatch(/sizeDigits\s*=\s*sizeUnit === "base" \? baseDigits : 2/);
  });

  test("the unit selector is a real control, not a caret painted on a label", () => {
    const src = strip(read(SPOT));
    expect(src).toMatch(/data-testid="orderbook-unit-toggle"/);
    expect(src).toMatch(/onClick=\{\(\) =>\s*setSizeUnit/);
  });
});
