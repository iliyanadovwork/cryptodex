/**
 * Liveness / readiness snapshot for spotapi.
 *
 * WHY THIS FILE EXISTS - AND WHY IT IS NOT THE FILL CANARY
 * =======================================================
 *
 * spotapi was the only one of the three services with no readiness probe. To
 * give `/api/health` *something* to answer, server.js aliased it to the FILL
 * CANARY's handler - which returns 503 whenever the venue cannot fill an order.
 *
 * Those are two different questions:
 *
 *     "is this process able to serve?"      <- readiness. This file.
 *     "can the venue currently fill?"       <- tradability. controllers/fillCanary.js
 *
 * Conflating them was actively harmful once the venue narrowed to a single
 * market. `summarise()` in fillCanary.js returns "unhealthy" only when EVERY
 * pair is failing and "degraded" otherwise - the degraded state exists so that
 * one dead market out of three does not read as an outage. With one market
 * there is no degraded state left: any single depth breaker means every pair is
 * failing, so spotapi answered 503, so the gateway's /api/health fan-out
 * answered 503, so Railway failed the healthcheck. A Binance hiccup could fail a
 * deploy, and with restartPolicyType ON_FAILURE restart a live container into an
 * outage that restarting cannot fix.
 *
 * So `/api/health` now means what it means on userapi and walletapi - process
 * and dependencies - and `/api/spot/health` remains the fill canary, which is
 * the right thing to point an uptime monitor or an alerting rule at.
 *
 * PRIVACY CONTRACT - the reason this file is deliberately small: the endpoint
 * that serves this snapshot is UNAUTHENTICATED. It may therefore only ever
 * describe the *process and its dependencies*. It must never read a collection,
 * count orders, echo a request parameter, or include anything derived from a
 * user record. Everything below is a constant, a clock, or a connection state.
 */

/** mongoose.connection.readyState -> human label. */
export const MONGO_READY_STATES = [
  "disconnected",
  "connected",
  "connecting",
  "disconnecting",
];

/**
 * @param {number} readyState mongoose connection readyState
 * @returns {string}
 */
export const mongoStateLabel = (readyState) =>
  MONGO_READY_STATES[readyState] || "unknown";

/**
 * Build the health snapshot.
 *
 * Severity model, and the reasoning behind each:
 *
 *   - Mongo (spot database) is a HARD dependency. The pair list, order history
 *     and trade history all live there. -> 503.
 *   - Redis is a HARD dependency *for this service in particular*. The
 *     authoritative spot balances and the live order book are both redis
 *     structures, so without it no order can be reserved and the matcher cannot
 *     read the book. This is the one place spotapi's severity model differs from
 *     userapi's, where redis is soft. -> 503.
 *   - The wallet database (spotapi's second mongoose connection, used for
 *     currency lookups) is SOFT. -> "degraded", still 200.
 *   - The Binance depth feed is REPORTED BUT NEVER GATES THE STATUS. It is a
 *     market condition, not a process fault, and it is exactly what this probe
 *     must not fail on. Read `/api/spot/health` for that judgement.
 *
 * @param {object} input
 * @param {number} input.mongoReadyState
 * @param {boolean} input.redisConnected
 * @param {number} [input.walletDbReadyState]
 * @param {boolean} [input.depthFeedConnected] reported only
 * @param {number} input.uptimeSeconds
 * @param {string} [input.checkedAt] ISO timestamp (injectable for tests)
 * @returns {{httpCode: number, body: object}}
 */
export const buildHealthSnapshot = ({
  mongoReadyState,
  redisConnected,
  walletDbReadyState,
  depthFeedConnected,
  uptimeSeconds,
  checkedAt = new Date().toISOString(),
}) => {
  const mongo = mongoStateLabel(mongoReadyState);
  const redis = redisConnected ? "connected" : "disconnected";
  const walletDb = mongoStateLabel(walletDbReadyState);

  const mongoHealthy = mongo === "connected";
  const walletDbHealthy = walletDb === "connected";
  const hardDepsHealthy = mongoHealthy && Boolean(redisConnected);

  let status;
  if (!hardDepsHealthy) {
    status = "unhealthy";
  } else if (!walletDbHealthy) {
    status = "degraded";
  } else {
    status = "ok";
  }

  return {
    httpCode: hardDepsHealthy ? 200 : 503,
    body: {
      status,
      service: "spotapi",
      checkedAt,
      uptimeSeconds,
      dependencies: { mongo, redis, walletDb },
      // Reported for operators, deliberately NOT part of `status`. A dark feed
      // is a market condition; see the header.
      depthFeed: {
        connected: Boolean(depthFeedConnected),
        note: "reported only - tradability is /api/spot/health",
      },
    },
  };
};

export default { buildHealthSnapshot, mongoStateLabel, MONGO_READY_STATES };
