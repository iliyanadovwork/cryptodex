import { useCallback } from "react";
import { useGoogleReCaptcha } from "react-google-recaptcha-v3";
import { recaptchaEnabledHere } from "@/lib/recaptcha";

/**
 * A reCAPTCHA token, or the honest absence of one.
 *
 * WHY THIS EXISTS
 * `_app` no longer mounts GoogleReCaptchaProvider where the site key cannot
 * work — see lib/recaptcha for the red "Localhost is not supported by this site
 * key." card that used to sit in the corner of every page. But nine auth forms
 * call `useGoogleReCaptcha()` directly, and OUTSIDE the provider the library's
 * default context hands back an `executeRecaptcha` that THROWS on call. Every
 * one of those forms would have caught that, toasted "Invalid recaptcha" and
 * refused to submit — trading a cosmetic error card for an app nobody can log
 * into.
 *
 * So the two decisions live together in one place: whether a token is required
 * at all, and how to get one.
 *
 * `required` is what a caller must branch on. It is NOT "did we get a token" —
 * an enabled reCAPTCHA that fails to produce a token must still block, exactly
 * as before. It only says whether this build asks for one.
 */
export interface RecaptchaToken {
  /** True when this build mounts reCAPTCHA and a token is expected. */
  required: boolean;
  /** Resolves to a token, or "" when unavailable/disabled. */
  getToken: (action: string) => Promise<string>;
}

export function useRecaptchaToken(): RecaptchaToken {
  const { executeRecaptcha } = useGoogleReCaptcha();
  // Evaluated per call rather than captured once: it depends only on the
  // origin and the build config, both fixed for the life of the page.
  const required = recaptchaEnabledHere();

  const getToken = useCallback(
    async (action: string): Promise<string> => {
      if (!required) return "";
      if (!executeRecaptcha) return "";
      try {
        return (await executeRecaptcha(action)) || "";
      } catch (err) {
        return "";
      }
    },
    [executeRecaptcha, required]
  );

  return { required, getToken };
}
