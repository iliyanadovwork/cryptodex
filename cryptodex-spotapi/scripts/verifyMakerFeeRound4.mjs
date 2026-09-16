/**
 * LIVE VERIFICATION - a PASSIVE spot limit order is charged the MAKER rate.
 *
 * Reads balances, places one small resting bid at the tradable best bid (so it
 * takes nothing and must be stamped `maker`), waits for the market to come to
 * it, and reports the exact arithmetic of the settlement against both published
 * rates. It never writes to any balance ledger itself - it places one ordinary
 * order as the developer's own test account and reads everything else.
 *
 * Run from the spot service directory:  node scripts/verifyMakerFeeRound4.mjs
 */

import redis from "redis";
import { encryptObject } from "../lib/cryptoJS.js";

const USER_API = "http://localhost:2567";
const SPOT_API = "http://localhost:2568";
const EMAIL = "papersmoke1@test.com";
const PASSWORD = "SmokeTest123!";

const PAIR_ID = "695bf1017573eeb15a749c9d"; // BTC/USD
const BTC_ID = "695bf0e2b9aba016fb8ce3c1";
const USD_ID = "695bf0e2b9aba016fb8ce3c4";
const QTY = 0.0002;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = redis.createClient({ host: "127.0.0.1", port: 6379, prefix: "cryptodex_" });
const hget = (key, field) =>
  new Promise((resolve, reject) =>
    client.hget(key, field, (err, val) => (err ? reject(err) : resolve(val)))
  );
const hgetall = (key) =>
  new Promise((resolve, reject) =>
    client.hgetall(key, (err, val) => (err ? reject(err) : resolve(val)))
  );

const bal = async (userId, currencyId) =>
  parseFloat((await hget("walletbalance_spot", `${userId}_${currencyId}`)) || 0);

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

const myOrders = async (side, userId) => {
  const all = (await hgetall(`${side}OpenOrders_${PAIR_ID}`)) || {};
  const rows = [];
  for (const raw of Object.values(all)) {
    try {
      const o = JSON.parse(raw);
      if (String(o.userId) === String(userId)) rows.push(o);
    } catch (e) {
      /* ignore */
    }
  }
  return rows;
};

const main = async () => {
  await new Promise((resolve, reject) => {
    client.on("ready", resolve);
    client.on("error", reject);
  });

  // ---- login -------------------------------------------------------------
  const loginRes = await fetch(`${USER_API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roleType: 1,
      email: EMAIL,
      password: PASSWORD,
      otpTextBox: false,
      langCode: "en",
    }),
  });
  const login = await loginRes.json();
  if (!login.token) {
    console.log("LOGIN FAILED", JSON.stringify(login).slice(0, 400));
    process.exit(1);
  }
  const token = login.token; // already carries "Bearer "
  const userId = login.result?._id || login.userId || login.result?.id;
  console.log("logged in as", userId);

  // ---- pair config, straight from the cache the matcher reads -------------
  const pair = JSON.parse(await hget("spotPairdata", PAIR_ID));
  const MAKER_PCT = parseFloat(pair.maker_rebate);
  const TAKER_PCT = parseFloat(pair.taker_fees);
  console.log(`pair ${pair.pairName}: maker_rebate ${MAKER_PCT}%  taker_fees ${TAKER_PCT}%`);

  // ---- the tradable top of book, and what the public endpoint says --------
  const top = await ladderTop();
  const listed = await (await fetch(`${SPOT_API}/api/spot/tradePair`)).json();
  const listedPair = listed.result.find((p) => p._id === PAIR_ID);
  console.log("ladder top      ", top);
  console.log("tradePair serves", {
    last_bid: listedPair.last_bid,
    last_ask: listedPair.last_ask,
    markPrice: listedPair.markPrice,
  });

  // ---- balances before ---------------------------------------------------
  const btc0 = await bal(userId, BTC_ID);
  const usd0 = await bal(userId, USD_ID);
  console.log("before: BTC", btc0, " USD", usd0);

  // ---- place ONE passive bid, at the tradable best bid --------------------
  // At the best bid it cannot cross the best ask, so it takes nothing and must
  // be stamped `maker`; it fills when the market ticks down onto it.
  const price = top.bestBuy;
  const body = {
    spotPairId: PAIR_ID,
    orderType: "limit",
    buyorsell: "buy",
    price,
    quantity: QTY,
  };
  const placeRes = await fetch(`${SPOT_API}/api/spot/orderPlace`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ token: encryptObject(body) }),
  });
  const place = await placeRes.json();
  console.log("placed:", placeRes.status, JSON.stringify(place).slice(0, 300));
  if (placeRes.status !== 200) process.exit(1);

  // ---- the stamp, as redis holds it --------------------------------------
  await sleep(300);
  let mine = await myOrders("buy", userId);
  const placed = mine.find((o) => parseFloat(o.price) === price);
  if (placed) {
    console.log(
      "stamped role:",
      placed.liquidityRole,
      " orderCode:",
      placed.orderCode,
      " _id:",
      placed._id
    );
  } else {
    console.log("order already gone from the book (filled immediately)");
  }
  const orderId = placed ? placed._id : null;

  // ---- wait for the fill -------------------------------------------------
  let filled = false;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    mine = await myOrders("buy", userId);
    if (!mine.some((o) => o._id === orderId)) {
      filled = true;
      break;
    }
  }
  if (!filled) {
    console.log("NOT FILLED within 90s - the market did not come down to", price);
    console.log("resting order still there; cancel it by hand if you want it gone");
    process.exit(2);
  }
  await sleep(1500);

  // ---- balances after, and the arithmetic --------------------------------
  const btc1 = await bal(userId, BTC_ID);
  const usd1 = await bal(userId, USD_ID);
  const btcGained = btc1 - btc0;
  const usdSpent = usd0 - usd1;
  const makerExpected = QTY * (1 - MAKER_PCT / 100);
  const takerExpected = QTY * (1 - TAKER_PCT / 100);

  console.log("");
  console.log("after : BTC", btc1, " USD", usd1);
  console.log("BTC credited      ", btcGained.toFixed(12));
  console.log("MAKER would credit", makerExpected.toFixed(12), "(qty - " + MAKER_PCT + "%)");
  console.log("TAKER would credit", takerExpected.toFixed(12), "(qty - " + TAKER_PCT + "%)");
  console.log("USD spent         ", usdSpent.toFixed(8), " limit price *", QTY, "=", (price * QTY).toFixed(8));
  console.log("");
  const isMaker = Math.abs(btcGained - makerExpected) < 1e-11;
  const isTaker = Math.abs(btcGained - takerExpected) < 1e-11;
  console.log(
    isMaker
      ? "RESULT: charged the MAKER rate. Correct."
      : isTaker
        ? "RESULT: charged the TAKER rate. THE DEFECT IS BACK."
        : "RESULT: neither published rate - " +
          ((1 - btcGained / QTY) * 100).toFixed(6) + "% charged"
  );

  client.quit();
  process.exit(isMaker ? 0 : 1);
};

main().catch((err) => {
  console.log("ERR", err);
  process.exit(1);
});
