/**
 * Spot Matcher Latch Tests (CRITICAL - Paper Trading)
 *
 * Exercises the REAL controllers/spot.controller.js (with all I/O mocked)
 * to pin the fixed bug: when tradeMatching throws mid-match, the
 * module-level isRun latch must be released so the 2s matching cron can
 * match again. Before the fix, one thrown error permanently stopped the
 * matcher for every pair until process restart.
 *
 * The 2s cron callback is captured through a mocked node-cron, and the
 * (module-private) latch is observed through its only real effect: whether
 * the cron invokes matchingcall (visible as FetchpairData's
 * hget('spotPairdata', pairId) lookup).
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

// ---- I/O mocks (must be declared before importing the controller) ----

// Capture cron jobs with plain functions/arrays so the registration made at
// module load survives jest resetMocks between tests.
jest.mock('node-cron', () => {
  const jobs = [];
  const schedule = (expression, cb, options) => {
    jobs.push({ expression, cb, options });
    return { stop: () => {} };
  };
  return { schedule, __jobs: jobs };
});

jest.mock('../../models/index.js', () => ({
  __esModule: true,
  SpotPair: { find: jest.fn(), findOne: jest.fn() },
  SpotOrder: {},
  OrderHistory: {},
  TradeHistory: {},
  SequenceId: { findOneAndUpdate: jest.fn() }
}));

jest.mock('../../config/socketIO.js', () => ({
  __esModule: true,
  socketEmitOne: jest.fn(),
  socketEmitAll: jest.fn()
}));

jest.mock('../../controllers/binance.controller.js', () => ({ __esModule: true }));

jest.mock('../../controllers/chart/chart.controller.js', () => ({
  __esModule: true,
  ChartDocHistory: jest.fn()
}));

jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  hset: jest.fn(),
  hget: jest.fn(),
  hgetall: jest.fn(),
  hincby: jest.fn(),
  hincbyfloat: jest.fn(),
  hdel: jest.fn(),
  hgetdel: jest.fn(),
  hlen: jest.fn(),
  hmget: jest.fn(),
  hmset: jest.fn(),
  rpush: jest.fn(),
  lrange: jest.fn(),
  lpop: jest.fn(),
  rpop: jest.fn()
}));

jest.mock('../../grpc/currencyService.js', () => ({
  __esModule: true,
  priceConversionGrpc: jest.fn()
}));

jest.mock('../../grpc/walletService.js', () => ({
  __esModule: true,
  getUserAsset: jest.fn(),
  updateUserWallet: jest.fn(),
  updateUserAsset: jest.fn(),
  passbook: jest.fn()
}));

jest.mock('../../grpc/adminService.js', () => ({
  __esModule: true,
  saveAdminprofit: jest.fn()
}));

import { tradeMatching, fetchAllpairs } from '../../controllers/spot.controller.js';
import { hget, hgetall } from '../../controllers/redis.controller.js';
import nodeCron from 'node-cron';

const PAIR_ID = '64b000000000000000000001';

const pairFixture = {
  _id: PAIR_ID,
  status: 'active',
  pair: 'BTCUSDC',
  firstCurrencySymbol: 'BTC',
  secondCurrencySymbol: 'USDC',
  botstatus: 'bot',
  markPrice: 50000
};

// Flush resolved-promise chains kicked off by the (un-awaited) cron work
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const matcherRan = () =>
  hget.mock.calls.some(([key, field]) => key === 'spotPairdata' && String(field) === PAIR_ID);

describe('Spot Matching Cron Latch (CRITICAL)', () => {
  let cronCb;

  const defaultHgetall = async (key) => {
    if (key === 'spotPairdata') return { [PAIR_ID]: JSON.stringify(pairFixture) };
    return null; // no open orders, no filled orders
  };

  beforeEach(async () => {
    hgetall.mockImplementation(defaultHgetall);
    hget.mockImplementation(async (key) => {
      if (key === 'spotPairdata') return JSON.stringify(pairFixture);
      return null;
    });

    // The 2s matching cron registered at module load
    const matchJob = nodeCron.__jobs.find((j) => j.expression === '*/2 * * * * *');
    expect(matchJob).toBeDefined();
    cronCb = matchJob.cb;

    // Populate the module-level pairInfo the cron iterates
    await fetchAllpairs();
  });

  test('cron invokes matchingcall for active pairs when the latch is free', async () => {
    hget.mockClear();
    await cronCb();
    await flush();

    expect(matcherRan()).toBe(true);
  });

  test('a completed tradeMatching run (empty books) releases the latch for the next cron tick', async () => {
    await tradeMatching(null, null, { ...pairFixture });

    hget.mockClear();
    await cronCb();
    await flush();

    expect(matcherRan()).toBe(true);
  });

  test('a tradeMatching that throws mid-match releases the latch so the cron can match again (regression)', async () => {
    // pairData null makes the real function throw inside its try block
    // (reading .botstatus of null) AFTER it has set isRun = true.
    // The error must be swallowed and the latch released.
    await expect(tradeMatching([], [], null)).resolves.toBeUndefined();

    hget.mockClear();
    await cronCb();
    await flush();

    // Before the fix isRun stayed true forever and the cron skipped
    // matchingcall for every pair; hget('spotPairdata', pairId) proves
    // the matcher ran again.
    expect(matcherRan()).toBe(true);
  });

  test('the latch blocks the cron while a match is in flight and frees it once the match finishes', async () => {
    let releaseBuyOrders;
    const pendingBuyOrders = new Promise((resolve) => {
      releaseBuyOrders = resolve;
    });

    hgetall.mockImplementation(async (key) => {
      if (key === 'spotPairdata') return { [PAIR_ID]: JSON.stringify(pairFixture) };
      if (key.startsWith('buyOpenOrders_')) return pendingBuyOrders; // suspend mid-match
      return null;
    });

    // botstatus 'off' + a market sell drives tradeMatching into the branch
    // that re-reads buyOpenOrders, where it suspends with the latch held.
    const inflight = tradeMatching(
      null,
      [{ price: 'market', pairId: PAIR_ID }],
      { ...pairFixture, botstatus: 'off' }
    );
    await flush();

    hget.mockClear();
    await cronCb();
    await flush();

    // Latch held: the cron must NOT start another match
    expect(matcherRan()).toBe(false);

    // Let the in-flight match finish (no buy orders -> early return)
    releaseBuyOrders(null);
    await inflight;

    hget.mockClear();
    await cronCb();
    await flush();

    // Latch released after completion: the cron matches again
    expect(matcherRan()).toBe(true);
  });
});
