/**
 * EVERY REQUEST GETS AN ANSWER (SWEEP)
 * ====================================
 *
 * A handler that returns without calling `res.*` leaves the socket open.
 * Express cannot detect it; the client waits until it gives up. userapi has a
 * `responseGuard(60000)` backstop in server.js that eventually forces a 500,
 * so in THIS service the symptom is a request that takes a minute and then
 * lies about why it failed - but the other five services have no such
 * backstop, so the same shape hangs indefinitely there.
 *
 * The reported instance was POST /api/user/sendOTP (`requestOTP`): its two
 * branches were `roleType == 2` and `roleType == 1`, the route is mounted with
 * NO validator, and any other value - including the request that omits the
 * field - fell off the end of the function. That handler now has ONE path (the
 * SMS channel went with the phone surface), so the shape is gone rather than
 * patched; the cases below still prove every body gets a reply.
 *
 * A source-level sweep of all six services' controllers (an AST walk for
 * handlers with a path that ends without a response) found the same shape in
 * this service in `resendOTP` (unauthenticated) and `showPair`, plus the two
 * 2FA handlers whose fall-through is currently unreachable. Those are the
 * user-reachable ones, and they are what this file covers.
 *
 * Guards:
 *   R1  requestOTP answers for every roleType, including a missing one;
 *   R2  resendOTP answers for roleType 2, the SMS channel this venue disabled;
 *   R3  showPair answers when the settings document is missing;
 *   R4  no handler covered here can be edited back into silence without a
 *       failure - each assertion is "res was called", never "it did not throw".
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

const mockUserDoc = {
  _id: "u1",
  email: "user@example.com",
  phoneCode: "1",
  phoneNo: "5550000",
  otp: "",
  otptime: new Date(),
  emailOTP: "",
  emailOTPtime: new Date(),
  requestType: "",
  antiphishingcode: "",
  save: jest.fn(),
};

const mockUserModel = {
  findOne: jest.fn(async () => mockUserDoc),
  findById: jest.fn(async () => mockUserDoc),
  findByIdAndUpdate: jest.fn(async () => mockUserDoc),
  updateOne: jest.fn(),
};

const mockUserSetting = {
  findById: jest.fn(),
  findOne: jest.fn(),
  findByIdAndUpdate: jest.fn(async () => null),
  updateOne: jest.fn(),
};

jest.mock("../../models/index.js", () => ({
  User: mockUserModel,
  UserSetting: mockUserSetting,
  UserKyc: { findById: jest.fn(), findOne: jest.fn() },
  SiteSetting: { findOne: jest.fn() },
  ipAddress: { findOne: jest.fn(async () => null) },
  Notification: { find: jest.fn() },
  LoginHistory: class {
    async save() {
      return this;
    }
  },
  Language: { findOne: jest.fn(async () => null) },
  Admin: { findById: jest.fn() },
}));

jest.mock("../../grpc/currencyService.js", () => ({ currencyId: jest.fn() }));
jest.mock("../../grpc/walletService.js", () => ({
  deactivateWallet: jest.fn(),
  newAsset: jest.fn(),
}));
jest.mock("../../grpc/spotService.js", () => ({
  cancelOrderForDeactiveAcc: jest.fn(),
}));
jest.mock("../../controllers/redis.controller.js", () => ({
  hget: jest.fn(async () => null),
  hset: jest.fn(),
  hdel: jest.fn(),
  hgetall: jest.fn(),
  hmset: jest.fn(),
  hmget: jest.fn(),
}));
jest.mock("../../controllers/notification.controller.js", () => ({
  newNotification: jest.fn(),
}));
jest.mock("../../controllers/emailTemplate.controller.js", () => ({
  mailTemplateLang: jest.fn(),
}));
jest.mock("../../config/socketIO.js", () => ({
  createSocketIO: jest.fn(),
  socketEmitAll: jest.fn(),
  socketEmitOne: jest.fn(),
}));

const { requestOTP, showPair } = require("../../controllers/user.controller.js");
const { resendOTP } = require("../../controllers/auth.controller.js");

/**
 * A response double that records whether it was USED. `answered` is the whole
 * point: a handler that returns without touching res is the defect.
 */
/** showPair casts req.user.id with mongoose's ObjectId, so it must be one. */
const SETTINGS_ID = "6a76bc6f9029e856d643554b";

const mockRes = () => {
  const res = {
    answered: false,
    statusCode: null,
    payload: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(p) {
      this.answered = true;
      this.payload = p;
      return this;
    },
    send(p) {
      this.answered = true;
      this.payload = p;
      return this;
    },
    end() {
      this.answered = true;
      return this;
    },
  };
  return res;
};

// jest.config.js sets resetMocks/restoreMocks, so every implementation given
// at jest.mock() time is wiped before each test. Everything these handlers
// actually consume has to be re-supplied here, or a happy-path assertion
// measures the harness rather than the handler.
const redis = require("../../controllers/redis.controller.js");
const { mailTemplateLang } = require("../../controllers/emailTemplate.controller.js");

beforeEach(() => {
  jest.clearAllMocks();
  mockUserModel.findOne.mockImplementation(async () => mockUserDoc);
  mockUserModel.findById.mockImplementation(async () => mockUserDoc);
  mockUserSetting.findByIdAndUpdate.mockImplementation(async () => null);
  redis.hget.mockImplementation(async () => null);
  redis.hset.mockImplementation(async () => true);
  mailTemplateLang.mockImplementation(async () => true);
  mockUserDoc.save.mockImplementation(async () => mockUserDoc);
  mockUserDoc.emailOTP = "";
  mockUserDoc.otp = "";
  mockUserDoc.requestType = "";
  mockUserDoc.otptime = new Date();
  mockUserDoc.emailOTPtime = new Date();
});

// ---------------------------------------------------------------------------

describe("R1 POST /api/user/sendOTP (requestOTP)", () => {
  const call = async (body) => {
    const res = mockRes();
    await requestOTP({ body, user: { id: "u1" } }, res);
    return res;
  };

  // THE HOLE IS CLOSED BY CONSTRUCTION NOW, NOT BY A TERMINAL BRANCH.
  //
  // This handler used to be two `if (roleType == N)` blocks with nothing after
  // them, so `{}` or `{"roleType":3}` fell off the end and answered nothing.
  // The SMS branch is gone with the phone surface and `roleType` is no longer
  // read at all: there is one path, it always mails, and it always answers.
  // These cases are kept exactly as they were - a bad or missing roleType must
  // still get a reply - but the reply is now the code, not a refusal.
  test.each([
    ["omitted", {}],
    ["3", { roleType: 3 }],
    ["0", { roleType: 0 }],
    ["a string", { roleType: "email" }],
    ["null", { roleType: null }],
    ["1 (the old email channel)", { roleType: 1 }],
    ["2 (the old SMS channel)", { roleType: 2 }],
  ])("answers when roleType is %s", async (_label, body) => {
    const res = await call({ requestType: `sweep-${Math.random()}`, ...body });
    expect(res.answered).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe("RESEND_OTP");
  });

  test("it mails the code rather than texting it", async () => {
    const res = await call({ roleType: 2, requestType: "BindMobile" });
    expect(res.answered).toBe(true);
    expect(mailTemplateLang).toHaveBeenCalled();
    const [args] = mailTemplateLang.mock.calls[0];
    expect(args.identifier).toBe("EMAIL_VERIFICATION_OTP");
    expect(args.toEmail).toBe(mockUserDoc.email);
    expect(String(args.content.emailOtp)).toMatch(/^\d{6}$/);
  });

  test("the 3-minute cooldown still answers instead of hanging", async () => {
    mockUserDoc.emailOTP = "123456";
    mockUserDoc.requestType = "ChangePass";
    mockUserDoc.emailOTPtime = new Date();
    const res = await call({ requestType: "ChangePass" });
    expect(res.answered).toBe(true);
    expect(res.statusCode).toBe(400);
  });

  test("an unknown user is still refused rather than served", async () => {
    mockUserModel.findOne.mockImplementationOnce(async () => null);
    const res = await call({ roleType: 1 });
    expect(res.answered).toBe(true);
    expect(res.statusCode).toBe(400);
  });
});

describe("R2 POST /api/resend-otp (resendOTP)", () => {
  const call = async (body) => {
    const res = mockRes();
    await resendOTP({ body }, res);
    return res;
  };

  test("roleType 2 - the removed SMS channel - still answers", async () => {
    // The phone lookup this branch used to do is gone, so `userData` is never
    // assigned and the `!userData` guard refuses. The point of the case is
    // unchanged: the request is ANSWERED, not left hanging on an
    // unauthenticated route.
    const res = await call({ roleType: 2, newPhoneNo: "5550000", newPhoneCode: "1" });
    expect(res.answered).toBe(true);
    expect(res.statusCode).toBe(400);
  });

  test("roleType 1 is unchanged", async () => {
    const res = await call({ roleType: 1, email: "USER@example.com" });
    expect(res.answered).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe("RESEND_OTP");
  });

  test("an unknown account is refused, not left hanging", async () => {
    mockUserModel.findOne.mockImplementation(async () => null);
    const res = await call({ roleType: 2, newPhoneNo: "1", newPhoneCode: "1" });
    expect(res.answered).toBe(true);
    expect(res.statusCode).toBe(400);
  });
});

describe("R3 POST showPair", () => {
  const call = async (body) => {
    const res = mockRes();
    await showPair({ body, user: { id: SETTINGS_ID } }, res);
    return res;
  };

  test("answers when there is no settings document to update", async () => {
    // `findByIdAndUpdate` returning null used to reach `else return
    // { status: false };` - a plain object handed to express, which does
    // nothing with it.
    const res = await call({ type: "spot-show", showSpot: true });
    expect(res.answered).toBe(true);
    expect(res.statusCode).toBe(400);
  });

  test("the success path is unchanged", async () => {
    mockUserSetting.findByIdAndUpdate.mockImplementationOnce(async () => ({
      showFuture: true,
      showInverse: true,
      showOFuture: true,
      showOInverse: true,
      showSpot: true,
    }));
    const res = await call({ type: "spot-show", showSpot: true });
    expect(res.answered).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  // THE FALL-THROUGH BRANCH IS GONE, AND SO IS THE SILENT WRITE.
  // The type chain used to end in `else { showOInverse: reqBody.showOInverse }`,
  // so an unknown type wrote `showOInverse: undefined` to the settings document
  // and answered 200 "Done". Four of the five branches named the deleted
  // derivative products; `spot-show` is the only one a client sends.
  test.each([
    ["a derivative type that no longer has an engine", { type: "perpetual-showfuture", showFuture: true }],
    ["the other derivative type", { type: "inverse-showfuture", showInverse: true }],
    ["the open-orders derivative toggle", { type: "perpetual-showopen", showOFuture: true }],
    ["a typo", { type: "spot-shwo", showSpot: true }],
    ["no type at all", { showSpot: true }],
  ])("refuses %s with 400 and writes nothing", async (_label, body) => {
    mockUserSetting.findByIdAndUpdate.mockClear();
    const res = await call(body);
    expect(res.answered).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(mockUserSetting.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
