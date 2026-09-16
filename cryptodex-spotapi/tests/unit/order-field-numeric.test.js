/**
 * EVERY NUMERIC ORDER FIELD IS ACTUALLY A NUMBER (CRITICAL - REGRESSION)
 *
 * THE DEFECT
 * ----------
 * validation/spotTrade.validation.js checked every numeric field with
 * `isEmpty` / `isNaN` / `parseFloat(...) <= 0`, and `isNaN` coerces with
 * `Number()` while `parseFloat` parses a PREFIX. The two disagree about almost
 * everything that is not already a number, and the disagreements all landed on
 * the accept side:
 *
 *     price: true      -> isNaN(true) is false      -> ACCEPTED
 *                         parseFloat(true) is NaN   -> the handler runs on NaN
 *     price: [50]      -> ACCEPTED, and becomes 50  -> an ARRAY became a price
 *     price: "1e309"   -> ACCEPTED, and is Infinity -> an infinite order
 *     quantity: true   -> same as price
 *
 * A NaN is the dangerous one, because NaN satisfies EVERY bounds check in the
 * handler: `NaN < min` and `NaN > max` are both false, so it walks the pair
 * lookup, the fill gate, the price band, the quantity bounds and the balance
 * read, and is stopped only by `hincrbyfloatIfEnough` refusing a non-finite
 * size. The user is then told "Due to insufficient balance order cannot be
 * placed" - a statement about their account, for a request that was malformed.
 *
 * These tests drive the REAL validators, so they pin both halves: the malformed
 * shapes are refused with a named error and `next()` is never called, and the
 * well-formed ones (including the string forms the encrypted client actually
 * sends) still pass straight through. The second half matters as much as the
 * first: a guard that refuses everything is not a fix.
 */

import { describe, test, expect } from '@jest/globals';

import {
  limitOrderValidate,
  marketOrderValidate,
  orderPlaceValidate,
} from '../../validation/spotTrade.validation.js';
import {
  numericField,
  positiveFieldFault,
} from '../../validation/numericField.validation.js';

const PAIR_ID = '695bf1017573eeb15a749c9d';

const mockRes = () => {
  const res = { statusCode: null, payload: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.payload = body;
    return res;
  };
  return res;
};

const run = (validator, body) => {
  const res = mockRes();
  let nextCalled = false;
  validator({ body }, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
};

const limitBody = (over = {}) => ({
  orderType: 'limit',
  spotPairId: PAIR_ID,
  buyorsell: 'buy',
  price: 63000,
  quantity: 0.1,
  ...over
});

const marketBuyBody = (over = {}) => ({
  orderType: 'market',
  spotPairId: PAIR_ID,
  buyorsell: 'buy',
  orderValue: 200,
  ...over
});

const marketSellBody = (over = {}) => ({
  orderType: 'market',
  spotPairId: PAIR_ID,
  buyorsell: 'sell',
  amount: 0.01,
  ...over
});

// ===========================================================================
// THE PARSER
// ===========================================================================

describe('numericField accepts numbers and nothing else (CRITICAL)', () => {
  test('finite numbers and fully-numeric strings are numbers', () => {
    expect(numericField(63000)).toBe(63000);
    expect(numericField(0)).toBe(0);
    expect(numericField(-1.5)).toBe(-1.5);
    expect(numericField('63000')).toBe(63000);
    expect(numericField('0.00000001')).toBe(0.00000001);
    expect(numericField('.5')).toBe(0.5);
    expect(numericField('1e-8')).toBe(1e-8);
    // a form field's whitespace changes no value
    expect(numericField('  63000  ')).toBe(63000);
  });

  test('the four shapes that used to get through are refused', () => {
    // Number(true) is 1, so isNaN said "this is a number"; parseFloat said NaN.
    expect(numericField(true)).toBe(null);
    expect(numericField(false)).toBe(null);
    // Number([50]) is 50: an array is not a price.
    expect(numericField([50])).toBe(null);
    expect(numericField([])).toBe(null);
    // A prefix is not a number: "12abc" would have become 12.
    expect(numericField('12abc')).toBe(null);
    // Infinity is not a large order, it is a broken one.
    expect(numericField('1e309')).toBe(null);
    expect(numericField(Infinity)).toBe(null);
    expect(numericField(-Infinity)).toBe(null);
  });

  test('everything else that is not a number is not a number', () => {
    expect(numericField(NaN)).toBe(null);
    expect(numericField(null)).toBe(null);
    expect(numericField(undefined)).toBe(null);
    expect(numericField('')).toBe(null);
    expect(numericField('   ')).toBe(null);
    expect(numericField({})).toBe(null);
    expect(numericField({ valueOf: () => 5 })).toBe(null);
    expect(numericField(() => 5)).toBe(null);
    expect(numericField('1 2')).toBe(null);
    expect(numericField('0x10')).toBe(null);
  });

  test('positiveFieldFault separates absent, not-a-number and not-positive', () => {
    expect(positiveFieldFault(undefined)).toBe('REQUIRED');
    expect(positiveFieldFault(null)).toBe('REQUIRED');
    expect(positiveFieldFault('')).toBe('REQUIRED');
    expect(positiveFieldFault(true)).toBe('NOT_A_NUMBER');
    expect(positiveFieldFault('abc')).toBe('NOT_A_NUMBER');
    expect(positiveFieldFault(0)).toBe('NOT_POSITIVE');
    expect(positiveFieldFault('0')).toBe('NOT_POSITIVE');
    expect(positiveFieldFault(-5)).toBe('NOT_POSITIVE');
    expect(positiveFieldFault(63000)).toBe(null);
    // 0 is PRESENT: it must be reported as not-positive, never as missing.
    expect(positiveFieldFault(0)).not.toBe('REQUIRED');
  });
});

// ===========================================================================
// THE LIMIT ORDER VALIDATOR
// ===========================================================================

describe('a limit order with a malformed price or quantity is refused (CRITICAL)', () => {
  const garbage = [true, false, [50], [], '12abc', '1e309', {}, '  ', 'abc'];

  test('every malformed PRICE is named, and nothing reaches the handler', () => {
    for (const price of garbage) {
      const { res, nextCalled } = run(limitOrderValidate, limitBody({ price }));
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(res.payload.errors.price).toBeDefined();
    }
  });

  test('every malformed QUANTITY is named, and nothing reaches the handler', () => {
    for (const quantity of garbage) {
      const { res, nextCalled } = run(limitOrderValidate, limitBody({ quantity }));
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(res.payload.errors.quantity).toBeDefined();
    }
  });

  test('the messages the client already knows are unchanged', () => {
    expect(
      run(limitOrderValidate, limitBody({ price: undefined })).res.payload.errors.price
    ).toBe('Price field is required');
    expect(
      run(limitOrderValidate, limitBody({ price: 'abc' })).res.payload.errors.price
    ).toBe('Price Value only numeric value');
    expect(
      run(limitOrderValidate, limitBody({ price: 0 })).res.payload.errors.price
    ).toBe('Price should be greater than zero');
    expect(
      run(limitOrderValidate, limitBody({ quantity: -1 })).res.payload.errors.quantity
    ).toBe('Quantity should be greater than zero');
  });

  test('a well-formed limit order STILL passes - as a number and as a string', () => {
    expect(run(limitOrderValidate, limitBody()).nextCalled).toBe(true);
    // The encrypted client sends strings; refusing those would break every
    // real order, which is the over-correction this asserts against.
    expect(
      run(limitOrderValidate, limitBody({ price: '63000.5', quantity: '0.00120000' }))
        .nextCalled
    ).toBe(true);
    expect(
      run(limitOrderValidate, limitBody({ price: 1e-8, quantity: 1e-8 })).nextCalled
    ).toBe(true);
  });

  test('the side is still checked, and still only buy or sell', () => {
    expect(
      run(limitOrderValidate, limitBody({ buyorsell: 'xyz' })).res.payload.errors.buyorsell
    ).toBe('INVALID SIDE');
    expect(
      run(limitOrderValidate, limitBody({ buyorsell: undefined })).res.payload.errors.buyorsell
    ).toBe('REQUIRED');
    expect(run(limitOrderValidate, limitBody({ buyorsell: 'sell' })).nextCalled).toBe(true);
  });
});

// ===========================================================================
// THE MARKET ORDER VALIDATOR
// ===========================================================================

describe('a market order with a malformed size is refused (CRITICAL)', () => {
  const garbage = [true, [200], '200abc', '1e309', {}, 'abc'];

  test('a malformed BUY orderValue is named', () => {
    for (const orderValue of garbage) {
      const { res, nextCalled } = run(marketOrderValidate, marketBuyBody({ orderValue }));
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(res.payload.errors.orderValue).toBeDefined();
    }
  });

  test('a malformed SELL amount is named', () => {
    for (const amount of garbage) {
      const { res, nextCalled } = run(marketOrderValidate, marketSellBody({ amount }));
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(res.payload.errors.amount).toBeDefined();
    }
  });

  test('zero and negative sizes are still refused as not-positive', () => {
    expect(
      run(marketOrderValidate, marketBuyBody({ orderValue: 0 })).res.payload.errors.orderValue
    ).toBe('Order Value should be greater than zero');
    expect(
      run(marketOrderValidate, marketSellBody({ amount: -0.5 })).res.payload.errors.amount
    ).toBe('Quantity should be greater than zero');
  });

  test('well-formed market orders STILL pass, in both directions', () => {
    expect(run(marketOrderValidate, marketBuyBody()).nextCalled).toBe(true);
    expect(run(marketOrderValidate, marketBuyBody({ orderValue: '200' })).nextCalled).toBe(true);
    expect(run(marketOrderValidate, marketSellBody()).nextCalled).toBe(true);
    expect(run(marketOrderValidate, marketSellBody({ amount: '0.01' })).nextCalled).toBe(true);
  });
});

// ===========================================================================
// THROUGH THE REAL ENTRY POINT
// ===========================================================================

describe('the dispatching validator applies the same rules (CRITICAL)', () => {
  test('a boolean price on a limit order never reaches orderPlace', () => {
    const { res, nextCalled } = run(orderPlaceValidate, limitBody({ price: true }));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.payload.errors.price).toBe('Price Value only numeric value');
  });

  test('a boolean orderValue on a market buy never reaches orderPlace', () => {
    const { res, nextCalled } = run(orderPlaceValidate, marketBuyBody({ orderValue: true }));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.payload.errors.orderValue).toBe('Order Value only numeric value');
  });

  test('and the two supported order types still get through', () => {
    expect(run(orderPlaceValidate, limitBody()).nextCalled).toBe(true);
    expect(run(orderPlaceValidate, marketBuyBody()).nextCalled).toBe(true);
  });
});
