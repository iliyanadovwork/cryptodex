/**
 * "NO RECORDS FOUND", PRINTED UNDER A LIVE ROW
 * ===========================================
 *
 * WHERE THIS IS USED
 * ------------------
 * lib/pagedTable re-exports `visiblePositionRows` as `visibleRowsForPair`,
 * which the SPOT open-order, order-history and trade-history panels all filter
 * their rows with — the rule, its guards (non-array payloads, absent pair ids,
 * ObjectId-vs-string comparison) and its tests are the same for an order as for
 * a position. Only the original name is position-specific.
 *
 * WHAT IT WAS WRITTEN FOR
 * -----------------------
 * A table showed the full empty-state illustration — the grey "no data" graphic
 * and the words "No records found" — sitting directly underneath a live row.
 *
 * WHY
 * ---
 * These panels use `react-infinite-scroll-component` and pass the empty-state
 * block as its `loader` prop. InfiniteScroll renders `loader` whenever
 * `hasMore` is true, so "hasMore" is doing double duty: it means "there is
 * another page to fetch" AND, by accident of styling, "show the empty state".
 * A payload that carries no paging field at all, or a component that hardcodes
 * `nextPage: true`, therefore leaves the illustration permanently mounted —
 * under the rows, whatever the rows were.
 *
 * WHAT THIS MODULE DECIDES
 * ------------------------
 * The empty state belongs to WHAT THE TABLE ACTUALLY RENDERS, not to what the
 * socket delivered. Those differ: the panel filters to the pair currently on
 * screen unless the user has switched on "show all". A user whose only open
 * position is on another contract has a non-empty payload and an empty table,
 * and used to get a blank panel with no explanation at all.
 *
 * So the panel derives its visible rows once, renders those, and shows the
 * empty state exactly when that list is empty. One list, one verdict, and the
 * illustration can no longer appear beside a row.
 */

/**
 * The rows an Open Positions table will actually paint.
 *
 * @param rows     whatever arrived from REST or the socket
 * @param pairId   the contract the trade page is showing
 * @param showAll  the user's "show positions from all contracts" setting
 *
 * Guards:
 *  - a non-array payload yields no rows. A socket that sends null, or an
 *    object, must not throw inside a render and must not be mistaken for
 *    "there are positions".
 *  - with `showAll` on, every row is visible; the pair is irrelevant.
 *  - with it off and NO pair selected yet, nothing is visible. Matching rows
 *    against an empty pair id would show either everything or nothing at
 *    random depending on the payload, and the table's own header is not
 *    meaningful before a pair is chosen.
 *  - rows whose pairId is missing are dropped rather than matched loosely:
 *    `String(undefined) === String(undefined)` would otherwise pass and paint a
 *    position under the wrong contract's heading.
 *  - ids are compared as strings, because mongo ids arrive as ObjectId-shaped
 *    objects from one source and as plain strings from the other.
 */
export function visiblePositionRows(
  rows: any,
  pairId: any,
  showAll: any
): any[] {
  if (!Array.isArray(rows)) return [];
  if (showAll) return rows;

  const wanted =
    pairId === null || pairId === undefined ? "" : String(pairId);
  if (wanted === "") return [];

  return rows.filter(
    (row: any) =>
      row != null &&
      row.pairId !== null &&
      row.pairId !== undefined &&
      String(row.pairId) === wanted
  );
}

/**
 * Whether the panel should paint its "no records found" block.
 *
 * True only when there is nothing to show. This is what the InfiniteScroll
 * `hasMore`/`loader` pair is being asked, and answering it from the VISIBLE
 * rows is what stops the illustration rendering beside a live position.
 */
export function showsEmptyState(visibleRows: any): boolean {
  return !Array.isArray(visibleRows) || visibleRows.length === 0;
}
