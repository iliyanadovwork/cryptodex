/**
 * Ownership check for the per-user ("private") socket.io rooms.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every private feed a trading screen renders - open orders, fills, order and
 * trade history, positions, balance deltas - is delivered by
 * socketEmitOne(type, data, userId), which emits into the socket.io room named
 * after the user's mongo _id. Until this module existed the only way into that
 * room was:
 *
 *     socket.on('CREATEROOM', (userId) => socket.join(userId.toString()))
 *
 * The client named the room it wanted and the server joined it, so any client
 * could subscribe to any other user's private stream.
 *
 * WHAT IT DOES
 * ------------
 * It proves ownership with the credential the product already issues, running
 * exactly the checks config/passport.js runs for the REST layer:
 *
 *   1. jwt.verify against config.secretOrKey;
 *   2. the payload role must be "user";
 *   3. the session must still be live - the redis `userToken` hash must hold an
 *      entry for that _id, that entry must not be locked, and its tokenId must
 *      equal the tokenId carried inside the JWT.
 *
 * Step 3 is what makes a re-login (which hset()s a fresh tokenId over the old
 * one) or an account deletion (which hdel()s the entry) invalidate a credential
 * that has not yet expired. There is no second scheme, no second secret and no
 * new store here - the socket layer and the REST layer accept and reject
 * exactly the same tokens.
 */

// import package
import jwt from "jsonwebtoken";

// import config
import config from "./index.js";

// import lib
import isEmpty from "../lib/isEmpty.js";

// import controller
import { hget } from "../controllers/redis.controller.js";

/**
 * Private rooms are named by a mongo user _id and nothing else.
 *
 * Every socketEmitOne() call site in this service passes either a user _id (the
 * private feeds) or one of the public market channels - "spot", "depthChart",
 * or a pair symbol such as BTCUSDT. None of the public names is 24 hex
 * characters, so an ObjectId-shaped room name is a reliable marker for "this is
 * somebody's private room". `subscribe` uses this to refuse to be used as a
 * back door into a room CREATEROOM now guards.
 */
const OBJECT_ID_SHAPE = /^[0-9a-fA-F]{24}$/;

export const isPrivateRoomName = (name) =>
  typeof name === "string" && OBJECT_ID_SHAPE.test(name.trim());

/**
 * The login response and the browser's localStorage both hold the token with
 * the "Bearer " prefix already attached, and ExtractJwt.fromAuthHeaderAsBearer
 * Token() strips it for REST. Accept it either way rather than making the
 * caller remember.
 */
export const stripBearer = (raw) => {
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith("bearer ")
    ? trimmed.slice(7).trim()
    : trimmed;
};

/**
 * Pull the credential out of a CREATEROOM payload.
 *
 * A bare string is the legacy shape - a client-supplied userId with no proof of
 * anything - and deliberately yields no token, so a legacy client is refused
 * rather than silently trusted. The handshake auth field is the fallback so a
 * reconnecting client that set `auth` on the socket does not have to re-emit.
 */
export const extractSocketToken = (payload, socket) => {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const fromPayload = stripBearer(payload.token);
    if (fromPayload) {
      return fromPayload;
    }
  }
  return stripBearer(socket?.handshake?.auth?.token);
};

/**
 * Re-read the live session row. Shared by the join check and by the periodic
 * re-check, so both agree on what "still logged in" means.
 */
const liveSession = async (userId, tokenId) => {
  let userDoc;
  try {
    userDoc = JSON.parse(await hget("userToken", userId));
  } catch (err) {
    return { ok: false, reason: "session_revoked" };
  }
  if (isEmpty(userDoc) || userDoc.userLocked != "false") {
    return { ok: false, reason: "session_revoked" };
  }
  if (userDoc.tokenId != tokenId) {
    return { ok: false, reason: "session_revoked" };
  }
  return { ok: true };
};

/**
 * Verify a credential and return the ONE user id it entitles the socket to.
 * The caller must join that id and must not join anything the client asked for.
 */
export const verifySocketCredential = async (token) => {
  if (!token) {
    return { ok: false, reason: "missing_token" };
  }

  let payload;
  try {
    payload = jwt.verify(token, config.secretOrKey);
  } catch (err) {
    return {
      ok: false,
      reason: err.name === "TokenExpiredError" ? "token_expired" : "bad_token",
    };
  }

  if (payload.role != "user") {
    return { ok: false, reason: "bad_token" };
  }
  if (isEmpty(payload._id)) {
    return { ok: false, reason: "bad_token" };
  }

  const session = await liveSession(payload._id.toString(), payload.tokenId);
  if (!session.ok) {
    return session;
  }

  return {
    ok: true,
    userId: payload._id.toString(),
    tokenId: payload.tokenId == null ? "" : payload.tokenId.toString(),
    expiresAt: payload.exp == null ? null : payload.exp * 1000,
  };
};

/**
 * A join is a one-off, but a session is not: logging in elsewhere rotates the
 * tokenId and deleting the account removes the row, and neither of those can
 * reach a socket that already joined. This sweep is the other half - it walks
 * the sockets that hold a private room and evicts the ones whose credential has
 * stopped being valid, telling them why so the UI can react instead of quietly
 * going stale.
 *
 * One timer per process, not one per socket.
 */
export const startPrivateRoomRecheck = (io, intervalMs = 60000) => {
  const timer = setInterval(async () => {
    let sockets;
    try {
      sockets = Array.from(io?.sockets?.sockets?.values?.() || []);
    } catch (err) {
      return;
    }
    for (const socket of sockets) {
      const userId = socket?.data?.privateRoom;
      if (!userId) {
        continue;
      }
      const expiresAt = socket.data.privateRoomExpiresAt;
      let verdict = { ok: true };
      if (expiresAt && Date.now() >= expiresAt) {
        verdict = { ok: false, reason: "token_expired" };
      } else {
        verdict = await liveSession(userId, socket.data.privateRoomTokenId);
      }
      if (!verdict.ok) {
        evictPrivateRoom(socket, verdict.reason);
      }
    }
  }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
};

export const evictPrivateRoom = (socket, reason) => {
  const userId = socket?.data?.privateRoom;
  if (userId) {
    socket.leave(userId);
  }
  socket.data.privateRoom = null;
  socket.data.privateRoomTokenId = null;
  socket.data.privateRoomExpiresAt = null;
  socket.emit("ROOMREJECTED", { success: false, reason });
};

/**
 * The CREATEROOM handler itself, factored out so it can be tested without a
 * listening server.
 */
export const handleCreateRoom = async (socket, payload, ack) => {
  const verdict = await verifySocketCredential(
    extractSocketToken(payload, socket)
  );

  if (!verdict.ok) {
    // Refusing has to leave the socket OUT of whatever room it was in, or a
    // socket that joined on a now-dead credential would keep its feed by
    // simply never re-authenticating successfully.
    evictPrivateRoom(socket, verdict.reason);
    if (typeof ack === "function") {
      ack({ success: false, reason: verdict.reason });
    }
    return { success: false, reason: verdict.reason };
  }

  // Whatever userId the client sent is ignored. The room is the subject of the
  // token and nothing else.
  const previous = socket.data.privateRoom;
  if (previous && previous !== verdict.userId) {
    socket.leave(previous);
  }
  socket.data.privateRoom = verdict.userId;
  socket.data.privateRoomTokenId = verdict.tokenId;
  socket.data.privateRoomExpiresAt = verdict.expiresAt;
  socket.join(verdict.userId);

  if (typeof ack === "function") {
    ack({ success: true, userId: verdict.userId });
  }
  socket.emit("ROOMJOINED", { success: true, userId: verdict.userId });
  return { success: true, userId: verdict.userId };
};
