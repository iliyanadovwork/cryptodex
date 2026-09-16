/**
 * Paper Trading — Redis -> Mongo balance write-back cron (redisWalletBackUp)
 *
 * Redis is the authoritative ledger while the engines run; this cron (every 10s,
 * started unconditionally in config/cron.js) copies each `walletbalance_*` hash
 * back into wallet.assets so a Redis flush cannot lose a paper balance.
 *
 * Covered here:
 *  - the balance actually lands on the right wallet.assets field per ledger
 *  - redisPassBook records the divergence that was repaired, i.e. the Mongo
 *    balance as it was BEFORE the write (regression: the field was read after
 *    being overwritten, so every row claimed dbBalance === redisBalance)
 *  - Redis fields that address the flat `assets` collection document id (USDC)
 *    resolve to no subdocument and are skipped, not crashed on
 *  - one unusable field cannot abort the rest of the batch
 *  - the isRun re-entrancy guard really serialises ticks (regression: the loop
 *    used `forEach(async ...)`, so the run resolved before any write happened
 *    and the guard was released while writes were still in flight)
 *
 * Redis is mocked; Mongo is real (mongodb-memory-server), as in the other
 * integration suites.
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

jest.mock('../../controllers/redis.controller.js', () => ({
  hgetall: jest.fn(),
  hdel: jest.fn(),
  hset: jest.fn(),
  createPassBook: jest.fn(),
}));

import {
  hgetall,
  hset,
  createPassBook,
} from '../../controllers/redis.controller.js';
import { Wallet } from '../../models/index.js';
import { redisBackUpWalletByCron } from '../../controllers/redisWalletBackUp.js';

let mongoServer;

const USDC_ID = new mongoose.Types.ObjectId();
const USD_ID = new mongoose.Types.ObjectId();

const emptyLedgers = () => {
  // Default every hash to empty so a test only has to describe the one it cares
  // about; the cron reads nine of them per tick.
  hgetall.mockResolvedValue({});
};

async function seedWallet(userId) {
  return Wallet.create({
    _id: userId,
    userCode: '1234567',
    assets: [
      {
        _id: USDC_ID,
        currencyId: USDC_ID,
        coin: 'USDC',
        spotBal: 10000,
        spotLockedBal: 0,
      },
      {
        _id: USD_ID,
        currencyId: USD_ID,
        coin: 'USD',
        spotBal: 10000,
      },
    ],
  });
}

const reloadAsset = async (userId, coin) => {
  const doc = await Wallet.findById(userId);
  return doc.assets.find((a) => a.coin === coin);
};

describe('Paper Trading Redis -> Mongo balance write-back (CRITICAL)', () => {
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
    emptyLedgers();
  });

  test('copies the Redis spot balance into wallet.assets', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedWallet(userId);

    hgetall.mockImplementation(async (key) =>
      key === 'walletbalance_spot'
        ? { [`${userId.toString()}_${USD_ID.toString()}`]: '9875.5' }
        : {}
    );

    await redisBackUpWalletByCron();

    expect((await reloadAsset(userId, 'USD')).spotBal).toBe(9875.5);
    // untouched ledgers stay untouched
    expect((await reloadAsset(userId, 'USDC')).spotBal).toBe(10000);
  });

  test('records the pre-write Mongo balance as the passbook dbBalance', async () => {
    // REGRESSION: the field was assigned `value` and only then read back as the
    // "db balance", so every redisPassBook row said dbBalance === redisBalance
    // and the divergence log recorded nothing.
    const userId = new mongoose.Types.ObjectId();
    await seedWallet(userId);

    hgetall.mockImplementation(async (key) =>
      key === 'walletbalance_spot'
        ? { [`${userId.toString()}_${USDC_ID.toString()}`]: '7.77' }
        : {}
    );

    await redisBackUpWalletByCron();

    expect(createPassBook).toHaveBeenCalledTimes(1);
    const [passUserId, assetId, coin, dbBalance, redisBalance] =
      createPassBook.mock.calls[0];
    expect(passUserId).toBe(userId.toString());
    expect(assetId.toString()).toBe(USDC_ID.toString());
    expect(coin).toBe('USDC');
    expect(dbBalance).toBe(10000); // the balance Mongo held BEFORE the write
    expect(redisBalance).toBe('7.77');
    expect(dbBalance).not.toBe(redisBalance);
  });

  test('writes nothing when Redis already matches Mongo', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedWallet(userId);

    hgetall.mockImplementation(async (key) =>
      key === 'walletbalance_spot'
        ? { [`${userId.toString()}_${USDC_ID.toString()}`]: '10000' }
        : {}
    );

    await redisBackUpWalletByCron();

    expect(createPassBook).not.toHaveBeenCalled();
    expect((await reloadAsset(userId, 'USDC')).spotBal).toBe(10000);
  });

  test('maps each ledger onto its own wallet.assets field', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedWallet(userId);

    const field = `${userId.toString()}_${USDC_ID.toString()}`;
    hgetall.mockImplementation(async (key) => {
      if (key === 'walletbalance_spot_locked') return { [field]: '12' };
      if (key === 'walletbalance_spot_inOrder') return { [field]: '34' };
      return {};
    });

    await redisBackUpWalletByCron();

    const asset = await reloadAsset(userId, 'USDC');
    expect(asset.spotLockedBal).toBe(12);
    expect(asset.spotInOrder).toBe(34);
    expect(asset.spotBal).toBe(10000);
  });

  test('skips Redis fields that address no wallet.assets subdocument', async () => {
    // A second redis field addressed by a flat `assets` document id once existed
    // and the faucet mirrors the balance under that id too. It resolves to no
    // wallet.assets subdocument here and must simply be ignored.
    const userId = new mongoose.Types.ObjectId();
    await seedWallet(userId);
    const flatAssetDocId = new mongoose.Types.ObjectId();

    hgetall.mockImplementation(async (key) =>
      key === 'walletbalance_spot'
        ? { [`${userId.toString()}_${flatAssetDocId.toString()}`]: '999' }
        : {}
    );

    await expect(redisBackUpWalletByCron()).resolves.toBeUndefined();
    expect(createPassBook).not.toHaveBeenCalled();
    expect((await reloadAsset(userId, 'USDC')).spotBal).toBe(10000);
  });

  test('one unusable field does not abort the rest of the batch', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedWallet(userId);

    hgetall.mockImplementation(async (key) =>
      key === 'walletbalance_spot'
        ? {
            'not-an-object-id_also-not-one': '1',
            [`${userId.toString()}_${USD_ID.toString()}`]: '4242',
          }
        : {}
    );

    await redisBackUpWalletByCron();

    expect((await reloadAsset(userId, 'USD')).spotBal).toBe(4242);
  });

  test('the isRun guard serialises overlapping ticks', async () => {
    // REGRESSION: balanceUpdate used forEach(async ...) and never awaited the
    // callbacks, so a run resolved (and released isRun) before a single write
    // had happened — the guard could never actually skip an overlapping tick.
    const userId = new mongoose.Types.ObjectId();
    await seedWallet(userId);

    let releaseFirstRead;
    const firstReadStarted = new Promise((resolve) => {
      releaseFirstRead = resolve;
    });
    let openGate;
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });

    let hgetallCalls = 0;
    hgetall.mockImplementation(async (key) => {
      hgetallCalls += 1;
      if (hgetallCalls === 1) {
        releaseFirstRead();
        await gate;
      }
      return key === 'walletbalance_spot'
        ? { [`${userId.toString()}_${USD_ID.toString()}`]: '555' }
        : {};
    });

    const firstRun = redisBackUpWalletByCron();
    await firstReadStarted;

    // Second tick fires while the first is still mid-flight: it must bail out
    // immediately without reading a single hash.
    const callsBeforeSecondTick = hgetall.mock.calls.length;
    await redisBackUpWalletByCron();
    expect(hgetall.mock.calls.length).toBe(callsBeforeSecondTick);

    openGate();
    await firstRun;

    expect((await reloadAsset(userId, 'USD')).spotBal).toBe(555);

    // Once the first run has finished the guard is released again.
    const callsBeforeThirdTick = hgetall.mock.calls.length;
    await redisBackUpWalletByCron();
    expect(hgetall.mock.calls.length).toBeGreaterThan(callsBeforeThirdTick);
  });

  /**
   * EVERY LEDGER HASH IS BACKED UP
   *
   * A `walletbalance_*` hash with no mapping is not "unsupported": the wallet
   * field it feeds reports its schema default forever. `spot_inOrder` had no
   * mapping, so wallet.assets[].spotInOrder read 0 for every user no matter how
   * much of their balance was reserved by open orders.
   *
   * `walletbalance_p2p` has since gone the other way: it WAS mapped, which made
   * this cron the last live writer of the p2p balance, and the mapping was
   * removed with the p2p remnants rather than added to.
   */
  describe('every walletbalance_* hash reaches its wallet.assets field', () => {
    test('spot_inOrder lands on spotInOrder instead of staying at the schema default', async () => {
      const userId = new mongoose.Types.ObjectId();
      await seedWallet(userId);

      // Nothing has ever written it, so it starts at the schema default.
      expect((await reloadAsset(userId, 'USDC')).spotInOrder).toBe(0);

      hgetall.mockImplementation(async (key) =>
        key === 'walletbalance_spot_inOrder'
          ? { [`${userId.toString()}_${USDC_ID.toString()}`]: '250.5' }
          : {}
      );

      await redisBackUpWalletByCron();

      expect((await reloadAsset(userId, 'USDC')).spotInOrder).toBe(250.5);
    });

    // `p2p lands on p2pBal` was here. The mapping has been REMOVED with the p2p
    // remnants: this cron was the last live writer of `assets.p2pBal`, copying
    // `walletbalance_p2p` into it on every pass, and with the seed in
    // wallet.controller.js#updatewalletfromdb gone there is nothing left that
    // can put a number into that hash. The assertion is now the inverse - a
    // value sitting in the hash must NOT be propagated into mongo.
    test('p2p is no longer copied into p2pBal', async () => {
      const userId = new mongoose.Types.ObjectId();
      await seedWallet(userId);

      const before = (await reloadAsset(userId, 'USD')).p2pBal;

      hgetall.mockImplementation(async (key) =>
        key === 'walletbalance_p2p'
          ? { [`${userId.toString()}_${USD_ID.toString()}`]: '31.25' }
          : {}
      );

      await redisBackUpWalletByCron();

      expect((await reloadAsset(userId, 'USD')).p2pBal).toBe(before);
      expect(hgetall.mock.calls.map(([key]) => key)).not.toContain('walletbalance_p2p');
    });

    test('every hash that exists in Redis is actually read', async () => {
      const userId = new mongoose.Types.ObjectId();
      await seedWallet(userId);

      await redisBackUpWalletByCron();

      const read = hgetall.mock.calls.map(([key]) => key);
      for (const hash of [
        'walletbalance_spot',
        'walletbalance_spot_locked',
        'walletbalance_spot_inOrder',
      ]) {
        expect(read).toContain(hash);
      }

      // AND THE REMOVED p2p LEDGER IS NOT READ: nothing writes that hash, so
      // copying it into mongo would keep writing a field nothing owns.
      expect(read).not.toContain('walletbalance_p2p');
    });
  });

  /*
   * A 'flat `assets` collection reconciliation' block stood here. The flat row
   * and its second redis field held USDC alone; both went with that currency,
   * so there is nothing left to fall behind and nothing to reconcile.
   */

});
