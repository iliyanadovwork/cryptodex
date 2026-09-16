// import package
import fs from "fs";
import mongoose from "mongoose";
import multer from "multer";
import { verifyToken } from "node-2fa";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import * as ABIARRAY_ERC2020 from "./coin/ABI/ERC20.json" with { type: "json" };
import * as bnbGateway from "./coin/bnbGateway.js";

import * as btcGateway from "./coin/btcGateway.js";
import * as ethGateway from "./coin/ethGateway.js";
import * as ltcGateway from "./coin/ltcGateway.js";
import * as polyGateway from "./coin/polyGateway.js";
// import * as trxGateway from "./coin/TrxGateway.js";
import * as coinCtrl from "./coin.controller.js";
import {
  getClientAccountDetails,
  getInternalWallets
} from "./coin/firebase.js";
// import model
import {
  Currency,
  GasStation,
  PriceConversion,
  Transaction,
  Wallet,
} from "../models/index.js";

// import controller
// import { mailTemplateLang } from "./emailTemplate.controller";
// import { newNotification } from "./notification.controller";

import {
  hdecrbyfloatIfFree,
  hget,
  hincbyfloat,
  hset,
  hsetnx
} from "../controllers/redis.controller.js";
// THE ONLY TWO FUNCTIONS IN THIS SERVICE THAT MAY MOVE A WALLET BALANCE.
// `debitFree` refuses unless the source wallet's FREE balance covers the
// amount, tested and applied in ONE redis command; `credit` is unconditional.
// lib/walletLedger.js has the whole argument, including why a plain settlement
// helper would NOT have fixed the race.
import {
  WALLET_TYPES,
  credit,
  debitFree,
  readWallet,
} from "../lib/walletLedger.js";

/**
 * HYDRATE ONE ENGINE LEDGER FIELD FROM MONGO, WITHOUT EVER OVERWRITING IT.
 *
 * `getWallet` has to be able to answer for an account whose redis rows have
 * never been written (a fresh account, a flushed cache), so it seeds them from
 * the persisted wallet document. What it must NOT do is impose that document on
 * a field that already exists: redis is the authoritative ledger while the
 * engines are running and mongo is a backup of it that is up to ten seconds
 * stale (controllers/redisWalletBackUp.js).
 *
 * HSETNX is "write only if absent", decided inside redis, so there is no gap
 * between the check and the write for a reservation to land in. The value
 * returned is whatever is STORED after the attempt - so a call that lost the
 * race reports the winner's live number rather than its own stale one.
 *
 * `?? 0` because an asset document written before one of these fields existed
 * has it undefined, and seeding `undefined` writes the string "undefined" into
 * a balance hash.
 */
const seedLedgerField = async (key, field, fallback) => {
  const current = await hget(key, field);
  if (current !== null && current !== undefined && current !== "") {
    return current;
  }
  await hsetnx(key, field, fallback ?? 0);
  const after = await hget(key, field);
  return after === null || after === undefined ? fallback ?? 0 : after;
};
// A spot balance has one engine field and two mirrors of it, addressed by the
// flat `assets` document id. A write must move all three, and there are exactly
// two ways to do it - see lib/spotMirror.js and lib/walletLedger.js:
//   spotDelta                  moves the engine field AND both mirrors by the
//                              same signed amount.
//   ledgerCredit / ledgerDebit the same, plus the atomic affordability gate;
//                              this is what every path that can REFUSE uses.
// There used to be a third, `mirrorSpot`, which mirrored only - for a call site
// that had already written the engine field itself. Its one caller was
// `updateAsset`, and the thing it had "already written" was an ABSOLUTE HSET
// computed from a balance read four awaits earlier, which is the bug that call
// site was fixed for. There is no longer any site that writes the engine field
// by hand, so there is no longer a helper that lets one.
import { applySpotDelta } from "../lib/spotMirror.js";
// A wallet is a TOTAL plus a RESERVATION counter; only their difference is
// spendable. balanceBreakdown owns that arithmetic. Spot's counter is always
// zero on this venue - a resting order's funds are moved OUT of the balance
// into `walletbalance_spot_inOrder` rather than reserved in place - so `free`
// currently equals `total`. The split is reported anyway because it is what
// the shape promises, and because it costs nothing to be already right.
import { balanceBreakdown } from "../lib/walletBalance.js";
// How many decimal places a balance of a given coin is SHOWN to. Answered on
// the asset itself so no client has to join a currency list to print a number.
import {
  DEFAULT_CRYPTO_DECIMALS,
  resolveDisplayDecimals,
} from "../lib/currencyDecimals.js";
// A wallet belonging to a deactivated account keeps its balances and loses the
// right to move them. One definition, shared with the gRPC path - and it now
// reads BOTH this service's own `wallet.frozen` (the authority) and the shared
// stand-down mark in redis.
import { makeFrozenWalletGuard, readStandDownMark } from "../lib/walletStandDown.js";
// import config
import "csv-express";
import config from "../config/index.js";
import { momentFormat } from "../lib/dateTimeHelper.js";

// import lib
// import { comparePassword } from '../lib/bcrypt';
import {
  columnFillter,
  filterSearchQuery,
  paginationQuery
} from "../lib/adminHelpers.js";
import { precentConvetPrice } from "../lib/calculation.js";
import {
  decryptObject,
  decryptString,
  encryptString,
} from "../lib/cryptoJS.js";
import { IncCntObjId } from "../lib/generalFun.js";
import imageFilter from "../lib/imageFilter.js";
import isEmpty from "../lib/isEmpty.js";
// import grpc
import {
  bankDetail,
  fetchUser,
  sendMail
} from "../grpc/userService.js";
import { createPassBook } from "./passbook.controller.js";
import { priceConversionGrpc } from "./priceCNV.controller.js";
const ObjectId = mongoose.Types.ObjectId;


const __dirname = dirname(fileURLToPath(import.meta.url));
// PAPER TRADING: FireblocksSDK removed — all custody paths below are stubbed.
/**
 * Multer Image Uploade
 */
const walletStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, config.IMAGE.DEPOSIT_PATH);
  },

  // By default, multer removes file extensions so let's add them back
  filename: function (req, file, cb) {
    cb(null, "file-" + Date.now() + path.extname(file.originalname));
  },
});

let walletUpload = multer({
  storage: walletStorage,
  fileFilter: imageFilter,
  limits: { fileSize: config.IMAGE.DEFAULT_SIZE },
}).fields([{ name: "image", maxCount: 1 }]);

export const uploadWalletDoc = (req, res, next) => {
  walletUpload(req, res, function (err) {
    if (!isEmpty(req.validationError)) {
      return res.status(400).json({
        success: false,
        errors: {
          [req.validationError.fieldname]: req.validationError.messages,
        },
      });
    } else if (err instanceof multer.MulterError) {
      return res
        .status(400)
        .json({ success: false, errors: { [err.field]: "TOO_LARGE" } });
    } else if (err) {
      return res
        .status(500)
        .json({ success: false, message: "Something Wrong" });
    }
    return next();
  });
};

/**
 * THE GUARD THAT MAKES "STOOD DOWN" MEAN SOMETHING.
 *
 * lib/walletStandDown.js sets `frozen: true` on the wallet of a deactivated
 * account and deliberately leaves every balance where it is. That mark is only
 * worth anything if the routes that move value actually honour it, so this sits
 * on every one of them: internal transfer, coin withdraw (both variants), fiat
 * withdraw, fiat deposit and address creation.
 *
 * It is deliberately NOT on the read routes. A stood-down account's owner (or
 * the operator restoring it) must still be able to see what the wallet holds -
 * that is the whole point of freezing instead of zeroing.
 *
 * The behaviour, including the fail-closed 503, lives in lib/walletStandDown.js
 * so it can be unit-tested; this module cannot be imported into a test because
 * it loads every coin gateway at module scope. All that is bound here is where
 * the wallet is read from.
 *
 * It runs AFTER passportAuth in every chain, so `req.user` is always present.
 *
 * TWO SOURCES SINCE THE MARK-ONLY HOLE WAS FOUND
 * ----------------------------------------------
 * `findWallet` is the AUTHORITY - this service's own document, and the thing
 * `deactivateWallet` writes. `readMark` is the second source: the shared
 * stand-down redis hash that spot also reads. An account stood down through the
 * mark alone has a mark and no `frozen: true` document, so before this the
 * freeze was honoured by the trading service and ignored by the one that holds
 * the balances - `/transfer`, `/coinWithdraw`, `/fiatWithdraw` and
 * `/createAddress` all stayed open. Both are read here; either one saying
 * "frozen" refuses, and neither one being readable refuses too. Only `hget` is
 * bound, so this path cannot write the mark. The reasoning is in
 * lib/walletStandDown.js.
 */
export const blockFrozenWallet = makeFrozenWalletGuard({
  findWallet: (userId) => Wallet.findById(userId).select("frozen").lean(),
  readMark: (userId) => readStandDownMark({ hget }, userId),
});

/**
 * Decrypt Token
 * BODY : token
 */
export const decryptWallet = (req, res, next) => {
  try {
    let token = decryptObject(req.body.token);
    req.body = token;
    return next();
  } catch (err) {
    return res.status(500).json({ status: false, message: "Something Wrong" });
  }
};

export const getWallet = async (req, res) => {
  try {
    console.log('*** getWallet called for user:', req.user?.id);
    let userId = req.user.id;
    let newArr = [];
    console.log('*** Fetching wallet from database...');
    let walletData = await Wallet.findById(req.user.id, {
      _id: 1,
      binSubAcctId: 1,
      "assets._id": 1,
      "assets.coin": 1,
      "assets.currencyId": 1,
      "assets.address": 1,
      "assets.destTag": 1,
      "assets.spotBal": 1,
      "assets.tokenAddressArray": 1,
      "assets.spotLockedBal": 1
    });

    if (!walletData) {
      return res.status(400).json({ success: false });
    }

    let assetList = [],
      usrAsset = walletData.assets || [];

    // THE FLAT `assets` COLLECTION IS GONE, AND SO IS THE MERGE THAT READ IT.
    //
    // A second, flat ledger sat beside wallet.assets holding USDC only, in
    // smallest units (1e6), for a Solana deposit path this venue never had -
    // it has no custody and takes no deposits. This block merged any coin
    // found there into the response when wallet.assets did not already carry
    // it, rescaling USDC by 1e6 on the way.
    //
    // It was one incomplete cleanup away from reporting a billion dollars:
    // remove a user's USDC subdocument but leave the flat row, and the merge
    // woke up and pushed `spotBal: 1000000000` into the response, which the
    // frontend prices at $1/unit because a demo dollar is pegged to 1. The
    // rescale only ever handled USDC, so any other coin landing there would
    // have gone through raw regardless. USDC is deleted, the collection is
    // dropped, and the merge goes with them rather than waiting for a coin it
    // cannot convert.

    walletData.assets.map(function (el) {
      if (el.address == "") {
        assetList.push(el._id);
      }
    });

    // THE ASSET CARRIES ITS OWN DISPLAY PRECISION.
    //
    // Clients used to join this list against /currency/getCurrency by id to
    // find out how many decimals to print a balance to. That join is wrong
    // twice over: it matches an ASSET subdocument id against a CURRENCY id
    // (equal only for coins seeded by createAsset - an asset from the flat
    // `assets` collection has its own _id and silently finds nothing), and the
    // currency list was itself answering `undefined` precision. A balance that
    // cannot be printed also cannot be Max'd into the amount field, which is
    // how one missing number turned into a 400 on Confirm.
    //
    // Resolved here from the asset's OWN currencyId, with a coin-name fallback,
    // so a client needs no join at all. See lib/currencyDecimals.js.
    const currencyPrecision = new Map();
    try {
      const currencyDocs = await Currency.find(
        {},
        { coin: 1, type: 1, decimals: 1, contractDecimal: 1 }
      ).lean();
      for (const doc of currencyDocs || []) {
        const entry = {
          displayDecimals: resolveDisplayDecimals(doc),
          currencyType: doc.type,
        };
        currencyPrecision.set(doc._id.toString(), entry);
        if (doc.coin && !currencyPrecision.has(doc.coin)) {
          currencyPrecision.set(doc.coin, entry);
        }
      }
    } catch (err) {
      console.error('*** Could not load currency precision:', err?.message || err);
    }

    // DISABLED updateTokenAddress for local development - coin gateways timing out
    // if (assetList && assetList.length > 0) {
    //   let updateAsset = await updateTokenAddress(
    //     req.user.id,
    //     usrAsset
    //   );
    //   // DISABLED for local development - coin gateways are timing out
    //   // await updateAddress(assetList, req.user.id);
    //   if (updateAsset && updateAsset.length > 0) {
    //     usrAsset = updateAsset;
    //   }
    // }

    if (usrAsset) {
      for (let i = 0; i < usrAsset.length; i++) {
        const ledgerField = userId + "_" + usrAsset[i]._id;
        // EVERY SEEDING BRANCH GOES THROUGH seedLedgerField, WHICH IS HSETNX.
        // ------------------------------------------------------------------
        // These branches used to be `hget` -> `if (!value)` -> `hset`, and the
        // guard is not the write: a reservation landing between the read and
        // the write was overwritten by a mongo value from before it. The
        // reservation counter makes that concrete - `walletbalance_spot_locked`
        // seeded from a ten-second-old `spotLockedBal` while an order is being
        // placed erases the order's reservation. HSETNX makes redis decide
        // "is it absent", and decide it in the same command that writes.
        //
        // Each call still reports the value to SHOW: whatever is stored after
        // the attempt, which under a lost HSETNX race is the other writer's
        // live value rather than this request's stale one. (The previous code
        // assigned the seeded value directly; the shape here keeps that
        // property - the response never carries the `undefined` that
        // redis.controller.hset returns.)
        let spotBal = await seedLedgerField(
          "walletbalance_spot",
          ledgerField,
          usrAsset[i].spotBal
        );
        let spotLockedBal = await seedLedgerField(
          "walletbalance_spot_locked",
          ledgerField,
          usrAsset[i].spotLockedBal
        );
        let inOrder = await seedLedgerField(
          "walletbalance_spot_inOrder",
          ledgerField,
          0
        );
        // THE FREE/LOCKED SPLIT, for the one wallet that is left. `spotBal` is
        // the whole pot; `spotBalAvailable` is the derived `total - locked`,
        // the only balance a new order can actually draw on. On this venue the
        // two are equal - a resting spot order's funds are moved OUT of the
        // balance into `walletbalance_spot_inOrder` rather than reserved in
        // place, so `walletbalance_spot_locked` stays at zero - but the derived
        // figure is reported rather than assumed, so nothing breaks quietly the
        // day something does start writing that counter.
        //
        // The gross field keeps its existing name and meaning. With one wallet
        // the spot balance IS the portfolio total, so nothing has to be summed
        // across pots to produce it.
        const spotView = balanceBreakdown(spotBal, spotLockedBal);
        const precision =
          currencyPrecision.get(
            usrAsset[i].currencyId ? usrAsset[i].currencyId.toString() : ''
          ) ||
          currencyPrecision.get(usrAsset[i].coin) ||
          { displayDecimals: DEFAULT_CRYPTO_DECIMALS, currencyType: 'crypto' };
        let data = {
          spotBal,
          spotInOrder: inOrder,
          spotBalAvailable: spotView.free,
          spotLockedBal,
          // Always present, always 0-8. Print any of the balances above with
          // this and stop joining against the currency list.
          displayDecimals: precision.displayDecimals,
          currencyType: precision.currencyType
        };
        newArr.push({ ...JSON.parse(JSON.stringify(usrAsset[i])), ...data });
      }
    }
    return res
      .status(200)
      .json({ success: true, messages: "successfully", result: newArr });
  } catch (err) {
    console.log("----err", err);
    return res.status(500).json({ success: false });
  }
};

/**
 * Update Address for Existing User
 */
export const updateAddress = async (assetList, userId) => {
  try {
    let currencyList = await Currency.aggregate([
      { $match: { _id: { $in: assetList } } },
      {
        $facet: {
          crypto: [
            { $match: { type: "crypto" } },
            {
              $project: {
                type: 1,
                coin: 1,
                depositType: 1,
                status: 1,
              },
            },
          ],
          fiat: [
            { $match: { type: "fiat" } },
            {
              $project: {
                type: 1,
                coin: 1,
                depositType: 1,
                status: 1,
              },
            },
          ],
        },
      },
    ]);

    let walletData;
    if (currencyList && currencyList.length > 0) {
      if (currencyList[0].crypto && currencyList[0].crypto.length > 0) {
        for (let cryptoData of currencyList[0].crypto) {
          let cryptoDoc = await coinCtrl.generateCryptoAddr({
            currencyList: [cryptoData],
            userId,
          });

          if (cryptoDoc && cryptoDoc.length > 0) {
            walletData = await Wallet.findOneAndUpdate(
              {
                _id: userId,
                "assets._id": cryptoData._id,
              },
              {
                $set: {
                  "assets.$.address": cryptoDoc[0].address,
                  "assets.$.destTag": cryptoDoc[0].destTag,
                  "assets.$.privateKey": cryptoDoc[0].privateKey,
                  "assets.$.tokenAddressArray": cryptoDoc[0].networkList,
                },
              },
              {
                fields: {
                  _id: 0,
                  binSubAcctId: 1,
                  "assets._id": 1,
                  "assets.coin": 1,
                  "assets.address": 1,
                  "assets.destTag": 1,
                  "assets.spotBal": 1,
                              "assets.tokenAddressArray": 1,
                },
                new: true,
              }
            );
          }
        }
      }

      if (currencyList[0].fiat && currencyList[0].fiat.length > 0) {
        for (let fiatData of currencyList[0].fiat) {
          let fiatDoc = await coinCtrl.generateFiatAddr({
            currencyList: [fiatData],
          });

          walletData = await Wallet.findOneAndUpdate(
            {
              _id: userId,
              "assets._id": fiatData._id,
            },
            {
              $set: {
                "assets.$.address": fiatDoc[0]._id,
              },
            },
            {
              fields: {
                _id: 0,
                binSubAcctId: 1,
                "assets._id": 1,
                "assets.coin": 1,
                "assets.address": 1,
                "assets.destTag": 1,
                "assets.spotBal": 1,
              },
              new: true,
            }
          );
        }
      }
      if (walletData) {
        return walletData.assets;
      }
    }
    return [];
  } catch (err) {
    console.log("Err on updateAddress(): ", err);
    return [];
  }
};

/**
 * Update Address for Existing User
 */
export const updateTokenAddress = async (userId, usrAsset) => {
  try {
    let currencyList = await Currency.find(
      { type: "token" },
      {
        type: 1,
        coin: 1,
        depositType: 1,
        tokenType: 1,
        status: 1,
        _id: 1,
      }
    ).lean();

    let walletData;
    if (currencyList && currencyList.length > 0) {
      for (let tokenData of currencyList) {
        usrAsset.forEach(async (element) => {
          if (element.coin == tokenData.coin) {
            let isTokExt = element?.tokenAddressArray.findIndex(el => el?.tokenType == tokenData.tokenType);
            if (isTokExt == -1) {
              const tokenDetail =
                await coinCtrl.generateTokenAddcreateForOldUser(tokenData);
              if (!isEmpty(tokenDetail)) {
                walletData = await Wallet.findOneAndUpdate(
                  {
                    _id: ObjectId(userId),
                    "assets._id": ObjectId(element._id),
                  },

                  { $push: { "assets.$.tokenAddressArray": tokenDetail } },

                  {
                    fields: {
                      _id: 0,
                      binSubAcctId: 1,
                      "assets._id": 1,
                      "assets.coin": 1,
                      "assets.address": 1,
                      "assets.destTag": 1,
                      "assets.spotBal": 1,
                    },
                    new: true,
                  }
                );
              }
            }
          }
        });
      }
    }

    if (walletData) {
      return walletData.assets;
    }

    return [];
  } catch (err) {
    console.log("updateTokenAddress(): ", err);
    return [];
  }
};

/**
 * Get Asset By Curreny
 * METHOD: GET
 * URL : /api/getAsset/:currencyId
 */
export const getAssetByCurrency = async (req, res) => {
  try {
    let usrWallet = await Wallet.findOne({
      _id: req.user.id,
    });
    if (!usrWallet) {
      return res.status(400).json({ success: false, message: "NO_DATA" });
    }
    console.log(req.user.id, "------req.user.id");
    console.log(req.params, "------req.params.currencyId");
    let spotBal = await hget(
      "walletbalance_spot",
      req.user.id + "_" + req.params.currencyId
    );
    let assetDoc = {};
    if (!spotBal) {
      await updatewalletfromdb(req.user.id);
      assetDoc.spotBal = await hget(
        "walletbalance_spot",
        req.user.id + "_" + req.params.currencyId
      );
    } else {
      assetDoc.spotBal = spotBal;
    }
    // The spot pot is reported alongside its reservation counter and the
    // derived spendable figure, the same shape getWallet answers with.
    let spotLocked = await hget(
      "walletbalance_spot_locked",
      req.user.id + "_" + req.params.currencyId
    );
    const spotView = balanceBreakdown(spotBal, spotLocked);
    let result = {
      spotBal: spotBal,
      spotBalLocked: spotLocked || "0",
      spotBalAvailable: spotView.free,
      currencyId: req.params.currencyId,
    };
    return res
      .status(200)
      .json({ success: true, messages: "success", result: result });
  } catch (err) {
    console.log("err------- ", err);
    return res.status(500).json({ status: false, message: "Error occured" });
  }
};

/**
 * HYDRATE MISSING LEDGER ROWS FROM MONGO. SEEDING ONLY, DECIDED BY REDIS.
 *
 * These branches were `hget` -> `if (!value)` -> `hset`, which is a
 * check-then-act across two awaits, in a process that runs many requests at
 * once and alongside four other services that write the same hashes. The guard
 * is not the write, and the gap between them is not theoretical:
 *
 *   field absent; this reads null
 *   a faucet claim or a fill lands and CREATES the field at 100
 *   this HSETs `wallet.assets[i].spotBal` - 0, from a mongo document up
 *     to ten seconds stale (controllers/redisWalletBackUp.js)
 *   -> the credit is erased and 100 USDC destroyed
 *
 * `seedLedgerField` is HSETNX: redis decides "is this field absent" in the same
 * command that writes it, so a row that exists is left exactly alone whatever
 * raced it. Same helper, same semantics and same reasoning as getWallet's
 * seeding above and as controllers/wallet.js#updateUserWallet.
 *
 * `?? 0` for the same reason it is there: an asset document written before one
 * of these fields existed has it undefined, and seeding `undefined` writes the
 * string "undefined" into a balance hash.
 */
const updatewalletfromdb = async (userid) => {
  try {
    console.log("updatewalletfromdb -Success");
    let usrWallet = await Wallet.findById(userid);
    if (usrWallet && usrWallet.assets.length > 0) {
      for (let i = 0; i < usrWallet.assets.length; i++) {
        const field =
          userid.toString() + "_" + usrWallet.assets[i]._id.toString();
        await seedLedgerField(
          "walletbalance_spot",
          field,
          usrWallet.assets[i].spotBal
        );
        // The `walletbalance_p2p` seed was here. It was the other live writer
        // of the p2p ledger (with the redisWalletBackUp cron), hydrating it
        // from `assets.p2pBal` whenever a wallet row was missing from redis.
        // The p2p product is gone, nothing spends or credits that hash, and
        // seeding it only re-created a balance no endpoint can reach.
      }
      console.log(usrWallet, "updatewalletfromdb -Success");
      return true;
    }
  } catch (err) {
    console.log(err, "errrrrrrrrrrrrrrrrrrrr");
  }
};
/**
 * `checkUserKyc` and `checkUserKyc_IDPROOF` used to sit here, on the /fiatWithdraw
 * and /fiatDeposit chains.
 *
 * REMOVING THEM CHANGES NO BEHAVIOUR AT ALL, which is why it is safe: both had
 * had their entire body commented out long before this - every branch that
 * could refuse a request was `// ...` and the only live statement in each was
 * `next()`. They were pass-throughs wearing the name of a gate.
 *
 * KYC has now been removed from the venue outright (userapi no longer has a
 * /kyc route, a UserKyc controller or a KYC review screen), so leaving two
 * middlewares named after it in a request chain would suggest an identity check
 * happens on a withdrawal path when none does and none can.
 */
/**
 * WITHDRAWAL IS CLOSED ON THIS VENUE
 * ==================================
 *
 * `withdrawCoinRequest`, `withdrawCoinRequestApp` and `withdrawFiatRequest` are
 * the walletapi half of the same facility spotapi refuses in
 * `controllers/withdrawal.controller.js` - read that file's header for the
 * argument. In short: this venue holds no custody, so there is no counterparty
 * to receive a withdrawal; completing one can only delete the user's balance
 * and hand back a receipt for a transfer nobody made.
 *
 * WHAT THESE THREE ACTUALLY DID, MEASURED ON THIS STACK
 * ----------------------------------------------------
 * They are worse than the spot one, because they also NOTIFY. The coin path
 * writes a `coin_withdraw` Transaction with `txid: "paper-<ms>"` and the
 * caller's `receiverAddress`, marks it `completed`, and mails the user the
 * "Withdraw_notification" template - the same mail an on-chain payout sent. The
 * fiat path writes a `fiat_withdraw` row against the user's bank details and
 * mails a confirmation link. Neither corresponds to anything.
 *
 * AND THEY WERE ONLY DORMANT BY ACCIDENT. Measured with an own throwaway,
 * 2FA enabled, ordinary user token:
 *
 *   POST /api/wallet/coinWithdraw  {amount: 100, USDC}
 *     -> 400 {"errors":{"amount":"Maximum withdraw amount 0"}}
 *   POST /api/wallet/coinWithdraw  {amount: 0,   USDC}
 *     -> 200 {"success":true,"message":"Withdraw successful"}
 *        + a coin_withdraw Transaction, txid paper-1786182098501, toAddress set,
 *          status completed, and a withdrawal email.
 *
 * The 400 is NOT a guard. `maximumWithdraw` is a Number with `default: 0` in
 * models/currency.js and NOT ONE of the five currency documents on this venue
 * sets it, so mongoose hands every read a 0 and the `amount > maximumWithdraw`
 * check refuses everything above zero. `minimumWithdraw` is 0 for the same
 * reason, so the floor is absent too. The only thing standing between a user
 * and an uncapped debit here is an unset field on a document the admin currency
 * screen can edit. That is a data accident, not a decision, and a decision is
 * what this needs.
 *
 * (The fee arithmetic - `finalAmount = amount + precentConvetPrice(amount,
 * curData.withdrawFee)` - was reported as broken by these same defaults. It is
 * NOT: `withdrawFee` is also `Number, default: 0`, so `precentConvetPrice`
 * returns `amount * 0 = 0` and `finalAmount === amount`. Recorded here because
 * "the fee makes it wrong" is a claim a future reader will meet again; the
 * wrong number is the maximum, and it is wrong by being zero, not by being NaN.)
 *
 * WHAT IS KEPT. The exports, the routes, the validation middleware and the
 * admin approve/reject handlers all stay - `grpc/server.js -> createAsset.js ->
 * coin.controller.js` and this file's own module graph are why the conversion
 * spec's decision 3 says "stub in place, do not delete", and a missing export
 * here is a boot crash. The refusal is inside the handler, before `fetchUser`,
 * before the 2FA check and before anything is read or written, so no row, no
 * mail and no ledger write can be produced by any input.
 *
 * There are ZERO `coin_withdraw` and ZERO `fiat_withdraw` rows in
 * `cryptodex_wallet.transaction` other than the one this investigation created,
 * so nothing that has ever worked stops working. `coinRequestVerify` /
 * `fiatRequestVerify` / `coinWithdrawApprove` / `coinWithdrawReject` /
 * `fiatWithdrawApprove` / `fiatWithdrawReject` act only on rows in states these
 * three were the sole producers of; they are left alone rather than refused,
 * because they are the only way an operator could still resolve a legacy row,
 * and none of them can create one.
 */
export const WITHDRAWALS_CLOSED = {
  code: "WITHDRAWALS_CLOSED",
  message:
    "Withdrawals are closed. Cryptodex is a paper-trading venue: your balance is a " +
    "scoreboard, not custody, so there is nothing to send and nowhere to send it. " +
    "No funds have been moved and your balance is unchanged. To start over, reset " +
    "your demo account.",
  resetEndpoint: "POST /api/spot/faucet/reset",
  resetPath: "/withdraw",
};

/** The one refusal all three withdrawal entry points answer with. */
const refuseWithdrawal = (res) =>
  res.status(410).json({
    success: false,
    message: WITHDRAWALS_CLOSED.message,
    errors: { amount: WITHDRAWALS_CLOSED.message },
    ...WITHDRAWALS_CLOSED,
  });

/**
 * User Withdraw
 * URL: /api/fiatWithdraw
 * METHOD : POST
 * BODY: currencyId, amount, bankId, twoFACode
 */
export const withdrawFiatRequest = async (req, res) => {
  // REFUSED - see the WITHDRAWALS_CLOSED block above. Nothing is read,
  // nothing is written, no mail is sent, no ledger is touched.
  return refuseWithdrawal(res);
};

/**
 * User Withdraw
 * URL: /api/fiatWithdraw
 * METHOD : PATCH
 * BODY: token
 */
export const fiatRequestVerify = async (req, res) => {
  try {
    let reqBody = req.body;
    let transactionId = decryptString(reqBody.token, true);
    let trxData = await Transaction.findOne({
      _id: transactionId,
      paymentType: "fiat_withdraw",
    });
    if (!trxData) {
      return res.status(400).json({ success: false, message: "INVALID_TOKEN" });
    }

    if (trxData.status != "new") {
      return res.status(400).json({ success: false, message: "EXPIRY_URL" });
    }

    trxData.status = "pending";
    let updateTrxData = await trxData.save();

    // newNotification({
    //   userId: updateTrxData.userId,
    //   currencyId: updateTrxData.currencyId,
    //   transactionId: updateTrxData._id,
    //   trxId: updateTrxData._id,
    //   currencySymbol: updateTrxData.coin,
    //   amount: updateTrxData.amount,
    //   paymentType: updateTrxData.paymentType,
    //   status: updateTrxData.status,
    // });

    return res.status(200).json({
      success: true,
      message: "Successfully verified your withdraw request",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Something Wrong" });
  }
};

/**
 * Coin Withdraw
 * URL: /api/coinWithdraw
 * METHOD : POST
 * BODY: currencyId, coin, amount, receiverAddress, twoFACode
 */
export const withdrawCoinRequest = async (req, res) => {
  // REFUSED - see the WITHDRAWALS_CLOSED block above. Nothing is read,
  // nothing is written, no mail is sent, no ledger is touched.
  return refuseWithdrawal(res);
};
/**
 * Coin Withdraw
 * URL: /api/coinWithdraw
 * METHOD : POST
 * BODY: currencyId, coin, amount, receiverAddress, twoFACode
 */
export const withdrawCoinRequestApp = async (req, res) => {
  // REFUSED - see the WITHDRAWALS_CLOSED block above. Nothing is read,
  // nothing is written, no mail is sent, no ledger is touched.
  return refuseWithdrawal(res);
};

/**
 * User Withdraw
 * URL: /api/fiatWithdraw
 * METHOD : PATCH
 * BODY: token
 */
export const coinRequestVerify = async (req, res) => {
  try {
    let reqBody = req.body;
    console.log(reqBody, "reqBody");
    let transactionId = decryptString(reqBody.token, true);
    let trxData = await Transaction.findOne({
      _id: transactionId,
      paymentType: "coin_withdraw",
    });
    if (!trxData) {
      return res.status(400).json({ success: false, message: "INVALID_TOKEN" });
    }

    if (trxData.status != "new") {
      return res.status(400).json({ success: false, message: "EXPIRY_URL" });
    }

    trxData.status = "pending";
    let updateTrxData = await trxData.save();

    // newNotification({
    //     'userId': updateTrxData.userId,
    //     'currencyId': updateTrxData.currencyId,
    //     'transactionId': updateTrxData._id,
    //     'trxId': updateTrxData._id,
    //     'currencySymbol': updateTrxData.currencySymbol,
    //     'amount': updateTrxData.amount,
    //     'paymentType': updateTrxData.paymentType,
    //     'status': updateTrxData.status,
    // })

    return res
      .status(200)
      .json({ success: true, message: "Successfully verify withdraw request" });
  } catch (err) {
    console.log(err, "err");
    return res.status(500).json({ success: false, message: "Something Wrong" });
  }
};

/**
 * Sent Deposit Request To Admin
 * URL: /api/fiatDeposit
 * METHOD : POST
 * BODY : userAssetId, amount, image
 */
export const depositRequest = async (req, res) => {
  try {
    let reqBody = req.body;
    let reqFile = req.files;
    let checkUser = await fetchUser({ id: req.user.id });
    let usrWallet = await Wallet.findOne({ _id: req.user.id });
    // let notify = await UserSetting.findOne({ userId: checkUser._id });
    if (!usrWallet) {
      return res.status(400).json({ success: false, message: "NO_DATA" });
    }
    let currencyData = await Currency.findOne({ _id: reqBody.userAssetId });
    if (
      parseFloat(reqBody.amount) < parseFloat(currencyData.minimumDeposit)
      //   parseFloat(currencyData.maximumDeposit) < parseFloat(reqBody.amount)
    ) {
      console.log("helloe eneter error fiat limit ");
      return res.status(400).json({
        success: false,
        errors: {
          amount: `amount should be above ${currencyData.minimumDeposit}`,
        },
      });
    }
    let usrAsset = usrWallet.assets.id(reqBody.userAssetId);
    if (!usrAsset) {
      return res.status(400).json({ success: false, message: "NO_DATA" });
    }

    let newDoc = new Transaction({
      userId: req.user.id,
      currencyId: usrAsset._id,
      actualAmount: reqBody.amount,
      amount: reqBody.amount,
      coin: usrAsset.coin,
      status: "pending",
      paymentType: "fiat_deposit",
      image: reqFile.image[0].filename,
      userCode: IncCntObjId(req.user.id),
    });
    let updateTrxData = await newDoc.save();

    // if (notify.siteNotification == true) {
    //   mailTemplateLang({
    //     userId: checkUser._id,
    //     identifier: "Withdraw_notification",
    //     toEmail: checkUser.email,
    //     content,
    //   });
    // }

    // newNotification({
    //     'userId': updateTrxData.userId,
    //     'currencyId': updateTrxData.currencyId,
    //     'transactionId': updateTrxData._id,
    //     'trxId': updateTrxData._id,
    //     'currencySymbol': updateTrxData.currencySymbol,
    //     'amount': updateTrxData.amount,
    //     'paymentType': updateTrxData.paymentType,
    //     'status': updateTrxData.status,
    // })

    return res
      .status(200)
      .json({ success: true, message: "DEPOSIT_REQUEST_SUCCESS" });
  } catch (err) {
    console.log(err, "err");
    return res
      .status(500)
      .json({ success: false, message: "err Something Wrong" });
  }
};

/**
 * The Redis ledger pair behind each wallet a transfer can name now lives in
 * lib/walletLedger.js, together with the only two functions allowed to move
 * them. Re-exported here because it was exported from this module before.
 */
export { WALLET_TYPES };

/**
 * THE TWO CALLS THAT MAY MOVE A WALLET BALANCE IN THIS SERVICE.
 *
 * `ledgerDebit` is CONDITIONAL - it refuses unless the source wallet's FREE
 * balance covers the amount, tested and applied inside one redis command - and
 * `ledgerCredit` is unconditional. lib/walletLedger.js has the argument for why
 * that split, and not a shared settlement helper, is the thing that makes
 * `locked <= available` true. Both bind this module's redis functions and mongo
 * connection so nothing downstream has to know where they came from.
 */
const ledgerDeps = () => ({
  db: Wallet.db,
  hget,
  hset,
  hincbyfloat,
  hdecrbyfloatIfFree,
});

const ledgerDebit = (args) => debitFree(args, ledgerDeps());
const ledgerCredit = (args) => credit(args, ledgerDeps());

/**
 * The service's spot-balance write for anything that moves a balance BY an
 * amount - ten call sites, every transfer and credit path in this file. Binds
 * this module's redis functions and
 * mongo connection to lib/spotMirror.js#applySpotDelta, so every call site gets
 * the engine field AND both mirrors of it moved together, and nothing has to
 * remember to.
 */
const spotDelta = ({ userId, currencyId, coin, delta }) =>
  applySpotDelta(
    { userId, currencyId, coin, delta },
    { db: Wallet.db, hget, hset, hincbyfloat }
  );

/**
 * READ-ONLY view of one wallet: { total, locked, free }. Used to answer a
 * completed transfer with what the two wallets now hold.
 */
const walletBalanceView = async (userId, currencyId, walletType) => {
  const row = await readWallet(
    { userId, currencyId, walletType },
    ledgerDeps()
  );
  if (!row) return null;
  return balanceBreakdown(row.total, row.locked);
};

/**
 * WALLET-TO-WALLET TRANSFER IS CLOSED, because there is nowhere left to
 * transfer TO.
 * =========================================================================
 *
 * This venue has exactly ONE pot: spot. A transfer needs two, so there is no
 * surviving (from, to) pair for this handler to serve.
 *
 * The one pair that could be formed from what is left, spot -> spot, is not a
 * transfer either: moving a balance from a wallet to itself is a passbook row
 * for money that never went anywhere.
 *
 * WHY A 410 AND NOT A DELETED ROUTE
 * ---------------------------------
 * The same argument the withdrawal routes settled, and deliberately the same
 * shape - see WITHDRAWALS_CLOSED above and spotapi routes/spot.route.js on
 * `/requestWithdrawal`:
 *
 *   - a deleted route answers 404, which reads to a client like a BROKEN
 *     DEPLOY rather than a decision. 410 says "this existed and is gone", and
 *     carries a message a UI can show a user verbatim.
 *   - the route keeps `passportAuth`, `blockFrozenWallet` and
 *     `trackValueFlight`. They cost one redis read on a request that is going
 *     to be refused anyway, they keep the refusal from becoming an
 *     unauthenticated probe, and the day anyone re-opens this route they must
 *     not have to remember to put the guards back on a value-moving path.
 *   - the frontend is being narrowed to spot in parallel. A transfer UI whose
 *     two dropdowns each hold one identical option is worse than no transfer
 *     UI, so that UI is going away - and until it does, a 410 with this message
 *     is a self-describing answer rather than a mystery.
 *
 * NOTHING IS READ AND NOTHING IS WRITTEN. No ledger, no passbook row, no
 * Transaction document.
 */
export const WALLET_TRANSFER_CLOSED = {
  code: "WALLET_TRANSFER_CLOSED",
  message:
    "Wallet transfers are closed. Cryptodex is a spot-only paper-trading venue: " +
    "there is one wallet, so there is nowhere to move funds to. No funds have " +
    "been moved and your balance is unchanged.",
};

/**
 * Wallet Transfer
 * URL: /api/wallet/transfer
 * METHOD : POST
 * BODY : fromType, toType, userAssetId, amount
 *
 * REFUSED - 410 Gone. See WALLET_TRANSFER_CLOSED above.
 */
export const walletTransfer = async (req, res) => {
  return res.status(410).json({
    success: false,
    status: false,
    message: WALLET_TRANSFER_CLOSED.message,
    errors: { amount: WALLET_TRANSFER_CLOSED.message },
    ...WALLET_TRANSFER_CLOSED,
  });
};

/** The on-chain-shaped movements. */
export const CRYPTO_PAYMENT_TYPES = [
  "coin_deposit",
  "coin_withdraw",
  "coin_transfer",
];

/**
 * Get Transaction History
 * URL: /api/history/transaction/{{payment}}
 * METHOD : GET
 * Params : payment(fiat)
 */
export const getTrnxHistory = async (req, res) => {
  try {
    const { payment } = req.params;

    let pagination = paginationQuery(req.query);
    let filter = filterSearchQuery(req.query, [
      "status",
      "coin",
      "bankDetail.bankName",
      "currency",
      "tokenType",
      "txid",
      "toAddress",
    ]);
    // Was `if (!["fiat", "crypto".includes(payment)])`, which is always false:
    // `.includes` bound to the string "crypto" alone, building the array
    // ["fiat", <boolean>], and negating a non-empty array is never truthy. The
    // 400 could not fire for any input. The intended expression is below.
    // (Not a data-leak either way - the query forces filter.userId = req.user.id
    // a few lines down - but the validation genuinely did nothing.)
    if (!["fiat", "crypto"].includes(payment)) {
      return res.status(400).json({ success: false, message: "Invalid type" });
    }

    // if (!isEmpty(req.query.paymentType) && req.query.paymentType != 'all') {
    //     filter['paymentType'] = req.query.paymentType
    // } else {
    //     console.log(payment,'paym,entt======================')
    //     if (payment == 'fiat') {
    //         filter['paymentType'] = { "$in": ['fiat_deposit', 'fiat_withdraw', 'fiat_transfer'] }
    //     } else if (payment == 'crypto') {
    //         filter['paymentType'] = { "$in": ['coin_deposit', 'coin_withdraw', 'coin_transfer'] }
    //     }
    // }

    if (!isEmpty(req.query.coin) && req.query.coin != "all") {
      filter["coin"] = req.query.coin;
    }

    if (payment == "crypto") {
      if (req.query.paymentType == "coin_deposit") {
        filter["paymentType"] = { $in: ["coin_deposit"] };
      } else if (req.query.paymentType == "coin_withdraw") {
        filter["paymentType"] = { $in: ["coin_withdraw"] };
      } else if (req.query.paymentType == "coin_transfer") {
        filter["paymentType"] = { $in: ["coin_transfer"] };
      } else {
        filter["paymentType"] = { $in: CRYPTO_PAYMENT_TYPES };
      }
    } else if (payment == "fiat") {
      if (req.query.paymentType == "all") {
        filter["paymentType"] = {
          $in: ["fiat_deposit", "fiat_withdraw", "fiat_transfer"],
        };
      } else if (req.query.paymentType == "fiat_deposit") {
        filter["paymentType"] = { $in: ["fiat_deposit"] };
      } else if (req.query.paymentType == "fiat_withdraw") {
        filter["paymentType"] = { $in: ["fiat_withdraw"] };
      } else if (req.query.paymentType == "fiat_transfer") {
        filter["paymentType"] = { $in: ["fiat_transfer"] };
      } else {
        filter["paymentType"] = {
          $in: ["fiat_deposit", "fiat_withdraw", "fiat_transfer"],
        };
      }
    }

    filter["userId"] = req.user.id;
    const count = await Transaction.countDocuments(filter);
    const data = await Transaction.find(filter, {
      createdAt: 1,
      paymentType: 1,
      coin: 1,
      amount: 1,
      bankDetail: 1,
      status: 1,
      toAddress: 1,
      tokenType: 1,
      txid: 1,
    })
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit);
    let result = {
      data,
      count: count,
    };
    return res.status(200).json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * Get Deposit List
 * URL : /adminapi/depositList
 * METHOD : GET
 */
/*export const getDepositList = async (req, res) => {
  try {
    let pagination = paginationQuery(req.query);
    let filter = filterSearchQuery(req.query, [
      "toAddress",
      "coin",
      "txid",
      "status",
    ]);

    filter["paymentType"] = { $in: ["coin_deposit", "fiat_deposit"] };

    let count = await Transaction.countDocuments(filter);

    let data = await Transaction.find(filter, {
      userId: 1,
      coin: 1,
      // "userAssetId": 1,
      image: 1,
      actualAmount: 1,
      amount: 1,
      txid: 1,
      toAddress: 1,
      status: 1,
      paymentType: 1,
      createdAt: 1,
    })
      .sort({ createdAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit);

    let result = {
      data,
      count: count.length,
    };
    return res.status(200).json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};*/


/**
 * function for checking the empty object
 */
function isEmptyobj(obj) {
  return Object.keys(obj).length === 0;
}

/**
 * Get Withdraw List
 * URL : /adminapi/withdrawList
 * METHOD : GET
 */

/**
 * Approve Coin Withdraw
 * URL: /adminapi/coinWithdraw/approve
 * METHOD : POST
 * BODY: transactionId
 */
// export const coinWithdrawApprove = async (req, res) => {
//     try {
//         let reqParam = req.params

//         let trxData = await Transaction.findOneAndUpdate({
//             '_id': reqParam.transactionId,
//             'paymentType': 'coin_withdraw',
//             'status': 'pending'
//         }, {
//             'status': 'completed'
//         }, { 'new': true })

//         if (!trxData) {
//             return res.status(400).json({ "success": false, 'message': 'Invalid Token' })
//         }

//         let withdrawData = await coinCtrl.coinWithdraw({
//             'type': trxData.type,
//             'coin': trxData.coin,
//             'toAddress': trxData.toAddress,
//             'amount': trxData.actualAmount
//         })

//         if (!withdrawData.status) {
//             return res.status(400).json({ "success": false, 'message': 'Something Wrong' })
//         }

//         trxData.txid = withdrawData.trxId;
//         let updateTrxData = await trxData.save();

//         let usrData = await User.findOne({ 'userId': trxData.userId })
//         if (usrData) {

//             let content = {
//                 'amount': trxData.actualAmount,
//                 'currency': trxData.coin,
//                 'tranactionId': reqParam.transactionId,
//                 'date': new Date(),
//             };

//             mailTemplateLang({
//                 'userId': usrData._id,
//                 'identifier': 'Withdraw_notification',
//                 'toEmail': usrData.email,
//                 content
//             })

//             // newNotification({
//             //     'userId': updateTrxData.userId,
//             //     'currencyId': updateTrxData.currencyId,
//             //     'transactionId': updateTrxData._id,
//             //     'trxId': updateTrxData._id,
//             //     'currencySymbol': updateTrxData.currencySymbol,
//             //     'amount': updateTrxData.amount,
//             //     'paymentType': updateTrxData.paymentType,
//             //     'status': updateTrxData.status,
//             // })

//         }

//         return res.status(200).json({ 'success': true, 'message': "Withdraw successfully" })
//     }
//     catch (err) {
//         console.log(err,'ee')
//         return res.status(500).json({ "success": false, 'message': 'Error on server' })
//     }
// }
const handleTransfer = async (trxData) => {
  try {
    trxData.txid = "paper-" + Date.now();
    trxData.status = "completed";
    await trxData.save();
    return { success: true };
  } catch (err) {
    console.error("handleTransfer error:", err);
    return { success: false, message: "Transfer processing failed" };
  }
};

export const coinWithdrawApprove = async (req, res) => {
  const { transactionId } = req.params;
  let trxData;

  try {
    trxData = await Transaction.findOneAndUpdate(
      {
        _id: transactionId,
        paymentType: "coin_withdraw",
        status: "pending",
      },
      { status: "processing" },
      { new: true }
    ).populate("currencyId");

    if (!trxData) {
      return res.status(400).json({ success: false, message: "Invalid transaction" });
    }

    const result = await handleTransfer(trxData);

    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }

    const content = {
      amount: trxData.actualAmount,
      currency:
        trxData.currencyId?.type === "token"
          ? `${trxData.currencyId.tokenType.toUpperCase()}/${trxData.coin}`
          : trxData.coin,
      tranactionId: trxData.txid,
      date: new Date(),
    };

    const user = await fetchUser({ id: trxData.userId });
    await sendMail({
      userId: trxData.userId,
      identifier: "Withdraw_notification",
      toEmail: user.email,
      content,
    });

    return res.status(200).json({ success: true, message: "Withdraw successful" });

  } catch (err) {
    console.error("Withdraw Error:", err);

    await Transaction.findOneAndUpdate(
      {
        _id: transactionId,
        paymentType: "coin_withdraw",
        status: "processing",
      },
      { status: "pending" },
      { new: true }
    );

    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
/**
 * Reject Coin Withdraw
 * URL: /adminapi/coinWithdraw/reject
 * METHOD : POST
 */
export const coinWithdrawReject = async (req, res) => {
  try {
    let reqParam = req.params;

    let trxData = await Transaction.findOneAndUpdate(
      {
        _id: ObjectId(req.body.decryptData),
        paymentType: "coin_withdraw",
        status: "pending",
      },
      {
        status: "rejected",
      },
      { new: true }
    );

    if (!trxData) {
      return res.status(400).json({ success: false, message: "Invalid Token" });
    }

    // THE REFUND HAS TO LAND IN THE FIELD THE SPEND CAME OUT OF.
    //
    // This credited `<userId>_<assetId>` - the ASSET-DOCUMENT key style -
    // while coinWithdraw debits `<userId>_<currencyId>`, the engine field. For
    // every coin seeded by createAsset those two ids happen to be equal, so it
    // worked by coincidence; for a coin whose asset row has its own id (USDC,
    // from the flat `assets` collection) the debit and the refund addressed
    // DIFFERENT FIELDS. The user's spendable balance never came back, and the
    // credit accumulated in a field nothing spends from.
    let afterBalance = await spotDelta({
      userId: trxData.userId.toString(),
      currencyId: trxData.currencyId.toString(),
      coin: trxData.coin,
      delta: trxData.amount,
    });

    // let updateWallet = await Wallet.findOneAndUpdate(
    //   {
    //     _id: trxData.userId,
    //     "assets._id": trxData.assetId,
    //   },
    //   {
    //     $inc: {
    //       "assets.$.spotBal": trxData.amount,
    //     },
    //   },
    //   { new: true }
    // );

    if (afterBalance) {
      // CREATE PASS_BOOK
      createPassBook({
        userId: trxData.userId,
        coin: trxData.coin,
        currencyId: trxData.currencyId,
        tableId: trxData._id,
        beforeBalance: parseFloat(afterBalance - trxData.amount),
        afterBalance: parseFloat(afterBalance),
        amount: parseFloat(trxData.amount),
        type: "coin_withdraw_reject",
        category: "credit",
      });
    }

    // newNotification({
    //     'userId': trxData.userId,
    //     'currencyId': trxData.currencyId,
    //     'transactionId': trxData._id,
    //     'trxId': trxData._id,
    //     'currencySymbol': trxData.currencySymbol,
    //     'amount': trxData.amount,
    //     'paymentType': trxData.paymentType,
    //     'status': trxData.status,
    // })
    let content = {
      amount: trxData.amount,
      currency: trxData.coin,
      tranactionId: trxData.txid,
      withdrwaType: "Crypto",
      status: `your withdraw request Rejected for ${req.body.reason}`,
      date: new Date(),
    };

    sendMail({
      userId: trxData.userId,
      identifier: "wallet_reject_notification",
      toEmail: trxData.userId,
      content,
    });

    return res
      .status(200)
      .json({ success: true, message: "Withdraw successfully rejected" });
  } catch (err) {
    console.log(err, ";err");
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * Approve Fiat Withdraw
 * URL: /adminapi/coinWithdraw/approve
 * METHOD : POST
 * BODY: transactionId
 */
export const fiatWithdrawApprove = async (req, res) => {
  try {
    let reqParam = req.params;

    let trxData = await Transaction.findOneAndUpdate(
      {
        _id: reqParam.transactionId,
        paymentType: "fiat_withdraw",
        status: "pending",
      },
      {
        status: "completed",
      },
      { new: true }
    );

    if (!trxData) {
      return res.status(400).json({ success: false, message: "Invalid Token" });
    }

    // let usrData = await User.findOne({ userId: trxData.userId });

    let content = {
      amount: trxData.actualAmount,
      currency: trxData.coin,
      tranactionId: trxData.txid,
      withdrwaType: "Fiat",
      status: `your withdraw request approved`,
      date: new Date(),
    };

    sendMail({
      userId: trxData.userId,
      identifier: "wallet_reject_notification",
      toEmail: trxData.userId,
      content,
    });

    // newNotification({
    //     'userId': trxData.userId,
    //     'currencyId': trxData.currencyId,
    //     'transactionId': trxData._id,
    //     'trxId': trxData._id,
    //     'currencySymbol': trxData.currencySymbol,
    //     'amount': trxData.amount,
    //     'paymentType': trxData.paymentType,
    //     'status': trxData.status,
    // })

    return res
      .status(200)
      .json({ success: true, message: "Withdraw successfully" });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * Reject Coin Withdraw
 * URL: /adminapi/coinWithdraw/reject
 * METHOD : POST
 */
export const fiatWithdrawReject = async (req, res) => {
  try {
    let reqParam = req.params;

    let trxData = await Transaction.findOneAndUpdate(
      {
        _id: ObjectId(req.body.decryptData),
        paymentType: "fiat_withdraw",
        status: "pending",
      },
      {
        status: "rejected",
      },
      { new: true }
    );

    if (!trxData) {
      return res.status(400).json({ success: false, message: "Invalid Token" });
    }

    let afterBalance = await spotDelta({
      userId: trxData.userId.toString(),
      currencyId: trxData.currencyId.toString(),
      coin: trxData.coin,
      delta: trxData.amount,
    });

    // let updateWallet = await Wallet.findOneAndUpdate(
    //   {
    //     _id: trxData.userId,
    //     "assets._id": trxData.currencyId,
    //   },
    //   {
    //     $inc: {
    //       "assets.$.spotBal": trxData.amount,
    //     },
    //   },
    //   { new: true }
    // );
    if (afterBalance) {
      // let usrAsset = updateWallet.assets.id(trxData.currencyId);
      // let beforeBalance =
      //   parseFloat(usrAsset.spotBal) + parseFloat(trxData.amount);

      // CREATE PASS_BOOK
      createPassBook({
        userId: trxData.userId,
        coin: trxData.coin,
        currencyId: trxData.currencyId,
        tableId: trxData._id,
        beforeBalance: parseFloat(afterBalance - trxData.amount),
        afterBalance: parseFloat(afterBalance),
        amount: parseFloat(trxData.amount),
        type: "fiat_withdraw_reject",
        category: "credit",
      });
    }

    // newNotification({
    //     'userId': trxData.userId,
    //     'currencyId': trxData.currencyId,
    //     'transactionId': trxData._id,
    //     'trxId': trxData._id,
    //     'currencySymbol': trxData.currencySymbol,
    //     'amount': trxData.amount,
    //     'paymentType': trxData.paymentType,
    //     'status': trxData.status,
    // })
    let content = {
      amount: trxData.amount,
      currency: trxData.coin,
      tranactionId: trxData.txid,
      withdrwaType: "Fiat",
      status: `your withdraw request Rejected for ${req.body.reason}`,
      date: new Date(),
    };

    sendMail({
      userId: trxData.userId,
      identifier: "wallet_reject_notification",
      toEmail: trxData.userId,
      content,
    });

    return res
      .status(200)
      .json({ success: true, message: "Withdraw successfully rejected" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * Admin Approved Fiat Deposit Request
 * URL: /adminapi/fiatDeposit/approve
 * METHOD : POST
 * BODY : transactionId, amount
 */
export const fiatDepositApprove = async (req, res) => {
  try {
    let reqBody = req.body;

    let trxData = await Transaction.findOne({
      _id: reqBody.transactionId,
      paymentType: "fiat_deposit",
      status: "pending",
    });

    if (!trxData) {
      return res.status(400).json({ success: false, message: "Invalid Token" });
    }

    if (isEmpty(reqBody.amount)) {
      return res.status(400).json({
        success: false,
        message: "Amount is required",
      });
    }
    if (reqBody.amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "enter amount more then zero",
      });
    }

    if (trxData.amount < reqBody.amount) {
      return res.status(400).json({
        success: false,
        message: "Amount should be lower than or equal to depoist amount",
      });
    }

    trxData.status = "completed";
    trxData.actualAmount = trxData.amount;
    trxData.amount = reqBody.amount;

    let transactionData = await trxData.save();

    // let updateWallet = await Wallet.findOneAndUpdate(
    //   {
    //     userId: transactionData.userId,
    //     "assets._id": transactionData.currencyId,
    //   },
    //   {
    //     $inc: {
    //       "assets.$.spotBal": reqBody.amount,
    //     },
    //   },
    //   { new: true }
    // );

    let afterBalance = await spotDelta({
      userId: trxData.userId.toString(),
      currencyId: trxData.currencyId.toString(),
      coin: trxData.coin,
      delta: reqBody.amount,
    });

    if (afterBalance) {
      // let usrAsset = updateWallet.assets.id(trxData.currencyId);
      // console.log("assets", usrAsset);
      // let beforeBalance =
      //   parseFloat(usrAsset.spotBal) - parseFloat(trxData.amount);

      // CREATE PASS_BOOK
      createPassBook({
        userId: trxData.userId,
        coin: trxData.coin,
        currencyId: trxData.currencyId,
        tableId: trxData._id,
        beforeBalance: afterBalance - parseFloat(reqBody.amount),
        afterBalance: parseFloat(afterBalance),
        amount: parseFloat(trxData.amount),
        type: "fiat_deposit_approve",
        category: "credit",
      });
    }

    let content = {
      amount: reqBody.amount,
      currency: trxData.coin,
      tranactionId: trxData.txid,
      depositType: "Fiat",
      status: `your deposit request approved`,
      date: new Date(),
    };

    sendMail({
      userId: trxData.userId,
      identifier: "USER_FIAT_NOTIFICATION",
      toEmail: trxData.userId,
      content,
    });

    // newNotification({
    //   userId: usrData._id,
    //   currencyId: transactionData.currencyId,
    //   transactionId: transactionData._id,
    //   trxId: transactionData._id,
    //   currencySymbol: transactionData.coin,
    //   amount: transactionData.amount,
    //   paymentType: transactionData.paymentType,
    //   status: transactionData.status,
    // });

    return res
      .status(200)
      .json({ success: true, message: "Amount added successfully" });
  } catch (err) {
    console.log("errrON___FIAT_DEPOSIT", err);
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

export const fiatDepositReject = async (req, res) => {
  try {
    let reqBody = req.body;

    let trxData = await Transaction.findOneAndUpdate(
      {
        _id: ObjectId(req.body.decryptData),
        paymentType: "fiat_deposit",
        status: "pending",
      },
      {
        status: "rejected",
      },
      { new: true }
    );

    if (!trxData) {
      return res.status(400).json({ success: false, message: "Invalid Token" });
    }

    let content = {
      amount: trxData.amount,
      currency: trxData.coin,
      tranactionId: trxData.txid,
      depositType: "Fiat",
      status: `your deposit request rejected for ${req.body.reason}`,
      date: new Date(),
    };

    sendMail({
      userId: trxData.userId,
      identifier: "USER_FIAT_NOTIFICATION",
      toEmail: trxData.userId,
      content,
    });

    // newNotification({
    //   userId: transactionData.userId,
    //   currencyId: transactionData.currencyId,
    //   transactionId: transactionData._id,
    //   trxId: transactionData._id,
    //   currencySymbol: transactionData.currencySymbol,
    //   amount: transactionData.amount,
    //   paymentType: transactionData.paymentType,
    //   status: transactionData.status,
    //   type: "Deposit rejected",
    //   description: "Deposit rejected",
    // });

    return res
      .status(200)
      .json({ success: true, message: "Reject successfully" });
  } catch (err) {
    console.log(err, "error");
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * Create new asset to all user at create new currency
 */
export const newAssetAllUsr = async (currency) => {
  try {
    // if (type = crypto)
    // else (= token) assets.tokenAray { '' }
    await Wallet.updateMany(
      {},
      {
        $push: {
          assets: {
            _id: currency._id,
            coin: currency.coin,
          },
        },
      },
      { multi: true }
    );
    console.log("success");
    return true;
  } catch (err) {
    console.log("err", err);
    return false;
  }
};

export const getMyTransactions = async (req, res) => {
  try {
    var userID = req.body.curUser;
    var trans = req.body.transactiontype;
    var curr = req.body.currencytype;
    var filter_by = {};
    if (userID) {
      filter_by["userId"] = userID;
    }
    if (trans) {
      if (trans !== "all") filter_by["paymentType"] = trans;
    }
    if (curr) {
      if (curr !== "all") filter_by["currencySymbol"] = curr;
    }
    Transaction.find(filter_by)
      .populate("currencyId")
      .exec((err, result) => {
        if (result) {
          return res.json({ status: true, result: result });
        } else {
          return res
            .status(500)
            .json({ status: false, message: "Error occured" });
        }
      });
  } catch {
    return res.status(500).json({ status: false, message: "Error occured" });
  }
};

// `getAdminDashboard` was here: the gRPC handler behind the operator
// dashboard's two tiles, counting today's deposit and withdraw Transaction
// rows (including the `admin_deposit` / `admin_withdraw` payment types, which
// only the removed admin credit/debit ever wrote). The admin panel is gone,
// nothing calls it, and a read of the transaction ledger that no surface can
// display is exactly the residue this reduction is meant to remove.

/**
 * Get Balance List
 * METHOD : Get
 * URL : /api/wallet/getUserAsset
 */
// export const getUserAsset = async (req, res) => {
//   try {
//     // let pagination = paginationQuery(req.query);
//     // let filter = filterSearchQuery(req.query, ["currencySymbol"]);
//     // let count = await Assets.countDocuments(filter);

//     let data = await Wallet.aggregate([
//       { $match: { _id: ObjectId(req.query.userId) } },
//       { $unwind: "$assets" },
//       {
//         $project: {
//           coin: "$assets.coin",

//           spotBal: "$assets.spotBal",
//           p2pBal: "$assets.p2pBal",

//           destTag: "$assets.destTag",
//           _id: "$assets._id",
//         },
//       },
//       // { $skip: pagination.skip },
//       // { $limit: pagination.limit },
//     ]);
//     let result = {
//       data,
//     };
//     return res.status(200).json({ success: true, messages: "success", result });
//   } catch (err) {
//     console.log("...errr", err);
//     res.status(500).json({ success: false, message: "error on server" });
//   }
// };

/**
 * Get By Id
 * METHOD : Get
 * URL : /api/wallet/findById
 */


/**
 * User Deposit
 */

export const userDeposit = async (req, res) => {
  try {
    // const userid = req.query.userId;
    const userid = req.user.id;
    if (!userid) {
      return res.status(400).json({ error: "Missing userId in query." });
    }

    const data = await Currency.find({ status: "active" });

    const tasks = data.map(async (currency) => {
      try {
        if (currency.type === "crypto" && currency.depositType === "local") {
          switch (currency.coin) {
            case "BNB":
              return await bnbGateway.deposit(userid, currency._id.toString());
            case "ETH":
              return await ethGateway.deposit(userid, currency._id.toString());
            case "POLYGON":
              return await polyGateway.polyCoinDeposit(userid, currency._id.toString());
            case "BTC":
              return await btcGateway.deposit(userid, currency._id.toString());
            case "LTC":
              return await ltcGateway.deposit(userid, currency._id.toString());
          }
        } else if (currency.type === "token" && currency.depositType === "local") {
          switch (currency.tokenType) {
            case "bep20":
              return await bnbGateway.tokenDeposit(userid, currency.coin);
            case "erc20":
              return await ethGateway.tokenDeposit(userid, currency.coin);
            case "poly20":
              return await polyGateway.polytokenDeposit(userid, currency.coin);
          }

        }
      } catch (innerError) {
        console.error(`Error processing ${currency.coin}:`, innerError);
      }
    });

    await Promise.allSettled(tasks);

    return res.status(200).json({ message: "Deposit process initiated." });
  } catch (error) {
    console.error("Deposit API Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * Get Withdraw Limit
 */
export const getWithdrawLimit = async (req, res) => {
  try {
    const userId = req.user.id;
    // Return default withdrawal limits - you can customize this per currency if needed
    const limits = {
      daily: 100000,
      weekly: 500000,
      monthly: 1000000,
      minWithdraw: 0.001
    };
    return res.status(200).json({
      success: true,
      result: limits
    });
  } catch (error) {
    console.error("Get Withdraw Limit Error:", error);
    return res.status(500).json({ success: false, message: "Error fetching withdraw limit" });
  }
};

/**
 * Create Address for a specific asset
 * Integrated with Helius/Alchemy deposit system via Spot API
 */
export const createAddress = async (req, res) => {
  try {
    console.log('*** createAddress called with body:', JSON.stringify(req.body));
    const userid = req.user.id;
    const { assetId } = req.body;

    console.log('*** userid:', userid);
    console.log('*** assetId:', assetId);

    if (!userid) {
      return res.status(400).json({ success: false, message: "Missing user ID." });
    }
    if (!assetId) {
      return res.status(400).json({ success: false, message: "Missing assetId." });
    }

    // Get user's wallet
    let wallet = await Wallet.findById(userid);
    if (!wallet) {
      return res.status(404).json({ success: false, message: "Wallet not found." });
    }

    // Find the asset in the wallet's assets array
    const asset = wallet.assets.id(assetId);
    if (!asset) {
      return res.status(404).json({ success: false, message: "Asset not found in wallet." });
    }

    console.log('*** Found asset:', { coin: asset.coin, currencyId: asset.currencyId?.toString() });

    // Find the currency
    const currency = await Currency.findById(asset.currencyId);
    if (!currency) {
      return res.status(404).json({ success: false, message: "Currency not found." });
    }

    console.log('*** Found currency:', { coin: currency.coin, type: currency.type, depositType: currency.depositType });

    // Map currency to chain for deposit system
    const chainMapping = {
      'ETH': 'ETH',
      'SOL': 'SOL',
      'BNB': 'BSC',
      'POLYGON': 'POLYGON',
      'MATIC': 'POLYGON',
      'BTC': 'BTC',
      'USDT': 'POLYGON', // USDT on Polygon
      'USDC': 'POLYGON', // USDC on Polygon
    };

    const chain = chainMapping[currency.coin] || currency.coin.toUpperCase();

    // PAPER TRADING: generate an obviously-fake, non-sendable paper address.
    // Same convention as the coin gateway stubs (e.g. btcGateway.js) — this
    // string fails any real wallet's address validation, so no real crypto can
    // ever be sent to it.
    const fallbackAddress =
      `paper-${currency.coin.toLowerCase()}-` +
      Date.now().toString(16) +
      Math.random().toString(16).slice(2, 10);

    console.log('*** Using paper address for', currency.coin, ':', fallbackAddress);

    // Update wallet asset with paper address
    await Wallet.updateOne(
      { _id: userid, 'assets._id': assetId },
      { $set: { 'assets.$.address': fallbackAddress } }
    );

    // Refresh wallet to get updated data.
    // SECURITY: projected, NOT the raw document. wallet.assets[] carries a
    // `privateKey` field (encryptString'd deposit-address key), and returning
    // the unprojected doc handed every one of the caller's asset keys back in
    // the HTTP response - and into any browser cache / proxy log along the way.
    // Same field list getWallet uses, so the response shape is unchanged apart
    // from the removed secret.
    wallet = await Wallet.findById(userid, {
      _id: 1,
      userCode: 1,
      binSubAcctId: 1,
      "assets._id": 1,
      "assets.coin": 1,
      "assets.currencyId": 1,
      "assets.address": 1,
      "assets.destTag": 1,
      "assets.spotBal": 1,
      "assets.spotLockedBal": 1,
      "assets.spotInOrder": 1,
      "assets.tokenAddressArray": 1,
    });

    return res.status(200).json({
      success: true,
      message: "Paper trading address generated — real crypto deposits are disabled in paper trading mode",
      data: wallet,
      chain: chain,
      depositAddress: fallbackAddress,
      fallback: true
    });

  } catch (error) {
    console.error("*** Create Address Error:", error?.message || error);
    // Do not echo the raw error message to the client - it can carry Mongo
    // query/document fragments.
    return res.status(500).json({ success: false, message: "Error creating address" });
  }
};

/**
 * ADMIN CREDIT / DEBIT of a user's spot balance.
 * PUT /adminapi/updateUserAsset   { userId, assetId, amount, type: 'deposit'|'withdraw' }
 *
 * WHY THIS ENDPOINT MAY STAY. It is the faucet's admin twin: on a paper venue,
 * an operator handing a user demo money (or taking it back) is an ordinary
 * administrative act with no off-venue counterparty and no claim that value
 * went anywhere. It writes a `Transaction` with `txid: "Internal Transfer"` and
 * a passbook row, which is exactly what it is. It is NOT a withdrawal and is
 * not closed with them.
 *
 * WHAT WAS WRONG WITH IT: A READ-MODIFY-WRITE ACROSS FOUR AWAITS.
 * --------------------------------------------------------------
 * It used to do this:
 *
 *     const checkBal = await hget("walletbalance_spot", `${userId}_${currencyId}`);
 *     ... affordability compared in node against `checkBal` ...
 *     asset[findex].spotBal = parseFloat(checkBal) +/- parseFloat(amount);
 *     await userWallet.save();                       // await 2
 *     await hset("walletbalance_spot", field, asset[findex].spotBal);   // await 3
 *     await mirrorSpot({ ... });                     // await 4
 *
 * The value finally STORED is an absolute number computed from a balance read
 * three awaits earlier, so everything that moved the same field in between is
 * overwritten. Concretely:
 *
 *   - a fill settling between the HGET and the HSET is erased. The matcher
 *     settles `walletbalance_spot` with HINCRBYFLOAT and does not know this
 *     handler exists; a 10,000-balance account credited 100 while a 4,000 buy
 *     fills ends at 10,100, not 6,100. The user keeps the coin AND the cash.
 *   - two admin adjustments that overlap lose one of them entirely, because
 *     both read the same `checkBal` and the later HSET wins outright.
 *   - the `type === "withdraw"` affordability check has the same shape as the
 *     three transfer defects measured in
 *     controllers/redis.controller.js#hdecrbyfloatIfFree ("a gate computed in
 *     node from a snapshot is not a gate"), and can therefore drive the balance
 *     negative - a number `readSpotBalanceNumber`, the dashboards and the order
 *     path all act on.
 *
 * THE FIX IS THE ONE THIS SERVICE ALREADY MADE FOR TRANSFERS. `ledgerCredit` /
 * `ledgerDebit` (lib/walletLedger.js) decide and apply in ONE redis command -
 * the debit through the `hdecrbyfloatIfFree` Lua step, which tests
 * `total - locked >= amount` and decrements inside the same call - and both
 * re-derive the flat `assets` row and its redis mirror from the value the write
 * actually produced. So there is no window, and no absolute write.
 *
 * `wallet.assets[].spotBal` is no longer written from a stale snapshot either:
 * the subdocument is set from the ledger's post-write total, which is what
 * `redisWalletBackUp`'s cron would have converged it to anyway.
 *
 * The refusal wording, the status codes, the 1000-USD non-superadmin cap, the
 * Transaction row and the passbook row are all unchanged.
 */

// export const updateAsset = async (req, res) => {
//   try {
//     const reqBody = req.body;

//     let userWallet = await Wallet.findOne({ _id: reqBody.userId });

//     let asset = userWallet.assets;
//     let findex = await asset.findIndex(
//       (item) => String(item._id) === reqBody.assetId
//     );

//     let priceConv = await PriceConversion.findOne({
//       baseSymbol: asset[findex].coin,
//     });

//     if (
//       req.user.role !== "superadmin" &&
//       priceConv.convertPrice * reqBody.amount > 1000
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "Maximum updation limit is upto 1000 USD",
//       });
//     }
//     let befBalance = asset[findex].spotBal;
//     console.log(befBalance, "befBalance");

//     if (reqBody.type != "deposit" && befBalance <= 0) {
//       {
//         return res.status(400).json({
//           success: false,
//           message: "User's Balance is insufficient to Withdraw",
//         });
//       }
//     }
//     asset[findex].spotBal =
//       reqBody.type === "deposit"
//         ? asset[findex].spotBal + parseFloat(reqBody.amount)
//         : asset[findex].spotBal - parseFloat(reqBody.amount);
//     await userWallet.save();
//     const currency = await Currency.findOne({ coin: asset[findex].coin });
//     await hset(
//       "walletbalance_spot",
//       reqBody.userId.toString() + "_" + currency._id.toString(),
//       asset[findex].spotBal
//     );

//     const transactObj = {
//       coin: asset[findex].coin,
//       tokenType: currency.tokenType,
//       amount: parseFloat(reqBody.amount),
//       actualAmount: parseFloat(reqBody.amount),
//       type: "local",
//       paymentType:
//         reqBody.type === "deposit" ? "admin_deposit" : "admin_withdraw",
//       userId: reqBody.userId,
//       currencyId: currency._id,
//       status: "completed",
//       txid: "Internal Transfer",
//       userCode: IncCntObjId(reqBody.userId),
//     };

//     const tx = new Transaction(transactObj);
//     await tx.save();

//     await createPassBook({
//       userId: userWallet._id,
//       coin: asset[findex].coin,
//       currencyId: currency._id,
//       tableId: tx._id,
//       beforeBalance: befBalance,
//       afterBalance: parseFloat(asset[findex].spotBal),
//       amount: parseFloat(reqBody.amount),
//       type: reqBody.type === "deposit" ? "admin_deposit" : "admin_withdraw",
//       category: reqBody.type === "deposit" ? "credit" : "debit",
//     });

//     if (reqBody.type === "deposit") {
//       updateSD({
//         userId: reqBody.userId,
//         amount: reqBody.amount,
//         currencyId: currency._id,
//       });
//     }
    
//     return res.json({ success: true, message: "Update Successful" });
//   } catch (error) {
//     console.log(error);
//     return res.status(500).json({ success: false, message: "Error on Server" });
//   }
// };

/**
 * TRON Node Api Initial Call
 */
export const depositTRXInfo = async (req, res) => {
  return res
    .status(400)
    .json({ success: false, message: "Disabled in paper trading mode" });
};

export const getCryptoBalance = async (
  currency,
  tokenType,
  wallet_address,
  contract_address
) => {
  console.log("WALLET_ADDRESS", wallet_address);
  try {
    let balance = 0;
    if (tokenType == "bep20") {
      balance = await bnbGateway.getTokenBalance(
        contract_address,
        wallet_address
      );
    } else if (currency == "BNB") {
      balance = await bnbGateway.getCryptoBalance(wallet_address);
    }

    return balance;
  } catch (error) {
    return { status: false };
  }
};

export const siteCumulativeFunds = async () => {
  try {
    const response = await Wallet.aggregate([
      {
        $unwind: "$assets",
      },
      {
        $group: {
          _id: "$assets._id",
          // asset_code: { $first: "$assets.asset_code" },
          coin: { $first: "$assets.coin" },
          // Spot is the only pot on this venue.
          totalSpotBal: { $sum: "$assets.spotBal" },
        },
      },
    ]);
    // if (response.length > 0) {
    //   return response[0];
    // } else {
    //   return [];
    // }
    return response;
  } catch (error) {
    console.log("ERROR", error);
    return [];
  }
};


// adminAssetInfo();
const GAS_STATION = /gas station wallet/i;

export const createGasStation = async (req, res) => {
  try {
    const internalWallets = await getInternalWallets();

    if (process.env.MODE === "PRODUCTION") {
      return res
        .status(200)
        .json({ success: true, message: "Cannot create in Production Mode" });
    }
    const data = internalWallets.find((item) => GAS_STATION.test(item.name));

    if (!data) {
      return res
        .status(400)
        .json({ success: false, message: "Gas Station Wallet not found" });
    }

    let assets = [];
    for (let asset of data.assets) {
      let currency = await Currency.findOne({ gateway_code: asset.id }).lean();
      if (!currency) continue;
      assets.push({
        assetId: asset.id,
        currencyId: currency._id,
        symbol: currency.symbol,
        balance: parseFloat(asset.balance),
        address: asset.address,
      });
    }

    await GasStation.deleteMany({});
    const gasStation = new GasStation({
      name: "Gas Station Wallet",
      assets,
    });

    await gasStation.save();

    return res.status(200).json({
      success: true,
      message: "Gas Station Wallet added successfully",
    });
  } catch (error) {
    console.log(error);
    return res
      .status(500)
      .json({ success: false, message: "Something went wrong" });
  }
};
export const updatingGasStation = async () => {
  try {
    const internalWallets = await getInternalWallets();

    const data = internalWallets.find((item) => GAS_STATION.test(item.name));

    if (!data) {
      return [];
    }

    let assets = [];
    for (let asset of data.assets) {
      let currency = await Currency.findOne({ gateway_code: asset.id }).lean();
      if (!currency) continue;
      assets.push({
        assetId: asset.id,
        currencyId: currency._id,
        symbol: currency.symbol,
        balance: parseFloat(asset.balance),
        address: asset.address,
      });
    }

    await GasStation.deleteMany({});
    const gasStation = new GasStation({
      name: "Gas Station Wallet",
      assets,
    });

    await gasStation.save();

    return assets;
  } catch (error) {
    console.log(error.toString());
    return [];
  }
};
export const updateGasStationCron = async () => {
  // PAPER TRADING: gas station custody removed — nothing to refresh.
  return true;
};
let isGasStationUpdate = false;
export const refrshGasStation = async () => {
  try {
    if (isGasStationUpdate) return false;
    isGasStationUpdate = true;
    await updateGasStationCron();
    isGasStationUpdate = false;
  } catch (error) {
    console.log(error);
    isGasStationUpdate = false;
  }
};
export const getGasStaion = async (req, res) => {
  try {
    const gasWallet = await GasStation.findOne({}).lean();

    return res.status(200).json({
      success: true,
      result: {
        data: gasWallet?.assets || [],
        count: gasWallet?.assets?.length || 0,
      },
    });
  } catch (error) {
    console.log(error, "-------------3592");
    return res
      .status(500)
      .json({ success: false, message: "Something went wrong" });
  }
};

export const getGasStaionConfigs = async (req, res) => {
  return res
    .status(400)
    .json({ success: false, message: "Disabled in paper trading mode" });
};

export const updateGasStationConfig = async (req, res) => {
  return res
    .status(400)
    .json({ success: false, message: "Disabled in paper trading mode" });
};

// updateGasStationCron();
