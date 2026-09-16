// import package
import io from "socket.io-client";
// import lib
import config from "./index";
import { getSocketCredential } from "./socketCredential";
import { toastAlert } from "../lib/toastAlert";

/**
 * Socket.IO connection options
 * Using WebSocket-first for better real-time performance and background tab handling
 * Polling is kept as fallback for compatibility
 */
var connectionOptions = {
  // WebSocket-first with polling fallback for better reliability
  transports: ['websocket', 'polling'],
  cookie: false,
  forceNew: true,
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 10000, // Increased from 600ms to 10s
  reconnectionAttempts: "Infinity",
  timeout: 10000, // Connection timeout
  // Add ping interval/timeout for better disconnect detection
  // These are client-side settings that help detect stale connections
};

// Only create socket connections on client-side, not during SSR
const isClientSide = typeof window !== 'undefined';

// ONE ENGINE, ONE SOCKET.
// Only open a socket to a service that is actually running: with
// `reconnectionAttempts: "Infinity"` above, a socket pointed at a port nothing
// binds never stops trying and produces an endless reconnect loop in every
// visitor's console.
const spotSocket = isClientSide ? io(config.SPOT_API, connectionOptions) : null;

const privateSockets = () => [
  ["spot", spotSocket],
];

/**
 * Join the per-user rooms that carry open orders, fills, positions, trade
 * history and balance updates.
 *
 * The server no longer takes the client's word for who this socket belongs to:
 * it verifies the JWT and joins the room named by the token's subject, ignoring
 * any userId in the payload. So what has to be sent is the credential, not the
 * id.
 *
 * The `userId` parameter is therefore unused, and is kept only so the existing
 * call sites (navbar.tsx, _app.tsx) still typecheck; the presence of a
 * credential is what decides whether to join. A logged-out visitor has none,
 * gets an early return, and keeps every public market feed - those need no
 * credential and are joined through `subscribe`, not here.
 *
 * Returns true if a join was attempted. Whether it succeeded arrives
 * asynchronously as ROOMJOINED or ROOMREJECTED.
 */
// eslint-disable-next-line no-unused-vars
const createSocketUser = (userId) => {
  const token = getSocketCredential();
  if (!token) {
    return false;
  }
  privateSockets().forEach(([, socket]) => socket?.emit("CREATEROOM", { token }));
  return true;
};

/**
 * A refused join must not present as a screen that simply stops updating.
 *
 * "session_revoked" and "token_expired" mean this browser's credential is no
 * longer good - it was rotated by a login elsewhere, or the account was
 * removed. The honest response is the same one the REST layer's 401 gets: end
 * the session and send the trader to the login page, rather than leaving them
 * looking at a position list frozen at whatever it last showed.
 *
 * Anything else (a malformed payload, a missing token on a page that thought it
 * was logged in) is logged and left alone; it is a client bug, not a reason to
 * throw the user out.
 */
const CREDENTIAL_REASONS = ["session_revoked", "token_expired", "bad_token"];
let sessionEnded = false;

const endSession = (reason) => {
  if (sessionEnded || !isClientSide) {
    return;
  }
  sessionEnded = true;
  try {
    // The same teardown BaseService.ts performs on a REST 401, so a credential
    // that has died reaches one end state whichever layer notices it first.
    localStorage.removeItem("user");
    document.cookie =
      "loggedin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;";
    document.cookie =
      "userToken=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;";
    toastAlert(
      "error",
      reason === "token_expired"
        ? "Your session has expired. Please log in again."
        : "You have been signed out. Please log in again.",
      "socketSession"
    );
  } catch (err) {
    // ignore - the redirect below is what actually matters
  }
  window.location.href = "/login";
};

privateSockets().forEach(([name, socket]) => {
  if (!socket) {
    return;
  }

  /**
   * Re-join on EVERY connect, which covers both the first connection and every
   * reconnect. The old code re-emitted CREATEROOM from the "disconnect"
   * handler, where the socket is by definition down and the emit is dropped;
   * after a server restart or a network blip the socket came back in no room at
   * all and the private feed went quiet with nothing on screen to say so.
   */
  socket.on("connect", () => {
    createSocketUser();
  });

  socket.on("ROOMREJECTED", (data) => {
    console.log(`[${name}Socket] private room refused:`, data?.reason);
    if (CREDENTIAL_REASONS.includes(data?.reason)) {
      endSession(data.reason);
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(`[${name}Socket] Disconnected:`, reason);
  });

  // On the MANAGER, not the socket: `reconnect` is emitted by manager.js, and
  // the Socket only reserves connect / connect_error / disconnect /
  // disconnecting. As `socket.on("reconnect", ...)` this never logged anything.
  // Diagnostics only - the actual re-join is the "connect" handler above, which
  // fires on the first connection and on every reconnect.
  socket.io.on("reconnect", (attemptNumber) => {
    console.log(`[${name}Socket] Reconnected after`, attemptNumber, "attempts");
  });
});

export { spotSocket, createSocketUser };
