/**
 * WHETHER reCAPTCHA APPLIES ON THIS MACHINE.
 *
 * THE BUG THIS EXISTS TO KILL
 * A red Google error card — "Localhost is not supported by this site key." —
 * was burned into the bottom-right corner of EVERY page of the local stack. It
 * is the reCAPTCHA v3 badge rendering its own failure: the site key registered
 * for the production domain refuses the `localhost` origin, so the badge shows
 * an error instead of the usual quiet logo. It is on the login screen, the
 * wallet, the trade screens, permanently, and it looks exactly like the app is
 * broken.
 *
 * It is also pure ceremony here. The backend disabled the check for local
 * development some time ago (userapi controllers/auth.controller.js: "reCaptcha
 * DISABLED for local testing" — the verification calls in signup, login and
 * forgot-password are all commented out), so the token the widget produces is
 * read by nobody.
 *
 * WHAT THIS DOES
 * Answers one question — should this build mount the reCAPTCHA provider and
 * require a token? — from one place, so `_app` and the three auth forms cannot
 * drift into disagreeing. When the answer is no, the provider is never mounted
 * (no script, no badge, no error card) and the forms stop refusing to submit
 * for want of a token they can no longer obtain.
 *
 * ON `localhost` SPECIFICALLY
 * The host check is not a security decision — a client-side flag defends
 * nothing, and the server enforces whatever it enforces. It is the same
 * condition Google itself is failing on: if the origin is a loopback host that
 * key cannot work, so showing its error to the developer serves no one.
 */

import config from "../config";

/** Hostnames a reCAPTCHA site key registered for a real domain cannot serve. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"];

export function isLoopbackHost(hostname: string | undefined | null): boolean {
  if (!hostname) return false;
  return LOOPBACK_HOSTS.includes(hostname.toLowerCase());
}

/**
 * True when reCAPTCHA should be mounted and required.
 *
 * `hostname` is passed in rather than read from `window` so this is testable
 * and so a server render (where there is no window) resolves the same way as
 * the client render that follows it: no key configured -> disabled, everywhere.
 */
export function isRecaptchaEnabled(
  hostname?: string | null,
  siteKey: string | undefined | null = config.RECAPTCHA_SITE_KEY
): boolean {
  // No key: the provider would mount a widget with nothing behind it.
  if (!siteKey) return false;
  // Explicitly local build: the backend is not checking, and the badge only
  // renders its own failure.
  if (config.MODE === "local") return false;
  if (isLoopbackHost(hostname)) return false;
  return true;
}

/** The client-side answer, using the current document origin. */
export function recaptchaEnabledHere(): boolean {
  const hostname =
    typeof window !== "undefined" && window.location
      ? window.location.hostname
      : null;
  return isRecaptchaEnabled(hostname);
}
