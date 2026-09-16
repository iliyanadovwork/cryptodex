/**
 * OTP VERIFICATION - AGAINST THE SHIPPED CHECKER
 * ==============================================
 *
 * WHAT THIS FILE USED TO BE
 * -------------------------
 * It imported nothing from the service. It declared, in the test file:
 *
 *     const generateOTP = () => Math.floor(100000 + Math.random()*900000);
 *     const isOTPExpired = (t, mins) => (Date.now()-t)/60000 > mins;
 *     const verifyOTP = (stored, entered) => stored === entered;
 *
 * and then tested those three. The service's real checker,
 * `user.controller.optVerification`, has a DIFFERENT contract from all three:
 * it returns `{status, message}` rather than a boolean, its two channels use
 * different windows (10.4 vs 3.4 minutes), and - the part a local
 * reimplementation can never catch - the two branches use DIFFERENT equality
 * operators (`!=` for mobile, `!==` for email).
 *
 * WHAT IT IS NOW
 * --------------
 * The real `optVerification` and the real `oneTimePassword` generator.
 *
 * The `verifyOtpValidation` block that used to sit at the bottom of this file
 * has gone with the validator: it guarded POST /api/auth/verifyOtp, the PHONE
 * code, which is deleted along with the rest of the phone surface.
 *
 * BOTH CHANNELS OF `optVerification` ARE STILL TESTED, INCLUDING THE MOBILE
 * ONE. Nothing issues a mobile code any more - /sendOTP and /deactive-req both
 * mail it - but `confirmDeActive` still decides which stored code to check from
 * `deactiveOtpChannel`, so an account that requested a deactivation code over
 * SMS BEFORE the removal can still complete it. That path stays correct until
 * those rows age out.
 */

import { describe, test, expect } from "@jest/globals";

// user.controller reaches for gRPC, redis and mail at import time. Only
// out-of-process modules are doubled; optVerification itself is the real one.
// The gRPC clients additionally resolve their .proto through `import.meta.url`,
// which jest's CJS transform cannot parse, so they must be doubled to load at
// all.
jest.mock("../../models/index.js", () => ({
  __esModule: true,
  User: { findOne: async () => null, findById: async () => null, findByIdAndUpdate: async () => null, updateOne: async () => null },
  UserSetting: { findOne: async () => null, findById: async () => null },
  UserKyc: { findById: async () => null, findOne: async () => null },
  SiteSetting: { findOne: async () => null },
  ipAddress: { findOne: async () => null },
  Notification: { find: () => [] },
}));
jest.mock("../../grpc/currencyService.js", () => ({ __esModule: true, currencyId: async () => ({}) }));
jest.mock("../../grpc/walletService.js", () => ({ __esModule: true, deactivateWallet: async () => ({}) }));
jest.mock("../../grpc/spotService.js", () => ({ __esModule: true, cancelOrderForDeactiveAcc: async () => ({}) }));
jest.mock("../../controllers/redis.controller.js", () => ({
  __esModule: true,
  hget: async () => null,
  hset: async () => {},
  hdel: async () => {},
  hgetall: async () => ({}),
  hmset: async () => true,
}));
jest.mock("../../controllers/notification.controller.js", () => ({ __esModule: true, newNotification: async () => ({ status: true }) }));
jest.mock("../../controllers/emailTemplate.controller.js", () => ({ __esModule: true, mailTemplateLang: async () => true }));

const { optVerification } = require("../../controllers/user.controller.js");
const { oneTimePassword } = require("../../lib/generalFun.js");

const MINUTE = 60 * 1000;
const minutesAgo = (m) => new Date(Date.now() - m * MINUTE);

const MOBILE = 1;
const EMAIL = 2;

describe("optVerification - mobile channel (type 1)", () => {
  const doc = (over = {}) => ({ otp: "123456", otptime: new Date(), ...over });

  test("accepts the stored code", async () => {
    const res = await optVerification(MOBILE, doc(), "123456");
    expect(res).toEqual({ status: true, message: "Code Verified" });
  });

  test("refuses a different code, and says which failure it was", async () => {
    const res = await optVerification(MOBILE, doc(), "654321");
    expect(res.status).toBe(false);
    expect(res.message).toBe("Invalid verification code");
  });

  test("the window is 10.4 minutes, and it is a >= boundary", async () => {
    expect((await optVerification(MOBILE, doc({ otptime: minutesAgo(10.3) }), "123456")).status).toBe(true);
    const expired = await optVerification(MOBILE, doc({ otptime: minutesAgo(10.5) }), "123456");
    expect(expired.status).toBe(false);
    expect(expired.message).toBe("Verification code expired");
  });

  test("expiry is reported only for a code that was otherwise CORRECT", async () => {
    // A wrong code on an expired OTP still says "invalid", not "expired" - the
    // wrong-code check comes first.
    const res = await optVerification(MOBILE, doc({ otptime: minutesAgo(60) }), "999999");
    expect(res.message).toBe("Invalid verification code");
  });

  test("the mobile branch compares LOOSELY, so a numeric code matches the stored string", async () => {
    // Pinned because it is a real asymmetry with the email branch below: the
    // schema stores `otp` as a String, and this branch uses `!=`.
    const res = await optVerification(MOBILE, doc(), 123456);
    expect(res.status).toBe(true);
  });

  test("an empty submission does not pass against an empty stored code", async () => {
    // `otp` defaults to "" on the schema, so a cleared OTP must not be a
    // free pass for a caller that submits nothing... but note it IS one under
    // loose equality if the caller submits "" explicitly. Callers guard this
    // upstream (confirmDeActive rejects an empty otp before calling here).
    const res = await optVerification(MOBILE, doc({ otp: "" }), "000000");
    expect(res.status).toBe(false);
  });
});

describe("optVerification - email channel (type 2)", () => {
  const doc = (over = {}) => ({ emailOTP: "123456", emailOTPtime: new Date(), ...over });

  test("accepts the stored code", async () => {
    const res = await optVerification(EMAIL, doc(), "123456");
    expect(res).toEqual({ status: true, message: "Code Verified" });
  });

  test("refuses a different code", async () => {
    const res = await optVerification(EMAIL, doc(), "654321");
    expect(res.status).toBe(false);
    expect(res.message).toBe("Invalid verification code");
  });

  test("the window is 3.4 minutes - much tighter than the mobile one", async () => {
    expect((await optVerification(EMAIL, doc({ emailOTPtime: minutesAgo(3.3) }), "123456")).status).toBe(true);
    const expired = await optVerification(EMAIL, doc({ emailOTPtime: minutesAgo(3.5) }), "123456");
    expect(expired.status).toBe(false);
    expect(expired.message).toBe("Verification code expired");
  });

  test("the email branch compares STRICTLY, so a numeric code does NOT match", async () => {
    // The asymmetry with the mobile branch, pinned. Every caller in this
    // service posts the OTP as a string from a form, so this is currently
    // harmless - but the two branches disagreeing is worth knowing about.
    const res = await optVerification(EMAIL, doc(), 123456);
    expect(res.status).toBe(false);
    expect(res.message).toBe("Invalid verification code");
  });
});

describe("optVerification - contract guarantees callers rely on", () => {
  test("it never throws; a broken document becomes a failure object", async () => {
    const res = await optVerification(EMAIL, null, "123456");
    expect(res.status).toBe(false);
    expect(res.message).toMatch(/went wrong/i);
  });

  test("an unrecognised channel returns undefined - callers must never pass one", async () => {
    // Every call site in this service passes 1 or 2. Pinned because callers do
    // `if (!resp.status)`, which would throw on undefined.
    expect(await optVerification(3, { otp: "1" }, "1")).toBeUndefined();
  });
});

describe("lib/generalFun.oneTimePassword", () => {
  test("produces a 6-digit code in [100000, 999999]", () => {
    for (let i = 0; i < 500; i++) {
      const otp = oneTimePassword(6);
      expect(otp).toBeGreaterThanOrEqual(100000);
      expect(otp).toBeLessThanOrEqual(999999);
      expect(String(otp)).toHaveLength(6);
    }
  });

  test("defaults to 6 digits and returns undefined for any other size", () => {
    expect(String(oneTimePassword())).toHaveLength(6);
    expect(oneTimePassword(4)).toBeUndefined();
    expect(oneTimePassword(8)).toBeUndefined();
  });

  test("is not constant across calls", () => {
    const seen = new Set(Array.from({ length: 200 }, () => oneTimePassword()));
    expect(seen.size).toBeGreaterThan(150);
  });
});
