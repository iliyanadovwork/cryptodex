/**
 * WITHDRAWAL IS CLOSED — wallet.controller.js, against real Mongo
 *
 * These tests used to pin the paper-trading "stub": instant completion, a
 * `paper-<ms>` txid, a preserved spot-balance debit and a preserved passbook
 * row. That contract is gone, because completing a withdrawal on a venue with
 * no custody deletes the user's demo balance and hands back a receipt for a
 * transfer nobody made. See controllers/wallet.controller.js#WITHDRAWALS_CLOSED
 * and spotapi controllers/withdrawal.controller.js.
 *
 * What is pinned now: 410, and NOTHING WRITTEN. Mongo is real
 * (mongodb-memory-server), so `Transaction.countDocuments({}) === 0` is a
 * statement about the whole database, not about a mock.
 *
 * The currency fixture below deliberately keeps sane withdraw limits
 * (fee 1%, min 1, max 10000). On the live venue every currency row leaves those
 * unset and mongoose reads back the schema default 0, which made the endpoint
 * refuse everything above zero and LOOK dormant. The fixture is the config that
 * re-arms it - so if the refusal ever moves back into the data, these tests go
 * red.
 *
 * Redis, gRPC and 2FA are mocked per existing conventions.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  jest,
} from '@jest/globals';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// gRPC fan-out to other services — mocked, no sockets in tests.
jest.mock('../../grpc/userService.js', () => ({
  fetchUser: jest.fn(),
  sendMail: jest.fn(),
  bankDetail: jest.fn(),
}));

// Redis: never touch a live server in tests.
jest.mock('../../controllers/redis.controller.js', () => ({
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  hset: jest.fn(),
  hget: jest.fn(),
  hincby: jest.fn(),
  hincbyfloat: jest.fn(),
  hdel: jest.fn(),
  hgetall: jest.fn(),
  hdetall: jest.fn(),
  createPassBook: jest.fn(),
}));

jest.mock('../../controllers/passbook.controller.js', () => ({
  createPassBook: jest.fn(),
}));

// priceCNV pulls in the live Binance client + Redis at module load.
jest.mock('../../controllers/priceCNV.controller.js', () => ({
  priceConversionGrpc: jest.fn(),
}));

jest.mock('node-2fa', () => ({
  verifyToken: jest.fn(),
}));

import { fetchUser, sendMail, bankDetail } from '../../grpc/userService.js';
import { hget, hincbyfloat } from '../../controllers/redis.controller.js';
import { createPassBook } from '../../controllers/passbook.controller.js';
import { verifyToken } from 'node-2fa';
import { Currency, Transaction, Wallet } from '../../models/index.js';
import {
  withdrawCoinRequest,
  withdrawCoinRequestApp,
  withdrawFiatRequest,
} from '../../controllers/wallet.controller.js';
import { IncCntObjId } from '../../lib/generalFun.js';

const PAPER_TXID_REGEX = /^paper-\d+$/;

let mongoServer;
let userId;
let currency;

const USER_ADDRESS = '0xUserDepositAddress0000000000000000000001';
const RECEIVER_ADDRESS = '0xReceiverAddress000000000000000000000002';

function createRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function createReq(overrides = {}) {
  return {
    user: { id: userId.toString(), email: 'paper@test.com' },
    body: {
      currencyId: currency._id.toString(),
      coin: 'ETH',
      amount: '100',
      receiverAddress: RECEIVER_ADDRESS,
      twoFACode: '123456',
      ...overrides,
    },
  };
}

describe('Withdrawal is closed (CRITICAL)', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  beforeEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany();
    }

    userId = new mongoose.Types.ObjectId();

    currency = await Currency.create({
      coin: 'ETH',
      symbol: 'ETH',
      name: 'Ethereum',
      gateway_code: 'ETH',
      type: 'crypto',
      depositType: 'local',
      withdrawFee: 1, // percent
      minimumWithdraw: 1,
      maximumWithdraw: 10000,
      status: 'active',
    });

    await new Wallet({
      _id: userId,
      userCode: String(IncCntObjId(userId)),
      assets: [
        {
          _id: currency._id,
          currencyId: currency._id,
          coin: 'ETH',
          address: USER_ADDRESS,
          spotBal: 500,
        },
      ],
    }).save();

    // 2FA passes, user exists, Redis holds a 500 spot balance.
    fetchUser.mockResolvedValue({
      _id: userId.toString(),
      google2Fa: { secret: 'TESTSECRET' },
    });
    verifyToken.mockReturnValue({ delta: 0 });
    hget.mockResolvedValue('500');
    hincbyfloat.mockResolvedValue('399');
  });

  describe.each([
    ['withdrawCoinRequest', withdrawCoinRequest],
    ['withdrawCoinRequestApp', withdrawCoinRequestApp],
  ])('%s', (name, controllerFn) => {
    test('refuses with 410 WITHDRAWALS_CLOSED and writes NOTHING to Mongo or Redis', async () => {
      const req = createReq();
      const res = createRes();

      await controllerFn(req, res);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, code: 'WITHDRAWALS_CLOSED' })
      );

      // Nothing anywhere. Mongo is real here, so this is the whole collection.
      expect(await Transaction.countDocuments({})).toBe(0);
      expect(hincbyfloat).not.toHaveBeenCalled();
      expect(hget).not.toHaveBeenCalled();
      expect(createPassBook).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
      // and the wallet document is untouched.
      const wallet = await Wallet.findById(userId);
      expect(wallet.assets[0].spotBal).toBe(500);
    });

    test('refuses even with a currency document that WOULD have permitted it', async () => {
      // THIS IS THE POINT OF THE FIXTURE ABOVE. On the live venue every currency
      // document leaves `maximumWithdraw` unset, which mongoose reads back as
      // the schema default 0, so `amount > maximumWithdraw` refused everything
      // above zero and the endpoint LOOKED dormant. It was not: measured on the
      // stack, `{amount: 0}` answered 200 "Withdraw successful", wrote a
      // completed coin_withdraw row with a paper txid and the caller's address,
      // and emailed the user.
      //
      // The fixture here is the opposite: withdrawFee 1%, minimumWithdraw 1,
      // maximumWithdraw 10000 - exactly the row an admin could create from the
      // currency screen, and exactly the row that re-arms the debit. The answer
      // must not depend on it.
      expect(currency.maximumWithdraw).toBe(10000);
      expect(currency.withdrawFee).toBe(1);

      for (const amount of [0, 1, 100, 9999]) {
        const res = createRes();
        await controllerFn(createReq({ amount }), res);
        expect(res.status).toHaveBeenCalledWith(410);
      }
      expect(await Transaction.countDocuments({})).toBe(0);
    });

    test('refuses without consulting 2FA, the wallet or the balance', async () => {
      // A refusal that runs the 2FA check first is a refusal with a code path
      // in front of it, and it also leaks whether an account has 2FA enabled.
      const res = createRes();
      await controllerFn(createReq({ twoFACode: 'wrong' }), res);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(fetchUser).not.toHaveBeenCalled();
      expect(verifyToken).not.toHaveBeenCalled();
      expect(hget).not.toHaveBeenCalled();
    });
  });

  test('no withdrawal notification can be sent, because no withdrawal can happen', async () => {
    const res = createRes();
    await withdrawCoinRequest(createReq(), res);

    // The "Withdraw_notification" template is the same mail the on-chain payout
    // sent. On a venue with no custody it is a claim, not a receipt.
    expect(sendMail).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(410);
  });

  test('the fiat path is closed on the same terms', async () => {
    const res = createRes();
    await withdrawFiatRequest(createReq(), res);

    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'WITHDRAWALS_CLOSED' })
    );
    expect(await Transaction.countDocuments({})).toBe(0);
    expect(bankDetail).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('no transaction can be left awaiting admin approval, because none is created', async () => {
    const res = createRes();
    await withdrawCoinRequest(createReq(), res);

    expect(
      await Transaction.countDocuments({
        status: { $in: ['new', 'pending', 'processing', 'completed'] },
      })
    ).toBe(0);
  });
});
