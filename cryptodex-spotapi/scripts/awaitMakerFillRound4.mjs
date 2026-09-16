/**
 * Waits for the resting bid placed by verifyMakerFeeRound4.mjs to be hit, then
 * reports the exact settlement arithmetic against both published rates, plus
 * the persisted orderHistory row (the maker/taker stamp's round trip through
 * mongo) and the trade row the matcher wrote.
 *
 *   node scripts/awaitMakerFillRound4.mjs <orderId> <btcBefore> <usdBefore> <price>
 */

import redis from "redis";
import mongoose from "mongoose";

const PAIR_ID = "695bf1017573eeb15a749c9d";
const BTC_ID = "695bf0e2b9aba016fb8ce3c1";
const USD_ID = "695bf0e2b9aba016fb8ce3c4";
const USER_ID = "6a70f1c287c92c7218ac37fc";
const QTY = 0.0002;

const [orderId, btcBeforeArg, usdBeforeArg, priceArg] = process.argv.slice(2);
const btc0 = parseFloat(btcBeforeArg);
const usd0 = parseFloat(usdBeforeArg);
const price = parseFloat(priceArg);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = redis.createClient({ host: "127.0.0.1", port: 6379, prefix: "cryptodex_" });
const hget = (k, f) =>
  new Promise((res, rej) => client.hget(k, f, (e, v) => (e ? rej(e) : res(v))));
const hgetall = (k) =>
  new Promise((res, rej) => client.hgetall(k, (e, v) => (e ? rej(e) : res(v))));
const bal = async (u, c) =>
  parseFloat((await hget("walletbalance_spot", `${u}_${c}`)) || 0);

const stillResting = async () => {
  const all = (await hgetall(`buyOpenOrders_${PAIR_ID}`)) || {};
  return Object.keys(all).includes(orderId);
};

const main = async () => {
  await new Promise((resolve, reject) => {
    client.on("ready", resolve);
    client.on("error", reject);
  });

  const pair = JSON.parse(await hget("spotPairdata", PAIR_ID));
  const MAKER_PCT = parseFloat(pair.maker_rebate);
  const TAKER_PCT = parseFloat(pair.taker_fees);

  let filled = false;
  for (let i = 0; i < 600; i++) {
    if (!(await stillResting())) {
      filled = true;
      break;
    }
    if (i % 30 === 0) {
      const all = (await hgetall(`sellOpenOrders_${PAIR_ID}`)) || {};
      let bestSell = null;
      for (const raw of Object.values(all)) {
        try {
          const o = JSON.parse(raw);
          if (o.isPaper !== true) continue;
          const p = parseFloat(o.price);
          if (p > 0 && (bestSell == null || p < bestSell)) bestSell = p;
        } catch (e) {
          /* ignore */
        }
      }
      console.log(`[${i}s] waiting - my bid ${price}, ladder best ask ${bestSell}`);
    }
    await sleep(1000);
  }
  if (!filled) {
    console.log("STILL RESTING after 600s");
    client.quit();
    process.exit(2);
  }
  await sleep(2000);

  const btc1 = await bal(USER_ID, BTC_ID);
  const usd1 = await bal(USER_ID, USD_ID);
  const btcGained = btc1 - btc0;
  const usdSpent = usd0 - usd1;
  const makerExpected = QTY * (1 - MAKER_PCT / 100);
  const takerExpected = QTY * (1 - TAKER_PCT / 100);

  console.log("");
  console.log("FILLED.");
  console.log("BTC credited      ", btcGained.toFixed(12));
  console.log(`MAKER would credit ${makerExpected.toFixed(12)}  (qty - ${MAKER_PCT}%)`);
  console.log(`TAKER would credit ${takerExpected.toFixed(12)}  (qty - ${TAKER_PCT}%)`);
  console.log("USD spent         ", usdSpent.toFixed(8), " own limit price *", QTY, "=", (price * QTY).toFixed(8));

  const isMaker = Math.abs(btcGained - makerExpected) < 1e-11;
  const isTaker = Math.abs(btcGained - takerExpected) < 1e-11;
  console.log(
    isMaker
      ? "RESULT: MAKER rate. Correct."
      : isTaker
        ? "RESULT: TAKER rate. THE DEFECT IS BACK."
        : `RESULT: ${((1 - btcGained / QTY) * 100).toFixed(6)}% charged - neither published rate`
  );

  // ---- the persisted stamp, read straight out of mongo -------------------
  await mongoose.connect("mongodb://127.0.0.1:27017/cryptodex_spot");
  const oid = new mongoose.Types.ObjectId(orderId);
  const rows = await mongoose.connection.db
    .collection("orderHistory")
    .find({ _id: oid })
    .toArray();
  console.log("");
  if (rows.length === 0) {
    console.log("orderHistory: no row for", orderId);
  } else {
    const r = rows[0];
    console.log("orderHistory row:", {
      _id: r._id,
      status: r.status,
      liquidityRole: r.liquidityRole,
      filledQuantity: r.filledQuantity,
      price: r.price,
    });
  }
  const trades = await mongoose.connection.db
    .collection("tradeHistory")
    .find({ $or: [{ buyOrderId: oid }, { sellOrderId: oid }] })
    .sort({ _id: -1 })
    .limit(5)
    .toArray();
  for (const t of trades) {
    console.log("trade:", {
      isMaker: t.isMaker,
      execPrice: t.execPrice ?? t.tradePrice,
      qty: t.tradeQty ?? t.quantity,
      buyerFee: t.buyerFee,
      sellerFee: t.sellerFee,
    });
  }
  await mongoose.disconnect();
  client.quit();
  process.exit(isMaker ? 0 : 1);
};

main().catch((e) => {
  console.log("ERR", e);
  process.exit(1);
});
