/**
 * NO INVENTED TRADES IN THE SHIPPED BUNDLE.
 * =========================================
 *
 * `components/Futures/PositionHistoryNew.tsx` fetched real trade history into
 * `orderData` and then rendered a `<tbody>` of TWO HARDCODED ROWS:
 *
 *     BTC/USDT  Long   2.49 USDT   101,804.20 USDT ... 2025-02-26 16:20
 *     BTC/USDT  Short -0.09 USDT   101,804.20 USDT ... 2025-02-26 16:20
 *
 * on a venue that listed no USDT and whose futures settled in USDC. The
 * fetched rows were never rendered at all.
 *
 * The whole futures surface has since been removed from this frontend, so the
 * ORIGINAL offender cannot come back under that path. The guards below are kept
 * and generalised: the first two still pin that nothing named
 * PositionHistoryNew exists or is imported anywhere, and the last two are what
 * actually earn their keep now — no shipped component may contain those
 * invented figures, and no `<td>` in components/ or pages/ may paint a hardcoded
 * number. Those apply to the spot screens exactly as they applied to the
 * derivative ones.
 *
 * REACHABILITY, MEASURED RATHER THAN ASSUMED. Driving the real app at
 * :3000/futures/BTC_USDC with Playwright: the strings "101,804.20",
 * "100,500.12" and "Max. Open Interest" were all present in the DOM and all
 * `visible === false`. The component sat in a `<Tab.Pane eventKey="pos_his">`
 * whose `<Nav.Link>` was commented out in both HomePages, so nothing on screen
 * could activate it - but react-bootstrap renders inactive panes into the DOM,
 * so the invented rows shipped in the bundle and were injected into every
 * /futures page, one uncommented line away from being on screen.
 *
 * It was deleted rather than wired up: the "Position History" tab the user can
 * actually click is `close_position`, which renders `ClosePnL` from
 * `perpetual/closedPnL/{pairId}` with the same columns and real data. Keeping
 * `PositionHistoryNew` would have meant a second Closed-P&L reading the TRADE
 * history endpoint under a position-history heading.
 *
 * This is a source-level guard, deliberately: the point is that the strings are
 * not COMPILED IN, which a render test of one component cannot show.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SEARCH_DIRS = ["components", "pages"];
const SKIP_DIRS = new Set(["node_modules", ".next", "__tests__", "e2e"]);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (/\.(tsx|jsx)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
};

const FILES = SEARCH_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const rel = (p: string) => path.relative(ROOT, p);

/** JSX with `{/* ... *\/}` and block comments removed, so only live markup is searched. */
const liveJsx = (src: string) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the fabricated futures position-history table is gone", () => {
  test("the component file no longer exists", () => {
    expect(
      fs.existsSync(path.join(ROOT, "components/Futures/PositionHistoryNew.tsx"))
    ).toBe(false);
  });

  test("nothing imports or renders it", () => {
    const referring = FILES.filter((f) =>
      fs.readFileSync(f, "utf8").includes("PositionHistoryNew")
    );
    expect(referring.map(rel)).toEqual([]);
  });

  test("the dead tab key it lived behind is gone from every page", () => {
    const offenders = FILES.filter((f) =>
      fs.readFileSync(f, "utf8").includes("pos_his")
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  test("its invented numbers appear in no shipped component", () => {
    const needles = ["101,804.20", "100,500.12", "2025-02-26 16:20"];
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = liveJsx(fs.readFileSync(f, "utf8"));
      for (const n of needles) if (src.includes(n)) offenders.push(`${rel(f)} :: ${n}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("no other component paints a hardcoded numeric table cell", () => {
  test("every <td> either is empty, is a header word, or comes from an expression", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = liveJsx(fs.readFileSync(f, "utf8"));
      const re = /<td[^>]*>\s*([^<>{}\n]{1,80}?)\s*<\/td>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const text = m[1].trim();
        // A literal containing a digit is data. A literal that is only words
        // ("Total", "-") is a label and is fine.
        if (/\d/.test(text)) offenders.push(`${rel(f)} :: ${text}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
