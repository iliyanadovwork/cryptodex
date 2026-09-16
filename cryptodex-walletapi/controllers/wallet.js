// import model
import { Wallet, Currency, PriceConversion } from "../models/index.js";
import mongoose from "mongoose";
import { hsetnx } from "../controllers/redis.controller.js";
import { IncCntObjId } from "../lib/generalFun.js";
import { createPassBook } from "./passbook.controller.js";
// import controller
import * as coinGateway from "./coin.controller.js";
import * as bnbGateway from './coin/bnbGateway.js';
import * as bdyxGateway from './coin/bdyxGateway.js';
import { encryptString } from "../lib/cryptoJS.js";
import { createVaultAsset, getUserWalletById } from "./coin/firebase.js";
import { applyStandDownMode } from "../lib/walletStandDown.js";

const ObjectId = mongoose.Types.ObjectId;
export const getUserAsset = async (reqBody) => {
  try {
    let usrWallet = await Wallet.findOne({ _id: reqBody.id });
    // Look up asset by currencyId instead of subdocument _id
    let usrAsset = usrWallet.assets.find(a => a.currencyId && a.currencyId.toString() === reqBody.currencyId);
    if (!usrAsset) {
      console.log('[getUserAsset] Asset not found for currencyId:', reqBody.currencyId);
      return { status: false };
    }
    // SECURITY: privateKey is deliberately NOT returned. This is the gRPC
    // wallet service, reachable over an insecure (plaintext) channel by
    // spotapi, and that consumer does not read the
    // field - shipping the asset's key across the wire bought nothing and
    // also landed it in the log line below.
    let result = {
      coin: usrAsset.coin,
      address: usrAsset.address,
      destTag: usrAsset.destTag,
      spotBal: usrAsset.spotBal,
    };
    return { status: true, result };
  } catch (error) {
    console.error('[getUserAsset] Error:', error);
    return { status: false };
  }
};

export const updateUserAsset = async (reqBody) => {
  try {
    // Use direct MongoDB update to avoid Mongoose validation issues with subdocuments
    let walletData = await Wallet.findOne({ _id: reqBody.id });
    if (walletData) {
      // Look up asset by currencyId
      let usrAsset = walletData.assets.find(a => a.currencyId && a.currencyId.toString() === reqBody.currencyId);
      if (usrAsset) {
        // Use updateOne with elemMatch to update the specific asset subdocument
        const updateResult = await Wallet.updateOne(
          { _id: reqBody.id, 'assets._id': usrAsset._id },
          { $set: { 'assets.$.spotBal': reqBody.spotBal } }
        );
        console.log('[updateUserAsset] Updated:', reqBody.id, reqBody.currencyId, reqBody.spotBal, 'modified:', updateResult.modifiedCount);
      } else {
        console.log('[updateUserAsset] Asset not found for currencyId:', reqBody.currencyId);
      }
    }
    return true;
  } catch (error) {
    console.error('[updateUserAsset] Error:', error);
    return false;
  }
};

/**
 * HYDRATE THE ENGINE LEDGERS FROM MONGO - SEEDING ONLY, NEVER OVERWRITING.
 * =======================================================================
 *
 * WHAT IT IS FOR
 * --------------
 * Its callers say so plainly. spotapi `spot.controller.orderPlace` and
 * `marketOrderPlace` call it over gRPC in exactly one situation:
 *
 *     let usrWallet = await hget("walletbalance_spot", uid + "_" + currencyId);
 *     if (usrWallet == null) { await updateUserWallet(req.user.id); }
 *
 * - "the redis field is MISSING, please put it there". `createAsset` calls it
 * once when a new account's assets have just been written. Neither asks for a
 * mongo snapshot to be imposed on a running ledger, and neither could sensibly
 * want that: redis is the authoritative ledger on this venue
 * (`controllers/redisWalletBackUp.js` is built on exactly that premise, and
 * copies redis INTO mongo every ten seconds), so mongo here is a backup that is
 * up to ten seconds stale.
 *
 * WHAT IT DID, AND WHAT THAT COST - MEASURED LIVE
 * -----------------------------------------------
 * It wrote every ledger with an unconditional `hset`, and some of them from the
 * wrong source on top of that: a RESERVATION counter was written from the whole
 * BALANCE field.
 *
 * On this stack, own throwaway account holding one live position that required
 * 7.382 of reserved margin, invoking the exact gRPC method spot.controller
 * invokes:
 *
 *   before the 10s backup cron (mongo balance 0):
 *     balance   2000  -> 0
 *     locked    7.382 -> 0      UNMARGINED LIVE POSITION
 *   after it (mongo balance 2000):
 *     locked    7.382 -> 2000   ENTIRE ACCOUNT RESERVED
 *
 * Both polarities from one ordinary "the spot field was missing" call.
 *
 * THE FIX IS THE SEMANTICS ITS CALLERS ALREADY ASSUME
 * ---------------------------------------------------
 * Every write is HSETNX: it fills a field that is ABSENT and leaves an existing
 * one exactly alone, decided by redis in one command so there is no window
 * between the check and the write either. A hydration that arrives while an
 * engine is mid-reservation can now do nothing at all, which is the correct
 * amount for it to do.
 *
 * And a reservation counter is seeded from the RESERVATION field, which is what
 * it is the backup of - never from the balance.
 *
 * `updated` counts the fields this call actually created, so a caller can tell
 * "seeded a missing row" from "everything was already there".
 */
export const updateUserWallet = async (reqBody) => {
  try {
    let walletData = await Wallet.findOne({ _id: reqBody.id });
    if (walletData && walletData.assets.length > 0) {
      let seeded = 0;
      for (let i = 0; i < walletData.assets.length; i++) {
        const asset = walletData.assets[i];
        const field =
          walletData._id.toString() + "_" + asset._id.toString();
        // key -> the mongo field that is the BACKUP OF THAT KEY. A reservation
        // counter is backed by a reservation field; a mirror by its mirror.
        const ledgers = [
          ["walletbalance_spot", asset.spotBal],
          ["walletbalance_spot_inOrder", asset.spotInOrder],
        ];
        for (const [key, value] of ledgers) {
          // `?? 0` rather than the raw value: an asset document written before
          // one of these fields existed has it undefined, and seeding a field
          // with `undefined` writes the string "undefined" into a balance hash.
          const written = await hsetnx(key, field, value ?? 0);
          if (written) seeded += 1;
        }
      }
      return { status: true, seeded };
    }
    return { status: false };
  } catch (err) {
    console.log("[updateUserWallet] Error:", err);
    return { status: false };
  }
};
export const passbook = async (reqBody) => {
  try {
    // createPassBook returns null when the row could not be written (e.g. a
    // non-numeric balance). Reporting status:true for a dropped audit row is
    // what made the loss invisible to the calling API.
    const saved = await createPassBook(reqBody);
    return { status: saved != null };
  } catch (err) {
    console.log("err: ", err);
    return { status: false };
  }
};

export const getUserAllAsset = async (reqBody) => {
  try {
    let usrWallet = await Wallet.findById(reqBody.id, {
      _id: 0,
      assets: 1,
    }).lean();
    if (!usrWallet) {
      return { status: false };
    }
    return { status: true, result: usrWallet };
  } catch (err) {
    console.log("err: ", err);
    return { status: false };
  }
};

/**
 * gRPC: deactivateWallet
 *
 * The wallet half of userapi's account deactivation, and the fix for the
 * blocker that made deactivation impossible: userapi called this method,
 * walletapi did not implement it, so it answered `12 UNIMPLEMENTED` and the
 * mandatory gate in `/deactive-confirm` failed every single time.
 *
 * All the reasoning about what standing a wallet down MEANS on a paper
 * exchange, and why it is a reversible mark rather than a zeroing, lives in
 * lib/walletStandDown.js. It moves no balance.
 *
 * Answers { status, message } - never rejects - because the caller treats
 * anything that is not `status === true` as "the wallet was NOT stood down"
 * and refuses to deactivate the account on the strength of it.
 */
export const deactivateWallet = async (reqBody) => {
  try {
    const result = await applyStandDownMode(
      Wallet,
      reqBody && reqBody.userId,
      reqBody && reqBody.mode
    );
    console.log(
      "[deactivateWallet]",
      reqBody && reqBody.userId,
      reqBody && reqBody.mode,
      result
    );
    return result;
  } catch (err) {
    console.log("[deactivateWallet] Error:", err);
    return { status: false, message: "FREEZE_FAILED" };
  }
};

/**
 * Create New User Wallet
 */
export const createWallet = async (userId, email) => {
  try {
    let currencyData = await Currency.find({}).lean();
    let userAssetData = await Wallet.findById(userId);
    if (currencyData && currencyData.length > 0) {
      for (const item of currencyData) {
        let { _id, tokenType, type, coin, gateway_code, depositType } = item;
        let createNew = true;
        let resp = { address: "" };

        if (userAssetData && userAssetData?.assets.length > 0) {
          let idx = userAssetData?.assets.findIndex((el) => el.coin == coin);
          if (idx > -1) {
            if (userAssetData?.assets[idx].address != "") createNew = false;
          }
        }

        console.log(coin, '------166')
        if (createNew) {
          if (type == "crypto") {
            let tokenArrayAddress = userAssetData?.assets?.find(
              (el) => el.coin == item.coin
            );
            if (tokenArrayAddress) continue;
            let coinGatewayFile = `${coin.toLowerCase()}Gateway`;
            if (depositType == "fireblocks") {
              let createFireBlock = await createVaultAsset(
                userAssetData.gateWayId?.toString(),
                gateway_code
              );
              resp = { address: createFireBlock?.data?.address };
            } else {
              if (coin == "BNB") {
                let cryptoCreate = await bnbGateway.createAddress();
                resp = {
                  address: cryptoCreate.address,
                  privateKey: encryptString(cryptoCreate.privateKey)
                }
              }
              if (coin == "BDYX") {
                let cryptoCreate = await bdyxGateway.createAddress();
                resp = {
                  address: cryptoCreate.address,
                  privateKey: encryptString(cryptoCreate.privateKey)
                }
              }
              if (coinGateway[coinGatewayFile])
                resp = await coinGateway[coinGatewayFile].createAddress({
                  email,
                });
            }

            let address = "";
            let privateKey = "";
            let destTag = "";
            if (resp.address) {
              address = resp.address;
              if (coin == "XRP") destTag = resp.destTag;
              else if (resp?.privateKey)
                privateKey = encryptString(resp.privateKey);
              userAssetData["assets"] = [
                ...userAssetData["assets"],
                ...[
                  {
                    _id: _id,
                    coin: coin,
                    address: address,
                    privateKey: privateKey,
                  },
                ],
              ];
            }
          } else if (type == "token") {
            /**
             * ERC Token
             */
            let tokenarrayObj = [],
              newTokenAsset = {};
            let assetArray = userAssetData?.assets?.findIndex(
              (el) => el.coin == item.coin
            );

            if (assetArray != -1) {
              let tokenExcist = userAssetData.assets[
                assetArray
              ]?.tokenAddressArray?.findIndex(
                (el) => el.tokenType == tokenType
              );
              if (tokenExcist != -1) continue;
              tokenarrayObj =
                userAssetData.assets[assetArray]?.tokenAddressArray;
            }
            let tokenNetwork = {};
            if (depositType == "fireblocks") {
              let createFireBlock = await createVaultAsset(
                userAssetData.gateWayId?.toString(),
                gateway_code
              );
              if (createFireBlock?.status)
                tokenNetwork = { address: createFireBlock.data.address };
            } else {
              if (tokenType == "erc20") {
                tokenNetwork = userAssetData?.assets?.find(
                  (el) => el.coin == "ETH"
                );
              } else if (tokenType == "spl") {
                tokenNetwork = userAssetData?.assets?.find(
                  (el) => el.coin == "SOL"
                );
              } else if (tokenType == "bep20") {
                let cryptoCreate = await bnbGateway.createAddress();
                tokenNetwork = {
                  address: cryptoCreate.address,
                  privateKey: encryptString(cryptoCreate.privateKey)
                }
                console.log(tokenNetwork, '------228')
                // tokenNetwork = userAssetData?.assets?.find(
                //   (el) => el.coin == "BNB"
                // );
              } else if (tokenType == "trc20") {
                tokenNetwork = userAssetData?.assets?.find(
                  (el) => el.coin == "TRX"
                );
              }
            }

            if (tokenNetwork)
              resp = {
                address: tokenNetwork.address,
                privateKey: tokenNetwork?.privateKey,
              };
            else continue;

            let address = "";
            let privateKey = "";
            if (resp.address) {
              address = resp.address;
              privateKey = resp?.privateKey;
              tokenarrayObj = [
                ...tokenarrayObj,
                {
                  address: address,
                  privateKey: privateKey,
                  currencyId: item._id,
                  coin: item.coin,
                  tokenType: tokenType,
                  status: item.status,
                  blockNo: 0,
                },
              ];
              newTokenAsset = {
                address: "",
                privateKey: "",
                tokenAddressArray: tokenarrayObj,
              };
              let coinId = currencyData?.findIndex(
                (el) => el.coin == item.coin
              );
              if (assetArray != -1) {
                newTokenAsset._id = currencyData[coinId]._id;
                newTokenAsset.coin = userAssetData.assets[assetArray].coin;
                userAssetData.spotBal =
                  userAssetData.assets[assetArray].spotBal;
                userAssetData.assets[assetArray] = newTokenAsset;
              } else {
                newTokenAsset._id = item._id;
                newTokenAsset.coin = item.coin;
                userAssetData.assets.push(newTokenAsset);
              }
            }
          } else if (type == "fiat") {
            let tokenArrayAddress = userAssetData?.assets?.find(
              (el) => el.coin == item.coin
            );
            if (tokenArrayAddress) continue;
            userAssetData["assets"] = [
              ...userAssetData["assets"],
              ...[
                {
                  _id: _id,
                  userId: userId,
                  currency: _id,
                  coin: coin,
                  address: _id,
                  privateKey: "",
                },
              ],
            ];
          }
        }
      }
    }
    console.log("---------304");
    let save = await userAssetData.save();
  } catch (err) {
    console.log("err", err);
    return;
  }
};

export const getCnvPrice = async (reqBody) => {
  try {
    const tokenData = await Currency.findOne(
      {
        coin: "CRYPTODEX",
        type: "token"
      }
    )
    let cnvData = await PriceConversion.findOne(
      {
        baseSymbol: reqBody.baseSymbol,
        convertSymbol: reqBody.convertSymbol
      }
    )
    if (!cnvData) {
      return { status: false };
    }
    return { status: true, price: cnvData.convertPrice.toString(), tokenId: tokenData._id.toString() };
  } catch (err) {
    console.log("err: ", err);
    return { status: false };
  }
};