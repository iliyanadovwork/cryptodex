/**
 * WHAT THE LOGIN RESPONSE IS ALLOWED TO PUT IN THE STORE.
 * =======================================================
 *
 * userapi's login response carries a `userSetting` block that still describes
 * two products this venue does not have: `showFuture`, `showInverse`,
 * `showOFuture`, `showOInverse` and a `leverage` preference. That payload is
 * userapi's and is not edited from this repository.
 *
 * The frontend used to dispatch the block into the store verbatim, and the
 * `UserSetting` slice is in the redux-persist whitelist - so those five keys
 * were written into every user's localStorage at every login, for a perpetual
 * engine and an inverse engine that were deleted along with every screen that
 * could read them. A persisted setting nothing reads is not neutral: it is the
 * next reader's evidence that the feature is still there.
 *
 * `setUserSetting` therefore drops them, and this pins that it does - including
 * the part that matters more, which is that everything else survives untouched.
 */

import reducer, { setUserSetting } from "@/store/UserSetting/dataSlice";

const loginPayload = {
  defaultTheme: "dark",
  theme: "dark",
  currencySymbol: "USD",
  languageId: "en",
  defaultWallet: "spotBal",
  siteNotification: true,
  // The derivative leftovers.
  showFuture: true,
  showInverse: true,
  showOFuture: false,
  showOInverse: false,
  leverage: 10,
};

const applied = () => reducer(undefined, setUserSetting(loginPayload));

describe("setUserSetting", () => {
  it("keeps every setting the venue can act on", () => {
    const { userSetting } = applied();
    expect(userSetting.theme).toBe("dark");
    expect(userSetting.currencySymbol).toBe("USD");
    expect(userSetting.languageId).toBe("en");
    expect(userSetting.defaultWallet).toBe("spotBal");
    expect(userSetting.siteNotification).toBe(true);
  });

  it("still lifts the default theme out of the payload", () => {
    expect(applied().defaultTheme).toBe("dark");
  });

  it("drops the settings for the two removed products", () => {
    const { userSetting } = applied();
    for (const key of [
      "showFuture",
      "showInverse",
      "showOFuture",
      "showOInverse",
      "leverage",
    ]) {
      expect([key, key in userSetting]).toEqual([key, false]);
    }
  });

  it("survives the empty payload that logout dispatches", () => {
    // `dispatch(setUserSetting({}))` runs on every logout, and `undefined`
    // reaches this reducer if a response ever omits the block. Destructuring
    // either of those must not throw inside a reducer.
    expect(() => reducer(undefined, setUserSetting({}))).not.toThrow();
    expect(() =>
      reducer(undefined, setUserSetting(undefined as any))
    ).not.toThrow();
  });
});
