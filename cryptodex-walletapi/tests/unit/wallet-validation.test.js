/**
 * WALLET REQUEST VALIDATION - THE MIDDLEWARE THIS SERVICE ACTUALLY MOUNTS
 * ======================================================================
 *
 * WHAT THIS REPLACES
 * ------------------
 * This file was headed "CRITICAL TESTS - These tests verify wallet validation
 * logic" and imported nothing at all. Its assertions were of the form
 *
 *     const currentBalance = '100.50';
 *     const amountToAdd = '50.25';
 *     const newBalance = parseFloat(currentBalance) + parseFloat(amountToAdd);
 *     expect(newBalance).toBe(150.75);
 *
 * and
 *
 *     const isValid = ['active','inactive'].includes(status);
 *     expect(isValid).toBe(true);
 *
 * - arithmetic and array membership, computed and asserted in the same
 * breath, naming no wallet, no validator and no function in this repository.
 * There is no edit to validation/wallet.validation.js that could have made it
 * fail.
 *
 * WHAT IS TESTED NOW
 * ------------------
 * The validators express actually runs, imported from
 * validation/wallet.validation.js and invoked as middleware with a real
 * request/response pair:
 *
 *   coinWithdrawValid        the crypto withdrawal gate, including the REAL
 *                            address check in controllers/coin.controller.js
 *   fiatWithdrawValidate     the fiat withdrawal gate
 *   depositReqtValid         the fiat deposit request gate
 *   tokenValid               the encrypted-payload gate on every 2FA route
 *   fiatDepositApproveValid  the admin approval gate
 *   fiatDepositRejectValid / rejectcoinWithdraw / rejectFiatWithdraw
 *   updateGasStationConfig   the yup-schema gate
 *
 * plus `isCryptoAddr`, the address validator those gates delegate to.
 *
 * `walletTransferValid` is deliberately NOT retested here - it has its own
 * file, tests/unit/wallet-transfer-validation.test.js, and duplicating it would
 * make the transfer guard look twice as covered as it is.
 *
 * THE SHAPE OF EVERY TEST
 * -----------------------
 * A validator either calls `next()` or answers a 4xx. Both outcomes are
 * observed on a recording res, so "accepted" and "refused" are distinguishable
 * and neither can be faked by an assertion that only looks at one of them.
 */

/* eslint-disable no-undef */

import { describe, test, expect, jest } from "@jest/globals";
import mongoose from "mongoose";

import {
  coinWithdrawValid,
  fiatWithdrawValidate,
  depositReqtValid,
  tokenValid,
  fiatDepositApproveValid,
  fiatDepositRejectValid,
  rejectcoinWithdraw,
  rejectFiatWithdraw,
  updateGasStationConfig,
} from "../../validation/wallet.validation.js";
import { isCryptoAddr } from "../../controllers/coin.controller.js";

const objectId = () => new mongoose.Types.ObjectId().toString();

/** A res that records what the middleware did to it. */
const recorder = () => ({
  statusCode: null,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.payload = body;
    return this;
  },
});

/** Run a synchronous or asynchronous middleware and report the outcome. */
const run = async (middleware, body, extra = {}) => {
  const req = { body: { ...body }, ...extra };
  const res = recorder();
  const next = jest.fn();
  await middleware(req, res, next);
  return {
    req,
    res,
    next,
    passed: next.mock.calls.length === 1 && res.statusCode === null,
    status: res.statusCode,
    errors: (res.payload && res.payload.errors) || null,
    message: res.payload && res.payload.message,
  };
};

// Addresses the REAL multicoin validator accepts. Not invented: these are the
// canonical well-formed examples for each chain.
const GOOD_ETH = "0x52908400098527886E0F7030069857D2E4169EE7";
const GOOD_BTC = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const GOOD_TRX = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// ---------------------------------------------------------------------------
// controllers/coin.controller.js#isCryptoAddr - what the withdrawal gate asks.
// ---------------------------------------------------------------------------
describe("isCryptoAddr - the real address check behind coinWithdrawValid", () => {
  test("accepts a well-formed address for its own chain", async () => {
    await expect(isCryptoAddr("ETH", GOOD_ETH)).resolves.toBe(true);
    await expect(isCryptoAddr("BTC", GOOD_BTC)).resolves.toBe(true);
    await expect(isCryptoAddr("TRX", GOOD_TRX)).resolves.toBe(true);
  });

  test("rejects an address from the WRONG chain", async () => {
    // The costly mistake this guard exists for: an ETH address pasted into a
    // BTC withdrawal is well-formed and unspendable.
    await expect(isCryptoAddr("BTC", GOOD_ETH)).resolves.toBe(false);
    await expect(isCryptoAddr("ETH", GOOD_BTC)).resolves.toBe(false);
  });

  test("rejects malformed and truncated addresses", async () => {
    await expect(isCryptoAddr("ETH", "0xnope")).resolves.toBe(false);
    await expect(isCryptoAddr("ETH", GOOD_ETH.slice(0, -1))).resolves.toBe(false);
    await expect(isCryptoAddr("BTC", "")).resolves.toBe(false);
  });

  test("EVM-compatible chains are validated as ETH", async () => {
    // BNB, BDYX and POLYGON all use the ETH address format on this deployment.
    await expect(isCryptoAddr("BNB", GOOD_ETH)).resolves.toBe(true);
    await expect(isCryptoAddr("POLYGON", GOOD_ETH)).resolves.toBe(true);
    await expect(isCryptoAddr("BDYX", GOOD_ETH)).resolves.toBe(true);
  });

  test("a token's NETWORK decides the format, not the token's own symbol", async () => {
    // USDT exists on several chains; erc20/bep20/poly20 are ETH-shaped, trc20
    // is TRX-shaped. Getting this backwards sends a withdrawal into the void.
    await expect(isCryptoAddr("USDT", GOOD_ETH, "erc20")).resolves.toBe(true);
    await expect(isCryptoAddr("USDT", GOOD_ETH, "bep20")).resolves.toBe(true);
    await expect(isCryptoAddr("USDT", GOOD_ETH, "poly20")).resolves.toBe(true);
    await expect(isCryptoAddr("USDT", GOOD_TRX, "trc20")).resolves.toBe(true);
    await expect(isCryptoAddr("USDT", GOOD_ETH, "trc20")).resolves.toBe(false);
    await expect(isCryptoAddr("USDT", GOOD_TRX, "erc20")).resolves.toBe(false);
  });

  test("a missing coin or address is refused, never assumed valid", async () => {
    await expect(isCryptoAddr("", GOOD_ETH)).resolves.toBe(false);
    await expect(isCryptoAddr(null, GOOD_ETH)).resolves.toBe(false);
    await expect(isCryptoAddr("ETH", null)).resolves.toBe(false);
    await expect(isCryptoAddr("ETH", undefined)).resolves.toBe(false);
  });

  test("an unknown chain is refused rather than throwing out of the middleware", async () => {
    // WAValidator throws on a currency it does not know; the catch turns that
    // into a refusal, which is the only safe direction for a withdrawal.
    await expect(isCryptoAddr("NOTACOIN", GOOD_ETH)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// coinWithdrawValid
// ---------------------------------------------------------------------------
describe("coinWithdrawValid", () => {
  const good = (over = {}) => ({
    currencyId: objectId(),
    coin: "ETH",
    receiverAddress: GOOD_ETH,
    amount: "1.5",
    twoFACode: "123456",
    ...over,
  });

  test("accepts a complete, well-formed withdrawal", async () => {
    const out = await run(coinWithdrawValid, good());
    expect(out.passed).toBe(true);
  });

  test("refuses a missing currencyId", async () => {
    const out = await run(coinWithdrawValid, good({ currencyId: "" }));
    expect(out.status).toBe(400);
    expect(out.errors.currencyId).toBe("REQUIRED");
  });

  test("refuses a currencyId that is not a mongo id", async () => {
    const out = await run(coinWithdrawValid, good({ currencyId: "12345" }));
    expect(out.status).toBe(400);
    expect(out.errors.currencyId).toBe("Invalid currency id");
  });

  test("refuses a missing destination address", async () => {
    const out = await run(coinWithdrawValid, good({ receiverAddress: "" }));
    expect(out.status).toBe(400);
    expect(out.errors.receiverAddress).toBe("REQUIRED");
  });

  test("refuses an address that does not belong to the chain being withdrawn", async () => {
    const out = await run(
      coinWithdrawValid,
      good({ coin: "BTC", receiverAddress: GOOD_ETH })
    );
    expect(out.status).toBe(400);
    expect(out.errors.receiverAddress).toBe("Invalid Address");
    expect(out.next).not.toHaveBeenCalled();
  });

  test("XRP additionally requires a destination tag", async () => {
    // An XRP withdrawal with no tag lands in an exchange's omnibus account and
    // is unattributable.
    const withoutTag = await run(
      coinWithdrawValid,
      good({ coin: "XRP", receiverAddress: "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn" })
    );
    expect(withoutTag.status).toBe(400);
    expect(withoutTag.errors.destTag).toBe("REQUIRED");

    const withTag = await run(
      coinWithdrawValid,
      good({
        coin: "XRP",
        receiverAddress: "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn",
        destTag: "12345",
      })
    );
    expect(withTag.passed).toBe(true);
  });

  test("non-XRP coins do not require a destination tag", async () => {
    const out = await run(coinWithdrawValid, good({ destTag: "" }));
    expect(out.passed).toBe(true);
  });

  test("refuses a missing, non-numeric or negative amount", async () => {
    const missing = await run(coinWithdrawValid, good({ amount: "" }));
    expect(missing.errors.amount).toBe("REQUIRED");

    const text = await run(coinWithdrawValid, good({ amount: "lots" }));
    expect(text.errors.amount).toBe("ALLOW_NUMERIC");

    const negative = await run(coinWithdrawValid, good({ amount: -1 }));
    expect(negative.errors.amount).toBe("INVALID_AMOUNT");
  });

  test("refuses a missing or malformed 2FA code", async () => {
    const missing = await run(coinWithdrawValid, good({ twoFACode: "" }));
    expect(missing.errors.twoFACode).toBe("REQUIRED");

    const nonNumeric = await run(coinWithdrawValid, good({ twoFACode: "abcdef" }));
    expect(nonNumeric.errors.twoFACode).toBe("INVALID_CODE");

    const tooLong = await run(coinWithdrawValid, good({ twoFACode: "1234567" }));
    expect(tooLong.errors.twoFACode).toBe("INVALID_CODE");
  });

  test("reports EVERY problem at once, not just the first", async () => {
    // A form that has to be fixed one field per round trip is the reason users
    // give up on a withdrawal.
    const out = await run(
      coinWithdrawValid,
      good({ currencyId: "", receiverAddress: "", amount: "", twoFACode: "" })
    );
    expect(Object.keys(out.errors).sort()).toEqual(
      ["amount", "currencyId", "receiverAddress", "twoFACode"].sort()
    );
  });

  test("a refusal never calls next", async () => {
    const out = await run(coinWithdrawValid, good({ amount: -5 }));
    expect(out.next).not.toHaveBeenCalled();
    expect(out.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// fiatWithdrawValidate
// ---------------------------------------------------------------------------
describe("fiatWithdrawValidate", () => {
  const good = (over = {}) => ({
    currencyId: objectId(),
    bankId: objectId(),
    amount: "500",
    ...over,
  });

  test("accepts a complete request", async () => {
    expect((await run(fiatWithdrawValidate, good())).passed).toBe(true);
  });

  test("requires a currency and a bank account, both as mongo ids", async () => {
    expect((await run(fiatWithdrawValidate, good({ currencyId: "" }))).errors.currencyId).toBe(
      "REQUIRED"
    );
    expect(
      (await run(fiatWithdrawValidate, good({ currencyId: "nope" }))).errors.currencyId
    ).toBe("Invalid currency id");
    expect((await run(fiatWithdrawValidate, good({ bankId: "" }))).errors.bankId).toBe(
      "REQUIRED"
    );
    expect(
      (await run(fiatWithdrawValidate, good({ bankId: "nope" }))).errors.bankId
    ).toBe("INVALID_BANK_ACCOUNT");
  });

  test("requires a numeric amount", async () => {
    expect((await run(fiatWithdrawValidate, good({ amount: "" }))).errors.amount).toBe(
      "REQUIRED"
    );
    expect((await run(fiatWithdrawValidate, good({ amount: "abc" }))).errors.amount).toBe(
      "ALLOW_NUMERIC"
    );
  });

  test("refuses with 400 and does not continue", async () => {
    const out = await run(fiatWithdrawValidate, good({ amount: "" }));
    expect(out.status).toBe(400);
    expect(out.next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// depositReqtValid
// ---------------------------------------------------------------------------
describe("depositReqtValid", () => {
  const good = (over = {}) => ({ userAssetId: objectId(), amount: "250", ...over });

  test("accepts a complete deposit request", async () => {
    expect((await run(depositReqtValid, good())).passed).toBe(true);
  });

  test("requires a valid userAssetId", async () => {
    expect((await run(depositReqtValid, good({ userAssetId: "" }))).errors.userAssetId).toBe(
      "User Asset field is required"
    );
    expect(
      (await run(depositReqtValid, good({ userAssetId: "abc" }))).errors.userAssetId
    ).toBe("Invalid userAssetId");
  });

  test("requires a numeric amount", async () => {
    expect((await run(depositReqtValid, good({ amount: "" }))).errors.amount).toBeDefined();
    expect((await run(depositReqtValid, good({ amount: "abc" }))).errors.amount).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// tokenValid - the gate on every encrypted-payload route.
// ---------------------------------------------------------------------------
describe("tokenValid", () => {
  test("passes a request that carries a token", async () => {
    expect((await run(tokenValid, { token: "cipher-text" })).passed).toBe(true);
  });

  test("refuses a missing or blank token with the message in `message`, not `errors`", async () => {
    // This one answers a different shape from its neighbours; a client reading
    // `errors` here would show nothing at all.
    for (const body of [{}, { token: "" }, { token: "   " }, { token: null }]) {
      const out = await run(tokenValid, body);
      expect(out.status).toBe(400);
      expect(out.message).toBe("REQUIRED");
      expect(out.next).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// The admin-side gates.
// ---------------------------------------------------------------------------
describe("fiatDepositApproveValid", () => {
  test("accepts a valid transaction id and amount", async () => {
    const out = await run(fiatDepositApproveValid, {
      transactionId: objectId(),
      amount: "100",
    });
    expect(out.passed).toBe(true);
  });

  test("refuses a transaction id that is not a mongo id", async () => {
    const out = await run(fiatDepositApproveValid, {
      transactionId: "nope",
      amount: "100",
    });
    expect(out.errors.transactionId).toBe("Invalid transactionId");
  });

  test("refuses a non-numeric amount", async () => {
    const out = await run(fiatDepositApproveValid, {
      transactionId: objectId(),
      amount: "some",
    });
    expect(out.errors.amount).toBeDefined();
  });
});

describe("fiatDepositRejectValid", () => {
  test("accepts a valid id plus a reason", async () => {
    const out = await run(fiatDepositRejectValid, {
      decryptData: objectId(),
      reason: "documents unreadable",
    });
    expect(out.passed).toBe(true);
  });

  test("a rejection without a reason is refused", async () => {
    // The reason is what the user is told; a blank one makes the rejection
    // unappealable.
    const out = await run(fiatDepositRejectValid, { decryptData: objectId() });
    expect(out.status).toBe(400);
    expect(out.errors.reason).toBe("Reason required");
  });

  test("a malformed id is refused", async () => {
    const out = await run(fiatDepositRejectValid, {
      decryptData: "nope",
      reason: "x",
    });
    expect(out.errors.decryptData).toBe("Invalid transactionId");
  });
});

describe("rejectcoinWithdraw / rejectFiatWithdraw", () => {
  test.each([
    ["rejectcoinWithdraw", rejectcoinWithdraw],
    ["rejectFiatWithdraw", rejectFiatWithdraw],
  ])("%s requires a reason", async (_name, middleware) => {
    expect((await run(middleware, { reason: "insufficient KYC" })).passed).toBe(true);

    const refused = await run(middleware, {});
    expect(refused.status).toBe(400);
    expect(refused.errors.reason).toBe("Required");
  });
});

// ---------------------------------------------------------------------------
// updateGasStationConfig - the one yup-schema gate in this module.
// ---------------------------------------------------------------------------
describe("updateGasStationConfig", () => {
  const good = (over = {}) => ({
    gasThreshold: 1,
    gasCap: 5,
    maxGasPrice: 100,
    ...over,
  });

  test("accepts three positive numbers", async () => {
    expect((await run(updateGasStationConfig, good())).passed).toBe(true);
  });

  test("refuses zero and negative values on every field", async () => {
    for (const field of ["gasThreshold", "gasCap", "maxGasPrice"]) {
      const zero = await run(updateGasStationConfig, good({ [field]: 0 }));
      expect(zero.status).toBe(400);
      expect(zero.errors[field]).toBe("Should be higher than 0");

      const negative = await run(updateGasStationConfig, good({ [field]: -1 }));
      expect(negative.errors[field]).toBe("Should be higher than 0");
    }
  });

  test("refuses a missing field", async () => {
    const out = await run(updateGasStationConfig, {
      gasCap: 5,
      maxGasPrice: 100,
    });
    expect(out.status).toBe(400);
    expect(out.errors.gasThreshold).toBeDefined();
  });

  test("collects all failures rather than stopping at the first", async () => {
    const out = await run(updateGasStationConfig, {
      gasThreshold: 0,
      gasCap: -1,
      maxGasPrice: 0,
    });
    expect(Object.keys(out.errors).sort()).toEqual([
      "gasCap",
      "gasThreshold",
      "maxGasPrice",
    ]);
  });

  test("answers success:false alongside the errors", async () => {
    const req = { body: { gasThreshold: 0, gasCap: 5, maxGasPrice: 1 } };
    const res = recorder();
    await updateGasStationConfig(req, res, jest.fn());
    expect(res.payload.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A property every validator in this module has to share.
// ---------------------------------------------------------------------------
describe("validator contract", () => {
  const cases = [
    ["coinWithdrawValid", coinWithdrawValid, {}],
    ["fiatWithdrawValidate", fiatWithdrawValidate, {}],
    ["depositReqtValid", depositReqtValid, {}],
    ["tokenValid", tokenValid, {}],
    ["fiatDepositApproveValid", fiatDepositApproveValid, {}],
    ["fiatDepositRejectValid", fiatDepositRejectValid, {}],
    ["rejectcoinWithdraw", rejectcoinWithdraw, {}],
    ["rejectFiatWithdraw", rejectFiatWithdraw, {}],
    ["updateGasStationConfig", updateGasStationConfig, {}],
  ];

  test.each(cases)(
    "%s refuses an empty body with a 400 and never calls next",
    async (_name, middleware, body) => {
      const out = await run(middleware, body);
      expect(out.status).toBe(400);
      expect(out.next).not.toHaveBeenCalled();
    }
  );

  test.each(cases)("%s never both refuses and continues", async (_name, middleware, body) => {
    const out = await run(middleware, body);
    const refused = out.status !== null;
    const continued = out.next.mock.calls.length > 0;
    expect(refused && continued).toBe(false);
  });
});
