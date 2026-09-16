// import model
import { IncCntObjId } from "../lib/generalFun.js";
import { Currency, Wallet } from "../models/index.js";
import * as coinCtrl from "./coin.controller.js";
import { updateUserWallet } from "./wallet.js";
import { hset, hget } from "./redis.controller.js";
// import { createVaultForUser } from "./coin/firebase.js";
// import { IncCntObjId } from "../lib/generalFun.js";

// PAPER TRADING (spec decision 1): every new wallet is seeded with demo money.
// USD is the quote currency of the venue's only market, BTC/USD, and the spot
// engine reads the buy-side balance under the pair's secondCurrencyId - so USD
// is the one coin a wallet must hold to be able to place an order at all.
//
// This used to seed USDC as well, because USDC was the spec currency. It never
// had a market to be traded in, so it is removed: currency, balances and the
// flat `assets` ledger that existed only to hold it. Kept in step with
// FAUCET_COINS in spotapi controllers/faucet.controller.js by tests on both
// sides - a reset and a fresh registration must produce the same account.
const DEMO_SEED_COINS = ["USD"];
const DEMO_SEED_AMOUNT = 1000; // regular units

/**
 * THE SEED IS ONE NUMBER, AND THIS IS ONE HALF OF ITS DEFINITION.
 * ==============================================================
 *
 * `POST /api/spot/faucet/reset` RESTORES an account to the signup seed, and
 * that sentence is only true while the two ends agree. They are pinned to each
 * other by a test on each side: tests/integration/paper-demo-seed.integration.test.js
 * here and tests/unit/faucet.controller.test.js in spotapi.
 *
 * THE SEED IS SPOT ONLY, both ends. Changing it on one end alone is exactly
 * the defect the two-sided pinning tests exist to catch. A reset and a fresh
 * registration both produce DEMO_SEED_AMOUNT of each DEMO_SEED_COIN in spot,
 * and nothing else.
 */


export const emptyAsset = async (reqBody) => {

  console.log("<===========================================emptyAsset:========================================> ", reqBody);
  try {
    const botUser = reqBody?.botUser || false;
    let walletData = await new Wallet({
      _id: reqBody.userId,
      userCode: IncCntObjId(reqBody.userId),
      assets: [],
    }).save();

    let currencyList = await Currency.aggregate([
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
          token: [
            { $match: { type: "token" } },
            {
              $project: {
                type: 1,
                coin: 1,
                depositType: 1,
                tokenType: 1,
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
                status: 1,
              },
            },
          ],
        },
      },
    ]);

    console.log("currencyList: ", currencyList.length);

    if (currencyList[0].crypto && currencyList[0].crypto.length > 0) {
      walletData["assets"] = [
        ...walletData["assets"],
        ...(await coinCtrl.generateCryptoAddr({
          currencyList: currencyList[0].crypto,
          userId: reqBody.userId,
          botUser
        })),
      ];
    }

    if (currencyList[0].token && currencyList[0].token.length > 0) {
      try {
        walletData["assets"] = [
          ...walletData["assets"],
          ...(await coinCtrl.generateTokenAddr({
            currencyList: currencyList[0].token,
            walletList: walletData["assets"],
            botUser
          })),
        ];
      } catch (err) {
        console.log("Error on generateTokenAddr(): ", err);
      }
    }

    if (currencyList[0].fiat && currencyList[0].fiat.length > 0) {
      walletData["assets"] = [
        ...walletData["assets"],
        ...(await coinCtrl.generateFiatAddr({
          currencyList: currencyList[0].fiat,
        })),
      ];
    }

    // PAPER TRADING: seed the new user with virtual funds. Mirrors the
    // double-ledger convention of spotapi controllers/faucet.controller.js:
    // wallet.assets[].spotBal in regular units, flat `assets` collection in
    // smallest-unit string (1e6), and Redis walletbalance_spot under BOTH
    // key styles (userId_currencyId AND userId_assetDocId).
    const seedCurrencies = await Currency.find({
      coin: { $in: DEMO_SEED_COINS },
    });

    for (const seedCurrency of seedCurrencies) {
      let seedAsset = walletData.assets.find(
        (el) => el.coin === seedCurrency.coin
      );
      if (seedAsset) {
        seedAsset.currencyId = seedCurrency._id;
        seedAsset.spotBal = DEMO_SEED_AMOUNT;
      } else {
        walletData.assets.push({
          _id: seedCurrency._id,
          currencyId: seedCurrency._id,
          coin: seedCurrency.coin,
          address: "",
          privateKey: "",
          spotBal: DEMO_SEED_AMOUNT,
        });
      }
    }

    await walletData.save();

    for (const seedCurrency of seedCurrencies) {
      try {
        const userIdObj = walletData._id;
        const userIdStr = userIdObj.toString();

        // Redis cache keyed by currency id — what the spot engine reads.
        await hset(
          "walletbalance_spot",
          `${userIdStr}_${seedCurrency._id.toString()}`,
          DEMO_SEED_AMOUNT
        );

        console.log(
          "PAPER TRADING: seeded demo",
          seedCurrency.coin,
          "for user:",
          userIdStr,
          DEMO_SEED_AMOUNT
        );
      } catch (err) {
        console.log(
          `Error seeding demo ${seedCurrency.coin}:`,
          err?.message ? err.message : err.toString()
        );
      }
    }

    if (seedCurrencies.length === 0) {
      console.log("PAPER TRADING: no seed currency found - demo seed skipped");
    }

    updateUserWallet({ id: reqBody.userId });
  } catch (err) {
    console.log(
      "CREATING EMPTY ASSET ERR :",
      err?.message ? err.message : err.toString()
    );
    return false;
  }
};


