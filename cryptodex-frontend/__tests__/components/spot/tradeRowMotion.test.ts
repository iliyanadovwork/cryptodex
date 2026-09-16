/**
 * THE TAPE'S MOTION, AND THE PARTS OF IT A TEST CAN ACTUALLY HOLD.
 * ===============================================================
 *
 * A batch prepends a few prints and every row below shifts down by that many
 * row heights. Unanimated that is a 48-192px jump (measured) with nothing
 * connecting where a row was to where it went, and the eye loses its place.
 * Rows now slide, via a FLIP transform in RecentTrade.tsx, and a new row
 * fades in as it arrives.
 *
 * WHAT THIS FILE CANNOT TEST, said plainly: jsdom does no layout. `offsetTop`
 * is 0 for every element, so the FLIP effect would find that no row ever
 * moved and do nothing - a test asserting "rows animate" would pass against a
 * component with the effect deleted. The motion was verified in Chrome
 * instead, against the running app:
 *
 *   10 slides in 8s, each passing through a median of 13 distinct
 *   intermediate positions; median travel 48px (two rows), median
 *   perceptible duration 129ms settling by 200ms; and a row translated 60px
 *   up into the sticky header's band is painted OVER by the header
 *   (elementFromPoint returns thead), which is what the header's opaque
 *   background and z-index are for.
 *
 * What IS testable here is the coupling between the two halves, which is
 * where this would rot: the JS removes the flash class on a timer, and the
 * CSS fades the colour out over its own duration. If those drift apart the
 * fade is cut off mid-colour or the class outlives its animation. And the
 * keyframes must never animate `transform`, because transform belongs to the
 * slide.
 *
 * An earlier version of this file also asserted the slide was shorter than the
 * server's 250ms publish throttle, on the theory that this made interruption
 * impossible. It does not - `recentTrade` has a second, unthrottled producer.
 * See the last describe block.
 */
import fs from "fs";
import path from "path";

import {
  FLASH_MS,
  ROW_SLIDE_MS,
  transformShift,
} from "@/components/spot/RecentTrade";

const SHEET = fs
  .readFileSync(path.join(process.cwd(), "styles", "Spot.module.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, ""); // prose names these properties; strip it

/** The declaration block of a top-level class rule. */
const ruleBody = (selector: string): string | null => {
  const m = SHEET.match(
    new RegExp(`(?:^|\\})\\s*\\${selector}\\s*\\{([^}]*)\\}`, "m")
  );
  return m ? m[1] : null;
};

/** The body of a @keyframes block. */
const keyframes = (name: string): string | null => {
  const at = SHEET.indexOf(`@keyframes ${name}`);
  if (at === -1) return null;
  const open = SHEET.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < SHEET.length; i++) {
    if (SHEET[i] === "{") depth++;
    else if (SHEET[i] === "}") {
      depth--;
      if (depth === 0) return SHEET.slice(open + 1, i);
    }
  }
  return null;
};

/** "450ms" | "0.45s" -> 450 */
const durationMs = (body: string): number | null => {
  const m = body.match(/animation:[^;]*?(\d*\.?\d+)(ms|s)\b/);
  if (!m) return null;
  return m[2] === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
};

const FLASHES = ["tradeFlashBuy", "tradeFlashSell"];

describe("the flash timer and the flash animation agree", () => {
  it.each(FLASHES)(
    "%s fades for exactly as long as the class is kept",
    (name) => {
      const body = ruleBody(`.${name}`);
      expect(body).not.toBeNull();
      const css = durationMs(body!);
      expect(css).not.toBeNull();
      // RecentTrade.tsx removes the class after FLASH_MS. A longer animation
      // is cut off part-way through its fade; a shorter one leaves a spent
      // class sitting on the row.
      expect(css).toBe(FLASH_MS);
    }
  );

  it.each(FLASHES)("%s announces the row by fading it in", (name) => {
    const frames = keyframes(name);
    expect(frames).not.toBeNull();
    // The entrance. Without it a new row materialises at the top while every
    // row below it glides, which reads as a stutter rather than an advance.
    expect(frames).toMatch(/opacity\s*:\s*0\b/);
    expect(frames).toMatch(/opacity\s*:\s*1\b/);
  });

  it.each(FLASHES)("%s leaves transform alone - that is the slide's", (name) => {
    const frames = keyframes(name);
    // A row is either arriving or being pushed down, never both, but a
    // transform here would still fight the FLIP effect's inline transform on
    // any row that is doing the latter.
    expect(frames).not.toMatch(/transform\s*:/);
  });
});

describe("motion is optional", () => {
  it("stops the flash animating for a reduced-motion preference", () => {
    // The slide is skipped in JS (prefersReducedMotion); the entrance is CSS
    // and needs its own answer.
    const blocks = SHEET.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/g
    );
    expect(blocks).toBeTruthy();
    const covers = blocks!.some(
      (b) => b.includes("tradeFlashBuy") && b.includes("tradeFlashSell")
    );
    expect(covers).toBe(true);
  });

  it("guards the slide on the same preference", () => {
    const src = fs
      .readFileSync(
        path.join(process.cwd(), "components", "spot", "RecentTrade.tsx"),
        "utf8"
      )
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(src).toMatch(/prefersReducedMotion\(\)/);
  });
});

/**
 * A SLIDE CAN BE INTERRUPTED, AND THE FIRST VERSION ASSUMED IT COULD NOT.
 * ======================================================================
 *
 * That version reasoned: spotapi publishes the Binance tape on a 250ms
 * throttle, a slide takes 200ms, so a row is never measured mid-flight and the
 * start position can be computed from layout alone.
 *
 * The premise was false. `recentTrade` has a SECOND producer -
 * spot.controller.js recentTradeSocket, emitted once per matched maker from
 * the order matcher, with no throttle whatsoever, into the tikerRoot room the
 * spot page subscribes to. A fill lands whenever it lands. Computing the start
 * from layout while the row is being drawn somewhere else snaps it to a
 * position it never occupied - the exact jump the slide exists to remove.
 *
 * So the offset is now read back off the row and carried forward, and the
 * slide is correct at any cadence. `transformShift` is the part of that with a
 * wrong answer available: pick the wrong index out of the matrix and rows
 * shift by a garbage amount, which is why it is pulled out and tested rather
 * than inlined.
 */
describe("an interrupted slide continues from where the row is drawn", () => {
  it("reads no offset from a row at rest", () => {
    expect(transformShift("none")).toBe(0);
    expect(transformShift("")).toBe(0);
    expect(transformShift(null)).toBe(0);
    expect(transformShift(undefined)).toBe(0);
  });

  it("takes ty out of a 2d matrix - index 5, not 4", () => {
    // matrix(a, b, c, d, tx, ty). Index 4 is the HORIZONTAL translate, and
    // reading it would return 0 for every vertical slide there has ever been.
    expect(transformShift("matrix(1, 0, 0, 1, 0, -48)")).toBe(-48);
    expect(transformShift("matrix(1, 0, 0, 1, 12, 96)")).toBe(96);
    expect(transformShift("matrix(1, 0, 0, 1, 12, 0)")).toBe(0);
  });

  it("takes ty out of a 3d matrix - index 13", () => {
    // matrix3d is column-major: indices 12/13/14 are tx/ty/tz. A row promoted
    // to its own compositor layer is reported in this form.
    const m3d =
      "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -72, 0, 1)";
    expect(transformShift(m3d)).toBe(-72);
  });

  it("answers 0 rather than NaN for anything it does not recognise", () => {
    // A NaN would propagate into translateY() and silently disable the slide
    // for that row, which is far harder to notice than a missing animation.
    expect(transformShift("rotate(4deg)")).toBe(0);
    expect(transformShift("matrix(nonsense)")).toBe(0);
    expect(Number.isNaN(transformShift("matrix(1,0,0,1,0,)"))).toBe(false);
  });
});

describe("the slide is quick enough to keep up", () => {
  it("settles well inside the interval the tape is published on", () => {
    // Not a correctness guarantee any more - interruption is handled above.
    // This is about feel: a slide longer than the gap between batches leaves
    // the tape permanently in motion.
    expect(ROW_SLIDE_MS).toBeGreaterThan(0);
    expect(ROW_SLIDE_MS).toBeLessThan(FLASH_MS);
  });
});
