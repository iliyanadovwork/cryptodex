/**
 * REAL INTEGRATION HARNESS FOR THE WALLET API.
 * ============================================
 *
 * WHAT THIS REPLACES, AND WHY IT HAD TO BE REPLACED
 * -------------------------------------------------
 * The previous version of this file was a 381-line SECOND COPY OF THE API. It
 * imported no service code at all. It redeclared `AssetsSchema`, `WalletSchema`
 * and `CurrencySchema` INSIDE the fixture, registered its own mongoose models
 * off them, and then `createTestApp()` defined seven express endpoints by hand:
 *
 *     app.get('/api/wallet/getAssetsDetails', ...)
 *     app.post('/api/wallet/transfer',        ...)
 *     app.get('/api/wallet/getAsset/:currencyId', ...)
 *     ... and four more
 *
 * each with a hand-written body that read and wrote those fixture models. Its
 * "auth" was `app.use((req,res,next) => { req.user = {...}; next(); })` plus a
 * bearer-token string check inside the fixture endpoint - passport was never
 * loaded, config/passport.js was never exercised, and no route file, no
 * controller, no validation module and no lib/ module was ever imported. Every
 * assertion in wallet-api.integration.test.js therefore graded the fixture.
 * `walletapi/` could have been deleted from disk and the suite would have
 * stayed green.
 *
 * This harness mounts THE SHIPPED CODE:
 *
 *   routes/wallet.route.js     -> the real router: passport's `usersAuth`,
 *                                 walletCtrl.blockFrozenWallet, the real
 *                                 walletValid.* validators and the real
 *                                 walletCtrl.* handlers, in the real order.
 *   routes/currency.route.js   -> the real currency list, which is what
 *                                 actually exercises lib/currencyDecimals.js.
 *   config/passport.js         -> the REAL JWT strategy. A request is
 *                                 authenticated only if it carries a token
 *                                 this service's own strategy accepts, which
 *                                 means the redis `userToken` row has to exist
 *                                 and its `tokenId` has to match.
 *   controllers/*, validation/*, lib/*, models/* -> untouched, real, and
 *                                 reached over real HTTP.
 *
 * WHAT IS STUBBED, AND WHY EACH ONE IS A GENUINE BOUNDARY
 * ------------------------------------------------------
 * Only things that leave this process. Nothing walletapi itself implements is
 * reimplemented here.
 *
 *   grpc/userService.js       -> userapi on :2567 (user doc, bank detail, mail).
 *   grpc/client.js            -> the site-settings service.
 *   node-cron                 -> the process scheduler. config/cron.js is not
 *                                on the router's import chain, but stubbing it
 *                                keeps any module that schedules at import
 *                                scope from mutating state under assertions.
 *
 * The `controllers/coin/*` gateways are NOT stubbed and do not need to be:
 * this deployment already ships them as paper stubs with no chain RPC, no key
 * reads and no network of any kind (see the file headers), so they are real
 * in-process code here exactly as they are in the running service.
 *
 * WHAT IS REAL
 * ------------
 *   mongo -> mongodb-memory-server, the REAL models from models/index.js, real
 *            queries, real schema casting. The passbook rows a transfer writes
 *            are read back out of the real Passbook model.
 *   redis -> THE REAL REDIS at 127.0.0.1:6379, on DB 15 under the key prefix
 *            `cryptodex_itest_`. Not a shim: the balance movement in
 *            walletTransfer is HINCRBYFLOAT through
 *            controllers/redis.controller.js, and a JS fake would test the
 *            fake. Live data is db 0 under the `cryptodex_` prefix, so the two
 *            cannot meet. Cleanup is a prefix-scoped SCAN+DEL and never
 *            FLUSHDB: if the db-select ever regressed, FLUSHDB would destroy
 *            live balances while a prefix scan simply finds nothing.
 *
 * ONE SERVER, NOT ONE PER REQUEST
 * -------------------------------
 * `request(app)` binds a fresh ephemeral listener per call, the documented
 * cause of intermittent ECONNRESET/EADDRINUSE. One long-lived server is bound
 * to 127.0.0.1 in beforeAll and handed to supertest, which reuses it.
 */

/* eslint-disable no-undef */

// --------------------------------------------------------------------------
// ENV, FIRST. config/index.js is read at module scope by
// controllers/redis.controller.js (which creates its client immediately), so
// these must be set before any service module loads. Nothing below imports
// service code statically.
// --------------------------------------------------------------------------
export const TEST_REDIS_PREFIX = "cryptodex_itest_";
export const TEST_REDIS_DB = 15;

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.REDIS_URL = `redis://127.0.0.1:6379/${TEST_REDIS_DB}`;
process.env.REDIS_PREFIX = TEST_REDIS_PREFIX;
process.env.SECRET_KEY =
  process.env.SECRET_KEY || "walletapi_itest_secret_key_do_not_reuse";
process.env.RUN_CRON = "false";
// gRPC targets that must never resolve to a real service even if a stub is
// missed. Everything below is mocked, but a wrong address fails fast rather
// than talking to the running stack.
process.env.GRPC_URL = "127.0.0.1:1";
process.env.GRPC_USER_URL = "127.0.0.1:1";
process.env.GRPC_WALLET_URL = "127.0.0.1:1";
process.env.GRPC_SPOT_URL = "127.0.0.1:1";

// --------------------------------------------------------------------------
// BOUNDARY STUBS. Hoisted by babel-plugin-jest-hoist above everything else in
// this module and applied to the whole module registry of the test file that
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


// config/binance.js CONSTRUCTS a Binance REST client at module scope from the
// deployment's API credentials, and controllers/priceCNV.controller.js is on
// wallet.controller.js's import chain, so the client is built merely by loading
// the router. That is the public internet, and it is the one boundary in this
// service that cannot be avoided by not calling anything.
//
// DO NOT DELETE THIS MOCK. It has been removed by accident before, which took
// the whole integration suite from 721 passing to 49 failing - and those
// failures were then reported as pre-existing. They were not.
jest.mock("../../config/binance.js", () => ({
  __esModule: true,
  binanceApiNode: {
    prices: async () => ({}),
    exchangeInfo: async () => ({ symbols: [] }),
    depositAddress: async () => ({}),
    accountInfo: async () => ({ balances: [] }),
    ws: {
      ticker: () => () => {},
      partialDepth: () => () => {},
    },
  },
}));

jest.mock("../../grpc/userService.js", () => ({
  __esModule: true,
  fetchUser: async () => ({ status: false }),
  bankDetail: async () => ({ status: false }),
  sendMail: async () => ({ status: true }),
  notification: async () => ({ status: true }),
}));

// grpc/adminService.js is DELETED, so there is nothing left to stub. It
// exported `fetchAdmin` (the only consumer was the adminAuth passport strategy,
// which went with routes/admin.route.js) and `saveAdminprofit` -- which sounds
// load-bearing because it books every maker/taker fee, but NOTHING IN WALLETAPI
// EVER CALLED IT. Fee booking is spotapi's, through spotapi's own client, and
// that copy is untouched. Verified by grep before deleting rather than assumed.

jest.mock("../../grpc/client.js", () => ({
  __esModule: true,
  getSiteSet: async () => ({ status: false }),
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
  const [
    walletRoute,
    currencyRoute,
    passportCfg,
    configMod,
    models,
    redisCtrl,
    walletCtrl,
    walletValid,
    standDownLib,
  ] = await Promise.all([
    import("../../routes/wallet.route.js"),
    import("../../routes/currency.route.js"),
    import("../../config/passport.js"),
    import("../../config/index.js"),
    import("../../models/index.js"),
    import("../../controllers/redis.controller.js"),
    import("../../controllers/wallet.controller.js"),
    import("../../validation/wallet.validation.js"),
    import("../../lib/walletStandDown.js"),
  ]);
  realModules = {
    walletRouter: walletRoute.default,
    currencyRouter: currencyRoute.default,
    usersAuth: passportCfg.usersAuth,
    config: configMod.default,
    models,
    redisCtrl,
    walletCtrl,
    walletValid,
    standDownLib,
  };
  return realModules;
};

export const getRealModules = () => {
  if (!realModules) throw new Error("harness not started");
  return realModules;
};

/**
 * The raw redis handle used ONLY for test bookkeeping (prefix-scoped cleanup).
 * Service code goes through controllers/redis.controller.js.
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
 * never used - see the header.
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
  process.env.DATABASE_URI = mongoServer.getUri("cryptodex_wallet_itest");
  await mongoose.connect(process.env.DATABASE_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  const {
    walletRouter,
    currencyRouter,
    usersAuth,
  } = await loadRealModules();

  // The SAME wiring server.js uses: body parsers, passport with the real JWT
  // strategies, and the real routers mounted at the real paths.
  const express = (await import("express")).default;
  const passport = (await import("passport")).default;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(passport.initialize());
  usersAuth(passport);
  // adminAuth is gone with routes/admin.route.js - nothing authenticates as an
  // admin in this service any more.
  app.use("/api/wallet", walletRouter);
  app.use("/api/currency", currencyRouter);

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
  // creates its client at module scope and exports no way to close it, which is
  // why jest.config.js sets `forceExit`.
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
 * A user the REAL passport strategy will accept: config/passport.js resolves a
 * bearer token by reading `userToken` out of redis and comparing `tokenId`, so
 * the fixture has to produce exactly that row. No auth middleware is faked -
 * a token whose redis row is missing, locked, or carries a different tokenId
 * gets a genuine 401 from the shipped strategy.
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

/** A token that is validly signed but whose redis session row does not exist. */
export function signOrphanToken(userId = oid().toString()) {
  const { config } = getRealModules();
  return jwt.sign({ _id: userId, role: "user", tokenId: "nope" }, config.secretOrKey, {
    expiresIn: "1h",
  });
}

export async function seedCurrency(overrides = {}) {
  const { models } = getRealModules();
  const doc = await models.Currency.create({
    _id: overrides._id || oid(),
    name: overrides.name || "Tether",
    coin: overrides.coin || "USDT",
    symbol: overrides.symbol || "USDT",
    gateway_code: overrides.gateway_code || "paper",
    type: overrides.type || "crypto",
    status: "active",
    depositStatus: "active",
    withdrawStatus: "active",
    withdrawFee: 0,
    minimumWithdraw: 1,
    maximumWithdraw: 100000,
    minimumDeposit: 1,
    maximumDeposit: 100000,
    ...overrides,
  });
  return doc.toObject();
}

/**
 * A currency document in the shape THIS DEPLOYMENT ACTUALLY HAS: inserted
 * straight into the collection by a seed script, so the schema's
 * `contractDecimal: { default: 0 }` never applied and the field is ABSENT from
 * the document rather than zero. That distinction is the entire subject of
 * lib/currencyDecimals.js - a document with `contractDecimal: 0` is a
 * whole-unit currency, a document with no `contractDecimal` at all is a
 * currency whose precision has to be recovered from `decimals`. Seeding
 * through the model would quietly paper over the case the library exists for.
 */
export async function seedRawCurrency(fields = {}) {
  const _id = fields._id || oid();
  await mongoose.connection.collection("currency").insertOne({
    _id,
    name: fields.name || fields.coin || "USD Coin",
    coin: fields.coin || "USDC",
    symbol: fields.symbol || fields.coin || "USDC",
    gateway_code: "paper",
    type: fields.type || "crypto",
    status: "active",
    ...fields,
    _id,
  });
  return mongoose.connection.collection("currency").findOne({ _id });
}

/**
 * A wallet whose asset subdocument `_id` EQUALS the currency id, which is the
 * shape controllers/createAsset.js produces and the shape every client sends
 * back as `userAssetId`.
 */
export async function seedWallet({ userId, userCode, currencies = [], frozen } = {}) {
  const { models } = getRealModules();
  const assets = currencies.map((c) => ({
    _id: c._id,
    currencyId: c._id,
    coin: c.coin,
    address: `paper-${c.coin}-${userId}`,
    spotBal: 0,
  }));
  const doc = await models.Wallet.create({
    _id: new mongoose.Types.ObjectId(userId),
    userCode: userCode || `UC${String(userId).slice(-6)}`,
    assets,
    ...(frozen === undefined ? {} : { frozen }),
  });
  return doc;
}

const ledgerField = (userId, currencyId) => `${userId}_${currencyId}`;

/** Write a redis ledger row through the REAL redis controller. */
export async function setLedger(hash, userId, currencyId, amount) {
  const { redisCtrl } = getRealModules();
  await redisCtrl.hset(hash, ledgerField(userId, currencyId), amount);
}

/** Read a redis ledger row through the REAL redis controller. */
export async function readLedger(hash, userId, currencyId) {
  const { redisCtrl } = getRealModules();
  const raw = await redisCtrl.hget(hash, ledgerField(userId, currencyId));
  if (raw == null) return null;
  const parsed = parseFloat(typeof raw === "string" ? raw.replace(/"/g, "") : raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Mark an account stood down through the SHARED redis hash that
 * lib/walletStandDown.js reads. This is the second of the guard's two sources;
 * the first is `wallet.frozen` on this service's own document.
 */
export async function markStoodDown(userId, mark = { frozen: true, reason: "itest" }) {
  const { redisCtrl, standDownLib } = getRealModules();
  await redisCtrl.hset(standDownLib.STAND_DOWN_HASH, userId.toString(), mark);
}

/** Freeze via this service's own authority: the wallet document. */
export async function freezeWalletDoc(userId) {
  const { models } = getRealModules();
  await models.Wallet.updateOne(
    { _id: new mongoose.Types.ObjectId(userId) },
    { $set: { frozen: true, frozenAt: new Date() } }
  );
}

/** Every passbook row a request wrote, in insertion order. */
export async function readPassbook(userId) {
  const { models } = getRealModules();
  return models.Passbook.find({ userId: userId.toString() }).sort({ _id: 1 }).lean();
}

/** Every transaction row a request wrote. */
export async function readTransactions(userId) {
  const { models } = getRealModules();
  return models.Transaction.find({ userId: new mongoose.Types.ObjectId(userId) })
    .sort({ _id: 1 })
    .lean();
}

/**
 * A user + wallet + currency + funded ledgers, the setup nearly every transfer
 * test needs. Returns everything a request needs to name itself.
 */
// Spot is the only wallet this venue has. `spotLocked` seeds the reservation
// counter that `spotBalAvailable` is derived from - the free/locked split.
export async function seedFundedAccount({
  coin = "USDT",
  type = "crypto",
  spot = 0,
  spotLocked = null,
  currencyOverrides = {},
} = {}) {
  const user = await seedUser();
  const currency = await seedCurrency({ coin, symbol: coin, type, ...currencyOverrides });
  await seedWallet({ userId: user.userId, userCode: user.userDoc.userCode, currencies: [currency] });
  await setLedger("walletbalance_spot", user.userId, currency._id, spot);
  if (spotLocked !== null) {
    await setLedger("walletbalance_spot_locked", user.userId, currency._id, spotLocked);
  }
  return { user, currency, userAssetId: currency._id.toString() };
}
