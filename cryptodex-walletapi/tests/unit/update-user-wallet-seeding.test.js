/**
 * `updateUserWallet` HYDRATES MISSING LEDGER FIELDS. IT DOES NOT OVERWRITE THEM.
 * =============================================================================
 *
 * WHAT IT DID, MEASURED LIVE
 * --------------------------
 * It wrote all nine engine ledgers with an unconditional `hset` from a mongo
 * snapshot, and two of the nine were wrong on top of that: a RESERVATION
 * counter and a settlement mirror were both fed the whole BALANCE.
 *
 * Its callers are spotapi `spot.controller.orderPlace` / `marketOrderPlace`,
 * which call it over gRPC in exactly one situation - `hget("walletbalance_spot",
 * ...) == null`, i.e. "the field is MISSING, please put it there" - and
 * walletapi's own `createAsset`, once, for a brand-new account.
 *
 * On this stack, own throwaway account holding one live SOLUSDC position
 * reserving 7.382 USDC, invoking the exact gRPC method spot.controller
 * invokes:
 *
 *   before the 10s backup cron (mongo balance 0):
 *     the balance ledger      2000  -> 0
 *     the reservation counter 7.382 -> 0     LIVE POSITION LEFT UNRESERVED
 *   after it (mongo balance 2000):
 *     the reservation counter 7.382 -> 2000  ENTIRE ACCOUNT RESERVED
 *
 * Both polarities, from one ordinary "the spot field was missing" call on the
 * order path.
 *
 * WHAT IS PINNED HERE
 * -------------------
 *   1. nothing is ever written with `hset` - every write is HSETNX, so an
 *      existing field is left exactly alone and there is no gap between the
 *      check and the write for a reservation to land in;
 *   2. the reservation counters are seeded from the RESERVATION fields, and the
 *      WB mirrors from the MIRROR fields, not from the balance;
 *   3. a missing field IS still seeded - the function must keep doing the only
 *      job its callers want from it.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const redisStore = {};
const calls = [];

// This project's jest config sets `resetMocks: true`, which strips the
// implementation off every jest.fn before each test. The factories therefore
// declare the shape and `beforeEach` re-installs the behaviour - a mock whose
// implementation has been reset answers `undefined`, which here would have
// looked like "the wallet has no assets" and passed a broken function.
jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  hset: jest.fn(),
  hsetnx: jest.fn(),
  hget: jest.fn(),
  hincbyfloat: jest.fn(),
}));

const walletDoc = { value: null };

jest.mock('../../models/index.js', () => ({
  __esModule: true,
  Wallet: { findOne: jest.fn() },
  Currency: { find: jest.fn(), findOne: jest.fn() },
  PriceConversion: { findOne: jest.fn() },
}));

jest.mock('../../controllers/passbook.controller.js', () => ({
  __esModule: true,
  createPassBook: jest.fn(async () => ({})),
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
  encryptString: jest.fn((v) => v),
}));
jest.mock('../../lib/walletStandDown.js', () => ({
  __esModule: true,
  applyStandDownMode: jest.fn(async () => ({ status: true })),
}));
jest.mock('../../lib/generalFun.js', () => ({
  __esModule: true,
  IncCntObjId: jest.fn(() => '1'),
}));

import { updateUserWallet } from '../../controllers/wallet.js';
import { hset, hsetnx, hget } from '../../controllers/redis.controller.js';
import { Wallet } from '../../models/index.js';

const USER = '6a769d0d5c3ed9629adcb4da';
const ASSET = '695bc8cd25bf5f8d3d11f2e4';
const FIELD = `${USER}_${ASSET}`;

// The wallet this service has. `updateUserWallet` seeds two ledgers - the spot
// pot and spot's IN-ORDER reservation counter - and nothing else.
//
// The DEFECT this file exists for: a RESERVATION counter must be seeded from
// the RESERVATION field, never from the balance. Here that is
// `walletbalance_spot_inOrder` <- `spotInOrder`, never `spotBal`.
const LOCKED = 'walletbalance_spot_inOrder';
const BAL = 'walletbalance_spot';

/** The asset as the backup cron leaves it on a funded account with a position. */
const fundedAsset = (overrides = {}) => ({
  _id: { toString: () => ASSET },
  coin: 'USDC',
  spotBal: 2000,
  spotInOrder: 7.382,
  ...overrides,
});

const setWallet = (assets) => {
  walletDoc.value = { _id: { toString: () => USER }, assets };
};

beforeEach(() => {
  for (const k of Object.keys(redisStore)) delete redisStore[k];
  calls.length = 0;
  setWallet([fundedAsset()]);

  hset.mockImplementation(async (key, field, value) => {
    calls.push({ op: 'hset', key, field: String(field), value });
    if (!redisStore[key]) redisStore[key] = {};
    redisStore[key][String(field)] = String(value);
    return 1;
  });
  // FAITHFUL HSETNX: writes only into an absent field, and says whether it did.
  hsetnx.mockImplementation(async (key, field, value) => {
    calls.push({ op: 'hsetnx', key, field: String(field), value });
    if (!redisStore[key]) redisStore[key] = {};
    if (Object.prototype.hasOwnProperty.call(redisStore[key], String(field))) {
      return false;
    }
    redisStore[key][String(field)] =
      typeof value === 'string' ? value : JSON.stringify(value);
    return true;
  });
  hget.mockImplementation(async (key, field) => {
    const h = redisStore[key];
    return h && h[String(field)] !== undefined ? h[String(field)] : null;
  });
  Wallet.findOne.mockImplementation(async () => walletDoc.value);
});

describe('updateUserWallet: seeding only', () => {
  test('a LIVE reservation is not touched - not zeroed, and not replaced by the balance', async () => {
    // Exactly the measured case: an order has reserved 7.382 and the mongo
    // snapshot is whatever the backup cron last wrote.
    redisStore[BAL] = { [FIELD]: '2000' };
    redisStore[LOCKED] = { [FIELD]: '7.382' };

    const result = await updateUserWallet({ id: USER });

    expect(result.status).toBe(true);
    expect(redisStore[LOCKED][FIELD]).toBe('7.382');
    expect(redisStore[BAL][FIELD]).toBe('2000');
  });

  test('it never writes an existing field, whatever the field holds', async () => {
    // "0" is the value the old `if (!value)` guards got wrong in one direction
    // and this one gets right by not having a guard at all: redis decides.
    redisStore[LOCKED] = { [FIELD]: '0' };
    redisStore[BAL] = { [FIELD]: '0' };

    await updateUserWallet({ id: USER });

    expect(redisStore[LOCKED][FIELD]).toBe('0');
    expect(redisStore[BAL][FIELD]).toBe('0');
  });

  test('nothing is written with `hset` - every write is HSETNX', async () => {
    // The check and the write have to be ONE command. An `hget`-then-`hset`
    // that happens to be guarded is still a window a reservation can land in.
    await updateUserWallet({ id: USER });
    expect(calls.some((c) => c.op === 'hset')).toBe(false);
    expect(calls.filter((c) => c.op === 'hsetnx').length).toBeGreaterThan(0);
  });

  test('a MISSING field is still seeded - the job the callers actually want', async () => {
    const result = await updateUserWallet({ id: USER });

    expect(result.status).toBe(true);
    expect(result.seeded).toBe(2);
    expect(redisStore[BAL][FIELD]).toBe('2000');
    expect(redisStore[LOCKED][FIELD]).toBe('7.382');
  });

  test('the reservation counter is seeded from the RESERVATION field, not the balance', async () => {
    // This is the "whole balance into the locked counter" defect, stated as an
    // assertion: 7.382 is spotInOrder, 2000 is spotBal. Seeding the counter
    // from the balance is what strands a user's whole wallet behind a
    // reservation that no order corresponds to.
    await updateUserWallet({ id: USER });

    expect(redisStore[LOCKED][FIELD]).toBe('7.382');
    expect(redisStore[LOCKED][FIELD]).not.toBe('2000');
  });

  test('exactly two ledgers are seeded - nothing else is served', async () => {
    await updateUserWallet({ id: USER });

    expect(Object.keys(redisStore).sort()).toEqual([BAL, LOCKED].sort());
  });

  test('an asset written before a field existed seeds 0, not the string "undefined"', async () => {
    setWallet([
      fundedAsset({
        spotInOrder: undefined,
      }),
    ]);

    await updateUserWallet({ id: USER });

    expect(redisStore[LOCKED][FIELD]).toBe('0');
  });

  test('`seeded` counts only what this call created', async () => {
    redisStore[LOCKED] = { [FIELD]: '7.382' };
    redisStore[BAL] = { [FIELD]: '2000' };

    const result = await updateUserWallet({ id: USER });

    expect(result.seeded).toBe(0); // two ledgers, both already present
  });

  test('every asset on the wallet is seeded, not just the first', async () => {
    const second = {
      ...fundedAsset(),
      _id: { toString: () => 'aaaaaaaaaaaaaaaaaaaaaaaa' },
      coin: 'BTC',
      spotInOrder: 1.5,
    };
    setWallet([fundedAsset(), second]);

    await updateUserWallet({ id: USER });

    expect(redisStore[LOCKED][FIELD]).toBe('7.382');
    expect(redisStore[LOCKED][`${USER}_aaaaaaaaaaaaaaaaaaaaaaaa`]).toBe('1.5');
  });

  test('a wallet with no assets reports failure and writes nothing', async () => {
    setWallet([]);
    const result = await updateUserWallet({ id: USER });
    expect(result.status).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
