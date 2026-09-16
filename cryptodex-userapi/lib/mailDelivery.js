/**
 * Outbound email delivery policy.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every transactional email in this service funnels through
 * `mailTemplateLang -> mailTemplate -> lib/emailGateway.sendEmail`, which POSTs
 * to api.resend.com. Three properties of that path made a provider outage
 * indistinguishable from success and left local development dead in the water:
 *
 *   1. `mailTemplateLang(...)` is invoked WITHOUT `await` at every call site, so
 *      the HTTP handler has already replied `{ success: true, message:
 *      "Activation mail sent..." }` before the provider is even contacted.
 *   2. `sendEmail` catches everything and logs it, returning undefined.
 *   3. Registration is unusable until the user clicks a link that only ever
 *      arrives by email, and `checkForgotPassword` refuses any account whose
 *      `status != "verified"`. So one failing provider call bricks both flows.
 *
 * Note what is NOT happening: there is no retry anywhere in this path. One user
 * action produces exactly one POST to the provider. A "rate limited on every
 * send" symptom is therefore NOT a retry storm of our own making - it is the
 * provider account's own state (exhausted free-tier quota, or an unverified
 * sending domain, which Resend rejects per-request). Do not add retries here:
 * retrying into a quota error is what would turn this into a real storm.
 *
 * THE FIX
 * -------
 * For a local paper-trading stack, requiring a third-party email round trip to
 * create an account is pure friction - there is no real user and no real
 * address to protect. In non-production we render the mail and LOG it (subject,
 * recipient, and the activation / reset link) instead of sending it, so the
 * developer completes the normal verification flow by pasting the link. The
 * auth logic itself is untouched: no account is auto-verified, no token is
 * weakened, and the verification code path still runs exactly as in production.
 *
 * PRODUCTION SAFETY
 * -----------------
 * The bypass has a hard production veto AND requires an explicit opt-in signal.
 * `NODE_ENV === "production"` short-circuits to real sending before any opt-in
 * is even consulted, so no combination of the other flags can disable delivery
 * in production. Opting in additionally requires one of:
 *
 *   NODE_ENV=test          - the automated suites
 *   TEST_MODE=true         - the signal this codebase already uses for the
 *                            local stack (see auth.controller.testVerifyUser)
 *   DEV_EMAIL_BYPASS=true  - explicit opt-in for a local dev run
 *
 * An unset NODE_ENV alone is deliberately NOT enough. Defaulting the bypass on
 * for "not production" would mean a deploy that merely forgot to set NODE_ENV
 * would silently stop mailing its users; requiring a positive signal makes the
 * failure mode "still sends real email", which is the safe direction.
 */

/** Deliver through the real provider. */
export const DELIVERY_SEND = "send";

/** Render the mail and write it to the log; never contact the provider. */
export const DELIVERY_LOG_ONLY = "log-only";

/**
 * True only for a real production deployment.
 * @param {Record<string, string|undefined>} env
 */
export const isProduction = (env = process.env) =>
  env.NODE_ENV === "production";

/**
 * Resolve the delivery mode for the current process.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {"send"|"log-only"}
 */
export const mailDeliveryMode = (env = process.env) => {
  // Hard production veto: checked FIRST so no opt-in flag can override it.
  if (isProduction(env)) {
    return DELIVERY_SEND;
  }

  const optedIn =
    env.NODE_ENV === "test" ||
    env.TEST_MODE === "true" ||
    env.DEV_EMAIL_BYPASS === "true";

  return optedIn ? DELIVERY_LOG_ONLY : DELIVERY_SEND;
};

/** Convenience predicate for callers that only care whether we skip the provider. */
export const isMailBypassed = (env = process.env) =>
  mailDeliveryMode(env) === DELIVERY_LOG_ONLY;

/**
 * Pull the actionable links (activation, password reset, email change) out of a
 * rendered HTML template so the developer can paste one into a browser.
 *
 * @param {string} template rendered HTML
 * @returns {string[]} unique verification URLs, in document order
 */
export const extractActionLinks = (template) => {
  if (typeof template !== "string" || template === "") {
    return [];
  }
  const urls = template.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  const interesting = urls.filter((u) => /\/verification\/|auth=|token=/i.test(u));
  return [...new Set(interesting)];
};

/**
 * Flatten a rendered HTML template to a short plain-text digest. Used so that
 * code-bearing mails (OTP, 2FA) are still usable locally, where the secret is
 * in the body rather than in a link.
 *
 * @param {string} template rendered HTML
 * @param {number} maxLength
 */
export const summariseTemplate = (template, maxLength = 400) => {
  if (typeof template !== "string" || template === "") {
    return "";
  }
  const text = template
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
};

/**
 * Log a mail that we deliberately did not send.
 *
 * Returns the same success-shaped object the real gateway returns so callers
 * cannot tell the difference (and so nothing downstream starts retrying).
 *
 * @param {string} to
 * @param {{subject?: string, template?: string}} content
 * @param {{ log?: (...args: unknown[]) => void }} [deps] test seam
 */
export const logMailInsteadOfSending = (to, content = {}, deps = {}) => {
  const log = deps.log || console.log;
  const links = extractActionLinks(content.template);

  log(
    [
      "",
      "==================== DEV EMAIL (NOT SENT) ====================",
      `  to      : ${to}`,
      `  subject : ${content.subject || "(no subject)"}`,
      links.length
        ? `  link    : ${links.join("\n            ")}`
        : `  body    : ${summariseTemplate(content.template)}`,
      "  Delivery is in log-only mode (non-production). Set DEV_EMAIL_BYPASS=false",
      "  and TEST_MODE=false to send through the provider instead.",
      "==============================================================",
      "",
    ].join("\n")
  );

  return { delivered: false, mode: DELIVERY_LOG_ONLY, to, links };
};

/**
 * WHAT AN HTTP HANDLER IS ALLOWED TO PROMISE THE CALLER ABOUT AN EMAIL.
 * ====================================================================
 *
 * Registration replied "Activation mail sent. Please check your email and
 * click the activation link", and the register form added "Sent to <address>.
 * Check your spam folder if it does not arrive." Under `TEST_MODE=true` - how
 * this stack runs - the mode below is `log-only`: the template is rendered,
 * the activation LINK is written to the process log, and the provider is never
 * contacted. Nothing was sent, so nothing can be in a spam folder.
 *
 * The decision lives HERE rather than in the controller so that it is testable
 * against a supplied `env` in both directions. Pinning only the controller lets
 * `delivered` be hardcoded to `false` without any test noticing, because the
 * suites all run in a bypassed environment.
 *
 * Nothing new is disclosed by returning it: GET /api/health already publishes
 * `email.deliveryMode` unauthenticated, and the production veto in
 * `mailDeliveryMode` makes `delivered: false` unreachable in production.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} [subject] what the undelivered mail was carrying, so the
 *   notice on a password reset does not talk about an "activation link"
 */
export const mailDeliveryFacts = (env = process.env, subject = "activation link") => {
  const mode = mailDeliveryMode(env);
  const logOnly = mode === DELIVERY_LOG_ONLY;
  return {
    mailDelivery: mode,
    delivered: !logOnly,
    mailNotice: logOnly
      ? `Email delivery is disabled on this environment, so no message was sent. The ${subject} was written to the server log instead.`
      : "",
  };
};

/**
 * HAND THE UNDELIVERABLE SECRET BACK TO THE CALLER - AND ONLY WHEN NOTHING WAS SENT.
 * =================================================================================
 *
 * WHY THIS IS HERE AT ALL
 * -----------------------
 * `mailDeliveryFacts` fixed the LIE ("we sent you a mail" when nothing was
 * sent) but not the DEAD END. Three flows on this venue cannot be completed
 * without a value that only ever left the building by e-mail:
 *
 *   registration      the activation link (/verification/register?auth=...)
 *   forgot password   the reset link      (/verification/forgotPassword?auth=...)
 *   change password   the six-digit code /sendOTP stores in `user.emailOTP`
 *
 * In `log-only` mode all three are written to the process log and nowhere
 * else. "Honest" was therefore still "locked out": a user - or a marker - with
 * a browser and no terminal can register an account and then never use it, and
 * an account whose password is forgotten is gone for good. Telling someone the
 * truth about a door that does not open is not a working door.
 *
 * So in log-only mode the value comes back in the HTTP response and the page
 * shows it. Nothing about the auth logic moves: the same AES token is minted,
 * `mailToken` / `conFirmMailToken` still single-use it, the OTP is still the
 * one stored on the user document and still expires in three minutes, and
 * `changePassword` still refuses without it. The only thing that changes is
 * WHERE the user can read it.
 *
 * WHY IT CANNOT LEAK
 * ------------------
 * `mailDeliveryMode` short-circuits to `DELIVERY_SEND` on
 * `NODE_ENV === "production"` BEFORE any opt-in flag is consulted, so
 * `isMailBypassed` is false in production and this function returns `{}` -
 * there is no flag combination that turns disclosure on in production. It is
 * also strictly narrower than what already happens: in log-only mode every one
 * of these values is in the process log already.
 *
 * THE HONEST CAVEAT, STATED RATHER THAN BURIED
 * --------------------------------------------
 * `POST /api/auth/forgotPassword` is unauthenticated. In log-only mode it will
 * therefore hand a working reset link to anybody who posts a registered address
 * - i.e. account takeover by anyone who can reach the port. That is acceptable
 * HERE and only here: this is a single-operator local paper venue whose log
 * already prints the same link on the same host, and the production veto makes
 * the behaviour unreachable anywhere real. It is not a pattern to copy onto a
 * deployed service.
 *
 * @param {Record<string, unknown>} disclosure fields to reveal when nothing was sent
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, unknown>} `disclosure` in log-only mode, `{}` otherwise
 */
export const discloseWhenLogOnly = (disclosure = {}, env = process.env) => {
  if (!isMailBypassed(env)) {
    return {};
  }
  if (disclosure === null || typeof disclosure !== "object") {
    return {};
  }
  // Drop empty values so a caller that failed to build a link does not publish
  // `resetLink: ""` and send the page down its "here is your link" branch.
  return Object.fromEntries(
    Object.entries(disclosure).filter(
      ([, value]) => value !== undefined && value !== null && value !== ""
    )
  );
};

export default {
  DELIVERY_SEND,
  DELIVERY_LOG_ONLY,
  isProduction,
  mailDeliveryMode,
  mailDeliveryFacts,
  isMailBypassed,
  discloseWhenLogOnly,
  extractActionLinks,
  summariseTemplate,
  logMailInsteadOfSending,
};
