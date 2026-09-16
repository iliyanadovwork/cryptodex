/**
 * LOGIN - AGAINST THE SHIPPED CONTROLLER
 * ======================================
 *
 * WHAT THIS FILE USED TO BE
 * -------------------------
 * It imported nothing from the service. It declared, in the test file, a
 * `validateCredentials`, a `MAX_LOGIN_ATTEMPTS = 5` constant and an
 * `isAccountLocked(attempts) => attempts >= MAX_LOGIN_ATTEMPTS`, and asserted
 * against those. The shipped controller blocks on the THIRD failure
 * (`login_attempt >= 2` at the time of the failure), not the fifth, and the
 * lock is time-based with a 24h expiry rather than a counter. All 47
 * assertions were about constants declared in the test file.
 *
 * WHAT IT IS NOW
 * --------------
 * The real `auth.controller.userLogin` and the real `loginValidate`, driven
 * with real `models/User.js` documents (so `authenticate()` is real pbkdf2)
 * over an in-memory store. Only out-of-process modules are doubled: the gRPC
 * clients (which additionally cannot be babel-transformed because they resolve
 * their .proto through `import.meta.url`), redis, the mail gateway, sms and the
 * socket fan-out.
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import mongoose from "mongoose";

// ---------------------------------------------------------------------------
// In-memory stand-ins for the STORES. The documents inside them are REAL
// models/User.js documents, so hashing, the password virtual and authenticate()
// are the shipped implementations.
// ---------------------------------------------------------------------------
const mockDb = {
  users: [],
  blockedIps: [],
  settings: new Map(),
  loginHistory: [],
  redisWrites: [],
  mails: [],
};

jest.mock("../../models/index.js", () => {
  const RealUser = require("../../models/User.js").default;
  const matches = (query, doc) =>
    Object.entries(query).every(([k, v]) => {
      if (k === "_id") return String(doc._id) === String(v);
      return String(doc[k]) === String(v);
    });
  const find = (query) => mockDb.users.find((d) => matches(query, d)) || null;
  const applyUpdate = (doc, update) => {
    const set = update && update.$set ? update.$set : update;
    Object.entries(set || {}).forEach(([k, v]) => {
      doc[k] = v;
    });
    return doc;
  };
  // userLogin does `new User().generateJWT(payload)`, so the stand-in has to be
  // a CONSTRUCTOR whose prototype carries the REAL signing method - the token
  // this suite verifies is minted by models/User.js, not by the double.
  function User() {}
  User.prototype.generateJWT = RealUser.prototype.generateJWT;
  Object.assign(User, {
    findOne: async (q) => find(q),
    findById: async (id) => find({ _id: id }),
    findByIdAndUpdate: async (id, update) => {
      const doc = find({ _id: id });
      return doc ? applyUpdate(doc, update) : null;
    },
    updateOne: async (q, update) => {
      const doc = find(q);
      if (doc) applyUpdate(doc, update);
      return { acknowledged: true };
    },
    deleteOne: async () => ({ deletedCount: 0 }),
    countDocuments: async () => mockDb.users.length,
  });

  return {
    __esModule: true,
    RealUser,
    User,
    UserSetting: {
      schema: {
        paths: {
          _id: 1, userId: 1, theme: 1, currencySymbol: 1, defaultWallet: 1,
          showSpot: 1, siteNotification: 1, enableCryptodexFee: 1,
          LatestEvent: 1, announcement: 1, tradingviewAlert: 1,
          tradeOrderPlaceAlertMobile: 1, tradeOrderPlaceAlertWeb: 1, __v: 1,
        },
      },
      findById: (id) => ({
        lean: async () => mockDb.settings.get(String(id)) || null,
      }),
      findOne: async () => null,
      deleteOne: async () => ({}),
    },
    UserKyc: { findById: async () => null, deleteOne: async () => ({}) },
    Language: { findOne: async () => null },
    Admin: { findById: () => null },
    ipAddress: {
      findOne: async (q) => mockDb.blockedIps.find((ip) => ip === q.ip) ? { ip: q.ip } : null,
    },
    LoginHistory: class {
      constructor(d) { Object.assign(this, d); }
      async save() { mockDb.loginHistory.push(this); return this; }
    },
  };
});

jest.mock("../../grpc/walletService.js", () => ({
  __esModule: true,
  newAsset: async () => ({ status: true }),
  getAdminDashboard: async () => ({ status: true }),
  deactivateWallet: async () => ({ status: true }),
}));
jest.mock("../../controllers/emailTemplate.controller.js", () => ({
  __esModule: true,
  mailTemplateLang: async (payload) => {
    mockDb.mails.push(payload);
    return true;
  },
}));
jest.mock("../../controllers/user.controller.js", () => ({
  __esModule: true,
  userProfileDetail: async (doc) => ({ _id: doc._id, email: doc.email }),
}));
jest.mock("../../controllers/redis.controller.js", () => ({
  __esModule: true,
  hget: async () => null,
  hset: async (key, id, data) => {
    mockDb.redisWrites.push({ key, id: String(id), data });
  },
  hmget: async () => [],
  hmset: async () => true,
  hdel: async () => {},
  hgetall: async () => ({}),
}));
jest.mock("../../controllers/notification.controller.js", () => ({
  __esModule: true,
  newNotification: async () => ({ status: true }),
}));
jest.mock("../../config/socketIO.js", () => ({
  __esModule: true,
  createSocketIO: () => {},
  socketEmitAll: () => {},
  socketEmitOne: () => {},
}));

const { userLogin } = require("../../controllers/auth.controller.js");
const { loginValidate } = require("../../validation/user.validation.js");
const { RealUser } = require("../../models/index.js");
const jwt = require("jsonwebtoken");
const config = require("../../config/index.js").default;

const PASSWORD = "SmokeTest123!";

/** A real User document, with save() bound to the in-memory store. */
const makeUser = (over = {}) => {
  const doc = new RealUser({
    userId: "100001",
    email: "user@example.com",
    status: "verified",
    emailStatus: "verified",
    type: "basic_verified",
    ...over,
  });
  doc.password = over.password || PASSWORD;
  doc.save = async () => doc;
  mockDb.users.push(doc);
  // The fixture still CARRIES the derivative preferences on purpose, and that
  // is now MORE faithful than it used to be, not less. models/userSetting.js
  // no longer declares these paths - but the handler reads with `.lean()`,
  // which bypasses hydration and returns the raw mongo document, so every
  // value stored before the schema was cleaned still arrives in that object
  // exactly as this Map serves it. Purging them from the database is a
  // `$unset` migration nobody has run.
  //
  // So the guarantee under test is unchanged: login does not hand these keys
  // to the browser or write them into the session. It is NOT that they are
  // absent from the database - and the schema cleanup did not make the strip
  // in auth.controller.js redundant.
  mockDb.settings.set(String(doc._id), {
    defaultWallet: "spot",
    derivativeMode: "cross",
    inverseMode: "cross",
    leverage: "10",
    inverseLeverage: "20",
    showFuture: true,
    showInverse: true,
    showOFuture: true,
    showOInverse: true,
    theme: "dark",
    currencySymbol: "USD",
  });
  return doc;
};

const callLogin = async (body) => {
  const res = {
    statusCode: null,
    payload: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
  };
  await userLogin({ body }, res);
  return res;
};

const loginBody = (over = {}) => ({
  roleType: 1,
  email: "user@example.com",
  password: PASSWORD,
  ...over,
});

beforeEach(() => {
  mockDb.users.length = 0;
  mockDb.blockedIps.length = 0;
  mockDb.settings.clear();
  mockDb.loginHistory.length = 0;
  mockDb.redisWrites.length = 0;
  mockDb.mails.length = 0;
  process.env.TEST_MODE = "false";
});

describe("validation/user.validation.js loginValidate", () => {
  const run = (body) => {
    const res = {
      statusCode: null,
      payload: null,
      status(c) { this.statusCode = c; return this; },
      json(p) { this.payload = p; return this; },
    };
    let nexted = false;
    loginValidate({ body }, res, () => { nexted = true; });
    return { nexted, res };
  };

  test("lets a complete email login through", () => {
    expect(run({ roleType: 1, email: "a@b.co", password: "x" }).nexted).toBe(true);
  });

  test("requires a password regardless of channel", () => {
    expect(run({ roleType: 1, email: "a@b.co" }).res.payload.errors.password).toBe(
      "Password field is required"
    );
  });

  test("rejects a malformed email", () => {
    expect(run({ roleType: 1, email: "nope", password: "x" }).res.payload.errors.email).toBe(
      "Invalid email"
    );
  });

  test("does NOT check password strength - that would leak the rule to attackers", () => {
    // Only registration and reset enforce strength; login must accept whatever
    // is submitted and let the credential check decide.
    expect(run({ roleType: 1, email: "a@b.co", password: "a" }).nexted).toBe(true);
  });
});

describe("auth.controller.userLogin - account state gates", () => {
  test("an unknown address is refused with a field error", async () => {
    const res = await callLogin(loginBody({ email: "nobody@example.com" }));
    expect(res.statusCode).toBe(400);
    expect(res.payload.errors.email).toBe("Please enter a correct email address");
  });

  test("the address is lower-cased before lookup", async () => {
    makeUser({ email: "user@example.com" });
    const res = await callLogin(loginBody({ email: "USER@Example.COM" }));
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe("OTP");
  });

  test("an unverified account is refused before the password is checked", async () => {
    makeUser({ status: "unverified" });
    const res = await callLogin(loginBody());
    expect(res.statusCode).toBe(400);
    expect(res.payload.message).toMatch(/still not activated/i);
  });

  test("a userLocked account is refused", async () => {
    makeUser({ userLocked: "true" });
    const res = await callLogin(loginBody());
    expect(res.statusCode).toBe(400);
    expect(res.payload.message).toMatch(/still locked/i);
  });

  // THE IP BLOCKLIST IS GONE, so the fact worth pinning is the opposite one:
  // an address that used to be blocked no longer changes the answer. The
  // blocklist was administered through /api/admin/IpRestriction, which was
  // removed with the rest of the security surface; nothing populates or reads
  // it. If someone reinstates the check without reinstating the admin screen,
  // this fails and says so.
  test("a formerly-blocked IP no longer changes the outcome", async () => {
    makeUser();
    mockDb.blockedIps.push("10.9.9.9");
    const res = await callLogin(
      loginBody({ loginHistory: { ipaddress: "10.9.9.9" } })
    );
    expect(res.statusCode).toBe(200);
    expect(res.payload.message).not.toMatch(/Ip has been Blocked/i);
  });
});

describe("auth.controller.userLogin - credentials and the real lockout", () => {
  test("a wrong password is refused and the attempt counter advances", async () => {
    const user = makeUser();
    const res = await callLogin(loginBody({ password: "Wrong123!" }));
    expect(res.statusCode).toBe(400);
    expect(res.payload.errors.password).toBe("Password incorrect");
    expect(user.login_attempt).toBe(1);
    expect(user.isBlock).toBe(false);
    expect(mockDb.redisWrites).toHaveLength(0);
  });

  test("the block lands on the THIRD failure, not the fifth", async () => {
    const user = makeUser();

    expect((await callLogin(loginBody({ password: "Wrong123!" }))).statusCode).toBe(400);
    expect(user.login_attempt).toBe(1);
    expect((await callLogin(loginBody({ password: "Wrong123!" }))).statusCode).toBe(400);
    expect(user.login_attempt).toBe(2);

    const third = await callLogin(loginBody({ password: "Wrong123!" }));
    expect(third.statusCode).toBe(405);
    expect(third.payload.message).toMatch(/too many login attempts/i);
    expect(user.isBlock).toBe(true);
    expect(user.login_attempt).toBe(0);
  });

  // THE LOGIN JOURNAL IS GONE. What actually acts on repeated failures is the
  // `login_attempt` counter on the User document and the lockout above it -
  // never the journal - so this now asserts that removing the journal did not
  // take the lockout with it, which is the part a user can feel.
  test("a failure still advances the lockout counter, with nothing journalled", async () => {
    const user = makeUser();
    await callLogin(
      loginBody({ password: "Wrong123!", loginHistory: { ipaddress: "1.2.3.4" } })
    );
    expect(user.login_attempt).toBe(1);
    expect(mockDb.loginHistory).toHaveLength(0);
  });

  test("a live block refuses even the CORRECT password", async () => {
    makeUser({ isBlock: true, lock_session: new Date() });
    const res = await callLogin(loginBody());
    expect(res.statusCode).toBe(405);
    expect(mockDb.redisWrites).toHaveLength(0);
  });

  test("a block older than 24h is cleared and the login proceeds", async () => {
    const user = makeUser({
      isBlock: true,
      lock_session: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const res = await callLogin(loginBody());
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe("OTP");
    expect(user.isBlock).toBe(false);
  });

  test("a block 23 hours old still holds", async () => {
    makeUser({
      isBlock: true,
      lock_session: new Date(Date.now() - 23 * 60 * 60 * 1000),
    });
    expect((await callLogin(loginBody())).statusCode).toBe(405);
  });
});

describe("auth.controller.userLogin - the OTP step", () => {
  test("step 1 stores an OTP, mails it, and mints NO session", async () => {
    const user = makeUser();
    const res = await callLogin(loginBody());

    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe("OTP");
    expect(res.payload.token).toBeUndefined();
    expect(String(user.otp)).toMatch(/^\d{6}$/);
    expect(mockDb.redisWrites).toHaveLength(0);

    expect(mockDb.mails).toHaveLength(1);
    expect(mockDb.mails[0].identifier).toBe("EMAIL_VERIFICATION_OTP");
    expect(mockDb.mails[0].toEmail).toBe("user@example.com");
    // The mailed code is the stored code.
    expect(String(mockDb.mails[0].content.emailOtp)).toBe(String(user.otp));
  });

  test("submitting the OTP box with no code is refused", async () => {
    makeUser();
    const res = await callLogin(loginBody({ otpTextBox: true, otp: "" }));
    expect(res.statusCode).toBe(400);
    expect(res.payload.errors.otp).toBe("OTP is required");
  });

  test("a wrong OTP is refused and no session is minted", async () => {
    const user = makeUser();
    await callLogin(loginBody());
    const res = await callLogin(
      loginBody({ otpTextBox: true, otp: String((Number(user.otp) + 1) % 1000000).padStart(6, "0") })
    );
    expect(res.statusCode).toBe(400);
    expect(res.payload.errors.otp).toBe("Invalid OTP");
    expect(mockDb.redisWrites).toHaveLength(0);
  });

  test("the email OTP window is 3.4 minutes", async () => {
    const user = makeUser();
    await callLogin(loginBody());
    const otp = String(user.otp);

    user.otptime = new Date(Date.now() - 3.3 * 60 * 1000);
    expect((await callLogin(loginBody({ otpTextBox: true, otp }))).statusCode).toBe(200);

    // A fresh code, then push it just past the window.
    await callLogin(loginBody());
    const otp2 = String(user.otp);
    user.otptime = new Date(Date.now() - 3.5 * 60 * 1000);
    const late = await callLogin(loginBody({ otpTextBox: true, otp: otp2 }));
    expect(late.statusCode).toBe(400);
    expect(late.payload.errors.otp).toBe("OTP Expired");
  });

  test("the correct OTP mints the session row the passport strategy reads", async () => {
    const user = makeUser();
    await callLogin(loginBody());
    const otp = String(user.otp);

    const res = await callLogin(
      loginBody({
        otpTextBox: true,
        otp,
        loginHistory: { ipaddress: "127.0.0.1", broswername: "itest" },
      })
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe("SUCCESS");
    expect(res.payload.token).toMatch(/^Bearer /);

    // Exactly one session row, keyed by the user id, on the `userToken` hash.
    expect(mockDb.redisWrites).toHaveLength(1);
    const write = mockDb.redisWrites[0];
    expect(write.key).toBe("userToken");
    expect(write.id).toBe(String(user._id));
    expect(write.data.userLocked).toBe("false");
    expect(write.data.email).toBe("user@example.com");
    expect(write.data.tokenId).toBeTruthy();

    // The token in the reply carries the SAME tokenId the session row holds -
    // this pairing is the whole of session revocation.
    const decoded = jwt.verify(res.payload.token.slice(7), config.secretOrKey);
    expect(String(decoded.tokenId)).toBe(String(write.data.tokenId));
    expect(String(decoded._id)).toBe(String(user._id));
    expect(decoded.role).toBe("user");

    // The session row must never carry password material.
    expect(JSON.stringify(write.data)).not.toContain(user.hash);
    expect(JSON.stringify(write.data)).not.toContain(user.salt);

    // Counters reset, success recorded.
    expect(user.login_attempt).toBe(0);
    expect(user.isBlock).toBe(false);
    // Nothing is journalled any more - the LoginHistory collection went with
    // the login-history screens. The session row above is the thing that has to
    // exist, because passport reads it on every subsequent request.
    expect(mockDb.loginHistory).toHaveLength(0);
  });

  test("login publishes no derivative preferences, in the reply or the session", async () => {
    // Both derivative engines were deleted in 1f0dc62. Login went on returning
    // the WHOLE UserSetting document, so every sign-in still shipped
    // showFuture / showInverse / showOFuture / showOInverse / leverage /
    // inverseLeverage, and copied derivativeMode and inverseMode into the redis
    // session row on top of that. The settings fixture above still stores all
    // of them, so this fails the moment the handler stops filtering.
    const user = makeUser();
    await callLogin(loginBody());
    const res = await callLogin(
      loginBody({ otpTextBox: true, otp: String(user.otp) })
    );

    expect(res.statusCode).toBe(200);
    const dead = [
      "showFuture",
      "showInverse",
      "showOFuture",
      "showOInverse",
      "leverage",
      "inverseLeverage",
      "derivativeMode",
      "inverseMode",
    ];
    for (const key of dead) {
      expect(res.payload.userSetting).not.toHaveProperty(key);
      expect(mockDb.redisWrites[0].data).not.toHaveProperty(key);
    }

    // The preferences that survive still travel, so this is a filter and not a
    // deletion of the block.
    expect(res.payload.userSetting.theme).toBe("dark");
    expect(res.payload.userSetting.currencySymbol).toBe("USD");
    expect(mockDb.redisWrites[0].data.defaultWallet).toBe("spot");
    expect(mockDb.redisWrites[0].data.theme).toBe("dark");
  });

  test("each successful login gets a DIFFERENT tokenId, so the previous session dies", async () => {
    const user = makeUser();
    await callLogin(loginBody());
    await callLogin(loginBody({ otpTextBox: true, otp: String(user.otp) }));
    await callLogin(loginBody());
    await callLogin(loginBody({ otpTextBox: true, otp: String(user.otp) }));

    expect(mockDb.redisWrites).toHaveLength(2);
    expect(String(mockDb.redisWrites[0].data.tokenId)).not.toBe(
      String(mockDb.redisWrites[1].data.tokenId)
    );
  });

  test("TEST_MODE=true skips the OTP step entirely - a bypass, pinned deliberately", async () => {
    // auth.controller wraps the whole OTP block in `if (process.env.TEST_MODE
    // !== 'true')`. The integration harness forces it OFF for that reason; this
    // test documents what the flag actually does so nobody ships it enabled.
    process.env.TEST_MODE = "true";
    const user = makeUser();
    const res = await callLogin(loginBody());
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe("SUCCESS");
    expect(res.payload.token).toMatch(/^Bearer /);
    expect(mockDb.redisWrites).toHaveLength(1);
    expect(String(user.otp)).toBe("");
  });
});
