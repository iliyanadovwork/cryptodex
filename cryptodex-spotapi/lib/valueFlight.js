/**
 * THE VALUE-FLIGHT REGISTRY - "IS ANY REQUEST OF THIS USER'S MID-MOVE?"
 * =====================================================================
 *
 * THE BUG THIS EXISTS TO KILL
 * ---------------------------
 * `POST /api/spot/faucet/reset` restores a known TOTAL by writing ABSOLUTE
 * balances: it zeroes every non-faucet ledger and SETS each faucet coin's spot
 * balance to FAUCET_AMOUNT. An absolute write is only correct if it is the last
 * word - if anything else moves the same account's money after the reset has
 * read its state, the two writes compose into a number neither of them meant,
 * and on a venue whose entire product is a scoreboard that number is minted
 * demo money.
 *
 * MEASURED, through the ordinary API, no admin access: an account taken from
 * 10,000 to 48,039.52 in four consecutive wins by racing `faucet/reset` against
 * spot limit-order placement. 12 of 32 races broke. The mechanism, exactly:
 *
 *     t0  orderPlace debits walletbalance_spot by the order value (redis)
 *     t1  reset asks MONGO "does this user have open orders?"  -> no
 *     t2  reset sets walletbalance_spot = 10,000
 *     t3  orderPlace writes the order into the book and into mongo
 *     t4  the user cancels the order; the reservation is refunded on top
 *
 * WHY THE OLD GATE COULD NOT HAVE WORKED
 * --------------------------------------
 * The reset asked mongo. Every engine in this product RESERVES BEFORE IT
 * PUBLISHES - the ledger moves first and the document that would justify it is
 * written last (`limitOrderPlace` debits redis, then `newOrderHistory`, whose
 * mongo write is itself fired without awaiting its promise). A question asked
 * of the documents is therefore structurally blind to an order in flight, and
 * no amount of care in phrasing it helps.
 *
 * An earlier round fixed exactly this shape elsewhere with a per-user margin
 * freeze (lib/marginFreeze.js) checked by an `EXISTS` inside the one Lua step
 * that takes a reservation. It did not cover spot: spot's reservation
 * (`hincrbyfloatIfEnough`) had no freeze key at all, and `marginFreezeKey`
 * appeared in this service only in the reset that takes it. A freeze honoured
 * on some reservation paths and not others is the same bug with a smaller
 * window.
 *
 * WHY A COUNTER OF RESERVATIONS IS NOT ENOUGH FOR SPOT
 * ----------------------------------------------------
 * A reset CAN safely read a `*_locked` counter when that counter is
 * incremented BY the same Lua command that decides affordability - it moves
 * first, so it is true at the moment it matters. Spot has no such counter:
 *
 *   - the limit path credits `walletbalance_spot_inOrder` in a SEPARATE command
 *     after the debit, so there is a window in which the money is gone and the
 *     counter still reads zero;
 *   - the market path never credits it at all, by design (see THE IN-ORDER
 *     LEDGER INVARIANT in spot.controller.js) - a market order's debit is
 *     recorded nowhere but in the balance itself.
 *
 * So the thing that has to be excluded is not one command. It is the whole
 * stretch between "this request took the money" and "this request has published
 * the obligation the money is standing behind", which is exactly a critical
 * section - and the reset is the writer that must not interleave with it.
 *
 * WHAT THIS IS
 * ------------
 * A per-user reader/writer exclusion, expressed in redis:
 *
 *   READERS  every value-moving spot request. On the way in it registers
 *            itself in the hash `value_flight_<userId>` - refused outright if
 *            the margin freeze is already held - and it deregisters when its
 *            response has been flushed, by which time everything it was going
 *            to write is written.
 *   WRITER   `faucet.resetFaucet`. It takes the margin freeze, and only then
 *            asks whether any flight is registered.
 *
 * Redis serialises the freeze against the registration, so there are exactly
 * two orderings and both are safe:
 *
 *   registration lands first -> the reset sees the flight and REFUSES, having
 *                               changed nothing
 *   freeze lands first       -> the registration answers FROZEN and the request
 *                               is refused BEFORE it reads a balance, so there
 *                               is nothing to unwind
 *
 * That is what makes the reset's remaining questions - "is anything resting in
 * the books", "is any margin reserved" - true at the moment they are asked
 * rather than eventually true. Nothing is in flight, so every obligation this
 * account has is already published where those questions can see it.
 *
 * THE SPOT RESERVATION ALSO CHECKS THE FREEZE DIRECTLY
 * ----------------------------------------------------
 * `hincrbyfloatIfEnough` gained the same `EXISTS` the two engines' reservation
 * scripts have. That is deliberately redundant with this registry: the registry
 * is what makes the reset's ENUMERATION true, and the freeze check on the
 * command is what guarantees that a reservation cannot be created under a
 * freeze even by a call site that forgot to register a flight. One of them is
 * about the question, the other about the write; a future caller that skips the
 * middleware is refused by the second.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not rate limiting and it is not anti-abuse. It refuses nothing that a
 * reset is not actively running against at that instant, it has no memory, and
 * it costs an unraced request one field in one hash.
 *
 * FAILURE IS CLOSED. If redis cannot be reached the registration throws, and
 * the guard refuses the request (503) rather than letting it move money
 * unregistered - the same direction `claimOnce` fails in for the reset itself.
 */

import { randomUUID } from 'crypto';
import { beginFlight, hdel, hgetall } from '../controllers/redis.controller.js';
import { marginFreezeKey } from './marginFreeze.js';

/**
 * How long a registration counts for if its request never finishes.
 *
 * Long enough that no ordinary value-moving request can outlive it (the slowest
 * of them is an order placement, a handful of redis writes and one gRPC call),
 * short enough that a request killed mid-flight cannot refuse the user's resets
 * for meaningfully longer than the request itself would have taken. The guard
 * deregisters on response flush; this is only the backstop.
 */
export const VALUE_FLIGHT_TTL_MS = 30000;

/** The one key name. */
export const valueFlightKey = (userId) => `value_flight_${userId?.toString()}`;

/** What `beginValueFlight` reports when the account is frozen for a reset. */
export const FROZEN = 'FROZEN';

/**
 * Register this request as in flight for `userId`.
 *
 * Returns `{ frozen: true }` when a reset holds the freeze - the caller must
 * refuse without touching a balance - or `{ frozen: false, token }`, and the
 * token must be handed back to `endValueFlight` once the request has published
 * everything it is going to publish.
 *
 * Throws when redis cannot be reached. That is the point: an unregistered
 * request must not proceed.
 */
export const beginValueFlight = async (userId) => {
  const token = randomUUID();
  const verdict = await beginFlight(
    valueFlightKey(userId),
    marginFreezeKey(userId),
    token,
    Date.now() + VALUE_FLIGHT_TTL_MS,
    VALUE_FLIGHT_TTL_MS
  );
  if (verdict === FROZEN) return { frozen: true, token: null };
  return { frozen: false, token };
};

/** Deregister one flight. Safe to call twice; safe to call with no token. */
export const endValueFlight = async (userId, token) => {
  if (!token) return;
  await hdel(valueFlightKey(userId), token);
};

/**
 * The flights registered for this user that have not yet passed their deadline.
 *
 * A field whose deadline cannot be PARSED counts as LIVE. "I cannot tell" must
 * never be spelled "nothing is in flight" here: that is the direction that lets
 * the reset overwrite a balance somebody is standing on. Expired fields are
 * left in place rather than deleted - this is a read, the whole hash carries a
 * PEXPIRE that every registration refreshes, and a read that writes is a read
 * that can fail halfway.
 *
 * Throws when redis cannot be reached, for the same reason.
 */
export const readLiveValueFlights = async (userId, now = Date.now()) => {
  const raw = await hgetall(valueFlightKey(userId));
  const live = [];
  for (const [token, deadline] of Object.entries(raw || {})) {
    const at = Number(deadline);
    if (!Number.isFinite(at) || at > now) live.push({ token, deadline: at });
  }
  return live;
};

export default {
  VALUE_FLIGHT_TTL_MS,
  valueFlightKey,
  FROZEN,
  beginValueFlight,
  endValueFlight,
  readLiveValueFlights
};
