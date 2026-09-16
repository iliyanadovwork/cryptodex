/**
 * WHERE reCAPTCHA APPLIES.
 *
 * Reported: 'a red reCAPTCHA error box "Localhost is not supported by this site
 * key" is burned into the corner of every page.' That box is the v3 badge
 * rendering its own failure, because a site key registered for the production
 * domain refuses a loopback origin.
 */

import {
  isRecaptchaEnabled,
  isLoopbackHost,
  recaptchaEnabledHere,
} from "@/lib/recaptcha";

const KEY = "6Lel2jYsAAAAAHvUJNQyCXKyRbtdCkjYFxokwJJx";

describe("isLoopbackHost", () => {
  it("knows the hosts a public site key cannot serve", () => {
    ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].forEach((h) =>
      expect(isLoopbackHost(h)).toBe(true)
    );
  });

  it("is case-insensitive", () => {
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  it("does not catch real hosts", () => {
    ["cryptodex.com", "app.cryptodex.com", "localhost.evil.com"].forEach((h) =>
      expect(isLoopbackHost(h)).toBe(false)
    );
  });

  it("treats a missing hostname as not-loopback", () => {
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});

describe("isRecaptchaEnabled", () => {
  it("THE BUG: disabled on localhost, which is where the error card appeared", () => {
    expect(isRecaptchaEnabled("localhost", KEY)).toBe(false);
    expect(isRecaptchaEnabled("127.0.0.1", KEY)).toBe(false);
  });

  it("disabled when no site key is configured at all", () => {
    // Mounting the provider with no key gives a widget with nothing behind it.
    expect(isRecaptchaEnabled("cryptodex.com", undefined)).toBe(false);
    expect(isRecaptchaEnabled("cryptodex.com", "")).toBe(false);
  });

  it("STILL ENABLED on a real host with a real key", () => {
    // The guard must not be vacuous: this is not a blanket removal.
    expect(isRecaptchaEnabled("cryptodex.com", KEY)).toBe(true);
  });

  it("enabled during a server render on a real deployment", () => {
    // No hostname available server-side; the key alone decides.
    expect(isRecaptchaEnabled(null, KEY)).toBe(true);
    expect(isRecaptchaEnabled(undefined, KEY)).toBe(true);
  });

  it("disabled outright on a build that declares itself local, whatever host it is served from", () => {
    // The host check alone is not enough. A local stack reached over a LAN
    // address, a tunnel, a container hostname or a *.local name is not a
    // loopback host, but the backend still is not verifying anything there
    // (userapi auth.controller.js: "reCaptcha DISABLED for local testing"), so
    // the badge would mount, fail against the production key and paint the same
    // error card the loopback check was added to remove.
    // The build flag is swapped at the config module, not through the
    // environment: next/jest inlines NEXT_PUBLIC_* at transform time, so
    // reassigning process.env after the fact reaches nothing.
    const withMode = (mode: string) => {
      jest.resetModules();
      jest.doMock("@/config", () => ({
        __esModule: true,
        default: { MODE: mode, RECAPTCHA_SITE_KEY: KEY },
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("@/lib/recaptcha") as typeof import("@/lib/recaptcha");
    };
    try {
      const local = withMode("local");
      expect(local.isRecaptchaEnabled("cryptodex.com", KEY)).toBe(false);
      expect(local.isRecaptchaEnabled("10.0.0.7", KEY)).toBe(false);
      // ...and it is the MODE doing it, not the key or the host.
      const prod = withMode("production");
      expect(prod.isRecaptchaEnabled("cryptodex.com", KEY)).toBe(true);
    } finally {
      jest.dontMock("@/config");
      jest.resetModules();
    }
  });
});

describe("recaptchaEnabledHere", () => {
  it("answers from the current origin", () => {
    // jsdom serves http://localhost, which is exactly the origin the site key
    // refuses - so the client-side answer here has to be "no".
    expect(window.location.hostname).toBe("localhost");
    expect(recaptchaEnabledHere()).toBe(false);
  });

  // The server-render case cannot live here: jsdom's `window` global is
  // non-configurable, so it cannot be taken away to simulate SSR. It runs in a
  // real node environment in recaptcha.ssr.test.ts.
});
