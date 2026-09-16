/**
 * THIS VENUE ADVERTISES NO FEES, BECAUSE IT CHARGES NONE.
 * ======================================================
 *
 * This file used to pin the OPPOSITE: that the ticket printed the pair's
 * `taker_fees` and `maker_rebate`, and specifically that it read those two
 * fields rather than the pair's `makerFee`/`takerFee`, which published 0.1%
 * against a charged 0.02% - five times the truth.
 *
 * Every fee was then withdrawn from the platform. spotapi's
 * lib/liquidityRole.feeRateFor returns 0 for every order in every role, so no
 * fill is charged anything, and a panel quoting a schedule would be advertising
 * something that is never applied.
 *
 * The file is kept, inverted, because a fee schedule is exactly the kind of
 * thing that creeps back into a trading UI: if any of these testids or labels
 * reappear, this goes red.
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** Source with comments stripped, so prose ABOUT the removal is not a match. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const TICKET_SURFACES = [
  "components/spot/OrderForm.tsx",
  "components/spot/LimitOrder.tsx",
  "components/spot/MarketOrder.tsx",
  "components/spot/TradeHistory.tsx",
];

describe("no fee is quoted anywhere in the trading UI", () => {
  it.each(TICKET_SURFACES)("%s renders no fee rate", (file) => {
    const src = code(file);
    for (const gone of [
      "spot-fee-rates",
      "spot-taker-rate",
      "spot-maker-rate",
      "taker_fees",
      "maker_rebate",
    ]) {
      expect([file, gone, src.includes(gone)]).toEqual([file, gone, false]);
    }
  });

  it("the ticket no longer carries a Fee heading", () => {
    const src = code("components/spot/OrderForm.tsx");
    expect(src).not.toMatch(/>\s*Fee\s*</);
    expect(src).not.toMatch(/Taker/);
    expect(src).not.toMatch(/Maker/);
  });

  it("the trade log has no Fee column", () => {
    const src = code("components/spot/TradeHistory.tsx");
    expect(src).not.toMatch(/<th>\s*Fee\s*<\/th>/);
    expect(src).not.toContain("item.fee");
  });
});
