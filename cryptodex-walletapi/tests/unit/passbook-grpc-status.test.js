/**
 * PASSBOOK gRPC STATUS (CRITICAL)
 *
 * controllers/wallet.js `passbook` is what grpc/server.js answers spotapi with.
 * It used to `return { status: true }` unconditionally, so a dropped audit row
 * (a NaN balance the schema refused) was reported to the calling API as a
 * success. The status must now follow whether the row was actually stored.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const mockCreatePassBook = jest.fn();

jest.mock('../../controllers/passbook.controller.js', () => ({
  __esModule: true,
  createPassBook: (...args) => mockCreatePassBook(...args),
}));

// Everything else wallet.js pulls in at module load - none of it is exercised
// by the passbook wrapper.
jest.mock('../../models/index.js', () => ({
  __esModule: true,
  Wallet: {},
  Currency: {},
  PriceConversion: {},
}));
jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  hset: jest.fn(),
}));
jest.mock('../../controllers/coin.controller.js', () => ({ __esModule: true }));
jest.mock('../../controllers/coin/bnbGateway.js', () => ({
  __esModule: true,
  createAddress: jest.fn(),
}));
jest.mock('../../controllers/coin/bdyxGateway.js', () => ({
  __esModule: true,
  createAddress: jest.fn(),
}));
jest.mock('../../controllers/coin/firebase.js', () => ({
  __esModule: true,
  createVaultAsset: jest.fn(),
  getUserWalletById: jest.fn(),
}));
jest.mock('../../lib/cryptoJS.js', () => ({
  __esModule: true,
  encryptString: (value) => value,
}));

import { passbook } from '../../controllers/wallet.js';

const row = {
  userId: '695af33fe64f3be062b77bb4',
  coin: 'SOL',
  beforeBalance: '240.9',
  afterBalance: '297.6',
  amount: '56.7',
  type: 'spot_market_match',
  category: 'credit',
};

describe('gRPC passbook status reflects whether the row was stored', () => {
  beforeEach(() => {
    mockCreatePassBook.mockReset();
  });

  test('status:true when the row is saved', async () => {
    mockCreatePassBook.mockResolvedValue({ _id: 'saved' });
    await expect(passbook(row)).resolves.toEqual({ status: true });
  });

  test('status:FALSE when the row was dropped - never a silent success', async () => {
    mockCreatePassBook.mockResolvedValue(null);
    await expect(passbook({ ...row, beforeBalance: 'NaN' })).resolves.toEqual({
      status: false,
    });
  });

  test('status:false (and no throw) when createPassBook rejects', async () => {
    mockCreatePassBook.mockRejectedValue(new Error('mongo down'));
    await expect(passbook(row)).resolves.toEqual({ status: false });
  });
});
