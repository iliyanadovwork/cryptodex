/**
 * CANCELLING A PARTLY FILLED ORDER MUST NOT MINT.
 * ==============================================
 *
 * THE DEFECT. After every partial fill the matcher rewrote the resting order's
 * remaining quantity through `toFixed`, which is `Number.prototype.toFixed` and
 * rounds HALF-UP. `cancelOrder` then recomputed the refund from that rewritten
 * quantity (`price * quantity` for a buy, `quantity` for a sell) and credited
 * it with an unclamped `hincbyfloat`. Whenever the true remainder carried more
 * decimals than the pair's `firstFloatDigit` and rounded up, the user was
 * refunded more than had ever been reserved.
 *
 * It was deterministic, not a race, and the user chose the direction: nothing
 * validates an order's quantity against the pair's precision, so a 12-decimal
 * quantity is accepted on a 9-decimal pair. Measured live on SOLUSD: a
 * 0.1000000005 sell with 0.02 filled refunded 5.000004681e-10 SOL more than it
 * was owed. On BTCUSD (firstFloatDigit 8) the same shape is worth ~3.3e-4 USD
 * per partial fill.
 *
 * TWO FIXES, EACH SUFFICIENT ALONE, BOTH KEPT.
 *   1. The remainder now truncates (`toFixedDown`). A remainder can only
 *      shrink; rounding it up invents quantity.
 *   2. The refund is read from the order's own reservation ledger
 *      (`inOrderReserved - inOrderReleased`) rather than recomputed from
 *      quantity, so an over-refund is impossible by construction even if some
 *      future writer rounds the quantity the wrong way again.
 */

import { describe, test, expect, jest } from "@jest/globals";

// The module under test is spot.controller.js, which pulls in gRPC, redis,
// mongoose and the binance websocket at import scope. These are the same
// boundary stubs tests/unit/fill-audit-trail.test.js uses to load it.
jest.mock('node-cron', () => ({ schedule: () => ({ stop: () => {} }) }));

jest.mock('../../models/index.js', () => {
  const trades = [];
  const savedOrders = [];
  return {
    __esModule: true,
    __trades: trades,
    __savedOrders: savedOrders,
    SpotPair: {
      find: async () => [],
      findOne: async () => null,
      updateOne: () => ({ exec: async () => {} })
    },
    SpotOrder: {},
    OrderHistory: {
      findOneAndUpdate: (filter, update) => {
        savedOrders.push({ filter, update });
        return { exec: () => ({ then: (cb) => { cb(); return { catch: () => {} }; } }) };
      }
    },
    TradeHistory: class {
      constructor(data) {
        Object.assign(this, data);
        trades.push(data);
      }
      async save() {
        return this;
      }
    },
    SequenceId: {
      findOneAndUpdate: async () => ({ lastIndex: 1000 })
    }
  };
});

jest.mock('../../config/socketIO.js', () => ({
  __esModule: true,
  socketEmitOne: () => {},
  socketEmitAll: () => {}
}));

jest.mock('../../controllers/binance.controller.js', () => ({ __esModule: true }));

jest.mock('../../controllers/chart/chart.controller.js', () => ({
  __esModule: true,
  ChartDocHistory: () => {}
}));

jest.mock('../../lib/cryptoJS.js', () => ({
  __esModule: true,
  decryptObject: (value) => value,
  encryptObject: (value) => value,
  decryptJs: (value) => value,
  encryptJs: (value) => value
}));

// In-memory redis so balances, ledgers and the open-order hashes really move.
jest.mock('../../controllers/redis.controller.js', () => {
  const hashes = new Map();
  const strings = new Map();
  const ledgers = new Map();
  const hash = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  return {
    __esModule: true,
    __hashes: hashes,
    __strings: strings,
    __reset: () => {
      hashes.clear();
      strings.clear();
      ledgers.clear();
    },
    set: async (key, value) => {
      strings.set(key, value);
      return true;
    },
    get: async (key) => (strings.has(key) ? strings.get(key) : null),
    del: async (key) => {
      strings.delete(key);
    },
    hset: async (key, field, data) => {
      hash(key).set(String(field), JSON.stringify(data));
    },
    hget: async (key, field) => {
      const map = hashes.get(key);
      const value = map && map.get(String(field));
      return value === undefined ? null : value;
    },
    hgetall: async (key) => {
      const map = hashes.get(key);
      // node-redis v3 returns null (not {}) for a missing key
      if (!map || map.size === 0) return null;
      const out = {};
      for (const [field, value] of map) out[field] = value;
      return out;
    },
    // Real HDEL semantics: the reply is the number of fields actually removed.
    hdel: async (key, field) => {
      const map = hashes.get(key);
      if (map && map.delete(String(field))) return 1;
      return 0;
    },
    // Real HGETDEL/Lua semantics: read+delete as ONE step, so of N callers
    // exactly one gets the value back. Node is single threaded, so an `async`
    // body with no await inside is genuinely indivisible here, exactly as the
    // Lua script is on the server.
    hgetdel: async (key, field) => {
      const map = hashes.get(key);
      const value = map && map.get(String(field));
      if (value === undefined) return null;
      map.delete(String(field));
      return value;
    },
    hincbyfloat: async (key, field, increment) => {
      const map = hash(key);
      const current = parseFloat(map.get(String(field)) || 0);
      const next = current + parseFloat(increment);
      map.set(String(field), String(next));
      return String(next);
    },
    // Real Lua semantics: compare and debit as ONE indivisible step, so the
    // balance is never transiently negative and a refused reservation moves
    // nothing at all. Node is single threaded, so an `async` body with no
    // await inside is genuinely atomic here, exactly as the script is on the
    // server.
    hincrbyfloatIfEnough: async (key, field, amount) => {
      const amt = parseFloat(amount);
      if (!Number.isFinite(amt) || amt <= 0) return null;
      const map = hash(key);
      const current = parseFloat(map.get(String(field)) || 0);
      if (!Number.isFinite(current) || current < amt) return null;
      const next = current - amt;
      map.set(String(field), String(next));
      return String(next);
    },
    // The ledger-writing mutation. Mirrors the real Lua: a credit always lands,
    // a debit refuses rather than overdrawing, a freeze refuses, and an entry is
    // appended ONLY on the branch that actually moved the balance - so a replay
    // can never count money that never moved.
    moveBalanceLogged: async (key, field, amount, opts = {}) => {
      const { direction = 'credit', reason = 'unspecified', ref = '', freezeKey = null } = opts;
      const amt = parseFloat(amount);
      if (!Number.isFinite(amt) || amt <= 0) return null;
      // This mock keeps freezes in the plain string store.
      if (freezeKey && strings.has(String(freezeKey))) return 'FROZEN';
      const map = hash(key);
      const before = parseFloat(map.get(String(field)) || 0);
      if (direction === 'debit' && (!Number.isFinite(before) || before < amt)) return null;
      const after = direction === 'debit' ? before - amt : before + amt;
      map.set(String(field), String(after));
      const stream = ledgers.get(String(field)) || [];
      stream.push({
        id: `${Date.now()}-${stream.length}`,
        field: String(field),
        delta: String(direction === 'debit' ? -amt : amt),
        before: String(before),
        after: String(after),
        reason: String(reason),
        ref: String(ref),
      });
      ledgers.set(String(field), stream);
      return { balance: String(after), entryId: stream[stream.length - 1].id };
    },
    // The unconditional signed apply: the faithful stand-in for a bare
    // hincbyfloat. No affordability check, CAN take a balance negative, always
    // logs. A stub that refused here would make the matcher's refund paths
    // silently no-op, which surfaces as a hang rather than a failure.
    moveBalanceSigned: async (key, field, delta, opts = {}) => {
      const d = parseFloat(delta);
      if (!Number.isFinite(d) || d === 0) return null;
      const map = hash(key);
      const before = parseFloat(map.get(String(field)) || 0);
      const after = before + d;
      map.set(String(field), String(after));
      const stream = ledgers.get(String(field)) || [];
      stream.push({
        id: `${Date.now()}-${stream.length}`,
        field: String(field),
        delta: String(d),
        before: String(before),
        after: String(after),
        reason: String(opts.reason || 'unspecified'),
        ref: String(opts.ref || ''),
      });
      ledgers.set(String(field), stream);
      // A STRING, like the real one and like the hincbyfloat it replaced. Every
      // caller does parseFloat() on this; an object here becomes a silent NaN.
      return String(after);
    },
    readLedger: async (field) => (ledgers.get(String(field)) || []).slice(),
    ledgerLength: async (field) => (ledgers.get(String(field)) || []).length,
    ledgerStreamKey: (field) => `ledger_${field}`,
    hincby: async (key, field, increment) => {
      const map = hash(key);
      const current = parseFloat(map.get(String(field)) || 0);
      map.set(String(field), String(current + parseFloat(increment)));
    },
    hlen: async (key) => (hashes.get(key) ? hashes.get(key).size : 0),
    hmget: async (key, fields) => fields.map(() => null),
    hmset: async () => {},
    rpush: async () => {},
    lrange: async () => null,
    lpop: async () => {},
    rpop: async () => {}
  };
});

jest.mock('../../lib/binanceWebSocket.js', () => {
  const state = { book: null };
  return {
    __esModule: true,
    __state: state,
    getDepthSnapshot: () => state.book
  };
});

jest.mock('../../grpc/currencyService.js', () => ({
  __esModule: true,
  priceConversionGrpc: async () => ({ status: false })
}));

jest.mock('../../grpc/walletService.js', () => {
  // The passbook is the audit trail of every balance move, so recording it lets
  // a test assert the refund was BOOKED once, not just that the arithmetic
  // happened to land on the right number.
  const entries = [];
  return {
    __esModule: true,
    __passbook: entries,
    getUserAsset: async () => {},
    updateUserWallet: async () => true,
    updateUserAsset: async () => {},
    passbook: (entry) => {
      entries.push(entry);
    }
  };
});

jest.mock('../../grpc/adminService.js', () => ({
  __esModule: true,
  saveAdminprofit: () => {}
}));

import { reservationRemaining } from "../../controllers/spot.controller.js";
import { toFixed, toFixedDown } from "../../lib/roundOf.js";
import fs from "fs";
import path from "path";

describe("the remainder of a partial fill truncates, never rounds up", () => {
  test("THE DEFECT: toFixed rounds a 9-decimal remainder UP", () => {
    // 0.1000000005 sold, 0.02 filled -> true remainder 0.0800000005
    const trueRemainder = 0.1000000005 - 0.02;
    expect(toFixed(trueRemainder, 9)).toBeGreaterThan(trueRemainder);
    expect(toFixed(trueRemainder, 9)).toBe(0.080000001);
  });

  test("THE FIX: toFixedDown never returns more than it was given", () => {
    const trueRemainder = 0.1000000005 - 0.02;
    expect(toFixedDown(trueRemainder, 9)).toBeLessThanOrEqual(trueRemainder);
  });

  test.each([
    [0.1000000005, 0.02, 9],
    [0.30000000005, 0.1, 8],
    [1.999999999, 0.5, 8],
    [0.000000105, 0.00000005, 8],
  ])(
    "a %s order %s filled on a %s-decimal pair never grows its remainder",
    (placed, filled, digits) => {
      const remainder = placed - filled;
      expect(toFixedDown(remainder, digits)).toBeLessThanOrEqual(remainder);
    }
  );
});

describe("the refund is what the order still holds, not what its quantity implies", () => {
  test("a partly released order gives back only the unreleased part", () => {
    expect(
      reservationRemaining({ inOrderReserved: 18.3, inOrderReleased: 6.1 })
    ).toBeCloseTo(12.2, 12);
  });

  test("a fully released order gives back nothing, never a negative", () => {
    expect(
      reservationRemaining({ inOrderReserved: 18.3, inOrderReleased: 18.3 })
    ).toBe(0);
    expect(
      reservationRemaining({ inOrderReserved: 18.3, inOrderReleased: 99 })
    ).toBe(0);
  });

  test("an order that never reserved answers null, so the caller keeps the old path", () => {
    // Market orders never escrow, and orders written before the field existed
    // have no ledger to read. Both must fall through rather than refund 0.
    expect(reservationRemaining({})).toBe(null);
    expect(reservationRemaining({ inOrderReserved: 0 })).toBe(null);
    expect(reservationRemaining(null)).toBe(null);
  });

  test("THE DEFECT, stated as arithmetic: the quantity path over-refunds", () => {
    // A sell reserved 0.1000000005 base and released 0.02 on the fill. The
    // rewritten quantity rounds to 0.080000001, so the quantity path refunds
    // that - more than the 0.0800000005 the order still holds.
    const order = {
      inOrderReserved: 0.1000000005,
      inOrderReleased: 0.02,
      quantity: toFixed(0.1000000005 - 0.02, 9),
    };
    const fromQuantity = order.quantity;
    const fromLedger = reservationRemaining(order);
    expect(fromQuantity).toBeGreaterThan(fromLedger);
    expect(fromLedger).toBeLessThanOrEqual(order.inOrderReserved - order.inOrderReleased);
  });
});

/**
 * THE TWO ASSERTIONS THAT ACTUALLY FAIL ON THE DEFECT.
 *
 * The cases above describe the arithmetic, and they pass with or without the
 * fix - `reservationRemaining` and `toFixedDown` both already existed. The
 * defect was that the two call sites did not USE them: `cancelOrder`
 * recomputed the refund from `checkOrder.quantity`, and the matcher rewrote
 * the remainder with the half-up `toFixed`.
 *
 * Driving `cancelOrder` end to end would need redis, mongo and the matcher
 * stood up around it, so these pin the call sites in the source instead. That
 * is weaker than a behavioural test and is stated rather than dressed up - but
 * it does fail the moment either call site goes back, which is what a
 * regression test is for. Verified by running this file against the
 * pre-fix tree: both cases below fail there.
 */
describe("the fixed call sites, pinned in the source", () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, "..", "..", "controllers", "spot.controller.js"),
    "utf8"
  );

  test("cancelOrder reads the reservation ledger for a limit order", () => {
    const cancel = SRC.slice(SRC.indexOf("export const cancelOrder"));
    const body = cancel.slice(0, cancel.indexOf("hincbyfloat"));
    expect(body).toMatch(/reservationRemaining\(checkOrder\)/);
    expect(body).toMatch(/retriveValue = stillHeld/);
  });

  // The account-deactivation sweep force-cancels every resting order through a
  // SEPARATE copy of the same refund (createTradeHistory), and it had the same
  // quantity-recomputed credit. It must read the ledger before its spot credit
  // too, or a partly filled limit order mints on deactivation.
  test("createTradeHistory (deactivation) reads the reservation ledger before crediting", () => {
    const fn = SRC.slice(SRC.indexOf("export const createTradeHistory"));
    const body = fn.slice(0, fn.indexOf("hincbyfloat"));
    expect(body).toMatch(/reservationRemaining\(checkOrder\)/);
    expect(body).toMatch(/retriveValue = stillHeld/);
  });

  test("the matcher truncates the remainder instead of rounding it", () => {
    // Live code only: the explanation above the fix quotes the old call.
    const live = SRC.split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(live).toMatch(/buyExcAmount = toFixedDown\(/);
    expect(live).toMatch(/sellExcAmount = toFixedDown\(/);
    expect(live).not.toMatch(/buyExcAmount = toFixed\(/);
    expect(live).not.toMatch(/sellExcAmount = toFixed\(/);
  });
});
