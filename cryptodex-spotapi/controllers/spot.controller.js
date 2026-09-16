// import package
import mongoose from "mongoose";

// import models
import {
  SpotPair,
  SpotOrder,
  // Admin,
  // TODO: Add Admin model
  OrderHistory,
  TradeHistory,
  SequenceId,
} from "../models/index.js";
import cron from "node-cron";

import { socketEmitOne, socketEmitAll } from "../config/socketIO.js";
// import controller
import * as binanceCtrl from "./binance.controller.js";
import { ChartDocHistory } from "./chart/chart.controller.js";
// import lib
import isEmpty from "../lib/isEmpty.js";
import { byTradeTime, inLast24h } from "../lib/tradeWindow.js";
import { decryptObject } from "../lib/cryptoJS.js";
import { filterSearchQuery, hasNextPage, paginationQuery } from "../lib/adminHelpers.js";
import { toFixed, toFixedDown, truncateDecimals } from "../lib/roundOf.js";
import {
  hset,
  hget,
  hgetall,
  hincby,
  hincbyfloat,
  hdel,
  hgetdel,
  rpush,
  lrange,
  lpop,
  hmget,
  hmset,
  hlen,
  get,
  set,
  hincrbyfloatIfEnough,
  moveBalanceLogged,
  moveBalanceSigned,
  FROZEN,
} from "../controllers/redis.controller.js";
// The per-user margin freeze a `faucet/reset` holds while it writes absolute
// balances. Spot's reservation refuses under it - see lib/valueFlight.js for
// why a freeze that covered only some of the reservation paths was the same
// bug with a smaller window.
import { marginFreezeKey } from "../lib/marginFreeze.js";

import { priceConversionGrpc } from "../grpc/currencyService.js";

// import grpc
import {
  getUserAsset,
  updateUserWallet,
  passbook,
} from "../grpc/walletService.js";
import { saveAdminprofit } from "../grpc/adminService.js";
// import { convert } from "../lib/convert.js";
import { syncPaperBook, getLadderState } from "./paperBook.controller.js";
// WHO WAS RESTING, AND THEREFORE WHO PAYS WHICH RATE. The role is stamped at
// acceptance and read back at settlement; see the module note for why it cannot
// be re-derived from a quote that has since moved.
import {
  TAKER,
  crossesBook,
  roleForNewOrder,
  roleOf,
  makerSideOf,
  isSyntheticOrder,
} from "../lib/liquidityRole.js";
import { buildPublishedBook } from "./bookPublish.controller.js";
// THE ORDER PATH'S OWN COPY OF THE HEALTH VERDICT - the one the browser cannot
// skip. See lib/orderGate.js for why market and limit orders are judged
// differently, and why nothing it rejects has moved a single unit of balance.
import { assertOrderTradable } from "../lib/orderGate.js";
// THE PAIR'S OWN PRECISION, ENFORCED AT THE DOOR. One definition of "how many
// decimals does this number carry", shared with the field validators - see
// PRICE IS REFUSED, SIZE IS QUANTISED below.
import {
  decimalPlaces,
  precisionDigits,
  exceedsPrecision,
} from "../validation/numericField.validation.js";

const IncCntObjId = (ObjectId) => {
  try {
    ObjectId = ObjectId.toString()
    return parseInt(ObjectId.substring(ObjectId.length - 6, ObjectId.length), 16)
  } catch (err) {
    return ''
  }
}

const ObjectId = mongoose.Types.ObjectId;

let pairInfo = [];
let orderHistArr = [];
let tradeHistArr = [];
let isRun = false;
let tradePair = "";
const pairLocks = new Set();

// The only redis hashes a client-supplied cancel is allowed to name.
export const OPEN_ORDER_TABLE = /^(buy|sell)OpenOrders_[0-9a-fA-F]{24}$/;

/**
 * THE CANCEL AUTHORISATION, in one place.
 *
 * Stateless, so it says nothing about whether the order is still THERE - that
 * question can only be answered by the atomic claim (hgetdel). It is evaluated
 * twice per cancel: once on the pre-read, so an unauthorised caller is turned
 * away without the order ever leaving the book, and once on the claimed
 * snapshot, so what is actually refunded is what was actually authorised.
 *
 *   - isPaper: synthetic Binance-depth ladder liquidity, admin-owned and never
 *     debited on placement. Refunding it credits balance out of nothing.
 *   - ownership: cancelOrder credits the ORDER'S OWN userId, so without this any
 *     authenticated caller could pay out someone else's reservation.
 *   - side/table: the refund currency is chosen from buyorsell (quote for a buy,
 *     base for a sell), so an order read out of the opposite side's hash would
 *     be refunded in the wrong coin.
 */
const cancelAuthorised = (order, userId, tableId) =>
  !!order &&
  order.isPaper !== true &&
  String(order.userId) === String(userId) &&
  typeof tableId === "string" &&
  tableId.startsWith(order.buyorsell + "OpenOrders_");

const parseOrder = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    return null;
  }
};

/**
 * Spot balance of a (user, currency) as a NUMBER, for the "before" side of a
 * passbook row.
 *
 * A walletbalance_spot field only EXISTS once something has written it. The
 * paper ladder's admin account is credited/debited purely by HINCRBYFLOAT
 * (which treats a missing field as 0 and creates it), so the very first fill in
 * a given coin reads the field before it exists: HGET returns null and
 * parseFloat(null) is NaN. A NaN beforeBalance/afterBalance is then rejected by
 * walletapi's passbook schema and the whole audit row is silently lost.
 *
 * Missing == 0 is exactly the assumption the HINCRBYFLOAT that follows makes,
 * so the number recorded here always matches the balance the settlement moves.
 */
export const readSpotBalanceNumber = async (userId, currencyId) => {
  const field = `${userId}_${currencyId}`;
  const raw = await hget("walletbalance_spot", field);
  const value = parseFloat(raw);
  if (Number.isFinite(value)) {
    return value;
  }
  if (raw != null) {
    // A field that exists but does not parse is a corrupt ledger entry, not a
    // first touch: worth saying out loud before it is treated as zero.
    console.log(
      "readSpotBalanceNumber: unparseable walletbalance_spot",
      field,
      JSON.stringify(raw)
    );
  }
  return 0;
};

/**
 * PRICE IS REFUSED, SIZE IS QUANTISED.
 * ====================================
 *
 * The pair document states two precisions and until now the order path used
 * NEITHER as a rule: `firstFloatDigit` is how finely the venue can express the
 * BASE coin (BTC 8, SOL 9, ETH 18) and `secondFloatDigit` how finely it can
 * express the QUOTE (2 on every live pair). A limit order priced 63510.631 and
 * sized 0.0012345678912345 BTC was accepted, escrowed, rested, and published at
 * the top of the public book - measured live, this stack, ordinary account.
 *
 * TWO FIELDS, TWO DIFFERENT ANSWERS. That asymmetry is the whole design, so
 * here is the argument for each.
 *
 * A PRICE IS REFUSED (400), NOT ROUNDED.
 * --------------------------------------
 * A limit price is an INSTRUCTION - "not a cent worse than this" - and rounding
 * it silently makes the venue trade on terms the user did not give. There is no
 * safe direction to round it in either: down is worse than the seller asked for,
 * up is worse than the buyer asked for, and "round toward the user" invents
 * price improvement out of a formatting decision. So the order does not happen
 * and the client is told exactly why, in the one place where nothing has moved
 * yet.
 *
 * It is also the field with the exploit. Price is what ORDERS THE QUEUE, and a
 * price finer than the pair's tick jumps the entire resting book - the whole
 * paper ladder included - for a fraction of a cent the venue cannot quote. A
 * user who cannot express 63510.631 cannot be beaten by it either. And the
 * published book stops advertising levels the pair cannot trade at.
 *
 * A SIZE IS QUANTISED DOWN, AND THE USER IS TOLD.
 * ----------------------------------------------
 * A quantity is not an instruction about terms, it is an amount, and three
 * things make truncation the right answer where refusal is the right answer for
 * price:
 *
 *   1. THE ENGINE ALREADY DOES IT, EVERYWHERE. `marketOrderQuantity` quantises
 *      a market buy's size down before charging for it, and the matcher
 *      truncates every partial fill's remainder (`buyExcAmount`/
 *      `sellExcAmount`). The venue's answer to "a size finer than the pair can
 *      express" is already "truncate down"; adding a SECOND, contradictory
 *      answer at the door would mean the same number is refused on the way in
 *      and silently truncated once it is resting.
 *   2. TRUNCATION CANNOT COST THE USER ANYTHING THEY DID NOT ASK FOR. It only
 *      ever shrinks the order, so the escrow taken is never larger than the one
 *      requested and no size is invented. Rounding a price has no such
 *      direction; rounding a size does.
 *   3. "SELL EVERYTHING I HOLD" HAS TO REMAIN EXPRESSIBLE. A balance that came
 *      out of a fill carries float residue - 0.10000000987588606 BTC is a real
 *      holding on this venue, and it is not typeable to 8 decimals. Refusing it
 *      would make a user's own balance unsellable through the API. The client
 *      already truncates its "max" button through the same rule, so the two
 *      agree.
 *
 * The response says what size was actually used, because a silent adjustment is
 * how a client's local copy of the order drifts from the venue's.
 *
 * WHAT IS DELIBERATELY NOT CHECKED: a market BUY's `orderValue`. It is a
 * BUDGET, not a price and not a size - it never rests, is never published, and
 * is converted into a base quantity that is already truncated to
 * `firstFloatDigit` before anything is charged. Refusing 999.9999999999 there
 * would break "spend my whole balance" for the same reason as (3) above, and
 * would protect nothing: a budget cannot jump a queue.
 *
 * A PAIR THAT STATES NO PRECISION IS NOT SUBJECT TO EITHER RULE - see
 * `precisionDigits`. A missing `firstFloatDigit` reaching `toFixedDown` would
 * take its DEFAULT of 2 and truncate a BTC quantity to two decimal places,
 * which is a much larger money defect than the one this is fixing.
 */
export const quantiseOrderSize = (value, digits) => {
  const requested = parseFloat(value);
  const allowed = precisionDigits(digits);
  if (allowed === null || !Number.isFinite(requested)) return requested;
  const places = decimalPlaces(requested);
  if (places === null || places <= allowed) return requested;
  const truncated = toFixedDown(requested, allowed);
  // `toFixedDown` answers "" for anything it cannot truncate. A size that
  // cannot be quantised is handed back unchanged so the ordinary numeric
  // guards below refuse it, rather than becoming "" and coercing to 0.
  return typeof truncated === "number" && Number.isFinite(truncated)
    ? truncated
    : requested;
};

/**
 * WHAT A MARKET ORDER ACTUALLY COSTS, AND OUT OF WHICH COIN
 * ========================================================
 *
 * A market BUY spends the QUOTE currency (`orderValue`) and a market SELL
 * delivers the BASE currency (`amount`), and a BUY's request is quantised to
 * the pair's base precision before it is charged - the user is billed for the
 * quantity the venue can actually express, not the one they typed.
 *
 * The pairing (which side, which coin, which unit) and the quantisation used to
 * live inline in marketOrderPlace, computed once, immediately before the debit.
 * That was fine while the debit was the only thing that needed it. It is not
 * fine now that the REJECTION path needs the same number, and a second copy of
 * "what does this order cost" is exactly the kind of duplicate that drifts:
 * a pre-check computed from the RAW request would refuse an order for one
 * satoshi of rounding that the real check, run on the quantised value a hundred
 * lines later, would have let through. One definition, both call sites.
 *
 * THE QUANTITY IS PART OF THE SAME DEFINITION, AND SPLITTING IT MINTED COIN.
 * ==========================================================================
 * The debit was computed from the QUANTISED quantity and the order was written
 * with the RAW one:
 *
 *     orderValue   = toFixedDown(orderValue / markPrice, firstFloatDigit) * markPrice
 *     quantity     = orderValue / markPrice        <- untruncated, in marketOrderPlace
 *     openQuantity = orderValue / markPrice        <- untruncated
 *
 * so the account paid for `truncQty` of the base coin and the book carried an
 * order for `rawQty`, every market BUY, deterministically, always in the user's
 * favour. The gap is (rawQty - truncQty) * markPrice, i.e. anything up to
 * `markPrice * 10^-firstFloatDigit` of quote currency created per order.
 *
 * MEASURED LIVE on this stack, own throwaway account, SOLUSD
 * (firstFloatDigit 9, markPrice 74.72), one ordinary `POST /api/spot/orderPlace`
 * market buy of orderValue 100:
 *
 *     walletbalance_spot USD  10000 -> 9900.0000000339205144   (debited 99.99999996607949)
 *     orderHistory.openQuantity      1.3383297644539616         (raw)
 *     orderHistory.orderValue        99.99999996608             (truncQty * markPrice)
 *
 * 3.39e-8 USD of SOL handed over unpaid for, from one order. Small, and NOT
 * left as "documented dust": it is deterministic, it is unbounded in aggregate
 * (once per market buy, and market buys are unlimited), and on BTCUSD
 * (firstFloatDigit 8, markPrice ~65,000) the same shape is worth up to 6.5e-4
 * USD per order rather than 1e-8. A venue whose whole product is a scoreboard
 * does not get to round in one direction.
 *
 * So the quantity has ONE producer, `marketOrderQuantity`, and the debit is
 * defined as `that quantity x markPrice`. They cannot disagree, because the
 * debit is derived from the quantity rather than recomputed beside it.
 */
export const marketOrderDebitCurrencyId = (reqBody, spotPairData) =>
  reqBody.buyorsell == "buy"
    ? spotPairData.secondCurrencyId
    : spotPairData.firstCurrencyId;

/**
 * The BASE-coin quantity this market order is actually for.
 *
 * A SELL names it directly (`amount`). A BUY names a quote-currency budget, and
 * the quantity it buys is quantised DOWN to the pair's base precision - the
 * venue cannot express a finer size, so it must not sell one either.
 *
 * `requested / 0` is Infinity, and `requested / undefined` is NaN. For BOTH,
 * `toFixedDown` answers "" - it has always done so for NaN, and since the
 * rounding-helper round it does so for Infinity too rather than handing the
 * infinity back untruncated. Left to the coercion, `"" * markPrice` is 0, and
 * that number is the DEBIT, so a 0 here would be a free order. (Infinity * 0
 * was NaN, which `usrWallet < NaN` waved through just as silently.) A quantity
 * that could not be computed is NaN and stays NaN: the debit derived from it is
 * NaN too, `isMarketOrderUnaffordable` refuses to judge a non-finite debit, and
 * `hincrbyfloatIfEnough` refuses a non-finite reservation outright.
 */
export const marketOrderQuantity = (reqBody, spotPairData) => {
  if (reqBody.buyorsell != "buy") {
    return parseFloat(reqBody.amount);
  }
  const requested = parseFloat(reqBody.orderValue);
  const truncated = toFixedDown(
    requested / spotPairData.markPrice,
    spotPairData.firstFloatDigit
  );
  if (typeof truncated !== "number" || !Number.isFinite(truncated)) {
    return NaN;
  }
  return truncated;
};

export const marketOrderDebitValue = (reqBody, spotPairData) => {
  if (reqBody.buyorsell != "buy") {
    return parseFloat(reqBody.amount);
  }
  const quantity = marketOrderQuantity(reqBody, spotPairData);
  if (!Number.isFinite(quantity)) {
    return NaN;
  }
  return parseFloat(quantity * spotPairData.markPrice);
};

/**
 * Can this account pay for this market order at all?
 *
 * FAILS OPEN, DELIBERATELY. It answers `true` only when a balance was actually
 * READ and that balance cannot cover the debit. A field that has never been
 * written (a first-touch account whose Redis row marketOrderPlace hydrates
 * further down, via updateUserWallet) answers `false` - "not known to be
 * unaffordable" - because the only thing this verdict is used for is choosing
 * WHICH refusal message to send, and guessing "you are broke" at someone whose
 * balance has not been read yet is a worse answer than the liquidity message it
 * would replace.
 *
 * Reading is not mutating: this runs on a path that has already decided to
 * refuse, so no balance moves either way.
 */
export const isMarketOrderUnaffordable = async (userId, reqBody, spotPairData) => {
  try {
    const debit = marketOrderDebitValue(reqBody, spotPairData);
    if (!Number.isFinite(debit) || debit <= 0) return false;
    const raw = await hget(
      "walletbalance_spot",
      `${userId}_${marketOrderDebitCurrencyId(reqBody, spotPairData)}`
    );
    if (raw == null) return false;
    const balance = parseFloat(raw);
    if (!Number.isFinite(balance)) return false;
    return balance < debit;
  } catch (err) {
    console.log("isMarketOrderUnaffordable: could not read balance", err);
    return false;
  }
};

/**
 * THE IN-ORDER LEDGER INVARIANT
 * -----------------------------
 * walletbalance_spot_inOrder[<userId>_<currencyId>] is the sum, over that
 * user's own still-open orders, of the balance that was actually MOVED OUT of
 * walletbalance_spot and is not yet spent. It is therefore:
 *
 *   - INCREMENTED in exactly one place: limitOrderPlace, by `orderValue`
 *     (price * quantity in the quote currency for a buy, quantity in the base
 *     currency for a sell) at the same moment walletbalance_spot is debited by
 *     the same number. Its rollback path decrements symmetrically.
 *   - DECREMENTED only as that reservation is consumed: per fill by the exact
 *     size of THAT fill (price * execQty for a buy, execQty for a sell), and on
 *     cancellation by the remaining unfilled reservation.
 *
 * Two order kinds are outside the ledger entirely and must never decrement it:
 *   - MARKET orders (`flag === true`): marketOrderPlace debits
 *     walletbalance_spot and never credits in-order.
 *   - PAPER ladder orders (`isPaper === true`): synthetic Binance-depth
 *     liquidity that was never debited from anything.
 *
 * Every release therefore goes through releaseInOrder(), which enforces both
 * exemptions in one place and clamps at zero, so no arithmetic drift or future
 * caller can push a user's reservation below the amount actually reserved.
 *
 * WHY THE RESERVATION IS CARRIED ON THE ORDER (`inOrderReserved`)
 * --------------------------------------------------------------
 * The two halves of the round trip used to be computed from DIFFERENT numbers,
 * and the difference stayed behind forever.
 *
 *   RESERVE, once:   inOrder += P * Q                 (P, Q as the client sent)
 *   RELEASE, n+1 times: inOrder -= P * q1, P * q2, ... (per fill)
 *                       inOrder -= P * Qrem            (the cancel, or the last
 *                                                       fill's remainder)
 *
 * Those agree in real arithmetic and not in binary floating point: `P*q1 +
 * P*q2` is not `P*(q1+q2)`, and the residue never returns to zero because
 * nothing else ever writes the field. Worse, `Qrem` is not even the exact
 * remainder - the matcher REWRITES the resting quantity through
 * `toFixed(..., firstFloatDigit)` after every partial fill (buyExcAmount /
 * sellExcAmount), so a quantity the reservation was taken on is released as a
 * rounded one. releaseInOrder clamps at zero, which means the drift is
 * one-directional: an over-release is absorbed, an under-release is kept.
 *
 * MEASURED ON THIS STACK. `cryptodex_walletbalance_spot_inOrder` field
 * `6a70f1c287c92c7218ac37fc_695bf0e2b9aba016fb8ce3c4` (USD) read
 * 0.00000000000090949 - exactly 2**-40 - for an account with NO open orders at
 * all, after 147 limit placements and 132 cancels. It is dust, but it is dust
 * that only ever accumulates, it is subtracted from the free balance every
 * client shows, and the same asymmetry at a larger quantity is a real trapped
 * reservation rather than a rounding curiosity.
 *
 * So the exact number credited at placement is stamped on the order as
 * `inOrderReserved`, the running total given back is accumulated on it as
 * `inOrderReleased`, and the release that RETIRES the order (`final: true` -
 * the cancel, and the fill that completes it) gives back exactly what is left
 * of that reservation rather than a re-derived product. A full reserve/release
 * round trip is then neutral by construction, whatever the fill schedule was.
 *
 * Orders written before this field existed carry no `inOrderReserved`; for
 * those the remainder is unknowable and the caller's amount is used exactly as
 * it was before, so nothing that is already resting changes behaviour.
 */

/** What is left of THIS order's own reservation, or null if it never had one. */
export const reservationRemaining = (order) => {
  const reserved = parseFloat(order && order.inOrderReserved);
  if (!Number.isFinite(reserved) || reserved <= 0) return null;
  const released = parseFloat(order && order.inOrderReleased);
  const given = Number.isFinite(released) && released > 0 ? released : 0;
  return Math.max(reserved - given, 0);
};

/**
 * A RETIRED ORDER HOLDS NOTHING - said once, so it is true on every exit.
 *
 * The bookkeeping and the ledger cannot be kept identical by arithmetic alone:
 * the ledger is reduced by successive subtractions (`(R - a) - b`) while the
 * remainder is computed in one (`R - (a + b)`), and those differ in the last
 * bit. So the retiring release closes the order's book by DEFINITION rather
 * than by subtraction - it has left the book, it will never reserve again, and
 * whatever it could give back it has given. Without this a retired order still
 * reports a femto-remainder, which is the same "residue nobody owns" this whole
 * mechanism exists to end, just moved onto the order document.
 */
const markReservationRetired = (order) => {
  const reserved = parseFloat(order && order.inOrderReserved);
  if (Number.isFinite(reserved) && reserved > 0) {
    order.inOrderReleased = reserved;
  }
};

export const releaseInOrder = async (
  order,
  currencyId,
  amount,
  { final = false } = {}
) => {
  if (!order || order.flag === true || order.isPaper === true) {
    return null;
  }
  const remaining = reservationRemaining(order);
  let release = parseFloat(amount);
  if (remaining !== null) {
    // THE ORDER'S OWN RESERVATION IS THE AUTHORITY, not the caller's product.
    // On the retiring release that is the whole remainder - the only number
    // that makes the round trip exact. On a partial fill it is a CEILING: an
    // order can never give back more than it took, however the per-fill
    // arithmetic rounds.
    release = final
      ? remaining
      : Math.min(Number.isFinite(release) ? release : 0, remaining);
  }
  if (!(release > 0)) {
    // Nothing left to give back. A retiring order still sweeps, because the
    // residue this is called to clear can be smaller than one full release.
    if (final) {
      markReservationRetired(order);
      await sweepResidualInOrder(order.userId, currencyId);
    }
    return null;
  }
  const field = order.userId + "_" + currencyId;
  const current = parseFloat((await hget("walletbalance_spot_inOrder", field)) || 0);
  const applied = Math.min(release, Math.max(current, 0));
  if (applied < release) {
    console.log(
      "releaseInOrder: clamped release",
      field,
      "requested",
      release,
      "available",
      current,
      "order",
      order._id
    );
  }
  if (!(applied > 0)) {
    if (final) {
      markReservationRetired(order);
      await sweepResidualInOrder(order.userId, currencyId);
    }
    return String(Math.max(current, 0));
  }
  const next = await hincbyfloat("walletbalance_spot_inOrder", field, -applied);
  if (remaining !== null) {
    // Accumulated on the order object itself, which every caller then hset()s
    // back into the book or into orderHistory, so a second partial fill cannot
    // re-release the share the first one already gave back.
    const given = parseFloat(order.inOrderReleased);
    order.inOrderReleased =
      (Number.isFinite(given) && given > 0 ? given : 0) + applied;
  }
  if (final) {
    markReservationRetired(order);
    await sweepResidualInOrder(order.userId, currencyId);
  }
  return next;
};

/**
 * THE PART OF A RETIRING ORDER'S ESCROW THAT WAS NEVER SOLD.
 * =========================================================
 *
 * THE DEFECT, MEASURED. When a resting order is partly filled the matcher
 * rewrites its remaining `quantity` through `toFixedDown(..., firstFloatDigit)`
 * - correctly: a remainder must only ever shrink (d35e676). But the ESCROW
 * counter keeps the exact remainder, so from that moment the order's quantity
 * and its reservation disagree by up to 10^-firstFloatDigit. The fill that
 * RETIRES the order then releases the whole remaining reservation out of
 * `walletbalance_spot_inOrder` with `{final: true}` - and nothing put the
 * unsold difference back into `walletbalance_spot`.
 *
 * The coin had really been debited at placement (limitOrderPlace moves it out
 * of the spendable balance and into the escrow counter in the same step), so it
 * was not "released", it was destroyed: the seller neither sold it nor got it
 * back.
 *
 * BOTH SIDES, NOT JUST THE SELL. The report this fixes named the sell side and
 * said the buy side was already covered by the `spot_limit_bal_retrieve` credit
 * beside it. It is not: that credit is the PRICE-IMPROVEMENT refund
 * (limitPrice - execPrice) * executed quantity, which is about the price of the
 * coin that WAS bought and says nothing about the quantity that was not. The
 * regression test measures both against the same invariant and, run against
 * HEAD, the buy side destroyed 0.0006320567335933447 USD on the same shape that
 * cost the sell side 9.875885673485407e-9 BTC. The credit-back is therefore
 * applied at all four retiring releases - limit and market matching, both
 * sides.
 *
 *   MEASURED LIVE, BTCUSD: reconstructing an account from seed + faucet + every
 *   tradeHistory row left it short by exactly 9.87588606428608e-9 BTC after one
 *   such fill, while the same reconciliation over 22 ordinary trades on another
 *   account closed to 3.5e-18.
 *
 * It is dust - bounded by 10^-firstFloatDigit per retiring fill, about
 * $0.00064 on BTC - and it is still money the ledger cannot account for. It is
 * also the exact mirror of d35e676, which fixed the same disagreement pointing
 * the other way (a cancel refunding MORE than was reserved).
 *
 * WHAT THIS RETURNS: reservation still held, minus the part of it this fill is
 * actually consuming. Read BEFORE the retiring release, because that release
 * marks the reservation retired and there is nothing left to measure after it.
 *
 *   `consumed` is the fill in the SAME UNIT the reservation is held in: base
 *   quantity for a sell, price * quantity for a buy.
 *
 * Zero for anything without a reservation of its own - a market order
 * (`flag`), the synthetic paper ladder (`isPaper`), and any order written
 * before `inOrderReserved` existed - which are the same three exemptions
 * releaseInOrder enforces, for the same reason: nothing was debited, so there
 * is nothing to give back.
 */
export const unspentReservationOf = (order, consumed) => {
  if (!order || order.flag === true || order.isPaper === true) return 0;
  const remaining = reservationRemaining(order);
  if (remaining === null) return 0;
  const spent = parseFloat(consumed);
  const unspent = remaining - (Number.isFinite(spent) && spent > 0 ? spent : 0);
  return unspent > 0 ? unspent : 0;
};

/**
 * ...and the credit that puts it back, with the audit row that says so.
 *
 * Called only from a retiring fill, only for a real (non-synthetic) account,
 * and only after the amount has been measured against the order's own
 * reservation - so it can never return more than was taken. A synthetic
 * counterparty is excluded by the caller as well as by the `isPaper` test
 * above: the ladder is credited by nobody because it is debited by nobody (see
 * settlementCredit).
 */
const refundUnspentReservation = async ({
  order,
  currencyId,
  coin,
  unspent,
}) => {
  if (!(unspent > 0)) return null;
  const field = order.userId + "_" + currencyId;
  const after = await moveBalanceSigned("walletbalance_spot", field, unspent, {
    reason: "unspent_reservation_refund",
    ref: String(order._id || ""),
  });
  const before = parseFloat(after) - unspent;
  passbook({
    userId: order.userId,
    coin,
    currencyId,
    tableId: order._id,
    beforeBalance: before,
    afterBalance: parseFloat(after),
    amount: unspent,
    // Its own type rather than the buy side's `spot_limit_bal_retrieve`: this
    // is not price improvement, it is the sub-precision remainder of an order
    // that has retired, and an auditor reconciling an account needs to be able
    // to tell the two apart.
    type: "spot_escrow_dust_retrieve",
    category: "credit",
  });
  console.log(
    "refundUnspentReservation: returned unsold escrow",
    field,
    unspent,
    "order",
    order._id
  );
  return after;
};

/**
 * THE LAST SATOSHI, RETURNED ONCE NOTHING IS HOLDING IT.
 *
 * The exact-remainder release above removes the SOURCE of the drift, but it
 * cannot remove the drift already sitting in redis, and it cannot make
 * HINCRBYFLOAT's own decimal round trip exact. So once an order retires, if the
 * user has NOTHING left that reserves this currency - no resting non-paper
 * LIMIT order on any pair whose reserved currency is this one - then whatever
 * is still in `walletbalance_spot_inOrder` is by definition unowned, and it is
 * returned to zero.
 *
 * IT ONLY EVER SWEEPS DUST, and the ceiling is load-bearing rather than
 * decorative. limitOrderPlace credits the in-order ledger BEFORE it writes the
 * order into the book, so there is a window in which a concurrent placement's
 * reservation exists and its order does not; without the ceiling this scan
 * would find no order, call the reservation unowned, and wipe a live one. Every
 * real reservation is enormous by comparison - a buy reserves at least the
 * pair's `minOrderValue` (10 USD on the live pairs) and a sell at least
 * `minQuantity` - so 1e-7 separates "float residue" from "somebody's money"
 * with many orders of magnitude to spare, and caps what this can ever release
 * at a ten-millionth of a unit.
 *
 * IT MOVES ONLY THE RESERVATION COUNTER, and it is not this function's job to
 * decide whether anything was owed.
 *
 * THE ORIGINAL VERSION OF THIS PARAGRAPH WAS WRONG, AND THE CORRECTION IS THE
 * POINT. It read: "`walletbalance_spot` - the actual money - is not touched,
 * because nothing was actually owed: the dust is an over-statement of what is
 * escrowed, not an under-payment." That is true of the HINCRBYFLOAT round-trip
 * residue this was written for, and FALSE of the other thing that lands in the
 * same counter: when a partial fill truncates a resting order's `quantity` to
 * `firstFloatDigit` while the escrow keeps the exact remainder, the difference
 * IS money the user was really debited for at placement. Sweeping it silently
 * to zero was the last step of destroying it.
 *
 * The under-payment is now settled where it can be identified - at the retiring
 * fill, against that order's own reservation, by `unspentReservationOf` /
 * `refundUnspentReservation` above, which credit `walletbalance_spot` and write
 * a passbook row. By the time this sweep runs, what is left really is
 * ownerless float residue with no order behind it, so returning it to zero
 * without touching the balance is correct - for a reason that has been checked
 * rather than assumed.
 */
export const RESIDUAL_IN_ORDER_DUST = 1e-7;

/** The currency an order's reservation is denominated in. */
export const reservedCurrencyOf = (order) =>
  order && order.buyorsell === "buy"
    ? order.secondCurrencyId
    : order && order.firstCurrencyId;

export const sweepResidualInOrder = async (userId, currencyId) => {
  try {
    if (!userId || !currencyId) return null;
    const field = userId + "_" + currencyId;
    const current = parseFloat(
      (await hget("walletbalance_spot_inOrder", field)) || 0
    );
    if (!Number.isFinite(current) || current <= 0) return null;
    if (current > RESIDUAL_IN_ORDER_DUST) return null;

    let pairList = await hgetall("spotPairdata");
    const pairs = Object.values(pairList || {})
      .map((value) => {
        try {
          return typeof value === "string" ? JSON.parse(value) : value;
        } catch (err) {
          return null;
        }
      })
      .filter(Boolean);
    // No pair cache means no way to prove the reservation is unowned, and an
    // unproven sweep must not happen.
    if (pairs.length === 0) return null;

    for (const pair of pairs) {
      for (const side of ["buy", "sell"]) {
        const resting = await hgetall(`${side}OpenOrders_${pair._id}`);
        for (const raw of Object.values(resting || {})) {
          let row;
          try {
            row = typeof raw === "string" ? JSON.parse(raw) : raw;
          } catch (err) {
            continue;
          }
          if (!row) continue;
          if (row.isPaper === true || row.flag === true) continue;
          if (row.orderType !== "limit") continue;
          if (String(row.userId) !== String(userId)) continue;
          if (String(reservedCurrencyOf(row)) !== String(currencyId)) continue;
          return null; // something still reserves this currency
        }
      }
    }

    const next = await hincbyfloat(
      "walletbalance_spot_inOrder",
      field,
      -current
    );
    console.log("sweepResidualInOrder: released unowned residue", {
      field,
      released: current,
      now: next,
    });
    return next;
  } catch (err) {
    console.log("sweepResidualInOrder: failed", err && err.message);
    return null;
  }
};

/**
 * THE BOOK AN ARRIVING LIMIT ORDER IS JUDGED AGAINST.
 *
 * Returns { bestBid, bestAsk } - the best prices resting on each side right
 * now, which is what decides whether the order takes liquidity (taker) or
 * provides it (maker).
 *
 * TWO SOURCES, because the pairs have two different liquidity models:
 *
 *   botstatus "binance" - the tradable book IS the synthetic ladder, and
 *     paperBook records the top of exactly what it wrote to redis. That
 *     assertion is in memory and synchronous, which matters on the order path:
 *     re-reading both open-order hashes here would add two full hgetalls to
 *     every placement, and syncPaperBook has a millisecond window each cycle in
 *     which redis holds ZERO paper rows while the ladder is perfectly healthy
 *     (see the note in lib/orderGate.js). Reading redis would call an order
 *     placed in that window a maker purely because the writer was mid-replace.
 *
 *   everything else - "off"/"bot" pairs have no ladder; their counterparty is
 *     synthesised from markPrice by liqOrdCreation, so markPrice IS the far
 *     side. This is the same comparison limitOrderPlace already made inline to
 *     compute `makerStatus`.
 *
 * Never throws: an unresolvable book yields nulls, which crossesBook reads as
 * "nothing to take", i.e. the order rests. That is the correct reading - if we
 * cannot see liquidity on the far side we must not bill the user as though they
 * had consumed it.
 */
export const bookTopFor = (spotPairData) => {
  try {
    if (!spotPairData) return { bestBid: null, bestAsk: null };
    if (spotPairData.botstatus === "binance") {
      const ladder = getLadderState(spotPairData._id);
      if (!ladder || !ladder.present) return { bestBid: null, bestAsk: null };
      return { bestBid: ladder.bestBuy, bestAsk: ladder.bestSell };
    }
    const mark = parseFloat(spotPairData.markPrice);
    if (!(mark > 0)) return { bestBid: null, bestAsk: null };
    return { bestBid: mark, bestAsk: mark };
  } catch (err) {
    console.log("bookTopFor: could not resolve top of book", err);
    return { bestBid: null, bestAsk: null };
  }
};

/**
 * STRIP EVERY FEE FIELD ON THE WAY OUT.
 *
 * This venue charges nothing, and the fee machinery is deleted rather than
 * zero-rated. But the PAIR DOCUMENTS still carry the old fields: `makerFee`,
 * `takerFee` and `spotFee` were never schema paths, they are raw properties on
 * documents written before the withdrawal, and every read feeding getPairList
 * uses `.lean()`, which hands them straight through.
 *
 * So without this overlay a served pair still advertises `makerFee: 0.1` on a
 * venue that charges 0 - the exact published-rate lie the old `withChargedFees`
 * existed to fix, reintroduced by deleting it. Removing the schema path is not
 * enough; the stored data has to be masked on the way out.
 *
 * Non-mutating: the redis cache and the mongo document are the pair editor's
 * business. Only what is SAID about the pair changes here.
 */
export const withoutFeeFields = (pairData) => {
  if (!pairData) return pairData;
  const {
    makerFee, takerFee, spotFee, maker_rebate, taker_fees, ...rest
  } = pairData;
  return rest;
};

/**
 * THE PAIR DOCUMENT AS THE PUBLIC PAIR LIST SHOULD SERVE IT.
 *
 * WHAT WAS WRONG
 * --------------
 * /api/spot/tradePair served `last`, `markPrice`, `last_bid` and `last_ask`
 * straight out of the `spotPairdata` redis cache. Those four are written by ONE
 * writer - the Binance 24h ticker stream in binance.controller.js - and nothing
 * anywhere re-derives them from the book this exchange actually matches
 * against. So when that stream lags or drops (it is one websocket, it does
 * reconnect, and its cadence is not the matcher's), the public price list goes
 * on quoting whatever it last heard. Measured on the running stack: ETH/USD was
 * served as last_bid 1869.34 / last_ask 1869.35 while the tradable ladder was
 * resting at 1873.78 / 1873.79 - the displayed top of book was 0.24% away from
 * the only prices anything could fill at, and markPrice/last were stale in the
 * same direction. A user reading that list and hitting "buy" was quoted one
 * price and matched at another.
 *
 * WHAT IT SERVES NOW
 * ------------------
 * bookTopFor() - the SAME function limitOrderPlace crosses an arriving order
 * against to decide maker or taker, reading the SAME in-memory ladder assertion
 * the gated book publisher reads (paperBook.getLadderState). There is no second
 * derivation to drift: if the list says 1873.78 then that is the price an order
 * is judged against, priced at and filled at.
 *
 *   - `last_bid` / `last_ask` become the tradable top of book.
 *   - `markPrice` follows the best BID, which is exactly the identity
 *     binance.controller.js already publishes (`markPrice: bestBid`); only the
 *     source changes, from the ticker mirror to the ladder that will actually
 *     take the order. This is the number the pair list renders and the number
 *     the limit-order form pre-fills, so it is the one a user acts on.
 *   - `last` is deliberately NOT touched. It means LAST TRADED PRICE - on
 *     "off"/"bot" pairs marketPrice() derives it from real trade history - and
 *     the top of book is not a trade. Overwriting it here would replace a fact
 *     with a quote.
 *
 * WHEN THERE IS NO TRADABLE TOP the document is returned UNTOUCHED. A pair
 * whose ladder is absent cannot fill at all - assertOrderTradable refuses every
 * order on it - so there is no quote to correct and no better number to invent;
 * blanking the list would only replace a stale price with none. This is
 * deliberately the one direction the overlay does not act in.
 *
 * PURE apart from bookTopFor's own in-memory read, and non-mutating: the redis
 * cache is left alone, because these fields are that cache's writer's business
 * and a display path must not race it.
 */
export const withTradableTop = (pairData) => {
  if (!pairData) return pairData;
  const { bestBid, bestAsk } = bookTopFor(pairData);
  const bid = parseFloat(bestBid);
  const ask = parseFloat(bestAsk);
  if (!(bid > 0) || !(ask > 0)) return pairData;
  return {
    ...pairData,
    last_bid: bid,
    last_ask: ask,
    markPrice: bid,
  };
};

/**
 * THE SYNTHETIC COUNTERPARTY IS NOT A LEDGER ACCOUNT.
 * ==================================================
 *
 * Every fill credited BOTH legs: the buyer got base, the seller got quote. For
 * two real users that is complete, because each of them was DEBITED the other
 * leg when their order was accepted (limitOrderPlace/marketOrderPlace move the
 * money out of walletbalance_spot before the order ever enters the book).
 *
 * The synthetic counterparty is never debited, because it never places an order
 * through those paths - paperBook.controller.js hsets the ladder straight into
 * the open-order hashes, out of nothing, and throws it away again two seconds
 * later. So the settlement credited it on one leg with no matching debit on the
 * other, on every single fill, forever. Measured on the running stack before
 * this change, the admin bot's spot balances had grown to 234,978 USD /
 * 0.0777 BTC / 104 SOL / 242 ETH purely out of that asymmetry. No user is
 * harmed by it - it is house liquidity - but it is unbounded, and it makes
 * every admin balance report a number with no meaning.
 *
 * DEBIT BOTH LEGS, OR EXEMPT IT? Exempt it, and here is why debiting is worse:
 * the ladder holds no inventory to debit. It is re-derived wholesale from live
 * Binance depth every 2s and has no persistent position, so debiting the other
 * leg would simply drive the same account unboundedly NEGATIVE in the asset it
 * keeps selling and unboundedly positive in the one it keeps buying. That is
 * not a more meaningful ledger, it is the same meaningless number with a sign
 * flip - and a negative balance is one that other readers (dashboards,
 * withdrawal paths, readSpotBalanceNumber) can act on.
 *
 * The service ALREADY takes this position everywhere else it touches the
 * synthetic, and this only finishes the job:
 *   - releaseInOrder(): `isPaper` never releases, because it never reserved.
 *   - cancelAuthorised(): a synthetic order may not be cancelled, because
 *     "refunding it credits balance out of nothing".
 *   - purgePaperBook(): never routes a deletion through the refunding cancel.
 *
 * So: no balance move, no passbook row, and no fee - the house does not pay
 * itself a fee, and recording one inflated saveAdminprofit with revenue that
 * was never collected from anyone.
 *
 * THE CONSEQUENCE, WHICH NOBODY HAD WRITTEN DOWN: with one leg exempt, THE
 * VENUE-WIDE SUM OF ANY SPOT COIN IS NOT CONSERVED ACROSS A FILL. That is
 * correct here and it is not a leak - but it means "total value conserved" is
 * the wrong invariant to audit spot against, and reaching for it is how a
 * balance-destroying endpoint hid in plain sight through several passes. The
 * invariant that IS true, and the list of endpoints allowed to mint or burn, is
 * stated in full in controllers/paperLedger.js, under the heading
 *     THE SPOT MONEY-SUPPLY INVARIANT
 * Read that before auditing balances.
 */
const settlementCredit = async (order, currencyId, amount, synthetic) => {
  if (synthetic) return null;
  // THROUGH THE LEDGER, NOT AROUND IT. This is the credit leg of a fill: the
  // one movement a user is most entitled to see a record of. It used to be a
  // bare hincbyfloat with the passbook row written separately and afterwards,
  // so a crash in between settled a fill that no record could reconstruct.
  // moveBalanceLogged appends the entry inside the same atomic step, so the
  // credit and its justification cannot exist apart. See lib/ledger.js.
  //
  // FAILURE BEHAVIOUR IS DELIBERATELY UNCHANGED. The old hincbyfloat swallowed
  // its own redis error and answered null; this runs mid-fill, after the orders
  // have been removed from the book and the passbook rows queued, so a throw
  // here would abandon the counterparty's credit AND the whole tick's history
  // flush. That is a worse outcome than a failed credit, so the error is caught
  // and reported the same way it always was: null, loudly logged, nothing else
  // unwound. Making this throw is a separate change that needs the settlement
  // path to be transactional first.
  let moved;
  try {
    moved = await moveBalanceLogged(
      "walletbalance_spot",
      order.userId + "_" + currencyId,
      amount,
      { direction: "credit", reason: "fill_settlement", ref: String(order._id || "") }
    );
  } catch (err) {
    console.log("err on settlementCredit---", err && err.message);
    return null;
  }
  return moved && moved !== "FROZEN" ? moved.balance : null;
};

/**
 * Trade Decrypt
 * BODY : token
 *
 * A TOKEN THAT DOES NOT DECRYPT IS A BAD REQUEST, NOT A BROKEN VENUE.
 * ------------------------------------------------------------------
 * `decryptObject` swallows its own failure and answers `""` (lib/cryptoJS.js),
 * so a corrupt or truncated token used to be installed as `req.body` and the
 * request walked on into orderPlaceValidate reading `.orderType` off a string.
 * It happened to land on a 400 there, but by accident and with an error naming
 * the wrong field; anything downstream that touched the body first got a 500.
 * Say the true thing at the point the fault is known. Same rule as cancelOrder
 * below: 5xx is a promise that the fault is OURS, and a client's retry policy
 * believes it.
 */
export const decryptTradeOrder = (req, res, next) => {
  try {
    let token = decryptObject(req.body.token);
    if (isEmpty(token) || typeof token !== "object") {
      return res.status(400).json({ errors: { token: "INVALID" } });
    }
    req.body = token;
    return next();
  } catch (err) {
    return res.status(500).json({ status: false, message: "Something Wrong" });
  }
};
// * Create ObjectId
function createobjectId() {
  return (
    hexval(Date.now() / 1000) +
    " ".repeat(16).replace(/./g, () => hexval(Math.random() * 16))
  );
}
function hexval(value) {
  return Math.floor(value).toString(16);
}
/**
 * Update Order Book
 * PARAMS : pairId
 */
const minTwoDigits = (n) => {
  let j = 1;
  for (let i = 0; i < n; i++) {
    j = j + "0";
  }
  return parseFloat(j);
};
/**
 * Get Spot Trade Pair List
 * METHOD: GET
 * URL : /api/spot/tradePair
 */
export const getPairList = async (req, res) => {
  try {
    let spotPairDoc = await hgetall("spotPairdata");
    let newArr = [];
    if (spotPairDoc && Object.keys(spotPairDoc).length > 0) {
      spotPairDoc = await getActivePairs(spotPairDoc);
    } else {
      // If Redis cache is empty, fetch directly from database
      spotPairDoc = await SpotPair.find({ status: "active" }).lean();
    }
    if (spotPairDoc?.length > 0) {
      for (let i = 0; i < spotPairDoc.length; i++) {
        if (spotPairDoc[i]._id) {
          // For binance botstatus, check if pair already has price data from cache
          if (spotPairDoc[i].botstatus === 'binance' && spotPairDoc[i].last && spotPairDoc[i].last > 0) {
            // Use the cached price data directly without calling marketPrice,
            // but never publish its top of book: that cache is the Binance
            // ticker mirror and the matcher trades the ladder. See
            // withTradableTop.
            newArr.push(withoutFeeFields(withTradableTop(spotPairDoc[i])));
          } else {
            // Call marketPrice to get/refresh price data
            await marketPrice(spotPairDoc[i]._id);
            let changesDoc = await hget("spot24hrsChange", spotPairDoc[i]._id);
            if (changesDoc) {
              try {
                changesDoc = typeof changesDoc === 'string' ? JSON.parse(changesDoc) : changesDoc;
              } catch (e) {
                changesDoc = {};
              }
            } else {
              changesDoc = {};
            }
            // The overlay goes on LAST: spot24hrsChange carries its own
            // markPrice/last and would otherwise put the stale pair back.
            newArr.push(
              withoutFeeFields(
                withTradableTop({ ...spotPairDoc[i], ...changesDoc })
              )
            );
          }
        }
      }
    }
    // DETERMINISTIC ORDER. This list is read from a redis HASH, and a hash has
    // no order - `hgetall` returned the pairs in whatever sequence redis felt
    // like, which was not the order they were written in and not the order mongo
    // holds them. That matters because the frontend's /spot route redirects to
    // `pairList[0]`: with three markets cached, the landing pair was decided by
    // redis internals, and users were sent to SOL/USD on a venue whose first
    // mongo row is BTC. Sorting by ticker makes the answer the same every time,
    // for every consumer of this endpoint - the redirect, the market tables and
    // any picker - rather than only happening to be right.
    newArr.sort((a, b) =>
      String(a.tikerRoot || "").localeCompare(String(b.tikerRoot || ""))
    );
    return res
      .status(200)
      .json({ success: true, messages: "success", result: newArr });
  } catch (err) {
    console.log("err: ", err);
    return res.status(500).json({ status: false, message: "Error occured" });
  }
};

export const getMySpotHistory = async (req, res) => {
  try {
    if (req.query.export == "pdf") {
      let filter = {};
      filter["userId"] = ObjectId(req.user.id);
      if (req.query.startDate != "" && req.query.endDate != "") {
        let startDate = new Date(req.query.startDate);
        let endDate = new Date(req.query.endDate);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        filter["orderDate"] = {
          $gte: startDate,
          $lt: endDate,
        };
      }
      const data = await OrderHistory.find(filter).sort({ _id: -1 });
      return res.json({ status: true, result: { data, count: 0 } });
    } else {
      let pagination = paginationQuery(req.query);
      let filter = filterSearchQuery(req.query, [
        "buyorsell",
        "status",
        "orderType",
        "pairName",
      ]);

      filter["userId"] = ObjectId(req.user.id);
      if (req.query.pairName != "all") {
        filter["pairName"] = req.query.pairName;
      }
      if (req.query.pairName != "all") {
        filter["pairName"] = req.query.pairName;
      }
      if (req.query.orderType != "all") {
        filter["orderType"] = req.query.orderType;
      }
      if (req.query.buyorsell != "all") {
        filter["buyorsell"] = req.query.buyorsell;
      }
      if (req.query.status != "all") {
        filter["status"] = req.query.status;
      }
      if (req.query.searchType == "searchDate") {
        let startDate = new Date(req.query.startDate);
        let endDate = new Date(req.query.endDate);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        filter["orderDate"] = {
          $gte: startDate,
          $lt: endDate,
        };
      }
      const count = await OrderHistory.find(filter).count();
      const data = await OrderHistory
        .find(filter)
        .sort({ _id: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit);
      return res.json({ status: true, result: { data, count } });
    }
  } catch (err) {
    console.log("-------------", err);
    return res.status(500).json({ status: false, message: "Error occured" });
  }
};

//tradehistory
export const getFilledOrderHistory = async (req, res) => {
  try {
    if (req.query.export == "pdf") {
      let filter = {};
      filter["userId"] = ObjectId(req.user.id);
      filter["status"] = { $in: ["completed"] };
      if (req.query.startDate != "" && req.query.endDate != "") {
        let startDate = new Date(req.query.startDate);
        let endDate = new Date(req.query.endDate);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        filter["updatedAt"] = {
          $gte: startDate,
          $lt: endDate,
        };
      }
      const data = await OrderHistory.find(filter).sort({ _id: -1 });
      return res.json({ status: true, result: { data, count: 0 } });
    } else {
      let pagination = paginationQuery(req.query);
      let filter = filterSearchQuery(req.query, [
        "buyorsell",
        "status",
        "orderType",
        "pairName",
      ]);

      if (req.query.pairName != "all") {
        filter["pairName"] = req.query.pairName;
      }
      if (req.query.pairName != "all") {
        filter["pairName"] = req.query.pairName;
      }
      if (req.query.orderType != "all") {
        filter["orderType"] = req.query.orderType;
      }

      if (req.query.buyorsell != "all") {
        filter["buyorsell"] = req.query.buyorsell;
        if (req.query.buyorsell == "buy") {
          filter["buyUserId"] = ObjectId(req.user.id);
        } else {
          filter["sellUserId"] = ObjectId(req.user.id);
        }
      } else {
        filter = {
          $or: [
            { sellUserId: ObjectId(req.user.id) },
            { buyUserId: ObjectId(req.user.id) },
          ],
          ...filter,
        };
      }

      if (req.query.status != "all") {
        filter["status"] = req.query.status;
      }

      if (req.query.searchType == "searchDate") {
        let startDate = new Date(req.query.startDate);
        let endDate = new Date(req.query.endDate);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        filter["updatedAt"] = {
          $gte: startDate,
          $lt: endDate,
        };
      }

      const count = await TradeHistory.countDocuments({
        $and: [filter],
      });
      const data = await TradeHistory.find({
        $and: [filter],
      })
        .sort({ _id: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit);
      return res.json({ status: true, result: { data, count } });
    }
  } catch (err) {
    console.log("errrrr", err);
    return res.status(500).json({ status: false, message: "Error occured" });
  }
};
/**
 * Cancel Order
 * METHOD: Delete
 * URL : /api/spot/cancelOrder/:{{orderId}}
 * PARAMS: orderId
 */
export const cancelOrder = async (req, res) => {
  try {
    let data = decryptObject(req.body.id);
    // A MALFORMED CANCEL IS A 400, NOT A 500.
    //
    // This answered `500 "Error on server"` for a body that was absent, was not
    // valid ciphertext, or simply did not carry the two fields a cancel needs -
    // none of which is a server fault. 5xx is a promise that the request was
    // fine and the VENUE broke, and clients act on that promise: a retry policy
    // re-sends a 500 (this one, forever, since the body will never decrypt any
    // better), an uptime monitor pages on it, and a circuit breaker opens on it
    // and stops sending the cancels that WOULD have worked. `decryptObject`
    // swallows its own failure and returns "" (lib/cryptoJS.js), so a truncated
    // token is indistinguishable here from a missing one - both are the
    // client's to fix, and both are told so.
    if (isEmpty(data) || isEmpty(data.tableId) || isEmpty(data.orderId)) {
      return res
        .status(400)
        .json({ status: false, message: "Order not found" });
    }
    // tableId arrives from the client, so it is only ever allowed to name an
    // OPEN-ORDER hash. Without this an "orderHistory_<userId>" tableId would
    // let a caller re-cancel an already settled order and be refunded twice.
    if (!OPEN_ORDER_TABLE.test(data.tableId)) {
      return res.status(400).json({ status: false, message: "Order not found" });
    }
    let pairId = data.tableId.split("_")[1];
    // PRE-READ, for authorisation only. Nothing here may be trusted for the
    // refund and nothing here proves the order still exists: both concurrent
    // cancels see the same value. Its only job is to reject an unauthorised
    // caller WITHOUT removing an order they were never allowed to touch.
    const preview = parseOrder(await hget(data.tableId, data.orderId));

    if (tradePair == pairId) {
      return res.status(400).json({
        success: false,
        message: "Order has been excute processing ...",
      });
    }
    if (!cancelAuthorised(preview, req.user.id, data.tableId)) {
      return res.status(400).json({ status: false, message: "Order not found" });
    }

    // THE CLAIM. Removing the order IS the permission to refund it: Redis runs
    // the read+delete as one indivisible step, so of N concurrent cancels of
    // this order exactly one gets the value back and the rest get null. Every
    // balance-moving line below therefore runs at most once per reservation.
    // It also re-reads under the claim, so a partial fill that landed between
    // the pre-read and here is reflected in the amount refunded.
    const checkOrder = parseOrder(await hgetdel(data.tableId, data.orderId));
    if (!checkOrder) {
      // Lost the race (a sibling cancel, a fill, or a purge got there first).
      return res.status(400).json({ status: false, message: "Order not found" });
    }
    // Re-check against the claimed value, not the pre-read. If it somehow fails,
    // put back exactly what was taken and refund nothing.
    if (!cancelAuthorised(checkOrder, req.user.id, data.tableId)) {
      await hset(data.tableId, data.orderId, checkOrder);
      return res.status(400).json({ status: false, message: "Order not found" });
    }
    checkOrder.status = "cancel";
    let currencyId =
      checkOrder.buyorsell == "buy"
        ? checkOrder.secondCurrencyId
        : checkOrder.firstCurrencyId;
    let orderValue =
      checkOrder.buyorsell == "buy"
        ? checkOrder.price * checkOrder.quantity
        : checkOrder.quantity;
    let marketValue =
      checkOrder.orderType == "market" && checkOrder.buyorsell == "buy"
        ? checkOrder.orderValue
        : checkOrder.amount;
    let retriveValue =
      checkOrder.orderType == "limit" ? orderValue : marketValue;
    retriveValue = parseFloat(retriveValue);

    // THE REFUND COMES FROM THE LEDGER, NOT FROM THE ORDER'S QUANTITY.
    //
    // `orderValue` above is recomputed from `checkOrder.quantity`, and that
    // field is REWRITTEN AFTER EVERY PARTIAL FILL through `toFixed`, which is
    // `Number.prototype.toFixed` and therefore rounds HALF-UP. Whenever the
    // true remainder carried more decimals than the pair's `firstFloatDigit`
    // and rounded up, cancelling refunded more than had ever been reserved -
    // deterministic money creation, with the direction chosen by the user,
    // since nothing validates an order's quantity against the pair's
    // precision. Measured: a 0.1000000005 SOL sell, 0.02 filled, cancelled for
    // 5.000004681e-10 SOL more than it was owed; on BTCUSD the same shape is
    // worth ~3.3e-4 USD per partial fill.
    //
    // `reservationRemaining` is `inOrderReserved - inOrderReleased` clamped at
    // zero: what this order actually still holds, accumulated by the same
    // releases that moved the escrow counter. Refunding that makes over-refund
    // impossible by construction rather than by getting the rounding right.
    //
    // Limit orders only, and only when the order carries the field. Market
    // orders never escrow (see `releaseInOrder`), and orders written before
    // `inOrderReserved` existed have no ledger to read - those keep the old
    // computation, which is what they were placed under.
    if (checkOrder.orderType == "limit") {
      const stillHeld = reservationRemaining(checkOrder);
      if (stillHeld !== null) {
        retriveValue = stillHeld;
      }
    }
    console.log("checkOrder", checkOrder)
    // Skipped for binance pairs: their book is drawn from the live WS feed and
    // editOrderBook would fire a REST /api/v3/depth call plus a competing
    // "orderBook" socket emit.
    const cancelPairData = await FetchpairData(checkOrder.pairId);
    if (checkOrder.liquidityType == "off")
      if (
        checkOrder.orderType != "market" &&
        cancelPairData?.botstatus !== "binance"
      ) {
        editOrderBook({
          buyorsell: checkOrder?.buyorsell || checkOrder?.type,
          price: checkOrder.price,
          minusQuantity: checkOrder.quantity,
          pairId: checkOrder.pairId,
          firstFloatDigit: checkOrder.firstFloatDigit,
        });
      }
    let userWallet = await moveBalanceSigned(
      "walletbalance_spot",
      checkOrder.userId + "_" + currencyId,
      retriveValue,
      { reason: "cancel_refund" }
    );

    // Only limit orders ever reserve in-order value (limitOrderPlace); market
    // orders debit walletbalance_spot alone, so releasing them here drove the
    // in-order ledger negative. releaseInOrder re-checks flag/isPaper and
    // clamps at zero - see the invariant note at the top of this file.
    // RETIRING: this order has just been claimed out of the book and will
    // never reserve anything again, so what it gives back is the whole
    // remainder of its own reservation - not `price * quantity` recomputed from
    // a quantity the matcher has already rounded. See releaseInOrder.
    if (checkOrder.orderType == "limit") {
      await releaseInOrder(checkOrder, currencyId, retriveValue, {
        final: true,
      });
    }
    await hset(
      "orderHistory_" + checkOrder.userId,
      checkOrder._id,
      checkOrder
    );
    getOpenOrderSocket(checkOrder.userId, checkOrder.pairId);
    getOrderHistorySocket(checkOrder.userId, checkOrder.pairId);
    newOrderHistory(checkOrder);

    if (checkOrder.liquidityType == "binance") {
      await binanceCtrl.cancelOrder({
        firstCoin: checkOrder.firstCurrency,
        secondCoin: checkOrder.secondCurrency,
        binanceId: checkOrder.liquidityId,
      });
    }
    let beforeBalanmce = userWallet - parseFloat(retriveValue);
    passbook({
      userId: checkOrder.userId,
      coin:
        checkOrder.buyorsell == "buy"
          ? checkOrder.secondCurrency
          : checkOrder.firstCurrency,
      currencyId: currencyId,
      tableId: checkOrder._id,
      beforeBalance: beforeBalanmce.toFixed(8),
      afterBalance: userWallet,
      amount: retriveValue,
      type: "order_Cancel",
      category: "credit",
    });

    socketEmitOne(
      "updateTradeAsset",
      {
        currencyId: currencyId,
        spotBal: userWallet,
      },
      req.user.id
    );
    return res
      .status(200)
      .json({ status: true, message: "Order cancelled successfully" });

  } catch (err) {
    console.log("err: ", err);
    return res.status(500).json({ status: false, message: "Error occured" });
  }
};

/**
redis pairdata fetching 
 */
export const FetchpairData = async (id = null) => {
  if (id == null) {
    return;
  }
  const pairId = id.toString();
  let pairdetials = await hget("spotPairdata", pairId);
  if (pairdetials) {
    try {
      return JSON.parse(pairdetials);
    } catch (err) {
      // unreadable cache entry: fall through and re-cache from mongo
    }
  }

  // A cache miss used to fan out into SpotPair.find({}) and compare every pair
  // in the collection, so every request naming a pairId that does not exist
  // (an old bookmark, a deleted pair, a client-supplied id) cost one full
  // collection scan. _id is indexed, and a value that cannot be an ObjectId
  // cannot match any document at all, so it costs no query whatsoever.
  if (!ObjectId.isValid(pairId)) {
    return;
  }
  let spotPairData;
  try {
    spotPairData = await SpotPair.findOne({ _id: pairId }).lean();
  } catch (err) {
    console.log("err on FetchpairData---", err);
    return;
  }
  if (!spotPairData) {
    return;
  }
  await hset("spotPairdata", spotPairData._id.toString(), spotPairData);
  return spotPairData;
};

export const getSequenceId = async (docType) => {
  try {
    const sequenceId = await SequenceId.findOneAndUpdate(
      { type: docType },
      { $inc: { lastIndex: 1 } },
      {
        new: true,
        projection: { lastIndex: 1 },
      }
    );

    if (!sequenceId) {
      await SequenceId.create({ type: docType, lastIndex: 10e10 });
      return 10e10;
    }

    return parseInt(sequenceId.lastIndex);
  } catch (err) {
    console.error(err);
  }
};

/**
 * Spot Order Place
 * METHOD : POST
 * URL : /api/spotOrder
 * BODY : newdate, spotPairId, price, quantity, buyorsell, orderType(limit,market)
 */

export const orderPlace = async (req, res) => {
  console.log('orderPlace req:>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> ', req.body);
  try {
    let reqBody = req.body;
    if (reqBody.orderType == "limit") {
      // AWAITED. Unawaited, a rejection from these handlers escapes this try
      // block entirely and becomes an unhandled rejection, which is a second
      // way for the request to end with no response ever written.
      return await limitOrderPlace(req, res);
    } else if (reqBody.orderType == "market") {
      return await marketOrderPlace(req, res);
    }
    // EVERY REQUEST GETS AN ANSWER.
    //
    // This function used to end here with no `else`. orderPlaceValidate let
    // stop_limit, stop_market and trailing_stop through, neither branch above
    // matched them, and the handler simply returned - no status, no body, no
    // `next()`. The socket stayed open until the client gave up, and one
    // connection leaked per attempt. The dispatch and the accepted-type list
    // are kept in sync in validation/spotTrade.validation.js
    // (SUPPORTED_ORDER_TYPES), so this branch should be unreachable; it exists
    // because "should be unreachable" is exactly what was believed before, and
    // a wrong answer is recoverable while no answer is not.
    return res.status(400).json({
      status: false,
      message: `Order type "${reqBody.orderType}" is not supported.`,
    });
  } catch (err) {
    console.log("err on orderPlace---", err);
    return res.status(400).json({
      status: false,
      message: "Error occured For the Interval_orderPlace_err",
    });
  }
};

/**
 * Limit order place
 * URL : /api/spotOrder
 * METHOD : POST
 * BODY : newdate, spotPairId, price, quantity, buyorsell, orderType(limit,market)
 */
export const limitOrderPlace = async (req, res) => {
  try {
    let reqBody = req.body;
    console.log("reqBody:", reqBody)
    reqBody.price = parseFloat(reqBody.price);
    reqBody.quantity = parseFloat(reqBody.quantity);
    let spotPairData = await FetchpairData(reqBody.spotPairId);
    console.log('spotPairData>>>>>>>>>>>>>: ', spotPairData);

    if (!spotPairData) {
      return res.status(400).json({ status: false, message: "Invalid Pair" });
    }
    if (spotPairData.status != "active") {
      return res
        .status(400)
        .json({ status: false, message: "Pair is not activated" });
    }

    // THE PAIR'S PRECISION - refuse the price, quantise the size. Both run
    // BEFORE the gate, the bounds checks and every balance read, so a refusal
    // costs nothing and every check below measures the number that will
    // actually rest in the book. See PRICE IS REFUSED, SIZE IS QUANTISED.
    if (exceedsPrecision(reqBody.price, spotPairData.secondFloatDigit)) {
      const allowed = precisionDigits(spotPairData.secondFloatDigit);
      return res.status(400).json({
        status: false,
        message:
          `Price must have at most ${allowed} decimal place${allowed == 1 ? "" : "s"} ` +
          `on this pair - ${spotPairData.secondCurrencySymbol} cannot express ` +
          `${decimalPlaces(reqBody.price)}. Adjust the price and try again.`,
      });
    }
    const requestedQuantity = reqBody.quantity;
    reqBody.quantity = quantiseOrderSize(
      requestedQuantity,
      spotPairData.firstFloatDigit
    );
    const quantityQuantised = reqBody.quantity !== requestedQuantity;
    if (quantityQuantised && !(reqBody.quantity > 0)) {
      // The whole order was finer than one unit of the pair's precision. The
      // minQuantity check below would refuse it too, but with a message about a
      // bound rather than about the reason, and on a pair whose minQuantity is
      // 0 it would not refuse it at all.
      return res.status(400).json({
        status: false,
        message:
          `Quantity is smaller than the smallest size this pair can trade ` +
          `(${10 ** -precisionDigits(spotPairData.firstFloatDigit)} ` +
          `${spotPairData.firstCurrencySymbol}).`,
      });
    }

    // THE FILL GATE - server side, before anything touches the wallet.
    //
    // A resting limit order is legitimate while the book is momentarily unwell,
    // so this only refuses the TERMINAL verdicts (the pair cannot carry
    // liquidity at all). It runs here, ahead of every read and every
    // hincbyfloat below, so a refusal costs the user exactly nothing.
    const limitGate = await assertOrderTradable(spotPairData, "limit");
    if (!limitGate.allowed) {
      return res.status(400).json({
        status: false,
        message: limitGate.message,
        healthReason: limitGate.reason,
      });
    }
    if (limitGate.degraded) {
      // Accepted on purpose, but say so: a limit order resting into a book that
      // cannot fill right now is the one case where "order placed" and "order
      // fillable" legitimately differ.
      console.log(
        "limitOrderPlace accepted into a degraded book---",
        String(spotPairData._id),
        limitGate.reason
      );
    }

    // WAS THIS ORDER PASSIVE OR AGGRESSIVE WHEN IT ARRIVED?
    //
    // Decided here, once, against the book that is actually resting, and
    // stamped on the order. It cannot be decided later: the paper ladder is
    // rebuilt from scratch every 2s with fresh ids and a backdated orderDate,
    // so by match time there is nothing left that says who was there first.
    // See lib/liquidityRole.js.
    const bookTop = bookTopFor(spotPairData);
    const crosses = crossesBook({
      buyorsell: reqBody.buyorsell,
      price: reqBody.price,
      bestBid: bookTop.bestBid,
      bestAsk: bookTop.bestAsk,
    });
    const liquidityRole = roleForNewOrder({
      orderType: reqBody.orderType,
      crosses,
    });

    let makerStatus = false,
      avgPrice = reqBody.price;
    if (reqBody.buyorsell == "buy" && reqBody.price >= spotPairData.markPrice && spotPairData.botstatus == "off") {
      // reqBody.price = spotPairData.markPrice;
      avgPrice = spotPairData.markPrice;
      makerStatus = true;
    }
    if (reqBody.buyorsell == "sell" && reqBody.price <= spotPairData.markPrice && spotPairData.botstatus == "off") {
      // reqBody.price = spotPairData.markPrice;
      avgPrice = spotPairData.markPrice;
      makerStatus = true;
    }
    if (reqBody.quantity < parseFloat(spotPairData.minQuantity)) {
      return res.status(400).json({
        status: false,
        message: `Quantity must not be lesser than ${spotPairData.minQuantity}`,
      });
    } else if (reqBody.quantity > parseFloat(spotPairData.maxQuantity)) {
      return res.status(400).json({
        status: false,
        message: `Quantity must not be higher than ${spotPairData.maxQuantity}`,
      });
    }
    // The percentages are stored signed (live pairs: min -90, max +100), so the
    // band has to be applied as a multiplier. Subtracting a negative min flipped
    // the window to "90-100% ABOVE market" and rejected every realistic price.
    let minPrice =
      spotPairData.markPrice * (1 + spotPairData.minPricePercentage / 100),
      maxPrice =
        spotPairData.markPrice * (1 + spotPairData.maxPricePercentage / 100);
    // console.log(minPrice, '------505', maxPrice, spotPairData)
    if (reqBody.price < minPrice) {
      return res.status(400).json({
        status: false,
        message: `Price must not be lesser than ${minPrice}`,
      });
    } else if (reqBody.price > maxPrice) {
      return res.status(400).json({
        status: false,
        message: `Price must not be higher than ${maxPrice}`,
      });
    }

    if (
      reqBody.buyorsell == "buy" &&
      parseFloat(reqBody.price * reqBody.quantity) < parseFloat(spotPairData.minOrderValue)
    ) {
      return res.status(400).json({
        status: false,
        message: `Order value must not be lesser than ${spotPairData.minOrderValue}`,
      });
    } else if (
      reqBody.buyorsell == "buy" &&
      parseFloat(reqBody.price * reqBody.quantity) > parseFloat(spotPairData.maxOrderValue)
    ) {
      return res.status(400).json({
        status: false,
        message: `Order value must not be higher than ${spotPairData.maxOrderValue}`,
      });
    }

    if (spotPairData && spotPairData.botstatus == "binance") {
      let getPriceConverSion = await priceConversionGrpc({
        baseSymbol: spotPairData.firstCurrencySymbol,
        convertSymbol: spotPairData.secondCurrencySymbol,
      });
      if (getPriceConverSion && getPriceConverSion.status) {
        let total = truncateDecimals(getPriceConverSion.convertPrice, 8);
        let checkDoller = total * reqBody.quantity;

        if (
          spotPairData.firstCurrencySymbol == "BNB" &&
          parseFloat(checkDoller) < 5
        ) {
          return res.status(400).json({
            status: false,
            message: `Total order value should be more than 5 USDT`,
          });
        }

        if (
          parseFloat(checkDoller) < 10 &&
          spotPairData.firstCurrencySymbol != "BNB"
        )
          return res.status(400).json({
            status: false,
            message: `Total order value should be more than 10 USDT`,
          });
      }
    }

    let currencyId =
      reqBody.buyorsell == "buy"
        ? spotPairData.secondCurrencyId
        : spotPairData.firstCurrencyId;
    let usrWallet = await hget(
      "walletbalance_spot",
      req.user.id + "_" + currencyId
    );
    if (usrWallet == null) {
      let createAsset = await updateUserWallet(req.user.id);
      if (createAsset == false) {
        return res.status(400).json({
          status: false,
          message: "Error on server",
        });
      }
    }
    let orderValue =
      reqBody.buyorsell == "buy"
        ? reqBody.price * reqBody.quantity
        : reqBody.quantity;
    // Re-read: updateUserWallet seeds the missing field, and the stale null
    // would otherwise become NaN, which passes `NaN < orderValue` and then
    // lands in the passbook as a NaN beforeBalance.
    usrWallet = await readSpotBalanceNumber(req.user.id, currencyId);
    console.log(usrWallet, '----------872', orderValue)
    if (usrWallet < orderValue) {
      return res.status(400).json({
        status: false,
        message: "Due to insufficient balance order cannot be placed",
      });
    }
    const seqId = await getSequenceId("orderHistory");
    const newOpenOrder = {
      _id: createobjectId(),
      userId: req.user.id,
      pairId: spotPairData._id,
      firstCurrencyId: spotPairData.firstCurrencyId,
      firstCurrency: spotPairData.firstCurrencySymbol,
      firstFloatDigit: spotPairData.firstFloatDigit,
      secondCurrencyId: spotPairData.secondCurrencyId,
      secondCurrency: spotPairData.secondCurrencySymbol,
      secondFloatDigit: spotPairData.secondFloatDigit,
      quantity: reqBody.quantity,
      price: reqBody.price,
      orderValue: reqBody.price * reqBody.quantity,
      pairName: `${spotPairData.firstCurrencySymbol}${spotPairData.secondCurrencySymbol}`,
      // beforeBalance / afterBalance are derived from the debit below and are
      // attached to this object once that debit has run (see below).
      orderType: reqBody.orderType,
      buyorsell: reqBody.buyorsell,
      openQuantity: reqBody.quantity,
      // THE averagePrice INVARIANT: averagePrice is a CUMULATIVE FILLED
      // NOTIONAL - the running sum of (execution price * executed quantity) -
      // NOT a price. Every consumer divides it by filledQuantity to recover the
      // true average fill price (frontend Spot/OrderHistory.tsx, admin
      // report.controller.js execPrice), and marketMatching derives a market
      // order's unfilled remainder as openOrderValue - averagePrice. It must
      // therefore start at ZERO for every order kind: seeding it with a PRICE
      // (as this did for non-"bot" pairs) made averagePrice/filledQuantity
      // render as price/qty + price, i.e. an astronomically wrong average.
      averagePrice: 0,
      // The reference execution price this order was accepted at. On "off"
      // pairs an aggressive limit order executes at markPrice rather than at
      // its own limit price; that number used to be smuggled through
      // averagePrice, which is what corrupted it. It lives here now, is never
      // mutated by matching, and equals `price` on bot/binance pairs.
      refPrice: avgPrice,
      filledQuantity: 0,
      isLiquidity: false,
      isLiquidityError: false,
      // PAPER TRADING: never follow botstatus. "binance" here routes to
      // liquidityOrderPlace which places a REAL order on Binance, and makes the
      // order invisible to every match branch (all require liquidityType "off").
      liquidityType: "off",
      flag: false,
      status: "open",
      orderDate: new Date(), // Date.now(),
      userCode: req.user.userCode,
      isMaker: makerStatus ? true : false,
      // THE ROLE, STAMPED. Read back at settlement by makerSideOf(); never
      // re-derived from the book, which has moved by then.
      liquidityRole,
      orderCode: seqId,
    };
    // THE RESERVATION - one indivisible step, and the only thing that decides
    // whether this order exists.
    //
    // This used to be "debit, then look at what came back, then put it back if
    // it went negative". The final numbers were right, but for the width of
    // that window the balance was NEGATIVE in redis and every other reader
    // could see it, including the passbook rows the repair itself wrote; and if
    // anything at all ended the request between the two calls the user was
    // permanently short the whole order value with no order to show for it.
    // hincrbyfloatIfEnough compares and debits inside one Lua call, so of any
    // number of concurrent placements exactly those that fit are charged and
    // the rest move nothing. See controllers/redis.controller.js.
    //
    // THE SAME CALL ALSO REFUSES UNDER THIS ACCOUNT'S MARGIN FREEZE, so a
    // `faucet/reset` that has taken the freeze cannot have a reservation land
    // underneath the absolute balances it is about to write. Redis orders the
    // two: either this debit happened first and the reset's gate sees the
    // resulting order, or the freeze happened first and this moves nothing.
    const moved = await moveBalanceLogged(
      "walletbalance_spot",
      req.user.id + "_" + currencyId,
      orderValue,
      {
        direction: "debit",
        reason: "reserve_limit_order",
        ref: String(req.user.id),
        freezeKey: marginFreezeKey(req.user.id),
      }
    );
    const userbalance =
      moved === FROZEN ? FROZEN : moved ? moved.balance : null;
    if (userbalance === FROZEN) {
      return res.status(409).json({
        status: false,
        code: "RESET_IN_PROGRESS",
        message:
          "A demo-account reset is running on your account right now, so this " +
          "order was not placed and nothing has been charged. Please try again " +
          "in a moment.",
      });
    }
    if (userbalance == null) {
      return res.status(400).json({
        status: false,
        message: "Due to insufficient balance order cannot be placed",
      });
    }
    // Only ever reached once the debit has actually happened, so the in-order
    // ledger cannot be credited for a reservation that was refused.
    await hincbyfloat(
      "walletbalance_spot_inOrder",
      req.user.id + "_" + currencyId,
      orderValue
    );
    // THE EXACT NUMBER THAT WAS CREDITED, carried on the order. Every release
    // is measured against this rather than re-derived from price * quantity, so
    // the round trip is neutral to the last bit however the fills are split and
    // however the matcher rounds the resting remainder. Written from the same
    // variable that was just handed to redis - not recomputed - because a
    // recomputation is exactly the asymmetry this is here to end. See the
    // in-order invariant note above releaseInOrder.
    newOpenOrder.inOrderReserved = orderValue;
    newOpenOrder.inOrderReleased = 0;
    console.log(
      "-------------------------------id",
      newOpenOrder.buyorsell + "OpenOrders_" + newOpenOrder.pairId,
      newOpenOrder
    );
    let balance = parseFloat(userbalance) + orderValue;
    let afterBalance = parseFloat(userbalance);
    newOpenOrder.beforeBalance = balance;
    newOpenOrder.afterBalance = afterBalance;

    socketEmitOne(
      "updateTradeAsset",
      {
        currencyId: currencyId,
        spotBal: afterBalance,
      },
      req.user.id
    );
    console.log(makerStatus, "------761");
    // if (makerStatus) {
    //   await liqOrdCreation(
    //     newOpenOrder,
    //     reqBody.buyorsell == "buy" ? "sell" : "buy",
    //     true
    //   );
    // }
    newOpenOrder.orderDate = new Date(),
      console.log("user order created>>>>>>>>>>>>>>>>>>>>>>>>>>>..", newOpenOrder)//  Date.now();
    newOrderHistory(newOpenOrder);
    console.log(orderValue, "------764");
    await hset(
      newOpenOrder.buyorsell + "OpenOrders_" + newOpenOrder.pairId,
      newOpenOrder._id,
      newOpenOrder
    );
    if (spotPairData.botstatus == "bot") {
      updateOrderBook(
        newOpenOrder,
        newOpenOrder.pairId,
        spotPairData.firstFloatDigit
      );
    }
    getOpenOrderSocket(newOpenOrder.userId, newOpenOrder.pairId);
    getOrderHistorySocket(newOpenOrder.userId, newOpenOrder.pairId);
    // CREATE PASS_BOOK
    passbook({
      userId: req.user.id.toString(),
      coin:
        reqBody.buyorsell == "buy"
          ? spotPairData.secondCurrencySymbol
          : spotPairData.firstCurrencySymbol,
      currencyId:
        reqBody.buyorsell == "buy"
          ? spotPairData.secondCurrencyId
          : spotPairData.firstCurrencyId,
      tableId: newOpenOrder._id,
      beforeBalance: parseFloat(balance),
      afterBalance: afterBalance,
      amount: toFixedDown(orderValue, 8),
      type: "spot_limit_orderPlace",
      category: "debit",
    });
    // THE SIZE THAT WAS ACTUALLY PLACED, always - and the adjustment said out
    // loud when there was one. The leading sentence is unchanged so a client
    // that renders `message` verbatim keeps reading the same confirmation.
    return res.status(200).json({
      status: true,
      message: quantityQuantised
        ? `Your order placed successfully. The quantity was rounded down to ` +
        `${reqBody.quantity} ${spotPairData.firstCurrencySymbol} - the finest ` +
        `size this pair can express.`
        : "Your order placed successfully.",
      quantity: reqBody.quantity,
      ...(quantityQuantised
        ? { requestedQuantity, quantityRounded: true }
        : {}),
    });
  } catch (err) {
    console.log("...err", err);
    return res
      .status(400)
      .json({ status: false, message: "Limit order match error" });
  }
};
// percentCalc(17645, 23456)
export const marketOrderPlace = async (req, res) => {
  try {
    let reqBody = req.body;
    console.log(reqBody, "------777");
    let side = reqBody.buyorsell == "buy" ? "sell" : "buy";
    let spotPairData = await FetchpairData(reqBody.spotPairId);

    if (!spotPairData) {
      return res.status(400).json({ status: false, message: "Invalid Pair" });
    }
    if (spotPairData.status != "active") {
      return res
        .status(400)
        .json({ status: false, message: "Pair is not activated" });
    }
    // A MARKET SELL NAMES A SIZE, so it is quantised at the door exactly as a
    // limit order's quantity is - see PRICE IS REFUSED, SIZE IS QUANTISED. It
    // matters more here than it looks: `amount` is BOTH the debit and the
    // resting quantity for a market sell (marketOrderQuantity returns it
    // verbatim), so an unquantised one is the one remaining way a fill quantity
    // finer than the pair's precision can still enter the matcher, and that is
    // what leaves escrow dust behind on the retiring fill.
    //
    // There is no equivalent for a market BUY: `orderValue` is a budget, and
    // the quantity it buys is already truncated by marketOrderQuantity.
    //
    // Ahead of the fill gate on purpose: the quantised size is never larger
    // than the raw one, so measuring it against the ladder can only refuse
    // orders the raw size would also have refused.
    const requestedAmount = parseFloat(reqBody.amount);
    let amountQuantised = false;
    if (reqBody.buyorsell == "sell") {
      reqBody.amount = quantiseOrderSize(
        requestedAmount,
        spotPairData.firstFloatDigit
      );
      amountQuantised = reqBody.amount !== requestedAmount;
      if (amountQuantised && !(reqBody.amount > 0)) {
        return res.status(400).json({
          status: false,
          message:
            `Quantity is smaller than the smallest size this pair can trade ` +
            `(${10 ** -precisionDigits(spotPairData.firstFloatDigit)} ` +
            `${spotPairData.firstCurrencySymbol}).`,
        });
      }
    }
    // THE FILL GATE - server side, before anything touches the wallet.
    //
    // A market order can ONLY fill against liquidity that exists right now, so
    // it requires a fully fillable book: healthy depth, a resting ladder, and a
    // ladder large enough to take THIS order whole. This is the check the UI's
    // disabled button was the only enforcement of; it runs before the balance
    // read and long before the hincbyfloat debit below, so a rejected market
    // order moves no money, writes no passbook row and leaves nothing in the
    // open-order hash.
    //
    // The size handed over is the RAW request, in the unit the user expressed
    // it in: `orderValue` (quote) for a buy, `amount` (base) for a sell -
    // marketOrderValidate has already established that the relevant one is a
    // positive number. It is deliberately the pre-rounding value; the quantised
    // orderValue computed further down is never larger, so measuring the raw
    // one can only refuse an order the rounded one would also have refused.
    const marketGate = await assertOrderTradable(spotPairData, "market", {
      side: reqBody.buyorsell,
      size:
        reqBody.buyorsell == "buy"
          ? parseFloat(reqBody.orderValue)
          : parseFloat(reqBody.amount),
    });
    if (!marketGate.allowed) {
      // THE REASON HAS TO BE THE USER'S REASON, NOT THE FIRST ONE WE CHECKED.
      //
      // The gate runs before the balance is read - correctly, because it must
      // run before anything can move money. But that ordering also meant it got
      // to NAME the failure, and its name was frequently the wrong one. Someone
      // holding 10,000 USD who asked to buy 90,000 USD of BTC was told "there is
      // not enough liquidity resting in this book... try a smaller size, or
      // place a limit order" - advice that is both untrue and unactionable, since
      // the limit order it recommends is unaffordable too, and the book has
      // nothing to do with it. The gate happened to fire first because 90,000 is
      // also bigger than the ladder; the reason the order could never have
      // succeeded is that the money is not there.
      //
      // So on the refusal path - after the order is already rejected, with
      // nothing moved and nothing to unwind - ask the one question the gate
      // cannot: could this account have paid for it? Insufficient balance is a
      // fact about the user that no amount of waiting changes, while every gate
      // verdict ends in "try again in a moment"; when both are true, the one
      // that does not resolve itself is the honest thing to report.
      const unaffordable = await isMarketOrderUnaffordable(
        req.user.id,
        reqBody,
        spotPairData
      );
      if (unaffordable) {
        console.log(
          "marketOrderPlace refused - insufficient balance (gate also reported",
          marketGate.reason,
          ")---",
          String(spotPairData._id),
          reqBody.buyorsell
        );
        return res.status(400).json({
          status: false,
          // Byte-for-byte the message the affordability check further down
          // already returns, so one cause never has two wordings.
          message: "Due to insufficient balance order cannot be placed",
          healthReason: "insufficient_balance",
        });
      }
      if (marketGate.reason === "insufficient_liquidity") {
        // Worth its own line: this refusal is about the SIZE of one order, not
        // the health of the pair, so an operator reading the log must not go
        // looking for a broken feed.
        console.log(
          "marketOrderPlace refused - order larger than the resting ladder---",
          String(spotPairData._id),
          reqBody.buyorsell,
          "requested:",
          reqBody.buyorsell == "buy" ? reqBody.orderValue : reqBody.amount,
          "available:",
          marketGate.available
        );
      }
      return res.status(400).json({
        status: false,
        message: marketGate.message,
        healthReason: marketGate.reason,
      });
    }

    reqBody.quantity = toFixedDown(
      parseFloat(reqBody.quantity),
      spotPairData.firstFloatDigit
    );
    console.log(reqBody, "-------803", spotPairData);
    if (
      reqBody.buyorsell == "buy" &&
      parseFloat(reqBody.orderValue) < parseFloat(spotPairData.minOrderValue)
    ) {
      return res.status(400).json({
        status: false,
        message: `Order value must not be lesser than ${spotPairData.minOrderValue}`,
      });
    } else if (
      reqBody.buyorsell == "buy" &&
      parseFloat(reqBody.orderValue) > parseFloat(spotPairData.maxOrderValue)
    ) {
      return res.status(400).json({
        status: false,
        message: `Order value must not be higher than ${spotPairData.maxOrderValue}`,
      });
    }
    if (reqBody.buyorsell == "buy" && spotPairData.botstatus == "binance") {
      let getPriceConverSion = await priceConversionGrpc({
        baseSymbol: spotPairData.firstCurrencySymbol,
        convertSymbol: spotPairData.secondCurrencySymbol,
      });
      if (getPriceConverSion && getPriceConverSion.status) {
        let total = truncateDecimals(getPriceConverSion.convertPrice, 8);
        let checkDoller = total * reqBody.orderValue;
        console.log(checkDoller, "checkDollercheckDoller", total);
        if (checkDoller < 10)
          return res.status(400).json({
            status: false,
            message: `Total order value should be more than 10 USDT`,
          });
      }
    }

    if (
      reqBody.buyorsell == "sell" &&
      parseFloat(reqBody.amount) < parseFloat(spotPairData.minQuantity)
    ) {
      return res.status(400).json({
        status: false,
        message: `Quantity must not be lesser than ${spotPairData.minQuantity}`,
      });
    } else if (
      reqBody.buyorsell == "sell" &&
      parseFloat(reqBody.amount) > parseFloat(spotPairData.maxQuantity)
    ) {
      return res.status(400).json({
        status: false,
        message: `Quantity must not be higher than ${spotPairData.maxQuantity}`,
      });
    }

    let currencyId =
      reqBody.buyorsell == "buy"
        ? spotPairData.secondCurrencyId
        : spotPairData.firstCurrencyId;
    let usrWallet = await hget(
      "walletbalance_spot",
      req.user.id + "_" + currencyId
    );
    if (usrWallet == null) {
      let createAsset = await updateUserWallet(req.user.id);
      if (createAsset == false) {
        return res.status(400).json({
          status: false,
          message: "Error on server",
        });
      }
    }
    // Re-read: updateUserWallet seeds the missing field above, and a stale null
    // would become NaN - which is what reaches the passbook as beforeBalance.
    let balance = await readSpotBalanceNumber(req.user.id, currencyId),
      orderValue = 0;

    if (spotPairData.botstatus == "off") {
      let getOrders = await hgetall(`${side}OpenOrders_` + spotPairData._id);
      console.log(
        side == "buy" && reqBody.buyorsell == "sell",
        "<<< --- side --->>>"
      );
      //Custom Option
      if (side == "buy" && reqBody.buyorsell == "sell" && getOrders) {
        let GetOrders = getOrders;
        if (GetOrders) {
          GetOrders = await getvalueObj(GetOrders);
        }

        GetOrders = GetOrders.sort(function (a, b) {
          if (a.price === "market") return -1;
          else return b.price - a.price;
        });

        console.log("<<< --- getBuyOrders --- >>>", GetOrders[0]);

        // let orderPercent = percentCalc(
        //   GetOrders[0].price,
        //   spotPairData.markPrice,
        // );
        // if (spotPairData.marketPercent < orderPercent) {
        //   return res.status(400).json({
        //     status: false,
        //     message:
        //       "Due to market order price percentage difference is high, so this order cannot be placed",
        //   });
        // }
      }
    }
    if (spotPairData.botstatus == "bot") {
      let getOrders = await hgetall(`${side}OpenOrders_` + spotPairData._id);
      if (getOrders) {
        getOrders = await getvalueObj(getOrders);
        console.log('getOrders: ', getOrders);
        let checkLimit = (element) => element.price !== "market";
        let checkIndex = getOrders.findIndex(checkLimit);
        let findIndex = 0;
        let checkOrder = getOrders[checkIndex];
        console.log('checkOrder: ', checkOrder);
        if (checkOrder.userId == req.user.id) {
          let findOrder = (element) =>
            element.price !== "market" && element.userId != checkOrder.userId;
          findIndex = getOrders.findIndex(findOrder);
        }
        if (checkIndex == -1 || findIndex == -1) {
          return res
            .status(400)
            .json({ status: false, message: "No orders in order book" });
        }
      } else {
        return res
          .status(400)
          .json({ status: false, message: "No orders in order book" });
      }
    }
    // The one definition of what this order costs - shared with the refusal
    // path above, so the balance the user is measured against there and the
    // balance they are measured against here can never disagree.
    orderValue = marketOrderDebitValue(reqBody, spotPairData);
    // ...and the one definition of what it BUYS. `orderValue` is literally
    // `marketQuantity * markPrice`, so the size written into the book below is
    // the size the account was charged for. Recomputing `orderValue/markPrice`
    // here instead is what handed out unpaid-for base coin on every market buy;
    // see the note above marketOrderQuantity.
    const marketQuantity = marketOrderQuantity(reqBody, spotPairData);

    console.log(orderValue, "-------863");
    // Fresh, null-safe read immediately before the debit: this same number is
    // both the sufficiency guard and the passbook beforeBalance below. Reading
    // it with parseFloat(hget(...)) yielded NaN on a first-touch field, which
    // silently satisfies `NaN < orderValue` and then loses the audit row.
    usrWallet = balance = await readSpotBalanceNumber(req.user.id, currencyId);
    console.log(usrWallet, '----------872')
    if (usrWallet < orderValue) {
      return res.status(400).json({
        status: false,
        message: "Due to insufficient balance order cannot be placed",
      });
    }

    console.log("checkOrder value>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>.", orderValue)
    // else if (spotPairData.botstatus == "binance") {
    //   orderValue =
    //     reqBody.buyorsell == "buy"
    //       ? spotPairData.markPrice * reqBody.quantity
    //       : reqBody.quantity;
    //   orderPrice = spotPairData.markPrice;
    // }

    // if (spotPairData.botstatus == "off") {
    let cost = reqBody.buyorsell == "buy" ? "orderValue" : "amount";
    const seqId = await getSequenceId("orderHistory");
    let newOpenOrder = {
      _id: createobjectId(),
      userId: req.user.id,
      pairId: spotPairData._id,
      firstCurrencyId: spotPairData.firstCurrencyId,
      firstCurrency: spotPairData.firstCurrencySymbol,
      firstFloatDigit: spotPairData.firstFloatDigit,
      secondCurrencyId: spotPairData.secondCurrencyId,
      secondCurrency: spotPairData.secondCurrencySymbol,
      secondFloatDigit: spotPairData.secondFloatDigit,
      price: "market",
      [cost]: reqBody.buyorsell == "buy" ? orderValue : parseFloat(reqBody.amount),
      quantity: marketQuantity,
      filledQuantity: 0,
      pairName: `${spotPairData.firstCurrencySymbol}${spotPairData.secondCurrencySymbol}`,
      // beforeBalance: parseFloat(balance),
      // afterBalance: parseFloat(balance) - parseFloat(orderValue),
      orderType: reqBody.orderType,
      buyorsell: reqBody.buyorsell,
      openQuantity: marketQuantity,
      openOrderValue: orderValue,
      averagePrice: 0,
      filledQuantity: 0,
      isLiquidity: false,
      isLiquidityError: false,
      // PAPER TRADING: never follow botstatus. "binance" here routes to
      // liquidityOrderPlace which places a REAL order on Binance, and makes the
      // order invisible to every match branch (all require liquidityType "off").
      liquidityType: "off",
      flag: true,
      status: "open",
      orderDate: new Date(), // Date.now(),
      userCode: req.user.userCode,
      orderCode: seqId,
      orderValue,
      // A market order demands immediate execution and never rests, so it is a
      // taker by definition, on every pair kind. Stamped for the same reason
      // the limit path stamps its verdict: settlement must read the role, not
      // re-guess it. See lib/liquidityRole.js.
      liquidityRole: TAKER,
    };
    console.log("NEWOPEN_ORDER", newOpenOrder)
    // THE RESERVATION, AND THE FREEZE CHECK - see the note on the same call in
    // limitOrderPlace. A market order's debit is recorded in no counter at all
    // (THE IN-ORDER LEDGER INVARIANT above: market orders never credit
    // walletbalance_spot_inOrder), so the freeze is the only thing standing
    // between it and a reset writing an absolute balance over the top of it.
    const moved = await moveBalanceLogged(
      "walletbalance_spot",
      req.user.id + "_" + currencyId,
      orderValue,
      {
        direction: "debit",
        reason: "reserve_market_order",
        ref: String(req.user.id),
        freezeKey: marginFreezeKey(req.user.id),
      }
    );
    const userbalance =
      moved === FROZEN ? FROZEN : moved ? moved.balance : null;
    if (userbalance === FROZEN) {
      return res.status(409).json({
        status: false,
        code: "RESET_IN_PROGRESS",
        message:
          "A demo-account reset is running on your account right now, so this " +
          "order was not placed and nothing has been charged. Please try again " +
          "in a moment.",
      });
    }
    if (userbalance == null) {
      return res.status(400).json({
        status: false,
        message: "Due to insufficient balance order cannot be placed",
      });
    }
    await hset(
      newOpenOrder.buyorsell + "OpenOrders_" + newOpenOrder.pairId,
      newOpenOrder._id,
      newOpenOrder
    );

    if (newOpenOrder.liquidityType == "binance") {
      let { status, message } = await liquidityOrderPlace(
        newOpenOrder,
        spotPairData
      );
      if (!status) {
        let userReturnbal = await moveBalanceSigned(
          "walletbalance_spot",
          req.user.id + "_" + currencyId,
          orderValue,
          { reason: "market_order_refund" }
        );
        passbook({
          userId: req.user.id,
          coin:
            reqBody.buyorsell == "buy"
              ? spotPairData.secondCurrencySymbol
              : spotPairData.firstCurrencySymbol,
          currencyId:
            reqBody.buyorsell == "buy"
              ? spotPairData.secondCurrencyId
              : spotPairData.firstCurrencyId,
          tableId: newOpenOrder._id,
          beforeBalance: parseFloat(balance),
          afterBalance: parseFloat(userbalance),
          amount: toFixedDown(orderValue, 8),
          type: "spot_market_orderPlace",
          category: "debit",
        });
        passbook({
          userId: req.user.id.toString(),
          coin:
            reqBody.buyorsell == "buy"
              ? spotPairData.secondCurrencySymbol
              : spotPairData.firstCurrencySymbol,
          currencyId:
            reqBody.buyorsell == "buy"
              ? spotPairData.secondCurrencyId
              : spotPairData.firstCurrencyId,
          tableId: newOpenOrder._id,
          beforeBalance: parseFloat(userReturnbal) - orderValue,
          afterBalance: parseFloat(userReturnbal),
          amount: toFixed(parseFloat(orderValue), 8),
          type: "spot_market_orderPlace_market_return",
          category: "credit",
        });

        return res.status(400).json({ status, message });
      }
    }

    let afterBalance = userbalance;

    socketEmitOne(
      "updateTradeAsset",
      {
        currencyId: currencyId,
        spotBal: afterBalance,
      },
      req.user.id
    );
    getOrderHistorySocket(newOpenOrder.userId, newOpenOrder.pairId);
    // if (spotPairData.botstatus == "off") {
    // let nOrd = newOpenOrder;
    // nOrd.price = spotPairData.markPrice;
    // nOrd.quantity =
    // nOrd.buyorsell == "buy"
    // ? reqBody.orderValue / spotPairData.markPrice
    // : reqBody.amount;
    // nOrd.orderType = "limit";
    // await liqOrdCreation(nOrd, reqBody.buyorsell == "buy" ? "sell" : "buy", false); // for admin liquidity only
    // }
    newOpenOrder.orderDate = new Date(), // Date.now();
      await newOrderHistory(newOpenOrder);
    passbook({
      userId: req.user.id,
      coin:
        reqBody.buyorsell == "buy"
          ? spotPairData.secondCurrencySymbol
          : spotPairData.firstCurrencySymbol,
      currencyId:
        reqBody.buyorsell == "buy"
          ? spotPairData.secondCurrencyId
          : spotPairData.firstCurrencyId,
      tableId: newOpenOrder._id,
      beforeBalance: parseFloat(balance),
      afterBalance: parseFloat(afterBalance),
      amount: toFixedDown(orderValue, 8),
      type: "spot_market_orderPlace",
      category: "debit",
    });

    return res.status(200).json({
      status: true,
      message: amountQuantised
        ? `Your order placed successfully. The quantity was rounded down to ` +
        `${reqBody.amount} ${spotPairData.firstCurrencySymbol} - the finest ` +
        `size this pair can express.`
        : "Your order placed successfully.",
      quantity: marketQuantity,
      ...(amountQuantised
        ? { requestedQuantity: requestedAmount, quantityRounded: true }
        : {}),
    });
  } catch (err) {
    console.log("err: ", err);
    return res
      .status(500)
      .json({ status: false, message: "Market order match error" });
  }
};

export const updateOrderBook = async (newOrder, pairId, firstFloatDigit) => {
  try {
    let decimalval = minTwoDigits(firstFloatDigit);
    let quntitydecimal = newOrder.quantity * decimalval;
    // console.log(newOrder, '---------1089')
    await hincby(
      newOrder.buyorsell + "Orders" + pairId,
      newOrder.price,
      quntitydecimal
    );
    console.log('--------------------------1095', newOrder.buyorsell + "Orders" + pairId,
      newOrder.price,
      quntitydecimal)
    getOrderBookSocket(pairId);
    return true;
  } catch (err) {
    console.log(err, '------1099')
    return false;
  }
};
/**
 * Terminal status for a persisted order row.
 *
 * A PAPER ladder order can never be "pending": the ladder is REPLACED wholesale
 * from live Binance depth on every matching cycle (~2s), so the moment a
 * synthetic is partially filled its remainder is deleted from the open-order
 * hashes and it stops existing. Persisting it as "pending" left a row that
 * nothing would ever resolve - one per partial fill, forever - polluting every
 * pending/open query with orders that are not in any book. "cancel" is the
 * status this exchange already uses for an order whose unfilled remainder was
 * withdrawn, which is exactly what the ladder refresh does to it.
 *
 * A synthetic that filled COMPLETELY is already "completed" and is left alone.
 */
export const orderHistoryStatus = (orderData) =>
  orderData?.isPaper === true && orderData?.status === "pending"
    ? "cancel"
    : orderData?.status;

export const newOrderHistory = async (orderData) => {
  try {
    // Paper-book liquidity is created with orderCode 0 so the ladder costs no
    // mongo counter round-trips; a synthetic that actually trades gets a real
    // sequence id here, at the point it is first persisted.
    if (!orderData.orderCode) {
      orderData.orderCode = await getSequenceId("orderHistory");
    }
    // The admin liquidation account, if it can be resolved at all. It used to
    // be JSON.parse'd and dereferenced unconditionally, so a missing or
    // unparseable record threw a TypeError here and the whole row - a real
    // user's order history - was lost to the catch below, silently. It is only
    // needed to answer "is this the house?", which isSyntheticOrder answers
    // without it for the paper ladder.
    let adminLiq = null;
    try {
      const adminRaw = await hget("admin_liquidity", "liquidation");
      adminLiq = adminRaw ? JSON.parse(adminRaw) : null;
    } catch (parseErr) {
      adminLiq = null;
    }
    const houseOrder = isSyntheticOrder(orderData, adminLiq && adminLiq._id);
    // console.log(orderData, "-------1135");
    let orderHistoryDetails = {
      _id: orderData._id,
      userId: orderData.userId,
      pairId: orderData.pairId,
      firstCurrencyId: orderData.firstCurrencyId,
      firstCurrency: orderData.firstCurrency,
      firstFloatDigit: orderData.firstFloatDigit,
      secondCurrencyId: orderData.secondCurrencyId,
      secondCurrency: orderData.secondCurrency,
      secondFloatDigit: orderData.secondFloatDigit,
      quantity:
        orderData.orderType == "market" ? orderData.amount : orderData.quantity,
      price: houseOrder ? orderData.price :
        orderData.orderType == "market"
          ? orderData.orderValue
          : orderData.price,
      orderValue: orderData.orderValue,
      pairName: orderData.pairName,
      orderType: orderData.orderType,
      buyorsell: orderData.buyorsell,
      openQuantity: orderData.openQuantity,
      averagePrice: orderData.averagePrice,
      openOrderValue: orderData.openOrderValue,
      filledQuantity: orderData.filledQuantity,
      flag: orderData.flag,
      status: orderHistoryStatus(orderData),
      orderDate: orderData.orderDate,
      liquidityType: orderData.liquidityType,
      liquidityId: orderData.liquidityId,
      isLiquidityError: orderData.isLiquidityError,
      isLiquidity: orderData.isLiquidity,
      // THE MAKER/TAKER STAMP, PERSISTED. Written through roleOf() rather than
      // copied raw so the column can only ever hold one of the two values the
      // fee table knows, and an order that predates the stamp is recorded as
      // the TAKER it settled as instead of as a null nobody can price. Without
      // this line the field never reached mongo at all - and models/orderHistory
      // had no path to receive it either, so strict mode dropped it twice over.
      liquidityRole: roleOf(orderData),
      updatedAt: Date.now(),
      orderDate: orderData.orderDate,
      userCode: orderData.userCode,
    };
    OrderHistory.findOneAndUpdate(
      { _id: orderData._id },
      {
        $set: orderHistoryDetails,
        $setOnInsert: { orderCode: orderData?.orderCode }
      },
      { upsert: true }
    ).exec()
      .then(() => { })
      .catch((err) => {
        console.log(err);
      })
    return true;
  } catch (err) {
    console.log("err on newOrderHistory---", err);
  }
};

/**
 * Admin Liquidity
 */
export const adminLiquidityPair = async () => {
  try {
    let pairList = await SpotPair.find({ botstatus: "binance" });
    if (pairList.length > 0) {
      // Admin model not available in this codebase - skip admin liquidity
      console.log("[adminLiquidityPair] Skipped - Admin model not available");
      return;
    }
  } catch (err) {
    console.log("Error on admin liquidity pair ", err);
  }
};

export const adminLiquiditySellOrder = async (pairData, adminData) => {
  try {
    let sellOrderList = await SpotOrder.find({
      pairId: pairData._id,
      buyorsell: "sell",
      price: {
        $lte: pairData.markPrice,
      },
      status: { $in: ["open", "pending"] },
    })
      .limit(100)
      .sort({ price: 1 });

    if (sellOrderList && sellOrderList.length > 0) {
      for (let sellOrderData of sellOrderList) {
        let remainingQuantity =
          sellOrderData.quantity - sellOrderData.filledQuantity;
        let buyOrderId = ObjectId();
        let uniqueId = Math.floor(Math.random() * 1000000000);

        const buyOrder = new SpotOrder({
          _id: buyOrderId,
          userId: adminData._id,
          pairId: sellOrderData.pairId,
          firstCurrencyId: sellOrderData.firstCurrencyId,
          firstCurrency: sellOrderData.firstCurrencySymbol,
          secondCurrencyId: sellOrderData.secondCurrencyId,
          secondCurrency: sellOrderData.secondCurrencySymbol,

          quantity: remainingQuantity,
          price: sellOrderData.price,
          orderValue: sellOrderData.price * remainingQuantity,

          pairName: `${sellOrderData.firstCurrencySymbol}${sellOrderData.secondCurrencySymbol}`,

          orderType: "market",
          orderDate: new Date(),
          buyorsell: "buy",
          status: "completed",

          filled: [
            {
              pairId: sellOrderData.pairId,
              sellUserId: sellOrderData.userId,
              buyUserId: adminData._id,
              userId: adminData._id,
              sellOrderId: sellOrderData._id,
              buyOrderId: buyOrderId,
              uniqueId: uniqueId,
              price: sellOrderData.price,
              filledQuantity: remainingQuantity,
              Fees: 0,
              status: "filled",
              Type: "buy",
              createdAt: new Date(),
              orderValue: sellOrderData.price * remainingQuantity,
            },
          ],
        });

        await buyOrder.save();

        await SpotOrder.findOneAndUpdate(
          {
            _id: sellOrderData._id,
          },
          {
            $set: {
              status: "completed",
              filledQuantity: sellOrderData.filledQuantity + remainingQuantity,
            },
            $push: {
              filled: {
                pairId: sellOrderData.pairId,
                sellUserId: sellOrderData.userId,
                buyUserId: adminData._id,
                userId: sellOrderData.userId,
                sellOrderId: sellOrderData._id,
                buyOrderId: buyOrderId,
                uniqueId: uniqueId,
                price: sellOrderData.price,
                filledQuantity: remainingQuantity,
                Fees: 0,
                status: "filled",
                Type: "sell",
                createdAt: new Date(),
                orderValue: sellOrderData.price * remainingQuantity,
              },
            },
          },
          { new: true }
        );

        await assetUpdate({
          currencyId: sellOrderData.secondCurrencyId,
          userId: sellOrderData.userId,
          balance: sellOrderData.price * remainingQuantity,
        });

        await getOpenOrderSocket(sellOrderData.userId, sellOrderData.pairId);
        await getOrderHistorySocket(sellOrderData.userId, sellOrderData.pairId);
        await getTradeHistorySocket(sellOrderData.userId, sellOrderData.pairId);

        if (pairData.botstatus == "off") {
          await getOrderBookSocket(sellOrderData.pairId);
          await marketPriceSocket(sellOrderData.pairId);
          await recentTradeSocket(sellOrderData.pairId);
        }
      }
    }
    return true;
  } catch (err) {
    return false;
  }
};

export const adminLiquidityBuyOrder = async (pairData, adminData) => {
  try {
    let buyOrderList = await SpotOrder.find({
      pairId: pairData._id,
      buyorsell: "buy",
      price: {
        $gte: pairData.markPrice,
      },
      status: { $in: ["open", "pending"] },
    })
      .limit(100)
      .sort({ price: 1 });

    if (buyOrderList && buyOrderList.length > 0) {
      for (let buyOrderData of buyOrderList) {
        let remainingQuantity =
          buyOrderData.quantity - buyOrderData.filledQuantity;
        let sellOrderId = ObjectId();
        let uniqueId = Math.floor(Math.random() * 1000000000);

        const sellOrder = new SpotOrder({
          _id: buyOrderId,
          userId: adminData._id,
          pairId: buyOrderData.pairId,
          firstCurrencyId: buyOrderData.firstCurrencyId,
          firstCurrency: buyOrderData.firstCurrencySymbol,
          secondCurrencyId: buyOrderData.secondCurrencyId,
          secondCurrency: buyOrderData.secondCurrencySymbol,

          quantity: remainingQuantity,
          price: buyOrderData.price,
          orderValue: buyOrderData.price * remainingQuantity,

          pairName: `${buyOrderData.firstCurrencySymbol}${buyOrderData.secondCurrencySymbol}`,

          orderType: "market",
          orderDate: new Date(),
          buyorsell: "sell",
          status: "completed",

          filled: [
            {
              pairId: buyOrderData.pairId,
              sellUserId: adminData._id,
              buyUserId: buyOrderData.userId,
              userId: adminData._id,
              sellOrderId: sellOrderId,
              buyOrderId: buyOrderData._id,
              uniqueId: uniqueId,
              price: buyOrderData.price,
              filledQuantity: remainingQuantity,
              Fees: 0,
              status: "filled",
              Type: "sell",
              createdAt: new Date(),
              orderValue: buyOrderData.price * remainingQuantity,
            },
          ],
        });

        await sellOrder.save();

        await SpotOrder.findOneAndUpdate(
          {
            _id: buyOrderData._id,
          },
          {
            $set: {
              status: "completed",
              filledQuantity: buyOrderData.filledQuantity + remainingQuantity,
            },
            $push: {
              filled: {
                pairId: buyOrderData.pairId,
                sellUserId: adminData._id,
                buyUserId: buyOrderData.userId,
                userId: buyOrderData.userId,
                sellOrderId: sellOrderId,
                buyOrderId: buyOrderData._id,
                uniqueId: uniqueId,
                price: buyOrderData.price,
                filledQuantity: remainingQuantity,
                Fees: 0,
                status: "filled",
                Type: "buy",
                createdAt: new Date(),
                orderValue: buyOrderData.price * remainingQuantity,
              },
            },
          },
          { new: true }
        );

        await assetUpdate({
          currencyId: buyOrderData.firstCurrencyId,
          userId: buyOrderData.userId,
          balance: buyOrderData.price * remainingQuantity,
        });

        await getOpenOrderSocket(buyOrderData.userId, buyOrderData.pairId);
        await getOrderHistorySocket(buyOrderData.userId, buyOrderData.pairId);
        await getTradeHistorySocket(buyOrderData.userId, buyOrderData.pairId);

        if (pairData.botstatus == "off") {
          await getOrderBookSocket(buyOrderData.pairId);
          await marketPriceSocket(buyOrderData.pairId);
        }
        await recentTradeSocket(buyOrderData.pairId);
      }
    }
    return true;
  } catch (err) {
    return false;
  }
};

/**
 * Credit `balance` of `currencyId` to `userId`'s spot balance and push the new
 * balance to that user's socket. Used by the liquidity-fill paths, which settle
 * a counterparty's order and then have to hand that counterparty the proceeds.
 *
 * It never did any of that. The body read `req.user.id` - there is no `req` in
 * this scope - so the very first statement threw a ReferenceError into an empty
 * catch on every call: no credit, no socket, no log. Two further faults were
 * hidden behind it: `updateUserAsset` is not imported by this module either,
 * and even had both resolved, crediting `req.user.id` would have paid the
 * balance to whoever happened to be making the request rather than to the
 * `userId` argument the callers pass.
 *
 * The credit now goes where every other settlement in this file goes: redis
 * walletbalance_spot[<userId>_<currencyId>], the authoritative paper-trading
 * ledger (see the in-order ledger invariant above and the matcher's own
 * hincbyfloat settlements). Routing it back through the gRPC wallet document
 * would write an absolute balance into a ledger the engine does not read and
 * silently diverge from redis.
 *
 * The surviving call sites are dormant today: adminLiquidityBuyOrder and
 * adminLiquiditySellOrder have no callers. It is fixed rather than removed
 * because reviving either of them really does move money, and a correct
 * settlement path is what they should find when that happens.
 * (trailingStopOrder was a third caller; it has been deleted along with the
 * rest of the conditional-order machinery.)
 */
export const assetUpdate = async ({ currencyId, userId, balance }) => {
  try {
    if (!currencyId || !userId) {
      return false;
    }
    const amount = parseFloat(balance);
    if (!isFinite(amount) || amount == 0) {
      return false;
    }
    const field = userId.toString() + "_" + currencyId.toString();
    // Through the ledger, like every other movement of a real balance. A
    // negative `balance` is a debit and is routed as one so it takes the same
    // refuse-rather-than-overdraw path every other debit takes, instead of
    // becoming a second way to reach a negative balance.
    const moved = await moveBalanceLogged(
      "walletbalance_spot",
      field,
      Math.abs(amount),
      {
        direction: amount < 0 ? "debit" : "credit",
        reason: "asset_update",
        ref: userId.toString(),
      }
    );
    if (!moved || moved === "FROZEN") {
      return false;
    }
    const spotBal = moved.balance;
    socketEmitOne(
      "updateTradeAsset",
      {
        currencyId: currencyId.toString(),
        spotBal: spotBal,
      },
      userId.toString()
    );
    return true;
  } catch (err) {
    console.log("err on assetUpdate---", err);
    return false;
  }
};

/**
 * Get Order Book
 * URL : /api/spot/ordeBook/:{{pairId}}
 * METHOD : GET
 * PARAMS : pairId
 */
export const getOrderBook = async (req, res) => {
  try {
    let result = await orderBookData({
      pairId: req.params.pairId,
    });
    console.log(result, '-------1873', req.params.pairId)
    return res.status(200).json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false });
  }
};

/**
 * Get Order Book Socket
 * PARAMS : pairId
 */
export const getOrderBookSocket = async (pairId) => {
  try {
    let result = await orderBookData({
      pairId: pairId,
    });
    if (result) {
      let pairDoc = await SpotPair.findOne({ _id: pairId });
      result["pairId"] = pairId;
      result["timestamp"] = Date.now();
      result["symbol"] = pairDoc?.tikerRoot;
      socketEmitOne("orderBook", result, pairDoc?.tikerRoot);
    }

    return true;
  } catch (err) {
    return false;
  }
};
/**
 * Every payload this legacy ("bot") derivation can return, stamped with a
 * health verdict.
 *
 * WHY THIS EXISTS
 * ---------------
 * bookPublish.controller.js gates the binance pairs and always stamps
 * `healthy` / `healthReason` / `ladderPresent`. This function did not, and
 * lib/orderBookHealth.ts on the client deliberately FAILS OPEN on a payload
 * with no `healthy` field ("only the gated publisher sets it, non-binance pairs
 * still come down the old ungated path"). Those two facts together meant that
 * flipping any pair to botstatus "bot" silently restored the pre-fix behaviour:
 * a fully drawn book, an enabled ticket, and no way for the UI to know better.
 *
 * THE CHOICE MADE HERE: make the absence of the field IMPOSSIBLE, rather than
 * asking the client to guess. Gating "bot" pairs on the paper ladder would be
 * wrong - they have no paper ladder, by design - but they are not ungatable:
 * for a bot pair the aggregate `{buy|sell}Orders<pairId>` hashes ARE a view of
 * the same resting orders the matcher walks, so "this side has no price levels"
 * is a true, first-hand statement that nothing can fill in that direction. That
 * is the verdict published, in the same vocabulary the binance path uses, so
 * the client's fail-open branch is now unreachable from this service and the
 * eventual removal of it is a client-side tidy-up rather than a fix.
 */
const legacyBook = (
  pairId,
  spotPairData,
  buyOrder,
  sellOrder,
  maxBidNotional,
  maxAskNotional,
  forcedReason = null
) => {
  // Both sides must be quotable for an order in either direction to fill.
  const reason =
    forcedReason || (buyOrder.length && sellOrder.length ? null : "empty_side");
  return {
    pairId: pairId,
    symbol: spotPairData ? spotPairData.tikerRoot : undefined,
    buyOrder: reason ? [] : buyOrder,
    sellOrder: reason ? [] : sellOrder,
    maxBidNotional: reason ? 0 : maxBidNotional,
    maxAskNotional: reason ? 0 : maxAskNotional,
    type: "SNAPSHOT",
    seq: 0,
    timestamp: Date.now(),
    // Always present, in EVERY branch, so no consumer ever has to distinguish
    // "absent" from "false".
    healthy: !reason,
    healthReason: reason,
    ladderPresent: !reason,
  };
};

export const orderBookData = async ({ pairId }) => {
  try {
    // let spotPairData = await SpotPair.findOne({ _id: pairId  },{firstFloatDigit:1});
    let spotPairData = await FetchpairData(pairId);
    let decimalval = 0;
    let ordeBookData = {};
    // A pairId that names no pair is a client-supplied value (getOrderBook is
    // an unauthenticated GET), not an exceptional condition: reading .botstatus
    // off undefined threw on every such request and the catch below turned that
    // into the same empty book this returns directly.
    if (!spotPairData) {
      return legacyBook(pairId, null, [], [], 0, 0, "no_pair");
    }
    if (spotPairData.botstatus != "bot" && spotPairData.botstatus != "binance") {
      // Not a book-bearing pair. This used to return undefined, which
      // getOrderBookSocket silently swallowed and getOrderBook handed to the
      // client as `result: undefined` - a payload with no `healthy` field, i.e.
      // exactly the shape the UI fails OPEN on.
      return legacyBook(
        pairId,
        spotPairData,
        [],
        [],
        0,
        0,
        "pair_ineligible"
      );
    }

    // For Binance pairs the book comes from the SAME publisher the socket uses.
    //
    // This used to hit the Binance REST depth endpoint directly - a THIRD
    // independent derivation of the book, with no health gate on it at all.
    // The UI calls this on mount and again from useOrderBookResync whenever the
    // socket goes quiet for 3s, so a raw-Binance answer here would have painted
    // a full 20-level book straight back over the empty one the socket had just
    // (correctly) published, and the display would have gone on lying about
    // what could be traded.
    if (spotPairData.botstatus == "binance") {
      const book = await buildPublishedBook(pairId, spotPairData, {
        type: "SNAPSHOT",
      });
      if (book.healthy && book.sellOrder.length && book.buyOrder.length) {
        // Best bid/ask are only recorded when the book is actually usable;
        // stamping the pair with prices from a book nothing can fill against is
        // how dead quotes leak into everything downstream.
        await SpotPair.findOneAndUpdate(
          { _id: pairId },
          {
            $set: {
              last_ask: book.sellOrder[0]?._id,
              last_bid: book.buyOrder[0]?._id,
            },
          }
        );
      }
      return book;
    }

    // For bot pairs, read from Redis
    let buyOrders = await hgetall("buyOrders" + pairId);

    let sellOrders = await hgetall("sellOrders" + pairId);
    ordeBookData.buyOrders = buyOrders
      ? Object.entries(buyOrders).map((e) => ({ price: e[0], quantity: e[1] }))
      : [];
    ordeBookData.sellOrders = sellOrders
      ? Object.entries(sellOrders).map((e) => ({ price: e[0], quantity: e[1] }))
      : [];
    // let ordeBookData = await OrderBook.findOne({ pairId: pairId });
    if (ordeBookData.buyOrders || ordeBookData.sellOrders) {
      let buyOrderData =
        ordeBookData.buyOrders.length > 0
          ? ordeBookData.buyOrders.sort((a, b) => b.price - a.price)
          : [];
      let sellOrderData =
        ordeBookData.sellOrders.length > 0
          ? ordeBookData.sellOrders.sort((a, b) => a.price - b.price)
          : [];
      let buyOrderList = [],
        sellOrderList = [];
      let cumulativeNotional = 0;
      let maxBidNotional = 0;
      let maxAskNotional = 0;

      if (buyOrderData.length > 0) {
        for (let i = 0; i < buyOrderData.length; i++) {
          decimalval = minTwoDigits(spotPairData.firstFloatDigit);
          const price = parseFloat(buyOrderData[i].price);
          const quantity = parseFloat(buyOrderData[i].quantity / decimalval);
          if (price > 0 && price !== "market" && quantity > 0) {
            const notional = price * quantity;
            cumulativeNotional += notional;
            if (cumulativeNotional > maxBidNotional) {
              maxBidNotional = cumulativeNotional;
            }
            buyOrderList.push({
              _id: price,
              price: price,
              quantity: quantity,
              notional: notional,
              cumulativeNotional: cumulativeNotional,
            });
          }
        }
      }

      cumulativeNotional = 0;
      if (sellOrderData.length > 0) {
        for (let i = 0; i < sellOrderData.length; i++) {
          decimalval = minTwoDigits(spotPairData.firstFloatDigit);
          const price = parseFloat(sellOrderData[i].price);
          const quantity = parseFloat(sellOrderData[i].quantity / decimalval);
          if (price > 0 && price !== "market" && quantity > 0) {
            const notional = price * quantity;
            cumulativeNotional += notional;
            if (cumulativeNotional > maxAskNotional) {
              maxAskNotional = cumulativeNotional;
            }
            sellOrderList.push({
              _id: price,
              price: price,
              quantity: quantity,
              notional: notional,
              cumulativeNotional: cumulativeNotional,
            });
          }
        }
      }
      await SpotPair.findOneAndUpdate(
        { _id: pairId },
        {
          $set: {
            last_ask: sellOrderList[0]?._id,
            last_bid: buyOrderList[0]?._id,
          },
        }
      );
      return legacyBook(
        pairId,
        spotPairData,
        buyOrderList.splice(0, 20),
        sellOrderList.splice(0, 20),
        maxBidNotional,
        maxAskNotional
      );
    } else {
      return legacyBook(pairId, spotPairData, [], [], 0, 0, "ladder_not_built");
    }
  } catch (err) {
    console.log(err, "---1979");
    // A book we could not build is a book we cannot vouch for. It used to be
    // returned with no `healthy` field at all, which the client read as
    // healthy - an empty, fully enabled book, which is the original bug in
    // miniature.
    return legacyBook(pairId, null, [], [], 0, 0, "error");
  }
};

/**
 * Get User Open Order
 * URL : /api/spot/openOrder/{{pairId}}
 * METHOD : GET
 * Query : page, limit
 */
export const getOpenOrder = async (req, res) => {
  try {
    let pagination = paginationQuery(req.query);
    let data = [];
    let pairList = await hgetall("spotPairdata");
    if (pairList) {
      pairList = await getActivePairs(pairList);
    }
    for (let item of pairList) {
      let buyOrder = await hgetall("buyOpenOrders_" + item._id);
      let sellOrder = await hgetall("sellOpenOrders_" + item._id);
      if (buyOrder) {
        buyOrder = await getvalueObjbyOId(buyOrder, req.user.id, item, data);
        data = buyOrder;
        buyOrder = data.sort((a, b) => b.createdAt - a.createdAt);
      } else {
        buyOrder = [];
      }
      if (sellOrder) {
        sellOrder = await getvalueObjbyOId(sellOrder, req.user.id, item, data);
        data = sellOrder;
        sellOrder = data.sort((a, b) => b.createdAt - a.createdAt);
      } else {
        sellOrder = [];
      }
    }
    // let index = data.findIndex(obj => obj.pairId.toString() == req.params.pairId.toString());
    // if (index > -1 && data.length > 1) {
    //   let [firstVal] = data.splice(index, 1);
    //   data.unshift(firstVal);
    // }
    data.sort((a, b) => {
      // First, prioritize items with the specified pairId
      if (a.pairId === req.params.pairId && b.pairId !== req.params.pairId) {
        return -1; // a comes before b
      }
      if (a.pairId !== req.params.pairId && b.pairId === req.params.pairId) {
        return 1; // b comes before a
      }

      // If both items have the same pairId or neither has the specified pairId, sort by orderDate
      return new Date(b.orderDate) - new Date(a.orderDate); // Sort by orderDate in descending order
    });
    // `count` is the size of the WHOLE result set, so it has to be taken
    // BEFORE the slice. Measured after, it equalled the page size, which is
    // also what the client's own "have I got everything?" guard compares
    // against (`data.length >= count` in components/spot/OpenOrder.tsx) - so
    // that guard passed on every full page and stopped the table dead.
    let count = data.length;
    // HOW MANY OF THEM ARE ON THE MARKET THE USER IS LOOKING AT.
    //
    // The table filters to the current pair unless the user has "show all
    // markets" on, and the "Open Orders(N)" badge beside it is supposed to
    // count what that table would show. The client had no figure for it, so it
    // counted the rows of the page it had LOADED - which under-reported for
    // anyone with more open orders than one page until they scrolled, and the
    // count silently changed as they did.
    //
    // Taken before the slice, for the same reason `count` is. String-compared
    // because the ids on these redis-sourced rows are strings while
    // `req.params.pairId` is whatever the URL carried.
    const pairCount = data.filter(
      (o) => String(o.pairId) === String(req.params.pairId)
    ).length;
    data = data.slice(
      pagination.skip,
      pagination.skip + pagination.limit
    );
    let result = {
      data,
      count: count,
      pairCount,
      currentPage: pagination.page,
      // THIS TABLE IS THE ONLY PLACE A RESTING SPOT ORDER CAN BE CANCELLED and
      // spot has no cancelAllOpen, so a page the client cannot reach is money
      // it cannot release. See hasNextPage for what the old expression claimed.
      nextPage: hasNextPage(pagination.skip, data.length, count),
      limit: pagination.limit,
    };
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.log("err---------- ", err);
    return res.status(500).json({ success: false });
  }
};
/**
 * Superseded by getOpenOrder above and reachable from nowhere: no route in
 * routes/ mounts it and nothing in controllers/ calls it. Its paging flag is
 * corrected all the same, because `count > data.length` is the OTHER wrong
 * answer - true on every page but the last one that happens to be short, so
 * page 3 of 3 with 5 rows still claims a page 4 - and a wrong expression left
 * lying in the file is what the live readers were copied from.
 */
export const getOpenOrder_Old = async (req, res) => {
  try {
    let pagination = paginationQuery(req.query);
    let buyOrder = await hgetall("buyOpenOrders_" + req.params.pairId);
    let sellOrder = await hgetall("sellOpenOrders_" + req.params.pairId);
    let data;
    if (buyOrder) {
      buyOrder = await getvalueObjbyId(buyOrder, req.user.id);
    } else {
      buyOrder = [];
    }
    if (sellOrder) {
      sellOrder = await getvalueObjbyId(sellOrder, req.user.id);
    } else {
      sellOrder = [];
    }
    data = [...buyOrder, ...sellOrder].slice(
      pagination.skip,
      pagination.skip + pagination.limit
    );
    let count = buyOrder.length + sellOrder.length;
    let result = {
      data,
      count: count,
      currentPage: pagination.page,
      nextPage: hasNextPage(pagination.skip, data.length, count),
      limit: pagination.limit,
    };
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.log("err---------- ", err);
    return res.status(500).json({ success: false });
  }
};

/**
 * Get User Open Order Socket
 * userId, pairId
 */
export const getOpenOrderSocket = async (userId, pairId) => {
  try {
    let data = [];
    let pairList = await hgetall("spotPairdata");
    if (pairList) {
      pairList = await getActivePairs(pairList);
    }
    for (let item of pairList) {
      let buyOrder = await hgetall("buyOpenOrders_" + item._id);
      let sellOrder = await hgetall("sellOpenOrders_" + item._id);
      if (buyOrder) {
        buyOrder = await getvalueObjbyOId(buyOrder, userId, item, data);
        data = buyOrder;
        buyOrder = data.sort((a, b) => b.createdAt - a.createdAt);
      } else {
        buyOrder = [];
      }
      if (sellOrder) {
        sellOrder = await getvalueObjbyOId(sellOrder, userId, item, data);
        data = sellOrder;
        sellOrder = data.sort((a, b) => b.createdAt - a.createdAt);
      } else {
        sellOrder = [];
      }
    }
    data.sort((a, b) => {
      // First, prioritize items with the specified pairId
      if (a.pairId === pairId && b.pairId !== pairId) {
        return -1; // a comes before b
      }
      if (a.pairId !== pairId && b.pairId === pairId) {
        return 1; // b comes before a
      }

      // If both items have the same pairId or neither has the specified pairId, sort by orderDate
      return new Date(b.orderDate) - new Date(a.orderDate); // Sort by orderDate in descending order
    });
    // let index = data.findIndex(obj => obj.pairId.toString() == pairId.toString());
    // if (index > -1 && data.length > 1) {
    //   let [firstVal] = data.splice(index, 1);
    //   data.unshift(firstVal);
    // }
    // THE SAME FIVE FIELDS THE REST READER SENDS.
    //
    // components/spot/OpenOrder.tsx assigns this payload over its whole state -
    // `currentPage`, `nextPage`, `limit` and `count` included - so the three
    // fields that were missing here landed as `undefined` on the first push
    // after mount, which is to say on the user's first order. `nextPage:
    // undefined` is a falsy `hasMore`, so the scroller stopped; `currentPage:
    // undefined` then made the next page request `undefined + 1`.
    //
    // `nextPage` is false rather than computed: this push carries the user's
    // ENTIRE open-order set - there is no slice anywhere above - so there is
    // nothing after it to fetch. That is also why `count` is `data.length`
    // here and not a separate total: on this message they are the same number.
    // `limit` is the page size a LATER rest call should use, not a description
    // of this message, so it stays at the default paginationQuery applies when
    // the client names none - which is what the client initialises with too.
    // `pairCount` for the same reason the REST reader sends it: the client's
    // "Open Orders(N)" badge counts what the TABLE would show, and the table
    // filters to the pair on screen unless "show all markets" is on. This push
    // does carry the whole set, so the client could count it - but only if the
    // two readers stay different, and they have not stayed different before
    // (see the note above about the three fields that were missing here).
    const pairCount = data.filter(
      (o) => String(o.pairId) === String(pairId)
    ).length;
    let result = {
      pairId,
      data,
      count: data.length,
      pairCount,
      currentPage: 1,
      nextPage: false,
      limit: 10,
    };
    socketEmitOne("openOrder", result, userId);
    return true;
  } catch (err) {
    console.log("gggggggggggg", err);
    return false;
  }
};

/**
 * Get User Filled Order
 * URL : /api/spot/filledOrder/{{pairId}}
 * METHOD : GET
 * Query : page, limit
 *
 * Reads OrderHistory (collection `orderHistory`), NOT SpotOrder. SpotOrder
 * maps to the `spotOrder` collection, which nothing in the paper exchange ever
 * writes - the matcher persists fills through newOrderHistory (`orderHistory`)
 * and newTradeHistory (`tradeHistory`) - so this endpoint returned 0 rows for
 * every user and every pair.
 */
export const getFilledOrder = async (req, res) => {
  try {
    // SAME SHAPE AS THE CANCEL 500 ABOVE. `ObjectId(req.params.pairId)` THROWS
    // on anything that is not a 24-hex id, and the catch at the bottom of this
    // function answers 500 - so `/api/spot/filledOrder/abc`, a stale bookmark
    // or a typo, reported the venue as broken. Every sibling route on this
    // router reads the same param through `hgetall("<hash>_" + pairId)` or
    // `FetchpairData`, both of which simply find nothing; this one is the only
    // handler that casts it, so it is the only one that could fault on it.
    if (!ObjectId.isValid(req.params.pairId)) {
      return res.status(400).json({ success: false, message: "Invalid pair id" });
    }
    let pagination = paginationQuery(req.query);

    let count = await OrderHistory.countDocuments({
      userId: ObjectId(req.user.id),
      pairId: ObjectId(req.params.pairId),
      status: "completed",
    });
    let data = await OrderHistory.aggregate([
      {
        $match: {
          userId: ObjectId(req.user.id),
          pairId: ObjectId(req.params.pairId),
          status: "completed",
        },
      },
      { $sort: { _id: -1 } },
      { $skip: pagination.skip },
      { $limit: pagination.limit },
      {
        $project: {
          orderDate: {
            $dateToString: {
              date: "$orderDate",
              format: "%Y-%m-%d %H:%M",
            },
          },
          firstCurrency: 1,
          secondCurrency: 1,
          orderType: 1,
          buyorsell: 1,
          price: 1,
          quantity: 1,
          filledQuantity: 1,
          orderValue: 1,
        },
      },
    ]);

    let result = {
      count,
      currentPage: pagination.page,
      // `count > data.length` is true on EVERY page that is not full, so the
      // last page - 5 rows out of 25 with a limit of 10 - still claimed a page
      // after it. The scroller then fetched an empty page 4 forever.
      nextPage: hasNextPage(pagination.skip, data.length, count),
      limit: pagination.limit,
      data,
    };
    return res.status(200).json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false });
  }
};

/**
 * Get User Filled Order Socket
 * userId, pairId
 *
 * Same collection correction as getFilledOrder above: fills live in
 * `orderHistory`, never in `spotOrder`.
 */
export const getFilledOrderSocket = async (userId, pairId) => {
  try {
    let count = await OrderHistory.countDocuments({
      userId: ObjectId(userId),
      pairId: ObjectId(pairId),
      status: "completed",
    });
    let data = await OrderHistory.aggregate([
      {
        $match: {
          userId: ObjectId(userId),
          pairId: ObjectId(pairId),
          status: "completed",
        },
      },
      { $sort: { _id: -1 } },
      { $limit: 10 },
      {
        $project: {
          orderDate: {
            $dateToString: {
              date: "$orderDate",
              format: "%Y-%m-%d %H:%M",
            },
          },
          firstCurrency: 1,
          secondCurrency: 1,
          orderType: 1,
          buyorsell: 1,
          price: 1,
          quantity: 1,
          filledQuantity: 1,
          orderValue: 1,
        },
      },
    ]);

    let result = {
      pairId,
      count,
      currentPage: 1,
      // Correct AS WRITTEN, and left alone deliberately: unlike the REST
      // reader this push is always page 1 (`$limit: 10`, no `$skip`), so
      // `skip` is 0 and `count > data.length` IS `0 + length < count`.
      nextPage: hasNextPage(0, data.length, count),
      limit: 10,
      data,
    };
    socketEmitOne("filledOrder", result, userId);
    return true;
  } catch (err) {
    return false;
  }
};

/**
 * Get User Trade History
 * URL : /api/spot/orderHistory/{{pairId}}
 * METHOD : GET
 * Query : page, limit
 */
export const getOrderHistory = async (req, res) => {
  try {
    let pagination = paginationQuery(req.query);
    let orderHistDoc = await hgetall("orderHistory_" + req.user.id);
    console.log('orderHistDoc: ', orderHistDoc);
    let buyOrder = await hgetall("buyOpenOrders_" + req.params.pairId);
    let sellOrder = await hgetall("sellOpenOrders_" + req.params.pairId);
    if (buyOrder) {
      buyOrder = await getvalueObjbyId(buyOrder, req.user.id);
      buyOrder = buyOrder.sort(
        (a, b) => new Date(b.orderDate) - new Date(a.orderDate)
      );
    } else {
      buyOrder = [];
    }
    if (sellOrder) {
      sellOrder = await getvalueObjbyId(sellOrder, req.user.id);
      sellOrder = sellOrder.sort(
        (a, b) => new Date(b.orderDate) - new Date(a.orderDate)
      );
    } else {
      sellOrder = [];
    }
    if (orderHistDoc) {
      orderHistDoc = await getvalueObjByPair(orderHistDoc, req.params.pairId);
      orderHistDoc = orderHistDoc.sort(
        (a, b) => new Date(b.orderDate) - new Date(a.orderDate)
      );
    } else {
      orderHistDoc = [];
    }
    let count = buyOrder.length + sellOrder.length + orderHistDoc.length;
    orderHistDoc = [...buyOrder, ...sellOrder, ...orderHistDoc].slice(
      pagination.skip,
      pagination.skip + pagination.limit
    );
    let result = {
      data: orderHistDoc,
      count: count,
      // `1`, hardcoded, on a handler that reads `page` from the query: the
      // client stores this and asks for `currentPage + 1` next, so every
      // "load more" on this table re-requested page 2.
      currentPage: pagination.page,
      nextPage: hasNextPage(pagination.skip, orderHistDoc.length, count),
      limit: pagination.limit,
    };

    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.log("err: ", err);
    return res.status(500).json({ success: false });
  }
};

/**
 * Get User Order History Socket
 * userId, pairId
 */
export const getOrderHistorySocket = async (userId, pairId) => {
  try {
    let orderHistDoc = await hgetall("orderHistory_" + userId);
    let buyOrder = await hgetall("buyOpenOrders_" + pairId);
    let sellOrder = await hgetall("sellOpenOrders_" + pairId);
    if (buyOrder) {
      buyOrder = await getvalueObjbyId(buyOrder, userId);
      buyOrder = buyOrder.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
    } else {
      buyOrder = [];
    }
    if (sellOrder) {
      sellOrder = await getvalueObjbyId(sellOrder, userId);
      sellOrder = sellOrder.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
    } else {
      sellOrder = [];
    }
    if (orderHistDoc) {
      orderHistDoc = await getvalueObjByPair(orderHistDoc, pairId);
      orderHistDoc = orderHistDoc.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
    } else {
      orderHistDoc = [];
    }

    let count = buyOrder.length + sellOrder.length + orderHistDoc.length;
    orderHistDoc = [...buyOrder, ...sellOrder, ...orderHistDoc].slice(0, 10);
    let result = {
      pairId,
      data: orderHistDoc,
      count: count,
      currentPage: 1,
      // Always page 1 here (`slice(0, 10)`, no skip), so this is the same
      // comparison hasNextPage makes with skip 0.
      nextPage: hasNextPage(0, orderHistDoc.length, count),
      limit: 10,
    };
    socketEmitOne("orderHistory", result, userId);
    return true;
  } catch (err) {
    return false;
  }
};

/**
 * Get User Trade History
 * URL : /api/spot/tradeHistory/{{pairId}}
 * METHOD : GET
 * Query : page, limit
 */
export const getTradeHistory = async (req, res) => {
  try {
    let pagination = paginationQuery(req.query);
    let tradeDoc = await hgetall("tradeHistory_" + req.params.pairId);
    if (tradeDoc) {
      tradeDoc = await getvalueObjbyId(tradeDoc, req.user.id, "trade");
      tradeDoc = tradeDoc.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      tradeDoc = [];
    }
    let count = tradeDoc.length;
    tradeDoc = tradeDoc.slice(
      pagination.skip,
      pagination.skip + pagination.limit
    );
    let result = {
      data: !isEmpty(tradeDoc) ? tradeDoc : [],
      count: count,
      // Was hardcoded `1` on a handler that pages - see getOrderHistory above.
      currentPage: pagination.page,
      nextPage: hasNextPage(pagination.skip, tradeDoc.length, count),
      limit: pagination.limit,
    };
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.log("err: ", err);
    return res.status(500).json({ success: false });
  }
};

/**
 * Get User Trade History Socket
 * URL : /api/spot/tradeHistory/{{pairId}}
 * METHOD : GET
 * Query : page, limit
 */
export const getTradeHistorySocket = async (userId, pairId) => {
  try {
    let tradeDoc = await hgetall("tradeHistory_" + pairId);
    if (tradeDoc) {
      tradeDoc = await getvalueObjbyId(tradeDoc, userId, "trade");
      tradeDoc = tradeDoc.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      tradeDoc = [];
    }
    let count = tradeDoc.length;
    tradeDoc = tradeDoc.slice(0, 10);
    let result = {
      pairId,
      data: tradeDoc,
      count: count,
      currentPage: 1,
      // Always page 1 here (`slice(0, 10)`, no skip).
      nextPage: hasNextPage(0, tradeDoc.length, count),
      limit: 10,
    };
    socketEmitOne("tradeHistory", result, userId);
    return true;
  } catch (err) {
    console.log("toString()toString()toString()", err);
    return false;
  }
};

/**
 * Get market price
 * URL : /api/spot/marketPrice/{{pairId}}
 * METHOD : GET
 */
export const getMarketPrice = async (req, res) => {
  try {
    let tickerPrice = await marketPrice(req.params.pairId);
    if (tickerPrice.status) {
      return res
        .status(200)
        .json({ success: true, result: tickerPrice.result });
    }
    // Return default market price data instead of 409
    return res.status(200).json({
      success: true,
      result: {
        markPrice: 0,
        last: 0,
        change: 0,
        high: 0,
        low: 0,
        firstVolume: 0,
        secondVolume: 0,
        changePrice: 0,
        botstatus: "off",
        _id: req.params.pairId,
      },
    });
  } catch (err) {
    console.log("getMarketPrice error: ", err);
    return res.status(200).json({
      success: true,
      result: {
        markPrice: 0,
        last: 0,
        change: 0,
        high: 0,
        low: 0,
        firstVolume: 0,
        secondVolume: 0,
        changePrice: 0,
        botstatus: "off",
        _id: req.params.pairId,
      },
    });
  }
};

/**
 * Get market price socket
 * pairId
 */
export const marketPriceSocket = async (pairId) => {
  try {
    let pairData = await SpotPair.findOne({ _id: pairId }, { tikerRoot: 1 });
    let tickerPrice = await marketPrice(pairId);
    // console.log("marketPrice_socket_status", tickerPrice.status, pairId);

    if (tickerPrice.status) {
      // console.log("marketPrice_socket", tickerPrice.result, pairId);

      socketEmitOne(
        "marketPrice",
        {
          pairId,
          data: tickerPrice.result,
        },
        "spot"
      );
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
};

export const marketPrice = async (pairId) => {
  try {
    let spotPairData = await FetchpairData(pairId);
    let tradeDoc = await hgetall("tradeHistory_" + pairId);
    let firstVolume = 0;
    let secondVolume = 0;
    let result = {};
    let openPrice = null;
    let closePrice = 0;
    let minPrice = 0;
    let maxPrice = 0;
    if (spotPairData && (spotPairData.botstatus == "off" || spotPairData.botstatus == "bot") && tradeDoc != null) {
      tradeDoc = await getvalueObj(tradeDoc);
      // These trades came back through JSON, so `createdAt` is a string. Sorted
      // and compared as one - see lib/tradeWindow.js for what comparing a
      // string against a Date did to every number below.
      tradeDoc.sort(byTradeTime);
      const windowEnd = Date.now();
      if (tradeDoc.length > 0) {
        for (let i = 0; i < tradeDoc.length; i++) {
          if (inLast24h(tradeDoc[i], windowEnd)) {
            if (openPrice == null) {
              openPrice = tradeDoc[i].tradePrice;
              maxPrice = tradeDoc[i].tradePrice;
              minPrice = tradeDoc[i].tradePrice;
            }
            if (tradeDoc[i].tradePrice > maxPrice) {
              maxPrice = tradeDoc[i].tradePrice;
            }
            if (tradeDoc[i].tradePrice < minPrice) {
              minPrice = tradeDoc[i].tradePrice;
            }
            closePrice = tradeDoc[i].tradePrice;
            secondVolume += tradeDoc[i].tradePrice * tradeDoc[i].tradeQty;
            firstVolume += tradeDoc[i].tradeQty;
          }
        }
        if (!isEmpty(openPrice)) {
          let diff = closePrice - openPrice;
          result = {
            markPrice: spotPairData.markPrice,
            last: closePrice,
            change: (diff / openPrice) * 100,
            high: maxPrice,
            low: minPrice,
            firstVolume,
            secondVolume,
            changePrice: diff,
            botstatus: spotPairData.botstatus,
            firstCurrencySymbol: spotPairData.firstCurrencySymbol,
            secondCurrencySymbol: spotPairData.secondCurrencySymbol,
            _id: pairId,
          };
          hset("spot24hrsChange", pairId, result);
          return {
            status: true,
            result,
          };
        } else {
          result = {
            markPrice: spotPairData.markPrice,
            last: 0,
            change: 0,
            high: 0,
            low: 0,
            firstVolume: 0,
            secondVolume: 0,
            changePrice: 0,
            botstatus: spotPairData.botstatus,
            _id: pairId,
          };
          hset("spot24hrsChange", pairId, result);
          return {
            status: true,
            result,
          };
        }
      } else {
        result = {
          markPrice: spotPairData.markPrice,
          last: 0,
          change: 0,
          high: 0,
          low: 0,
          firstVolume: 0,
          secondVolume: 0,
          changePrice: 0,
          botstatus: spotPairData.botstatus,
          _id: pairId,
        };
        hset("spot24hrsChange", pairId, result);
        return {
          status: true,
          result,
        };
      }
    } else {
      let spotPairData = await SpotPair.findOne({ _id: pairId });
      if (spotPairData && (spotPairData.botstatus == "off" || spotPairData.botstatus == "bot")) {
        let tradeDoc = await TradeHistory.aggregate([
          {
            $match: {
              pairId: ObjectId(pairId),
            },
          },
          {
            $match: {
              createdAt: {
                $gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
                $lte: new Date(),
              },
            },
          },
          {
            $sort: { createdAt: 1 },
          },

          {
            $project: {
              tradePrice: 1,
              tradeQty: 1,
              markPrice: 1,
            },
          },
        ]);
        if (tradeDoc.length > 0) {
          for (let i = 0; i < tradeDoc.length; i++) {
            if (openPrice == null) {
              openPrice = tradeDoc[i].tradePrice;
              maxPrice = tradeDoc[i].tradePrice;
              minPrice = tradeDoc[i].tradePrice;
            }
            if (tradeDoc[i].tradePrice > maxPrice) {
              maxPrice = tradeDoc[i].tradePrice;
            }
            if (tradeDoc[i].tradePrice < minPrice) {
              minPrice = tradeDoc[i].tradePrice;
            }
            closePrice = tradeDoc[i].tradePrice;
            firstVolume += tradeDoc[i].tradeQty;
            secondVolume += tradeDoc[i].tradePrice * tradeDoc[i].tradeQty;
          }

          let diff = closePrice - openPrice;
          result = {
            markPrice: spotPairData.markPrice,
            last: closePrice,
            // The percentage change over the window, the same way the redis
            // branch of this function computes it a hundred lines above. This
            // read `(diff * openPrice) / 100`, which is not a percentage of
            // anything: a $1 move on a $64,000 open published "+640" where the
            // truth is "+0.0016", and every such reading overstates in the
            // direction of the move.
            change: (diff / openPrice) * 100,
            high: maxPrice,
            low: minPrice,
            firstVolume,
            secondVolume,
            changePrice: diff,
            botstatus: spotPairData.botstatus,
            firstCurrencySymbol: spotPairData.firstCurrencySymbol,
            secondCurrencySymbol: spotPairData.secondCurrencySymbol,
            _id: pairId,
          };
          hset("spot24hrsChange", pairId, result);
          return {
            status: true,
            result,
          };
        } else {
          result = {
            markPrice: spotPairData.markPrice,
            last: 0,
            change: 0,
            high: 0,
            low: 0,
            firstVolume: 0,
            secondVolume: 0,
            changePrice: 0,
            botstatus: spotPairData.botstatus,
            firstCurrencySymbol: spotPairData.firstCurrencySymbol,
            secondCurrencySymbol: spotPairData.secondCurrencySymbol,
            _id: pairId,
          };
          hset("spot24hrsChange", pairId, result);
          return {
            status: true,
            result,
          };
        }
      }
    }

    // Default return when pair exists but no conditions matched
    // Return default values with markPrice if available
    // For binance botstatus, return values from spotPairData cache
    if (spotPairData && spotPairData.botstatus === "binance") {
      const result = {
        markPrice: spotPairData.markPrice || 0,
        last: spotPairData.last || spotPairData.markPrice || 0,
        change: spotPairData.change || 0,
        changePrice: spotPairData.changePrice || 0,
        high: spotPairData.high || 0,
        low: spotPairData.low || 0,
        firstVolume: spotPairData.firstVolume || 0,
        secondVolume: spotPairData.secondVolume || 0,
        botstatus: spotPairData.botstatus,
        firstCurrencySymbol: spotPairData.firstCurrencySymbol,
        secondCurrencySymbol: spotPairData.secondCurrencySymbol,
        _id: pairId,
      };
      // Update cache
      hset("spot24hrsChange", pairId, result);
      return {
        status: true,
        result,
      };
    }

    return {
      status: true,
      result: {
        markPrice: 0,
        last: 0,
        change: 0,
        high: 0,
        low: 0,
        firstVolume: 0,
        secondVolume: 0,
        changePrice: 0,
        botstatus: "off",
        _id: pairId,
      },
    };
  } catch (err) {
    console.log("err: ", err);
    return {
      status: false,
    };
  }
};

/**
 * Get Recent Trade
 * URL : /api/spot/recentTrade/{{pairId}}
 * METHOD : GET
 */
export const getRecentTrade = async (req, res) => {
  try {
    let pairData = await FetchpairData(req.params.pairId);
    if (pairData) {
      if (pairData.botstatus == "off" || pairData.botstatus == "binance") {
        let recentTradeData = await binanceCtrl.recentTrade({
          firstCurrencySymbol: pairData.firstCurrencySymbol,
          secondCurrencySymbol: pairData.secondCurrencySymbol,
        });
        if (recentTradeData && recentTradeData.length > 0) {
          return res.status(200).json({ success: true, result: recentTradeData });
        }
        // Return empty array instead of 409 when no recent trades
        return res.status(200).json({ success: true, result: [] });
      }
      else if (pairData.botstatus == "bot") {
        let recentTradeData = await recentTrade(pairData._id);
        if (recentTradeData.status) {
          return res
            .status(200)
            .json({ success: true, result: recentTradeData.result });
        }
        // Return empty array instead of 409 when no recent trades
        return res.status(200).json({ success: true, result: [] });
      }

      //   if (recentTradeData.status) {
      //     return res
      //       .status(200)
      //       .json({ success: true, result: recentTradeData.result });
      //   }
      // }

      // Return empty array for unknown botstatus instead of 409
      return res.status(200).json({ success: true, result: [] });
    }
    // Return 404 when pair not found
    return res.status(404).json({ success: false, message: "Pair not found" });
  } catch (err) {
    console.log("err---------- ", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * Get Recent Trade Socket
 * pairId
 */
export const recentTradeSocket = async (pairId) => {
  try {
    let pairData = await SpotPair.findOne({ _id: pairId }, { tikerRoot: 1 });
    let recentTradeData = await recentTrade(pairId);
    if (recentTradeData.status) {
      socketEmitOne(
        "recentTrade",
        {
          pairId,
          data: recentTradeData.result,
        },
        pairData.tikerRoot
      );
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
};

export const recentTrade = async (pairId) => {
  try {
    let recentTrade = await hgetall("tradeHistory_" + pairId);
    if (recentTrade) {
      recentTrade = await getTradevalueObj(recentTrade);
    }
    recentTrade = recentTrade
      .sort((a, b) => b.createdAt - a.createdAt)
      .splice(0, 25);
    if (recentTrade.length > 0) {
      return {
        status: true,
        result: recentTrade,
      };
    }
    return {
      status: true,
      result: [],
    };
  } catch (err) {
    return {
      status: true,
      result: [],
    };
  }
};

const getvalueObjbyId = async (allvalues, useId, type = "") => {
  if (type == "trade") {
    var keys = Object.values(allvalues);
    let newarray = [];
    for (var i = 0; i < keys.length; i++) {
      var str = keys[i];  // Get string directly, not as array
      try {
        str = JSON.parse(str);
      } catch (e) {
        continue;
      }
      if (str.buyUserId == useId) {
        let data = {
          createdAt: str.createdAt,
          firstCurrency: str.firstCurrency,
          secondCurrency: str.secondCurrency,
          pair: str.firstCurrency / str.secondCurrency,
          buyorsell: "buy",
          tradePrice: str.tradePrice,
          tradeQty: str.tradeQty,
          pairId: str.pairId,
          orderCode: str.buyOrdCode,
        };
        newarray.push(data);
      } else if (str.sellUserId == useId) {
        let data = {
          createdAt: str.createdAt,
          firstCurrency: str.firstCurrency,
          secondCurrency: str.secondCurrency,
          pair: str.firstCurrency / str.secondCurrency,
          buyorsell: "sell",
          tradePrice: str.tradePrice,
          tradeQty: str.tradeQty,
          pairId: str.pairId,
          orderCode: str.sellOrdCode,
        };
        newarray.push(data);
      }
    }
    return newarray;
  } else {
    var keys = Object.values(allvalues);
    let newarray = [];
    for (var i = 0; i < keys.length; i++) {
      var str = keys[i];  // Get string directly, not as array
      try {
        str = JSON.parse(str);
      } catch (e) {
        continue;
      }
      if (str.userId == useId) {
        newarray.push(str);
      }
    }
    return newarray;
  }
};
export const getvalueObjbyOId = async (allvalues, useId, pairDet, data) => {
  var keys = Object.values(allvalues);
  for (var i = 0; i < keys.length; i++) {
    var str = keys[i];  // Get string directly, not as array
    try {
      str = JSON.parse(str);
    } catch (e) {
      continue;
    }
    if (str.userId == useId) {
      data.push({ ...str, ...{ pairDetail: pairDet } });
    }
  }
  return data;
}
export const fetchAllpairs = async () => {
  try {
    pairInfo = [];
    let pairdetials = await hgetall("spotPairdata");
    if (pairdetials) {
      pairdetials = await intialPair(pairdetials);
    }
    if (pairdetials?.length > 0) {
      pairInfo = pairdetials;
    } else {
      pairInfo = [];
    }
    if (!pairdetials) {
      let spotPairData = await SpotPair.find({ status: "active" })
        .lean()
        .select({ firstCurrencySymbol: 1 });
      if (spotPairData.length > 0) {
        pairInfo = spotPairData;
      } else {
        pairInfo = [];
      }
    }
  } catch (err) {
    console.log("-----------err on fetchAllpairs", err);
  }
};
const intialPair = async (allvalues) => {
  var keys = Object.values(allvalues);
  let newarray = [];
  for (var i = 0; i < keys.length; i++) {
    var str = keys[i];  // Get string directly, not as array
    try {
      str = JSON.parse(str);
    } catch (e) {
      continue;
    }
    if (str.status === "active") {
      newarray.push({
        pair: str.firstCurrencySymbol,
        _id: str._id,
        botstatus: str.botstatus,
        firstCurrencySymbol: str.firstCurrencySymbol,
        secondCurrencySymbol: str.secondCurrencySymbol,
      });
    }
  }
  return newarray;
};
export const getActivePairs = async (allvalues) => {
  if (!allvalues) return [];
  var keys = Object.values(allvalues);
  let newarray = [];
  for (var i = 0; i < keys.length; i++) {
    var str = keys[i];  // Get the string value directly, not as array
    try {
      str = JSON.parse(str);
    } catch (e) {
      console.log('[getActivePairs] JSON parse error for item', i, ':', e.message);
      continue;
    }
    if (str.status === "active") {
      newarray.push(str);
    }
  }
  return newarray;
};
const getvalueObjByPair = async (allvalues, id) => {
  var keys = Object.values(allvalues);
  let newarray = [];
  for (var i = 0; i < keys.length; i++) {
    var str = keys[i];  // Get string directly, not as array
    try {
      str = JSON.parse(str);
    } catch (e) {
      continue;
    }
    if (str.pairId == id) {
      newarray.push(str);
    }
  }
  return newarray;
};
export const getTradevalueObj = async (allvalues) => {
  var keys = Object.values(allvalues);
  let newarray = [];
  for (var i = 0; i < keys.length; i++) {
    var str = keys[i];  // Get string directly, not as array
    try {
      str = JSON.parse(str);
      let data = {
        createdAt: str.createdAt,
        Type: str.isMaker,
        tradePrice: str.tradePrice,
        tradeQty: str.tradeQty,
      };
      newarray.push(data);
    } catch (e) {
      continue;
    }
  }
  return newarray;
};

export const getvalueObj = async (allvalues) => {
  var keys = Object.values(allvalues);
  let newarray = [];
  for (var i = 0; i < keys.length; i++) {
    var str = keys[i];  // Get string directly, not as array
    try {
      newarray.push(JSON.parse(str));
    } catch (e) {
      continue;
    }
  }
  return newarray;
};

cron.schedule("*/2 * * * * *", async () => {
  try {
    if (isEmpty(pairInfo)) {
      return;
    }
    for (let i = 0; i < pairInfo.length; i++) {
      if (isRun == false) {
        matchingcall(pairInfo[i]._id);
      }
    }
    execute()

  } catch (err) {
    console.log("-----------err on match call cron", err);
  }
});

export const matchingcall = async (pairId) => {
  console.log("-----3050");
  // Per-pair re-entry latch: the 2s cron fires matchingcall for every pair
  // without awaiting, so the global isRun latch cannot stop a slow tick from
  // overlapping the next one and double-matching the same order.
  const lockKey = String(pairId);
  if (pairLocks.has(lockKey)) {
    return;
  }
  pairLocks.add(lockKey);
  try {
    let pairData;
    let spotPairData = await FetchpairData(pairId);
    if (spotPairData) {
      pairData = spotPairData;
    } else {
      pairData = await SpotPair.findOne({ _id: pairId });
    }
    if (!isEmpty(pairData)) {
      // PAPER TRADING: refresh the synthetic ladder from live Binance depth
      // immediately before the matcher reads the hashes, so liquidity can never
      // be matched against without having just been re-derived from real depth.
      await syncPaperBook(pairData);
      // ARM THE CANCEL-BLOCK LATCH BEFORE READING THE OPEN-ORDER HASHES.
      // matchingcall reads the buy/sell hashes into an in-memory snapshot and
      // only settles later; if a cancel lands between this read and the fill it
      // would refund the reservation AND let the matcher credit the SAME order
      // from the stale snapshot - a double-pay / mint. cancelOrder rejects while
      // tradePair == this pair; the finally below always clears it. (Was set
      // inside tradeMatching only on topCross, i.e. AFTER this read.)
      tradePair = pairData._id;
      let orderList = await hgetall("buyOpenOrders_" + pairData._id);
      if (orderList) {
        orderList = await getvalueObj(orderList);
        orderList = orderList.sort((a, b) => a.orderDate - b.orderDate);
      }
      let sellorderList = await hgetall("sellOpenOrders_" + pairData._id);
      if (sellorderList) {
        sellorderList = await getvalueObj(sellorderList);
        sellorderList = sellorderList.sort((a, b) => a.orderDate - b.orderDate);
      }
      await tradeMatching(orderList, sellorderList, pairData);
    }
  } finally {
    pairLocks.delete(lockKey);
    // Always release the cancel-block latch for THIS pair (keyed on lockKey so a
    // concurrent pair's latch is untouched), even on an early return or throw,
    // so a cancel is never permanently refused.
    if (tradePair == lockKey) tradePair = "";
  }
};

export const liqOrdCreation = async (data, side, timeDelay) => {
  try {
    let adminLiq = await hget("admin_liquidity", "liquidation");
    adminLiq = JSON.parse(adminLiq);
    console.log(adminLiq, "---------3075");
    if (data?.userId.toString() == adminLiq._id.toString()) return true;
    let cost = side == "buy" ? "orderValue" : "amount";
    let newOpenOrder = { ...data };
    console.log(newOpenOrder, "---------3344");
    newOpenOrder[cost] = side == "buy" ? data.orderValue : data.amount;

    newOpenOrder._id = createobjectId();
    newOpenOrder.orderCode = await getSequenceId("orderHistory");
    newOpenOrder.buyorsell = side;
    if (newOpenOrder.orderType == "limit") {
      // refPrice, not averagePrice: averagePrice is a cumulative filled
      // notional (see the invariant note on limitOrderPlace) and would price
      // this counterparty order at 0 for a fresh order.
      newOpenOrder.price =
        newOpenOrder.refPrice != null
          ? newOpenOrder.refPrice
          : newOpenOrder.price;
    }
    newOpenOrder.flag = false;
    newOpenOrder.orderDate = new Date(), // Date.now();
      newOpenOrder.userCode = adminLiq.userId;
    newOpenOrder.userId = adminLiq._id;
    // console.log(newOpenOrder, "--------3350");
    // console.log(new Date(), '----------3115', timeDelay)
    if (timeDelay) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // console.log(new Date(), '-----------3119')
    await hset(
      newOpenOrder.buyorsell + "OpenOrders_" + newOpenOrder.pairId,
      newOpenOrder._id,
      newOpenOrder
    );
    console.log("liquidation order created>>>>>>>>>>>>>>>>>>>>>>>>>>>>", newOpenOrder);
    newOrderHistory(newOpenOrder);
  } catch (err) {
    console.log("---------------416", err);
  }
};

export const tradeMatching = async (bOrders, sOrders, pairData) => {
  try {
    isRun = true;
    let buyOrders = bOrders;
    let sellOrders = sOrders;
    // console.log("----------31022");
    // console.log(buyOrders && buyOrders.length, "---------buyOrders");
    // console.log(sellOrders && sellOrders.length, "---------sellOrders");
    // console.log(pairData.markPrice, "---------pairData.markPrice");
    if (sellOrders != null && pairData.botstatus == "off") {
      // console.log("---------3109");
      for (let element of sellOrders) {
        console.log('element: ', element);
        if (element.price == "market") {
        } else if (element.price <= pairData.markPrice && !element.isMaker) {
          let bO = await liqOrdCreation(element, "buy", false);
          break;
        }
      }
      let bOrd = await hgetall("buyOpenOrders_" + pairData._id);
      if (bOrd) {
        bOrd = await getvalueObj(bOrd);
        bOrd = bOrd.sort((a, b) => a.orderDate - b.orderDate);
        buyOrders = bOrd;
      }
    }
    if (buyOrders != null && pairData.botstatus == "off") {
      // console.log("-------------3123");
      for (let element of buyOrders) {
        if (element.price == "market") {
        } else if (element.price >= pairData.markPrice && !element.isMaker) {
          let sO = await liqOrdCreation(element, "sell", false);
          break;
        }
      }
      // console.log("-----------3130");
      let sOrd = await hgetall("sellOpenOrders_" + pairData._id);
      if (sOrd) {
        sOrd = await getvalueObj(sOrd);
        sOrd = sOrd.sort((a, b) => a.orderDate - b.orderDate);
        sellOrders = sOrd;
      }
    }

    // A MARKET ORDER LEFT ALONE ON A ONE-SIDED BOOK IS DEBITED MONEY THAT CAN
    // NEVER FILL, so it is cancelled and refunded here.
    //
    // This used to be gated on botstatus "bot", which left the paper
    // ("binance") pairs out - and they are the ones where a whole side vanishes
    // as a matter of routine, because syncPaperBook PURGES the ladder outright
    // on any depth fault. The order gate refuses a market order into a book
    // that is already in that state, but it cannot refuse one that was fine
    // when it was placed and whose counterparty ladder was torn out two seconds
    // later. Without this the order simply rests as `price: "market"`, with the
    // funds gone, until a ladder happens to come back - and if the pair is
    // deactivated it never does. The check below (`buyOrders.length <= 0`) is
    // the same rule for the case where the hash is empty rather than absent;
    // this is the case where hgetall returned nothing at all.
    //
    // Paper ladder rows can never be caught by this: they are limit orders with
    // a numeric price, and `price === "market"` is only ever a user's market
    // order. cancelMarketOrder claims the row with hgetdel before refunding, so
    // overlapping ticks cannot refund it twice.
    if (buyOrders == null && sellOrders != null) {
      sellOrders.forEach(async (element) => {
        if (element.price === "market" && element.liquidityType == "off") {
          console.log('----SellMarket Order Remove----')
          cancelMarketOrder(`sellOpenOrders_${element.pairId}`, element._id);
        }
      });
    }
    if (sellOrders == null && buyOrders != null) {
      buyOrders.forEach(async (element) => {
        if (element.price === "market" && element.liquidityType == "off") {
          console.log('----BuyMarket Order Remove----')
          cancelMarketOrder(`buyOpenOrders_${element.pairId}`, element._id);
        }
      });
    }
    if (buyOrders == null || sellOrders == null) {
      isRun = false;
      // console.log("-----------3140");
      return;
    }

    buyOrders = buyOrders.sort(function (a, b) {
      if (a.price === "market") return -1;
      else return b.price - a.price;
    });
    sellOrders = sellOrders.sort(function (a, b) {
      if (a.price === "market") return -1;
      else return a.price - b.price;
    });
    // tradePair blocks cancellation while a pair is mid-match. With a
    // permanently populated paper ladder both sides are always non-empty, so
    // only latch it when the top of book actually crosses - otherwise every
    // cancel would be rejected forever.
    const topCross =
      buyOrders[0]?.price === "market" ||
      sellOrders[0]?.price === "market" ||
      (typeof buyOrders[0]?.price === "number" &&
        typeof sellOrders[0]?.price === "number" &&
        buyOrders[0].price >= sellOrders[0].price);
    if (buyOrders.length > 0 && sellOrders.length > 0) {
      isRun = true;
      if (topCross) tradePair = pairData._id;
    }
    // console.log(isRun, "----------3153");
    while (buyOrders.length > 0 && sellOrders.length > 0) {
      let uniqueId = Math.floor(Math.random() * 1000000000);
      let current_buy = buyOrders[0];
      let current_buy_limit;
      let current_sell = sellOrders[0];
      let current_sell_limit;

      //check if order is already in liquidity
      // if (current_sell.isLiquidity && current_sell.liquidityType != "off") {
      //   sellOrders.shift();
      //   continue;
      // }
      // if (current_buy.isLiquidity && current_buy.liquidityType != "off") {
      //   buyOrders.shift();
      //   continue;
      // }
      let checkLimit = (element) => element.price !== "market";
      let buyIndex = buyOrders.findIndex(checkLimit);
      let sellIndex = sellOrders.findIndex(checkLimit);
      current_buy_limit = buyOrders[buyIndex];
      current_sell_limit = sellOrders[sellIndex];
      // console.log(current_buy, "------current_buy");
      // console.log(current_sell, "------current_sell");
      //MARKET ORDER EXECUTE
      if (
        current_buy.price == "market" &&
        current_sell.price == "market" &&
        current_buy.liquidityType == "off" &&
        current_sell.liquidityType == "off"
      ) {
        if (current_buy_limit == -1 || current_sell_limit == -1) {
          cancelMarketOrder(
            `buyOpenOrders_${current_buy.pairId}`,
            current_buy._id
          );
          cancelMarketOrder(
            `sellOpenOrders_${current_sell.pairId}`,
            current_sell._id
          );
          continue;
        }
        if (
          current_buy?.userId.toString() ==
          current_sell_limit?.userId.toString()
        ) {
          buyOrders.shift();
          sellOrders.splice(sellIndex, 1);
          continue;
        } else if (
          current_sell?.userId.toString() ==
          current_buy_limit?.userId.toString()
        ) {
          buyOrders.splice(buyIndex, 1);
          sellOrders.shift();
          continue;
        }
        let exectamount = current_buy.orderValue / current_sell_limit?.price;
        if (current_sell_limit) {
          current_buy.price = current_sell_limit.price;
          current_buy.quantity = toFixedDown(
            exectamount,
            pairData.firstFloatDigit
          );
          await marketMatching(
            buyOrders,
            sellOrders,
            current_buy,
            current_sell_limit,
            pairData
          );
        }
        if (current_buy_limit) {
          current_sell.price = current_buy_limit.price;
          current_sell.quantity = current_sell.amount;
          await marketMatching(
            buyOrders,
            sellOrders,
            current_buy_limit,
            current_sell,
            pairData
          );
        }
      } else if (
        current_buy.price == "market" &&
        current_sell.price != "market" &&
        current_buy.liquidityType == "off" &&
        current_sell.liquidityType == "off"
      ) {
        if (current_sell_limit == -1) {
          cancelMarketOrder(
            `buyOpenOrders_${current_buy.pairId}`,
            current_buy._id
          );
          continue;
        }
        if (current_buy.userId.toString() == current_sell.userId.toString()) {
          // console.log('*************** -------------- ***************')
          let checkLimit = (element) =>
            element.price !== "market" && element.userId != current_buy.userId;
          let sellIndex = sellOrders.findIndex(checkLimit);
          if (sellIndex >= 0) {
            sellOrders.shift();
          } else {
            cancelMarketOrder(
              `buyOpenOrders_${current_sell.pairId}`,
              current_buy._id
            );

            buyOrders.shift();
            sellOrders.splice(sellIndex, 1);
          }

          continue;
        }
        let exectamount = current_buy.orderValue / current_sell_limit.price;
        // A fully consumed market buy can be left with a float residual rather
        // than exactly 0; refund and drop it instead of trading zero quantity.
        if (!(exectamount > 0)) {
          cancelMarketOrder(
            `buyOpenOrders_${current_buy.pairId}`,
            current_buy._id
          );
          buyOrders.shift();
          continue;
        }
        current_buy.price = current_sell_limit.price;
        current_buy.quantity = parseFloat(exectamount);
        // toFixedDown(
        //   exectamount,
        //   pairData.firstFloatDigit
        // );
        console.log(current_buy, "-------3321");
        await marketMatching(
          buyOrders,
          sellOrders,
          current_buy,
          current_sell_limit,
          pairData
        );
      } else if (
        current_buy.price != "market" &&
        current_sell.price == "market" &&
        current_buy.liquidityType == "off" &&
        current_sell.liquidityType == "off"
      ) {
        if (current_buy_limit == -1) {
          cancelMarketOrder(
            `sellOpenOrders_${current_sell.pairId}`,
            current_sell._id
          );

          continue;
        }

        if (current_buy.userId.toString() == current_sell.userId.toString()) {
          let checkLimit = (element) =>
            element.price !== "market" && element.userId != current_buy.userId;
          let buyIndex = buyOrders.findIndex(checkLimit);
          if (buyIndex >= 0) {
            buyOrders.shift();
          } else {
            cancelMarketOrder(
              `sellOpenOrders_${current_sell.pairId}`,
              current_sell._id
            );
            buyOrders.splice(buyIndex, 1);
            sellOrders.shift();
          }

          continue;
        }
        current_sell.price = current_buy_limit.price;
        current_sell.quantity = parseFloat(current_sell.amount);
        await marketMatching(
          buyOrders,
          sellOrders,
          current_buy_limit,
          current_sell,
          pairData
        );
      }

      ////LIMIT ORDER EXECUT
      if (
        current_buy.flag == false &&
        current_sell.flag == false &&
        current_buy.liquidityType == "off" &&
        current_sell.liquidityType == "off"
      ) {
        // console.log(
        //   current_buy.price >= current_sell.price,
        //   "------current_buy.price >= current_sell.price"
        // );
        // console.log(current_buy.orderDate, "------current_buy.orderDate");
        // console.log(current_sell.orderDate, "------current_sell.price", current_buy.orderDate < current_sell.orderDate);
        if (current_buy.price >= current_sell.price) {
          let adminLiq = await hget("admin_liquidity", "liquidation");
          adminLiq = adminLiq ? JSON.parse(adminLiq) : null;
          const adminLiqId = adminLiq && adminLiq._id;
          // THE MAKER IS WHOEVER WAS RESTING WHEN THE OTHER SIDE ARRIVED.
          //
          // This used to read `isMaker = current_buy.isPaper ? "buy" : "sell"`
          // whenever either side was synthetic - which, on a "binance" pair, is
          // every fill there is - so the paper ladder claimed the maker side
          // unconditionally and no spot user could ever be charged
          // `maker_rebate`. The role now comes from the stamp the order carried
          // in from acceptance, and the ladder takes the complement of it. See
          // lib/liquidityRole.js.
          const isMaker = makerSideOf(current_buy, current_sell, adminLiqId);
          // House liquidity is not a ledger account - see settlementCredit.
          const buyerSynthetic = isSyntheticOrder(current_buy, adminLiqId);
          const sellerSynthetic = isSyntheticOrder(current_sell, adminLiqId);
          console.log(isMaker, "--------3419");
          if (current_buy.userId.toString() == current_sell.userId.toString()) {
            if (buyOrders.length > sellOrders.length) {
              buyOrders.shift();
            } else {
              sellOrders.shift();
            }
            continue;
          }
          let exectamount = Math.min(
            current_buy.quantity,
            current_sell.quantity
          );
          // Per-fill size for the in-order releases: they must not use the
          // CUMULATIVE filledQuantity or a second partial fill re-releases the
          // share already released by the first.
          const execQty = exectamount;
          console.log(exectamount, "--------3381");
          let execvalue =
            isMaker == "buy"
              ? exectamount * current_buy.price
              : exectamount * current_sell.price;
          // Each side is priced from its OWN order (the seller's fee used to be
          // computed from current_buy.makerFee and vice versa - identical only
          // because both orders on a pair carry the same rates), at the rate
          // for the role it actually played in THIS fill.

          // The execution price is the MAKER's price. Never read averagePrice
          // here: it is a cumulative filled notional (see the invariant note on
          // limitOrderPlace), so a partially consumed order re-read within the
          // same tick would execute at that notional. refPrice preserves the
          // "off"-pair rule that an aggressive limit order executes at markPrice
          // rather than at its own limit price; on bot/binance pairs refPrice
          // equals price, and paper-ladder orders carry none, so `price` wins.
          const makerOrder = isMaker == "buy" ? current_buy : current_sell;
          let avgPrice =
            makerOrder.refPrice != null ? makerOrder.refPrice : makerOrder.price;
          console.log(avgPrice, "---------3400");
          // isMaker == "buy" ? current_buy.price : current_sell.price;
          // Never HGET+parseFloat these directly: a first-touch field is
          // absent, and NaN here loses the whole passbook row (see
          // readSpotBalanceNumber).
          let buyerWallet = await readSpotBalanceNumber(
            current_buy.userId,
            current_buy.firstCurrencyId
          );
          let sellerWallet = await readSpotBalanceNumber(
            current_sell.userId,
            current_sell.secondCurrencyId
          );
          // /* START IGNORE TRADE FEE */
          // let buyUsrDoc = await hget(
          //   "userToken_" + current_buy.userId,
          //   current_buy.userId
          // );
          // let sellUsrDoc = await hget(
          //   "userToken_" + current_sell.userId,
          //   current_sell.userId
          // );
          // // console.log(buyUsrDoc, '----buyUsrDoc')
          // // console.log(sellUsrDoc, '----sellUsrDoc')
          // if (buyUsrDoc) {
          //   buyUsrDoc = JSON.parse(buyUsrDoc);
          //   if (
          //     buyUsrDoc.feeManagement?.includes(current_buy.firstCurrencyId)
          //   ) {
          //     buyFee = 0;
          //   }
          // }

          // if (sellUsrDoc) {
          //   sellUsrDoc = JSON.parse(sellUsrDoc);
          //   if (
          //     sellUsrDoc.feeManagement?.includes(current_sell.secondCurrencyId)
          //   ) {
          //     sellFee = 0;
          //   }
          // }
          /* END IGNORE TRADE FEE */
          let buyExcAmount =
            (current_buy.quantity * 10 ** current_buy.firstFloatDigit -
              exectamount * 10 ** current_buy.firstFloatDigit) /
            10 ** current_buy.firstFloatDigit;
          let sellExcAmount =
            (current_sell.quantity * 10 ** current_sell.firstFloatDigit -
              exectamount * 10 ** current_sell.firstFloatDigit) /
            10 ** current_sell.firstFloatDigit;
          let sellInOrder;
          let buyInOrder;
          // TRUNCATE, DO NOT ROUND. This is the REMAINDER of a partly filled
          // order, and a remainder can only ever shrink: rounding half-up
          // hands the order back more quantity than is left, which the cancel
          // path then refunded as money it never held. Truncating errs the
          // safe way - the order ends a dust-fraction smaller than the exact
          // arithmetic, never larger. `toFixedDown` keeps the sign and handles
          // exponent notation; see the note above it in lib/roundOf.js.
          buyExcAmount = toFixedDown((buyExcAmount * 100) / 100, current_buy.firstFloatDigit)
          sellExcAmount = toFixedDown((sellExcAmount * 100) / 100, current_sell.firstFloatDigit)
          console.log(buyExcAmount, '--------3601')
          console.log(sellExcAmount, '--------3602')
          // buyerWallet/sellerWallet are already numbers (readSpotBalanceNumber)
          current_buy.quantity = buyExcAmount;
          current_buy.filledQuantity += exectamount;
          current_sell.quantity = sellExcAmount;
          current_sell.filledQuantity += exectamount;
          // averagePrice ACCUMULATES the filled notional on every pair kind.
          // Assigning it (the old "off"/binance branch) threw away every fill
          // but the last, so a multi-fill order rendered
          // averagePrice/filledQuantity as the last fill's price scaled by the
          // ratio of that fill to the total.
          current_buy.averagePrice =
            parseFloat(current_buy.averagePrice || 0) + avgPrice * exectamount;
          current_sell.averagePrice =
            parseFloat(current_sell.averagePrice || 0) + avgPrice * exectamount;
          current_sell.tradePrice = avgPrice;
          current_sell.tradeQty = exectamount;
          current_sell.createdAt = Date.now();

          current_buy.tradePrice = avgPrice;
          current_buy.tradeQty = exectamount;
          current_buy.createdAt = Date.now();


          console.log(current_buy.quantity, "------current_buy.quantity");
          //order update process
          if (current_buy.quantity == 0) {
            const filledOrderValue = avgPrice * exectamount;
            const realOrderValue = current_buy.price * exectamount;
            // The price-improvement refund: an AGGRESSIVE buyer reserved
            // price*qty and executed at the maker's better price, so the
            // difference goes back. Never for the synthetic - it reserved
            // nothing, so there is nothing of its own to give back and this
            // would credit it out of thin air.
            //
            // COMPARED EXACTLY, not rounded to the quote's decimals. Quantising
            // the two sides first meant any improvement worth less than one
            // quote tick OF NOTIONAL was not refunded at all: measured live, a
            // 0.0002 BTC buy that improved by 5.00 USD/BTC (12.842324 reserved
            // against 12.841328 filled) rounded to 12.84 on both sides and the
            // 0.000996 USD difference simply stayed debited - it left the user
            // and reached nobody. The difference is (limitPrice - execPrice) *
            // quantity, which is zero to the last bit when the buyer IS the
            // maker (same multiplication, same operands) and strictly positive
            // otherwise, so there is no float dust for the rounding to absorb.
            if (
              !buyerSynthetic &&
              isMaker == "sell" &&
              realOrderValue > filledOrderValue
            ) {
              console.log("----------3509");
              const retriveBal =
                parseFloat(realOrderValue) - parseFloat(filledOrderValue);
              let buyRetrive = await moveBalanceSigned(
                "walletbalance_spot",
                current_buy.userId + "_" + current_buy.secondCurrencyId,
                retriveBal,
                { reason: "price_improvement_refund" }
              );
              let beforeBAL = parseFloat(buyRetrive) - parseFloat(retriveBal);
              passbook({
                userId: current_buy.userId,
                coin: current_buy.secondCurrency,
                currencyId: current_buy.secondCurrencyId,
                tableId: current_buy._id,
                beforeBalance: beforeBAL,
                afterBalance: buyRetrive,
                amount: toFixedDown(retriveBal, 8),
                type: "spot_limit_bal_retrieve",
                category: "credit",
              });
              // Pass Book
              socketEmitOne(
                "updateTradeAsset",
                {
                  currencyId: current_buy.secondCurrencyId,
                  spotBal: buyRetrive,
                  inOrder: buyInOrder,
                },
                current_buy.userId
              );
            }

            current_buy.status = "completed";
            // THE UNSOLD REMAINDER, MEASURED BEFORE THE RELEASE THAT ERASES IT.
            // A quote-currency amount here: the reservation is price * quantity
            // and this fill consumes price * execQty. See
            // unspentReservationOf - the reservation left over is quote that
            // bought no coin, and it has to go back to the balance, not merely
            // out of the escrow counter.
            const buyUnspent = buyerSynthetic
              ? 0
              : unspentReservationOf(current_buy, current_buy.price * execQty);
            // RETIRING - the fill that emptied the order. It gives back the
            // whole remainder of its own reservation, so the per-fill rounding
            // of every earlier partial cannot survive it. See releaseInOrder.
            buyInOrder = await releaseInOrder(
              current_buy,
              current_buy.secondCurrencyId,
              current_buy.price * execQty,
              { final: true }
            );
            await refundUnspentReservation({
              order: current_buy,
              currencyId: current_buy.secondCurrencyId,
              coin: current_buy.secondCurrency,
              unspent: buyUnspent,
            });
            hset(
              "orderHistory_" + current_buy.userId,
              current_buy._id,
              current_buy
            );
            console.log(current_buy, "---------3519");
            await hdel("buyOpenOrders_" + current_buy.pairId, current_buy._id);
            orderHistArr.push(current_buy);
            buyOrders.shift();
          } else {
            current_buy.status = "pending";
            const filledOrderValue = avgPrice * exectamount;
            const realOrderValue = current_buy.price * exectamount;
            // The price-improvement refund: an AGGRESSIVE buyer reserved
            // price*qty and executed at the maker's better price, so the
            // difference goes back. Never for the synthetic - it reserved
            // nothing, so there is nothing of its own to give back and this
            // would credit it out of thin air.
            //
            // COMPARED EXACTLY, not rounded to the quote's decimals. Quantising
            // the two sides first meant any improvement worth less than one
            // quote tick OF NOTIONAL was not refunded at all: measured live, a
            // 0.0002 BTC buy that improved by 5.00 USD/BTC (12.842324 reserved
            // against 12.841328 filled) rounded to 12.84 on both sides and the
            // 0.000996 USD difference simply stayed debited - it left the user
            // and reached nobody. The difference is (limitPrice - execPrice) *
            // quantity, which is zero to the last bit when the buyer IS the
            // maker (same multiplication, same operands) and strictly positive
            // otherwise, so there is no float dust for the rounding to absorb.
            if (
              !buyerSynthetic &&
              isMaker == "sell" &&
              realOrderValue > filledOrderValue
            ) {
              const retriveBal =
                parseFloat(realOrderValue) - parseFloat(filledOrderValue);
              let buyRetrive = await moveBalanceSigned(
                "walletbalance_spot",
                current_buy.userId + "_" + current_buy.secondCurrencyId,
                retriveBal,
                { reason: "price_improvement_refund" }
              );
              let beforeBAL = parseFloat(buyRetrive) - parseFloat(retriveBal);
              passbook({
                userId: current_buy.userId,
                coin: current_buy.secondCurrency,
                currencyId: current_buy.secondCurrencyId,
                tableId: current_buy._id,
                beforeBalance: beforeBAL,
                afterBalance: buyRetrive,
                amount: parseFloat(retriveBal),
                type: "spot_limit_bal_retrieve",
                category: "credit",
              });
              // Pass Book
              socketEmitOne(
                "updateTradeAsset",
                {
                  currencyId: current_buy.secondCurrencyId,
                  spotBal: buyRetrive,
                  inOrder: buyInOrder,
                },
                current_buy.userId
              );
            }
            buyInOrder = await releaseInOrder(
              current_buy,
              current_buy.secondCurrencyId,
              current_buy.price * execQty
            );
            orderHistArr.push(current_buy);
            await hdel("buyOpenOrders_" + current_buy.pairId, current_buy._id);
            await hset(
              "buyOpenOrders_" + current_buy.pairId,
              current_buy._id,
              current_buy
            );
            // }
          }
          console.log(current_sell.quantity, "------current_sell.quantity");

          if (current_sell.quantity == 0) {
            current_sell.status = "completed";
            current_sell.triggerPrice = current_buy.price;
            // orderSocket(current_sell.userId, current_sell, sellwalletBal, 'del');
            // THE UNSOLD REMAINDER - base coin here, since a sell escrows the
            // coin itself and this fill delivers execQty of it. This is the
            // side the defect was measured on: 9.87588606428608e-9 BTC debited
            // at placement, sold to nobody, and released out of the escrow
            // counter without ever being credited back. See
            // unspentReservationOf.
            const sellUnspent = sellerSynthetic
              ? 0
              : unspentReservationOf(current_sell, execQty);
            // RETIRING - see the buy side above.
            sellInOrder = await releaseInOrder(
              current_sell,
              current_sell.firstCurrencyId,
              execQty,
              { final: true }
            );
            await refundUnspentReservation({
              order: current_sell,
              currencyId: current_sell.firstCurrencyId,
              coin: current_sell.firstCurrency,
              unspent: sellUnspent,
            });
            hset(
              "orderHistory_" + current_sell.userId,
              current_sell._id,
              current_sell
            );
            await hdel(
              "sellOpenOrders_" + current_sell.pairId,
              current_sell._id
            );
            orderHistArr.push(current_sell);
            sellOrders.shift();
          } else {
            current_sell.status = "pending";
            sellInOrder = await releaseInOrder(
              current_sell,
              current_sell.firstCurrencyId,
              execQty
            );
            current_sell.triggerPrice = current_buy.price;
            // orderSocket(current_sell.userId, current_sell, sellwalletBal, 'edit');
            orderHistArr.push(current_sell);
            await hdel(
              "sellOpenOrders_" + current_sell.pairId,
              current_sell._id
            );
            await hset(
              "sellOpenOrders_" + current_sell.pairId,
              current_sell._id,
              current_sell
            );
          }
          // THE CRYPTODEX FEE DISCOUNT WAS DEDUCTED HERE. It is gone; see the
          // note above `settlementCredit` for the full reasoning. Nothing
          // replaces it, because it could never fire: the reward pot it
          // debited has had no crediting path for some time.
          // }
          // The buyOrders/sellOrders depth hashes are not rendered for binance
          // pairs (the UI book comes from the live WS feed), and editOrderBook
          // fires a REST /api/v3/depth call plus a competing "orderBook" emit
          // per level, so skip it entirely there.
          if (pairData.botstatus !== "binance") {
            // update for BUY
            editOrderBook({
              buyorsell: current_buy?.buyorsell || current_buy?.type,
              price: current_buy.price,
              minusQuantity: exectamount,
              pairId: current_buy.pairId,
              firstFloatDigit: current_buy.firstFloatDigit,
            });

            // //update for SELL
            editOrderBook({
              buyorsell: current_sell?.buyorsell || current_sell?.type,
              price: current_sell.price,
              minusQuantity: exectamount,
              pairId: current_sell.pairId,
              firstFloatDigit: current_sell.firstFloatDigit,
            });
          }

          // No passbook row for the synthetic: it has no balance for a row to
          // describe, and a "before/after" pair for an account that is never
          // debited is not an audit trail, it is noise that makes the ledger
          // look reconciled when it is not.
          if (!buyerSynthetic) {
            passbook({
              userId: current_buy.userId,
              coin: current_buy.firstCurrency,
              currencyId: current_buy.firstCurrencyId,
              tableId: current_buy._id,
              beforeBalance: buyerWallet,
              afterBalance: buyerWallet + exectamount,
              amount: toFixedDown(parseFloat(exectamount), 8),
              type: "spot_limit_match",
              category: "credit",
            });
          }
          if (!sellerSynthetic) {
            passbook({
              userId: current_sell.userId,
              coin: current_sell.secondCurrency,
              currencyId: current_sell.secondCurrencyId,
              tableId: current_sell._id,
              beforeBalance: sellerWallet,
              afterBalance: sellerWallet + execvalue,
              amount: toFixedDown(parseFloat(execvalue), 8),
              type: "spot_limit_match",
              category: "credit",
            });
          }
          tradeHistArr.push({
            buyOrderData: current_buy,
            sellOrderData: current_sell,
            uniqueId: uniqueId,
            execPrice: avgPrice,
            Maker: isMaker,
            execQuantity: exectamount,
            ordertype: "Limit",
          });
          ChartDocHistory({
            pairName: pairData.tikerRoot,
            price: avgPrice,
          }); //ChartHistory
          // THE TWO SETTLEMENT LEGS. Skipped for the synthetic counterparty,
          // which is credited by nobody because it is debited by nobody - see
          // settlementCredit.
          let buyerFinaleBalance = await settlementCredit(
            current_buy,
            current_buy.firstCurrencyId,
            exectamount,
            buyerSynthetic
          );
          let sellerFinaleBalance = await settlementCredit(
            current_sell,
            current_sell.secondCurrencyId,
            execvalue,
            sellerSynthetic
          );

          socketEmitOne(
            "updateTradeAsset",
            {
              currencyId: current_buy.firstCurrencyId,
              spotBal: buyerFinaleBalance,
              inOrder: buyInOrder,
            },
            current_buy.userId
          );
          socketEmitOne(
            "updateTradeAsset",
            {
              currencyId: current_sell.secondCurrencyId,
              spotBal: sellerFinaleBalance,
              inOrder: sellInOrder,
            },
            current_sell.userId
          );
          // NOTE: the per-fill `tradePair = ""` that used to sit here was removed.
          // It cleared the cancel-block latch after the FIRST fill, re-opening
          // the race for every subsequent fill in the same tick. The latch is now
          // armed for the whole tick (set in matchingcall before the read,
          // cleared once in matchingcall's finally).
          getOpenOrderSocket(current_sell.userId, current_sell.pairId);
          getOpenOrderSocket(current_buy.userId, current_buy.pairId);
          getOrderHistorySocket(current_buy.userId, current_buy.pairId);
          getOrderHistorySocket(current_sell.userId, current_sell.pairId);
          // marketPriceSocket(current_buy.pairId);
        }
        // console.log('----------3779')
        break;
      }
    }
    isRun = false;
    //DB MAINTAIN
    if (orderHistArr.length > 0) {
      orderHistArr.forEach((element) => {
        newOrderHistory(element);
      });
      orderHistArr = [];
    }

    if (tradeHistArr.length > 0) {
      tradeHistArr.forEach((element) => {
        newTradeHistory(element);
      });
      tradeHistArr = [];
    }

    if (buyOrders.length <= 0) {
      sellOrders.forEach(async (element) => {
        if (
          element.price === "market" &&
          element.liquidityType == "off" &&
          !element.isLiquidity
        ) {
          cancelMarketOrder(`sellOpenOrders_${element.pairId}`, element._id);
          return;
        }
      });
    }
    if (sellOrders.length <= 0) {
      buyOrders.forEach(async (element) => {
        if (
          element.price === "market" &&
          element.liquidityType == "off" &&
          !element.isLiquidity
        ) {
          cancelMarketOrder(`buyOpenOrders_${element.pairId}`, element._id);
          return;
        }
      });
    }
    if (tradePair == pairData._id) tradePair = "";
  } catch (err) {
    console.log("----------------------TRADE MATCH ERR", err);
    // Release the matcher latch so one thrown error cannot permanently
    // stop the 2s matching cron for every pair until process restart.
    isRun = false;
    if (pairData && tradePair == pairData._id) tradePair = "";
  }
};

export const setDepthHist = async (item, type) => {
  let buyDepth = await lrange(`buy_depth_${item.PairId}`);
  let sellDepth = await lrange(`sell_depth_${item.PairId}`);
  if (!isEmpty(buyDepth)) {
    buyDepth = await getvalueObj(buyDepth);
  }
  if (!isEmpty(sellDepth)) {
    sellDepth = await getvalueObj(sellDepth);
  }
  if (type == "buy" && (buyDepth?.length < 21 || buyDepth == null)) {
    rpush(
      `buy_depth_${item.PairId}`,
      JSON.stringify({ price: item.tradePrice, volume: item.tradeQty })
    );
  } else if (buyDepth?.length >= 21) {
    lpop(`buy_depth_${item.PairId}`);
    rpush(
      `buy_depth_${item.PairId}`,
      JSON.stringify({ price: item.tradePrice, volume: item.tradeQty })
    );
  }
  if (type == "sell" && (sellDepth?.length < 21 || sellDepth == null)) {
    rpush(
      `sell_depth_${item.PairId}`,
      JSON.stringify({ price: item.tradePrice, volume: item.tradeQty })
    );
  } else if (sellDepth?.length >= 21) {
    lpop(`sell_depth_${item.PairId}`);
    rpush(
      `sell_depth_${item.PairId}`,
      JSON.stringify({ price: item.tradePrice, volume: item.tradeQty })
    );
  }
};
export const setDepthBinanceHist = async (item, type) => {
  let buyDepth = await lrange(`buy_depth_binance_${item.PairId}`);
  let sellDepth = await lrange(`sell_depth_binance_${item.PairId}`);
  if (!isEmpty(buyDepth)) {
    buyDepth = await getvalueObj(buyDepth);
  }
  if (!isEmpty(sellDepth)) {
    sellDepth = await getvalueObj(sellDepth);
  }
  if (type == "buy" && (buyDepth?.length < 21 || buyDepth == null)) {
    rpush(
      `buy_depth_binance_${item.PairId}`,
      JSON.stringify({ price: item.tradePrice, volume: item.tradeQty })
    );
  } else if (buyDepth?.length >= 21) {
    lpop(`buy_depth_binance_${item.PairId}`);
    rpush(
      `buy_depth_binance_${item.PairId}`,
      JSON.stringify({ price: item.tradePrice, volume: item.tradeQty })
    );
  }
  if (type == "sell" && (sellDepth?.length < 21 || sellDepth == null)) {
    rpush(
      `sell_depth_binance_${item.PairId}`,
      JSON.stringify({ price: item.tradePrice, volume: item.tradeQty })
    );
  } else if (sellDepth?.length >= 21) {
    lpop(`sell_depth_binance_${item.PairId}`);
    rpush(
      `sell_depth_binance_${item.PairId}`,
      JSON.stringify({ price: item.tradePrice, volume: item.tradeQty })
    );
  }
};

export const marketMatching = async (
  buyOrders,
  sellOrders,
  current_buy,
  current_sell,
  pairData
) => {
  try {
    console.log("--------MARKET MATCH-----------");
    if (
      current_buy.liquidityType == "off" &&
      current_sell.liquidityType == "off"
    ) {
      let uniqueId = Math.floor(Math.random() * 1000000000);
      let adminLiq = await hget("admin_liquidity", "liquidation");
      adminLiq = adminLiq ? JSON.parse(adminLiq) : null;
      const adminLiqId = adminLiq && adminLiq._id;
      // THE MAKER IS WHOEVER WAS RESTING. Exactly one side of a marketMatching
      // fill is a market order (tradeMatching always pairs a market order
      // against the opposite side's best LIMIT), and a market order never
      // rests, so the limit side is the maker.
      //
      // The old rule asked only "is the BUYER the admin liquidation account".
      // It got the ladder cases right by luck and the user-vs-user case exactly
      // backwards: a real user's market SELL hitting another real user's
      // resting limit BUY was named `isMaker = "sell"`, charging the resting
      // user the taker rate and the aggressor the maker rebate.
      const isMaker = makerSideOf(current_buy, current_sell, adminLiqId);
      // House liquidity is not a ledger account - see settlementCredit.
      const buyerSynthetic = isSyntheticOrder(current_buy, adminLiqId);
      const sellerSynthetic = isSyntheticOrder(current_sell, adminLiqId);
      let sellamount = current_sell.quantity;
      // Never HGET+parseFloat these directly: a first-touch field is absent,
      // and NaN here loses the whole passbook row (see readSpotBalanceNumber).
      let buyerWallet = await readSpotBalanceNumber(
        current_buy.userId,
        current_buy.firstCurrencyId
      );
      let sellerWallet = await readSpotBalanceNumber(
        current_sell.userId,
        current_sell.secondCurrencyId
      );
      let exectamount = Math.min(current_buy.quantity, current_sell.quantity);
      // Nothing to settle: a float residual (firstFloatDigit is 18 on ETH, so
      // the quantity arithmetic loses precision above 2^53) must not produce a
      // zero/negative-quantity trade.
      if (!(exectamount > 0)) {
        return;
      }
      // exectamount is mutated later (fee deduction); keep the per-fill size for
      // the in-order releases, which must never use the CUMULATIVE
      // filledQuantity or a second partial re-releases the first fill's share.
      const execQty = exectamount;
      let execvalue =
        isMaker == "buy"
          ? exectamount * current_buy.price
          : exectamount * current_sell.price;
      // Each side priced from its OWN order, at the rate for the role it
      // actually played; nothing for the synthetic - see settlementCredit.

      let avgPrice = isMaker == "buy" ? current_buy.price : current_sell.price;
      let buyExcAmount =
        (current_buy.quantity * 10 ** current_buy.firstFloatDigit -
          exectamount * 10 ** current_buy.firstFloatDigit) /
        10 ** current_buy.firstFloatDigit;

      // TRUNCATE, DO NOT ROUND - the market branch, same rule as the limit
      // branch above. A remainder can only shrink.
      buyExcAmount = toFixedDown((buyExcAmount * 100) / 100, current_buy.firstFloatDigit)
      current_buy.quantity = buyExcAmount;
      current_buy.filledQuantity += exectamount;
      let sellExcAmount =
        (current_sell.quantity * 10 ** current_sell.firstFloatDigit -
          exectamount * 10 ** current_sell.firstFloatDigit) /
        10 ** current_sell.firstFloatDigit;
      sellExcAmount = toFixedDown((sellExcAmount * 100) / 100, current_sell.firstFloatDigit)
      current_sell.quantity = sellExcAmount;
      current_sell.filledQuantity += exectamount;
      console.log(avgPrice, "--------avgPrice");
      console.log(exectamount, "--------exectamount");
      console.log(isMaker, "--------isMaker");
      // averagePrice ACCUMULATES the filled notional for every orderType: a
      // market order's unfilled remainder is openOrderValue - averagePrice
      // (below), and a limit order's rendered average fill is
      // averagePrice / filledQuantity. The old limit branch ASSIGNED, which
      // discarded every fill but the last.
      current_buy.averagePrice =
        parseFloat(current_buy.averagePrice || 0) + avgPrice * exectamount;
      current_sell.averagePrice =
        parseFloat(current_sell.averagePrice || 0) + avgPrice * exectamount;
      console.log(current_sell, "----------3937");
      console.log(current_buy, "----------3942");
      //order update process
      if (current_buy.quantity == 0) {
        current_buy.status = "completed";
        // The unsold remainder of a RESTING LIMIT buy that a market order has
        // just finished off. `openOrderValue` below is a MARKET order's field -
        // a limit order has none, so that refund is NaN-guarded out for this
        // case and does not overlap with this one. See unspentReservationOf.
        const buyUnspent = buyerSynthetic
          ? 0
          : unspentReservationOf(current_buy, current_buy.price * execQty);
        // Market orders (flag) never escrowed in-order value and paper
        // liquidity was never debited at all: releaseInOrder enforces both.
        // RETIRING - the fill that emptied the order gives back the whole
        // remainder of its own reservation. See releaseInOrder.
        await releaseInOrder(
          current_buy,
          current_buy.secondCurrencyId,
          current_buy.price * execQty,
          { final: true }
        );
        await refundUnspentReservation({
          order: current_buy,
          currencyId: current_buy.secondCurrencyId,
          coin: current_buy.secondCurrency,
          unspent: buyUnspent,
        });
        let retriveBal =
          parseFloat(current_buy.openOrderValue) -
          parseFloat(current_buy.averagePrice);

        if (retriveBal > 0) {
          // `liquidityType`/`isLiquidity` do NOT exclude the synthetic: paper
          // ladder rows carry liquidityType "off" and isLiquidity false, so an
          // unspent-remainder refund would land on the account that never spent
          // anything. See settlementCredit.
          if (
            !buyerSynthetic &&
            current_buy.liquidityType == "off" &&
            !current_buy.isLiquidity
          ) {
            let buyRetrive = await moveBalanceSigned(
              "walletbalance_spot",
              current_buy.userId + "_" + current_buy.secondCurrencyId,
              retriveBal,
              { reason: "price_improvement_refund" }
            );

            let beforeBAL = parseFloat(buyRetrive) - parseFloat(retriveBal);
            passbook({
              userId: current_buy.userId,
              coin: current_buy.secondCurrency,
              currencyId: current_buy.secondCurrencyId,
              tableId: current_buy._id,
              beforeBalance: toFixedDown(beforeBAL, 8),
              afterBalance: toFixedDown(buyRetrive, 8),
              amount: parseFloat(retriveBal),
              type: "spot_market_bal_retrieve_buy",
              category: "credit",
            });
            socketEmitOne(
              "updateTradeAsset",
              {
                currencyId: current_buy.secondCurrencyId,
                spotBal: buyRetrive,
              },
              current_buy.userId
            );
          }
        }
        hset(
          "orderHistory_" + current_buy.userId,
          current_buy._id,
          current_buy
        );
        await hdel("buyOpenOrders_" + current_buy.pairId, current_buy._id);
        newOrderHistory(current_buy);
        buyOrders.shift();
      } else {
        if (current_buy.flag == true) {
          let checkLimit = (element) => element._id !== current_sell._id;
          let checkOrder = sellOrders.findIndex(checkLimit);
          let retriveBal =
            parseFloat(current_buy.openOrderValue) -
            parseFloat(current_buy.averagePrice);
          current_buy.orderValue = retriveBal;
          current_buy.quantity = 0;
          console.log(retriveBal, "-------retriveBal");
          console.log(checkOrder, "-------checkOrder");
          if (retriveBal > 0 && checkOrder == -1) {
            if (
              !buyerSynthetic &&
              current_buy.liquidityType == "off" &&
              !current_buy.isLiquidity
            ) {
              current_buy.status = "completed";
              hset(
                "orderHistory_" + current_buy.userId,
                current_buy._id,
                current_buy
              );
              let buyRetrive = await moveBalanceSigned(
                "walletbalance_spot",
                current_buy.userId + "_" + current_buy.secondCurrencyId,
                retriveBal,
                { reason: "price_improvement_refund" }
              );
              await hdel(
                "buyOpenOrders_" + current_buy.pairId,
                current_buy._id
              );
              let beforeBAL = parseFloat(buyRetrive) - parseFloat(retriveBal);
              passbook({
                userId: current_buy.userId,
                coin: current_buy.secondCurrency,
                currencyId: current_buy.secondCurrencyId,
                tableId: current_buy._id,
                beforeBalance: beforeBAL,
                afterBalance: buyRetrive,
                amount: parseFloat(retriveBal),
                type: "spot_market_bal_retrieve_buy",
                category: "credit",
              });
              newOrderHistory(current_buy);
              socketEmitOne(
                "updateTradeAsset",
                {
                  currencyId: current_buy.secondCurrencyId,
                  spotBal: buyRetrive,
                },
                current_buy.userId
              );
            }
          } else {
            current_buy.price = "market";
            console.log("-------------- ELSE REOPEN BUY");
            current_buy.status = "pending";
            await hdel("buyOpenOrders_" + current_buy.pairId, current_buy._id);
            await hset(
              "buyOpenOrders_" + current_buy.pairId,
              current_buy._id,
              current_buy,
              "buyone"
            );
            newOrderHistory(current_buy);
          }
        } else {
          console.log("-------------- ELSE DOWN REOPEN BUY");
          current_buy.status = "pending";
          await releaseInOrder(
            current_buy,
            current_buy.secondCurrencyId,
            current_buy.price * execQty
          );
          await hdel("buyOpenOrders_" + current_buy.pairId, current_buy._id);
          await hset(
            "buyOpenOrders_" + current_buy.pairId,
            current_buy._id,
            current_buy,
            "buytwo"
          );
          newOrderHistory(current_buy);
        }
      }
      if (current_sell.quantity == 0) {
        console.log("--------------COMPLETE SELL");
        current_sell.status = "completed";
        // The unsold remainder of a RESTING LIMIT sell finished off by a market
        // order - base coin, debited at placement and delivered to nobody. This
        // is the path the task's note is about: even with sizes quantised at
        // the door, a fill quantity can still be finer than the resting order's
        // precision, so the truncated remainder and the exact escrow still
        // part company. See unspentReservationOf.
        const sellUnspent = sellerSynthetic
          ? 0
          : unspentReservationOf(current_sell, execQty);
        // Market orders (flag) never escrowed in-order value and paper
        // liquidity was never debited at all: releaseInOrder enforces both.
        // RETIRING - see the buy side above.
        await releaseInOrder(
          current_sell,
          current_sell.firstCurrencyId,
          execQty,
          { final: true }
        );
        await refundUnspentReservation({
          order: current_sell,
          currencyId: current_sell.firstCurrencyId,
          coin: current_sell.firstCurrency,
          unspent: sellUnspent,
        });
        hset(
          "orderHistory_" + current_sell.userId,
          current_sell._id,
          current_sell
        );
        await hdel("sellOpenOrders_" + current_sell.pairId, current_sell._id);
        newOrderHistory(current_sell);
        sellOrders.shift();
      } else {
        if (current_sell.flag == true) {
          let checkLimit = (element) => element._id !== current_sell._id;
          let checkOrder = buyOrders.findIndex(checkLimit);
          let retriveBal = sellamount - exectamount;
          current_sell.price = "market";
          current_sell.amount = current_sell.quantity;
          if (retriveBal > 0 && checkOrder == -1) {
            if (!sellerSynthetic && current_sell.liquidityType == "off") {
              current_sell.status = "completed";
              hset(
                "orderHistory_" + current_sell.userId,
                current_sell._id,
                current_sell
              );
              let sellRetrive = await moveBalanceSigned(
                "walletbalance_spot",
                current_sell.userId + "_" + current_sell.firstCurrencyId,
                retriveBal,
                { reason: "price_improvement_refund" }
              );
              await hdel(
                "sellOpenOrders_" + current_sell.pairId,
                current_sell._id
              );
              let beforeBAL = parseFloat(sellRetrive) - parseFloat(retriveBal);
              passbook({
                userId: current_sell.userId,
                coin: current_sell.firstCurrency,
                currencyId: current_sell.firstCurrencyId,
                tableId: current_sell._id,
                beforeBalance: beforeBAL,
                afterBalance: sellRetrive,
                amount: parseFloat(retriveBal),
                type: "spot_market_bal_retrieve_sell",
                category: "credit",
              });
              newOrderHistory(current_sell);
              socketEmitOne(
                "updateTradeAsset",
                {
                  currencyId: current_sell.firstCurrencyId,
                  spotBal: sellRetrive,
                },
                current_sell.userId
              );
            }
          } else {
            console.log("-------------- ELSE REOPEN SELL");
            current_buy.status = "completed";
            await hdel(
              "sellOpenOrders_" + current_sell.pairId,
              current_sell._id
            );
            await hset(
              "sellOpenOrders_" + current_sell.pairId,
              current_sell._id,
              current_sell,
              "sellone"
            );
            newOrderHistory(current_sell);
          }
        } else {
          console.log("-------------- ELSE DOWN REOPEN SELL");
          current_sell.status = "pending";
          await releaseInOrder(
            current_sell,
            current_sell.firstCurrencyId,
            execQty
          );
          await hdel("sellOpenOrders_" + current_sell.pairId, current_sell._id);
          await hset(
            "sellOpenOrders_" + current_sell.pairId,
            current_sell._id,
            current_sell,
            "selltwo"
          );
          newOrderHistory(current_sell);
        }
      }

      // THE CRYPTODEX FEE DISCOUNT WAS DEDUCTED HERE - removed, see the note
      // above `settlementCredit`. The market path carried the same call pair
      // as the limit path, including the same seller-from-buyer bug.

      //Order Book update for BUY
      // Skipped for binance pairs: see the note in tradeMatching's limit branch.
      if (current_sell.flag == true && pairData.botstatus !== "binance") {
        editOrderBook({
          buyorsell: current_buy?.buyorsell || current_buy?.type,
          price: current_buy.price,
          minusQuantity: exectamount,
          pairId: current_buy.pairId,
          firstFloatDigit: pairData.firstFloatDigit,
        });
      }
      // No passbook row for the synthetic - see settlementCredit.
      if (!buyerSynthetic) {
        passbook({
          userId: current_buy.userId,
          coin: current_buy.firstCurrency,
          currencyId: current_buy.firstCurrencyId,
          tableId: current_buy._id,
          beforeBalance: buyerWallet,
          afterBalance: buyerWallet + exectamount,
          amount: parseFloat(exectamount),
          type: "spot_market_match",
          category: "credit",
        });
      }
      //Order Book update for SELL
      if (current_buy.flag == true && pairData.botstatus !== "binance") {
        editOrderBook({
          buyorsell: current_sell.buyorsell,
          price: current_sell.price,
          minusQuantity: exectamount,
          pairId: current_sell.pairId,
          firstFloatDigit: pairData.firstFloatDigit,
        });
      }
      if (!sellerSynthetic) {
        passbook({
          userId: current_sell.userId,
          coin: current_sell.secondCurrency,
          currencyId: current_sell.secondCurrencyId,
          tableId: current_sell._id,
          beforeBalance: sellerWallet,
          afterBalance: sellerWallet + execvalue,
          amount: parseFloat(execvalue),
          type: "spot_market_match",
          category: "credit",
        });
      }
      // Trade History
      newTradeHistory({
        buyOrderData: current_buy,
        sellOrderData: current_sell,
        uniqueId: uniqueId,
        execPrice: avgPrice,
        Maker: isMaker,
        execQuantity: exectamount,
        ordertype: "Market",
      });
      ChartDocHistory({
        pairName: pairData.tikerRoot,
        price: avgPrice,
      }); //ChartHistory


      // THE TWO SETTLEMENT LEGS - see settlementCredit.
      let buyWallet = await settlementCredit(
        current_buy,
        current_buy.firstCurrencyId,
        exectamount,
        buyerSynthetic
      );
      let sellWallet = await settlementCredit(
        current_sell,
        current_sell.secondCurrencyId,
        execvalue,
        sellerSynthetic
      );
      getOpenOrderSocket(current_sell.userId, current_sell.pairId);
      getOpenOrderSocket(current_buy.userId, current_buy.pairId);
      getOrderHistorySocket(current_buy.userId, current_buy.pairId);
      getOrderHistorySocket(current_sell.userId, current_sell.pairId);
      socketEmitOne(
        "updateTradeAsset",
        {
          currencyId: current_buy.firstCurrencyId,
          spotBal: buyWallet,
        },
        current_buy.userId
      );
      socketEmitOne(
        "updateTradeAsset",
        {
          currencyId: current_sell.secondCurrencyId,
          spotBal: sellWallet,
        },
        current_sell.userId
      );
      // marketPriceSocket(current_buy.pairId);
    }
  } catch (err) {
    console.log(err, "-----------------Market match error");
  }
};

/**
 * THE "PAY FEES IN CRYPTODEX" DISCOUNT IS GONE. `cryptodexFeeSetting()` and
 * `deductCryptodex()` lived here, and both call sites (the limit match above and
 * the market match) went with them.
 *
 * IT COULD NOT FIRE, AND HAD NOT BEEN ABLE TO FOR SOME TIME. The discount
 * debited the user's CRYPTODEX balance out of a reward pot whose only
 * crediting path has been removed, so nothing writes to that hash any more.
 * Every account's balance in it is
 * therefore <= 0 for good, and the function's own overdraft check
 * (`hincbyfloat` then "if the result went negative, put it back") rejected the
 * deduction and returned `{isEnabled: false}` every time. It was also gated on
 * the `enableCryptodexFee` user setting, which registration writes as `false`.
 *
 * IT ALSO CARRIED A LATENT BUG, which is why removing it is better than
 * leaving it switched off. Both call sites computed the SELLER's deduction
 * from the BUYER's numbers:
 *
 *     const sellerCryptodex = await deductCryptodex({
 *       order: current_sell,
 *       fee: buyFee,               // <- the buyer's fee
 *       feeCurrency: bFeeCurrency, // <- and the buyer's fee currency
 *     });
 *
 * The buyer is charged in the BASE coin and the seller in the QUOTE currency,
 * so this asked "what is the buyer's base-coin fee worth in CRYPTODEX" and
 * charged the seller that - a different amount, converted through the wrong
 * leg of the pair. Worse, the buyer's block reassigns `buyFee` before the
 * seller's block reads it, so had the feature ever been switched on the
 * seller's charge would have depended on whether the BUYER had the discount
 * enabled. Nobody was ever charged wrongly, because nobody was ever charged.
 *
 * PLAIN MAKER/TAKER FEES ARE GONE TOO, since 2026-09-06. `buyFee`/`sellFee` no
 * longer exist: nothing is computed, nothing is deducted from a settled amount,
 * and TradeHistory has no fee column at all. Both legs credit the gross. What
 * this note still records is the earlier change, where the two `deductCryptodex`
 * calls stopped running and the `isEnabled` ternaries that fanned out from them
 * were folded to the branch that always executed:
 *
 *     buyerFeeCurrencyId: !buyerCryptodex.isEnabled ? current_buy.firstCurrencyId : ...
 *   becomes
 *     buyerFeeCurrencyId: current_buy.firstCurrencyId
 *
 * and `buyerFeeExcRate`/`sellerFeeExcRate` are the empty string they were
 * always written as. Measured live before and after on a throwaway account:
 * taker buy 0.1% in the base coin, taker sell 0.1% in the quote, maker buy and
 * maker sell 0.02%, byte-identical on both sides of this change.
 */

//Cancel Market Order

export const cancelMarketOrder = async (tableId, orderId) => {
  try {
    // CLAIM FIRST, then refund - same rule as cancelOrder. The matcher fires
    // this without awaiting, from several branches of the same tick and from
    // overlapping ticks, so a read-then-refund-then-delete would credit the
    // same unspent market-order value once per caller.
    const checkOrder = parseOrder(await hgetdel(tableId, orderId));
    if (checkOrder) {
      checkOrder.status = "cancel";
      let currencyId =
        checkOrder.buyorsell == "buy"
          ? checkOrder.secondCurrencyId
          : checkOrder.firstCurrencyId;
      let orderValue =
        checkOrder.buyorsell == "buy"
          ? checkOrder.price * checkOrder.quantity
          : checkOrder.quantity;
      let marketValue =
        checkOrder.orderType == "market" && checkOrder.buyorsell == "buy"
          ? checkOrder.orderValue
          : checkOrder.amount;
      let retriveValue =
        checkOrder.orderType == "limit" ? orderValue : marketValue;
      retriveValue = parseFloat(retriveValue);
      if (checkOrder.orderType != "market") {
        // editOrderBook({
        //   buyorsell: checkOrder.buyorsell,
        //   price: checkOrder.price,
        //   minusQuantity: checkOrder.quantity,
        //   pairId: checkOrder.pairId,
        //   firstFloatDigit: checkOrder.firstFloatDigit,
        // });
      }
      let userWallet = await moveBalanceSigned(
        "walletbalance_spot",
        checkOrder.userId + "_" + currencyId,
        retriveValue,
        { reason: "cancel_market_refund" }
      );
      // A REFUND THAT CREDITS `orderValue` MUST RELEASE `orderValue`.
      //
      // Every call site today passes an order with `price === "market"`, and a
      // market order reserves nothing - so this branch does not fire in
      // practice. It is here because the function does not TAKE that as an
      // argument: two lines up it computes `retriveValue` from the limit
      // formula whenever `orderType == "limit"`, so the day a caller hands it a
      // resting limit order it would credit the whole reservation back into the
      // balance and leave the reservation standing - which is exactly the leak
      // createTradeHistory had. The invariant is made structural rather than
      // left resting on which call sites happen to exist. releaseInOrder is a
      // no-op for market (`flag`) and paper (`isPaper`) orders regardless.
      if (checkOrder.orderType == "limit") {
        await releaseInOrder(checkOrder, currencyId, retriveValue, {
          final: true,
        });
      }
      passbook({
        userId: checkOrder.userId,
        coin:
          checkOrder.buyorsell == "buy"
            ? checkOrder.secondCurrency
            : checkOrder.firstCurrency,
        currencyId: currencyId,
        tableId: checkOrder._id,
        beforeBalance: userWallet - retriveValue,
        afterBalance: userWallet,
        amount: retriveValue,
        type: "orderCancel",
        category: "credit",
      });
      await hset(
        "orderHistory_" + checkOrder.userId,
        checkOrder._id,
        checkOrder
      );
      getOpenOrderSocket(checkOrder.userId, checkOrder.pairId);
      getOrderHistorySocket(checkOrder.userId, checkOrder.pairId);
      newOrderHistory(checkOrder);

      socketEmitOne(
        "updateTradeAsset",
        {
          currencyId: currencyId,
          spotBal: userWallet,
        },
        checkOrder.userId
      );
      return true;
    }
    return true;
  } catch (err) {
    console.log("err: ", err);
    return false;
  }
};

/**
 * Update Order Book
 * PARAMS : pairId
 */
export const editOrderBook = async ({
  orderType = "limit",
  buyorsell,
  price,
  minusQuantity,
  pairId,
  firstFloatDigit,
}) => {
  try {
    let decimalval = minTwoDigits(firstFloatDigit);
    let quntitydecimal = Math.round(minusQuantity * decimalval);
    quntitydecimal = toFixedDown(quntitydecimal, firstFloatDigit);
    console.log(buyorsell, '--------------4532', quntitydecimal)
    await hincby(buyorsell + "Orders" + pairId, price, -quntitydecimal);
    getOrderBookSocket(pairId);
    return true;
  } catch (err) {
    console.log("---4537", err);
    return false;
  }
};

export const newTradeHistory = async ({
  buyOrderData,
  sellOrderData,
  uniqueId,
  execPrice,
  Maker,
  execQuantity,
  ordertype,
}) => {
  // console.log(buyOrderData, "---buyOrderData")
  // console.log(sellOrderData, "---sellOrderData")
  // console.log(buyerFee, "buyerFee");
  // console.log(sellerFee, "sellerFee");
  // console.log(execPrice, "execPrice")
  // console.log("execQuantity>>>>>>>>>>>>>..", execQuantity)
  try {
    let PairId = buyOrderData.pairId
      ? buyOrderData.pairId
      : sellOrderData.pairId;
    let firsrCurrency = buyOrderData.firstCurrency
      ? buyOrderData.firstCurrency
      : sellOrderData.firstCurrency;
    let secondCurrecny = buyOrderData.secondCurrency
      ? buyOrderData.secondCurrency
      : sellOrderData.secondCurrency;
    let PairSymbole = firsrCurrency + secondCurrecny;
    let data = {
      pairId: PairId,
      firstCurrency: firsrCurrency,
      secondCurrency: secondCurrecny,
      firstCurrencyId: buyOrderData.firstCurrencyId
        ? buyOrderData.firstCurrencyId
        : sellOrderData.firstCurrencyId,
      secondCurrencyId: buyOrderData.secondCurrencyId
        ? buyOrderData.secondCurrencyId
        : sellOrderData.secondCurrencyId,
      sellUserId: sellOrderData.userId,
      buyUserId: buyOrderData.userId,
      uniqueId: uniqueId,
      tradePrice: execPrice,
      tradeQty: execQuantity,
      // The SAME two numbers again, under the two names the tradeHistory schema
      // has always carried. They are not dead fields: report.controller.js
      // projects execPrice and quantity in spotTradeUserHistory and in the
      // history export. Nothing ever WROTE them, so every row landed with the
      // schema defaults and every one of those readers has been rendering 0
      // for the price and size of a real trade.
      //
      // Written rather than dropped because the consumers live in another
      // service: removing the fields here would turn a wrong number into a
      // missing one in a UI this change cannot touch.
      //
      // Rows written before this fix have been repaired in place by
      // scripts/backfill-tradehistory-execprice.js: the execution was never
      // actually lost, tradePrice/tradeQty on the SAME document held it, and
      // the backfill cross-checks the copy against the row's own orderValue
      // before writing it. 162 rows were repaired; the collection now has no
      // row with a zeroed execPrice or quantity.
      execPrice: execPrice,
      quantity: execQuantity,
      buyUserCode: buyOrderData.userCode ? buyOrderData.userCode : "",
      sellUserCode: sellOrderData.userCode ? sellOrderData.userCode : "",
      buyeOrderPrice: parseFloat(
        !isEmpty(buyOrderData.price) && buyOrderData.price != "market"
          ? buyOrderData.price
          : 0
      ),
      sellerOrderPrice: parseFloat(
        !isEmpty(sellOrderData) && sellOrderData.price != "market"
          ? sellOrderData.price
          : 0
      ),
      sellOrderType: sellOrderData.orderType
        ? sellOrderData.orderType
        : "Liquidity",
      buyOrderType: buyOrderData.orderType
        ? buyOrderData.orderType
        : "Liquidity",
      isMaker: Maker,
      status: "completed",
      createdAt: Date.now(),
      orderValue: execPrice * execQuantity,
      pairName: PairSymbole,
      buyOrderId: buyOrderData._id ? buyOrderData._id : PairId,
      sellOrderId: sellOrderData._id ? sellOrderData._id : PairId,
      buyOrdCode: buyOrderData?.orderCode,
      sellOrdCode: sellOrderData?.orderCode,
    };
    console.log(data, "TradeHistory");
    let newCompletedTrade = new TradeHistory(data);
    await newCompletedTrade.save();

    if (!isEmpty(buyOrderData)) {
      // THERE IS NO FEE LEFT TO SHIP ANYWHERE. lib/liquidityRole's feeRateFor
      // and feeForSide are deleted, no fill computes a charge, and the
      // saveAdminprofit calls below no longer carry one - they record that a
      // trade happened, not revenue, because none is collected.
      saveAdminprofit({
        userId: newCompletedTrade.buyUserId,
        ordertype: newCompletedTrade.buyOrderType,
        pair:
          newCompletedTrade.firstCurrency +
          "/" +
          newCompletedTrade.secondCurrency,
        coin: newCompletedTrade.firstCurrency,
      });
    }
    if (!isEmpty(sellOrderData)) {
      // No fee is computed on this leg either - see the buy leg.
      saveAdminprofit({
        userId: newCompletedTrade.sellUserId,
        ordertype: newCompletedTrade.sellOrderType,
        pair:
          newCompletedTrade.firstCurrency +
          "/" +
          newCompletedTrade.secondCurrency,
        coin: newCompletedTrade.secondCurrency,
      });
    }

    await hset("tradeHistory_" + PairId, uniqueId, data);
    setDepthHist(
      {
        PairId,
        tradePrice: execPrice,
        tradeQty: execQuantity,
      },
      Maker
    );
    if (buyOrderData.userId) {
      await getTradeHistorySocket(
        buyOrderData.userId.toString(),
        PairId.toString()
      );
    }

    if (sellOrderData.userId) {
      await getTradeHistorySocket(
        sellOrderData.userId.toString(),
        PairId.toString()
      );
    }

    recentTradeSocket(PairId);

    let getDoc = await hget("spotPairdata", PairId.toString());

    getDoc = JSON.parse(getDoc);

    if (getDoc) {
      getDoc["prevMarkPrice"] = getDoc.markPrice;
      getDoc.markPrice = execPrice;
      hset("spotPairdata", PairId.toString(), getDoc);
      SpotPair.updateOne(
        { _id: PairId },
        { markPrice: execPrice, prevMarkPrice: getDoc.markPrice },
        { upsert: true }
      ).exec();
    }
    marketPriceSocket(PairId);
    return true;
  } catch (err) {
    console.log("newTradeHistorynewTradeHistoryERRRRRRRRR", err);
  }
};

export const liquidityOrderPlace = async (element, pairData) => {
  try {
    await hdel(`${element.buyorsell}OpenOrders_` + element.pairId, element._id);

    if (element.orderType == "market") {
      const { status } = await binanceCtrl.orderPlace(element, pairData);
      if (status) {
        return {
          status: true,
          message: "Your order placed successfully.",
        };
      } else {
        return {
          status: false,
          message: "Order cannot be placed now. Please try again later",
        };
      }
    } else {
      const { status, data } = await binanceCtrl.orderPlace(element, pairData);
      if (status) {
        element.status = "pending";
        element.isLiquidity = true;
        element.isLiquidityError = false;
        element.liquidityId = data.orderId;
        await hset(
          `${element.buyorsell}OpenOrders_` + element.pairId,
          element._id,
          element
        );
        newOrderHistory(element);
        return {
          status: true,
          message: "Your order placed successfully.",
        };
      } else {
        return {
          status: false,
          message: "Order cannot be placed now. Please try again later",
        };
      }
    }
  } catch (err) {
    console.log(
      "liquidityOrderPlaceliquidityOrderPlaceliquidityOrderPlaceliquidityOrderPlace",
      err
    );
    return {
      status: false,
    };
  }
};

export const depthData = async () => {
  let initial = [{ price: 0, volume: 0 }];
  let data = {};

  for (let i = 0; i < pairInfo.length; i++) {
    if (pairInfo[i].botstatus == "binance") {
      let buyDepth = await lrange(`buy_depth_binance_${pairInfo[i]._id}`);
      let sellDepth = await lrange(`sell_depth_binance_${pairInfo[i]._id}`);

      if (!isEmpty(buyDepth)) {
        buyDepth = await getvalueObj(buyDepth);
        buyDepth = buyDepth.sort((a, b) => b.price - a.price);
      }
      if (!isEmpty(sellDepth)) {
        sellDepth = await getvalueObj(sellDepth);
        sellDepth = sellDepth.sort((a, b) => a.price - b.price);
      }
      data = {
        pairId: pairInfo[i]._id,
        buy: buyDepth?.length > 20 ? buyDepth : initial,
        sell: sellDepth?.length > 20 ? sellDepth : initial,
      };
    } else {
      let buyDepth = await lrange("buy_depth_" + pairInfo[i]._id);
      let sellDepth = await lrange("sell_depth_" + pairInfo[i]._id);
      if (!isEmpty(buyDepth)) {
        buyDepth = await getvalueObj(buyDepth);
        buyDepth = buyDepth.sort((a, b) => b.price - a.price);
      }
      if (!isEmpty(sellDepth)) {
        sellDepth = await getvalueObj(sellDepth);
        sellDepth = sellDepth.sort((a, b) => a.price - b.price);
      }
      data = {
        pairId: pairInfo[i]._id,
        buy: buyDepth?.length > 0 ? buyDepth : initial,
        sell: sellDepth?.length > 0 ? sellDepth : initial,
      };
    }
    socketEmitOne("depthChart", data, "depthChart");
  }
};

export const clearSpotRedis = async () => {
  try {
    let tradeDoc,
      tradeArr = [];
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    let orderHistDoc = await OrderHistory.find({
      createdAt: { $gte: sevenDaysAgo },
      status: { $in: ["completed", "cancel"] },
    });
    let pairDoc = await SpotPair.find({}).distinct("_id");
    if (pairDoc?.length > 0) {
      for (let item of pairDoc) {
        tradeDoc = await hgetall("tradeHistory_" + item.toString());
        if (tradeDoc) {
          tradeDoc = await getvalueObj(tradeDoc);
          tradeArr = tradeArr.concat(...tradeDoc);
        }
      }
    }
    if (orderHistDoc?.length > 0) {
      for (let item of orderHistDoc) {
        await hdel("orderHistory_" + item.userId, item._id);
      }
    }
    if (tradeArr?.length > 0) {
      for (let item of tradeArr) {
        await hdel("tradeHistory_" + item.pairId, item.uniqueId);
      }
    }
  } catch (err) {
    console.log("err: ", err);
  }
};

export const getDepthData = async (req, res) => {
  try {
  let initial = [{ price: 0, volume: 0 }];
  let data = {};
  // This route is unauthenticated. Anything that throws past here never writes
  // a response, so the request hangs and the connection leaks: an absent,
  // malformed (CastError) or unknown id used to do exactly that.
  if (isEmpty(req.body.id) || !mongoose.isValidObjectId(req.body.id)) {
    return res.status(400).json({ success: false, message: "Invalid pair id" });
  }
  let pairData = await SpotPair.findOne(
    { _id: req.body.id },
    { botstatus: 1, firstCurrencySymbol: 1, secondCurrencySymbol: 1 }
  ).lean();
  if (isEmpty(pairData)) {
    return res.status(400).json({ success: false, message: "Pair not found" });
  }
  if (pairData.botstatus == "binance") {
    // Use simple get to retrieve data stored by updateOrderbookDepth cron job
    let buyDepthRaw = await get(`buy_depth_binance_${pairData._id}`);
    let sellDepthRaw = await get(`sell_depth_binance_${pairData._id}`);

    let buyDepth = [];
    let sellDepth = [];

    if (!isEmpty(buyDepthRaw)) {
      try {
        buyDepth = JSON.parse(buyDepthRaw);
        buyDepth = buyDepth.sort((a, b) => b.price - a.price);
      } catch (e) {
        buyDepth = [];
      }
    }
    if (!isEmpty(sellDepthRaw)) {
      try {
        sellDepth = JSON.parse(sellDepthRaw);
        sellDepth = sellDepth.sort((a, b) => a.price - b.price);
      } catch (e) {
        sellDepth = [];
      }
    }

    // Calculate totals for buy orders
    let sumamount = 0;
    buyDepth = buyDepth.map(order => {
      sumamount += order.volume;
      return { ...order, total: sumamount };
    });

    // Calculate totals for sell orders
    sumamount = 0;
    sellDepth = sellDepth.map(order => {
      sumamount += order.volume;
      return { ...order, total: sumamount };
    });

    // If Redis is empty, fetch from Binance REST API as fallback
    if (isEmpty(buyDepth) || isEmpty(sellDepth) || buyDepth.length < 20 || sellDepth.length < 20) {
      try {
        const axios = (await import("axios")).default;
        const symbol = pairData.firstCurrencySymbol +
          (pairData.secondCurrencySymbol === "USD" ? "USDT" : pairData.secondCurrencySymbol);
        const depthResponse = await axios.get(`https://api.binance.com/api/v3/depth`, {
          params: { symbol: symbol, limit: 20 },
          timeout: 5000,
        });
        const depth = depthResponse.data;

        // Process bids (buy orders)
        let buyOrderList = [];
        let sumamount = 0;
        if (depth.bids && depth.bids.length > 0) {
          for (let i = 0; i < depth.bids.length; i++) {
            const price = parseFloat(depth.bids[i][0]);
            const quantity = parseFloat(depth.bids[i][1]);
            sumamount += quantity;
            if (price > 0) {
              buyOrderList.push({
                price: price,
                volume: quantity,
                total: sumamount,
              });
            }
          }
        }

        // Process asks (sell orders)
        let sellOrderList = [];
        sumamount = 0;
        if (depth.asks && depth.asks.length > 0) {
          for (let i = 0; i < depth.asks.length; i++) {
            const price = parseFloat(depth.asks[i][0]);
            const quantity = parseFloat(depth.asks[i][1]);
            sumamount += quantity;
            if (price > 0) {
              sellOrderList.push({
                price: price,
                volume: quantity,
                total: sumamount,
              });
            }
          }
        }

        buyDepth = buyOrderList;
        sellDepth = sellOrderList;
      } catch (binanceErr) {
        console.log("[getDepthData] Binance API error:", binanceErr.message);
      }
    }

    data = {
      pairId: pairData._id,
      buy: buyDepth?.length > 0 ? buyDepth : initial,
      sell: sellDepth?.length > 0 ? sellDepth : initial,
    };
  } else {
    let buyDepth = await lrange("buy_depth_" + pairData._id);
    let sellDepth = await lrange("sell_depth_" + pairData._id);
    if (!isEmpty(buyDepth)) {
      buyDepth = await getvalueObj(buyDepth);
      buyDepth = buyDepth.sort((a, b) => b.price - a.price);
    }
    if (!isEmpty(sellDepth)) {
      sellDepth = await getvalueObj(sellDepth);
      sellDepth = sellDepth.sort((a, b) => a.price - b.price);
    }
    data = {
      pairId: pairData._id,
      buy: buyDepth?.length > 0 ? buyDepth : initial,
      sell: sellDepth?.length > 0 ? sellDepth : initial,
    };
  }
  socketEmitAll("depthChart", data);
  return res.status(200).json({ success: true, result: data });
  } catch (err) {
    console.log("getDepthData err", err);
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

export const getTrends = async (req, res) => {
  try {
    let result = [];
    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    let data = await TradeHistory.aggregate([
      {
        $match: { createdAt: { $gte: startOfDay, $lt: endOfDay } },
      },
      {
        $group: {
          _id: "$pairId",
          count: { $sum: 1 },
        },
      },
      {
        $sort: { count: -1 },
      },
    ]);
    if (data.length > 0) {
      result = data.map((item) => item._id.toString());
    }
    return res.status(200).json({ success: true, result });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Something went wrong" });
  }
};
/**
 * THE DEACTIVATION CANCEL - and why it has to release the reservation too.
 *
 * This is `cancelOrder` for orders the USER is not cancelling: the account is
 * being deactivated, so every one of their resting orders is claimed out of the
 * book and refunded. It credited `walletbalance_spot` by the retrieved value
 * and stopped there - it never released `walletbalance_spot_inOrder`.
 *
 * The two ledgers are not independent. Free balance is TOTAL MINUS IN-ORDER
 * everywhere it is shown (getWallet, the trade-page asset panel, the order
 * gate), so a reservation left standing behind an order that no longer exists
 * is money the user can see in their total and can never spend again - for a
 * deactivated-then-reactivated account, permanently. Reproduced on this stack:
 * a 30 USD resting buy, cancelled down this path, returned `walletbalance_spot`
 * to 20000 and left `walletbalance_spot_inOrder` at 30 with an empty book.
 *
 * It goes through releaseInOrder rather than a hand-rolled hincbyfloat for the
 * same reasons every other caller does: that helper is where the MARKET-order
 * and PAPER-liquidity exemptions live, where the clamp at zero lives, and where
 * "a retiring order gives back exactly the remainder of its own reservation"
 * lives. A fourth hand-rolled decrement here would be a fourth place for those
 * three rules to drift out of agreement. See the in-order ledger invariant note
 * above releaseInOrder.
 *
 * `final: true` because the caller has ALREADY claimed the row out of the open
 * order hash with hgetdel - this order has left the book and will never reserve
 * again - and the release happens BEFORE the order is written into
 * orderHistory, so the `inOrderReleased` the helper stamps on it is what gets
 * persisted and a second pass can never re-release the same reservation.
 */
export const createTradeHistory = async (order) => {
  let checkOrder = order;
  checkOrder.status = "cancel";
  let currencyId =
    checkOrder.buyorsell == "buy"
      ? checkOrder.secondCurrencyId
      : checkOrder.firstCurrencyId;
  let orderValue =
    checkOrder.buyorsell == "buy"
      ? checkOrder.price * checkOrder.quantity
      : checkOrder.quantity;
  let marketValue =
    checkOrder.orderType == "market" && checkOrder.buyorsell == "buy"
      ? checkOrder.orderValue
      : checkOrder.amount;
  let retriveValue = checkOrder.orderType == "limit" ? orderValue : marketValue;
  retriveValue = parseFloat(retriveValue);

  // THE REFUND COMES FROM THE LEDGER, NOT THE REWRITTEN QUANTITY - identical to
  // cancelOrder. `orderValue` is `price * quantity`, and `quantity` is rewritten
  // (Number.prototype.toFixed, half-up) after every partial fill, so a partly
  // filled limit order force-cancelled on deactivation credited walletbalance_spot
  // with MORE than it had ever reserved - the same deterministic mint the normal
  // cancel path fixed, just reached through account deactivation instead. This
  // credit is the spendable money; releaseInOrder({final:true}) below already
  // clamps the in-order counter to the ledger, but nothing clamped THIS line.
  // reservationRemaining = inOrderReserved - inOrderReleased: exactly what this
  // order still holds. Limit-only, and only when the ledger field exists
  // (pre-ledger orders keep the computation they were placed under).
  if (checkOrder.orderType == "limit") {
    const stillHeld = reservationRemaining(checkOrder);
    if (stillHeld !== null) {
      retriveValue = stillHeld;
    }
  }

  if (checkOrder.liquidityType == "off")
    if (checkOrder.orderType != "market") {
      editOrderBook({
        buyorsell: checkOrder.buyorsell,
        price: checkOrder.price,
        minusQuantity: checkOrder.quantity,
        pairId: checkOrder.pairId,
        firstFloatDigit: checkOrder.firstFloatDigit,
      });
    }
  let userWallet = await moveBalanceSigned(
    "walletbalance_spot",
    checkOrder.userId + "_" + currencyId,
    retriveValue,
    { reason: "trade_history_credit" }
  );
  // THE OTHER HALF OF THE REFUND. Only limit orders ever reserved (see
  // limitOrderPlace); market orders debited walletbalance_spot alone, and
  // releasing one here would drive the in-order ledger negative for a
  // reservation that was never taken.
  if (checkOrder.orderType == "limit") {
    await releaseInOrder(checkOrder, currencyId, retriveValue, { final: true });
  }
  await hset("orderHistory_" + checkOrder.userId, checkOrder._id, checkOrder);

  let beforeBalanmce = userWallet - parseFloat(retriveValue);
  passbook({
    userId: checkOrder.userId,
    coin:
      checkOrder.buyorsell == "buy"
        ? checkOrder.secondCurrency
        : checkOrder.firstCurrency,
    currencyId: currencyId,
    tableId: checkOrder._id,
    beforeBalance: beforeBalanmce.toFixed(8),
    afterBalance: userWallet,
    amount: retriveValue,
    type: "order_Cancel",
    category: "credit",
  });
};

export const cancelOrderForDeactiveAcc = async (reqBody) => {
  try {
    let userId = reqBody.userId;
    // console.log(userId, 'userId')
    if (!userId) {
      return { status: false };
    }

    await OrderHistory.updateMany(
      { userId, status: { $in: ["pending", "open"] } }, // Use $in instead of $or
      { $set: { status: "cancel" } } // Wrap status in $set to update it
    );

    let spotPairDoc = await hgetall("spotPairdata");
    spotPairDoc = await getActivePairs(spotPairDoc);

    const pairIdList = spotPairDoc.map((item) => item._id);
    let orderList = [];

    for (const item of pairIdList) {
      let buyOrder = await hgetall(`buyOpenOrders_${item}`);
      if (buyOrder) {
        buyOrder = await getvalueObjbyId(buyOrder, userId);
        if (buyOrder.length > 0) orderList.push(...buyOrder);
      }
      let sellOrder = await hgetall(`sellOpenOrders_${item}`);
      if (sellOrder) {
        sellOrder = await getvalueObjbyId(sellOrder, userId);
        if (sellOrder.length > 0) orderList.push(...sellOrder);
      }
    }

    for (const item of orderList) {
      if (item.userId == userId) {
        const orderType =
          item.buyorsell === "buy" ? "buyOpenOrders_" : "sellOpenOrders_";
        // CLAIM FIRST, then refund. createTradeHistory credits
        // walletbalance_spot, so deleting after it would let two concurrent
        // deactivations (or one racing a user cancel) pay the same reservation
        // out twice. The claimed snapshot is also the fresher one.
        const claimed = parseOrder(
          await hgetdel(orderType + item.pairId, item._id)
        );
        if (!claimed) continue;
        await createTradeHistory(claimed);
        getOpenOrderSocket(claimed.userId, claimed.pairId);
        getOrderHistorySocket(claimed.userId, claimed.pairId);
      }
    }
    return { status: true };
  } catch (err) {
    console.log(err, "-------------err");
    return { status: false };
  }
};




let cronState = false;
export const execute = async () => {
  if (cronState == true) return;
  try {
    cronState = true;
    let pair_data = await hgetall("spotPairdata");
    pair_data = await getActivePairs(pair_data);
    // console.log(pair_data, "pair_data");

    let adminLiquidity = await hget("admin_liquidity", "liquidation");
    // console.log(adminLiquidity, "adminLiquidity..");

    for (const pair of pair_data) {
      const filled_orders = await hgetall("filled_orders_" + pair._id);
      // console.log('exceute filled_orders', filled_orders);

      if (filled_orders) {
        // console.log("enter filled order")
        let filledOrdersArray = Object.values(filled_orders).map(order => {
          let parsed = JSON.parse(order);
          if (typeof parsed === "string") {
            parsed = JSON.parse(parsed);
          }
          // console.log('parsed order data>>>>>>>>>>>>>>>.: ', parsed);
          return parsed;
        });
        filledOrdersArray.sort((a, b) => a.timestamp - b.timestamp);
        if (filledOrdersArray?.length <= 0) {
          return
        }
        // console.log(filledOrdersArray, "filledOrdersArray");

        for (const filledOrderData of filledOrdersArray) {
          // let filledOrderData = JSON.parse(filled_orders[orderKey]);
          if (typeof filledOrderData == "string") {
            filledOrderData = JSON.parse(filledOrderData)
          }
          // console.log("filledOrderData>>>>>>>>>>>>>>>>>>>>>>>>>>>", filledOrderData);

          filledOrderData["botStatus"] = false;
          if (Array.isArray(filledOrderData?.balanceRetrievals) && filledOrderData.balanceRetrievals.length > 0) {
            // console.log("BALANCE_RETRIEVALS", filledOrderData.balanceRetrievals.length);
            for (const retrieval of filledOrderData.balanceRetrievals) {
              // console.log("retrieval data", retrieval)
              const orderData = filledOrderData.orderData.find(order => order.userId === retrieval.userId);
              // console.log("ORDER_DATA", orderData);
              if (!["spot_market_match", "spot_limit_match"].includes(retrieval.type)) {
                // if (retrieval.type !== "spot_limit_match") {
                passbook({
                  userId: retrieval.userId,
                  coin: retrieval.currencyId === orderData.firstCurrencyId ? orderData.firstCurrency : orderData.secondCurrency,
                  currencyId: retrieval.currencyId,
                  tableId: orderData._id,
                  beforeBalance: truncateDecimals(retrieval.beforeBalance, 8),
                  afterBalance: truncateDecimals(retrieval.afterBalance, 8),
                  amount: truncateDecimals(retrieval.amount, 8),
                  type: retrieval.type,
                  category: retrieval?.category || "credit",
                });
              }


            }
          }
          // console.log("ORDER_DATA_LENGTH", typeof filledOrderData);

          // console.log("ORDER_DATA_LENGTH", filledOrderData.orderData.length);

          if (filledOrderData.orderData && filledOrderData.orderData.length > 0) {

            if (filledOrderData.orderData.length == 1) {
              // console.log("orderLength == 1")
              let orderData = JSON.parse(JSON.stringify(filledOrderData.orderData[0]))
              if (orderData.status == "bot") {
                // console.log("orderData_status is bot", orderData)
                filledOrderData["botStatus"] = true;
                // console.log('adminLIQ', adminLiquidity)
                if (typeof adminLiquidity == "string") {
                  adminLiquidity = JSON.parse(adminLiquidity)
                }
                if (!adminLiquidity) {
                  throw Error("NO ADMIN LIQUIDITY FOUND");
                }
                orderData.status = "completed";
                orderData._id = new ObjectId();
                orderData.userId = adminLiquidity.id;
                orderData.type = orderData.type == "buy" ? "sell" : 'buy';
                orderData.buyorsell = orderData.type == "buy" ? "buy" : "sell";
                if (orderData.type === "sell") orderData.openQuantity = orderData.filledQuantity;
                // bot order currency swap
                // let tempCurrency = orderData.firstCurrency;
                // orderData.firstCurrency = orderData.secondCurrency;
                // orderData.secondCurrency = tempCurrency;

                // let tempCurrencyId = orderData.firstCurrencyId;
                // orderData.firstCurrencyId = orderData.secondCurrencyId;
                // orderData.secondCurrencyId = tempCurrencyId;
                filledOrderData.orderData[0].status = "completed";



                filledOrderData.orderData.push(orderData)

                // console.log('filledOrderData_firstOrder_id_status', filledOrderData.orderData[0].status, filledOrderData.orderData[0]._id, filledOrderData.orderData[0].type)
                // console.log('filledOrderData_secondOrder_id_status', filledOrderData.orderData[1].status, filledOrderData.orderData[1]._id, filledOrderData.orderData[1].type)
              }
            }
            for (const orderData of filledOrderData.orderData) {  // b
              // console.log("order_data_status:", orderData.status, orderData._id, orderData.type)

              newOrderHistory(orderData);
              getOpenOrderSocket(orderData.userId, orderData.pairId);
              getOrderHistorySocket(orderData.userId, orderData.pairId);
            }
          }

          if (filledOrderData.tradeData && filledOrderData.orderData.length >= 2) {
            const buyOrderData = filledOrderData.orderData.find(order => order.type === "buy");
            const sellOrderData = filledOrderData.orderData.find(order => order.type === "sell");

            if (buyOrderData && sellOrderData) {
              // console.log("ORDERBOOK UPDATED");

              [{ data: buyOrderData, side: "buy" }, { data: sellOrderData, side: "sell" }].forEach(({ data, side }) => {
                if (!filledOrderData.botStatus) {
                  editOrderBook({
                    orderType: data.orderType === "market" ? "market" : "limit",
                    buyorsell: side,
                    price: data.price,
                    minusQuantity: data.tradeQty,
                    pairId: data.pairId,
                    firstFloatDigit: data.firstFloatDigit,
                  });
                }
              });
              const passbookTypes = filledOrderData.balanceRetrievals.filter(retrieval => ["spot_market_match", "spot_limit_match"].includes(retrieval.type));
              // console.log('filledOrderData>>>>>>>>>>>>>>>.: ', filledOrderData);

              if (passbookTypes?.length > 0) {
                // console.log("buyOrderData", buyOrderData)
                // console.log("sellOrderData", sellOrderData)
                passbook({
                  userId: buyOrderData.userId,
                  coin: buyOrderData.firstCurrency,
                  currencyId: buyOrderData.firstCurrencyId,
                  tableId: buyOrderData._id,
                  beforeBalance: truncateDecimals(filledOrderData.tradeData.buyerWalletBefore, 8),
                  afterBalance: truncateDecimals(filledOrderData.tradeData.buyerWalletBefore +
                    filledOrderData.tradeData.execQuantity, 8),
                  amount: truncateDecimals(parseFloat(filledOrderData.tradeData.execQuantity), 8),
                  type: filledOrderData.tradeData.ordertype === "Market" ? "spot_market_match" : "spot_limit_match",
                  category: "credit",
                });

                passbook({
                  userId: sellOrderData.userId,
                  coin: sellOrderData.secondCurrency,
                  currencyId: sellOrderData.secondCurrencyId,
                  tableId: sellOrderData._id,
                  beforeBalance: truncateDecimals(filledOrderData.tradeData.sellerWalletBefore, 8),
                  afterBalance: truncateDecimals(filledOrderData.tradeData.sellerWalletBefore +
                    filledOrderData.tradeData.execValue, 8),
                  amount: truncateDecimals(parseFloat(filledOrderData.tradeData.execValue), 8),
                  type: filledOrderData.tradeData.ordertype === "Market" ? "spot_market_match" : "spot_limit_match",
                  category: "credit",
                });

              }


              buyOrderData["userCode"] = IncCntObjId(buyOrderData.userId);
              sellOrderData["userCode"] = IncCntObjId(sellOrderData.userId);
              // console.log("filledOrderData.tradeData.execPrice", filledOrderData.tradeData.execPrice)
              // console.log("bot_status", filledOrderData["botStatus"])
              newTradeHistory({
                buyOrderData,
                sellOrderData,
                uniqueId: filledOrderData.uniqueId,
                // execPrice: filledOrderData["botStatus"] ? buyOrderData.averagePrice : filledOrderData.tradeData.execPrice,
                execPrice: filledOrderData.tradeData.execPrice,
                Maker: filledOrderData.tradeData.maker == "bid" ? "buy" : "sell",
                execQuantity: filledOrderData["botStatus"] == true ? buyOrderData.filledQuantity : filledOrderData.tradeData.execQuantity,
                ordertype: filledOrderData.tradeData.ordertype,
              });
            }

          }

          if (filledOrderData.userCurrencies && filledOrderData.userCurrencies.length > 0) {
            const processedUsers = new Set();

            for (const userCurrency of filledOrderData.userCurrencies) {
              const [userId, currencyId] = userCurrency.split('_');

              const spotBal = await hget("walletbalance_spot", userCurrency);
              const inOrder = await hget("walletbalance_spot_inOrder", userCurrency);

              socketEmitOne("updateTradeAsset", {
                currencyId: currencyId,
                spotBal: parseFloat(spotBal) || 0,
                inOrder: parseFloat(inOrder) || 0
              }, userId);

              if (!processedUsers.has(userId)) {
                const orderData = filledOrderData.orderData.find(order => order.userId === userId);
                if (orderData) {
                  getOpenOrderSocket(userId, orderData.pairId);
                }
                processedUsers.add(userId);
              }

            }
          }

          for (let order of filledOrderData.orderData) {
            await ChartDocHistory({
              pairName: `${order.firstCurrency}${order.secondCurrency}`,
              price: order.price,
            });
          }
          await hdel("filled_orders_" + pair._id, filledOrderData.uniqueId);
        }
      }
    }
  } catch (error) {
    console.log("Error in execute function: ", error);
  }
  cronState = false;
};

// execute()


/////////////////////// FOR MATCHING SPEED CHECK PROCESS  ///////////////////////


async function getOrderCount(pairId) {
  const bc = await hlen("buyOpenOrders_" + pairId);
  const sc = await hlen("sellOpenOrders_" + pairId);
  return bc + sc;
}

async function monitorOrders(pairId) {
  let prevCount = await getOrderCount(pairId);

  setInterval(async () => {
    const currentCount = await getOrderCount(pairId);
    const diff = currentCount - prevCount;

    console.log(`Orders changed in last second: ${diff}`);

    prevCount = currentCount;
  }, 1000);
}

async function buyOrder() {

  // const seqId = await getSequenceId("orderHistory");
  const newOpenOrder = {
    _id: createobjectId(),
    userId: "6891dcebcff2e1e1a2826c8b",
    pairId: "6883229c633dbb627dc970dc",
    firstCurrencyId: "688321dd9d4aeaeb87a460e1",
    firstCurrency: "BNB",
    firstFloatDigit: 3,
    secondCurrencyId: "688322389d4aeaeb87a460eb",
    secondCurrency: "USDT",
    secondFloatDigit: 2,
    quantity: 1,
    price: 776.57,
    orderValue: 776.57,
    pairName: "BNBUSDT",
    beforeBalance: 0,
    afterBalance: 0,
    orderType: "limit",
    buyorsell: "buy",
    openQuantity: 1,
    averagePrice: 0,
    filledQuantity: 0,
    isLiquidity: false,
    isLiquidityError: false,
    liquidityType: "off",
    flag: false,
    status: "open",
    orderDate: new Date(),
    userCode: "8547467",
    isMaker: true,
    orderCode: 1,
  };

  newOpenOrder.orderDate = new Date(),

    newOrderHistory(newOpenOrder);
  // console.log(orderValue, "------764");
  await hset(
    newOpenOrder.buyorsell + "OpenOrders_" + newOpenOrder.pairId,
    newOpenOrder._id,
    newOpenOrder
  );
  updateOrderBook(
    newOpenOrder,
    newOpenOrder.pairId,
    3
  );
  getOpenOrderSocket(newOpenOrder.userId, newOpenOrder.pairId);
  getOrderHistorySocket(newOpenOrder.userId, newOpenOrder.pairId);
}

async function sellOrder() {
  // const seqId = await getSequenceId("orderHistory");
  const newOpenOrder = {
    _id: createobjectId(),
    userId: "6894a63eddd875a0cdf13e3a",
    pairId: "6883229c633dbb627dc970dc",
    firstCurrencyId: "688321dd9d4aeaeb87a460e1",
    firstCurrency: "BNB",
    firstFloatDigit: 3,
    secondCurrencyId: "688322389d4aeaeb87a460eb",
    secondCurrency: "USDT",
    secondFloatDigit: 2,
    quantity: 1,
    price: 776.57,
    orderValue: 776.57,
    pairName: "BNBUSDT",
    beforeBalance: 0,
    afterBalance: 0,
    orderType: "limit",
    buyorsell: "sell",
    openQuantity: 1,
    averagePrice: 0,
    filledQuantity: 0,
    isLiquidity: false,
    isLiquidityError: false,
    liquidityType: "off",
    flag: false,
    status: "open",
    orderDate: new Date(),
    userCode: "8547467",
    isMaker: true,
    orderCode: 1,
  };

  newOpenOrder.orderDate = new Date(),

    newOrderHistory(newOpenOrder);
  // console.log(orderValue, "------764");
  await hset(
    newOpenOrder.buyorsell + "OpenOrders_" + newOpenOrder.pairId,
    newOpenOrder._id,
    newOpenOrder
  );
  updateOrderBook(
    newOpenOrder,
    newOpenOrder.pairId,
    3
  );
  getOpenOrderSocket(newOpenOrder.userId, newOpenOrder.pairId);
  getOrderHistorySocket(newOpenOrder.userId, newOpenOrder.pairId);
}

(async function () {
  try {
    // monitorOrders("6883229c633dbb627dc970dc");
    // for (let i=0; i<5000; i++) {
    //   buyOrder();
    // }

    // for (let i=0; i<5000; i++) {
    //   sellOrder();
    // }

  } catch (err) {
    console.log(err);
  }
})();