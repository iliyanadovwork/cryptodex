import { useEffect, useState } from "react";
import { useSelector } from "@/store";
import {
  BookHealth,
  BookHealthCopy,
  describeBookHealth,
  healthForPair,
} from "@/lib/orderBookHealth";

/**
 * How long the ticket waits for the first verdict of a pair before deciding the
 * silence is legitimate and enabling itself anyway.
 *
 * The book republishes about once a second and OrderBook.tsx also pulls a REST
 * snapshot the moment a pair mounts, so a real verdict is ~1s away. Three
 * seconds is several missed publishes — long enough that we are clearly not
 * getting one, and short enough that a user who switched pairs and started
 * typing an amount has not reached the Buy button yet.
 */
export const PENDING_VERDICT_GRACE_MS = 3000;

interface SpotBookHealth {
  /** The verdict, as it applies to the pair currently on screen. */
  health: BookHealth;
  /** Human copy for that verdict. */
  copy: BookHealthCopy;
  /** True when an order placed now could not fill, or when we cannot yet tell. */
  tradingPaused: boolean;
  /** True for the narrower case: no verdict for this pair has arrived yet. */
  awaitingVerdict: boolean;
  /** One short line to sit above a disabled Buy/Sell button. */
  note: string;
}

/**
 * The order book verdict, for anything that can submit a spot order.
 *
 * OrderBook.tsx writes `spot.bookHealth` from the published payload (see
 * lib/orderBookHealth.ts). Reading it here is what keeps the Buy/Sell ticket
 * from cheerfully accepting an order into a book with nothing on the other
 * side — and, because it is plain redux state, the ticket re-enables itself the
 * instant a healthy payload lands. No refresh, no polling.
 *
 * Two states pause the ticket, and they are not the same thing:
 *
 *   1. An explicit `healthy: false` for THIS pair — the backend has told us
 *      nothing can fill. Stays paused until a healthy payload replaces it.
 *   2. `pending` — page load or a pair switch, and no payload for this pair has
 *      arrived yet. We do not know, so we hold... but only for
 *      PENDING_VERDICT_GRACE_MS. A pair that is legitimately ungated (the old
 *      non-binance "bot" path never publishes a verdict at all) must not be
 *      locked out forever by a payload that is never coming, so the grace
 *      window expires and the ticket opens. Failing open after a bounded wait
 *      is the same trade the payload reader makes for a missing `healthy` field.
 */
export function useSpotBookHealth(): SpotBookHealth {
  const { bookHealth, tradePair } = useSelector((state: any) => state.spot);
  const pairId = tradePair?._id ? String(tradePair._id) : "";
  const health = healthForPair(bookHealth, pairId);
  const copy = describeBookHealth(health);

  // Bounded wait for the first verdict of this pair.
  const isPending = !!health.pending;
  const [graceExpired, setGraceExpired] = useState(false);
  useEffect(() => {
    if (!isPending) {
      setGraceExpired(false);
      return;
    }
    setGraceExpired(false);
    const timer = setTimeout(() => setGraceExpired(true), PENDING_VERDICT_GRACE_MS);
    return () => clearTimeout(timer);
    // Restart the wait whenever the pair changes or we go back to not knowing.
  }, [isPending, pairId]);

  const awaitingVerdict = isPending && !graceExpired;
  const tradingPaused = !health.healthy || awaitingVerdict;

  const note = awaitingVerdict
    ? `${copy.title} — the ticket unlocks as soon as the book reports.`
    : `Trading paused — ${copy.short}. This re-enables on its own.`;

  return {
    health,
    copy,
    tradingPaused,
    awaitingVerdict,
    note,
  };
}
