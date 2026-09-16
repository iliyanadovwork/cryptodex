/**
 * EVERY ROUNDING AND TRUNCATION HELPER IN THE SPOT SERVICE, PINNED.
 * ================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `lib/roundOf.toFixedDown` matches `(\d+\.\d{type})(\d)` against
 * `Number.prototype.toString()`. `\d` cannot match "-", so for any NEGATIVE
 * value carrying more decimals than `type` the match began AFTER the minus and
 * `parseFloat(m[1])` returned the MAGNITUDE:
 *
 *     toFixedDown(-1.234567891, 8)  ->  1.23456789      // sign flipped
 *     toFixedDown(-0.5, 1)          -> -0.5             // no match, correct
 *
 * An earlier copy of this function turned a stored -4923.36 into +4923.36 and
 * the flipped sign was then acted on as if it were real money. Spot applies the
 * same function to passbook `beforeBalance`/`afterBalance` rows and to refund
 * amounts derived from DIFFERENCES - the shape of value that can go negative -
 * which is why it matters here.
 *
 * The same regex could not read a second thing: EXPONENT notation. JavaScript
 * stringifies any magnitude below 1e-6 as e.g. "5e-8", which matched nothing,
 * so the value was returned WHOLE - truncation to the ledger's precision
 * silently not happening, and more decimals coming back than were asked for.
 *
 * HOW THIS FILE IS WRITTEN
 * ------------------------
 * Every guard is asserted on the SHIPPING helper and again on a verbatim copy
 * of the ORIGINAL (`originalToFixedDown` / `signOnlyToFixedDown`), to prove the
 * assertion discriminates. A test that passes on both the fixed and the broken
 * function is worth nothing. Over-correction mutants - "just take Math.abs",
 * "always negate", "round instead of truncate", "zero anything exponential" -
 * get the same treatment.
 */

import * as roundOf from '../../lib/roundOf.js';
import {
  toFixed,
  toFixedDown,
  convert,
  truncateDecimals,
} from '../../lib/roundOf.js';
import isEmpty from '../../lib/isEmpty.js';

/* ------------------------------------------------------------------ */
/* The implementation as it shipped before this round, verbatim.       */
/* ------------------------------------------------------------------ */

const originalToFixedDown = (item, type = 2) => {
  try {
    if (!isEmpty(item) && !isNaN(item)) {
      item = parseFloat(item);
      let decReg = new RegExp('(\\d+\\.\\d{' + type + '})(\\d)'),
        m = item.toString().match(decReg);
      return m ? parseFloat(m[1]) : item.valueOf();
    }
    return '';
  } catch (err) {
    return '';
  }
};

/** The sign fix alone, without the exponent fix. */
const signOnlyToFixedDown = (item, type = 2) => {
  try {
    if (!isEmpty(item) && !isNaN(item)) {
      item = parseFloat(item);
      const negative = item < 0;
      const magnitude = Math.abs(item);
      let decReg = new RegExp('(\\d+\\.\\d{' + type + '})(\\d)'),
        m = magnitude.toString().match(decReg);
      const truncated = m ? parseFloat(m[1]) : magnitude.valueOf();
      return negative ? -truncated : truncated;
    }
    return '';
  } catch (err) {
    return '';
  }
};

/* ================================================================== */
/* 1. toFixedDown - sign                                              */
/* ================================================================== */

describe('toFixedDown: the sign of a negative survives truncation', () => {
  const negatives = [
    [-4923.3618133400005, 8, -4923.36181334],
    [-1.234567891, 8, -1.23456789],
    [-1.999999999, 8, -1.99999999],
    [-0.123456, 2, -0.12],
  ];

  test.each(negatives)(
    'toFixedDown(%p, %p) === %p, magnitude truncated, sign kept',
    (input, digits, expected) => {
      expect(toFixedDown(input, digits)).toBeCloseTo(expected, digits);
    }
  );

  test('MUTATION CHECK: the original returned the MAGNITUDE for every one of them', () => {
    for (const [input, digits, expected] of negatives) {
      const was = originalToFixedDown(input, digits);
      expect(was).toBeGreaterThan(0);
      expect(was).toBeCloseTo(-expected, digits);
      expect(Math.sign(was)).not.toBe(Math.sign(toFixedDown(input, digits)));
    }
  });

  test('MUTATION CHECK: an "always take Math.abs" helper fails the same assertions', () => {
    const absMutant = (v, d) => Math.abs(toFixedDown(v, d));
    expect(absMutant(-1.234567891, 8)).not.toBeCloseTo(-1.23456789, 8);
  });

  test('MUTATION CHECK: an "always negate" helper breaks the positives', () => {
    const negateMutant = (v, d) => -toFixedDown(v, d);
    expect(negateMutant(1.234567891, 8)).not.toBeCloseTo(1.23456789, 8);
    expect(toFixedDown(1.234567891, 8)).toBeCloseTo(1.23456789, 8);
  });

  test('a negative that needs no truncation is unchanged, as it always was', () => {
    expect(toFixedDown(-0.5, 1)).toBe(-0.5);
    expect(toFixedDown(-12, 8)).toBe(-12);
    expect(originalToFixedDown(-0.5, 1)).toBe(-0.5);
    expect(originalToFixedDown(-12, 8)).toBe(-12);
  });

  test('truncation is toward zero on BOTH sides - never away from it', () => {
    expect(Math.abs(toFixedDown(-1.999999999, 8))).toBeLessThan(1.999999999);
    expect(Math.abs(toFixedDown(1.999999999, 8))).toBeLessThan(1.999999999);
    // ...and this is the difference from toFixed, which rounds to nearest.
    expect(toFixed(1.999999999, 8)).toBeCloseTo(2, 8);
    expect(toFixed(-1.999999999, 8)).toBeCloseTo(-2, 8);
  });

  test('negative zero stringifies as "0", so no ledger row is written "-0"', () => {
    expect(toFixedDown(-0.005, 2) === 0).toBe(true);
    expect(String(toFixedDown(-0.005, 2))).toBe('0');
    expect(toFixedDown(-0, 8) === 0).toBe(true);
    expect(String(toFixedDown(-0, 8))).toBe('0');
  });

  test('the passbook shape this actually protects: a negative running balance', () => {
    // spot.controller.js passes `hincbyfloat` results straight into
    // toFixedDown for passbook beforeBalance/afterBalance. hincbyfloat answers
    // a STRING, and it answers a NEGATIVE string whenever a balance is
    // overdrawn - which is exactly the case deductCryptodex checks for with
    // `parseFloat(userbalance) < 0`.
    const overdrawn = '-0.123456789123';
    expect(toFixedDown(overdrawn, 8)).toBeCloseTo(-0.12345678, 10);
    // MUTATION CHECK: the original wrote that row as a CREDIT of the same size.
    expect(originalToFixedDown(overdrawn, 8)).toBeCloseTo(0.12345678, 10);
    // ...a passbook row 0.24691356 out, in the direction that flatters the
    // account, on a balance the caller had already established was negative.
  });
});

/* ================================================================== */
/* 2. toFixedDown - exponent notation                                 */
/* ================================================================== */

describe('toFixedDown: a value below 1e-6 is truncated, not waved through', () => {
  test('sub-satoshi dust truncates to zero at 8 decimals', () => {
    expect(toFixedDown(1e-9, 8)).toBe(0);
    expect(toFixedDown(4.99e-9, 8)).toBe(0);
    expect(toFixedDown(-1e-9, 8) === 0).toBe(true);
    expect(String(toFixedDown(-1e-9, 8))).toBe('0');
  });

  test('a value with one digit too many keeps exactly `type` decimals', () => {
    expect(toFixedDown(0.000000109, 8)).toBeCloseTo(0.0000001, 12);
    expect(toFixedDown(-0.000000109, 8)).toBeCloseTo(-0.0000001, 12);
  });

  test('MUTATION CHECK: both earlier versions returned the value WHOLE', () => {
    expect(originalToFixedDown(1e-9, 8)).toBe(1e-9);
    expect(signOnlyToFixedDown(1e-9, 8)).toBe(1e-9);
    expect(originalToFixedDown(0.000000109, 8)).toBe(0.000000109);
    expect(signOnlyToFixedDown(0.000000109, 8)).toBe(0.000000109);
    expect(signOnlyToFixedDown(0.000000109, 8)).not.toBeCloseTo(0.0000001, 12);
  });

  test('MUTATION CHECK: "round instead of truncate" over-corrects the same inputs', () => {
    expect(toFixed(0.000000109, 8)).toBeCloseTo(0.00000011, 12);
    expect(toFixedDown(0.000000109, 8)).toBeLessThan(toFixed(0.000000109, 8));
  });

  test('MUTATION CHECK: "return 0 for anything exponential" over-corrects', () => {
    expect(toFixedDown(1e-7, 8)).toBe(1e-7);
    expect(toFixedDown(-1e-7, 8)).toBe(-1e-7);
    expect(toFixedDown(5e-8, 8)).toBe(5e-8);
  });

  test('the plain-notation range is bit-for-bit unmoved by the exponent fix', () => {
    const unmoved = [3.694, 0.000001, 0.5, 73.88, 1234.5, 0, 12, 1e21];
    for (const v of unmoved) {
      expect(toFixedDown(v, 8)).toBe(originalToFixedDown(v, 8));
    }
  });
});

/* ================================================================== */
/* 3. toFixedDown - non-numeric, no-decimal and infinite inputs       */
/* ================================================================== */

describe('toFixedDown: inputs that are not ordinary decimals', () => {
  test('a value with no decimal part is returned unchanged, either sign', () => {
    expect(toFixedDown(12, 8)).toBe(12);
    expect(toFixedDown(-12, 8)).toBe(-12);
    expect(toFixedDown(0, 8)).toBe(0);
  });

  test('a numeric STRING is parsed, and its sign is kept', () => {
    expect(toFixedDown('12.3456789012', 8)).toBeCloseTo(12.3456789, 8);
    expect(toFixedDown('-12.3456789012', 8)).toBeCloseTo(-12.3456789, 8);
    expect(originalToFixedDown('-12.3456789012', 8)).toBeCloseTo(12.3456789, 8);
  });

  test('a non-number is the empty string every caller guards against', () => {
    expect(toFixedDown('abc', 8)).toBe('');
    expect(toFixedDown(NaN, 8)).toBe('');
    expect(toFixedDown(undefined, 8)).toBe('');
    expect(toFixedDown(null, 8)).toBe('');
    expect(toFixedDown('', 8)).toBe('');
  });

  test('Infinity is now REFUSED like every other untruncatable input', () => {
    // WAS "passes straight through - recorded, not endorsed". It is endorsed
    // no longer: see section 8 below for the full argument and the mutants.
    expect(toFixedDown(Infinity, 8)).toBe('');
    expect(toFixedDown(-Infinity, 8)).toBe('');
    expect(originalToFixedDown(Infinity, 8)).toBe(Infinity);
  });
});

/* ================================================================== */
/* 4. toFixed                                                         */
/* ================================================================== */

describe('toFixed: rounds to nearest and is sign-correct by construction', () => {
  test('it delegates to Number.prototype.toFixed, so "-" is never lost', () => {
    expect(toFixed(-1.239, 2)).toBe(-1.24);
    expect(toFixed(1.239, 2)).toBe(1.24);
    // Ties go AWAY from zero on both sides. Recorded because it is the one
    // rounding rule in this service that can round a debit up in magnitude.
    expect(toFixed(-0.005, 2)).toBe(-0.01);
    expect(toFixed(0.005, 2)).toBe(0.01);
  });

  test('exponent-notation input is handled by the primitive', () => {
    expect(toFixed(1e-9, 8)).toBe(0);
    expect(toFixed(-1e-9, 8) === 0).toBe(true);
    expect(String(toFixed(-1e-9, 8))).toBe('0');
    expect(toFixed(1.09e-7, 8)).toBeCloseTo(0.00000011, 12);
  });

  test('no-decimal, string, NaN, empty and Infinity inputs', () => {
    expect(toFixed(12, 8)).toBe(12);
    expect(toFixed(-12, 8)).toBe(-12);
    expect(toFixed('12.345', 2)).toBe(12.35);
    expect(toFixed(NaN, 8)).toBe('');
    expect(toFixed(null, 8)).toBe('');
    expect(toFixed('', 8)).toBe('');
    // RangeError inside the try - toFixed accepts 0..100 digits - is swallowed
    // into the same empty string.
    expect(toFixed(1.5, 500)).toBe('');
    expect(toFixed(Infinity, 8)).toBe(Infinity);
    expect(toFixed(-Infinity, 8)).toBe(-Infinity);
  });
});

/* ================================================================== */
/* 5. convert - the exponent expander both truncators lean on         */
/* ================================================================== */

describe('convert: exponential -> plain decimal, sign kept', () => {
  test('small magnitudes expand with the right number of zeros, either sign', () => {
    expect(convert(5e-8)).toBe('0.00000005');
    expect(convert(-5e-8)).toBe('-0.00000005');
    expect(convert(1.09e-7)).toBe('0.000000109');
    expect(convert(-1.09e-7)).toBe('-0.000000109');
    expect(parseFloat(convert(-5e-8))).toBe(-5e-8);
  });

  test('large magnitudes expand too', () => {
    expect(parseFloat(convert(1e21))).toBe(1e21);
    expect(parseFloat(convert(-1e21))).toBe(-1e21);
  });

  test('a value already in plain notation is handed back untouched', () => {
    expect(convert(0.000001)).toBe(0.000001);
    expect(convert(-73.88)).toBe(-73.88);
    expect(convert(0)).toBe(0);
  });

  test('NaN and Infinity contain no "e" and are returned as-is', () => {
    expect(Number.isNaN(convert(NaN))).toBe(true);
    expect(convert(Infinity)).toBe(Infinity);
    expect(convert(-Infinity)).toBe(-Infinity);
  });
});

/* ================================================================== */
/* 6. truncateDecimals - string arithmetic, correct on sign           */
/* ================================================================== */

describe('truncateDecimals: cuts toward zero and returns a STRING', () => {
  test('the sign survives, and the magnitude is cut not rounded', () => {
    expect(truncateDecimals(1.234567891, 8)).toBe('1.23456789');
    expect(truncateDecimals(-1.234567891, 8)).toBe('-1.23456789');
    expect(parseFloat(truncateDecimals(-1.999999999, 8))).toBeCloseTo(
      -1.99999999,
      8
    );
  });

  test('it goes through convert(), so exponent notation is not mis-read', () => {
    expect(parseFloat(truncateDecimals(5e-8, 8))).toBeCloseTo(5e-8, 12);
    expect(parseFloat(truncateDecimals(-5e-8, 8))).toBeCloseTo(-5e-8, 12);
    expect(parseFloat(truncateDecimals(1e-9, 8))).toBe(0);
  });

  test('a value with no decimal part is padded to the requested scale', () => {
    expect(parseFloat(truncateDecimals(12, 8))).toBe(12);
    expect(parseFloat(truncateDecimals(-12, 8))).toBe(-12);
    expect(parseFloat(truncateDecimals(0, 8))).toBe(0);
  });

  test('it does NOT scale by 1e8, so it cannot shave a unit off an exact value', () => {
    // The obvious alternative - Math.floor(x * 1e8) / 1e8 - gets this wrong,
    // because 0.29 * 1e8 is 28999999.999999996. String arithmetic does not.
    expect(parseFloat(truncateDecimals(0.29, 8))).toBe(0.29);
    expect(Math.floor(0.29 * 1e8) / 1e8).toBeCloseTo(0.28999999, 8);
  });

  test('NaN, Infinity and "" no longer get a decimal tail they never earned', () => {
    // WAS "NaN.00000000" / "Infinity.00000000" / ".00000000" - a decimal-
    // looking string built around a value that has no decimals, which is what
    // string surgery on Number.toString() produces when nobody asks whether the
    // value is a number first. These reach the passbook writers at
    // spot.controller.js:7292-7294 and 7385-7401.
    expect(truncateDecimals(NaN, 8)).toBe('NaN');
    expect(truncateDecimals(Infinity, 8)).toBe('Infinity');
    expect(truncateDecimals(-Infinity, 8)).toBe('-Infinity');
    expect(truncateDecimals('', 8)).toBe('NaN');
    expect(truncateDecimals(null, 8)).toBe('NaN');
    expect(truncateDecimals(undefined, 8)).toBe('NaN');
  });

  test('NUMERICALLY INERT for NaN, Infinity and the trailing dot', () => {
    // The safety argument for touching a helper that populates passbook rows:
    // every arithmetic call site (spot.controller.js:6744-6745 and the two
    // `total * quantity` order gates)
    // coerces the string, and for these inputs the coercion is IDENTICAL
    // before and after - only the literal text changes.
    expect(parseFloat('NaN.00000000')).toBeNaN();
    expect(parseFloat(truncateDecimals(NaN, 8))).toBeNaN();
    expect(parseFloat('Infinity.00000000')).toBe(Infinity);
    expect(parseFloat(truncateDecimals(Infinity, 8))).toBe(Infinity);
    expect(parseFloat('1.')).toBe(1);
    expect(parseFloat(truncateDecimals(1.999, 0))).toBe(1);
  });

  test('NOT INERT for an ABSENT value, deliberately: it used to fabricate a 0', () => {
    // `parseFloat('.00000000')` is 0, not NaN - so an EMPTY or UNDEFINED input
    // used to come back as a string that reads as ZERO. (undefined took the
    // other route: `convert` throws on `undefined.toString()`, catches, returns
    // 0, and the result was the literal "0.00000000".) Both are a number nobody
    // computed standing in for a value that was never read, which is the exact
    // failure this codebase has now paid for three times.
    expect(parseFloat('.00000000')).toBe(0);
    expect(parseFloat('0.00000000')).toBe(0);
    // It is NOT preserved. An absent value is now unparseable, which is what
    // the consumers are built for: grpc/walletService.passbook parseFloats and
    // finite-checks every balance field and REFUSES the row (loudly) rather
    // than storing it, and redis HINCRBYFLOAT refuses a non-float outright.
    // A missing audit row that was shouted about beats a fabricated 0.
    expect(parseFloat(truncateDecimals('', 8))).toBeNaN();
    expect(parseFloat(truncateDecimals(undefined, 8))).toBeNaN();
    expect(parseFloat(truncateDecimals(null, 8))).toBeNaN();
    for (const bad of [NaN, Infinity, -Infinity, '', null, undefined]) {
      expect(Number.isFinite(parseFloat(truncateDecimals(bad, 8)))).toBe(false);
    }
  });

  test('zero decimal places means NO decimal point, not a bare trailing dot', () => {
    // WAS "1." - not a number anything can render, and it is used as an order
    // quantity whenever a pair's floatDigit is 0.
    expect(truncateDecimals(1.999, 0)).toBe('1');
    expect(truncateDecimals(-1.999, 0)).toBe('-1');
    expect(truncateDecimals(12, 0)).toBe('12');
    expect(truncateDecimals(0.9, 0)).toBe('0');
    expect(parseFloat(truncateDecimals(1.999, 0))).toBe(1);
  });

  test('MUTATION CHECK: the pre-fix implementation produced all four', () => {
    const original = (num, decimals) => {
      num = convert(num);
      let s = num.toString(),
        p = s.indexOf('.');
      s += (p < 0 ? ((p = 1 + s.length), '.') : '') + '0'.repeat(decimals);
      return s.slice(0, p + 1 + decimals);
    };
    expect(original(1.999, 0)).toBe('1.');
    expect(original(NaN, 8)).toBe('NaN.00000000');
    expect(original(Infinity, 8)).toBe('Infinity.00000000');
    expect(original('', 8)).toBe('.00000000');
    // and every one of them differs from what ships now
    expect(original(1.999, 0)).not.toBe(truncateDecimals(1.999, 0));
    expect(original(NaN, 8)).not.toBe(truncateDecimals(NaN, 8));
    expect(original(Infinity, 8)).not.toBe(truncateDecimals(Infinity, 8));
    expect(original('', 8)).not.toBe(truncateDecimals('', 8));
  });

  test('OVER-CORRECTION CHECK: the return type is STILL A STRING, and still padded', () => {
    // Returning a NUMBER instead is deliberately NOT done: callers display and
    // log the padded spelling, and "1.50000000" is not "1.5". A "just return a
    // number" mutant fails here.
    expect(typeof truncateDecimals(1.5, 8)).toBe('string');
    expect(truncateDecimals(1.5, 8)).toBe('1.50000000');
    expect(truncateDecimals(12, 8)).toBe('12.00000000');
    expect(truncateDecimals(1.234567891, 8)).toBe('1.23456789');
    const numberMutant = (n, d) => parseFloat(truncateDecimals(n, d));
    expect(String(numberMutant(1.5, 8))).toBe('1.5');
    expect(String(numberMutant(1.5, 8))).not.toBe(truncateDecimals(1.5, 8));
  });

  test('OVER-CORRECTION CHECK: an "empty for anything odd" mutant loses real values', () => {
    // A guard placed on the wrong side - refusing every input that is not a
    // primitive number, say - would swallow the numeric strings the callers
    // really pass (a mongo Decimal, a gRPC convertPrice).
    expect(truncateDecimals('1.234567891', 8)).toBe('1.23456789');
    expect(truncateDecimals('-1.234567891', 8)).toBe('-1.23456789');
    expect(truncateDecimals(0, 8)).toBe('0.00000000');
    expect(parseFloat(truncateDecimals(0.29, 8))).toBe(0.29);
  });
});

/* ================================================================== */
/* 7. longNumbers - DELETED                                           */
/* ================================================================== */

describe('longNumbers: DELETED, and it must stay deleted', () => {
  test('the module no longer exports it', () => {
    // No call site anywhere in this service. It threw a TypeError on EVERY
    // call - `Number.prototype.toFixedNoRounding` is defined only in the
    // frontend copy of roundOf.js - and
    // its first branch, `if (x < 0.000001) return 0.0`, is true for every
    // NEGATIVE number, so any loss routed through it would have shown as 0.
    expect(roundOf.longNumbers).toBeUndefined();
    expect(Object.keys(roundOf)).not.toContain('longNumbers');
  });

  test('the prototype it depended on is still absent, so re-adding it cannot work', () => {
    expect(typeof Number.prototype.toFixedNoRounding).toBe('undefined');
  });

  test('MUTATION CHECK: the sign bug it carried, asserted on the predicate', () => {
    const smallBranch = (x) => x < 0.000001;
    expect(smallBranch(-4923.36)).toBe(true);
    expect(smallBranch(4923.36)).toBe(false);
    // A magnitude test is what was meant.
    expect(Math.abs(-4923.36) < 0.000001).toBe(false);
  });
});

/* ================================================================== */
/* 8. toFixedDown - Infinity                                          */
/* ================================================================== */

describe('toFixedDown: an infinity is REFUSED, not handed back untruncated', () => {
  /** The helper exactly as it shipped before this round (post-exponent fix). */
  const infinityPassthroughMutant = (item, type = 2) => {
    try {
      if (!isEmpty(item) && !isNaN(item)) {
        item = parseFloat(item);
        const negative = item < 0;
        const magnitude = Math.abs(item);
        const s = magnitude.toString();
        const plain =
          !/e/i.test(s) || !Number.isFinite(magnitude) || magnitude >= 1e21
            ? s
            : magnitude.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
        const m = plain.match(new RegExp('(\\d+\\.\\d{' + type + '})(\\d)'));
        const truncated = m ? parseFloat(m[1]) : magnitude.valueOf();
        return negative ? -truncated : truncated;
      }
      return '';
    } catch (err) {
      return '';
    }
  };

  test('Infinity and -Infinity answer "", the same as NaN and null', () => {
    expect(toFixedDown(Infinity, 8)).toBe('');
    expect(toFixedDown(-Infinity, 8)).toBe('');
    expect(toFixedDown('Infinity', 8)).toBe('');
    expect(toFixedDown(1 / 0, 8)).toBe('');
    // ...which is the answer it has ALWAYS given for every other input it
    // cannot truncate. That is the argument for "" over 0: an infinity now
    // lands on a path every caller was already exposed to, rather than a new
    // one - and a fabricated 0 in a money figure is its own bug.
    expect(toFixedDown(NaN, 8)).toBe('');
    expect(toFixedDown(null, 8)).toBe('');
    expect(toFixedDown(undefined, 8)).toBe('');
    expect(toFixedDown('', 8)).toBe('');
  });

  test('MUTATION CHECK: the shipped-before version returned the infinity ITSELF', () => {
    expect(infinityPassthroughMutant(Infinity, 8)).toBe(Infinity);
    expect(infinityPassthroughMutant(-Infinity, 8)).toBe(-Infinity);
    expect(infinityPassthroughMutant(Infinity, 8)).not.toBe(
      toFixedDown(Infinity, 8)
    );
  });

  test('MUTATION CHECK: "clamp to 0" is a DIFFERENT answer and is rejected', () => {
    const zeroClampMutant = (v, d) => {
      const r = toFixedDown(v, d);
      return r === '' ? 0 : r;
    };
    expect(zeroClampMutant(Infinity, 8)).toBe(0);
    expect(toFixedDown(Infinity, 8)).not.toBe(0);
    expect(toFixedDown(Infinity, 8)).toBe('');
  });

  test('OVER-CORRECTION CHECK: finite values are untouched by the new guard', () => {
    for (const [input, digits, expected] of [
      [1.234567891, 8, 1.23456789],
      [-1.234567891, 8, -1.23456789],
      ['73.885', 2, 73.88],
      ['-73.885', 2, -73.88],
      [0, 8, 0],
      [1e-9, 8, 0],
    ]) {
      expect(toFixedDown(input, digits)).toBeCloseTo(expected, 8);
      expect(typeof toFixedDown(input, digits)).toBe('number');
    }
    expect(toFixedDown(1e21, 8)).toBe(1e21);
    expect(toFixedDown(Number.MAX_SAFE_INTEGER, 8)).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  test('OVER-CORRECTION CHECK: a guard that also rejects 0 or huge values would fail', () => {
    const overGuardMutant = (v, d) =>
      Math.abs(parseFloat(v)) >= 1e21 || parseFloat(v) === 0
        ? ''
        : toFixedDown(v, d);
    expect(overGuardMutant(0, 8)).toBe('');
    expect(toFixedDown(0, 8)).toBe(0);
    expect(overGuardMutant(1e21, 8)).toBe('');
    expect(toFixedDown(1e21, 8)).toBe(1e21);
  });
});

