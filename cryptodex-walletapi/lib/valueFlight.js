/**
 * THE VALUE-FLIGHT REGISTRY - THIS SERVICE'S HALF.
 * ===============================================
 *
 * spotapi's lib/valueFlight.js is the authority: it has the measurement (an
 * account taken from 10,000 to 48,039.52 through the ordinary API by racing
 * `faucet/reset` against order placement), the reader/writer argument, and the
 * reason a reservation counter could not have answered the question.
 *
 * WHY walletapi IS ONE OF THE READERS
 * -----------------------------------
 * The reset writes ABSOLUTE balances: it SETS each faucet coin's
 * `walletbalance_spot`. The value-moving routes here - `/coinWithdraw`,
 * `/fiatWithdraw`, `/createAddress` and the admin adjustment - each move value
 * in several separate redis commands. Interleave one with a reset and the
 * account keeps both halves:
 *
 *     a handler debits spot       -> reset SETS spot to 10,000
 *                                 -> the handler's own credit lands
 *     ...account now holds the whole grant AND the moved amount.
 *
 * That is the same mint as the order-placement one, through a different door,
 * and enumerating the doors is the whole point - a freeze honoured by some of
 * the value-moving paths is the same bug with a smaller window.
 *
 * The key name, the TTL and the protocol are IDENTICAL to spotapi's on purpose;
 * they address the same redis hash and the same freeze key.
 */

import { randomUUID } from 'crypto';
import { beginFlight, hdel, hgetall } from '../controllers/redis.controller.js';

/** Must match spotapi's lib/valueFlight.js. */
export const VALUE_FLIGHT_TTL_MS = 30000;
export const valueFlightKey = (userId) => `value_flight_${userId?.toString()}`;
/** Must match every service's lib/marginFreeze.js. */
export const marginFreezeKey = (userId) => `margin_freeze_${userId?.toString()}`;
export const FROZEN = 'FROZEN';

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

export const endValueFlight = async (userId, token) => {
  if (!token) return;
  await hdel(valueFlightKey(userId), token);
};

/** Present for symmetry with spotapi; this service reads nobody's registry. */
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
  marginFreezeKey,
  FROZEN,
  beginValueFlight,
  endValueFlight,
  readLiveValueFlights
};
