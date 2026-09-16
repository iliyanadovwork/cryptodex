/**
 * PASSBOOK AUDIT-ROW INTEGRITY (CRITICAL)
 *
 * Every passbook row is the audit record of money that has ALREADY moved, so a
 * row that cannot be stored is a real loss, not a cosmetic one.
 *
 * /tmp/wallet-api.log showed this happening silently:
 *
 *   passbook validation failed: beforeBalance: Cast to Number failed for
 *   value "NaN" ... afterBalance: ... NaN
 *
 * always on the admin (paper ladder) account, once per coin. The cause was on
 * the spotapi side (a balance HGET of a field that did not exist yet), but the
 * reason nobody noticed was here: createPassBook caught the cast failure and
 * `return err`, and err is TRUTHY - indistinguishable from a saved document -
 * so the gRPC handler answered status:true for a row it had dropped.
 *
 * These tests pin BOTH halves of the contract:
 *   - a non-numeric row is refused loudly and reported as a failure,
 *   - the schema is never widened to accept NaN, and a valid row still saves.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const saved = [];
const saveBehaviour = { throwOnSave: false };

jest.mock('../../models/index.js', () => ({
  __esModule: true,
  Passbook: class Passbook {
    constructor(data) {
      Object.assign(this, data);
    }
    async save() {
      if (saveBehaviour.throwOnSave) {
        throw new Error('passbook validation failed');
      }
      saved.push(this);
      return this;
    }
  },
}));

jest.mock('../../models/smslog.js', () => ({ __esModule: true, default: class {} }));
jest.mock('csv-express', () => ({}), { virtual: true });

import {
  createPassBook,
  invalidPassbookNumbers,
  impossiblePassbookBalances,
} from '../../controllers/passbook.controller.js';

const USER_ID = '695af33fe64f3be062b77bb4'; // the admin/paper-ladder account
const CURRENCY_ID = '695bf0e2b9aba016fb8ce3c2';

const row = (overrides = {}) => ({
  userId: USER_ID,
  coin: 'SOL',
  currencyId: CURRENCY_ID,
  tableId: '6a712e106e9d3c42959bdbd0',
  beforeBalance: '240.9',
  afterBalance: '297.6',
  amount: '56.7',
  type: 'spot_market_match',
  category: 'credit',
  ...overrides,
});

describe('passbook audit-row integrity (CRITICAL)', () => {
  beforeEach(() => {
    saved.length = 0;
    saveBehaviour.throwOnSave = false;
  });

  describe('invalidPassbookNumbers', () => {
    test('accepts a fully numeric row', () => {
      expect(invalidPassbookNumbers(row())).toEqual([]);
    });

    test('names every non-numeric field - this is the exact live failure', () => {
      // gRPC ships these as strings, so NaN arrives as the string "NaN".
      expect(
        invalidPassbookNumbers(row({ beforeBalance: 'NaN', afterBalance: 'NaN' }))
      ).toEqual(['beforeBalance', 'afterBalance']);
    });

    test('rejects undefined / null / empty, not just NaN', () => {
      expect(invalidPassbookNumbers(row({ amount: undefined }))).toEqual(['amount']);
      expect(invalidPassbookNumbers(row({ amount: null }))).toEqual(['amount']);
      expect(invalidPassbookNumbers(row({ amount: '' }))).toEqual(['amount']);
      expect(invalidPassbookNumbers(undefined)).toEqual([
        'beforeBalance',
        'afterBalance',
        'amount',
      ]);
    });

    test('a zero balance is valid - a first-touch account really does start at 0', () => {
      expect(invalidPassbookNumbers(row({ beforeBalance: 0, afterBalance: '0' }))).toEqual(
        []
      );
    });
  });

  describe('createPassBook', () => {
    test('stores a valid row and returns the saved document', async () => {
      const result = await createPassBook(row());

      expect(result).not.toBe(null);
      expect(saved).toHaveLength(1);
      expect(saved[0].beforeBalance).toBe(240.9);
      expect(saved[0].afterBalance).toBe(297.6);
      expect(saved[0].amount).toBe(56.7);
    });

    test('REFUSES a NaN row, stores nothing, and reports the loss', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const result = await createPassBook(
        row({ beforeBalance: 'NaN', afterBalance: 'NaN' })
      );

      // Null, NOT a truthy error object: the caller must be able to tell.
      expect(result).toBe(null);
      expect(saved).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('AUDIT ROW LOST'),
        expect.stringContaining('beforeBalance'),
        expect.objectContaining({ userId: USER_ID, coin: 'SOL' })
      );

      errorSpy.mockRestore();
    });

    test('never widens the schema: a NaN is never handed to the model', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      // If the guard ever "repaired" NaN to 0/undefined, a row would appear here.
      await createPassBook(row({ amount: 'NaN' }));
      expect(saved).toHaveLength(0);
      errorSpy.mockRestore();
    });

    test('returns null (never throws) when the save itself fails', async () => {
      // Most call sites are fire-and-forget, so a rejection here would surface
      // as an unhandled promise rejection instead of a missing audit row.
      saveBehaviour.throwOnSave = true;
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(createPassBook(row())).resolves.toBe(null);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('AUDIT ROW LOST'),
        expect.any(String),
        expect.objectContaining({ userId: USER_ID })
      );
      errorSpy.mockRestore();
    });
  });

  /**
   * A NEGATIVE BALANCE IS AN IMPOSSIBLE AUDIT ROW.
   *
   * cryptodex_wallet.passbook held two of these, both written by the spot
   * insufficient-balance recovery:
   *
   *   { coin: 'BTC', beforeBalance: 0, afterBalance: -0.001, amount: 0.001,
   *     type: 'spot_market_orderPlace_Insufficient', category: 'credit' }
   *   { coin: 'SOL', beforeBalance: 0, afterBalance: -0.05,  amount: 0.05,
   *     type: 'spot_market_orderPlace_Insufficient', category: 'credit' }
   *
   * spot.controller debits Redis by the full order value, sees the result went
   * below zero, credits the difference straight back and rejects the order -
   * then books both halves, quoting the transient sub-zero figure. No wallet
   * ever held it. The recovery pair nets to zero, so refusing it loses no
   * movement; it only stops the ledger claiming an account went overdrawn.
   */
  describe('negative balances (impossible rows)', () => {
    test('a negative amount is FINE - a loss row books one', () => {
      expect(impossiblePassbookBalances(row({ amount: -159.38675 }))).toEqual([]);
      expect(invalidPassbookNumbers(row({ amount: -159.38675 }))).toEqual([]);
    });

    test('zero balances are fine - a fresh account really does sit at 0', () => {
      expect(
        impossiblePassbookBalances(row({ beforeBalance: 0, afterBalance: '0' }))
      ).toEqual([]);
    });

    test('names each negative balance field, strings included (gRPC sends strings)', () => {
      expect(impossiblePassbookBalances(row({ afterBalance: -0.001 }))).toEqual([
        'afterBalance',
      ]);
      expect(impossiblePassbookBalances(row({ beforeBalance: '-0.05' }))).toEqual([
        'beforeBalance',
      ]);
      expect(
        impossiblePassbookBalances(
          row({ beforeBalance: -1, afterBalance: '-2' })
        )
      ).toEqual(['beforeBalance', 'afterBalance']);
    });

    test('REFUSES the exact live row and stores nothing', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const result = await createPassBook(
        row({
          coin: 'BTC',
          beforeBalance: 0,
          afterBalance: -0.001,
          amount: 0.001,
          type: 'spot_market_orderPlace_Insufficient',
        })
      );

      expect(result).toBe(null);
      expect(saved).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('IMPOSSIBLE AUDIT ROW REFUSED'),
        expect.stringContaining('afterBalance'),
        expect.objectContaining({ userId: USER_ID, coin: 'BTC' })
      );

      errorSpy.mockRestore();
    });

    test('REFUSES the matching balretrive row (negative beforeBalance)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const result = await createPassBook(
        row({
          beforeBalance: -0.05,
          afterBalance: 0,
          type: 'spot_limit_balretrive_Insufficient_Market',
        })
      );

      expect(result).toBe(null);
      expect(saved).toHaveLength(0);
      errorSpy.mockRestore();
    });

    test('a loss row with a negative amount still SAVES - the guard is balance-only', async () => {
      const result = await createPassBook(
        row({
          beforeBalance: 100,
          afterBalance: 40,
          amount: -60,
          type: 'future_loss',
          category: 'debit',
        })
      );

      expect(result).not.toBe(null);
      expect(saved).toHaveLength(1);
      expect(saved[0].amount).toBe(-60);
    });
  });
});
