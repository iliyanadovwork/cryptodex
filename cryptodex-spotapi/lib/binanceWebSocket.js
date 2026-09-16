import { SpotPair } from "../models/index.js";
import { socketEmitAll } from "../config/socketIO.js";
import { set } from "../controllers/redis.controller.js";
import WebSocket from "ws";

// Store WebSocket connections for management
const depthConnections = new Map(); // pairId -> WebSocket
const tradeConnections = new Map(); // pairId -> WebSocket
const reconnectTimers = new Map(); // pairId -> timer
const orderBookCache = new Map(); // pairId -> { bids: Map, asks: Map, lastUpdateId, seq, bufferedEvents }

// DESIRED state: pairId -> { pairName, binanceSymbol }. What SHOULD have a live
// depth stream. The watchdog reconciles the actual connections against this,
// which is the difference between "self-healing" and "healing only when a
// 'close' event happens to fire".
const depthStreams = new Map();
// pairId -> timestamp of the last DEPTH MESSAGE received. This, and only this,
// is what liveness is judged on.
//
// Protocol chatter deliberately does NOT count. Binance pings every ~20s, and
// counting a ping as life means a socket that is perfectly connected and
// perfectly useless - handshake alive, zero depth data - is never replaced.
// That is a real state (verified live: pings kept arriving while the book sat
// frozen for a minute), and for an @depth@100ms subscription on BTC/ETH/SOL,
// tens of seconds without a single depth message is broken by definition.
const depthActivity = new Map();
// pairId -> last ping/pong/open. Reporting only: it distinguishes "the peer is
// gone" from "the peer is talking to us but sending no data".
const depthProtocolActivity = new Map();

// Trade buffers to throttle updates (emit batches every 500ms instead of every trade)
const tradeBuffers = new Map(); // pairId -> Array of trades
const tradeTimers = new Map(); // pairId -> timer id

/**
 * How often the trade tape is published, and how deep the buffer behind it is.
 *
 * The flush used to be a trailing DEBOUNCE with no maxWait: every arriving
 * print cleared the pending timer and set a new 500ms one, so the tape was
 * published only after the upstream feed had been SILENT for a full 500ms.
 * On a market printing tens of times a second that almost never happens on
 * schedule, and the cadence inverts - the busier the market, the staler the
 * tape. Measured against the live BTCUSDT feed: one emit every ~1.7s, worst
 * gap 7.2s, and 86% of prints dropped by a 20-slot buffer that overflowed
 * during every burst.
 *
 * A fixed-interval throttle instead: the first print after a quiet period
 * schedules a flush, and every print until that flush rides along with it.
 * The interval is therefore an upper bound on staleness rather than a
 * hope. The buffer matches the client's MAX_TRADE_ROWS so a flush can never
 * drop a print the panel would have had room to show.
 */
const TRADE_FLUSH_MS = 250;
const TRADE_BUFFER_MAX = 60;

// How often the display publishes when the venue is quiet. The depth stream
// drives a publish on every update (~100ms) when it is healthy; this heartbeat
// exists so that a book which has GONE UNHEALTHY still gets republished - a
// dead feed produces no depth events at all, and without a clock of its own the
// UI would keep rendering the last healthy payload forever.
const PUBLISH_HEARTBEAT_MS = Number(
  process.env.BOOK_PUBLISH_HEARTBEAT_MS || 1000
);
// Every Nth heartbeat is labelled SNAPSHOT rather than DELTA.
const HEARTBEAT_SNAPSHOT_EVERY = 30;
const publishTimers = new Map(); // pairId -> interval id
const heartbeatTicks = new Map(); // pairId -> tick counter

// Redis depth mirror write throttle. The mirror is a FALLBACK for consumers
// that start before the streams do; it does not need to be rewritten 10x a
// second per pair.
const REDIS_MIRROR_MS = 1000;
const lastMirrorWrite = new Map(); // pairId -> timestamp

// ---------------------------------------------------------------------------
// DEPTH STREAM WATCHDOG
//
// The reconnect chain used to be: 'close' -> setTimeout(5s) -> snapshot ->
// startDepthStream. Every link depends on the FIRST one, and a socket can die
// without ever emitting 'close' - a half-open TCP connection after a sleep/wake
// or a NAT rebind stays ESTABLISHED in the kernel and simply stops delivering
// data. That is precisely what happened here: the process still held three
// ESTABLISHED sockets to Binance while zero depth updates arrived, the
// re-entry guard `if (depthConnections.has(pairId)) return` kept refusing to
// start a replacement, and only the (cache-echoing) 30s timer kept the display
// looking alive.
//
// So liveness is measured by DATA, not by events: if a depth stream has been
// silent for longer than a stream that ticks every 100ms ever legitimately is,
// it is terminated and rebuilt - whether or not anything ever told us it died.
// ---------------------------------------------------------------------------
const DEPTH_WATCHDOG_INTERVAL_MS = Number(
  process.env.BINANCE_DEPTH_WATCHDOG_MS || 10000
);
const DEPTH_SILENCE_MS = Number(process.env.BINANCE_DEPTH_SILENCE_MS || 30000);
// A cache stuck at lastUpdateId 0 is desynced: handleDepthUpdate zeroes it on a
// sequence gap and waits for a REST snapshot to restore it. If that snapshot
// request fails, nothing ever retries and every subsequent event is buffered
// forever - a stream that looks perfectly alive and publishes nothing.
const DEPTH_DESYNC_RECOVERY_MS = Number(
  process.env.BINANCE_DEPTH_DESYNC_MS || 15000
);
// Ceiling on the resync buffer so a permanent desync cannot eat the heap.
const MAX_BUFFERED_EVENTS = 2000;
const RECONNECT_DELAY_MS = Number(
  process.env.BINANCE_DEPTH_RECONNECT_MS || 5000
);
// pairIds whose reconnect is mid-flight (snapshot in progress).
const reconnecting = new Set();
let watchdogTimer = null;

const markDepthActivity = (pairId, now = Date.now()) => {
  depthActivity.set(String(pairId), now);
  depthProtocolActivity.set(String(pairId), now);
};

const markDepthProtocol = (pairId, now = Date.now()) => {
  depthProtocolActivity.set(String(pairId), now);
};

// ---------------------------------------------------------------------------
// PUBLISH SEAM
//
// This module owns the depth CACHE; controllers/bookPublish.controller.js owns
// what the world is told about it. Wiring the publisher in (server.js) instead
// of importing it keeps the dependency one-way: the publisher reads
// getDepthSnapshot from here, and nothing here needs to know about redis
// ladders, socket payload shapes or health verdicts.
// ---------------------------------------------------------------------------
let depthListener = null;
let missingListenerWarned = false;

export const setDepthListener = (fn) => {
  depthListener = typeof fn === "function" ? fn : null;
};

const notifyDepthListener = (pairId, type) => {
  if (!depthListener) {
    if (!missingListenerWarned) {
      missingListenerWarned = true;
      console.log(
        "[BinanceWS] no depth listener registered - the order book will NOT publish. Call setDepthListener() at boot."
      );
    }
    return;
  }
  try {
    const result = depthListener(String(pairId), type);
    if (result && typeof result.catch === "function") {
      result.catch((err) =>
        console.log("[BinanceWS] publish error:", err && err.message)
      );
    }
  } catch (err) {
    console.log("[BinanceWS] publish error:", err && err.message);
  }
};

/**
 * Fetch initial orderbook snapshot via REST API
 * This is the authoritative starting point
 */
const fetchDepthSnapshot = async (pairId, pairName, binanceSymbol) => {
  try {
    const axios = (await import("axios")).default;
    const response = await axios.get("https://api.binance.com/api/v3/depth", {
      // limit=1000, not 100. The grouped ladders are aggregated from this book,
      // and depth is what a coarse bucket is made of: measured on BTCUSDT, 100
      // levels span ~$17 (3 buckets at a $10 step) while 1000 span ~$200 (21).
      // Fetched once per stream start / resync, never per tick - weight 50.
      params: { symbol: binanceSymbol, limit: 1000 },
      timeout: 10000,
    });

    const depth = response.data;
    const cache = orderBookCache.get(pairId);

    if (cache && depth.bids && depth.asks) {
      // Clear existing cache
      cache.bids.clear();
      cache.asks.clear();
      // Clear any buffered events - snapshot resets state
      cache.bufferedEvents = [];

      // Populate bids (buy orders) - sorted descending by price
      for (const bid of depth.bids) {
        const price = parseFloat(bid[0]);
        const quantity = parseFloat(bid[1]);
        if (quantity > 0) {
          cache.bids.set(price, { price, quantity });
        }
      }

      // Populate asks (sell orders) - sorted ascending by price
      for (const ask of depth.asks) {
        const price = parseFloat(ask[0]);
        const quantity = parseFloat(ask[1]);
        if (quantity > 0) {
          cache.asks.set(price, { price, quantity });
        }
      }

      // Store lastUpdateId to sync with depth stream
      cache.lastUpdateId = depth.lastUpdateId;
      cache.updatedAt = Date.now();
      // Resynced: the desync clock stops here.
      cache.desyncSince = 0;

      console.log(`[BinanceWS] Fetched depth snapshot for ${pairName}: ${cache.bids.size} bids, ${cache.asks.size} asks, lastUpdateId=${depth.lastUpdateId}`);

      // Emit initial orderbook as SNAPSHOT
      emitOrderBook(pairId, pairName, "SNAPSHOT");

      return true;
    }
    return false;
  } catch (err) {
    console.log(`[BinanceWS] Error fetching depth snapshot for ${pairName}:`, err.message);
    return false;
  }
};

/**
 * Process buffered depth events
 * Called after we have a snapshot and a valid lastUpdateId
 */
const processBufferedEvents = (pairId, pairName) => {
  const cache = orderBookCache.get(pairId);
  if (!cache || !cache.bufferedEvents || cache.bufferedEvents.length === 0) {
    return;
  }

  console.log(`[BinanceWS] Processing ${cache.bufferedEvents.length} buffered events for ${pairName}`);

  const validEvents = [];
  let foundFirstValid = false;

  for (const event of cache.bufferedEvents) {
    // Only start applying events once we find one that covers the snapshot
    if (!foundFirstValid) {
      if (event.firstUpdateId <= cache.lastUpdateId && event.lastUpdateId >= cache.lastUpdateId) {
        foundFirstValid = true;
      }
    }

    if (foundFirstValid) {
      validEvents.push(event);
    }
  }

  // Apply valid buffered events in order
  for (const event of validEvents) {
    applyDepthEvent(cache, event);
  }

  // Clear buffer and emit
  cache.bufferedEvents = [];
  emitOrderBook(pairId, pairName, "DELTA");
};

/**
 * Apply a depth update event to the cache
 */
const applyDepthEvent = (cache, event) => {
  // Update bids (buy orders)
  for (const bid of event.bids) {
    const price = parseFloat(bid[0]);
    const quantity = parseFloat(bid[1]);

    if (quantity === 0) {
      cache.bids.delete(price);
    } else {
      cache.bids.set(price, { price, quantity });
    }
  }

  // Update asks (sell orders)
  for (const ask of event.asks) {
    const price = parseFloat(ask[0]);
    const quantity = parseFloat(ask[1]);

    if (quantity === 0) {
      cache.asks.delete(price);
    } else {
      cache.asks.set(price, { price, quantity });
    }
  }

  // Update lastUpdateId
  cache.lastUpdateId = event.lastUpdateId;
  cache.updatedAt = Date.now();
};

/**
 * Write the raw depth mirror to redis.
 *
 * This is the FALLBACK SOURCE (lib/depthSource.js reads it), not the display:
 * it stores raw price/quantity levels and an age marker, and nothing decides
 * from it whether the book is healthy. Throttled - the mirror only has to be
 * roughly current, and the websocket updates ten times a second.
 */
const mirrorDepthToRedis = (pairId, force = false) => {
  try {
    const cache = orderBookCache.get(pairId);
    if (!cache) return;
    const now = Date.now();
    if (!force && now - (lastMirrorWrite.get(pairId) || 0) < REDIS_MIRROR_MS) {
      return;
    }
    lastMirrorWrite.set(pairId, now);

    const bids = Array.from(cache.bids.values())
      .sort((a, b) => b.price - a.price)
      .slice(0, 20)
      .map((l) => ({ price: l.price, quantity: l.quantity }));
    const asks = Array.from(cache.asks.values())
      .sort((a, b) => a.price - b.price)
      .slice(0, 20)
      .map((l) => ({ price: l.price, quantity: l.quantity }));

    set(`buy_depth_binance_${pairId}`, JSON.stringify(bids));
    set(`sell_depth_binance_${pairId}`, JSON.stringify(asks));
    // Age marker so consumers of the redis depth fallback can tell whether it
    // is still live. Written from cache.updatedAt, NOT Date.now(): stamping a
    // fresh timestamp on a frozen cache is how a dead feed passes a staleness
    // check.
    set(
      `depth_meta_binance_${pairId}`,
      JSON.stringify({
        ts: cache.updatedAt || 0,
        lastUpdateId: cache.lastUpdateId,
      })
    );
  } catch (err) {
    console.log("[BinanceWS] Error mirroring depth to redis:", err.message);
  }
};

/**
 * A depth update landed: mirror it and let the publisher decide what the world
 * is told.
 *
 * Nothing here builds a display payload any more. The published book is derived
 * once, in controllers/bookPublish.controller.js, from the same snapshot and
 * behind the same health gate as the tradable ladder - see the header there for
 * why a second derivation in this file was the whole bug.
 */
const emitOrderBook = (pairId, pairName, type = "DELTA") => {
  mirrorDepthToRedis(pairId, type === "SNAPSHOT");
  notifyDepthListener(pairId, type);
};

/**
 * Publish heartbeat.
 *
 * The old timer here re-emitted the CACHE every 30s and called it a "snapshot
 * refresh", which is why a frozen book kept looking freshly delivered. This one
 * does not touch the cache at all: it just asks the publisher to restate the
 * truth on a fixed clock, so a book that has gone unhealthy goes empty in the
 * UI even though a dead feed is producing no events to ride on.
 */
const startPublishHeartbeat = (pairId, pairName) => {
  const existing = publishTimers.get(pairId);
  if (existing) {
    clearInterval(existing);
  }
  const timer = setInterval(() => {
    const ticks = (heartbeatTicks.get(pairId) || 0) + 1;
    heartbeatTicks.set(pairId, ticks);
    notifyDepthListener(
      pairId,
      ticks % HEARTBEAT_SNAPSHOT_EVERY === 0 ? "SNAPSHOT" : "DELTA"
    );
  }, PUBLISH_HEARTBEAT_MS);
  if (typeof timer.unref === "function") timer.unref();
  publishTimers.set(pairId, timer);
};

/**
 * Initialize Binance WebSocket streams for all active pairs
 */
export const startBinanceWebSockets = async () => {
  try {
    console.log('[BinanceWS] Starting WebSocket streams...');

    const pairs = await SpotPair.find({ status: 'active', botstatus: 'binance' }).lean();
    console.log(`[BinanceWS] Found ${pairs.length} active pairs`);

    for (const pair of pairs) {
      const pairName = pair.tikerRoot || `${pair.firstCurrencySymbol}${pair.secondCurrencySymbol}`;
      const binanceSymbol = pair.secondCurrencySymbol === "USD"
        ? pair.firstCurrencySymbol + "USDT"
        : pair.firstCurrencySymbol + pair.secondCurrencySymbol;

      // Initialize orderbook cache for this pair
      orderBookCache.set(pair._id.toString(), {
        bids: new Map(), // price -> { price, quantity }
        asks: new Map(),
        lastUpdateId: 0,
        bufferedEvents: [], // Buffer events until snapshot is synced
        updatedAt: 0,
        desyncSince: 0,
      });

      // Fetch initial depth snapshot first
      await fetchDepthSnapshot(pair._id.toString(), pairName, binanceSymbol);

      // Start depth stream for this pair (after snapshot)
      startDepthStream(pair._id.toString(), pairName, binanceSymbol);

      // Start trade stream for this pair
      startTradeStream(pair._id.toString(), pairName, binanceSymbol);

      // Republish the book on a fixed clock, so an unhealthy book still reaches
      // the UI when the feed has stopped producing events entirely.
      startPublishHeartbeat(pair._id.toString(), pairName);
    }

    // Self-healing: reconciles connections against `depthStreams` every tick,
    // instead of trusting a reconnect chain that only fires on a 'close' event
    // the process may never receive.
    startDepthWatchdog();

    console.log('[BinanceWS] WebSocket streams started successfully');
  } catch (err) {
    console.log('[BinanceWS] Error starting streams:', err.message);
  }
};

/**
 * Reset the depth cache for a pair IN PLACE.
 *
 * Deleting the cache entry made fetchDepthSnapshot a silent no-op (its whole
 * body is guarded by `if (cache && ...)`) and handleDepthUpdate bail on
 * `if (!cache) return`, permanently killing the book for that pair.
 */
const resetDepthCache = (pairId) => {
  const c = orderBookCache.get(pairId);
  if (c) {
    c.bids.clear();
    c.asks.clear();
    c.lastUpdateId = 0;
    c.bufferedEvents = [];
    c.updatedAt = 0;
    c.desyncSince = 0;
  } else {
    orderBookCache.set(pairId, {
      bids: new Map(),
      asks: new Map(),
      lastUpdateId: 0,
      bufferedEvents: [],
      updatedAt: 0,
      desyncSince: 0,
    });
  }
};

/**
 * Schedule a reconnect: fresh REST snapshot, then a fresh stream.
 *
 * Reads the pair's desired state from `depthStreams` rather than closing over
 * it, so a reconnect scheduled by the watchdog and one scheduled by a 'close'
 * event are the same code path, and a pair that has since been stopped is not
 * resurrected.
 */
const scheduleDepthReconnect = (pairId, delay = RECONNECT_DELAY_MS) => {
  const existing = reconnectTimers.get(pairId);
  if (existing) {
    clearTimeout(existing);
  }
  const timerId = setTimeout(async () => {
    reconnectTimers.delete(pairId);
    const desired = depthStreams.get(pairId);
    if (!desired) return;
    // Held across the REST snapshot below: for that whole window the pair has
    // no connection and no pending timer, and a watchdog tick landing in it
    // would otherwise queue a second, redundant reconnect.
    reconnecting.add(pairId);
    try {
      resetDepthCache(pairId);
      try {
        await fetchDepthSnapshot(pairId, desired.pairName, desired.binanceSymbol);
      } catch (err) {
        // fetchDepthSnapshot swallows its own errors; belt and braces so a
        // throw can never break the chain to startDepthStream below - which is
        // how the stream stayed down last time.
        console.log(`[BinanceWS] snapshot failed during reconnect for ${desired.pairName}:`, err.message);
      }
      startDepthStream(pairId, desired.pairName, desired.binanceSymbol);
    } finally {
      reconnecting.delete(pairId);
    }
  }, delay);
  reconnectTimers.set(pairId, timerId);
};

/**
 * Tear down a depth stream and rebuild it immediately.
 *
 * `terminate()`, not `close()`: a socket that has stopped delivering data will
 * not complete a closing handshake either, and close() would just hang. The
 * connection is dropped from the map FIRST so the 'close' terminate triggers is
 * recognised as superseded and does not schedule a second reconnect.
 */
export const restartDepthStream = (pairId, reason) => {
  const pid = String(pairId);
  const ws = depthConnections.get(pid);
  depthConnections.delete(pid);
  if (ws) {
    try {
      ws.terminate();
    } catch (err) {
      // already dead
    }
  }
  console.log(`[BinanceWS] depth watchdog: restarting stream for ${pid} (${reason})`);
  scheduleDepthReconnect(pid, 0);
};

/**
 * Start depth stream for a specific pair
 */
const startDepthStream = (pairId, pairName, binanceSymbol) => {
  // Record what SHOULD be running before anything can fail, so the watchdog can
  // rebuild this stream even if the connection below never gets off the ground.
  depthStreams.set(pairId, { pairName, binanceSymbol });

  // Guard against stacking connections for a pair that already has one.
  // NOTE: the map is now populated at CREATION, not on 'open' (see below), so
  // this also covers a socket that is still connecting - which the old guard
  // did not, letting a slow connect stack duplicate streams.
  if (depthConnections.has(pairId)) return;
  const wsUrl = `wss://stream.binance.com:9443/ws/${binanceSymbol.toLowerCase()}@depth@100ms`;

  const connectDepth = () => {
    try {
      const ws = new WebSocket(wsUrl);
      // REGISTERED IMMEDIATELY. Registering on 'open' meant a socket that never
      // opened was invisible to every other part of this module, and a socket
      // that opened and later died silently could not be replaced because the
      // guard above still saw the corpse. The watchdog kills anything that is
      // registered but not delivering, so a connection that never opens is torn
      // down after DEPTH_SILENCE_MS rather than blocking the pair forever.
      depthConnections.set(pairId, ws);
      markDepthActivity(pairId);

      ws.on('open', () => {
        console.log(`[BinanceWS] Depth stream connected for ${pairName}`);
        markDepthProtocol(pairId);
      });

      ws.on('message', (data) => {
        // Liveness is measured HERE, on real DEPTH DATA from the venue - not on
        // connection events (which a half-open socket never emits) and not on
        // pings (which keep arriving on a connection that has stopped
        // delivering anything worth having).
        markDepthActivity(pairId);
        try {
          const message = JSON.parse(data.toString());

          // Handle depth update
          if (message.e === 'depthUpdate') {
            handleDepthUpdate(pairId, pairName, message, binanceSymbol);
          }
        } catch (err) {
          // Ignore parse errors for partial messages
        }
      });

      // Binance pings every ~20s and `ws` auto-pongs. Recorded for diagnosis
      // only - see depthProtocolActivity: a ping proves the peer is there, not
      // that the subscription is still delivering.
      ws.on('ping', () => markDepthProtocol(pairId));
      ws.on('pong', () => markDepthProtocol(pairId));

      ws.on('error', (err) => {
        console.log(`[BinanceWS] Depth stream error for ${pairName}:`, err.message);
      });

      ws.on('close', () => {
        // Only the socket that is CURRENTLY registered may act on its own
        // close. A late close from a superseded socket used to delete the live
        // connection from the map and schedule a duplicate stream.
        if (depthConnections.get(pairId) !== ws) return;
        console.log(`[BinanceWS] Depth stream closed for ${pairName}, reconnecting...`);
        depthConnections.delete(pairId);
        scheduleDepthReconnect(pairId, RECONNECT_DELAY_MS);
      });
    } catch (err) {
      console.log(`[BinanceWS] Error creating depth stream for ${pairName}:`, err.message);
      // `new WebSocket` threw, so there is no socket to emit 'close': without
      // this the pair would simply never be retried.
      depthConnections.delete(pairId);
      scheduleDepthReconnect(pairId, RECONNECT_DELAY_MS);
    }
  };

  connectDepth();
};

/**
 * Reconcile actual depth connections against the desired set, once per tick.
 *
 * Exported so it can be driven deterministically in tests.
 */
export const runDepthWatchdog = (now = Date.now()) => {
  const actions = [];
  for (const [pairId, desired] of depthStreams) {
    const ws = depthConnections.get(pairId);
    const pendingReconnect =
      reconnectTimers.has(pairId) || reconnecting.has(pairId);

    if (!ws) {
      // No connection and nothing on the way: the reconnect chain was never
      // started, or it was lost. This is the case a close-event-driven design
      // can never recover from.
      if (!pendingReconnect) {
        actions.push({ pairId, action: "reconnect", reason: "no_connection" });
        scheduleDepthReconnect(pairId, 0);
      }
      continue;
    }

    const silentFor = now - (depthActivity.get(pairId) || 0);
    if (silentFor > DEPTH_SILENCE_MS) {
      const protocolFor = now - (depthProtocolActivity.get(pairId) || 0);
      actions.push({ pairId, action: "restart", reason: `silent_${silentFor}ms` });
      restartDepthStream(
        pairId,
        `no depth data for ${silentFor}ms (last protocol frame ${protocolFor}ms ago)`
      );
      continue;
    }

    // Alive, but desynced: stuck at lastUpdateId 0 with events piling into the
    // resync buffer because the recovery snapshot failed and nobody retried.
    const cache = orderBookCache.get(pairId);
    if (
      cache &&
      cache.lastUpdateId === 0 &&
      cache.desyncSince &&
      now - cache.desyncSince > DEPTH_DESYNC_RECOVERY_MS
    ) {
      cache.desyncSince = now;
      actions.push({ pairId, action: "resnapshot", reason: "desynced" });
      console.log(`[BinanceWS] depth watchdog: re-snapshotting ${desired.pairName} (desynced)`);
      fetchDepthSnapshot(pairId, desired.pairName, desired.binanceSymbol).then(
        (ok) => {
          if (ok) processBufferedEvents(pairId, desired.pairName);
        }
      );
    }
  }
  return actions;
};

/**
 * Start the watchdog. Idempotent.
 */
export const startDepthWatchdog = () => {
  if (watchdogTimer) return watchdogTimer;
  watchdogTimer = setInterval(() => {
    try {
      runDepthWatchdog();
    } catch (err) {
      console.log("[BinanceWS] depth watchdog error:", err.message);
    }
  }, DEPTH_WATCHDOG_INTERVAL_MS);
  if (typeof watchdogTimer.unref === "function") watchdogTimer.unref();
  return watchdogTimer;
};

/**
 * Operational view of every depth stream: what is connected, how long it has
 * been silent, and whether its cache is synced. This is the signal that was
 * missing when the streams sat dead for hours.
 */
export const getDepthStreamHealth = (now = Date.now()) =>
  Array.from(depthStreams.entries()).map(([pairId, desired]) => {
    const cache = orderBookCache.get(pairId);
    return {
      pairId,
      pairName: desired.pairName,
      symbol: desired.binanceSymbol,
      connected: depthConnections.has(pairId),
      readyState: depthConnections.get(pairId)
        ? depthConnections.get(pairId).readyState
        : null,
      silentForMs: now - (depthActivity.get(pairId) || 0),
      protocolSilentForMs: now - (depthProtocolActivity.get(pairId) || 0),
      reconnectPending:
        reconnectTimers.has(pairId) || reconnecting.has(pairId),
      lastUpdateId: cache ? cache.lastUpdateId : 0,
      depthAgeMs: cache && cache.updatedAt ? now - cache.updatedAt : null,
      bufferedEvents: cache && cache.bufferedEvents ? cache.bufferedEvents.length : 0,
    };
  });

/**
 * Start trade stream for a specific pair
 */
const startTradeStream = (pairId, pairName, binanceSymbol) => {
  // @aggTrade, not @trade. The raw stream emits one message per FILL, so a
  // single taker order sweeping several resting makers prints a row per maker
  // - identical in time, price, size and side, and meaningless to read as
  // separate events. @aggTrade rolls one taker order into one print, which is
  // what an exchange tape shows (Binance's own Market Trades panel included),
  // and it cuts BTCUSDT from ~40 messages/sec to ~13 for the same information.
  const wsUrl = `wss://stream.binance.com:9443/ws/${binanceSymbol.toLowerCase()}@aggTrade`;

  const connectTrade = () => {
    try {
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        console.log(`[BinanceWS] Trade stream connected for ${pairName}`);
        tradeConnections.set(pairId, ws);
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());

          // The aggregated stream names itself 'aggTrade'; 'trade' is kept so a
          // rollback of the URL above does not silently stop the tape.
          if (message.e === 'aggTrade' || message.e === 'trade') {
            handleTradeUpdate(pairId, pairName, message);
          }
        } catch (err) {
          // Ignore parse errors
        }
      });

      ws.on('error', (err) => {
        console.log(`[BinanceWS] Trade stream error for ${pairName}:`, err.message);
      });

      ws.on('close', () => {
        console.log(`[BinanceWS] Trade stream closed for ${pairName}, reconnecting...`);
        tradeConnections.delete(pairId);

        // Reconnect after 5 seconds
        setTimeout(() => {
          startTradeStream(pairId, pairName, binanceSymbol);
        }, 5000);
      });
    } catch (err) {
      console.log(`[BinanceWS] Error creating trade stream for ${pairName}:`, err.message);
    }
  };

  connectTrade();
};

/**
 * Handle depth update from Binance WebSocket
 * Implements proper snapshot + buffered diffs with updateId continuity
 */
const handleDepthUpdate = (pairId, pairName, message, binanceSymbol) => {
  try {
    const cache = orderBookCache.get(pairId);
    if (!cache) return;

    const firstUpdateId = message.U;
    const lastUpdateId = message.u;

    // Check if we have a snapshot
    if (cache.lastUpdateId === 0) {
      // No snapshot yet, buffer this event
      if (!cache.desyncSince) {
        // When the desync started, so the watchdog can retry a recovery
        // snapshot that failed instead of buffering into the void forever.
        cache.desyncSince = Date.now();
      }
      cache.bufferedEvents.push({
        bids: message.b,
        asks: message.a,
        firstUpdateId,
        lastUpdateId,
        timestamp: message.E
      });
      // Bounded: a desync that outlives its recovery must not eat the heap.
      // The oldest events are the ones a fresh snapshot will discard anyway.
      if (cache.bufferedEvents.length > MAX_BUFFERED_EVENTS) {
        cache.bufferedEvents.splice(0, cache.bufferedEvents.length - MAX_BUFFERED_EVENTS);
      }
      return;
    }

    // Check for continuity break
    // Expected: lastUpdateId < firstUpdateId <= lastUpdateId
    if (firstUpdateId > cache.lastUpdateId + 1 || lastUpdateId < cache.lastUpdateId) {
      console.log(`[BinanceWS] Sequence gap detected! lastUpdateId=${cache.lastUpdateId}, incoming U=${firstUpdateId}-${lastUpdateId}`);
      // Sequence broken - need fresh snapshot
      // Don't apply this update, fetch fresh snapshot instead.
      // Reset lastUpdateId first so events arriving while the snapshot is in
      // flight are buffered instead of triggering another snapshot request.
      cache.lastUpdateId = 0;
      cache.desyncSince = Date.now();
      fetchDepthSnapshot(pairId, pairName, binanceSymbol).then((ok) => {
        // After snapshot, process any buffered events. If the snapshot FAILED,
        // leave desyncSince alone: the watchdog retries it, which is the only
        // thing standing between a failed recovery and a stream that stays
        // alive while publishing nothing.
        if (ok) processBufferedEvents(pairId, pairName);
      });
      return;
    }

    // Update bids (buy orders)
    for (const bid of message.b) {
      const price = parseFloat(bid[0]);
      const quantity = parseFloat(bid[1]);

      if (quantity === 0) {
        cache.bids.delete(price);
      } else {
        cache.bids.set(price, { price, quantity });
      }
    }

    // Update asks (sell orders)
    for (const ask of message.a) {
      const price = parseFloat(ask[0]);
      const quantity = parseFloat(ask[1]);

      if (quantity === 0) {
        cache.asks.delete(price);
      } else {
        cache.asks.set(price, { price, quantity });
      }
    }

    // Update lastUpdateId
    cache.lastUpdateId = lastUpdateId;
    cache.updatedAt = Date.now();

    // Emit orderbook as DELTA
    emitOrderBook(pairId, pairName, "DELTA");
  } catch (err) {
    console.log('[BinanceWS] Error handling depth update:', err.message);
  }
};

/**
 * Flush trade buffer for a pair - emits all buffered trades
 */
const flushTradeBuffer = (pairId, pairName) => {
  // Release the timer slot FIRST. The scheduled flush has now run, and the
  // throttle in handleTradeUpdate treats an occupied slot as "a flush is
  // already coming". The empty-buffer early return below used to skip this
  // delete, which under a debounce was harmless - the next print overwrote
  // the slot anyway - but under a throttle would strand it forever and stop
  // the pair publishing for the rest of the process's life.
  tradeTimers.delete(pairId);

  const buffer = tradeBuffers.get(pairId);
  if (!buffer || buffer.length === 0) return;

  // One line per flush is 4/sec of log; count them instead.
  if (!global.tradeFlushCounter) global.tradeFlushCounter = 0;
  global.tradeFlushCounter++;
  if (global.tradeFlushCounter % 200 === 0) {
    console.log(`[BinanceWS] ${global.tradeFlushCounter} trade flushes; last was ${buffer.length} trades for ${pairName}`);
  }

  // Emit all buffered trades at once
  socketEmitAll("recentTrade", { data: buffer, pairId: pairId });

  // Clear buffer
  tradeBuffers.set(pairId, []);
};

/**
 * Handle trade update from Binance WebSocket
 * Formats trades to match frontend expectations and throttles emissions
 */
const handleTradeUpdate = (pairId, pairName, message) => {
  try {
    // Transform Binance trade format to match frontend expected format
    const trade = {
      // Binance's own trade id, carried through as `_id` because it is the
      // ONLY field that separates the fills of one sweep. An aggressive order
      // crossing several makers at one price prints several trades sharing
      // millisecond, price, size and side; without an id the client dedupes
      // them into a single row and the tape silently loses most of its depth.
      // Measured on the live REST window: 50 prints collapsed to 18 rows.
      // @aggTrade calls it `a`, @trade calls it `t`; ?? keeps id 0 usable.
      _id: message.a ?? message.t,
      createdAt: message.T || message.time || Date.now(), // Unix timestamp in ms
      Type: message.m ? "sell" : "buy",  // isBuyerMaker: true = sell order, false = buy order
      tradePrice: parseFloat(message.p || message.price),
      tradeQty: parseFloat(message.q || message.qty),
    };

    // Log trade for debugging (every 50th trade to avoid spam)
    if (!global.tradeCounter) global.tradeCounter = 0;
    global.tradeCounter++;
    if (global.tradeCounter % 50 === 0) {
      console.log(`[BinanceWS] Processed ${global.tradeCounter} trades total`);
    }

    // Get or create buffer for this pair
    if (!tradeBuffers.has(pairId)) {
      tradeBuffers.set(pairId, []);
    }
    const buffer = tradeBuffers.get(pairId);

    // Add trade to buffer (keep the newest TRADE_BUFFER_MAX)
    buffer.push(trade);
    if (buffer.length > TRADE_BUFFER_MAX) {
      buffer.shift(); // Remove oldest trade
    }

    // Throttle: the first print after a flush schedules the next one, and
    // every print until then rides along with it. Deliberately NOT a
    // clearTimeout/setTimeout pair - that is a debounce, and it made the emit
    // wait for a lull that a live market never gives.
    if (!tradeTimers.has(pairId)) {
      tradeTimers.set(
        pairId,
        setTimeout(() => flushTradeBuffer(pairId, pairName), TRADE_FLUSH_MS)
      );
    }

  } catch (err) {
    console.log('[BinanceWS] Error handling trade update:', err.message);
  }
};

/**
 * Read-only snapshot of the live L2 order book cache for a pair.
 * Returns null when the pair has no usable book (never synced, or one side
 * empty). Bids are sorted best-first (descending), asks best-first (ascending).
 */
export const getDepthSnapshot = (pairId) => {
  const c = orderBookCache.get(String(pairId));
  if (!c || c.lastUpdateId === 0) return null;
  if (c.bids.size === 0 || c.asks.size === 0) return null;
  return {
    lastUpdateId: c.lastUpdateId,
    updatedAt: c.updatedAt || 0,
    bids: Array.from(c.bids.values()).sort((a, b) => b.price - a.price),
    asks: Array.from(c.asks.values()).sort((a, b) => a.price - b.price),
  };
};

/**
 * Stop all WebSocket streams
 */
export const stopBinanceWebSockets = () => {
  console.log('[BinanceWS] Stopping all WebSocket streams...');

  // Desired state first: nothing must be rebuilt by the watchdog or by a
  // 'close' handler AFTER a deliberate shutdown.
  depthStreams.clear();
  depthActivity.clear();
  depthProtocolActivity.clear();
  reconnecting.clear();
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  // Close all depth connections
  for (const [pairId, ws] of depthConnections) {
    try {
      ws.close();
    } catch (err) {
      // Ignore errors
    }
  }
  depthConnections.clear();

  // Close all trade connections
  for (const [pairId, ws] of tradeConnections) {
    try {
      ws.close();
    } catch (err) {
      // Ignore errors
    }
  }
  tradeConnections.clear();

  // Clear all timers
  for (const timerId of reconnectTimers.values()) {
    clearTimeout(timerId);
  }
  reconnectTimers.clear();

  // Clear trade throttling timers
  for (const timerId of tradeTimers.values()) {
    clearTimeout(timerId);
  }
  tradeTimers.clear();
  tradeBuffers.clear();

  // Clear publish heartbeats
  for (const timerId of publishTimers.values()) {
    clearInterval(timerId);
  }
  publishTimers.clear();
  heartbeatTicks.clear();

  console.log('[BinanceWS] All WebSocket streams stopped');
};
