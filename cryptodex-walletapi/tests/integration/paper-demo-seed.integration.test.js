/**
 * Paper Trading — Demo USD Seed Tests (emptyAsset)
 *
 * The paper-trading conversion seeds every newly registered user with exactly
 * 1,000 virtual units of each demo currency — USD (the spec currency) and
 * USD (the quote currency of the live spot pairs, which is the id the spot
 * engine reads the buy-side balance under). These tests exercise the REAL
 * emptyAsset -> coin.controller -> gateway-stub path against an in-memory
 * MongoDB and verify the double-ledger convention:
 *
 *  - wallet.assets[] subdocument: spotBal 10000 (regular units) + currencyId
 *  - flat `assets` collection: spotBal "10000000000" (1e6 smallest-unit string)
 *  - Redis walletbalance_spot written under BOTH key styles
 *    (userId_currencyId AND userId_assetDocId); the cryptodex_ prefix is added
 *    inside the mocked redis.controller hset wrapper
 *  - every other currency gets a zero-balance asset row carrying currencyId
 *  - a seed failure must NOT break wallet creation (inner catch)
 *
 * Redis and the cross-service wallet sync are mocked per existing conventions;
 * Mongo is real (mongodb-memory-server, as in wallet-api.integration.test.js).
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

// Cross-service wallet sync (gRPC fan-out) — out of scope here.
jest.mock('../../controllers/wallet.js', () => ({
  updateUserWallet: jest.fn(),
}));

import { hset, hget, hincbyfloat } from '../../controllers/redis.controller.js';
import { updateUserWallet } from '../../controllers/wallet.js';
import { Currency, Wallet } from '../../models/index.js';
import { emptyAsset } from '../../controllers/createAsset.js';
import { IncCntObjId } from '../../lib/generalFun.js';

const DEMO_USD = 1000;

let mongoServer;

async function createCurrencies({ usdDepositType } = {}) {
  const [btc, usd] = await Currency.create([
    {
      coin: 'BTC',
      symbol: 'BTC',
      name: 'Bitcoin',
      gateway_code: 'BTC',
      type: 'crypto',
      depositType: 'local',
      status: 'active',
    },
    {
      coin: 'USD',
      symbol: 'USD',
      name: 'US Dollar',
      gateway_code: 'USD',
      type: 'fiat',
      ...(usdDepositType ? { depositType: usdDepositType } : {}),
      status: 'active',
    },
  ]);
  return { btc, usd };
}

const flatAssets = () => mongoose.connection.db.collection('assets');

const spotBalanceHsetCalls = () =>
  hset.mock.calls.filter((call) => call[0] === 'walletbalance_spot');

describe('Paper Trading demo seed — emptyAsset (CRITICAL)', () => {
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
    await flatAssets().deleteMany({});
  });

  test('seeds exactly 1,000 virtual USD under the currencyId key style', async () => {
    const {usd} = await createCurrencies();
    const userId = new mongoose.Types.ObjectId();

    await emptyAsset({ userId });

    // --- wallet.assets[] subdocument ledger (regular units) ---
    const walletDoc = await Wallet.findOne({ _id: userId });
    expect(walletDoc).toBeTruthy();
    expect(walletDoc.userCode).toBe(String(IncCntObjId(userId)));

    // USD is the quote currency of the venue's only market, and the spot engine
    // reads the buy-side balance under the pair's secondCurrencyId - so it is
    // the one coin a wallet must hold to be able to place an order at all.
    const usdAsset = walletDoc.assets.find((a) => a.coin === 'USD');
    expect(usdAsset).toBeTruthy();
    expect(usdAsset.spotBal).toBe(DEMO_USD);
    expect(usdAsset.currencyId.toString()).toBe(usd._id.toString());

    // --- the flat `assets` ledger is gone with USD, the only coin it held ---
    expect(await flatAssets().findOne({})).toBeNull();

    // --- Redis cache, ONE key style: userId_currencyId ---
    const calls = spotBalanceHsetCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(`${userId.toString()}_${usd._id.toString()}`);
    expect(calls[0][2]).toBe(DEMO_USD);

    // --- other services are told the wallet changed ---
    expect(updateUserWallet).toHaveBeenCalledWith({ id: userId });
  });

  /**
   * THE SEED HAS ONE LEG, AND THAT IS THE POINT.
   *
   * `POST /api/spot/faucet/reset` RESTORES an account to the signup seed, and
   * that sentence is only true while the two ends agree. When they disagreed,
   * a reset on a brand-new account minted the difference out of nothing,
   * repeatably. The test below is the guard: registration must seed the faucet
   * coins and NOTHING ELSE, which is what stops a second leg being introduced
   * on one side only.
   */
  describe('no wallet other than spot is seeded', () => {
    test('registration credits the faucet coins and nothing else', async () => {
      await createCurrencies();
      const userId = new mongoose.Types.ObjectId();

      await emptyAsset({ userId });

      // The spot pot is the ONLY ledger registration may write, by any
      // primitive. A second ledger appearing here is a second seed leg.
      for (const call of [...hincbyfloat.mock.calls, ...hset.mock.calls]) {
        expect(String(call[0])).toBe('walletbalance_spot');
      }

      // ...and in mongo, only the seed coin carries a balance.
      const walletDoc = await Wallet.findOne({ _id: userId });
      for (const asset of walletDoc.assets) {
        expect(asset.spotBal).toBe(asset.coin === 'USD' ? DEMO_USD : 0);
      }
    });
  });

  /*
   * A test pinning 'only USD gets a flat `assets` document' stood here. The
   * flat ledger existed for USD alone and is deleted with it, so there is no
   * second ledger for a coin to be in or out of.
   */

  test('every non-seeded asset keeps its zero balance init', async () => {
    await createCurrencies();
    const userId = new mongoose.Types.ObjectId();

    await emptyAsset({ userId });

    const walletDoc = await Wallet.findOne({ _id: userId });
    const notSeeded = walletDoc.assets.filter(
      (a) => a.coin !== 'USD'
    );
    expect(notSeeded.length).toBeGreaterThan(0);
    for (const asset of notSeeded) {
      expect(asset.spotBal).toBe(0);
      expect(asset.spotLockedBal).toBe(0);
    }

    // The BTC address comes from the stub gateway — a paper address, never a
    // real chain address.
    const btcAsset = walletDoc.assets.find((a) => a.coin === 'BTC');
    expect(btcAsset).toBeTruthy();
    expect(btcAsset.address).toMatch(/^paper-btc-/);

    // Only the demo currency gets a Redis spot-balance seed, and only under
    // the currencyId key style - the flat-row style went with the flat ledger.
    const seededKeys = spotBalanceHsetCalls().map((c) => c[1]);
    expect(seededKeys).toHaveLength(1);
  });

  test('every currency gets an asset row resolvable by currencyId', async () => {
    // Regression: generateCryptoAddr used to require currency.depositType
    // "local", so coins without that field (SOL/ETH here, as in the live
    // catalogue) got no asset row at all — they could never be held, shown or
    // credited, and gRPC getUserAsset (which matches on currencyId) missed.
    const {btc, usd} = await createCurrencies();
    const [sol, eth] = await Currency.create([
      {
        coin: 'SOL',
        symbol: 'SOL',
        name: 'Solana',
        gateway_code: 'SOL',
        type: 'crypto',
        status: 'active',
      },
      {
        coin: 'ETH',
        symbol: 'ETH',
        name: 'Ethereum',
        gateway_code: 'ETH',
        type: 'crypto',
        status: 'active',
      },
    ]);
    const userId = new mongoose.Types.ObjectId();

    await emptyAsset({ userId });

    const walletDoc = await Wallet.findOne({ _id: userId });
    for (const currency of [btc, usd, usd, sol, eth]) {
      const asset = walletDoc.assets.find((a) => a.coin === currency.coin);
      expect(asset).toBeTruthy();
      expect(asset.currencyId).toBeTruthy();
      expect(asset.currencyId.toString()).toBe(currency._id.toString());
    }

    // No gateway exists for SOL — it still gets a row, just no address.
    const solAsset = walletDoc.assets.find((a) => a.coin === 'SOL');
    expect(solAsset.spotBal).toBe(0);
    expect(solAsset.address).toBe('');
  });

  test('the seed coin is credited on the subdocument the fiat generator made', async () => {
    // This test used to force emptyAsset's FALLBACK branch - the one that
    // pushes a fresh subdocument when no address generator produced one. It
    // could do that because the seed coin was USDC: a `token` with depositType
    // "fireblocks", which generateTokenAddr skips. The venue's only seed coin
    // is now USD, and generateFiatAddr (coin.controller.js:288-307) emits a
    // subdocument for every fiat currency unconditionally, so a seed coin can
    // no longer miss one. The fallback still exists for a token currency that
    // is skipped; nothing this venue seeds can reach it.
    //
    // What is still worth pinning is the join: the credit must land on the
    // subdocument the generator made, keyed by the currency's own id, rather
    // than on a second subdocument for the same coin.
    const { usd } = await createCurrencies({ usdDepositType: 'fireblocks' });
    const userId = new mongoose.Types.ObjectId();

    await emptyAsset({ userId });

    const walletDoc = await Wallet.findOne({ _id: userId });
    const usdAssets = walletDoc.assets.filter((a) => a.coin === 'USD');
    expect(usdAssets).toHaveLength(1);

    const usdAsset = usdAssets[0];
    expect(usdAsset._id.toString()).toBe(usd._id.toString());
    expect(usdAsset.currencyId.toString()).toBe(usd._id.toString());
    expect(usdAsset.spotBal).toBe(DEMO_USD);
    // generateFiatAddr uses the currency's own id as the "address": a paper
    // venue has no chain address to put there.
    expect(usdAsset.address.toString()).toBe(usd._id.toString());
    expect(usdAsset.privateKey).toBe('');

    expect(await flatAssets().findOne({})).toBeNull();
    expect(spotBalanceHsetCalls()).toHaveLength(1);
  });

  test('a Redis seed failure does not break wallet creation (inner catch)', async () => {
    await createCurrencies();
    hset.mockRejectedValue(new Error('redis down'));
    const userId = new mongoose.Types.ObjectId();

    const result = await emptyAsset({ userId });

    // emptyAsset only returns false from its outer catch — the seed failure
    // must be swallowed by the inner catch instead.
    expect(result).not.toBe(false);

    const walletDoc = await Wallet.findOne({ _id: userId });
    expect(walletDoc).toBeTruthy();
    const usdAsset = walletDoc.assets.find((a) => a.coin === 'USD');
    // The wallet-side seed happened before the Redis write failed.
    expect(usdAsset.spotBal).toBe(DEMO_USD);

    // The post-seed wallet sync still runs.
    expect(updateUserWallet).toHaveBeenCalledWith({ id: userId });
  });

  test('skips the demo seed cleanly when no USD currency exists', async () => {
    await Currency.create([
      {
        coin: 'BTC',
        symbol: 'BTC',
        name: 'Bitcoin',
        gateway_code: 'BTC',
        type: 'crypto',
        depositType: 'local',
        status: 'active',
      },
    ]);
    const userId = new mongoose.Types.ObjectId();

    const result = await emptyAsset({ userId });

    expect(result).not.toBe(false);
    const walletDoc = await Wallet.findOne({ _id: userId });
    expect(walletDoc).toBeTruthy();
    expect(walletDoc.assets.find((a) => a.coin === 'USD')).toBeUndefined();
    expect(spotBalanceHsetCalls()).toHaveLength(0);
    expect(updateUserWallet).toHaveBeenCalledWith({ id: userId });
  });
});
