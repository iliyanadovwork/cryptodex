/**
 * FILL CANARY - continuous proof that spot can still fill an order RIGHT NOW.
 *
 * WHY THIS EXISTS
 * Spot stopped filling for 5.5 hours and nothing noticed: every service was up,
 * the UI rendered a book, no error was logged and every test passed. Tests pass
 * against mocks; what broke was LIVE liquidity. Uptime checks answer "is the
 * process alive", not "can a user's order actually trade", and those are
 * different questions. This module answers the second one, on an interval, and
 * screams when the answer is no.
 *
 * MECHANISM: NON-COMMITTING DRY RUN ("shadow fill")
 * Every cycle the canary reads the live resting book out of redis and walks it
 * exactly as a market order would - best price first, consuming each order's
 * live remaining `quantity` -
 * to see whether a small probe would fully fill. It then throws the result away.
 *
 * It performs ZERO writes. No hset, no hdel, no wallet mutation, no mongo
 * insert. That is the entire safety argument, and it holds structurally rather
 * than by discipline:
 *   - it cannot pollute a real user's balances: it never touches
 *     walletbalance_spot / _inOrder;
 *   - it cannot leave a resting order behind: it never creates one, so there is
 *     no cleanup path that can fail and no crash window that can strand one;
 *   - it cannot distort trade history, recent trades, chart volume or the paper
 *     ladder: nothing it does is observable to a user at all;
 *   - a bug in the canary can therefore damage system state only by throwing,
 *     and every entry point catches.
 *
 * The alternatives were considered and rejected:
 *   - a dedicated canary ACCOUNT placing a real self-cancelling probe would
 *     consume real ladder liquidity, print rows into tradeHistory (which the
 *     recent-trades panel and the volume charts both read), move its own
 *     balances, and - the disqualifier - could strand a resting order if the
 *     process died between place and cancel. That is the exact class of user
 *     visible damage the brief rules out.
 *   - a full dry-run through the real matcher (tradeMatching) cannot be done
 *     without committing: it settles as it goes, there is no rehearsal mode,
 *     and adding one would mean editing files another agent owns this round.
 *
 * WHAT THE DRY RUN CANNOT SEE, AND HOW THAT GAP IS CLOSED
 * A dry run proves the liquidity is there; it does not prove the engine is
 * turning. So liveness is checked independently, from evidence the matcher
 * leaves behind: the paper ladder is rewritten synchronously at the top of
 * matchingcall() on a 2s cron, so a ladder older than LADDER_STALE_MS means
 * the matcher is not running even if the book looks perfect. Between the two
 * checks the canary covers everything a live probe order would have proved.
 *
 * ROOT-CAUSE ORDER
 * Checks run cheapest-and-deepest first (pair eligibility -> depth feed ->
 * ladder -> simulated fill) so the reported verdict is the CAUSE and not a
 * symptom. A dead depth feed reports "stale_depth", not the "no_ladder" it
 * inevitably produces one cycle later.
 *
 * NO SECOND COPY OF ANY RULE
 * The canary is a monitor, so every rule it reports on is IMPORTED from the
 * thing it monitors, never restated here:
 *   "is this depth usable"  -> lib/depthHealth.assessDepthHealth (thresholds
 *                              included: DEPTH_STALE_MS and
 *                              PRICE_DEVIATION_GUARD used to be re-declared in
 *                              this file, under a comment claiming they were
 *                              shared - which is the exact bug class the shared
 *                              gate exists to eliminate);
 *   "where does depth come from" -> lib/depthSource.resolveDepthSnapshot, the
 *                              same resolver the ladder and the display use;
 *   "may this pair carry a ladder" -> paperBook.isPaperEligible;
 *   "why is the ladder gone"  -> paperBook.getLadderState, so the remedy names
 *                              the subsystem that actually failed;
 *   "how old may a ladder be" -> lib/depthHealth.LADDER_STALE_MS, the very
 *                              constant getLadderState expires the ladder on.
 *                              This file used to declare its own
 *                              SPOT_CANARY_LADDER_MAX_AGE_MS with the same
 *                              default, so raising the documented knob moved
 *                              the gate and left the MONITOR reporting against
 *                              15s - a canary that calls a ladder healthy after
 *                              the display and the order gate have condemned
 *                              it.
 */

// import controller
import { hgetall } from "./redis.controller.js";
// paperBook owns the definition of "may this pair carry a ladder at all" and
// the record of WHY a ladder is missing; re-deriving either here would let the
// canary and the matcher drift apart.
import { isPaperEligible, getLadderState } from "./paperBook.controller.js";
// import model
import { SpotPair, TradeHistory } from "../models/index.js";
// import lib
import { getDepthStreamHealth } from "../lib/binanceWebSocket.js";
import { resolveDepthSnapshot } from "../lib/depthSource.js";
import {
  assessDepthHealth,
  depthAgeMs,
  DEPTH_STALE_MS,
  LADDER_STALE_MS,
  PRICE_DEVIATION_GUARD,
} from "../lib/depthHealth.js";

// ---------------------------------------------------------------------------
// Tunables. Every one is env-overridable so an operator can tighten or loosen
// the canary without a deploy.
// ---------------------------------------------------------------------------

// How often the self-test runs. Minutes, not seconds: the point is to catch an
// outage in minutes instead of hours, and a tighter loop buys nothing while
// costing redis reads forever.
export const INTERVAL_MS = Number(process.env.SPOT_CANARY_INTERVAL_MS || 180000);
// The ladder is empty until the matcher's first cron tick, and depth needs the
// websocket/REST warm-up; alarming during boot would train operators to ignore
// the canary, which is worse than not having one.
const FIRST_RUN_DELAY_MS = Number(
  process.env.SPOT_CANARY_FIRST_RUN_DELAY_MS || 20000
);
// Probe size in QUOTE currency. Deliberately tiny: this asks "is there a
// working market here", not "how deep is it".
export const PROBE_NOTIONAL = Number(process.env.SPOT_CANARY_NOTIONAL || 10);
// The ladder is rewritten every 2s by matchingcall. Anything older than ~7
// ticks is not jitter, it is a matcher that has stopped. IMPORTED, not
// declared: see LADDER_STALE_MS in lib/depthHealth.js.
// An identical, unchanged failure re-logs at most this often. See emitVerdict.
const REPEAT_LOG_MS = Number(process.env.SPOT_CANARY_REPEAT_LOG_MS || 600000);
// /api/spot/health is unauthenticated, so it must be cheap under abuse: a burst
// of requests collapses onto one evaluation.
const HEALTH_CACHE_MS = Number(process.env.SPOT_CANARY_HEALTH_CACHE_MS || 2000);
// The last-fill lookup is the only mongo query in here; it is reported, never
// used for a verdict (an idle exchange is not a broken one).
const LAST_FILL_CACHE_MS = Number(
  process.env.SPOT_CANARY_LAST_FILL_CACHE_MS || 30000
);
// buildPaperOrders backdates orderDate by exactly this much, so
// orderDate + BACKDATE is the wall-clock instant the ladder was written.
const ORDER_BACKDATE_MS = 60000;

// ---------------------------------------------------------------------------
// State. All of it is in-process and disposable: losing it on restart costs one
// interval of history and nothing else.
// ---------------------------------------------------------------------------

let timer = null;
// Single-flight latch. The canary and an /api/spot/health request can both ask
// for an evaluation; without this a slow redis turns concurrent callers into a
// pile-up, which is how a monitor becomes the outage.
let evaluating = null;
let cachedSnapshot = null;
let cachedAt = 0;
let lastFillCache = { value: null, at: 0 };
// Per-subject log throttle: subject -> { reason, firstAt, lastLoggedAt, count }
const logState = new Map();

const canaryState = {
  enabled: false,
  lastRunAt: null,
  lastRunDurationMs: null,
  lastOkAt: null,
  lastVerdict: null,
  lastMessage: null,
  consecutiveFailures: 0,
  runs: 0,
};

// ---------------------------------------------------------------------------
// Verdicts and their remedies.
//
// Depth strings come from lib/depthHealth.js and ladder strings from
// paperBook's recorded purge reason, so a verdict here always names the
// subsystem that actually failed. The canary is only allowed to INVENT a
// verdict for the things it alone measures (matcher liveness, probe depth).
// ---------------------------------------------------------------------------

const REMEDY = {
  no_pairs:
    "no pair is configured with botstatus=binance, so no pair has a liquidity source at all. Check the spotpair collection.",
  no_depth:
    "no Binance L2 depth in memory or in redis for this pair. The depth websocket and the 30s REST snapshot are both failing - check lib/binanceWebSocket.js connections.",
  stale_depth:
    "the Binance depth feed has stopped updating. paperBook purges the ladder in this state, so NOTHING can fill until the feed recovers - check the depth websocket and its REST fallback.",
  empty_side:
    "the depth snapshot has an empty bid or ask side, so half the book cannot be quoted. Usually a partial/torn snapshot - force a REST refresh.",
  crossed_book:
    "best ask <= best bid in the depth snapshot; the feed is corrupt and the ladder is purged on purpose. Resync the snapshot.",
  price_deviation:
    "the depth feed disagrees with the pair markPrice by more than 5%, so the ladder is purged as a safety measure. Either the feed is wrong or markPrice is frozen - reconcile them.",
  no_ladder:
    "depth is healthy and paperBook has no record of ever building a ladder for this pair, so there are no paper orders resting in the book. The matcher has not called syncPaperBook - check that the 2s matching cron is running and that this pair is in the active pair list.",
  // --- ladder verdicts adopted verbatim from paperBook's recorded purge
  // reason. Every one of these used to be reported as "no_ladder", which sent
  // the reader after the matching cron no matter what had actually broken.
  pair_ineligible:
    "paperBook purged the ladder because the PAIR is not eligible to carry one: botstatus is no longer \"binance\", or the pair was deactivated or deleted. The matcher is fine - this is a pair configuration state.",
  ladder_not_built:
    "depth is healthy but the last sync wrote no orders - every price level grouped below PAPER_BOOK_MIN_NOTIONAL, or redis rejected the write. Check PAPER_BOOK_MIN_NOTIONAL against how thin the depth is.",
  ladder_stale:
    "paperBook last wrote a ladder for this pair longer ago than PAPER_BOOK_LADDER_STALE_MS, so it can no longer be trusted as tradable. The matcher has stopped visiting this pair - check the 2s cron and the active pair list.",
  ladder_orphaned:
    "the ladder was swept because nothing refreshed it for PAPER_BOOK_ORPHAN_MS: the matcher stopped visiting this pair entirely (deleted, deactivated, or dropped from the active pair list).",
  error:
    "paperBook threw while syncing the ladder and purged it as a precaution. The cause is in the spotapi log at \"err on syncPaperBook\" - usually redis.",
  no_pair:
    "paperBook was asked to sync a ladder without a pair document. The pair cache and mongo disagree - check the redis spotPairdata hash.",
  one_sided_ladder:
    "the paper ladder exists on only one side, so orders in one direction cannot fill. Depth was healthy at check time - suspect a torn ladder write.",
  matcher_stalled:
    "the paper ladder has not been rewritten within its refresh window, which means matchingcall() has stopped running. Nothing will fill regardless of how good the depth looks - check the 2s cron and the per-pair lock in spot.controller.js.",
  insufficient_liquidity:
    "the resting book cannot absorb even the canary probe, so a real user order would not fill either. Check the depth levels and PAPER_BOOK_MIN_NOTIONAL.",
  no_admin_liquidity:
    "the admin_liquidity/liquidation account is missing from redis, so paperBook cannot build a ladder at all.",
  canary_error:
    "the canary itself failed to run (redis or mongo unreachable). Fill status is UNKNOWN, which must be treated as broken until proven otherwise.",
};

// ---------------------------------------------------------------------------
// Pure helpers - unit tested directly, no I/O.
// ---------------------------------------------------------------------------

/**
 * Wall-clock instant a synthetic ladder order was written, i.e. the last time
 * the matcher demonstrably ran for this pair.
 *
 * Two independent sources, and the LATEST wins, so a change to either one in
 * paperBook degrades this to "slightly coarser" instead of "silently wrong":
 *   - the id prefix, which createobjectId builds from Date.now()/1000 (whole
 *     seconds, hence up to 999ms of pessimism);
 *   - orderDate, which buildPaperOrders backdates by ORDER_BACKDATE_MS.
 * Returns 0 when neither can be read, which callers treat as "unknown".
 */
export const ladderWrittenAt = (order) => {
  let ts = 0;
  if (order && typeof order._id === "string" && /^[0-9a-f]{8}/.test(order._id)) {
    const seconds = parseInt(order._id.slice(0, 8), 16);
    if (Number.isFinite(seconds) && seconds > 0) {
      ts = seconds * 1000;
    }
  }
  if (order && order.orderDate) {
    const placed = new Date(order.orderDate).getTime();
    if (Number.isFinite(placed)) {
      ts = Math.max(ts, placed + ORDER_BACKDATE_MS);
    }
  }
  return ts;
};

/**
 * Walk the resting book the way a market order would and report what WOULD
 * have happened. PURE: orders in, verdict out, nothing written anywhere.
 *
 * `restingOrders` is the opposite side of the probe (asks for a buy probe, bids
 * for a sell probe). Sorting is by price, best first, matching the price
 * priority the matcher applies; the probe is expressed as a QUOTE notional for
 * both directions so the two sides are directly comparable.
 */
export const simulateMarketFill = (
  restingOrders,
  probeSide,
  probeNotional = PROBE_NOTIONAL
) => {
  const wantSide = probeSide === "buy" ? "sell" : "buy";
  const usable = (restingOrders || []).filter(
    (o) =>
      o &&
      (o.buyorsell == null || o.buyorsell === wantSide) &&
      (o.status == null || o.status === "open") &&
      Number(o.price) > 0 &&
      // `quantity` is the live remainder; `openQuantity` is the size the
      // order was opened at and is never decremented. See the note in
      // lib/depthHealth.js#bookLevels - reading openQuantity here made the
      // canary over-estimate fillable depth, which is the opposite of what a
      // liveness probe should err towards.
      Number(o.quantity) > 0
  );
  // Best price first: cheapest ask for a buy probe, richest bid for a sell one.
  usable.sort((a, b) =>
    probeSide === "buy"
      ? Number(a.price) - Number(b.price)
      : Number(b.price) - Number(a.price)
  );

  let remaining = probeNotional;
  let filledQty = 0;
  let filledNotional = 0;
  let levelsConsumed = 0;
  let availableNotional = 0;

  for (const order of usable) {
    const price = Number(order.price);
    const open = Number(order.quantity);
    availableNotional += price * open;
    if (remaining <= 0) {
      continue;
    }
    const takeQty = Math.min(open, remaining / price);
    const takeNotional = takeQty * price;
    filledQty += takeQty;
    filledNotional += takeNotional;
    remaining -= takeNotional;
    levelsConsumed += 1;
  }

  return {
    // Float tolerance: a book that covers the probe to the last cent must not
    // be called a failure because of binary representation.
    fillable: probeNotional > 0 && filledNotional + 1e-9 >= probeNotional,
    probeNotional,
    filledQty: Number(filledQty.toFixed(8)),
    filledNotional: Number(filledNotional.toFixed(8)),
    avgPrice: filledQty > 0 ? Number((filledNotional / filledQty).toFixed(8)) : 0,
    bestPrice: usable.length ? Number(usable[0].price) : null,
    levelsConsumed,
    restingLevels: usable.length,
    availableNotional: Number(availableNotional.toFixed(8)),
  };
};

/**
 * The depth circuit breakers, evaluated WITHOUT touching the ladder.
 *
 * The VERDICT is not computed here: it is delegated to the one pure gate in
 * lib/depthHealth.js, the same call syncPaperBook purges on and the same call
 * the display publish gates on. syncPaperBook itself cannot be called from a
 * health check - its whole job is to purge and rewrite the book, so calling it
 * would mutate the very thing being observed - but the RULE is shared rather
 * than restated, which is what stops the canary reporting healthy about a feed
 * the ladder is purging on.
 *
 * What this function adds is the operator-facing numbers behind the verdict:
 * how old the depth is, and what the top of book looked like when it was judged.
 */
export const evaluateDepth = (book, pairData, now = Date.now()) => {
  const { healthy, reason } = assessDepthHealth(book, pairData, now);
  if (!book) {
    return { verdict: reason };
  }
  const ageMs = depthAgeMs(book, now);
  const bids = Array.isArray(book.bids) ? book.bids : [];
  const asks = Array.isArray(book.asks) ? book.asks : [];
  const detail = { ageMs };
  if (bids.length) detail.bestBid = Number(bids[0].price);
  if (asks.length) detail.bestAsk = Number(asks[0].price);
  const markPrice = Number(pairData && pairData.markPrice);
  if (markPrice > 0) detail.markPrice = markPrice;
  return { verdict: healthy ? "ok" : reason, ...detail };
};

/**
 * Turn paperBook's recorded ladder state into the canary's verdict for "there
 * are no paper orders resting".
 *
 * PURE, and deliberately a translation rather than a guess:
 *   - a recorded purge reason IS the verdict (no_admin_liquidity,
 *     pair_ineligible, ladder_orphaned, ladder_stale, error, no_pair...), so
 *     the remedy names the subsystem that actually failed;
 *   - NOTHING recorded at all (`at` is 0) means paperBook has never run for
 *     this pair, which is the canary's own "no_ladder": the matcher has not
 *     visited it, and that remedy already says exactly that;
 *   - "ladder_not_built" WITH a record is a different fault - a sync that
 *     completed and wrote nothing - and keeps its own remedy;
 *   - anything unrecognised falls back to no_ladder rather than emitting a
 *     verdict with no remedy text behind it.
 */
export const ladderVerdict = (ladderState) => {
  const reason = ladderState && ladderState.reason;
  if (!reason || !ladderState.at) return "no_ladder";
  return REMEDY[reason] ? reason : "no_ladder";
};

/**
 * Roll per-pair verdicts into one platform verdict.
 * "degraded" is a real state and not a rounding of healthy: one dead market out
 * of three is invisible on a dashboard that only knows up/down.
 */
export const summarise = (pairs) => {
  if (!pairs.length) {
    return { status: "unhealthy", verdict: "no_pairs" };
  }
  const failing = pairs.filter((p) => !p.ok);
  if (!failing.length) {
    return { status: "healthy", verdict: "ok" };
  }
  return {
    status: failing.length === pairs.length ? "unhealthy" : "degraded",
    verdict: failing[0].verdict,
  };
};

// ---------------------------------------------------------------------------
// I/O helpers. Every one degrades to a null/empty result instead of throwing,
// so one unreadable key cannot take out the whole health check.
// ---------------------------------------------------------------------------

/**
 * The depth the LADDER would see, read through the same resolver the ladder and
 * the display read through (in-memory websocket cache first, redis mirror
 * second). This file used to carry its own copy of the redis fallback - a third
 * transcription of the same key names and sort orders, free to drift from both.
 */
const readDepth = async (pairId) => {
  let book = null;
  try {
    book = await resolveDepthSnapshot(pairId);
  } catch (err) {
    book = null;
  }
  return { book, source: (book && book.source) || "none" };
};

/** Read one open-order hash into an array; unparseable fields are skipped. */
const readSide = async (pairId, side) => {
  const orders = [];
  let raw = null;
  try {
    raw = await hgetall(`${side}OpenOrders_${pairId}`);
  } catch (err) {
    return orders;
  }
  if (!raw) return orders;
  for (const field of Object.keys(raw)) {
    try {
      const order = JSON.parse(raw[field]);
      if (order) orders.push(order);
    } catch (e) {
      continue;
    }
  }
  return orders;
};

/**
 * Pairs that are SUPPOSED to be fillable. Redis is the hot path; mongo is the
 * fallback for a cold cache. A pair that is not paper-eligible is not a failure
 * (it was never meant to carry a ladder), so it is excluded rather than failed.
 */
export const listEligiblePairs = async () => {
  const pairs = [];
  let cached = null;
  try {
    cached = await hgetall("spotPairdata");
  } catch (err) {
    cached = null;
  }
  if (cached) {
    for (const id of Object.keys(cached)) {
      try {
        const pair = JSON.parse(cached[id]);
        if (isPaperEligible(pair)) pairs.push(pair);
      } catch (e) {
        continue;
      }
    }
  }
  if (pairs.length) return pairs;
  try {
    const docs = await SpotPair.find({ botstatus: "binance" }).lean();
    for (const doc of docs || []) {
      if (isPaperEligible(doc)) pairs.push(doc);
    }
  } catch (err) {
    // mongo down: report on what redis could see (possibly nothing), the
    // verdict machinery turns an empty list into a loud no_pairs.
  }
  return pairs;
};

/**
 * Timestamp of the most recent settled trade, throttled and index-backed.
 *
 * Sorted by _id, not createdAt: only _id is indexed on this collection and an
 * ObjectId is monotonic in time, so this is an index hit instead of the
 * collection scan a createdAt sort would be. REPORTED ONLY - a quiet exchange
 * is legitimately quiet and must never trip the canary.
 */
export const readLastFill = async (now = Date.now()) => {
  if (lastFillCache.at !== 0 && now - lastFillCache.at < LAST_FILL_CACHE_MS) {
    return lastFillCache.value;
  }
  try {
    const doc = await TradeHistory.findOne({}, { createdAt: 1, pairName: 1 })
      .sort({ _id: -1 })
      .lean();
    const at = doc && doc.createdAt ? new Date(doc.createdAt).getTime() : null;
    lastFillCache = {
      at: now,
      value: {
        at: at ? new Date(at).toISOString() : null,
        ageMs: at ? now - at : null,
        pairName: (doc && doc.pairName) || null,
      },
    };
  } catch (err) {
    lastFillCache = { at: now, value: { at: null, ageMs: null, pairName: null } };
  }
  return lastFillCache.value;
};

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Full read-only verdict for one pair. Never throws: an unexpected failure
 * becomes a canary_error verdict for that pair so the rest still report.
 */
export const evaluatePair = async (pairData, now = Date.now()) => {
  const pairId = String(pairData._id);
  const symbol =
    pairData.pairName ||
    `${pairData.firstCurrencySymbol || ""}${pairData.secondCurrencySymbol || ""}`;
  const result = {
    pairId,
    symbol,
    ok: false,
    verdict: "canary_error",
    depth: { source: "none", ageMs: null, bestBid: null, bestAsk: null },
    // `checked: false` and null counts, NOT zeros: the checks short-circuit at
    // the first failure, so a pair that failed on depth never had its ladder
    // read. Reporting 0 there would invent a second, fictional fault and send
    // whoever is reading the log after the wrong thing.
    ladder: { checked: false, buy: null, sell: null, ageMs: null, stalled: null },
    simulation: { buy: null, sell: null },
  };

  try {
    // 1. Depth feed - the deepest cause, checked first so the reported verdict
    //    is the reason and not the consequence.
    const { book, source } = await readDepth(pairId);
    const depth = evaluateDepth(book, pairData, now);
    result.depth = {
      source,
      ageMs: depth.ageMs != null ? depth.ageMs : null,
      staleAfterMs: DEPTH_STALE_MS,
      bestBid: depth.bestBid != null ? depth.bestBid : null,
      bestAsk: depth.bestAsk != null ? depth.bestAsk : null,
      bids: book && Array.isArray(book.bids) ? book.bids.length : 0,
      asks: book && Array.isArray(book.asks) ? book.asks.length : 0,
    };
    if (depth.verdict !== "ok") {
      result.verdict = depth.verdict;
      return result;
    }

    // 2. Ladder presence and freshness. Freshness IS matcher liveness: the
    //    ladder is only ever rewritten from inside matchingcall().
    const [buySide, sellSide] = await Promise.all([
      readSide(pairId, "buy"),
      readSide(pairId, "sell"),
    ]);
    const paperBuy = buySide.filter((o) => o.isPaper === true);
    const paperSell = sellSide.filter((o) => o.isPaper === true);
    let writtenAt = 0;
    for (const order of paperBuy.concat(paperSell)) {
      writtenAt = Math.max(writtenAt, ladderWrittenAt(order));
    }
    const ladderAgeMs = writtenAt ? now - writtenAt : null;
    // What the LADDER'S OWN WRITER says about this pair. The canary sees an
    // absence; paperBook knows the cause of it, and has since the purge.
    const ladderState = getLadderState(pairId, now);
    result.ladder = {
      checked: true,
      buy: paperBuy.length,
      sell: paperSell.length,
      ageMs: ladderAgeMs,
      maxAgeMs: LADDER_STALE_MS,
      stalled: ladderAgeMs != null ? ladderAgeMs > LADDER_STALE_MS : null,
      // paperBook's in-memory claim, next to what redis actually holds, so a
      // disagreement between the two is visible instead of inferred.
      claimedPresent: ladderState.present === true,
      claimedReason: ladderState.reason || null,
      // Resting user orders are counted, never described: the health endpoint
      // is unauthenticated and must expose system state only.
      userOrders: buySide.length - paperBuy.length + (sellSide.length - paperSell.length),
    };

    if (!paperBuy.length && !paperSell.length) {
      // THE MISDIAGNOSIS THIS REPLACES: every empty ladder was reported as
      // "no_ladder", whose remedy sends the reader to the 2s matching cron. But
      // an empty ladder is the SYMPTOM of five different faults, and paperBook
      // recorded which one at the moment it purged - a missing admin liquidity
      // account, an ineligible pair, a redis failure, an orphan sweep. Naming
      // the cron for any of those points the operator at a subsystem that is
      // working perfectly, while the true reason sat unread in memory.
      result.verdict = ladderVerdict(ladderState);
      return result;
    }
    if (ladderAgeMs != null && ladderAgeMs > LADDER_STALE_MS) {
      result.verdict = "matcher_stalled";
      return result;
    }
    if (!paperBuy.length || !paperSell.length) {
      result.verdict = "one_sided_ladder";
      return result;
    }

    // 3. The dry run itself. Simulated against the WHOLE resting side, because
    //    that is what a real order would hit - a user's limit order is just as
    //    fillable as a synthetic one.
    const buyProbe = simulateMarketFill(sellSide, "buy");
    const sellProbe = simulateMarketFill(buySide, "sell");
    result.simulation = { buy: buyProbe, sell: sellProbe };
    if (!buyProbe.fillable || !sellProbe.fillable) {
      result.verdict = "insufficient_liquidity";
      return result;
    }

    result.ok = true;
    result.verdict = "ok";
    return result;
  } catch (err) {
    result.verdict = "canary_error";
    result.error = err && err.message ? err.message : "unknown";
    return result;
  }
};

/**
 * One read-only pass over every eligible pair, collapsed into a health
 * snapshot. Single-flighted: concurrent callers share one evaluation instead of
 * multiplying the redis reads.
 */
/**
 * Connection-level view of the depth feed: what is connected, how long each
 * stream has been silent, whether a reconnect is pending, and how many events
 * are stuck in a resync buffer.
 *
 * THIS IS THE SIGNAL THAT WAS INVISIBLE DURING THE OUTAGE. Everything else the
 * canary reports is downstream of the feed - "stale_depth" tells an operator
 * that data stopped arriving, not that four sockets are closed with no
 * reconnect scheduled, or that one is connected and pushing frames into a
 * buffer that will never drain. lib/binanceWebSocket.js has measured all of
 * that since the watchdog landed, and until now nothing but a unit test read it.
 *
 * Never throws and never blocks the verdict: the streams view is a report, so a
 * failure to produce it must degrade to "unavailable", not take down the health
 * endpoint that an operator is reaching for precisely because things are wrong.
 */
export const readDepthStreams = (now = Date.now()) => {
  try {
    if (typeof getDepthStreamHealth !== "function") return [];
    const streams = getDepthStreamHealth(now);
    if (!Array.isArray(streams)) return [];
    // Clamped for the same reason the depth age is: `now` is sampled once at
    // the top of the evaluation and a 100ms feed keeps ticking underneath it,
    // so a perfectly healthy stream can report "silent for -2ms". A negative
    // duration in an operator's dashboard reads as a broken dashboard.
    return streams.map((s) => ({
      ...s,
      silentForMs: Math.max(0, s.silentForMs || 0),
      protocolSilentForMs: Math.max(0, s.protocolSilentForMs || 0),
      depthAgeMs: s.depthAgeMs == null ? null : Math.max(0, s.depthAgeMs),
    }));
  } catch (err) {
    return [];
  }
};

/**
 * Roll the per-stream view into the one line an operator reads first.
 * PURE. `null` when there is nothing to summarise (streams not started yet, or
 * unreadable), which is reported as such rather than as "0 connected" - an
 * unmeasured feed is not a dead one.
 */
export const summariseStreams = (streams) => {
  if (!Array.isArray(streams) || !streams.length) return null;
  const connected = streams.filter((s) => s.connected).length;
  return {
    total: streams.length,
    connected,
    reconnecting: streams.filter((s) => s.reconnectPending).length,
    desynced: streams.filter((s) => !s.lastUpdateId).length,
    buffered: streams.reduce((sum, s) => sum + (s.bufferedEvents || 0), 0),
    // The worst silence across all streams: one dead market hides behind an
    // average, and this is the number that goes wrong first.
    maxSilentForMs: streams.reduce(
      (max, s) => Math.max(max, s.silentForMs || 0),
      0
    ),
    allConnected: connected === streams.length,
  };
};

export const evaluateAll = async () => {
  if (evaluating) return evaluating;
  evaluating = (async () => {
    const now = Date.now();
    const startedAt = Date.now();
    let pairs = [];
    let fatal = null;
    try {
      const eligible = await listEligiblePairs();
      pairs = await Promise.all(eligible.map((p) => evaluatePair(p, now)));
    } catch (err) {
      fatal = err && err.message ? err.message : "unknown";
    }
    const rollup = fatal
      ? { status: "unhealthy", verdict: "canary_error" }
      : summarise(pairs);
    const lastFill = await readLastFill(now);
    const streams = readDepthStreams(now);
    const snapshot = {
      status: rollup.status,
      verdict: rollup.verdict,
      service: "spotapi",
      checkedAt: new Date(now).toISOString(),
      durationMs: Date.now() - startedAt,
      uptimeSec: Math.round(process.uptime()),
      matcher: {
        // Liveness is inferred, not asserted: the freshest ladder across all
        // pairs is the newest proof that matchingcall() actually ran.
        running: pairs.some((p) => p.ladder.ageMs != null && !p.ladder.stalled),
        evidence: "paper_ladder_refresh",
        ladderAgeMs: pairs.reduce(
          (min, p) =>
            p.ladder.ageMs == null ? min : min == null ? p.ladder.ageMs : Math.min(min, p.ladder.ageMs),
          null
        ),
      },
      // Connection state of the feed everything else depends on. Reported, not
      // judged: a stream that is briefly reconnecting while the depth cache is
      // still fresh is not a reason to call the platform broken, and the depth
      // verdict above already condemns the case where it matters.
      depthFeed: {
        summary: summariseStreams(streams),
        streams,
      },
      lastFill,
      pairs,
    };
    if (fatal) snapshot.error = fatal;
    cachedSnapshot = snapshot;
    cachedAt = Date.now();
    return snapshot;
  })().finally(() => {
    evaluating = null;
  });
  return evaluating;
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Log a verdict change, rate-limited.
 *
 * The rules, in the order they matter:
 *   - a NEW or CHANGED failure logs immediately (that is the alert);
 *   - an unchanged failure re-logs at most once per REPEAT_LOG_MS, carrying how
 *     long it has been broken and how many checks it has survived, so a
 *     permanently-down platform costs 6 lines an hour instead of 20;
 *   - a recovery logs exactly once, loudly, so "is it back" is answerable from
 *     the log alone;
 *   - a healthy platform logs nothing at all. An idle exchange must be silent,
 *     otherwise the canary becomes noise and gets muted, which is how this
 *     class of outage went unnoticed in the first place.
 */
export const emitVerdict = (subject, ok, verdict, detail, now = Date.now()) => {
  const previous = logState.get(subject);
  if (ok) {
    if (previous && !previous.ok) {
      const downMs = now - previous.firstAt;
      console.log(
        "\x1b[32m%s\x1b[0m",
        `[FILL-CANARY] RECOVERED ${subject} can fill again after ${Math.round(
          downMs / 1000
        )}s down (was: ${previous.reason})`
      );
    }
    logState.set(subject, { ok: true, reason: "ok", firstAt: now, lastLoggedAt: now, count: 0 });
    return true;
  }

  const changed = !previous || previous.ok || previous.reason !== verdict;
  const count = changed ? 1 : previous.count + 1;
  const firstAt = changed ? now : previous.firstAt;
  const due = changed || now - previous.lastLoggedAt >= REPEAT_LOG_MS;
  if (!due) {
    logState.set(subject, { ok: false, reason: verdict, firstAt, lastLoggedAt: previous.lastLoggedAt, count });
    return false;
  }

  const forMs = now - firstAt;
  const suffix =
    changed
      ? ""
      : ` [still failing after ${Math.round(forMs / 1000)}s, ${count} consecutive checks]`;
  console.error(
    "\x1b[31m%s\x1b[0m",
    `[FILL-CANARY] CANNOT FILL ${subject} verdict=${verdict} ${detail}${suffix}\n` +
      `[FILL-CANARY] WHY: ${REMEDY[verdict] || "unrecognised verdict - inspect GET /api/spot/health."}`
  );
  logState.set(subject, { ok: false, reason: verdict, firstAt, lastLoggedAt: now, count });
  return true;
};

const describe = (pair) => {
  const parts = [
    `depth=${pair.depth.source}`,
    `depthAgeMs=${pair.depth.ageMs}`,
    pair.ladder.checked
      ? `ladder=${pair.ladder.buy}b/${pair.ladder.sell}s ladderAgeMs=${pair.ladder.ageMs}`
      : "ladder=not-checked(failed earlier)",
  ];
  if (pair.simulation && pair.simulation.buy) {
    parts.push(
      `probe=${PROBE_NOTIONAL} buyFilled=${pair.simulation.buy.filledNotional} sellFilled=${
        pair.simulation.sell ? pair.simulation.sell.filledNotional : "n/a"
      }`
    );
  }
  if (pair.error) parts.push(`error=${pair.error}`);
  return parts.join(" ");
};

/**
 * One canary cycle: evaluate, log, book-keep. Never throws - a canary that can
 * crash the process it monitors is worse than no canary.
 */
export const runCanary = async () => {
  const startedAt = Date.now();
  let snapshot;
  try {
    snapshot = await evaluateAll();
  } catch (err) {
    snapshot = {
      status: "unhealthy",
      verdict: "canary_error",
      pairs: [],
      error: err && err.message ? err.message : "unknown",
    };
  }

  try {
    for (const pair of snapshot.pairs || []) {
      emitVerdict(pair.symbol || pair.pairId, pair.ok, pair.verdict, describe(pair), startedAt);
    }
    if (!(snapshot.pairs || []).length) {
      emitVerdict(
        "spot",
        false,
        snapshot.verdict || "no_pairs",
        `pairs=0 error=${snapshot.error || "none"}`,
        startedAt
      );
    }
  } catch (err) {
    console.error("\x1b[31m%s\x1b[0m", `[FILL-CANARY] logging failed: ${err.message}`);
  }

  canaryState.runs += 1;
  canaryState.lastRunAt = new Date(startedAt).toISOString();
  canaryState.lastRunDurationMs = Date.now() - startedAt;
  canaryState.lastVerdict = snapshot.verdict;
  canaryState.lastMessage =
    snapshot.status === "healthy"
      ? "all eligible pairs would fill a probe order"
      : REMEDY[snapshot.verdict] || snapshot.verdict;
  if (snapshot.status === "healthy") {
    canaryState.lastOkAt = new Date(startedAt).toISOString();
    canaryState.consecutiveFailures = 0;
  } else {
    canaryState.consecutiveFailures += 1;
  }
  return snapshot;
};

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

/**
 * Health payload. Serves a snapshot no older than HEALTH_CACHE_MS, recomputing
 * on demand otherwise - so an operator who hits this because "something feels
 * off" gets the state NOW, not whatever the last interval saw, while a monitor
 * hammering it cannot turn the endpoint into load.
 */
export const getHealth = async (now = Date.now()) => {
  let snapshot = cachedSnapshot;
  if (!snapshot || now - cachedAt > HEALTH_CACHE_MS) {
    snapshot = await evaluateAll();
  }
  return {
    ...snapshot,
    cacheAgeMs: Math.max(0, Date.now() - cachedAt),
    canary: {
      enabled: canaryState.enabled,
      intervalMs: INTERVAL_MS,
      probeNotional: PROBE_NOTIONAL,
      mechanism: "non-committing dry-run match (no orders, balances or trades are written)",
      runs: canaryState.runs,
      lastRunAt: canaryState.lastRunAt,
      lastRunDurationMs: canaryState.lastRunDurationMs,
      lastOkAt: canaryState.lastOkAt,
      lastVerdict: canaryState.lastVerdict,
      lastMessage: canaryState.lastMessage,
      consecutiveFailures: canaryState.consecutiveFailures,
    },
  };
};

/**
 * GET /api/spot/health - unauthenticated by design: this is what a human or a
 * monitor reaches for when the platform feels wrong, and gating it behind a
 * login makes it useless in exactly that moment. It exposes system state only -
 * pair symbols, feed ages, ladder counts, simulated fills - and never a userId,
 * an order id, a balance or anything else user-owned.
 *
 * 503 on "unhealthy" so an uptime monitor trips without having to parse JSON;
 * 200 on "degraded" because some markets are still fillable.
 */
export const healthCheck = async (req, res) => {
  try {
    const health = await getHealth();
    return res.status(health.status === "unhealthy" ? 503 : 200).json(health);
  } catch (err) {
    console.error("\x1b[31m%s\x1b[0m", `[FILL-CANARY] health endpoint failed: ${err.message}`);
    return res.status(503).json({
      status: "unhealthy",
      verdict: "canary_error",
      service: "spotapi",
      checkedAt: new Date().toISOString(),
    });
  }
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the periodic self-test. Idempotent, and a no-op under NODE_ENV=test so
 * importing this module in a unit test cannot start a background timer.
 * The timer is unref'd: the canary must never be the reason a process refuses
 * to exit.
 */
export const startFillCanary = () => {
  if (timer || process.env.NODE_ENV === "test") {
    return timer;
  }
  if (process.env.SPOT_CANARY_DISABLED === "true") {
    console.log("[FILL-CANARY] disabled by SPOT_CANARY_DISABLED");
    return null;
  }
  canaryState.enabled = true;
  console.log(
    "\x1b[36m%s\x1b[0m",
    `[FILL-CANARY] armed: dry-run fill probe of ${PROBE_NOTIONAL} every ${Math.round(
      INTERVAL_MS / 1000
    )}s (health: GET /api/spot/health)`
  );
  const tick = () => {
    runCanary().catch((err) =>
      console.error("\x1b[31m%s\x1b[0m", `[FILL-CANARY] run failed: ${err.message}`)
    );
  };
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.();
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  return timer;
};

export const stopFillCanary = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  canaryState.enabled = false;
};

/** Test seam: drop cached snapshots and log throttling between cases. */
export const __resetCanaryState = () => {
  cachedSnapshot = null;
  cachedAt = 0;
  evaluating = null;
  lastFillCache = { value: null, at: 0 };
  logState.clear();
  canaryState.enabled = false;
  canaryState.lastRunAt = null;
  canaryState.lastRunDurationMs = null;
  canaryState.lastOkAt = null;
  canaryState.lastVerdict = null;
  canaryState.lastMessage = null;
  canaryState.consecutiveFailures = 0;
  canaryState.runs = 0;
};

export default {
  startFillCanary,
  stopFillCanary,
  runCanary,
  getHealth,
  healthCheck,
};
