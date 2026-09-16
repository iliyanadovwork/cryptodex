/**
 * spotapi readiness policy.
 *
 * The point of these tests is the LAST block: a dark Binance feed must not
 * change the status code. That is the whole reason this module exists - the
 * endpoint used to be the fill canary, which 503s on a market condition, and on
 * a one-market venue that made any depth breaker fail the deploy healthcheck.
 */
import { describe, it, expect } from "@jest/globals";
import {
  buildHealthSnapshot,
  mongoStateLabel,
  MONGO_READY_STATES,
} from "../../lib/serviceHealth.js";

const CONNECTED = MONGO_READY_STATES.indexOf("connected");
const DISCONNECTED = MONGO_READY_STATES.indexOf("disconnected");

const snapshot = (over = {}) =>
  buildHealthSnapshot({
    mongoReadyState: CONNECTED,
    redisConnected: true,
    walletDbReadyState: CONNECTED,
    depthFeedConnected: true,
    uptimeSeconds: 42,
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

describe("mongoStateLabel", () => {
  it("maps every mongoose readyState", () => {
    expect(mongoStateLabel(0)).toBe("disconnected");
    expect(mongoStateLabel(1)).toBe("connected");
    expect(mongoStateLabel(2)).toBe("connecting");
    expect(mongoStateLabel(3)).toBe("disconnecting");
  });

  it("does not invent a label for an unknown state", () => {
    expect(mongoStateLabel(99)).toBe("unknown");
    expect(mongoStateLabel(undefined)).toBe("unknown");
  });
});

describe("spotapi health policy", () => {
  it("is ok and 200 when everything is up", () => {
    const { httpCode, body } = snapshot();
    expect(httpCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("spotapi");
    expect(body.dependencies).toEqual({
      mongo: "connected",
      redis: "connected",
      walletDb: "connected",
    });
  });

  it("503s when mongo is down - the pair list and history live there", () => {
    const { httpCode, body } = snapshot({ mongoReadyState: DISCONNECTED });
    expect(httpCode).toBe(503);
    expect(body.status).toBe("unhealthy");
  });

  it("503s when redis is down, because balances and the book live in it", () => {
    // This is where spotapi's severity model deliberately differs from
    // userapi's, where redis is a soft dependency.
    const { httpCode, body } = snapshot({ redisConnected: false });
    expect(httpCode).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.dependencies.redis).toBe("disconnected");
  });

  it("degrades but still serves when only the wallet database is down", () => {
    const { httpCode, body } = snapshot({ walletDbReadyState: DISCONNECTED });
    expect(httpCode).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.dependencies.walletDb).toBe("disconnected");
  });

  it("reports an unset wallet connection as unknown rather than connected", () => {
    const { body } = snapshot({ walletDbReadyState: undefined });
    expect(body.dependencies.walletDb).toBe("unknown");
    expect(body.status).toBe("degraded");
  });

  // ---------------------------------------------------------------------
  // The reason this module exists.
  // ---------------------------------------------------------------------
  it("stays 200 and ok when the Binance depth feed is dark", () => {
    const { httpCode, body } = snapshot({ depthFeedConnected: false });
    expect(httpCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.depthFeed.connected).toBe(false);
  });

  it("never lets the depth feed alone change the status code", () => {
    const up = snapshot({ depthFeedConnected: true });
    const dark = snapshot({ depthFeedConnected: false });
    expect(dark.httpCode).toBe(up.httpCode);
    expect(dark.body.status).toBe(up.body.status);
  });

  it("leaks nothing beyond process and dependency state", () => {
    const { body } = snapshot();
    expect(Object.keys(body).sort()).toEqual(
      ["checkedAt", "depthFeed", "dependencies", "service", "status", "uptimeSeconds"].sort()
    );
  });
});
