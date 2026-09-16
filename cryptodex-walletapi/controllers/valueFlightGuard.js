/**
 * THE ROUTE-LEVEL HALF OF THE VALUE-FLIGHT REGISTRY, ON THIS SERVICE.
 *
 * The argument is in lib/valueFlight.js here and, in full, in spotapi's copy.
 * This module is only the wiring, and it mirrors spotapi's
 * controllers/valueFlightGuard.js line for line - including the one decision
 * worth restating:
 *
 * IT DEREGISTERS ON `finish`, AND DELIBERATELY NOT ON `close`. `close` also
 * fires when the CLIENT hangs up while the handler keeps running, and
 * deregistering there would tell a reset "nothing is in flight" while the money
 * was still moving. An abandoned request keeps its slot until its deadline.
 */

import {
  beginValueFlight,
  endValueFlight,
  VALUE_FLIGHT_TTL_MS
} from '../lib/valueFlight.js';

const refuse = (res, status, body) =>
  res.status(status).json({ status: false, success: false, ...body });

export const trackValueFlight = async (req, res, next) => {
  const userId = req.user && req.user.id;
  if (!userId) return next();

  let flight;
  try {
    flight = await beginValueFlight(userId);
  } catch (err) {
    console.error('[ValueFlight] Could not register a flight:', err && err.message);
    return refuse(res, 503, {
      code: 'FLIGHT_UNAVAILABLE',
      message:
        'This request could not be checked against a demo-account reset, so ' +
        'nothing has been changed. Please try again in a moment.'
    });
  }

  if (flight.frozen) {
    return refuse(res, 409, {
      code: 'RESET_IN_PROGRESS',
      message:
        'A demo-account reset is running on your account right now, so ' +
        'nothing has been changed. Please try again in a moment.'
    });
  }

  let released = false;
  res.on('finish', () => {
    if (released) return;
    released = true;
    endValueFlight(userId, flight.token).catch((err) => {
      console.error(
        '[ValueFlight] Could not deregister a flight; it will expire in',
        VALUE_FLIGHT_TTL_MS,
        'ms:',
        err && err.message
      );
    });
  });

  return next();
};

export default { trackValueFlight };
