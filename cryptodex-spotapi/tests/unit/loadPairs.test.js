/**
 * Pair cache hydration tests (CRITICAL - stale pair cache)
 *
 * Exercises the REAL controllers/loadPairs.js with mocked I/O.
 *
 * Pins the fixed phantom-pair bug: getPairList() prefers the Redis
 * "spotPairdata" hash and only falls back to mongo when it is EMPTY, so a hash
 * left over from an older database kept serving pairs whose _id exists nowhere
 * (BTCUSDT at a frozen 89,999.99 while the real BTCUSD book traded at ~63.4k).
 * Mongo has to be authoritative on boot AND the leftovers have to be pruned.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import mongoose from 'mongoose';

jest.mock('../../config/index.js', () => ({
  __esModule: true,
  default: {
    REDIS_URL: 'redis://127.0.0.1:6379',
    REDIS_PREFIX: 'cryptodex_',
    WALLET_URL: 'http://localhost:3002',
    IMAGE: { CURRENCY_URL_PATH: '/currency/' }
  }
}));

jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  hset: jest.fn(),
  hget: jest.fn(),
  hgetall: jest.fn(),
  hdel: jest.fn()
}));

jest.mock('../../grpc/currencyService.js', () => ({
  __esModule: true,
  currencyId: jest.fn()
}));

jest.mock('../../models/index.js', () => ({
  __esModule: true,
  SpotPair: { find: jest.fn() }
}));

import { loadPairsToRedis } from '../../controllers/loadPairs.js';
import { hset, hgetall, hdel } from '../../controllers/redis.controller.js';
import { currencyId } from '../../grpc/currencyService.js';
import { SpotPair } from '../../models/index.js';

const REAL_ID = new mongoose.Types.ObjectId();
const PHANTOM_ID = new mongoose.Types.ObjectId();
const BASE_ID = new mongoose.Types.ObjectId();
const QUOTE_ID = new mongoose.Types.ObjectId();

const realPair = () => ({
  _id: REAL_ID,
  tikerRoot: 'BTCUSD',
  firstCurrencyId: BASE_ID,
  secondCurrencyId: QUOTE_ID,
  firstCurrencySymbol: 'BTC',
  secondCurrencySymbol: 'USD',
  status: 'active',
  botstatus: 'binance'
});

describe('loadPairsToRedis (CRITICAL - stale pair cache)', () => {
  let cache; // in-memory spotPairdata hash

  beforeEach(() => {
    cache = {};
    hgetall.mockImplementation(async () => cache);
    hset.mockImplementation(async (key, field, value) => {
      cache[field] = JSON.stringify(value);
    });
    hdel.mockImplementation(async (key, field) => {
      delete cache[field];
    });
    currencyId.mockResolvedValue({ status: false });
    SpotPair.find.mockReturnValue({ lean: async () => [realPair()] });
  });

  test('should prune cached pairs that no longer exist in mongo (regression)', async () => {
    // The hash still holds a pair from a previous database
    cache[PHANTOM_ID.toString()] = JSON.stringify({
      _id: PHANTOM_ID.toString(),
      tikerRoot: 'BTCUSDT',
      status: 'active',
      markPrice: 89999.99
    });

    const result = await loadPairsToRedis();

    expect(result).toEqual({ success: true, loaded: 1, pruned: 1 });
    expect(hdel).toHaveBeenCalledWith('spotPairdata', PHANTOM_ID.toString());
    expect(Object.keys(cache)).toEqual([REAL_ID.toString()]);
  });

  test('should hydrate every mongo pair so an empty cache is never served from', async () => {
    const result = await loadPairsToRedis();

    expect(result.success).toBe(true);
    expect(hset).toHaveBeenCalledWith(
      'spotPairdata',
      REAL_ID.toString(),
      expect.objectContaining({ _id: REAL_ID.toString(), tikerRoot: 'BTCUSD', status: 'active' })
    );
  });

  test('should let mongo win over a stale cached copy of the same pair', async () => {
    cache[REAL_ID.toString()] = JSON.stringify({
      _id: REAL_ID.toString(),
      tikerRoot: 'BTCUSD',
      status: 'deactive',
      secondCurrencySymbol: 'USDT'
    });

    await loadPairsToRedis();

    const stored = JSON.parse(cache[REAL_ID.toString()]);
    expect(stored.status).toBe('active');
    expect(stored.secondCurrencySymbol).toBe('USD');
  });

  test('should carry over the live-only price fields mongo does not store', async () => {
    cache[REAL_ID.toString()] = JSON.stringify({
      _id: REAL_ID.toString(),
      markPrice: 63512.88,
      last: 63512.88,
      high: 64155.2,
      low: 63000.1,
      change: '-0.01'
    });

    await loadPairsToRedis();

    const stored = JSON.parse(cache[REAL_ID.toString()]);
    expect(stored.markPrice).toBe(63512.88);
    expect(stored.last).toBe(63512.88);
    expect(stored.high).toBe(64155.2);
    expect(stored.change).toBe('-0.01');
  });

  test('should prefer the mongo value over the cached one for a price field mongo does store', async () => {
    SpotPair.find.mockReturnValue({
      lean: async () => [{ ...realPair(), markPrice: 100, last_bid: 99 }]
    });
    cache[REAL_ID.toString()] = JSON.stringify({
      _id: REAL_ID.toString(),
      markPrice: 89999.99,
      last_bid: 88045.84
    });

    await loadPairsToRedis();

    const stored = JSON.parse(cache[REAL_ID.toString()]);
    expect(stored.markPrice).toBe(100);
    expect(stored.last_bid).toBe(99);
  });

  test('should attach currency images when the wallet service answers', async () => {
    currencyId.mockImplementation(async ({ id }) => ({
      status: true,
      image: id === BASE_ID.toString() ? 'btc.png' : 'usd.png'
    }));

    await loadPairsToRedis();

    const stored = JSON.parse(cache[REAL_ID.toString()]);
    expect(stored.firstCurrencyImage).toBe('http://localhost:3002/currency/btc.png');
    expect(stored.secondCurrencyImage).toBe('http://localhost:3002/currency/usd.png');
  });

  test('should tolerate an unparsable cached entry instead of throwing', async () => {
    cache[REAL_ID.toString()] = 'not json';

    const result = await loadPairsToRedis();

    expect(result.success).toBe(true);
    expect(JSON.parse(cache[REAL_ID.toString()]).tikerRoot).toBe('BTCUSD');
  });

  test('should report failure without throwing when mongo is unreachable', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    SpotPair.find.mockReturnValue({
      lean: async () => {
        throw new Error('mongo down');
      }
    });

    const result = await loadPairsToRedis();

    expect(result).toEqual({ success: false, loaded: 0, pruned: 0 });
    expect(hdel).not.toHaveBeenCalled();
  });
});
