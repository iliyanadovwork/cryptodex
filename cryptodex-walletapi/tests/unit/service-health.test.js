/**
 * THE WALLET API'S HEALTH VERDICT.
 *
 * WHAT THIS EXISTS TO STOP
 * ========================
 * walletapi had no health endpoint, so its liveness could only be inferred from
 * port 3002 being open - and this stack has already watched that lie: a service
 * was OOM-killed while its port checker reported green.
 *
 * A port cannot answer either of the two questions that decide whether this
 * service is doing its job:
 *
 *   1. IS THE gRPC SERVER BOUND? Every balance any other service reads or moves
 *      arrives on 6002, not on 3002. An express process with an unbound gRPC
 *      server serves /api/wallet perfectly while spotapi and userapi both get
 *      `14 UNAVAILABLE`.
 *
 *   2. CAN THE FROZEN-WALLET GUARD READ ITS SOURCES? lib/walletStandDown.js
 *      fails CLOSED by design: an unreadable wallet document or an unreadable
 *      shared stand-down mark refuses every value-moving route with 503.
 *      So a redis blip switches the entire money surface off while every read
 *      route keeps answering 200 and the port stays open.
 *
 * The policy lives in lib/serviceHealth.js as a pure function precisely so both
 * of those can be asserted without a mongo, a redis or a socket. Every test
 * below EXECUTES it.
 *
 * THE PRIVACY CONTRACT IS PART OF THE POLICY. The endpoint is unauthenticated,
 * so the snapshot may describe the process and its dependencies and nothing
 * else. That is asserted here as a property of the whole payload, not as a
 * grep: the body is walked and any key or value that looks like user state
 * fails.
 */

import { describe, test, expect } from "@jest/globals";

import {
  buildHealthSnapshot,
  mongoStateLabel,
  MONGO_READY_STATES,
  GUARD_FAILING_CLOSED_EFFECT,
} from "../../lib/serviceHealth.js";
import {
  recordGrpcBind,
  grpcServerState,
  resetGrpcBindState,
} from "../../lib/grpcHealth.js";

/** A completely well service. Each test spoils exactly one thing. */
const WELL = {
  mongoReadyState: 1,
  redisConnected: true,
  uptimeSeconds: 42,
  grpc: { bound: true, address: "127.0.0.1:6002", port: 6002, error: null },
  standDown: { walletLookup: "ok", markRead: "ok" },
  checkedAt: "2026-08-07T00:00:00.000Z",
};

const snapshot = (overrides = {}) => buildHealthSnapshot({ ...WELL, ...overrides });

// ===========================================================================
// 1. THE HAPPY PATH, AND THE SHAPE system-smoke-test PARSES
// ===========================================================================

describe("a well wallet api", () => {
  test("is ok, 200, and names itself", () => {
    const { httpCode, body } = snapshot();
    expect(httpCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("walletapi");
  });

  test("carries no reason, because there is nothing wrong to explain", () => {
    expect(snapshot().body.reason).toBeUndefined();
  });

  test("reports the dependency states check-services.js prints", () => {
    expect(snapshot().body.dependencies).toEqual({
      mongo: "connected",
      redis: "connected",
    });
  });

  test("reports the gRPC socket the rest of the venue actually uses", () => {
    expect(snapshot().body.grpc).toEqual({
      bound: true,
      address: "127.0.0.1:6002",
      port: 6002,
      error: null,
    });
  });

  test("reports the guard as ready, and offers no 'effect' when nothing is broken", () => {
    const guard = snapshot().body.standDownGuard;
    expect(guard.ready).toBe(true);
    expect(guard.walletLookup).toBe("ok");
    expect(guard.sharedMark).toBe("ok");
    expect(guard.effect).toBeUndefined();
  });

  test("the checkedAt clock is injectable, so nothing here is time-dependent", () => {
    expect(snapshot().body.checkedAt).toBe("2026-08-07T00:00:00.000Z");
    expect(typeof buildHealthSnapshot(WELL).body.checkedAt).toBe("string");
  });
});

// ===========================================================================
// 2. MONGO IS HARD
// ===========================================================================

describe("mongo is a hard dependency", () => {
  test.each([
    [0, "disconnected"],
    [2, "connecting"],
    [3, "disconnecting"],
    [99, "unknown"],
  ])("readyState %i (%s) is unhealthy and 503", (readyState, label) => {
    const { httpCode, body } = snapshot({ mongoReadyState: readyState });
    expect(body.dependencies.mongo).toBe(label);
    expect(body.status).toBe("unhealthy");
    expect(httpCode).toBe(503);
  });

  test("only readyState 1 is connected", () => {
    expect(MONGO_READY_STATES[1]).toBe("connected");
    expect(mongoStateLabel(1)).toBe("connected");
    expect(mongoStateLabel(0)).toBe("disconnected");
    expect(mongoStateLabel(7)).toBe("unknown");
    expect(mongoStateLabel(undefined)).toBe("unknown");
  });

  test("the reason names mongo, so an operator is not left guessing", () => {
    expect(snapshot({ mongoReadyState: 0 }).body.reason).toMatch(/mongo disconnected/);
  });
});

// ===========================================================================
// 3. THE gRPC SERVER IS HARD - THE PART A PORT CHECK CANNOT SEE
// ===========================================================================

describe("the gRPC server is a hard dependency", () => {
  test("an unbound gRPC server is UNHEALTHY and 503, even with mongo and redis perfect", () => {
    const { httpCode, body } = snapshot({
      grpc: { bound: false, address: "127.0.0.1:6002", port: null, error: null },
    });
    // THE WHOLE POINT: HTTP is fine, the port is open, and this service cannot
    // serve a single other process on the venue.
    expect(body.dependencies).toEqual({ mongo: "connected", redis: "connected" });
    expect(body.status).toBe("unhealthy");
    expect(httpCode).toBe(503);
  });

  test("the bind error is carried through to the reason", () => {
    const { body } = snapshot({
      grpc: {
        bound: false,
        address: "127.0.0.1:6002",
        port: 0,
        error: "No address added out of total 1 resolved",
      },
    });
    expect(body.reason).toMatch(/grpc server not bound/);
    expect(body.reason).toMatch(/No address added/);
    expect(body.grpc.error).toMatch(/No address added/);
  });

  test("a missing grpc block is not assumed bound", () => {
    // The default-argument path. Absence of evidence is not evidence of a bound
    // socket, and defaulting to `true` here would recreate the port-check lie
    // inside the health endpoint itself.
    const { httpCode, body } = buildHealthSnapshot({ ...WELL, grpc: undefined });
    expect(body.grpc.bound).toBe(false);
    expect(httpCode).toBe(503);
  });

  test("a truthy-but-not-true bound flag does not count", () => {
    for (const bound of ["true", 1, {}, "yes"]) {
      expect(snapshot({ grpc: { bound } }).body.grpc.bound).toBe(false);
    }
  });
});

// ===========================================================================
// 4. REDIS IS SOFT FOR THE PROCESS AND HARD FOR THE USER
// ===========================================================================

describe("redis is soft - degraded, but still 200", () => {
  test("a disconnected redis is degraded and NOT a 503", () => {
    const { httpCode, body } = snapshot({ redisConnected: false });
    expect(body.dependencies.redis).toBe("disconnected");
    expect(body.status).toBe("degraded");
    // An orchestrator must not kill this process over a redis blip.
    expect(httpCode).toBe(200);
  });

  test("degraded is not 'ok' - check-services.js must not print it as running", () => {
    expect(snapshot({ redisConnected: false }).body.status).not.toBe("ok");
  });

  test("the reason names redis", () => {
    expect(snapshot({ redisConnected: false }).body.reason).toMatch(/redis disconnected/);
  });
});

// ===========================================================================
// 5. THE GUARD THAT FAILS CLOSED
// ===========================================================================

describe("the frozen-wallet guard's dependencies", () => {
  test.each([
    ["walletLookup", { walletLookup: "failed", markRead: "ok" }],
    ["sharedMark", { walletLookup: "ok", markRead: "unreadable" }],
    ["both", { walletLookup: "failed", markRead: "unreadable" }],
  ])("an unreachable %s source is degraded, and says what it costs", (_which, standDown) => {
    const { httpCode, body } = snapshot({ standDown });
    expect(body.standDownGuard.ready).toBe(false);
    expect(body.status).toBe("degraded");
    expect(httpCode).toBe(200);
    // NAMING THE CONSEQUENCE IS THE POINT. "redis: disconnected" is a fact an
    // operator has to translate; "every value-moving route refuses with 503" is
    // the thing they actually need to know.
    expect(body.standDownGuard.effect).toBe(GUARD_FAILING_CLOSED_EFFECT);
    expect(body.standDownGuard.effect).toMatch(/refuses with 503/);
    expect(body.reason).toMatch(/failing closed/i);
  });

  test("the reason names WHICH source failed", () => {
    const { body } = snapshot({
      standDown: { walletLookup: "ok", markRead: "unreadable" },
    });
    expect(body.reason).toMatch(/shared mark unreadable/);
    expect(body.reason).toMatch(/wallet lookup ok/);
  });

  test("an absent verdict is 'unknown' and NOT ready - never optimistically ok", () => {
    const { body } = buildHealthSnapshot({ ...WELL, standDown: undefined });
    expect(body.standDownGuard).toEqual(
      expect.objectContaining({
        ready: false,
        walletLookup: "unknown",
        sharedMark: "unknown",
      })
    );
    expect(body.status).toBe("degraded");
  });

  test("a guard failure alone still keeps the process alive - it is not a 503", () => {
    // OVER-CORRECTION MUTANT. Answering 503 here would have an orchestrator
    // restart a process whose mongo and gRPC server are both perfectly fine,
    // which fixes nothing and loses the in-flight requests that still work.
    expect(snapshot({ standDown: { walletLookup: "failed", markRead: "ok" } }).httpCode).toBe(200);
  });
});

// ===========================================================================
// 6. SEVERITY ORDERING
// ===========================================================================

describe("severity ordering", () => {
  test("a hard failure outranks a soft one - mongo down plus redis down is UNHEALTHY", () => {
    const { httpCode, body } = snapshot({
      mongoReadyState: 0,
      redisConnected: false,
      standDown: { walletLookup: "failed", markRead: "unreadable" },
    });
    expect(body.status).toBe("unhealthy");
    expect(httpCode).toBe(503);
  });

  test("every reason is listed, not just the first", () => {
    const { body } = snapshot({
      mongoReadyState: 0,
      redisConnected: false,
      grpc: { bound: false },
      standDown: { walletLookup: "failed", markRead: "unreadable" },
    });
    expect(body.reason).toMatch(/mongo/);
    expect(body.reason).toMatch(/grpc/);
    expect(body.reason).toMatch(/redis/);
    expect(body.reason).toMatch(/guard/);
  });

  test("the three states are the only three, and 200/503 tracks hard failure exactly", () => {
    const cases = [
      [{}, "ok", 200],
      [{ redisConnected: false }, "degraded", 200],
      [{ standDown: { walletLookup: "failed", markRead: "ok" } }, "degraded", 200],
      [{ mongoReadyState: 0 }, "unhealthy", 503],
      [{ grpc: { bound: false } }, "unhealthy", 503],
    ];
    for (const [overrides, status, code] of cases) {
      const got = snapshot(overrides);
      expect([got.body.status, got.httpCode]).toEqual([status, code]);
    }
  });
});

// ===========================================================================
// 7. THE PRIVACY CONTRACT - AN UNAUTHENTICATED ENDPOINT
// ===========================================================================

describe("the snapshot never carries user data", () => {
  /** Every key and every string value anywhere in the payload. */
  const walk = (node, keys = [], values = []) => {
    if (node === null || node === undefined) return { keys, values };
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, keys, values));
      return { keys, values };
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        keys.push(k);
        walk(v, keys, values);
      }
      return { keys, values };
    }
    if (typeof node === "string") values.push(node);
    return { keys, values };
  };

  test("no key names a user, a balance, a wallet or a secret", () => {
    const { keys } = walk(snapshot().body);
    const forbidden =
      /^(user|users|userId|email|wallet|wallets|balance|balances|addresses|assets|privateKey|token|secret|frozen|accounts)$/i;
    expect(keys.filter((k) => forbidden.test(k))).toEqual([]);
  });

  test("the ONE 'address' in the payload is a listen socket, never a chain address", () => {
    // `grpc.address` is deliberately present - it is what this process asked
    // the OS to bind, and it is how an operator spots a service pointed at the
    // wrong target. It is host:port and nothing else; a deposit address would
    // be user state and has no business in an unauthenticated payload.
    const { body } = snapshot();
    const addressed = Object.entries(body).filter(([, v]) => v && v.address !== undefined);
    expect(addressed.map(([k]) => k)).toEqual(["grpc"]);
    expect(body.grpc.address).toMatch(/^[\w.:[\]-]+:\d+$/);
    expect(body.grpc.address).not.toMatch(/^0x/i);
    expect(body.grpc.address).not.toMatch(/^paper-/);
  });

  test("no value looks like a mongo id, a key or an email", () => {
    const { values } = walk(snapshot().body);
    expect(values.filter((v) => /^[0-9a-f]{24}$/i.test(v))).toEqual([]);
    expect(values.filter((v) => /@/.test(v))).toEqual([]);
    expect(values.filter((v) => /^0x[0-9a-f]{16,}$/i.test(v))).toEqual([]);
  });

  test("the payload has exactly the top-level keys it is documented to have", () => {
    // A new key is not automatically wrong; it is a decision, and it has to be
    // made deliberately rather than by an accidental spread of a user document.
    expect(Object.keys(snapshot().body).sort()).toEqual(
      [
        "checkedAt",
        "dependencies",
        "grpc",
        "service",
        "standDownGuard",
        "status",
        "uptimeSeconds",
      ].sort()
    );
  });

  test("the snapshot is a pure function of its input - same input, same output", () => {
    expect(snapshot()).toEqual(snapshot());
  });

  test("it cannot be made to echo anything: unknown input keys are ignored", () => {
    const { body } = buildHealthSnapshot({
      ...WELL,
      email: "papersmoke1@test.com",
      userId: "6a70f1c287c92c7218ac37fc",
    });
    expect(JSON.stringify(body)).not.toMatch(/papersmoke1/);
    expect(JSON.stringify(body)).not.toMatch(/6a70f1c287c92c7218ac37fc/);
  });
});

// ===========================================================================
// 8. THE gRPC BIND RECORDER
// ===========================================================================

describe("lib/grpcHealth records what bindAsync actually reported", () => {
  test("a successful bind is bound, with the port the OS gave us", () => {
    resetGrpcBindState();
    recordGrpcBind({ address: "127.0.0.1:6002", port: 6002, error: null });
    const state = grpcServerState();
    expect(state.bound).toBe(true);
    expect(state.port).toBe(6002);
    expect(state.address).toBe("127.0.0.1:6002");
    expect(state.error).toBeNull();
  });

  test("PORT 0 IS A FAILURE, not a bind - grpc-js returns it when it could not bind", () => {
    resetGrpcBindState();
    recordGrpcBind({ address: "127.0.0.1:6002", port: 0, error: null });
    expect(grpcServerState().bound).toBe(false);
    // And the snapshot built from it refuses to call the service ready.
    expect(snapshot({ grpc: grpcServerState() }).httpCode).toBe(503);
  });

  test("an error is recorded as a message, never as an Error object on the wire", () => {
    resetGrpcBindState();
    recordGrpcBind({
      address: "127.0.0.1:6002",
      port: 0,
      error: new Error("EADDRINUSE"),
    });
    const state = grpcServerState();
    expect(state.bound).toBe(false);
    expect(state.error).toBe("EADDRINUSE");
    expect(JSON.parse(JSON.stringify(state)).error).toBe("EADDRINUSE");
  });

  test("before any bind has been reported, the server is NOT bound", () => {
    // The readiness window: express is listening and grpc/server.js has not
    // finished binding. Reporting "ready" here is how a caller gets routed into
    // a service that cannot answer it.
    resetGrpcBindState();
    expect(grpcServerState().bound).toBe(false);
    expect(grpcServerState().port).toBeNull();
  });

  test("the state cannot be mutated by a caller holding it", () => {
    resetGrpcBindState();
    recordGrpcBind({ address: "127.0.0.1:6002", port: 6002 });
    const held = grpcServerState();
    held.bound = false;
    held.port = 1;
    expect(grpcServerState().bound).toBe(true);
    expect(grpcServerState().port).toBe(6002);
  });

  test("a later failure overwrites an earlier success - the record is CURRENT, not historic", () => {
    resetGrpcBindState();
    recordGrpcBind({ address: "127.0.0.1:6002", port: 6002 });
    recordGrpcBind({ address: "127.0.0.1:6002", port: 0, error: new Error("gone") });
    expect(grpcServerState().bound).toBe(false);
  });
});
