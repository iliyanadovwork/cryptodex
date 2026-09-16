/**
 * THE CANCEL DIALOG CANCELLED THE WRONG ORDER
 * ===========================================
 *
 * `components/spot/OpenOrder.tsx` rendered its rows as `<tr key={index}>`. The
 * key was the row's POSITION, not the order's identity, so when a row above
 * left the table React unmounted nothing: it reused the already-mounted cancel
 * control and swapped its `orderInfo` prop WHILE ITS MODAL WAS OPEN. The modal
 * had no copy of the order - `CancelOrder` read the live prop inside its submit
 * handler - so Confirm acted on whichever order now occupied that index.
 *
 * A row leaves the table on its own every time an order fills, so this needed
 * nobody to do anything unusual.
 *
 * MEASURED LIVE on /spot/BTC_USD, twice, on a throwaway account:
 *   three resting buys, newest first: [63480.19, 61000, 60000]
 *   dialog opened on the 61000 row (index 1), left open
 *   the top row filled by itself
 *   Confirm -> available USD 1931.601272 -> 1943.601272, i.e. +12.00 exactly:
 *   the 60000 x 0.0002 order was cancelled and the 61000 order survived.
 *   Toast: "Order cancelled successfully".
 * The same result was produced with the top row cancelled from a second tab
 * instead of filling.
 *
 * The server cannot catch this and it is not the server's fault: BOTH orders
 * belong to the caller. (Checked live rather than assumed: a second account
 * asking to cancel this account's order by id gets 400 "Order not found" and
 * the order stays resting.)
 *
 * WHAT THESE TESTS PIN, and how each one fails on the defect:
 *
 *   R1  Confirm sends the id of the order the dialog was OPENED on, after the
 *       row above has left. On the old code it sends the id of the order below.
 *       This is the regression test proper.
 *   R2  The dialog names the order it is about. The old dialog printed one
 *       sentence and no order at all, which is why the swap was invisible.
 *   R3  The dialog survives its own row leaving the table. A correct key alone
 *       makes the row unmount and the dialog vanish mid-read; the dialog is
 *       owned by the table instead, so it stays and says what happened.
 *   R4  With the order gone and every page loaded, the dialog offers Close and
 *       NO Confirm - it can no longer be used to cancel anything.
 *   R5  "Gone" is not claimed when the table is only PARTLY loaded, because
 *       absence from a paged list is not absence from the venue.
 *   R6  The payload identifies the order by `_id`, and derives `tableId` from
 *       the same order's own side and pair.
 */

import React from "react";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";

jest.mock("next/image", () => ({
  __esModule: true,
  default: (p: any) => <img {...p} />,
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children }: any) => <a>{children}</a>,
}));
jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark", setTheme: jest.fn() }),
}));

const handlers: Record<string, any> = {};
jest.mock("@/components/Context/SocketContext", () => {
  const react = require("react");
  const socket = {
    on: (evt: string, fn: any) => {
      handlers[evt] = fn;
    },
    off: jest.fn(),
    emit: jest.fn(),
  };
  return {
    __esModule: true,
    default: react.createContext({ spotSocket: socket }),
  };
});

const getOpenOrderApi = jest.fn();
const cancelOrderApi = jest.fn();
jest.mock("@/services/Spot/SpotService", () => ({
  getOpenOrder: (...a: any[]) => getOpenOrderApi(...a),
  cancelOrder: (...a: any[]) => cancelOrderApi(...a),
}));

// The real encryption is not what is under test; passing the plaintext through
// is what lets these tests read WHICH ORDER the request is about.
jest.mock("@/lib/cryptoJS", () => ({
  encryptObject: (o: any) => o,
}));

const toastAlert = jest.fn();
jest.mock("@/lib/toastAlert", () => ({
  toastAlert: (...a: any[]) => toastAlert(...a),
}));

jest.mock("@/components/spot/NoAuth", () => ({
  __esModule: true,
  default: () => <div>sign in</div>,
}));

import OpenOrder from "@/components/spot/OpenOrder";
import { cancelOrderPayload, stillOpen } from "@/lib/cancelOrderRequest";

const PAIR_ID = "695bf1017573eeb15a749c9d";
const PAIR = {
  _id: PAIR_ID,
  tikerRoot: "BTCUSD",
  firstCurrencySymbol: "BTC",
  secondCurrencySymbol: "USD",
  firstFloatDigit: 8,
  secondFloatDigit: 2,
};

/** The three buys of the live reproduction, newest first in the table. */
const order = (id: string, price: number, quantity: number) => ({
  _id: id,
  orderCode: "OC-" + id,
  pairId: PAIR_ID,
  firstCurrency: "BTC",
  secondCurrency: "USD",
  orderType: "limit",
  buyorsell: "buy",
  price,
  quantity,
  openQuantity: quantity,
  filledQuantity: 0,
  orderValue: price * quantity,
  orderDate: "2026-08-12T21:01:00.000Z",
  pairDetail: PAIR,
});

const TOP = order("id-top", 63480.19, 0.0002); // fills on its own
const MID = order("id-61000", 61000, 0.0003); // the dialog is opened on this one
const LOW = order("id-60000", 60000, 0.0002); // the one the defect cancelled

const makeStore = () =>
  configureStore({
    reducer: {
      spot: () => ({ tradePair: PAIR, pairList: [PAIR], openOrders: [] }),
      auth: () => ({ session: { signedIn: true } }),
      UserSetting: () => ({ data: { mode: { showSpot: false } } }),
      trade: (state: any = { openOrders: [] }, action: any) =>
        action?.type === "data/setOpenOrders"
          ? { ...state, openOrders: action.payload }
          : state,
    },
  });

const page = (rows: any[], total = rows.length) => ({
  status: "success",
  loading: false,
  result: {
    data: rows,
    count: total,
    pairCount: total,
    currentPage: 1,
    nextPage: rows.length < total,
    limit: 10,
  },
});

const renderPanel = async () => {
  const utils = render(
    <Provider store={makeStore()}>
      <OpenOrder countRef={{ current: null }} countRef2={{ current: null }} />
    </Provider>
  );
  await screen.findByText("Total Order Value");
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
};

/** The rows the panel paints, top to bottom. */
const bodyRows = () =>
  Array.from(document.querySelectorAll("tbody tr")) as HTMLElement[];

/** Open the confirmation on the row currently at `index`. */
const openDialogOnRow = async (index: number) => {
  const btn = within(bodyRows()[index]).getByRole("button", { name: /cancel/i });
  await act(async () => {
    fireEvent.click(btn);
    await Promise.resolve();
  });
};

/** What the venue pushes when the book changes under the user. */
const pushOpenOrders = async (rows: any[], total = rows.length) => {
  await act(async () => {
    handlers["openOrder"]({
      pairId: PAIR_ID,
      data: rows,
      count: total,
      pairCount: total,
      currentPage: 1,
      nextPage: rows.length < total,
      limit: 10,
    });
    await Promise.resolve();
  });
};

const dialog = () => document.querySelector(".modal") as HTMLElement | null;
const dialogText = () => (dialog()?.textContent || "").replace(/\s+/g, " ");
const confirmBtn = () =>
  dialog() ? within(dialog() as HTMLElement).queryByRole("button", { name: /^confirm$/i }) : null;

beforeEach(() => {
  for (const key of Object.keys(handlers)) delete handlers[key];
  getOpenOrderApi.mockReset();
  cancelOrderApi.mockReset();
  toastAlert.mockReset();
  cancelOrderApi.mockResolvedValue({
    status: "success",
    loading: false,
    message: "Order cancelled successfully",
  });
});

describe("THE BLOCKER: the cancel dialog acts on the order it was opened for", () => {
  /** R1 - the regression test. Fails on `key={index}` + live-prop submit. */
  it("cancels the 61000 order after the row ABOVE it fills, not the 60000 order below", async () => {
    getOpenOrderApi.mockResolvedValue(page([TOP, MID, LOW]));
    await renderPanel();

    expect(bodyRows()).toHaveLength(3);
    await openDialogOnRow(1); // the 61000 order
    expect(dialog()).toBeTruthy();

    // The top row fills. Nothing about the dialog is supposed to move.
    await pushOpenOrders([MID, LOW]);
    expect(bodyRows()).toHaveLength(2);

    await act(async () => {
      fireEvent.click(confirmBtn() as HTMLElement);
      await Promise.resolve();
    });

    expect(cancelOrderApi).toHaveBeenCalledTimes(1);
    const sent = cancelOrderApi.mock.calls[0][0];
    expect(sent.orderId).toBe(MID._id);
    expect(sent.orderId).not.toBe(LOW._id);
    expect(sent.tableId).toBe("buyOpenOrders_" + PAIR_ID);
  });

  /** R2 - a confirmation the user can actually check. */
  it("names the order it is about, so a swap would be visible before Confirm", async () => {
    getOpenOrderApi.mockResolvedValue(page([TOP, MID, LOW]));
    await renderPanel();

    await openDialogOnRow(1);
    const summary = screen.getByTestId("cancel-order-summary").textContent || "";
    // jest.setup.js stubs `capitalize` to the identity, so the side is matched
    // case-insensitively; the PRICE and the order code are what identify the
    // order, and neither may be the row below's.
    expect(summary).toContain("61000");
    expect(summary).toContain("BTC/USD");
    expect(summary.toLowerCase()).toContain("buy");
    expect(summary).toContain(MID.orderCode);
    expect(summary).not.toContain("60000");
    expect(summary).not.toContain(LOW.orderCode);

    // ... and it keeps saying so once the row above has gone.
    await pushOpenOrders([MID, LOW]);
    expect(screen.getByTestId("cancel-order-summary").textContent).toContain("61000");
    expect(screen.getByTestId("cancel-order-summary").textContent).toContain(MID.orderCode);
  });

  /** R3 - the dialog belongs to the table, not to the row. */
  it("stays open when the order it is about leaves the table", async () => {
    getOpenOrderApi.mockResolvedValue(page([TOP, MID, LOW]));
    await renderPanel();

    await openDialogOnRow(1);
    await pushOpenOrders([TOP, LOW]); // the 61000 order filled elsewhere

    expect(bodyRows()).toHaveLength(2);
    expect(dialog()).toBeTruthy();
    expect(screen.getByTestId("cancel-order-summary").textContent).toContain(MID.orderCode);
  });

  /** R4 - and it refuses to cancel anything else in its place. */
  it("switches to 'no longer open' and offers no Confirm once the order is gone", async () => {
    getOpenOrderApi.mockResolvedValue(page([TOP, MID, LOW]));
    await renderPanel();

    await openDialogOnRow(1);
    await pushOpenOrders([TOP, LOW]);

    expect(screen.getByTestId("cancel-order-gone")).toBeInTheDocument();
    expect(dialogText()).toContain("This order is no longer open");
    expect(confirmBtn()).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("cancel-order-close"));
      await Promise.resolve();
    });
    expect(cancelOrderApi).not.toHaveBeenCalled();
  });

  /**
   * R5 - "gone" is a claim about the VENUE, and a paged table cannot make it.
   * The socket push carries page one only; an order the user scrolled to is
   * absent from `data` and still perfectly alive.
   */
  it("does not claim 'no longer open' merely because the loaded page lost the row", async () => {
    getOpenOrderApi.mockResolvedValue(page([TOP, MID, LOW], 30));
    await renderPanel();

    await openDialogOnRow(1);
    await pushOpenOrders([TOP, LOW], 30); // 30 orders exist, 2 are loaded

    expect(screen.queryByTestId("cancel-order-gone")).toBeNull();
    expect(confirmBtn()).toBeTruthy();

    await act(async () => {
      fireEvent.click(confirmBtn() as HTMLElement);
      await Promise.resolve();
    });
    expect(cancelOrderApi.mock.calls[0][0].orderId).toBe(MID._id);
  });

  /** R6 - the request names the order, and its table follows from the order. */
  it("builds the request from the order itself", () => {
    expect(cancelOrderPayload(MID)).toEqual({
      tableId: "buyOpenOrders_" + PAIR_ID,
      orderId: MID._id,
      firstFloatDigit: undefined,
      secondFloatDigit: undefined,
    });
    // The socket payload spells the side `type` on some rows.
    expect(
      cancelOrderPayload({ _id: "x", pairId: "p", type: "sell" } as any).tableId
    ).toBe("sellOpenOrders_p");
    expect(stillOpen(MID, [TOP, LOW])).toBe(false);
    expect(stillOpen(MID, [TOP, MID, LOW])).toBe(true);
  });
});
