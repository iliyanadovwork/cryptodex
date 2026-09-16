/**
 * "RESET PASSWORD LINK SENT TO REGISTERED MAIL ID" - FOR A MAIL NOBODY SENT.
 * =========================================================================
 *
 * This form is the ONLY route back into an account whose password has been
 * forgotten. It reported success in a toast and stopped there. On this stack
 * userapi runs in `log-only` delivery (GET /api/health -> email.deliveryMode):
 * the reset mail is rendered, the link goes to the process log, and the
 * provider is never contacted. So the one door out of a lockout announced that
 * help was on the way and then did nothing a user could act on. A locked-out
 * user was locked out permanently.
 *
 * /api/auth/forgotPassword now reports `delivered` and, when it sent nothing,
 * returns the `resetLink` it wrote to the log (`discloseWhenLogOnly`, userapi
 * lib/mailDelivery.js - vetoed in production before any opt-in flag is read).
 *
 * Both directions are pinned, and the production direction is the one that
 * matters most: a build that rendered a reset link when the server says it DID
 * send the mail would be publishing an account-takeover token on a page that
 * takes an arbitrary email address.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const apiForgotPassword = jest.fn();

jest.mock("next/router", () => ({
  useRouter: jest.fn(() => ({ push: jest.fn(), pathname: "/forget", query: {} })),
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
  apiForgotPassword: (...a: any[]) => apiForgotPassword(...a),
}));
jest.mock("@/lib/toastAlert", () => ({ toastAlert: jest.fn() }));

import EmailForm from "@/components/ForgotPassword/EmailForm";

const LINK = "http://localhost:3000/verification/forgotPassword?auth=RESET123";

const replies = (extra: Record<string, unknown>) =>
  apiForgotPassword.mockResolvedValue({
    data: { success: true, message: "Reset password link sent to registered mail ID", ...extra },
  });

const submit = async () => {
  fireEvent.change(screen.getByPlaceholderText(/Enter Email Address/i), {
    target: { name: "email", value: "locked.out@example.com" },
  });
  fireEvent.click(screen.getByText(/Confirm/i));
};

beforeEach(() => {
  apiForgotPassword.mockReset();
});

test("delivery off: the reset link is on the page, and it is the real one", async () => {
  replies({ delivered: false, mailDelivery: "log-only", resetLink: LINK });
  render(<EmailForm />);
  await submit();

  const block = await screen.findByTestId("forgot-reset-link");
  const anchor = block.querySelector("a") as HTMLAnchorElement;
  expect(anchor.getAttribute("href")).toBe(LINK);
  expect(screen.getByTestId("forgot-reset-link-url").textContent).toContain("auth=RESET123");
});

test("delivery off: it does not claim a mail was sent, or offer a spam folder", async () => {
  replies({
    delivered: false,
    mailDelivery: "log-only",
    resetLink: LINK,
    message: "No email was sent: mail delivery is switched off on this environment.",
  });
  render(<EmailForm />);
  await submit();

  const notice = await screen.findByTestId("forgot-success-notice");
  expect(notice.textContent).toMatch(/no email was sent/i);
  expect(notice.textContent).not.toMatch(/spam/i);
});

test("delivery ON: no link is rendered even if a server sent one (SECURITY)", async () => {
  replies({ delivered: true, mailDelivery: "send", resetLink: LINK });
  render(<EmailForm />);
  await submit();

  const notice = await screen.findByTestId("forgot-success-notice");
  await waitFor(() => expect(notice.textContent).toMatch(/spam folder/i));
  expect(screen.queryByTestId("forgot-reset-link")).toBeNull();
  expect(notice.textContent).not.toContain("RESET123");
});

test("a server that says nothing keeps the production wording", async () => {
  // No `delivered` field at all - an older userapi. In production the mail
  // really is sent, so the original sentence is the correct one.
  replies({});
  render(<EmailForm />);
  await submit();

  const notice = await screen.findByTestId("forgot-success-notice");
  await waitFor(() => expect(notice.textContent).toMatch(/spam folder/i));
  expect(screen.queryByTestId("forgot-reset-link")).toBeNull();
});

test("delivery off with no link: it says where the link went rather than dead-ending", async () => {
  replies({ delivered: false, mailDelivery: "log-only" });
  render(<EmailForm />);
  await submit();

  const block = await screen.findByTestId("forgot-reset-link-missing");
  expect(block.textContent).toMatch(/server log/i);
  expect(screen.queryByTestId("forgot-reset-link")).toBeNull();
});

test("the confirmation outlives the toast", async () => {
  // The whole interaction used to be a toast that fades after ~3s, on the one
  // page a locked-out user has. It is page state now.
  replies({ delivered: false, mailDelivery: "log-only", resetLink: LINK });
  render(<EmailForm />);
  await submit();

  const notice = await screen.findByTestId("forgot-success-notice");
  expect(notice).toBeInTheDocument();
});
