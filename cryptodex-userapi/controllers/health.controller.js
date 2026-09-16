// import package
import mongoose from "mongoose";

// import config
import config from "../config/index.js";

// import lib
import { buildHealthSnapshot } from "../lib/serviceHealth.js";
import { mailDeliveryMode } from "../lib/mailDelivery.js";

// import controllers
import { isRedisConnected } from "./redis.controller.js";

const STARTED_AT = Date.now();

/**
 * Liveness / readiness probe.
 * URL    : GET /api/health
 * METHOD : GET
 * AUTH   : none - deliberately unauthenticated (see routes/health.route.js)
 *
 * Returns 200 when the process can serve, 503 when a hard dependency is down.
 * Reports process and dependency state ONLY; it touches no collection and
 * reflects nothing from the request, so there is no user data to leak.
 *
 * Responds on every path, including its own failure - this endpoint is what a
 * human reaches for when the service feels wrong, so it must never be the thing
 * that hangs.
 */
export const healthCheck = async (req, res) => {
  try {
    const { httpCode, body } = buildHealthSnapshot({
      mongoReadyState: mongoose.connection.readyState,
      redisConnected: isRedisConnected(),
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      mailDeliveryMode: mailDeliveryMode(),
      mailProviderConfigured: Boolean(config.RESEND && config.RESEND.API_KEY),
    });

    return res.status(httpCode).json(body);
  } catch (err) {
    console.error(`[health] health endpoint failed: ${err && err.message}`);
    return res.status(503).json({
      status: "unhealthy",
      service: "userapi",
      reason: "health_check_error",
      checkedAt: new Date().toISOString(),
    });
  }
};

export default { healthCheck };
