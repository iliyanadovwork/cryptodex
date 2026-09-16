/**
 * TWO SENTENCES THE PRODUCT NO LONGER MEANT
 * =========================================
 *
 * Both of these are the LAST thing a user reads before committing to an action,
 * and both described behaviour this venue does not have.
 *
 * C1  THE CONFIRM RESET DIALOG said the reset would "cancel every open spot
 *     order". It will not, and the removal of that behaviour is deliberate:
 *     cancelling a resting order refunds its reservation, and a refund landing
 *     on top of the fixed balances a reset writes is how an account went
 *     10,000 -> 48,039.52 over four wins. spotapi now answers 409 while
 *     anything is resting (controllers/faucet.controller.js, codes
 *     OPEN_SPOT_ORDERS). So the sentence promised
 *     both a convenience the product had withdrawn and a disposal of the user's
 *     own orders that it would never perform.
 *
 * C2  THE CHANGE PASSWORD MODAL made the user tick: "I have been informed that
 *     if I log in to this account on a new device after changing the login
 *     password, I will be temporarily unable to withdraw coins within 24
 *     hours." userapi's `changePassword` (controllers/user.controller.js) sets
 *     no timer, touches no wallet and invalidates no session; there is no coin
 *     withdrawal on this venue at all. What IS true is that the redis
 *     `userToken` row holds ONE `tokenId` per account and only a login mints a
 *     new one, so signing in elsewhere ends the session here - and that the app
 *     signs this device out after a successful change.
 *
 * These tests assert the copy against those two behaviours. They do not test
 * the behaviours themselves, which live in spotapi and userapi.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";

jest.mock("next/router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/toastAlert", () => ({ toastAlert: jest.fn() }));
jest.mock("@/services/Wallet/WalletService", () => ({
  faucetReset: jest.fn(),
}));
jest.mock("@/services/User/UserServices", () => ({
  // `apiSendOTP` was mocked here too, for the SMS arm of the change-password
  // modal. That branch and its client went with the phone surface; the modal
  // now has one code path, `apiEmailOTPRequest` -> user/sendOTP roleType 1.
  apiEmailOTPRequest: jest.fn(),
  apiPasswordChange: jest.fn(),
}));
jest.mock("@/lib/stringCase", () => jest.requireActual("@/lib/stringCase"));

import ResetForm from "@/components/Wallet/ResetForm";
import ChangePassword from "@/components/security/ChangePassword";

const store = () =>
  configureStore({
    reducer: {
      wallet: () => ({ assets: [] }),
      auth: () => ({
        user: { _id: "u1", email: "a@b.c", emailStatus: "verified", phoneStatus: "unverified" },
        session: { signedIn: true },
      }),
      UserSetting: () => ({ data: { mode: {} } }),
    },
  });

describe("C1 the Confirm Reset warning describes the reset that exists", () => {
  const openConfirm = () => {
    render(
      <Provider store={store()}>
        <ResetForm />
      </Provider>
    );
    fireEvent.click(screen.getByText("Reset Demo Account", { selector: "label" }));
    return screen.getByTestId("reset-confirm-warning").textContent || "";
  };

  it("no longer promises to cancel the user's resting spot orders", () => {
    const text = openConfirm();
    expect(text).not.toMatch(/cancel every open spot order/i);
    // No promise, in any wording, that the reset will dispose of the user's
    // orders. "Nothing is cancelled ... for you" is the opposite claim and is
    // allowed; a promise to cancel is not.
    expect(text).not.toMatch(/\bcancels?\b/i);
    expect(text).not.toMatch(/\bcancelling\b/i);
  });

  it("says the reset is REFUSED while anything is still open", () => {
    const text = openConfirm();
    expect(text).toMatch(/refused/i);
    expect(text).toMatch(/resting/i);
  });

  it("still names what the reset does do", () => {
    const text = openConfirm();
    expect(text).toMatch(/spot wallet/i);
    expect(text).toMatch(/every other coin balance/i);
  });

  it("names no wallet the venue no longer has", () => {
    // It used to name three: spot, inverse margin and futures. Two of those
    // wallets went with their engines, and a confirm dialog that promises to
    // rewrite a wallet that does not exist is the same class of untrue sentence
    // this file was written about.
    const text = openConfirm();
    expect(text).not.toMatch(/inverse/i);
    expect(text).not.toMatch(/futures/i);
  });
});

describe("C2 the Change Password consent is true of this product", () => {
  const consentText = () => {
    render(
      <Provider store={store()}>
        <ChangePassword password_modal setpassword_modal={jest.fn()} />
      </Provider>
    );
    const box = screen.getByTestId("change-password-consent");
    // react-bootstrap renders the label as a sibling <label> inside the wrapper
    return (box.closest(".form-check") || box.parentElement)?.textContent || "";
  };

  it("does not claim a 24-hour withdrawal hold", () => {
    const text = consentText();
    expect(text).not.toMatch(/24\s*hours?/i);
    expect(text).not.toMatch(/withdraw/i);
  });

  it("does not claim that changing the password ends other sessions", () => {
    const text = consentText();
    // The old line hung its whole promise on logging in "on a new device"
    // AFTER a password change. Nothing about a password change touches a
    // session but this one.
    expect(text).not.toMatch(/new device/i);
  });

  it("states what does happen: signed out here, one session at a time", () => {
    const text = consentText();
    expect(text).toMatch(/sign(s)? me out|signs me out/i);
    expect(text).toMatch(/one signed-in device at a time/i);
  });
});
