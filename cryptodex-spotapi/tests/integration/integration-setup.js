/**
 * REAL INTEGRATION HARNESS FOR THE SPOT API.
 * ==========================================
 *
 * WHAT THIS REPLACES, AND WHY IT HAD TO BE REPLACED
 * -------------------------------------------------
 * The previous version of this file was a 517-line SECOND COPY OF THE API. It
 * imported no service code at all: it defined twelve express endpoints inside
 * the fixture (`app.post('/api/spot/orderPlace', ...)` and friends) that read
 * and wrote four in-memory `Map`s. Every "integration" assertion in
 * spot-api.integration.test.js therefore exercised the fixture and nothing
 * else. It was proven by mutation: DELETING the entire `/orderPlace` route from
 * routes/spot.route.js left the suite green, as did making
 * spot.controller.orderPlace return 500.
 *
 * This harness mounts THE SHIPPED CODE:
 *
 *   routes/spot.route.js  ->  the real router, with the real passport JWT
 *                             strategy from config/passport.js and the real
 *                             blockStoodDownAccount guard on the gated routes.
 *   controllers/spot.controller.js, validation/spotTrade.validation.js,
 *   lib/*, models/* -> untouched, real, and reached over real HTTP.
 *
 * WHAT IS STUBBED, AND WHY EACH ONE IS A GENUINE BOUNDARY
 * ------------------------------------------------------
 * Only things that leave this process are stubbed. Nothing that spotapi itself
 * implements is reimplemented here.
 *
 *   grpc/walletService.js        -> walletapi, a separate service on :3002.
 *   grpc/walletStandDownService.js -> walletapi's freeze check, same service.
 *   grpc/adminService.js         -> the admin service.
 *   grpc/currencyService.js      -> the currency/price-conversion service.
 *   grpc/userService.js          -> userapi on :2567.
 *   controllers/binance.controller.js + config/binance.js + lib/binanceWebSocket.js
 *                                -> the Binance REST/WS feed (the public
 *                                   internet).
 *   config/socketIO.js           -> the browser websocket fan-out. Emitting to
 *                                   nobody is not business logic; a real
 *                                   socket.io server would only add a listener
 *                                   nothing connects to.
 *   node-cron                    -> the process scheduler. spot.controller.js
 *                                   registers a 2s matcher cron AT MODULE
 *                                   SCOPE; letting it run would mutate the book
 *                                   underneath assertions.
 *
 * WHAT IS REAL
 * ------------
 *   mongo  -> mongodb-memory-server, real mongoose models, real queries.
 *   redis  -> THE REAL REDIS at 127.0.0.1:6379, on DB 15 with the key prefix
 *             `cryptodex_itest_`. Not a shim: controllers/redis.controller.js
 *             ships a Lua `hincrbyfloatIfEnough`, and the reservation in
 *             limitOrderPlace is that Lua script. A JS fake would test the
 *             fake. Live data is db 0 with the `cryptodex_` prefix, so the two
 *             cannot meet, and cleanup only ever deletes keys matching the test
 *             prefix (never FLUSHDB).
 *
 * ONE SERVER, NOT ONE PER REQUEST
 * -------------------------------
 * `request(app)` binds a fresh ephemeral listener for every call, which is the
 * documented cause of the ~1-in-20 ECONNRESET/EADDRINUSE flake this suite used
 * to show. A single long-lived server is bound to 127.0.0.1 in beforeAll and
 * handed to supertest, which reuses it.
 */

/* eslint-disable no-undef */

// --------------------------------------------------------------------------
// ENV, FIRST. config/index.js is read at module scope by redis.controller.js
// (which creates its client immediately), so these must be set before any
// service module is loaded. Nothing below imports service code statically.
// --------------------------------------------------------------------------
export const TEST_REDIS_PREFIX = "cryptodex_itest_";
export const TEST_REDIS_DB = 15;

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.REDIS_URL = `redis://127.0.0.1:6379/${TEST_REDIS_DB}`;
process.env.REDIS_PREFIX = TEST_REDIS_PREFIX;
process.env.RUN_CRON = "false";
// gRPC targets that must never resolve to a real service even if a stub is
// missed. Everything below is mocked, but a wrong address fails fast rather
// than talking to the running stack.
process.env.GRPC_WALLET_URL = "127.0.0.1:1";
process.env.GRPC_USER_URL = "127.0.0.1:1";
process.env.GRPC_URL = "127.0.0.1:1";

// --------------------------------------------------------------------------
// BOUNDARY STUBS. Hoisted by babel-plugin-jest-hoist above everything else in
// this module, and applied to the whole module registry of the test file that
// imports this harness.
// --------------------------------------------------------------------------
jest.mock("node-cron", () => ({
  __esModule: true,
  default: {
    schedule: () => ({ start() {}, stop() {} }),
    validate: () => true,
  },
  schedule: () => ({ start() {}, stop() {} }),
}));

jest.mock("../../config/socketIO.js", () => ({
  __esModule: true,
  createSocketIO: (() => {}),
  socketEmitOne: (() => {}),
  socketEmitAll: (() => {}),
  getSocketIO: (() => {}),
}));

jest.mock("../../config/binance.js", () => ({
  __esModule: true,
  nodeBinanceAPI: {
    websockets: { depthCache() {}, depth() {}, miniTicker() {}, trades() {}, candles() {}, terminate() {} },
    depth: async () => ({ bids: {}, asks: {} }),
    prices: async () => ({}),
  },
  binanceApiNode: { ws: { partialDepth() {}, depth() {}, ticker() {}, recentTrades() {}, chart() {}, terminate() {} } },
}));

jest.mock("../../lib/binanceWebSocket.js", () => ({
  __esModule: true,
  startBinanceWebSockets: (() => {}),
  setDepthListener: (() => {}),
  stopBinanceWebSockets: (() => {}),
  getDepthSnapshot: (() => null),
  getAllDepthSnapshots: (() => ({})),
}));

jest.mock("../../controllers/binance.controller.js", () => ({
  __esModule: true,
  orderPlace: (async () => ({ status: false, message: "binance stubbed" })),
  cancelOrder: (async () => ({ status: false })),
  recentTrade: (async () => ({ status: false, result: [] })),
  checkBalance: (async () => ({ status: false })),
  calculateMarkup: ((price) => price),
  liquidityMarkup: ((price) => price),
  spotOrderBookWS: (() => {}),
  spotTickerPriceWS: (() => {}),
  updateBinancePrices: (() => {}),
  updateChartData: (() => {}),
  checkOrder: (() => {}),
  getSpotPair: (async () => []),
  recentTradeWS: (() => {}),
  accountInfo: (async () => ({})),
  balanceInfo: (async () => ({})),
  orderStatus: (async () => ({ status: false })),
  checkStatus: (() => {}),
}));

jest.mock("../../grpc/walletService.js", () => ({
  __esModule: true,
  getUserAsset: (async () => ({ status: false, result: {} })),
  updateUserAsset: (async () => ({ status: true })),
  updateUserWallet: (async () => true),
  passbook: (async () => ({ status: true })),
}));

jest.mock("../../grpc/walletStandDownService.js", () => ({
  __esModule: true,
  // The real contract: { known, frozen }. `known:false` is a REFUSAL (503), so
  // the stub has to answer the way a reachable walletapi answers.
  checkWalletFrozen: (async () => ({ known: true, frozen: false })),
  __resetWalletStandDownClient: (() => {}),
  WALLET_STAND_DOWN_DESCRIPTOR: {},
}));

// `fetchAdmin` is no longer exported: it existed only for the `adminAuth`
// passport strategy guarding /api/admin, and both are gone with the admin
// router. `saveAdminprofit` stays - it books every maker/taker fee on the
// ordinary trading path and is nothing to do with the admin surface.
jest.mock("../../grpc/adminService.js", () => ({
  __esModule: true,
  saveAdminprofit: (async () => ({ status: true })),
}));

jest.mock("../../grpc/currencyService.js", () => ({
  __esModule: true,
  currencyId: (async () => ({ status: false })),
  currencySymbol: (async () => ({ status: false })),
  priceConversionGrpc: (async () => ({ status: true, convertPrice: 1 })),
}));

jest.mock("../../grpc/userService.js", () => ({
  __esModule: true,
  fetchUser: (async () => ({ status: false })),
  fetchBotUser: (async () => ({ status: false })),
  botUser: (async () => ({ status: false })),
}));

// --------------------------------------------------------------------------

import http from "http";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import redis from "redis";
import { promisify } from "util";

let mongoServer = null;
let server = null;
let rawRedis = null;
let redisScan = null;
let redisDel = null;

/** Loaded lazily so every jest.mock above is already in place. */
let realModules = null;

const loadRealModules = async () => {
  if (realModules) return realModules;
  const [spotRoute, passportCfg, configMod, models, cryptoJS, redisCtrl, spotCtrl] =
    await Promise.all([
      import("../../routes/spot.route.js"),
      import("../../config/passport.js"),
      import("../../config/index.js"),
      import("../../models/index.js"),
      import("../../lib/cryptoJS.js"),
      import("../../controllers/redis.controller.js"),
      import("../../controllers/spot.controller.js"),
    ]);
  realModules = {
    spotRouter: spotRoute.default,
    usersAuth: passportCfg.usersAuth,
    config: configMod.default,
    models,
    cryptoJS,
    redisCtrl,
    spotCtrl,
  };
  return realModules;
};

export const getRealModules = () => {
  if (!realModules) throw new Error("harness not started");
  return realModules;
};

/**
 * The raw redis handle used ONLY for test bookkeeping (seed + prefix-scoped
 * cleanup). Service code goes through controllers/redis.controller.js.
 */
const connectRawRedis = async () => {
  if (rawRedis) return rawRedis;
  rawRedis = redis.createClient({ url: process.env.REDIS_URL });
  rawRedis.on("error", () => {});
  await new Promise((resolve, reject) => {
    rawRedis.once("ready", resolve);
    rawRedis.once("error", reject);
  });
  if (Number(rawRedis.selected_db) !== TEST_REDIS_DB) {
    throw new Error(
      `refusing to run: redis selected db is ${rawRedis.selected_db}, expected ${TEST_REDIS_DB}`
    );
  }
  redisScan = promisify(rawRedis.scan).bind(rawRedis);
  redisDel = promisify(rawRedis.del).bind(rawRedis);
  return rawRedis;
};

/**
 * Delete only keys that start with the test prefix. FLUSHDB is deliberately
 * never used: if the db-select ever regressed, FLUSHDB would destroy live data
 * while a prefix scan simply finds nothing.
 */
const purgeTestKeys = async () => {
  if (!redisScan) return;
  if (!TEST_REDIS_PREFIX.startsWith("cryptodex_itest_")) {
    throw new Error("refusing to purge: test prefix is not the isolated one");
  }
  let cursor = "0";
  const keys = [];
  do {
    const [next, batch] = await redisScan(
      cursor,
      "MATCH",
      `${TEST_REDIS_PREFIX}*`,
      "COUNT",
      "500"
    );
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  if (keys.length) await redisDel(keys);
};

export async function startHarness() {
  await connectRawRedis();
  await purgeTestKeys();

  mongoServer = await MongoMemoryServer.create();
  process.env.DATABASE_URI = mongoServer.getUri("cryptodex_spot_itest");
  await mongoose.connect(process.env.DATABASE_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  const { spotRouter, usersAuth } = await loadRealModules();

  // The SAME wiring server.js uses: body parsers, passport with the real JWT
  // strategy, and the real router mounted at the real path.
  const express = (await import("express")).default;
  const passport = (await import("passport")).default;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(passport.initialize());
  // Only the users strategy now - spotapi no longer registers an admin one.
  usersAuth(passport);
  app.use("/api/spot", spotRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

export async function stopHarness() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  await purgeTestKeys();
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = null;
  }
  // The harness's own bookkeeping client. controllers/redis.controller.js
  // creates its client at module scope and exports no way to close it, which
  // is why jest.config.js sets `forceExit` - see the note there.
  if (rawRedis) {
    await new Promise((resolve) => rawRedis.quit(() => resolve()));
    rawRedis = null;
    redisScan = null;
    redisDel = null;
  }
}

export async function resetState() {
  await purgeTestKeys();
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

/** supertest bound to the ONE long-lived server (see the header note). */
export const api = () => {
  if (!server) throw new Error("harness not started");
  return request(server);
};

// --------------------------------------------------------------------------
// Seeding. Everything below writes only through the real models / the real
// redis controller, into the isolated test db + prefix.
// --------------------------------------------------------------------------

export const oid = () => new mongoose.Types.ObjectId();

/**
 * A pair with `botstatus: "off"`, i.e. one whose liquidity is real resting user
 * orders rather than the synthetic Binance paper ladder. That is deliberate:
 * lib/orderGate.js scopes the paper-ladder verdicts to `botstatus === "binance"`
 * only, so an "off" pair exercises the ordinary order path end to end without
 * needing a live depth feed.
 */
export async function seedPair(overrides = {}) {
  const { models, redisCtrl } = getRealModules();
  const firstCurrencyId = overrides.firstCurrencyId || oid();
  const secondCurrencyId = overrides.secondCurrencyId || oid();
  const doc = await models.SpotPair.create({
    tikerRoot: overrides.tikerRoot || "BTCUSDT",
    firstCurrencyId,
    firstCurrencySymbol: "BTC",
    firstFloatDigit: 8,
    secondCurrencyId,
    secondCurrencySymbol: "USDT",
    secondFloatDigit: 8,
    minPricePercentage: -90,
    maxPricePercentage: 100,
    minQuantity: 0.0001,
    maxQuantity: 100,
    minOrderValue: 1,
    maxOrderValue: 5000000,
    maker_rebate: 0.02,
    taker_fees: 0.05,
    markPrice: 50000,
    last: 50000,
    botstatus: "off",
    status: "active",
    ...overrides,
  });
  const lean = doc.toObject();
  await redisCtrl.hset("spotPairdata", lean._id.toString(), lean);
  return lean;
}

/**
 * A user the REAL passport strategy will accept: config/passport.js resolves a
 * bearer token by reading `userToken` out of redis and comparing `tokenId`, so
 * the fixture has to produce exactly that row. No auth middleware is faked.
 */
export async function seedUser(overrides = {}) {
  const { config, redisCtrl } = getRealModules();
  const userId = (overrides._id || oid()).toString();
  const tokenId = overrides.tokenId || `tok_${userId}`;
  const userDoc = {
    userLocked: "false",
    tokenId,
    userCode: overrides.userCode || `UC${userId.slice(-6)}`,
    type: overrides.type || "basic_verified",
    email: overrides.email || `itest_${userId}@example.com`,
    secret2FA: "",
    ...overrides.userDoc,
  };
  await redisCtrl.hset("userToken", userId, userDoc);
  const token = jwt.sign(
    { _id: userId, role: "user", tokenId },
    config.secretOrKey,
    { expiresIn: "1h" }
  );
  return { userId, tokenId, token, authHeader: `Bearer ${token}`, userDoc };
}

export async function setSpotBalance(userId, currencyId, amount) {
  const { redisCtrl } = getRealModules();
  await redisCtrl.hset(
    "walletbalance_spot",
    `${userId}_${currencyId}`,
    amount
  );
  // hset JSON-stringifies; the balance readers parse it back, and a bare
  // number round-trips through JSON unchanged.
}

export async function readSpotBalance(userId, currencyId) {
  const { redisCtrl } = getRealModules();
  const raw = await redisCtrl.hget("walletbalance_spot", `${userId}_${currencyId}`);
  return raw == null ? null : parseFloat(JSON.parse(raw));
}

export async function readInOrder(userId, currencyId) {
  const { redisCtrl } = getRealModules();
  const raw = await redisCtrl.hget(
    "walletbalance_spot_inOrder",
    `${userId}_${currencyId}`
  );
  return raw == null ? 0 : parseFloat(raw);
}

export async function readOpenOrders(side, pairId) {
  const { redisCtrl } = getRealModules();
  const all = await redisCtrl.hgetall(`${side}OpenOrders_${pairId}`);
  if (!all) return [];
  return Object.values(all).map((v) => (typeof v === "string" ? JSON.parse(v) : v));
}

/** The real client-side encryption the /orderPlace route decrypts. */
export function encryptOrder(payload) {
  const { cryptoJS } = getRealModules();
  return cryptoJS.encryptObject(payload);
}

/** Mark an account stood down through the hash standDownState.js reads. */
export async function markStoodDown(userId, mark = { frozen: true, reason: "test" }) {
  const { redisCtrl } = getRealModules();
  const lib = await import("../../lib/accountStandDown.js");
  await redisCtrl.hset(lib.STAND_DOWN_HASH, userId.toString(), mark);
}
