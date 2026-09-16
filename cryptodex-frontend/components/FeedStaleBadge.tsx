import React from "react";
import spot from "@/styles/Spot.module.css";
import { useSelector } from "../store";

/**
 * "NOT LIVE" — the one honest label for ticker-derived numbers when the venue
 * feed has gone silent.
 *
 * It takes a `market` and reads `state[market].tickerStale` rather than
 * hard-coding spot. Spot is the only caller today, but the parameter stays
 * rather than being inlined: it is what keeps the badge reading the SLICE THAT
 * WENT QUIET instead of a slice chosen at authoring time, which is the mistake
 * the per-market scoping exists to prevent.
 *
 * WHY THIS IS SEPARATE FROM THE ORDER BOOK VERDICT
 * The order book has its own gate (lib/orderBookHealth.ts) because a purged
 * ladder means orders cannot fill. That fault does NOT make the last traded
 * price, the 24H stats or the trade log false — they are the venue tick, and
 * they keep arriving. So the book blanking itself while the header keeps
 * ticking is correct, not a contradiction.
 *
 * A DEAD FEED is different: nothing is arriving, and every ticker-derived
 * number on the page is frozen at whatever it was when the feed died while
 * still being painted as the current market. That is the case this badge
 * covers, and it is driven by the ticker's own silence (`<market>.tickerStale`,
 * written by the market's MarketPrice component), never by the book's verdict.
 *
 * Deliberately a label, not a blanking: unlike the book, a frozen price with an
 * honest "not live" is still useful information. Hiding it would remove context
 * without adding truth.
 */
export type FeedMarket = string;

export default function FeedStaleBadge({
  market = "spot",
  className = "",
}: {
  market?: FeedMarket;
  className?: string;
}) {
  const tickerStale = useSelector((state: any) => state?.[market]?.tickerStale);
  if (!tickerStale) return null;
  return (
    <span
      className={`${spot.feed_stale_badge} ${className}`.trim()}
      role="status"
      aria-live="polite"
      data-testid="feed-stale-badge"
      title="The market feed has gone quiet. These values are the last ones received and are not updating."
    >
      Not live
    </span>
  );
}
