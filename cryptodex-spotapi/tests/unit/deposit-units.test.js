/**
 * Base-unit codec for deposit amounts (lib/depositUnits.js)
 *
 * `DepositEvent.amount` is a base-unit integer STRING and `decimals` says how
 * many of its digits are fractional. The faucet writes it, the history endpoint
 * reads it, and until the faucet had to record a fractional 0.05 BTC leg both
 * ends hard-coded 1e6 independently.
 *
 * The reason this is string arithmetic and not `* 1e8` is two lines of IEEE-754:
 *
 *     0.07  * 1e8 === 7000000.000000001
 *     1.005 * 1e8 === 100499999.99999999
 *
 * A ledger row that reads "7000000.000000001 base units" is not an integer, so
 * nothing downstream can decode it. The faucet's current constants (0.05, 1,
 * 50) happen to scale cleanly - which is why the naive version survived, and
 * why the guard has to be pinned by a value that does not.
 */

import { describe, test, expect } from '@jest/globals';
import {
  toBaseUnits,
  fromBaseUnits,
  DEPOSIT_DECIMALS,
  LEGACY_DEPOSIT_DECIMALS,
} from '../../lib/depositUnits.js';

describe('toBaseUnits', () => {
  test('encodes the faucet grant exactly', () => {
    expect(toBaseUnits(10000, 8)).toBe('1000000000000');
  });

  test('encodes a fractional eight-decimal amount exactly', () => {
    expect(toBaseUnits(0.05, 8)).toBe('5000000');
  });

  test('encodes an amount the naive multiply gets wrong (the guard)', () => {
    // These are what a `* 1e8` implementation actually produces.
    expect(0.07 * 1e8).toBe(7000000.000000001);
    expect(1.005 * 1e8).toBe(100499999.99999999);

    expect(toBaseUnits(0.07, 8)).toBe('7000000');
    expect(toBaseUnits(1.005, 8)).toBe('100500000');
  });

  test('always produces an integer string', () => {
    for (const amount of [0.05, 1, 50, 10000, 0.1, 0.3, 1.005, 123.456789012]) {
      expect(toBaseUnits(amount, 8)).toMatch(/^-?\d+$/);
    }
  });

  test('encodes zero as "0", not "" or "00000000"', () => {
    expect(toBaseUnits(0, 8)).toBe('0');
  });

  test('encodes the smallest representable unit', () => {
    expect(toBaseUnits(0.00000001, 8)).toBe('1');
  });

  test('rounds at the stored scale rather than truncating silently', () => {
    // 9 dp at a scale of 8: the ninth digit rounds the eighth, it is not cut.
    expect(toBaseUnits(0.000000016, 8)).toBe('2');
    expect(toBaseUnits(0.000000014, 8)).toBe('1');
  });

  test('keeps the sign', () => {
    expect(toBaseUnits(-0.05, 8)).toBe('-5000000');
  });

  test('refuses a non-numeric amount instead of writing "NaN" to a ledger', () => {
    expect(toBaseUnits('abc', 8)).toBeNull();
    expect(toBaseUnits(undefined, 8)).toBeNull();
    expect(toBaseUnits(Infinity, 8)).toBeNull();
  });

  test('accepts a numeric string', () => {
    expect(toBaseUnits('0.05', 8)).toBe('5000000');
  });

  test('falls back to the default scale for a nonsense scale', () => {
    expect(toBaseUnits(0.05, undefined)).toBe(toBaseUnits(0.05, DEPOSIT_DECIMALS));
    expect(toBaseUnits(0.05, -3)).toBe(toBaseUnits(0.05, DEPOSIT_DECIMALS));
  });
});

describe('fromBaseUnits', () => {
  test('decodes the faucet grant with no trailing zeros', () => {
    expect(fromBaseUnits('1000000000000', 8)).toBe('10000');
  });

  test('decodes sub-unit collateral', () => {
    expect(fromBaseUnits('5000000', 8)).toBe('0.05');
    expect(fromBaseUnits('100000000', 8)).toBe('1');
    expect(fromBaseUnits('5000000000', 8)).toBe('50');
  });

  test('decodes the pre-existing 1e6 rows at their own scale', () => {
    expect(fromBaseUnits('10000000000', 6)).toBe('10000');
    expect(fromBaseUnits('10000000000', LEGACY_DEPOSIT_DECIMALS)).toBe('10000');
  });

  test('defaults to the legacy scale, which is what a row without decimals was written at', () => {
    expect(fromBaseUnits('10000000000')).toBe('10000');
  });

  test('keeps the smallest unit rather than rounding it away', () => {
    expect(fromBaseUnits('1', 8)).toBe('0.00000001');
  });

  test('decodes zero as "0"', () => {
    expect(fromBaseUnits('0', 8)).toBe('0');
    expect(fromBaseUnits('00000000', 8)).toBe('0');
  });

  test('never reports "-0"', () => {
    expect(fromBaseUnits('-0', 8)).toBe('0');
  });

  test('keeps a real negative', () => {
    expect(fromBaseUnits('-5000000', 8)).toBe('-0.05');
  });

  test('survives a scale of zero', () => {
    expect(fromBaseUnits('1234', 0)).toBe('1234');
  });

  test('does not mangle a non-integer amount written by some other path', () => {
    expect(fromBaseUnits('12.5', 6)).toBe('0.0000125');
  });

  test('yields "0" rather than NaN for junk', () => {
    expect(fromBaseUnits('abc', 8)).toBe('0');
    expect(fromBaseUnits(undefined, 8)).toBe('0');
    expect(fromBaseUnits(null, 8)).toBe('0');
  });
});

describe('round trip', () => {
  test('every amount the faucet credits survives encode -> decode', () => {
    for (const amount of [10000, 0.05, 1, 50, 0.00000001, 0]) {
      const encoded = toBaseUnits(amount, DEPOSIT_DECIMALS);
      expect(Number(fromBaseUnits(encoded, DEPOSIT_DECIMALS))).toBe(amount);
    }
  });
});
