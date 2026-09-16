import {
  useState,
  useEffect,
  useLayoutEffect,
  useContext,
  useRef,
} from "react";
import spot from "@/styles/Spot.module.css";
import { Table } from "react-bootstrap";
//import socket
import SocketContext from "../Context/SocketContext";
//import store
import { useSelector, useDispatch } from "../../store";
import { setLastTrade } from "@/store/trade/dataSlice";
//improt lib
import isEmpty from "../../lib/isEmpty";
import { formatPrice, formatQty } from "@/lib/numberFormat";
import { tradeTime } from "@/lib/tradeTime";
//import service
import { getRecentTrade } from "../../services/Spot/SpotService";
//import feed freshness label
import FeedStaleBadge from "./FeedStaleBadge";

/**
 * How many rows the trade log keeps. The panel shows ~50; the rest is headroom
 * so a burst does not visibly truncate the list.
 *
 * THE BUG THIS CAP EXISTS TO KILL. The old merge did `data.pop()` - removing
 * exactly ONE row - and then prepended the WHOLE incoming batch, so the array
 * grew by (batch - 1) on every message and never shrank. Both server emitters
 * send more than one: the Binance trade buffer flushes up to 20 on a 500ms
 * debounce, and `recentTradeSocket` republishes the entire top-25 window on
 * every fill. A tab left open passed 10,000 rows within an hour, and because
 * every row is rendered, the cost of handling each message grew with it - which
 * is what made the page progressively unresponsive and slow to return to.
 */
export const MAX_TRADE_ROWS = 60;

/**
 * A trade's identity, stable across messages.
 *
 * Deliberately NOT position-based. The row key used to include the array index,
 * so prepending N rows shifted every index and changed every key - React could
 * match no existing row, and tore down and rebuilt the ENTIRE table on every
 * message. With a stable key it reuses the rows it already has.
 */
export const tradeKey = (t: any) =>
  String(
    t?._id ??
      `${t?.createdAt}|${t?.tradePrice}|${t?.tradeQty}|${t?.Type ?? ""}`
  );

/**
 * A trade's time as a number, from either form the feeds use.
 *
 * The two feeds disagree about the type, and BOTH land in this one list:
 *   - the REST seed (binance.controller.js recentTrade) builds `new Date(...)`,
 *     which crosses the wire as an ISO-8601 STRING;
 *   - the socket push (binanceWebSocket.js handleTradeUpdate) passes Binance's
 *     `message.T` straight through, as epoch MILLISECONDS.
 * Comparing those as text is not merely fragile, it is wrong in one direction:
 * "2026-..." > "1787..." for every ISO row against every epoch row, so the
 * seeded rows would pin themselves above the live ones and stay there.
 *
 * A row with neither sorts to the end rather than to the top, so a malformed
 * message cannot take over the head of the list.
 */
export const tradeTimeValue = (t: any): number => {
  const raw = t?.createdAt;
  if (raw == null) return -Infinity;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : -Infinity;
};

/**
 * Newest first, no duplicates, capped - and it now does the first of those.
 *
 * The dedupe is load-bearing rather than defensive: `recentTradeSocket`
 * republishes the whole top-25 window on every fill, so most of each batch is
 * rows the list already holds. Without it the log fills with repeats.
 *
 * IT DID NOT SORT. This claimed "newest first" and delivered arrival order:
 * incoming batch, then whatever was already there. Two emitters feed it - a
 * Binance trade buffer on a 500ms debounce and a republish of the top window on
 * every fill - so a batch carrying prints older than rows already on screen put
 * them above those rows. Captured live from the running app, the tape read
 * 18:52:21, 18:52:24, 18:52:25, 18:52:22, 18:52:23: four jumps backwards in a
 * list whose whole job is chronological order.
 *
 * `createdAt` arrives as an ISO-8601 string from the live feed but as epoch
 * milliseconds elsewhere, so it is resolved to a number rather than compared as
 * text: string comparison only orders numeric timestamps correctly while they
 * all have the same digit count, which is true until it silently is not.
 *
 * The sort must be STABLE, and Array.prototype.sort is: a batch stamps many
 * prints with the same millisecond, and within one timestamp the order they
 * arrived in is the only ordering information there is.
 *
 * SORT BEFORE CAPPING, not after. The cap used to break out of the loop at 60
 * in arrival order, so a late batch of older trades could fill the list and
 * push newer ones off the end - the cap would have been keeping the wrong 60.
 */
export const mergeTrades = (incoming: any[], previous: any[]) => {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const trade of [...(incoming || []), ...(previous || [])]) {
    if (!trade) continue;
    const key = tradeKey(trade);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trade);
  }
  out.sort((a, b) => tradeTimeValue(b) - tradeTimeValue(a));
  return out.slice(0, MAX_TRADE_ROWS);
};

/** How long a row takes to travel to its new place. */
export const ROW_SLIDE_MS = 200;

/**
 * The vertical offset a row is being DRAWN at, which is not where layout puts
 * it while a slide is still running.
 *
 * This exists because an earlier version of the slide assumed it could never
 * be interrupted: spotapi throttles the Binance tape to one publish per 250ms,
 * comfortably longer than a slide. That reasoning was wrong. `recentTrade` has
 * a SECOND producer - spot.controller.js recentTradeSocket, emitted once per
 * matched maker from the order matcher, with no throttle at all, into the
 * tikerRoot room this page subscribes to. A fill can therefore land in the
 * middle of a slide, and a start position computed from layout alone would
 * snap the row from wherever it was being drawn to somewhere it never was.
 *
 * Reading the in-flight offset costs one style read per moving row and makes
 * the slide correct at any cadence, which is worth more than the assumption.
 */
export const transformShift = (transform: string | null | undefined): number => {
  if (!transform || transform === "none") return 0;
  // matrix(a, b, c, d, tx, ty) - ty is index 5.
  const two = transform.match(/^matrix\(([^)]+)\)/);
  if (two) return parseFloat(two[1].split(",")[5]) || 0;
  // matrix3d is 16 values in column-major order; ty is index 13.
  const three = transform.match(/^matrix3d\(([^)]+)\)/);
  if (three) return parseFloat(three[1].split(",")[13]) || 0;
  return 0;
};

/**
 * How long a newly arrived row stays lit. Must match the keyframes in
 * Spot.module.css, which fade the colour out over exactly this long - the
 * class is removed on this timer, so a longer animation would be cut off
 * mid-fade and a shorter one would leave a dead class on the row.
 */
export const FLASH_MS = 450;

/** Someone who asked their system not to animate things is not argued with. */
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * useLayoutEffect warns when it runs during server rendering, and this one has
 * nothing to do there - there is no layout to measure.
 */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * The latest print in a batch, by time rather than by position.
 *
 * Ordering is a property of the feed, and both feeds happen to deliver
 * oldest-first. Reading the time is the same work either way and does not
 * quietly become wrong when a feed changes its mind - which is exactly how
 * the headline price came to disagree with the row printed next to it.
 */
export const newestTrade = (trades: any): any => {
  if (!Array.isArray(trades)) return null;
  let newest: any = null;
  for (const trade of trades) {
    if (!trade) continue;
    if (newest === null || tradeTimeValue(trade) > tradeTimeValue(newest)) {
      newest = trade;
    }
  }
  return newest;
};

export default function RecentTrade() {
  const { tradePair } = useSelector((state: any) => state.spot);
  const dispatch = useDispatch();
  const [tradeData, setTradeData] = useState<any>([]);
  // Track which trades should flash (using timestamp as unique identifier)
  const [flashingTrades, setFlashingTrades] = useState<Set<string>>(new Set());
  const socketContext = useContext<any>(SocketContext);
  const fetchInterval = useRef<NodeJS.Timeout | null>(null);
  const pairIdRef = useRef<string>();
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  /** Where each row sat last commit, keyed by the identity the row is keyed by. */
  const prevTops = useRef<Map<string, number>>(new Map());

  /**
   * Publish the newest executed price for whoever needs to print "the price".
   *
   * This used to take `trades[0]` on the strength of a comment asserting the
   * batch was newest-first. BOTH feeds are the other way round: the socket
   * buffer is built with push(), and Binance's aggTrades returns ascending, so
   * element 0 is the OLDEST print of the window.
   *
   * That was invisible until the tape learned to sort. Before it did, the top
   * row was whatever arrived first - element 0 - so the headline and the row
   * beside it agreed, both wrong in the same direction. Sorting the tape fixed
   * the row and left this behind, and the two then disagreed on screen:
   * measured $10 apart on a 60-row batch, and $11 on the REST seed. That is
   * the contradiction lib/lastPrice.ts exists to prevent.
   */
  const publishLastTrade = (pairId: string, trades: any) => {
    const newest = newestTrade(trades);
    if (!newest) return;
    dispatch(setLastTrade({ pairId, price: newest.tradePrice }));
  };

  const fetchRecentTrade = async (pairId: string) => {
    try {
      let { status, result } = await getRecentTrade(pairId);
      if (status) {
        // THROUGH THE MERGE, not straight to state. This assigned the response
        // directly, so the first paint was whatever the server sent: unsorted,
        // undeduped, and past MAX_TRADE_ROWS - measured at 76 rows against a cap
        // of 60. That cap is not cosmetic. Every row is rendered, and the note
        // on MAX_TRADE_ROWS records a tab reaching 10,000 rows within an hour,
        // which is what made this page progressively unresponsive.
        setTradeData(mergeTrades(result || [], []));
        publishLastTrade(pairId, result);
      } else {
        setTradeData([]);
      }
    } catch (err) {
      setTradeData([]);
    }
  };

  const fetchRecentTradeWs = (result: any) => {
    // (The per-message console.log that used to sit here is gone. It ran ABOVE
    // the pair guard, so it fired for every pair on the venue rather than the
    // one on screen, and serialised an object on every trade.)

    // Use ref to avoid closure issues
    if (result?.pairId == pairIdRef.current) {
      // The engine just filled something: this, not the 30s venue cron, is what
      // "the price" is. Published before the render bookkeeping below so the
      // header and the book marker move in the same commit as the trade log.
      publishLastTrade(result.pairId, result.data);
      // Which rows flash - by the SAME stable identity the rows are keyed by, so
      // a flash follows its trade instead of whatever now sits at that position.
      const newTradeIds = new Set<string>(
        (result.data || []).map((trade: any) => tradeKey(trade))
      );
      setFlashingTrades(newTradeIds);

      // Remove flash class after the animation completes.
      setTimeout(() => {
        setFlashingTrades((prev) => {
          let changed = false;
          const next = new Set(prev);
          newTradeIds.forEach((id) => {
            if (next.delete(id)) changed = true;
          });
          // Returning a NEW Set unconditionally re-rendered the whole table a
          // second time per message even when this deleted nothing.
          return changed ? next : prev;
        });
      }, FLASH_MS);

      setTradeData((prevMessages: any) =>
        mergeTrades(result.data, prevMessages)
      );
    }
  };

  useEffect(() => {
    // Clean up any existing interval
    if (fetchInterval.current) {
      clearInterval(fetchInterval.current);
      fetchInterval.current = null;
    }

    if (!isEmpty(tradePair) && tradePair?._id) {
      // Update ref
      pairIdRef.current = tradePair._id;

      // Initial fetch
      fetchRecentTrade(tradePair._id);

      // Note: WebSocket streams now provide real-time updates for binance pairs
      // No need for polling - socket updates are handled by fetchRecentTradeWs
    }

    // Socket listener (works for both internal bot data and Binance WebSocket streams)
    socketContext.spotSocket.on("recentTrade", fetchRecentTradeWs);

    return () => {
      if (fetchInterval.current) {
        clearInterval(fetchInterval.current);
      }
      // Pass the SAME handler so only THIS instance unsubscribes. A bare
      // off("recentTrade") deletes every "recentTrade" listener on the shared
      // singleton socket (component-emitter drops the whole event), which would
      // silently freeze the page's other RecentTrade panels until a pair switch.
      // on() and off() share this effect closure, so the reference matches.
      socketContext.spotSocket.off("recentTrade", fetchRecentTradeWs);
    };
  }, [tradePair?._id, tradePair?.botstatus]);

  /**
   * ROWS SLIDE TO THEIR NEW PLACE INSTEAD OF TELEPORTING.
   * ====================================================
   *
   * A batch prepends a few prints and everything below shifts down by that
   * many row heights in a single frame - a 50-70px jump with nothing
   * connecting where a row was to where it went. The tape is a sequence, and
   * that jump is exactly where the eye loses its place in it.
   *
   * FLIP. By the time this runs the rows have already been laid out at their
   * NEW positions, so each one is put back where it was with a transform and
   * then let go. The browser animates the transform on the compositor: the
   * layout is never touched again, no reflow happens per frame, and every row
   * moves in step because they are all doing the same thing.
   *
   * `offsetTop`, NOT getBoundingClientRect: this panel scrolls, and a
   * viewport-relative measurement would read a scroll as movement and animate
   * all sixty rows on every wheel event.
   *
   * A slide already in flight is carried forward rather than cancelled - see
   * transformShift. Two producers publish `recentTrade` and only one of them
   * is throttled, so batches can and do arrive closer together than one slide.
   */
  useIsomorphicLayoutEffect(() => {
    const tbody = tbodyRef.current;
    if (!tbody) return;

    const rows = Array.from(
      tbody.querySelectorAll<HTMLTableRowElement>("tr[data-trade-key]")
    );

    // Read everything first. Interleaving reads with the writes below would
    // force a reflow per row instead of one for the batch.
    const nextTops = new Map<string, number>();
    const moved: Array<[HTMLTableRowElement, number]> = [];
    for (const row of rows) {
      const key = row.dataset.tradeKey as string;
      const top = row.offsetTop;
      nextTops.set(key, top);
      const was = prevTops.current.get(key);
      if (was === undefined || was === top) continue;
      // Where the row is being drawn now, so an interrupted slide continues
      // from there instead of jumping back to a layout position it never
      // occupied. Zero when the row is at rest, which is the common case.
      const inFlight = transformShift(getComputedStyle(row).transform);
      moved.push([row, was - top + inFlight]);
    }

    const hadPrevious = prevTops.current.size > 0;
    prevTops.current = nextTops;

    // Nothing to trace on the first paint - every row is new, and animating
    // them all in from nowhere is noise, not information.
    if (!hadPrevious || moved.length === 0 || prefersReducedMotion()) return;

    for (const [row, delta] of moved) {
      row.style.transition = "none";
      row.style.transform = `translateY(${delta}px)`;
    }

    // Make the browser ADOPT that start position before the transition is
    // armed. Without this read the two style changes below coalesce into one,
    // the row is only ever painted at its destination, and nothing animates.
    void tbody.offsetHeight;

    for (const [row] of moved) {
      row.style.transition = `transform ${ROW_SLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      row.style.transform = "";
    }
  }, [tradeData]);

  return (
    <div className={spot.recent_trade_wrap}>
      <div className={`${spot.market_pair_info}`}>
        <div className={spot.head_box}>
          <h6 className={spot.spot_head}>Recent Trades</h6>
          {/* The trade log is fed by the same socket as the venue tick. When
              that goes silent these rows are history that has stopped growing,
              not "the latest trades" — so they are labelled instead of hidden;
              a past trade is still a true fact about the past. */}
          <FeedStaleBadge />
        </div>
        <div className={spot.table_box}>
          <Table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Price ({tradePair.secondCurrencySymbol})</th>
                <th>Volume ({tradePair.firstCurrencySymbol})</th>
              </tr>
            </thead>
            <tbody ref={tbodyRef}>
              {tradeData?.length > 0 &&
                tradeData.map((item: any, index: number) => {

                  // Format time with leading zeros (HH:MM:SS). lib/tradeTime
                  // also answers "" instead of "NaN:NaN:NaN" when createdAt is
                  // unreadable, which padStart alone does not.
                  const time = tradeTime(item.createdAt);

                  // Stable identity - NOT the array index. See tradeKey.
                  const tradeId = tradeKey(item);
                  const isFlashing = flashingTrades.has(tradeId);
                  const isSell = item?.Type === "sell";

                  return (
                    <tr
                      key={tradeId}
                      // Read back by the slide effect above. `key` is React's
                      // and is not exposed on the DOM node.
                      data-trade-key={tradeId}
                      className={
                        isFlashing
                          ? isSell
                            ? spot.tradeFlashSell
                            : spot.tradeFlashBuy
                          : ""
                      }
                    >
                      <td>{time}</td>
                      <td
                        className={`${isSell ? spot.red : spot.green} ${spot.tabular_nums}`}
                      >
                        {formatPrice(
                          item?.tradePrice,
                          tradePair?.secondFloatDigit,
                          "—"
                        )}
                      </td>
                      <td className={spot.tabular_nums}>
                        {formatQty(
                          item?.tradeQty,
                          tradePair?.firstFloatDigit,
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </Table>
        </div>
      </div>
    </div>
  );
}
