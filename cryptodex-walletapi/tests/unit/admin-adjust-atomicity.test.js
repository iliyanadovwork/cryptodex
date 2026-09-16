/**
 * THE ADMIN CREDIT/DEBIT IS GONE - AND NOTHING MAY TAKE ITS PLACE
 * ==============================================================
 *
 * WHAT THIS FILE USED TO DO. `PUT /api/admin/updateUserAsset` was the faucet's
 * admin twin: an operator handing a user demo money. It was allowed to exist on
 * a paper venue, but it was not allowed to be a read-modify-write, and it
 * started life as one:
 *
 *     const checkBal = await hget("walletbalance_spot", `${userId}_${currencyId}`);
 *     ...affordability compared in node against `checkBal`...
 *     asset[findex].spotBal = parseFloat(checkBal) +/- parseFloat(amount);
 *     await userWallet.save();                                        // await 2
 *     await hset("walletbalance_spot", field, asset[findex].spotBal);  // await 3
 *     await mirrorSpot({...});                                        // await 4
 *
 * The value finally stored was absolute and computed from a read three awaits
 * earlier, so any settlement that moved the same field in between was erased -
 * and the matcher settles `walletbalance_spot` with HINCRBYFLOAT knowing
 * nothing about this handler. The suite here drove a concurrent fill into that
 * window and asserted it survived, which is only possible if the handler
 * applies a DELTA decided inside redis (`ledgerCredit`/`ledgerDebit`).
 *
 * WHY IT IS NOW A REMOVAL GUARD. The endpoint went with the admin surface, and
 * `updateAsset` with it. A handler that does not exist cannot regress into a
 * non-atomic one, so the interleaving tests have nothing left to drive. What is
 * still worth pinning is the invariant they were protecting, stated over the
 * whole file rather than over one function: no admin-shaped path may write a
 * user's spot balance to an absolute figure.
 *
 * The positive half of that invariant - that every surviving spot writer goes
 * through the ledger module - is enforced by tests/unit/spot-write-call-sites.js,
 * which walks the same file.
 */

import { describe, test, expect } from "@jest/globals";
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "../..");
const WALLET_CONTROLLER = path.join(ROOT, "controllers/wallet.controller.js");
const ADMIN_ROUTE = path.join(ROOT, "routes/admin.route.js");

/**
 * Live code only. This controller keeps commented-out copies of old handlers
 * AND long block comments that quote the defective code verbatim - including
 * the `hset("walletbalance_spot", ...)` line the last test below searches for.
 * Both kinds of comment have to go or the assertions match the explanation.
 */
const liveCode = (file) =>
  fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

describe("the admin balance adjust is removed", () => {
  test("the handler is gone from wallet.controller.js", () => {
    const code = liveCode(WALLET_CONTROLLER);
    expect(code).not.toMatch(/export const updateAsset\b/);
  });

  test("there is no admin router left to mount it on", () => {
    // Stronger than the assertion this replaces. That one read
    // routes/admin.route.js and checked `updateUserAsset` was absent from it;
    // the whole file is now gone, along with the last of the custody
    // approve/reject workflow it held, so the handler has nowhere to be
    // mounted at all.
    expect(fs.existsSync(ADMIN_ROUTE)).toBe(false);
    const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    expect(server).not.toMatch(/admin\.route/);
  });

  test("no surviving handler writes walletbalance_spot to an absolute value", () => {
    const code = liveCode(WALLET_CONTROLLER);
    // `hset` against the spot ledger is the exact shape of the defect: it
    // stores a number computed in node instead of a delta applied by redis.
    const absoluteWrites = (code.match(/\bhset\s*\(\s*\n?\s*["']walletbalance_spot/g) || []);
    expect(absoluteWrites).toEqual([]);
  });

  test("the atomic ledger helpers are still declared for the paths that remain", () => {
    // Their last caller was updateAsset, but they are the audited API every
    // future value-moving path must use, and lib/walletLedger.js is written
    // around them. Losing them would quietly re-open the door this closed.
    const code = liveCode(WALLET_CONTROLLER);
    expect(code).toMatch(/const ledgerDebit = /);
    expect(code).toMatch(/const ledgerCredit = /);
  });
});
