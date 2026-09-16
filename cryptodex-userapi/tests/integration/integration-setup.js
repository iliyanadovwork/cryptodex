/**
 * REAL INTEGRATION HARNESS FOR THE USER API.
 * ==========================================
 *
 * WHAT THIS REPLACES, AND WHY IT HAD TO BE REPLACED
 * -------------------------------------------------
 * The previous version of this file was 912 lines and a SECOND, COMPLETE
 * IMPLEMENTATION OF THE AUTH AND ACCOUNT API. It imported no service code at
 * all - not one controller, not one route, not one validator, not the real
 * User model. It declared its own mongoose UserSchema inline, its own
 * `app.use((req,res,next) => { req.user = testUsers.get(req.get('user-id')) })`
 * in place of passport, and SIXTY-SEVEN express endpoints inside the fixture:
 *
 *   app.post('/api/auth/register', ...)  - its own email regex, its own
 *                                          "password too weak" rule, its own
 *                                          duplicate check
 *   app.post('/api/auth/login', ...)     - `if (password !== 'Test123456')`,
 *                                          i.e. a literal string compare
 *                                          standing in for pbkdf2
 *   app.put('/api/user/2fa', ...)        - `res.json({message:'2FA enabled'})`
 *                                          and nothing else
 *   ...and 64 more of the same shape.
 *
 * So every assertion in auth-api.integration.test.js and
 * user-api.integration.test.js described the fixture. Deleting
 * routes/auth.route.js entirely left both suites green. This service owns
 * registration, login, 2FA and deactivation - the four flows a user cannot
 * route around - and none of them were under test.
 *
 * This harness mounts THE SHIPPED CODE, wired the way server.js wires it:
 *
 *   routes/auth.route.js      -> the real router, the real
 *                                validation/user.validation.js middlewares,
 *                                the real controllers/auth.controller.js
 *   routes/user.route.js      -> the real router behind the REAL passport
 *                                "usersAuth" JWT strategy from
 *                                config/passport.js, which resolves a session
 *                                out of the redis `userToken` hash
 *   routes/health.route.js, routes/language.route.js
 *   lib/responseGuard.js      -> the same 60s response guarantee server.js
 *                                installs
 *   models/*                  -> the real mongoose models, including the real
 *                                User with its pbkdf2 `password` virtual and
 *                                `authenticate()` method
 *
 * WHAT IS STUBBED, AND WHY EACH ONE IS A GENUINE BOUNDARY
 * ------------------------------------------------------
 * Only things that leave this process. Nothing userapi itself implements is
 * reimplemented here.
 *
 *   grpc/walletService.js             -> walletapi on :3002 (newAsset,
 *                                        deactivateWallet, getAdminDashboard)
 *   grpc/spotService.js               -> spotapi on :2568
 *   grpc/currencyService.js           -> the currency service
 *   lib/emailGateway.js               -> api.resend.com. THE MAIL GATEWAY.
 *                                        Note the real emailTemplate.controller
 *                                        rendering still runs above it, off
 *                                        real EmailTemplate/SiteSetting rows -
 *                                        only the outbound POST is replaced,
 *                                        and it is replaced by a RECORDER so
 *                                        tests can assert what was mailed.
 *   config/socketIO.js                -> the browser websocket fan-out.
 *                                        Emitting to nobody is not business
 *                                        logic; recorded so the tests can
 *                                        still assert the emit happened.
 *
 * Every stub is CONFIGURABLE and RECORDING, through a registry hung off
 * `global` (jest.mock factories may not close over module scope). That is what
 * lets a test drive `deactivateWallet` to refuse and assert the deactivation
 * aborts with nothing written - the compensation logic in confirmDeActive is
 * real code and is now actually exercised.
 *
 * WHAT IS REAL
 * ------------
 *   mongo -> mongodb-memory-server, real mongoose models, real queries, real
 *            unique indexes.
 *   redis -> THE REAL REDIS at 127.0.0.1:6379, on DB 15 under the key prefix
 *            `cryptodex_itest_user_`. config/passport.js reads the session out of
 *            redis with the real controllers/redis.controller.js; a JS fake
 *            would test the fake. Live data is db 0 under `cryptodex_`, so the
 *            two cannot meet, and cleanup only ever deletes keys matching the
 *            test prefix (SCAN + DEL, never FLUSHDB).
 *   crypto-> real pbkdf2 password hashing, real CryptoJS mail tokens, real
 *            jsonwebtoken signing, real node-2fa TOTP.
 *
 * ONE SERVER, NOT ONE PER REQUEST
 * -------------------------------
 * `request(app)` binds a fresh ephemeral listener per call, which is the
 * documented cause of the mongod port-collision flake the old file's header
 * described at length. One long-lived server is bound to 127.0.0.1 in
 * startHarness and handed to supertest, which reuses it.
 */

/* eslint-disable no-undef */

// --------------------------------------------------------------------------
// ENV, FIRST. controllers/redis.controller.js creates its client at MODULE
// SCOPE off config/index.js, so these must be set before any service module is
// loaded. Nothing below imports service code statically - it is all behind the
// lazy loadRealModules() call.
//
// config/index.js does `import "dotenv/config"`, and dotenv never overwrites a
// variable that is already set, so the assignments below win over the checked
// in .env.
// --------------------------------------------------------------------------
export const TEST_REDIS_PREFIX = "cryptodex_itest_user_";
export const TEST_REDIS_DB = 15;

process.env.NODE_ENV = "test";
process.env.REDIS_URL = `redis://127.0.0.1:6379/${TEST_REDIS_DB}`;
process.env.REDIS_PREFIX = TEST_REDIS_PREFIX;
process.env.RUN_CRON = "false";
// TEST_MODE=true makes auth.controller.userLogin SKIP the entire email-OTP
// step. The live .env sets it. Forcing it off here is deliberate: the suite is
// meant to exercise the two-step login a real user gets, not a bypass.
process.env.TEST_MODE = "false";
// gRPC targets that must never resolve to a real service even if a stub were
// missed. Everything is mocked, but a wrong address fails fast rather than
// talking to the running stack.
process.env.GRPC_URL = "127.0.0.1:1";
process.env.GRPC_USER_URL = "127.0.0.1:1";
process.env.GRPC_WALLET_URL = "127.0.0.1:1";
process.env.GRPC_SPOT_URL = "127.0.0.1:1";

// --------------------------------------------------------------------------
// BOUNDARY STUBS.
//
// babel-plugin-jest-hoist lifts these above every import in the file that
// imports this harness, and forbids a factory from referencing module scope.
// The shared registry therefore lives on `global`, which the plugin permits,
// and each factory re-derives it. `boundaries()` below is the public accessor.
// --------------------------------------------------------------------------

/* eslint-disable no-undef */
const REG = () => {
  const g = global;
  if (!g.__USERAPI_ITEST__) {
    g.__USERAPI_ITEST__ = {
      mails: [],
      sms: [],
      socket: [],
      grpc: [],
      /** Per-method overrides: { newAsset: () => ({status:false}) } */
      behaviour: {},
    };
  }
  return g.__USERAPI_ITEST__;
};

jest.mock("../../lib/emailGateway.js", () => {
  const reg = () => {
    const g = global;
    g.__USERAPI_ITEST__ = g.__USERAPI_ITEST__ || {
      mails: [],
      sms: [],
      socket: [],
      grpc: [],
      behaviour: {},
    };
    return g.__USERAPI_ITEST__;
  };
  return {
    __esModule: true,
    // The real gateway POSTs to api.resend.com. Everything ABOVE it -
    // mailTemplate's template lookup and token substitution - is real and runs
    // before we get here, so `content.subject` / `content.template` are the
    // genuinely rendered mail.
    sendEmail: async (to, content) => {
      reg().mails.push({
        to,
        subject: (content && content.subject) || "",
        template: (content && content.template) || "",
      });
      return { delivered: true, mode: "send", status: 200, id: "itest" };
    },
    DELIVERY_LOG_ONLY: "log-only",
    DELIVERY_SEND: "send",
    mailDeliveryMode: () => "send",
  };
});

// The lib/smsGateway.js stub is gone with the module. Nothing in this service
// sends SMS any more: phone verification, phone registration/login and the SMS
// one-time code have all been removed, and every code this service issues now
// goes out through the mail gateway stubbed above.

jest.mock("../../config/socketIO.js", () => {
  const reg = () => {
    const g = global;
    g.__USERAPI_ITEST__ = g.__USERAPI_ITEST__ || {
      mails: [],
      sms: [],
      socket: [],
      grpc: [],
      behaviour: {},
    };
    return g.__USERAPI_ITEST__;
  };
  return {
    __esModule: true,
    createSocketIO: () => {},
    socketEmitAll: (type, data) => {
      reg().socket.push({ scope: "all", type, data });
    },
    socketEmitOne: (type, data, userId) => {
      reg().socket.push({ scope: "one", type, data, userId: String(userId) });
    },
  };
});

jest.mock("../../grpc/walletService.js", () => {
  const reg = () => {
    const g = global;
    g.__USERAPI_ITEST__ = g.__USERAPI_ITEST__ || {
      mails: [],
      sms: [],
      socket: [],
      grpc: [],
      behaviour: {},
    };
    return g.__USERAPI_ITEST__;
  };
  const call = (name, dflt) => async (body) => {
    const r = reg();
    r.grpc.push({ service: "wallet", method: name, body });
    const override = r.behaviour[name];
    return override ? await override(body) : dflt;
  };
  return {
    __esModule: true,
    newAsset: call("newAsset", { status: true }),
    getAdminDashboard: call("getAdminDashboard", { status: true }),
    // walletapi answers { status, message }. "FROZEN" means THIS call applied
    // the freeze; confirmDeActive's compensation ledger keys off exactly that
    // string (user.controller.FREEZE_APPLIED_MESSAGE), so the stub has to
    // answer the way a reachable walletapi answers.
    deactivateWallet: call("deactivateWallet", {
      status: true,
      message: "FROZEN",
    }),
  };
});

jest.mock("../../grpc/spotService.js", () => {
  const reg = () => {
    const g = global;
    g.__USERAPI_ITEST__ = g.__USERAPI_ITEST__ || {
      mails: [],
      sms: [],
      socket: [],
      grpc: [],
      behaviour: {},
    };
    return g.__USERAPI_ITEST__;
  };
  return {
    __esModule: true,
    cancelOrderForDeactiveAcc: async (body) => {
      const r = reg();
      r.grpc.push({ service: "spot", method: "cancelOrderForDeactiveAcc", body });
      const override = r.behaviour.cancelOrderForDeactiveAcc;
      return override ? await override(body) : { status: true };
    },
  };
});

jest.mock("../../grpc/currencyService.js", () => {
  const reg = () => {
    const g = global;
    g.__USERAPI_ITEST__ = g.__USERAPI_ITEST__ || {
      mails: [],
      sms: [],
      socket: [],
      grpc: [],
      behaviour: {},
    };
    return g.__USERAPI_ITEST__;
  };
  const call = (name, dflt) => async (body) => {
    const r = reg();
    r.grpc.push({ service: "currency", method: name, body });
    const override = r.behaviour[name];
    return override ? await override(body) : dflt;
  };
  return {
    __esModule: true,
    currencyId: call("currencyId", { status: false }),
    priceConversionGrpc: call("priceConversionGrpc", {
      status: true,
      convertPrice: 1,
    }),
  };
});

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
    authRoute,
    userRoute,
    healthRoute,
    languageRoute,
    passportCfg,
    configMod,
    models,
    cryptoJS,
    redisCtrl,
    authCtrl,
    userCtrl,
    userValid,
    responseGuardMod,
  ] = await Promise.all([
    import("../../routes/auth.route.js"),
    import("../../routes/user.route.js"),
    import("../../routes/health.route.js"),
    import("../../routes/language.route.js"),
    import("../../config/passport.js"),
    import("../../config/index.js"),
    import("../../models/index.js"),
    import("../../lib/cryptoJS.js"),
    import("../../controllers/redis.controller.js"),
    import("../../controllers/auth.controller.js"),
    import("../../controllers/user.controller.js"),
    import("../../validation/user.validation.js"),
    import("../../lib/responseGuard.js"),
  ]);

  realModules = {
    authRouter: authRoute.default,
    userRouter: userRoute.default,
    healthRouter: healthRoute.default,
    languageRouter: languageRoute.default,
    usersAuth: passportCfg.usersAuth,
    config: configMod.default,
    models,
    cryptoJS,
    redisCtrl,
    authCtrl,
    userCtrl,
    userValid,
    responseGuard: responseGuardMod.responseGuard,
  };
  return realModules;
};

export const getRealModules = () => {
  if (!realModules) throw new Error("harness not started");
  return realModules;
};

/** Recorded traffic + behaviour overrides for the out-of-process boundaries. */
export const boundaries = () => REG();

/** Replace one boundary method's answer for the duration of a test. */
export const setBoundaryBehaviour = (name, fn) => {
  REG().behaviour[name] = fn;
};

export const resetBoundaries = () => {
  const r = REG();
  r.mails.length = 0;
  r.sms.length = 0;
  r.socket.length = 0;
  r.grpc.length = 0;
  r.behaviour = {};
};

export const mailsTo = (email) =>
  REG().mails.filter((m) => String(m.to).toLowerCase() === String(email).toLowerCase());

export const grpcCalls = (method) =>
  REG().grpc.filter((c) => (method ? c.method === method : true));

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
  process.env.DATABASE_URI = mongoServer.getUri("cryptodex_user_itest");
  await mongoose.connect(process.env.DATABASE_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  const real = await loadRealModules();

  // The SAME wiring server.js uses, minus morgan (stdout noise) and the socket
  // server (stubbed): responseGuard, body parsers, passport with the real JWT
  // strategies, and the real routers at the real paths.
  const express = (await import("express")).default;
  const passport = (await import("passport")).default;
  const app = express();
  app.use(real.responseGuard(60000));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ limit: "10mb", extended: false }));
  app.use(passport.initialize());
  real.usersAuth(passport);

  app.use("/api/health", real.healthRouter);
  app.use("/api/auth", real.authRouter);
  app.use("/api/language", real.languageRouter);
  app.use("/api/user", real.userRouter);

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
  // why jest.config.js sets `forceExit` - see the note there.
  if (rawRedis) {
    await new Promise((resolve) => rawRedis.quit(() => resolve()));
    rawRedis = null;
    redisScan = null;
    redisDel = null;
  }
}

export async function resetState() {
  await purgeTestKeys();
  resetBoundaries();
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

/** supertest bound to the ONE long-lived server (see the header note). */
export const api = () => {
  if (!server) throw new Error("harness not started");
  return request(server);
};

// --------------------------------------------------------------------------
// Seeding. Everything below writes through the real models / the real redis
// controller, into the isolated test db + prefix.
// --------------------------------------------------------------------------

export const oid = () => new mongoose.Types.ObjectId();

/**
 * emailTemplate.controller.mailTemplate needs a SiteSetting row and an
 * EmailTemplate row or it returns false before ever reaching the gateway.
 * Both are real documents; the substitution below is the real one.
 */
export async function seedSiteSetting(overrides = {}) {
  const { models } = getRealModules();
  return models.SiteSetting.create({
    siteName: "Cryptodex",
    emailLogo: "logo.png",
    supportMail: "support@cryptodex.test",
    twitterUrl: "https://x.test/cryptodex",
    telegramLink: "https://t.test/cryptodex",
    facebookLink: "https://fb.test/cryptodex",
    instaLink: "https://ig.test/cryptodex",
    contactNo: "0000000000",
    address: "nowhere",
    ...overrides,
  });
}

/**
 * The templates the auth + account flows actually ask for, with the real
 * placeholder tokens so the assertions can read the activation link / OTP back
 * out of the RENDERED mail rather than out of a mock's arguments.
 */
export const TEMPLATE_BODIES = {
  activate_register_user:
    "<p>Hello ##templateInfo_name##</p><a href='##templateInfo_url##'>Activate</a><span>##ANTIPHISHINGCODE##</span>",
  EMAIL_VERIFICATION_OTP:
    "<p>Your code is ##OTP##</p><span>##ANTIPHISHINGCODE##</span>",
  User_forgot:
    "<p>Hi ##templateInfo_name##</p><a href='##templateInfo_url##'>Reset</a><span>##ANTIPHISHINGCODE##</span>",
  Login_notification:
    "<p>Login by ##templateInfo_name## from ##BROWSER## ##IP## ##COUNTRY## at ##DATE##</p><span>##ANTIPHISHINGCODE##</span>",
  alert_notification:
    "<p>##message## for ##templateInfo_name## at ##DATE##</p><span>##ANTIPHISHINGCODE##</span>",
  verify_new_email:
    "<p>##DATE##</p><a href='##templateInfo_url##'>Verify</a><span>##ANTIPHISHINGCODE##</span>",
};

export async function seedEmailTemplates(identifiers = Object.keys(TEMPLATE_BODIES)) {
  const { models } = getRealModules();
  return models.EmailTemplate.insertMany(
    identifiers.map((identifier) => ({
      identifier,
      subject: `[itest] ${identifier}`,
      content: TEMPLATE_BODIES[identifier] || `<p>##ANTIPHISHINGCODE##</p>`,
      langCode: "en",
      status: "active",
    }))
  );
}

/**
 * A real User document, created through the real model so the pbkdf2
 * `password` virtual, the pre-save "Invalid password" hook and the unique
 * indexes all apply. Nothing here bypasses the model.
 */
export async function seedUser(overrides = {}) {
  const { models } = getRealModules();
  const { password = "SmokeTest123!", ...rest } = overrides;
  const doc = new models.User({
    email: (rest.email || `itest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`).toLowerCase(),
    status: "verified",
    emailStatus: "verified",
    type: "basic_verified",
    role: "user",
    ...rest,
  });
  doc.password = password;
  if (!doc.userId) {
    // The real registration path derives userId from the ObjectId via
    // lib/generalFun.IncCntObjId; do the same here.
    const { IncCntObjId } = await import("../../lib/generalFun.js");
    doc.userId = IncCntObjId(doc._id);
    if (!doc.refferalCode) doc.refferalCode = doc.userId;
  }
  await doc.save();
  return doc;
}

/** The UserSetting row that userLogin / changePassword / 2FA all read. */
export async function seedUserSetting(userDoc, overrides = {}) {
  const { models } = getRealModules();
  return models.UserSetting.create({
    _id: userDoc._id,
    userId: userDoc._id,
    ...overrides,
  });
}

/** The UserKyc row userProfileDetail reads. */
export async function seedUserKyc(userDoc) {
  const { models } = getRealModules();
  return models.UserKyc.create({ _id: userDoc._id, userId: userDoc._id });
}

/**
 * A session the REAL passport strategy will accept.
 *
 * config/passport.js resolves a bearer token by reading `userToken` out of
 * redis and comparing `tokenId`, so this writes exactly the row the real
 * userLogin writes and signs the token with the real secret. No auth
 * middleware is faked, and a test that wants the whole login flow should use
 * loginViaApi() instead.
 */
export async function issueSession(userDoc, overrides = {}) {
  const { config, redisCtrl } = getRealModules();
  const tokenId = overrides.tokenId || oid().toString();
  const sessionDoc = {
    id: userDoc._id,
    userCode: userDoc.userId,
    type: userDoc.type,
    email: userDoc.email,
    refferalCode: userDoc.refferalCode,
    tokenId,
    secret2FA: (userDoc.google2Fa && userDoc.google2Fa.secret) || "",
    userLocked: userDoc.userLocked || "false",
    feeManagement: userDoc.feeManagement || [],
    ...overrides.sessionDoc,
  };
  await redisCtrl.hset("userToken", userDoc._id.toString(), sessionDoc);
  const raw = jwt.sign(
    {
      _id: userDoc._id.toString(),
      uniqueId: userDoc.userId,
      tokenId,
      role: overrides.role || "user",
    },
    config.secretOrKey,
    { expiresIn: "1h" }
  );
  return { token: raw, authHeader: `Bearer ${raw}`, tokenId, sessionDoc };
}

/** Read back whatever the service stored for this user's session. */
export async function readSession(userId) {
  const { redisCtrl } = getRealModules();
  const raw = await redisCtrl.hget("userToken", userId.toString());
  return raw == null ? null : JSON.parse(raw);
}

/**
 * Poll until `predicate()` is truthy.
 *
 * EVERY transactional mail in this service is dispatched WITHOUT await:
 * `mailTemplateLang(...)` is called bare from the controllers, and it in turn
 * calls `mailTemplate(...)` bare, which does two mongo round trips before it
 * reaches the gateway. So the HTTP response is written BEFORE the mail exists.
 * That is the shipped behaviour (see lib/mailDelivery.js's header, which calls
 * it out), so the tests wait for the mail rather than pretending it is
 * synchronous.
 */
export async function waitFor(predicate, { timeoutMs = 5000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Wait until at least `count` mails have been rendered for `email`. */
export const waitForMail = (email, count = 1, opts) =>
  waitFor(() => {
    const mails = mailsTo(email);
    return mails.length >= count ? mails : null;
  }, opts);

/**
 * The full, real, two-step login: POST /login gets an OTP mailed, the OTP is
 * read out of the rendered mail, POST /login again with it returns the token.
 * Requires seedSiteSetting + seedEmailTemplates.
 */
export async function loginViaApi(email, password, extra = {}) {
  const before = mailsTo(email).length;
  const first = await api()
    .post("/api/auth/login")
    .send({ roleType: 1, email, password, ...extra });
  if (first.status !== 200 || first.body.status !== "OTP") {
    return { otpResponse: first, response: first, token: null, otp: null };
  }
  await waitForMail(email, before + 1);
  const otp = lastOtpFor(email);
  const second = await api()
    .post("/api/auth/login")
    .send({ roleType: 1, email, password, otpTextBox: true, otp, ...extra });
  return {
    otpResponse: first,
    response: second,
    otp,
    token: second.body && second.body.token,
  };
}

/** Pull the 6-digit OTP back out of the most recent rendered mail. */
export function lastOtpFor(email) {
  const mails = mailsTo(email);
  for (let i = mails.length - 1; i >= 0; i--) {
    const m = mails[i].template.match(/\b(\d{6})\b/);
    if (m) return m[1];
  }
  return null;
}

/** Pull the `?auth=` / `?userId=` token back out of the most recent mail. */
export function lastLinkTokenFor(email) {
  const mails = mailsTo(email);
  for (let i = mails.length - 1; i >= 0; i--) {
    const m = mails[i].template.match(/auth=([^'"\s>]+)/);
    if (m) return m[1];
  }
  return null;
}

/** The real client-side encryption the auth routes decrypt. */
export function encryptId(value) {
  const { cryptoJS } = getRealModules();
  return cryptoJS.encryptString(value.toString(), true);
}

export function decryptId(value) {
  const { cryptoJS } = getRealModules();
  return cryptoJS.decryptString(value, true);
}

/** A valid TOTP for a secret, from the same library the controllers verify with. */
export async function totpFor(secret) {
  const mod = await import("node-2fa");
  const node2fa = mod.default || mod;
  return node2fa.generateToken(secret).token;
}
