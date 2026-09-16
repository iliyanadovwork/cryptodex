/**
 * WITHDRAWAL IS CLOSED ON THIS VENUE — walletapi half
 * ==================================================
 *
 * The argument is in controllers/wallet.controller.js under WITHDRAWALS_CLOSED,
 * and in spotapi controllers/withdrawal.controller.js. In short: this venue
 * holds no custody, so completing a withdrawal can only delete a user's demo
 * balance and hand back a receipt for a transfer nobody made.
 *
 * WHAT WAS MEASURED ON THE RUNNING STACK, own throwaway, 2FA enabled:
 *
 *   POST /api/wallet/coinWithdraw {amount: 100, USDC}
 *     -> 400 {"errors":{"amount":"Maximum withdraw amount 0"}}
 *   POST /api/wallet/coinWithdraw {amount: 0,   USDC}
 *     -> 200 {"success":true,"message":"Withdraw successful"}
 *        + a coin_withdraw Transaction with txid paper-1786182098501 and the
 *          caller's address, status completed, and a "Withdraw_notification"
 *          email.
 *
 * That 400 was never a guard: `maximumWithdraw` is `Number, default: 0` in
 * models/currency.js and no currency document on this venue sets it, so mongoose
 * hands every read a 0. An admin editing one currency row re-opens an uncapped
 * debit. These tests pin the CODE answer, so the data cannot decide it.
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import fs from "fs";
import path from "path";

// `wallet.controller.js` builds gRPC clients at module load, so the only way to
// exercise a handler in a unit test is to stand those clients down.
// Everything mocked here is I/O the refusal must never reach; if a refusal
// starts reaching one, the mock records it and the second test below fails.
jest.mock("../../grpc/userService.js", () => ({
  __esModule: true,
  bankDetail: jest.fn(),
  fetchUser: jest.fn(),
  sendMail: jest.fn(),
}));
jest.mock("../../controllers/passbook.controller.js", () => ({
  __esModule: true,
  createPassBook: jest.fn(),
}));
jest.mock("../../controllers/priceCNV.controller.js", () => ({
  __esModule: true,
  priceConversionGrpc: jest.fn(),
}));

const CONTROLLERS = path.join(process.cwd(), "controllers");
const ROUTES = path.join(process.cwd(), "routes");

/** Source with comments removed - these files talk ABOUT the old behaviour. */
const codeOf = (file) =>
  fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const controllerSource = () =>
  fs.readFileSync(path.join(CONTROLLERS, "wallet.controller.js"), "utf8");

/**
 * The body of one exported handler, comments stripped: from its `export const`
 * to the next top-level `export const`.
 */
const handlerBody = (name) => {
  const code = codeOf(path.join(CONTROLLERS, "wallet.controller.js"));
  const start = code.indexOf(`export const ${name} = `);
  expect(start).toBeGreaterThan(-1);
  const rest = code.slice(start + 1);
  const nextIdx = rest.indexOf("\nexport const ");
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
};

const CLOSED_HANDLERS = [
  "withdrawCoinRequest",
  "withdrawCoinRequestApp",
  "withdrawFiatRequest",
];

describe("the three walletapi withdrawal handlers refuse", () => {
  test.each(CLOSED_HANDLERS)(
    "%s answers 410 WITHDRAWALS_CLOSED for any input",
    async (name) => {
      const mod = await import("../../controllers/wallet.controller.js");
      const handler = mod[name];
      expect(typeof handler).toBe("function");

      // Every input shape that used to reach a different answer.
      const bodies = [
        { currencyId: "695bc8cd25bf5f8d3d11f2e4", coin: "USDC", amount: 0 },
        { currencyId: "695bc8cd25bf5f8d3d11f2e4", coin: "USDC", amount: 10000 },
        { amount: -5 },
        {},
      ];

      for (const body of bodies) {
        const res = {
          status: jest.fn(() => res),
          json: jest.fn(() => res),
        };
        await handler({ user: { id: "6a76f8ac4fa86c3c083e27e9" }, body }, res);

        expect(res.status).toHaveBeenCalledWith(410);
        const payload = res.json.mock.calls[0][0];
        expect(payload.success).toBe(false);
        expect(payload.code).toBe("WITHDRAWALS_CLOSED");
        // A refusal that reads like a payout is the thing being prevented.
        expect(payload).not.toHaveProperty("txid");
        expect(payload).not.toHaveProperty("result");
        expect(String(payload.message)).not.toMatch(/successful/i);
      }
    }
  );

  test.each(CLOSED_HANDLERS)(
    "%s cannot write a ledger, a row, or an email - there is no code path to one",
    (name) => {
      const body = handlerBody(name);
      // The whole handler is the refusal. Anything else in it is a branch, and
      // a branch is where the debit comes back.
      for (const forbidden of [
        "spotDelta",
        "ledgerDebit",
        "hincbyfloat",
        "hset",
        "Transaction",
        "createPassBook",
        "sendMail",
        "fetchUser",
        "verifyToken",
        "precentConvetPrice",
      ]) {
        expect({ handler: name, forbidden, present: body.includes(forbidden) }).toEqual(
          { handler: name, forbidden, present: false }
        );
      }
      expect(body).toContain("refuseWithdrawal(res)");
    }
  );

  test("the walletapi withdrawal routes are gone, not merely refusing", () => {
    // This test used to assert the 410 handler was mounted AHEAD of validation
    // on /coinWithdraw, /coinWithdraw-app and /fiatWithdraw, so that a
    // well-formed request and a malformed one got the same answer instead of
    // "Invalid Address" versus "withdrawals are closed".
    //
    // The routes are now deleted outright, along with /fiatDeposit,
    // /createAddress, /userDeposit, /getWithdrawLimit, /fireblocksWebhook and
    // the operator approve/reject workflow in routes/admin.route.js. Ordering a
    // refusal correctly is moot once there is nothing to refuse, and absence
    // is the stronger guarantee: no chain to regress, no validator to reach.
    //
    // spotapi's POST /api/spot/requestWithdrawal keeps its 410 - it is the one
    // withdrawal surface a client might still call - and the tests for that
    // half live in spotapi.
    const route = codeOf(path.join(ROUTES, "wallet.route.js"));
    for (const routePath of [
      "/coinWithdraw",
      "/coinWithdraw-app",
      "/fiatWithdraw",
      "/fiatDeposit",
      "/createAddress",
      "/userDeposit",
      "/getWithdrawLimit",
      "/fireblocksWebhook",
    ]) {
      expect({ routePath, present: route.includes(`.route("${routePath}")`) })
        .toEqual({ routePath, present: false });
    }
    expect(fs.existsSync(path.join(ROUTES, "admin.route.js"))).toBe(false);
  });

  test("the refusal sentence is one string, stated once", () => {
    // Three handlers wording the same fact three ways is how a surface starts
    // telling two stories.
    const src = controllerSource();
    expect(src).toMatch(/export const WITHDRAWALS_CLOSED = \{/);
    expect(src).toMatch(/code: "WITHDRAWALS_CLOSED"/);
    const refusals = src.match(/refuseWithdrawal\(res\)/g) || [];
    expect(refusals).toHaveLength(3);
  });

  test("the currency defaults that made this look dormant are recorded, not relied on", () => {
    // If someone deletes the note, the next reader re-derives "it is capped at
    // 0 so it is safe" from the data and re-opens it by editing the data.
    const currency = fs.readFileSync(
      path.join(process.cwd(), "models", "currency.js"),
      "utf8"
    );
    // The defaults are still what the note says they are.
    expect(currency).toMatch(/maximumWithdraw:\s*\{\s*type:\s*Number,\s*default:\s*0/);
    expect(currency).toMatch(/withdrawFee:\s*\{\s*type:\s*Number,[\s\S]{0,40}default:\s*0/);

    const src = controllerSource();
    expect(src).toContain("Maximum withdraw amount 0");
    expect(src).toMatch(/data accident, not a decision/);
  });
});
