/**
 * spot.lastTrade — the authoritative "what just traded here".
 *
 * Written from the live `recentTrade` stream, read by the headline price and
 * by the order book's last-price marker. Both of those used to read
 * `marketData.markPrice`, which spotapi republishes on a 30 SECOND cron, so
 * they drifted a whole cycle away from the ladder and the trade log they sit
 * beside.
 *
 * The trade stream fires many times a second and every accepted write
 * re-renders the header, the marker and the order ticket, so the reducer's job
 * is as much about refusing writes as recording them.
 */

import reducer, { setLastTrade } from "@/store/trade/dataSlice";

const PAIR_A = "695bf1017573eeb15a749c9d";
const PAIR_B = "695bf1017573eeb15a749c9f";

const EMPTY = { pairId: null, price: null, at: 0 };
const stateWith = (lastTrade: any) => ({ lastTrade } as any);

describe("setLastTrade", () => {
  it("records an executed price", () => {
    const next = reducer(
      stateWith(EMPTY),
      setLastTrade({ pairId: PAIR_A, price: 64730.5 })
    );
    expect(next.lastTrade.pairId).toBe(PAIR_A);
    expect(next.lastTrade.price).toBe(64730.5);
    expect(next.lastTrade.at).toBeGreaterThan(0);
  });

  it("parses a numeric string price", () => {
    const next = reducer(
      stateWith(EMPTY),
      setLastTrade({ pairId: PAIR_A, price: "64730.50" })
    );
    expect(next.lastTrade.price).toBe(64730.5);
  });

  it("keeps the same object when the price has not moved", () => {
    // The identity check is what stops a fill-heavy second from re-rendering
    // the whole header on every message.
    const state = stateWith({ pairId: PAIR_A, price: 100, at: 1 });
    const next = reducer(state, setLastTrade({ pairId: PAIR_A, price: 100 }));
    expect(next.lastTrade).toBe(state.lastTrade);
  });

  it("writes when the same pair moves", () => {
    const state = stateWith({ pairId: PAIR_A, price: 100, at: 1 });
    const next = reducer(state, setLastTrade({ pairId: PAIR_A, price: 101 }));
    expect(next.lastTrade.price).toBe(101);
  });

  it("writes when an equal price arrives for a DIFFERENT pair", () => {
    // Same number, different market. Skipping this would leave the slot
    // labelled with the old pair and the reader would fall back for ever.
    const state = stateWith({ pairId: PAIR_A, price: 100, at: 1 });
    const next = reducer(state, setLastTrade({ pairId: PAIR_B, price: 100 }));
    expect(next.lastTrade.pairId).toBe(PAIR_B);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["non-numeric", "abc"],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("refuses a %s price and keeps the last good one", (_label, price) => {
    const good = { pairId: PAIR_A, price: 100, at: 1 };
    const next = reducer(stateWith(good), setLastTrade({ pairId: PAIR_A, price }));
    expect(next.lastTrade).toBe(good);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
  ])("refuses a payload with a %s pairId", (_label, pairId) => {
    const good = { pairId: PAIR_A, price: 100, at: 1 };
    const next = reducer(stateWith(good), setLastTrade({ pairId, price: 200 }));
    expect(next.lastTrade).toBe(good);
  });

  it("tolerates a payload that is missing entirely", () => {
    const good = { pairId: PAIR_A, price: 100, at: 1 };
    expect(() => reducer(stateWith(good), setLastTrade(undefined))).not.toThrow();
    expect(reducer(stateWith(good), setLastTrade(undefined)).lastTrade).toBe(good);
  });
});
