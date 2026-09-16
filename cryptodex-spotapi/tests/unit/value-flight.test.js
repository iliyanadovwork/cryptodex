/**
 * THE RESET/PLACEMENT EXCLUSION: THE REGISTRY, THE GUARD AND THE BOOK WALK.
 * =========================================================================
 *
 * WHAT WENT WRONG, MEASURED LIVE
 * ------------------------------
 * `POST /api/spot/faucet/reset` writes ABSOLUTE balances. It decided it was
 * allowed to by asking MONGO whether the account had open spot orders -
 * a store `limitOrderPlace` writes LAST, and does not even await. An order in
 * flight was therefore invisible to the gate, kept the reservation it had
 * already taken out of `walletbalance_spot`, and had it refunded on top of the
 * restored 10,000. Through the ordinary API, no admin access: 10,000 ->
 * 48,039.52 in four consecutive wins; 12 of 32 races broke.
 *
 * THE THREE PIECES PINNED HERE
 * ----------------------------
 *   lib/valueFlight.js         a request registers itself for the whole stretch
 *                              between taking money and publishing what it took
 *                              it for, and cannot register at all under a
 *                              freeze. This is what makes the reset's questions
 *                              true at the moment it asks them.
 *   controllers/valueFlightGuard.js
 *                              the route wiring: refuse under a freeze, refuse
 *                              when redis cannot be reached, and deregister on
 *                              `finish` and DELIBERATELY NOT on `close`.
 *   lib/restingSpotOrders.js   the books, not mongo, and fail closed.
 *
 * Each test below is written against a mistake that would reintroduce a mint or
 * a lockout, not against the implementation.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

jest.mock('../../config/index.js', () => ({
  __esModule: true,
  default: { REDIS_URL: 'redis://127.0.0.1:6379', REDIS_PREFIX: 'cryptodex_' }
}));

jest.mock('../../controllers/redis.controller.js', () => ({
  __esModule: true,
  beginFlight: jest.fn(),
  hdel: jest.fn(),
  hgetall: jest.fn()
}));

import {
  VALUE_FLIGHT_TTL_MS,
  valueFlightKey,
  beginValueFlight,
  endValueFlight,
  readLiveValueFlights,
} from '../../lib/valueFlight.js';
import { trackValueFlight } from '../../controllers/valueFlightGuard.js';
import {
  listRestingSpotOrders,
  SpotBookUnreadable,
} from '../../lib/restingSpotOrders.js';
import { marginFreezeKey } from '../../lib/marginFreeze.js';
import { beginFlight, hdel, hgetall } from '../../controllers/redis.controller.js';

const USER = '6a70f1c287c92c7218ac37fc';
const OTHER = '000000000000000000000000';

const makeRes = () => {
  const handlers = {};
  const res = { statusCode: null, payload: null };
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body) => {
    res.payload = body;
    return res;
  });
  res.on = jest.fn((event, fn) => {
    handlers[event] = fn;
    return res;
  });
  res.__emit = (event) => handlers[event] && handlers[event]();
  res.__has = (event) => typeof handlers[event] === 'function';
  return res;
};

// ===========================================================================
// 1. THE REGISTRY
// ===========================================================================

describe('the value-flight registry (CRITICAL)', () => {
  beforeEach(() => {
    beginFlight.mockReset();
    hdel.mockReset();
    hgetall.mockReset();
  });

  test('registration is checked against THIS account\'s margin freeze, atomically', async () => {
    beginFlight.mockResolvedValue('OK');

    const { frozen, token } = await beginValueFlight(USER);

    expect(frozen).toBe(false);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const [flightKey, freezeKey, sentToken, deadline, ttl] =
      beginFlight.mock.calls[0];
    // The freeze this consults must be the SAME key the reset takes, or the
    // exclusion is between two things that never meet.
    expect(freezeKey).toBe(marginFreezeKey(USER));
    expect(flightKey).toBe(valueFlightKey(USER));
    expect(sentToken).toBe(token);
    expect(ttl).toBe(VALUE_FLIGHT_TTL_MS);
    // The deadline is an ABSOLUTE ms timestamp in the future, not a duration:
    // readLiveValueFlights compares it against Date.now().
    expect(deadline).toBeGreaterThan(Date.now());
    expect(deadline).toBeLessThanOrEqual(Date.now() + VALUE_FLIGHT_TTL_MS);
  });

  test('a held freeze refuses the registration and yields no token', async () => {
    beginFlight.mockResolvedValue('FROZEN');

    const flight = await beginValueFlight(USER);

    expect(flight.frozen).toBe(true);
    expect(flight.token).toBe(null);
  });

  test('a redis failure THROWS rather than answering "registered"', async () => {
    // Answering "registered" on a failure would let a request move money that
    // the reset could not see. Answering "frozen" would be safe but is not what
    // this reports; the caller turns the throw into a 503.
    beginFlight.mockRejectedValue(new Error('redis is down'));

    await expect(beginValueFlight(USER)).rejects.toThrow('redis is down');
  });

  test('deregistration removes exactly this flight, by token', async () => {
    await endValueFlight(USER, 'token-a');
    expect(hdel).toHaveBeenCalledWith(valueFlightKey(USER), 'token-a');
  });

  test('deregistering without a token touches nothing', async () => {
    await endValueFlight(USER, null);
    expect(hdel).not.toHaveBeenCalled();
  });

  test('a live flight is reported; an expired one is not', async () => {
    const now = Date.now();
    hgetall.mockResolvedValue({
      live: String(now + 5000),
      // A request that died holding a registration must not lock the account
      // out of its own reset forever.
      dead: String(now - 1)
    });

    const live = await readLiveValueFlights(USER, now);

    expect(live.map((f) => f.token)).toEqual(['live']);
  });

  test('an UNPARSEABLE deadline counts as LIVE - "cannot tell" is not "idle"', async () => {
    hgetall.mockResolvedValue({ corrupt: 'not-a-number' });

    const live = await readLiveValueFlights(USER, Date.now());

    expect(live).toHaveLength(1);
  });

  test('reading the registry does NOT delete anything', async () => {
    // A read that writes is a read that can fail halfway, and the whole hash
    // already carries a PEXPIRE that every registration refreshes.
    hgetall.mockResolvedValue({ dead: String(Date.now() - 10000) });

    await readLiveValueFlights(USER);

    expect(hdel).not.toHaveBeenCalled();
  });

  test('an empty registry is an empty answer, not a throw', async () => {
    hgetall.mockResolvedValue(null);
    expect(await readLiveValueFlights(USER)).toEqual([]);
  });

  test('the key is per user', () => {
    expect(valueFlightKey(USER)).not.toBe(valueFlightKey(OTHER));
    expect(valueFlightKey(USER)).toContain(USER);
  });
});

// ===========================================================================
// 2. THE ROUTE GUARD
// ===========================================================================

describe('the value-flight route guard (CRITICAL)', () => {
  beforeEach(() => {
    beginFlight.mockReset();
    hdel.mockReset();
    hgetall.mockReset();
  });

  test('an ordinary request is registered and passed through', async () => {
    beginFlight.mockResolvedValue('OK');
    const res = makeRes();
    const next = jest.fn();

    await trackValueFlight({ user: { id: USER } }, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(beginFlight).toHaveBeenCalled();
  });

  test('a frozen account is refused 409 and the handler never runs', async () => {
    beginFlight.mockResolvedValue('FROZEN');
    const res = makeRes();
    const next = jest.fn();

    await trackValueFlight({ user: { id: USER } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('RESET_IN_PROGRESS');
    // Both response dialects: the trade routes read `status`, the faucet
    // routes read `success`, and this guard sits in front of both.
    expect(res.payload.status).toBe(false);
    expect(res.payload.success).toBe(false);
  });

  test('a redis failure is refused 503 - it FAILS CLOSED', async () => {
    // The alternative is letting an unregistered request move money, which is
    // exactly the state the reset cannot see.
    beginFlight.mockRejectedValue(new Error('redis is down'));
    const res = makeRes();
    const next = jest.fn();

    await trackValueFlight({ user: { id: USER } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.payload.code).toBe('FLIGHT_UNAVAILABLE');
  });

  test('the flight is deregistered when the response is FLUSHED', async () => {
    beginFlight.mockResolvedValue('OK');
    const res = makeRes();

    await trackValueFlight({ user: { id: USER } }, res, jest.fn());
    expect(hdel).not.toHaveBeenCalled();

    res.__emit('finish');
    expect(hdel).toHaveBeenCalledWith(valueFlightKey(USER), expect.any(String));
  });

  test('it does NOT deregister on `close` - an abandoned request keeps its slot', async () => {
    // `close` fires when the CLIENT hangs up while the handler keeps running.
    // Deregistering there would hand the reset "nothing is in flight" while the
    // money was still moving - the exact bug this guard exists to close. The
    // deadline is what recovers the slot instead.
    beginFlight.mockResolvedValue('OK');
    const res = makeRes();

    await trackValueFlight({ user: { id: USER } }, res, jest.fn());

    expect(res.__has('finish')).toBe(true);
    expect(res.__has('close')).toBe(false);
  });

  test('deregistering twice removes the flight once', async () => {
    beginFlight.mockResolvedValue('OK');
    const res = makeRes();

    await trackValueFlight({ user: { id: USER } }, res, jest.fn());
    res.__emit('finish');
    res.__emit('finish');

    expect(hdel).toHaveBeenCalledTimes(1);
  });

  test('a failed deregistration never throws into an already-sent response', async () => {
    beginFlight.mockResolvedValue('OK');
    hdel.mockRejectedValue(new Error('redis is down'));
    const res = makeRes();

    await trackValueFlight({ user: { id: USER } }, res, jest.fn());

    expect(() => res.__emit('finish')).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('an unauthenticated request is passed straight through, unregistered', async () => {
    const res = makeRes();
    const next = jest.fn();

    await trackValueFlight({}, res, next);

    expect(next).toHaveBeenCalled();
    expect(beginFlight).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 3. THE BOOK WALK
// ===========================================================================

describe('resting spot orders are read from the BOOKS (CRITICAL)', () => {
  const PAIR = 'pair-1';

  const books = (rows) => {
    hgetall.mockImplementation(async (key) => {
      if (key === 'spotPairdata') {
        return { [PAIR]: JSON.stringify({ _id: PAIR, pairName: 'BTCUSD' }) };
      }
      return rows[key] || {};
    });
  };

  beforeEach(() => {
    hgetall.mockReset();
  });

  test("this user's resting order is found, on either side, and named", async () => {
    books({
      [`buyOpenOrders_${PAIR}`]: {
        o1: JSON.stringify({ _id: 'o1', userId: USER, pairName: 'BTCUSD', buyorsell: 'buy' })
      },
      [`sellOpenOrders_${PAIR}`]: {
        o2: JSON.stringify({ _id: 'o2', userId: USER, pairName: 'BTCUSD', buyorsell: 'sell' })
      }
    });

    const resting = await listRestingSpotOrders(USER);

    expect(resting.map((r) => r.orderId).sort()).toEqual(['o1', 'o2']);
    // Shaped so the page's existing describeResetRefusal renders it with no
    // new client-side case.
    expect(resting[0]).toEqual(
      expect.objectContaining({ productLabel: 'Spot', pairName: 'BTCUSD' })
    );
  });

  test('a MARKET order counts - its debit is recorded in no counter at all', async () => {
    books({
      [`buyOpenOrders_${PAIR}`]: {
        m: JSON.stringify({
          _id: 'm', userId: USER, pairName: 'BTCUSD', orderType: 'market', flag: true
        })
      }
    });

    expect(await listRestingSpotOrders(USER)).toHaveLength(1);
  });

  test("another user's order and the house paper ladder do NOT count", async () => {
    books({
      [`buyOpenOrders_${PAIR}`]: {
        theirs: JSON.stringify({ _id: 'theirs', userId: OTHER, pairName: 'BTCUSD' }),
        ladder: JSON.stringify({ _id: 'ladder', userId: USER, isPaper: true, pairName: 'BTCUSD' })
      }
    });

    expect(await listRestingSpotOrders(USER)).toEqual([]);
  });

  test('an unparseable row is skipped rather than crashing the gate', async () => {
    books({ [`buyOpenOrders_${PAIR}`]: { junk: '{not json' } });
    expect(await listRestingSpotOrders(USER)).toEqual([]);
  });

  test('an EMPTY pair cache refuses rather than reading as "nothing is resting"', async () => {
    // The opposite direction from sweepResidualInOrder, which does nothing when
    // it cannot prove a reservation is unowned. This walk's caller is about to
    // OVERWRITE balances, so an unproven answer has to refuse.
    hgetall.mockResolvedValue({});
    await expect(listRestingSpotOrders(USER)).rejects.toBeInstanceOf(SpotBookUnreadable);
  });

  test('a redis failure on the pair cache refuses', async () => {
    hgetall.mockRejectedValue(new Error('redis is down'));
    await expect(listRestingSpotOrders(USER)).rejects.toBeInstanceOf(SpotBookUnreadable);
  });

  test('a redis failure on ONE book refuses, rather than reporting the rest', async () => {
    hgetall.mockImplementation(async (key) => {
      if (key === 'spotPairdata') {
        return { [PAIR]: JSON.stringify({ _id: PAIR, pairName: 'BTCUSD' }) };
      }
      if (key === `buyOpenOrders_${PAIR}`) return {};
      throw new Error('redis is down');
    });

    await expect(listRestingSpotOrders(USER)).rejects.toBeInstanceOf(SpotBookUnreadable);
  });

  test('an account with nothing resting answers with an empty list', async () => {
    books({});
    expect(await listRestingSpotOrders(USER)).toEqual([]);
  });
});
