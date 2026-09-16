/**
 * "CHECK YOUR SPAM FOLDER" FOR A MAIL THE SERVER NEVER SENT.
 * ==========================================================
 *
 * userapi runs with `TEST_MODE=true` on this stack, which puts
 * `lib/mailDelivery.mailDeliveryMode()` into `log-only`: the activation mail
 * is rendered, its LINK is written to the process log, and the provider is
 * never contacted. The register form nevertheless printed
 *
 *     Sent to <address>. Check your spam folder if it does not arrive.
 *
 * for every successful registration. Nothing was sent, so nothing can be in a
 * spam folder; a user or developer who follows that instruction waits for a
 * message that was deliberately never dispatched.
 *
 * The endpoint now reports `delivered` (see `mailDeliveryFacts` in userapi
 * controllers/auth.controller.js) and this form renders what it is told. In
 * production `delivered` is true by construction - `mailDeliveryMode` vetoes
 * the bypass on `NODE_ENV === "production"` before reading any opt-in flag -
 * so the original wording is what production still shows.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const apiSignUp = jest.fn();
const apiMailResend = jest.fn();

jest.mock("next/router", () => ({
  useRouter: jest.fn(() => ({ push: jest.fn(), pathname: "/register", query: {} })),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
jest.mock("react-google-recaptcha-v3", () => ({
  useGoogleReCaptcha: () => ({
    executeRecaptcha: jest.fn(() => Promise.resolve("mock-captcha-token")),
  }),
}));
jest.mock("@/services/User/AuthService", () => ({
  apiSignUp: (...a: any[]) => apiSignUp(...a),
  apiMailResend: (...a: any[]) => apiMailResend(...a),
}));
jest.mock("@/lib/toastAlert", () => ({ toastAlert: jest.fn() }));

import EmailForm from "@/components/Register/EmailForm";

const fillAndSubmit = async () => {
  fireEvent.change(screen.getByPlaceholderText(/Enter your email/i), {
    target: { name: "email", value: "someone@example.com" },
  });
  fireEvent.change(screen.getByPlaceholderText(/Enter password/i), {
    target: { name: "password", value: "Passw0rd!23" },
  });
  fireEvent.change(screen.getByPlaceholderText(/Re-enter your password/i), {
    target: { name: "confirmPassword", value: "Passw0rd!23" },
  });
  const boxes = document.querySelectorAll('input[type="checkbox"]');
  if (boxes.length) fireEvent.click(boxes[0]);
  fireEvent.click(screen.getByText(/^Register$/i));
};

const signUpReplies = (extra: Record<string, unknown>) =>
  apiSignUp.mockResolvedValue({
    data: { status: true, message: "Activation mail sent.", success: true, ...extra },
  });

beforeEach(() => {
  apiSignUp.mockReset();
  apiMailResend.mockReset();
});

test("delivery off: it does not tell the user to check a spam folder", async () => {
  signUpReplies({ delivered: false, mailDelivery: "log-only" });
  render(<EmailForm refId="" />);
  await fillAndSubmit();

  const notice = await screen.findByTestId("register-success-notice");
  await waitFor(() =>
    expect(screen.queryByTestId("register-mail-not-sent")).not.toBeNull()
  );
  expect(notice.textContent).not.toMatch(/spam/i);
});

test("delivery off: it says plainly that no email was sent", async () => {
  signUpReplies({ delivered: false, mailDelivery: "log-only" });
  render(<EmailForm refId="" />);
  await fillAndSubmit();

  const block = await screen.findByTestId("register-mail-not-sent");
  expect(block.textContent).toMatch(/no email was sent/i);
  expect(block.textContent).toMatch(/someone@example\.com/);
});

test("delivery on: the spam-folder line is exactly as before", async () => {
  signUpReplies({ delivered: true, mailDelivery: "send" });
  render(<EmailForm refId="" />);
  await fillAndSubmit();

  const notice = await screen.findByTestId("register-success-notice");
  await waitFor(() => expect(notice.textContent).toMatch(/spam folder/i));
  expect(screen.queryByTestId("register-mail-not-sent")).toBeNull();
});

test("a server that says nothing keeps the production wording", async () => {
  // No `delivered` field at all - an older userapi.
  signUpReplies({});
  render(<EmailForm refId="" />);
  await fillAndSubmit();

  const notice = await screen.findByTestId("register-success-notice");
  await waitFor(() => expect(notice.textContent).toMatch(/spam folder/i));
  expect(screen.queryByTestId("register-mail-not-sent")).toBeNull();
});

/**
 * ...AND THE LINK ITSELF, BECAUSE A BROWSER CANNOT READ THE SERVER LOG.
 * ====================================================================
 * Telling the truth ("the activation link was written to the server log") was
 * an improvement on the lie, but it is still not a door: a user - or a marker -
 * with a browser and no terminal could create an account here and never be
 * able to activate it. In log-only mode /api/auth/register now returns the
 * link (`discloseWhenLogOnly`, userapi lib/mailDelivery.js) and it is rendered.
 *
 * Both directions are pinned. A build that showed the link when the server
 * says it DID send would be publishing an activation token in production.
 */
test("delivery off: the activation link is on the page, not only in a log", async () => {
  signUpReplies({
    delivered: false,
    mailDelivery: "log-only",
    activationLink: "http://localhost:3000/verification/register?auth=TOKEN123",
  });
  render(<EmailForm refId="" />);
  await fillAndSubmit();

  const block = await screen.findByTestId("register-activation-link");
  const anchor = block.querySelector("a") as HTMLAnchorElement;
  expect(anchor.getAttribute("href")).toBe(
    "http://localhost:3000/verification/register?auth=TOKEN123"
  );
  expect(
    screen.getByTestId("register-activation-link-url").textContent
  ).toContain("auth=TOKEN123");
});

test("delivery ON: no link is rendered even if a server sent one (SECURITY)", async () => {
  signUpReplies({
    delivered: true,
    mailDelivery: "send",
    activationLink: "http://localhost:3000/verification/register?auth=TOKEN123",
  });
  render(<EmailForm refId="" />);
  await fillAndSubmit();

  await screen.findByTestId("register-success-notice");
  expect(screen.queryByTestId("register-activation-link")).toBeNull();
});

test("delivery off with no link: it says where the link went instead of dead-ending", async () => {
  signUpReplies({ delivered: false, mailDelivery: "log-only" });
  render(<EmailForm refId="" />);
  await fillAndSubmit();

  await screen.findByTestId("register-mail-not-sent");
  expect(screen.queryByTestId("register-activation-link")).toBeNull();
});
