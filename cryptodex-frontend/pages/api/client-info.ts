import type { NextApiRequest, NextApiResponse } from "next";

/**
 * WHY THIS EXISTS
 * ===============
 *
 * The login forms used to call https://ipapi.co/json/ from the browser on every
 * mount, purely to fill in the `loginHistory` payload (IP + country) the user
 * API stores against a sign-in. Because the login page is what an expired
 * session lands on, that fired on every navigation, and — being cross-origin
 * from a stack served over plain http on localhost — it was blocked, logging
 * two console errors each time.
 *
 * A local paper-trading stack has no business phoning a third-party geolocation
 * service at all, so the lookup now happens here: same origin, no third party,
 * and the address is the one the Next server actually saw the request arrive
 * on. Country is deliberately NOT guessed — an unknown country is reported as
 * an empty string rather than a made-up one.
 */

export interface ClientInfo {
  ip: string;
  country_name: string;
  country_calling_code: string;
  region: string;
}

/**
 * The client address, preferring the first hop of X-Forwarded-For (the
 * original client when a proxy is in front) and falling back to the socket.
 */
export function resolveClientIp(
  forwardedFor: string | string[] | undefined,
  socketAddress: string | undefined
): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (typeof header === "string") {
    const first = header.split(",")[0]?.trim();
    if (first) return first;
  }
  return (socketAddress || "").trim();
}

/** ::1 / ::ffff:127.0.0.1 / 127.0.0.1 all mean "this machine". */
export function isLoopback(ip: string): boolean {
  if (!ip) return false;
  const bare = ip.replace(/^::ffff:/, "");
  return bare === "::1" || bare === "127.0.0.1" || bare.startsWith("127.");
}

export function buildClientInfo(
  forwardedFor: string | string[] | undefined,
  socketAddress: string | undefined
): ClientInfo {
  const ip = resolveClientIp(forwardedFor, socketAddress);
  return {
    ip,
    // Reported, not inferred. A local stack knows the address it was reached
    // on and nothing else about where the user is.
    country_name: isLoopback(ip) ? "Local" : "",
    country_calling_code: "",
    region: isLoopback(ip) ? "Local" : "",
  };
}

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse<ClientInfo>
) {
  res.status(200).json(
    buildClientInfo(req.headers["x-forwarded-for"], req.socket?.remoteAddress)
  );
}
