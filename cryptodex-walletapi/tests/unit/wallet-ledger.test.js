/**
 * lib/walletLedger.js - THE ONLY WAY walletapi MAY MOVE A WALLET BALANCE.
 * =======================================================================
 *
 * The integration suite exercises this through the real router against real
 * redis (tests/integration/transfer-reservation-race.integration.test.js). What
 * is pinned HERE is the module's own contract, including the two things a
 * request-level test cannot easily show:
 *
 *   - a DEBIT decides and applies in ONE call. If the decision ever moves back
 *     into javascript - an hget of the locked counter, a comparison, then an
 *     increment - the gate is gone again even though every number still looks
 *     right in a sequential test. So the CALL ORDER is asserted, not just the
 *     outcome.
 *   - a REFUSED debit must move nothing at all: not the pot, not the mirror,
 *     and it must report `applied: 0` so a caller cannot write an audit row for
 *     money that never left.
 *
 * The redis double below implements HINCRBYFLOAT and the conditional-debit Lua
 * script HONESTLY (the script is one indivisible step because a javascript
 * function call is), and it can be told to fail, which is the other refusal
 * path a money handler has to get right.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

/* ----------------------------------------------------- in-memory redis ---- */
// On globalThis because the jest.mock factory below is hoisted above every
// `const` in this module and cannot close over one.
globalThis.__ledgerStore = {};
globalThis.__ledgerCalls = [];
const store = globalThis.__ledgerStore;
/** Where a test may make something happen INSIDE the ledger call. */
const hooks = { beforeCas: null };
/** Which primitives were called, in order. Asserting the SHAPE of the debit. */
const calls = globalThis.__ledgerCalls;
const failures = { cas: false };

const read = (hash, field) =>
  store[hash] && store[hash][field] !== undefined ? store[hash][field] : null;

const write = (hash, field, value) => {
  store[hash] = store[hash] || {};
  store[hash][field] = String(value);
};

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * PLAIN FUNCTIONS, NOT `jest.fn`. jest.config.js sets `resetMocks: true`, which
 * strips the implementation off every mock before each test - a double defined
 * at module scope would answer `undefined` for every read and the whole file
 * would grade nothing. `calls` is the call log instead.
 */
const deps = {
  db: null,
  hget: async (hash, field) => {
    calls.push(`hget:${hash}`);
    return read(hash, String(field));
  },
  hset: async (hash, field, value) => {
    calls.push(`hset:${hash}`);
    write(hash, String(field), value);
  },
  hincbyfloat: async (hash, field, delta) => {
    calls.push(`hincbyfloat:${hash}`);
    const after = num(read(hash, String(field))) + num(delta);
    write(hash, String(field), after);
    return String(after);
  },
  /**
   * The shipped Lua script, faithfully: read both fields, compare, and either
   * increment or refuse - all without yielding, exactly as redis runs it.
   */
  hdecrbyfloatIfFree: async (totalKey, lockedKey, field, amount) => {
    calls.push(`cas:${totalKey}`);
    if (hooks.beforeCas) {
      const fn = hooks.beforeCas;
      hooks.beforeCas = null;
      await fn();
    }
    if (failures.cas) return null;
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return null;
    const avail = num(read(totalKey, String(field)));
    const lock = num(read(lockedKey, String(field)));
    if (avail - lock + 1e-9 >= amt) {
      const after = avail - amt;
      write(totalKey, String(field), after);
      return String(after);
    }
    return null;
  },
};

/* syncMirror writes through the REAL redis controller, so it is doubled. */
jest.mock("../../controllers/redis.controller.js", () => ({
  __esModule: true,
  hset: async (hash, field, value) => {
    globalThis.__ledgerStore[hash] = globalThis.__ledgerStore[hash] || {};
    globalThis.__ledgerStore[hash][String(field)] = String(value);
    globalThis.__ledgerCalls.push(`hset:${hash}`);
  },
  hget: async (hash, field) =>
    globalThis.__ledgerStore[hash] &&
    globalThis.__ledgerStore[hash][String(field)] !== undefined
      ? globalThis.__ledgerStore[hash][String(field)]
      : null,
}));

import {
  WALLET_LEDGERS,
  WALLET_TYPES,
  credit,
  debitFree,
  readWallet,
} from "../../lib/walletLedger.js";

const USER = "6a70f1c287c92c7218ac37fc";
const COIN = "695bc8cd25bf5f8d3d11f2e4";
const field = `${USER}_${COIN}`;

const seed = ({ total = 0, locked = 0, mirror = null, walletType = "spot" }) => {
  const ledger = WALLET_LEDGERS[walletType];
  write(ledger.total, field, total);
  write(ledger.locked, field, locked);
  if (ledger.mirror) write(ledger.mirror, field, mirror === null ? total : mirror);
};

const row = (walletType = "spot") => {
  const ledger = WALLET_LEDGERS[walletType];
  return {
    total: num(read(ledger.total, field)),
    locked: num(read(ledger.locked, field)),
    mirror: ledger.mirror ? num(read(ledger.mirror, field)) : null,
  };
};

const args = (overrides = {}) => ({
  userId: USER,
  currencyId: COIN,
  coin: "USDC",
  walletType: "spot",
  ...overrides,
});

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  calls.length = 0;
  hooks.beforeCas = null;
  failures.cas = false;
});

// ==========================================================================
describe("the wallet table", () => {
  test("names SPOT and nothing else", () => {
    // The table having exactly one entry IS the property worth pinning: an
    // extra row here would mean something had started addressing a ledger no
    // product backs.
    expect(WALLET_TYPES).toEqual(["spot"]);
    expect(WALLET_LEDGERS.spot).toEqual({
      total: "walletbalance_spot",
      locked: "walletbalance_spot_locked",
      // No mirror: nothing settles against this service out of band.
      mirror: null,
    });
    expect(Object.keys(WALLET_LEDGERS)).toEqual(["spot"]);
  });

  test("readWallet reports total, locked and their difference", async () => {
    seed({ total: 500, locked: 140 });
    expect(await readWallet(args(), deps)).toEqual({
      total: 500,
      locked: 140,
      free: 360,
    });
  });

  test("an absent row reads as zero, never NaN", async () => {
    expect(await readWallet(args(), deps)).toEqual({ total: 0, locked: 0, free: 0 });
  });
});

// ==========================================================================
describe("debitFree: the gate", () => {
  test("takes exactly the free balance, to the last unit", async () => {
    seed({ total: 500, locked: 140 });
    const res = await debitFree(args({ amount: 360 }), deps);
    expect(res.status).toBe(true);
    expect(res.applied).toBe(360);
    expect(row()).toEqual({ total: 140, locked: 140, mirror: null });
  });

  test("refuses one unit more than the free balance, and moves NOTHING", async () => {
    seed({ total: 500, locked: 140 });
    const res = await debitFree(args({ amount: 361 }), deps);
    expect(res.status).toBe(false);
    expect(res.reason).toBe("insufficient_free");
    expect(res.applied).toBe(0);
    // The pot AND the mirror are exactly where they were.
    expect(row()).toEqual({ total: 500, locked: 140, mirror: null });
  });

  test("the refusal reports the row, so the caller can say what is reserved", async () => {
    seed({ total: 500, locked: 140 });
    const res = await debitFree(args({ amount: 400 }), deps);
    expect(res.total).toBe(500);
    expect(res.locked).toBe(140);
    expect(res.free).toBe(360);
  });

  // -- THE REGRESSION ------------------------------------------------------
  test("a reservation landing before the debit is honoured, not overrun", async () => {
    // The live shape: the caller has already decided free = 500 is enough, and
    // an engine reserves 340 before the decrement lands. The decision must be
    // taken against the counter as it ACTUALLY stands.
    seed({ total: 500, locked: 0 });
    hooks.beforeCas = async () => {
      write("walletbalance_spot_locked", field, 340);
    };
    const res = await debitFree(args({ amount: 500 }), deps);
    expect(res.status).toBe(false);
    expect(row().total).toBe(500);
    // H2: locked <= available. Before this guard, total went to 0 with locked
    // at 340 - a resting order margined by nothing.
    expect(row().locked).toBeLessThanOrEqual(row().total);
  });

  test("and the part that is still free still leaves", async () => {
    seed({ total: 500, locked: 0 });
    hooks.beforeCas = async () => {
      write("walletbalance_spot_locked", field, 340);
    };
    expect((await debitFree(args({ amount: 500 }), deps)).status).toBe(false);
    const second = await debitFree(args({ amount: 160 }), deps);
    expect(second.status).toBe(true);
    expect(row()).toEqual({ total: 340, locked: 340, mirror: null });
  });

  // -- THE SHAPE OF THE DEBIT ---------------------------------------------
  test("the decision and the decrement are ONE call, not a read then a write", async () => {
    seed({ total: 500, locked: 0 });
    await debitFree(args({ amount: 100 }), deps);
    const casAt = calls.indexOf("cas:walletbalance_spot");
    expect(casAt).toBeGreaterThanOrEqual(0);
    // NOTHING is read before the conditional debit. A read of either counter
    // ahead of it is the javascript gate coming back.
    expect(calls.slice(0, casAt)).toEqual([]);
    expect(calls).not.toContain("hincbyfloat:walletbalance_spot");
  });

  test("redis failing to answer is a REFUSAL, not a payout", async () => {
    seed({ total: 500, locked: 0 });
    failures.cas = true;
    const res = await debitFree(args({ amount: 100 }), deps);
    expect(res.status).toBe(false);
    expect(res.applied).toBe(0);
    expect(row().total).toBe(500);
  });

  test("a non-positive or non-numeric amount is refused and never reaches redis", async () => {
    seed({ total: 500, locked: 0 });
    for (const amount of [0, -1, NaN, undefined, null, "abc"]) {
      const res = await debitFree(args({ amount }), deps);
      expect(res.status).toBe(false);
      expect(res.reason).toBe("invalid_amount");
    }
    expect(calls.filter((c) => c.startsWith("cas:"))).toEqual([]);
    expect(row().total).toBe(500);
  });

  test("an unknown wallet is refused rather than guessed at", async () => {
    const res = await debitFree(args({ walletType: "p2p", amount: 10 }), deps);
    expect(res.status).toBe(false);
    expect(res.reason).toBe("unknown_wallet");
    expect(calls.filter((c) => c.startsWith("cas:"))).toEqual([]);
  });

  test("a spot debit is gated by the spot balance", async () => {
    seed({ walletType: "spot", total: 100 });
    expect((await debitFree(args({ walletType: "spot", amount: 101 }), deps)).status).toBe(false);
    expect((await debitFree(args({ walletType: "spot", amount: 100 }), deps)).status).toBe(true);
    expect(num(read("walletbalance_spot", field))).toBe(0);
  });
});

// ==========================================================================
describe("no surviving wallet has a settlement mirror", () => {
  // Settlement mirrors existed so another process could read an absolute
  // figure without going through this service. There is no such reader now.
  // `syncMirror` is kept (it still encodes the absolute-not-delta rule, which
  // cost real money to learn) but returns false on the first line for every
  // wallet the table holds, so NOTHING may be written.

  test("a debit writes no mirror hash at all", async () => {
    seed({ total: 500, locked: 0 });
    await debitFree(args({ amount: 100 }), deps);
    expect(row().total).toBe(400);
    expect(calls.filter((c) => c.startsWith("hset:"))).toEqual([]);
  });

  test("a credit writes no mirror hash at all", async () => {
    seed({ total: 500, locked: 0 });
    await credit(args({ amount: 100 }), deps);
    expect(row().total).toBe(600);
    expect(calls.filter((c) => c.startsWith("hset:"))).toEqual([]);
  });

  test("a movement touches the spot ledgers and no other hash", async () => {
    seed({ total: 500, locked: 0 });
    await credit(args({ amount: 100 }), deps);
    await debitFree(args({ amount: 50 }), deps);
    expect(Object.keys(store).sort()).toEqual([
      "walletbalance_spot",
      "walletbalance_spot_locked",
    ]);
  });
});

// ==========================================================================
describe("credit: unconditional, and it cannot break the bound", () => {
  test("credits a wallet whose locked counter exceeds its balance", async () => {
    // An account in this state is under water; refusing the credit would trap
    // it there. A credit can only ever move `locked <= available` towards true.
    seed({ total: 10, locked: 100 });
    const res = await credit(args({ amount: 200 }), deps);
    expect(res.status).toBe(true);
    expect(row().total).toBe(210);
    expect(row().locked).toBeLessThanOrEqual(row().total);
  });

  test("a non-positive amount is refused", async () => {
    seed({ total: 10, locked: 0 });
    for (const amount of [0, -5, NaN]) {
      expect((await credit(args({ amount }), deps)).status).toBe(false);
    }
    expect(row().total).toBe(10);
  });
});
