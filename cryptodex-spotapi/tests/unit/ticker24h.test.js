/**
 * 24H TICKER STATISTICS
 *
 * The four header numbers (24h high, 24h low, 24h volume in the base coin, 24h
 * turnover in the quote currency) are one measurement of one window, not four
 * readings. These pin the identities that make them agree, and pin the exact
 * shape of the bug they replaced: two independent Math.random() draws for
 * volume and turnover, and a "24h range" rebuilt from the previous 30s tick.
 */

import { describe, test, expect } from '@jest/globals';
import {
  normalize,
  isCoherent,
  buildPairPayloads,
  TURNOVER_TOLERANCE,
} from '../../lib/ticker24h.js';

/** A real-shaped /api/v3/ticker/24hr payload. */
const payload = (over = {}) => ({
  symbol: 'BTCUSDT',
  priceChange: '587.99',
  priceChangePercent: '0.917',
  weightedAvgPrice: '64320.54',
  lastPrice: '64709.99',
  openPrice: '64122.00',
  highPrice: '64804.00',
  lowPrice: '63880.00',
  volume: '12749.52875',
  quoteVolume: '820056614.97',
  ...over
});

describe('normalize (Binance 24hr ticker -> pair fields)', () => {
  test('maps the whole window onto the field names the pair document uses', () => {
    const result = normalize(payload());

    expect(result.ok).toBe(true);
    expect(result.stats).toEqual(
      expect.objectContaining({
        last: 64709.99,
        markPrice: 64709.99,
        high: 64804,
        low: 63880,
        firstVolume: 12749.52875,
        secondVolume: 820056614.97,
        change: 0.917,
        changePrice: 587.99
      })
    );
  });

  test('the result satisfies every identity the header depends on', () => {
    const { stats } = normalize(payload());

    expect(stats.low).toBeLessThanOrEqual(stats.last);
    expect(stats.last).toBeLessThanOrEqual(stats.high);
    // Turnover is the same trades in the quote unit: dividing back out lands
    // inside the day's range.
    const impliedAverage = stats.secondVolume / stats.firstVolume;
    expect(impliedAverage).toBeGreaterThanOrEqual(stats.low);
    expect(impliedAverage).toBeLessThanOrEqual(stats.high);
    expect(isCoherent(stats)).toBe(true);
  });

  test('REGRESSION: two independent random draws for volume and turnover are rejected', () => {
    // Exactly what updateBinancePrices published: firstVolume from
    // Math.random()*1000+100, secondVolume from Math.random()*1000000+10000.
    // At BTC prices they disagree by three orders of magnitude.
    const result = normalize(payload({ volume: '217.19', quoteVolume: '759964.26' }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('turnover-incoherent');
  });

  test('REGRESSION: a range rebuilt from the previous tick, which excludes the live price, is rejected', () => {
    // high = prevPrice * 1.01 and low = prevPrice * 0.99 track the last tick,
    // not the day - so the "24h low" could sit above the current price.
    const result = normalize(payload({ lowPrice: '64900.00', highPrice: '65500.00' }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('range-excludes-last');
  });

  test('a high below the low is refused', () => {
    const result = normalize(payload({ highPrice: '63000', lowPrice: '64000' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('range-inverted');
  });

  test('a missing or unusable last price is refused rather than published as 0', () => {
    expect(normalize(payload({ lastPrice: undefined })).reason).toBe('last-price-invalid');
    expect(normalize(payload({ lastPrice: '0' })).reason).toBe('last-price-invalid');
    expect(normalize(payload({ lastPrice: 'abc' })).reason).toBe('last-price-invalid');
    expect(normalize(null).reason).toBe('no-payload');
  });

  test('a missing range is refused', () => {
    expect(normalize(payload({ highPrice: undefined })).reason).toBe('range-invalid');
    expect(normalize(payload({ lowPrice: '-1' })).reason).toBe('range-invalid');
  });

  test('a negative volume is refused', () => {
    expect(normalize(payload({ volume: '-5' })).reason).toBe('base-volume-invalid');
    expect(normalize(payload({ volume: 'x' })).reason).toBe('base-volume-invalid');
    expect(normalize(payload({ quoteVolume: '-5' })).reason).toBe('quote-volume-invalid');
  });

  test('a missing turnover is DERIVED from volume x weighted average, not invented', () => {
    const result = normalize(payload({ quoteVolume: undefined }));

    expect(result.ok).toBe(true);
    expect(result.stats.secondVolume).toBeCloseTo(12749.52875 * 64320.54, 2);
  });

  test('a missing turnover with no weighted average is refused, not guessed', () => {
    const result = normalize(payload({ quoteVolume: undefined, weightedAvgPrice: '0' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('quote-volume-invalid');
  });

  test('a pair that genuinely did not trade is coherent at zero', () => {
    const result = normalize(
      payload({ volume: '0', quoteVolume: '0', weightedAvgPrice: '0' })
    );

    expect(result.ok).toBe(true);
    expect(result.stats.firstVolume).toBe(0);
    expect(result.stats.secondVolume).toBe(0);
  });

  test('rounding-sized drift inside the tolerance is accepted, drift outside it is not', () => {
    const implied = 12749.52875 * 64320.54;
    const justInside = implied * (1 + TURNOVER_TOLERANCE * 0.5);
    const justOutside = implied * (1 + TURNOVER_TOLERANCE * 2);

    expect(normalize(payload({ quoteVolume: String(justInside) })).ok).toBe(true);
    expect(normalize(payload({ quoteVolume: String(justOutside) })).ok).toBe(false);
  });

  test('change is taken from the feed, and derived from the open only when absent', () => {
    const fromFeed = normalize(payload()).stats;
    expect(fromFeed.change).toBe(0.917);
    expect(fromFeed.changePrice).toBe(587.99);

    const derived = normalize(
      payload({ priceChange: undefined, priceChangePercent: undefined })
    ).stats;
    expect(derived.changePrice).toBeCloseTo(64709.99 - 64122.0, 6);
    expect(derived.change).toBeCloseTo(((64709.99 - 64122.0) / 64122.0) * 100, 6);
  });
});

describe('isCoherent (assertion over a published snapshot)', () => {
  test('accepts a real snapshot', () => {
    expect(
      isCoherent({
        last: 64709.99,
        high: 64804,
        low: 63880,
        firstVolume: 12749.52875,
        secondVolume: 820056614.97
      })
    ).toBe(true);
  });

  test('rejects the shape the service used to publish', () => {
    expect(
      isCoherent({
        last: 64772.64,
        high: 64772.64,
        low: 64117.58,
        firstVolume: 217.19,
        secondVolume: 759964.26
      })
    ).toBe(false);
  });

  test('rejects a live price outside the range it is printed beside', () => {
    expect(
      isCoherent({ last: 100, high: 90, low: 80, firstVolume: 1, secondVolume: 85 })
    ).toBe(false);
  });

  test('rejects turnover recorded against no volume at all', () => {
    expect(
      isCoherent({ last: 85, high: 90, low: 80, firstVolume: 0, secondVolume: 1000 })
    ).toBe(false);
  });

  test('rejects a missing snapshot instead of passing it', () => {
    expect(isCoherent(null)).toBe(false);
    expect(isCoherent({})).toBe(false);
  });
});

describe('buildPairPayloads (what the cron publishes)', () => {
  const pair = {
    _id: { toString: () => 'pair-1' },
    pairName: 'BTC/USD',
    firstCurrencySymbol: 'BTC',
    secondCurrencySymbol: 'USD',
    botstatus: 'binance',
    minQuantity: 0.0001
  };

  test('an incoherent tick publishes NOTHING - the previous snapshot stands', () => {
    const built = buildPairPayloads(pair, payload({ quoteVolume: '759964.26' }));

    expect(built.ok).toBe(false);
    expect(built.reason).toBe('turnover-incoherent');
    expect(built.updatedPair).toBeUndefined();
    expect(built.changeData).toBeUndefined();
    expect(built.socketData).toBeUndefined();
  });

  test('REGRESSION: the socket tick carries the 24h fields, not just the price', () => {
    // The market table REPLACES its row from the tick, so a tick without these
    // rendered every 24h cell on /market as 0 thirty seconds after load.
    const { socketData } = buildPairPayloads(pair, payload());

    expect(socketData).toEqual(
      expect.objectContaining({
        high: 64804,
        low: 63880,
        firstVolume: 12749.52875,
        secondVolume: 820056614.97,
        markPrice: 64709.99,
        last: 64709.99,
        price: 64709.99
      })
    );
  });

  test('the cache, the pair document and the socket all carry the SAME numbers', () => {
    const { stats, updatedPair, changeData, socketData } = buildPairPayloads(pair, payload());

    for (const field of ['high', 'low', 'firstVolume', 'secondVolume', 'last', 'markPrice', 'change', 'changePrice']) {
      expect(updatedPair[field]).toBe(stats[field]);
      expect(changeData[field]).toBe(stats[field]);
      expect(socketData[field]).toBe(stats[field]);
    }
    expect(isCoherent(updatedPair)).toBe(true);
    expect(isCoherent(changeData)).toBe(true);
    expect(isCoherent(socketData)).toBe(true);
  });

  test('the pair payload keeps the pair document fields it is merged onto', () => {
    const { updatedPair, changeData } = buildPairPayloads(pair, payload());

    expect(updatedPair.pairName).toBe('BTC/USD');
    expect(updatedPair.minQuantity).toBe(0.0001);
    expect(changeData._id).toBe('pair-1');
    expect(changeData.botstatus).toBe('binance');
    expect(changeData.firstCurrencySymbol).toBe('BTC');
  });

  test('REGRESSION: no random volume can survive - the same tick always builds the same payload', () => {
    const a = buildPairPayloads(pair, payload());
    const b = buildPairPayloads(pair, payload());

    expect(a.stats).toEqual(b.stats);
  });
});
