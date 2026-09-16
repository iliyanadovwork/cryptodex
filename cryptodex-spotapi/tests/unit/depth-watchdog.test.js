/**
 * BINANCE DEPTH STREAM SELF-HEALING (CRITICAL)
 *
 * The depth stream went down and never came back. The process still held three
 * ESTABLISHED TCP sockets to Binance while zero depth updates arrived: a
 * half-open connection stays ESTABLISHED in the kernel and simply stops
 * delivering data, and `ws` emits nothing at all when that happens.
 *
 * The old recovery design could not survive it:
 *   - the whole reconnect chain hung off the 'close' event
 *     ('close' -> setTimeout 5s -> snapshot -> startDepthStream), so a death
 *     that produced no 'close' produced no recovery, ever;
 *   - the re-entry guard `if (depthConnections.has(pairId)) return` refused to
 *     start a replacement while the corpse was still in the map;
 *   - the map was only ever written in the 'open' handler, so a socket that
 *     never opened was invisible while one that had opened and died looked
 *     exactly like a healthy one;
 *   - and a sequence-gap recovery whose REST snapshot failed left the cache
 *     pinned at lastUpdateId 0, buffering every subsequent event forever on a
 *     connection that looked perfectly alive.
 *
 * Liveness is now measured by DATA, and a watchdog reconciles the live
 * connections against the set of streams that SHOULD exist.
 *
 * The thresholds are shrunk to milliseconds here so the tests exercise the real
 * timers and the real clock rather than a simulated one.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

const PAIR_ID = '695bf1017573eeb15a749c9d';
const SILENCE_MS = 150;

jest.mock('ws', () => {
  const { EventEmitter: EE } = require('events');
  const sockets = [];
  const state = { throwOnConstruct: false };
  class FakeWebSocket extends EE {
    constructor(url) {
      super();
      if (state.throwOnConstruct) {
        throw new Error('construct failed');
      }
      this.url = url;
      this.readyState = 0;
      this.terminated = false;
      this.closed = false;
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.emit('open');
    }
    // A real depth message from the venue.
    deliver(message) {
      this.emit('message', Buffer.from(JSON.stringify(message)));
    }
    terminate() {
      this.terminated = true;
      this.readyState = 3;
      this.emit('close');
    }
    close() {
      this.closed = true;
      this.readyState = 3;
      this.emit('close');
    }
  }
  return {
    __esModule: true,
    default: FakeWebSocket,
    __sockets: sockets,
    __state: state,
    __reset: () => {
      sockets.length = 0;
      state.throwOnConstruct = false;
    }
  };
});

jest.mock('axios', () => {
  const state = { fail: false, lastUpdateId: 1000 };
  return {
    __esModule: true,
    __state: state,
    default: {
      get: async () => {
        if (state.fail) throw new Error('binance unreachable');
        return {
          data: {
            lastUpdateId: state.lastUpdateId,
            bids: [['63499', '0.5'], ['63498', '1']],
            asks: [['63500', '0.5'], ['63501', '1']]
          }
        };
      }
    }
  };
});

jest.mock('../../models/index.js', () => ({
  __esModule: true,
  SpotPair: {
    find: () => ({
      lean: async () => [
        {
          _id: { toString: () => '695bf1017573eeb15a749c9d' },
          tikerRoot: 'BTCUSD',
          firstCurrencySymbol: 'BTC',
          secondCurrencySymbol: 'USD'
        }
      ]
    })
  }
}));

jest.mock('../../config/socketIO.js', () => ({
  __esModule: true,
  socketEmitAll: () => {},
  socketEmitOne: () => {}
}));

jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  set: async () => true,
  get: async () => null
}));

import * as wsModule from 'ws';
import * as axiosModule from 'axios';

// The module reads its thresholds at load time, so it is imported dynamically
// AFTER they are set (a plain `import` is hoisted above any assignment).
let bws;
beforeAll(async () => {
  process.env.BINANCE_DEPTH_RECONNECT_MS = '1';
  process.env.BINANCE_DEPTH_SILENCE_MS = String(SILENCE_MS);
  process.env.BINANCE_DEPTH_DESYNC_MS = '100';
  process.env.BOOK_PUBLISH_HEARTBEAT_MS = '100000';
  bws = await import('../../lib/binanceWebSocket.js');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => sleep(25);

const depthSockets = () =>
  wsModule.__sockets.filter((s) => s.url && s.url.includes('@depth'));
const liveDepthSocket = () => {
  const all = depthSockets();
  return all[all.length - 1];
};

const depthUpdate = (U, u) => ({
  e: 'depthUpdate',
  U,
  u,
  b: [['63499', '0.6']],
  a: [['63500', '0.4']]
});

const boot = async () => {
  await bws.startBinanceWebSockets();
  liveDepthSocket().open();
  await settle();
};

describe('depth stream self-healing (CRITICAL)', () => {
  beforeEach(() => {
    bws.setDepthListener(null);
    wsModule.__reset();
    axiosModule.__state.fail = false;
    axiosModule.__state.lastUpdateId = 1000;
  });

  afterEach(async () => {
    bws.stopBinanceWebSockets();
    await settle();
    wsModule.__reset();
  });

  test('the connection is registered before it opens, so a slow connect cannot stack duplicates', async () => {
    await bws.startBinanceWebSockets();
    // Still CONNECTING - never opened.
    expect(depthSockets()).toHaveLength(1);
    expect(bws.getDepthStreamHealth()[0].connected).toBe(true);

    // The old guard only knew about OPEN sockets, so this second attempt would
    // have created a second live stream for the same pair.
    await bws.startBinanceWebSockets();
    expect(depthSockets()).toHaveLength(1);
  });

  test('a stream that dies SILENTLY - no close, no error - is restarted', async () => {
    await boot();
    const dead = liveDepthSocket();
    dead.deliver(depthUpdate(1001, 1002));
    await settle();
    expect(bws.runDepthWatchdog()).toEqual([]);

    // The socket stops delivering. Nothing is emitted: no 'close', no 'error'.
    // The kernel still calls it ESTABLISHED. This is the exact outage.
    await sleep(SILENCE_MS + 50);
    const actions = bws.runDepthWatchdog();

    expect(actions).toEqual([
      expect.objectContaining({ pairId: PAIR_ID, action: 'restart' })
    ]);
    expect(dead.terminated).toBe(true);

    await settle();
    const revived = liveDepthSocket();
    expect(revived).not.toBe(dead);
    revived.open();
    revived.deliver(depthUpdate(1001, 1002));
    await settle();

    expect(bws.getDepthStreamHealth()[0].connected).toBe(true);
    expect(bws.runDepthWatchdog()).toEqual([]);
    expect(bws.getDepthSnapshot(PAIR_ID)).not.toBeNull();
  });

  test('a live stream is never killed by the watchdog', async () => {
    await boot();
    const live = liveDepthSocket();
    for (let i = 0; i < 4; i++) {
      live.deliver(depthUpdate(1001 + i, 1002 + i));
      await sleep(SILENCE_MS / 2);
      expect(bws.runDepthWatchdog()).toEqual([]);
    }
    expect(live.terminated).toBe(false);
    expect(liveDepthSocket()).toBe(live);
  });

  test('a socket that pings but delivers no depth is STILL restarted', async () => {
    // Verified live against Binance: pings arrive every ~20s and kept the
    // liveness clock refreshed while zero depth updates flowed and the book sat
    // frozen. A ping proves the peer is there; it does not prove the
    // subscription is delivering. Liveness is DATA.
    await boot();
    const live = liveDepthSocket();
    live.deliver(depthUpdate(1001, 1002));

    for (let i = 0; i < 4; i++) {
      live.emit('ping'); // protocol alive, data starved
      await sleep(SILENCE_MS / 2);
    }

    const actions = bws.runDepthWatchdog();
    expect(actions).toEqual([
      expect.objectContaining({ pairId: PAIR_ID, action: 'restart' })
    ]);
    expect(live.terminated).toBe(true);
    // ...and the distinction is visible, not guessed at.
    await settle();
    const health = bws.getDepthStreamHealth()[0];
    expect(health.protocolSilentForMs).toBeLessThan(health.silentForMs + 1);
  });

  test('a close from a SUPERSEDED socket does not tear down the live one', async () => {
    await boot();
    const first = liveDepthSocket();

    await sleep(SILENCE_MS + 50);
    bws.runDepthWatchdog(); // terminates `first`, schedules a replacement
    await settle();
    const second = liveDepthSocket();
    second.open();
    expect(second).not.toBe(first);

    // A late 'close' from the socket that was already replaced. This used to
    // delete the LIVE connection from the map and schedule a duplicate stream.
    first.emit('close');
    await settle();

    expect(liveDepthSocket()).toBe(second);
    expect(bws.getDepthStreamHealth()[0].connected).toBe(true);
  });

  test('a normal close reconnects, with a fresh snapshot', async () => {
    await boot();
    const first = liveDepthSocket();
    axiosModule.__state.lastUpdateId = 2000;

    first.close();
    await settle();

    const second = liveDepthSocket();
    expect(second).not.toBe(first);
    second.open();
    await settle();
    expect(bws.getDepthSnapshot(PAIR_ID).lastUpdateId).toBe(2000);
  });

  test('a reconnect whose snapshot fails still restarts the stream', async () => {
    await boot();
    const first = liveDepthSocket();
    // The old chain was fetchDepthSnapshot().then(startDepthStream): anything
    // that broke that promise left the stream permanently down.
    axiosModule.__state.fail = true;

    first.close();
    await settle();

    expect(liveDepthSocket()).not.toBe(first);
    expect(bws.getDepthStreamHealth()[0].connected).toBe(true);
  });

  test('a stream whose socket cannot even be constructed is retried until it can', async () => {
    await boot();
    const first = liveDepthSocket();
    wsModule.__state.throwOnConstruct = true;

    first.close();
    await settle();
    // Nothing was created, and no 'close' will ever arrive for a socket that
    // does not exist - the retry has to come from somewhere else.
    expect(bws.getDepthStreamHealth()[0].connected).toBe(false);

    wsModule.__state.throwOnConstruct = false;
    await sleep(60);
    expect(bws.getDepthStreamHealth()[0].connected).toBe(true);
    expect(liveDepthSocket()).not.toBe(first);
  });

  test('a desynced cache whose recovery snapshot failed is retried', async () => {
    await boot();
    const live = liveDepthSocket();
    live.deliver(depthUpdate(1001, 1002));
    await settle();

    // Sequence gap -> the cache is zeroed and a recovery snapshot is requested.
    // It fails, so every subsequent event is buffered and the stream stays
    // perfectly alive while publishing nothing at all.
    axiosModule.__state.fail = true;
    live.deliver(depthUpdate(9000, 9001));
    await settle();
    live.deliver(depthUpdate(9002, 9003));
    await settle();

    expect(bws.getDepthSnapshot(PAIR_ID)).toBeNull();
    expect(bws.getDepthStreamHealth()[0].bufferedEvents).toBeGreaterThan(0);

    // The watchdog retries the snapshot nothing else would have retried. The
    // stream is still delivering, so it must NOT be restarted for silence.
    axiosModule.__state.fail = false;
    axiosModule.__state.lastUpdateId = 9500;
    await sleep(120); // past the desync recovery window
    live.deliver(depthUpdate(9004, 9005)); // ...but the socket is still alive
    const actions = bws.runDepthWatchdog();
    expect(actions).toEqual([
      expect.objectContaining({ action: 'resnapshot', reason: 'desynced' })
    ]);
    await settle();

    expect(bws.getDepthSnapshot(PAIR_ID).lastUpdateId).toBe(9500);
    expect(live.terminated).toBe(false);
  });

  test('shutdown stops the watchdog rebuilding streams', async () => {
    await boot();
    bws.stopBinanceWebSockets();
    await settle();
    const count = depthSockets().length;

    await sleep(SILENCE_MS + 50);
    expect(bws.runDepthWatchdog()).toEqual([]);
    await settle();
    expect(depthSockets()).toHaveLength(count);
  });

  test('startDepthWatchdog is idempotent', async () => {
    const a = bws.startDepthWatchdog();
    const b = bws.startDepthWatchdog();
    expect(a).toBe(b);
  });

  test('health reporting exposes what was invisible during the outage', async () => {
    await boot();
    liveDepthSocket().deliver(depthUpdate(1001, 1002));
    await settle();

    expect(bws.getDepthStreamHealth()[0]).toEqual(
      expect.objectContaining({
        pairId: PAIR_ID,
        pairName: 'BTCUSD',
        symbol: 'BTCUSDT',
        connected: true,
        reconnectPending: false
      })
    );
    expect(bws.getDepthStreamHealth()[0].depthAgeMs).toBeLessThan(5000);
  });
});

// ===========================================================================
// The publish seam: this module owns the depth cache, it does not decide what
// the world is told about it.
// ===========================================================================

describe('depth updates drive the shared publisher, not a private one', () => {
  beforeEach(() => {
    wsModule.__reset();
    axiosModule.__state.fail = false;
  });

  afterEach(async () => {
    bws.setDepthListener(null);
    bws.stopBinanceWebSockets();
    await settle();
    wsModule.__reset();
  });

  test('every depth update notifies the registered publisher', async () => {
    const calls = [];
    bws.setDepthListener(async (pairId, type) => {
      calls.push({ pairId, type });
    });

    await boot();
    expect(calls).toEqual(
      expect.arrayContaining([{ pairId: PAIR_ID, type: 'SNAPSHOT' }])
    );

    calls.length = 0;
    liveDepthSocket().deliver(depthUpdate(1001, 1002));
    await settle();
    expect(calls).toEqual([{ pairId: PAIR_ID, type: 'DELTA' }]);
  });

  test('a publisher that rejects cannot break the depth pipeline', async () => {
    bws.setDepthListener(async () => {
      throw new Error('publish exploded');
    });

    await boot();
    const live = liveDepthSocket();
    live.deliver(depthUpdate(1001, 1002));
    await settle();

    expect(bws.getDepthSnapshot(PAIR_ID)).not.toBeNull();
    expect(live.terminated).toBe(false);
  });
});
