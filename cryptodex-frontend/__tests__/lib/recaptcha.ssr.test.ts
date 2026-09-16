/**
 * @jest-environment node
 */

/**
 * recaptchaEnabledHere() DURING A SERVER RENDER.
 *
 * `_app` calls this while deciding whether to mount GoogleReCaptchaProvider,
 * and that decision is made on the server first. There, `window` is not an
 * empty object - the IDENTIFIER DOES NOT EXIST, and evaluating
 * `window.location` throws a ReferenceError that takes down the whole page
 * render before a byte of HTML is produced. `typeof window !== "undefined"` is
 * the only form that can ask the question safely, and it is easy to "simplify"
 * away by anyone reading the client-side code alone.
 *
 * This case needs a real node environment to be worth anything: under jsdom the
 * `window` global is non-configurable, so it cannot be removed and any test
 * pretending to remove it passes whether the guard is there or not. Hence the
 * docblock above and the separate file.
 */

import { recaptchaEnabledHere, isRecaptchaEnabled } from "@/lib/recaptcha";

const KEY = "6Lel2jYsAAAAAHvUJNQyCXKyRbtdCkjYFxokwJJx";

describe("recaptchaEnabledHere on the server", () => {
  it("there really is no window here", () => {
    // The precondition, asserted rather than assumed.
    expect(typeof window).toBe("undefined");
  });

  it("does not throw, and answers with a boolean", () => {
    expect(() => recaptchaEnabledHere()).not.toThrow();
    expect(typeof recaptchaEnabledHere()).toBe("boolean");
  });

  it("resolves the same way the client render that follows it will", () => {
    // No hostname to judge, so the key alone decides - and with no key
    // configured the answer is a stable "disabled" on both sides of the
    // hydration boundary. A server/client disagreement here is a React
    // hydration mismatch on every page of the app.
    expect(recaptchaEnabledHere()).toBe(isRecaptchaEnabled(null));
  });

  it("a real deployment is still enabled server-side", () => {
    // The guard must not be vacuous: it makes SSR safe, it does not turn
    // reCAPTCHA off.
    expect(isRecaptchaEnabled(null, KEY)).toBe(true);
  });
});
