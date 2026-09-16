/**
 * /history -> Spot -> TRADE History: THE QUANTITY (CRITICAL)
 * ==========================================================
 *
 * REPORTED: "shows a DIFFERENT QUANTITY from the trade page for the same trade
 * (0.0155 vs 0.01553693) — truncated display presented as the real figure."
 *
 * The trade page's own Trade History panel prints
 * `formatQty(tradeQty, tradePair.firstFloatDigit)`; this table printed
 * `toFixed(tradeQty, 4)`. `toFixed` is Number.prototype.toFixed, so it is not
 * even a truncation — 0.00008 BTC (about $5) rendered as "0.0001", MORE than
 * the user traded, and anything under 0.00005 as a flat "0.0000".
 *
 * The sibling ORDER History tab beside it had already been fixed the same way;
 * this tab was missed. Both now resolve their precision through
 * lib/historyPrecision.
 *
 * Guards:
 *   Q1  the reported figure itself: 0.01553693 is shown in full;
 *   Q2  a size far below the old 4dp floor is a number, not a zero;
 *   Q3  the price and the order value use the QUOTE currency's precision;
 *   Q4  a missing figure is a dash, not a fabricated zero.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";

jest.mock("next/image", () => ({
  __esModule: true,
  default: (p: any) => <img {...p} />,
}));
jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark", setTheme: jest.fn() }),
}));
jest.mock("@/lib/toastAlert", () => ({ toastAlert: jest.fn() }));
jest.mock("@/lib/pagination", () => ({
  __esModule: true,
  default: () => <div />,
}));

const apiGetMyTradeHistory = jest.fn();
jest.mock("@/services/history.service", () => ({
  apiGetMyTradeHistory: (...a: any[]) => apiGetMyTradeHistory(...a),
  apiGetMySpotHistory: jest.fn(),
}));

import TradeHistory from "@/components/History/TradeHistory";

const PAIRS = [
  {
    tikerRoot: "BTCUSD",
    firstFloatDigit: 8,
    secondFloatDigit: 2,
  },
];

const ME = "user-1";

const trade = (over: any = {}) => ({
  buyUserId: ME,
  sellUserId: "someone-else",
  buyOrdCode: "100000000859",
  sellOrdCode: "0",
  createdAt: "2026-08-07T00:11:10.928Z",
  pairName: "BTCUSD",
  tradePrice: 64378.01,
  tradeQty: 0.01553693,
  status: "completed",
  ...over,
});

const renderTable = async (rows: any[]) => {
  apiGetMyTradeHistory.mockResolvedValue({
    data: { result: { data: rows, count: rows.length } },
  });
  const store = configureStore({
    reducer: {
      spot: () => ({ pairList: PAIRS }),
      auth: () => ({ user: { _id: ME } }),
    },
  });
  const utils = render(
    <Provider store={store}>
      <TradeHistory />
    </Provider>
  );
  await waitFor(() => expect(apiGetMyTradeHistory).toHaveBeenCalled());
  await screen.findByText("Quantity");
  return utils;
};

/** The cells of the single data row, in column order. */
const cells = () => {
  const rows = Array.from(document.querySelectorAll("tbody tr"));
  const data = rows[rows.length - 1];
  return Array.from(data.querySelectorAll("td")).map((td) =>
    (td.textContent || "").trim()
  );
};

/**
 * A cell BY ITS COLUMN HEADING, not by its position.
 *
 * These used to read the row by index. Removing the "Pair Name" column - it
 * printed the same market on every row, this venue having one - shifted every
 * index after it by one, and the suite failed with a total where a size was
 * expected. The figure was never wrong; the test was counting.
 *
 * Looking the index up from the header means a column added or removed to the
 * LEFT of the one under test cannot break it again.
 */
const cell = (heading: string) => {
  const heads = Array.from(document.querySelectorAll("thead th")).map((th) =>
    (th.textContent || "").trim().toLowerCase()
  );
  const i = heads.findIndex((h) => h.startsWith(heading.toLowerCase()));
  if (i < 0) throw new Error(`no column headed "${heading}" (have: ${heads.join(", ")})`);
  return cells()[i];
};

describe("Q1 the reported figure", () => {
  it("THE BUG: prints 0.01553693, not 0.0155", async () => {
    await renderTable([trade()]);
    await waitFor(() => expect(cells().length).toBeGreaterThan(4));
    const qty = cell("Quantity");
    expect(qty).toBe("0.01553693");
    expect(qty).not.toBe("0.0155");
  });

  it("agrees with what the trade page would print for the same fill", async () => {
    const { formatQty } = require("@/lib/numberFormat");
    await renderTable([trade()]);
    await waitFor(() => expect(cells().length).toBeGreaterThan(4));
    expect(cell("Quantity")).toBe(formatQty(0.01553693, 8, "—"));
  });
});

describe("Q2 sizes the old four places erased", () => {
  it("a 0.00008 BTC fill is not rounded UP to 0.0001", async () => {
    await renderTable([trade({ tradeQty: 0.00008 })]);
    await waitFor(() => expect(cells().length).toBeGreaterThan(4));
    expect(cell("Quantity")).toBe("0.00008");
  });

  it("a dust fill is not printed as zero", async () => {
    await renderTable([trade({ tradeQty: 0.00000123 })]);
    await waitFor(() => expect(cells().length).toBeGreaterThan(4));
    expect(cell("Quantity")).toBe("0.00000123");
    expect(cell("Quantity")).not.toMatch(/^0(\.0+)?$/);
  });

  it("a round size does not grow a tail of zeros", async () => {
    await renderTable([trade({ tradeQty: 2 })]);
    await waitFor(() => expect(cells().length).toBeGreaterThan(4));
    expect(cell("Quantity")).toBe("2");
  });
});

describe("Q3 the quote-currency columns", () => {
  it("prices to the quote currency's own precision, not to four places", async () => {
    await renderTable([trade({ tradePrice: 64378.019 })]);
    await waitFor(() => expect(cells().length).toBeGreaterThan(5));
    expect(cell("Price")).toBe("64378.02");
  });

  it("the order value is price x quantity at the same precision", async () => {
    await renderTable([trade({ tradePrice: 100, tradeQty: 0.01553693 })]);
    await waitFor(() => expect(cells().length).toBeGreaterThan(5));
    expect(cell("Total")).toBe("1.55");
  });
});

describe("Q4 a missing figure", () => {
  it("is a dash rather than a zero", async () => {
    await renderTable([trade({ tradeQty: null, tradePrice: null })]);
    await waitFor(() => expect(cells().length).toBeGreaterThan(4));
    expect(cell("Price")).toBe("—");
    expect(cell("Quantity")).toBe("—");
  });
});
