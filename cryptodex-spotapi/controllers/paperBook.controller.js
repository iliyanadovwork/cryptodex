/**
 * PAPER TRADING LIQUIDITY BOOK
 *
 * Cryptodex is a paper-trading exchange: no order is ever routed to a real venue.
 * For pairs with botstatus "binance" the matching engine had no counterparty
 * source at all (tradeMatching only synthesises liquidity for "off"/"bot"), so
 * user orders rested forever and never filled.
 *
 * This module mirrors the LIVE Binance L2 depth that lib/binanceWebSocket.js
 * already streams into memory as resting, admin-owned limit orders inside the
 * real buyOpenOrders_/sellOpenOrders_ hashes. The existing engine then matches
 * and settles them with no special-casing: a user market buy walks the real ask
 * ladder, a user market sell walks the real bid ladder, and a user limit order
 * fills only when the real book reaches it.
 *
 * The ladder is refreshed synchronously at the top of matchingcall(), i.e.
 * immediately before the matcher reads the hashes, so the liquidity that can be
 * matched against is always <1ms old by construction rather than by discipline.
 */

// import controller
import { hset, hdel, hgetall, hget } from "./redis.controller.js";
// import lib
import { resolveDepthSnapshot } from "../lib/depthSource.js";
import { assessDepthHealth, LADDER_STALE_MS } from "../lib/depthHealth.js";
import { toFixedDown } from "../lib/roundOf.js";

const LEVELS = 12; // synthetic price levels per side
// The depth circuit breakers (stale / empty side / crossed / price deviation)
// used to live here as an inline if-else chain. They now live in
// lib/depthHealth.js and are shared verbatim with the display publish, because
// two copies of "is this depth usable" is exactly how the UI ended up showing a
// full 20-level book for a pair whose ladder had been purged.
const MIN_NOTIONAL = Number(process.env.PAPER_BOOK_MIN_NOTIONAL || 25);
const SIZE_MULT = Number(process.env.PAPER_BOOK_SIZE_MULT || 1);
// A ladder that has not been rewritten for this long is ORPHANED: syncPaperBook
// is only ever reached through matchingcall, which only runs for the pairs in
// the matcher's active-pair list, so a pair that is deleted or deactivated
// simply stops being visited and its last ladder would rest forever. 15 cron
// ticks of slack before another pair's cycle sweeps it away.
const ORPHAN_MS = Number(process.env.PAPER_BOOK_ORPHAN_MS || 30000);

// pairId -> string[] of synthetic _ids written on the last cycle
const lastIds = new Map();
// pairId -> timestamp of the last successful ladder write (orphan detection)
const lastSyncAt = new Map();
// pairIds whose ladder is known to be gone, so a pair that is ineligible cycle
// after cycle does not re-scan both open-order hashes every 2 seconds.
const purgedPairs = new Set();

// ---------------------------------------------------------------------------
// LADDER STATE - what the display publish reads.
//
// The health of the DEPTH is only half the answer to "can anything fill right
// now". The other half is whether the ladder built from that depth is actually
// resting in the book: it is also purged when the pair goes ineligible, when
// the admin liquidity account vanishes, when a write throws, and when the
// matcher stops visiting the pair at all. The display has to go empty for
// every one of those, not just for the depth breakers, so every purge and
// every successful write records its verdict here.
// ---------------------------------------------------------------------------

// A ladder nothing has rewritten for this long cannot be trusted as tradable
// liquidity. The threshold is NOT declared here: it lives in lib/depthHealth.js
// next to DEPTH_STALE_MS, because controllers/fillCanary.js needs the same
// number to report against and used to carry its own copy under a second env
// var. See the note on LADDER_STALE_MS there - it is imported at the top of
// this file alongside assessDepthHealth.

// pairId -> { present, reason, at, buy, sell, buyQuantity, ... }
const ladderState = new Map();

/**
 * A ladder that is not there has no capacity. Spelled out as a constant so no
 * purge site can forget a field and leave a stale capacity behind a
 * present:false verdict - the order gate reads these numbers and "0 orders but
 * 3.5 BTC available" is exactly the kind of half-updated assertion this module
 * exists to make impossible.
 */
const NO_CAPACITY = {
  buy: 0,
  sell: 0,
  buyQuantity: 0,
  buyNotional: 0,
  sellQuantity: 0,
  sellNotional: 0,
  // TOP OF THE TRADABLE BOOK, or null when there is no ladder to have one.
  //
  // This is the reference limitOrderPlace crosses an arriving order against to
  // decide whether it takes liquidity or provides it (lib/liquidityRole.js), so
  // it has to be the price the MATCHER will use, not the raw venue depth: the
  // ladder groups levels up to MIN_NOTIONAL and quotes each group at its WORST
  // price, so the ladder's best ask is never better than Binance's and an order
  // judged against the raw feed could be called a taker of a price that is not
  // actually resting here. Null and 0 both mean "nothing to cross", which
  // crossesBook reads as "this order will rest".
  bestBuy: null,
  bestSell: null,
};

/** Best price on one built side: highest bid, lowest ask. PURE. */
export const ladderBestPrice = (orders, side) => {
  let best = null;
  for (const order of orders || []) {
    const price = parseFloat(order && order.price);
    if (!(price > 0)) continue;
    if (best == null) best = price;
    else if (side === "buy" ? price > best : price < best) best = price;
  }
  return best;
};

/**
 * How much one built side can actually absorb, in both units an order can be
 * expressed in: `quantity` is base (what a market SELL delivers) and `notional`
 * is quote (what a market BUY spends). PURE.
 *
 * This is the size half of "can this order fill". getLadderState has always
 * answered "is a ladder resting"; presence alone let a market order twenty
 * times the size of the whole book through, fill what it could, and leave the
 * remainder resting as `price: "market"` with the user's funds debited - the
 * precise state the gate was built to prevent, reached by a different door.
 */
export const ladderCapacity = (orders) => {
  let quantity = 0;
  let notional = 0;
  for (const order of orders || []) {
    const qty = parseFloat(order && order.quantity);
    const price = parseFloat(order && order.price);
    if (!(qty > 0) || !(price > 0)) continue;
    quantity += qty;
    notional += qty * price;
  }
  return { quantity, notional };
};

const recordLadder = (pairId, state) => {
  ladderState.set(String(pairId), { at: Date.now(), ...state });
};

/**
 * Is a synthetic ladder resting in the book for this pair right now?
 *
 * Returns { present, reason, at, buy, sell, buyQuantity, buyNotional,
 * sellQuantity, sellNotional }. `reason` is null when present, and otherwise
 * names the purge that took it out - which is what the published book reports
 * as `healthReason` so an empty display is never unexplained.
 *
 * The four capacity numbers are HOW MUCH is resting, in both units an order can
 * be sized in (base quantity and quote notional), per side. They are zero
 * whenever `present` is false, so a reader can never see size without presence.
 *
 * WHAT THIS IS AND IS NOT
 * ----------------------
 * This is an in-memory ASSERTION about redis, made by the only writer of the
 * ladder, and it is deliberately synchronous: the display publish calls it on
 * the 100ms websocket path and must not turn a depth tick into a redis query.
 * That leaves a window where memory says "present" and redis disagrees. It is
 * closed from three directions rather than papered over:
 *
 *   1. VERIFIED, FOR FREE. controllers/bookPublish.controller.js already
 *      hgetall's both open-order hashes to merge real user orders in. It counts
 *      the paper rows in that same reply and refuses to publish a healthy book
 *      when there are none. So the answer that reaches a user IS redis-backed,
 *      at zero extra I/O.
 *   2. NARROWED AT THE SOURCE. Every purge records "gone" BEFORE it starts
 *      deleting (see purgePaperBook), not after, so the ladder is never claimed
 *      present while it is being torn out of redis. A write records "present"
 *      only AFTER redis has taken every order, and only if there was at least
 *      one to take.
 *   3. BOUNDED. LADDER_STALE_MS expires the assertion outright, so even a
 *      writer that dies mid-cycle cannot leave a permanent lie behind.
 *
 * The residual gap is one publish: a ladder consumed or deleted by something
 * else between the hgetall and the emit. That is sub-millisecond, self-healing
 * on the next tick (the book republishes at least once a second), and cannot
 * produce a FILLABLE claim about liquidity that is gone - the matcher reads the
 * same hashes at match time and simply finds nothing there.
 */
export const getLadderState = (pairId, now = Date.now()) => {
  const state = ladderState.get(String(pairId));
  if (!state) {
    // Nothing has synced this pair yet: at boot the matcher has not run, and a
    // pair with no ladder genuinely has nothing to fill against.
    return {
      present: false,
      reason: "ladder_not_built",
      at: 0,
      ...NO_CAPACITY,
    };
  }
  if (state.present && now - state.at > LADDER_STALE_MS) {
    // Capacity is zeroed along with presence. A ladder that has expired is not
    // liquidity, and leaving its last measured size behind a present:false
    // verdict would let a reader that checks size before presence conclude that
    // 3.5 BTC is available in a book that has stopped existing.
    return { ...state, ...NO_CAPACITY, present: false, reason: "ladder_stale" };
  }
  return state;
};

/**
 * Test seam: forget everything this module remembers between cases. Nothing in
 * the service calls it - the process-level equivalent is a restart, which the
 * boot purge in server.js already handles.
 */
export const __resetPaperBookState = () => {
  lastIds.clear();
  lastSyncAt.clear();
  purgedPairs.clear();
  ladderState.clear();
};

// * Create ObjectId (mirrors spot.controller.js)
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
 * Build the synthetic order ladder for one side. PURE: depth in, orders out.
 * `levels` must already be sorted best-first ({ price, quantity }).
 */
export const buildPaperOrders = (
  pairData,
  levels,
  side,
  adminLiq,
  now = Date.now()
) => {
  const orders = [];
  if (!pairData || !adminLiq || !Array.isArray(levels) || levels.length == 0) {
    return orders;
  }

  let groupQty = 0,
    groupNotional = 0,
    groupPrice = 0;

  for (let i = 0; i < levels.length && orders.length < LEVELS; i++) {
    const price = parseFloat(levels[i].price);
    const quantity = parseFloat(levels[i].quantity);
    if (!(price > 0) || !(quantity > 0)) {
      continue;
    }
    groupQty += quantity;
    groupNotional += price * quantity;
    // Worst price of the group (highest for asks, lowest for bids) so the
    // ladder never quotes better than the real book. Levels are best-first, so
    // the worst price is always the last one merged in.
    groupPrice = price;

    if (groupNotional < MIN_NOTIONAL) {
      continue;
    }

    const qty = toFixedDown(groupQty * SIZE_MULT, pairData.firstFloatDigit);
    groupQty = 0;
    groupNotional = 0;
    if (!(qty > 0)) {
      continue;
    }

    orders.push({
      _id: createobjectId(),
      // MANDATORY: marketMatching resolves isMaker by comparing the admin
      // liquidation id against the buy side, so the synthetic must own it for
      // both directions to price off the book side.
      userId: adminLiq._id,
      userCode: adminLiq.userId,
      orderCode: 0, // assigned lazily by newOrderHistory if it ever trades
      pairId: String(pairData._id),
      firstCurrencyId: pairData.firstCurrencyId,
      firstCurrency: pairData.firstCurrencySymbol,
      firstFloatDigit: pairData.firstFloatDigit,
      secondCurrencyId: pairData.secondCurrencyId,
      secondCurrency: pairData.secondCurrencySymbol,
      secondFloatDigit: pairData.secondFloatDigit,
      pairName: `${pairData.firstCurrencySymbol}${pairData.secondCurrencySymbol}`,
      orderType: "limit",
      buyorsell: side,
      price: groupPrice,
      quantity: qty,
      openQuantity: qty,
      amount: qty,
      filledQuantity: 0,
      // averagePrice is a CUMULATIVE FILLED NOTIONAL, not a price (see the
      // invariant note on limitOrderPlace in spot.controller.js). Seeding it
      // with the level price would make the matcher accumulate on top of a
      // number that was never a fill.
      averagePrice: 0,
      orderValue: groupPrice * qty,
      openOrderValue: groupPrice * qty,
      liquidityType: "off", // every match branch is gated on this
      flag: false, // "limit" marker
      isLiquidity: false,
      isLiquidityError: false,
      isMaker: true,
      status: "open",
      // Backdated as belt-and-braces for the price-time isMaker comparison;
      // the explicit isPaper check in tradeMatching is what actually decides.
      orderDate: new Date(now - 60000),
      isPaper: true,
    });
  }

  return orders;
};

/**
 * Remove every synthetic order of a pair from both open-order hashes.
 * NEVER route this through cancelOrder/cancelMarketOrder: those credit
 * walletbalance_spot and the synthetic was never debited.
 */
export const purgePaperBook = async (pairId, reason = "purged") => {
  const pid = String(pairId);
  // Recorded BEFORE the first hdel, not after the last one. Deleting a ladder
  // is not atomic - it is two hgetalls and N hdels - and for the whole of that
  // window the display was still being told the ladder was present. Recording
  // first means the claim can only ever be pessimistic: "gone" while some rows
  // still exist is harmless (they are on their way out), "present" while they
  // are being deleted is the exact lie this module exists to prevent.
  recordLadder(pid, { present: false, reason, ...NO_CAPACITY });
  try {
    for (const side of ["buy", "sell"]) {
      const key = `${side}OpenOrders_${pid}`;
      const all = await hgetall(key);
      if (!all) continue;
      for (const field of Object.keys(all)) {
        let order;
        try {
          order = JSON.parse(all[field]);
        } catch (e) {
          continue;
        }
        if (order && order.isPaper === true) {
          await hdel(key, field);
        }
      }
    }
    lastIds.delete(pid);
    lastSyncAt.delete(pid);
    purgedPairs.add(pid);
    // Re-stamped on success so `at` reflects the completed purge; the display
    // reads this and must publish an EMPTY book, not the stale-but-pretty depth
    // that used to keep rendering right through it.
    recordLadder(pid, { present: false, reason, ...NO_CAPACITY });
    return true;
  } catch (err) {
    // Deliberately NOT marked as purged: a failed purge leaves liquidity in the
    // book, so the next cycle has to try again. The ladder state stays at the
    // "gone" recorded above - a half-deleted ladder is not something the
    // display may claim is tradable.
    console.log("err on purgePaperBook---", err);
    return false;
  }
};

/**
 * Purge, unless this pair's ladder is already known to be gone. The gate is a
 * cost guard only (purgePaperBook reads both open-order hashes in full); every
 * caller below still has purge as its outcome.
 */
const dropLadder = async (pairId, reason) => {
  const pid = String(pairId);
  if (purgedPairs.has(pid) && !lastIds.has(pid)) {
    // Already gone - but the display still has to be told WHY on every cycle,
    // otherwise a pair that goes ineligible after being purged for stale depth
    // keeps reporting the wrong reason forever.
    recordLadder(pid, { present: false, reason, ...NO_CAPACITY });
    return false;
  }
  const purged = await purgePaperBook(pid, reason);
  if (purged) {
    console.log(`paperBook: purged synthetic ladder for ${pid} (${reason})`);
  }
  return purged;
};

/**
 * Is this pair allowed to carry a synthetic ladder at all?
 *
 * Eligibility is a property of the PAIR (mirroring live Binance depth is only
 * meaningful for a pair that is actually configured to track Binance and is
 * actually tradable); the depth circuit breakers below are separate and are
 * about the quality of the feed. `status` is only read when the caller supplied
 * it, so a projected/partial pair document is never mistaken for a deactivated
 * one.
 */
export const isPaperEligible = (pairData) =>
  !!pairData &&
  pairData.botstatus === "binance" &&
  (pairData.status == null || pairData.status === "active");

/**
 * Purge the ladders of pairs that nothing is refreshing any more.
 *
 * syncPaperBook only ever runs for pairs the matching cron still visits, so a
 * pair that is DELETED, deactivated, or otherwise dropped from that list can
 * never purge itself - it just stops being called. Every surviving pair's cycle
 * therefore sweeps the others: a ladder older than ORPHAN_MS belongs to a pair
 * the engine has stopped matching and must not be left resting in the book.
 * (The boot-time purge in server.js is the backstop for the case where every
 * pair stops at once, i.e. a restart.)
 */
export const sweepOrphanLadders = async (skipPairId = null, now = Date.now()) => {
  const swept = [];
  for (const [pairId, syncedAt] of Array.from(lastSyncAt.entries())) {
    if (skipPairId != null && pairId === String(skipPairId)) continue;
    if (now - syncedAt <= ORPHAN_MS) continue;
    if (await purgePaperBook(pairId, "ladder_orphaned")) {
      console.log(
        `paperBook: purged orphaned synthetic ladder for ${pairId} (no refresh for ${now - syncedAt}ms)`
      );
      swept.push(pairId);
    }
  }
  return swept;
};

/**
 * Refresh the synthetic ladder for a pair from live Binance depth.
 * Returns { ok, reason }.
 *
 * PURGE-VS-LEAVE, the whole policy in one place. The ladder is admin-owned
 * liquidity that was never debited from any wallet, so a stale one is not
 * "slightly wrong prices", it is free money for whoever hits it. Every exit
 * from this function other than a successful write therefore purges:
 *
 *   pair ineligible (botstatus flipped away from "binance", pair deactivated,
 *     pair deleted)          -> PURGE. An ordinary admin action must not strand
 *                               24 fillable orders in the book.
 *   no depth / stale depth / empty side / crossed book / price deviation
 *                            -> PURGE (unchanged: quoting a dead price is worse
 *                               than quoting nothing).
 *   admin liquidity account missing
 *                            -> PURGE. The ladder cannot be rebuilt, and the
 *                               existing one is exactly the frozen book the
 *                               depth breakers exist to prevent.
 *   unexpected error         -> PURGE, best effort. The write is not atomic, so
 *                               a throw can leave a half-replaced ladder; if
 *                               redis itself is what failed the purge fails too
 *                               and the next cycle (or the boot purge) retries.
 *   pair no longer visited at all
 *                            -> PURGE, by sweepOrphanLadders below.
 */
export const syncPaperBook = async (pairData) => {
  const pairId =
    pairData && pairData._id != null ? String(pairData._id) : null;
  try {
    // Other pairs first: this is the only place that can notice a pair the
    // matcher has stopped visiting entirely.
    await sweepOrphanLadders(pairId);

    if (!isPaperEligible(pairData)) {
      if (pairId) {
        await dropLadder(pairId, "pair_ineligible");
      }
      if (!pairData) {
        return { ok: false, reason: "no_pair" };
      }
      return {
        ok: false,
        reason:
          pairData.botstatus !== "binance" ? "not_binance" : "pair_inactive",
      };
    }

    const book = await resolveDepthSnapshot(pairId);

    // Circuit breakers. A frozen ladder quoting dead prices is the worst
    // possible outcome, so anything suspicious purges and quotes nothing.
    // THE SAME CALL the display publish makes, on the SAME snapshot: there is
    // no second verdict that can disagree with this one.
    const health = assessDepthHealth(book, pairData);
    if (!health.healthy) {
      await dropLadder(pairId, health.reason);
      return { ok: false, reason: health.reason };
    }

    let adminLiq = await hget("admin_liquidity", "liquidation");
    adminLiq = adminLiq ? JSON.parse(adminLiq) : null;
    if (!adminLiq || !adminLiq._id) {
      console.log(
        "paperBook: admin_liquidity/liquidation missing - orders cannot fill"
      );
      await dropLadder(pairId, "no_admin_liquidity");
      return { ok: false, reason: "no_admin_liquidity" };
    }

    const now = Date.now();
    const buyOrders = buildPaperOrders(pairData, book.bids, "buy", adminLiq, now);
    const sellOrders = buildPaperOrders(pairData, book.asks, "sell", adminLiq, now);
    const newIds = [];
    for (const order of buyOrders.concat(sellOrders)) {
      order.bookUpdateId = book.lastUpdateId;
      newIds.push(order._id);
    }

    // Replace, never merge. A half-filled synthetic order means nothing once
    // the feed has moved on, so there is no right answer to "what should it
    // become" - rebuild instead of patching.
    const previous = lastIds.get(pairId) || [];
    for (const id of previous) {
      await hdel(`buyOpenOrders_${pairId}`, id);
      await hdel(`sellOpenOrders_${pairId}`, id);
    }
    // Sweep anything left behind by a crash or a concurrent cycle. Real user
    // orders are only ever read here, never deleted.
    const keep = new Set(newIds);
    for (const side of ["buy", "sell"]) {
      const key = `${side}OpenOrders_${pairId}`;
      const all = await hgetall(key);
      if (!all) continue;
      for (const field of Object.keys(all)) {
        let order;
        try {
          order = JSON.parse(all[field]);
        } catch (e) {
          continue;
        }
        if (order && order.isPaper === true && !keep.has(order._id)) {
          await hdel(key, field);
        }
      }
    }

    for (const order of buyOrders) {
      await hset(`buyOpenOrders_${pairId}`, order._id, order);
    }
    for (const order of sellOrders) {
      await hset(`sellOpenOrders_${pairId}`, order._id, order);
    }
    lastIds.set(pairId, newIds);
    lastSyncAt.set(pairId, Date.now());
    purgedPairs.delete(pairId);
    const buyCapacity = ladderCapacity(buyOrders);
    const sellCapacity = ladderCapacity(sellOrders);
    recordLadder(pairId, {
      // A cycle can succeed and still write NOTHING: buildPaperOrders emits no
      // order until a level group clears MIN_NOTIONAL, so dust-thin depth
      // produces an empty ladder. That used to be recorded as present=true with
      // buy:0/sell:0 - an assertion of liquidity that demonstrably is not
      // there. Presence is what was actually written to redis, not that the
      // function reached its end.
      present: newIds.length > 0,
      reason: newIds.length > 0 ? null : "ladder_not_built",
      buy: buyOrders.length,
      sell: sellOrders.length,
      // WHAT WAS ACTUALLY WRITTEN, in the two units an order can be sized in.
      // Measured from the orders redis has just taken, not from the depth they
      // were derived from: MIN_NOTIONAL grouping and the LEVELS cap both throw
      // depth away, so "how deep is Binance" over-states "how much can fill
      // here" - and over-stating is the direction that lets an oversized market
      // order through.
      buyQuantity: buyCapacity.quantity,
      buyNotional: buyCapacity.notional,
      sellQuantity: sellCapacity.quantity,
      sellNotional: sellCapacity.notional,
      // Top of the ladder that was actually written - see NO_CAPACITY.
      bestBuy: ladderBestPrice(buyOrders, "buy"),
      bestSell: ladderBestPrice(sellOrders, "sell"),
      // The exact venue update the tradable ladder was derived from. The
      // published book carries the same field, so "display and ladder agree"
      // is checkable rather than a claim.
      bookUpdateId: book.lastUpdateId,
    });

    return { ok: true, buy: buyOrders.length, sell: sellOrders.length };
  } catch (err) {
    console.log("err on syncPaperBook---", err);
    if (pairId) {
      // Recorded BEFORE the purge is attempted: if redis is what failed, the
      // purge fails too, and the one thing that must not happen is the display
      // going on claiming a healthy ladder it cannot verify.
      recordLadder(pairId, { present: false, reason: "error", ...NO_CAPACITY });
      // Best effort: see the purge-vs-leave note above. A torn ladder is still
      // fillable liquidity, so it must not survive the failure that made it.
      try {
        await purgePaperBook(pairId, "error");
      } catch (purgeErr) {
        console.log("err on syncPaperBook purge---", purgeErr);
      }
    }
    return { ok: false, reason: "error" };
  }
};
