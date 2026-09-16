/**
 * THE REQUEST CONTRACT: whose fault is it?
 * ========================================
 *
 * A 5xx is a PROMISE that the request was fine and the VENUE broke, and clients
 * act on that promise: a retry policy re-sends it, an uptime monitor pages on
 * it, a circuit breaker opens on it and stops sending the requests that WOULD
 * have worked. Answering 500 to a malformed request therefore does real damage
 * that the malformed request itself never could - it reports an exchange as
 * down when nothing is wrong with it, and it does so in a loop, because a body
 * that will not decrypt will not decrypt any better on the retry.
 *
 * Pinned here:
 *   1. `/cancelOrder` answered `500 "Error on server"` for a body that was
 *      absent, was not valid ciphertext, or simply did not carry the two fields
 *      a cancel needs. Now 400.
 *   2. `decryptTradeOrder` installed `""` as `req.body` when the token would
 *      not decrypt (decryptObject swallows its own failure) and walked on.
 *      Now 400 at the point the fault is known.
 *   3. `/filledOrder/:pairId` casts the param with `ObjectId(...)`, which
 *      THROWS on anything that is not a 24-hex id, and the catch answered 500.
 *      Now 400. It is the only handler on this router that casts the param -
 *      every sibling reads it through `hgetall("<hash>_" + pairId)` or
 *      `FetchpairData`, both of which merely find nothing.
 *
 * And the guard that made round five of mutation testing:
 *   4. `OPEN_ORDER_TABLE` in cancelOrder. It is redundant with
 *      `cancelAuthorised`'s side/table clause for AUTHORISATION - that is why
 *      deleting it left the whole suite green - but it is not the same guard:
 *      it is the only thing that constrains a client-supplied string before it
 *      is used as a REDIS KEY NAME, in `hget`, then `hgetdel` (a mutation), and
 *      then `hset` on the put-back. Its contract is therefore not "the response
 *      is 400" (the ownership check produces that too, which is exactly why no
 *      test could tell) but "the request never reaches redis at all", and that
 *      is what is asserted below.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

jest.mock("node-cron", () => ({ schedule: () => ({ stop: () => {} }) }));

jest.mock("../../models/index.js", () => ({
  __esModule: true,
  SpotPair: { find: async () => [], findOne: async () => null },
  SpotOrder: {},
  TradeHistory: class {},
  OrderHistory: {
    countDocuments: jest.fn(async () => 0),
    aggregate: jest.fn(async () => []),
    find: jest.fn(() => ({ sort: () => ({ skip: () => ({ limit: async () => [] }) }) })),
  },
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

// The REAL failure mode of the crypto helper: it swallows its own error and
// answers "" rather than throwing (lib/cryptoJS.js). Everything below depends
// on that, so it is reproduced rather than mocked away.
jest.mock("../../lib/cryptoJS.js", () => ({
  __esModule: true,
  decryptObject: (value) => {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value === "string") return ""; // undecryptable ciphertext
    return value;
  },
  encryptObject: (value) => value,
  decryptJs: (value) => value,
  encryptJs: (value) => value,
}));

// EVERY redis entry point is a jest.fn, so a test can assert that a rejected
// request issued NO redis command at all - which is the only observable
// difference between having the table guard and not having it.
jest.mock("../../controllers/redis.controller.js", () => ({
  __esModule: true,
  set: jest.fn(async () => true),
  get: jest.fn(async () => null),
  del: jest.fn(async () => {}),
  hset: jest.fn(async () => {}),
  hget: jest.fn(async () => null),
  hgetall: jest.fn(async () => null),
  hdel: jest.fn(async () => 0),
  hgetdel: jest.fn(async () => null),
  hincbyfloat: jest.fn(async () => "0"),
  hincrbyfloatIfEnough: jest.fn(async () => null),
  hincby: jest.fn(async () => {}),
  hlen: jest.fn(async () => 0),
  hmget: jest.fn(async () => []),
  hmset: jest.fn(async () => {}),
  rpush: jest.fn(async () => {}),
  lrange: jest.fn(async () => null),
  lpop: jest.fn(async () => {}),
  rpop: jest.fn(async () => {}),
}));

jest.mock("../../lib/binanceWebSocket.js", () => ({
  __esModule: true,
  getDepthSnapshot: () => null,
}));

jest.mock("../../grpc/currencyService.js", () => ({
  __esModule: true,
  priceConversionGrpc: async () => ({ status: false }),
}));

jest.mock("../../grpc/walletService.js", () => ({
  __esModule: true,
  getUserAsset: async () => {},
  updateUserWallet: async () => true,
  updateUserAsset: async () => {},
  passbook: jest.fn(),
}));

jest.mock("../../grpc/adminService.js", () => ({
  __esModule: true,
  saveAdminprofit: () => {},
}));

import {
  cancelOrder,
  decryptTradeOrder,
  getFilledOrder,
  OPEN_ORDER_TABLE,
} from "../../controllers/spot.controller.js";
import * as redisMock from "../../controllers/redis.controller.js";
import * as walletMock from "../../grpc/walletService.js";

const PAIR_ID = "695bf1017573eeb15a749c9d";
const USER_ID = "6a70f1c287c92c7218ac37fc";
const ORDER_ID = "6a731e42490600b66d6adce9";

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

const cancel = async (body, user = { id: USER_ID }) => {
  const res = mockRes();
  await cancelOrder({ body, user }, res);
  return res;
};

/** Every redis entry point that can name a key. */
const REDIS_FNS = [
  "hget",
  "hgetall",
  "hgetdel",
  "hset",
  "hdel",
  "hincbyfloat",
  "hincrbyfloatIfEnough",
  "hlen",
  "hmget",
  "hmset",
  "get",
  "set",
  "del",
  "lrange",
  "rpush",
];

const redisCalls = () =>
  REDIS_FNS.flatMap((name) =>
    redisMock[name].mock.calls.map((args) => ({ fn: name, args }))
  );

beforeEach(() => {
  jest.clearAllMocks();
});

describe("cancelOrder answers 400 for a request it cannot parse", () => {
  test("an absent body is the caller's fault, not the venue's", async () => {
    const res = await cancel({});

    expect(res.statusCode).toBe(400);
    expect(res.payload.status).toBe(false);
    expect(redisCalls()).toEqual([]);
  });

  test("a token that will not decrypt is the caller's fault", async () => {
    // decryptObject answers "" rather than throwing, so this is
    // indistinguishable here from a missing body - and both are 400.
    const res = await cancel({ id: "not-real-ciphertext" });

    expect(res.statusCode).toBe(400);
    expect(redisCalls()).toEqual([]);
  });

  test("a decrypted payload missing tableId is the caller's fault", async () => {
    const res = await cancel({ id: { orderId: ORDER_ID } });

    expect(res.statusCode).toBe(400);
    expect(redisCalls()).toEqual([]);
  });

  test("a decrypted payload missing orderId is the caller's fault", async () => {
    const res = await cancel({ id: { tableId: `buyOpenOrders_${PAIR_ID}` } });

    expect(res.statusCode).toBe(400);
    expect(redisCalls()).toEqual([]);
  });

  test("no balance is moved and no audit row is written for a malformed cancel", async () => {
    await cancel({});
    await cancel({ id: "garbage" });

    expect(redisMock.hincbyfloat).not.toHaveBeenCalled();
    expect(walletMock.passbook).not.toHaveBeenCalled();
  });
});

describe("OPEN_ORDER_TABLE: a client string never becomes a redis key", () => {
  // Each of these is rejected by the ownership check too, which is why the
  // suite stayed green when the guard was deleted. The distinguishing claim is
  // the one below: the request must not reach redis AT ALL.
  const rejected = [
    ["the order-history hash", `orderHistory_${USER_ID}`],
    ["a balance hash", "walletbalance_spot"],
    ["the in-order ledger", "walletbalance_spot_inOrder"],
    ["the session hash", "userToken"],
    ["a near-miss with a suffix", `buyOpenOrders_${PAIR_ID}_x`],
    ["a near-miss with a non-hex id", "buyOpenOrders_notanobjectid"],
    ["an empty pair id", "buyOpenOrders_"],
    ["the pair cache", "spotPairdata"],
  ];

  test.each(rejected)(
    "%s is refused before any redis command is issued",
    async (_label, tableId) => {
      const res = await cancel({ id: { tableId, orderId: ORDER_ID } });

      expect(res.statusCode).toBe(400);
      expect(res.payload.message).toBe("Order not found");
      // THE ASSERTION THE OWNERSHIP CHECK CANNOT MAKE. Without the table guard
      // the pre-read fires `hget(<client string>, <client string>)`, and on a
      // hash that did hold an order-shaped value the claim `hgetdel` - a
      // MUTATION - would fire too. The guard's contract is that a table name
      // this service does not recognise never becomes a key name at all.
      expect(redisCalls()).toEqual([]);
    }
  );

  test("the two hashes it DOES admit are read, so the guard is not simply refusing everything", async () => {
    for (const side of ["buy", "sell"]) {
      jest.clearAllMocks();
      const res = await cancel({
        id: { tableId: `${side}OpenOrders_${PAIR_ID}`, orderId: ORDER_ID },
      });

      // hget returns null from the mock, so the order is "not found" - but the
      // read HAPPENED, which is the half of the contract that proves the guard
      // is a shape check and not a blanket refusal.
      expect(redisMock.hget).toHaveBeenCalledWith(
        `${side}OpenOrders_${PAIR_ID}`,
        ORDER_ID
      );
      expect(res.statusCode).toBe(400);
    }
  });

  test("the pattern itself admits exactly the two open-order hashes", () => {
    expect(OPEN_ORDER_TABLE.test(`buyOpenOrders_${PAIR_ID}`)).toBe(true);
    expect(OPEN_ORDER_TABLE.test(`sellOpenOrders_${PAIR_ID}`)).toBe(true);
    expect(OPEN_ORDER_TABLE.test(`orderHistory_${USER_ID}`)).toBe(false);
    expect(OPEN_ORDER_TABLE.test(`buyOpenOrders_${PAIR_ID}_x`)).toBe(false);
  });
});

describe("the cancel authorisation, guard by guard", () => {
  const TABLE = `buyOpenOrders_${PAIR_ID}`;
  const order = (over = {}) => ({
    _id: ORDER_ID,
    userId: USER_ID,
    buyorsell: "buy",
    orderType: "limit",
    price: 63000,
    quantity: 0.001,
    secondCurrencyId: "695bf0e2b9aba016fb8ce3c4",
    firstCurrencyId: "695bf0e2b9aba016fb8ce3c1",
    ...over,
  });

  test("a PAPER order the caller genuinely owns is still refused, and never claimed", async () => {
    // The isPaper gate survived round five because every fixture that exercised
    // it was ADMIN-owned, so the ownership check refused it first and the two
    // guards were indistinguishable. Synthetic ladder liquidity is never
    // debited on placement, so refunding it credits balance out of nothing -
    // and the ONLY thing standing between that and a caller who owns the
    // ladder account is this flag.
    redisMock.hget.mockResolvedValue(JSON.stringify(order({ isPaper: true })));

    const res = await cancel({ id: { tableId: TABLE, orderId: ORDER_ID } });

    expect(res.statusCode).toBe(400);
    // Refused on the PRE-READ, so the order never even leaves the book.
    expect(redisMock.hgetdel).not.toHaveBeenCalled();
    expect(redisMock.hincbyfloat).not.toHaveBeenCalled();
    expect(walletMock.passbook).not.toHaveBeenCalled();
  });

  test("the claimed value is re-authorised, and a mismatch is put back untouched", async () => {
    // The second `cancelAuthorised` call survived round five because both calls
    // saw the same object. They need not: the pre-read and the claim are two
    // separate reads, and only the claim decides what is refunded. If what
    // comes back under the claim is not what was authorised, the refund must
    // not happen AND the order must go back exactly as it was taken.
    const authorised = order();
    const claimed = order({ userId: "6a70fe409c46d957cd45ba3a" }); // someone else's
    redisMock.hget.mockResolvedValue(JSON.stringify(authorised));
    redisMock.hgetdel.mockResolvedValue(JSON.stringify(claimed));

    const res = await cancel({ id: { tableId: TABLE, orderId: ORDER_ID } });

    expect(res.statusCode).toBe(400);
    expect(res.payload.message).toBe("Order not found");
    // Put back, and nothing paid out.
    expect(redisMock.hset).toHaveBeenCalledWith(
      TABLE,
      ORDER_ID,
      expect.objectContaining({ userId: "6a70fe409c46d957cd45ba3a" })
    );
    expect(redisMock.hincbyfloat).not.toHaveBeenCalled();
    expect(walletMock.passbook).not.toHaveBeenCalled();
  });

  test("losing the claim race pays nothing and puts nothing back", async () => {
    redisMock.hget.mockResolvedValue(JSON.stringify(order()));
    redisMock.hgetdel.mockResolvedValue(null);

    const res = await cancel({ id: { tableId: TABLE, orderId: ORDER_ID } });

    expect(res.statusCode).toBe(400);
    expect(redisMock.hset).not.toHaveBeenCalled();
    expect(redisMock.hincbyfloat).not.toHaveBeenCalled();
  });
});

describe("decryptTradeOrder answers 400 for a token it cannot read", () => {
  const call = async (body) => {
    const res = mockRes();
    const next = jest.fn();
    await decryptTradeOrder({ body }, res, next);
    return { res, next };
  };

  test("an undecryptable token does not become the request body", async () => {
    const { res, next } = await call({ token: "not-real-ciphertext" });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.payload.errors.token).toBe("INVALID");
  });

  test("an absent token is 400, not a request that walks on with an empty body", async () => {
    const { res, next } = await call({});

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  test("a token that DOES decrypt is installed and passed on", async () => {
    const payload = { orderType: "limit", spotPairId: PAIR_ID };
    const req = { body: { token: payload } };
    const res = mockRes();
    const next = jest.fn();

    await decryptTradeOrder(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
    expect(req.body).toEqual(payload);
  });
});

describe("getFilledOrder answers 400 for a pair id it cannot cast", () => {
  const call = async (pairId) => {
    const res = mockRes();
    await getFilledOrder(
      { params: { pairId }, query: {}, user: { id: USER_ID } },
      res
    );
    return res;
  };

  test("a non-ObjectId pair id is the caller's fault", async () => {
    const res = await call("abc");

    expect(res.statusCode).toBe(400);
    expect(res.payload.message).toBe("Invalid pair id");
  });

  test("an absent pair id is the caller's fault", async () => {
    const res = await call(undefined);

    expect(res.statusCode).toBe(400);
  });

  test("a well-formed pair id still reaches the query", async () => {
    const res = await call(PAIR_ID);

    expect(res.statusCode).not.toBe(400);
  });
});
