/**
 * ORDER BOOK HEALTH — the single place the backend's verdict becomes English.
 *
 * spotapi/controllers/bookPublish.controller.js publishes every "orderBook"
 * payload (socket AND the REST snapshot) through one health gate. When nothing
 * can fill, the payload arrives with `healthy: false`, empty ladders and a
 * machine-readable `healthReason`. The UI used to throw all three fields away,
 * so a purged ladder rendered as an unexplained blank book with a fully enabled
 * Buy/Sell ticket — an order the user could submit that could not possibly fill.
 *
 * Everything that consumes the payload reads it through `readBookHealth`, and
 * everything that shows it to a person reads `describeBookHealth`. Nothing
 * renders the raw enum.
 */

/** Reasons the backend can publish, plus the one the client derives itself. */
export type BookHealthReason =
  | "no_depth"
  | "stale_depth"
  | "empty_side"
  | "crossed_book"
  | "price_deviation"
  | "pair_ineligible"
  | "no_admin_liquidity"
  | "ladder_not_built"
  | "ladder_stale"
  | "ladder_orphaned"
  | "error"
  | "no_pair"
  /** Client-side: no payload at all for a while (socket died / backend down). */
  | "connection_lost";

export interface BookHealth {
  healthy: boolean;
  reason: BookHealthReason | null;
  ladderPresent: boolean;
  /** Which pair this verdict describes; "" when unknown. */
  pairId: string;
  /**
   * True when NOTHING has been observed for `pairId` yet — a placeholder, not a
   * verdict. `healthy` is optimistic here purely so nothing renders an error;
   * anything that can send an order must treat pending as "not yet known" and
   * hold, because "we have not heard" is not the same as "it is fine".
   */
  pending: boolean;
}

export const DEFAULT_BOOK_HEALTH: BookHealth = {
  healthy: true,
  reason: null,
  ladderPresent: true,
  pairId: "",
  pending: false,
};

/** The "we have not heard about this pair yet" placeholder. */
export function pendingBookHealth(pairId: string | undefined | null): BookHealth {
  return {
    healthy: true,
    reason: null,
    ladderPresent: true,
    pairId: pairId ? String(pairId) : "",
    pending: true,
  };
}

/**
 * Read the health fields off an "orderBook" payload.
 *
 * A payload with NO `healthy` field is treated as healthy on purpose: only the
 * gated publisher sets it, and non-binance ("bot") pairs still come down the
 * old ungated path. Blocking those would be a regression, so we react to an
 * explicit `false` and nothing else.
 */
export function readBookHealth(payload: any): BookHealth {
  const healthy = payload?.healthy !== false;
  const rawReason = payload?.healthReason;
  // An unhealthy payload with no usable reason still has to say something, so
  // it falls back to the generic "error" copy rather than rendering nothing.
  const reason: BookHealthReason | null = healthy
    ? null
    : typeof rawReason === "string" && rawReason !== ""
      ? (rawReason as BookHealthReason)
      : "error";
  return {
    healthy,
    reason,
    ladderPresent: payload?.ladderPresent !== false,
    pairId: payload?.pairId ? String(payload.pairId) : "",
    // A payload IS the observation, so it is never pending.
    pending: false,
  };
}

export interface BookHealthCopy {
  /** Headline for the order book panel. */
  title: string;
  /** One calm supporting line. */
  detail: string;
  /** Compact clause for the order ticket, reads after "Trading paused — ". */
  short: string;
  /** true when we expect this to clear on its own in seconds. */
  transient: boolean;
}

const COPY: Record<BookHealthReason, BookHealthCopy> = {
  no_depth: {
    title: "Waiting for market data",
    detail: "The price feed is still connecting. This usually takes a moment.",
    short: "waiting for market data",
    transient: true,
  },
  stale_depth: {
    title: "Market data is stale",
    detail: "Reconnecting to the price feed — the book will fill back in shortly.",
    short: "market data is stale",
    transient: true,
  },
  connection_lost: {
    title: "Reconnecting",
    detail: "We stopped hearing from the market feed. Trying again automatically.",
    short: "reconnecting to the market feed",
    transient: true,
  },
  empty_side: {
    title: "Waiting for market data",
    detail: "One side of the book is empty, so there is nothing to trade against yet.",
    short: "waiting for market data",
    transient: true,
  },
  crossed_book: {
    title: "Market data looks wrong",
    detail: "Trading is paused until the quotes make sense again.",
    short: "market data looks wrong",
    transient: true,
  },
  price_deviation: {
    title: "Market data looks wrong",
    detail: "Prices are too far from the market, so trading is paused for now.",
    short: "market data looks wrong",
    transient: true,
  },
  no_admin_liquidity: {
    title: "No liquidity available right now",
    detail: "There is nothing to trade against at the moment. It should be back soon.",
    short: "no liquidity available",
    transient: false,
  },
  ladder_not_built: {
    title: "No liquidity available right now",
    detail: "The book is still being built for this pair. Hang tight.",
    short: "no liquidity available",
    transient: true,
  },
  ladder_stale: {
    title: "No liquidity available right now",
    detail: "The book has not refreshed recently, so orders could not fill.",
    short: "no liquidity available",
    transient: false,
  },
  ladder_orphaned: {
    title: "No liquidity available right now",
    detail: "There is nothing to trade against at the moment. It should be back soon.",
    short: "no liquidity available",
    transient: false,
  },
  pair_ineligible: {
    title: "This pair is not trading right now",
    detail: "Pick another pair — the rest of the market is unaffected.",
    short: "this pair is not trading",
    transient: false,
  },
  no_pair: {
    title: "This pair is not available",
    detail: "Pick another pair from the list to keep trading.",
    short: "this pair is not available",
    transient: false,
  },
  error: {
    title: "Order book unavailable",
    detail: "Something went wrong on our side. It should recover on its own.",
    short: "the order book is unavailable",
    transient: true,
  },
};

const FALLBACK: BookHealthCopy = COPY.error;

/**
 * Copy for the placeholder state: we have asked about this pair and the first
 * payload has not landed yet (page load, pair switch). It is not a fault, so it
 * never reads like one.
 */
export const AWAITING_BOOK_COPY: BookHealthCopy = {
  title: "Loading the order book",
  detail: "Fetching the book for this pair. This takes about a second.",
  short: "loading the order book",
  transient: true,
};

/** Translate a verdict into something a person understands. */
export function describeBookHealth(health: BookHealth | null | undefined): BookHealthCopy {
  // "Not heard yet" is its own state — never the generic error copy.
  if (health?.pending && health.healthy) return AWAITING_BOOK_COPY;
  const reason = health?.reason;
  if (!reason) return FALLBACK;
  // COPY is keyed by the reasons we know about. A reason the backend adds later
  // is still a string we have no copy for, so it degrades to the generic
  // explanation rather than leaking the raw enum or rendering nothing.
  return COPY[reason] || FALLBACK;
}

/**
 * The verdict as it applies to `pairId`.
 *
 * A verdict belonging to a DIFFERENT pair says nothing about this one — it is
 * neither proof that this pair is broken nor proof that it is fine. It comes
 * back as `pending` so the caller can hold briefly instead of assuming either.
 * (It used to come back healthy, which is how the ~1s after a pair switch left
 * the ticket fully enabled with no verdict behind it.)
 */
export function healthForPair(
  health: BookHealth | null | undefined,
  pairId: string | undefined | null
): BookHealth {
  // No pair on screen: there is nothing to trade and nothing to gate.
  if (!pairId) return DEFAULT_BOOK_HEALTH;
  if (!health) return pendingBookHealth(pairId);
  if (String(health.pairId) !== String(pairId)) return pendingBookHealth(pairId);
  return health;
}

/** True when the two verdicts say exactly the same thing. */
export function sameHealth(a: BookHealth, b: BookHealth): boolean {
  return (
    a.healthy === b.healthy &&
    a.reason === b.reason &&
    a.ladderPresent === b.ladderPresent &&
    a.pairId === b.pairId &&
    !!a.pending === !!b.pending
  );
}
