/**
 * ACCOUNT DEACTIVATION + 2FA ENROLMENT (SECURITY / DATA-LOSS REGRESSION)
 * =====================================================================
 *
 * THREE THINGS WERE WRONG, AND THEY ARE ALL PINNED HERE.
 *
 * 1. DEACTIVATION DESTROYED THE ACCOUNT AND THEN 500ed.
 *    `confirmDeActive` shredded 25 fields on the user (email overwritten with
 *    the literal "anonymous@gmail.com", status/type/2FA-secret/address all
 *    wiped), committed that with `await checkUser.save()`, and only THEN
 *    called out to cancel the user's open orders, stand down their wallets and
 *    purge their session. The very first of those calls - deactivateWallet -
 *    is the one client in grpc/walletService.js that had no `.catch()`, and
 *    walletapi does not implement the RPC at all, so it returned
 *    `12 UNIMPLEMENTED` every time and the rejection propagated. The catch
 *    answered "SOMETHING WRONG".
 *
 *    Reproduced live against a throwaway account before the fix: HTTP 500,
 *    user document already reduced to anonymous@gmail.com / unverified /
 *    not_activate, and `GET /api/user/profile` with the pre-deactivation
 *    bearer token still returned 200 - because the `hdel("userToken", ...)`
 *    that ends the session is three lines further down and never ran.
 *
 *    So: orders resting on the book, balances behind an identity nothing could
 *    reach, and a live session on a "deactivated" account.
 *
 * 2. BOTH DEACTIVATION ROUTES WERE UNAUTHENTICATED.
 *    `/deactive-req` looked its target up by the `email` in the request body.
 *    Anyone could POST any registered address and that person would be mailed
 *    a live deactivation code, as many times as the 3-minute throttle allowed,
 *    forever. `/deactive-confirm` would then shred an account the caller had
 *    never proved they owned.
 *
 * (A third item covering the 2FA enrolment secret used to sit here. 2FA has
 * since been removed from this venue entirely - see the note where GUARDS 5-9
 * were.)
 *
 * These tests are written against the real controllers with the data layer and
 * the two gRPC calls doubled, so the ordering and the honesty of the responses
 * are exercised for real rather than asserted about source text.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// doubles
// ---------------------------------------------------------------------------

// Every cross-boundary effect lands here in call order, so a test can assert
// that the destructive write really does come after the teardown.
let calls = [];

const mockUserModel = {
  findOne: jest.fn(),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  updateOne: jest.fn(),
};

const mockUserKyc = { findOne: jest.fn(async () => null) };
const mockUserSetting = { findOne: jest.fn(async () => ({ twoFA: false })), updateOne: jest.fn() };

jest.mock('../../models/index.js', () => ({
  User: mockUserModel,
  UserSetting: mockUserSetting,
  UserKyc: mockUserKyc,
  SiteSetting: { findOne: jest.fn() },
  ipAddress: { findOne: jest.fn() },
  Notification: { find: jest.fn() },
  Contact: class {},
  LoginHistory: { findOne: jest.fn() },
  Anouncement: { find: jest.fn() },
}));

const mockCancelOrders = jest.fn();
const mockDeactivateWallet = jest.fn();

jest.mock('../../grpc/currencyService.js', () => ({ currencyId: jest.fn() }));
jest.mock('../../grpc/walletService.js', () => ({
  deactivateWallet: (...a) => mockDeactivateWallet(...a),
}));
jest.mock('../../grpc/spotService.js', () => ({
  cancelOrderForDeactiveAcc: (...a) => mockCancelOrders(...a),
}));

const mockHdel = jest.fn();
const mockHset = jest.fn();
const mockHget = jest.fn();
// jest.config.js sets resetMocks/restoreMocks, so every implementation has to
// be (re)installed in beforeEach rather than in the factory.
jest.mock('../../controllers/redis.controller.js', () => ({
  hget: (...a) => mockHget(...a),
  hset: (...a) => mockHset(...a),
  hdel: (...a) => mockHdel(...a),
  hgetall: jest.fn(),
  hmset: jest.fn(),
}));
jest.mock('../../controllers/notification.controller.js', () => ({ newNotification: jest.fn() }));
jest.mock('../../controllers/emailTemplate.controller.js', () => ({ mailTemplateLang: jest.fn() }));

/** The controller's own source, for the handful of shape contracts below. */
const CONTROLLER = fs.readFileSync(
  path.resolve(process.cwd(), 'controllers/user.controller.js'),
  'utf8'
);

const {
  confirmDeActive,
  undoFreezes,
  freezeAppliedByThisCall,
  deactiveRequest,
} = require('../../controllers/user.controller.js');

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const USER_ID = '6a7527221f4fb1b2fbe7bb7e';
const OWNER_EMAIL = 'owner@example.test';

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

const req = (body = {}, userId = USER_ID) => ({ user: { id: userId }, params: {}, body });

/** A stand-in for the mongoose User document, with a save() we can watch. */
function makeUserDoc(overrides = {}) {
  const doc = {
    _id: USER_ID,
    email: OWNER_EMAIL,
    emailStatus: 'verified',
    phoneStatus: 'unverified',
    status: 'verified',
    type: 'basic_pending',
    userLocked: 'false',
    percentage: 25,
    login_attempt: 0,
    isBlock: false,
    antiphishingcode: '',
    firstName: 'Real',
    lastName: 'Person',
    emailOTP: '',
    emailOTPtime: null,
    otp: '',
    otptime: null,
    phoneOTP: '',
    requestType: '',
    deactiveOtpChannel: '',
    deactivatedAt: null,
    google2Fa: { secret: '', uri: '', pendingSecret: '', pendingUri: '', pendingCreatedAt: null },
    ...overrides,
  };
  doc.save = jest.fn(async () => {
    calls.push('save');
    doc.saveCount = (doc.saveCount || 0) + 1;
    return doc;
  });
  return doc;
}

/**
 * A REALISTIC STAND-DOWN REPLY, because the `message` is load bearing.
 *
 * walletapi's lib/walletStandDown.js and both engines' lib/accountStandDown.js
 * answer `{ status, message }`, and the message is the ONLY thing that says
 * whether this call is what froze the account:
 *
 *   freeze   -> "FROZEN"          this call closed a live account
 *            -> "ALREADY_FROZEN"  somebody else had closed it already
 *   unfreeze -> "RESTORED" | "ALREADY_LIVE"
 *
 * A mock that answers a bare `{ status: true }` is not a stand-in for those
 * services - it is a stand-in for a service that has never existed - and it
 * hides the entire compensation decision. So the default double speaks the
 * real protocol.
 */
const standDownReply = (body) => {
  const mode = (body && body.mode) || 'freeze';
  if (mode === 'unfreeze') return { status: true, message: 'RESTORED' };
  if (mode === 'check') return { status: true, message: 'READY' };
  if (mode === 'teardown') return { status: true, message: 'TORN_DOWN' };
  return { status: true, message: 'FROZEN' };
};

/** A freeze that finds the account ALREADY closed - an operator hold. */
const alreadyFrozenReply = (body) => {
  const mode = (body && body.mode) || 'freeze';
  if (mode === 'unfreeze') return { status: true, message: 'RESTORED' };
  return { status: true, message: 'ALREADY_FROZEN' };
};

/** Put a live email deactivation OTP on the document, as deactiveRequest would. */
function armEmailOtp(doc, code = '424242') {
  doc.emailOTP = code;
  doc.emailOTPtime = new Date();
  doc.requestType = 'deactive';
  doc.deactiveOtpChannel = 'email';
  return code;
}

beforeEach(() => {
  calls = [];
  jest.clearAllMocks();
  mockUserKyc.findOne.mockResolvedValue(null);
  mockUserSetting.findOne.mockResolvedValue({ twoFA: false });
  mockCancelOrders.mockImplementation(async () => {
    calls.push('cancelOrders');
    return { status: true };
  });
  mockDeactivateWallet.mockImplementation(async (body) => {
    calls.push(
      body && body.mode === 'unfreeze' ? 'unfreezeWallet' : 'deactivateWallet'
    );
    return standDownReply(body);
  });
  mockHdel.mockImplementation(async () => {
    calls.push('hdel');
    return 1;
  });
  mockHset.mockResolvedValue(undefined);
  mockHget.mockResolvedValue(JSON.stringify({ userCode: 'uc' }));
});

// ===========================================================================
// GUARD 1 - deactivation acts on the SIGNED-IN account, never on a body field
// ===========================================================================

describe('deactivation is scoped to the authenticated user', () => {
  test('the OTP request targets req.user.id and ignores the email in the body', async () => {
    const doc = makeUserDoc();
    mockUserModel.findOne.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await deactiveRequest(
      req({ roleType: 1, requestType: 'deactive', email: 'victim@elsewhere.test' }),
      res
    );

    expect(out.statusCode).toBe(200);
    // The lookup must be by id. If any query key names email or phone, the
    // caller is still choosing the victim.
    const query = mockUserModel.findOne.mock.calls[0][0];
    expect(query._id).toBe(USER_ID);
    expect(query).not.toHaveProperty('email');
    expect(query).not.toHaveProperty('phoneNo');
  });

  test('the confirm step loads the account by id, not by the email in the body', async () => {
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, email: 'victim@elsewhere.test', otp: code }), res);

    expect(out.statusCode).toBe(200);
    expect(mockUserModel.findById).toHaveBeenCalledWith(USER_ID);
    expect(mockUserModel.findOne).not.toHaveBeenCalled();
  });

  test('a userId in the body cannot redirect the confirm at somebody else', async () => {
    // The body is attacker-controlled. Only the session decides whose account
    // is closed, whose wallet is stood down and whose book is swept.
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(
      req({ roleType: 2, otp: code, userId: '0123456789abcdef01234567', id: '0123456789abcdef01234567' }),
      res
    );

    expect(out.statusCode).toBe(200);
    expect(mockUserModel.findById).toHaveBeenCalledWith(USER_ID);
    expect(mockUserModel.findById).not.toHaveBeenCalledWith('0123456789abcdef01234567');
    expect(mockDeactivateWallet).toHaveBeenCalledWith({ userId: USER_ID });
    expect(mockCancelOrders).toHaveBeenCalledWith({ userId: USER_ID });
    expect(mockHdel).toHaveBeenCalledWith('userToken', USER_ID);
  });

  test('a request that still asks for SMS is served by e-mail, and STILL targets req.user.id', async () => {
    // The SMS channel is gone: `roleType` is ignored and the code is mailed.
    // The property this case exists for is unchanged and is the important one -
    // whatever the body says, the account is chosen by the session, never by a
    // phone number the caller supplied.
    const doc = makeUserDoc({ phoneStatus: 'verified', phoneCode: '1', phoneNo: '5550100' });
    mockUserModel.findOne.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await deactiveRequest(
      req({ roleType: 2, requestType: 'deactive', newPhoneNo: '5559999' }),
      res
    );

    expect(out.statusCode).toBe(200);
    const query = mockUserModel.findOne.mock.calls[0][0];
    expect(query._id).toBe(USER_ID);
    expect(query).not.toHaveProperty('phoneNo');
    expect(doc.deactiveOtpChannel).toBe('email');
  });

  test('the OTP request records which channel it sent on', async () => {
    const doc = makeUserDoc();
    mockUserModel.findOne.mockResolvedValue(doc);
    const { res } = makeRes();

    await deactiveRequest(req({ roleType: 1, requestType: 'deactive' }), res);

    expect(doc.deactiveOtpChannel).toBe('email');
    expect(doc.save).toHaveBeenCalled();
  });

  test('an unrecognised channel is answered, not left hanging', async () => {
    // There is one channel now, so a nonsense roleType is simply served by
    // e-mail. The point of the case survives: the request gets a reply.
    const doc = makeUserDoc();
    mockUserModel.findOne.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await deactiveRequest(req({ roleType: 9, requestType: 'deactive' }), res);

    expect(out.statusCode).toBe(200);
    expect(out.body.success).toBe(true);
    expect(doc.deactiveOtpChannel).toBe('email');
  });
});

// ===========================================================================
// GUARD 2 - the confirm step checks the code the SERVER sent, on the channel
//           the SERVER sent it on
// ===========================================================================

describe('the deactivation code is verified against server-held state', () => {
  test('a confirm with no prior request is refused', async () => {
    const doc = makeUserDoc(); // deactiveOtpChannel is ''
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: '424242' }), res);

    expect(out.statusCode).toBe(400);
    expect(out.body.status).toBe('NO_PENDING_REQUEST');
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('a missing otp is refused before anything is even looked up', async () => {
    const doc = makeUserDoc();
    armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: '' }), res);

    expect(out.statusCode).toBe(400);
    // "you didn't type a code" is a different thing from "that code is wrong",
    // and an empty submission must not cost a database read.
    expect(out.body.message).toBe('Please enter the otp');
    expect(mockUserModel.findById).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
    expect(mockCancelOrders).not.toHaveBeenCalled();
  });

  test('an omitted otp field is refused the same way', async () => {
    const doc = makeUserDoc();
    armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2 }), res);

    expect(out.statusCode).toBe(400);
    expect(out.body.message).toBe('Please enter the otp');
    expect(mockUserModel.findById).not.toHaveBeenCalled();
  });

  test('a wrong code leaves the account completely untouched', async () => {
    const doc = makeUserDoc();
    armEmailOtp(doc, '424242');
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: '000000' }), res);

    expect(out.statusCode).toBe(400);
    expect(out.body.message).toBe('Invalid verification code');
    expect(doc.status).toBe('verified');
    expect(doc.email).toBe(OWNER_EMAIL);
    expect(doc.save).not.toHaveBeenCalled();
    expect(mockCancelOrders).not.toHaveBeenCalled();
    expect(mockDeactivateWallet).not.toHaveBeenCalled();
    expect(mockHdel).not.toHaveBeenCalled();
  });

  test('an expired code is refused', async () => {
    const doc = makeUserDoc();
    armEmailOtp(doc, '424242');
    doc.emailOTPtime = new Date(Date.now() - 60 * 60 * 1000);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: '424242' }), res);

    expect(out.statusCode).toBe(400);
    expect(out.body.message).toBe('Verification code expired');
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('the mobile code cannot be used to satisfy an email request', async () => {
    // The two endpoints used OPPOSITE roleType conventions (deactive-req:
    // 1=email, deactive-confirm: 1=mobile), so the confirm step could be
    // pointed at the wrong stored code. The channel now comes from the record.
    const doc = makeUserDoc();
    armEmailOtp(doc, '424242'); // channel = email
    doc.otp = '111111'; // a stale mobile code from some other flow
    doc.otptime = new Date();
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    // Body says roleType 1, which the OLD code read as "mobile" and would have
    // happily matched against doc.otp.
    await confirmDeActive(req({ roleType: 1, otp: '111111' }), res);

    expect(out.statusCode).toBe(400);
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('the email code still works when the body claims the wrong roleType', async () => {
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 1, otp: code }), res);

    expect(out.statusCode).toBe(200);
  });

  test('an account already deactivated is not deactivated again', async () => {
    const doc = makeUserDoc({ status: 'deactivated' });
    armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: '424242' }), res);

    expect(out.statusCode).toBe(400);
    expect(out.body.status).toBe('ALREADY_DEACTIVATED');
    expect(mockCancelOrders).not.toHaveBeenCalled();
  });

  test('an unknown account is refused', async () => {
    mockUserModel.findById.mockResolvedValue(null);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: '424242' }), res);

    expect(out.statusCode).toBe(400);
    expect(out.body.success).toBe(false);
  });
});

// ===========================================================================
// GUARD 3 - THE IRREVERSIBLE STEP GOES LAST, AND A REFUSAL CHANGES NOTHING
//           (this is the blocker, and the ledger corruption behind it)
// ===========================================================================
//
// The first repair of this endpoint moved the dependent work in front of the
// destructive save - right idea, wrong order within the dependent work. It put
// `cancelOrderForDeactiveAcc` FIRST, and that is the only step in the whole
// sequence that cannot be undone. The wallet gate two lines later was the one
// that failed (walletapi did not implement the RPC), so every attempt on a
// LIVE account cancelled every resting order the user had and then answered
// "nothing has changed".
//
// It cost more than the orders. Measured on this stack, throwaway account with
// two resting BTCUSD buys (0.01 and 0.02 at 7000):
//
//   before   walletbalance_spot 9790   walletbalance_spot_inOrder 210
//   attempt  HTTP 503 WALLET_NOT_DEACTIVATED
//   after    walletbalance_spot 10000  walletbalance_spot_inOrder 210
//
// spotapi's cancel-for-deactivation path refunds `walletbalance_spot` through
// createTradeHistory and never calls `releaseInOrder`, so the 210 stayed in the
// in-order counter for ever. Free balance is total minus in-order everywhere it
// is shown, so pressing a button that reported FAILURE silently cost the user
// the use of 210 USD, and pressing it again cost more.
//
// So the order below is the fix, and these tests are what hold it in place:
//
//   deactivateWallet     fallible, idempotent, exactly undoable
//   save                 local, and undone by the compensating unfreeze
//   hdel                 after this nothing can place a new order
//   cancelOrders         irreversible - spot, and therefore last
//
// FOUR MORE STEPS USED TO BRACKET THAT SEQUENCE - a freeze and a teardown for
// each of the two derivative engines. Both engines have been removed and this
// venue is spot only, so the sequence is the four steps above and the
// assertion below lists exactly those four. The ORDER PROPERTY is what the
// test is really about and it is unchanged: everything reversible happens
// first, and the one irreversible step happens last.

describe('teardown ordering', () => {
  test('the irreversible cancels are the LAST things that happen', async () => {
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(200);
    // The two derivative freezes and the two derivative teardowns that used to
    // bracket this sequence are gone with their engines. The ORDER PROPERTY is
    // unchanged and is what this test is about: everything reversible happens
    // first, and the one irreversible step happens last.
    expect(calls).toEqual([
      'deactivateWallet',
      'save',
      'hdel',
      'cancelOrders',
    ]);
    for (const irreversible of ['cancelOrders']) {
      expect(calls.indexOf(irreversible)).toBeGreaterThan(
        calls.indexOf('deactivateWallet')
      );
      expect(calls.indexOf(irreversible)).toBeGreaterThan(calls.indexOf('save'));
      expect(calls.indexOf(irreversible)).toBeGreaterThan(calls.indexOf('hdel'));
    }
  });



  test('the wallet is stood down BEFORE the account is written', async () => {
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(200);
    expect(calls.indexOf('save')).toBeGreaterThan(calls.indexOf('deactivateWallet'));
  });

  test('the session is purged AFTER the account is marked, never before', async () => {
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(calls.indexOf('hdel')).toBeGreaterThan(calls.indexOf('save'));
    expect(mockHdel).toHaveBeenCalledWith('userToken', USER_ID);
  });

  test('the session is purged BEFORE the orders are cancelled', async () => {
    // spotapi authenticates off the same redis `userToken` hash, so killing the
    // session first is what stops a user placing an order that races the sweep.
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(calls.indexOf('cancelOrders')).toBeGreaterThan(calls.indexOf('hdel'));
  });

  // -- THE REGRESSION ------------------------------------------------------
  test('a failure to stand down the wallet cancels NOTHING and writes NOTHING', async () => {
    // This is the exact live failure - walletapi unreachable, so the client
    // answers { status: false }. Everything downstream must be untouched, and
    // in particular the orders must still be resting, because a cancelled
    // order is not recoverable and its reservation is never released.
    mockDeactivateWallet.mockImplementation(async () => {
      calls.push('deactivateWallet');
      return { status: false, error: 'Error on Connection' };
    });
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(503);
    expect(out.body.status).toBe('WALLET_NOT_DEACTIVATED');
    expect(out.body.message).toMatch(/NOT been deactivated/i);
    expect(out.body.message).toMatch(/untouched/i);
    expect(mockCancelOrders).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
    expect(mockHdel).not.toHaveBeenCalled();
    expect(doc.status).toBe('verified');
    expect(doc.userLocked).toBe('false');
    expect(doc.email).toBe(OWNER_EMAIL);
    // `toEqual` is exhaustive, and that is what actually pins this: every
    // cross-service call in this flow pushes its name into `calls`, so any
    // extra one - to a derivative engine or to anything else - fails here.
    // Nothing is frozen, nothing is swept, and the user's resting orders are
    // exactly as they were found.
    //
    // Two `expect(mockDeactivatePerpetual).not.toHaveBeenCalled()` assertions
    // stood below this line. They were VACUOUS, not merely redundant: those
    // mocks were wired to no module, so they asserted that a local jest.fn()
    // nothing could reach had not been reached. They would have gone on
    // passing if the flow HAD started calling a real engine, which is the
    // opposite of what a reader would take them to mean.
    expect(calls).toEqual(['deactivateWallet']);
  });

  test('the refusal keeps the OTP alive so the user can simply try again', async () => {
    // The live retry works because nothing consumed the code on the way out.
    mockDeactivateWallet.mockResolvedValue({ status: false });
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(503);
    expect(doc.emailOTP).toBe(code);
    expect(doc.deactiveOtpChannel).toBe('email');
  });

  test('a wallet call that throws is still a clean refusal, not a half-done teardown', async () => {
    mockDeactivateWallet.mockImplementation(async () => {
      throw new Error('12 UNIMPLEMENTED');
    });
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(500);
    expect(out.body.success).toBe(false);
    expect(out.body.message).toMatch(/NOT been deactivated/i);
    expect(mockCancelOrders).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
    expect(doc.status).toBe('verified');
  });

  test('a truthy-but-not-true wallet reply is not mistaken for success', async () => {
    mockDeactivateWallet.mockResolvedValue({ status: 'false' });
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(503);
    expect(doc.save).not.toHaveBeenCalled();
    expect(mockCancelOrders).not.toHaveBeenCalled();
  });

  test('a missing reply from the wallet call is not mistaken for success', async () => {
    mockDeactivateWallet.mockResolvedValue(undefined);
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(503);
    expect(doc.save).not.toHaveBeenCalled();
    expect(mockCancelOrders).not.toHaveBeenCalled();
  });

  // -- COMPENSATION --------------------------------------------------------
  test('an account write that fails puts the wallet back and reports no change', async () => {
    // The wallet is down and the account is not: left alone that is a live
    // user who cannot move their own funds and has no idea why.
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    doc.save = jest.fn(async () => {
      calls.push('save');
      throw new Error('mongo down');
    });
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(503);
    expect(out.body.status).toBe('ACCOUNT_NOT_DEACTIVATED');
    expect(out.body.message).toMatch(/Nothing has changed/i);
    expect(mockDeactivateWallet).toHaveBeenCalledTimes(2);
    expect(mockDeactivateWallet).toHaveBeenLastCalledWith({
      userId: USER_ID,
      mode: 'unfreeze',
    });
    expect(mockCancelOrders).not.toHaveBeenCalled();
    expect(mockHdel).not.toHaveBeenCalled();
  });

  test('the freeze call itself asks for the default mode, not unfreeze', async () => {
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(mockDeactivateWallet).toHaveBeenCalledTimes(1);
    expect(mockDeactivateWallet).toHaveBeenCalledWith({ userId: USER_ID });
  });

  test('a compensating unfreeze that also fails still reports no change', async () => {
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    doc.save = jest.fn(async () => {
      throw new Error('mongo down');
    });
    mockDeactivateWallet.mockImplementation(async (body) =>
      body && body.mode === 'unfreeze'
        ? { status: false }
        : { status: true, message: 'FROZEN' }
    );
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(503);
    expect(out.body.status).toBe('ACCOUNT_NOT_DEACTIVATED');
    expect(mockCancelOrders).not.toHaveBeenCalled();
  });

  // -- AFTER THE POINT OF NO RETURN ---------------------------------------
  test('a KYC cleanup failure does not strand a user whose wallet is already down', async () => {
    mockUserKyc.findOne.mockRejectedValue(new Error('mongo blip'));
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(200);
    expect(doc.status).toBe('deactivated');
  });

  test('a session that cannot be purged is reported, not papered over with a 200', async () => {
    mockHdel.mockRejectedValue(new Error('redis down'));
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(500);
    expect(out.body.success).toBe(false);
    expect(out.body.status).toBe('SESSION_NOT_PURGED');
  });

  test('a session purge failure does not skip the order cancel', async () => {
    // Both remaining actions are ATTEMPTED and then reported. Returning early
    // on the redis failure would leave a closed account with a live book.
    mockHdel.mockRejectedValue(new Error('redis down'));
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(500);
    expect(mockCancelOrders).toHaveBeenCalledWith({ userId: USER_ID });
  });

  test('orders that cannot be cancelled do not un-deactivate the account, and are declared', async () => {
    mockCancelOrders.mockImplementation(async () => {
      calls.push('cancelOrders');
      return { status: false, error: 'Error on Connection' };
    });
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(200);
    expect(out.body.success).toBe(true);
    expect(out.body.status).toBe('DEACTIVATED_ORDERS_PENDING');
    expect(out.body.message).toMatch(/could not be cancelled/i);
    // the closure itself stands - claiming otherwise would be the same lie in
    // the other direction
    expect(doc.status).toBe('deactivated');
    expect(doc.userLocked).toBe('true');
    expect(mockHdel).toHaveBeenCalledWith('userToken', USER_ID);
  });

  test('a missing reply from the order cancel is not mistaken for success', async () => {
    mockCancelOrders.mockResolvedValue(undefined);
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(200);
    expect(out.body.status).toBe('DEACTIVATED_ORDERS_PENDING');
  });

  test('a truthy-but-not-true order reply is not mistaken for success', async () => {
    mockCancelOrders.mockResolvedValue({ status: 'true' });
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.body.status).toBe('DEACTIVATED_ORDERS_PENDING');
  });

  test('an unpurged session outranks an uncancelled book in the answer', async () => {
    // Both went wrong; the one that leaves a live credential on a dead account
    // is the one the caller is told about, and it is not a 200.
    mockHdel.mockRejectedValue(new Error('redis down'));
    mockCancelOrders.mockResolvedValue({ status: false });
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(500);
    expect(out.body.status).toBe('SESSION_NOT_PURGED');
  });
});

// ===========================================================================
// GUARD 3c - A FAILED DEACTIVATION MUST NOT CLEAR AN OPERATOR'S FREEZE
// ===========================================================================
//
// THE DEFECT. `undoFreezes` was called with literal `true` for every mark the
// sequence had reached, on the reasoning that the freeze step had answered
// `status: true` and the account was therefore frozen. It was - but these
// freezes are IDEMPOTENT, and an idempotent freeze answers `status: true` for
// an account somebody else froze just as readily as for one it froze itself.
// So a deactivation that failed at a later step handed the account back.
//
// Reproduced live on this stack, against a throwaway an operator had frozen
// through walletapi directly (an abuse hold, nothing to do with deactivation),
// with the shared redis `account_standdown` mark made unreadable so the
// perpetual freeze refused:
//
//   before   deactivateWallet({mode:"check"}) -> {status:true,"ALREADY_FROZEN"}
//   POST /api/user/deactive-confirm           -> 503 DERIVATIVES_NOT_DEACTIVATED
//                                                "Nothing has changed"
//   after    deactivateWallet({mode:"check"}) -> {status:true,"READY"}
//
// The hold was gone, the user could move value again, and the only trace was a
// log line about a perpetual freeze that had failed. Anyone who could reach
// /deactive-confirm with their own OTP could clear their own operator freeze
// by arranging for a later step to fail.
//
// After the fix, the same run leaves the wallet ALREADY_FROZEN and logs
// DEACTIVATE_FREEZE_NOT_APPLIED_BY_THIS_CALL wallet <id> ALREADY_FROZEN.

describe('freezeAppliedByThisCall', () => {
  test('only a plain "I froze it" counts', () => {
    expect(freezeAppliedByThisCall({ status: true, message: 'FROZEN' })).toBe(true);
  });

  test('a freeze that found one already there does NOT count', () => {
    expect(
      freezeAppliedByThisCall({ status: true, message: 'ALREADY_FROZEN' })
    ).toBe(false);
  });

  test('a wallet that does not exist was not frozen by us either', () => {
    expect(freezeAppliedByThisCall({ status: true, message: 'NO_WALLET' })).toBe(
      false
    );
  });

  test('a refusal never counts, whatever it says', () => {
    for (const resp of [
      { status: false, message: 'FROZEN' },
      { status: false, message: 'FREEZE_FAILED' },
      { status: 'true', message: 'FROZEN' },
      { status: 1, message: 'FROZEN' },
    ]) {
      expect(freezeAppliedByThisCall(resp)).toBe(false);
    }
  });

  test('an absent or empty reply never counts', () => {
    for (const resp of [undefined, null, {}, { status: true }, { message: 'FROZEN' }]) {
      expect(freezeAppliedByThisCall(resp)).toBe(false);
    }
  });

  test('an answer this build has never heard of resolves to "not ours"', () => {
    // The two ways to be wrong are not symmetric: undoing a freeze that was
    // not ours is a silent security regression, failing to undo one that was
    // is a loud support ticket. Unknown therefore means "leave it alone".
    expect(
      freezeAppliedByThisCall({ status: true, message: 'SOME_FUTURE_ANSWER' })
    ).toBe(false);
  });

  test('the message is compared exactly, not loosely', () => {
    for (const message of ['frozen', ' FROZEN', 'FROZEN ', 'NOT_FROZEN', 'ALREADY_FROZEN']) {
      expect(freezeAppliedByThisCall({ status: true, message })).toBe(false);
    }
  });
});

describe('a failed deactivation undoes only the freezes IT applied', () => {
  // WHAT CHANGED, AND WHAT DID NOT.
  //
  // These tests used to trigger the compensation by failing one of the two
  // DERIVATIVE freezes, which were steps 2 and 3 of the teardown. Both engines
  // have been removed, so the wallet freeze in step 1 is the only freeze left
  // and there is no longer any way for a LATER FREEZE to fail.
  //
  // The security property they were written for is untouched and is what they
  // still pin: the compensation is AIMED, not blanket. It puts back exactly the
  // freezes THIS call applied and leaves alone any that were already there.
  // Without that, anyone who could reach `/deactive-confirm` with their own OTP
  // could clear an operator's abuse hold by making a later step fail - which is
  // the defect that was measured live.
  //
  // The surviving trigger for a late failure is the ACCOUNT WRITE (step 3),
  // so that is what these now fail.

  // -- THE REGRESSION ------------------------------------------------------
  test("a wallet an operator had already frozen is LEFT frozen", async () => {
    mockDeactivateWallet.mockImplementation(async (body) => {
      calls.push(
        body && body.mode === 'unfreeze' ? 'unfreezeWallet' : 'deactivateWallet'
      );
      return alreadyFrozenReply(body);
    });
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    doc.save = jest.fn(async () => {
      calls.push('save');
      throw new Error('mongo down');
    });
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(503);
    expect(out.body.status).toBe('ACCOUNT_NOT_DEACTIVATED');
    // THE POINT: no unfreeze at all. The operator's hold survives.
    expect(calls).toEqual(['deactivateWallet', 'save']);
    expect(mockDeactivateWallet).toHaveBeenCalledTimes(1);
    expect(mockDeactivateWallet).not.toHaveBeenCalledWith({
      userId: USER_ID,
      mode: 'unfreeze',
    });
    // and nothing was committed either
    expect(mockCancelOrders).not.toHaveBeenCalled();
  });

  test('a wallet THIS call froze is still put back', async () => {
    // The compensation is not disabled - it is aimed.
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    doc.save = jest.fn(async () => {
      calls.push('save');
      throw new Error('mongo down');
    });
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(503);
    expect(calls).toEqual(['deactivateWallet', 'save', 'unfreezeWallet']);
  });

  test('an account already stood down is left exactly as found', async () => {
    // A retry of a deactivation whose account write keeps failing. Nothing in
    // this call froze anything, so nothing in this call may unfreeze anything -
    // otherwise a retry loop would toggle the account open and closed.
    mockDeactivateWallet.mockImplementation(async (body) => {
      calls.push((body && body.mode) || 'freeze');
      return { ...alreadyFrozenReply(body), positionsOpen: 0 };
    });
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    doc.save = jest.fn(async () => {
      throw new Error('mongo down');
    });
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(503);
    expect(calls).toEqual(['freeze']);
    expect(calls).not.toContain('unfreeze');
  });

  test('a wallet that does not exist is not "unfrozen" on the way out', async () => {
    mockDeactivateWallet.mockImplementation(async (body) => {
      calls.push(
        body && body.mode === 'unfreeze' ? 'unfreezeWallet' : 'deactivateWallet'
      );
      return body && body.mode === 'unfreeze'
        ? { status: true, message: 'RESTORED' }
        : { status: true, message: 'NO_WALLET' };
    });
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    doc.save = jest.fn(async () => {
      calls.push('save');
      throw new Error('mongo down');
    });
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(503);
    expect(calls).toEqual(['deactivateWallet', 'save']);
  });

  test('a message-less reply is not undone either', async () => {
    // A peer that predates the `message` field. Its freeze is honoured (the
    // gate is `status`), and the compensation stays off it - the safe way to be
    // wrong.
    mockDeactivateWallet.mockImplementation(async (body) => {
      calls.push(
        body && body.mode === 'unfreeze' ? 'unfreezeWallet' : 'deactivateWallet'
      );
      return { status: true };
    });
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    doc.save = jest.fn(async () => {
      calls.push('save');
      throw new Error('mongo down');
    });
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(503);
    expect(calls).toEqual(['deactivateWallet', 'save']);
    expect(calls).not.toContain('unfreezeWallet');
  });

  // -- THE HAPPY PATH IS UNCHANGED ----------------------------------------
  test('an already-frozen account still deactivates normally', async () => {
    // The freeze step is a GATE on `status`, not on `message`. An account an
    // operator had already stood down must still be closable - refusing would
    // be the "deactivation is impossible" blocker in a third costume.
    mockDeactivateWallet.mockImplementation(async (body) => ({
      ...alreadyFrozenReply(body),
      ordersCancelled: 0,
      ordersFailed: 0,
      positionsOpen: 0,
    }));
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(200);
    expect(out.body.status).toBe('DEACTIVATED');
    expect(doc.status).toBe('deactivated');
    expect(doc.userLocked).toBe('true');
  });

  test('the compensation is never handed a literal true again', () => {
    // The exact shape of the defect, pinned in the source: every call site
    // must pass the ledger, never a hand-written set of flags.
    // THE ANCHOR HAS MOVED TWICE NOW, which is the point of asserting it.
    // It was `export const changeDerivativeMode`, deleted with the derivative
    // gRPC surface; then `export const changeLeverage`, deleted with the
    // `leverage` schema path it wrote. Each time, indexOf would have returned
    // -1 and slice(start, -1) would silently have read to the end of the file.
    // So the anchor is the next surviving export AND is asserted to exist - a
    // slice that quietly widens to the whole file is a test that stops testing
    // what it names.
    const start = CONTROLLER.indexOf('export const confirmDeActive');
    const end = CONTROLLER.indexOf('export const showPair');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = CONTROLLER.slice(start, end);
    expect(body.length).toBeGreaterThan(1000);
    // Was 3 - one per abort point. Two of those were the derivative freezes,
    // which are gone; the account-write abort is the one that remains.
    const undoCalls = body.match(/undoFreezes\([^)]*\)/g) || [];
    expect(undoCalls).toHaveLength(1);
    for (const call of undoCalls) {
      expect(call).toBe('undoFreezes(userId, applied)');
    }
    expect(body).not.toMatch(/undoFreezes\(userId,\s*\{/);
  });
});

// ===========================================================================
// GUARD 4 - a successful deactivation locks the account instead of shredding it
// ===========================================================================

describe('what a successful deactivation actually does', () => {
  test('it locks the account and stamps it', async () => {
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(out.statusCode).toBe(200);
    expect(out.body.success).toBe(true);
    expect(doc.status).toBe('deactivated');
    expect(doc.userLocked).toBe('true');
    expect(doc.deactivatedAt).toBeInstanceOf(Date);
  });

  test('it does NOT overwrite the identity with a shared placeholder', async () => {
    // The old code set every deactivated account's email to the literal
    // "anonymous@gmail.com", collapsing them all onto one address so nothing
    // could tell them apart, while achieving no actual erasure - the row, the
    // userId, the wallets and the order history all survived it anyway.
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(doc.email).toBe(OWNER_EMAIL);
    expect(doc.email).not.toBe('anonymous@gmail.com');
    expect(doc.firstName).toBe('Real');
  });

  test('it consumes the code so it cannot be replayed', async () => {
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(doc.emailOTP).toBe('');
    expect(doc.deactiveOtpChannel).toBe('');
    expect(doc.requestType).toBe('');
  });

  test('a deactivated account can no longer authenticate: the state login checks is set', async () => {
    // userLogin refuses `userLocked == "true"` and `status != "verified"`, and
    // the passport strategy refuses a redis session whose userLocked is not
    // "false". Setting these is what makes the lock bite.
    const doc = makeUserDoc();
    const code = armEmailOtp(doc);
    mockUserModel.findById.mockResolvedValue(doc);
    const { res } = makeRes();

    await confirmDeActive(req({ roleType: 2, otp: code }), res);

    expect(doc.userLocked).toBe('true');
    expect(doc.status).not.toBe('verified');
    expect(mockHdel).toHaveBeenCalledWith('userToken', USER_ID);
  });
});

// ===========================================================================
// GUARDS 5-9 REMOVED WITH THE FEATURE THEY GUARDED
// ===========================================================================
//
// Five blocks lived here covering TOTP enrolment: that the QR payload never
// travelled to quickchart.io, that the enrolment secret was minted once and
// held server-side, that a client-chosen secret was ignored, that disabling
// required a code from the STORED secret, and that the validator asked only
// for the code.
//
// 2FA has been removed from this venue - the routes, the handlers, the
// validator and lib/twoFactor.js are all deleted - so there is nothing left for
// them to guard. tests/unit/route-authorization.test.js now asserts the
// ABSENCE of that whole surface, which is the fact that can still regress.
//
// Worth recording, because the brief that ordered the removal said otherwise:
// 2FA WORKED when it was taken out. It was verified live first - with an
// authenticator enrolled, a login with no code got the TWO_FA challenge and no
// token, a wrong code got 400 and no token, and only a correct code got in.
// This was a scope decision on a paper-trading venue, not a repair.

// ===========================================================================
// GUARD 10 - no gRPC client leaks a rejection to its caller
// ===========================================================================

/**
 * grpc/*.js cannot be `import`ed here - they use `import.meta.url`, which
 * babel-jest does not transform - so this is a structural check on the source,
 * the same approach tests/unit/route-authorization.test.js takes for routes.
 *
 * It exists because grpc/walletService.js `deactivateWallet` was the single
 * client in this service without a terminating `.catch()`. walletapi does not
 * implement that RPC, so every call rejected, and the rejection surfaced
 * inside confirmDeActive AFTER it had committed a destructive write.
 */
describe('gRPC clients report failure instead of throwing it', () => {
  const GRPC_DIR = path.resolve(process.cwd(), 'grpc');

  const clientFiles = fs
    .readdirSync(GRPC_DIR)
    .filter((f) => f.endsWith('Service.js'));

  test('there are client modules to check', () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  test.each(clientFiles)('every exported RPC wrapper in %s ends in a .catch()', (file) => {
    const src = fs.readFileSync(path.join(GRPC_DIR, file), 'utf8');
    const uncaught = [];

    // Each wrapper is `export const NAME = async (...) => { return new Promise(...)... }`.
    const re = /export\s+const\s+(\w+)\s*=\s*async\s*\([^)]*\)\s*=>\s*\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      const next = re.lastIndex;
      const after = src.slice(next);
      const endIdx = after.search(/\n\}/);
      const body = endIdx === -1 ? after : after.slice(0, endIdx);
      if (/new Promise\s*\(/.test(body) && !/\)\s*\.catch\s*\(/.test(body)) {
        uncaught.push(`${file}:${name}`);
      }
    }

    expect(uncaught).toEqual([]);
  });

  test('deactivateWallet specifically settles rather than rejecting', () => {
    const src = fs.readFileSync(path.join(GRPC_DIR, 'walletService.js'), 'utf8');
    const fn = src.slice(src.indexOf('export const deactivateWallet'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    expect(body).toMatch(/\.catch\s*\(/);
    expect(body).toMatch(/status:\s*false/);
  });

  test('deactivateWallet forwards the mode the caller asked for', () => {
    // confirmDeActive's compensating rollback is `mode: "unfreeze"`. A client
    // that drops the field sends the default - which is FREEZE - so the
    // rollback would re-apply the very thing it exists to undo.
    const src = fs.readFileSync(path.join(GRPC_DIR, 'walletService.js'), 'utf8');
    const fn = src.slice(src.indexOf('export const deactivateWallet'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    expect(body).toMatch(/userId:\s*reqBody\.userId/);
    expect(body).toMatch(/mode:\s*reqBody\.mode/);
  });

  test('the client contract declares the mode field it sends', () => {
    const proto = fs.readFileSync(path.join(GRPC_DIR, 'wallet.proto'), 'utf8');
    const msg = proto.slice(
      proto.indexOf('message deactivateWalletReq'),
      proto.indexOf('}', proto.indexOf('message deactivateWalletReq'))
    );
    expect(msg).toMatch(/string\s+userId\s*=\s*1/);
    expect(msg).toMatch(/string\s+mode\s*=\s*2/);
  });
});

// ===========================================================================
// GUARD 10 - credentials do not go to the log
// ===========================================================================

describe('credentials are not written to the service log', () => {
  const read = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
  const codeOnly = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');

  test('changePassword does not log the request body', () => {
    const src = codeOnly(read('controllers/user.controller.js'));
    const fn = src.slice(src.indexOf('export const changePassword'));
    const body = fn.slice(0, fn.indexOf('export const', 10));
    expect(body).not.toMatch(/console\.log\([^)]*reqBody/);
  });

  test('verifyOtp and resendOTP do not log the request body', () => {
    const src = codeOnly(read('controllers/auth.controller.js'));
    for (const name of ['export const verifyOtp', 'export const resendOTP']) {
      const fn = src.slice(src.indexOf(name));
      const body = fn.slice(0, fn.indexOf('export const', 10));
      expect(body).not.toMatch(/console\.log\([^)]*reqBody/);
    }
  });

  test('enabling 2FA does not dump the whole user document', () => {
    const src = codeOnly(read('controllers/user.controller.js'));
    const fn = src.slice(src.indexOf('export const update2faCode'));
    const body = fn.slice(0, fn.indexOf('export const', 10));
    expect(body).not.toMatch(/console\.log\([^)]*userData\s*\)/);
  });
});

// ===========================================================================
// GUARD 11 - the deactivation code has to REACH the user
// ===========================================================================

/**
 * THE FLOW COULD BE STARTED AND NOT FINISHED.
 * ===========================================
 * `/deactive-req` renders the mail through `mailTemplateLang` and, under
 * `log-only` delivery - which is how this stack runs, and how these suites run
 * (NODE_ENV=test) - writes it to the process log and never contacts a provider.
 * It still answered "Verification code sent to your email ID", and nothing in
 * the product ever showed the code. `confirmDeActive` refuses without it, so
 * account closure dead-ended exactly where password reset used to, while
 * /security told the user that "where email delivery is switched off, the code
 * is shown to you on screen instead".
 *
 * Two properties are pinned here, and the second is the one that matters:
 *
 *   1. in log-only mode the stored code comes back, so the screen can show it;
 *   2. in PRODUCTION it does not, and cannot be made to. `mailDeliveryMode`
 *      short-circuits to `send` on NODE_ENV=production BEFORE any opt-in flag
 *      is consulted, so `discloseWhenLogOnly` returns `{}` there. A build that
 *      published a deactivation code in an HTTP response on a real deployment
 *      would be handing out the one value that closes an account.
 *
 * The code itself is untouched: same six digits on `user.emailOTP`, same
 * three-minute window, same `optVerification` check on the confirm step.
 */
describe('the deactivation code reaches the user when no mail was sent', () => {
  const withEnv = async (patch, fn) => {
    const saved = { ...process.env };
    Object.assign(process.env, patch);
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  test('log-only: the response says nothing was sent and carries the code', async () => {
    const doc = makeUserDoc();
    mockUserModel.findOne.mockResolvedValue(doc);
    const { res, out } = makeRes();

    await deactiveRequest(req({ roleType: 1, requestType: 'deactive' }), res);

    expect(out.statusCode).toBe(200);
    expect(out.body.delivered).toBe(false);
    expect(out.body.mailDelivery).toBe('log-only');
    expect(out.body.message).toMatch(/no email was sent/i);
    // The disclosed value is the one that was STORED, not a second code.
    expect(out.body.verificationCode).toBe(String(doc.emailOTP));
    expect(out.body.verificationCode).toMatch(/^\d{6}$/);
  });

  test('production: nothing is disclosed and the wording stays "we mailed it" (SECURITY)', async () => {
    await withEnv({ NODE_ENV: 'production', TEST_MODE: 'true', DEV_EMAIL_BYPASS: 'true' }, async () => {
      const doc = makeUserDoc();
      mockUserModel.findOne.mockResolvedValue(doc);
      const { res, out } = makeRes();

      await deactiveRequest(req({ roleType: 1, requestType: 'deactive' }), res);

      expect(out.statusCode).toBe(200);
      expect(out.body.delivered).toBe(true);
      expect(out.body).not.toHaveProperty('verificationCode');
      expect(out.body.message).toMatch(/sent to your email/i);
      // Belt and braces: the code must not have leaked into any other field.
      expect(JSON.stringify(out.body)).not.toContain(String(doc.emailOTP));
    });
  });

  test('disclosure does not weaken the confirm step: a wrong code is still refused', async () => {
    const doc = makeUserDoc();
    mockUserModel.findOne.mockResolvedValue(doc);
    const { res: reqRes, out: reqOut } = makeRes();
    await deactiveRequest(req({ roleType: 1, requestType: 'deactive' }), reqRes);

    const shown = reqOut.body.verificationCode;
    mockUserModel.findById.mockResolvedValue(doc);

    const { res: badRes, out: badOut } = makeRes();
    await confirmDeActive(req({ otp: '000000' }), badRes);
    expect(badOut.statusCode).toBe(400);
    expect(mockDeactivateWallet).not.toHaveBeenCalled();

    const { res: goodRes, out: goodOut } = makeRes();
    await confirmDeActive(req({ otp: shown }), goodRes);
    expect(goodOut.statusCode).toBe(200);
    expect(goodOut.body.status).toBe('DEACTIVATED');
  });
});
