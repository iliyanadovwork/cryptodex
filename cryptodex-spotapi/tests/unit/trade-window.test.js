/**
 * THE 24H WINDOW, OVER TRADES THAT CAME BACK THROUGH JSON
 *
 * A trade cached in `tradeHistory_<pairId>` has a STRING createdAt; the same
 * trade read from mongo has a DATE. `marketPrice()` walked both with
 * `a.createdAt - b.createdAt` and `trade.createdAt >= new Date(...)`, which
 * are a NaN sort and an always-false comparison on strings - so a locally
 * matched pair published a 24h high, low, volume, turnover and change of ZERO
 * while the trades sat in the hash.
 *
 * These pin the comparison to the one representation both forms convert to.
 */

import { describe, test, expect } from '@jest/globals';
import {
  tradeTime,
  byTradeTime,
  inLast24h,
  WINDOW_MS,
} from '../../lib/tradeWindow.js';

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const at = (msAgo) => new Date(NOW - msAgo);

describe('tradeTime', () => {
  test('reads a Date, an ISO string and an epoch as the same instant', () => {
    const date = at(0);
    expect(tradeTime({ createdAt: date })).toBe(NOW);
    expect(tradeTime({ createdAt: date.toISOString() })).toBe(NOW);
    expect(tradeTime({ createdAt: NOW })).toBe(NOW);
  });

  test('a trade with no readable timestamp has no time', () => {
    expect(Number.isNaN(tradeTime({ createdAt: undefined }))).toBe(true);
    expect(Number.isNaN(tradeTime({ createdAt: null }))).toBe(true);
    expect(Number.isNaN(tradeTime({ createdAt: 'yesterday-ish' }))).toBe(true);
    expect(Number.isNaN(tradeTime({}))).toBe(true);
    expect(Number.isNaN(tradeTime(null))).toBe(true);
    expect(Number.isNaN(tradeTime({ createdAt: Infinity }))).toBe(true);
  });

  test('an unreadable timestamp is not the epoch', () => {
    // 0 would place the trade in January 1970 - outside every window, but by
    // accident rather than by decision, and inside a sort it would become the
    // window's "first" trade and therefore its open price.
    expect(tradeTime({ createdAt: 'nonsense' })).not.toBe(0);
  });
});

describe('byTradeTime', () => {
  test('sorts string timestamps into the order they happened', () => {
    const trades = [
      { id: 'c', createdAt: at(0).toISOString() },
      { id: 'a', createdAt: at(3 * 3600 * 1000).toISOString() },
      { id: 'b', createdAt: at(2 * 3600 * 1000).toISOString() }
    ];
    expect([...trades].sort(byTradeTime).map((t) => t.id)).toEqual([
      'a',
      'b',
      'c'
    ]);
  });

  test('sorts mixed Dates and strings together', () => {
    const trades = [
      { id: 'c', createdAt: at(0) },
      { id: 'a', createdAt: at(3 * 3600 * 1000).toISOString() },
      { id: 'b', createdAt: at(2 * 3600 * 1000) }
    ];
    expect([...trades].sort(byTradeTime).map((t) => t.id)).toEqual([
      'a',
      'b',
      'c'
    ]);
  });

  test('the subtraction it replaces produced no order at all', () => {
    const older = { createdAt: at(3 * 3600 * 1000).toISOString() };
    const newer = { createdAt: at(0).toISOString() };
    expect(Number.isNaN(newer.createdAt - older.createdAt)).toBe(true);
    expect(byTradeTime(older, newer)).toBeLessThan(0);
  });

  test('an undateable trade never becomes the window open', () => {
    const trades = [
      { id: 'broken', createdAt: 'nonsense' },
      { id: 'first', createdAt: at(3 * 3600 * 1000).toISOString() },
      { id: 'last', createdAt: at(0).toISOString() }
    ];
    expect([...trades].sort(byTradeTime).map((t) => t.id)).toEqual([
      'first',
      'last',
      'broken'
    ]);
  });

  test('two undateable trades do not reorder each other', () => {
    expect(byTradeTime({ createdAt: 'x' }, { createdAt: 'y' })).toBe(0);
  });

  test('an undateable trade sorts after a dateable one, whichever side it is on', () => {
    const dateable = { createdAt: at(0).toISOString() };
    const broken = { createdAt: 'nonsense' };
    expect(byTradeTime(broken, dateable)).toBeGreaterThan(0);
    expect(byTradeTime(dateable, broken)).toBeLessThan(0);
  });
});

describe('inLast24h', () => {
  test('a string timestamp inside the window counts', () => {
    expect(inLast24h({ createdAt: at(3600 * 1000).toISOString() }, NOW)).toBe(true);
  });

  test('the comparison it replaces excluded every cached trade', () => {
    const iso = at(3600 * 1000).toISOString();
    // exactly what the shipped line evaluated
    expect(iso >= new Date(NOW - WINDOW_MS)).toBe(false);
    // what it should have said
    expect(inLast24h({ createdAt: iso }, NOW)).toBe(true);
  });

  test('a Date inside the window counts the same way', () => {
    expect(inLast24h({ createdAt: at(3600 * 1000) }, NOW)).toBe(true);
  });

  test('both edges of the window are inside it', () => {
    expect(inLast24h({ createdAt: new Date(NOW - WINDOW_MS) }, NOW)).toBe(true);
    expect(inLast24h({ createdAt: new Date(NOW) }, NOW)).toBe(true);
  });

  test('older than the window is out', () => {
    expect(inLast24h({ createdAt: new Date(NOW - WINDOW_MS - 1) }, NOW)).toBe(
      false
    );
    expect(
      inLast24h({ createdAt: new Date(NOW - WINDOW_MS - 1).toISOString() }, NOW)
    ).toBe(false);
  });

  test('a trade stamped in the future cannot add to today', () => {
    expect(inLast24h({ createdAt: new Date(NOW + 1) }, NOW)).toBe(false);
    expect(inLast24h({ createdAt: new Date(NOW + 60000).toISOString() }, NOW)).toBe(
      false
    );
  });

  test('an undateable trade is not in the window', () => {
    expect(inLast24h({ createdAt: 'nonsense' }, NOW)).toBe(false);
    expect(inLast24h({}, NOW)).toBe(false);
    expect(inLast24h(null, NOW)).toBe(false);
  });

  test('the window is 24 hours', () => {
    expect(WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  test('defaults to now', () => {
    expect(inLast24h({ createdAt: new Date() })).toBe(true);
    expect(inLast24h({ createdAt: new Date(Date.now() - WINDOW_MS - 5000) })).toBe(
      false
    );
  });
});
