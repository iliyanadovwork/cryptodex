/**
 * ACCOUNT DEACTIVATION COULD BE STARTED AND NOT FINISHED.
 * ======================================================
 *
 * /security promises the user that "where email delivery is switched off, the
 * code is shown to you on screen instead". That became true for password reset
 * and for change-password in an earlier round. The DEACTIVATION code was
 * missed: `/deactive-req` rendered the mail, wrote it to the userapi process
 * log and returned "Verification code sent to your email ID", and nothing in
 * the product ever showed it. `confirmDeActive` refuses without that code, so
 * the flow dead-ended exactly where password reset used to - a door the page
 * says is there and that does not open.
 *
 * `/deactive-req` now reports `delivered` and, when it sent nothing, returns
 * the code it stored (`discloseWhenLogOnly`, userapi lib/mailDelivery.js,
 * which returns `{}` on NODE_ENV=production before any opt-in flag is read).
 *
 * The PRODUCTION direction is pinned here too, and it is the important half: a
 * build that printed a deactivation code on screen when the server says it DID
 * mail it would be handing the one code that closes an account to whoever is
 * looking at the screen, which is the opposite of why it is mailed.
 *
 * The rest of these cases are about the screen itself, which was the last
 * wireframe in the product: a heading, one unlabelled box captioned "Please
 * enter otp", and a Confirm button - with no sentence anywhere saying what
 * pressing it would do to the account.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const deactiveReq = jest.fn();
const deactiveConfirm = jest.fn();
const push = jest.fn();
const toastAlert = jest.fn();

// NOT `jest.fn(() => ...)`: jest.config.js sets `resetMocks`, which strips the
// factory's implementation before each test and would hand the component an
// undefined router - so the redirect after a successful closure would throw
// inside its setTimeout instead of being asserted.
jest.mock("next/router", () => ({
  useRouter: () => ({ push, pathname: "/deactive", query: {} }),
}));
jest.mock("../../../services/User/UserServices", () => ({
  deactiveReq: (...a: any[]) => deactiveReq(...a),
  deactiveConfirm: (...a: any[]) => deactiveConfirm(...a),
}));
jest.mock("@/lib/toastAlert", () => ({ toastAlert: (...a: any[]) => toastAlert(...a) }));
jest.mock("@/lib/stringCase", () => jest.requireActual("@/lib/stringCase"));

const mockState = {
  auth: { user: { email: "trader@example.com", emailStatus: "verified" } },
};
jest.mock("../../../store", () => ({
  useDispatch: () => jest.fn(),
  useSelector: (fn: any) => fn(mockState),
}));

// jest.setup.js mocks @/store/auth/userSlice down to `getUserDetails` alone,
// which leaves `setUser` and `initialState` undefined - so the sign-out this
// screen performs after a successful closure would throw inside its own try
// block and the redirect would silently never happen. Restore the three action
// creators it actually uses.
jest.mock("../../../store/auth/userSlice", () => ({
  setUser: jest.fn(() => ({ type: "SET_USER" })),
  initialState: {},
  getUserDetails: jest.fn(() => ({ type: "USER_DETAILS_SUCCESS" })),
}));
jest.mock("../../../store/auth/sessionSlice", () => ({
  onSignOutSuccess: jest.fn(() => ({ type: "SIGN_OUT_SUCCESS" })),
}));
jest.mock("../../../store/UserSetting/dataSlice", () => ({
  setUserSetting: jest.fn(() => ({ type: "SET_USER_SETTING" })),
}));

import EmailForm from "@/components/Deactive/EmailForm";

const requestReplies = (extra: Record<string, unknown>) =>
  deactiveReq.mockResolvedValue({
    data: {
      success: true,
      status: "RESEND_OTP",
      message: "Verification code sent to your email ID",
      ...extra,
    },
  });

const pressSend = () => fireEvent.click(screen.getByTestId("deactivate-send-code"));

beforeEach(() => {
  deactiveReq.mockReset();
  deactiveConfirm.mockReset();
  push.mockReset();
  toastAlert.mockReset();
});

// ---------------------------------------------------------------------------
// the dead end
// ---------------------------------------------------------------------------

test("delivery off: the code is shown, because nothing was mailed", async () => {
  requestReplies({
    delivered: false,
    mailDelivery: "log-only",
    verificationCode: "730519",
    message: "No email was sent: mail delivery is switched off on this environment.",
  });
  render(<EmailForm />);
  pressSend();

  const code = await screen.findByTestId("deactivate-code");
  expect(code.textContent).toBe("730519");
  expect(screen.getByTestId("deactivate-code-notice").textContent).toMatch(
    /no email was sent/i
  );
});

test("delivery ON: the code is never printed on screen (SECURITY)", async () => {
  requestReplies({ delivered: true, mailDelivery: "send", verificationCode: "730519" });
  render(<EmailForm />);
  pressSend();

  const notice = await screen.findByTestId("deactivate-code-notice");
  expect(notice.textContent).toMatch(/sent to your email/i);
  expect(screen.queryByTestId("deactivate-code")).toBeNull();
  expect(notice.textContent).not.toContain("730519");
});

test("a server that says nothing keeps the production wording", async () => {
  requestReplies({});
  render(<EmailForm />);
  pressSend();

  const notice = await screen.findByTestId("deactivate-code-notice");
  expect(notice.textContent).toMatch(/sent to your email/i);
  expect(screen.queryByTestId("deactivate-code")).toBeNull();
});

test("delivery off with no code: it points at the log instead of dead-ending", async () => {
  requestReplies({ delivered: false, mailDelivery: "log-only" });
  render(<EmailForm />);
  pressSend();

  const missing = await screen.findByTestId("deactivate-code-missing");
  expect(missing.textContent).toMatch(/server log/i);
  expect(screen.queryByTestId("deactivate-code")).toBeNull();
});

test("nothing is claimed before the code is asked for", () => {
  requestReplies({ delivered: false, verificationCode: "730519" });
  render(<EmailForm />);

  expect(screen.queryByTestId("deactivate-code-notice")).toBeNull();
  expect(screen.queryByTestId("deactivate-otp")).toBeNull();
});

// ---------------------------------------------------------------------------
// the screen
// ---------------------------------------------------------------------------

test("the first step says what deactivation does before it offers to do it", () => {
  requestReplies({});
  render(<EmailForm />);

  const intro = screen.getByTestId("deactivate-intro").textContent || "";
  expect(intro).toMatch(/session ends/i);
  expect(intro).toMatch(/cancelled/i);

  const effects = screen.getByTestId("deactivate-effects").textContent || "";
  // The three consequences a user has to know BEFORE pressing, not after.
  expect(effects).toMatch(/signed out/i);
  expect(effects).toMatch(/returned to your balance/i);
  expect(effects).toMatch(/nothing is deleted/i);

  expect(screen.getByTestId("deactivate-step-hint").textContent).toMatch(
    /nothing changes until you enter it/i
  );
});

test("it names the account it is about to close, from the session", () => {
  requestReplies({});
  render(<EmailForm />);

  // The old first step asked the user to TYPE an address that userapi ignores:
  // `deactiveRequest` looks the account up by `req.user.id` and nothing else,
  // so a mistyped address changed nothing and explained nothing.
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByTestId("deactivate-account").textContent).toMatch(/@/);
});

test("the request is scoped by the session, not by anything the form collects", async () => {
  requestReplies({ delivered: false, verificationCode: "730519" });
  render(<EmailForm />);
  pressSend();

  await screen.findByTestId("deactivate-code");
  const sent = deactiveReq.mock.calls[0][0];
  expect(sent).not.toHaveProperty("email");
  expect(sent).not.toHaveProperty("userId");
  expect(sent.requestType).toBe("deactive");
});

test("the code field is labelled, and the placeholder is a sentence", async () => {
  requestReplies({ delivered: false, verificationCode: "730519" });
  render(<EmailForm />);
  pressSend();

  const otp = await screen.findByTestId("deactivate-otp");
  expect(otp.getAttribute("placeholder")).toBe("Enter the 6-digit confirmation code");
  expect(screen.getByLabelText(/confirmation code/i)).toBe(otp);
});

test("confirm is refused until the consequence is acknowledged", async () => {
  requestReplies({ delivered: false, verificationCode: "730519" });
  render(<EmailForm />);
  pressSend();

  const otp = await screen.findByTestId("deactivate-otp");
  fireEvent.change(otp, { target: { name: "otp", value: "730519" } });
  fireEvent.click(screen.getByTestId("deactivate-confirm"));

  expect(deactiveConfirm).not.toHaveBeenCalled();
  expect(toastAlert).toHaveBeenCalledWith(
    "error",
    expect.stringMatching(/understand what deactivation does/i),
    "deactive"
  );
});

test("an empty code is refused without a round trip", async () => {
  requestReplies({ delivered: false, verificationCode: "730519" });
  render(<EmailForm />);
  pressSend();

  await screen.findByTestId("deactivate-otp");
  fireEvent.click(screen.getByTestId("deactivate-consent"));
  fireEvent.click(screen.getByTestId("deactivate-confirm"));

  expect(deactiveConfirm).not.toHaveBeenCalled();
});

test("a successful closure signs the browser out instead of leaving a dead session on screen", async () => {
  requestReplies({ delivered: false, verificationCode: "730519" });
  deactiveConfirm.mockResolvedValue({
    data: { success: true, status: "DEACTIVATED", message: "Your account deactivated successfully." },
  });
  render(<EmailForm />);
  pressSend();

  const otp = await screen.findByTestId("deactivate-otp");
  fireEvent.change(otp, { target: { name: "otp", value: "730519" } });
  fireEvent.click(screen.getByTestId("deactivate-consent"));
  fireEvent.click(screen.getByTestId("deactivate-confirm"));

  // userapi purges the redis `userToken` row inside that call, so the token
  // this browser holds is dead the moment it returns.
  await waitFor(() => expect(deactiveConfirm).toHaveBeenCalledTimes(1));
  expect(deactiveConfirm.mock.calls[0][0].otp).toBe("730519");
  await waitFor(() => expect(push).toHaveBeenCalledWith("/login"), { timeout: 3000 });
});
