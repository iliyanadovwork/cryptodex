/**
 * Deposit Controller - which ledger the reported balance comes from
 *
 * getDepositInfo used to read the flat `assets` collection document directly
 * and divide by 1e6. That document is a MIRROR, not a ledger: every settlement
 * in spot.controller.js moves `walletbalance_spot[<userId>_<currencyId>]` and
 * nothing else, so the flat value is whatever the last faucet / deposit /
 * withdrawal left behind.
 *
 * On live data that produced exactly the divergence the `assets` sweep found:
 * one user's deposit page reported 10,000 USDC while the engine had already
 * settled them to 5,000, and another's reported 0 while the engine held 10,000.
 * The balance now comes from paperLedger.readSpotBalance, i.e. the engine field,
 * with the flat value used only as a seed for an account the engine has never
 * touched.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import mongoose from 'mongoose';

jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  hset: jest.fn(),
  hget: jest.fn(),
  hincbyfloat: jest.fn(),
  hdel: jest.fn()
}));

jest.mock('../../grpc/walletService.js', () => ({
  __esModule: true,
  updateUserAsset: jest.fn(),
  getUserAsset: jest.fn()
}));

jest.mock('../../models/currency.js', () => {
  const assetsCollection = {
    find: jest.fn(),
    findOne: jest.fn(),
    insertOne: jest.fn(),
    updateOne: jest.fn()
  };
  const Currency = {
    find: jest.fn(),
    findOne: jest.fn(),
    db: { collection: () => assetsCollection }
  };
  return {
    __esModule: true,
    default: Currency,
    __assetsCollection: assetsCollection
  };
});

jest.mock('../../models/index.js', () => ({
  __esModule: true,
  DepositEvent: {
    create: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn()
  }
}));

import { getDepositInfo, getDepositHistory } from '../../controllers/deposit.controller.js';
import { hget } from '../../controllers/redis.controller.js';
import Currency, { __assetsCollection as assetsCollection } from '../../models/currency.js';
import { DepositEvent } from '../../models/index.js';

const USER_ID = new mongoose.Types.ObjectId().toString();
const CURRENCY_ID = new mongoose.Types.ObjectId();
const ASSET_ID = new mongoose.Types.ObjectId();
const ENGINE_FIELD = `${USER_ID}_${CURRENCY_ID.toString()}`;

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const makeReq = () => ({ user: { id: USER_ID }, query: {} });

const lastBody = (res) => res.json.mock.calls[res.json.mock.calls.length - 1][0];

describe('Deposit Controller balance source (CRITICAL - Paper Trading)', () => {
  let hash;

  beforeEach(() => {
    hash = {};
    hget.mockImplementation(async (key, field) => {
      const k = `${key}|${field}`;
      return k in hash ? hash[k] : null;
    });
    Currency.findOne.mockResolvedValue({ _id: CURRENCY_ID, coin: 'USDC' });
    assetsCollection.findOne.mockResolvedValue({
      _id: ASSET_ID,
      userId: new mongoose.Types.ObjectId(USER_ID),
      currencyId: CURRENCY_ID.toString(),
      coin: 'USDC',
      spotBal: '10000000000' // 10,000 USDC in smallest units
    });
  });

  test('reports the engine balance, not the stale flat mirror', async () => {
    // The exact live shape: flat row still says 10,000, the engine settled to 5,000.
    hash[`walletbalance_spot|${ENGINE_FIELD}`] = '5000';

    const res = makeRes();
    await getDepositInfo(makeReq(), res);

    expect(lastBody(res).usdcBalance).toBe(5000);
    expect(lastBody(res).usdcBalance).not.toBe(10000);
  });

  test('reports funds the flat mirror lost entirely', async () => {
    // The other live shape: flat row zeroed, engine holds the money.
    assetsCollection.findOne.mockResolvedValue({
      _id: ASSET_ID,
      userId: new mongoose.Types.ObjectId(USER_ID),
      currencyId: CURRENCY_ID.toString(),
      coin: 'USDC',
      spotBal: '0'
    });
    hash[`walletbalance_spot|${ENGINE_FIELD}`] = '10000';

    const res = makeRes();
    await getDepositInfo(makeReq(), res);

    expect(lastBody(res).usdcBalance).toBe(10000);
  });

  test('reports zero for an account the engine has never touched', async () => {
    // This used to fall back to the flat `assets` ledger, which held a second
    // copy of the balance for an account that had never traded. That ledger
    // held USDC alone and went with it, so an absent engine field now means
    // exactly what it says rather than "look somewhere else".
    const res = makeRes();
    await getDepositInfo(makeReq(), res);

    expect(lastBody(res).usdcBalance).toBe(0);
  });

  test('rejects an unauthenticated caller', async () => {
    const res = makeRes();
    await getDepositInfo({ query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(lastBody(res).success).toBe(false);
  });

  test('reports zero rather than throwing when USDC is not configured', async () => {
    Currency.findOne.mockResolvedValue(null);

    const res = makeRes();
    await getDepositInfo(makeReq(), res);

    expect(lastBody(res).usdcBalance).toBe(0);
  });
});

/**
 * THE HISTORY A SECOND DEVICE SEES
 * ================================
 *
 * A faucet claim used to credit a second, non-spot wallet as well. Only the
 * spot legs were ever written as deposit rows, and the history page filled the
 * gap from a receipt in the claiming browser's localStorage - so the money
 * simply was not there on any other device, or from a plain API read.
 *
 * Every credited leg is a row now, and this endpoint is what turns them back
 * into amounts: it must report the row's own WALLET, and decode the amount at
 * the row's own DECIMALS rather than a hard-coded 1e6 (0.05 BTC is not a whole
 * number of 1e6 units in any honest sense, and the pre-existing rows say 6).
 *
 * DepositEvent rows naming that second wallet STILL EXIST in the collection,
 * which is why the fixtures below still carry one: this endpoint must report
 * each row's OWN wallet and decode at each row's OWN decimals, whatever they
 * say. Do not "clean" those fixtures to 'spot' - two rows with the same wallet
 * would make the assertion vacuous.
 */
describe('getDepositHistory - every leg, at its own scale', () => {
  let query;

  const wireRows = (rows, count = rows.length) => {
    query = {
      sort: jest.fn(() => query),
      limit: jest.fn(() => query),
      skip: jest.fn(() => query),
      lean: jest.fn(async () => rows)
    };
    DepositEvent.find.mockReturnValue(query);
    DepositEvent.countDocuments.mockResolvedValue(count);
  };

  const row = (over) => ({
    creditedAt: new Date('2026-08-03T23:27:00.000Z'),
    asset: 'USDC',
    wallet: 'spot',
    amount: '1000000000000',
    decimals: 8,
    signature: 'faucet-1-user-spot-USDC',
    toAddress: 'faucet',
    ...over
  });

  const historyReq = (query = {}) => ({ user: { id: USER_ID }, query });

  test('reports the wallet each row landed in', async () => {
    wireRows([
      row(),
      row({ asset: 'BTC', wallet: 'inverse', amount: '5000000', signature: 'sig-btc' })
    ]);

    const res = makeRes();
    await getDepositHistory(historyReq(), res);

    const data = lastBody(res).result.data;
    expect(data.map((d) => d.wallet)).toEqual(['spot', 'inverse']);
  });

  test('decodes 0.05 BTC exactly, at the row own decimals', async () => {
    wireRows([
      row({ asset: 'BTC', wallet: 'inverse', amount: '5000000', decimals: 8, signature: 'sig-btc' })
    ]);

    const res = makeRes();
    await getDepositHistory(historyReq(), res);

    expect(lastBody(res).result.data[0].amount).toBe('0.05');
  });

  test('still reads the pre-existing 1e6 rows correctly', async () => {
    // Written before decimals was carried through: 10,000 USDC at 1e6.
    wireRows([row({ amount: '10000000000', decimals: 6 })]);

    const res = makeRes();
    await getDepositHistory(historyReq(), res);

    expect(lastBody(res).result.data[0].amount).toBe('10000');
  });

  test('a row that predates the wallet column reads as spot, which is what it was', async () => {
    wireRows([row({ wallet: undefined, amount: '10000000000', decimals: 6 })]);

    const res = makeRes();
    await getDepositHistory(historyReq(), res);

    expect(lastBody(res).result.data[0].wallet).toBe('spot');
  });

  test('orders the legs of one claim deterministically by insertion', async () => {
    wireRows([row()]);

    const res = makeRes();
    await getDepositHistory(historyReq(), res);

    // Same creditedAt for every leg of a claim, so _id is the only tiebreak
    // that keeps a claim's rows together and in the order they were credited.
    expect(query.sort).toHaveBeenCalledWith({ creditedAt: -1, _id: 1 });
  });

  test('paginates on the caller page and limit', async () => {
    wireRows([row()], 12);

    const res = makeRes();
    await getDepositHistory(historyReq({ page: '3', limit: '5' }), res);

    expect(query.limit).toHaveBeenCalledWith(5);
    expect(query.skip).toHaveBeenCalledWith(10);
    expect(lastBody(res).result.count).toBe(12);
  });

  test('rejects an unauthenticated caller', async () => {
    wireRows([row()]);

    const res = makeRes();
    await getDepositHistory({ query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(DepositEvent.find).not.toHaveBeenCalled();
  });
});
