/**
 * The single place that tears down EVERYTHING a login wrote, so no logout path
 * can leave a valid JWT behind for an API client to keep re-attaching.
 *
 * Login (components/Login/EmailForm.tsx) stores the token in THREE places:
 *   - redux-persist localStorage key "user"
 *   - localStorage "authToken"      (read by services/Wallet/BaseService.ts and
 *                                     services/Wallet/SpotApiService.ts)
 *   - the "userToken" cookie         (read by services/{User,Common,Spot}/BaseService)
 * plus the "loggedin" cookie.
 *
 * Both logout paths used to clear only SOME of these - the navbar button left
 * both the userToken cookie AND authToken localStorage, the idle-timeout left
 * authToken - so every subsequent request re-attached the still-valid token and
 * the session was never actually terminated (the server uses stateless JWTs).
 * Clearing them in one routine is the only way the two paths cannot drift.
 */
export function clearClientSession(): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem("user");
    localStorage.removeItem("authToken");
  } catch (_) {
    // storage disabled / unavailable - nothing to clear
  }

  const expire = "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;";
  document.cookie = "userToken" + expire;
  document.cookie = "loggedin" + expire;
}
