/**
 * THE ONE PLACE A DEPTH SNAPSHOT COMES FROM.
 *
 * Both the synthetic ladder (controllers/paperBook.controller.js) and the
 * published display book (controllers/bookPublish.controller.js) resolve their
 * depth through this function, so "the book you can see" and "the book you can
 * trade" are literally the same numbers - not two reads of two caches that were
 * once the same.
 *
 * In-memory cache first (the live 100ms websocket), redis second (the mirror
 * lib/binanceWebSocket.js writes, which survives a matcher that starts before
 * the streams do).
 */

import { getDepthSnapshot } from "./binanceWebSocket.js";
import { get } from "../controllers/redis.controller.js";

/**
 * Read the redis depth mirror written by lib/binanceWebSocket.js.
 * Returns null when there is nothing usable to read.
 */
export const redisDepthFallback = async (pairId) => {
  try {
    let meta = await get(`depth_meta_binance_${pairId}`);
    if (!meta) return null;
    meta = JSON.parse(meta);
    const bidsRaw = await get(`buy_depth_binance_${pairId}`);
    const asksRaw = await get(`sell_depth_binance_${pairId}`);
    if (!bidsRaw || !asksRaw) return null;
    const bids = JSON.parse(bidsRaw);
    const asks = JSON.parse(asksRaw);
    if (!Array.isArray(bids) || !Array.isArray(asks)) return null;
    return {
      lastUpdateId: meta.lastUpdateId || 0,
      updatedAt: meta.ts || 0,
      bids: bids.sort((a, b) => b.price - a.price),
      asks: asks.sort((a, b) => a.price - b.price),
      source: "redis",
    };
  } catch (err) {
    return null;
  }
};

/**
 * The depth snapshot for a pair, or null. Bids best-first (descending), asks
 * best-first (ascending).
 */
export const resolveDepthSnapshot = async (pairId) => {
  const pid = String(pairId);
  const memory = getDepthSnapshot(pid);
  if (memory) {
    return memory.source ? memory : { ...memory, source: "memory" };
  }
  return await redisDepthFallback(pid);
};
