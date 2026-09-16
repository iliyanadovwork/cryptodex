/**
 * THE STAND-DOWN STATE, WIRED TO THIS SERVICE'S REDIS AND TO walletapi.
 *
 * All of the reasoning - what a stand-down means on spot, which routes it stops
 * and which it deliberately does not, why the faucet counts as value-moving and
 * why cancel never will - lives in lib/accountStandDown.js. This module is only
 * the wiring, and it is kept free of any import from spot.controller.js so that
 * the guard can be mounted on a route and unit-tested without dragging 7,600
 * lines of matching engine (and with it the bot, the pair cache, the binance
 * websockets and a redis connection) into the graph.
 *
 * TWO SOURCES, ONE VERDICT
 * ------------------------
 *   - `account_standdown` (redis, the shared mark, still read by walletapi) is
 *     consulted FIRST. Spot READS it and never writes it -
 *     see the note in lib/accountStandDown.js; this module exports no writer,
 *     so there is none to call by mistake.
 *   - walletapi's `wallet.frozen`, read through its existing read-only
 *     `deactivateWallet(mode: "check")`, is the AUTHORITY, and it is what
 *     catches a wallet frozen by walletapi ALONE - the exact case that leaves
 *     no local mark, and the exact case a live-session freeze produces.
 *
 * A session-level marker was the third option and it is not enough: the session
 * is destroyed by userapi's deactivation, so a marker on it says nothing at all
 * about the case this has to catch, which is A FROZEN WALLET WITH A LIVE
 * SESSION.
 */

import {
  STAND_DOWN_HASH,
  STAND_DOWN_MESSAGE,
  STAND_DOWN_STATUS,
  STAND_DOWN_UNKNOWN_MESSAGE,
  STAND_DOWN_UNKNOWN_STATUS,
  makeStandDownGuard,
  readStandDownMark,
  resolveStandDown,
} from "../lib/accountStandDown.js";
import { hget } from "./redis.controller.js";
import { checkWalletFrozen } from "../grpc/walletStandDownService.js";

export {
  STAND_DOWN_HASH,
  STAND_DOWN_MESSAGE,
  STAND_DOWN_STATUS,
  STAND_DOWN_UNKNOWN_MESSAGE,
  STAND_DOWN_UNKNOWN_STATUS,
};

/** Read-only by construction: no hset, no hdel, nothing that can write a mark. */
const redisDeps = { hget };

/**
 * THE VERDICT. Every guard in this service goes through this one function, so
 * "is this account stood down" cannot come to mean two different things on two
 * different routes.
 */
export const resolveAccountStandDown = async (userId) =>
  resolveStandDown({
    readMark: () => readStandDownMark(redisDeps, userId),
    readWallet: () => checkWalletFrozen(userId),
  });

/**
 * Express guard for the routes that create or settle exposure, or that move
 * value. Mounted in routes/spot.route.js, which lists exactly where and why.
 */
export const blockStoodDownAccount = makeStandDownGuard({
  resolve: resolveAccountStandDown,
});

/**
 * The same verdict for callers that are not an express route. Answers
 * { allowed, reason, message } so a refusal reads the same to another service
 * as it does to a browser. Nothing calls it yet - it exists so that the next
 * non-HTTP surface that needs the verdict reaches for THIS rather than
 * re-deriving the policy, which is how two independent callers drift apart.
 */
export const assertAccountMayAct = async (userId) => {
  const verdict = await resolveAccountStandDown(userId);
  if (verdict.frozen === true) {
    return {
      allowed: false,
      reason: STAND_DOWN_STATUS,
      message: STAND_DOWN_MESSAGE,
      source: verdict.source,
    };
  }
  if (verdict.known !== true) {
    return {
      allowed: false,
      reason: STAND_DOWN_UNKNOWN_STATUS,
      message: STAND_DOWN_UNKNOWN_MESSAGE,
      source: verdict.source,
    };
  }
  return { allowed: true, reason: null, message: null, source: verdict.source };
};
