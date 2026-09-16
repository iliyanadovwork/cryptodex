/**
 * THE ROUTE GUARD GUARDS THE ROUTES IT NAMES (CRITICAL)
 * =====================================================
 *
 * `middleware.ts` decides, at the edge, whether a request may reach a page at
 * all. It used to ask `protectedRoutes.includes(request.nextUrl.pathname)` — a
 * whole-string equality — against a list that was written in Next's
 * FILE-SYSTEM ROUTE spelling:
 *
 *     '/deposit/[id]'      '/withdraw/[id]'      '/reset-password/[token]'
 *
 * `nextUrl.pathname` is the resolved URL the browser asked for. A literal
 * `[id]` never appears in one, so those three entries matched nothing, ever.
 * And they were the only mention of the deposit and withdraw screens: both are
 * FLAT routes (`pages/deposit.tsx`, `pages/withdraw.tsx`), so both rendered the
 * whole wallet UI to a signed-out visitor around an API answering 401 —
 * balances blank, buttons dead, no explanation.
 *
 * (`/2fa` used to be a third entry here, for the same reason. Two-factor
 * authentication has since been removed from this venue entirely: the page is
 * deleted and `/2fa` now redirects to `/security` from next.config.js, so it
 * is neither protected nor public — it never reaches the middleware. R7 below
 * pins that it is not in either list, because an entry left behind would send
 * a signed-out visitor to /login for a URL that only redirects.)
 *
 * Guards:
 *   R1  every protected page is matched by its real URL;
 *   R2  a dynamic child of a protected route is matched too;
 *   R3  a route is matched on SEGMENT boundaries, not as a string prefix;
 *   R4  a trailing slash is the same page;
 *   R5  public pages are not caught by either list;
 *   R6  no entry is written in the `[param]` spelling that cannot match.
 */

import {
  authRoutes,
  protectedRoutes,
  matchesRoute,
} from "@/components/Router/routes";

describe("the edge route guard (CRITICAL)", () => {
  test("R1 - the pages that need a session are all matched by their real URL", () => {
    // /deposit and /withdraw used to be this list's only mention of the faucet
    // and the reset. Both pages were RENAMED during the paper conversion
    // (/faucet, /reset) and next.config.js redirects the old URLs, so the two
    // entries guarded paths with no page while the pages themselves were open
    // to anyone - the same bug the `[id]` spellings caused, one rename later.
    // /history joined the list for the same reason: every panel on it is a
    // per-account read, and /deactive because both endpoints behind it are
    // authenticated and act only on the caller's own account.
    for (const url of [
      "/faucet",
      "/reset",
      "/history",
      "/deactive",
      "/wallet",
      "/security",
    ]) {
      expect({ url, guarded: matchesRoute(protectedRoutes, url) }).toEqual({
        url,
        guarded: true,
      });
    }
  });

  test("R2 - a parameterised child of a protected route is guarded by the parent", () => {
    // This is what the `[id]` entries were reaching for and never achieved.
    expect(matchesRoute(protectedRoutes, "/faucet/695bc8cd25bf5f8d3d11f2e4")).toBe(
      true
    );
    expect(matchesRoute(protectedRoutes, "/history/spot")).toBe(true);
    expect(matchesRoute(protectedRoutes, "/wallet/spot/history")).toBe(true);
    // Same for the signed-in redirect list: /reset-password/<token> is the only
    // form that route is ever requested in.
    expect(matchesRoute(authRoutes, "/reset-password/9f2c3a1e")).toBe(true);
  });

  test("R3 - matching is on segment boundaries, not on string prefixes", () => {
    // A bare `startsWith` would guard these, which is a different bug in the
    // other direction: pages nobody meant to protect become unreachable.
    expect(matchesRoute(protectedRoutes, "/faucets")).toBe(false);
    expect(matchesRoute(protectedRoutes, "/resetting")).toBe(false);
    // The real one this protects: /reset-password is a SIGNED-OUT page, and a
    // prefix match against /reset would bounce every password-reset link to
    // /login - the one place the user cannot get to.
    expect(matchesRoute(protectedRoutes, "/reset-password/9f2c3a1e")).toBe(false);
    expect(matchesRoute(protectedRoutes, "/security-policy")).toBe(false);
    expect(matchesRoute(authRoutes, "/registered")).toBe(false);
  });

  test("R9 - the renamed money screens are guarded by their new names, not their old ones", () => {
    // next.config.js redirects /deposit -> /faucet and /withdraw -> /reset.
    // Guarding the old paths protected nothing (there is no page there) and
    // left the real pages open; both entries are gone.
    for (const url of ["/deposit", "/withdraw"]) {
      expect({ url, protectedHit: matchesRoute(protectedRoutes, url) }).toEqual({
        url,
        protectedHit: false,
      });
    }
  });

  test("R4 - a trailing slash is the same page", () => {
    expect(matchesRoute(protectedRoutes, "/wallet/")).toBe(true);
    // And "/" itself is not swallowed by the normalisation.
    expect(matchesRoute(protectedRoutes, "/")).toBe(false);
    expect(matchesRoute(authRoutes, "/")).toBe(false);
  });

  test("R8 - the removed help and phone screens are in neither list", () => {
    // /support-ticket, /faq and /contactus were deleted with the endpoints
    // behind them (user/support, user/getSupportCategory, user/faq,
    // user/addContactus). A leftover `protectedRoutes` entry would send a
    // signed-out visitor through /login on the way to a 404, which reads as a
    // page they lack permission for rather than one that is gone.
    for (const url of ["/support-ticket", "/faq", "/contactus"]) {
      expect({ url, protectedHit: matchesRoute(protectedRoutes, url) }).toEqual({
        url,
        protectedHit: false,
      });
      expect({ url, authHit: matchesRoute(authRoutes, url) }).toEqual({
        url,
        authHit: false,
      });
    }
  });

  test("R7 - the removed identity screens are in neither list", () => {
    // /2fa, /kyc and /log-session are redirects now (next.config.js), not
    // pages. A leftover entry in either list would make the middleware bounce a
    // signed-out visitor to /login for a URL that exists only to forward them.
    for (const url of ["/2fa", "/kyc", "/log-session"]) {
      expect(matchesRoute(protectedRoutes, url)).toBe(false);
      expect(matchesRoute(authRoutes, url)).toBe(false);
    }
  });

  test("R5 - public pages are caught by neither list", () => {
    for (const url of [
      "/",
      "/login",
      "/market",
      "/spot/BTC_USDT",
    ]) {
      expect({ url, protectedHit: matchesRoute(protectedRoutes, url) }).toEqual({
        url,
        protectedHit: false,
      });
      expect({ url, authHit: matchesRoute(authRoutes, url) }).toEqual({
        url,
        authHit: false,
      });
    }
    // A garbage pathname is not a match either, rather than throwing inside the
    // middleware and letting the request through unguarded.
    expect(matchesRoute(protectedRoutes, "")).toBe(false);
    expect(matchesRoute(protectedRoutes, undefined as any)).toBe(false);
  });

  test("R6 - no entry is written in a spelling that cannot match a pathname", () => {
    const unmatchable = [...protectedRoutes, ...authRoutes].filter(
      (r) => r.includes("[") || r.includes("]") || !r.startsWith("/")
    );
    expect(unmatchable).toEqual([]);
  });
});
