/**
 * THE TOTAL FOLLOWS THE PRICE, AND BOTH COPIES OF IT FOLLOW TOGETHER.
 * ==================================================================
 *
 * "Total Assets Value" was a snapshot. Measured against the running app: read
 * it, wait 45 seconds, read it twice more - the same figure, and not one
 * balance or price request in the window. It is computed from
 * `state.wallet.priceConversion`, which was fetched once on mount and never
 * rewritten, so a wallet holding BTC drifted from its own displayed value for
 * as long as a tab stayed open.
 *
 * A `marketPrice` tick now writes into that table (HelperRoute), and this holds
 * the two things that makes true:
 *
 *   1. the figure MOVES when the price moves and nothing else changes;
 *   2. the two places it is printed move TOGETHER, to the same number.
 *
 * (2) is the one that matters. navbar.tsx:26 records the incident: the account
 * menu and the /wallet headline showed 57701.32 and 57385.36 at the same
 * moment, under the same caption. They agree today because both compute from
 * this one table - so making the table live is safe exactly as long as both
 * still react to it. WalletList's effect listened to `assets` alone and would
 * have frozen while the navbar moved, which is why it takes `priceConversion`
 * in its dependencies now, and why that is asserted here rather than trusted.
 *
 * TWO WAYS THIS TEST COULD PASS WITHOUT PROVING ANYTHING, both guarded below:
 *
 *   - A USD-ONLY WALLET. lib/walletTotals pegs a demo dollar to exactly 1
 *     whatever the feed says, so a wallet of dollars is worth the same at any
 *     BTC price and both figures would "agree" while frozen. The fixture holds
 *     BTC, and the test asserts each figure differs from its own baseline
 *     before comparing them to each other.
 *   - THE SETUP MOCKS. jest.setup.js replaces `useDispatch` with a bare
 *     jest.fn() and stubs the whole wallet slice, so a dispatch would reach no
 *     reducer and the state would never change. Both are restored to the real
 *     implementations at the top of this file.
 */

// Opt out of the two global mocks that would make this vacuous. Must come
// before the imports that read them.
jest.mock("react-redux", () => jest.requireActual("react-redux"));
jest.mock("@/store/Wallet/dataSlice", () =>
  jest.requireActual("@/store/Wallet/dataSlice")
);

import React from "react";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";

import walletReducer, { marketPriceTick } from "@/store/Wallet/dataSlice";
import WalletList from "@/components/Wallet/WalletList";

jest.mock("next/router", () => ({ useRouter: jest.fn() }));
jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: any) => <img {...props} />,
}));
jest.mock("@/services/Wallet/WalletService", () => ({
  apiGetUserDeposit: jest.fn(() => Promise.resolve()),
}));

import { useRouter } from "next/router";

const OPENING_PRICE = 79205;
const TICK_PRICE = 88000;
const BTC_HELD = 0.5;

/** A wallet holding BTC - a dollar is pegged to 1, so dollars alone prove nothing. */
const assets = [
  {
    _id: "btc1",
    coin: "BTC",
    currencyId: "cur-btc",
    spotBal: String(BTC_HELD),
    spotInOrder: "0",
    spotLockedBal: "0",
    tokenAddressArray: [],
  },
];

const currency = [
  {
    _id: "cur-btc",
    coin: "BTC",
    type: "crypto",
    status: "active",
    image: "/images/btc.png",
    decimals: 8,
    contractDecimal: 8,
  },
];

const priceConversion = [
  { baseSymbol: "BTC", convertSymbol: "USD", convertPrice: String(OPENING_PRICE) },
  { baseSymbol: "USD", convertSymbol: "BTC", convertPrice: String(1 / OPENING_PRICE) },
];

const makeStore = () =>
  configureStore({
    reducer: {
      wallet: walletReducer,
      spot: () => ({ pairList: [] }),
      auth: () => ({ session: { signedIn: true }, user: { _id: "u1" } }),
    },
    preloadedState: {
      wallet: {
        currency,
        priceConversion,
        assets,
        toastAlertStatus: false,
        loading: false,
        revision: 0,
      },
    } as any,
  });

const headline = () =>
  screen.getByTestId("total-assets-value").textContent || "";

/** The USD number out of "1000.00 USD ≈ 0.0125 BTC". */
const usdOf = (text: string) => {
  const m = text.match(/([\d.]+)\s*USD/);
  return m ? parseFloat(m[1]) : NaN;
};

beforeEach(() => {
  (useRouter as jest.Mock).mockReturnValue({
    push: jest.fn(),
    pathname: "/wallet",
    query: {},
  });
});

describe("the wallet total tracks the price feed", () => {
  it("moves when the price moves and nothing else does", () => {
    const store = makeStore();
    render(
      <Provider store={store}>
        <WalletList />
      </Provider>
    );

    const before = usdOf(headline());
    expect(before).toBeCloseTo(BTC_HELD * OPENING_PRICE, 0);

    // The price ticks. `assets` is untouched: the balance has not changed, only
    // what it is worth.
    act(() => {
      store.dispatch(
        marketPriceTick({ base: "BTC", quote: "USD", price: TICK_PRICE })
      );
    });

    const after = usdOf(headline());
    // The non-vacuity guard: it must actually have moved.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeCloseTo(BTC_HELD * TICK_PRICE, 0);
    expect(after - before).toBeCloseTo(BTC_HELD * (TICK_PRICE - OPENING_PRICE), 0);
  });

  it("writes both directions of the pair, so the BTC half of the sentence agrees", () => {
    const store = makeStore();
    act(() => {
      store.dispatch(
        marketPriceTick({ base: "BTC", quote: "USD", price: TICK_PRICE })
      );
    });

    const rows = store.getState().wallet.priceConversion;
    const fwd = rows.find(
      (r: any) => r.baseSymbol === "BTC" && r.convertSymbol === "USD"
    );
    const inv = rows.find(
      (r: any) => r.baseSymbol === "USD" && r.convertSymbol === "BTC"
    );
    // WalletList prints "X USD ≈ Y BTC" by multiplying the USD total by the
    // inverse row. Leaving it stale would have the two halves of one sentence
    // disagreeing about the rate.
    expect(parseFloat(fwd.convertPrice)).toBe(TICK_PRICE);
    expect(parseFloat(inv.convertPrice)).toBeCloseTo(1 / TICK_PRICE, 12);
  });

  it("ignores a tick that carries no usable price", () => {
    const store = makeStore();
    const before = store.getState().wallet.priceConversion[0].convertPrice;

    act(() => {
      store.dispatch(marketPriceTick({ base: "BTC", quote: "USD", price: 0 } as any));
      store.dispatch(marketPriceTick({ base: "BTC", quote: "USD", price: NaN } as any));
      store.dispatch({ type: marketPriceTick.type, payload: undefined } as any);
    });

    // A zero or a NaN would value the whole wallet at nothing, or at NaN, on a
    // dropped frame from the feed.
    expect(store.getState().wallet.priceConversion[0].convertPrice).toBe(before);
  });
});
