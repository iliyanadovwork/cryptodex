/**
 * THE ROUTING TABLE - the one fact that makes a single public port possible.
 * =========================================================================
 *
 * Railway exposes exactly ONE port per service. The browser, however, talks to
 * three Express apps: userapi, walletapi and spotapi. Something has to put them
 * behind one hostname.
 *
 * The happy discovery is that NOTHING HAS TO BE REWRITTEN. The three services
 * were already mounted on disjoint path spaces - read off their server.js
 * files:
 *
 *   userapi    /api/auth  /api/user  /api/language   /app/auth /app/user /app/language
 *   walletapi  /api/wallet  /api/currency  /api/common
 *   spotapi    /api/spot  /api/dashboard   /app/spot /app/dashboard   + /socket.io
 *
 * Every path is unique at its FIRST segment after /api (or /app). The gateway
 * can therefore route by prefix and forward the URL BYTE FOR BYTE. No prefix
 * stripping, no prefix adding, no path rewriting anywhere.
 *
 * WHY THAT MATTERS MORE THAN IT LOOKS - SOCKET.IO.
 *
 * The obvious alternative was to give each service a prefix and rewrite:
 * /user/... -> userapi, /spot/... -> spotapi. That breaks the trading screen,
 * and it breaks it in a way that is easy to miss until the venue is live.
 * The frontend opens its socket with
 *
 *     io(config.SPOT_API, connectionOptions)          // socketConnectivity.js
 *
 * and socket.io-client does NOT read a path out of that URL - it reads a
 * NAMESPACE. `io("https://host/spot")` connects to https://host, engine.io path
 * "/socket.io/", namespace "/spot". spotapi registers no "/spot" namespace, so
 * the handshake is refused with "Invalid namespace" and the order book, the
 * depth chart and the trade feed never arrive. Making it work would mean
 * editing connectionOptions to add `path: "/spot/socket.io"`, editing the
 * gateway to match, and keeping the two in step forever.
 *
 * Routing on the real paths avoids all of it. config.SPOT_API becomes the plain
 * origin, the namespace stays "/", the engine.io path stays "/socket.io/", and
 * socketConnectivity.js is not touched. The frontend change is limited to env
 * vars: every NEXT_PUBLIC_*_API / _URL points at the same origin.
 *
 * ONE SHARED PATH, DELIBERATELY. All three services answer /api/health (the
 * comment in spotapi/server.js explains why: one probe path has to work
 * everywhere). A prefix table cannot express "all three", so the gateway owns
 * /api/health itself and fans out - see gateway.mjs. That is strictly better
 * for Railway, whose healthcheck then fails if ANY of the three is sick rather
 * than only the one that happened to win the routing table.
 *
 * STATIC FILES. userapi and walletapi both call express.static(__dirname +
 * "/public"), which serves at the ROOT of their path space, not under /api:
 *   userapi/public/images/...     -> /images/...      (profile images)
 *   walletapi/public/currency/... -> /currency/...    (coin icons; walletapi's
 *                                    currency.controller.js builds these URLs
 *                                    as config.SERVER_URL + "/currency/" + f)
 * Those are listed too. They are disjoint as well.
 */

/**
 * Longest-prefix wins. A prefix matches when the path equals it or continues
 * with "/" or "?" - so "/api/user" matches "/api/user" and "/api/user/profile"
 * but never "/api/usersomethingelse".
 */
export const ROUTES = [
  // ---- userapi -----------------------------------------------------------
  { prefix: "/api/auth", service: "userapi" },
  { prefix: "/api/user", service: "userapi" },
  { prefix: "/api/language", service: "userapi" },
  { prefix: "/app/auth", service: "userapi" },
  { prefix: "/app/user", service: "userapi" },
  { prefix: "/app/language", service: "userapi" },
  { prefix: "/images", service: "userapi" },
  { prefix: "/profile", service: "userapi" },

  // ---- walletapi ---------------------------------------------------------
  { prefix: "/api/wallet", service: "walletapi" },
  { prefix: "/api/currency", service: "walletapi" },
  { prefix: "/api/common", service: "walletapi" },
  { prefix: "/currency", service: "walletapi" },
  { prefix: "/deposit", service: "walletapi" },

  // ---- spotapi -----------------------------------------------------------
  { prefix: "/api/spot", service: "spotapi" },
  { prefix: "/api/dashboard", service: "spotapi" },
  { prefix: "/app/spot", service: "spotapi" },
  { prefix: "/app/dashboard", service: "spotapi" },
  // The socket. Same origin, same engine.io path, namespace "/" - exactly what
  // socket.io-client asks for when handed a bare origin. Both transports come
  // through here: `polling` as ordinary chunked HTTP, `websocket` as an Upgrade
  // that gateway.mjs tunnels at the TCP level.
  { prefix: "/socket.io", service: "spotapi" },
];

/** Upstream ports inside the container. Loopback, exactly as on the dev machine. */
export const UPSTREAMS = {
  userapi: Number(process.env.USERAPI_PORT || 2567),
  walletapi: Number(process.env.WALLETAPI_PORT || 3002),
  spotapi: Number(process.env.SPOTAPI_PORT || 2568),
};

/** Sorted longest-first so /api/user cannot shadow /api/userfoo-style additions. */
const SORTED = [...ROUTES].sort((a, b) => b.prefix.length - a.prefix.length);

export function routeFor(pathname) {
  for (const r of SORTED) {
    if (pathname === r.prefix) return r.service;
    if (pathname.startsWith(r.prefix)) {
      const next = pathname[r.prefix.length];
      if (next === "/" || next === "?") return r.service;
    }
  }
  return null;
}
