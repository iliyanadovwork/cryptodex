/**
 * LOGGING OUT MUST LEAVE NO USABLE TOKEN BEHIND.
 *
 * Login writes the JWT to three places (redux-persist "user", localStorage
 * "authToken", the "userToken" cookie). Both logout paths used to clear only
 * some of them - the navbar button left the userToken cookie AND authToken, the
 * idle timeout left authToken - so the Wallet/Spot/User API clients kept
 * re-attaching a valid token after "logout". clearClientSession is the single
 * routine both now call; this pins that it removes ALL of them.
 */
import { clearClientSession } from "@/utils/clearSession";

describe("clearClientSession", () => {
  beforeEach(() => {
    localStorage.setItem("user", JSON.stringify({ token: "jwt" }));
    localStorage.setItem("authToken", "jwt-value");
    document.cookie = "userToken=jwt-value; Path=/";
    document.cookie = "loggedin=true; Path=/";
  });

  it("removes BOTH user and authToken from localStorage (authToken was the leak)", () => {
    expect(localStorage.getItem("authToken")).toBe("jwt-value");
    clearClientSession();
    expect(localStorage.getItem("user")).toBeNull();
    expect(localStorage.getItem("authToken")).toBeNull();
  });

  it("expires the userToken and loggedin cookies", () => {
    clearClientSession();
    expect(document.cookie).not.toMatch(/userToken=/);
    expect(document.cookie).not.toMatch(/loggedin=/);
  });

  it("does not throw when there is nothing to clear", () => {
    localStorage.clear();
    expect(() => clearClientSession()).not.toThrow();
  });
});
