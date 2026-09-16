/**
 * Liveness / readiness snapshot for this service.
 *
 * Kept as a pure function, separate from the express handler, so the policy
 * (what counts as healthy, what HTTP code that maps to) can be unit-tested
 * without a live Mongo, Redis, or socket.
 *
 * PRIVACY CONTRACT - the reason this file is deliberately small:
 * the endpoint that serves this snapshot is UNAUTHENTICATED. It may therefore
 * only ever describe the *process and its dependencies*. It must never read a
 * collection, count users, echo a request parameter, or include anything
 * derived from a user record. Everything below is a constant, a clock, or a
 * connection state.
 */

/** mongoose.connection.readyState -> human label. */
export const MONGO_READY_STATES = [
  "disconnected",
  "connected",
  "connecting",
  "disconnecting",
];

/**
 * @param {number} readyState mongoose.connection.readyState
 * @returns {string}
 */
export const mongoStateLabel = (readyState) =>
  MONGO_READY_STATES[readyState] || "unknown";

/**
 * Build the health snapshot.
 *
 * Severity model:
 *   - Mongo is a HARD dependency: every route in this service queries it, so a
 *     disconnected Mongo means the process is up but cannot serve. -> 503.
 *   - Redis is a SOFT dependency: it backs caches and session-ish scratch data,
 *     and most auth routes still work without it. -> "degraded", but still 200,
 *     because the process is alive and an orchestrator should not kill it.
 *
 * @param {object} input
 * @param {number} input.mongoReadyState
 * @param {boolean} input.redisConnected
 * @param {number} input.uptimeSeconds
 * @param {string} input.mailDeliveryMode
 * @param {boolean} input.mailProviderConfigured
 * @param {string} [input.checkedAt] ISO timestamp (injectable for tests)
 * @returns {{httpCode: number, body: object}}
 */
export const buildHealthSnapshot = ({
  mongoReadyState,
  redisConnected,
  uptimeSeconds,
  mailDeliveryMode,
  mailProviderConfigured,
  checkedAt = new Date().toISOString(),
}) => {
  const mongo = mongoStateLabel(mongoReadyState);
  const redis = redisConnected ? "connected" : "disconnected";

  const mongoHealthy = mongo === "connected";
  let status;
  if (!mongoHealthy) {
    status = "unhealthy";
  } else if (!redisConnected) {
    status = "degraded";
  } else {
    status = "ok";
  }

  return {
    httpCode: mongoHealthy ? 200 : 503,
    body: {
      status,
      service: "userapi",
      checkedAt,
      uptimeSeconds,
      dependencies: { mongo, redis },
      // Config shape only - never a key, never an address.
      email: {
        provider: "resend",
        configured: Boolean(mailProviderConfigured),
        deliveryMode: mailDeliveryMode,
      },
    },
  };
};

export default { buildHealthSnapshot, mongoStateLabel, MONGO_READY_STATES };
