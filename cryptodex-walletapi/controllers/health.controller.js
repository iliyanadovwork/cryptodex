// import package
import mongoose from "mongoose";

// import models
import { Wallet } from "../models/index.js";

// import lib
import { buildHealthSnapshot } from "../lib/serviceHealth.js";
import { grpcServerState } from "../lib/grpcHealth.js";
import { readStandDownMark } from "../lib/walletStandDown.js";

// import controllers
import { isRedisConnected, hget } from "./redis.controller.js";

const STARTED_AT = Date.now();

/**
 * THE ID THE PROBES USE.
 *
 * A valid 24-hex ObjectId whose embedded timestamp is the epoch, so no document
 * in this deployment can carry it. Both probes below are addressed to it, which
 * is what keeps this UNAUTHENTICATED endpoint from reading a user record while
 * still exercising the exact code path the frozen-wallet guard uses: the
 * question asked is "can this store answer", not "what does it say about
 * anyone".
 */
const PROBE_ID = "000000000000000000000000";

/** No probe may outlive the operator's patience. */
const PROBE_TIMEOUT_MS = 1500;

/**
 * Run a probe with a hard deadline.
 *
 * `controllers/redis.controller.js` uses node_redis v3, whose default offline
 * queue makes a command against a DOWN server PEND rather than reject - so
 * without this, the one endpoint a human reaches for when the service feels
 * wrong would hang for exactly the outage it exists to report. A timeout is
 * reported as a failed probe, which is the honest answer: the store did not
 * respond.
 */
const withDeadline = async (label, run) => {
  let timer;
  try {
    return await Promise.race([
      run(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Can the guard read its AUTHORITY - this service's own wallet document?
 * A findById of an id that cannot exist is an indexed lookup that returns null;
 * null is a SUCCESS here, because the question is whether mongo answered.
 */
const probeWalletLookup = async () => {
  try {
    await withDeadline("wallet lookup", () =>
      Wallet.findById(PROBE_ID).select("frozen").lean()
    );
    return "ok";
  } catch (err) {
    console.log("[health] wallet lookup probe failed:", err && err.message);
    return "failed";
  }
};

/**
 * Can the guard read its SECOND SOURCE - the shared stand-down hash (see
 * lib/walletStandDown.js for the literal and why it is agreed across
 * services)? `readStandDownMark` is the very function the guard calls, and it
 * answers `known:false` for an unreadable store, which is
 * precisely the condition that makes every value-moving route refuse.
 */
const probeSharedMark = async () => {
  try {
    const mark = await withDeadline("shared mark", () =>
      readStandDownMark({ hget }, PROBE_ID)
    );
    return mark && mark.known === true ? "ok" : "unreadable";
  } catch (err) {
    console.log("[health] shared-mark probe failed:", err && err.message);
    return "unreadable";
  }
};

/**
 * Liveness / readiness probe.
 * URL    : GET /api/health
 * METHOD : GET
 * AUTH   : none - deliberately unauthenticated (see routes/health.route.js)
 *
 * Returns 200 when the process can serve, 503 when a hard dependency is down.
 * Reports process and dependency state ONLY; it touches no user document and
 * reflects nothing from the request, so there is no user data to leak.
 *
 * Responds on every path, including its own failure - this endpoint is what a
 * human reaches for when the service feels wrong, so it must never be the thing
 * that hangs.
 */
export const healthCheck = async (req, res) => {
  try {
    const [walletLookup, markRead] = await Promise.all([
      probeWalletLookup(),
      probeSharedMark(),
    ]);

    const { httpCode, body } = buildHealthSnapshot({
      mongoReadyState: mongoose.connection.readyState,
      redisConnected: isRedisConnected(),
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      grpc: grpcServerState(),
      standDown: { walletLookup, markRead },
    });

    return res.status(httpCode).json(body);
  } catch (err) {
    console.error(`[health] health endpoint failed: ${err && err.message}`);
    return res.status(503).json({
      status: "unhealthy",
      service: "walletapi",
      reason: "health_check_error",
      checkedAt: new Date().toISOString(),
    });
  }
};

export default { healthCheck };
