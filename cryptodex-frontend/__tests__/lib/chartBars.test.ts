/**
 * THE CHART'S LIVE CANDLE.
 * ========================
 *
 * `subscribeBars` used to register the subscriber and return without ever
 * calling `onTick`, so the chart drew history and stood still. These pin the
 * arithmetic that replaced it - and in particular the two properties of the
 * feed that make a naive fold wrong:
 *
 *   1. `recentTrade` republishes the whole top-25 window on every fill, so the
 *      same prints arrive again and again. Volume must not count them twice.
 *   2. Prints arrive out of order, and a bar time that moves backwards is
 *      rejected by the library outright.
 *
 * The bucket cases exist because the live bar has to land in the SAME bucket
 * the backend aggregation would have put it in (controllers/chart/
 * chart.controller.js). A live candle that disagreed with history would draw
 * as a second candle rather than as an extension of the first.
 */

import {
  barTimeFor,
  tradeTimeValue,
  tradeKey,
  LiveBarBuilder,
} from '@/lib/chartBars';

const at = (iso: string) => Date.parse(iso);

const trade = (over: any = {}) => ({
  _id: over._id ?? Math.random().toString(36).slice(2),
  createdAt: over.createdAt ?? at('2026-03-04T10:07:30Z'),
  tradePrice: over.tradePrice ?? 100,
  tradeQty: over.tradeQty ?? 1,
  Type: over.Type ?? 'buy',
});

describe('barTimeFor - buckets match the backend aggregation', () => {
  test('minute resolutions floor to their own span, in UTC', () => {
    const t = at('2026-03-04T10:07:30.500Z');
    expect(barTimeFor(t, '1')).toBe(at('2026-03-04T10:07:00Z'));
    expect(barTimeFor(t, '5')).toBe(at('2026-03-04T10:05:00Z'));
    expect(barTimeFor(t, '15')).toBe(at('2026-03-04T10:00:00Z'));
    expect(barTimeFor(t, '30')).toBe(at('2026-03-04T10:00:00Z'));
    expect(barTimeFor(t, '60')).toBe(at('2026-03-04T10:00:00Z'));
  });

  test('a day bucket starts at UTC midnight', () => {
    expect(barTimeFor(at('2026-03-04T23:59:59Z'), '1D')).toBe(at('2026-03-04T00:00:00Z'));
    expect(barTimeFor(at('2026-03-05T00:00:00Z'), '1D')).toBe(at('2026-03-05T00:00:00Z'));
  });

  test('a month bucket starts on the first of the month', () => {
    expect(barTimeFor(at('2026-03-31T23:00:00Z'), '1M')).toBe(at('2026-03-01T00:00:00Z'));
  });

  /**
   * The aggregation groups weeks by `year + month + week`, so a week straddling
   * a month boundary is TWO buckets. Reproduced deliberately: matching the
   * backend matters more than a tidier week.
   */
  test('a week bucket starts on Sunday, but never before the first of the month', () => {
    // Wed 4 Mar 2026; the Sunday before is 1 Mar, which is also the month start.
    expect(barTimeFor(at('2026-03-04T10:00:00Z'), '1W')).toBe(at('2026-03-01T00:00:00Z'));
    // Tue 3 Feb 2026: Sunday before is 1 Feb.
    expect(barTimeFor(at('2026-02-03T10:00:00Z'), '1W')).toBe(at('2026-02-01T00:00:00Z'));
    // Thu 2 Apr 2026: the Sunday before is 29 Mar, which is the PREVIOUS month,
    // so the bucket is clamped to 1 Apr - the split the backend produces.
    expect(barTimeFor(at('2026-04-02T10:00:00Z'), '1W')).toBe(at('2026-04-01T00:00:00Z'));
  });

  test('an unusable time or resolution yields null rather than a guess', () => {
    expect(barTimeFor(NaN, '1')).toBeNull();
    expect(barTimeFor(at('2026-03-04T10:00:00Z'), 'not-a-resolution')).toBeNull();
    expect(barTimeFor(undefined as any, '1')).toBeNull();
  });
});

describe('tradeTimeValue - both wire formats, and neither', () => {
  test('epoch milliseconds pass through', () => {
    expect(tradeTimeValue({ createdAt: 1772000000000 })).toBe(1772000000000);
  });

  test('an ISO string is parsed', () => {
    expect(tradeTimeValue({ createdAt: '2026-03-04T10:07:30Z' })).toBe(
      at('2026-03-04T10:07:30Z')
    );
  });

  /**
   * NOT defaulted to `Date.now()`. Inventing a timestamp would file the fill in
   * whichever candle happened to be open, which is worse than dropping it.
   */
  test('a missing or unparseable time is null, not now', () => {
    expect(tradeTimeValue({})).toBeNull();
    expect(tradeTimeValue({ createdAt: 'the fourth of March' })).toBeNull();
    expect(tradeTimeValue(null)).toBeNull();
  });
});

describe('tradeKey', () => {
  test('prefers the feed id, which is the only thing separating one sweep', () => {
    expect(tradeKey({ _id: 'abc', tradePrice: 1 })).toBe('abc');
    expect(tradeKey({ _id: 0, tradePrice: 1 })).toBe('0');
  });

  test('falls back to a composite when no id arrives', () => {
    const k = tradeKey({ createdAt: 5, tradePrice: 10, tradeQty: 2, Type: 'buy' });
    expect(k).toBe('5|10|2|buy');
  });
});

describe('LiveBarBuilder', () => {
  test('the first trade opens a candle at the bucket start', () => {
    const b = new LiveBarBuilder('1');
    const bar = b.accept(trade({ createdAt: at('2026-03-04T10:07:30Z'), tradePrice: 100, tradeQty: 2 }));
    expect(bar).toEqual({
      time: at('2026-03-04T10:07:00Z'),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 2,
    });
  });

  test('further trades in the same bucket extend it rather than opening a new one', () => {
    const b = new LiveBarBuilder('1');
    b.accept(trade({ createdAt: at('2026-03-04T10:07:01Z'), tradePrice: 100, tradeQty: 1 }));
    b.accept(trade({ createdAt: at('2026-03-04T10:07:20Z'), tradePrice: 105, tradeQty: 1 }));
    const bar = b.accept(trade({ createdAt: at('2026-03-04T10:07:50Z'), tradePrice: 98, tradeQty: 3 }));

    expect(bar).toEqual({
      time: at('2026-03-04T10:07:00Z'),
      open: 100,   // the first print
      high: 105,   // the highest
      low: 98,     // the lowest
      close: 98,   // the last
      volume: 5,
    });
  });

  test('crossing into the next bucket starts a fresh candle', () => {
    const b = new LiveBarBuilder('1');
    b.accept(trade({ createdAt: at('2026-03-04T10:07:50Z'), tradePrice: 100, tradeQty: 1 }));
    const bar = b.accept(trade({ createdAt: at('2026-03-04T10:08:01Z'), tradePrice: 110, tradeQty: 4 }));

    expect(bar).toEqual({
      time: at('2026-03-04T10:08:00Z'),
      open: 110,
      high: 110,
      low: 110,
      close: 110,
      volume: 4,
    });
  });

  /**
   * THE ONE THAT MATTERS MOST.
   *
   * recentTradeSocket republishes the top-25 window on EVERY fill, so the same
   * print arrives many times over. High and low survive that; volume does not.
   */
  test('a republished trade is refused, so volume is not counted twice', () => {
    const b = new LiveBarBuilder('1');
    const t = trade({ _id: 'same-print', createdAt: at('2026-03-04T10:07:10Z'), tradePrice: 100, tradeQty: 7 });

    const first = b.accept(t);
    expect(first!.volume).toBe(7);

    expect(b.accept(t)).toBeNull();
    expect(b.accept({ ...t })).toBeNull();
    expect(b.current()!.volume).toBe(7);
  });

  /**
   * The library requires bar times to be non-decreasing, and a candle the chart
   * has already drawn must not be rewritten from a late print.
   */
  test('a trade older than the open bar is dropped', () => {
    const b = new LiveBarBuilder('1');
    b.accept(trade({ createdAt: at('2026-03-04T10:08:10Z'), tradePrice: 100, tradeQty: 1 }));

    const late = b.accept(trade({ createdAt: at('2026-03-04T10:07:10Z'), tradePrice: 50, tradeQty: 9 }));

    expect(late).toBeNull();
    expect(b.current()).toEqual({
      time: at('2026-03-04T10:08:00Z'),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
    });
  });

  test('a malformed trade changes nothing and does not consume its own identity', () => {
    const b = new LiveBarBuilder('1');
    expect(b.accept({ _id: 'x', createdAt: null, tradePrice: 10, tradeQty: 1 })).toBeNull();
    expect(b.accept({ _id: 'y', createdAt: at('2026-03-04T10:07:00Z'), tradePrice: 'nope', tradeQty: 1 })).toBeNull();
    expect(b.current()).toBeNull();

    // The same id, now well-formed, must still be accepted: a row refused for
    // being unusable was never counted, so remembering it would lose a fill.
    const bar = b.accept({ _id: 'x', createdAt: at('2026-03-04T10:07:00Z'), tradePrice: 10, tradeQty: 1 });
    expect(bar).not.toBeNull();
  });

  describe('seeding from history', () => {
    /**
     * The backend stamps a bar with `Date: { $last: "$createdAt" }` - the LAST
     * trade's time, not the bucket start. So the newest history bar sits inside
     * its bucket. A live tick must extend it AT THAT TIME: emit the aligned
     * bucket start instead and the time goes backwards (rejected); emit the next
     * aligned time and a second candle is drawn beside the one being extended.
     */
    test('a trade in the seeded bar\'s bucket keeps the history timestamp', () => {
      const b = new LiveBarBuilder('1');
      const historyTime = at('2026-03-04T10:07:42Z'); // NOT aligned to the minute
      b.seed({ time: historyTime, open: 100, high: 102, low: 99, close: 101, volume: 10 });

      const bar = b.accept(trade({ createdAt: at('2026-03-04T10:07:55Z'), tradePrice: 105, tradeQty: 2 }));

      expect(bar!.time).toBe(historyTime);
      expect(bar!.open).toBe(100);
      expect(bar!.high).toBe(105);
      expect(bar!.low).toBe(99);
      expect(bar!.close).toBe(105);
      expect(bar!.volume).toBe(12);
    });

    test('the next bucket opens at the aligned boundary, not from the seed', () => {
      const b = new LiveBarBuilder('1');
      b.seed({ time: at('2026-03-04T10:07:42Z'), open: 100, high: 102, low: 99, close: 101, volume: 10 });

      const bar = b.accept(trade({ createdAt: at('2026-03-04T10:08:05Z'), tradePrice: 105, tradeQty: 2 }));
      expect(bar!.time).toBe(at('2026-03-04T10:08:00Z'));
      expect(bar!.open).toBe(105);
      expect(bar!.volume).toBe(2);
    });

    /**
     * getBars is called again for every page the user scrolls back through, and
     * those pages are older. An older seed must not drag the live candle back.
     */
    test('an older seed cannot replace a newer one', () => {
      const b = new LiveBarBuilder('1');
      b.seed({ time: at('2026-03-04T10:07:42Z'), open: 100, high: 100, low: 100, close: 100, volume: 1 });
      b.seed({ time: at('2026-01-01T00:00:00Z'), open: 5, high: 5, low: 5, close: 5, volume: 1 });

      expect(b.current()!.time).toBe(at('2026-03-04T10:07:42Z'));
      expect(b.current()!.open).toBe(100);
    });

    test('a seed without a usable time is ignored', () => {
      const b = new LiveBarBuilder('1');
      b.seed({ time: NaN, open: 1, high: 1, low: 1, close: 1, volume: 0 } as any);
      b.seed(null as any);
      expect(b.current()).toBeNull();
    });
  });

  test('volume is carried even when a trade omits its quantity', () => {
    const b = new LiveBarBuilder('1');
    const bar = b.accept({ _id: 'q', createdAt: at('2026-03-04T10:07:00Z'), tradePrice: 100 });
    expect(bar!.volume).toBe(0);
  });
});
