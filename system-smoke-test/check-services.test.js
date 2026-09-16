/**
 * TESTS FOR THE OPERATOR-FACING SERVICE CHECK.
 *
 * THE FAULT THESE EXIST TO KILL
 * =============================
 * `node check-services.js` printed
 *
 *     ✓ Sentinel API (port 3005) - liveness only (no health route) - HTTP 200
 *     7/7 services running
 *     ✓ All services running!
 *
 * and exited 0, while GET /api/sentinel/health on that very port was
 * answering
 *
 *     HTTP 503 {"service":"sentinelapi","status":"degraded",
 *               "verdict":"margin_invariant_violated","violationCount":1,...}
 *
 * A checker that contradicts the services' own health is worse than no checker,
 * because an operator trusts it. Two independent defects made it possible:
 * two services that have since been deleted were probed for LIVENESS against a
 * data route that knows nothing about correctness, and the health parser read
 * `verdict` in preference to `status` — so even once pointed at the health
 * endpoint it would have called a healthy service degraded, because that
 * service's verdict is the reason code "margin_reconciled" rather than the
 * word "ok".
 *
 * No test framework: `node --test` ships with node, and this directory has one
 * dependency for a reason.
 *
 *     node --test system-smoke-test/
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { SERVICES, interpretHealthBody, checkService } from "./check-services.js";

/* ------------------------------------------------------------------------ *
 * REAL PAYLOADS, CAPTURED FROM THE RUNNING STACK
 * ------------------------------------------------------------------------ */

const SPOT_HEALTHY = {
  status: "healthy",
  verdict: "ok",
  service: "spotapi",
  uptimeSec: 2706,
  matcher: { running: true, evidence: "paper_ladder_refresh" },
  depthFeed: { summary: { total: 3, connected: 3, allConnected: true } },
};

const USER_HEALTHY = {
  status: "ok",
  service: "userapi",
  uptimeSeconds: 5652,
  dependencies: { mongo: "connected", redis: "connected" },
};

const AUDITOR_HEALTHY = {
  service: "auditorapi",
  check: "margin_reconciliation",
  status: "healthy",
  verdict: "margin_reconciled",
  accountsScanned: 4,
  violationCount: 0,
  violations: [],
  acknowledgedCount: 0,
  pendingCount: 0,
};

const SENTINEL_DEGRADED = {
  service: "sentinelapi",
  check: "margin_reconciliation",
  status: "degraded",
  verdict: "margin_invariant_violated",
  matcher: { status: "healthy", verdict: "matcher_live" },
  accountsScanned: 5,
  violationCount: 1,
  violations: [
    {
      userId: "6a70f1c287c92c7218ac37fc",
      coinId: "695bc8cd25bf5f8d3d11f2e4",
      verdict: "orphaned_margin",
      drift: 0.00090032,
    },
  ],
  acknowledgedCount: 0,
  pendingCount: 0,
  remedy: "read-only detector; repair with `node reconcileBalanceDrift.js`",
};

const SENTINEL_ACKNOWLEDGED = {
  service: "sentinelapi",
  status: "healthy",
  verdict: "margin_invariant_acknowledged",
  accountsScanned: 5,
  violationCount: 0,
  violations: [],
  acknowledgedCount: 1,
  acknowledged: [{ userId: "u1", coinId: "c1", drift: 0.0009 }],
};

const body = (payload) => JSON.stringify(payload);

/* ------------------------------------------------------------------------ *
 * GUARD 1 — `status` IS THE STATE, `verdict` IS THE REASON
 * ------------------------------------------------------------------------ */

test("guard: a healthy reconciliation service is UP despite a non-'ok' verdict", () => {
  const parsed = interpretHealthBody(body(AUDITOR_HEALTHY), "auditorapi");

  // Reading `verdict` first made this 'degraded': "margin_reconciled" is not a
  // state word and was never going to be in the healthy set.
  assert.equal(parsed.state, "up");
});

test("guard: an acknowledged margin violation is UP, and says so", () => {
  const parsed = interpretHealthBody(body(SENTINEL_ACKNOWLEDGED), "sentinelapi");

  assert.equal(parsed.state, "up");
  assert.match(parsed.detail, /1 ACKNOWLEDGED margin violation/);
});

test("guard: a degraded service is DEGRADED", () => {
  const parsed = interpretHealthBody(body(SENTINEL_DEGRADED), "sentinelapi");

  assert.equal(parsed.state, "degraded");
});

test("guard: the degradation reason names the account and the drift", () => {
  const { detail } = interpretHealthBody(body(SENTINEL_DEGRADED), "sentinelapi");

  assert.match(detail, /margin invariant violated/);
  assert.match(detail, /1 margin violation/);
  assert.match(detail, /6a70f1c287c92c7218ac37fc/);
  assert.match(detail, /0\.00090032/);
  assert.match(detail, /reconcileBalanceDrift/);
});

test("guard: spotapi and userapi still read as UP", () => {
  assert.equal(interpretHealthBody(body(SPOT_HEALTHY), "spotapi").state, "up");
  assert.equal(interpretHealthBody(body(USER_HEALTHY), "userapi").state, "up");
});

test("guard: the healthy detail carries the evidence, not just the word", () => {
  assert.match(
    interpretHealthBody(body(SPOT_HEALTHY), "spotapi").detail,
    /matcher running \| depth 3\/3/
  );
  assert.match(
    interpretHealthBody(body(USER_HEALTHY), "userapi").detail,
    /mongo connected, redis connected/
  );
  assert.match(
    interpretHealthBody(body(AUDITOR_HEALTHY), "auditorapi").detail,
    /4 accounts reconciled/
  );
});

test("guard: a drift inside the grace window is reported even though it is green", () => {
  const parsed = interpretHealthBody(
    body({ ...AUDITOR_HEALTHY, pendingCount: 1 }),
    "auditorapi"
  );

  assert.equal(parsed.state, "up");
  assert.match(parsed.detail, /1 drift\(s\) inside the grace window/);
});

/* ------------------------------------------------------------------------ *
 * GUARD 2 — ANY NON-HEALTHY STATE IS NOT "RUNNING"
 * ------------------------------------------------------------------------ */

test("guard: every unhealthy state word is refused", () => {
  for (const status of ["degraded", "unhealthy", "unknown", "starting", ""]) {
    const parsed = interpretHealthBody(
      body({ ...AUDITOR_HEALTHY, status }),
      "auditorapi"
    );
    assert.notEqual(parsed.state, "up", `"${status}" must not read as up`);
  }
});

test("guard: only the four state words count as healthy", () => {
  for (const status of ["ok", "healthy", "up", "pass"]) {
    assert.equal(
      interpretHealthBody(body({ service: "x", status }), null).state,
      "up"
    );
  }
});

test("guard: a payload with no status at all is DOWN, not assumed well", () => {
  const parsed = interpretHealthBody(body({ service: "auditorapi" }), "auditorapi");

  assert.equal(parsed.state, "down");
  assert.match(parsed.detail, /carried no status/);
});

test("guard: a verdict cannot stand in for a missing status", () => {
  const parsed = interpretHealthBody(
    body({ service: "auditorapi", verdict: "ok" }),
    "auditorapi"
  );

  assert.equal(parsed.state, "down");
});

test("guard: a non-JSON body is DOWN", () => {
  assert.equal(interpretHealthBody("<html>502</html>", null).state, "down");
  assert.equal(interpretHealthBody("", null).state, "down");
});

test("guard: valid JSON that is not an object is DOWN", () => {
  assert.equal(interpretHealthBody("null", null).state, "down");
  assert.equal(interpretHealthBody("42", null).state, "down");
  assert.equal(interpretHealthBody('"healthy"', null).state, "down");
});

/* ------------------------------------------------------------------------ *
 * GUARD 3 — IDENTITY
 * ------------------------------------------------------------------------ */

test("guard: the wrong service on the right port is DOWN, however healthy", () => {
  const parsed = interpretHealthBody(body(SPOT_HEALTHY), "sentinelapi");

  assert.equal(parsed.state, "down");
  assert.match(parsed.detail, /expected sentinelapi, got spotapi/);
});

test("guard: identity is checked before the verdict", () => {
  // A degraded payload from the WRONG service must not be reported as this
  // service being degraded — that is a different, and worse, wrong answer.
  const parsed = interpretHealthBody(body(SENTINEL_DEGRADED), "auditorapi");

  assert.equal(parsed.state, "down");
  assert.match(parsed.detail, /wrong service on this port/);
});

test("guard: a payload with no service name is still judged on its status", () => {
  assert.equal(
    interpretHealthBody(body({ status: "healthy" }), "sentinelapi").state,
    "up"
  );
});

/* ------------------------------------------------------------------------ *
 * GUARD 4 — THE HTTP LAYER
 * ------------------------------------------------------------------------ */

/** One-request server on an ephemeral port. */
const withServer = async (handler, fn) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const healthService = (port, service = "sentinelapi") => ({
  name: "Sentinel API",
  key: "sentinelAPI",
  port,
  probe: { kind: "health", path: "/api/sentinel/health", service },
});

test("guard: a 503 health response is degraded, and the body is still read", async () => {
  const result = await withServer(
    (req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(body(SENTINEL_DEGRADED));
    },
    (port) => checkService(healthService(port))
  );

  assert.equal(result.state, "degraded");
  assert.match(result.detail, /HTTP 503/);
  assert.match(result.detail, /margin invariant violated/);
});

test("guard: a 503 claiming to be healthy is STILL not reported as running", async () => {
  const result = await withServer(
    (req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(body({ service: "sentinelapi", status: "healthy" }));
    },
    (port) => checkService(healthService(port))
  );

  assert.equal(result.state, "degraded");
});

test("guard: a 200 healthy response is up", async () => {
  const result = await withServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body({ ...AUDITOR_HEALTHY, service: "sentinelapi" }));
    },
    (port) => checkService(healthService(port))
  );

  assert.equal(result.state, "up");
});

test("guard: the probe asks for the path the table names", async () => {
  let seen = null;
  await withServer(
    (req, res) => {
      seen = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body({ service: "sentinelapi", status: "healthy" }));
    },
    (port) => checkService(healthService(port))
  );

  assert.equal(seen, "/api/sentinel/health");
});

test("guard: nothing listening is DOWN, with the reason", async () => {
  // Port 1 is reserved and nothing binds it.
  const result = await checkService(healthService(1));

  assert.equal(result.state, "down");
  assert.ok(result.detail.length > 0);
});

test("guard: a liveness 404 is DOWN — something is bound, but not this service", async () => {
  const result = await withServer(
    (req, res) => {
      res.writeHead(404);
      res.end("Not Found");
    },
    (port) =>
      checkService({
        name: "Wallet API",
        key: "walletAPI",
        port,
        probe: { kind: "liveness", path: "/api/currency/getCurrency" },
      })
  );

  assert.equal(result.state, "down");
  assert.match(result.detail, /is not mounted there/);
});

test("guard: a liveness pass is labelled as liveness, never as health", async () => {
  const result = await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end("ok");
    },
    (port) =>
      checkService({
        // The Next frontend is the only liveness probe left on the table.
        name: "Frontend",
        key: "frontend",
        port,
        probe: { kind: "liveness", path: "/" },
      })
  );

  assert.equal(result.state, "up");
  assert.match(result.detail, /liveness only/);
});

/* ------------------------------------------------------------------------ *
 * GUARD 5 — THE TABLE ITSELF
 * ------------------------------------------------------------------------ */

test("guard: every service that has a health endpoint is probed with it", () => {
  const byKey = Object.fromEntries(SERVICES.map((s) => [s.key, s]));

  // walletapi used to be probed for liveness against /api/currency/getCurrency,
  // which cannot see an unbound gRPC server or a stand-down guard that has
  // failed closed. It is now in the table as a health probe like the rest.
  const expected = {
    userAPI: { path: "/api/health", service: "userapi" },
    spotAPI: { path: "/api/spot/health", service: "spotapi" },
    walletAPI: { path: "/api/health", service: "walletapi" },
  };

  for (const [key, want] of Object.entries(expected)) {
    assert.ok(byKey[key], `${key} missing from the table`);
    assert.equal(byKey[key].probe.kind, "health", `${key} must use its health route`);
    assert.equal(byKey[key].probe.path, want.path);
    assert.equal(byKey[key].probe.service, want.service);
  }
});

test("guard: the ports have not drifted back", () => {
  const ports = Object.fromEntries(SERVICES.map((s) => [s.key, s.port]));

  // FOUR PROCESSES, AND THE ABSENCES ARE PART OF THE ASSERTION. A table entry
  // for a service that is not running makes `check-services.js` print red
  // crosses and exit 1 against a completely healthy stack. deepEqual is
  // deliberate - an extra key fails here, so nothing can creep back onto the
  // inventory unnoticed.
  assert.deepEqual(ports, {
    frontend: 3000,
    userAPI: 2567,
    spotAPI: 2568,
    walletAPI: 3002,
  });
});

test("guard: every liveness probe names a route only its own service mounts", () => {
  for (const service of SERVICES) {
    assert.ok(service.probe, `${service.name} has no probe`);
    assert.ok(
      ["health", "liveness"].includes(service.probe.kind),
      `${service.name} has an unknown probe kind`
    );
    assert.ok(service.probe.path.startsWith("/"), `${service.name} path`);
  }
});
