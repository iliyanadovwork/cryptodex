/**
 * PAGING, AND THE EMPTY STATE THAT WAS RIDING ON IT
 * ================================================
 *
 * Unit guards for lib/pagedTable.ts. The component-level proof - that a user
 * with twelve resting spot orders can reach and cancel all twelve, and that the
 * "no records found" illustration no longer prints under a full page - is in
 * __tests__/components/spot/OpenOrderPaging.test.tsx.
 *
 * MUTATION-CHECKED: making mergePage always append, always replace, or skip the
 * de-duplication, and making showsNoRecords answer from a payload rather than
 * from a row list, each make named cases here fail. Table in the round summary.
 */

import { mergePage, showsNoRecords, visibleRowsForPair } from "@/lib/pagedTable";

const row = (id: string, extra: any = {}) => ({ _id: id, ...extra });

describe("mergePage", () => {
  test("page 1 REPLACES whatever the panel was holding", () => {
    const held = [row("a"), row("b")];
    // A refetch or a pair switch re-requests page 1. Appending it would double
    // every row, and on a pair switch would show the previous market's orders
    // under the new market's heading - the effect calls setOrderData(initial)
    // but the fetch closure still holds the old `data`.
    expect(mergePage(held, [row("c")], 1)).toEqual([row("c")]);
  });

  test("page 2 APPENDS to what is already on screen", () => {
    const held = [row("a"), row("b")];
    expect(mergePage(held, [row("c"), row("d")], 2)).toEqual([
      row("a"),
      row("b"),
      row("c"),
      row("d"),
    ]);
  });

  test("the twelve-order case: two pages of ten yield all twelve, in order", () => {
    const all = Array.from({ length: 12 }, (_, i) => row("o" + i));
    const first = mergePage([], all.slice(0, 10), 1);
    const second = mergePage(first, all.slice(10), 2);

    expect(second).toHaveLength(12);
    expect(second.map((r: any) => r._id)).toEqual(all.map((r) => r._id));
  });

  test("a row page 1 already had is not added twice", () => {
    // The open-order book is live: an order filling between the two requests
    // shifts every later row up by one, so page 2 re-sends a row page 1 had.
    // Two identical rows means two cancel buttons for one order.
    const first = [row("a"), row("b"), row("c")];
    const merged = mergePage(first, [row("c"), row("d")], 2);

    expect(merged.map((r: any) => r._id)).toEqual(["a", "b", "c", "d"]);
  });

  test("de-duplication also works within the incoming page", () => {
    const merged = mergePage([row("a")], [row("b"), row("b")], 2);
    expect(merged.map((r: any) => r._id)).toEqual(["a", "b"]);
  });

  test("identity is read from _id, orderId or orderCode", () => {
    expect(
      mergePage([{ orderCode: "x1" }], [{ orderCode: "x1" }, { orderCode: "x2" }], 2)
    ).toEqual([{ orderCode: "x1" }, { orderCode: "x2" }]);

    expect(mergePage([{ orderId: "y1" }], [{ orderId: "y1" }], 2)).toEqual([
      { orderId: "y1" },
    ]);
  });

  test("a row with no id at all is KEPT, not silently dropped", () => {
    // Dropping it would lose a real row to make de-duplication tidy. Two rows
    // that both have nothing to compare on are not evidence they are the same
    // row.
    const merged = mergePage([{ price: 1 }], [{ price: 2 }, { price: 3 }], 2);
    expect(merged).toHaveLength(3);
  });

  test("an empty string id counts as no id", () => {
    const merged = mergePage([{ _id: "" }], [{ _id: "" }], 2);
    expect(merged).toHaveLength(2);
  });

  test("a broken page 2 leaves the rows already on screen alone", () => {
    // It adds nothing rather than erasing what is there: a malformed "load
    // more" response must not blank a table the user is reading, and on the
    // open-order table must not hide an order they are trying to cancel.
    expect(mergePage([row("a")], null, 2)).toEqual([row("a")]);
    expect(mergePage([row("a")], { data: [] }, 2)).toEqual([row("a")]);
  });

  test("a broken page 1 leaves an empty table, because page 1 IS the table", () => {
    expect(mergePage([row("a")], undefined, 1)).toEqual([]);
    expect(mergePage([row("a")], null, 1)).toEqual([]);
  });

  test("none of the broken shapes throws", () => {
    expect(() => mergePage(null, null, null)).not.toThrow();
    expect(() => mergePage("nope", 7, {})).not.toThrow();
  });

  test("a non-array of held rows is replaced rather than concatenated", () => {
    expect(mergePage(null, [row("a")], 2)).toEqual([row("a")]);
  });

  test("an unusable page number is treated as page 1", () => {
    // `currentPage: undefined` is exactly what the spot socket used to send,
    // and `undefined + 1` is NaN. Replacing is the safe reading: it shows the
    // payload, where appending would stack pages that may overlap arbitrarily.
    expect(mergePage([row("a")], [row("b")], undefined)).toEqual([row("b")]);
    expect(mergePage([row("a")], [row("b")], NaN)).toEqual([row("b")]);
    expect(mergePage([row("a")], [row("b")], "not a page")).toEqual([row("b")]);
  });

  test("a page number that arrives as a string still appends", () => {
    expect(mergePage([row("a")], [row("b")], "2")).toEqual([row("a"), row("b")]);
  });
});

describe("showsNoRecords", () => {
  test("an empty list is the empty state", () => {
    expect(showsNoRecords([])).toBe(true);
  });

  test("one row is not", () => {
    expect(showsNoRecords([row("a")])).toBe(false);
  });

  test("a non-list is the empty state rather than a crash", () => {
    expect(showsNoRecords(null)).toBe(true);
    expect(showsNoRecords(undefined)).toBe(true);
    expect(showsNoRecords({ length: 3 })).toBe(true);
  });

  test("it answers from the VISIBLE rows, so a full page is never 'empty'", () => {
    // This is the pairing that matters: a full first page with a second page
    // behind it used to print the empty-state illustration, because the
    // question being answered was `hasMore`, not "is the table empty".
    const fullPage = Array.from({ length: 10 }, (_, i) => row("o" + i));
    expect(showsNoRecords(fullPage)).toBe(false);
  });
});

describe("visibleRowsForPair (re-exported from positionPanel)", () => {
  const PAIR = "695bf1017573eeb15a749c9d";
  const OTHER = "695bf1017573eeb15a749c9e";

  test("with show-all off, only the pair on screen is visible", () => {
    const rows = [row("a", { pairId: PAIR }), row("b", { pairId: OTHER })];
    expect(visibleRowsForPair(rows, PAIR, false).map((r: any) => r._id)).toEqual(["a"]);
  });

  test("with show-all on, every row is visible", () => {
    const rows = [row("a", { pairId: PAIR }), row("b", { pairId: OTHER })];
    expect(visibleRowsForPair(rows, PAIR, true)).toHaveLength(2);
  });

  test("a payload of orders on OTHER markets is an empty TABLE", () => {
    // The panel used to render nothing at all here: rows existed, so the empty
    // state was suppressed, but none of them passed the pair filter.
    const rows = [row("b", { pairId: OTHER })];
    const visible = visibleRowsForPair(rows, PAIR, false);
    expect(visible).toEqual([]);
    expect(showsNoRecords(visible)).toBe(true);
  });
});
