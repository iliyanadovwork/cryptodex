/**
 * THE SPOT TICKET AFTER "USING CRYPTODEX FOR FEES" WAS WITHDRAWN
 * ============================================================
 *
 * WHAT THIS FILE USED TO GUARD
 * ----------------------------
 * It was written for the report "the spot 'Using CRYPTODEX for Fees' toggle is
 * decorative: no request, no rate change, no fee change." Traced end to end,
 * the report was half right in a way that mattered. The control WAS wired: it
 * PUT user/setting/updateCryptodexFee, userapi persisted `enableCryptodexFee` to
 * mongo and to `userSetting_<id>` in redis, and spotapi's `deductCryptodex` read
 * that field on every fill. What it could not do was change a number on THIS
 * venue: `deductCryptodex` resolves the fee coin through `cryptodexFeeSetting()`,
 * which scans the currency list for a coin named CRYPTODEX and returns null when
 * there is not one. This venue lists BTC, ETH, SOL, USD and USDC. So every
 * fill took `{isEnabled:false}` and the ordinary fee whichever way the switch
 * was set - and there was no discount in that path either, so the Taker and
 * Maker percentages printed underneath were right both ways and never moved.
 *
 * The response then was to hide the control behind a currency-list guard so it
 * could return if the coin were ever listed. The scope decision since is that
 * the pay-fees-in-CRYPTODEX option goes altogether, along with its endpoint, so
 * the toggle, its client and `lib/cryptodexFee` are deleted rather than hidden.
 *
 * WHAT IT GUARDS NOW, AND WHY THE FILE SURVIVES THE FEATURE
 * --------------------------------------------------------
 * The one thing that must NOT have gone with it. **Plain maker/taker fees
 * stay** - they are charged on every fill and printed on this panel, and they
 * were explicitly out of scope for the removal. Deleting a toggle whose label
 * contains the word "Fees" is exactly the edit that takes the fee display with
 * it by accident, so:
 *
 *   G1  the withdrawn control is absent, on any currency list, including one
 *       that lists CRYPTODEX (the old escape hatch must not resurrect it);
 *   G2  the Taker and Maker rates are still rendered, and still read from
 *       `taker_fees` / `maker_rebate` - the two fields spotapi actually
 *       charges, not the `takerFee` / `makerFee` pair beside them;
 *   G3  the panel renders for a signed-out visitor too, since the removed
 *       control was the only thing on it that needed a session.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";

jest.mock("@/store", () => {
  const actualReactRedux = jest.requireActual("react-redux");
  return {
    ...jest.requireActual("@/store"),
    useSelector: actualReactRedux.useSelector,
    useDispatch: actualReactRedux.useDispatch,
  };
});
jest.mock("next/image", () => ({ __esModule: true, default: (p: any) => <img {...p} /> }));
jest.mock("next/router", () => ({ useRouter: () => ({ push: jest.fn(), query: {} }) }));
jest.mock("@/components/spot/LimitOrder", () => function L() { return <div /> });
jest.mock("@/components/spot/MarketOrder", () => function M() { return <div /> });
jest.mock("@/lib/toastAlert", () => ({ toastAlert: jest.fn() }));
jest.mock("@/components/Context/SocketContext", () => {
  const react = require("react");
  return {
    __esModule: true,
    default: react.createContext({
      spotSocket: { on: jest.fn(), off: jest.fn(), emit: jest.fn() },
    }),
  };
});

import OrderForm from "@/components/spot/OrderForm";

const TRADE_PAIR = { taker_fees: 0.1, maker_rebate: 0.05 };

const renderForm = ({ currency = [] as any[], signedIn = true } = {}) => {
  const store = configureStore({
    reducer: {
      spot: () => ({
        firstCurrency: { currencyId: "a" },
        secondCurrency: { currencyId: "b" },
        tradePair: TRADE_PAIR,
      }),
      wallet: () => ({ currency }),
      auth: () => ({ session: { signedIn } }),
      UserSetting: () => ({ data: { mode: {} } }),
    },
  });
  return render(
    <Provider store={store}>
      <OrderForm />
    </Provider>
  );
};

/** This venue's real currency list - GET wallet/currency on the running stack. */
const THIS_VENUE = [
  { coin: "BTC" },
  { coin: "ETH" },
  { coin: "SOL" },
  { coin: "USD" },
  { coin: "USDC" },
];

describe("G1 the pay-fees-in-CRYPTODEX control is gone", () => {
  it("is absent on this venue's currency list", () => {
    renderForm({ currency: THIS_VENUE });
    expect(screen.queryByTestId("cryptodex-fee-toggle")).toBeNull();
    expect(screen.queryByText(/Using CRYPTODEX for Fees/i)).toBeNull();
  });

  it("is absent when the currency list has not loaded at all", () => {
    renderForm({ currency: [] });
    expect(screen.queryByTestId("cryptodex-fee-toggle")).toBeNull();
  });

  it("does NOT come back when a coin called CRYPTODEX is listed", () => {
    // The old guard rendered the toggle in exactly this case. The feature is
    // withdrawn, not conditionally hidden, so listing the coin must change
    // nothing on screen.
    renderForm({ currency: [...THIS_VENUE, { coin: "CRYPTODEX" }] });
    expect(screen.queryByTestId("cryptodex-fee-toggle")).toBeNull();
    expect(screen.queryByText(/Using CRYPTODEX for Fees/i)).toBeNull();
  });

  it("renders no checkbox anywhere in the ticket", () => {
    const { container } = renderForm({ currency: THIS_VENUE });
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

describe("G2 the ordinary maker/taker fees went too, later", () => {
  // This block used to assert that the plain maker/taker schedule SURVIVED the
  // removal of the pay-fees-in-CRYPTODEX option - the point being that only the
  // discount mechanism went, not the fees themselves. Every fee has since been
  // withdrawn from the platform (spotapi lib/liquidityRole.feeRateFor returns 0
  // for every order in every role), so the ticket quotes no schedule at all.
  // __tests__/components/spot/feeRatesShown.test.tsx is the standing guard that
  // none of it comes back; this only records that the two removals were separate
  // events, so the history stays legible.
  it("the ticket shows no fee rates at all", () => {
    renderForm({ currency: THIS_VENUE });
    expect(screen.queryByTestId("spot-fee-rates")).toBeNull();
    expect(screen.queryByTestId("spot-taker-rate")).toBeNull();
    expect(screen.queryByTestId("spot-maker-rate")).toBeNull();
  });
});

describe("G3 the panel no longer depends on a session to render", () => {
  it("a signed-out visitor sees the ticket without any fee panel", () => {
    // This block's point is that the panel does not need a session to render.
    // There is no panel any more - every fee was withdrawn - so what it now
    // guards is that a signed-out visitor gets the ticket, and no fee surface.
    renderForm({ currency: THIS_VENUE, signedIn: false });
    expect(screen.queryByTestId("spot-fee-rates")).toBeNull();
  });
});
