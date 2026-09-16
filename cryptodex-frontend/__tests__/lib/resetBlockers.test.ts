import { describeResetRefusal } from "@/lib/resetBlockers";

/** The shape spotapi's 409 actually sends (controllers/faucet.controller.js). */
const order = (pairName: string, productLabel = "Spot") => ({
  product: productLabel.toLowerCase(),
  productLabel,
  orderId: "o1",
  pairName,
  side: "buy",
  quantity: 100,
  status: "open",
});
const position = (pairName: string, productLabel = "Spot") => ({
  product: productLabel.toLowerCase(),
  productLabel,
  positionId: "p1",
  pairName,
  side: "buy",
  quantity: 0.05,
});

/** The server's own sentence, which says "Close" for orders too. */
const SERVER_ORDER_MESSAGE =
  "Close your 1 open order first. A reset rewrites your balances, which " +
  "would leave those orders with nothing behind it (Spot ETHUSD).";

/**
 * GUARD 1 — A RESTING ORDER IS CANCELLED, NOT CLOSED
 */
describe("guard: an order blocker is named as an order, with the cancel verb", () => {
  const view = describeResetRefusal(
    { positions: [], orders: [order("ETHUSD")] },
    SERVER_ORDER_MESSAGE
  );

  it("instructs the user to cancel", () => {
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0].kind).toBe("order");
    expect(view.groups[0].instruction).toBe("Cancel your 1 resting order");
  });

  it("never tells the user to close it", () => {
    const printed = view.headline + JSON.stringify(view.groups);
    expect(printed.toLowerCase()).not.toContain("close");
  });

  it("does not mention a position the user does not have", () => {
    const printed = view.headline + JSON.stringify(view.groups);
    expect(printed.toLowerCase()).not.toContain("position");
  });

  it("names the pair so the instruction is actionable", () => {
    expect(view.groups[0].items).toEqual(["Spot ETHUSD"]);
  });

  it("does not repeat the server's sentence, which uses the wrong verb", () => {
    expect(view.headline).not.toBe(SERVER_ORDER_MESSAGE);
    expect(view.headline).not.toContain("Close your");
  });
});

/**
 * GUARD 2 — A POSITION IS CLOSED, NOT CANCELLED
 */
describe("guard: a position blocker is named as a position, with the close verb", () => {
  const view = describeResetRefusal(
    { positions: [position("BTCUSDC")], orders: [] },
    "Close your 1 open position first."
  );

  it("instructs the user to close", () => {
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0].kind).toBe("position");
    expect(view.groups[0].instruction).toBe("Close your 1 open position");
  });

  it("never tells the user to cancel it", () => {
    const printed = view.headline + JSON.stringify(view.groups);
    expect(printed.toLowerCase()).not.toContain("cancel");
  });

  it("does not mention an order the user does not have", () => {
    const printed = view.headline + JSON.stringify(view.groups);
    expect(printed.toLowerCase()).not.toContain("order");
  });
});

/**
 * GUARD 3 — BOTH KINDS ARE LISTED, AND ORDERS COME FIRST
 * Clearing one still leaves the reset refused; being told the second one only
 * after a wasted trip is the same complaint again.
 */
describe("guard: both kinds are listed at once", () => {
  const view = describeResetRefusal(
    {
      positions: [position("BTCUSDC"), position("SOLUSDC")],
      orders: [order("ETHUSD")],
    },
    "Close your 2 open positions and 1 open order first."
  );

  it("lists both groups", () => {
    expect(view.groups.map((g) => g.kind)).toEqual(["order", "position"]);
  });

  it("puts the cheaper action first", () => {
    expect(view.groups[0].instruction).toBe("Cancel your 1 resting order");
    expect(view.groups[1].instruction).toBe("Close your 2 open positions");
  });

  it("mentions both in the headline", () => {
    expect(view.headline).toContain("1 resting order");
    expect(view.headline).toContain("2 open positions");
  });

  it("names every pair once", () => {
    expect(view.groups[1].items).toEqual(["Spot BTCUSDC", "Spot SOLUSDC"]);
  });
});

/**
 * GUARD 4 — PLURALS AGREE WITH THE COUNT
 */
describe("guard: the count and its noun agree", () => {
  it("uses the singular for one", () => {
    const view = describeResetRefusal({ orders: [order("ETHUSD")] }, "x");
    expect(view.groups[0].instruction).toBe("Cancel your 1 resting order");
    expect(view.headline).toContain("1 resting order still holds a reservation");
  });

  it("uses the plural for two", () => {
    const view = describeResetRefusal(
      { orders: [order("ETHUSD"), order("BTCUSD")] },
      "x"
    );
    expect(view.groups[0].instruction).toBe("Cancel your 2 resting orders");
    expect(view.headline).toContain("2 resting orders still hold a reservation");
  });

  it("uses the singular and plural correctly for positions", () => {
    expect(
      describeResetRefusal({ positions: [position("BTCUSDC")] }, "x").headline
    ).toContain("1 open position still stands on margin");
    expect(
      describeResetRefusal(
        { positions: [position("BTCUSDC"), position("ETHUSDC")] },
        "x"
      ).headline
    ).toContain("2 open positions still stand on margin");
  });
});

/**
 * GUARD 5 — WITH NOTHING NAMED, QUOTE THE SERVER RATHER THAN INVENT
 */
describe("guard: nothing is invented when the server names nothing", () => {
  const UNAVAILABLE =
    "Cannot verify your open orders right now, so the reset was not run.";

  it.each([
    ["empty arrays", { positions: [], orders: [], unavailable: ["spot"] }],
    ["absent arrays", { unavailable: ["spot"] }],
    ["null payload", null],
    ["undefined payload", undefined],
    ["non-array fields", { positions: "1", orders: 3 }],
  ])("falls back to the server sentence for %s", (_label, data) => {
    const view = describeResetRefusal(data as any, UNAVAILABLE);
    expect(view.headline).toBe(UNAVAILABLE);
    expect(view.groups).toEqual([]);
  });
});

/**
 * GUARD 6 — LABELS
 */
describe("guard: blocker labels", () => {
  it("de-duplicates two orders on the same pair into one bullet", () => {
    const view = describeResetRefusal(
      { orders: [order("ETHUSD"), order("ETHUSD")] },
      "x"
    );
    expect(view.groups[0].items).toEqual(["Spot ETHUSD"]);
    // The COUNT still says two — one bullet must not hide the second order.
    expect(view.groups[0].instruction).toBe("Cancel your 2 resting orders");
  });

  // The label is the SERVER's word, echoed, not a value this module knows.
  // Spot is the only product the venue lists today; the module must still keep
  // two different labels apart rather than assuming there is only ever one.
  it("keeps two products on the same pair name apart", () => {
    const view = describeResetRefusal(
      { orders: [order("BTCUSD", "Spot"), order("BTCUSD", "Legacy")] },
      "x"
    );
    expect(view.groups[0].items).toEqual(["Spot BTCUSD", "Legacy BTCUSD"]);
  });

  it("drops an unnameable row from the bullets but still counts it", () => {
    const view = describeResetRefusal(
      { orders: [{ orderId: "x" }, order("ETHUSD")] },
      "x"
    );
    expect(view.groups[0].items).toEqual(["Spot ETHUSD"]);
    expect(view.groups[0].instruction).toBe("Cancel your 2 resting orders");
  });

  it("explains the consequence in terms of what the reset does", () => {
    const view = describeResetRefusal({ orders: [order("ETHUSD")] }, "x");
    expect(view.headline).toContain(
      "paid back on top of them rather than returned to where it came from"
    );
  });
});
