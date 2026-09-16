/**
 * THE ROUTE-LEVEL HALF OF THE VALUE-FLIGHT REGISTRY.
 *
 * All of the reasoning - what the registry excludes, why the reset needs it and
 * why a reservation counter could not have done the job for spot - lives in
 * lib/valueFlight.js. This module is only the wiring, and it is kept free of
 * any import from spot.controller.js so the guard can be mounted on a route and
 * unit-tested without dragging the matching engine into the graph (the same
 * discipline controllers/standDownState.js keeps for the stand-down guard).
 *
 * WHY IT DEREGISTERS ON `finish` AND DELIBERATELY NOT ON `close`
 * --------------------------------------------------------------
 * `finish` fires when the response has been flushed, which on every route this
 * guards is after the handler has written everything it is going to write. That
 * is the moment the request stops being able to surprise a reset.
 *
 * `close` also fires when the CLIENT hangs up mid-request - and the handler
 * keeps running. Deregistering there would hand the reset a "nothing is in
 * flight" answer while the money was still moving, which is precisely the bug
 * this exists to close. So an abandoned request stays registered until its
 * deadline passes (VALUE_FLIGHT_TTL_MS), and the cost of that is at most one
 * refused reset with an accurate "try again in a moment".
 */

import {
  beginValueFlight,
  endValueFlight,
  VALUE_FLIGHT_TTL_MS,
} from '../lib/valueFlight.js';

/** Spoken in both response dialects this service uses. */
const refuse = (res, status, body) =>
  res.status(status).json({ status: false, success: false, ...body });

export const trackValueFlight = async (req, res, next) => {
  const userId = req.user && req.user.id;
  // No authenticated user means no account to move value in; the route's own
  // passport guard is what answers that, not this one.
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
      // Losing the deregistration costs one TTL of refused resets and no money,
      // so it is logged and never thrown into a response that has already been
      // sent.
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
