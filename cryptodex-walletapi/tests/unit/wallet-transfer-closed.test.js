/**
 * WALLET-TO-WALLET TRANSFER IS CLOSED, AND REFUSES WITHOUT TOUCHING ANYTHING
 * =========================================================================
 *
 * This replaces `wallet-transfer-validation.test.js`, which pinned the request
 * shapes `walletTransferValid` accepted and refused. That middleware is gone
 * with the feature: `spot` is the only pot this venue has, so there is no
 * surviving (from, to) pair to validate.
 *
 * WHAT IS PINNED HERE INSTEAD, and why each part matters:
 *
 *   1. THE REFUSAL IS 410, NOT 404 AND NOT 400. 410 says "this existed and is
 *      gone"; a 404 reads to a client like a broken deploy, and a 400 would
 *      claim the caller's request was malformed when the endpoint would refuse
 *      any request at all. This is the same contract the withdrawal routes
 *      answer with (`WITHDRAWALS_CLOSED`).
 *
 *   2. IT REFUSES EVERY SHAPE, including the ones that used to be valid and the
 *      ones that were always nonsense. The old validator is no longer in the
 *      route chain, so nothing may depend on a request being well formed.
 *
 *   3. NOTHING IS READ AND NOTHING IS WRITTEN. The handler is called with a
 *      request whose `user` and body are present and with NO ledger, mongo or
 *      redis dependency injected or mocked at all - if the handler tried to
 *      touch any of them it would throw rather than answer, and the test would
 *      fail. That is the assertion that a refused transfer cannot move money.
 *
 *   4. THE MESSAGE IS SELF-DESCRIBING, because it is shown to a user verbatim
 *      and is the only explanation they get.
 */

import { describe, test, expect, jest } from '@jest/globals';
import mongoose from 'mongoose';

// `wallet.controller.js` builds gRPC clients and loads every coin gateway at
// module scope, so importing it in a unit test means standing those clients
// down first - the same shape withdrawals-closed.test.js uses. Every one of
// these is I/O this refusal must never reach; `expect(...).not.toHaveBeenCalled()`
// below is what turns that from a claim into an assertion.
jest.mock('../../grpc/userService.js', () => ({
  __esModule: true,
  bankDetail: jest.fn(),
  fetchUser: jest.fn(),
  sendMail: jest.fn()
}));
jest.mock('../../controllers/passbook.controller.js', () => ({
  __esModule: true,
  createPassBook: jest.fn()
}));
jest.mock('../../controllers/priceCNV.controller.js', () => ({
  __esModule: true,
  priceConversionGrpc: jest.fn()
}));

import { createPassBook } from '../../controllers/passbook.controller.js';
import {
  walletTransfer,
  WALLET_TRANSFER_CLOSED
} from '../../controllers/wallet.controller.js';

const VALID_ASSET_ID = new mongoose.Types.ObjectId().toString();

/** A response double that records instead of sending. */
const makeRes = () => {
  const res = { statusCode: null, payload: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.payload = body;
    return res;
  };
  return res;
};

const call = async (body) => {
  const res = makeRes();
  // No deps: a handler that reads a wallet or a ledger here throws.
  await walletTransfer({ user: { id: new mongoose.Types.ObjectId().toString() }, body }, res);
  return res;
};

describe('POST /api/wallet/transfer is closed', () => {
  test('refuses a request that would once have been a VALID transfer', async () => {
    const res = await call({
      fromType: 'spot',
      toType: 'elsewhere',
      userAssetId: VALID_ASSET_ID,
      amount: '10'
    });

    expect(res.statusCode).toBe(410);
    expect(res.payload.success).toBe(false);
    expect(res.payload.code).toBe('WALLET_TRANSFER_CLOSED');
  });

  test.each([
    ['spot -> spot (the only surviving pair, and not a transfer)', { fromType: 'spot', toType: 'spot', userAssetId: VALID_ASSET_ID, amount: '1' }],
    ['an unknown destination wallet', { fromType: 'spot', toType: 'elsewhere', userAssetId: VALID_ASSET_ID, amount: '1' }],
    ['an unknown source wallet', { fromType: 'elsewhere', toType: 'spot', userAssetId: VALID_ASSET_ID, amount: '1' }],
    ['a blank amount', { fromType: 'spot', toType: 'elsewhere', userAssetId: VALID_ASSET_ID, amount: '' }],
    ['a negative amount', { fromType: 'spot', toType: 'elsewhere', userAssetId: VALID_ASSET_ID, amount: '-5' }],
    ['a missing wallet type', { toType: 'elsewhere', userAssetId: VALID_ASSET_ID, amount: '1' }],
    ['a nonsense wallet type', { fromType: 'wat', toType: 'nope', userAssetId: VALID_ASSET_ID, amount: '1' }],
    ['an empty body', {}]
  ])('refuses %s with 410', async (_label, body) => {
    const res = await call(body);
    expect(res.statusCode).toBe(410);
    expect(res.payload.code).toBe('WALLET_TRANSFER_CLOSED');
  });

  test('the refusal explains itself in terms a user can act on', () => {
    const message = WALLET_TRANSFER_CLOSED.message;
    // It must say the balance did NOT move - that is the fact a user needs.
    expect(message).toMatch(/no funds have been moved/i);
    expect(message).toMatch(/balance is unchanged/i);
    // ...and why, rather than only that it failed.
    expect(message).toMatch(/one wallet|spot-only/i);
  });

  test('the message is carried on `errors.amount` too, so a form can render it', async () => {
    const res = await call({
      fromType: 'spot',
      toType: 'elsewhere',
      userAssetId: VALID_ASSET_ID,
      amount: '10'
    });
    expect(res.payload.errors.amount).toBe(WALLET_TRANSFER_CLOSED.message);
  });

  test('answers both `success:false` and `status:false`, so either check sees a refusal', async () => {
    const res = await call({ fromType: 'spot', toType: 'elsewhere', userAssetId: VALID_ASSET_ID, amount: '10' });
    expect(res.payload.success).toBe(false);
    expect(res.payload.status).toBe(false);
  });

  test('writes NO passbook row - a refused transfer leaves no audit trail because nothing moved', async () => {
    createPassBook.mockClear();
    await call({ fromType: 'spot', toType: 'elsewhere', userAssetId: VALID_ASSET_ID, amount: '10' });
    expect(createPassBook).not.toHaveBeenCalled();
  });
});
