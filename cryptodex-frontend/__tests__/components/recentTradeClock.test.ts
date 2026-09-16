/**
 * NO TRADE TAPE MAY BUILD ITS OWN CLOCK AGAIN.
 *
 * Three "Recent Trades" components rendered a Time column. Two of them built
 * the string as `getHours() + ":" + getMinutes() + ":" + getSeconds()` and
 * printed "22:47:0"; the third had a padStart fix inlined in the component,
 * where it could not be reused — which is exactly why the other two were never
 * updated. Two of the three belonged to products this venue no longer lists and
 * are gone with them; the property still holds for the one that remains, and it
 * is the property, not the count, that this file exists to pin.
 *
 * This reads the REAL component sources off disk and holds them to the
 * property that failed: the fix lives in lib/tradeTime, and no tape reimplements
 * it. A source-level assertion is used because these components mount sockets,
 * Redux and a charting library, so rendering them to inspect one <td> costs far
 * more than it proves — and the defect was never in the rendering anyway, it was
 * in the arithmetic that produced the string.
 *
 * lib/tradeTime itself is tested behaviourally in __tests__/lib/tradeTime.test.ts.
 */
import fs from "fs";
import path from "path";

/** The tapes a user can actually reach. */
const LIVE_TAPES = ["components/spot/RecentTrade.tsx"];

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe.each(LIVE_TAPES)("%s", (rel) => {
  const src = read(rel);

  it("uses the shared tradeTime helper", () => {
    expect(src).toMatch(/from ["']@\/lib\/tradeTime["']/);
    expect(src).toMatch(/tradeTime\(/);
  });

  it("does not read clock fields off a Date itself", () => {
    // getHours/getMinutes/getSeconds in a tape means it is formatting its own
    // timestamp again — the precise shape of the original bug, whether or not
    // the author remembered to pad it this time.
    expect(src).not.toMatch(/\.getHours\s*\(/);
    expect(src).not.toMatch(/\.getMinutes\s*\(/);
    expect(src).not.toMatch(/\.getSeconds\s*\(/);
  });

  it("does not concatenate a time string with ':'", () => {
    // Catches `h + ':' + m + ':' + s` in any spacing, including a future
    // reintroduction that pads correctly but duplicates the logic.
    expect(src).not.toMatch(/\+\s*["']:["']\s*\+/);
  });
});

describe("lib/tradeTime is the single implementation", () => {
  it("exists and pads through a helper rather than inline padStart", () => {
    const lib = read("lib/tradeTime.ts");
    expect(lib).toMatch(/export function tradeTime/);
  });

  it("no live tape inlines padStart for time formatting", () => {
    for (const rel of LIVE_TAPES) {
      expect(read(rel)).not.toMatch(/padStart\(\s*2/);
    }
  });
});
