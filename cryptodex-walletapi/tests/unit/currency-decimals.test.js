/**
 * CURRENCY DISPLAY PRECISION
 *
 * The transfer modal could not print a coin's balance and its Max button
 * therefore filled the amount field with an empty string, so Confirm posted
 * amount:"" and the API answered 400. The whole chain started here: the API
 * answered `undefined` for every coin's precision, because the currency
 * documents on this deployment populate `decimals` and never `contractDecimal`,
 * while the client read `type == "token" ? decimals : contractDecimal`.
 *
 * These pin the resolution rule, and pin the exact downstream consequence of
 * getting it wrong - `truncateDecimals(value, undefined) === ''` - so the fix
 * cannot regress into "some number" that happens not to be undefined.
 */

import { describe, test, expect } from '@jest/globals';
import {
  resolveDisplayDecimals,
  withDisplayDecimals,
  withDisplayDecimalsList,
  MAX_DISPLAY_DECIMALS,
  DEFAULT_FIAT_DECIMALS,
  DEFAULT_CRYPTO_DECIMALS
} from '../../lib/currencyDecimals.js';

/** The frontend helper this precision is consumed by, reproduced exactly. */
const truncateDecimals = (num, decimals) => {
  let s = num.toString();
  let p = s.indexOf('.');
  s += (p < 0 ? ((p = 1 + s.length), '.') : '') + '0'.repeat(decimals);
  return s.slice(0, p + 1 + decimals);
};

/** The seeded documents, exactly as they come out of the collection. */
const SEEDED = [
  { coin: 'USDC', type: 'crypto', decimals: 6 },
  { coin: 'BTC', type: 'crypto', decimals: 8 },
  { coin: 'SOL', type: 'crypto', decimals: 9 },
  { coin: 'ETH', type: 'crypto', decimals: 18 },
  { coin: 'USD', type: 'fiat', decimals: 2 }
];

describe('resolveDisplayDecimals', () => {
  test('REGRESSION: every seeded currency resolves to a usable number, none to undefined', () => {
    for (const currency of SEEDED) {
      const decimals = resolveDisplayDecimals(currency);
      expect(Number.isInteger(decimals)).toBe(true);
      expect(decimals).toBeGreaterThanOrEqual(0);
      expect(decimals).toBeLessThanOrEqual(MAX_DISPLAY_DECIMALS);
    }
  });

  test('REGRESSION: the resolved precision actually prints a balance', () => {
    // With `undefined` this produced '' - the blank "Total:" line, and the
    // blank amount the Max button then posted.
    expect(truncateDecimals(1234.5, undefined)).toBe('');

    for (const currency of SEEDED) {
      const printed = truncateDecimals(1234.5, resolveDisplayDecimals(currency));
      expect(printed).not.toBe('');
      expect(parseFloat(printed)).toBeCloseTo(1234.5, 2);
    }
  });

  test('a token is answered from `decimals`, everything else from `contractDecimal`', () => {
    expect(resolveDisplayDecimals({ type: 'token', decimals: 6, contractDecimal: 2 })).toBe(6);
    expect(resolveDisplayDecimals({ type: 'crypto', decimals: 18, contractDecimal: 4 })).toBe(4);
  });

  test('falls back to the other field when the authoritative one is absent', () => {
    // This is the whole deployment: type crypto, contractDecimal never written.
    expect(resolveDisplayDecimals({ type: 'crypto', decimals: 6 })).toBe(6);
    expect(resolveDisplayDecimals({ type: 'token', contractDecimal: 6 })).toBe(6);
  });

  test('falls back to a type-appropriate default when neither field exists', () => {
    expect(resolveDisplayDecimals({ type: 'fiat' })).toBe(DEFAULT_FIAT_DECIMALS);
    expect(resolveDisplayDecimals({ type: 'crypto' })).toBe(DEFAULT_CRYPTO_DECIMALS);
    expect(resolveDisplayDecimals(null)).toBe(DEFAULT_CRYPTO_DECIMALS);
  });

  test('0 is a real precision and is kept, not treated as missing', () => {
    expect(resolveDisplayDecimals({ type: 'crypto', contractDecimal: 0, decimals: 8 })).toBe(0);
  });

  test('caps at 8 places - ETH resolves to 8, not 18', () => {
    expect(resolveDisplayDecimals({ coin: 'ETH', type: 'crypto', decimals: 18 })).toBe(8);
    expect(resolveDisplayDecimals({ type: 'token', decimals: 18 })).toBe(8);
  });

  test('ignores junk rather than propagating NaN', () => {
    expect(resolveDisplayDecimals({ type: 'crypto', contractDecimal: 'abc', decimals: 6 })).toBe(6);
    expect(resolveDisplayDecimals({ type: 'crypto', contractDecimal: -3, decimals: 6 })).toBe(6);
    expect(Number.isNaN(resolveDisplayDecimals({ type: 'crypto', decimals: 'x' }))).toBe(false);
  });

  test('accepts a numeric string, as Mongo rows sometimes carry', () => {
    expect(resolveDisplayDecimals({ type: 'crypto', contractDecimal: '4' })).toBe(4);
  });
});

describe('withDisplayDecimals', () => {
  test('adds displayDecimals and leaves the ledger meaning of `decimals` alone', () => {
    const row = withDisplayDecimals({ coin: 'ETH', type: 'crypto', decimals: 18 });

    expect(row.displayDecimals).toBe(8);
    expect(row.decimals).toBe(18); // on-chain precision, untouched
  });

  test('backfills contractDecimal so existing clients stop reading undefined', () => {
    const row = withDisplayDecimals({ coin: 'USDC', type: 'crypto', decimals: 6 });

    expect(row.contractDecimal).toBe(6);
    // The exact expression the transfer modal evaluates.
    const clientDecimals = row.type === 'token' ? row.decimals : row.contractDecimal;
    expect(truncateDecimals(10000, clientDecimals)).toBe('10000.000000');
  });

  test('never overwrites a contractDecimal the document really has', () => {
    // Chosen so the backfill value and the real value DIFFER: a token reads its
    // display precision from `decimals`, and an 18-place contractDecimal is
    // above the display cap. Overwriting either would be silently changing a
    // stored figure rather than filling in a missing one.
    const token = withDisplayDecimals({ type: 'token', decimals: 6, contractDecimal: 2 });
    expect(token.displayDecimals).toBe(6);
    expect(token.contractDecimal).toBe(2);

    const deepCrypto = withDisplayDecimals({ type: 'crypto', contractDecimal: 18 });
    expect(deepCrypto.displayDecimals).toBe(8);
    expect(deepCrypto.contractDecimal).toBe(18);

    expect(withDisplayDecimals({ type: 'crypto', contractDecimal: 0, decimals: 8 }).contractDecimal).toBe(0);
  });

  test('maps a whole list and passes non-arrays through untouched', () => {
    const rows = withDisplayDecimalsList(SEEDED);
    expect(rows.map((r) => r.displayDecimals)).toEqual([6, 8, 8, 8, 2]);
    expect(withDisplayDecimalsList(null)).toBe(null);
  });
});
