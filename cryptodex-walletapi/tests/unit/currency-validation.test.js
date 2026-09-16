/**
 * CURRENCY ADMIN VALIDATION - THE MIDDLEWARE THAT GUARDS THE CURRENCY TABLE
 * ========================================================================
 *
 * WHAT THIS REPLACES
 * ------------------
 * This file was headed "CRITICAL TESTS - These tests verify currency validation
 * logic" and imported nothing at all. Its 100-odd assertions were of the form
 *
 *     const symbol = 'BTC';
 *     const isValid = /^[A-Z]{2,10}$/.test(symbol);
 *     expect(isValid).toBe(true);
 *
 * - a regular expression written in the test, applied in the test, and asserted
 * in the test. That regex appears nowhere in walletapi. No currency validator,
 * no currency model, no currency controller was imported, so no change to any
 * of them could have turned the file red. It graded its own literals.
 *
 * WHAT IS TESTED NOW
 * ------------------
 * validation/currency.validation.js, the middleware chain the admin currency
 * routes actually mount:
 *
 *   cryptoValidation / tokenValidation / fiatValidation   the add gates
 *   editCryptoValidation / editFiatValidation             the update gates
 *   addValid / editValid                                  the dispatchers that
 *                                                         choose between them
 *
 * These decide what a currency row may contain, and a currency row decides how
 * every balance of that coin is priced, rounded, withdrawn and displayed. A
 * withdraw limit pair the wrong way round, or a negative fee, is a live
 * misconfiguration of the whole exchange for that coin.
 *
 * The `decimals` / `contractDecimal` resolution these fields feed is pinned
 * separately in tests/unit/currency-decimals.test.js, and the end-to-end answer
 * of GET /api/currency/getCurrency in
 * tests/integration/wallet-api.integration.test.js. Nothing is duplicated here.
 */

/* eslint-disable no-undef */

import { describe, test, expect, jest } from "@jest/globals";

import {
  cryptoValidation,
  tokenValidation,
  fiatValidation,
  editCryptoValidation,
  editFiatValidation,
  addValid,
  editValid,
} from "../../validation/currency.validation.js";

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

/**
 * Run a currency validator. `req.files` is always supplied because every one of
 * these reads `req.files.image` unguarded - a request without it is a 500, not
 * a 400, and that is a property of the middleware, not of the test.
 */
const run = async (middleware, body, files = { image: [{}] }) => {
  const req = { body: { ...body }, files };
  const res = recorder();
  const next = jest.fn();
  await middleware(req, res, next);
  return {
    res,
    next,
    passed: next.mock.calls.length === 1 && res.statusCode === null,
    status: res.statusCode,
    errors: (res.payload && res.payload.errors) || null,
  };
};

// The minimum a validator accepts, per currency type.
const cryptoBody = (over = {}) => ({
  name: "Bitcoin",
  coin: "BTC",
  symbol: "BTC",
  contractDecimal: "8",
  withdrawFee: "0.0005",
  minimumWithdraw: "0.001",
  maximumWithdraw: "10",
  minimumDeposit: "0.0001",
  ...over,
});

const tokenBody = (over = {}) => ({
  name: "Tether",
  coin: "USDT",
  symbol: "USDT",
  contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  decimals: "6",
  tokenType: "erc20",
  contractDecimal: "6",
  withdrawFee: "1",
  minimumWithdraw: "10",
  maximumWithdraw: "100000",
  minimumDeposit: "10",
  ...over,
});

const fiatBody = (over = {}) => ({
  name: "US Dollar",
  coin: "USD",
  symbol: "USD",
  ...over,
});

// ---------------------------------------------------------------------------
// cryptoValidation
// ---------------------------------------------------------------------------
describe("cryptoValidation - adding a crypto currency", () => {
  test("accepts a complete crypto row", async () => {
    expect((await run(cryptoValidation, cryptoBody())).passed).toBe(true);
  });

  test("requires a name, a coin and a symbol", async () => {
    expect((await run(cryptoValidation, cryptoBody({ name: "" }))).errors.name).toBe(
      "Name Field Is Required"
    );
    expect((await run(cryptoValidation, cryptoBody({ coin: "" }))).errors.coin).toBe(
      "Coin Field Is Required"
    );
    expect((await run(cryptoValidation, cryptoBody({ symbol: "" }))).errors.symbol).toBe(
      "Symbol Field Is Required"
    );
  });

  test("refuses a coin symbol containing punctuation", async () => {
    // The coin string is concatenated into redis field names and gateway
    // lookups; a separator character in it corrupts every key it appears in.
    for (const bad of ["BT-C", "BT C", "BT/C", "BT.C"]) {
      const out = await run(cryptoValidation, cryptoBody({ coin: bad }));
      expect(out.errors.coin).toBe("Coin Field must contain only Alphabets");
    }
  });

  test("allows spaces in the display NAME but not in the coin code", async () => {
    expect((await run(cryptoValidation, cryptoBody({ name: "Wrapped Bitcoin" }))).passed).toBe(
      true
    );
    expect(
      (await run(cryptoValidation, cryptoBody({ coin: "WRAPPED BTC" }))).errors.coin
    ).toBeDefined();
  });

  test("requires an image on an ADD", async () => {
    const out = await run(cryptoValidation, cryptoBody(), {});
    expect(out.errors.image).toBe("Image Field is Required");
  });

  test("refuses a missing, non-numeric or negative contract decimal", async () => {
    expect(
      (await run(cryptoValidation, cryptoBody({ contractDecimal: "" }))).errors
        .contractDecimal
    ).toBe("Enter Valid Contract Decimal");
    expect(
      (await run(cryptoValidation, cryptoBody({ contractDecimal: "eight" }))).errors
        .contractDecimal
    ).toBe("Only Allow Numeric");
    expect(
      (await run(cryptoValidation, cryptoBody({ contractDecimal: "-1" }))).errors
        .contractDecimal
    ).toBe("Enter Valid Contract Decimal");
  });

  test("a zero contract decimal is ACCEPTED on add - a whole-unit currency is legitimate", async () => {
    expect((await run(cryptoValidation, cryptoBody({ contractDecimal: "0" }))).passed).toBe(
      true
    );
  });

  test("refuses a negative withdraw fee", async () => {
    // A negative fee pays the user to withdraw.
    const out = await run(cryptoValidation, cryptoBody({ withdrawFee: "-0.1" }));
    expect(out.status).toBe(400);
    expect(out.errors.withdrawFee).toBeDefined();
  });

  test("a zero withdraw fee is accepted", async () => {
    expect((await run(cryptoValidation, cryptoBody({ withdrawFee: "0" }))).passed).toBe(true);
  });

  test("refuses a zero or missing withdraw limit on either end", async () => {
    expect(
      (await run(cryptoValidation, cryptoBody({ minimumWithdraw: "0" }))).errors
        .minimumWithdraw
    ).toBe("Enter Valid Minimum Withdraw");
    expect(
      (await run(cryptoValidation, cryptoBody({ maximumWithdraw: "0" }))).errors
        .maximumWithdraw
    ).toBe("Enter Valid Maximum Withdraw");
  });

  test("REFUSES A WITHDRAW WINDOW THAT IS EMPTY OR INVERTED", async () => {
    // min >= max means no amount at all is withdrawable - the coin is silently
    // frozen for every user, with nothing in the UI to say why.
    const inverted = await run(
      cryptoValidation,
      cryptoBody({ minimumWithdraw: "10", maximumWithdraw: "1" })
    );
    expect(inverted.status).toBe(400);
    expect(inverted.errors.minimumWithdraw).toBe(
      "Minimum withdraw not more than Maximum withdraw"
    );

    const equal = await run(
      cryptoValidation,
      cryptoBody({ minimumWithdraw: "5", maximumWithdraw: "5" })
    );
    expect(equal.errors.minimumWithdraw).toBe(
      "Minimum withdraw not more than Maximum withdraw"
    );
  });

  test("the comparison is NUMERIC, not lexical", async () => {
    // "9" > "10" as strings. A string comparison here would reject a perfectly
    // ordinary 9 -> 10 window and accept an inverted 100 -> 20 one.
    expect(
      (await run(cryptoValidation, cryptoBody({ minimumWithdraw: "9", maximumWithdraw: "10" })))
        .passed
    ).toBe(true);
    expect(
      (await run(
        cryptoValidation,
        cryptoBody({ minimumWithdraw: "100", maximumWithdraw: "20" })
      )).errors.minimumWithdraw
    ).toBeDefined();
  });

  test("refuses a zero or non-numeric minimum deposit", async () => {
    expect(
      (await run(cryptoValidation, cryptoBody({ minimumDeposit: "0" }))).errors.minimumDeposit
    ).toBe("Enter Valid Minimum Deposit");
    expect(
      (await run(cryptoValidation, cryptoBody({ minimumDeposit: "lots" }))).errors
        .minimumDeposit
    ).toBe("Only Allow Numeric");
  });

  test("reports every problem at once", async () => {
    const out = await run(cryptoValidation, {});
    expect(Object.keys(out.errors).length).toBeGreaterThanOrEqual(6);
    expect(out.next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// tokenValidation
// ---------------------------------------------------------------------------
describe("tokenValidation - adding a token", () => {
  test("accepts a complete token row", async () => {
    expect((await run(tokenValidation, tokenBody())).passed).toBe(true);
  });

  test("requires a contract address - a token without one cannot be credited", async () => {
    const out = await run(tokenValidation, tokenBody({ contractAddress: "" }));
    expect(out.errors.contractAddress).toBe("Contract Address Field Required");
  });

  test("requires the token's ON-CHAIN decimals and refuses zero", async () => {
    // `decimals` is the scale every on-chain amount of this token is converted
    // by; a zero would multiply every balance by 1 and mis-state it by orders
    // of magnitude.
    expect((await run(tokenValidation, tokenBody({ decimals: "" }))).errors.decimals).toBe(
      "Decimals Field Is Required"
    );
    expect((await run(tokenValidation, tokenBody({ decimals: "six" }))).errors.decimals).toBe(
      "Only Allow Numeric"
    );
    expect((await run(tokenValidation, tokenBody({ decimals: "0" }))).errors.decimals).toBe(
      "Invalid Value"
    );
    expect((await run(tokenValidation, tokenBody({ decimals: "-6" }))).errors.decimals).toBe(
      "Invalid Value"
    );
  });

  test("only the four networks this service can actually settle are accepted", async () => {
    for (const good of ["erc20", "bep20", "trc20", "poly20"]) {
      expect((await run(tokenValidation, tokenBody({ tokenType: good }))).passed).toBe(true);
    }
    for (const bad of ["ERC20", "solana", "spl", "erc721", "x"]) {
      const out = await run(tokenValidation, tokenBody({ tokenType: bad }));
      expect(out.errors.tokenType).toBe("Invalid Type");
    }
  });

  test("a missing token type is refused", async () => {
    expect((await run(tokenValidation, tokenBody({ tokenType: "" }))).errors.tokenType).toBe(
      "Token Type Field Required"
    );
  });

  test("the withdraw window rule applies to tokens too", async () => {
    const out = await run(
      tokenValidation,
      tokenBody({ minimumWithdraw: "1000", maximumWithdraw: "10" })
    );
    expect(out.errors.minimumWithdraw).toBe(
      "Minimum withdraw not more than Maximum withdraw"
    );
  });

  test("a token NAME may not contain digits, unlike a crypto name", async () => {
    // tokenValidation uses /^[a-zA-Z_\s]*$/ where cryptoValidation allows 0-9.
    // Pinned because the two look identical at a glance and are not.
    expect((await run(tokenValidation, tokenBody({ name: "Token 2" }))).errors.name).toBe(
      "Name Field must contain only Alphabets"
    );
    expect((await run(cryptoValidation, cryptoBody({ name: "Coin 2" }))).passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fiatValidation
// ---------------------------------------------------------------------------
describe("fiatValidation - adding a fiat currency", () => {
  test("accepts name, coin, symbol and an image", async () => {
    expect((await run(fiatValidation, fiatBody())).passed).toBe(true);
  });

  test("a fiat coin code is letters only - no digits", async () => {
    // /^[A-Za-z]+$/ here, unlike the crypto gate which allows digits and _.
    expect((await run(fiatValidation, fiatBody({ coin: "USD1" }))).errors.coin).toBe(
      "Coin Field must contain only Alphabets"
    );
    expect((await run(cryptoValidation, cryptoBody({ coin: "USD1" }))).passed).toBe(true);
  });

  test("requires an image", async () => {
    expect((await run(fiatValidation, fiatBody(), {})).errors.image).toBe("REQUIRED");
  });

  test("does NOT demand withdraw limits - those are commented out for fiat", async () => {
    // Pinning the current shape so a future reinstatement is a deliberate,
    // visible change rather than a silent one.
    const out = await run(fiatValidation, fiatBody());
    expect(out.passed).toBe(true);
    expect(out.errors).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The edit gates. These are NOT the add gates with a different name.
// ---------------------------------------------------------------------------
describe("editCryptoValidation - updating a crypto currency", () => {
  test("accepts a complete update", async () => {
    expect((await run(editCryptoValidation, cryptoBody())).passed).toBe(true);
  });

  test("an EXISTING image on the body satisfies the image requirement", async () => {
    // On an edit the client resubmits the stored filename rather than the file;
    // demanding an upload would force a re-upload on every rename.
    const out = await run(editCryptoValidation, cryptoBody({ image: "btc.png" }), {});
    expect(out.passed).toBe(true);
  });

  test("with neither a file nor a stored image it still refuses", async () => {
    const out = await run(editCryptoValidation, cryptoBody(), {});
    expect(out.errors.image).toBe("Image Field Is Required");
  });

  test("a zero contract decimal is REFUSED on edit though it is accepted on add", async () => {
    // The two gates genuinely differ (`|| reqBody.contractDecimal == 0`).
    // Pinned so the difference is a decision on record rather than a surprise.
    expect(
      (await run(editCryptoValidation, cryptoBody({ contractDecimal: "0" }))).errors
        .contractDecimal
    ).toBe("Enter Valid Contract Decimal");
    expect((await run(cryptoValidation, cryptoBody({ contractDecimal: "0" }))).passed).toBe(
      true
    );
  });

  test("an edit cannot invert the withdraw window either", async () => {
    const out = await run(
      editCryptoValidation,
      cryptoBody({ minimumWithdraw: "50", maximumWithdraw: "10" })
    );
    expect(out.errors.minimumWithdraw).toBe(
      "Minimum withdraw not more than Maximum withdraw"
    );
  });

  test("a zero withdraw fee is REFUSED on edit though accepted on add", async () => {
    expect(
      (await run(editCryptoValidation, cryptoBody({ withdrawFee: "0" }))).errors.withdrawFee
    ).toBe("Enter Valid Withdraw Fee");
  });
});

describe("editFiatValidation - updating a fiat currency", () => {
  const editFiatBody = (over = {}) => ({
    name: "US Dollar",
    coin: "USD",
    symbol: "USD",
    image: "usd.png",
    contractDecimal: "2",
    withdrawFee: "1",
    minimumWithdraw: "10",
    maximumWithdraw: "10000",
    minimumDeposit: "10",
    bankName: "Paperbank",
    accountNo: "123456789",
    holderName: "Cryptodex Paper",
    bankcode: "PPRB0001",
    country: "US",
    ...over,
  });

  test("accepts a complete fiat update", async () => {
    expect((await run(editFiatValidation, editFiatBody(), {})).passed).toBe(true);
  });

  test("demands the full bank payout detail a fiat withdrawal needs", async () => {
    // Unlike the ADD gate, the edit gate requires these - a fiat currency with
    // no destination bank cannot settle a withdrawal at all.
    for (const field of ["bankName", "accountNo", "holderName", "bankcode", "country"]) {
      const out = await run(editFiatValidation, editFiatBody({ [field]: "" }), {});
      expect(out.status).toBe(400);
      expect(out.errors[field]).toBeDefined();
    }
  });

  test("refuses an inverted withdraw window numerically", async () => {
    const out = await run(
      editFiatValidation,
      editFiatBody({ minimumWithdraw: "9000", maximumWithdraw: "100" }),
      {}
    );
    expect(out.errors.minimumWithdraw).toBe(
      "Minimum withdraw not more than Maximum withdraw"
    );
  });
});

// ---------------------------------------------------------------------------
// addValid / editValid - the dispatchers.
// ---------------------------------------------------------------------------
describe("addValid / editValid dispatch on currencyType", () => {
  test("addValid routes a crypto body through the crypto gate", async () => {
    // A token-shaped body declared as crypto must NOT be asked for a contract
    // address, and a crypto body missing crypto fields must be refused.
    const ok = await run(addValid, cryptoBody({ currencyType: "crypto" }));
    expect(ok.passed).toBe(true);

    const bad = await run(
      addValid,
      cryptoBody({ currencyType: "crypto", minimumWithdraw: "0" })
    );
    expect(bad.status).toBe(400);
    expect(bad.errors.minimumWithdraw).toBeDefined();
  });

  test("addValid routes a token body through the token gate", async () => {
    const bad = await run(
      addValid,
      tokenBody({ currencyType: "token", contractAddress: "" })
    );
    expect(bad.status).toBe(400);
    expect(bad.errors.contractAddress).toBe("Contract Address Field Required");
  });

  test("addValid routes a fiat body through the fiat gate", async () => {
    const ok = await run(addValid, fiatBody({ currencyType: "fiat" }));
    expect(ok.passed).toBe(true);
    // The fiat gate does not ask for withdraw limits, so a body with none passes.
    expect(ok.errors).toBeNull();
  });

  test("AN UNKNOWN currencyType MATCHES NO BRANCH - the request neither passes nor is refused", async () => {
    // A real defect in the dispatcher, pinned rather than hidden: `addValid` is
    // three independent `if`s with no `else`, so an unrecognised currencyType
    // (or a missing one) falls off the end without calling next() and without
    // answering. The request hangs until the client times out. This test is the
    // record of that behaviour; if a default branch is ever added, it goes red
    // and the change is deliberate.
    const out = await run(addValid, { currencyType: "commodity" });
    expect(out.next).not.toHaveBeenCalled();
    expect(out.status).toBeNull();

    const missing = await run(addValid, cryptoBody());
    expect(missing.next).not.toHaveBeenCalled();
    expect(missing.status).toBeNull();
  });

  test("editValid dispatches to the EDIT gates, not the add ones", async () => {
    // The tell: contractDecimal 0 passes the add gate and fails the edit gate.
    const out = await run(
      editValid,
      cryptoBody({ currencyType: "crypto", contractDecimal: "0" })
    );
    expect(out.status).toBe(400);
    expect(out.errors.contractDecimal).toBe("Enter Valid Contract Decimal");
  });

  test("editValid dispatches fiat to the fiat edit gate", async () => {
    const out = await run(editValid, { currencyType: "fiat", name: "US Dollar" }, {});
    expect(out.status).toBe(400);
    // The fiat EDIT gate asks for bank detail; the fiat ADD gate does not.
    expect(out.errors.bankName).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// A property every validator in this module shares.
// ---------------------------------------------------------------------------
describe("validator contract", () => {
  const gates = [
    ["cryptoValidation", cryptoValidation],
    ["tokenValidation", tokenValidation],
    ["fiatValidation", fiatValidation],
    ["editCryptoValidation", editCryptoValidation],
    ["editFiatValidation", editFiatValidation],
  ];

  test.each(gates)("%s refuses an empty body with 400 and never calls next", async (_n, gate) => {
    const out = await run(gate, {}, {});
    expect(out.status).toBe(400);
    expect(out.next).not.toHaveBeenCalled();
  });

  test.each(gates)("%s never both refuses and continues", async (_n, gate) => {
    const out = await run(gate, {}, {});
    expect(out.status !== null && out.next.mock.calls.length > 0).toBe(false);
  });

  test.each(gates)("%s answers its failures under an `errors` object", async (_n, gate) => {
    const out = await run(gate, {}, {});
    expect(out.res.payload).toHaveProperty("errors");
    expect(typeof out.res.payload.errors).toBe("object");
  });
});
