/**
 * THE CHART IS SUBSCRIBED TO THE TRADE FEED.
 * ==========================================
 *
 * chartBars.test.ts pins the arithmetic. This pins the WIRING, which is where
 * the defect actually lived: `subscribeBars` stored the library's `onTick`
 * callback and never called it, so every one of these assertions would have
 * failed against the previous version while the chart still looked fine on
 * screen.
 *
 * The assertions are therefore all of the form "onTick was called with X",
 * never "it did not throw".
 */

import CustomDatafeed from '@/lib/customDatafeed';

/** A stand-in for the socket.io singleton, recording listeners by reference. */
const stubSocket = () => {
  const listeners: Record<string, Function[]> = {};
  return {
    listeners,
    on(event: string, fn: Function) {
      (listeners[event] = listeners[event] || []).push(fn);
    },
    off(event: string, fn?: Function) {
      if (!listeners[event]) return;
      if (!fn) {
        // The behaviour the real emitter has, and the reason unsubscribeBars
        // must pass its handler: no argument drops EVERY listener.
        delete listeners[event];
        return;
      }
      listeners[event] = listeners[event].filter((l) => l !== fn);
    },
    emit(event: string, payload: any) {
      (listeners[event] || []).slice().forEach((l) => l(payload));
    },
    count(event: string) {
      return (listeners[event] || []).length;
    },
  };
};

const at = (iso: string) => Date.parse(iso);

const symbolInfo = { name: 'BTC_USDT', ticker: 'BTC_USDT' } as any;

const trade = (over: any = {}) => ({
  _id: over._id ?? Math.random().toString(36).slice(2),
  createdAt: over.createdAt ?? at('2026-03-04T10:07:30Z'),
  tradePrice: over.tradePrice ?? 100,
  tradeQty: over.tradeQty ?? 1,
  Type: over.Type ?? 'buy',
});

describe('live chart updates', () => {
  test('subscribeBars attaches a recentTrade listener', () => {
    const socket = stubSocket();
    const feed = new CustomDatafeed('http://x/api/spot/chart', { socket, pairId: 'p1' });

    expect(socket.count('recentTrade')).toBe(0);
    feed.subscribeBars(symbolInfo, '1', jest.fn(), 'guid-1');
    expect(socket.count('recentTrade')).toBe(1);
  });

  test('a trade message produces a candle', () => {
    const socket = stubSocket();
    const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
    const onTick = jest.fn();

    feed.subscribeBars(symbolInfo, '1', onTick, 'guid-1');

    socket.emit('recentTrade', {
      pairId: 'p1',
      data: [trade({ createdAt: at('2026-03-04T10:07:30Z'), tradePrice: 100, tradeQty: 2 })],
    });

    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith({
      time: at('2026-03-04T10:07:00Z'),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 2,
    });
  });

  /**
   * ONE redraw per message, not one per print. A republished window is 25 rows
   * arriving together; ticking the library 25 times to reach one candle is 24
   * wasted renders on the hot path.
   */
  test('a batch produces a single tick carrying the folded candle', () => {
    const socket = stubSocket();
    const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
    const onTick = jest.fn();

    feed.subscribeBars(symbolInfo, '1', onTick, 'guid-1');

    socket.emit('recentTrade', {
      pairId: 'p1',
      data: [
        trade({ createdAt: at('2026-03-04T10:07:10Z'), tradePrice: 100, tradeQty: 1 }),
        trade({ createdAt: at('2026-03-04T10:07:20Z'), tradePrice: 106, tradeQty: 1 }),
        trade({ createdAt: at('2026-03-04T10:07:30Z'), tradePrice: 97, tradeQty: 2 }),
      ],
    });

    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith({
      time: at('2026-03-04T10:07:00Z'),
      open: 100,
      high: 106,
      low: 97,
      close: 97,
      volume: 4,
    });
  });

  /**
   * The feed does not promise an order, and two producers write to this event.
   * A batch applied backwards would take `close` from the wrong print.
   */
  test('a batch arriving out of order still closes on the latest print', () => {
    const socket = stubSocket();
    const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
    const onTick = jest.fn();

    feed.subscribeBars(symbolInfo, '1', onTick, 'guid-1');

    socket.emit('recentTrade', {
      pairId: 'p1',
      data: [
        trade({ createdAt: at('2026-03-04T10:07:40Z'), tradePrice: 97, tradeQty: 1 }),
        trade({ createdAt: at('2026-03-04T10:07:10Z'), tradePrice: 100, tradeQty: 1 }),
      ],
    });

    const bar = onTick.mock.calls[0][0];
    expect(bar.open).toBe(100);  // the 10:07:10 print
    expect(bar.close).toBe(97);  // the 10:07:40 print
  });

  test('republished trades do not inflate volume', () => {
    const socket = stubSocket();
    const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
    const onTick = jest.fn();

    feed.subscribeBars(symbolInfo, '1', onTick, 'guid-1');

    const print = trade({ _id: 'fill-1', createdAt: at('2026-03-04T10:07:10Z'), tradePrice: 100, tradeQty: 5 });

    socket.emit('recentTrade', { pairId: 'p1', data: [print] });
    socket.emit('recentTrade', { pairId: 'p1', data: [print] });
    socket.emit('recentTrade', { pairId: 'p1', data: [{ ...print }] });

    // Only the first message changed anything, so only it ticked.
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick.mock.calls[0][0].volume).toBe(5);
  });

  test('a message for another market is ignored', () => {
    const socket = stubSocket();
    const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
    const onTick = jest.fn();

    feed.subscribeBars(symbolInfo, '1', onTick, 'guid-1');
    socket.emit('recentTrade', { pairId: 'SOMETHING-ELSE', data: [trade()] });

    expect(onTick).not.toHaveBeenCalled();
  });

  test('a malformed message is ignored rather than throwing into the socket', () => {
    const socket = stubSocket();
    const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
    const onTick = jest.fn();

    feed.subscribeBars(symbolInfo, '1', onTick, 'guid-1');

    expect(() => {
      socket.emit('recentTrade', null);
      socket.emit('recentTrade', { pairId: 'p1' });
      socket.emit('recentTrade', { pairId: 'p1', data: 'not an array' });
      socket.emit('recentTrade', { pairId: 'p1', data: [] });
    }).not.toThrow();

    expect(onTick).not.toHaveBeenCalled();
  });

  describe('unsubscribeBars', () => {
    test('stops the ticks', () => {
      const socket = stubSocket();
      const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
      const onTick = jest.fn();

      feed.subscribeBars(symbolInfo, '1', onTick, 'guid-1');
      feed.unsubscribeBars('guid-1');

      socket.emit('recentTrade', { pairId: 'p1', data: [trade()] });
      expect(onTick).not.toHaveBeenCalled();
      expect(socket.count('recentTrade')).toBe(0);
    });

    /**
     * `spotSocket` is a shared singleton: the trade tape, the order book and the
     * price header all listen on it. `off("recentTrade")` with no handler drops
     * every one of them, so the chart closing would silently kill the tape.
     */
    test('removes only its own listener, not every recentTrade subscriber', () => {
      const socket = stubSocket();
      const somebodyElse = jest.fn();
      socket.on('recentTrade', somebodyElse);

      const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
      feed.subscribeBars(symbolInfo, '1', jest.fn(), 'guid-1');
      expect(socket.count('recentTrade')).toBe(2);

      feed.unsubscribeBars('guid-1');

      expect(socket.count('recentTrade')).toBe(1);
      socket.emit('recentTrade', { pairId: 'p1', data: [trade()] });
      expect(somebodyElse).toHaveBeenCalledTimes(1);
    });

    test('is safe for a guid that was never subscribed', () => {
      const socket = stubSocket();
      const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
      expect(() => feed.unsubscribeBars('never-seen')).not.toThrow();
    });
  });

  /**
   * A server render has no socket, and neither does a bare construction of the
   * feed. History must still work; only the live updates are absent.
   */
  test('without a socket the feed still subscribes without throwing', () => {
    const feed = new CustomDatafeed('http://x');
    expect(() => {
      feed.subscribeBars(symbolInfo, '1', jest.fn(), 'guid-1');
      feed.unsubscribeBars('guid-1');
    }).not.toThrow();
  });

  describe('seeding from history', () => {
    /**
     * The backend timestamps a bar with the LAST trade in it, not the bucket
     * start, so the live bar must extend it AT THAT TIME or the period is drawn
     * twice. These drive the real `getBars` path through a stubbed fetch, so the
     * seeding wiring is covered rather than just `LiveBarBuilder.seed`.
     */
    const historyResponse = (bars: Array<[number, number, number, number, number, number]>) => ({
      s: 'ok',
      t: bars.map((b) => b[0]),
      o: bars.map((b) => b[1]),
      h: bars.map((b) => b[2]),
      l: bars.map((b) => b[3]),
      c: bars.map((b) => b[4]),
      v: bars.map((b) => b[5]),
    });

    const withFetch = (payload: any) => {
      (global as any).fetch = jest.fn(() =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
      );
    };

    afterEach(() => {
      delete (global as any).fetch;
    });

    const loadHistory = (feed: any, resolution: string) =>
      new Promise<void>((resolve) =>
        feed.getBars(symbolInfo, resolution, { timeFrom: 0, timeTo: 9e9 }, () => resolve(), () => resolve())
      );

    test('a live print extends the history bar instead of drawing a second candle', async () => {
      // 10:07:42 - inside the 10:07 bucket, but NOT on its boundary.
      const seedTime = at('2026-03-04T10:07:42Z') / 1000;
      withFetch(historyResponse([[seedTime, 100, 102, 99, 101, 10]]));

      const socket = stubSocket();
      const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
      await loadHistory(feed, '1');

      const onTick = jest.fn();
      feed.subscribeBars(symbolInfo, '1', onTick, 'guid-1');

      socket.emit('recentTrade', {
        pairId: 'p1',
        data: [trade({ createdAt: at('2026-03-04T10:07:55Z'), tradePrice: 105, tradeQty: 2 })],
      });

      const bar = onTick.mock.calls[0][0];
      expect(bar.time).toBe(at('2026-03-04T10:07:42Z')); // the history bar's own time
      expect(bar.open).toBe(100);                        // history's open survives
      expect(bar.high).toBe(105);
      expect(bar.low).toBe(99);
      expect(bar.close).toBe(105);
      expect(bar.volume).toBe(12);                       // 10 + 2
    });

    /**
     * The library's order is getBars then subscribeBars. A subscription that
     * ran first would open its own aligned bar beside the history one.
     */
    test('a subscription made BEFORE history loads still picks the seed up', async () => {
      const seedTime = at('2026-03-04T10:07:42Z') / 1000;
      withFetch(historyResponse([[seedTime, 100, 102, 99, 101, 10]]));

      const socket = stubSocket();
      const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });

      const onTick = jest.fn();
      feed.subscribeBars(symbolInfo, '1', onTick, 'guid-1'); // BEFORE any getBars
      await loadHistory(feed, '1');

      socket.emit('recentTrade', {
        pairId: 'p1',
        data: [trade({ createdAt: at('2026-03-04T10:07:55Z'), tradePrice: 105, tradeQty: 2 })],
      });

      expect(onTick.mock.calls[0][0].time).toBe(at('2026-03-04T10:07:42Z'));
      expect(onTick.mock.calls[0][0].open).toBe(100);
    });

    /**
     * The page is sorted ascending upstream. This does not rely on it: if that
     * sort were dropped, taking the last element would seed from the OLDEST bar
     * and strand the live candle in the past.
     */
    test('the newest bar is found even if the page arrives unsorted', async () => {
      const newest = at('2026-03-04T10:07:42Z') / 1000;
      const older = at('2026-03-04T09:00:00Z') / 1000;
      withFetch(historyResponse([
        [newest, 100, 102, 99, 101, 10],
        [older, 1, 1, 1, 1, 1],          // out of order, newest NOT last
      ]));

      const socket = stubSocket();
      const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
      await loadHistory(feed, '1');

      const onTick = jest.fn();
      feed.subscribeBars(symbolInfo, '1', onTick, 'guid-1');

      socket.emit('recentTrade', {
        pairId: 'p1',
        data: [trade({ createdAt: at('2026-03-04T10:07:55Z'), tradePrice: 105, tradeQty: 2 })],
      });

      expect(onTick.mock.calls[0][0].time).toBe(at('2026-03-04T10:07:42Z'));
      expect(onTick.mock.calls[0][0].open).toBe(100);
    });
  });

  /**
   * Two charts are on the spot page at once (HomePage renders
   * tv_chart_container_1 and _2), so two subscriptions share one socket.
   */
  test('two subscriptions are independent', () => {
    const socket = stubSocket();
    const feed = new CustomDatafeed('http://x', { socket, pairId: 'p1' });
    const oneMinute = jest.fn();
    const oneHour = jest.fn();

    feed.subscribeBars(symbolInfo, '1', oneMinute, 'guid-1');
    feed.subscribeBars(symbolInfo, '60', oneHour, 'guid-2');

    socket.emit('recentTrade', {
      pairId: 'p1',
      data: [trade({ createdAt: at('2026-03-04T10:07:30Z'), tradePrice: 100, tradeQty: 1 })],
    });

    expect(oneMinute.mock.calls[0][0].time).toBe(at('2026-03-04T10:07:00Z'));
    expect(oneHour.mock.calls[0][0].time).toBe(at('2026-03-04T10:00:00Z'));

    feed.unsubscribeBars('guid-1');
    socket.emit('recentTrade', {
      pairId: 'p1',
      data: [trade({ createdAt: at('2026-03-04T10:08:30Z'), tradePrice: 101, tradeQty: 1 })],
    });

    expect(oneMinute).toHaveBeenCalledTimes(1);
    expect(oneHour).toHaveBeenCalledTimes(2);
  });
});
