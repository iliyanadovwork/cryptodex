// import model
import { SpotPair } from "../models/index.js";

// import config
import config from "../config/index.js";

// import controller
import { hset, hdel, hgetall } from "./redis.controller.js";

// grpc
import { currencyId } from "../grpc/currencyService.js";

const currencyImage = (curData) => {
  if (!curData || !curData.status || !curData.image) return "";
  return config.WALLET_URL + config.IMAGE.CURRENCY_URL_PATH + curData.image;
};

/**
 * Price / 24h statistics that only ever live in Redis: the binance streams
 * write them straight into the "spotPairdata" hash and mongo has no column for
 * most of them. Re-hydrating from mongo must not blank the last traded price of
 * a pair that is still real, so these are carried over from the cached copy
 * whenever the mongo document has no value of its own.
 */
const LIVE_ONLY_FIELDS = [
  "last",
  "markPrice",
  "prevMarkPrice",
  "low",
  "high",
  "firstVolume",
  "secondVolume",
  "changePrice",
  "change",
  "last_ask",
  "last_bid",
];

/**
 * Load the spot pairs from mongo into redis and drop every cached pair that no
 * longer exists in mongo.
 *
 * getPairList() (and the chart / dashboard / market endpoints) prefer the
 * "spotPairdata" hash and only fall back to mongo when it is completely empty,
 * so a hash left over from an older database keeps serving pairs whose _id
 * exists nowhere: the UI lists them, shows their frozen mark price and lets
 * users land on an untradable market. Making mongo authoritative on boot - and
 * pruning the leftovers - is what keeps the cache honest.
 */
export const loadPairsToRedis = async () => {
  try {
    const pairList = await SpotPair.find({}).lean();
    const cached = (await hgetall("spotPairdata")) || {};

    const validIds = new Set();

    for (const pairDoc of pairList) {
      const id = pairDoc._id.toString();
      validIds.add(id);

      let prev = {};
      if (cached[id]) {
        try {
          prev =
            typeof cached[id] === "string" ? JSON.parse(cached[id]) : cached[id];
        } catch (e) {
          prev = {};
        }
      }

      // mongo wins for every field it owns; the live-only price fields are kept
      const carried = {};
      for (const field of LIVE_ONLY_FIELDS) {
        if (
          (pairDoc[field] === undefined || pairDoc[field] === null) &&
          prev[field] !== undefined
        ) {
          carried[field] = prev[field];
        }
      }

      const baseCoinData = await currencyId({
        id: pairDoc.firstCurrencyId.toString(),
      });
      const quoteCoinData = await currencyId({
        id: pairDoc.secondCurrencyId.toString(),
      });

      await hset("spotPairdata", id, {
        ...JSON.parse(JSON.stringify(pairDoc)),
        ...carried,
        firstCurrencyImage:
          currencyImage(baseCoinData) || prev.firstCurrencyImage || "",
        secondCurrencyImage:
          currencyImage(quoteCoinData) || prev.secondCurrencyImage || "",
      });
    }

    // Prune: a cached pair whose document is gone from mongo is a phantom.
    let pruned = 0;
    for (const id of Object.keys(cached)) {
      if (!validIds.has(id)) {
        await hdel("spotPairdata", id);
        pruned++;
      }
    }

    console.log(
      "\x1b[33m%s\x1b[0m",
      `Loaded ${pairList.length} spot pairs to redis (pruned ${pruned} stale pair${
        pruned === 1 ? "" : "s"
      }).`
    );
    return { success: true, loaded: pairList.length, pruned };
  } catch (err) {
    console.log("Error on loadPairsToRedis(): ", err);
    return { success: false, loaded: 0, pruned: 0 };
  }
};

export default { loadPairsToRedis };
