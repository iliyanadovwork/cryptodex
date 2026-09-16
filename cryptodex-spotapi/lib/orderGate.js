/**
 * THE SERVER-SIDE FILL GATE FOR THE ORDER PATH.
 *
 * WHAT WENT WRONG BEFORE
 * ----------------------
 * The health verdict was enforced in exactly one place: the browser. The order
 * book payload carried `healthy: false`, the React ticket disabled its Buy/Sell
 * button, and everyone declared the lying-book bug closed. But POST
 * /api/spot/orderPlace had no equivalent check at all, so an order submitted
 * while nothing could fill was ACCEPTED and the user's balance was DEBITED
 * immediately - the money left the wallet to back an order that could not
 * possibly execute. The browser is not a security boundary. A stale tab, a
 * mobile client, a scripted API user, a retry that lands during recovery, or
 * anyone at all with a bearer token walks straight past a disabled button.
 *
 * So the same verdict is enforced here, on the server, BEFORE a single
 * balance-moving line runs. The gate is called immediately after pair
 * validation in both limitOrderPlace and marketOrderPlace, which is before the
 * wallet is read and long before hincbyfloat: a rejected order therefore moves
 * nothing, writes no passbook row and leaves no orphan in the open-order hash.
 *
 * NO THIRD COPY OF THE RULE
 * -------------------------
 * "Is this depth usable" is lib/depthHealth.assessDepthHealth. "Is a ladder
 * actually resting" is paperBook.getLadderState. This module owns neither; it
 * owns only the POLICY of what those two verdicts mean FOR AN ORDER, which is
 * genuinely a different question from what they mean for a DISPLAY.
 *
 * THE POLICY, AND WHY IT IS NOT "block everything when unhealthy"
 * --------------------------------------------------------------
 * A MARKET order is a promise of immediate execution. It has no price of its
 * own, it can only ever fill against liquidity that exists RIGHT NOW, and when
 * there is none it does not rest usefully - it sits in the book as
 * `price: "market"` with the user's funds debited, unfillable and unpriceable,
 * until someone notices. There is no state of the book in which accepting one
 * is better for the user than refusing it. Market orders therefore require a
 * fully fillable book: healthy depth AND a resting ladder AND a resting ladder
 * BIG ENOUGH to fill the whole order.
 *
 * WHY SIZE IS PART OF THE VERDICT AND NOT A SEPARATE CHECK
 * -------------------------------------------------------
 * The gate originally asked only "is a ladder resting". That is the right
 * question for an order of one satoshi and the wrong one for an order twenty
 * times the size of the book: the oversized order passed, filled against every
 * level there was, and left its remainder resting as `price: "market"` with the
 * funds for it already debited. That is bit-for-bit the state the paragraph
 * above says must never be reached - the gate simply had no opinion about the
 * door it came through. "Enough liquidity to fill THIS order" is the same
 * question as "is this fillable", asked with the one parameter that was
 * missing, so it belongs in the same verdict rather than in a second check that
 * can be forgotten at one of the call sites.
 *
 * WHY REFUSE RATHER THAN FILL-WHAT-YOU-CAN
 * ----------------------------------------
 * The alternatives all move money before they discover the shortfall:
 *
 *   partial fill, remainder rests  - the status quo, and the defect.
 *   partial fill, remainder cancelled (IOC) - correct on a real venue, but the
 *     refund would have to be computed by the ASYNC matcher, after fees, in two
 *     currencies, for an order whose debit was taken at markPrice before the
 *     first fill happened. Every one of those is a place a rounding error
 *     becomes a permanent balance discrepancy, and none of them is needed to
 *     make the user whole.
 *   accept and refund on failure   - a debit the user can see, followed by a
 *     credit they have to trust arrived.
 *
 * Refusing before the wallet is touched is the only outcome where there is no
 * money to return, no partially-filled position to reconcile and nothing
 * resting that cannot be priced. The user loses nothing but the round trip, and
 * the message tells them the two things they can do about it (smaller size, or
 * a limit order, which rests legitimately and is cancellable at will).
 *
 * The measurement is deliberately CONSERVATIVE: it counts the synthetic ladder
 * only, not the real user orders that may also be resting on the far side. A
 * rejection is therefore possible for an order that could in fact have filled
 * against another user - which costs that user a retry, while the opposite
 * error costs them a debited, unfillable order. Erring is safe in exactly one
 * direction and this is it.
 *
 * A LIMIT order is a different instrument. It is a claim about a FUTURE price,
 * it is expected to rest, and a resting limit order is exactly as legitimate
 * when the feed hiccups for eight seconds as it is when the feed is perfect -
 * on a real venue the book being thin is not a reason to refuse a bid 5% below
 * it. Blocking limit orders on transient depth/ladder faults would also take
 * away the one instrument a user has to get OUT of a position while the feed is
 * unwell, which is worse for them than the fault. So a limit order is refused
 * only for the TERMINAL, pair-level verdicts - the pair cannot carry liquidity
 * at all (`pair_ineligible`) or does not resolve (`no_pair`) - where the ladder
 * is not coming back and the order would rest against nothing indefinitely.
 *
 * WHY THIS CANNOT STRAND MONEY
 * ----------------------------
 * The permissive branch is only ever the limit branch, and a limit order's
 * reservation is fully recoverable: it moves balance into
 * `walletbalance_spot_inOrder`, it is visible in the open orders list, and
 * spot.cancelOrder refunds it in full at any time. Cancel is deliberately NOT
 * gated on health - see the note there - precisely so that a book which has
 * gone bad can never trap funds. Every path this module can take therefore ends
 * either in "no money moved" (rejected) or in "money the user can take back on
 * demand" (a resting limit order).
 *
 * WHY THIS TRUSTS getLadderState AND DOES NOT RE-VERIFY AGAINST REDIS
 * ------------------------------------------------------------------
 * bookPublish.controller.js deliberately double-checks the in-memory ladder
 * assertion by counting the paper rows in the open-order hashes it is already
 * reading. The order path must NOT copy that, and the reason is in
 * syncPaperBook: it replaces the ladder by hdel'ing every previous id and only
 * then hset'ing the new ones, with awaits in between. So every 2s there is a
 * real window, milliseconds wide, in which redis holds ZERO paper orders while
 * the ladder is perfectly healthy. The display can absorb a spurious blank -
 * it republishes 100ms later. A user pressing Buy cannot absorb a spurious
 * rejection. The in-memory assertion, expired by LADDER_STALE_MS and recorded
 * "gone" BEFORE any purge starts deleting, is the correct source here; the
 * matcher reads the same hashes at match time anyway, so the worst case of
 * trusting it is an order that rests one cycle longer.
 *
 * SCOPE
 * -----
 * The gate applies to pairs whose tradable liquidity IS the paper ladder, i.e.
 * botstatus "binance". A "bot"/"off" pair has no paper ladder by design, so
 * getLadderState would report `ladder_not_built` for it forever and the gate
 * would refuse every market order on those pairs - a self-inflicted outage.
 * Their liquidity check is the resting-order check that already exists inline
 * in marketOrderPlace ("No orders in order book").
 */

import { resolveDepthSnapshot } from "./depthSource.js";
import { assessDepthHealth } from "./depthHealth.js";
import { getLadderState } from "../controllers/paperBook.controller.js";

/** botstatus of the pairs whose fills come from the synthetic paper ladder. */
export const PAPER_LADDER_BOTSTATUS = "binance";

/** Does this pair's ability to fill depend on the paper ladder? */
export const usesPaperLadder = (pairData) =>
  !!pairData && pairData.botstatus === PAPER_LADDER_BOTSTATUS;

/**
 * Verdicts that mean THIS PAIR cannot carry liquidity at all, as opposed to
 * "the market is momentarily unwell". These are the only ones that stop a
 * resting limit order, because they are the only ones that will not clear on
 * their own within seconds.
 */
export const TERMINAL_REASONS = new Set(["pair_ineligible", "no_pair"]);

/** Every reason the gate can report, mapped to what the user is told. */
const MESSAGES = {
  no_depth:
    "Market data for this pair is unavailable, so a market order cannot fill. Nothing has been charged - try again in a moment or place a limit order.",
  stale_depth:
    "The market data feed has stopped updating, so a market order cannot fill. Nothing has been charged - try again in a moment or place a limit order.",
  empty_side:
    "There is no liquidity on the other side of this book, so a market order cannot fill. Nothing has been charged - try again in a moment or place a limit order.",
  crossed_book:
    "Market data for this pair is inconsistent, so trading is paused. Nothing has been charged - try again in a moment.",
  price_deviation:
    "Market data for this pair is too far from the reference price, so trading is paused. Nothing has been charged - try again in a moment.",
  ladder_not_built:
    "There is no liquidity resting in this book yet, so a market order cannot fill. Nothing has been charged - try again in a moment or place a limit order.",
  ladder_stale:
    "This book has not refreshed recently, so a market order cannot fill. Nothing has been charged - try again in a moment or place a limit order.",
  ladder_orphaned:
    "There is no liquidity resting in this book, so a market order cannot fill. Nothing has been charged - try again in a moment or place a limit order.",
  no_admin_liquidity:
    "There is no liquidity available for this pair right now. Nothing has been charged - please try again shortly.",
  insufficient_liquidity:
    "There is not enough liquidity resting in this book to fill an order that size right now. Nothing has been charged - try a smaller size, or place a limit order.",
  pair_ineligible:
    "This pair is not trading right now. Nothing has been charged - please pick another pair.",
  no_pair:
    "This pair is not available. Nothing has been charged - please pick another pair.",
  error:
    "This pair's order book could not be verified, so the order was not accepted. Nothing has been charged - please try again.",
};

const DEFAULT_MESSAGE = MESSAGES.error;

/**
 * How much of the far side is resting, in the unit the order is sized in.
 *
 * A market BUY spends QUOTE (`orderValue`) and consumes the ask/sell ladder, so
 * it is measured against that side's NOTIONAL. A market SELL delivers BASE
 * (`amount`) and consumes the bid/buy ladder, so it is measured against that
 * side's QUANTITY. Mixing the two units is the one arithmetic mistake that
 * would make this check meaningless (a BTC quantity compared against a USD
 * notional passes everything), so the pairing lives in exactly one function.
 *
 * Returns null when the ladder cannot state its capacity - see the fail-closed
 * note in evaluateOrderGate.
 */
export const ladderCapacityFor = (ladder, side) => {
  if (!ladder) return null;
  const available =
    String(side) === "sell"
      ? Number(ladder.buyQuantity)
      : Number(ladder.sellNotional);
  return Number.isFinite(available) ? available : null;
};

/**
 * THE POLICY. Pure: verdicts in, decision out. No redis, no clock.
 *
 * `depth`  - the { healthy, reason } assessDepthHealth returned.
 * `ladder` - the { present, reason, buyQuantity, sellNotional, ... }
 *            getLadderState returned.
 * `side`   - "buy" or "sell", needed to know WHICH side of the ladder this
 *            order eats and therefore which unit `size` is in.
 * `size`   - how big the order is, in quote for a buy and in base for a sell.
 *            Optional, and omitting it means "no size opinion wanted": the
 *            gate is also asked the pure question "is this pair tradable at
 *            all" by health reporting, where there is no order to measure. The
 *            order path always supplies it - see marketOrderPlace.
 *
 * Returns { allowed, reason, message, degraded }:
 *   allowed  - may this order be accepted at all
 *   reason   - the single machine-readable verdict, present even when allowed,
 *              so the caller can log WHY a limit order was let through a book
 *              that is not fully well
 *   degraded - allowed, but into a book that cannot fill right now
 *   available- only on an insufficient_liquidity refusal: the size that WOULD
 *              have been accepted, so the refusal is loggable and actionable
 */
export const evaluateOrderGate = ({ orderType, depth, ladder, side, size }) => {
  // Depth first: it is the deeper cause, so the reported reason names what
  // actually broke rather than the ladder absence it produces a tick later.
  const reason = !depth || !depth.healthy
    ? (depth && depth.reason) || "error"
    : !ladder || !ladder.present
      ? (ladder && ladder.reason) || "ladder_not_built"
      : null;

  // Anything that is not explicitly a market order is treated as a resting
  // order. Erring this way is safe in one direction only, and this is it: the
  // permissive branch is the one whose funds cancelOrder can always return.
  const isMarket = String(orderType) === "market";

  if (!reason) {
    // Depth is healthy and a ladder IS resting. The only remaining way a market
    // order can fail to fill is by being bigger than that ladder, and a resting
    // order cannot fail that way at all - it is a claim about a future price,
    // not a demand on the liquidity of this instant.
    if (!isMarket || size == null) {
      return { allowed: true, reason: null, message: null, degraded: false };
    }
    const requested = Number(size);
    const available = ladderCapacityFor(ladder, side);
    // FAIL CLOSED on an unmeasurable order or an unmeasurable ladder. Both are
    // "we do not know whether this can fill", and for a market order that is
    // the same answer as "it cannot": accepting is what debits money against
    // liquidity nobody has confirmed exists. Only reachable via a malformed
    // size or a ladder recorded without capacity, neither of which the order
    // path can produce - see the record sites in paperBook.controller.js.
    if (!Number.isFinite(requested) || requested <= 0 || available == null) {
      return {
        allowed: false,
        reason: "error",
        message: MESSAGES.error,
        degraded: true,
      };
    }
    if (requested > available) {
      return {
        allowed: false,
        reason: "insufficient_liquidity",
        message: MESSAGES.insufficient_liquidity,
        degraded: true,
        available,
      };
    }
    return { allowed: true, reason: null, message: null, degraded: false };
  }

  if (!isMarket && !TERMINAL_REASONS.has(reason)) {
    return { allowed: true, reason, message: null, degraded: true };
  }

  return {
    allowed: false,
    reason,
    message: MESSAGES[reason] || DEFAULT_MESSAGE,
    degraded: true,
  };
};

/**
 * Resolve the live verdicts for a pair and apply the policy.
 *
 * Returns the evaluateOrderGate shape plus `gated`, which is false when the
 * pair does not draw its liquidity from the paper ladder and the gate therefore
 * expressed no opinion.
 *
 * FAILS CLOSED FOR MARKET ORDERS. If the depth snapshot cannot even be read
 * (redis down mid-request), the honest answer is "unknown", and accepting a
 * market order on an unknown book is the exact trade that debits money against
 * liquidity that may not exist. A limit order still rests, because "unknown" is
 * not a terminal pair verdict and its funds remain recoverable.
 *
 * `options` carries the order's own dimensions - { side, size } - plus `now`
 * for tests. They are optional so that a caller asking only "is this pair
 * tradable" (health reporting) need not invent an order; supplying them is what
 * turns on the sufficiency verdict, and the order path always does.
 */
export const assertOrderTradable = async (
  pairData,
  orderType,
  options = {}
) => {
  const { side, size, now = Date.now() } = options;
  if (!usesPaperLadder(pairData)) {
    return { allowed: true, reason: null, message: null, degraded: false, gated: false };
  }
  const pairId = String(pairData._id);
  let depth;
  let ladder;
  try {
    const book = await resolveDepthSnapshot(pairId);
    depth = assessDepthHealth(book, pairData, now);
    ladder = getLadderState(pairId, now);
  } catch (err) {
    depth = { healthy: false, reason: "error" };
    ladder = { present: false, reason: "error" };
  }
  return {
    ...evaluateOrderGate({ orderType, depth, ladder, side, size }),
    gated: true,
  };
};
