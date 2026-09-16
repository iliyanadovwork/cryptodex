/**
 * Register validation — the reCAPTCHA rule (CRITICAL)
 *
 * This rule bricked registration. `_app` stopped mounting
 * GoogleReCaptchaProvider on hosts whose site key cannot serve them, so the
 * form can no longer produce a token; the rule demanded one anyway, on every
 * build, and every single submit returned before reaching apiSignUp.
 *
 * Both directions matter, so both are asserted:
 *   - a build that issues no token must not be asked for one (or nobody signs
 *     up at all), and
 *   - a build that DOES issue tokens must still refuse a submit without one
 *     (or the rule has been deleted rather than fixed).
 */
import registerValid from "@/components/Register/validation";

const emailUser = () => ({
  roleType: 1,
  email: "newuser@test.com",
  password: "FirstRun123!",
  confirmPassword: "FirstRun123!",
  reCaptcha: "",
});

describe("registerValid — reCAPTCHA is only demanded where it is issued", () => {
  test("no token required: an otherwise valid email signup passes clean", () => {
    const errors = registerValid(emailUser(), false) as Record<string, string>;
    expect(errors).toEqual({});
  });

  test("no token required: the reCaptcha key is never set", () => {
    const errors = registerValid(emailUser(), false) as Record<string, string>;
    expect(errors.reCaptcha).toBeUndefined();
  });

  test("token required but missing: signup is refused", () => {
    const errors = registerValid(emailUser(), true) as Record<string, string>;
    expect(errors.reCaptcha).toBe("ReCAPTCHA field is required");
  });

  test("token required and supplied: signup passes clean", () => {
    const errors = registerValid(
      { ...emailUser(), reCaptcha: "a-real-token" },
      true
    ) as Record<string, string>;
    expect(errors).toEqual({});
  });

  test("the reCAPTCHA flag does not swallow the other rules", () => {
    const errors = registerValid(
      { ...emailUser(), email: "", confirmPassword: "" },
      false
    ) as Record<string, string>;
    expect(errors.email).toBe("Email field is required");
    expect(errors.confirmPassword).toBe("Confirm password field is required");
  });

  test("mobile signup: same flag governs the same rule", () => {
    const mobile = {
      roleType: 2,
      newPhoneNo: "5551234567",
      newPhoneCode: "1",
      password: "FirstRun123!",
      confirmPassword: "FirstRun123!",
      reCaptcha: "",
    };
    expect(registerValid(mobile, false)).toEqual({});
    expect((registerValid(mobile, true) as any).reCaptcha).toBe(
      "ReCAPTCHA field is required"
    );
  });
});
