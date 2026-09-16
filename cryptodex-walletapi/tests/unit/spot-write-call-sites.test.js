/**
 * NO SPOT WRITE MAY BYPASS THE MIRROR
 *
 * lib/spotMirror.js only helps where it is called. The defect it fixes is one
 * of OMISSION - a call site that moves `walletbalance_spot` and forgets the two
 * mirrors addressed by the flat `assets` document id - so the guard has to be
 * over the call sites themselves, not over the helper.
 *
 * This reads the controllers as source and asserts that every write to the spot
 * ledger goes through `spotDelta` / `mirrorSpot` / `applySpotDelta`. A new
 * `hincbyfloat("walletbalance_spot", ...)` anywhere in walletapi fails here.
 */

import { describe, test, expect } from "@jest/globals";
import fs from "fs";
import path from "path";

const CONTROLLERS = path.join(process.cwd(), "controllers");

const sourceFiles = () =>
  fs
    .readdirSync(CONTROLLERS)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({
      name,
      body: fs.readFileSync(path.join(CONTROLLERS, name), "utf8"),
    }));

/**
 * Every statement that writes the spot ledger, with the redis primitive named.
 * Comments are stripped first: this file and the controllers both talk ABOUT
 * the old calls, and a sentence describing a defect is not the defect.
 */
const spotWrites = (body) => {
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const found = [];
  const pattern = /(hincbyfloat|hincby|hset|hdel)\s*\(\s*\n?\s*"walletbalance_spot"/g;
  let match;
  while ((match = pattern.exec(code)) !== null) found.push(match[1]);
  return found;
};

describe("spot ledger writers", () => {
  test("the controllers directory is where it is expected to be", () => {
    expect(fs.existsSync(CONTROLLERS)).toBe(true);
    expect(sourceFiles().length).toBeGreaterThan(5);
  });

  test("no controller increments the spot ledger directly", () => {
    const offenders = [];
    for (const { name, body } of sourceFiles()) {
      // redisWalletBackUp is the RECONCILER: correcting the mirror is its job,
      // and it writes only the mirror field, never the engine field.
      if (name === "redisWalletBackUp.js") continue;
      const writes = spotWrites(body).filter((fn) => fn !== "hset");
      if (writes.length) offenders.push(`${name}: ${writes.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  test("wallet.controller reaches the spot ledger only through spotDelta / the ledger helpers", () => {
    const body = fs.readFileSync(
      path.join(CONTROLLERS, "wallet.controller.js"),
      "utf8"
    );
    // THERE IS NO LONGER ANY ABSOLUTE WRITE OF THE SPOT LEDGER IN THIS FILE.
    //
    // One used to remain by design - `updateAsset`, the admin credit/debit -
    // and it was allowed on the grounds that it was followed by `mirrorSpot`.
    // Mirroring was never the problem. The problem was the ABSOLUTE part: the
    // value HSET was computed from an `hget` taken four awaits earlier, so a
    // fill (or a second admin adjustment) landing in between was overwritten.
    // It now goes through `ledgerCredit` / `ledgerDebit`, which decide and
    // apply in one redis command, so the `mirrorSpot`-only helper has no caller
    // and has been removed with it.
    expect(spotWrites(body)).toEqual([]);
    expect(body).toMatch(/const spotDelta = /);
    expect(body).not.toMatch(/const mirrorSpot = /);
    expect(body).toMatch(/applySpotDelta/);
  });

  /**
   * HYDRATION IS HSETNX, NEVER `hget` -> `if (!value)` -> `hset`.
   *
   * `updatewalletfromdb` seeded three ledgers with a check-then-act across two
   * awaits, in a process that serves many requests at once and beside four
   * other services writing the same hashes. The guard is not the write:
   *
   *   field absent; this reads null
   *   a settlement of 100 lands and CREATES the field at 100
   *   this HSETs the balance back to 0, from a mongo document up to ten
   *     seconds stale (controllers/redisWalletBackUp.js)
   *   -> 100 destroyed
   *
   * HSETNX makes redis decide "is this field absent" in the same command that
   * writes it, so a row that exists is left alone whatever raced it. Same
   * treatment getWallet and controllers/wallet.js#updateUserWallet already got.
   */
  test("updatewalletfromdb hydrates through HSETNX, not read-then-write", () => {
    const body = fs.readFileSync(
      path.join(CONTROLLERS, "wallet.controller.js"),
      "utf8"
    );
    const start = body.indexOf("const updatewalletfromdb");
    expect(start).toBeGreaterThan(-1);
    const fn = body.slice(start, body.indexOf("export const checkUserKyc"));
    const code = fn
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // ONE ledger, one seed, and no absolute write of it. `walletbalance_spot`
    // is the only ledger this service hydrates.
    expect((code.match(/await seedLedgerField\(/g) || [])).toHaveLength(1);
    expect(code).not.toMatch(/walletbalance_p2p/);
    expect(code).not.toMatch(/\bhset\s*\(/);
    expect(code).not.toMatch(/if\s*\(!\w*Bal\)/);
  });

  /**
   * THE ADMIN ADJUST IS GONE ENTIRELY, WHICH IS STRONGER THAN ATOMIC.
   *
   * `PUT /api/admin/updateUserAsset` let an admin credit or debit any user's
   * spot balance. This test used to pin the hard-won property that it did so
   * through `ledgerCredit`/`ledgerDebit` - one redis command deciding and
   * applying together - rather than the read-modify-write it started as, which
   * erased any fill that settled mid-request.
   *
   * The endpoint went with the admin surface, and `updateAsset` with it. A
   * writer that does not exist cannot regress into a non-atomic one, so what is
   * asserted now is simply that it stays gone: nothing in this service may
   * write a user's spot balance to an absolute figure from an admin request.
   */
  test("the admin balance adjust is gone, not merely made atomic", () => {
    const body = fs.readFileSync(
      path.join(CONTROLLERS, "wallet.controller.js"),
      "utf8"
    );
    // LIVE CODE ONLY. This file carries commented-out legacy copies of several
    // of these handlers (`// export const updateAsset = ...`), and a substring
    // check over the raw source matches the corpse as readily as the handler.
    const live = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(live).not.toMatch(/export const updateAsset\b/);
    expect(live).not.toMatch(/export const adminAssetInfo\b/);
    expect(live).not.toMatch(/export const getUserAsset\b/);

    // And there is no router left to offer a way in: routes/admin.route.js is
    // deleted and server.js mounts nothing at /api/admin.
    expect(
      fs.existsSync(path.join(CONTROLLERS, "..", "routes", "admin.route.js"))
    ).toBe(false);
    const server = fs.readFileSync(
      path.join(CONTROLLERS, "..", "server.js"),
      "utf8"
    );
    expect(server).not.toMatch(/admin\.route/);
  });

  /**
   * WALLET TRANSFER MOVES NOTHING, BECAUSE IT REFUSES.
   *
   * This used to assert that `walletTransfer`'s two ledger legs each named a
   * COIN, because a spot movement that does not name one silently no-ops the
   * flat-`assets` mirror (`mirrorSpotBalance` returns
   * `{mirrored:false, reason:"no-account"}` and moves nothing), so the balance
   * shown by the deposit screens drifts from the engine field with no error
   * anywhere.
   *
   * There are no legs left to check. `spot` is the only pot this venue has, so
   * there is no surviving (from, to) pair - the endpoint answers 410 and
   * touches nothing (see WALLET_TRANSFER_CLOSED, and
   * tests/unit/wallet-transfer-closed.test.js for the behavioural half).
   *
   * What is pinned here is the SOURCE-LEVEL version of "it moves nothing": the
   * handler must contain no ledger call at all. That is the assertion which
   * would fail if someone re-opened the transfer without re-establishing the
   * coin discipline the old test protected.
   */
  test("walletTransfer contains no ledger movement at all", () => {
    const body = fs.readFileSync(
      path.join(CONTROLLERS, "wallet.controller.js"),
      "utf8"
    );
    const start = body.indexOf("export const walletTransfer");
    expect(start).toBeGreaterThan(-1);
    const end = body.indexOf("export const", start + 10);
    expect(end).toBeGreaterThan(start);
    const transfer = body
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(transfer.match(/await ledger(Debit|Credit)\(/g) || []).toHaveLength(0);
    expect(transfer).not.toMatch(/\bhincbyfloat\s*\(/);
    expect(transfer).not.toMatch(/\bhset\s*\(/);
    expect(transfer).not.toMatch(/createPassBook\s*\(/);
    // ...and it answers the documented refusal.
    expect(transfer).toMatch(/status\(410\)/);
  });

  test("the spot path writes the engine field and nothing else", () => {
    const body = fs.readFileSync(
      path.join(process.cwd(), "lib", "walletLedger.js"),
      "utf8"
    );
    // Spot writes still funnel through the one named operation...
    expect(body).toMatch(/applySpotDelta\(\{/);
    // ...but there is no second or third copy of the balance to bring into
    // step any more. The flat `assets` ledger and its redis mirror held USDC
    // alone and went with it, so a mirror call here would be writing to
    // something that does not exist.
    expect(body).not.toMatch(/mirrorSpotBalance/);
  });

  test("the withdraw-reject refund addresses the currency, not the asset doc", () => {
    const body = fs.readFileSync(
      path.join(CONTROLLERS, "wallet.controller.js"),
      "utf8"
    );
    const start = body.indexOf("export const coinWithdrawReject");
    const reject = body.slice(start, start + 3000);
    expect(start).toBeGreaterThan(-1);
    // The refund used to credit `<userId>_<assetId>` while the debit came out
    // of `<userId>_<currencyId>`: for a coin whose asset row has its own id
    // those are different fields, so the money never came back.
    expect(reject).toContain("currencyId: trxData.currencyId.toString()");
    expect(reject).not.toMatch(/trxData\.assetId\.toString\(\),\s*\n\s*trxData\.amount/);
  });

  // -- THE CONDITIONAL DEBIT ------------------------------------------------
  // These three assertions pin the conditional debit that gates every spot
  // movement: it must stay ONE atomic Lua eval, never an hget + hincrbyfloat
  // pair, and it must return null rather than throw when the script fails.

  /** Source with comments removed - these files talk ABOUT the old calls. */
  const liveSource = (file) =>
    fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  test("the ledger module's only debit is the conditional one", () => {
    // `debitFree` must reach redis through the CAS and nothing else. A plain
    // `hincbyfloat` with a negative amount would compose atomically and still
    // be ungated - which is precisely the bug, spelled more carefully.
    const code = liveSource(
      path.join(process.cwd(), "lib", "walletLedger.js")
    );
    expect(code).toMatch(/hdecrbyfloatIfFree\s*\(/);
    const negativeIncrements = code.match(/hincbyfloat\s*\([^)]*-\s*am(oun)?t/g) || [];
    expect(negativeIncrements).toEqual([]);
  });

  test("the CAS primitive exists in the redis controller and refuses on failure", () => {
    const code = liveSource(path.join(CONTROLLERS, "redis.controller.js"));
    expect(code).toMatch(/export const hdecrbyfloatIfFree/);
    // The test and the decrement must be ONE eval, not a read followed by a
    // write. If this ever becomes an hget + hincbyfloat pair the gate is gone.
    expect(code).toMatch(/redisClient\.eval\(\s*DEBIT_IF_FREE_LUA/);
    expect(code).toMatch(/HINCRBYFLOAT/);
    // A redis failure must answer null (refuse), never a value.
    expect(code).toMatch(/catch[\s\S]{0,200}HDECRBYFLOATIFFREE ERROR[\s\S]{0,80}return null/);
  });

  test("wallet.controller reaches the wallet only through the ledger module", () => {
    const body = fs.readFileSync(
      path.join(CONTROLLERS, "wallet.controller.js"),
      "utf8"
    );
    expect(body).toMatch(/from\s+["']\.\.\/lib\/walletLedger\.js["']/);
    expect(body).toMatch(/const ledgerDebit = /);
    expect(body).toMatch(/const ledgerCredit = /);
  });
});
