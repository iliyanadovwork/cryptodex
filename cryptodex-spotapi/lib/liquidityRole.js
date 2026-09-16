/**
 * MAKER OR TAKER ON SPOT - THE ONE PLACE THAT DECIDES IT.
 * ======================================================
 *
 * WHAT WENT WRONG BEFORE
 * ----------------------
 * `maker_rebate` is configured on every spot pair (0.02% against a 0.1%
 * `taker_fees` on the seeded pairs) and it was, in practice, unreachable. The
 * matcher's limit branch decided the maker like this:
 *
 *     if (current_buy.isPaper || current_sell.isPaper)
 *       isMaker = current_buy.isPaper ? "buy" : "sell";
 *     else
 *       isMaker = current_buy.orderDate < current_sell.orderDate ? "buy" : "sell";
 *
 * The synthetic paper ladder is the counterparty of EVERY fill on a "binance"
 * pair - which is every live pair - so the first branch always fired and the
 * ladder always claimed the maker side. A user who rested a limit order two
 * cents below the bid, waited for the market to come to them and provided the
 * liquidity that fill consumed was billed `taker_fees`. Measured on the running
 * stack before this change: a passive 0.0002 BTC buy settled at
 * 0.0001998 BTC == quantity - 0.1%, i.e. the taker rate, on an order that had
 * rested for two seconds and had been hit rather than hitting anything.
 *
 * The price-time fallback could not have saved it either: buildPaperOrders
 * stamps every synthetic row `orderDate: now - 60000`, so the ladder wins an
 * `orderDate` comparison against any real order by a minute, by construction.
 *
 * HOW THE ROLE IS DECIDED NOW
 * ---------------------------
 * The maker is the party that was RESTING when the aggressor arrived. That is a
 * fact about ARRIVAL, and arrival is the only moment at which it can be
 * observed honestly - by match time the quote has moved, the ladder has been
 * rebuilt from scratch (every 2s, with fresh `_id`s and a backdated
 * `orderDate`), and there is nothing left to read it off. So the role is
 * decided ONCE, when the order is accepted, and stamped on the order:
 *
 *   - a MARKET order carries no price of its own and demands immediate
 *     execution. It never rests. TAKER, always.
 *
 *   - a LIMIT order that is already through the far side of the book when it
 *     arrives (`buy: price >= bestAsk` / `sell: price <= bestBid`) took the
 *     liquidity that was resting there. TAKER.
 *
 *   - a LIMIT order that does NOT cross rests in
 *     `{buy|sell}OpenOrders_<pairId>` and can only be filled later, when the
 *     book comes to IT. It provided the liquidity. MAKER - and the synthetic
 *     ladder that eventually crosses it is the taker of that fill.
 *
 * This rule is what makes "the ladder is not automatically the maker"
 * true: the ladder's role is simply the COMPLEMENT of the user's, because the
 * ladder is not an independent trader with an arrival time of its own. It is a
 * mirror of resting depth that is re-derived wholesale every tick.
 *
 * WHAT THE ROLE ALSO DECIDES
 * --------------------------
 * The execution price, which the matcher has always taken from the maker's
 * order, and which is now correct for the same reason the fee is: a fill prints
 * at the RESTING order's price. A user who rests a bid at 63,000 and is hit by
 * an ask that crosses down through it buys at 63,000 - their own limit price,
 * never worse than it - rather than at the aggressor's. Aggressive user orders
 * are unaffected: they are takers, the ladder is the maker, and they execute at
 * the book price exactly as they did before.
 *
 * WHY THE FALLBACK IS THE TAKER RATE
 * ----------------------------------
 * Orders written before this field existed, and any path that forgets to stamp
 * it, resolve to TAKER. That is the rate this service has always charged, so an
 * unstamped order settles exactly as it does today; and if the two rates are
 * ever misconfigured, defaulting to the HIGHER of the two published rates fails
 * in the direction that does not silently hand money away. A `maker_rebate`
 * that is missing, non-numeric or negative falls back the same way - treating
 * it as 0 would make every resting order free.
 */

export const MAKER = "maker";
export const TAKER = "taker";

/** Opposite side name. "buy" <-> "sell". */
export const otherSide = (side) => (side === "buy" ? "sell" : "buy");

/**
 * Does this order cross the far side of the book as it arrives?
 *
 * PURE. `bestAsk` / `bestBid` are the best resting prices on the far side at
 * the moment of acceptance; a side with nothing resting cannot be crossed, so a
 * null/NaN/non-positive reference answers false ("it will rest"). That is the
 * safe direction for the PRICE - an order that rests is priced at its own limit
 * - and the role it produces (MAKER) is only ever reached when there was
 * genuinely nothing to take.
 */
export const crossesBook = ({ buyorsell, price, bestBid, bestAsk }) => {
  const p = parseFloat(price);
  if (!Number.isFinite(p)) return false;
  if (buyorsell === "buy") {
    const ask = parseFloat(bestAsk);
    return Number.isFinite(ask) && ask > 0 && p >= ask;
  }
  const bid = parseFloat(bestBid);
  return Number.isFinite(bid) && bid > 0 && p <= bid;
};

/**
 * The role to stamp on an order that is being accepted.
 *
 * `crosses` is the caller's own crossing test, so the role and the price the
 * order is accepted at can never disagree.
 */
export const roleForNewOrder = ({ orderType, crosses }) => {
  if (String(orderType) === "market") return TAKER;
  return crosses ? TAKER : MAKER;
};

/** The role recorded on an order, defaulting to TAKER. */
export const roleOf = (order) => {
  const role = order && order.liquidityRole;
  return role === MAKER ? MAKER : TAKER;
};

/**
 * Is this order a market order? Checked three ways because the matcher mutates
 * `price` before it settles: tradeMatching stamps a market order with the
 * limit price it is about to trade against, so by the time marketMatching sees
 * it, `price === "market"` is no longer true. `flag` is the marker
 * marketOrderPlace sets and nothing overwrites.
 */
export const isMarketOrder = (order) =>
  !!order &&
  (order.flag === true ||
    order.price === "market" ||
    String(order.orderType) === "market");

/**
 * Is this order the SYNTHETIC counterparty rather than a real account?
 *
 * Two kinds, both of them house liquidity that was never debited from any
 * wallet when it was written into the book:
 *   - `isPaper` rows, the Binance-depth ladder built by paperBook.controller.js
 *   - orders owned by the admin liquidation account, which liqOrdCreation
 *     clones onto "off"/"bot" pairs
 *
 * `adminLiqId` is optional so the predicate still answers for the ladder when
 * the caller has not resolved the admin account.
 */
export const isSyntheticOrder = (order, adminLiqId) => {
  if (!order) return false;
  if (order.isPaper === true) return true;
  if (adminLiqId == null || order.userId == null) return false;
  return String(order.userId) === String(adminLiqId);
};

/** orderDate as a comparable number; unparseable dates sort last. */
const arrivedAt = (order) => {
  const raw = order && order.orderDate;
  if (raw == null) return Number.POSITIVE_INFINITY;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(raw);
  if (Number.isFinite(ms)) return ms;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
};

/** Price-time priority: the order that arrived first provided the liquidity. */
const priceTimeMaker = (buyOrder, sellOrder) =>
  arrivedAt(buyOrder) < arrivedAt(sellOrder) ? "buy" : "sell";

/**
 * WHICH SIDE OF THIS FILL IS THE MAKER - "buy" or "sell".
 *
 * Returns the same "buy"/"sell" string the matcher's `isMaker` variable has
 * always carried, so it is a drop-in for both of its consumers (the fee rate
 * per side and the execution price).
 *
 * The order of the tests is the order of certainty:
 *
 *  1. A MARKET order did not rest, so it cannot be the maker. This also fixes a
 *     second, quieter defect: marketMatching decided the maker by asking
 *     whether the BUYER was the admin account, which named the market order as
 *     the maker whenever a real user's market SELL met another real user's
 *     resting limit BUY - charging the resting user the taker rate and the
 *     aggressor the maker rate, exactly backwards.
 *  2. Exactly one side is SYNTHETIC. The real order's stamped role decides, and
 *     the synthetic takes the complement - see the module note.
 *  3. Everything else (user vs user, or the degenerate synthetic-vs-synthetic)
 *     falls back to price-time priority, which is what the matcher already did
 *     for user-vs-user fills and is unchanged.
 */
export const makerSideOf = (buyOrder, sellOrder, adminLiqId) => {
  const buyIsMarket = isMarketOrder(buyOrder);
  const sellIsMarket = isMarketOrder(sellOrder);
  if (buyIsMarket !== sellIsMarket) {
    return buyIsMarket ? "sell" : "buy";
  }
  if (!buyIsMarket) {
    const buyIsSynthetic = isSyntheticOrder(buyOrder, adminLiqId);
    const sellIsSynthetic = isSyntheticOrder(sellOrder, adminLiqId);
    if (buyIsSynthetic !== sellIsSynthetic) {
      const userSide = buyIsSynthetic ? "sell" : "buy";
      const userOrder = buyIsSynthetic ? sellOrder : buyOrder;
      return roleOf(userOrder) === MAKER ? userSide : otherSide(userSide);
    }
  }
  return priceTimeMaker(buyOrder, sellOrder);
};

// NO FEE FUNCTIONS LIVE HERE ANY MORE.
//
// feeRateFor() and feeForSide() were deleted along with every charge on this
// venue. They had already been reduced to a hard `return 0`, but a zero-rate
// function still reads as a fee schedule that happens to be switched off, and
// every settlement path still carried the arithmetic to apply it. Both matchers
// now credit the gross amount and no trade row records a fee at all.
//
// If a fee is ever wanted again it must be REBUILT deliberately, on both legs of
// both matchers at once. Do not reintroduce a rate function and assume the
// call sites are still there; they are not.

export default {
  MAKER,
  TAKER,
  otherSide,
  crossesBook,
  roleForNewOrder,
  roleOf,
  isMarketOrder,
  isSyntheticOrder,
  makerSideOf,
};
