/**
 * WALLET API INTEGRATION TESTS
 * ============================
 *
 * Every request below travels the SHIPPED stack: the real router from
 * routes/wallet.route.js, the real passport JWT strategy from
 * config/passport.js, the real validators from validation/wallet.validation.js,
 * the real handlers in controllers/wallet.controller.js, the real libraries
 * they delegate to (lib/walletBalance.js, lib/walletStandDown.js,
 * lib/spotMirror.js, lib/currencyDecimals.js), the real mongoose models and
 * the real redis client. See tests/integration/integration-setup.js for what is
 * stubbed (only gRPC to other services and the Binance client) and why.
 *
 * The previous version of this file asserted against seven express endpoints
 * defined inside the fixture. Nothing here can pass unless the service's own
 * code produces the answer.
 */

/* eslint-disable no-undef */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "@jest/globals";
import mongoose from "mongoose";
import {
  startHarness,
  stopHarness,
  resetState,
  api,
  oid,
  seedUser,
  signOrphanToken,
  seedCurrency,
  seedRawCurrency,
  seedWallet,
  seedFundedAccount,
  setLedger,
  readLedger,
  markStoodDown,
  freezeWalletDoc,
  readPassbook,
  readTransactions,
  getRealModules,
} from "./integration-setup.js";

jest.setTimeout(60000);

beforeAll(async () => {
  await startHarness();
});

afterAll(async () => {
  await stopHarness();
});

beforeEach(async () => {
  await resetState();
});

// ---------------------------------------------------------------------------
// AUTHENTICATION - config/passport.js, not a fixture middleware.
// ---------------------------------------------------------------------------
describe("authentication (real passport usersAuth strategy)", () => {
  test("a request with no Authorization header is rejected", async () => {
    const res = await api().get("/api/wallet/getAssetsDetails");
    expect(res.status).toBe(401);
  });

  test("a garbage bearer token is rejected", async () => {
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", "Bearer not-a-jwt");
    expect(res.status).toBe(401);
  });

  test("a token signed with the wrong secret is rejected", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const bad = jwt.sign(
      { _id: oid().toString(), role: "user", tokenId: "x" },
      "definitely-not-the-service-secret"
    );
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  test("a correctly signed token with no redis session row is rejected", async () => {
    // The strategy resolves the session out of the `userToken` hash. A token
    // that never had a session (or whose session was revoked) must not pass
    // merely because its signature verifies.
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", `Bearer ${signOrphanToken()}`);
    expect(res.status).toBe(401);
  });

  test("a token whose tokenId no longer matches the session is rejected", async () => {
    const user = await seedUser();
    const { config, redisCtrl } = getRealModules();
    // Simulate a re-login elsewhere: the session row now carries a new tokenId.
    await redisCtrl.hset("userToken", user.userId, {
      ...user.userDoc,
      tokenId: "rotated",
    });
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", user.authHeader);
    expect(res.status).toBe(401);
    expect(config.secretOrKey).toBeTruthy();
  });

  test("a locked account is rejected even with a current token", async () => {
    const user = await seedUser({ userDoc: { userLocked: "true" } });
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", user.authHeader);
    expect(res.status).toBe(401);
  });

  test("a token with a non-user role is rejected", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const { config } = getRealModules();
    const user = await seedUser();
    const adminish = jwt.sign(
      { _id: user.userId, role: "admin", tokenId: user.tokenId },
      config.secretOrKey
    );
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", `Bearer ${adminish}`);
    expect(res.status).toBe(401);
  });

  test("a current token on a live session is accepted", async () => {
    const { user } = await seedFundedAccount();
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", user.authHeader);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/wallet/getAssetsDetails - walletCtrl.getWallet
// ---------------------------------------------------------------------------
describe("GET /api/wallet/getAssetsDetails", () => {
  test("a user with no wallet document gets 400, not an empty list", async () => {
    const user = await seedUser();
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", user.authHeader);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("balances come from redis, not from the mongo mirror", async () => {
    // The redis hash is the ENGINE field and the authority while the engines
    // run; wallet.assets[].spotBal is a mirror the cron refreshes. A read that
    // answered from mongo would report the stale number.
    const { user, currency } = await seedFundedAccount({ spot: 1234.5 });
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", user.authHeader);

    expect(res.status).toBe(200);
    const asset = res.body.result.find((a) => a.coin === currency.coin);
    expect(asset).toBeDefined();
    expect(parseFloat(asset.spotBal)).toBe(1234.5);
  });

  test("the spot free/locked split is reported, not just the gross pot", async () => {
    // lib/walletBalance.js: `spotBal` is the whole pot and already includes
    // whatever a resting order has reserved, so on its own it names a number
    // the user cannot move.
    const { user, currency } = await seedFundedAccount({
      spot: 100,
      spotLocked: 30,
    });
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", user.authHeader);

    const asset = res.body.result.find((a) => a.coin === currency.coin);
    expect(parseFloat(asset.spotBal)).toBe(100);
    expect(parseFloat(asset.spotLockedBal)).toBe(30);
    expect(asset.spotBalAvailable).toBe(70);
  });

  test("a reservation larger than the pot never reports a negative free balance", async () => {
    const { user, currency } = await seedFundedAccount({
      spot: 5,
      spotLocked: 12,
    });
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", user.authHeader);
    const asset = res.body.result.find((a) => a.coin === currency.coin);
    expect(asset.spotBalAvailable).toBe(0);
  });

  test("a first-touch account reports numbers, never null or NaN", async () => {
    // The seeding branches used to assign the RETURN of hset (undefined), so a
    // fresh account came back with balance fields missing or explicitly null -
    // which the client turned into NaN.
    const user = await seedUser();
    const currency = await seedCurrency({ coin: "BTC", symbol: "BTC" });
    await seedWallet({
      userId: user.userId,
      userCode: user.userDoc.userCode,
      currencies: [currency],
    });

    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", user.authHeader);
    const asset = res.body.result.find((a) => a.coin === "BTC");

    for (const field of ["spotBal", "spotLockedBal"]) {
      expect(asset[field]).not.toBeNull();
      expect(asset[field]).not.toBeUndefined();
      expect(Number.isNaN(parseFloat(asset[field]))).toBe(false);
    }
    expect(asset.spotBalAvailable).toBe(0);
  });

  test("every asset carries a usable displayDecimals so no client has to join the currency list", async () => {
    const user = await seedUser();
    // The shape this deployment actually has: inserted straight into the
    // collection, so `contractDecimal` is ABSENT and only `decimals` is set.
    const eth = await seedRawCurrency({ coin: "ETH", symbol: "ETH", decimals: 18 });
    const usdc = await seedRawCurrency({ coin: "USDC", symbol: "USDC", decimals: 6 });
    const usd = await seedRawCurrency({
      coin: "USD",
      symbol: "USD",
      type: "fiat",
      decimals: 2,
    });
    await seedWallet({
      userId: user.userId,
      userCode: user.userDoc.userCode,
      currencies: [eth, usdc, usd],
    });

    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", user.authHeader);
    const byCoin = Object.fromEntries(res.body.result.map((a) => [a.coin, a]));

    // 18 on-chain places are true and useless on screen; capped at 8.
    expect(byCoin.ETH.displayDecimals).toBe(8);
    expect(byCoin.USDC.displayDecimals).toBe(6);
    expect(byCoin.USD.displayDecimals).toBe(2);
    for (const coin of ["ETH", "USDC", "USD"]) {
      expect(Number.isInteger(byCoin[coin].displayDecimals)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/wallet/getAsset/:currencyId - walletCtrl.getAssetByCurrency
// ---------------------------------------------------------------------------
describe("GET /api/wallet/getAsset/:currencyId", () => {
  test("answers the single asset with its free/locked split", async () => {
    const { user, currency } = await seedFundedAccount({
      spot: 40,
      spotLocked: 15,
    });
    const res = await api()
      .get(`/api/wallet/getAsset/${currency._id}`)
      .set("Authorization", user.authHeader);

    expect(res.status).toBe(200);
    expect(parseFloat(res.body.result.spotBal)).toBe(40);
    expect(parseFloat(res.body.result.spotBalLocked)).toBe(15);
    expect(res.body.result.spotBalAvailable).toBe(25);
  });

  test("a user with no wallet gets 400", async () => {
    const user = await seedUser();
    const res = await api()
      .get(`/api/wallet/getAsset/${oid()}`)
      .set("Authorization", user.authHeader);
    expect(res.status).toBe(400);
  });

  test("is unauthenticated-proof", async () => {
    const res = await api().get(`/api/wallet/getAsset/${oid()}`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/wallet/transfer - CLOSED (controllers/wallet.controller.js)
//
// This replaces five describe blocks: request validation, balance movement,
// "only free balance may leave", an open-position refusal, and the audit
// trail. All five described a feature that no longer exists.
//
// `spot` is the only pot this venue has, so there is no surviving (from, to)
// pair. The endpoint answers 410 and touches nothing.
//
// The STAND-DOWN GUARD block below is deliberately kept and still passes: the
// guards run BEFORE the handler, so a frozen wallet is still refused by the
// freeze rather than by the closure, and that ordering is the property worth
// keeping - the day anyone re-opens this route the guards are already on it.
// ---------------------------------------------------------------------------
describe("POST /api/wallet/transfer - closed", () => {
  const post = (user, body) =>
    api().post("/api/wallet/transfer").set("Authorization", user.authHeader).send(body);

  test("refuses a well-formed transfer with 410 and moves nothing", async () => {
    const { user, currency, userAssetId } = await seedFundedAccount({ spot: 100 });

    const res = await post(user, {
      fromType: "spot",
      toType: "elsewhere",
      userAssetId,
      amount: 10,
    });

    expect(res.status).toBe(410);
    expect(res.body.code).toBe("WALLET_TRANSFER_CLOSED");
    expect(res.body.success).toBe(false);
    // The pot is exactly where it was.
    expect(await readLedger("walletbalance_spot", user.userId, currency._id)).toBe(100);
  });

  test("refuses every shape, including ones the old validator rejected", async () => {
    const { user, userAssetId } = await seedFundedAccount({ spot: 100 });
    for (const body of [
      { fromType: "spot", toType: "spot", userAssetId, amount: 1 },
      { fromType: "spot", toType: "elsewhere", userAssetId, amount: 1 },
      { fromType: "spot", toType: "elsewhere", userAssetId, amount: -1 },
      { fromType: "nonsense", toType: "spot", userAssetId, amount: 1 },
      {},
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(user, body);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe("WALLET_TRANSFER_CLOSED");
    }
  });

  test("writes no Transaction row", async () => {
    const { user, userAssetId } = await seedFundedAccount({ spot: 100 });
    await post(user, {
      fromType: "spot",
      toType: "elsewhere",
      userAssetId,
      amount: 10,
    });

    const { models } = getRealModules();
    expect(await models.Transaction.countDocuments({ userId: user.userId })).toBe(0);
  });

  test("still requires a login - the refusal is not an unauthenticated probe", async () => {
    const res = await api()
      .post("/api/wallet/transfer")
      .send({ fromType: "spot", toType: "elsewhere", userAssetId: "x", amount: "1" });
    expect(res.status).toBe(401);
  });
});


// ---------------------------------------------------------------------------
// POST /api/wallet/transfer - lib/walletStandDown.js via walletCtrl.blockFrozenWallet
// ---------------------------------------------------------------------------
describe("POST /api/wallet/transfer - stand-down guard", () => {
  const post = (user, body) =>
    api().post("/api/wallet/transfer").set("Authorization", user.authHeader).send(body);

  test("a wallet frozen by this service refuses with 423 and moves nothing", async () => {
    const { user, currency, userAssetId } = await seedFundedAccount({ spot: 100 });
    await freezeWalletDoc(user.userId);

    const res = await post(user, {
      fromType: "spot",
      toType: "elsewhere",
      userAssetId,
      amount: 10,
    });
    expect(res.status).toBe(423);
    expect(res.body.status).toBe("WALLET_STOOD_DOWN");
    expect(await readLedger("walletbalance_spot", user.userId, currency._id)).toBe(100);
  });

  test("a stand-down mark in redis refuses too - the mark-only hole", async () => {
    // The guard used to read only `wallet.frozen`, so an account stood down
    // through the shared redis mark alone was refused by every trading service
    // and let through by the one that holds the balances.
    const { user, currency, userAssetId } = await seedFundedAccount({ spot: 100 });
    await markStoodDown(user.userId);

    const res = await post(user, {
      fromType: "spot",
      toType: "elsewhere",
      userAssetId,
      amount: 10,
    });
    expect(res.status).toBe(423);
    expect(await readLedger("walletbalance_spot", user.userId, currency._id)).toBe(100);
  });

  test("an unreadable mark fails CLOSED with 503, it does not pass", async () => {
    // A corrupt row is not evidence the account is live. Written as a bare
    // string so it cannot parse to a record.
    const { user, currency, userAssetId } = await seedFundedAccount({ spot: 100 });
    const { redisCtrl, standDownLib } = getRealModules();
    await redisCtrl.hset(standDownLib.STAND_DOWN_HASH, user.userId, "!!truncated");
    // hset JSON-stringifies, so the stored value is `"\"!!truncated\""`, which
    // parses to a bare string - exactly the "not an object" corrupt case.
    const res = await post(user, {
      fromType: "spot",
      toType: "elsewhere",
      userAssetId,
      amount: 10,
    });
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("WALLET_STATE_UNKNOWN");
    expect(await readLedger("walletbalance_spot", user.userId, currency._id)).toBe(100);
  });

  test("an explicitly live mark ({frozen:false}) is allowed through", async () => {
    // `blockFrozenWallet` runs BEFORE the controller, so "allowed through" is
    // still observable here even though transfer itself now answers 410
    // WALLET_TRANSFER_CLOSED for everyone: reaching the 410 means the guard did
    // not refuse. A frozen account never gets this far - its siblings above
    // assert 423 - so the contrast this test exists for is intact.
    const { user, userAssetId } = await seedFundedAccount({ spot: 100 });
    await markStoodDown(user.userId, { frozen: false });
    const res = await post(user, {
      fromType: "spot",
      toType: "elsewhere",
      userAssetId,
      amount: 10,
    });
    expect(res.status).toBe(410);
    expect(res.status).not.toBe(423);
  });

  test("the guard is NOT on the read routes - a frozen account can still see its portfolio", async () => {
    const { user } = await seedFundedAccount({ spot: 100 });
    await freezeWalletDoc(user.userId);
    const res = await api()
      .get("/api/wallet/getAssetsDetails")
      .set("Authorization", user.authHeader);
    expect(res.status).toBe(200);
  });
});





// ---------------------------------------------------------------------------
// GET /api/currency/getCurrency - routes/currency.route.js, the real aggregate
// and lib/currencyDecimals.js.
// ---------------------------------------------------------------------------
describe("GET /api/currency/getCurrency", () => {
  test("is public and answers the list", async () => {
    await seedRawCurrency({ coin: "BTC", symbol: "BTC", decimals: 8 });
    const res = await api().get("/api/currency/getCurrency");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.result)).toBe(true);
    expect(res.body.result).toHaveLength(1);
  });

  test("every row carries a whole-number displayDecimals in [0, 8]", async () => {
    await seedRawCurrency({ coin: "ETH", symbol: "ETH", decimals: 18 });
    await seedRawCurrency({ coin: "SOL", symbol: "SOL", decimals: 9 });
    await seedRawCurrency({ coin: "USDC", symbol: "USDC", decimals: 6 });
    await seedRawCurrency({ coin: "USD", symbol: "USD", type: "fiat", decimals: 2 });

    const res = await api().get("/api/currency/getCurrency");
    const byCoin = Object.fromEntries(res.body.result.map((c) => [c.coin, c]));

    expect(byCoin.ETH.displayDecimals).toBe(8);
    expect(byCoin.SOL.displayDecimals).toBe(8);
    expect(byCoin.USDC.displayDecimals).toBe(6);
    expect(byCoin.USD.displayDecimals).toBe(2);
    for (const row of res.body.result) {
      expect(Number.isInteger(row.displayDecimals)).toBe(true);
      expect(row.displayDecimals).toBeGreaterThanOrEqual(0);
      expect(row.displayDecimals).toBeLessThanOrEqual(8);
    }
  });

  test("contractDecimal is backfilled when the document never carried one", async () => {
    // The whole reported symptom: the aggregate projected a field that was not
    // in the document, so the transfer modal's `type=='token' ? decimals :
    // contractDecimal` branch landed on undefined and rendered blank.
    await seedRawCurrency({ coin: "USDC", symbol: "USDC", decimals: 6 });
    const res = await api().get("/api/currency/getCurrency");
    const usdc = res.body.result.find((c) => c.coin === "USDC");
    expect(usdc.contractDecimal).toBe(6);
    expect(usdc.contractDecimal).not.toBeUndefined();
  });

  test("a token reads its ON-CHAIN decimals, capped for display", async () => {
    await seedRawCurrency({
      coin: "SHIB",
      symbol: "SHIB",
      type: "token",
      decimals: 18,
      contractDecimal: 4,
    });
    const res = await api().get("/api/currency/getCurrency");
    const shib = res.body.result.find((c) => c.coin === "SHIB");
    // type "token" -> `decimals` is authoritative; 18 capped to 8.
    expect(shib.displayDecimals).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Route surface. These pin the ROUTER, not any one handler: a route that is
// deleted stops existing, and express answers 404.
// ---------------------------------------------------------------------------
describe("routes/wallet.route.js - the mounted surface", () => {
  const authedRoutes = [
    ["get", "/api/wallet/getAssetsDetails"],
    ["post", "/api/wallet/transfer"],
  ];

  // CUSTODY IS DELETED. /userDeposit, /getWithdrawLimit, /createAddress,
  // /coinWithdraw, /coinWithdraw-app, /fiatWithdraw, /fiatDeposit and
  // /fireblocksWebhook moved real money on a venue that holds none, and the
  // operator approve/reject workflow that completed them went with the admin
  // panel. They must now 404 - the same answer this file's control case gets
  // for a path that was never mounted at all.
  const deletedRoutes = [
    // Portfolio analytics for a dashboard page this venue does not have.
    ["get", "/api/wallet/recentTransaction"],
    ["get", "/api/wallet/getDashBal"],
    ["get", "/api/dashboard/TotalBalance"],
    ["get", "/api/dashboard/AssetsAllocation"],
    ["get", "/api/dashboard/TotalBalanceChart"],
    ["get", "/api/dashboard/profitLoss"],
    ["get", "/api/wallet/userDeposit"],
    ["get", "/api/wallet/getWithdrawLimit"],
    ["post", "/api/wallet/createAddress"],
    ["post", "/api/wallet/coinWithdraw"],
    ["post", "/api/wallet/coinWithdraw-app"],
    ["post", "/api/wallet/fiatWithdraw"],
    ["post", "/api/wallet/fiatDeposit"],
    ["post", "/api/wallet/fireblocksWebhook"],
  ];

  test.each(deletedRoutes)("%s %s is gone, not merely refusing", async (method, path) => {
    const res = await api()[method](path);
    expect(res.status).toBe(404);
  });

  test.each(authedRoutes)(
    "%s %s exists and is behind authentication",
    async (method, path) => {
      const res = await api()[method](path);
      // 401 proves BOTH: the route is mounted (a missing one 404s) and the
      // passport guard is the first thing on it.
      expect(res.status).toBe(401);
    }
  );

  test("a path that was never mounted 404s - so the 401s above mean something", async () => {
    const res = await api().get("/api/wallet/thisRouteDoesNotExist");
    expect(res.status).toBe(404);
  });

  test("the removed unauthenticated debug endpoint stays removed", async () => {
    const res = await api().post("/api/wallet/testRoute").send({ any: "thing" });
    expect(res.status).toBe(404);
  });
});
