/**
 * THE "THE LEDGER MOVED" SIGNAL (CRITICAL)
 * ========================================
 *
 * REPORTED, and reproduced end to end in Chromium: on a trade page the order
 * ticket's own Transfer button opens the wallet-transfer modal; the transfer
 * succeeds server-side (walletapi answers 200) and the ticket goes on printing
 * "Free: 0.000 USDC". Reload, and the money is there. The mirror-image fault
 * was just as bad: after a transfer OUT the ticket still offered collateral
 * that had gone, sized a "100%" order from it, and the order was refused.
 *
 * The cause was one line: the modal dispatched `getAssetData()` and nothing
 * else, which writes ONLY `state.wallet.assets`. The tickets read their own
 * slice's `walletBal`, written by page mount and by ENGINE sockets - and
 * walletapi has no socket layer at all, so a transfer produces no event any
 * ticket is listening for.
 *
 * `refreshWalletBalances()` is the replacement, and this file pins its contract
 * because everything else in the fix hangs off it.
 *
 * Guards:
 *   S1  the signal starts at rest and only a mutation raises it;
 *   S2  refreshWalletBalances() BOTH re-reads the asset rows AND raises it;
 *   S3  a plain read does not raise it (or every read makes every mounted
 *       trade page re-read, forever);
 *   S4  consecutive mutations each raise it, so a second transfer is not
 *       swallowed by the first.
 */

// jest.setup.js replaces this module GLOBALLY with jest.fn() stubs so that the
// component suites do not hit the network. This file is about the real slice.
jest.unmock("@/store/Wallet/dataSlice");
jest.mock("@/store/Wallet/dataSlice", () =>
  jest.requireActual("@/store/Wallet/dataSlice")
);
jest.mock("@/services/Wallet/WalletService", () => ({
  apiGetAssetData: jest.fn(),
}));
jest.mock("@/services/Common/CommonService", () => ({
  apiGetCurrency: jest.fn(),
  apiGetPriceConversion: jest.fn(),
}));

import reducer, {
  walletBalancesChanged,
  refreshWalletBalances,
  getAssetData,
} from "@/store/Wallet/dataSlice";

describe("S1 the signal starts at rest", () => {
  it("a fresh wallet slice has revision 0", () => {
    const state: any = reducer(undefined, { type: "@@INIT" });
    expect(state.revision).toBe(0);
  });

  it("walletBalancesChanged raises it", () => {
    const state: any = reducer(undefined, walletBalancesChanged());
    expect(state.revision).toBe(1);
  });
});

describe("S2 refreshWalletBalances re-reads AND signals", () => {
  it("dispatches both halves", () => {
    const dispatch = jest.fn();
    refreshWalletBalances()(dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
    // The asset-row read the modal always did...
    const first = dispatch.mock.calls[0][0];
    expect(typeof first === "function" || typeof first === "object").toBe(true);
    // ...and the signal that was missing.
    expect(dispatch).toHaveBeenCalledWith(walletBalancesChanged());
  });

  it("the signal it dispatches actually raises the revision", () => {
    const dispatch = jest.fn();
    refreshWalletBalances()(dispatch);
    const signal = dispatch.mock.calls.find(
      (c) => c[0] && c[0].type === walletBalancesChanged().type
    );
    expect(signal).toBeDefined();
    const state: any = reducer({ revision: 7 } as any, signal![0]);
    expect(state.revision).toBe(8);
  });
});

describe("S3 a read is not a mutation", () => {
  it("getAssetData's own thunk action does not raise the revision", () => {
    // Whatever getAssetData dispatches internally, none of it may be the
    // signal: a page mount reads, and a mount that signalled would make every
    // other mounted page re-read on every mount.
    const before: any = reducer(undefined, { type: "@@INIT" });
    const after: any = reducer(before, { type: getAssetData.fulfilled.type, payload: [] });
    expect(after.revision).toBe(before.revision);
  });

  it("an unrelated action leaves it alone", () => {
    const state: any = reducer({ revision: 3 } as any, { type: "something/else" });
    expect(state.revision).toBe(3);
  });
});

describe("S4 each mutation is its own signal", () => {
  it("two transfers in a row raise it twice", () => {
    let state: any = reducer(undefined, { type: "@@INIT" });
    state = reducer(state, walletBalancesChanged());
    const afterFirst = state.revision;
    state = reducer(state, walletBalancesChanged());
    expect(state.revision).toBe(afterFirst + 1);
    expect(state.revision).toBeGreaterThan(1);
  });
});
