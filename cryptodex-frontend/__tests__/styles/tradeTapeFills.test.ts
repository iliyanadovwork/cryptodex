/**
 * THE TRADE TAPE FILLS ITS PANEL, AND ITS ROWS STAY REACHABLE.
 * ============================================================
 *
 * `.market_pair_info .table_box` was `height: 336px; overflow: hidden` inside a
 * parent that is `height: 100%`. Measured in Chrome on the running app:
 *
 *   - 336px at a 24px row height shows ~13 rows;
 *   - the panel is 570px, so 234px below the tape was dead space that NO
 *     number of rows could fill - forcing 60 rows into the live DOM grew the
 *     table to 1460px while the box stayed 336px and the dead band stayed
 *     exactly 234px;
 *   - `overflow: hidden` (not `auto`) left the other ~47 rows rendered,
 *     invisible and unreachable - a wheel over the tape scrolled the page.
 *
 * Jest maps `*.module.css` to identity-obj-proxy, so a rendering test cannot
 * see a single declaration; the file itself is where the truth lives. This
 * reads the real stylesheet and holds the declarations to the shape that fixed
 * it. After the fix, the same measurement gives a 570px box, 5px of remaining
 * space (the parent's own padding-bottom) and a reachable scroll range.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not incidental: the rules below are
 * documented with prose that quotes the very declarations being asserted
 * absent ("this was `height: 336px`"). Matching raw text would find the
 * explanation and report the defect.
 */
import fs from "fs";
import path from "path";

const CSS = fs.readFileSync(
  path.join(process.cwd(), "styles", "Spot.module.css"),
  "utf8"
);

/** Strip comments so prose about a declaration is never read as one. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const SHEET = stripComments(CSS);

/**
 * Bodies of every rule with this exact selector, at a chosen nesting level.
 *
 * Depth matters here and a naive text search gets it wrong: the first @media
 * in this sheet opens at line 742, well ABOVE the base rule at 1410, so
 * "everything after the first @media" sweeps the base rule in with the
 * breakpoint copies. This tracks braces instead, so `depth === 0` is the base
 * rule and `depth > 0` is a rule inside an at-rule.
 */
const rules = (selector: string, nested: boolean): string[] => {
  const out: string[] = [];
  let depth = 0;
  let headStart = 0;
  for (let i = 0; i < SHEET.length; i++) {
    const ch = SHEET[i];
    if (ch === "{") {
      const head = SHEET.slice(headStart, i).trim();
      if (head === selector && (nested ? depth > 0 : depth === 0)) {
        let d = 1;
        let j = i + 1;
        while (j < SHEET.length && d > 0) {
          if (SHEET[j] === "{") d++;
          else if (SHEET[j] === "}") d--;
          j++;
        }
        out.push(SHEET.slice(i + 1, j - 1));
      }
      depth++;
      headStart = i + 1;
    } else if (ch === "}") {
      depth--;
      headStart = i + 1;
    } else if (ch === ";") {
      headStart = i + 1;
    }
  }
  return out;
};

/** The single base (unnested) rule for a selector. */
const topLevelRule = (selector: string): string | null =>
  rules(selector, false)[0] ?? null;

const decl = (body: string, prop: string): string | null => {
  const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;}]+)`, "i"));
  return m ? m[1].trim() : null;
};

describe("the Recent Trades panel fills the space it is given", () => {
  it("does not pin the tape to a fixed height at desktop width", () => {
    const body = topLevelRule(".market_pair_info .table_box");
    expect(body).not.toBeNull();
    // The defect, exactly: a definite height inside a height:100% parent.
    expect(decl(body!, "height")).toBeNull();
  });

  it("grows to fill its parent instead", () => {
    const body = topLevelRule(".market_pair_info .table_box")!;
    const flex = decl(body, "flex");
    expect(flex).toBeTruthy();
    // flex-grow is the first component; it must be non-zero or the box sits
    // at its content height and the dead band comes back.
    expect(parseFloat(flex!.split(/\s+/)[0])).toBeGreaterThan(0);
    // Without min-height:0 a flex item refuses to shrink below its content,
    // so the box would push past the panel rather than scroll inside it.
    expect(decl(body, "min-height")).toBe("0");
  });

  it("lets the rows past the fold be reached", () => {
    const body = topLevelRule(".market_pair_info .table_box")!;
    const overflow = decl(body, "overflow-y") ?? decl(body, "overflow");
    expect(overflow).toBe("auto");
    expect(overflow).not.toBe("hidden");
  });

  it("keeps the column headings visible while the tape scrolls", () => {
    const body = topLevelRule(".market_pair_info .table_box thead th");
    expect(body).not.toBeNull();
    expect(decl(body!, "position")).toBe("sticky");
    expect(decl(body!, "top")).toBe("0");
    // The rows pass directly under it; a transparent header shows them through.
    const bg = decl(body!, "background") ?? decl(body!, "background-color");
    expect(bg).toBeTruthy();
    expect(bg).not.toMatch(/transparent|none/i);
  });

  it("makes the ancestors a flex column, or the tape has nothing to fill", () => {
    const info = topLevelRule(".market_pair_info")!;
    expect(decl(info, "display")).toBe("flex");
    expect(decl(info, "flex-direction")).toBe("column");
    expect(decl(info, "min-height")).toBe("0");
  });

  it("gives the Trades tab host the fill its sibling already had", () => {
    // .orderbook_wrap_inner carries `flex: 1 1 0%` and fills the panel with no
    // dead space. .ob_trades_host declared only `padding: 0`, so it computed
    // `flex: 0 1 auto` and sat at its content height.
    const host = topLevelRule(".ob_trades_host");
    expect(host).not.toBeNull();
    const flex = decl(host!, "flex");
    expect(flex).toBeTruthy();
    expect(parseFloat(flex!.split(/\s+/)[0])).toBeGreaterThan(0);
    expect(decl(host!, "min-height")).toBe("0");
  });

  it("keeps a definite height at the breakpoints, and stops flex fighting it", () => {
    // Below 1200px this panel sits inside a fixed-height <Scrollbars>, where
    // flex:1 has no definite parent height to resolve against - so those copies
    // SHOULD keep a height, and must neutralise the base rule's flex to do it.
    const overrides = rules(".market_pair_info .table_box", true);
    expect(overrides.length).toBeGreaterThanOrEqual(2);
    for (const body of overrides) {
      expect(body).toMatch(/height\s*:\s*\d+px/);
      expect(body).toMatch(/flex\s*:\s*none/);
    }
  });
});
