/**
 * WHAT THIS USER STILL HAS RESTING IN THE SPOT BOOKS - READ FROM THE BOOKS.
 * =========================================================================
 *
 * WHY NOT MONGO
 * -------------
 * `faucet.resetFaucet` used to decide "does this account have open spot
 * orders?" with `OrderHistory.find({ status: open|pending })`. That question can
 * never be true at the moment it matters, for two independent reasons:
 *
 *   1. RESERVE BEFORE PUBLISH. `limitOrderPlace` debits `walletbalance_spot`
 *      first and writes the order afterwards, so an order in flight has taken
 *      the money and has no document yet.
 *   2. THE MONGO WRITE IS NOT EVEN AWAITED. `newOrderHistory` calls
 *      `findOneAndUpdate(...).exec().then(...)` without returning the promise,
 *      so `await newOrderHistory(order)` resolves before the row exists. Mongo
 *      lags the books by an unbounded amount by construction.
 *
 * The REDIS open-order hashes are the store the order path awaits
 * (`await hset(<side>OpenOrders_<pairId>, ...)`) before it answers the user, so
 * they are the only store in which "this order exists" is settled by the time
 * the request is over. Paired with the value-flight registry - which tells the
 * reset that no request is between its debit and that hset - they answer the
 * question completely.
 *
 * WHAT COUNTS AS A BLOCKER
 * ------------------------
 * Every row in either side of every pair's book that belongs to this user and
 * is NOT synthetic paper liquidity. Both order kinds hold money:
 *
 *   - a LIMIT order's reservation sits in `walletbalance_spot_inOrder` and is
 *     refunded to `walletbalance_spot` when it is cancelled;
 *   - a MARKET order's debit sits nowhere but in the balance, and it is still
 *     resting because the matcher has not consumed it yet.
 *
 * Either one, left alone while the reset writes an absolute balance, is a
 * credit that lands on top of the fresh grant.
 *
 * `isPaper` rows are the house ladder (paperBook.controller.js). They are not
 * this user's and they are replaced wholesale every matching cycle.
 *
 * IT FAILS CLOSED, WHICH IS THE OPPOSITE OF HOW THE DUST SWEEP FAILS
 * ------------------------------------------------------------------
 * `spot.controller.sweepResidualInOrder` walks the same hashes and, when the
 * pair cache cannot be read, does NOTHING - because its action is to release a
 * reservation and an unproven release is a give-away. This walk's caller is
 * about to OVERWRITE balances, so an unproven answer here has to refuse
 * instead: `SpotBookUnreadable` is thrown and the reset declines. Same data,
 * opposite safe direction, which is why the two walks are deliberately not
 * shared.
 */

import { hgetall } from '../controllers/redis.controller.js';

/** Thrown when the books cannot be enumerated, so "no orders" cannot be said. */
export class SpotBookUnreadable extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpotBookUnreadable';
  }
}

const parseRow = (raw) => {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
};

/**
 * Every non-synthetic order of `userId` still resting in a spot book.
 *
 * Shaped as `productLabel` + `pairName`, which is what the frontend's existing
 * lib/resetBlockers.describeResetRefusal consumes to render "Cancel your 2
 * resting orders - Spot BTCUSD" with no new client-side case.
 */
export const listRestingSpotOrders = async (userId) => {
  let pairCache;
  try {
    pairCache = await hgetall('spotPairdata');
  } catch (err) {
    throw new SpotBookUnreadable(
      `spot pair cache could not be read: ${err && err.message}`
    );
  }

  const pairs = Object.values(pairCache || {}).map(parseRow).filter(Boolean);
  // No pair cache means no way to prove the account is clear, and an unproven
  // "clear" is what lets the reset overwrite a funded order.
  if (pairs.length === 0) {
    throw new SpotBookUnreadable('spot pair cache is empty');
  }

  const resting = [];
  for (const pair of pairs) {
    for (const side of ['buy', 'sell']) {
      let rows;
      try {
        rows = await hgetall(`${side}OpenOrders_${pair._id}`);
      } catch (err) {
        throw new SpotBookUnreadable(
          `${side} book for pair ${pair._id} could not be read: ${err && err.message}`
        );
      }
      for (const raw of Object.values(rows || {})) {
        const row = parseRow(raw);
        if (!row) continue;
        if (row.isPaper === true) continue;
        if (String(row.userId) !== String(userId)) continue;
        resting.push({
          productLabel: 'Spot',
          pairName: row.pairName || String(pair.pairName || pair._id),
          orderId: String(row._id),
          buyorsell: row.buyorsell,
          orderType: row.orderType
        });
      }
    }
  }

  return resting;
};

export default { listRestingSpotOrders, SpotBookUnreadable };
