/**
 * SPOT ORDER VALIDATION - AGAINST THE VALIDATORS
 * ==============================================
 *
 * WHY THIS FILE WAS REWRITTEN
 * ---------------------------
 * It held 70 tests and imported nothing but `@jest/globals`. Every one of them
 * computed a value and asserted that value against itself:
 *
 *     const minPrice = markPrice - (markPrice * (minPricePercentage / 100));
 *     test('should calculate minimum price correctly', () => {
 *       expect(minPrice).toBe(47500);
 *     });
 *
 *     const isValid = orderPrice >= minPrice && orderPrice <= maxPrice;
 *     expect(isValid).toBe(true);
 *
 * `orderPlaceValidate`, `limitOrderValidate` and `marketOrderValidate` - the
 * three middlewares every spot order in the service actually passes through -
 * were never called. The file was green while `isNaN`/`parseFloat` disagreed
 * about `true`, `[50]` and `"1e309"`, and green while three order types walked
 * into `orderPlace`, matched no branch, and HUNG the request until the client
 * timed out.
 *
 * It also asserted a great deal that is not true of this exchange: stop-limit
 * price rules, OCO structures, maker/taker fee tables of its own invention. The
 * replacement asserts what the code does, and where the old file described a
 * feature the engine does not have, the replacement pins the REFUSAL - because
 * that is the behaviour, and the refusal is load-bearing (see
 * UNSUPPORTED_ORDER_TYPES: accepting one debited a user for an order that could
 * never execute).
 *
 * WHAT IS ASSERTED, AND HOW
 * -------------------------
 * `tests/unit/order-field-numeric.test.js` already pins the numericField parser
 * itself. This file does not repeat it; it pins the layer above - that the
 * VALIDATORS agree with that parser, as an identity:
 *
 *     positiveFieldFault(v)  <->  which message the validator emits for v
 *
 * checked across every numeric field on both validators. A validator that
 * grows its own opinion about what a number is - which is exactly the defect
 * that existed - breaks the identity rather than merely changing a string.
 *
 * The other identity here is between the LIST and the DISPATCH:
 * `SUPPORTED_ORDER_TYPES` is what validation accepts, and it must be exactly
 * the set `orderPlaceValidate` has a branch for. One list, so a type can never
 * be accepted and then find no handler.
 *
 * MUTATION SUMMARY at the foot of the file.
 */

import { describe, test, expect } from '@jest/globals';

import {
  orderPlaceValidate,
  limitOrderValidate,
  marketOrderValidate,
  decryptValidate,
  SUPPORTED_ORDER_TYPES,
  UNSUPPORTED_ORDER_TYPES,
} from '../../validation/spotTrade.validation.js';
import { positiveFieldFault } from '../../validation/numericField.validation.js';

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

/**
 * Run a middleware and report EVERYTHING it did. `answered` is the property
 * that matters most: a middleware that neither responds nor calls next() has
 * hung the request, and that is not a hypothetical failure mode here - it is
 * the stop-order bug.
 */
const run = (validator, body) => {
  const res = mockRes();
  let nextCalled = false;
  validator({ body }, res, () => {
    nextCalled = true;
  });
  return {
    res,
    nextCalled,
    answered: nextCalled || res.statusCode !== null,
    errors: (res.payload && res.payload.errors) || null
  };
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
// THE ORDER TYPE CONTRACT
// ===========================================================================

describe('the order type vocabulary is one list, and it is the dispatch (CRITICAL)', () => {
  test('the supported list is exactly what this engine can execute', () => {
    expect(SUPPORTED_ORDER_TYPES).toEqual(['limit', 'market']);
  });

  test('IDENTITY - every supported type reaches a validator, and is answered', () => {
    // The list and the branch table below it must agree. If a type is added to
    // SUPPORTED_ORDER_TYPES without a branch, `orderPlaceValidate` falls
    // through to its final `return` - so this asserts the answer AND that the
    // answer is not the unsupported one.
    for (const orderType of SUPPORTED_ORDER_TYPES) {
      const body =
        orderType === 'limit' ? limitBody() : marketBuyBody();
      const { answered, nextCalled, errors } = run(orderPlaceValidate, {
        ...body,
        orderType
      });
      expect(answered).toBe(true);
      expect(nextCalled).toBe(true);
      expect(errors).toBeNull();
    }
  });

  test('the two lists are disjoint - a type is supported or refused, never both', () => {
    for (const type of UNSUPPORTED_ORDER_TYPES) {
      expect(SUPPORTED_ORDER_TYPES).not.toContain(type);
    }
  });

  test('THE ORDER TYPES THAT USED TO HANG THE REQUEST ARE NAMED AND REFUSED', () => {
    // They passed validation, walked into orderPlace, matched none of its two
    // branches, and fell off the end of the function - no response was ever
    // written, so the connection leaked. `answered` is the assertion that
    // matters; the code is what tells the client to stop retrying.
    expect(UNSUPPORTED_ORDER_TYPES).toEqual([
      'stop_limit',
      'stop_market',
      'trailing_stop'
    ]);
    for (const orderType of UNSUPPORTED_ORDER_TYPES) {
      const { res, nextCalled, answered, errors } = run(
        orderPlaceValidate,
        limitBody({ orderType })
      );
      expect(answered).toBe(true);
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(errors.orderType).toBe('UNSUPPORTED_ORDER_TYPE');
    }
  });

  test('"we do not offer that" is a DIFFERENT answer from "that is not a type"', () => {
    // A client that cannot tell them apart will retry a stop order forever.
    const unsupported = run(
      orderPlaceValidate,
      limitBody({ orderType: 'stop_limit' })
    );
    const invalid = run(
      orderPlaceValidate,
      limitBody({ orderType: 'iceberg' })
    );
    expect(unsupported.errors.orderType).toBe('UNSUPPORTED_ORDER_TYPE');
    expect(invalid.errors.orderType).toBe('INVALID_ORDER_TYPE');
    expect(unsupported.errors.orderType).not.toBe(invalid.errors.orderType);
  });

  test('a missing order type is REQUIRED, not invalid', () => {
    for (const orderType of [undefined, null, '']) {
      const { errors, nextCalled } = run(
        orderPlaceValidate,
        limitBody({ orderType })
      );
      expect(errors.orderType).toBe('REQUIRED');
      expect(nextCalled).toBe(false);
    }
  });

  test('NO REQUEST IS EVER LEFT UNANSWERED, whatever the type is', () => {
    // The shape of the original bug, generalised: every one of these must
    // either respond or call next(). None may simply return.
    const types = [
      'limit',
      'market',
      'stop_limit',
      'stop_market',
      'trailing_stop',
      'iceberg',
      'LIMIT',
      'Market',
      ' limit',
      '',
      null,
      undefined,
      0,
      1,
      true,
      [],
      {},
      'constructor',
      '__proto__',
      'toString'
    ];
    for (const orderType of types) {
      const { answered } = run(orderPlaceValidate, limitBody({ orderType }));
      expect(answered).toBe(true);
    }
  });

  test('A TYPE ACCEPTED BUT NOT DISPATCHED IS STILL ANSWERED - the safety net', () => {
    // `orderPlaceValidate` ends with a `return res.status(400)` that is
    // UNREACHABLE while SUPPORTED_ORDER_TYPES and the branch table agree. It is
    // there for the day they stop agreeing - someone extends the list without
    // extending the dispatch - because falling off the end of a middleware
    // without responding or calling next() is exactly how the stop-order types
    // hung the request until the client timed out.
    //
    // The only way to exercise it is to create that disagreement, so this test
    // creates it: the exported list is extended for the duration of one call
    // and restored afterwards. Without the final return this reaches nothing
    // and `answered` is false.
    SUPPORTED_ORDER_TYPES.push('iceberg');
    try {
      const { answered, nextCalled, res } = run(
        orderPlaceValidate,
        limitBody({ orderType: 'iceberg' })
      );
      expect(answered).toBe(true);
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(res.payload.errors.orderType).toBe('UNSUPPORTED_ORDER_TYPE');
    } finally {
      SUPPORTED_ORDER_TYPES.pop();
    }
    // ...and the list is back to what it was, so nothing else in this file or
    // any other sees the extension.
    expect(SUPPORTED_ORDER_TYPES).toEqual(['limit', 'market']);
  });

  test('the type match is exact - case and whitespace are not corrected', () => {
    // Guessing what a client meant is how a market order becomes a limit one.
    for (const orderType of ['LIMIT', 'Limit', ' limit', 'limit ', 'MARKET']) {
      const { errors, nextCalled } = run(
        orderPlaceValidate,
        limitBody({ orderType })
      );
      expect(nextCalled).toBe(false);
      expect(errors.orderType).toBe('INVALID_ORDER_TYPE');
    }
  });
});

// ===========================================================================
// THE VALIDATORS AGREE WITH THE PARSER
// ===========================================================================

describe('IDENTITY - every numeric field speaks the parser\'s vocabulary (CRITICAL)', () => {
  // The three faults `positiveFieldFault` can report, and the message each
  // validator is contracted to emit for each. The identity below asserts the
  // MAPPING holds for every input, rather than re-listing which inputs are
  // numbers (order-field-numeric.test.js owns that question).
  const FIELD_MESSAGES = {
    price: {
      REQUIRED: 'Price field is required',
      NOT_A_NUMBER: 'Price Value only numeric value',
      NOT_POSITIVE: 'Price should be greater than zero'
    },
    quantity: {
      REQUIRED: 'Quantity field is required',
      NOT_A_NUMBER: 'Quantity Value only numeric value',
      NOT_POSITIVE: 'Quantity should be greater than zero'
    },
    orderValue: {
      REQUIRED: 'Order Value field is Required',
      NOT_A_NUMBER: 'Order Value only numeric value',
      NOT_POSITIVE: 'Order Value should be greater than zero'
    },
    amount: {
      REQUIRED: 'Quantity field is Required',
      NOT_A_NUMBER: 'Quantity only numeric value',
      NOT_POSITIVE: 'Quantity should be greater than zero'
    }
  };

  // Deliberately spans all three fault classes plus good values, and includes
  // every shape the isNaN/parseFloat pair used to disagree about.
  const INPUTS = [
    undefined, null, '',
    true, false, [50], [], {}, '12abc', 'abc', '1e309', Infinity, NaN,
    '  ', '1 2', '0x10', () => 5, { valueOf: () => 5 },
    0, '0', -1, '-0.5',
    63000, '63000', '0.00000001', '.5', '  63000  '
  ];

  const check = (validator, bodyFor, field) => {
    for (const value of INPUTS) {
      const fault = positiveFieldFault(value);
      const { errors, nextCalled } = run(validator, bodyFor({ [field]: value }));
      if (fault === null) {
        // A usable positive number must not be refused ON THIS FIELD.
        expect(errors && errors[field]).toBeFalsy();
        expect(nextCalled).toBe(true);
      } else {
        expect(nextCalled).toBe(false);
        expect(errors[field]).toBe(FIELD_MESSAGES[field][fault]);
      }
    }
  };

  test('limit order PRICE', () => {
    check(limitOrderValidate, limitBody, 'price');
  });

  test('limit order QUANTITY', () => {
    check(limitOrderValidate, limitBody, 'quantity');
  });

  test('market BUY orderValue', () => {
    check(marketOrderValidate, marketBuyBody, 'orderValue');
  });

  test('market SELL amount', () => {
    check(marketOrderValidate, marketSellBody, 'amount');
  });

  test('the same identity holds through the DISPATCHING validator', () => {
    // orderPlaceValidate delegates; the delegation must not soften anything.
    for (const value of INPUTS) {
      const fault = positiveFieldFault(value);
      const { errors, nextCalled } = run(
        orderPlaceValidate,
        limitBody({ price: value })
      );
      if (fault === null) {
        expect(nextCalled).toBe(true);
      } else {
        expect(nextCalled).toBe(false);
        expect(errors.price).toBe(FIELD_MESSAGES.price[fault]);
      }
    }
  });

  test('ZERO IS PRESENT - it is refused as not-positive, never as missing', () => {
    // `isEmpty(0)` is the trap: a 0 reported as REQUIRED tells the user they
    // forgot a field they did in fact supply.
    for (const [validator, bodyFor, field] of [
      [limitOrderValidate, limitBody, 'price'],
      [limitOrderValidate, limitBody, 'quantity'],
      [marketOrderValidate, marketBuyBody, 'orderValue'],
      [marketOrderValidate, marketSellBody, 'amount']
    ]) {
      const { errors } = run(validator, bodyFor({ [field]: 0 }));
      expect(errors[field]).toBe(FIELD_MESSAGES[field].NOT_POSITIVE);
      expect(errors[field]).not.toBe(FIELD_MESSAGES[field].REQUIRED);
    }
  });

  test('a NaN price never reaches the handler - the case that reached money', () => {
    // NaN satisfies EVERY range check (`NaN < min` and `NaN > max` are both
    // false), so it used to walk the whole of limitOrderPlace and stop only at
    // the ledger, which then told the user their BALANCE was insufficient.
    for (const value of [true, [50], '12abc', '1e309']) {
      const { nextCalled, errors } = run(
        limitOrderValidate,
        limitBody({ price: value })
      );
      expect(nextCalled).toBe(false);
      expect(errors.price).toBe(FIELD_MESSAGES.price.NOT_A_NUMBER);
    }
  });
});

// ===========================================================================
// SIDE, PAIR, AND THE SHAPE OF A REFUSAL
// ===========================================================================

describe('side and pair are validated on every path (CRITICAL)', () => {
  test('a side that is not a side is refused, not guessed', () => {
    for (const buyorsell of ['long', 'BUY', 'Sell', 'b', 0, 1, true]) {
      const { errors, nextCalled } = run(
        limitOrderValidate,
        limitBody({ buyorsell })
      );
      expect(nextCalled).toBe(false);
      expect(errors.buyorsell).toBe('INVALID SIDE');
    }
  });

  test('a missing side is REQUIRED', () => {
    for (const buyorsell of [undefined, null, '', '   ']) {
      const { errors } = run(limitOrderValidate, limitBody({ buyorsell }));
      expect(errors.buyorsell).toBe('REQUIRED');
    }
  });

  test('AN EMPTY OBJECT OR ARRAY COUNTS AS ABSENT, not as a bad value', () => {
    // `isEmpty` is `typeof value === 'object' && Object.keys(value).length === 0`,
    // so `{}` and `[]` are ABSENT to every non-numeric field on this path while
    // `{ a: 1 }` and `[50]` are present-and-invalid. Pinned because it is
    // surprising, it is the reported error a client will see, and it differs
    // from the NUMERIC fields - where numericField refuses `[50]` BY TYPE
    // rather than letting it become a 50.
    for (const empty of [{}, []]) {
      expect(
        run(limitOrderValidate, limitBody({ buyorsell: empty })).errors.buyorsell
      ).toBe('REQUIRED');
      expect(
        run(limitOrderValidate, limitBody({ spotPairId: empty })).errors.spotPairId
      ).toBe('REQUIRED');
    }
    expect(
      run(limitOrderValidate, limitBody({ buyorsell: { a: 1 } })).errors.buyorsell
    ).toBe('INVALID SIDE');
    expect(
      run(limitOrderValidate, limitBody({ spotPairId: [50] })).errors.spotPairId
    ).toBe('Invalid pair');
  });

  test('both real sides are accepted', () => {
    expect(run(limitOrderValidate, limitBody({ buyorsell: 'buy' })).nextCalled).toBe(true);
    expect(run(limitOrderValidate, limitBody({ buyorsell: 'sell' })).nextCalled).toBe(true);
  });

  test('a market order is sized in the unit its SIDE trades in', () => {
    // A buy spends QUOTE (orderValue); a sell delivers BASE (amount). Mixing
    // them is how a size check becomes meaningless.
    const buyMissingValue = run(
      marketOrderValidate,
      marketBuyBody({ orderValue: undefined })
    );
    expect(buyMissingValue.errors.orderValue).toBe('Order Value field is Required');
    // ...and a buy does not need `amount` at all.
    expect(
      run(marketOrderValidate, marketBuyBody({ amount: undefined })).nextCalled
    ).toBe(true);

    const sellMissingAmount = run(
      marketOrderValidate,
      marketSellBody({ amount: undefined })
    );
    expect(sellMissingAmount.errors.amount).toBe('Quantity field is Required');
    expect(
      run(marketOrderValidate, marketSellBody({ orderValue: undefined })).nextCalled
    ).toBe(true);
  });

  test('a pair id that is not an ObjectId is refused', () => {
    for (const spotPairId of ['not-an-id', '123', 'zzzz', '695bf1017573eeb15a749c9']) {
      const { errors, nextCalled } = run(
        limitOrderValidate,
        limitBody({ spotPairId })
      );
      expect(nextCalled).toBe(false);
      expect(errors.spotPairId).toBe('Invalid pair');
    }
  });

  test('a missing pair id is REQUIRED, on both validators', () => {
    expect(
      run(limitOrderValidate, limitBody({ spotPairId: undefined })).errors.spotPairId
    ).toBe('REQUIRED');
    expect(
      run(marketOrderValidate, marketBuyBody({ spotPairId: undefined })).errors
        .spotPairId
    ).toBe('REQUIRED');
  });

  test('a refusal is a 400 with a per-field errors object, and never calls next', () => {
    const { res, nextCalled } = run(
      limitOrderValidate,
      limitBody({ price: -1, quantity: 0, buyorsell: 'nope', spotPairId: 'x' })
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(400);
    // EVERY fault is reported at once. Reporting one at a time makes a client
    // fix a form field by field.
    expect(Object.keys(res.payload.errors).sort()).toEqual([
      'buyorsell',
      'price',
      'quantity',
      'spotPairId'
    ]);
  });

  test('a valid order passes with no response written at all', () => {
    for (const [validator, body] of [
      [limitOrderValidate, limitBody()],
      [marketOrderValidate, marketBuyBody()],
      [marketOrderValidate, marketSellBody()],
      [orderPlaceValidate, limitBody()],
      [orderPlaceValidate, marketBuyBody()],
      [orderPlaceValidate, marketSellBody()]
    ]) {
      const { res, nextCalled } = run(validator, body);
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBeNull();
      expect(res.payload).toBeNull();
    }
  });
});

describe('the decrypt gate', () => {
  test('a request with no token is refused, and one with a token passes', () => {
    const missing = run(decryptValidate, {});
    expect(missing.res.statusCode).toBe(400);
    expect(missing.errors.token).toBe('REQUIRED');
    expect(missing.nextCalled).toBe(false);

    expect(run(decryptValidate, { token: 'anything' }).nextCalled).toBe(true);
  });
});

/**
 * MUTATION SUMMARY - each applied to the real implementation in a shadow tree,
 * reverted after each, with the guards that went red.
 *
 * validation/spotTrade.validation.js
 *  S1  orderPlaceValidate: drop the UNSUPPORTED_ORDER_TYPES branch (so a stop
 *      order falls through to the dispatch and is answered by nothing) ... the
 *      hang guard, the two-different-answers guard, every-request-answered
 *  S2  orderPlaceValidate: report INVALID_ORDER_TYPE for an unsupported type
 *      (collapse the two answers into one) ......... two-different-answers
 *  S3b orderPlaceValidate: delete the final `return`, so an
 *      accepted-but-undispatched type hangs ........ the safety-net guard
 *  S4  orderPlaceValidate: lowercase the incoming orderType before matching
 *      ("helpfully" accept "LIMIT") ................ exact-match guard
 *  S5  limitOrderValidate: `positiveFieldFault(price)` -> the old
 *      isEmpty/isNaN/parseFloat trio ............... price identity, NaN guard
 *  S6  limitOrderValidate: same for quantity ....... quantity identity
 *  S7  marketOrderValidate: same for orderValue .... orderValue identity
 *  S8  marketOrderValidate: same for amount ........ amount identity
 *  S10 limitOrderValidate: accept any truthy buyorsell ..... side guards
 *  S11 limitOrderValidate: drop the ObjectId check ......... pair guard
 *  S12 limitOrderValidate: return after the first error instead of
 *      collecting them ................................... errors-object guard
 *  S13 marketOrderValidate: check `amount` for a buy and `orderValue` for a
 *      sell (swap the units) ............................. side-unit guard
 *  S14 decryptValidate: call next() regardless ............ decrypt gate
 *
 * 14 mutations applied, 14 killed, 0 survivors.
 */
