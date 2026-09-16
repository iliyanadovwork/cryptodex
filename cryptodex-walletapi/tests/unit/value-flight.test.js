/**
 * THE VALUE-FLIGHT REGISTRY ON THIS SERVICE.
 * ==========================================
 *
 * WHY walletapi HAS ONE AT ALL
 * ----------------------------
 * spotapi's `POST /faucet/reset` restores a known total by writing ABSOLUTE
 * balances - it SETS each faucet coin's `walletbalance_spot`. A value-moving
 * request touches the same ledgers in several separate redis commands.
 * Interleave the two and the account keeps both halves:
 *
 *     request debits spot   ->  reset SETS spot back to 10,000
 *                           ->  request credits it again
 *
 * ...and the account holds the whole grant AND the transferred amount. That is
 * the same unlimited mint that was MEASURED against order placement (an account
 * taken from 10,000 to 48,039.52 through the ordinary API), reached through a
 * different door. Enumerating the doors is the point: an exclusion honoured by
 * three of four value-moving paths is the same bug with a smaller window.
 *
 * WHAT IS PINNED
 * --------------
 *   - the key names and TTL are IDENTICAL to spotapi's, because the two
 *     services address the same redis hash and the same freeze key. A rename on
 *     one side is a silent, total loss of the exclusion, and nothing else in
 *     either service would notice.
 *   - the freeze refuses the registration, and the guard turns that into a 409
 *     with the handler never running;
 *   - a redis failure FAILS CLOSED (503), because an unregistered request is
 *     one the reset cannot see;
 *   - the flight is released on `finish` and deliberately NOT on `close`.
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
  marginFreezeKey,
  beginValueFlight,
  endValueFlight,
  readLiveValueFlights
} from '../../lib/valueFlight.js';
import { trackValueFlight } from '../../controllers/valueFlightGuard.js';
import { beginFlight, hdel, hgetall } from '../../controllers/redis.controller.js';

const USER = '6a70f1c287c92c7218ac37fc';

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

describe('walletapi value-flight registry (CRITICAL)', () => {
  beforeEach(() => {
    beginFlight.mockReset();
    hdel.mockReset();
    hgetall.mockReset();
  });

  test('the key names and TTL are the ones spotapi uses - they MUST NOT drift', () => {
    // Hardcoded on purpose. Importing spotapi's copy would make this test pass
    // for two names that had drifted together, which is exactly the failure it
    // exists to catch.
    expect(valueFlightKey(USER)).toBe(`value_flight_${USER}`);
    expect(marginFreezeKey(USER)).toBe(`margin_freeze_${USER}`);
    expect(VALUE_FLIGHT_TTL_MS).toBe(30000);
  });

  test('registration names this account\'s freeze and flight keys', async () => {
    beginFlight.mockResolvedValue('OK');

    const { frozen, token } = await beginValueFlight(USER);

    expect(frozen).toBe(false);
    const [flightKey, freezeKey, sentToken, deadline, ttl] = beginFlight.mock.calls[0];
    expect(flightKey).toBe(valueFlightKey(USER));
    expect(freezeKey).toBe(marginFreezeKey(USER));
    expect(sentToken).toBe(token);
    expect(ttl).toBe(VALUE_FLIGHT_TTL_MS);
    expect(deadline).toBeGreaterThan(Date.now());
  });

  test('a transfer is refused 409 while a reset holds the freeze', async () => {
    beginFlight.mockResolvedValue('FROZEN');
    const res = makeRes();
    const next = jest.fn();

    await trackValueFlight({ user: { id: USER } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('RESET_IN_PROGRESS');
  });

  test('a redis failure refuses 503 - an unregistered transfer must not run', async () => {
    beginFlight.mockRejectedValue(new Error('redis is down'));
    const res = makeRes();
    const next = jest.fn();

    await trackValueFlight({ user: { id: USER } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.payload.code).toBe('FLIGHT_UNAVAILABLE');
  });

  test('an ordinary transfer is registered and passed through', async () => {
    beginFlight.mockResolvedValue('OK');
    const res = makeRes();
    const next = jest.fn();

    await trackValueFlight({ user: { id: USER } }, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('the flight is released on `finish`, and NOT on `close`', async () => {
    beginFlight.mockResolvedValue('OK');
    const res = makeRes();

    await trackValueFlight({ user: { id: USER } }, res, jest.fn());

    expect(res.__has('close')).toBe(false);
    expect(hdel).not.toHaveBeenCalled();
    res.__emit('finish');
    expect(hdel).toHaveBeenCalledWith(valueFlightKey(USER), expect.any(String));
  });

  test('an unparseable deadline reads as LIVE, an expired one does not', async () => {
    const now = Date.now();
    hgetall.mockResolvedValue({
      live: String(now + 5000),
      dead: String(now - 1),
      corrupt: 'nonsense'
    });

    const live = await readLiveValueFlights(USER, now);

    expect(live.map((f) => f.token).sort()).toEqual(['corrupt', 'live']);
  });

  test('deregistering without a token touches nothing', async () => {
    await endValueFlight(USER, null);
    expect(hdel).not.toHaveBeenCalled();
  });

  test('the transfer route mounts the guard, after the stand-down and before the handler', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const route = fs.readFileSync(
      path.join(process.cwd(), 'routes', 'wallet.route.js'),
      'utf8'
    );
    const at = route.indexOf('.route("/transfer")');
    expect(at).toBeGreaterThan(-1);
    const chain = route.slice(at, route.indexOf(');', route.indexOf('walletTransfer', at)));
    expect(chain).toContain('blockFrozenWallet');
    expect(chain).toContain('trackValueFlight');
    // Ordering: the registration must happen before anything that could read or
    // move a balance, and the stand-down refusal must not register a flight it
    // will never release.
    expect(chain.indexOf('blockFrozenWallet')).toBeLessThan(chain.indexOf('trackValueFlight'));
    expect(chain.indexOf('trackValueFlight')).toBeLessThan(chain.indexOf('walletTransfer'));
  });
});
