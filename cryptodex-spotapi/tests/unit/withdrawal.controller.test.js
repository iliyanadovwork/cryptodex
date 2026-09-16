/**
 * Withdrawal Controller Tests (CRITICAL - Paper Trading)
 *
 * Exercises the REAL controllers/withdrawal.controller.js with mocked I/O
 * (Redis, Mongo collections, gRPC wallet ledger).
 *
 * Pins the fixed double-ledger bug: a withdrawal used to debit ONLY the
 * wallet-API Redis field (`<userId>_<assetDocId>`) and left the trading-engine
 * field (`<userId>_<currencyId>`) untouched, so the withdrawn funds were still
 * fully spendable on the order book.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import mongoose from 'mongoose';

// ---- I/O mocks (must be declared before importing the controller) ----

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
  const walletCollection = { findOne: jest.fn() };
  const Currency = {
    find: jest.fn(),
    findOne: jest.fn(),
    db: {
      collection: (name) => (name === 'wallet' ? walletCollection : assetsCollection)
    }
  };
  return {
    __esModule: true,
    default: Currency,
    __assetsCollection: assetsCollection,
    __walletCollection: walletCollection
  };
});

jest.mock('../../models/index.js', () => ({
  __esModule: true,
  WithdrawalEvent: {
    create: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    countDocuments: jest.fn()
  }
}));

import {
  requestWithdrawal,
  getWithdrawalHistory,
  getWithdrawalStatus,
  isPaperIssued,
} from '../../controllers/withdrawal.controller.js';
import { hset, hget, hincbyfloat } from '../../controllers/redis.controller.js';
import { updateUserAsset } from '../../grpc/walletService.js';
import Currency, { __assetsCollection as assetsCollection } from '../../models/currency.js';
import { WithdrawalEvent } from '../../models/index.js';

const USER_ID = new mongoose.Types.ObjectId().toString();
const CURRENCY_ID = new mongoose.Types.ObjectId();
const ASSET_ID = new mongoose.Types.ObjectId();

const ENGINE_FIELD = `${USER_ID}_${CURRENCY_ID.toString()}`; // trading-engine key style
const WALLET_FIELD = `${USER_ID}_${ASSET_ID.toString()}`;    // wallet-API key style

const DESTINATION = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'; // base58, 44 chars

const hashKey = (key, field) => `${key}|${field}`;

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const makeReq = (body) => ({ user: { id: USER_ID }, body });

describe('Withdrawal Controller (CRITICAL - Paper Trading)', () => {
  let hash; // in-memory walletbalance_spot hash
  let assetDoc;

  beforeEach(() => {
    hash = {};
    hset.mockImplementation(async (key, field, value) => {
      hash[hashKey(key, field)] = value;
    });
    hget.mockImplementation(async (key, field) => {
      const k = hashKey(key, field);
      return k in hash ? hash[k] : null;
    });
    hincbyfloat.mockImplementation(async (key, field, inc) => {
      const k = hashKey(key, field);
      const next = parseFloat(hash[k] != null ? hash[k] : 0) + parseFloat(inc);
      hash[k] = next.toString();
      return next.toString();
    });

    assetDoc = {
      _id: ASSET_ID,
      userId: new mongoose.Types.ObjectId(USER_ID),
      currencyId: CURRENCY_ID.toString(),
      coin: 'USDC',
      spotBal: '10000000000' // 10,000 USDC in smallest units
    };

    Currency.findOne.mockResolvedValue({ _id: CURRENCY_ID, coin: 'USDC' });
    assetsCollection.findOne.mockResolvedValue(assetDoc);
    assetsCollection.updateOne.mockResolvedValue({ acknowledged: true });
    assetsCollection.insertOne.mockResolvedValue({ acknowledged: true });
    updateUserAsset.mockResolvedValue({ status: true });
    WithdrawalEvent.create.mockResolvedValue({});
  });

  /**
   * WITHDRAWAL IS CLOSED
   * ====================
   *
   * These tests replace nine that pinned the DEBIT. That behaviour was measured
   * on the running stack - one curl, ordinary user token, no race - moving spot
   * USDC 19,500 -> 9,500 across all four ledger locations while answering
   * `{ destination: <a Solana address>, txid: "paper-...", message:
   * "Withdrawal processed successfully" }`. On a venue with no custody there is
   * no counterparty and nowhere for the funds to go, so the endpoint was
   * deleting the user's scoreboard and describing it as a transfer. See the
   * controller header for why this is a refusal and not a silent no-op.
   *
   * Each test below names an input that USED to reach the debit.
   */
  describe('requestWithdrawal is refused (410 WITHDRAWALS_CLOSED)', () => {
    const noLedgerTouched = () => {
      expect(hincbyfloat).not.toHaveBeenCalled();
      expect(hset).not.toHaveBeenCalled();
      expect(hget).not.toHaveBeenCalled();
      expect(WithdrawalEvent.create).not.toHaveBeenCalled();
      expect(assetsCollection.updateOne).not.toHaveBeenCalled();
      expect(updateUserAsset).not.toHaveBeenCalled();
    };

    test('a fully valid, fully funded, in-range request is refused and moves nothing', async () => {
      hash[hashKey('walletbalance_spot', ENGINE_FIELD)] = '10000';
      hash[hashKey('walletbalance_spot', WALLET_FIELD)] = '10000';

      const res = makeRes();
      await requestWithdrawal(makeReq({ amount: 1, destinationAddress: DESTINATION }), res);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, code: 'WITHDRAWALS_CLOSED' })
      );

      // The balances are exactly what they were.
      expect(parseFloat(hash[hashKey('walletbalance_spot', ENGINE_FIELD)])).toBe(10000);
      expect(parseFloat(hash[hashKey('walletbalance_spot', WALLET_FIELD)])).toBe(10000);
      noLedgerTouched();
    });

    test('the exact request that emptied an account live (10,000, the old maximum) is refused', async () => {
      hash[hashKey('walletbalance_spot', ENGINE_FIELD)] = '19500';
      hash[hashKey('walletbalance_spot', WALLET_FIELD)] = '19500';

      const res = makeRes();
      await requestWithdrawal(
        makeReq({ amount: 10000, destinationAddress: DESTINATION }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(410);
      expect(parseFloat(hash[hashKey('walletbalance_spot', ENGINE_FIELD)])).toBe(19500);
      noLedgerTouched();
    });

    test('the refusal never dresses itself up as a completed transfer', async () => {
      const res = makeRes();
      await requestWithdrawal(makeReq({ amount: 1, destinationAddress: DESTINATION }), res);

      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
      // A caller that keyed off any of these would read a refusal as a payout.
      expect(body).not.toHaveProperty('txid');
      expect(body).not.toHaveProperty('signature');
      expect(body).not.toHaveProperty('destination');
      expect(body).not.toHaveProperty('balance');
      expect(String(body.message)).not.toMatch(/successful/i);
      // and it names the thing the user probably wanted instead.
      expect(body.resetEndpoint).toBe('POST /api/spot/faucet/reset');
    });

    test('every shape of request gets the SAME answer - the venue tells one story', async () => {
      const inputs = [
        { amount: 1, destinationAddress: DESTINATION },      // valid
        { amount: 10001, destinationAddress: DESTINATION },  // over the old max
        { amount: 0.001, destinationAddress: DESTINATION },  // under the old min
        { amount: 1, destinationAddress: '0xdeadbeef' },     // not a Solana address
        { amount: 'not a number', destinationAddress: DESTINATION },
        {}                                                    // nothing at all
      ];

      for (const body of inputs) {
        const res = makeRes();
        await requestWithdrawal(makeReq(body), res);
        expect(res.status).toHaveBeenCalledWith(410);
        expect(res.json.mock.calls[0][0].code).toBe('WITHDRAWALS_CLOSED');
      }
      noLedgerTouched();
    });

    test('an insufficient balance is refused for the CLOSED reason, not the poverty reason', async () => {
      // Guards the over-correction where someone "restores" withdrawal behind an
      // affordability check: the answer must not depend on the balance at all.
      hash[hashKey('walletbalance_spot', ENGINE_FIELD)] = '5';

      const res = makeRes();
      await requestWithdrawal(makeReq({ amount: 100, destinationAddress: DESTINATION }), res);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].code).toBe('WITHDRAWALS_CLOSED');
      noLedgerTouched();
    });

    test('the refusal does not depend on the USDC currency document existing', async () => {
      // It used to 500 here. A refusal that can be turned into a 500 by deleting
      // a currency row is a refusal with a code path behind it.
      Currency.findOne.mockResolvedValue(null);

      const res = makeRes();
      await requestWithdrawal(makeReq({ amount: 1, destinationAddress: DESTINATION }), res);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(Currency.findOne).not.toHaveBeenCalled();
    });
  });

  /**
   * PRE-CONVERSION WITHDRAWAL ROWS
   *
   * `withdrawalevents` still holds rows written before Cryptodex became a paper
   * exchange, whose `signature` is a real 88-character base58 Solana txid. The
   * rows are user data and are kept exactly as they are; the guard is that no
   * response may present such a signature as a transaction id of this exchange.
   */
  describe('legacy (pre-paper-conversion) withdrawal rows', () => {
    // A real 88-char base58 Solana signature, taken from the shape of the four
    // rows actually present in cryptodex_spot.withdrawalevents.
    const CHAIN_SIGNATURE =
      '4KJTKCNauXtXXAxiRK6ieYS1njs7di84HwqdWkCBvyW4oFNBPRpGi2sVGNjzQxFtRecFpkcQrUbKewCgVe6d6CTm';
    const PAPER_SIGNATURE = 'paper-1785793939026';

    const legacyRow = {
      _id: 'legacy-row',
      userId: USER_ID,
      amount: '20000',
      amountFormatted: '20000',
      destinationAddress: DESTINATION,
      signature: CHAIN_SIGNATURE,
      status: 'completed'
      // note: no `network` at all - these rows predate the field default
    };
    const paperRow = {
      _id: 'paper-row',
      userId: USER_ID,
      amount: '1000000',
      amountFormatted: '1',
      destinationAddress: DESTINATION,
      signature: PAPER_SIGNATURE,
      status: 'completed',
      network: 'paper'
    };

    const historyReq = { user: { id: USER_ID }, query: {} };

    const mockHistory = (rows) => {
      WithdrawalEvent.countDocuments.mockResolvedValue(rows.length);
      WithdrawalEvent.find.mockReturnValue({
        sort: () => ({ limit: () => ({ skip: () => ({ lean: async () => rows }) }) })
      });
    };

    test('isPaperIssued distinguishes a paper txid from a chain signature', () => {
      expect(isPaperIssued(paperRow)).toBe(true);
      expect(isPaperIssued(legacyRow)).toBe(false);
      expect(isPaperIssued({ signature: CHAIN_SIGNATURE, network: 'paper' })).toBe(true);
      expect(isPaperIssued({})).toBe(false);
    });

    test('history NEVER emits a chain signature as a txid', async () => {
      mockHistory([legacyRow, paperRow]);

      const res = makeRes();
      await getWithdrawalHistory(historyReq, res);

      const payload = res.json.mock.calls[0][0];
      const [legacy, paper] = payload.result.data;

      expect(legacy.txid).toBe('N/A');
      expect(JSON.stringify(payload)).not.toContain(CHAIN_SIGNATURE);

      // The paper-issued row is unaffected.
      expect(paper.txid).toBe(PAPER_SIGNATURE);
    });

    test('history labels a pre-conversion row instead of hiding or deleting it', async () => {
      mockHistory([legacyRow, paperRow]);

      const res = makeRes();
      await getWithdrawalHistory(historyReq, res);

      const payload = res.json.mock.calls[0][0];
      // Both rows are still returned: nothing is dropped from the user's history.
      expect(payload.result.data).toHaveLength(2);
      expect(payload.result.count).toBe(2);

      const [legacy, paper] = payload.result.data;
      expect(legacy).toMatchObject({
        legacy: true,
        isPaper: false,
        network: 'legacy',
        note: 'Pre-paper-conversion record',
        amount: '20000',
        status: 'completed'
      });
      expect(paper).toMatchObject({ legacy: false, isPaper: true, network: 'paper' });
      expect(paper.note).toBeUndefined();
    });

    test('status lookup labels a pre-conversion row', async () => {
      WithdrawalEvent.findOne.mockReturnValue({ lean: async () => legacyRow });

      const res = makeRes();
      await getWithdrawalStatus(
        { user: { id: USER_ID }, query: { signature: CHAIN_SIGNATURE } },
        res
      );

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          legacy: true,
          isPaper: false,
          network: 'legacy',
          note: 'Pre-paper-conversion record'
        })
      );
    });

    test('no new row can be added to this history at all', async () => {
      // This used to assert that a withdrawal issued NOW was paper-issued end to
      // end. There is no longer any way to issue one, which is the stronger
      // statement: the set of rows in `withdrawalevents` is closed, so the
      // legacy/paper labelling above is the whole of the problem forever.
      hash[hashKey('walletbalance_spot', ENGINE_FIELD)] = '10000';
      const res = makeRes();
      await requestWithdrawal(makeReq({ amount: 1, destinationAddress: DESTINATION }), res);

      expect(res.status).toHaveBeenCalledWith(410);
      expect(WithdrawalEvent.create).not.toHaveBeenCalled();
    });

    test('the history reader carries the server\'s own statement that the facility is closed', async () => {
      // The page must not have to hard-code that sentence: if it did, the page
      // and the endpoint could come to disagree about whether withdrawal exists.
      mockHistory([paperRow]);

      const res = makeRes();
      await getWithdrawalHistory(historyReq, res);

      const payload = res.json.mock.calls[0][0];
      expect(payload.closed).toBe(true);
      expect(payload.notice).toMatch(/closed/i);
      // and the rows themselves are still all there
      expect(payload.result.data).toHaveLength(1);
    });

    test('the schema default network cannot mislabel a new row as a chain transfer', async () => {
      // The default used to be 'devnet': any row written without an explicit
      // network was born looking like a pre-conversion chain transfer and would
      // be reported to its own user as a legacy record with no txid.
      const { default: WithdrawalEventModel } = await import(
        '../../models/withdrawalEvent.js'
      );
      const doc = new WithdrawalEventModel({
        userId: new mongoose.Types.ObjectId(),
        amount: '1000000',
        amountFormatted: '1',
        destinationAddress: DESTINATION,
        signature: 'paper-' + Date.now()
      });

      expect(doc.network).toBe('paper');
      expect(isPaperIssued(doc)).toBe(true);
    });
  });

});
