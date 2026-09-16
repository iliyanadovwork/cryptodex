// import package
import mongoose from "mongoose";

// import lib
import { buildHealthSnapshot } from "../lib/serviceHealth.js";
import { ledgerDurability } from "./redis.controller.js";
import { getDepthStreamHealth } from "../lib/binanceWebSocket.js";

// import controllers
import { isRedisConnected } from "./redis.controller.js";

// import models - for the second (wallet database) connection handle only
import { walletDb } from "../models/currency.js";

const STARTED_AT = Date.now();

/**
 * Liveness / readiness probe.
 * URL    : GET /api/health
 * METHOD : GET
 * AUTH   : none - deliberately unauthenticated, so it stays useful when auth or
 *          redis is the broken thing.
 *
 * Returns 200 when the process can serve, 503 when a HARD dependency is down
 * (mongo or redis - see lib/serviceHealth.js for why redis is hard here).
 *
 * This is NOT the fill canary. A dark Binance feed is reported in the body but
 * never changes the status code; `/api/spot/health` is the tradability
 * judgement. The two were conflated, and on a one-market venue that made any
 * depth breaker fail the Railway healthcheck - see the header of
 * lib/serviceHealth.js.
 *
 * Reports process and dependency state ONLY; it touches no collection and
 * reflects nothing from the request, so there is no user data to leak.
 *
 * Responds on every path, including its own failure - this endpoint is what a
 * human reaches for when the service feels wrong, so it must never be the thing
 * that hangs.
 */
export const healthCheck = async (req, res) => {
  try {
    // Never let an operational read throw into the probe: if the depth module
    // is mid-teardown this is decoration, not a dependency.
    let depthFeedConnected = false;
    try {
      const streams = getDepthStreamHealth();
      depthFeedConnected =
        Array.isArray(streams) &&
        streams.length > 0 &&
        streams.every((s) => s.connected);
    } catch {
      depthFeedConnected = false;
    }

    const { httpCode, body } = buildHealthSnapshot({
      mongoReadyState: mongoose.connection.readyState,
      redisConnected: isRedisConnected(),
      walletDbReadyState: walletDb ? walletDb.readyState : undefined,
      depthFeedConnected,
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    });

    // REPORTED, NEVER GATED. Whether redis is persisting the ledger is an
    // operator setting this service cannot change, and a deploy that refuses to
    // go green over it would block every release without fixing anything. It is
    // surfaced so the answer is visible rather than assumed - the same reason
    // the depth feed is reported here and gates nothing.
    //
    // AND IT IS RACED AGAINST A TIMEOUT, WHICH IS THE POINT. This is a liveness
    // probe. node-redis queues commands while the connection is down rather
    // than rejecting them, so an unguarded await here would never settle during
    // a redis outage - and the probe would HANG instead of returning the 503 it
    // has already computed. A health check that stops answering when the system
    // is unhealthy is worse than not having one.
    const LEDGER_CHECK_MS = 250;
    let ledger = { durable: null, reason: "not checked" };
    try {
      ledger = await Promise.race([
        ledgerDurability(),
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ durable: null, reason: "check timed out" }),
            LEDGER_CHECK_MS
          )
        ),
      ]);
    } catch {
      ledger = { durable: null, reason: "check failed" };
    }

    return res.status(httpCode).json({ ...body, ledger });
  } catch (err) {
    console.error(`[health] health endpoint failed: ${err && err.message}`);
    return res.status(503).json({
      status: "unhealthy",
      service: "spotapi",
      checkedAt: new Date().toISOString(),
      error: "health_check_failed",
    });
  }
};

export default { healthCheck };
