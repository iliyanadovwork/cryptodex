/**
 * THE FOURTH FIELD OF THE CHANGE-PASSWORD DIALOG COULD NOT BE ANSWERED.
 * ====================================================================
 *
 * /security -> Login Password -> Modify asks for an e-mail verification code
 * and, on pressing Send, said "Verification code sent to your email ID". On
 * this stack userapi is in `log-only` delivery: /sendOTP stores the code on the
 * user, renders the mail, writes it to the process log and never contacts a
 * provider. `changePassword` genuinely requires that code - deliberately, see
 * the note on the handler in userapi controllers/user.controller.js - so the
 * dialog could not be completed by anyone without shell access to the server,
 * while claiming a mail was on its way.
 *
 * The requirement is untouched; these tests are about what the user is TOLD.
 * /sendOTP now reports `delivered` and, when it sent nothing, returns the code
 * (`discloseWhenLogOnly`, userapi lib/mailDelivery.js, vetoed in production).
 *
 * The production direction is pinned too: a build that printed the code on
 * screen when the server says it DID mail it would be defeating the point of
 * mailing it.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const apiEmailOTPRequest = jest.fn();
const apiPasswordChange = jest.fn();

jest.mock("next/router", () => ({
  useRouter: jest.fn(() => ({ push: jest.fn(), pathname: "/security", query: {} })),
}));
jest.mock("@/services/User/UserServices", () => ({
  apiEmailOTPRequest: (...a: any[]) => apiEmailOTPRequest(...a),
  apiPasswordChange: (...a: any[]) => apiPasswordChange(...a),
}));
jest.mock("@/lib/toastAlert", () => ({ toastAlert: jest.fn() }));

const mockState = {
  auth: { user: { email: "trader@example.com", emailStatus: "verified" } },
};
jest.mock("../../../store", () => ({
  useDispatch: () => jest.fn(),
  useSelector: (fn: any) => fn(mockState),
}));

import ChangePassword from "@/components/security/ChangePassword";

const sendReplies = (extra: Record<string, unknown>) =>
  apiEmailOTPRequest.mockResolvedValue({
    data: {
      success: true,
      status: "RESEND_OTP",
      message: "Verification code sent to your email ID",
      ...extra,
    },
  });

const pressSend = () => fireEvent.click(screen.getByText(/^Send$/i));

const renderDialog = () =>
  render(<ChangePassword password_modal={true} setpassword_modal={jest.fn()} />);

beforeEach(() => {
  apiEmailOTPRequest.mockReset();
  apiPasswordChange.mockReset();
});

test("delivery off: the code is shown, because nothing was mailed", async () => {
  sendReplies({
    delivered: false,
    mailDelivery: "log-only",
    verificationCode: "482913",
    message: "No email was sent: mail delivery is switched off on this environment.",
  });
  renderDialog();
  pressSend();

  const code = await screen.findByTestId("change-password-code");
  expect(code.textContent).toBe("482913");
  const notice = screen.getByTestId("change-password-code-notice");
  expect(notice.textContent).toMatch(/no email was sent/i);
});

test("delivery ON: the code is never printed on screen (SECURITY)", async () => {
  sendReplies({ delivered: true, mailDelivery: "send", verificationCode: "482913" });
  renderDialog();
  pressSend();

  const notice = await screen.findByTestId("change-password-code-notice");
  expect(notice.textContent).toMatch(/sent to your email/i);
  expect(screen.queryByTestId("change-password-code")).toBeNull();
  expect(notice.textContent).not.toContain("482913");
});

test("a server that says nothing keeps the production wording", async () => {
  sendReplies({});
  renderDialog();
  pressSend();

  const notice = await screen.findByTestId("change-password-code-notice");
  expect(notice.textContent).toMatch(/sent to your email/i);
  expect(screen.queryByTestId("change-password-code")).toBeNull();
});

test("delivery off with no code: it points at the log instead of dead-ending", async () => {
  sendReplies({ delivered: false, mailDelivery: "log-only" });
  renderDialog();
  pressSend();

  const missing = await screen.findByTestId("change-password-code-missing");
  expect(missing.textContent).toMatch(/server log/i);
  expect(screen.queryByTestId("change-password-code")).toBeNull();
});

test("nothing is claimed before Send is pressed", async () => {
  sendReplies({ delivered: false, verificationCode: "482913" });
  renderDialog();

  expect(screen.queryByTestId("change-password-code-notice")).toBeNull();
});

test("the code field is still there - disclosure is not a bypass", async () => {
  // The fix must not read as "the code stopped being required". The dialog
  // still asks for it and userapi still verifies it.
  sendReplies({ delivered: false, verificationCode: "482913" });
  renderDialog();

  expect(
    screen.getByPlaceholderText(/Enter your email verification code/i)
  ).toBeInTheDocument();
});
