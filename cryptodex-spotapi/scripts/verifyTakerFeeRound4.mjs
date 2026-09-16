/**
 * LIVE VERIFICATION - the complement of the maker case.
 *
 * Places one AGGRESSIVE limit buy at the tradable best ask (so it crosses and
 * must be stamped `taker`), waits for it to fill against the synthetic ladder,
 * and reports:
 *   - the rate it was actually charged, against both published rates,
 *   - that the house (admin liquidity) ledger did not move by a single unit
 *     across the fill, and
 *   - the persisted orderHistory stamp.
 *
 *   node scripts/verifyTakerFeeRound4.mjs
 */

import redis from "redis";
import mongoose from "mongoose";
import { encryptObject } from "../lib/cryptoJS.js";

const USER_API = "http://localhost:2567";
const SPOT_API = "http://localhost:2568";
const EMAIL = "papersmoke1@test.com";
const PASSWORD = "SmokeTest123!";

const PAIR_ID = "695bf1017573eeb15a749c9d";
const BTC_ID = "695bf0e2b9aba016fb8ce3c1";
const USD_ID = "695bf0e2b9aba016fb8ce3c4";
const SOL_ID = "695bf0e2b9aba016fb8ce3c2";
const ETH_ID = "695bf0e2b9aba016fb8ce3c3";
const ADMIN_ID = "695af33fe64f3be062b77bb4";
const QTY = 0.0002;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = redis.createClient({ host: "127.0.0.1", port: 6379, prefix: "cryptodex_" });
const hget = (k, f) =>
  new Promise((res, rej) => client.hget(k, f, (e, v) => (e ? rej(e) : res(v))));
const hgetall = (k) =>
  new Promise((res, rej) => client.hgetall(k, (e, v) => (e ? rej(e) : res(v))));
const bal = async (u, c) =>
  parseFloat((await hget("walletbalance_spot", `${u}_${c}`)) || 0);

const houseLedger = async () => ({
  USD: await bal(ADMIN_ID, USD_ID),
  BTC: await bal(ADMIN_ID, BTC_ID),
  SOL: await bal(ADMIN_ID, SOL_ID),
  ETH: await bal(ADMIN_ID, ETH_ID),
});

const ladderTop = async () => {
  const out = { bestBuy: null, bestSell: null };
  for (const side of ["buy", "sell"]) {
    const all = (await hgetall(`${side}OpenOrders_${PAIR_ID}`)) || {};
    for (const raw of Object.values(all)) {
      let o;
      try {
        o = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      if (o.isPaper !== true) continue;
      const p = parseFloat(o.price);
      if (!(p > 0)) continue;
      if (side === "buy") {
        if (out.bestBuy == null || p > out.bestBuy) out.bestBuy = p;
      } else if (out.bestSell == null || p < out.bestSell) out.bestSell = p;
    }
  }
  return out;
};

const main = async () => {
  await new Promise((resolve, reject) => {
    client.on("ready", resolve);
    client.on("error", reject);
  });

  const login = await (
    await fetch(`${USER_API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roleType: 1,
        email: EMAIL,
        password: PASSWORD,
        otpTextBox: false,
        langCode: "en",
      }),
    })
  ).json();
  const token = login.token;
  const userId = login.result?._id || login.userId;

  const pair = JSON.parse(await hget("spotPairdata", PAIR_ID));
  const MAKER_PCT = parseFloat(pair.maker_rebate);
  const TAKER_PCT = parseFloat(pair.taker_fees);

  const house0 = await houseLedger();
  const btc0 = await bal(userId, BTC_ID);
  const usd0 = await bal(userId, USD_ID);
  const top = await ladderTop();
  console.log("ladder top", top);
  console.log("house before", house0);

  const price = top.bestSell; // crosses: this order takes the resting ask
  const res = await fetch(`${SPOT_API}/api/spot/orderPlace`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({
      token: encryptObject({
        spotPairId: PAIR_ID,
        orderType: "limit",
        buyorsell: "buy",
        price,
        quantity: QTY,
      }),
    }),
  });
  console.log("placed:", res.status, JSON.stringify(await res.json()).slice(0, 200));
  if (res.status !== 200) process.exit(1);

  // find the order and its stamp before it is consumed
  let orderId = null;
  let stamp = null;
  for (let i = 0; i < 10 && !orderId; i++) {
    const all = (await hgetall(`buyOpenOrders_${PAIR_ID}`)) || {};
    for (const [id, raw] of Object.entries(all)) {
      const o = JSON.parse(raw);
      if (String(o.userId) === String(userId) && parseFloat(o.price) === price) {
        orderId = id;
        stamp = o.liquidityRole;
      }
    }
    if (!orderId) await sleep(100);
  }
  console.log("stamped role:", stamp, "orderId:", orderId);

  for (let i = 0; i < 60; i++) {
    const all = (await hgetall(`buyOpenOrders_${PAIR_ID}`)) || {};
    if (!Object.keys(all).includes(orderId)) break;
    await sleep(1000);
  }
  await sleep(2000);

  const btc1 = await bal(userId, BTC_ID);
  const usd1 = await bal(userId, USD_ID);
  const house1 = await houseLedger();

  console.log("");
  console.log("BTC credited      ", (btc1 - btc0).toFixed(12));
  console.log(`TAKER would credit ${(QTY * (1 - TAKER_PCT / 100)).toFixed(12)}  (qty - ${TAKER_PCT}%)`);
  console.log(`MAKER would credit ${(QTY * (1 - MAKER_PCT / 100)).toFixed(12)}  (qty - ${MAKER_PCT}%)`);
  console.log("USD spent         ", (usd0 - usd1).toFixed(8), " book price *", QTY, "=", (price * QTY).toFixed(8));
  console.log("");
  console.log("house after ", house1);
  const houseMoved = Object.keys(house0).some((k) => house0[k] !== house1[k]);
  console.log(houseMoved ? "HOUSE LEDGER MOVED - the synthetic was credited" : "house ledger unchanged to the last unit");

  await mongoose.connect("mongodb://127.0.0.1:27017/cryptodex_spot");
  const row = await mongoose.connection.db
    .collection("orderHistory")
    .findOne({ _id: new mongoose.Types.ObjectId(orderId) });
  console.log("orderHistory:", row && {
    status: row.status,
    liquidityRole: row.liquidityRole,
    filledQuantity: row.filledQuantity,
    price: row.price,
  });
  const trade = await mongoose.connection.db
    .collection("tradeHistory")
    .findOne({ buyOrderId: new mongoose.Types.ObjectId(orderId) });
  console.log("trade:", trade && {
    isMaker: trade.isMaker,
    execPrice: trade.execPrice,
    qty: trade.tradeQty,
    buyerFee: trade.buyerFee,
    sellerFee: trade.sellerFee,
  });
  await mongoose.disconnect();
  client.quit();
  process.exit(0);
};

main().catch((e) => {
  console.log("ERR", e);
  process.exit(1);
});
