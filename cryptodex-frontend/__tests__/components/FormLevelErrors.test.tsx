/**
 * FormLevelErrors (CRITICAL)
 *
 * The reason registration looked dead rather than broken: an error key that no
 * `<p>` renders is invisible, so a form that refuses to submit gives the user
 * nothing at all. This component is the backstop — anything a form does not
 * claim as a field error has to appear somewhere.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import FormLevelErrors from "@/components/FormLevelErrors";

describe("FormLevelErrors", () => {
  test("renders an error key the form does not claim as a field", () => {
    render(
      <FormLevelErrors
        error={{ reCaptcha: "ReCAPTCHA field is required" }}
        fieldKeys={["email", "password"]}
      />
    );
    expect(screen.getByTestId("form-level-error")).toHaveTextContent(
      "ReCAPTCHA field is required"
    );
  });

  test("stays silent for keys the form already renders itself", () => {
    render(
      <FormLevelErrors
        error={{ email: "Email field is required" }}
        fieldKeys={["email", "password"]}
      />
    );
    expect(screen.queryByTestId("form-level-error")).not.toBeInTheDocument();
  });

  test("renders only the unclaimed keys when both kinds are present", () => {
    render(
      <FormLevelErrors
        error={{
          email: "Email field is required",
          somethingNobodyDrew: "Server said no",
        }}
        fieldKeys={["email"]}
      />
    );
    const el = screen.getByTestId("form-level-error");
    expect(el).toHaveTextContent("Server said no");
    expect(el).not.toHaveTextContent("Email field is required");
  });

  test("renders nothing for an empty, null or undefined error object", () => {
    const { rerender } = render(
      <FormLevelErrors error={{}} fieldKeys={["email"]} />
    );
    expect(screen.queryByTestId("form-level-error")).not.toBeInTheDocument();
    rerender(<FormLevelErrors error={null} fieldKeys={["email"]} />);
    expect(screen.queryByTestId("form-level-error")).not.toBeInTheDocument();
    rerender(<FormLevelErrors error={undefined} fieldKeys={["email"]} />);
    expect(screen.queryByTestId("form-level-error")).not.toBeInTheDocument();
  });

  test("an unclaimed key holding an empty value is not a visible error", () => {
    render(<FormLevelErrors error={{ reCaptcha: "" }} fieldKeys={["email"]} />);
    expect(screen.queryByTestId("form-level-error")).not.toBeInTheDocument();
  });

  test("honours a caller-supplied testId", () => {
    render(
      <FormLevelErrors
        error={{ reCaptcha: "nope" }}
        fieldKeys={[]}
        testId="register-form-error"
      />
    );
    expect(screen.getByTestId("register-form-error")).toBeInTheDocument();
  });
});
