/**
 * THE /security ROWS (CRITICAL)
 * =============================
 *
 * WHAT THIS FILE USED TO GUARD, AND WHY IT CHANGED
 * ------------------------------------------------
 * It was written for a reported defect: the page showed "Asset Password" as a
 * Pending item with an Add button that led nowhere useful — a permanent false
 * to-do the user could not resolve. The row went, and a Two-Factor
 * Authentication row took its place, because /2fa was fully implemented and
 * had no link anywhere in the product.
 *
 * This venue has since been narrowed to spot-only paper trading, and the whole
 * identity/security surface went with that: 2FA, the anti-phishing code, KYC,
 * the login journal and the login IP blocklist. So the page is down to the two
 * things it can honestly offer — the password you sign in with, and the address
 * it can reach you at.
 *
 * ON 2FA SPECIFICALLY, because the record matters and the brief that ordered
 * the removal got it backwards: **2FA WORKED when it was removed.** It was
 * verified live against the running stack first — with an authenticator
 * enrolled, a login with no code got the TWO_FA challenge and no token, a wrong
 * code got 400 and no token, and only a correct TOTP got in. An earlier round
 * had shipped it broken and an earlier round had fixed it. Taking it out now
 * was a scope decision about a venue with imaginary money, NOT a bug fix, and
 * nobody reading this later should believe otherwise.
 *
 * Guards, in the same spirit as before — every "Pending" a user sees must
 * belong to a control that does something:
 *   R1  the removed rows are gone, and none of their modals is mounted;
 *   R2  the page still renders and still manages what it can;
 *   R3  no unresolvable "Pending" survives;
 *   R4  nothing on the page claims 2FA, KYC or anti-phishing protects anything;
 *   R5  the security-level meter is gone rather than pinned to "Low".
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";

const push = jest.fn();
// jest.setup.js stubs @/lib/stringCase down to `capitalize`, which leaves
// `emailFormat` undefined and makes this page throw on render.
jest.mock("@/lib/stringCase", () => jest.requireActual("@/lib/stringCase"));
jest.mock("next/image", () => ({
  __esModule: true,
  default: (p: any) => <img {...p} />,
}));
jest.mock("next/router", () => ({
  useRouter: () => ({ push, query: {} }),
}));
jest.mock("@/lib/toastAlert", () => ({ toastAlert: jest.fn() }));
jest.mock("@/components/navbar", () => ({
  __esModule: true,
  default: () => <div />,
}));
jest.mock("@/components/security/ChangePassword", () => ({
  __esModule: true,
  default: () => <div data-testid="change-password-modal" />,
}));
// BindEmail and AssetPassword are no longer modules in this tree, so they
// cannot be jest.mock'd by path any more. R1 and R6 below assert their absence
// from what the page renders instead, which is the fact that matters.

import Security from "@/pages/security";

const renderPage = (user: any = {}) => {
  const store = configureStore({
    reducer: {
      auth: () => ({
        session: { signedIn: true },
        user: {
          emailStatus: "verified",
          email: "papersmoke1@test.com",
          userId: "11286524",
          ...user,
        },
      }),
    },
  });
  return render(
    <Provider store={store}>
      <Security />
    </Provider>
  );
};

describe("R1 the removed rows are gone", () => {
  it.each([
    ["asset password", /asset password/i],
    ["two-factor authentication", /two-factor authentication/i],
    ["anti-phishing code", /anti-?phishing/i],
    ["identity verification", /identity verification|kyc/i],
    ["security level", /security level/i],
    ["IP address", /ip address/i],
  ])("no %s row", (_label, pattern) => {
    renderPage();
    expect(screen.queryByText(pattern)).toBeNull();
  });

  it("none of their modals is mounted", () => {
    renderPage();
    expect(screen.queryByTestId("asset-password-modal")).toBeNull();
    expect(screen.queryByTestId("bind-email-modal")).toBeNull();
    // The anti-phishing modal is not even imported any more; if it came back
    // its text would show up in the query above.
  });

  it("the 2FA row and its button are gone by test id, not just by label", () => {
    renderPage();
    expect(screen.queryByTestId("security-2fa-row")).toBeNull();
    expect(screen.queryByTestId("security-2fa-button")).toBeNull();
  });
});

describe("R2 the page still manages what it can", () => {
  it("offers the password and the way out, and nothing that does nothing", () => {
    renderPage();
    expect(screen.getByText(/login password/i)).toBeTruthy();
    expect(screen.getByText(/deactivate account/i)).toBeTruthy();
    // A "Secure Email" card sat between them with no action at all. Its badge
    // could only read Completed - login is refused unless the address is
    // verified - and it reprinted an address the header already shows.
    expect(screen.queryByText(/secure email/i)).toBeNull();
  });

  it("offers exactly one control, and it is the one that works", () => {
    // The change-password modal is a next/dynamic import and does not resolve
    // in a synchronous render, so the button that opens it is what is
    // asserted.
    //
    // There used to be TWO. The second opened the Set-email-ID modal, and it
    // could not be completed by anybody: userapi's `emailUpdate` verifies the
    // code with `optVerification(1, ...)`, which reads the SMS field that only
    // the removed roleType-2 sender ever wrote. Its own body was gated on
    // `phoneStatus == "verified"` besides, which nothing on this venue can set.
    // A button whose dialog cannot be finished reads as a task the user has
    // failed, which is the exact class of defect this file exists to catch.
    renderPage();
    const labels = screen.getAllByText(/^(Modify|Add)$/);
    expect(labels.length).toBe(1);
    expect(labels[0].textContent).toBe("Modify");
  });

  it("names the account, once and in full", () => {
    renderPage();
    // The address was rendered three times - masked as the display name, in
    // full beside it, and masked again inside the Secure Email card. One
    // unmasked rendering is the whole of what this page needs to say.
    const shown = screen.getAllByText(/papersmoke1@test\.com/);
    expect(shown).toHaveLength(1);
    // The UID went with the support surface that asked for it.
    expect(screen.queryByText("11286524")).toBeNull();
  });
});

describe("R7 the account can be closed from the screen that manages the account", () => {
  /**
   * /deactive was an ORPHAN. userapi implements the whole flow - an e-mailed
   * code, then a teardown ordered so that every reversible step commits before
   * any irreversible one - and nothing in the product linked to the page, so a
   * user could only reach it by typing the URL. A feature nobody can find is
   * indistinguishable from one that does not exist.
   */
  it("offers a route to it", () => {
    renderPage();
    expect(screen.getByTestId("security-deactivate-link")).toBeTruthy();
  });

  it("goes to the page, and to that page only", () => {
    renderPage();
    screen.getByTestId("security-deactivate-link").click();
    expect(push).toHaveBeenCalledWith("/deactive");
  });

  it("says what deactivating actually does, since it cancels the user's orders", () => {
    renderPage();
    const copy = screen.getByTestId("security-deactivate-copy").textContent || "";
    expect(copy).toMatch(/cancel/i);
    expect(copy).toMatch(/code/i);
  });
});

describe("R3 no unresolvable Pending survives", () => {
  it("a verified account has no Pending at all", () => {
    renderPage({ emailStatus: "verified" });
    expect(screen.queryAllByText(/pending/i)).toHaveLength(0);
  });

  /*
   * A test for the "Pending" an unverified account would see stood here. That
   * state is unreachable: userapi refuses a login unless `status` is
   * "verified" (auth.controller.js:810), and across every account on this
   * stack `emailStatus` and `status` have never differed - so nobody can be
   * signed in, on this page, unverified. The badge that could only read
   * Completed is gone with the card that carried it, and the test that
   * rendered the other branch directly was describing a screen no user can
   * open.
   */
});

describe("R6 nothing on the page offers a phone", () => {
  it("no mobile row, no SMS, no phone number field", () => {
    renderPage();
    const text = document.body.textContent || "";
    expect(text).not.toMatch(/secure phone/i);
    expect(text).not.toMatch(/\bmobile\b/i);
    expect(text).not.toMatch(/\bsms\b/i);
    expect(text).not.toMatch(/phone number/i);
  });

  it("an unverified account is not shown an empty phone field instead", () => {
    // The email block used to fall through to a Mobile row printing
    // `user.phoneNo`, a field this venue never populates.
    renderPage({ emailStatus: "unverified", phoneNo: "" });
    expect(document.body.textContent).not.toMatch(/mobile/i);
  });
});

describe("R4 the page makes no claim it cannot keep", () => {
  it("never says an authenticator code is required to sign in", () => {
    renderPage();
    expect(
      screen.queryByText(/authenticator code is required/i)
    ).toBeNull();
    expect(document.body.textContent).not.toMatch(/authenticator/i);
  });

  it("never mentions a second factor at all", () => {
    renderPage();
    expect(document.body.textContent).not.toMatch(/\b2fa\b/i);
    expect(document.body.textContent).not.toMatch(/two-factor/i);
  });
});

describe("R5 the security meter is gone rather than stuck", () => {
  it("prints no level, high or low", () => {
    renderPage({ emailStatus: "verified" });
    const text = document.body.textContent || "";
    expect(text).not.toMatch(/security level/i);
    // A meter scoring four factors when three of them no longer exist could
    // only ever have read "Low", which is the defect its predecessor was
    // written to kill. It is removed, not re-pinned.
    expect(screen.queryByText(/^(High|Middle|Low)$/)).toBeNull();
  });
});
