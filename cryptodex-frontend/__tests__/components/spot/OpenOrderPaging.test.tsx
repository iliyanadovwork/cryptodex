/**
 * TWELVE RESTING ORDERS, TWO OF THEM UNCANCELLABLE
 * ================================================
 *
 * The spot open-orders table is the ONLY place a resting spot order can be
 * cancelled. Spot has no `cancelAllOpen` bulk-cancel endpoint and
 * the table has no page-number control, so a row the scroller cannot reach is
 * an order the user cannot release - and its reservation sits in the in-order
 * ledger indefinitely.
 *
 * `GET /api/spot/openOrder` answered `nextPage: data.length <= 0 ? true : false`
 * - true exactly when the page was EMPTY. `nextPage` is InfiniteScroll's
 * `hasMore`, and `onScrollListener` only calls `next()` under
 * `if (atBottom && this.props.hasMore)`, so a full first page could never load
 * a second. Twelve orders, ten rows, two gone.
 *
 * The same flag was ALSO the empty-state switch, by accident. InfiniteScroll
 * renders `loader` under `!showLoader && !hasChildren && hasMore`, `hasChildren`
 * was false (a single <Table> child is not an Array), and this panel passed the
 * "no records found" illustration as `loader`. So correcting the API alone
 * would have printed that illustration underneath ten live orders and removed
 * it from a genuinely empty table. Both directions are pinned below.
 *
 * These tests drive the REAL component. The service is stubbed at the module
 * boundary, so what is exercised is the component's paging arithmetic, its
 * merge, and what InfiniteScroll does with the props it is given.
 *
 * MUTATION-CHECKED (against the component and lib/pagedTable.ts):
 *   F1  put the empty state back in the `loader` prop
 *   F2  render the empty state from `nextPage` instead of the rows
 *   F3  drop the second child, so `hasChildren` goes false again
 *   F4  make mergePage replace on every page (the pre-fix behaviour)
 *   F5  make mergePage append on page 1 as well
 *   F6  make the panel show the empty state whenever `data.length === 0`
 *       rather than when the VISIBLE rows are empty
 * Table in the round summary.
 */

import React from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";
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
jest.mock("@/services/Spot/SpotService", () => ({
  getOpenOrder: (...a: any[]) => getOpenOrderApi(...a),
}));

// The cancel control, rendered per row. Its presence in the DOM is the
// property under test: an order with no cancel button is money the user cannot
// release.
jest.mock("@/components/spot/CancelOrder", () => ({
  __esModule: true,
  default: ({ orderInfo }: any) => (
    <button data-testid={"cancel-" + orderInfo._id}>Cancel</button>
  ),
}));
jest.mock("@/components/spot/NoAuth", () => ({
  __esModule: true,
  default: () => <div>sign in</div>,
}));

import OpenOrder from "@/components/spot/OpenOrder";

const PAIR_ID = "695bf1017573eeb15a749c9d";
const OTHER_PAIR = "695bf1017573eeb15a749c9e";

const PAIR = {
  _id: PAIR_ID,
  tikerRoot: "BTCUSD",
  firstCurrencySymbol: "BTC",
  secondCurrencySymbol: "USD",
  firstFloatDigit: 8,
  secondFloatDigit: 2,
};

const order = (id: string, over: any = {}) => ({
  _id: id,
  orderCode: id,
  pairId: PAIR_ID,
  firstCurrency: "BTC",
  secondCurrency: "USD",
  orderType: "limit",
  buyorsell: "buy",
  price: 64000,
  quantity: 0.1,
  openQuantity: 0.1,
  filledQuantity: 0,
  orderValue: 6400,
  orderDate: "2026-01-01T00:00:00.000Z",
  pairDetail: PAIR,
  ...over,
});

const makeStore = (showSpot: boolean) =>
  configureStore({
    reducer: {
      spot: () => ({ tradePair: PAIR, pairList: [PAIR], openOrders: [] }),
      auth: () => ({ session: { signedIn: true } }),
      UserSetting: () => ({ data: { mode: { showSpot } } }),
      trade: (state: any = { openOrders: [] }, action: any) =>
        action?.type === "data/setOpenOrders"
          ? { ...state, openOrders: action.payload }
          : state,
    },
  });

/** The API answer the FIXED service sends for one page of a `total`-row set. */
const page = (rows: any[], currentPage: number, limit: number, total: number) => ({
  status: "success",
  loading: false,
  result: {
    data: rows,
    count: total,
    currentPage,
    nextPage: (currentPage - 1) * limit + rows.length < total,
    limit,
  },
});

const emptyStateShown = () => screen.queryAllByText(/no records found/i).length > 0;

const renderPanel = async (showSpot = false) => {
  const utils = render(
    <Provider store={makeStore(showSpot)}>
      <OpenOrder countRef={{ current: null }} countRef2={{ current: null }} />
    </Provider>
  );
  await screen.findByText("Total Order Value");
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
};

/**
 * Scroll the panel to the bottom, which is what makes InfiniteScroll call
 * `next()`. Its listener is on the scrollable div and compares
 * `scrollTop + clientHeight` against `scrollHeight`, so those three are set by
 * hand - jsdom lays nothing out.
 */
const scrollToBottom = async () => {
  const scroller = document.querySelector(".infinite-scroll-component") as HTMLElement;
  expect(scroller).toBeTruthy();
  Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 250, configurable: true });
  Object.defineProperty(scroller, "scrollTop", { value: 750, configurable: true });
  await act(async () => {
    fireEvent.scroll(scroller);
    await Promise.resolve();
    await Promise.resolve();
  });
};

const TWELVE = Array.from({ length: 12 }, (_, i) => order("o" + i));

beforeEach(() => {
  for (const key of Object.keys(handlers)) delete handlers[key];
  getOpenOrderApi.mockReset();
});

describe("THE BLOCKER: every resting order is reachable and cancellable", () => {
  it("renders the first ten and asks for no more until told to", async () => {
    getOpenOrderApi.mockResolvedValue(page(TWELVE.slice(0, 10), 1, 10, 12));
    await renderPanel();

    expect(screen.getAllByRole("row")).toHaveLength(11); // header + 10
    expect(getOpenOrderApi).toHaveBeenCalledTimes(1);
  });

  it("loads page 2 on scroll and ends up showing ALL TWELVE, each with a cancel button", async () => {
    getOpenOrderApi.mockResolvedValueOnce(page(TWELVE.slice(0, 10), 1, 10, 12));
    await renderPanel();

    getOpenOrderApi.mockResolvedValueOnce(page(TWELVE.slice(10), 2, 10, 12));
    await scrollToBottom();

    // THE DEFECT: `nextPage: data.length <= 0` made this call never happen, so
    // o10 and o11 were unreachable - and this table is the only way to cancel
    // them.
    expect(getOpenOrderApi).toHaveBeenCalledTimes(2);
    expect(getOpenOrderApi.mock.calls[1][0]).toEqual({ page: 2, limit: 10 });

    for (const row of TWELVE) {
      expect(screen.getByTestId("cancel-" + row._id)).toBeTruthy();
    }
  });

  it("page 2 does not REPLACE page 1 - the first ten are still on screen", async () => {
    getOpenOrderApi.mockResolvedValueOnce(page(TWELVE.slice(0, 10), 1, 10, 12));
    await renderPanel();
    getOpenOrderApi.mockResolvedValueOnce(page(TWELVE.slice(10), 2, 10, 12));
    await scrollToBottom();

    // F4: the component stored `result.data` outright, so this was 3 rows
    // (header + o10 + o11) and ten orders vanished on scroll.
    expect(screen.getAllByRole("row")).toHaveLength(13); // header + 12
    expect(screen.getByTestId("cancel-o0")).toBeTruthy();
  });

  it("no order is listed twice when page 2 re-sends a row page 1 already had", async () => {
    getOpenOrderApi.mockResolvedValueOnce(page(TWELVE.slice(0, 10), 1, 10, 12));
    await renderPanel();
    // A fill between the two requests shifts the window: page 2 comes back
    // holding o9 again. Two rows means two cancel buttons for one order.
    getOpenOrderApi.mockResolvedValueOnce(
      page([TWELVE[9], TWELVE[10], TWELVE[11]], 2, 10, 12)
    );
    await scrollToBottom();

    expect(screen.getAllByTestId("cancel-o9")).toHaveLength(1);
    expect(screen.getAllByRole("row")).toHaveLength(13);
  });

  it("stops asking once the last page has arrived", async () => {
    getOpenOrderApi.mockResolvedValueOnce(page(TWELVE.slice(0, 10), 1, 10, 12));
    await renderPanel();
    getOpenOrderApi.mockResolvedValueOnce(page(TWELVE.slice(10), 2, 10, 12));
    await scrollToBottom();

    await scrollToBottom();
    expect(getOpenOrderApi).toHaveBeenCalledTimes(2);
  });

  it("`nextPage: false` STOPS it, even when `count` says otherwise", async () => {
    // The server's flag is the authority; the component's `data.length >= count`
    // guard is only a backstop. Here they disagree - the answer says "no more"
    // while `count` claims 50 - which is exactly what the socket push produces
    // when it carries the complete set. Without this case a `hasMore` wired to
    // a constant `true` passes the whole suite, because the backstop absorbs it
    // whenever `count` happens to be right.
    getOpenOrderApi.mockResolvedValue({
      status: "success",
      loading: false,
      result: {
        data: TWELVE.slice(0, 10),
        count: 50,
        currentPage: 1,
        nextPage: false,
        limit: 10,
      },
    });
    await renderPanel();

    getOpenOrderApi.mockClear();
    await scrollToBottom();
    expect(getOpenOrderApi).not.toHaveBeenCalled();
  });

  it("`nextPage: true` STARTS it, even when `count` has not caught up", async () => {
    getOpenOrderApi.mockResolvedValueOnce({
      status: "success",
      loading: false,
      result: {
        data: TWELVE.slice(0, 10),
        count: 12,
        currentPage: 1,
        nextPage: true,
        limit: 10,
      },
    });
    await renderPanel();

    getOpenOrderApi.mockResolvedValueOnce(page(TWELVE.slice(10), 2, 10, 12));
    await scrollToBottom();
    expect(getOpenOrderApi).toHaveBeenCalledTimes(2);
  });
});

describe("the empty state belongs to the rows, not to the paging flag", () => {
  it("THE REGRESSION THIS FIX HAD TO AVOID: a full page with more behind it prints no empty state", async () => {
    getOpenOrderApi.mockResolvedValue(page(TWELVE.slice(0, 10), 1, 10, 12));
    await renderPanel();

    // `nextPage` is true here. F1/F2/F3 each put the illustration back
    // underneath ten live orders.
    expect(emptyStateShown()).toBe(false);
  });

  it("an exactly-full page with nothing behind it also prints no empty state", async () => {
    const ten = TWELVE.slice(0, 10);
    getOpenOrderApi.mockResolvedValue(page(ten, 1, 10, 10));
    await renderPanel();

    expect(emptyStateShown()).toBe(false);
    expect(screen.getAllByRole("row")).toHaveLength(11);
  });

  it("a genuinely empty table STILL says so - the fix did not just delete the empty state", async () => {
    getOpenOrderApi.mockResolvedValue(page([], 1, 10, 0));
    await renderPanel();

    // The old code got this right by accident (`data.length <= 0` was true);
    // a truthful `nextPage` is FALSE here, so an unchanged frontend would show
    // a blank panel with no explanation.
    expect(emptyStateShown()).toBe(true);
  });

  it("orders that exist only on OTHER markets leave an empty TABLE, and it says so", async () => {
    getOpenOrderApi.mockResolvedValue(
      page([order("x1", { pairId: OTHER_PAIR })], 1, 10, 1)
    );
    await renderPanel(false);

    // F6: `data.length === 0` is false here - the payload has a row - but the
    // pair filter drops it, so the table paints nothing.
    expect(screen.queryByTestId("cancel-x1")).toBeNull();
    expect(emptyStateShown()).toBe(true);
  });

  it("with show-all on, that same order is visible and there is no empty state", async () => {
    getOpenOrderApi.mockResolvedValue(
      page([order("x1", { pairId: OTHER_PAIR })], 1, 10, 1)
    );
    await renderPanel(true);

    expect(screen.getByTestId("cancel-x1")).toBeTruthy();
    expect(emptyStateShown()).toBe(false);
  });
});

describe("the socket push replaces the whole table", () => {
  it("a push of the complete set is shown, and claims no further page", async () => {
    getOpenOrderApi.mockResolvedValue(page(TWELVE.slice(0, 10), 1, 10, 12));
    await renderPanel();

    await act(async () => {
      handlers["openOrder"]?.({
        pairId: PAIR_ID,
        data: TWELVE,
        count: 12,
        currentPage: 1,
        nextPage: false,
        limit: 10,
      });
      await Promise.resolve();
    });

    expect(screen.getAllByRole("row")).toHaveLength(13);
    expect(emptyStateShown()).toBe(false);

    // `nextPage: false` on a push that carries everything: no further fetch.
    getOpenOrderApi.mockClear();
    await scrollToBottom();
    expect(getOpenOrderApi).not.toHaveBeenCalled();
  });

  it("a push that empties the book restores the empty state", async () => {
    getOpenOrderApi.mockResolvedValue(page(TWELVE.slice(0, 10), 1, 10, 12));
    await renderPanel();

    await act(async () => {
      handlers["openOrder"]?.({
        pairId: PAIR_ID,
        data: [],
        count: 0,
        currentPage: 1,
        nextPage: false,
        limit: 10,
      });
      await Promise.resolve();
    });

    expect(emptyStateShown()).toBe(true);
  });
});
