// import models
import { Wallet } from "../models/index.js";
//import redis
import {
  hgetall,
  hdel,
  hset,
  createPassBook,
} from "../controllers/redis.controller.js";
//import lib

/**
 * HOW STALE `wallet.assets` IS, AND WHY THAT IS SAFE - CHECKED, NOT ASSUMED.
 * =========================================================================
 *
 * This cron runs every TEN SECONDS (config/cron.js), so a `wallet` document
 * trails redis by up to ten seconds, which on an active account is its entire
 * recent trading. That is BY DESIGN and it is safe, but "safe" here rests on
 * two specific facts rather than on the intention, and both were verified:
 *
 *   1. NOTHING COPIES MONGO BACK OVER A LIVE REDIS BALANCE. The only
 *      mongo -> redis path is `controllers/wallet.js#updateUserWallet`, and
 *      every write it makes is HSETNX: it fills a field that is ABSENT and
 *      leaves an existing one alone, decided inside redis. A stale document can
 *      therefore seed a row that does not exist yet and can never overwrite one
 *      that does.
 *   2. NO AFFORDABILITY DECISION IS TAKEN FROM MONGO. Every path in
 *      wallet.controller.js that moves money reads `hget("walletbalance_spot",
 *      ...)` for the decision - the three withdrawal handlers all do - and
 *      `getWallet` overwrites `assetDoc.spotBal` with the redis value before it
 *      answers. The subdocument is a mirror for reporting and for cold-start
 *      hydration, not a ledger.
 *
 * WHAT THE STALENESS DID COST, and it was not nothing: the fiat_withdraw
 * handler built its passbook `afterBalance` out of the stale subdocument while
 * taking `beforeBalance` from redis, so the audit row's own before/after did
 * not differ by its own amount. Fixed there, not here; see the note at that
 * call site.
 *
 * CONSEQUENCE FOR ANYONE CROSS-CHECKING A BALANCE: read redis. A `wallet`
 * document that disagrees with `walletbalance_*` by less than ten seconds of
 * activity is not evidence of a defect, and a verifier that treats it as one is
 * measuring this cron's period.
 *
 * Redis is the authoritative ledger; this cron is the write-back that keeps
 * wallet.assets in step. Each Redis hash maps onto one balance field of the
 * asset subdocument.
 *
 * EVERY `walletbalance_*` hash that exists must appear here AND be read in
 * redisBackUpWalletByCron below. A hash with no entry is not "unsupported", it
 * is a wallet field that silently reports its schema default forever:
 * `spot_inOrder` had no mapping, so wallet.assets[].spotInOrder read 0 for every
 * user no matter how much of their balance was reserved by open orders.
 *
 * THE P2P MAPPING IS GONE, with the p2p remnants.
 * This entry was not inert the way the others had become - the tick loops every
 * key in BALANCE_FIELD, so it actively copied `walletbalance_p2p` into
 * `assets.p2pBal` on every pass, which made this cron the last live WRITER of
 * the p2p balance in the stack. With the seeding removed from
 * wallet.controller.js#updatewalletfromdb there is nothing left to put a number
 * into that hash, so the copy could only ever propagate a frozen value. Both
 * sides keep whatever they last held.
 */
const BALANCE_FIELD = {
  SPOT: "spotBal",
  SPOT_LOCKED: "spotLockedBal",
  SPOT_IN_ORDER: "spotInOrder",
};

/**
 * The `walletbalance_*` hash each mapping is fed from. Kept next to
 * BALANCE_FIELD so "a hash exists but nothing backs it up" is one missing line
 * in one object rather than a missing statement buried in the tick body.
 */
const LEDGER_HASH = {
  SPOT: "walletbalance_spot",
  SPOT_LOCKED: "walletbalance_spot_locked",
  SPOT_IN_ORDER: "walletbalance_spot_inOrder",
};

// Mirrors FLAT_LEDGER_COINS / FLAT_LEDGER_DECIMALS in spotapi
// controllers/paperLedger.js: only USDC has a document in the flat `assets`
// collection, and it is stored in smallest units as a string.
const FLAT_LEDGER_COINS = ["USDC"];
const FLAT_LEDGER_DECIMALS = 1e6;

const balanceUpdate = async (allvalues, type = "SPOT") => {
  const field = BALANCE_FIELD[type];
  if (!field) return true;

  // Sequential on purpose: the previous `forEach(async ...)` never awaited its
  // callbacks, so balanceUpdate resolved before a single write had happened and
  // the isRun re-entrancy guard in redisBackUpWalletByCron guarded nothing.
  for (const [redisField, value] of Object.entries(allvalues)) {
    // One bad field (unparseable id, save conflict) must not abort the batch —
    // that resilience used to come for free from the un-awaited callbacks.
    try {
      const [userId, assetId] = redisField.split("_");
      const walletDoc = await Wallet.findById(userId);
      if (!walletDoc) continue;

      // Redis also carries fields keyed by the flat `assets` collection document
      // id (USDC); those resolve to no subdocument here and are skipped.
      const assetDetails = walletDoc.assets.id(assetId);
      if (!assetDetails) continue;

      if (assetDetails[field] == value) continue;

      // Capture the stored balance BEFORE overwriting it: redisPassBook exists
      // to record the Mongo-vs-Redis divergence this cron just repaired, and
      // reading the field after the assignment made every row dbBalance ===
      // redisBalance, i.e. "no divergence", for every write since the cron was
      // introduced.
      const dbBalance = assetDetails[field];
      assetDetails[field] = value;
      await walletDoc.save();
      await createPassBook(
        userId,
        assetDetails._id,
        assetDetails.coin,
        dbBalance,
        value
      );
    } catch (error) {
      console.log(
        "errrrrrrrrrrr_balanceUpdate_redis_TO_db_field",
        type,
        redisField,
        error
      );
    }
  }
  return true;
};

/*
 * `reconcileFlatLedger` stood here. It re-derived the flat `assets` row and its
 * second redis field from the engine field on every tick, because those two
 * drifted from it. Both went with USDC - the only coin the flat ledger ever
 * held - so there is nothing left to reconcile and no cron work to do for it.
 */

let isRun = false;
export const redisBackUpWalletByCron = async () => {
  if (isRun == true) return;
  isRun = true;
  try {
    // Every mapped ledger, in one loop: a hash that gains a BALANCE_FIELD entry
    // can no longer be forgotten here.
    for (const type of Object.keys(BALANCE_FIELD)) {
      const hash = LEDGER_HASH[type];
      if (!hash) continue;
      const values = await hgetall(hash);
      if (values) await balanceUpdate(values, type);
    }
  } catch (err) {
    console.log("err_redisBackUpWalletByCron", err);
  } finally {
    isRun = false;
  }
};
