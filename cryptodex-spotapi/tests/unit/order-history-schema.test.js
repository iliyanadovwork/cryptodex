/**
 * THE ORDER HISTORY SCHEMA IS PART OF THE FEE PATH (CRITICAL)
 * ==========================================================
 *
 * lib/liquidityRole.js decides maker-or-taker ONCE, at the moment an order is
 * accepted, and stamps it on the order - because that is the only moment at
 * which it can be observed: the synthetic ladder is rebuilt from scratch every
 * two seconds with fresh ids and a backdated `orderDate`, so by match time
 * there is nothing left to read the answer off. limitOrderPlace wrote the
 * stamp. Redis carried it. And `models/orderHistory.js` had no path for it, so
 * mongoose STRICT MODE - the default - dropped it on the floor on the way to
 * disk.
 *
 * That is the quietest possible failure. Strict mode does not throw, does not
 * warn and does not log; the write succeeds and the field is simply not there.
 * The order comes back off disk with no role on it, roleOf() resolves an absent
 * role to TAKER (correctly - that is the documented, safe fallback), and every
 * consumer that rehydrates an order from mongo therefore re-bills a passive
 * maker at the taker rate. The maker rebate exists, is configured on every
 * pair, is computed correctly by the matcher, and evaporates at the storage
 * layer.
 *
 * These cases run against the REAL mongoose model - no mock, no database - so
 * they fail if the schema path is removed, renamed or given the wrong type.
 * The companion cases in tests/unit/liquidity-role.test.js cover the other half
 * of the round trip: that newOrderHistory actually offers mongo the value.
 */

import { describe, test, expect } from '@jest/globals';

import OrderHistory from '../../models/orderHistory.js';
import { MAKER, TAKER, roleOf } from '../../lib/liquidityRole.js';

/** The fields newOrderHistory writes, minus the one under test. */
const baseOrder = {
  _id: '695bf1017573eeb15a749c9d',
  userId: '6a70f1c287c92c7218ac37fc',
  pairId: '695bf1017573eeb15a749c9d',
  pairName: 'BTCUSD',
  orderType: 'limit',
  buyorsell: 'buy',
  price: 63499.5,
  quantity: 0.1,
  openQuantity: 0.1,
  orderValue: 6349.95,
  makerFee: 0.02,
  takerFee: 0.1,
  flag: false,
  status: 'open',
  orderDate: new Date()
};

describe('orderHistory persists the maker/taker stamp (CRITICAL)', () => {
  test('THE BUG: a maker stamp survives the schema instead of being dropped', () => {
    const doc = new OrderHistory({ ...baseOrder, liquidityRole: MAKER });
    // The document, and the object that is actually handed to the driver.
    expect(doc.liquidityRole).toBe('maker');
    expect(doc.toObject().liquidityRole).toBe('maker');
    // Strict mode's signature is silent omission: the key is simply absent from
    // the serialised document. Assert on the KEY, not just the value, so a
    // dropped path cannot pass as an undefined one.
    expect(Object.keys(doc.toObject())).toContain('liquidityRole');
  });

  test('a taker stamp survives too', () => {
    const doc = new OrderHistory({ ...baseOrder, liquidityRole: TAKER });
    expect(doc.toObject().liquidityRole).toBe('taker');
  });

  test('a row written before the stamp existed reads back as the TAKER it settled as', () => {
    // Never null, never undefined: the fee table can price exactly two values
    // and the default has to be the rate the service always charged, which is
    // the same fallback roleOf() applies in memory.
    const doc = new OrderHistory({ ...baseOrder });
    expect(doc.liquidityRole).toBe('taker');
    expect(doc.liquidityRole).toBe(roleOf(doc.toObject()));
  });

  test('the column cannot hold anything the fee table cannot price', () => {
    const doc = new OrderHistory({ ...baseOrder, liquidityRole: 'rebate' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err.errors.liquidityRole).toBeDefined();
  });

  test('a valid stamp does not trip validation', () => {
    for (const role of [MAKER, TAKER]) {
      const err = new OrderHistory({ ...baseOrder, liquidityRole: role }).validateSync();
      expect(err && err.errors && err.errors.liquidityRole).toBeUndefined();
    }
  });

  test('roleOf reads back exactly what the schema stored, both ways', () => {
    // The round trip that matters at settlement: what went in is what a fee is
    // computed from on the way out.
    for (const role of [MAKER, TAKER]) {
      const stored = new OrderHistory({ ...baseOrder, liquidityRole: role }).toObject();
      expect(roleOf(stored)).toBe(role);
    }
  });

  test('the stamp is stored as a string, not coerced into something else', () => {
    const doc = new OrderHistory({ ...baseOrder, liquidityRole: MAKER });
    expect(typeof doc.toObject().liquidityRole).toBe('string');
  });
});
