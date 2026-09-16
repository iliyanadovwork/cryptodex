/**
 * "Open Orders(N)" COUNTS THE USER'S OPEN ORDERS, NOT THE ROWS LOADED
 * ===================================================================
 *
 * The badge beside the spot open-orders tab was fed `result.data` - ONE PAGE of
 * the response - and counted it. The table pages ten rows at a time, so a user
 * with twenty-three resting orders read "Open Orders(10)" until they scrolled,
 * and watched the number climb as they did. It is meant to say how many orders
 * they have, and it said how many the browser had fetched.
 *
 * spotapi now sends two totals, both taken before the slice: `count` (all
 * markets) and `pairCount` (the market on screen). Which one the badge wants is
 * decided by the same "show all markets" setting the table's own row filter
 * uses.
 *
 * Guards:
 *   B1  with the pair filter ON, the badge shows the server's pairCount,
 *       not the page length;
 *   B2  with "show all markets" ON, it shows the server's whole-set count;
 *   B3  it does not move when a later page merely arrives;
 *   B4  a payload with no pairCount (an older server, or a socket push from a
 *       process not yet restarted) still yields a sensible number rather than
 *       a blank or NaN badge;
 *   B5  the socket push updates the badge from the same fields.
 */

import React from "react";
import { act, render, screen } from "@testing-library/react";
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
jest.mock("@/components/spot/CancelOrder", () => ({
  __esModule: true,
  default: () => <button>Cancel</button>,
}));
jest.mock("@/components/spot/NoAuth", () => ({
  __esModule: true,
  default: () => <div>sign in</div>,
}));

import OpenOrder from "@/components/spot/OpenOrder";
import OrderCount from "@/components/spot/CountRef";

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

/**
 * The badge and the table, wired the way the page wires them: the table pokes
 * the badge through an imperative ref. Reading the badge's rendered text is
 * what the user sees.
 */
const Harness = ({ showSpot }: { showSpot: boolean }) => {
  const countRef = React.useRef<any>(null);
  return (
    <Provider store={makeStore(showSpot)}>
      <OrderCount ref={countRef} />
      <OpenOrder countRef={countRef} countRef2={countRef} />
    </Provider>
  );
};

const badge = () => {
  const el = screen.getByText(/Open Orders\(/);
  return (el.textContent || "").trim();
};

const renderPanel = async (showSpot = false) => {
  const utils = render(<Harness showSpot={showSpot} />);
  await screen.findByText("Total Order Value");
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
};

/** One page of a `total`-row set, as the FIXED service now answers. */
const page = (
  rows: any[],
  currentPage: number,
  limit: number,
  total: number,
  pairCount?: number
) => ({
  status: "success",
  loading: false,
  result: {
    data: rows,
    count: total,
    ...(pairCount === undefined ? {} : { pairCount }),
    currentPage,
    nextPage: (currentPage - 1) * limit + rows.length < total,
    limit,
  },
});

const tenOnThisPair = Array.from({ length: 10 }, (_, i) => order("o" + i));

beforeEach(() => {
  getOpenOrderApi.mockReset();
  for (const k of Object.keys(handlers)) delete handlers[k];
});

describe("B1 the pair filter is on (the default)", () => {
  it("shows the server's pairCount, not the ten rows loaded", async () => {
    // Twenty-three orders on this pair; the first page carries ten of them.
    getOpenOrderApi.mockResolvedValue(page(tenOnThisPair, 1, 10, 23, 23));
    await renderPanel(false);
    expect(badge()).toBe("Open Orders(23)");
  });

  it("counts only this market when the user has orders elsewhere too", async () => {
    // 30 open orders in total, 7 of them on the pair on screen.
    getOpenOrderApi.mockResolvedValue(page(tenOnThisPair, 1, 10, 30, 7));
    await renderPanel(false);
    expect(badge()).toBe("Open Orders(7)");
  });

  it("shows zero when the user has nothing resting on this market", async () => {
    getOpenOrderApi.mockResolvedValue(page([], 1, 10, 12, 0));
    await renderPanel(false);
    expect(badge()).toBe("Open Orders(0)");
  });

  it("an explicit ZERO from the server wins over rows still in the payload", async () => {
    // Reachable when a payload and the pair on screen disagree - a push that
    // was in flight when the user switched market. Zero is a figure the server
    // sent, not a missing one, so it is used; treating 0 as "absent" and
    // counting the rows instead would print the previous market's total under
    // this market's name.
    getOpenOrderApi.mockResolvedValue(page(tenOnThisPair, 1, 10, 10, 0));
    await renderPanel(false);
    expect(badge()).toBe("Open Orders(0)");
  });
});

describe("B2 show all markets is on", () => {
  it("shows the whole-set count", async () => {
    getOpenOrderApi.mockResolvedValue(page(tenOnThisPair, 1, 10, 30, 7));
    await renderPanel(true);
    expect(badge()).toBe("Open Orders(30)");
  });
});

describe("B3 paging does not move the badge", () => {
  it("page 2 arriving leaves the number where it was", async () => {
    getOpenOrderApi.mockResolvedValueOnce(page(tenOnThisPair, 1, 10, 23, 23));
    await renderPanel(false);
    expect(badge()).toBe("Open Orders(23)");

    // The scroller fetching page 2 is the moment the OLD badge changed.
    getOpenOrderApi.mockResolvedValueOnce(
      page([order("o10"), order("o11")], 2, 10, 23, 23)
    );
    await act(async () => {
      handlers.openOrder &&
        handlers.openOrder({
          pairId: PAIR_ID,
          data: [...tenOnThisPair, order("o10"), order("o11")],
          count: 23,
          pairCount: 23,
          currentPage: 1,
          nextPage: false,
          limit: 10,
        });
    });
    expect(badge()).toBe("Open Orders(23)");
  });
});

describe("B4 a payload without pairCount", () => {
  it("falls back to counting the rows it was given, filtered to the pair", async () => {
    const mixed = [
      order("a"),
      order("b"),
      order("c", { pairId: OTHER_PAIR }),
      order("d", { pairId: OTHER_PAIR }),
    ];
    getOpenOrderApi.mockResolvedValue(page(mixed, 1, 10, 4));
    await renderPanel(false);
    expect(badge()).toBe("Open Orders(2)");
  });

  it("never renders a NaN or blank badge", async () => {
    getOpenOrderApi.mockResolvedValue({
      status: "success",
      loading: false,
      result: { data: tenOnThisPair, currentPage: 1, nextPage: false, limit: 10 },
    });
    await renderPanel(false);
    expect(badge()).toMatch(/^Open Orders\(\d+\)$/);
  });
});

describe("B5 the socket push", () => {
  it("updates the badge from the same fields", async () => {
    getOpenOrderApi.mockResolvedValue(page(tenOnThisPair, 1, 10, 23, 23));
    await renderPanel(false);

    await act(async () => {
      handlers.openOrder({
        pairId: PAIR_ID,
        data: [order("x")],
        count: 9,
        pairCount: 4,
        currentPage: 1,
        nextPage: false,
        limit: 10,
      });
    });
    expect(badge()).toBe("Open Orders(4)");
  });
});
