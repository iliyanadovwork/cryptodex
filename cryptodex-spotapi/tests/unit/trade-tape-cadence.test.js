/**
 * THE TRADE TAPE IS PUBLISHED ON A CLOCK, NOT WHEN THE MARKET GOES QUIET.
 * ======================================================================
 *
 * `handleTradeUpdate` used to clear the pending flush timer on every arriving
 * print and set a new 500ms one. That is a trailing DEBOUNCE with no maxWait,
 * and it inverts the cadence: the emit fires only after the upstream feed has
 * been SILENT for a full 500ms, so the busier the market, the staler the tape.
 *
 * Measured against the live BTCUSDT feed before the fix:
 *
 *   upstream @trade          37.7 prints/sec
 *   emits                    0.65/sec, worst gap 7.2 SECONDS
 *   delivered                5.2/sec
 *   dropped, never emitted   86%          (a 20-slot buffer, shift()ed)
 *
 * And after, on @aggTrade with a 250ms throttle and a 60-slot buffer:
 *
 *   upstream @aggTrade       10.8/sec
 *   emits                    1.92/sec, worst gap 1.8s
 *   dropped                  0%
 *
 * This module opens live WebSockets at import time, so it cannot be require()d
 * in a unit test. These assertions read the source instead. Comments are
 * stripped FIRST - the code is documented with prose that names `clearTimeout`
 * and `debounce` precisely because they were removed, and matching raw text
 * would find the explanation and pass while the defect sat next to it.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

/** Strip block and line comments so prose is never read as code. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const WS = stripComments(
  fs.readFileSync(path.join(ROOT, "lib", "binanceWebSocket.js"), "utf8")
);
const CTRL = stripComments(
  fs.readFileSync(path.join(ROOT, "controllers", "binance.controller.js"), "utf8")
);

/** The body of a top-level `const name = (...) => {...}` or `function name`. */
const fnBody = (src, name) => {
  const start = src.search(
    new RegExp(`(const\\s+${name}\\s*=|function\\s+${name}\\s*\\()`)
  );
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
};

describe("the trade flush is a throttle, not a debounce", () => {
  it("does not cancel the pending flush when a print arrives", () => {
    const body = fnBody(WS, "handleTradeUpdate");
    expect(body).not.toBeNull();
    // The debounce signature. Its presence means the emit waits for a lull.
    expect(body).not.toMatch(/clearTimeout/);
  });

  it("schedules a flush only when one is not already pending", () => {
    const body = fnBody(WS, "handleTradeUpdate");
    // The throttle: the first print after a flush arms the timer, and every
    // print until it fires rides along with it.
    expect(body).toMatch(/if\s*\(\s*!\s*tradeTimers\.has\(/);
    expect(body).toMatch(/setTimeout\(/);
  });

  it("publishes at least four times a second", () => {
    const m = WS.match(/const\s+TRADE_FLUSH_MS\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    const ms = Number(m[1]);
    expect(ms).toBeGreaterThan(0);
    // An upper bound on staleness. 500ms was the debounce's nominal wait and
    // it never once achieved it; a real interval should be well inside that.
    expect(ms).toBeLessThanOrEqual(250);
    // ...and the constant must actually BE the delay. Reading only the
    // declaration lets a literal at the call site pass unnoticed: substituting
    // `setTimeout(..., 500)` there leaves every assertion here green while the
    // tape publishes on exactly the interval this file exists to rule out.
    expect(WS).toMatch(
      /setTimeout\(\s*\(\)\s*=>\s*flushTradeBuffer\(pairId,\s*pairName\),\s*TRADE_FLUSH_MS\s*\)/
    );
  });

  it("buffers deep enough to never drop what the panel could show", () => {
    const m = WS.match(/const\s+TRADE_BUFFER_MAX\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    // The client's MAX_TRADE_ROWS is 60. A shallower buffer discards prints
    // that the tape had room for - the old 20 dropped 86% of them.
    expect(Number(m[1])).toBeGreaterThanOrEqual(60);
    expect(WS).toMatch(/buffer\.length\s*>\s*TRADE_BUFFER_MAX/);
  });

  /**
   * The subtle one. Under a debounce, an early return that skipped
   * `tradeTimers.delete` was harmless - the next print overwrote the slot
   * anyway. Under a throttle the slot IS the "flush already pending" flag, so
   * leaving it set on the empty-buffer path strands it forever and the pair
   * stops publishing for the life of the process.
   */
  it("releases the timer slot before the empty-buffer early return", () => {
    const body = fnBody(WS, "flushTradeBuffer");
    expect(body).not.toBeNull();
    const release = body.search(/tradeTimers\.delete\(/);
    const earlyReturn = body.search(/length\s*===\s*0\s*\)\s*return/);
    expect(release).toBeGreaterThanOrEqual(0);
    expect(earlyReturn).toBeGreaterThanOrEqual(0);
    expect(release).toBeLessThan(earlyReturn);
  });
});

describe("the tape carries aggregated trades, each with an identity", () => {
  it("subscribes to @aggTrade, not the raw per-fill stream", () => {
    // @trade emits one message per FILL, so one taker order sweeping several
    // makers prints a row per maker - identical in time, price, size and side.
    expect(WS).toMatch(/@aggTrade/);
    expect(WS).not.toMatch(/\$\{binanceSymbol\.toLowerCase\(\)\}@trade`/);
  });

  it("accepts the aggregated event name", () => {
    expect(WS).toMatch(/message\.e\s*===\s*['"]aggTrade['"]/);
  });

  it("fetches the aggregated REST window to seed it", () => {
    expect(CTRL).toMatch(/api\/v3\/aggTrades/);
    expect(CTRL).not.toMatch(/api\/v3\/trades/);
  });

  /**
   * Without an id the client's dedupe key falls back to
   * `createdAt|tradePrice|tradeQty|Type`, which the fills of one sweep share.
   * Measured: a 50-print REST window rendered as 18 rows, and one key was
   * shared by 20 separate fills.
   */
  it("carries a trade id on both feeds, so distinct prints stay distinct", () => {
    expect(fnBody(WS, "handleTradeUpdate")).toMatch(/_id\s*:/);
    expect(CTRL).toMatch(/_id\s*:\s*el\.a/);
  });

  it("reads the aggTrades field names, which differ from trades", () => {
    // aggTrades uses a/p/q/T/m where trades used id/price/qty/time/isBuyerMaker.
    // Reading the old names against the new endpoint yields NaN prices.
    expect(CTRL).toMatch(/createdAt\s*:\s*new Date\(el\.T\)/);
    expect(CTRL).toMatch(/tradePrice\s*:\s*parseFloat\(el\.p\)/);
    expect(CTRL).toMatch(/tradeQty\s*:\s*parseFloat\(el\.q\)/);
    expect(CTRL).toMatch(/Type\s*:\s*el\.m\s*\?/);
  });
});
