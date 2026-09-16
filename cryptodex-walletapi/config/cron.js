// import package
import cron from "node-cron";

// import config
import config from "../config/index.js";
import { priceCNV } from "../controllers/priceCNV.controller.js";
import { redisBackUpWalletByCron } from "../controllers/redisWalletBackUp.js";

/*
 * EVREY 5 MINS
 */
export const priceCNVCron = cron.schedule(
  "*/5 * * * *",
  () => {
    priceCNV();
  },
  { scheduled: false }
);

export const redisBackUpWallet = cron.schedule(
  "*/10 * * * * *",
  () => {
    redisBackUpWalletByCron();
  },
  {
    scheduled: false,
  }
);

redisBackUpWallet.start();
/// erc20MoveToAdminCron
// cron.schedule("* * * * *", async () => {
//   console.log("REFRESH_STATION");
//   require("../controllers/wallet.controller.js").refrshGasStation();
// });

// PAPER TRADING: the EVM sweep crons (erc20MoveToAdminCron, bep20MoveToAdminCron,
// polyTokenDepositCron) were removed — no on-chain custody in paper mode.

if (config.RUN_CRON == "true") {
  priceCNVCron.start();
  // Totalbalancecron.start();
}
