/**
 * Liveness / readiness snapshot for the WALLET API.
 *
 * Kept as a pure function, separate from the express handler, so the policy
 * (what counts as healthy, what HTTP code that maps to) can be unit-tested
 * without a live Mongo, Redis or gRPC socket. Same shape and same contract as
 * userapi/lib/serviceHealth.js - deliberately, because system-smoke-test reads
 * both with one parser.
 *
 * PRIVACY CONTRACT - the reason this file is deliberately small:
 * the endpoint that serves this snapshot is UNAUTHENTICATED. It may therefore
 * only ever describe the *process and its dependencies*. It must never read a
 * wallet, count users, quote a balance, echo a request parameter, or include
 * anything derived from a user record. Everything below is a constant, a clock,
 * or a connection state. The probes the controller runs are addressed to an
 * id that cannot exist (see health.controller.js), so even the probe reads
 * nothing.
 *
 * WHY THIS SERVICE NEEDS MORE THAN mongo+redis
 * --------------------------------------------
 * Two things are true of walletapi and of nothing else on the venue:
 *
 *  1. ITS MAIN SURFACE IS NOT HTTP. spotapi and userapi
 *     all reach walletapi over gRPC. An express process
 *     whose gRPC server never bound serves /api/wallet perfectly while every
 *     other service on the venue gets `14 UNAVAILABLE`. A port check on 3002 -
 *     and an HTTP-only health check - both call that healthy.
 *
 *  2. IT HAS A GUARD THAT FAILS CLOSED. lib/walletStandDown.js refuses every
 *     value-moving route with 503 when it cannot READ the stand-down state,
 *     which is the correct behaviour and means a redis outage silently turns
 *     transfer/withdraw/deposit into a total refusal while the process looks
 *     fine. Reporting "redis: disconnected" and leaving the operator to infer
 *     the consequence is how the last outage got misread, so the consequence
 *     is stated in the payload.
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

/** What the money-moving routes do when the guard cannot read its sources. */
export const GUARD_FAILING_CLOSED_EFFECT =
  "every value-moving route (transfer, coinWithdraw, fiatWithdraw, fiatDeposit, createAddress) refuses with 503";

/**
 * Build the health snapshot.
 *
 * SEVERITY MODEL - three tiers, and each one is a decision about what an
 * orchestrator or an operator should DO:
 *
 *   - MONGO is a HARD dependency. Every route and every gRPC handler in this
 *     service reads the wallet collection, and the stand-down guard's authority
 *     IS a mongo document, so a disconnected mongo means the process is up and
 *     can serve nothing. -> "unhealthy", 503.
 *
 *   - THE gRPC SERVER is a HARD dependency, and this is the part a port check
 *     can never see. It is also the readiness half of this probe: express binds
 *     first and grpc/server.js binds afterwards, so "not bound yet" is a real,
 *     expected, transient state that a caller must not be routed into.
 *     -> "unhealthy", 503, until it is bound.
 *
 *   - REDIS is a SOFT dependency for the PROCESS - it holds the balance ledger
 *     mirrors and the session rows, the service stays up and reads keep
 *     working - so it is "degraded" and still 200, because an orchestrator must
 *     not kill this process over a redis blip. It is NOT soft for the user:
 *     with redis unreadable the frozen-wallet guard fails closed, and the
 *     payload says exactly that rather than leaving it to be inferred.
 *
 * @param {object} input
 * @param {number} input.mongoReadyState
 * @param {boolean} input.redisConnected
 * @param {number} input.uptimeSeconds
 * @param {{bound:boolean, port:?number, address:?string, error:?string}} input.grpc
 * @param {{walletLookup:string, markRead:string}} input.standDown
 * @param {string} [input.checkedAt] ISO timestamp (injectable for tests)
 * @returns {{httpCode: number, body: object}}
 */
export const buildHealthSnapshot = ({
  mongoReadyState,
  redisConnected,
  uptimeSeconds,
  grpc = {},
  standDown = {},
  checkedAt = new Date().toISOString(),
}) => {
  const mongo = mongoStateLabel(mongoReadyState);
  const redis = redisConnected ? "connected" : "disconnected";

  const mongoHealthy = mongo === "connected";
  const grpcBound = grpc.bound === true;

  // The guard's two sources, reported separately because they fail for
  // different reasons and an operator fixes them in different places.
  const walletLookup = standDown.walletLookup || "unknown";
  const markRead = standDown.markRead || "unknown";
  const guardReady = walletLookup === "ok" && markRead === "ok";

  const reasons = [];
  if (!mongoHealthy) reasons.push(`mongo ${mongo}`);
  if (!grpcBound) {
    reasons.push(
      grpc.error ? `grpc server not bound: ${grpc.error}` : "grpc server not bound"
    );
  }
  if (!redisConnected) reasons.push("redis disconnected");
  if (!guardReady) {
    reasons.push(
      `frozen-wallet guard failing closed (wallet lookup ${walletLookup}, shared mark ${markRead})`
    );
  }

  let status;
  if (!mongoHealthy || !grpcBound) {
    status = "unhealthy";
  } else if (!redisConnected || !guardReady) {
    status = "degraded";
  } else {
    status = "ok";
  }

  return {
    httpCode: mongoHealthy && grpcBound ? 200 : 503,
    body: {
      status,
      service: "walletapi",
      checkedAt,
      uptimeSeconds,
      dependencies: { mongo, redis },
      // The socket every OTHER service on the venue talks to. Never a
      // credential, never a key path - a bound flag, the address we asked for
      // and the port we got.
      grpc: {
        bound: grpcBound,
        address: grpc.address == null ? null : String(grpc.address),
        port: grpc.port == null ? null : grpc.port,
        error: grpc.error == null ? null : String(grpc.error),
      },
      // Whether the guard that makes "stood down" mean something can reach the
      // two sources it reads. Not whether ANY wallet is frozen - that would be
      // user state, and this endpoint has none.
      standDownGuard: {
        ready: guardReady,
        walletLookup,
        sharedMark: markRead,
        ...(guardReady ? {} : { effect: GUARD_FAILING_CLOSED_EFFECT }),
      },
      ...(reasons.length ? { reason: reasons.join("; ") } : {}),
    },
  };
};

export default { buildHealthSnapshot, mongoStateLabel, MONGO_READY_STATES };
