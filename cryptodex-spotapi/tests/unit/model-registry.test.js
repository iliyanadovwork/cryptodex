/**
 * Pins every models/index.js export to the mongo collection it resolves to.
 *
 * WHY THIS EXISTS
 * ===============
 * The barrel used to export two models under names that meant the opposite of
 * what they said:
 *
 *     SpotTrade         -> collection `spotOrder`     (live / open orders)
 *     SpotOrder         -> collection `orderHistory`
 *     spotOrderHistory  -> collection `orderHistory`  (same model, second alias)
 *
 * So `SpotOrder` was the order-HISTORY table. Every consumer had to remember the
 * inversion, and getting it wrong reads or writes the wrong collection - silently,
 * because both documents carry userId / pairId / status and would look plausible.
 * Nothing in this codebase would catch that: there are no types on these models,
 * and mongoose will happily query either.
 *
 * The names now match the collections. This test is what keeps them matched: it
 * asserts the MAPPING, not the spelling, so a future rename that re-inverts them
 * fails here rather than in production.
 *
 * Registering a mongoose model does not open a connection, so this needs no
 * database.
 */
import { describe, it, expect } from "@jest/globals";
import * as models from "../../models/index.js";

/** export name -> the collection it must resolve to. */
const EXPECTED = {
  SpotPair: "spotpair",
  SpotOrder: "spotOrder",
  OrderHistory: "orderHistory",
  FavPair: "favouritepair",
  TradeHistory: "tradeHistory",
  TradeBot: "tradeBot",
  VolumeBot: "volumeBot",
  SequenceId: "sequenceId",
  DepositEvent: "depositevents",
  WithdrawalEvent: "withdrawalevents",
};

const collectionOf = (m) =>
  m && m.collection ? m.collection.collectionName : null;

describe("models/index.js registry", () => {
  it.each(Object.entries(EXPECTED))(
    "%s resolves to collection %s",
    (name, collection) => {
      expect(collectionOf(models[name])).toBe(collection);
    }
  );

  it("SpotOrder is the live order table, NOT order history", () => {
    // The exact inversion this file exists to prevent.
    expect(collectionOf(models.SpotOrder)).toBe("spotOrder");
    expect(collectionOf(models.SpotOrder)).not.toBe("orderHistory");
  });

  it("OrderHistory is the history table, NOT the live order table", () => {
    expect(collectionOf(models.OrderHistory)).toBe("orderHistory");
    expect(collectionOf(models.OrderHistory)).not.toBe("spotOrder");
  });

  it("no two exports are aliases for the same model", () => {
    // `SpotOrder` and `spotOrderHistory` used to be one model under two names.
    const modelExports = Object.entries(models).filter(
      ([, v]) => collectionOf(v) !== null
    );
    const seen = new Map();
    for (const [name, m] of modelExports) {
      const c = collectionOf(m);
      expect(seen.has(c)).toBe(false);
      seen.set(c, name);
    }
  });

  it("the removed aliases stay removed", () => {
    expect(models.SpotTrade).toBeUndefined();
    expect(models.spotOrderHistory).toBeUndefined();
  });

  it("ChartSchema is a bare Schema, not a model", () => {
    // chartdoc.js exports a Schema that consumers bind to a collection at
    // runtime; treating it as a model would throw at the first query.
    expect(collectionOf(models.ChartSchema)).toBeNull();
  });
});
