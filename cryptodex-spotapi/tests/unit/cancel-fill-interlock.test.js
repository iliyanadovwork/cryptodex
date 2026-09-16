/**
 * CANCEL-vs-FILL INTERLOCK  (H1 regression - CRITICAL, paper-money mint)
 * =====================================================================
 *
 * THE DEFECT. matchingcall reads the buy/sell open-order hashes into an
 * in-memory snapshot and only settles the fills later in the same tick. The
 * module-level `tradePair` latch - the ONLY thing cancelOrder consults to
 * refuse a cancel while a match is in flight - used to be armed deep inside
 * tradeMatching, and only when a crossing top-of-book was found (`topCross`),
 * i.e. AFTER matchingcall had already read the hashes. A cancel that landed in
 * the window between the read and that late arming saw `tradePair == ""`,
 * sailed past the guard, ran the atomic hgetdel-claim and REFUNDED the
 * reservation - and then the matcher, working from its stale pre-cancel
 * snapshot, credited the very same order's fill. Refund + settled coin = a
 * double-pay (mint).
 *
 * THE FIX. matchingcall now sets `tradePair = pairData._id` BEFORE the first
 * `hgetall`, and its `finally` clears it once per tick. cancelOrder's line-1297
 * guard therefore covers the entire read+settle window. The fragile per-fill
 * `tradePair = ""` that used to sit between fills (re-opening the window for
 * every fill after the first) was removed.
 *
 * WHAT THIS PINS. Driving the REAL matchingcall/cancelOrder with all I/O mocked,
 * suspend matchingcall exactly at its buyOpenOrders read and prove a concurrent
 * cancel is rejected by the "processing" guard - then, once the tick finishes,
 * prove the latch is released so the cancel is honoured again. Against the old
 * code the first assertion is false (the read window was unguarded).
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

// ---- boundary stubs (declared before importing the controller) ----
// jest.config sets resetMocks:true, so factories use PLAIN functions (a
// jest.fn() would be stripped of its implementation between tests) and any
// closed-over test state is `mock`-prefixed for babel-plugin-jest-hoist.

jest.mock("node-cron", () => ({ schedule: () => ({ stop: () => {} }) }));

jest.mock("../../models/index.js", () => ({
  __esModule: true,
  SpotPair: {
    find: async () => [],
    findOne: async () => null,
    updateOne: () => ({ exec: async () => {} }),
  },
  SpotOrder: {},
  OrderHistory: {},
  TradeHistory: class {},
  SequenceId: { findOneAndUpdate: async () => ({ lastIndex: 1000 }) },
}));

jest.mock("../../config/socketIO.js", () => ({
  __esModule: true,
  socketEmitOne: () => {},
  socketEmitAll: () => {},
}));

jest.mock("../../controllers/binance.controller.js", () => ({ __esModule: true }));

jest.mock("../../controllers/chart/chart.controller.js", () => ({
  __esModule: true,
  ChartDocHistory: () => {},
}));

jest.mock("../../lib/cryptoJS.js", () => ({
  __esModule: true,
  decryptObject: (v) => v,
  encryptObject: (v) => v,
  decryptJs: (v) => v,
  encryptJs: (v) => v,
}));

// KEY: neutralise the paper-ladder refresh so matchingcall reaches its read.
jest.mock("../../controllers/paperBook.controller.js", () => ({
  __esModule: true,
  syncPaperBook: async () => {},
  getLadderState: () => ({}),
}));

// Controllable redis: only hget/hgetall vary per test; everything else is inert.
let mockHget;
let mockHgetall;
jest.mock("../../controllers/redis.controller.js", () => ({
  __esModule: true,
  hget: (...a) => mockHget(...a),
  hgetall: (...a) => mockHgetall(...a),
  set: async () => {},
  get: async () => null,
  del: async () => {},
  hset: async () => {},
  hdel: async () => 0,
  hgetdel: async () => null,
  hincby: async () => {},
  hincbyfloat: async () => "0",
  hincrbyfloatIfEnough: async () => null,
  hlen: async () => 0,
  hmget: async () => [],
  hmset: async () => true,
  rpush: async () => {},
  lrange: async () => [],
  lpop: async () => null,
  rpop: async () => null,
}));

jest.mock("../../grpc/currencyService.js", () => ({
  __esModule: true,
  priceConversionGrpc: async () => ({}),
}));

jest.mock("../../grpc/walletService.js", () => ({
  __esModule: true,
  getUserAsset: async () => ({}),
  updateUserWallet: async () => {},
  updateUserAsset: async () => {},
  passbook: async () => {},
}));

jest.mock("../../grpc/adminService.js", () => ({
  __esModule: true,
  saveAdminprofit: async () => {},
}));

import { matchingcall, cancelOrder } from "../../controllers/spot.controller.js";

const PAIR_ID = "64b000000000000000000001"; // 24 hex - satisfies OPEN_ORDER_TABLE
const TABLE = `buyOpenOrders_${PAIR_ID}`;
const pairFixture = {
  _id: PAIR_ID,
  status: "active",
  pair: "BTCUSDC",
  firstCurrencySymbol: "BTC",
  secondCurrencySymbol: "USDC",
  botstatus: "bot",
  markPrice: 50000,
};

// Let the un-awaited matchingcall chain advance to its suspension point.
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

// Invoke the real cancelOrder against a fake req/res and hand back what it sent.
const callCancel = async () => {
  let captured = null;
  const res = {
    status: (code) => ({
      json: (body) => {
        captured = { code, body };
        return captured;
      },
    }),
  };
  // decryptObject is the identity stub, so the body IS the decrypted object.
  const req = { body: { id: { tableId: TABLE, orderId: "o1" } }, user: { id: "u1" } };
  await cancelOrder(req, res);
  return captured;
};

beforeEach(() => {
  mockHget = async (key, field) => {
    if (key === "spotPairdata" && String(field) === PAIR_ID) {
      return JSON.stringify(pairFixture);
    }
    return null; // no resting order at (TABLE, o1)
  };
  mockHgetall = async () => null; // empty books by default
});

describe("cancel-vs-fill interlock (H1 regression)", () => {
  test("with no matcher in flight the cancel is NOT blocked by the interlock", async () => {
    const out = await callCancel();
    expect(out.code).toBe(400);
    // Reaches the claim, finds no order -> "Order not found", NOT the
    // "processing" guard. Proves the latch is not stuck armed at rest.
    expect(out.body.message).toMatch(/not found/i);
    expect(out.body.message).not.toMatch(/processing/i);
  });

  test("a cancel racing the matcher's READ WINDOW is rejected by the interlock", async () => {
    // Suspend matchingcall exactly at its buyOpenOrders read, AFTER it has armed
    // tradePair. Against the pre-fix code tradePair was still "" here (it was set
    // inside tradeMatching, after this read), so the cancel would NOT be blocked.
    let releaseRead;
    const pendingRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    mockHgetall = async (key) => {
      if (typeof key === "string" && key.startsWith("buyOpenOrders_")) return pendingRead;
      return null;
    };

    const inflight = matchingcall(PAIR_ID);
    await flush(); // past FetchpairData + syncPaperBook + `tradePair = pairData._id`

    const blocked = await callCancel();
    expect(blocked.code).toBe(400);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.message).toMatch(/processing/i);

    // Finish the tick; matchingcall's finally MUST clear the latch.
    releaseRead(null);
    await inflight;

    const afterTick = await callCancel();
    // Guard no longer active: the cancel runs to the claim and finds nothing.
    expect(afterTick.body.message).toMatch(/not found/i);
    expect(afterTick.body.message).not.toMatch(/processing/i);
  });

  test("the latch is released even when the tick throws before matching", async () => {
    // Make the buyOpenOrders read throw AFTER tradePair is armed. The finally
    // must still clear it, or every future cancel on this pair is refused.
    mockHgetall = async (key) => {
      if (typeof key === "string" && key.startsWith("buyOpenOrders_")) {
        throw new Error("redis blip mid-read");
      }
      return null;
    };

    await expect(matchingcall(PAIR_ID)).rejects.toThrow(/redis blip/);

    const afterThrow = await callCancel();
    expect(afterThrow.body.message).toMatch(/not found/i);
    expect(afterThrow.body.message).not.toMatch(/processing/i);
  });
});
