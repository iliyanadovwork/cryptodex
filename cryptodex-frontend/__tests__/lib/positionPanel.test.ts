/**
 * WHAT AN OPEN POSITIONS PANEL PAINTS, AND WHEN IT SAYS THERE IS NOTHING.
 *
 * REPORTED: "one Open Positions panel renders the full 'no records found'
 * empty-state illustration directly underneath a live open position; the
 * equivalent panel on another product does not."
 *
 * Both panels hand that illustration to InfiniteScroll as its `loader`, so it
 * is shown by `hasMore`. The working one read `nextPage` off a socket payload
 * that computes it (`data.length <= 0`); the broken one's socket sent no paging
 * fields at all and the component hardcoded `nextPage: true`, so the empty
 * state was permanently mounted.
 *
 * Guards:
 *   V1  visible rows are the ones the table will actually paint;
 *   V2  a payload that is not a list is no rows, not an exception;
 *   V3  rows are matched to the pair on screen, and only exactly;
 *   V4  the empty state is shown exactly when there is nothing to paint.
 */

import { visiblePositionRows, showsEmptyState } from "@/lib/positionPanel";

const pos = (pairId: any, over: any = {}) => ({
  _id: `p-${pairId}`,
  pairId,
  ...over,
});

describe("V1 the visible rows", () => {
  it("keeps only the rows for the contract on screen", () => {
    const rows = [pos("a"), pos("b"), pos("a")];
    expect(visiblePositionRows(rows, "a", false)).toHaveLength(2);
  });

  it("keeps everything when the user asked for all contracts", () => {
    const rows = [pos("a"), pos("b")];
    expect(visiblePositionRows(rows, "a", true)).toEqual(rows);
  });

  it("compares ids as strings, because one source sends objects", () => {
    const objectish = { toString: () => "a" };
    expect(visiblePositionRows([pos(objectish)], "a", false)).toHaveLength(1);
    expect(visiblePositionRows([pos("a")], objectish, false)).toHaveLength(1);
  });
});

describe("V2 a payload that is not a list", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an object", { data: [] }],
    ["a string", "nope"],
    ["a number", 3],
  ])("%s yields no rows", (_l, rows) => {
    expect(visiblePositionRows(rows, "a", false)).toEqual([]);
    expect(visiblePositionRows(rows, "a", true)).toEqual([]);
  });
});

describe("V3 rows are matched exactly", () => {
  it("shows nothing before a pair has been chosen", () => {
    // Matching against "" would otherwise be decided by whatever the payload
    // happens to contain.
    for (const noPair of [undefined, null, ""]) {
      expect(visiblePositionRows([pos("a")], noPair, false)).toEqual([]);
    }
  });

  it("still shows everything with showAll on, even before a pair is chosen", () => {
    expect(visiblePositionRows([pos("a")], undefined, true)).toHaveLength(1);
  });

  it("drops a row carrying no pairId rather than matching it loosely", () => {
    expect(visiblePositionRows([pos(undefined)], undefined, false)).toEqual([]);
    expect(visiblePositionRows([pos(null), pos("a")], "a", false)).toHaveLength(
      1
    );
  });

  it("a missing pairId does not match a pair id that STRINGIFIES the same", () => {
    // `String(undefined) === "undefined"` is true, so a bare string compare
    // would paint a row with no contract under a contract literally named
    // "undefined" - which is exactly the id a half-loaded store supplies.
    expect(visiblePositionRows([pos(undefined)], "undefined", false)).toEqual(
      []
    );
    expect(visiblePositionRows([pos(null)], "null", false)).toEqual([]);
  });

  it("survives a null row in the list", () => {
    expect(visiblePositionRows([null, pos("a")], "a", false)).toHaveLength(1);
  });

  it("does not match a DIFFERENT pair", () => {
    expect(visiblePositionRows([pos("b")], "a", false)).toEqual([]);
  });
});

describe("V4 when the empty state is shown", () => {
  it("THE BUG: not while there is a row to paint", () => {
    expect(showsEmptyState(visiblePositionRows([pos("a")], "a", false))).toBe(
      false
    );
  });

  it("yes when the payload is empty", () => {
    expect(showsEmptyState(visiblePositionRows([], "a", false))).toBe(true);
  });

  it("yes when every position belongs to another contract", () => {
    // Previously a blank panel with no explanation: rows existed, so no empty
    // state, but none of them were for this pair so nothing was painted.
    expect(showsEmptyState(visiblePositionRows([pos("b")], "a", false))).toBe(
      true
    );
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a non-list", {}],
  ])("yes for %s", (_l, rows) => {
    expect(showsEmptyState(rows)).toBe(true);
  });
});
