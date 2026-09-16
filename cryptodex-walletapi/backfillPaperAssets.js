/**
 * PAPER TRADING backfill — bring wallets created before the asset/seed fix up
 * to the shape `emptyAsset` now produces:
 *
 *  - an asset row for every currency (crypto rows used to be skipped unless the
 *    currency carried depositType "local", which none of them does)
 *  - `currencyId` set on every row (gRPC getUserAsset/updateUserAsset match on
 *    it — rows without one are invisible to the spot engine)
 *  - the demo balance on the seed currencies, but only where the wallet was
 *    never funded (spotBal 0), so traded balances are left alone
 *
 * Idempotent — re-running changes nothing once a wallet is up to date.
 *
 * RUN: node -r dotenv/config backfillPaperAssets.js dotenv_config_path=local.env
 */
import mongoose from "mongoose";

import config from "./config/index.js";
import { Currency, Wallet } from "./models/index.js";
import { updateUserWallet } from "./controllers/wallet.js";

// MUST match controllers/createAsset.js DEMO_SEED_AMOUNT (the live grant). It was
// 10000 here while the live seed is 1000 - running this backfill would have
// credited 10x the grant onto never-seeded wallets. Kept in lockstep at 1000.
const DEMO_SEED_COINS = ["USD"];
const DEMO_SEED_AMOUNT = 1000;

await mongoose.connect(config.DATABASE_URI);

const currencyList = await Currency.find({});
const walletList = await Wallet.find({});
console.log(
  `Backfilling ${walletList.length} wallet(s) against ${currencyList.length} currencies`
);

for (const walletData of walletList) {
  let changed = [];

  for (const currency of currencyList) {
    let asset = walletData.assets.find((el) => el.coin === currency.coin);
    if (!asset) {
      walletData.assets.push({
        _id: currency._id,
        currencyId: currency._id,
        coin: currency.coin,
        address: currency.type === "fiat" ? currency._id : "",
        privateKey: "",
        spotBal: 0,
      });
      asset = walletData.assets[walletData.assets.length - 1];
      changed.push(`+${currency.coin}`);
    } else if (!asset.currencyId) {
      asset.currencyId = currency._id;
      changed.push(`${currency.coin}.currencyId`);
    }

    if (DEMO_SEED_COINS.includes(currency.coin) && !asset.spotBal) {
      asset.spotBal = DEMO_SEED_AMOUNT;
      changed.push(`${currency.coin}=${DEMO_SEED_AMOUNT}`);
    }
  }

  if (changed.length === 0) {
    console.log(`${walletData._id} already up to date`);
    continue;
  }

  await walletData.save();
  // Redis is what the trading engines read, and the 10s backup cron writes it
  // back to Mongo — mirror immediately so the two cannot diverge.
  await updateUserWallet({ id: walletData._id });
  console.log(`${walletData._id} ${changed.join(" ")}`);
}

await mongoose.disconnect();
process.exit(0);
