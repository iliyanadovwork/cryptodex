/**
 * THE PAGE EVERY MAILED LINK LANDS ON, WHICH ONLY EVER HANDLED SUCCESS.
 * ====================================================================
 *
 * pages/verification/[id].js rendered exactly two things: a bare `<p>Loading</p>`
 * and a bare `<p>Invalid Url</p>`. Every failure fired a toast at the same
 * moment as a `history.push` to another route, so the reason raced a
 * navigation and the user landed somewhere that never explained anything.
 *
 * Three shapes of broken link, all of which a real user produces:
 *
 *   EXPIRED / ALREADY USED   400 from the API -> toast + push, no explanation
 *                            left on screen and nowhere to get a new link.
 *   MISTYPED / GARBAGE       userapi could not decrypt it, threw a mongoose
 *                            CastError and answered HTTP 500 "Error on server"
 *                            - the product blaming itself for a typo. (Fixed
 *                            server-side too: `userFromMailToken` in userapi
 *                            controllers/auth.controller.js.)
 *   TRUNCATED / NO TOKEN     a link cut short by a mail client arrives with
 *                            `auth` undefined; the request went out anyway,
 *                            the error had no `message`, and the page sat on
 *                            "Loading" for ever. It did the same for any `id`
 *                            the file did not recognise.
 *
 * These tests hold the property that replaced all of it: THE PAGE ALWAYS
 * TERMINATES, and when it terminates badly it says why and offers a route
 * back to the flow that can issue a new link.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

const userEmailActivation = jest.fn();
const resetPasswordVerification = jest.fn();
const push = jest.fn();

let query: Record<string, any> = {};
let isReady = true;

jest.mock("next/router", () => ({
  useRouter: () => ({ push, query, isReady, pathname: "/verification/[id]" }),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));
jest.mock("@/components/navbar", () => ({
  __esModule: true,
  default: () => <div data-testid="navbar" />,
}));
jest.mock("../../services/User/AuthService", () => ({
  userEmailActivation: (...a: any[]) => userEmailActivation(...a),
  resetPasswordVerification: (...a: any[]) => resetPasswordVerification(...a),
}));
jest.mock("../../lib/toastAlert", () => ({ toastAlert: jest.fn() }));

import EmailVerification from "@/pages/verification/[id]";

const rejectWith = (status: number, message?: string) =>
  Promise.reject({ response: { status, data: message ? { message } : {} } });

beforeEach(() => {
  userEmailActivation.mockReset();
  resetPasswordVerification.mockReset();
  push.mockReset();
  query = {};
  isReady = true;
});

describe("it always terminates - the bare Loading is gone", () => {
  test("an unrecognised id ends in an explained error, not a spinner", async () => {
    query = { id: "nonsense", auth: "TOKEN" };
    render(<EmailVerification />);

    const error = await screen.findByTestId("verification-error");
    expect(error.textContent).toMatch(/not one we recognise/i);
    expect(screen.queryByTestId("verification-working")).toBeNull();
    // ...and it does not ask a server about a route it does not know.
    expect(userEmailActivation).not.toHaveBeenCalled();
    expect(resetPasswordVerification).not.toHaveBeenCalled();
  });

  test("a truncated link with no token is named as such, before any request", async () => {
    query = { id: "register" };
    render(<EmailVerification />);

    const error = await screen.findByTestId("verification-error");
    expect(error.textContent).toMatch(/cut short|missing its token/i);
    expect(userEmailActivation).not.toHaveBeenCalled();
  });

  test("an empty token is treated the same way", async () => {
    query = { id: "forgotPassword", auth: "   " };
    render(<EmailVerification />);

    await screen.findByTestId("verification-error");
    expect(resetPasswordVerification).not.toHaveBeenCalled();
  });

  test("before the router is ready it waits, rather than declaring the link broken", async () => {
    // `router.query` is empty on the first render of a dynamic route. Acting on
    // it then made every correct link look broken for an instant.
    isReady = false;
    query = {};
    render(<EmailVerification />);

    expect(screen.getByTestId("verification-working")).toBeInTheDocument();
    expect(screen.queryByTestId("verification-error")).toBeNull();
  });
});

describe("activation", () => {
  test("a good token verifies and moves the user to sign in", async () => {
    query = { id: "register", auth: "GOODTOKEN" };
    userEmailActivation.mockResolvedValue({
      data: { success: true, message: "Your email has been verified, you can now log in" },
    });
    render(<EmailVerification />);

    const ok = await screen.findByTestId("verification-success");
    expect(ok.textContent).toMatch(/verified/i);
    expect(userEmailActivation).toHaveBeenCalledWith({ userId: "GOODTOKEN" });
    // The success screen is deliberately held for a beat before we navigate,
    // so the user sees WHY they arrived at the login page.
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"), { timeout: 3000 });
  });

  test("an expired token explains itself and stays put, offering a new link", async () => {
    query = { id: "register", auth: "EXPIRED" };
    userEmailActivation.mockReturnValue(
      rejectWith(400, "This activation link has expired. Request a new one from the register page.")
    );
    render(<EmailVerification />);

    const error = await screen.findByTestId("verification-error");
    expect(error.textContent).toMatch(/expired/i);
    // The reason is not thrown away by a navigation.
    expect(push).not.toHaveBeenCalled();
    const actions = screen.getByTestId("verification-actions");
    expect(actions.textContent).toMatch(/new activation link/i);
    expect(actions.querySelector('a[href="/register"]')).not.toBeNull();
  });

  test("an error with no message still explains something (SERVER 500)", async () => {
    // The old page read `error.response.data.message` blind. A 500 with no
    // body, or a network failure with no `response` at all, threw inside the
    // catch and left the page on "Loading".
    query = { id: "register", auth: "GARBAGE" };
    userEmailActivation.mockReturnValue(Promise.reject(new Error("Network Error")));
    render(<EmailVerification />);

    const error = await screen.findByTestId("verification-error");
    expect(error.textContent.trim().length).toBeGreaterThan(0);
    expect(screen.queryByTestId("verification-working")).toBeNull();
  });

  test("a 200 that is not a success is an error, not a permanent spinner", async () => {
    query = { id: "register", auth: "ODD" };
    userEmailActivation.mockResolvedValue({ data: { success: false } });
    render(<EmailVerification />);

    await screen.findByTestId("verification-error");
    expect(screen.queryByTestId("verification-working")).toBeNull();
  });
});

describe("password reset", () => {
  test("a good token moves the user on to set a new password", async () => {
    query = { id: "forgotPassword", auth: "RESET123" };
    resetPasswordVerification.mockResolvedValue({
      data: { success: true, message: "you can now change password" },
    });
    render(<EmailVerification />);

    await screen.findByTestId("verification-success");
    expect(resetPasswordVerification).toHaveBeenCalledWith({ authToken: "RESET123" });
    await waitFor(
      () => expect(push).toHaveBeenCalledWith("/reset-password/RESET123"),
      { timeout: 3000 }
    );
  });

  test("a used-up reset link offers the way to start another one", async () => {
    query = { id: "forgotPassword", auth: "USED" };
    resetPasswordVerification.mockReturnValue(rejectWith(400, "Your link was expired"));
    render(<EmailVerification />);

    const error = await screen.findByTestId("verification-error");
    expect(error.textContent).toMatch(/expired/i);
    expect(push).not.toHaveBeenCalled();
    const actions = screen.getByTestId("verification-actions");
    expect(actions.querySelector('a[href="/forget"]')).not.toBeNull();
  });
});
