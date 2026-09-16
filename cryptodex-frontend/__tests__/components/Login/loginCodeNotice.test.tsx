/**
 * THE FRONT DOOR HAS THE SAME FAILURE MODE AS THE RECOVERY SURFACES.
 * =================================================================
 *
 * Sign-in can ask for a six-digit code as a second step. That branch is
 * skipped entirely while userapi runs with TEST_MODE=true - which is how this
 * venue runs - so it does not bite here. It matters for the OTHER way delivery
 * is switched off: `mailDeliveryMode` (userapi lib/mailDelivery.js) also goes
 * log-only on DEV_EMAIL_BYPASS=true alone, and the skip in `userLogin` does not
 * consult that flag. On such a run registration, password reset and password
 * change would all work and LOGIN would be impossible: a code demanded, and
 * "sent" by a gateway that only writes to a log.
 *
 * /api/auth/login now reports `delivered` and, having already verified the
 * password, returns the code it could not deliver. This form renders it.
 *
 * The production direction is pinned: a build that printed the login code on
 * screen when the server says it DID mail it would be defeating the point of
 * the second step.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

const apiSignIn = jest.fn();
const resendOtp = jest.fn();

jest.mock("../../../store/auth/userSlice", () => ({
  setUser: jest.fn(),
  initialState: {},
  userSlice: { name: "auth/user", reducer: (state = {}) => state },
}));
jest.mock("../../../store/auth/sessionSlice", () => ({
  onSignInSuccess: jest.fn(),
  onSignOut: jest.fn(),
  setSessionToken: jest.fn(),
}));
jest.mock("../../../store/UserSetting/dataSlice", () => ({
  setUserSetting: jest.fn(),
  updateUserSetting: jest.fn(),
  getMode: jest.fn(),
}));
jest.mock("../../../services/User/AuthService", () => ({
  apiSignIn: (...a: any[]) => apiSignIn(...a),
  resendOtp: (...a: any[]) => resendOtp(...a),
}));
jest.mock("@/lib/toastAlert", () => ({ toastAlert: jest.fn() }));
jest.mock("@/utils/cookie", () => ({ setCookie: jest.fn() }));
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    get: jest.fn(() =>
      Promise.resolve({ data: { country_name: "United States", ip: "1.1.1.1", region: "CA" } })
    ),
  },
}));
jest.mock("browser-detect", () => ({
  __esModule: true,
  default: () => ({ name: "Chrome", mobile: false, os: "macOS" }),
}));

import EmailForm from "@/components/Login/EmailForm";

const challengeWith = (extra: Record<string, unknown>) =>
  apiSignIn.mockResolvedValue({
    data: {
      success: true,
      status: "OTP",
      message: "OTP sent to your email address, OTP is valid only for 3 minutes",
      ...extra,
    },
  });

const submit = async () => {
  fireEvent.change(screen.getByPlaceholderText(/Enter your email/i), {
    target: { name: "email", value: "trader@example.com" },
  });
  fireEvent.change(screen.getByPlaceholderText(/Enter password/i), {
    target: { name: "password", value: "Passw0rd!23" },
  });
  fireEvent.click(screen.getByText(/Log In/i));
};

beforeEach(() => {
  apiSignIn.mockReset();
  resendOtp.mockReset();
});

test("delivery off: the login code is shown, because nothing was mailed", async () => {
  challengeWith({
    delivered: false,
    mailDelivery: "log-only",
    verificationCode: "771204",
    message: "No email was sent: mail delivery is switched off on this environment.",
  });
  render(<EmailForm />);
  await submit();

  const code = await screen.findByTestId("login-code");
  expect(code.textContent).toBe("771204");
  expect(screen.getByTestId("login-code-notice").textContent).toMatch(/no email was sent/i);
  // The code field is still there and still has to be answered.
  expect(screen.getByPlaceholderText(/Enter OTP code/i)).toBeInTheDocument();
});

test("delivery ON: the code is never printed on screen (SECURITY)", async () => {
  challengeWith({ delivered: true, mailDelivery: "send", verificationCode: "771204" });
  render(<EmailForm />);
  await submit();

  expect(await screen.findByPlaceholderText(/Enter OTP code/i)).toBeInTheDocument();
  expect(screen.queryByTestId("login-code-notice")).toBeNull();
  expect(document.body.textContent).not.toContain("771204");
});

test("a server that says nothing shows no notice at all", async () => {
  // An older userapi. In production the mail really is sent.
  challengeWith({});
  render(<EmailForm />);
  await submit();

  expect(await screen.findByPlaceholderText(/Enter OTP code/i)).toBeInTheDocument();
  expect(screen.queryByTestId("login-code-notice")).toBeNull();
});

test("delivery off with no code: it points at the log rather than dead-ending", async () => {
  challengeWith({ delivered: false, mailDelivery: "log-only" });
  render(<EmailForm />);
  await submit();

  const missing = await screen.findByTestId("login-code-missing");
  expect(missing.textContent).toMatch(/server log/i);
  expect(screen.queryByTestId("login-code")).toBeNull();
});
