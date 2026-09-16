/**
 * SPOT TRADING API - REAL INTEGRATION TESTS
 * =========================================
 *
 * Every request below goes over real HTTP into routes/spot.route.js, through
 * the real passport JWT strategy, the real blockStoodDownAccount guard, the
 * real validation chain and the real controllers, against an in-memory mongo
 * and an isolated real redis. See tests/integration/integration-setup.js for
 * what is stubbed (only things that leave this process) and why.
 *
 * The bar these have to clear: DELETING the /orderPlace route, or making
 * spot.controller.orderPlace return 500, must turn this file red.
 */

import {
  startHarness,
  stopHarness,
  resetState,
  api,
  seedPair,
  seedUser,
  setSpotBalance,
  readSpotBalance,
  readInOrder,
  readOpenOrders,
  encryptOrder,
  markStoodDown,
  getRealModules,
  oid,
} from "./integration-setup.js";

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";

jest.setTimeout(120000);

describe("Spot Trading API Integration (real router + real controllers)", () => {
  let pair;
  let user;

  beforeAll(async () => {
    await startHarness();
  });

  afterAll(async () => {
    await stopHarness();
  });

  beforeEach(async () => {
    await resetState();
    pair = await seedPair();
    user = await seedUser();
    // The quote side funds buys, the base side funds sells.
    await setSpotBalance(user.userId, pair.secondCurrencyId, 1000000);
    await setSpotBalance(user.userId, pair.firstCurrencyId, 10);
  });

  const placeOrder = (payload, auth = user) =>
    api()
      .post("/api/spot/orderPlace")
      .set("Authorization", auth.authHeader)
      .send({ token: encryptOrder(payload) });

  const limitBuy = (overrides = {}) => ({
    spotPairId: pair._id.toString(),
    orderType: "limit",
    buyorsell: "buy",
    price: 45000,
    quantity: 0.01,
    ...overrides,
  });

  // ------------------------------------------------------------------
  // The route table itself. If a route is deleted from spot.route.js the
  // request 404s here, which is the whole point.
  // ------------------------------------------------------------------
  describe("route surface", () => {
    test("POST /api/spot/orderPlace is mounted and reachable", async () => {
      const res = await placeOrder(limitBuy());
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
    });

    test("POST /api/spot/orderPlace requires a bearer token", async () => {
      const res = await api()
        .post("/api/spot/orderPlace")
        .send({ token: encryptOrder(limitBuy()) });
      expect(res.status).toBe(401);
    });

    test("POST /api/spot/orderPlace rejects a token that names no session", async () => {
      const stranger = await seedUser();
      // Drop the userToken row the real strategy looks up.
      const { redisCtrl } = getRealModules();
      await redisCtrl.hdel("userToken", stranger.userId);
      const res = await api()
        .post("/api/spot/orderPlace")
        .set("Authorization", stranger.authHeader)
        .send({ token: encryptOrder(limitBuy()) });
      expect(res.status).toBe(401);
    });
  });

  // ------------------------------------------------------------------
  // POST /api/spot/orderPlace - the validation chain that really runs
  // ------------------------------------------------------------------
  describe("POST /api/spot/orderPlace validation (real spotTrade.validation.js)", () => {
    test("a missing encrypted token is refused by decryptValidate", async () => {
      const res = await api()
        .post("/api/spot/orderPlace")
        .set("Authorization", user.authHeader)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual({ token: "REQUIRED" });
    });

    test("ciphertext that does not decrypt is refused by decryptTradeOrder", async () => {
      const res = await api()
        .post("/api/spot/orderPlace")
        .set("Authorization", user.authHeader)
        .send({ token: "not-real-ciphertext" });
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual({ token: "INVALID" });
    });

    test("stop_limit is refused as UNSUPPORTED_ORDER_TYPE, not INVALID", async () => {
      const res = await placeOrder(limitBuy({ orderType: "stop_limit" }));
      expect(res.status).toBe(400);
      expect(res.body.errors.orderType).toBe("UNSUPPORTED_ORDER_TYPE");
    });

    test("a nonsense order type is INVALID_ORDER_TYPE", async () => {
      const res = await placeOrder(limitBuy({ orderType: "banana" }));
      expect(res.status).toBe(400);
      expect(res.body.errors.orderType).toBe("INVALID_ORDER_TYPE");
    });

    test("a non-numeric price is refused with the numeric message", async () => {
      const res = await placeOrder(limitBuy({ price: "12abc" }));
      expect(res.status).toBe(400);
      expect(res.body.errors.price).toBe("Price Value only numeric value");
    });

    test("a side that is neither buy nor sell is refused", async () => {
      const res = await placeOrder(limitBuy({ buyorsell: "sideways" }));
      expect(res.status).toBe(400);
      expect(res.body.errors.buyorsell).toBe("INVALID SIDE");
    });
  });

  // ------------------------------------------------------------------
  // POST /api/spot/orderPlace - the money path
  // ------------------------------------------------------------------
  describe("POST /api/spot/orderPlace (real limitOrderPlace)", () => {
    test("a limit buy is accepted, debits the quote wallet and rests in redis", async () => {
      const before = await readSpotBalance(user.userId, pair.secondCurrencyId);

      const res = await placeOrder(limitBuy({ price: 45000, quantity: 0.01 }));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(true);

      const orderValue = 45000 * 0.01;
      const after = await readSpotBalance(user.userId, pair.secondCurrencyId);
      // The reservation is the Lua hincrbyfloatIfEnough in redis.controller.js.
      expect(after).toBeCloseTo(before - orderValue, 6);
      expect(await readInOrder(user.userId, pair.secondCurrencyId)).toBeCloseTo(
        orderValue,
        6
      );

      const resting = await readOpenOrders("buy", pair._id);
      expect(resting).toHaveLength(1);
      expect(resting[0]).toMatchObject({
        userId: user.userId,
        buyorsell: "buy",
        orderType: "limit",
        price: 45000,
        quantity: 0.01,
        status: "open",
        inOrderReserved: orderValue,
      });
      // The role stamped at acceptance, from lib/liquidityRole.js.
      expect(["maker", "taker"]).toContain(resting[0].liquidityRole);

      // And the order history row the real controller writes to mongo.
      const { models } = getRealModules();
      const histCount = await models.OrderHistory.countDocuments({
        userId: user.userId,
      });
      expect(histCount).toBe(1);
    });

    test("a limit sell reserves the BASE currency, not the quote", async () => {
      const beforeBase = await readSpotBalance(user.userId, pair.firstCurrencyId);
      const beforeQuote = await readSpotBalance(user.userId, pair.secondCurrencyId);

      const res = await placeOrder(
        limitBuy({ buyorsell: "sell", price: 55000, quantity: 0.02 })
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(true);
      expect(await readSpotBalance(user.userId, pair.firstCurrencyId)).toBeCloseTo(
        beforeBase - 0.02,
        8
      );
      expect(
        await readSpotBalance(user.userId, pair.secondCurrencyId)
      ).toBeCloseTo(beforeQuote, 8);
      expect(await readOpenOrders("sell", pair._id)).toHaveLength(1);
    });

    test("an order larger than the wallet is refused and moves nothing", async () => {
      await setSpotBalance(user.userId, pair.secondCurrencyId, 100);
      const res = await placeOrder(limitBuy({ price: 45000, quantity: 0.01 }));

      expect(res.status).toBe(400);
      expect(res.body.status).toBe(false);
      expect(res.body.message).toMatch(/insufficient balance/i);
      expect(await readSpotBalance(user.userId, pair.secondCurrencyId)).toBe(100);
      expect(await readOpenOrders("buy", pair._id)).toHaveLength(0);
    });

    test("a quantity under the pair minimum is refused by the pair rules", async () => {
      const res = await placeOrder(limitBuy({ quantity: 0.00001 }));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/must not be lesser than/i);
      expect(await readOpenOrders("buy", pair._id)).toHaveLength(0);
    });

    test("a price outside the pair's percentage band is refused", async () => {
      // markPrice 50000, maxPricePercentage +100 -> ceiling 100000.
      const res = await placeOrder(limitBuy({ price: 250000, quantity: 0.001 }));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/must not be higher than/i);
    });

    test("an unknown pair id is refused", async () => {
      const res = await placeOrder(limitBuy({ spotPairId: oid().toString() }));
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Invalid Pair");
    });

    test("an inactive pair is refused", async () => {
      const { models, redisCtrl } = getRealModules();
      await models.SpotPair.updateOne({ _id: pair._id }, { $set: { status: "deactive" } });
      await redisCtrl.hset("spotPairdata", pair._id.toString(), {
        ...pair,
        status: "deactive",
      });
      const res = await placeOrder(limitBuy());
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Pair is not activated");
    });

    test("a stood-down account is refused with 423 before anything is debited", async () => {
      await markStoodDown(user.userId);
      const before = await readSpotBalance(user.userId, pair.secondCurrencyId);

      const res = await placeOrder(limitBuy());

      expect(res.status).toBe(423);
      expect(res.body.reason).toBe("ACCOUNT_STOOD_DOWN");
      expect(res.body.status).toBe(false);
      expect(await readSpotBalance(user.userId, pair.secondCurrencyId)).toBe(before);
      expect(await readOpenOrders("buy", pair._id)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------
  describe("GET /api/spot/tradePair (real getPairList)", () => {
    test("returns the seeded pair from the real pair cache", async () => {
      const res = await api().get("/api/spot/tradePair");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const ids = res.body.result.map((p) => String(p._id));
      expect(ids).toContain(pair._id.toString());
    });
  });

  describe("GET /api/spot/openOrder/:pairId (real getOpenOrder)", () => {
    test("lists the caller's resting order and nobody else's", async () => {
      await placeOrder(limitBuy());

      const other = await seedUser();
      await setSpotBalance(other.userId, pair.secondCurrencyId, 1000000);
      await placeOrder(limitBuy({ price: 44000 }), other);

      const res = await api()
        .get(`/api/spot/openOrder/${pair._id}`)
        .set("Authorization", user.authHeader);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result.data.length).toBe(1);
      expect(res.body.result.data[0].userId).toBe(user.userId);
    });

    test("requires authentication", async () => {
      const res = await api().get(`/api/spot/openOrder/${pair._id}`);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/spot/cancelOrder (real cancelOrder)", () => {
    test("cancelling a resting buy refunds the exact reservation", async () => {
      const before = await readSpotBalance(user.userId, pair.secondCurrencyId);
      await placeOrder(limitBuy({ price: 45000, quantity: 0.01 }));
      const [resting] = await readOpenOrders("buy", pair._id);
      expect(resting).toBeTruthy();

      const res = await api()
        .post("/api/spot/cancelOrder")
        .set("Authorization", user.authHeader)
        .send({
          id: encryptOrder({
            tableId: `buyOpenOrders_${pair._id}`,
            orderId: resting._id,
          }),
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(true);
      expect(
        await readSpotBalance(user.userId, pair.secondCurrencyId)
      ).toBeCloseTo(before, 6);
      expect(await readOpenOrders("buy", pair._id)).toHaveLength(0);
      expect(await readInOrder(user.userId, pair.secondCurrencyId)).toBeCloseTo(0, 6);
    });

    test("another user cannot cancel - and the order stays put", async () => {
      await placeOrder(limitBuy());
      const [resting] = await readOpenOrders("buy", pair._id);
      const other = await seedUser();

      const res = await api()
        .post("/api/spot/cancelOrder")
        .set("Authorization", other.authHeader)
        .send({
          id: encryptOrder({
            tableId: `buyOpenOrders_${pair._id}`,
            orderId: resting._id,
          }),
        });

      expect(res.status).toBe(400);
      expect(await readOpenOrders("buy", pair._id)).toHaveLength(1);
    });

    test("a tableId that is not an open-order hash is refused", async () => {
      const res = await api()
        .post("/api/spot/cancelOrder")
        .set("Authorization", user.authHeader)
        .send({
          id: encryptOrder({
            tableId: `orderHistory_${user.userId}`,
            orderId: "whatever",
          }),
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Order not found");
    });

    test("a cancel is NOT blocked by a stand-down (releasing a reservation is always allowed)", async () => {
      await placeOrder(limitBuy());
      const [resting] = await readOpenOrders("buy", pair._id);
      await markStoodDown(user.userId);

      const res = await api()
        .post("/api/spot/cancelOrder")
        .set("Authorization", user.authHeader)
        .send({
          id: encryptOrder({
            tableId: `buyOpenOrders_${pair._id}`,
            orderId: resting._id,
          }),
        });

      expect(res.status).toBe(200);
      expect(await readOpenOrders("buy", pair._id)).toHaveLength(0);
    });
  });

  describe("GET /api/spot/ordeBook/:pairId (real orderBookData)", () => {
    test("an 'off' pair reports a book with an explicit health verdict", async () => {
      const res = await api().get(`/api/spot/ordeBook/${pair._id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result).toHaveProperty("healthy");
      expect(res.body.result).toHaveProperty("buyOrder");
      expect(res.body.result).toHaveProperty("sellOrder");
    });

    test("an unknown pair still answers a shaped, unhealthy book rather than throwing", async () => {
      const res = await api().get(`/api/spot/ordeBook/${oid()}`);
      expect(res.status).toBe(200);
      expect(res.body.result.healthy).toBe(false);
    });
  });

  describe("GET /api/spot/marketPrice/:pairId (real getMarketPrice)", () => {
    test("answers with a priced result for a known pair", async () => {
      const res = await api().get(`/api/spot/marketPrice/${pair._id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result).toHaveProperty("markPrice");
    });
  });

  describe("POST /api/spot/depth-chart (real getDepthData)", () => {
    test("answers for a known pair", async () => {
      // The real controller reads `id`, not `pairId`.
      const res = await api()
        .post("/api/spot/depth-chart")
        .send({ id: pair._id.toString() });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test("an id that is not an ObjectId is answered, not hung", async () => {
      const res = await api().post("/api/spot/depth-chart").send({ id: "nope" });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Invalid pair id");
    });

    test("an unknown pair is refused", async () => {
      const res = await api()
        .post("/api/spot/depth-chart")
        .send({ id: oid().toString() });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Pair not found");
    });
  });

  describe("GET /api/spot/recentTrade/:pairId (real getRecentTrade)", () => {
    test("answers for a known pair", async () => {
      const res = await api().get(`/api/spot/recentTrade/${pair._id}`);
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/spot/health (real fillCanary healthCheck)", () => {
    test("is unauthenticated and reports system state", async () => {
      const res = await api().get("/api/spot/health");
      expect([200, 503]).toContain(res.status);
      expect(res.body).toBeDefined();
    });
  });
});
