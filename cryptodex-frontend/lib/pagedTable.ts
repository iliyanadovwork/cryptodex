/**
 * TWO MEANINGS SHARING ONE FLAG
 * =============================
 *
 * Every history/open-order panel on this frontend is a
 * `react-infinite-scroll-component` wrapping a single `<Table>`, and every one
 * of them passed the "no records found" illustration as that component's
 * `loader` prop. Read its render (node_modules/react-infinite-scroll-component,
 * `render()`):
 *
 *     {!showLoader && !hasChildren && hasMore && loader}
 *     {showLoader && hasMore && loader}
 *
 * `hasChildren` is `props.hasChildren || (children instanceof Array &&
 * children.length)`, and a single `<Table>` child is not an Array — so it was
 * false in every one of these panels and the first line reduced to
 * `!showLoader && hasMore && loader`. The empty-state illustration was
 * therefore mounted whenever `hasMore` was true, WHATEVER the rows were.
 *
 * `hasMore` is the API's `nextPage`, and `nextPage` used to be
 * `data.length <= 0 ? true : false` — true exactly when the page was empty. So
 * the accident lined up: an empty table said "hasMore", which printed the empty
 * state, and a table with rows said "no more", which hid it. The panels looked
 * right and paginated not at all: with 12 resting orders and a page size of 10,
 * two of them were unreachable, and on the SPOT open-orders table — the only
 * place a resting spot order can be cancelled — that stranded their reservation
 * in the in-order ledger indefinitely.
 *
 * Correcting `nextPage` alone would have broken both halves: a full first page
 * would print "No records found" underneath ten live rows, and a genuinely
 * empty table would print nothing at all. So the two meanings are separated
 * here, the same way lib/positionPanel.ts already separated them for the
 * position panels:
 *
 *   - `hasMore` stays the paging flag and nothing else;
 *   - the empty state is rendered as a SECOND CHILD of the scroller, decided
 *     from the rows the table actually paints. Being a second child also makes
 *     `hasChildren` true, which retires the `!hasChildren && hasMore` branch
 *     above — so `loader` can go back to meaning "a fetch is in flight".
 */

/**
 * The rows a table will paint, given the pair on screen and the user's
 * "show every market" setting.
 *
 * Re-exported rather than reimplemented: the open-order panels filter their
 * rows by exactly the rule the position panels do - `showAll || String(
 * row.pairId) === String(pairId)` - and lib/positionPanel.ts already carries
 * that rule, its guards (non-array payloads, absent pair ids, ObjectId-vs-
 * string comparison) and its tests. Only the name was position-specific.
 */
export { visiblePositionRows as visibleRowsForPair } from "./positionPanel";

/**
 * The rows a panel should hold after a page arrives.
 *
 * Page 1 REPLACES: it is a fresh read of the table, and appending it to
 * whatever was on screen would double every row on a pair switch or a refetch.
 * Later pages APPEND: that is what "load more" means, and the three open-order
 * panels used to overwrite instead — page 2 of a 12-order book replaced the ten
 * rows on screen with the last two, so correcting `nextPage` without this would
 * have made ten orders vanish on scroll instead of two.
 *
 * Rows already held are never added twice. The open-order set is live: an order
 * can fill or be cancelled between the two requests, which shifts every later
 * row up by one and re-sends a row page 1 already had. React would then warn on
 * duplicate keys and the user would see the same order listed twice, with two
 * cancel buttons for one order.
 *
 * A payload that is not a list contributes no rows. On a later page that leaves
 * what is on screen untouched — a malformed "load more" must not blank a table
 * the user is reading, still less hide an order they were about to cancel. On
 * page 1 it leaves the table empty, because page 1 IS the table.
 */
export function mergePage<T = any>(
  existing: any,
  incoming: any,
  page: any
): T[] {
  const rows: T[] = Array.isArray(incoming) ? incoming : [];
  const pageNumber = Number(page);
  if (!Number.isFinite(pageNumber) || pageNumber <= 1) return rows;
  if (!Array.isArray(existing)) return rows;

  const seen = new Set<string>();
  for (const row of existing) {
    const id = rowKey(row);
    if (id !== null) seen.add(id);
  }
  return existing.concat(rows.filter((row) => {
    const id = rowKey(row);
    if (id === null) return true; // no id to compare on: keep it, and say so
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }));
}

/** A row's identity, or null when it has none to compare on. */
function rowKey(row: any): string | null {
  if (row === null || row === undefined) return null;
  const id = row._id ?? row.orderId ?? row.orderCode;
  if (id === null || id === undefined) return null;
  const key = String(id);
  return key === "" ? null : key;
}

/**
 * Whether a panel should paint its "no records found" block.
 *
 * Takes the rows the table WILL PAINT, not the payload: the open-order panels
 * filter to the pair on screen unless "show all" is on, so a user whose only
 * resting order is on another market has a non-empty payload and an empty
 * table. Answering from the payload leaves them a blank panel with no
 * explanation.
 */
export function showsNoRecords(visibleRows: any): boolean {
  return !Array.isArray(visibleRows) || visibleRows.length === 0;
}
