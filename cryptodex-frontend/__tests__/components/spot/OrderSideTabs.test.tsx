/**
 * THE BUY / SELL SELECTOR IS A REAL TABLIST.
 * ==========================================
 *
 * It used to be two <li onClick> elements. An <li> is not focusable and has no
 * implicit role, so the control that decides whether you are BUYING or SELLING
 * could not be reached or operated from a keyboard at all, and announced
 * nothing to a screen reader about which side was active.
 *
 * It is now two <button role="tab"> in a role="tablist", with aria-selected
 * carrying the state. The sliding rule beside them is aria-hidden, because it
 * says the same thing aria-selected already does.
 */
import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import OrderForm from "@/components/spot/OrderForm";

jest.mock("@/store", () => {
  const actual = jest.requireActual("react-redux");
  return { useSelector: actual.useSelector, useDispatch: actual.useDispatch };
});

// The tickets themselves are exercised by their own suites; this is about the
// selector above them.
jest.mock("@/components/spot/LimitOrder", () => ({
  __esModule: true,
  default: () => <div data-testid="limit-ticket" />,
}));
jest.mock("@/components/spot/MarketOrder", () => ({
  __esModule: true,
  default: () => <div data-testid="market-ticket" />,
}));

const socket = { on: jest.fn(), off: jest.fn(), emit: jest.fn() };

const renderForm = () => {
  const SocketContext = require("@/components/Context/SocketContext").default;
  const store = configureStore({
    reducer: {
      spot: (
        state = {
          tradePair: { taker_fees: 0.1, maker_rebate: 0.02 },
          firstCurrency: { currencyId: "a" },
          secondCurrency: { currencyId: "b" },
        }
      ) => state,
    },
  });
  return render(
    <Provider store={store}>
      <SocketContext.Provider value={{ spotSocket: socket } as any}>
        <OrderForm />
      </SocketContext.Provider>
    </Provider>
  );
};

describe("order side selector", () => {
  it("exposes both sides as tabs, with Buy selected to begin with", () => {
    renderForm();
    // Scoped by name: the Limit/Market nav below is a tablist too.
    const sideTabs = screen.getByRole("tablist", { name: "Order side" });
    const tabs = within(sideTabs).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Buy", "Sell"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  });

  it("moves the selection when a side is chosen", () => {
    renderForm();
    fireEvent.click(screen.getByRole("tab", { name: "Sell" }));
    expect(screen.getByRole("tab", { name: "Sell" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Buy" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("is operable from the keyboard - the <li> version was not", () => {
    renderForm();
    const sell = screen.getByRole("tab", { name: "Sell" });
    // A <button> is focusable and fires click on Enter/Space; an <li> does
    // neither, which is what this replaced.
    expect(sell.tagName).toBe("BUTTON");
    sell.focus();
    expect(sell).toHaveFocus();
  });

  it("drives the styling from one data-side attribute, not two class swaps", () => {
    renderForm();
    const list = screen.getByRole("tablist", { name: "Order side" });
    expect(list.dataset.side).toBe("buy");
    fireEvent.click(screen.getByRole("tab", { name: "Sell" }));
    expect(list.dataset.side).toBe("sell");
  });

  it("gives the order type the same tablist, in neutral", () => {
    renderForm();
    const typeTabs = screen.getByRole("tablist", { name: "Order type" });
    const tabs = within(typeTabs).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Limit", "Market"]);
    // Market is the ticket's default.
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs.every((t) => t.tagName === "BUTTON")).toBe(true);
  });

  it("actually switches the ticket when the order type changes", () => {
    // Tab.Container is CONTROLLED now (it used to own defaultActiveKey), so a
    // mis-wired activeKey would move the underline while leaving the wrong
    // ticket on screen - which no styling test would catch.
    renderForm();
    const typeTabs = screen.getByRole("tablist", { name: "Order type" });

    expect(screen.getByTestId("market-ticket").closest(".tab-pane")).toHaveClass(
      "active"
    );

    fireEvent.click(within(typeTabs).getByRole("tab", { name: "Limit" }));

    expect(within(typeTabs).getByRole("tab", { name: "Limit" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(typeTabs.dataset.type).toBe("limit");
    expect(screen.getByTestId("limit-ticket").closest(".tab-pane")).toHaveClass(
      "active"
    );
  });

  it("keeps the two rows independent - side does not move the type", () => {
    renderForm();
    const typeTabs = screen.getByRole("tablist", { name: "Order type" });
    fireEvent.click(screen.getByRole("tab", { name: "Sell" }));
    expect(typeTabs.dataset.type).toBe("market");
    expect(
      screen.getByRole("tablist", { name: "Order side" }).dataset.side
    ).toBe("sell");
  });
});
