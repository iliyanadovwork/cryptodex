/**
 * THE CLOCK ON THE TRADE TAPE.
 * ===========================
 *
 * THE BUG THIS EXISTS TO KILL
 * ---------------------------
 * Several "Recent Trades" tapes rendered the same column and only one of them
 * rendered it correctly. MEASURED in Chrome on a trade page:
 *
 *     Time      Price(USD)   Volume(USD)
 *     22:47:0   64364.8      100
 *
 * `22:47:0` is not a time. The broken tapes built the string as
 *
 *     dataTime.getHours() + ":" + dataTime.getMinutes() + ":" + dataTime.getSeconds()
 *
 * which drops the leading zero on any field below ten — so for the first ten
 * seconds of every minute, and the first ten minutes of every hour, the tape
 * prints a ragged, mis-sorting, one-character-short timestamp. The spot tape
 * (components/spot/RecentTrade.tsx) had already been fixed with `padStart(2)`
 * inline, which is exactly how the other two were left behind: the fix lived in
 * a component instead of in a function, so it could not be reused and nobody
 * could see that two callers still had the old arithmetic.
 *
 * THE SECOND DEFECT, WHICH PADDING ALONE DOES NOT FIX
 * ---------------------------------------------------
 * `new Date(undefined)` is an Invalid Date, and every accessor on it answers
 * NaN. The unpadded version therefore renders the literal `NaN:NaN:NaN`, and
 * the *padded* version renders `NaN:NaN:NaN` too — `String(NaN).padStart(2,"0")`
 * is `"NaN"`, not `"0N"` — so copying the spot fix verbatim would have carried
 * that with it. A trade row whose timestamp cannot be read should show an empty
 * cell, not three NaNs: the price and size on that row are still true, and
 * blanking one cell is a smaller lie than printing a fake one.
 *
 * WHY NOT lib/dateTimeHelper.dateTimeFormat
 * -----------------------------------------
 * It exists and it does pad. It also does its work by successive string
 * REPLACEMENT into the format template, which means it is doing substring
 * surgery on a string that already contains the numbers it substituted; it has
 * no tests; and it answers `''` for a valid Date of epoch 0 because `isEmpty`
 * treats 0 as empty. This is one column on a hot path that repaints on every
 * trade, so it gets a function that does one thing and is tested on the
 * boundaries that actually broke.
 */

/** Two digits, zero-padded. Only ever called with an integer 0..59 (or 0..23). */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * `HH:MM:SS` in the viewer's local timezone, or `""` when the input is not a
 * readable instant.
 *
 * Accepts anything `new Date()` accepts — an ISO string (what the trade feeds
 * send), an epoch number, or a Date. Returns `""` rather than a placeholder for
 * null/undefined/unparseable input, because the caller renders this straight
 * into a <td> and an empty cell is the honest rendering of "no time".
 *
 * Epoch 0 is a VALID instant and formats normally; it is only falsy, not
 * unreadable, and the tape has no business deciding that 1970 is a typo.
 */
export function tradeTime(value: any): string {
  // ONLY null is checked here, and it is not defensive padding: `new Date(null)`
  // is a VALID Date at epoch 0, so without this a null createdAt would render
  // "00:00:00" — a confident, wrong timestamp — instead of an empty cell.
  // `undefined` and "" both coerce to Invalid Date and are caught by the
  // getTime() check below; listing them here as well would be dead code that
  // no test could distinguish, so they are deliberately left to that guard.
  if (value === null) return "";

  const date = value instanceof Date ? value : new Date(value);
  // Invalid Date is the only Date whose getTime() is NaN. Checking the instant
  // once is cheaper and safer than checking each of the three accessors, which
  // is what a caller doing `padStart` on each field failed to do.
  if (Number.isNaN(date.getTime())) return "";

  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
    date.getSeconds()
  )}`;
}
