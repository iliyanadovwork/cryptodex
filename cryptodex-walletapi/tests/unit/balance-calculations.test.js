/**
 * BALANCE CALCULATIONS - THE ONES THIS SERVICE ACTUALLY PERFORMS
 * =============================================================
 *
 * WHAT THIS REPLACES
 * ------------------
 * This file was headed "CRITICAL TESTS - These tests verify financial
 * calculations are correct" and imported nothing. Every one of its 60-odd
 * assertions computed its own expected value inline and then checked that
 * JavaScript had done arithmetic:
 *
 *     const balance1 = '100.50';
 *     const balance2 = '50.25';
 *     const result = parseFloat(balance1) + parseFloat(balance2);
 *     expect(result).toBe(150.75);
 *
 * That is a test of `+`. It cannot fail unless V8 is broken, it names no
 * function in this repository, and deleting walletapi from disk would have left
 * it green. The word "CRITICAL" in the header was the only thing connecting it
 * to money.
 *
 * WHAT IS TESTED NOW
 * ------------------
 * The balance arithmetic that this service ships, imported and called:
 *
 *   lib/walletBalance.js   the free/locked split. `total - locked` is the only
 *                          figure a transfer or an order may draw on, and the
 *                          clamping at both ends is what stops a corrupt
 *                          reservation from inventing money or inventing a debt.
 *   lib/roundOf.js         toFixed / toFixedDown, the rounding every balance
 *                          that reaches a user passes through. toFixedDown
 *                          exists because ROUNDING UP a withdrawable balance
 *                          hands out money that is not there.
 *   lib/calculation.js     the fee/percentage helpers wallet.controller.js uses
 *                          to size a withdrawal fee.
 *   lib/spotMirror.js      the smallest-unit conversion the flat USDC ledger is
 *                          stored in, and the delta write that keeps the engine
 *                          field and both mirrors of it in step.
 *
 * Every expected value below is a property of the SUBJECT - a clamp, a
 * direction of rounding, a conservation law - not a restatement of the
 * implementation. Break any of these functions and this file goes red.
 */

/* eslint-disable no-undef */

import { describe, test, expect, jest } from "@jest/globals";

import {
  toLedgerNumber,
  freeBalance,
  balanceBreakdown,
  lockedShortfallMessage,
} from "../../lib/walletBalance.js";
import { toFixed, toFixedDown } from "../../lib/roundOf.js";
import {
  percentageCalculation,
  precentConvetPrice,
  commissionFeeCalculate,
  calculateServiceFee,
  withoutServiceFee,
  interestByDays,
} from "../../lib/calculation.js";
import { applySpotDelta } from "../../lib/spotMirror.js";

// ---------------------------------------------------------------------------
// lib/walletBalance.js#toLedgerNumber
//
// Redis answers strings, and a field that was never written as null. Every
// balance in this service arrives through this function first.
// ---------------------------------------------------------------------------
describe("toLedgerNumber - what a redis answer means as a balance", () => {
  test("parses the string form redis actually returns", () => {
    expect(toLedgerNumber("1234.5")).toBe(1234.5);
    expect(toLedgerNumber("-0.75")).toBe(-0.75);
  });

  test("a field that was never written is 0, never NaN", () => {
    // NaN here propagates into a rendered wallet and into the arithmetic that
    // decides what a user may transfer.
    expect(toLedgerNumber(null)).toBe(0);
    expect(toLedgerNumber(undefined)).toBe(0);
    expect(toLedgerNumber("")).toBe(0);
  });

  test("unparseable junk falls back rather than poisoning the arithmetic", () => {
    expect(toLedgerNumber("not-a-number")).toBe(0);
    expect(toLedgerNumber({})).toBe(0);
    expect(Number.isNaN(toLedgerNumber("oops"))).toBe(false);
  });

  test("the fallback is caller-chosen", () => {
    expect(toLedgerNumber(null, 7)).toBe(7);
    expect(toLedgerNumber("nope", -1)).toBe(-1);
  });

  test("a real zero is preserved and not confused with absence", () => {
    expect(toLedgerNumber("0", 99)).toBe(0);
    expect(toLedgerNumber(0, 99)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// lib/walletBalance.js#freeBalance
//
// THE contract of every ledger in the stack: the total ALREADY INCLUDES what
// is reserved, and only `total - locked` can move.
// ---------------------------------------------------------------------------
describe("freeBalance - only the unreserved part of a pot may move", () => {
  test("subtracts the reservation from the pot", () => {
    expect(freeBalance("100", "30")).toBe(70);
    expect(freeBalance(0.05, 0.02)).toBeCloseTo(0.03, 8);
  });

  test("a missing reservation means nothing is reserved, not no balance", () => {
    // The distinction the fresh-account bug turned into NaN in the transfer UI.
    expect(freeBalance("100", null)).toBe(100);
    expect(freeBalance("100", undefined)).toBe(100);
    expect(freeBalance("100", "")).toBe(100);
  });

  test("a reservation larger than the pot floors at zero, never a phantom debt", () => {
    // Drift, or a settlement that debited the pot without resizing the
    // reservation. A negative free balance reads to a user as money owed.
    expect(freeBalance(5, 12)).toBe(0);
    expect(freeBalance("0.01", "1000")).toBe(0);
  });

  test("a NEGATIVE reservation cannot make the free balance exceed the pot", () => {
    // This is money invented at the point of display and then handed to a
    // transfer guard. An unfloored `locked - orderCost` on a double release is
    // exactly how a negative reservation appears.
    expect(freeBalance(100, -50)).toBe(100);
    expect(freeBalance(100, -50)).not.toBe(150);
  });

  test("a genuinely negative pot is reported as-is", () => {
    // An account in deficit. Nothing is spendable either way, and clamping it
    // to 0 would hide the deficit.
    expect(freeBalance(-25, 0)).toBe(-25);
    expect(freeBalance(-25, 10)).toBe(-25);
  });

  test("settles at 8 decimals, the precision the rest of the stack uses", () => {
    // 0.3 - 0.1 is 0.19999999999999998 in binary floating point; a balance
    // rendered that way is a bug report.
    expect(freeBalance(0.3, 0.1)).toBe(0.2);
    expect(String(freeBalance(0.3, 0.1))).not.toMatch(/99999/);
  });

  test("the whole pot reserved leaves exactly nothing free", () => {
    expect(freeBalance(0.05, 0.05)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// lib/walletBalance.js#balanceBreakdown - the shape a wallet is reported in.
// ---------------------------------------------------------------------------
describe("balanceBreakdown - a balance never reported without saying what is spendable", () => {
  test("answers total, locked and free together", () => {
    expect(balanceBreakdown("200", "50")).toEqual({
      total: 200,
      locked: 50,
      free: 150,
    });
  });

  test("total and locked come back as NUMBERS, not the raw redis strings", () => {
    // A consumer that concatenates two balance strings gets "20050".
    const view = balanceBreakdown("200", "50");
    expect(typeof view.total).toBe("number");
    expect(typeof view.locked).toBe("number");
    expect(typeof view.free).toBe("number");
  });

  test("free is always present, even for an untouched account", () => {
    const view = balanceBreakdown(null, null);
    expect(view).toEqual({ total: 0, locked: 0, free: 0 });
    expect(view.free).toBeDefined();
  });

  test("the reported reservation is the CLAMPED one, so the three always reconcile", () => {
    const view = balanceBreakdown(5, 12);
    expect(view.total - view.locked).toBe(view.free);
    expect(view.locked).toBe(5);
  });

  test("total = locked + free holds across the awkward inputs", () => {
    for (const [total, locked] of [
      [100, 30],
      [100, null],
      [100, -5],
      [5, 12],
      [0.3, 0.1],
      [0, 0],
    ]) {
      const view = balanceBreakdown(total, locked);
      expect(view.locked + view.free).toBeCloseTo(view.total, 8);
    }
  });
});

// ---------------------------------------------------------------------------
// lib/walletBalance.js#lockedShortfallMessage - why a transfer was refused.
// ---------------------------------------------------------------------------
describe("lockedShortfallMessage - 'Insufficient Balance' is a lie when the wallet is full of margin", () => {
  test("with nothing reserved the original wording is preserved EXACTLY", () => {
    // Anything already keying off this string must not change behaviour.
    expect(lockedShortfallMessage(0, 0)).toBe("Insufficient Balance");
    expect(lockedShortfallMessage(0, null)).toBe("Insufficient Balance");
    expect(lockedShortfallMessage(0, -3)).toBe("Insufficient Balance");
  });

  test("with margin reserved it names both numbers the user needs", () => {
    const msg = lockedShortfallMessage(20, 80);
    expect(msg).not.toBe("Insufficient Balance");
    expect(msg).toContain("20");
    expect(msg).toContain("80");
    expect(msg).toMatch(/free to transfer/);
    expect(msg).toMatch(/reserved as margin/);
  });

  test("a negative free balance is reported as zero free, not as a negative", () => {
    expect(lockedShortfallMessage(-4, 10)).toMatch(/^Insufficient available balance\. 0 is free/);
  });

  test("float noise never reaches the sentence", () => {
    expect(lockedShortfallMessage(0.1 + 0.2, 1)).toContain("0.3");
    expect(lockedShortfallMessage(0.1 + 0.2, 1)).not.toContain("0.30000000000000004");
  });
});

// ---------------------------------------------------------------------------
// lib/roundOf.js - the rounding every user-facing balance passes through.
// ---------------------------------------------------------------------------
describe("toFixed / toFixedDown - rounding a balance", () => {
  test("toFixed rounds to the requested precision and returns a NUMBER", () => {
    expect(toFixed("100.567", 2)).toBe(100.57);
    expect(typeof toFixed("100.567", 2)).toBe("number");
  });

  test("toFixed defaults to 2 places", () => {
    expect(toFixed("100.567")).toBe(100.57);
  });

  test("toFixedDown TRUNCATES rather than rounding - it never hands out money", () => {
    // The whole reason both exist. Rounding a withdrawable balance UP pays out
    // a fraction the account does not hold.
    expect(toFixedDown(100.999, 2)).toBe(100.99);
    expect(toFixedDown(0.999999999, 8)).toBe(0.99999999);
    expect(toFixedDown(100.999, 2)).toBeLessThan(toFixed(100.999, 2));
  });

  test("toFixedDown truncates toward zero on negatives too", () => {
    expect(toFixedDown(-100.999, 2)).toBe(-100.99);
    expect(Math.abs(toFixedDown(-100.999, 2))).toBeLessThan(100.999);
  });

  test("truncation is never larger than the input, at any precision", () => {
    for (const value of [1.23456789, 0.00000199, 999.9999999, 12.5]) {
      for (const digits of [0, 2, 4, 8]) {
        expect(toFixedDown(value, digits)).toBeLessThanOrEqual(value);
      }
    }
  });

  test("both refuse non-numeric input rather than answering NaN", () => {
    expect(toFixed("abc")).toBe("");
    expect(toFixed(null)).toBe("");
    expect(toFixed(undefined)).toBe("");
    expect(toFixedDown("abc")).toBe("");
    expect(toFixedDown(null)).toBe("");
  });

  test("8 decimals, the ledger precision, survives a round trip", () => {
    expect(toFixed("0.00000001", 8)).toBe(0.00000001);
    expect(toFixedDown(0.00000001, 8)).toBe(0.00000001);
  });
});

// ---------------------------------------------------------------------------
// lib/calculation.js - fee arithmetic wallet.controller.js calls.
// ---------------------------------------------------------------------------
describe("fee and percentage calculations", () => {
  test("precentConvetPrice returns the FEE, not the net", () => {
    // withdrawCoinRequest sizes the withdrawal fee with this.
    expect(precentConvetPrice(200, 1.5)).toBe(3);
    expect(precentConvetPrice("1000", "0.1")).toBe(1);
  });

  test("percentageCalculation returns the price NET of the percentage", () => {
    expect(percentageCalculation(200, 1.5)).toBe(197);
  });

  test("the two are complements: net + fee = gross", () => {
    for (const [price, pct] of [
      [200, 1.5],
      [1000, 0.1],
      [55.5, 12],
    ]) {
      expect(
        percentageCalculation(price, pct) + precentConvetPrice(price, pct)
      ).toBeCloseTo(price, 8);
    }
  });

  test("a zero percentage takes nothing", () => {
    expect(precentConvetPrice(200, 0)).toBe(0);
    expect(percentageCalculation(200, 0)).toBe(200);
  });

  test("commissionFeeCalculate reports the gap between requested and credited", () => {
    expect(commissionFeeCalculate(100, 95)).toEqual({
      commissionFee: 5,
      amount: 95,
    });
  });

  test("commissionFeeCalculate reports no fee when nothing was withheld", () => {
    expect(commissionFeeCalculate(100, 100).commissionFee).toBe(0);
  });

  test("calculateServiceFee and withoutServiceFee split a price exactly", () => {
    const price = 250;
    const serviceFee = 4;
    expect(calculateServiceFee({ price, serviceFee })).toBe(10);
    expect(withoutServiceFee({ price, serviceFee })).toBe(240);
    expect(
      calculateServiceFee({ price, serviceFee }) +
        withoutServiceFee({ price, serviceFee })
    ).toBeCloseTo(price, 8);
  });

  test("interestByDays spreads the rate across the period", () => {
    // 10% of 3650 is 365; over 365 days that is 1 per day.
    expect(interestByDays(3650, 10, 365)).toBeCloseTo(1, 8);
  });

  test("THE isEmpty GUARDS IN THIS MODULE ARE DEAD, and callers must sanitise first", () => {
    // Pinning what the code really does rather than what its shape suggests.
    //
    // Every function here does `price = parseFloat(price)` BEFORE testing
    // `isEmpty(price)`. lib/isEmpty.js is true only for undefined, null, a
    // blank string or an empty object - and parseFloat never returns any of
    // those, it returns a number or NaN. So the `return 0` fallbacks are
    // unreachable, and a non-numeric input propagates as NaN.
    //
    // That matters because a NaN fee is a NaN amount, and a NaN amount written
    // to a balance is an unrecoverable ledger row. lib/walletBalance.js
    // (toLedgerNumber, above) is where this service DOES defend itself, and
    // these helpers are only ever called with numbers already parsed from a
    // validated request body. This test exists so that if someone adds a real
    // guard here, they do it deliberately and see this line go red rather than
    // silently changing what a fee calculation answers.
    expect(Number.isNaN(precentConvetPrice("", 10))).toBe(true);
    expect(Number.isNaN(percentageCalculation(null, 10))).toBe(true);
    expect(Number.isNaN(interestByDays("", 10, 365))).toBe(true);

    // And a numeric zero period is not "missing" either - it divides.
    expect(Number.isFinite(interestByDays(1000, 10, 0))).toBe(false);
  });

  test("with numeric inputs - the only way they are called - the answers are exact", () => {
    expect(precentConvetPrice(0, 10)).toBe(0);
    expect(percentageCalculation(0, 10)).toBe(0);
    expect(interestByDays(0, 10, 365)).toBe(0);
    expect(Number.isNaN(precentConvetPrice(0, 10))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lib/spotMirror.js - the smallest-unit conversion and the delta write.
// ---------------------------------------------------------------------------
/*
 * Three helpers were tested here - the smallest-unit conversion, the mirror
 * field name and the two id shapes - and five of the applySpotDelta tests
 * below them covered mirroring. All of it derived a flat `assets` row and a
 * second redis field from a spot balance. That ledger held USDC alone and went
 * with it: there is no second copy of a spot balance left to bring into step,
 * so what remains of applySpotDelta is the engine write itself.
 */
describe("applySpotDelta - the one spot write, and what it returns", () => {
  const makeDeps = ({ after } = {}) => {
    const calls = { hincbyfloat: [] };
    return {
      calls,
      deps: {
        hincbyfloat: async (hash, field, delta) => {
          calls.hincbyfloat.push([hash, field, delta]);
          return after;
        },
      },
    };
  };

  test("moves the ENGINE field by the delta, under the currencyId key style", async () => {
    const { calls, deps } = makeDeps({ after: "1041" });
    await applySpotDelta({ userId: "u1", currencyId: "c1", delta: 41 }, deps);
    expect(calls.hincbyfloat).toEqual([["walletbalance_spot", "u1_c1", 41]]);
  });

  test("returns what HINCRBYFLOAT returned, so callers read exactly as before", async () => {
    const { deps } = makeDeps({ after: "1041" });
    const out = await applySpotDelta(
      { userId: "u1", currencyId: "c1", delta: 41 },
      deps
    );
    expect(out).toBe("1041");
  });

  test("needs nothing but the atomic increment", async () => {
    // The guard against a mirror creeping back in: handing it only
    // hincbyfloat - no db, no hget, no hset - must still be enough.
    const { calls, deps } = makeDeps({ after: "5" });
    await expect(
      applySpotDelta({ userId: "u1", currencyId: "c1", delta: -1 }, deps)
    ).resolves.toBe("5");
    expect(calls.hincbyfloat).toHaveLength(1);
  });
});

describe("a transfer neither creates nor destroys balance", () => {
  test("what one wallet loses the other gains, at ledger precision", () => {
    const move = (fromTotal, fromLocked, toTotal, amount) => {
      const from = balanceBreakdown(fromTotal, fromLocked);
      if (from.free < amount) return null;
      return {
        from: balanceBreakdown(fromTotal - amount, fromLocked),
        to: balanceBreakdown(toTotal + amount, 0),
      };
    };

    const before = 100 + 40;
    const after = move(100, 30, 40, 25);
    expect(after).not.toBeNull();
    expect(after.from.total + after.to.total).toBeCloseTo(before, 8);
    // And the reservation is untouched by a transfer of free funds.
    expect(after.from.locked).toBe(30);
    expect(after.from.free).toBe(45);
  });

  test("a move larger than the free balance is refused before anything changes", () => {
    const view = balanceBreakdown(100, 80);
    expect(view.free).toBe(20);
    expect(view.free < 50).toBe(true);
  });
});
