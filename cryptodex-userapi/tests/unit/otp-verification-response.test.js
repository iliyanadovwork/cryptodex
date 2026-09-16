/**
 * WHAT THE CODE-VERIFYING ENDPOINTS ACTUALLY TELL THE CALLER (REGRESSION)
 * ======================================================================
 *
 * WHAT THIS FILE USED TO COVER, AND WHY IT MOVED
 * ----------------------------------------------
 * It covered `user.controller.OTPVerification`, the standalone
 * POST /api/user/verifyOtp probe, and the bug it was written for: the mobile
 * branch built its failure response out of `EmailOTPResp`, a variable that only
 * exists in the EMAIL branch, so a mistyped mobile digit threw a ReferenceError
 * and came back "Error on server".
 *
 * THAT ENDPOINT IS GONE. No client ever called it - it was dead surface next to
 * the flows that verify a code inline - and the phone channel it half-supported
 * is gone with the rest of the phone surface.
 *
 * THE SAME QUESTION STILL MATTERS, on the endpoint that now owns it:
 * POST /api/user/changePassword. That handler verifies the mailed code itself
 * before it will rotate a password, and it is on this project's regression
 * baseline, so what it says about a wrong code - and, more importantly, THAT IT
 * STILL REFUSES ONE - is pinned here.
 *
 * The `type` field is the other half. changePassword used to branch on it (2 =
 * e-mail, 1 = SMS) and refuse anything else with "Invalid type" AFTER assigning
 * the new password to the in-memory document. With one channel left, `type` is
 * ignored: the mailed code is the only code there is, and an older client that
 * still sends `type: 1` gets its password changed instead of an error about a
 * field that no longer decides anything.
 *
 * `updateProfileImage` is covered here for a related reason: it returned
 * `success: false` next to a 200 and a SUCCESS message, so the standard
 * `if (result.data.success)` check every caller in this codebase uses read a
 * completed update as a failure.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// doubles - user.controller reaches for grpc, redis and mail on import
// ---------------------------------------------------------------------------

const mockUserDoc = {
  _id: 'u1',
  email: 'u1@example.test',
  firstName: 'Test',
  password: null,
  changepassword: false,
  percentage: 0,
  antiphishingcode: '',
  otp: '654321',
  otptime: new Date(),
  emailOTP: '123456',
  emailOTPtime: new Date(),
  requestType: 'ChangePass',
  authenticate: jest.fn((plain) => plain === 'OldPass123!'),
  save: jest.fn(async () => mockUserDoc),
};

const mockUserModel = {
  findOne: jest.fn(async () => mockUserDoc),
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(async () => mockUserDoc),
  updateOne: jest.fn(),
};

jest.mock('../../models/index.js', () => ({
  User: mockUserModel,
  UserSetting: { findOne: jest.fn(async () => ({ passwordChange: false })), updateOne: jest.fn() },
  UserKyc: { findById: jest.fn(), findOne: jest.fn() },
  SiteSetting: { findOne: jest.fn() },
  ipAddress: { findOne: jest.fn() },
  Notification: { find: jest.fn() },
  LoginHistory: { findOne: jest.fn() },
}));

jest.mock('../../grpc/walletService.js', () => ({ deactivateWallet: jest.fn() }));
jest.mock('../../grpc/spotService.js', () => ({ cancelOrderForDeactiveAcc: jest.fn() }));
// Doubled because these gRPC clients are ESM modules that resolve their .proto
// next to themselves via `import.meta.url`, which jest's CJS transform cannot
// parse. Nothing in this file exercises account deactivation; the mock only
// keeps user.controller.js loadable.
jest.mock('../../controllers/redis.controller.js', () => ({
  hget: jest.fn(),
  hset: jest.fn(),
  hdel: jest.fn(),
  hmset: jest.fn(),
}));
jest.mock('../../controllers/notification.controller.js', () => ({ newNotification: jest.fn() }));
jest.mock('../../controllers/emailTemplate.controller.js', () => ({ mailTemplateLang: jest.fn() }));

const { changePassword, updateProfileImage } = require('../../controllers/user.controller.js');
// jest.config.js sets `resetMocks: true`, which strips every mock's
// implementation before each test - including the ones declared in the factories
// above. Anything a handler under test actually calls has to be re-armed in
// beforeEach, or it silently returns undefined and the handler 500s on it.
const { UserSetting } = require('../../models/index.js');

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const makeRes = () => {
  const out = { statusCode: null, body: null };
  return {
    out,
    res: {
      status(code) {
        out.statusCode = code;
        return this;
      },
      json(payload) {
        out.body = payload;
        return this;
      },
    },
  };
};

const changeReq = (body) => ({
  user: { id: 'u1' },
  params: {},
  body: { oldPassword: 'OldPass123!', password: 'NewPass123!', confirmPassword: 'NewPass123!', ...body },
});

beforeEach(() => {
  mockUserDoc.password = null;
  mockUserDoc.otp = '654321';
  mockUserDoc.otptime = new Date();
  mockUserDoc.emailOTP = '123456';
  mockUserDoc.emailOTPtime = new Date();
  mockUserDoc.requestType = 'ChangePass';
  mockUserDoc.authenticate = jest.fn((plain) => plain === 'OldPass123!');
  mockUserDoc.save = jest.fn(async () => mockUserDoc);
  mockUserModel.findOne.mockReset().mockResolvedValue(mockUserDoc);
  mockUserModel.findByIdAndUpdate.mockReset().mockResolvedValue(mockUserDoc);
  // changePassword reads the user's notification preferences to decide whether
  // to mail the "your password changed" alert.
  UserSetting.findOne.mockReset().mockResolvedValue({ passwordChange: false });
});

// ===========================================================================
// GUARD - the mailed code is still REQUIRED to change a password
// ===========================================================================

describe('changePassword still enforces the mailed code', () => {
  test('a wrong code is refused, and nothing is saved', async () => {
    const { res, out } = makeRes();

    await changePassword(changeReq({ otp: '000000', type: 2 }), res);

    expect(out.statusCode).toBe(400);
    expect(out.body.success).toBe(false);
    expect(out.body.message).toBe('Invalid verification code');
    expect(out.body.message).not.toMatch(/error on server/i);
    expect(mockUserDoc.save).not.toHaveBeenCalled();
  });

  test('the failure names the otp field, so the form can attach the error', async () => {
    const { res, out } = makeRes();

    await changePassword(changeReq({ otp: '000000', type: 2 }), res);

    expect(out.body.error).toEqual({ otp: 'Invalid verification code' });
  });

  test('an expired code is reported as expired, and nothing is saved', async () => {
    mockUserDoc.emailOTPtime = new Date(Date.now() - 60 * 60 * 1000);
    const { res, out } = makeRes();

    await changePassword(changeReq({ otp: '123456', type: 2 }), res);

    expect(out.statusCode).toBe(400);
    expect(out.body.message).toBe('Verification code expired');
    expect(mockUserDoc.save).not.toHaveBeenCalled();
  });

  test('a request with NO code at all is refused', async () => {
    const { res, out } = makeRes();

    await changePassword(changeReq({ type: 2 }), res);

    expect(out.statusCode).toBe(400);
    expect(mockUserDoc.save).not.toHaveBeenCalled();
  });

  test('the correct code rotates the password and clears the stored code', async () => {
    const { res, out } = makeRes();

    await changePassword(changeReq({ otp: '123456', type: 2 }), res);

    expect(out.statusCode).toBe(200);
    expect(out.body.success).toBe(true);
    expect(mockUserDoc.password).toBe('NewPass123!');
    expect(mockUserDoc.emailOTP).toBe('');
    expect(mockUserDoc.save).toHaveBeenCalled();
  });

  test('a wrong CURRENT password is refused before the code is even looked at', async () => {
    const { res, out } = makeRes();

    await changePassword(changeReq({ oldPassword: 'nope', otp: '123456', type: 2 }), res);

    expect(out.statusCode).toBe(400);
    expect(out.body.errors).toEqual({ oldPassword: 'Incorrect Password' });
    expect(mockUserDoc.save).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GUARD - `type` no longer decides anything, because there is one channel
// ===========================================================================

describe('the `type` field no longer gates the change', () => {
  test('the legacy mobile type still changes the password, given the mailed code', async () => {
    // Before: `type: 1` checked the SMS code, which /sendOTP no longer issues,
    // so a client that still sends it could never change its password again.
    const { res, out } = makeRes();

    await changePassword(changeReq({ otp: '123456', type: 1 }), res);

    expect(out.statusCode).toBe(200);
    expect(mockUserDoc.password).toBe('NewPass123!');
  });

  test('a request with no type at all works too', async () => {
    const { res, out } = makeRes();

    await changePassword(changeReq({ otp: '123456' }), res);

    expect(out.statusCode).toBe(200);
    expect(out.body.success).toBe(true);
  });

  test('"Invalid type" is gone as a refusal', async () => {
    const { res, out } = makeRes();

    await changePassword(changeReq({ otp: '123456', type: 99 }), res);

    expect(out.body.message).not.toMatch(/invalid type/i);
    expect(out.statusCode).toBe(200);
  });

  test('but a bogus type does NOT skip the code check', async () => {
    // The point of ignoring `type` is one channel, not no channel.
    const { res, out } = makeRes();

    await changePassword(changeReq({ otp: '000000', type: 99 }), res);

    expect(out.statusCode).toBe(400);
    expect(mockUserDoc.save).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GUARD - a successful update reports success
// ===========================================================================

describe('updating the profile image', () => {
  test('a completed update reports success:true alongside its 200', async () => {
    const { res, out } = makeRes();

    await updateProfileImage(
      { user: { id: 'u1' }, body: { profileImage: 'avatar.png' } },
      res
    );

    expect(out.statusCode).toBe(200);
    expect(out.body.success).toBe(true);
  });

  test('a failed update is a 500 that reports success:false', async () => {
    mockUserModel.findByIdAndUpdate.mockRejectedValue(new Error('mongo down'));
    const { res, out } = makeRes();

    await updateProfileImage(
      { user: { id: 'u1' }, body: { profileImage: 'avatar.png' } },
      res
    );

    expect(out.statusCode).toBe(500);
    expect(out.body.success).toBe(false);
  });
});
