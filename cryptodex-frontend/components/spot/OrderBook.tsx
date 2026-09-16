import React, { useState, useEffect, useContext, useCallback, useMemo, useRef } from "react";
import spot from "@/styles/Spot.module.css";
//import store
import { useDispatch, useSelector } from "../../store";
//import socket
import SocketContext from "../Context/SocketContext";
//improt lib
import { toFixed } from "@/lib/roundOf";
import { formatPrice, formatQty } from "@/lib/numberFormat";
import isEmpty from "@/lib/isEmpty";
//import service
import { getOrderBook } from "../../services/Spot/SpotService";
import RecentTrade from "./RecentTrade";
import { setOrderBookPrice, setBookHealth } from "../../store/trade/dataSlice";
//import resync hook
import { useOrderBookResync } from "@/hooks/useOrderBookResync";
//import book health
import {
  BookHealth,
  DEFAULT_BOOK_HEALTH,
  describeBookHealth,
  pendingBookHealth,
  readBookHealth,
  sameHealth,
} from "@/lib/orderBookHealth";

/**
 * Minimum gap between ladder repaints, in ms. The depth feed pushes ~10x a
 * second (Binance `@depth@100ms`); this is how often the user actually sees a
 * new frame. See the repaint-throttle block in the component for why coalescing
 * is lossless here, and for the two cases that bypass it.
 *
 * THIS NUMBER AND THE DEPTH-BAR GLIDE ARE COUPLED. The bars animate their width
 * (.ob_row_bar in Spot.module.css) and an animation that is still running when
 * the next frame lands gets interrupted and restarted from wherever it had got
 * to - which is what made the book visibly stutter when this was 500ms against a
 * 200ms glide at feed rate. The glide must stay comfortably SHORTER than this
 * interval. At 750ms/300ms the bar moves for 300ms and is then still for 450ms;
 * if this is ever lowered, lower the transition with it.
 */
const BOOK_REPAINT_INTERVAL_MS = 750;

/**
 * The price-grouping step the book opens on, before the venue's own list of
 * steps has arrived. 10 is the coarsest step a USD pair publishes; a pair that
 * does not offer it snaps to its own coarsest once the first payload lands.
 */
const DEFAULT_GROUPING_STEP = 10;

/**
 * The up/down chevron pair both header controls wear.
 *
 * Drawn rather than typed: the previous single "\u2304" glyph renders at wildly
 * different weights across fonts and platforms, and only hinted at "this opens".
 * A stepper pair reads as adjustable at a glance and is crisp at any size.
 */
const StepperChevron = () => (
  <svg
    className={spot.ob_dd_caret}
    width="7"
    height="11"
    viewBox="0 0 7 11"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M1 4.2 3.5 1.6 6 4.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M1 6.8 3.5 9.4 6 6.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface OrderBookProps {
  /**
   * Whether THIS instance owns `spot.bookHealth`, the single shared verdict the
   * order tickets read.
   *
   * The spot page mounts two OrderBooks — the desktop layout and the mobile
   * layout are both in the tree, and CSS decides which one you see. They each
   * keep their own copy of the verdict (own socket handler, own REST snapshot,
   * own staleness watchdog), so they can legitimately disagree for a moment:
   * one instance's mount snapshot can resolve AFTER the other has already
   * processed a newer socket payload. With both of them writing the shared slot
   * it is last-writer-wins, and the loser can be the instance that actually
   * knows — a stale "healthy" snapshot re-enabling the ticket over a live
   * "nothing can fill" verdict.
   *
   * So exactly one instance publishes. The other still renders its own panel
   * from its own copy; it just does not get a vote on what the tickets see.
   */
  publishHealth?: boolean;
}

export default function OrderBook({ publishHealth = true }: OrderBookProps = {}) {
  const { tradePair, openOrders } = useSelector((state: any) => state.spot);
  const { priceConversion } = useSelector((state: any) => state.wallet);
  const socketContext = useContext<any>(SocketContext);
  const dispatch = useDispatch();

  const [view, setView] = useState("all");
  // Which tab of the panel is showing - Order Book or Trades (reference layout).
  const [panelTab, setPanelTab] = useState<"book" | "trades">("book");
  const [orderBook, setOrderBook] = useState<any>({
    buyOrder: [],
    sellOrder: [],
  });

  // The publisher's verdict for the book currently on screen. Every payload —
  // socket tick, REST snapshot, resync — carries it, and we never draw a ladder
  // that the backend has told us nothing can fill against. Until the first
  // payload lands it is `pending`: not a claim that the book is fine, just an
  // admission that we have not heard yet.
  const [health, setHealth] = useState<BookHealth>(() =>
    pendingBookHealth(tradePair?._id)
  );

  // The Size and Total columns show the BASE-coin quantity at each level (how
  // much of the coin is resting / cumulatively available), the way a standard
  // exchange book reads - not the quote notional. Base coin + its precision come
  // from the pair (firstCurrencySymbol / firstFloatDigit).
  const baseSymbol = tradePair?.firstCurrencySymbol || "";
  const baseDigits = Number.isFinite(Number(tradePair?.firstFloatDigit))
    ? Number(tradePair.firstFloatDigit)
    : 4;

  // Reference-matched palette for the order book.
  const OB = {
    red: "#f6465d",
    green: "#0ecb81",
    redBar: "rgba(246,70,93,0.16)",
    greenBar: "rgba(14,203,129,0.14)",
    num: "#eaecef",
    gray: "#848e9c",
    dim: "#5b6371",
  };

  // Which side of the pair the SIZE / TOTAL columns are denominated in.
  // "base" = the coin itself (0.40936 BTC), "quote" = its value (31,554 USD).
  const [sizeUnit, setSizeUnit] = useState<"base" | "quote">("base");
  const quoteSymbol = tradePair?.secondCurrencySymbol || "";
  const unitSymbol = sizeUnit === "base" ? baseSymbol : quoteSymbol;

  // The grouping steps the SERVER published a ladder for. Driving the dropdown
  // from the payload means the two cannot drift: a step offered here is by
  // definition one the publisher aggregated, so picking it can never fall back
  // to local grouping. Null until the first payload lands.
  const [serverSteps, setServerSteps] = useState<number[] | null>(null);

  // THE VENUE'S TICK - the finest price increment this pair quotes in.
  //
  // Internally step 0 means "do not group", but a grouping menu that offers "0"
  // is nonsense to read: zero of what? The ungrouped view IS the tick, because
  // the raw levels are already at tick granularity, so the option is LABELLED
  // with the tick the way every exchange labels its finest step (0.01, 0.5, 1,
  // 5, 10). The value stays 0 - only what the user reads changes.
  const tickDigits = Number.isFinite(Number(tradePair?.secondFloatDigit))
    ? Number(tradePair.secondFloatDigit)
    : 2;
  const tickSize = Math.pow(10, -tickDigits);
  const tickLabel = tickSize.toFixed(tickDigits);

  // Price-grouping steps offered in the dropdown, scaled to the quote. The
  // hardcoded list is only the pre-first-payload (and older-server) fallback.
  // A step at or below the tick is dropped: it would be indistinguishable from
  // ungrouped, and would render a second option carrying the same label.
  const groupOptions = (
    serverSteps && serverSteps.length
      ? [0, ...serverSteps]
      : tradePair?.secondCurrencySymbol === "USD" ||
        tradePair?.secondCurrencySymbol === "USDT"
        ? [0, 0.5, 1, 5, 10]
        : [0, 0.01, 0.05, 0.1, 0.5]
  ).filter((g) => g === 0 || g > tickSize);

  // Price grouping state - groups levels into larger steps for cleaner staircase.
  //
  // The book OPENS GROUPED, at the coarsest step the venue publishes (10 on a
  // USD pair). Ungrouped is the tick, and a BTC ladder at 0.01 is eight rows
  // spanning a couple of dollars - technically the finest view and practically
  // unreadable, because consecutive levels differ in the last digit. The coarse
  // step is the one that shows where the liquidity actually is, which is what
  // the book is for; the finer steps stay one click away.
  const [groupingStep, setGroupingStep] = useState<number>(
    DEFAULT_GROUPING_STEP
  );
  // Whether the user has picked a step themselves. Once they have, the snap
  // below must never overrule them.
  const userPickedStepRef = useRef(false);

  // The default above is a literal, and a pair need not offer it: a
  // finer-quoting market publishes [0.01, 0.05, 0.1, 0.5] and has no 10 at all,
  // which would leave the select on a value with no matching option. Once the
  // venue's real steps are known, land on the COARSEST one it actually
  // publishes - unless the user has already chosen for themselves.
  useEffect(() => {
    if (userPickedStepRef.current) return;
    if (!serverSteps || serverSteps.length === 0) return;
    if (serverSteps.includes(groupingStep)) return;
    setGroupingStep(serverSteps[serverSteps.length - 1]);
  }, [serverSteps, groupingStep]);


  // A grouping change is a DIRECT user action, and the ladder can only be
  // re-derived from a payload - so open the repaint window immediately, letting
  // the next tick (~100ms) draw at the new step instead of sitting on the old
  // grouping for up to a full window. Without this the dropdown feels laggy.
  useEffect(() => {
    lastPaintedAtRef.current = 0;
  }, [groupingStep]);

  // Last drawn size per `${side}:${price}`, and a counter whose parity restarts
  // the flash animation. See the marking step in handleOrderBookData.
  const prevSizesRef = useRef<Map<string, number>>(new Map());
  const flashSeqRef = useRef(0);

  // Track current pair ID for state reset on pair change
  const currentPairIdRef = useRef<string | null>(null);

  // Last-applied venue update id per pair, so a slow REST/resync snapshot cannot
  // overwrite a fresher live socket tick. bookUpdateId is Binance's monotonic
  // lastUpdateId - it survives a backend restart (unlike the per-process seq),
  // so an ordering guard keyed on it can never wedge the book after a redeploy.
  const lastBookUpdateIdRef = useRef<Map<string, number>>(new Map());

  // Track stable socket instance and pairId for subscription
  const socketRef = useRef(socketContext?.spotSocket);
  const pairIdRef = useRef(tradePair?._id);

  // Update refs when values change (prevents effect re-runs)
  useEffect(() => {
    socketRef.current = socketContext?.spotSocket;
  }, [socketContext?.spotSocket]);

  useEffect(() => {
    pairIdRef.current = tradePair?._id;
  }, [tradePair?._id]);

  let { buyOrder, sellOrder } = orderBook;

  /**
   * Merge user's open orders into orderbook data
   * Shows visual indicator (→) for prices that match user's orders
   */
  const mergeOrder = useCallback(async (data: any, type: string) => {
    try {
      let updatedOrder = data;
      if (type == "buy" && openOrders.length > 0) {
        // NUMERIC band test: is the user's order price within [worst..best] of
        // the visible bids? toFixed() returns a STRING, so the old `>=`/`<=` were
        // lexicographic ("101.00" >= "99.50" is false because '1' < '9'), which
        // silently dropped the user's own-order (→) marker for any book that
        // straddled a power-of-ten boundary. Compare numbers.
        let checkO = openOrders.filter((order: any) => (
          Number(updatedOrder[0]._id) >= Number(order.price) &&
          Number(updatedOrder[updatedOrder.length - 1]._id) <= Number(order.price) &&
          order.buyorsell == "buy"
        ));
        if (checkO && checkO.length > 0) {
          checkO.forEach((matchedOrder: any) => {
            let existingOrder = updatedOrder.find((upd: any) =>
              toFixed(upd._id, tradePair.secondFloatDigit) === toFixed(matchedOrder.price, tradePair.secondFloatDigit)
            );
            if (existingOrder) {
              existingOrder.price = matchedOrder.price;
              existingOrder.status = 'open';
            }
          });
          return updatedOrder;
        }
      } else if (type == "sell" && openOrders.length > 0) {
        // NUMERIC band test (see the buy branch): asks ascend, so best is [0]
        // and worst is [last]. String `<=`/`>=` on toFixed() was lexicographic.
        let checkO = openOrders.filter((order: any) => (
          Number(updatedOrder[0]._id) <= Number(order.price) &&
          Number(updatedOrder[updatedOrder.length - 1]._id) >= Number(order.price) &&
          order.buyorsell == "sell"
        ));
        if (checkO && checkO.length > 0) {
          checkO.forEach((matchedOrder: any) => {
            let existingOrder = updatedOrder.find((upd: any) =>
              toFixed(upd._id, tradePair.secondFloatDigit) === toFixed(matchedOrder.price, tradePair.secondFloatDigit)
            );
            if (existingOrder) {
              existingOrder.price = matchedOrder.price;
              existingOrder.status = 'open';
            }
          });
          return updatedOrder;
        }
      }
    } catch (err) {
      // Silently handle errors
    }

    return data
  }, [openOrders, tradePair.secondFloatDigit]);

  /**
   * Group price to a step size
   * Bids group "down" (floor), asks group "up" (ceil) to avoid crossing spread
   */
  const groupPrice = useCallback((price: number, step: number, side: 'bid' | 'ask'): number => {
    if (step <= 0) return price;
    const k = price / step;
    const g = side === 'bid' ? Math.floor(k) : Math.ceil(k);
    return g * step;
  }, []);

  /**
   * Normalize and group orderbook data
   * Pipeline: parse → filter zeros → (optional: group) → sort → compute notional → compute cumulative
   */
  const normalizeOrderBookData = useCallback((rawOrders: any[], side: 'bid' | 'ask', step: number) => {
    if (!rawOrders || rawOrders.length === 0) return [];

    // Map to group aggregated quantities
    const groupedMap = new Map<number, { qty: number; notional: number; status: string | null }>();

    // Step 1: Parse and optionally group levels
    rawOrders.forEach((item: any) => {
      const price = parseFloat(item?._id || item?.price || 0);
      const qty = parseFloat(item?.quantity || 0);

      // Filter out zero quantity levels
      if (qty <= 0 || price <= 0) return;

      // Apply grouping if step > 0
      const groupedPrice = step > 0 ? groupPrice(price, step, side) : price;

      // Accumulate quantity and notional per grouped price
      const existing = groupedMap.get(groupedPrice);
      const notional = item?.notional || (price * qty);

      if (existing) {
        existing.qty += qty;
        existing.notional += notional;
        if (item?.status === 'open') existing.status = 'open';
      } else {
        groupedMap.set(groupedPrice, {
          qty: qty,
          notional: notional,
          status: item?.status || null,
        });
      }
    });

    // Convert map to array
    const normalized = Array.from(groupedMap.entries()).map(([price, data]) => ({
      _id: price,
      price: price,
      quantity: data.qty,
      notional: data.notional,
      cumulativeNotional: 0,  // Will be computed below
      status: data.status,
    }));

    // Step 2: Sort
    // Bids: descending by price (best bid = highest price first)
    // Asks: ascending by price (best ask = lowest price first)
    const sorted = normalized.sort((a: any, b: any) => {
      return side === 'bid' ? b.price - a.price : a.price - b.price;
    });

    // Step 3: Take top 20 (more than displayed 8, for scaling reference)
    const top20 = sorted.slice(0, 20);

    // Step 4: Compute cumulative BASE quantity (and notional) from best -> worse.
    // The Size/Total columns and the depth bars read cumulativeQuantity; the
    // notional total is kept for the mid/spread and any value-based logic.
    let runningQty = 0;
    let runningCumulative = 0;
    const withCumulative = top20.map((item: any) => {
      runningQty += item.quantity;
      runningCumulative += item.notional;
      return {
        ...item,
        cumulativeQuantity: runningQty,
        cumulativeNotional: runningCumulative,
      };
    });

    return withCumulative;
  }, [groupPrice]);

  /**
   * Recompute cumulative notional after any data modification
   * This ensures cumulative values are always correct after merging/grouping
   */
  const recomputeCumulative = useCallback((orders: any[], side: 'bid' | 'ask') => {
    // Sort first to ensure correct cumulative direction
    const sorted = [...orders].sort((a: any, b: any) => {
      return side === 'bid' ? b.price - a.price : a.price - b.price;
    });

    let runningQty = 0;
    let runningCumulative = 0;
    return sorted.map((item: any) => {
      runningQty += Number(item.quantity) || 0;
      runningCumulative += item.notional || 0;
      return {
        ...item,
        cumulativeQuantity: runningQty,
        cumulativeNotional: runningCumulative,
      };
    });
  }, []);

  /**
   * Handle orderbook data from REST API or socket
   * Implements: pair change reset → normalize/group → merge → recompute cumulative → update state
   */
  const handleOrderBookData = useCallback(async (result: any) => {
    if (!result) return;

    const pairId = result.pairId;

    // GUARD (wrong pair): only render a payload for the pair the user is
    // currently viewing. A late in-flight REST/resync snapshot whose closure
    // captured a since-abandoned pair (mount, reconnect, visibilitychange,
    // focus, staleness watchdog) would otherwise render the OLD pair's ladder
    // under the new header and pre-fill the ticket with the wrong price.
    // pairIdRef is kept current by an effect, unlike a value captured in a
    // fetch closure - so this catches the resolve-after-switch race.
    if (pairIdRef.current != null && String(pairId) !== String(pairIdRef.current)) {
      return;
    }

    const previousPairId = currentPairIdRef.current;

    // Reset state on pair change (prevents cross-pair artifacts)
    if (previousPairId !== null && previousPairId !== pairId) {
      console.log(`[OrderBook] Pair changed from ${previousPairId} to ${pairId}, resetting state`);
      setOrderBook({ buyOrder: [], sellOrder: [] });
      // Another pair's sizes are not this pair's history - keeping them would
      // flash the whole new book on its first paint.
      prevSizesRef.current = new Map();
      // Reset grouping on pair change
      setGroupingStep(0);
    }
    currentPairIdRef.current = pairId;

    // Step 0: the health gate. bookPublish.controller.js already empties the
    // ladders when the verdict is unhealthy, but the component must not keep
    // whatever it drew a moment ago either — a blank book with no explanation is
    // the same lie as a stale one, just quieter.
    const payloadHealth = readBookHealth({ ...result, pairId });
    setHealth((prev) => (sameHealth(prev, payloadHealth) ? prev : payloadHealth));
    if (!payloadHealth.healthy) {
      setOrderBook({ buyOrder: [], sellOrder: [] });
      return;
    }

    // GUARD (stale ordering): for a HEALTHY book, reject a payload older than one
    // already applied for this pair, so a slow REST/resync snapshot that resolves
    // after a fresher live tick cannot overwrite it with a staler best bid/ask.
    // Keyed on Binance's monotonic bookUpdateId (restart-safe); unhealthy
    // payloads are exempt above so a blank always lands; a missing/zero id is
    // always applied. Strict `<` so a same-snapshot re-emit (e.g. a user-order
    // republish at the same venue id) still refreshes the overlay.
    const updateId = Number(result.bookUpdateId);
    if (Number.isFinite(updateId) && updateId > 0) {
      const key = String(pairId);
      const lastId = lastBookUpdateIdRef.current.get(key);
      if (lastId != null && updateId < lastId) return;
      lastBookUpdateIdRef.current.set(key, updateId);
    }

    // Step 1: Normalize and group data
    //
    // PREFER THE SERVER'S PRE-GROUPED LADDER. Grouping the 20 published levels
    // here collapses them into almost nothing at coarse steps - the top 20 BTC
    // levels span about $2.67, i.e. ONE bucket at a $10 step, which is why the
    // book used to render two rows and a column of dashes. The publisher now
    // aggregates over the whole cached book (~1000 levels) and sends the handful
    // of rows actually drawn. Local grouping stays as the fallback for a payload
    // that predates this, or a step the server did not send.
    // Remember which steps this venue actually publishes, so the dropdown offers
    // exactly those. Compared before writing: this runs on every tick and a new
    // array each time would re-render the whole panel at feed rate.
    if (result?.grouped) {
      const steps = Object.keys(result.grouped)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
      setServerSteps((prev) =>
        prev &&
        prev.length === steps.length &&
        prev.every((v, i) => v === steps[i])
          ? prev
          : steps
      );
    }

    const preGrouped =
      groupingStep > 0 ? result?.grouped?.[String(groupingStep)] : null;
    const rawBuy = preGrouped?.buyOrder || result.buyOrder || [];
    const rawSell = preGrouped?.sellOrder || result.sellOrder || [];
    // Server rows are ALREADY bucketed, so normalise them at step 0 - grouping a
    // second time would fold neighbouring buckets together.
    const localStep = preGrouped ? 0 : groupingStep;
    const normalizedBuy = normalizeOrderBookData(rawBuy, 'bid', localStep);
    const normalizedSell = normalizeOrderBookData(rawSell, 'ask', localStep);

    // Step 2: Merge user's open orders (for visual indicator)
    const mergedBuy = await mergeOrder(normalizedBuy, "buy");
    const mergedSell = await mergeOrder(normalizedSell, "sell");

    // Step 3: Recompute cumulative after merge (ensures correctness)
    const withCumulativeBuy = recomputeCumulative(mergedBuy, 'bid');
    const withCumulativeSell = recomputeCumulative(mergedSell, 'ask');

    // Step 4: Mark the levels whose SIZE moved, so the row can flash.
    //
    // Compared by PRICE, not by row position: at a coarse grouping the prices
    // are stable and the quantity inside a bucket is what moves, and a level
    // that merely shifts row (because a better one appeared) has not itself
    // changed. Quantity is the yardstick even when the display is showing the
    // quote value, since the two move together.
    //
    // `flashSeq` alternates parity on every paint, which is what actually
    // RESTARTS the CSS animation: the rows are keyed by position, so they
    // persist across repaints and re-applying the same class would do nothing.
    flashSeqRef.current += 1;
    const seq = flashSeqRef.current;
    const previousSizes = prevSizesRef.current;
    // Nothing to compare against on the first paint of a pair - flashing the
    // whole book because it just arrived would say "everything changed".
    const firstPaint = previousSizes.size === 0;
    const nextSizes = new Map<string, number>();
    const markChanged = (rows: any[], side: 'bid' | 'ask') =>
      rows.map((row: any) => {
        const key = side + ":" + row._id;
        const quantity = Number(row.quantity) || 0;
        nextSizes.set(key, quantity);
        const before = previousSizes.get(key);
        return !firstPaint && before !== undefined && before !== quantity
          ? { ...row, flashSeq: seq }
          : row;
      });
    const buyRows = markChanged(withCumulativeBuy, 'bid');
    const sellRows = markChanged(withCumulativeSell, 'ask');
    prevSizesRef.current = nextSizes;

    // Step 5: Update state
    setOrderBook({
      buyOrder: buyRows,
      sellOrder: sellRows,
    });
  }, [mergeOrder, normalizeOrderBookData, recomputeCumulative, groupingStep]);

  /**
   * Fetch initial orderbook snapshot
   */
  const fetchOrderBookSnapshot = useCallback(async (pairId: any) => {
    try {
      const { status, result } = await getOrderBook(pairId);
      if (status == "success") {
        await handleOrderBookData(result);
      }
    } catch (err) {
      // Silently handle errors
    }
  }, [handleOrderBookData]);

  // ============================================================
  // REPAINT THROTTLE  (how often the ladder is allowed to redraw)
  // ============================================================
  /**
   * The venue publishes off Binance's `@depth@100ms` stream, so up to ~10
   * payloads a second arrive per pair and every one of them used to repaint the
   * whole ladder - too fast to read, and needless work.
   *
   * Coalescing is safe here because each payload is a COMPLETE book:
   * handleOrderBookData REPLACES the ladder, it never merges deltas (see the
   * bookUpdateId guard there, which only ever rejects payloads that are OLDER
   * than the one already applied). So collapsing a burst and drawing only the
   * NEWEST loses no information - it draws the same truth less often, and the
   * normalize -> merge-user-orders -> recompute-cumulative pass runs twice a
   * second instead of ten times.
   *
   * Leading edge + trailing edge: the first tick after a quiet spell draws
   * immediately, and the last tick of a burst is always drawn, so the book can
   * never settle on a stale frame.
   *
   * TWO THINGS DELIBERATELY DO NOT WAIT:
   *   - `markUpdate()`, the liveness mark. It must see EVERY message or the
   *     staleness watchdog would resync a perfectly live feed.
   *   - a HEALTH TRANSITION. A book going dead must blank at once, and a
   *     recovering one must come back at once; health is a safety verdict, not
   *     a price tick.
   */
  const pendingTickRef = useRef<{ payload: any; healthy: boolean } | null>(null);
  const lastPaintedAtRef = useRef<number>(0);
  const lastPaintedHealthyRef = useRef<boolean | null>(null);
  const paintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The ladder derivation reached through a LATEST-REF rather than a closure.
   *
   * `handleOrderBookData` (and `fetchOrderBookSnapshot` with it) changes identity
   * whenever the user's open orders or the grouping step change - `mergeOrder`
   * depends on `openOrders`. Capturing it directly made `paintBook` ->
   * `queueBookPaint` -> the socket effect all churn with it, and that had two
   * consequences, one of them a bug:
   *
   *   1. THE BUG: the effect's cleanup cancelled the pending timer, so a frame
   *      already queued was DROPPED and never drawn. Measured: with a frame
   *      queued, dispatching an open-order change left the ladder showing the
   *      older frame indefinitely - exactly the "settles on a stale frame" the
   *      trailing edge exists to prevent.
   *   2. every open-order change also re-subscribed the socket and fired a fresh
   *      REST snapshot (3 order writes = 3 extra GETs).
   *
   * The ref always holds the CURRENT derivation, so a queued frame still lands
   * with the latest open-order merge - it just no longer takes the callback
   * identity, and the timer, down with it.
   */
  const handleBookRef = useRef(handleOrderBookData);
  const fetchSnapshotRef = useRef(fetchOrderBookSnapshot);
  useEffect(() => {
    handleBookRef.current = handleOrderBookData;
    fetchSnapshotRef.current = fetchOrderBookSnapshot;
  }, [handleOrderBookData, fetchOrderBookSnapshot]);

  const paintBook = useCallback((payload: any, healthy: boolean) => {
    pendingTickRef.current = null;
    lastPaintedAtRef.current = Date.now();
    lastPaintedHealthyRef.current = healthy;
    // Returned, not swallowed, so a caller (and the tests) can await the draw.
    return handleBookRef.current(payload);
  }, []);

  const queueBookPaint = useCallback(
    (payload: any) => {
      const healthy = readBookHealth({
        ...payload,
        pairId: payload?.pairId,
      }).healthy;

      pendingTickRef.current = { payload, healthy };

      // Health transition: draw now, cancelling any queued frame.
      if (lastPaintedHealthyRef.current !== healthy) {
        if (paintTimerRef.current) {
          clearTimeout(paintTimerRef.current);
          paintTimerRef.current = null;
        }
        return paintBook(payload, healthy);
      }

      // A frame is already queued; it will pick up this payload as the newest.
      if (paintTimerRef.current) return;

      const wait = BOOK_REPAINT_INTERVAL_MS - (Date.now() - lastPaintedAtRef.current);
      if (wait <= 0) {
        return paintBook(payload, healthy);
      }

      paintTimerRef.current = setTimeout(() => {
        paintTimerRef.current = null;
        const next = pendingTickRef.current;
        if (next) paintBook(next.payload, next.healthy);
      }, wait);
    },
    [paintBook]
  );

  // ============================================================
  // ORDERBOOK RESYNC HOOK
  // ============================================================
  const isSubscribedPair =
    !isEmpty(tradePair?._id) &&
    (tradePair?.botstatus == "bot" || tradePair?.botstatus == "binance");

  const { markUpdate, isStale } = useOrderBookResync({
    pairId: tradePair?._id || "",
    botstatus: tradePair?.botstatus,
    isEnabled: isSubscribedPair,
    onResyncComplete: handleOrderBookData,
    staleThreshold: 3, // Resync if no message for 3 seconds
  });

  // ============================================================
  // EFFECTIVE HEALTH  (published verdict + "are we still hearing it")
  // ============================================================

  /**
   * A book we have stopped receiving is no more tradeable than one the backend
   * has declared dead — the payload just never arrives to say so. Fold that in
   * here so there is exactly ONE notion of "is this book usable" in the UI.
   */
  const effectiveHealth: BookHealth = useMemo(() => {
    if (isSubscribedPair && isStale) {
      return {
        healthy: false,
        reason: "connection_lost",
        ladderPresent: false,
        pairId: String(tradePair?._id || ""),
        pending: false,
      };
    }
    // A pair we never subscribe to (the old ungated non-binance path) will never
    // produce a payload, so "pending" would be permanent. Publish a settled
    // healthy verdict for it instead: it is ungated by design, not unknown.
    if (!isSubscribedPair && health.pending) {
      return { ...DEFAULT_BOOK_HEALTH, pairId: String(tradePair?._id || "") };
    }
    return health;
  }, [health, isStale, isSubscribedPair, tradePair?._id]);

  const healthCopy = describeBookHealth(effectiveHealth);
  // A ladder is only worth drawing once we have a verdict AND it is good.
  const bookUsable = effectiveHealth.healthy && !effectiveHealth.pending;

  // Publish the verdict so the order ticket (and anything else) can refuse to
  // submit an order that cannot fill. The reducer drops no-op writes, so this
  // firing on every 1s republish costs nothing.
  //
  // Only the owning instance writes — see `publishHealth`. A second writer does
  // not add information, it only adds a race.
  useEffect(() => {
    if (!publishHealth) return;
    dispatch(
      setBookHealth({
        ...effectiveHealth,
        pairId: effectiveHealth.pairId || String(tradePair?._id || ""),
      })
    );
  }, [dispatch, effectiveHealth, tradePair?._id, publishHealth]);

  // Switching pairs must not carry the previous pair's verdict across, and must
  // not invent a healthy one either — go back to "not heard yet" and let the
  // first payload for the new pair (<= 1s away) settle it.
  useEffect(() => {
    setHealth(pendingBookHealth(tradePair?._id));
  }, [tradePair?._id]);

  // ============================================================
  // ORDERBOOK SOCKET HANDLER
  // ============================================================
  useEffect(() => {
    const socket = socketRef.current;
    const currentPairId = pairIdRef.current;

    if (!socket || isEmpty(currentPairId)) return;

    // Only set up subscription for bot/binance pairs
    if (tradePair.botstatus !== "bot" && tradePair.botstatus !== "binance") {
      return;
    }

    const handleOrderBookMessage = async (result: any) => {
      // Compare against the ref AS THE MESSAGE ARRIVES, not against a value
      // copied out of it when we subscribed. The two are not the same thing: a
      // pair switch between two pairs that happen to share `secondFloatDigit`
      // leaves every callback in this effect identical, so the effect does not
      // re-run, and a captured id would go on filtering for the pair the user
      // left — dropping every payload for the pair actually on screen.
      if (result.pairId === pairIdRef.current) {
        // Liveness FIRST and unthrottled: the watchdog is asking "is the feed
        // alive", which is true of every message, not only the ones we draw.
        markUpdate();
        // ...and the draw itself is coalesced to BOOK_REPAINT_INTERVAL_MS.
        await queueBookPaint(result);
      }
    };

    // Subscribe to orderbook updates
    socket.on("orderBook", handleOrderBookMessage);

    // Fetch the snapshot for whichever pair we just (re)subscribed for. This is
    // what makes a pair switch resolve in ~1s instead of waiting for the
    // staleness watchdog to notice and go get one. Through the ref, so this
    // effect does not re-subscribe (and re-fetch) on every open-order change.
    fetchSnapshotRef.current(currentPairId);

    return () => {
      socket.off("orderBook", handleOrderBookMessage);
      // Drop any queued frame: on a pair switch it belongs to the pair being
      // left, and on unmount there is nothing to draw it onto.
      if (paintTimerRef.current) {
        clearTimeout(paintTimerRef.current);
        paintTimerRef.current = null;
      }
      pendingTickRef.current = null;
      // Let the first payload of the NEW pair draw immediately rather than
      // waiting out the previous pair's interval.
      lastPaintedAtRef.current = 0;
      lastPaintedHealthyRef.current = null;
    };
  }, [
    tradePair.botstatus,
    // A pair change must pull a fresh snapshot; without this the effect only
    // re-runs by accident, when some unrelated callback identity happens to
    // change with it.
    tradePair?._id,
    // queueBookPaint and markUpdate are both stable, and the snapshot fetch goes
    // through a ref, so this effect now re-runs ONLY on a real pair/botstatus
    // change - never on an open-order or grouping change. That is what keeps a
    // queued frame from being cancelled mid-flight; see the latest-ref note above.
    queueBookPaint,
    markUpdate,
  ]);
  // Note: marketData is deliberately NOT a dependency — refs keep the
  // subscription stable across ticker updates.

  // ============================================================
  // SOCKET RECONNECT HANDLER
  // ============================================================
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const handleReconnect = () => {
      const currentPairId = pairIdRef.current;
      if (!isEmpty(currentPairId) && (tradePair.botstatus === "bot" || tradePair.botstatus === "binance")) {
        console.log("[OrderBook] Socket reconnected, resyncing orderbook");
        fetchSnapshotRef.current(currentPairId);
      }
    };

    // `reconnect` is a MANAGER event in socket.io-client v4, not a Socket event:
    // it is emitted by `this.emitReserved("reconnect", attempt)` in manager.js,
    // and the Socket's RESERVED_EVENTS list is only connect / connect_error /
    // disconnect / disconnecting. `socket.on("reconnect", ...)` therefore never
    // fired, and since this component registers no "connect" listener either,
    // the order book had NO resync path at all - after a network blip it kept
    // rendering whatever was last pushed until the next delta arrived.
    // `socket.io` is the Manager, which is where the event actually lives.
    // Optional-chained on purpose. This runs inside a useEffect, so a socket
    // handed in without a manager (a partial test double, or a context default
    // that is still the placeholder "") would throw during render and take the
    // whole trading screen down rather than merely losing the resync.
    const manager = socket.io;
    manager?.on("reconnect", handleReconnect);

    return () => {
      manager?.off("reconnect", handleReconnect);
    };
    // Same reasoning as the subscription effect: the fetch goes through a ref so
    // this listener is not torn down and re-added on every open-order change.
  }, [tradePair.botstatus]);

  // ============================================================
  // HELPERS
  // ============================================================

  // Helper to convert value to USD
  const convertToUSD = (value: number) => {
    if (tradePair.secondCurrencySymbol === "USDT" || tradePair.secondCurrencySymbol === "USD") {
      return value; // Already in USD/USDT
    }
    // Find conversion rate to USD
    const conversion = priceConversion?.find(
      (item: any) => item.baseSymbol === tradePair.secondCurrencySymbol && item.convertSymbol === "USDT"
    );
    return conversion?.convertPrice ? value * conversion.convertPrice : value;
  };

  // Helper to render ask rows (always 8)
  // Render the 8 rows for one side. Asks display worst(highest)->best(lowest) so
  // the spread meets in the middle; bids best->worst. Depth bars grow from the
  // RIGHT on both sides, width proportional to the cumulative base quantity.
  const renderSide = (orders: any[], side: "ask" | "bid") => {
    const rows: any[] = [];
    const list = orders?.slice(0, 8) || [];
    const cumVals = list.map((r: any) => r.cumulativeQuantity || 0);
    const maxCum = Math.max(...cumVals, 0);
    const minCum = cumVals.length ? Math.min(...cumVals) : 0;
    const range = maxCum - minCum;
    const compressed = maxCum > 0 && range > 0 && range / maxCum < 0.05;
    const priceColor = side === "ask" ? OB.red : OB.green;
    const barColor = side === "ask" ? OB.redBar : OB.greenBar;

    for (let i = 0; i < 8; i++) {
      const item = side === "ask" ? list[7 - i] : list[i];
      const key = side + "-" + i;
      if (item && toFixed(item?.quantity, baseDigits) > 0) {
        // Base coin or its quote value, per the unit selector. Both cumulatives
        // are already computed upstream, so switching is a render choice only.
        const cumSize =
          (sizeUnit === "base"
            ? item.cumulativeQuantity
            : item.cumulativeNotional) || 0;
        const size = (sizeUnit === "base" ? item.quantity : item.notional) || 0;
        // Quote amounts are money: 2dp reads better than the base coin's 6-8.
        const sizeDigits = sizeUnit === "base" ? baseDigits : 2;
        let t = 0;
        if (compressed && range > 0) t = (cumSize - minCum) / range;
        else if (maxCum > 0) t = cumSize / maxCum;
        const barWidth = 2 + Math.pow(Math.min(t, 1), 0.6) * 98;
        const price = item?.status == "open" ? item.price : item._id;
        // Alternating class names are what restart the animation: the row
        // element persists across repaints, so re-adding the SAME class is a
        // no-op to the CSS engine.
        const flashClass = !item.flashSeq
          ? ""
          : side === "bid"
            ? item.flashSeq % 2
              ? spot.ob_flash_bid_a
              : spot.ob_flash_bid_b
            : item.flashSeq % 2
              ? spot.ob_flash_ask_a
              : spot.ob_flash_ask_b;
        rows.push(
          <div
            key={key}
            className={`${spot.ob_row} ${flashClass}`}
            onClick={() =>
              dispatch(
                setOrderBookPrice(toFixed(item._id, tradePair.secondFloatDigit))
              )
            }
          >
            <div
              className={spot.ob_row_bar}
              style={{ width: barWidth + "%", background: barColor }}
            />
            <div
              className={spot.tabular_nums}
              style={{ position: "relative", color: priceColor, textAlign: "left" }}
            >
              {item?.status == "open" && <span style={{ marginRight: 3 }}>&rarr;</span>}
              {formatPrice(price, tradePair?.secondFloatDigit, "—")}
            </div>
            <div
              className={spot.tabular_nums}
              style={{ position: "relative", color: OB.num, textAlign: "right" }}
            >
              {formatQty(size, sizeDigits, "—")}
            </div>
            <div
              className={spot.tabular_nums}
              style={{ position: "relative", color: OB.num, textAlign: "right" }}
            >
              {formatQty(cumSize, sizeDigits, "—")}
            </div>
          </div>
        );
      } else {
        rows.push(
          <div
            key={key}
            className={spot.ob_row}
            style={{ color: OB.dim, cursor: "default" }}
          >
            <div style={{ position: "relative", textAlign: "left" }}>—</div>
            <div style={{ position: "relative", textAlign: "right" }}>—</div>
            <div style={{ position: "relative", textAlign: "right" }}>—</div>
          </div>
        );
      }
    }
    return rows;
  };

  // Calculate buy/ask ratio
  const calculateRatio = () => {
    let buyVol = 0;
    let askVol = 0;

    buyOrder?.forEach((item: any) => {
      if (item?.quantity) buyVol += parseFloat(item.quantity);
    });

    sellOrder?.forEach((item: any) => {
      if (item?.quantity) askVol += parseFloat(item.quantity);
    });

    const total = buyVol + askVol;
    if (total === 0) return { buyPercent: 50, askPercent: 50 };

    const buyPercent = (buyVol / total) * 100;
    const askPercent = (askVol / total) * 100;

    return {
      buyPercent: Math.round(buyPercent * 100) / 100,
      askPercent: Math.round(askPercent * 100) / 100,
    };
  };

  const { buyPercent, askPercent } = calculateRatio();

  // Best bid / best ask off the top of each displayed side (both are stored
  // best-first) for the mid-price + spread readout that sits between the two
  // sides, the way the reference book reads.
  const bestBid = Number(buyOrder?.[0]?._id);
  const bestAsk = Number(sellOrder?.[0]?._id);
  const hasTop =
    Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0 && bestAsk > 0;
  const midPrice = hasTop ? (bestBid + bestAsk) / 2 : null;
  // clamp at 0: the backend guards against a crossed published book, but a
  // defensive floor means an unexpected cross can never print a negative spread.
  const spreadAbs = hasTop ? Math.max(0, bestAsk - bestBid) : null;
  const spreadPct =
    midPrice != null && spreadAbs != null ? (spreadAbs / midPrice) * 100 : null;

  return (
    <>
      <div className={spot.orderbook_wrap}>
        {/* Tabs: Order Book / Trades, with a kebab menu - reference layout. */}
        <div className={spot.ob_tabs_row}>
          <div className={spot.ob_tabs}>
            <button
              className={panelTab === "book" ? spot.ob_tab_active : spot.ob_tab}
              onClick={() => setPanelTab("book")}
            >
              Order Book
            </button>
            <button
              className={panelTab === "trades" ? spot.ob_tab_active : spot.ob_tab}
              onClick={() => setPanelTab("trades")}
            >
              Trades
            </button>
          </div>
          <button className={spot.ob_kebab} title="More" aria-label="More">
            &#8942;
          </button>
        </div>

        {panelTab === "trades" ? (
          <div className={spot.ob_trades_host}>
            <RecentTrade />
          </div>
        ) : (
          <>
            {bookUsable && (
              <div className={spot.ob_controls}>
                <span className={spot.ob_dd_group}>
                  <select
                    className={spot.ob_dd_select}
                    data-testid="orderbook-grouping"
                    value={groupingStep}
                    onChange={(e) => {
                      userPickedStepRef.current = true;
                      setGroupingStep(Number(e.target.value));
                    }}
                    aria-label="Price grouping"
                  >
                    {groupOptions.map((g) => (
                      <option key={g} value={g}>
                        {g === 0 ? tickLabel : g}
                      </option>
                    ))}
                  </select>
                  <StepperChevron />
                </span>
                <button
                  type="button"
                  className={spot.ob_dd}
                  data-testid="orderbook-unit-toggle"
                  aria-label={`Show sizes in ${
                    sizeUnit === "base" ? quoteSymbol : baseSymbol
                  }`}
                  title={`Showing ${unitSymbol} - click for ${
                    sizeUnit === "base" ? quoteSymbol : baseSymbol
                  }`}
                  onClick={() =>
                    setSizeUnit((u) => (u === "base" ? "quote" : "base"))
                  }
                >
                  <span>{unitSymbol}</span>
                  <StepperChevron />
                </button>
                <button
                  className={spot.ob_view_btn}
                  onClick={() =>
                    setView(
                      view === "all" ? "sell" : view === "sell" ? "buy" : "all"
                    )
                  }
                  title="Toggle side view"
                  aria-label="Toggle side view"
                >
                  <span
                    className={spot.ob_view_ask}
                    style={{ opacity: view === "buy" ? 0.25 : 1 }}
                  />
                  <span
                    className={spot.ob_view_bid}
                    style={{ opacity: view === "sell" ? 0.25 : 1 }}
                  />
                </button>
              </div>
            )}

            <div className={spot.orderbook_wrap_inner} id="spotOrderbook">
              {!bookUsable ? (
                <div
                  className={spot.orderbook_status}
                  role="status"
                  aria-live="polite"
                  data-testid="orderbook-status"
                  data-health-reason={
                    effectiveHealth.pending
                      ? "awaiting_book"
                      : effectiveHealth.reason || ""
                  }
                >
                  <span
                    className={`${spot.orderbook_status_dot} ${
                      healthCopy.transient ? spot.orderbook_status_dot_pulse : ""
                    }`}
                    aria-hidden="true"
                  />
                  <div className={spot.orderbook_status_title}>
                    {healthCopy.title}
                  </div>
                  <p className={spot.orderbook_status_detail}>
                    {healthCopy.detail}
                  </p>
                </div>
              ) : (
                <>
                  <div className={spot.ob_colhead}>
                    <div style={{ textAlign: "left" }}>PRICE</div>
                    <div style={{ textAlign: "right" }}>SIZE</div>
                    <div style={{ textAlign: "right" }}>TOTAL</div>
                  </div>
                  <div className={spot.ob_colhead_units}>
                    <div style={{ textAlign: "left" }}>
                      {tradePair?.secondCurrencySymbol}
                    </div>
                    <div style={{ textAlign: "right" }}>{unitSymbol}</div>
                    <div style={{ textAlign: "right" }}>{unitSymbol}</div>
                  </div>

                  <div
                    className={`${spot.orderlist_container} ${
                      view == "sell" ? spot.show_sell : ""
                    } ${view == "buy" ? spot.show_buy : ""} `}
                  >
                    {(view == "sell" || view == "all") && (
                      <div className={`${spot.orderbook_list} ${spot.orderbook_ask}`}>
                        <div className={spot.orderbook_list_container}>
                          {renderSide(sellOrder, "ask")}
                        </div>
                      </div>
                    )}

                    <div className={spot.ob_midrow}>
                      <span className={spot.ob_mid_label}>
                        Mid:{" "}
                        <b className={spot.tabular_nums}>
                          {midPrice != null
                            ? formatPrice(midPrice, tradePair?.secondFloatDigit, "—")
                            : "—"}
                        </b>
                      </span>
                      <span className={spot.ob_spread_label}>
                        Spread:{" "}
                        {spreadAbs != null
                          ? formatPrice(spreadAbs, tradePair?.secondFloatDigit, "—")
                          : "—"}{" "}
                        / {spreadPct != null ? spreadPct.toFixed(2) : "—"}%
                      </span>
                    </div>

                    {(view == "buy" || view == "all") && (
                      <div className={`${spot.orderbook_list} ${spot.orderbook_bid}`}>
                        <div className={spot.orderbook_list_container}>
                          {renderSide(buyOrder, "bid")}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className={spot.ob_ratio}>
                    <div
                      className={spot.ob_ratio_bid}
                      style={{ flex: Math.max(buyPercent, 1) }}
                    >
                      Bid {buyPercent.toFixed(2)}%
                    </div>
                    <div
                      className={spot.ob_ratio_ask}
                      style={{ flex: Math.max(askPercent, 1) }}
                    >
                      {askPercent.toFixed(2)}% Ask
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
