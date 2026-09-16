/**
 * THE TRADE LOG MUST NOT GROW FOR EVER.
 * =====================================
 *
 * THE DEFECT. The socket handler removed exactly ONE row (`data.pop()`) and then
 * prepended the WHOLE incoming batch, so the list grew by (batch - 1) on every
 * message and nothing ever trimmed it. Both server emitters send more than one
 * row: the Binance trade buffer flushes up to 20 on a 500ms debounce, and
 * `recentTradeSocket` republishes the entire top-25 window on every fill - which
 * also means most of each batch is rows the list already holds.
 *
 * Left open, the table passed 10,000 rows within an hour. Every row is rendered,
 * so the cost of each message grew with the list: the page got progressively
 * less responsive, held more memory, and was slowest right after a spell in the
 * background, where messages had been accumulating unseen.
 */
import {
  mergeTrades,
  tradeKey,
  newestTrade,
  MAX_TRADE_ROWS,
} from "@/components/spot/RecentTrade";

const trade = (id: number, over: any = {}) => ({
  _id: `t${id}`,
  createdAt: 1700000000000 + id * 1000,
  tradePrice: 100 + id,
  tradeQty: 1,
  Type: "buy",
  ...over,
});

describe("the recent-trade log", () => {
  it("never grows past the cap, however many batches arrive", () => {
    let list: any[] = [];
    // 200 messages of 20 trades each: 4,000 rows offered.
    for (let batch = 0; batch < 200; batch++) {
      const incoming = Array.from({ length: 20 }, (_, i) => trade(batch * 20 + i));
      list = mergeTrades(incoming, list);
      expect(list.length).toBeLessThanOrEqual(MAX_TRADE_ROWS);
    }
    expect(list.length).toBe(MAX_TRADE_ROWS);
  });

  it("keeps the newest trades and drops the oldest", () => {
    const older = [trade(1), trade(2)];
    const newer = [trade(99)];
    const merged = mergeTrades(newer, older);
    expect(merged[0]._id).toBe("t99");
    // WAS ["t99","t1","t2"] - arrival order, incoming batch then the rest. In
    // this fixture a higher id is a LATER trade, so t2 is newer than t1 and
    // belongs above it. The old expectation encoded the defect: the list only
    // looked sorted while batches happened to arrive in order.
    expect(merged.map((t) => t._id)).toEqual(["t99", "t2", "t1"]);
  });

  it("drops duplicates, because the server republishes its whole window", () => {
    const existing = [trade(1), trade(2), trade(3)];
    // A fill re-sends the same top-of-window rows plus one new trade.
    const republished = [trade(4), trade(1), trade(2), trade(3)];
    const merged = mergeTrades(republished, existing);
    // Newest first: t4, then t3, t2, t1 by their timestamps - not the order
    // the republished batch happened to list them in.
    expect(merged.map((t) => t._id)).toEqual(["t4", "t3", "t2", "t1"]);
  });

  it("survives a batch that is entirely duplicates without growing", () => {
    const existing = [trade(1), trade(2)];
    const merged = mergeTrades([trade(1), trade(2)], existing);
    expect(merged.length).toBe(2);
  });

  it("identifies a trade stably, never by its position", () => {
    // The row key used to embed the array index, so prepending shifted every
    // index, changed every key, and made React rebuild the whole table.
    const t = trade(7);
    expect(tradeKey(t)).toBe(tradeKey({ ...t }));
    expect(tradeKey(t)).not.toContain("undefined");
    // Two distinct trades never collide.
    expect(tradeKey(trade(7))).not.toBe(tradeKey(trade(8)));
  });

  it("still identifies a trade with no _id", () => {
    const a = { createdAt: 1, tradePrice: 10, tradeQty: 2, Type: "sell" };
    const b = { createdAt: 1, tradePrice: 10, tradeQty: 3, Type: "sell" };
    expect(tradeKey(a)).toBe(tradeKey({ ...a }));
    expect(tradeKey(a)).not.toBe(tradeKey(b));
  });

  it("tolerates missing or malformed payloads", () => {
    expect(mergeTrades(undefined as any, [])).toEqual([]);
    expect(mergeTrades([], undefined as any)).toEqual([]);
    expect(mergeTrades([null as any, trade(1)], [])).toHaveLength(1);
  });
});

describe("the tape is in time order, which is the whole point of a tape", () => {
  const at = (iso: string, price = 1, qty = 1) => ({
    createdAt: iso,
    tradePrice: price,
    tradeQty: qty,
    Type: "buy",
  });

  it("puts a late batch of OLDER prints below newer rows already held", () => {
    // Captured from the running app before the fix: 18:52:21, 18:52:24,
    // 18:52:25, 18:52:22, 18:52:23 - four jumps backwards. Two emitters feed
    // this list, so a batch can arrive carrying prints older than rows already
    // on screen.
    const held = [at("2026-08-25T18:52:25.000Z"), at("2026-08-25T18:52:24.000Z")];
    const late = [at("2026-08-25T18:52:22.000Z"), at("2026-08-25T18:52:23.000Z")];

    const merged = mergeTrades(late, held);
    const times = merged.map((t: any) => t.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(times[0]).toBe("2026-08-25T18:52:25.000Z");
  });

  it("keeps arrival order within one timestamp, because a batch shares one", () => {
    // A batch stamps many prints with the same millisecond; within it, the
    // order they arrived in is the only ordering information there is.
    const batch = [
      at("2026-08-25T18:52:30.000Z", 100),
      at("2026-08-25T18:52:30.000Z", 200),
      at("2026-08-25T18:52:30.000Z", 300),
    ];
    expect(mergeTrades(batch, []).map((t: any) => t.tradePrice)).toEqual([100, 200, 300]);
  });

  it("caps to the NEWEST rows, not the first ones it happened to see", () => {
    // The cap used to break out of the loop in arrival order, so a late batch
    // of older trades could fill the list and push newer rows off the end.
    const old = Array.from({ length: MAX_TRADE_ROWS }, (_, i) =>
      at(`2026-08-25T18:00:${String(i).padStart(2, "0")}.000Z`, i)
    );
    const newest = at("2026-08-25T19:00:00.000Z", 999);

    const merged = mergeTrades(old, [newest]);
    expect(merged).toHaveLength(MAX_TRADE_ROWS);
    expect(merged[0].createdAt).toBe("2026-08-25T19:00:00.000Z");
  });

  it("survives a row with no timestamp rather than throwing", () => {
    const merged = mergeTrades(
      [{ tradePrice: 1, tradeQty: 1 }, at("2026-08-25T18:52:25.000Z")],
      []
    );
    expect(merged).toHaveLength(2);
    expect(merged[0].createdAt).toBe("2026-08-25T18:52:25.000Z");
  });
});

/**
 * THE SWEEP: SEVERAL FILLS THAT DIFFER ONLY BY ID.
 * ================================================
 *
 * One aggressive order crossing several resting makers at the same price
 * prints several separate trades stamped with the SAME millisecond, price,
 * size and side. They are distinct fills and the tape must show all of them.
 *
 * The dedupe key falls back to `createdAt|tradePrice|tradeQty|Type` when a row
 * carries no `_id`, and both feed mappers used to discard Binance's per-trade
 * id - so every sweep collapsed to one row. Measured against the running API:
 * a 50-print REST window rendered as 18 rows, losing 64% of the tape. The
 * mappers now carry the id (binanceWebSocket.js handleTradeUpdate,
 * binance.controller.js recentTrade), and this holds them to it.
 */
describe("trades that differ only by id", () => {
  /** Five fills of one sweep: identical in every field Binance sends but the id. */
  const sweep = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      _id: 900 + i,
      createdAt: 1700000000000,
      tradePrice: 79151.99,
      tradeQty: 0.00007,
      Type: "sell",
    }));

  it("keeps every fill of a sweep, not just one", () => {
    const merged = mergeTrades(sweep(5), []);
    expect(merged).toHaveLength(5);
    expect(new Set(merged.map((t: any) => t._id)).size).toBe(5);
  });

  it("collapses the sweep if the id is dropped - the defect this guards", () => {
    // Same rows with `_id` stripped: the key falls back to the composite and
    // all five become one. This is what the feed used to send.
    const idless = sweep(5).map(({ _id, ...rest }: any) => rest);
    expect(mergeTrades(idless, [])).toHaveLength(1);
  });

  it("still dedupes a genuine repeat of the same trade", () => {
    const one = sweep(1);
    expect(mergeTrades(one, one)).toHaveLength(1);
  });

  it("dedupes one trade across BOTH feeds, whose timestamp types differ", () => {
    // The REST mapper sends `new Date(...)` (an ISO string on the wire); the
    // socket mapper sends epoch ms. Same trade, same id, so it is one row.
    const ms = 1700000000000;
    const viaSocket = { _id: 42, createdAt: ms, tradePrice: 79151.99, tradeQty: 0.00007, Type: "sell" };
    const viaRest = { ...viaSocket, createdAt: new Date(ms).toISOString() };
    expect(mergeTrades([viaSocket], [viaRest])).toHaveLength(1);
  });

  it("orders a sweep against later prints by time, not by id", () => {
    const later = { _id: 999, createdAt: 1700000005000, tradePrice: 80000, tradeQty: 1, Type: "buy" };
    const merged = mergeTrades(sweep(3), [later]);
    expect(merged[0]._id).toBe(999);
    expect(merged).toHaveLength(4);
  });
});

/**
 * THE TWO FEEDS STAMP TIME AS DIFFERENT TYPES, AND BOTH LAND IN THIS LIST.
 * =======================================================================
 *
 * The REST seed builds `new Date(...)`, which crosses the wire as an ISO-8601
 * STRING. The socket passes Binance's `T` through, as epoch MILLISECONDS.
 *
 * Every other ordering test in this file uses ONE type throughout, so a
 * comparator that compares the values as TEXT passes all of them. It would
 * not merely misorder the tape: "2026-..." beats "1787..." for every ISO row
 * against every epoch row, so the REST seed pins itself above every live
 * print - and because the seed is exactly MAX_TRADE_ROWS, the live prints are
 * sliced off entirely and the tape freezes at first paint.
 *
 * These are the assertions that fail against a text comparator.
 */
describe("ordering across the two timestamp types", () => {
  const BASE = 1700000000000;
  const iso = (id: string, ms: number) => ({
    _id: id,
    createdAt: new Date(ms).toISOString(),
    tradePrice: 1,
    tradeQty: 1,
    Type: "buy",
  });
  const epoch = (id: string, ms: number) => ({
    _id: id,
    createdAt: ms,
    tradePrice: 2,
    tradeQty: 1,
    Type: "buy",
  });

  it("puts the genuinely newer row first, whichever type carries it", () => {
    const older = iso("rest", BASE);
    const newer = epoch("sock", BASE + 60_000);
    expect(mergeTrades([newer], [older])[0]._id).toBe("sock");
    // Both directions, so this cannot be satisfied by arrival order.
    expect(mergeTrades([older], [newer])[0]._id).toBe("sock");
  });

  it("puts an ISO row first when IT is the newer one", () => {
    const older = epoch("sock", BASE);
    const newer = iso("rest", BASE + 60_000);
    expect(mergeTrades([older], [newer])[0]._id).toBe("rest");
  });

  it("does not let a full ISO seed bury every live print", () => {
    // A REST snapshot of exactly the cap, then live prints arriving after it.
    const seed = Array.from({ length: MAX_TRADE_ROWS }, (_, i) =>
      iso(`seed${i}`, BASE + i)
    );
    const live = Array.from({ length: 5 }, (_, i) =>
      epoch(`live${i}`, BASE + 10_000 + i)
    );
    const merged = mergeTrades(live, seed);
    expect(merged.slice(0, 5).map((t: any) => t._id)).toEqual([
      "live4",
      "live3",
      "live2",
      "live1",
      "live0",
    ]);
    // The failure this guards is total, not partial: under a text comparator
    // not one live print survives the slice.
    expect(merged.filter((t: any) => t._id.startsWith("live"))).toHaveLength(5);
  });
});

/**
 * THE HEADLINE PRICE AND THE ROW BESIDE IT ARE THE SAME PRINT.
 * ===========================================================
 *
 * publishLastTrade feeds spot.lastTrade, which is the large price at the top
 * of the trade page. It used to read `trades[0]` on the strength of a comment
 * claiming the batch was newest-first. Both feeds are the reverse - the socket
 * buffer is built with push(), Binance's aggTrades returns ascending - so
 * element 0 is the OLDEST print of the window.
 *
 * It stayed invisible while the tape was in arrival order, because then the
 * top row WAS element 0 and the two agreed, both wrong together. Sorting the
 * tape corrected the row and left the headline reading the oldest print:
 * measured $10 apart on a live 60-row batch, $11 on the REST seed.
 */
describe("the price published from a batch", () => {
  const at = (ms: number, price: number) => ({
    _id: `t${ms}`,
    createdAt: ms,
    tradePrice: price,
    tradeQty: 1,
    Type: "buy",
  });

  it("takes the newest print from an oldest-first batch", () => {
    // The shape both feeds actually send.
    const batch = [at(1000, 79272), at(2000, 79265), at(3000, 79262)];
    expect(newestTrade(batch).tradePrice).toBe(79262);
    // The defect, named: element 0 is the oldest and must not win.
    expect(newestTrade(batch).tradePrice).not.toBe(batch[0].tradePrice);
  });

  it("takes the newest print from a newest-first batch too", () => {
    // Order is a property of the feed; this must not depend on it.
    const batch = [at(3000, 79262), at(2000, 79265), at(1000, 79272)];
    expect(newestTrade(batch).tradePrice).toBe(79262);
  });

  it("agrees with the row the tape puts at the top", () => {
    // The invariant that matters on screen: one print, two places.
    const batch = [at(1000, 79272), at(2000, 79265), at(3000, 79262)];
    expect(newestTrade(batch)._id).toBe(mergeTrades(batch, [])[0]._id);
  });

  it("compares across the two timestamp types", () => {
    const ms = 1700000000000;
    const isoOlder = {
      _id: "rest",
      createdAt: new Date(ms).toISOString(),
      tradePrice: 1,
      tradeQty: 1,
      Type: "buy",
    };
    const epochNewer = at(ms + 5000, 2);
    expect(newestTrade([isoOlder, epochNewer])._id).toBe(epochNewer._id);
    expect(newestTrade([epochNewer, isoOlder])._id).toBe(epochNewer._id);
  });

  it("has nothing to say about an empty or malformed batch", () => {
    expect(newestTrade([])).toBeNull();
    expect(newestTrade(undefined)).toBeNull();
    expect(newestTrade(null)).toBeNull();
    expect(newestTrade("not a batch")).toBeNull();
    expect(newestTrade([null, undefined])).toBeNull();
  });

  it("still answers when no row carries a readable time", () => {
    // Better a price than none; the rows are all equally unusable.
    const junk = [{ _id: "a", tradePrice: 5, tradeQty: 1, Type: "buy" }];
    expect(newestTrade(junk)?.tradePrice).toBe(5);
  });
});

