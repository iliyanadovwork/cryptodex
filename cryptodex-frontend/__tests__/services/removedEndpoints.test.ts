/**
 * NO CLIENT FOR A ROUTE THAT NO LONGER EXISTS (CRITICAL)
 * =====================================================
 *
 * Four rounds of deletion removed endpoints from userapi, walletapi and
 * spotapi. The clients that called them mostly stayed, and a client for a
 * deleted route is not inert - it is one import away from a screen that renders
 * a spinner, or an empty table, over a request that can never succeed. Both
 * defects this file was written after were exactly that:
 *
 *   /verification/coinwithdraw and /verification/fiatWithdraw were LIVE URLS
 *   that PATCHed walletapi's wallet/coinWithdraw and wallet/fiatWithdraw, both
 *   deleted. A user following an old mail link fired a request at a 404 and was
 *   pushed to /wallet with a red toast.
 *
 *   components/Wallet/DepositHistory.tsx read spot/getDepositHistory, deleted -
 *   so the "Demo credit history" table on /faucet and the Demo Credits tab on
 *   /history printed "No Records Found" for accounts that had just claimed. The
 *   rows existed the whole time; only the way to read them had gone.
 *
 * These are SOURCE-LEVEL assertions on purpose. A render test cannot show that
 * a dead URL is absent from the bundle, and the failure mode here is a request
 * that is never made in a test because the component swallows its own error.
 *
 * Each path below was verified against the running stack before being listed:
 * every one of them answers 404, and the two that survive answer 200.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Every service module in the app, whatever it is called. */
const SERVICE_FILES = (function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(path.relative(ROOT, full));
  }
  return out;
})(path.join(ROOT, "services"));

/** Strip comments: this file's own prose names the dead routes it forbids. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every deleted endpoint, as it would be spelled in a client. */
const DELETED_ENDPOINTS = [
  // walletapi - the custody surface
  "wallet/coinWithdraw",
  "wallet/fiatWithdraw",
  "wallet/fiatDeposit",
  "wallet/userDeposit",
  "wallet/getWithdrawLimit",
  "wallet/transfer",
  "wallet/createAddress",
  "onramp/getCurrency",
  "onramp/checkNetwork",
  "onramp/createTransaction",
  // userapi - the mailed withdrawal confirmations
  "auth/coinWithdraw",
  "auth/fiatWithdraw",
  // spotapi - deposits in, withdrawals out
  "spot/getDepositInfo",
  "spot/getDepositWallet",
  "spot/getDepositHistory",
  "spot/requestWithdrawal",
  "spot/getWithdrawalStatus",
  "spot/getWithdrawalHistory",
];

describe("no service client names a deleted endpoint (CRITICAL)", () => {
  test.each(DELETED_ENDPOINTS)("%s has no client", (endpoint) => {
    const offenders = SERVICE_FILES.filter((f) => code(read(f)).includes(endpoint));
    expect(offenders).toEqual([]);
  });
});

describe("the demo-credit history reads a route that exists", () => {
  const wallet = code(read("services/Wallet/WalletService.ts"));

  test("it asks spotapi for the faucet's own history", () => {
    expect(wallet).toContain("/spot/faucet/history");
  });

  test("the component asks for it through that client and nothing else", () => {
    const component = code(read("components/Wallet/DepositHistory.tsx"));
    expect(component).toContain("getDemoCreditHistory");
    expect(component).not.toContain("getSolanaDepositHistory");
  });
});

describe("nothing in the app still reaches the withdrawal screens", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (["node_modules", ".next", "__tests__", "e2e"].includes(entry.name)) continue;
        walk(path.join(dir, entry.name), out);
      } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
    return out;
  };

  const FILES = ["components", "pages", "store", "services", "lib"].flatMap((d) =>
    walk(path.join(ROOT, d))
  );

  test("no page or component routes to /verification/coinwithdraw or /verification/fiatWithdraw", () => {
    const offenders = FILES.filter((f) => {
      const src = code(fs.readFileSync(f, "utf8"));
      return /["'`]coinwithdraw["'`]/i.test(src) || /["'`]fiatWithdraw["'`]/.test(src);
    }).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  test("the withdrawal-history component is gone, and nothing imports it", () => {
    expect(fs.existsSync(path.join(ROOT, "components/Wallet/WithdrawHistory.tsx"))).toBe(
      false
    );
    const offenders = FILES.filter((f) =>
      code(fs.readFileSync(f, "utf8")).includes("WithdrawHistory")
    ).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
