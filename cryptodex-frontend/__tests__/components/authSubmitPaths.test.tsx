/**
 * AUTH SUBMIT PATHS (CRITICAL)
 *
 * THE BUG THIS EXISTS TO CATCH
 * Registration was impossible. Not slow, not erroring — the Register button
 * did nothing whatsoever: no request, no message, no console error. Removing
 * the nested GoogleReCaptchaProvider meant the form could no longer obtain a
 * token, and Register's client-side validation demanded one unconditionally,
 * so every submit returned before `apiSignUp`. Nothing on screen said so,
 * because `errors.reCaptcha` had no `<p>` anywhere in the form.
 *
 * The existing Register suite passed the whole time. Its "should submit form
 * with valid data" test clicked the button and asserted the button still
 * existed afterwards — true of a dead button and a live one alike.
 *
 * So these tests assert the ONE fact that separates them: the service function
 * gets called. Each form here is rendered exactly as the local stack renders
 * it — no reCAPTCHA provider above it, `useGoogleReCaptcha` handing back the
 * out-of-provider `executeRecaptcha` that THROWS the moment anyone calls it.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

jest.mock("next/router", () => ({
  useRouter: jest.fn(() => ({ push: jest.fn(), pathname: "/", query: {} })),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// Exactly what the library does outside its provider: the context default is an
// executeRecaptcha that throws. Any form that calls it unguarded blows up here.
jest.mock("react-google-recaptcha-v3", () => ({
  useGoogleReCaptcha: () => ({
    executeRecaptcha: () => {
      throw new Error(
        "GoogleReCaptcha Context has not yet been implemented, if you are using useGoogleReCaptcha hook, make sure the hook is called inside component wrapped by GoogleRecaptchaProvider"
      );
    },
  }),
}));

jest.mock("@/services/User/AuthService", () => ({
  apiSignUp: jest.fn(),
  apiMailResend: jest.fn(() =>
    Promise.resolve({ data: { success: true, message: "resent" } })
  ),
  apiForgotPassword: jest.fn(),
  apiResetPassword: jest.fn(),
}));

jest.mock("@/lib/toastAlert", () => ({ toastAlert: jest.fn() }));

import RegisterEmailForm from "@/components/Register/EmailForm";
import ForgotPasswordForm from "@/components/ForgotPassword/EmailForm";
import ResetPasswordForm from "@/components/ResetPassword/Form";
import {
  apiSignUp,
  apiForgotPassword,
  apiResetPassword,
} from "@/services/User/AuthService";

const ok = (data: any) => Promise.resolve({ data });

const fillRegister = (email = "newuser@test.com", pw = "FirstRun123!") => {
  fireEvent.change(screen.getByPlaceholderText("Enter your email"), {
    target: { name: "email", value: email },
  });
  fireEvent.change(screen.getByPlaceholderText("Enter password"), {
    target: { name: "password", value: pw },
  });
  fireEvent.change(screen.getByPlaceholderText("Re-enter your password"), {
    target: { name: "confirmPassword", value: pw },
  });
};

describe("Register — the submit path reaches the API (CRITICAL)", () => {
  beforeEach(() => {
    (apiSignUp as jest.Mock).mockImplementation(() =>
      ok({ status: true, message: "Activation mail sent" })
    );
  });

  test("a valid signup calls apiSignUp on a build that issues no reCAPTCHA token", async () => {
    render(<RegisterEmailForm refId="" />);
    fillRegister();
    fireEvent.click(screen.getByRole("button", { name: /Register/i }));

    await waitFor(() => expect(apiSignUp).toHaveBeenCalledTimes(1));
    expect((apiSignUp as jest.Mock).mock.calls[0][0]).toMatchObject({
      email: "newuser@test.com",
      password: "FirstRun123!",
      confirmPassword: "FirstRun123!",
      roleType: 1,
    });
  });

  test("the out-of-provider executeRecaptcha never escapes as an unhandled throw", async () => {
    render(<RegisterEmailForm refId="" />);
    fillRegister();
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: /Register/i }))
    ).not.toThrow();
    await waitFor(() => expect(apiSignUp).toHaveBeenCalled());
  });

  test("an invalid form still blocks the API and says why", async () => {
    render(<RegisterEmailForm refId="" />);
    fireEvent.change(screen.getByPlaceholderText("Enter your email"), {
      target: { name: "email", value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Register/i }));

    expect(await screen.findByText("Email is invalid")).toBeInTheDocument();
    expect(apiSignUp).not.toHaveBeenCalled();
  });

  test("a rejection the form has no field for is still shown to the user", async () => {
    (apiSignUp as jest.Mock).mockImplementation(() =>
      Promise.reject({
        response: {
          data: { errors: { reCaptcha: "ReCAPTCHA field is required" } },
        },
      })
    );
    render(<RegisterEmailForm refId="" />);
    fillRegister();
    fireEvent.click(screen.getByRole("button", { name: /Register/i }));

    const banner = await screen.findByTestId("register-form-error");
    expect(banner).toHaveTextContent("ReCAPTCHA field is required");
  });

  test("a clean form shows no form-level error banner", () => {
    render(<RegisterEmailForm refId="" />);
    expect(screen.queryByTestId("register-form-error")).not.toBeInTheDocument();
  });
});

describe("Forgot password — the submit path reaches the API (CRITICAL)", () => {
  test("clicking Confirm calls apiForgotPassword", async () => {
    (apiForgotPassword as jest.Mock).mockImplementation(() =>
      ok({ success: true, message: "sent" })
    );
    render(<ForgotPasswordForm />);
    fireEvent.change(screen.getByPlaceholderText("Enter Email Address"), {
      target: { name: "email", value: "someone@test.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    await waitFor(() => expect(apiForgotPassword).toHaveBeenCalledTimes(1));
    expect((apiForgotPassword as jest.Mock).mock.calls[0][0]).toMatchObject({
      email: "someone@test.com",
      roleType: 1,
    });
  });

  test("a rejection it has no field for is still shown to the user", async () => {
    (apiForgotPassword as jest.Mock).mockImplementation(() =>
      Promise.reject({
        response: {
          data: { errors: { reCaptcha: "ReCAPTCHA field is required" } },
        },
      })
    );
    render(<ForgotPasswordForm />);
    fireEvent.change(screen.getByPlaceholderText("Enter Email Address"), {
      target: { name: "email", value: "someone@test.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    expect(await screen.findByTestId("forgot-form-error")).toHaveTextContent(
      "ReCAPTCHA field is required"
    );
  });
});

describe("Reset password — the submit path reaches the API (CRITICAL)", () => {
  test("clicking Confirm calls apiResetPassword with the auth token", async () => {
    (apiResetPassword as jest.Mock).mockImplementation(() =>
      ok({ success: true, message: "updated" })
    );
    render(<ResetPasswordForm authToken="token-from-the-email-link" />);
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { name: "password", value: "FirstRun123!" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm password"), {
      target: { name: "confirmPassword", value: "FirstRun123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    await waitFor(() => expect(apiResetPassword).toHaveBeenCalledTimes(1));
    expect((apiResetPassword as jest.Mock).mock.calls[0][0]).toMatchObject({
      password: "FirstRun123!",
      confirmPassword: "FirstRun123!",
      authToken: "token-from-the-email-link",
    });
  });

  test("a rejection it has no field for is still shown to the user", async () => {
    (apiResetPassword as jest.Mock).mockImplementation(() =>
      Promise.reject({
        response: { data: { errors: { authToken: "Link has expired" } } },
      })
    );
    render(<ResetPasswordForm authToken="stale" />);
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { name: "password", value: "FirstRun123!" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm password"), {
      target: { name: "confirmPassword", value: "FirstRun123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    expect(await screen.findByTestId("reset-form-error")).toHaveTextContent(
      "Link has expired"
    );
  });
});

/**
 * THE FOURTH FORM THAT USED TO BE COVERED HERE IS GONE.
 *
 * "Contact us — the submit path reaches the API" rendered
 * components/contactus/RegisterForm and asserted it reached `apiContactUs`
 * (user/addContactus). The endpoint was withdrawn with the rest of the
 * support surface and the page and component went with it, so there is no
 * submit path left to guard. The three that remain — register, forgot
 * password, reset password — are the ones this file was written for.
 */
