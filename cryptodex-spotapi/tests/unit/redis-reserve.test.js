/**
 * THE ATOMIC RESERVATION PRIMITIVE ITSELF.
 *
 * Every other suite in this service jest.mock()s controllers/redis.controller.js
 * wholesale, so the REAL hincrbyfloatIfEnough is never executed anywhere else -
 * a mutation that deletes its argument guard survives the entire suite. This
 * file mocks the `redis` PACKAGE instead, one layer lower, so the real function
 * body runs: its guard, its serialisation, and the script it hands to redis.
 *
 * WHAT THIS CAN AND CANNOT PROVE
 * ------------------------------
 * It cannot execute Lua. What the Lua actually does is verified against the
 * running redis directly, and that verification is what found the defect the
 * `amt ~= amt` clause below fixes: Lua's tonumber() is strtod-backed, so it
 * turns the string "NaN" into a NaN NUMBER rather than nil, every comparison
 * against NaN is false, and the amount sailed past `amt <= 0` into
 * HINCRBYFLOAT, which errored out mid-request. The in-memory redis mock the
 * rest of the suite uses cannot reproduce that, because it is JavaScript.
 *
 * So this file pins the two halves a unit test CAN own: the JS guard (by
 * behaviour - redis is never asked at all), and the presence of the two NaN
 * clauses in the script text (by inspection, because there is no interpreter
 * here to run them through).
 */

import { describe, test, expect, beforeEach } from '@jest/globals';

// The `redis` package, one layer below controllers/redis.controller.js. Every
// method is callback-style because the controller wraps them in promisify().
jest.mock('redis', () => {
  const state = { evalCalls: [], evalReply: 'REPLY' };
  const callback = (reply) => (...args) => {
    const done = args[args.length - 1];
    if (typeof done === 'function') done(null, typeof reply === 'function' ? reply(args) : reply);
  };
  const client = {
    __state: state,
    on: () => {},
    get: callback(null),
    set: callback('OK'),
    hget: callback(null),
    hset: callback(1),
    HGETALL: callback(null),
    HDEL: callback(1),
    HINCRBY: callback(1),
    HINCRBYFLOAT: callback('0'),
    HLEN: callback(0),
    hmset: callback('OK'),
    hmget: callback([]),
    rpush: callback(1),
    lpop: callback(null),
    rpop: callback(null),
    lrange: callback([]),
    // The ledger stream reads. Present because redis.controller promisifies
    // them at import: a fake client missing a method fails the whole module
    // load, which is a test-harness gap rather than a production one.
    xrange: callback([]),
    xlen: callback(0),
    config: callback(['appendonly', 'no']),
    DEL: callback(1),
    del: callback(1),
    eval: (...args) => {
      const done = args[args.length - 1];
      state.evalCalls.push(args.slice(0, -1));
      if (typeof done === 'function') done(null, state.evalReply);
    }
  };
  return {
    __esModule: true,
    __client: client,
    default: { createClient: () => client },
    createClient: () => client
  };
});

import redisPackage from 'redis';
import { hincrbyfloatIfEnough } from '../../controllers/redis.controller.js';

const state = redisPackage.createClient().__state;

describe('hincrbyfloatIfEnough - the placement reservation primitive (CRITICAL)', () => {
  beforeEach(() => {
    state.evalCalls.length = 0;
    state.evalReply = 'REPLY';
  });

  test('a usable amount reaches redis, prefixed, with the number JS compared', async () => {
    const result = await hincrbyfloatIfEnough('walletbalance_spot', 'u1_c1', 12.809196);
    expect(result).toBe('REPLY');
    expect(state.evalCalls).toHaveLength(1);
    const [script, numKeys, key, freezeKey, field, amount] = state.evalCalls[0];
    // TWO keys: the balance hash and the margin freeze the faucet reset holds.
    expect(numKeys).toBe(2);
    expect(key).toMatch(/walletbalance_spot$/);
    expect(key).not.toBe('walletbalance_spot'); // the redis prefix is applied
    // A caller that names no freeze gets a key that cannot exist, so the verdict
    // is exactly what it was before this argument existed.
    expect(freezeKey).toMatch(/__no_freeze__$/);
    expect(field).toBe('u1_c1');
    // Serialised by JS, so redis compares the same double node compared.
    expect(amount).toBe('12.809196');
    expect(typeof script).toBe('string');
  });

  test('a nil reply (nothing reserved) is surfaced as null, never undefined', async () => {
    state.evalReply = undefined;
    expect(await hincrbyfloatIfEnough('walletbalance_spot', 'u1_c1', 5)).toBe(null);
  });

  test.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['zero', 0],
    ['negative', -5],
    ['a non-numeric string', 'abc'],
    ['null', null],
    ['undefined', undefined]
  ])('an unusable amount (%s) reserves nothing and never asks redis', async (_label, amount) => {
    // Refusing here rather than in Lua matters twice: an amount that is not a
    // positive finite number is not a reservation, and NaN specifically used to
    // reach HINCRBYFLOAT and throw "value is not a valid float" out of the
    // middle of order placement.
    expect(await hincrbyfloatIfEnough('walletbalance_spot', 'u1_c1', amount)).toBe(null);
    expect(state.evalCalls).toHaveLength(0);
  });

  test('the script refuses a NaN amount AND a NaN stored balance', async () => {
    // `x ~= x` is the only NaN test that works in Lua. Verified for real against
    // the running redis; asserted here by inspection because this file has no
    // Lua interpreter - see the module note.
    await hincrbyfloatIfEnough('walletbalance_spot', 'u1_c1', 1);
    const script = state.evalCalls[0][0];
    expect(script).toContain('amt ~= amt');
    expect(script).toContain('bal ~= bal');
    // The comparison is >= by construction: it refuses only when bal < amt, so
    // an exactly-affordable order is still affordable.
    expect(script).toContain('bal < amt then return nil');
    // The debit itself is still HINCRBYFLOAT, i.e. redis' own long-double
    // arithmetic, not a value recomputed in Lua and written back.
    expect(script).toContain("redis.call('HINCRBYFLOAT'");
  });

  /**
   * THE FREEZE CHECK - THE HALF THAT MADE THE FAUCET RESET AN UNLIMITED MINT.
   * ------------------------------------------------------------------------
   * This command takes EVERY spot reservation in the product, and it was the
   * one reservation path in the product that did not check the per-user margin
   * freeze a `faucet/reset` holds while it writes absolute balances.
   * `marginFreezeKey` appeared in this service only in the reset that took it.
   * Measured through the
   * ordinary API: 10,000 -> 48,039.52 in four consecutive wins, 12 of 32 races.
   */
  test('the named freeze key is passed to redis, and the script checks it FIRST', async () => {
    await hincrbyfloatIfEnough(
      'walletbalance_spot',
      'u1_c1',
      10,
      'margin_freeze_u1'
    );
    const [script, numKeys, , freezeKey] = state.evalCalls[0];
    expect(numKeys).toBe(2);
    expect(freezeKey).toMatch(/margin_freeze_u1$/);
    expect(freezeKey).not.toBe('margin_freeze_u1'); // prefixed like every key

    // FIRST, and returning without touching the balance. A check placed after
    // the HINCRBYFLOAT would debit and then report FROZEN, which is the debit
    // this exists to prevent.
    expect(script.startsWith(
      "if redis.call('EXISTS', KEYS[2]) == 1 then return 'FROZEN' end"
    )).toBe(true);
    expect(script.indexOf("EXISTS', KEYS[2]")).toBeLessThan(
      script.indexOf("HINCRBYFLOAT")
    );
  });

  test("the FROZEN sentinel is surfaced to the caller, not flattened into null", async () => {
    // A caller that cannot tell FROZEN from "insufficient balance" tells the
    // user the wrong thing, and - worse - a caller that reads it as a SUCCESS
    // would treat a refused reservation as a taken one.
    state.evalReply = 'FROZEN';
    expect(await hincrbyfloatIfEnough('walletbalance_spot', 'u1_c1', 10, 'margin_freeze_u1'))
      .toBe('FROZEN');
  });
});
