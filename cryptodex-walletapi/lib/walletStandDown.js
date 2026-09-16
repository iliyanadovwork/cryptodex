/**
 * STANDING A WALLET DOWN
 * ======================
 *
 * userapi's account-deactivation flow has always had a mandatory wallet gate:
 * `/deactive-confirm` calls the `deactivateWallet` gRPC method and refuses to
 * deactivate anything if that call does not come back `status: true`. The
 * method was declared in userapi/grpc/wallet.proto and implemented NOWHERE -
 * it was missing from this service's proto and from grpc/server.js - so every
 * call returned `12 UNIMPLEMENTED`, the gate always failed, and account
 * deactivation was impossible: a hard 503 on every attempt, 100% of the time.
 * This module is the missing half.
 *
 * WHAT "STANDING DOWN" MEANS HERE, AND WHY
 * ----------------------------------------
 * Three things it could plausibly mean, and what each is worth on THIS stack:
 *
 *   (a) ZERO THE BALANCES. No. Cryptodex is a paper exchange - every balance is
 *       virtual, there is no custody to return and no fiat rail to settle
 *       against - so zeroing destroys the only record of what the account held
 *       and buys nothing in exchange. It would also make the ledger
 *       unauditable and an accidental deactivation unrecoverable, and it is a
 *       write to a user balance ledger, which nothing in a deactivation path
 *       has any business doing.
 *
 *   (b) DELETE THE WALLET. Worse. The `_id` of a wallet is the user's `_id`;
 *       deleting it orphans the passbook, the transaction history and the
 *       redis mirrors, none of which are deleted with it.
 *
 *   (c) MARK IT, AND REFUSE FURTHER MOVEMENT. This one. It is the only option
 *       whose postcondition ("no value can leave or enter this wallet") is
 *       actually the thing the caller wants, it is exactly reversible, and it
 *       costs one boolean. `frozen: true` is set on the wallet document and
 *       every money-moving route in this service - internal transfer, coin
 *       withdraw (both variants), fiat withdraw, fiat deposit, address
 *       creation - refuses with 423 while it is set.
 *
 * So: the balances are left EXACTLY as they are, and the wallet is closed to
 * movement. Restoring an account is `restoreWallet` plus the user-document
 * flip, and the user finds their paper portfolio precisely as they left it.
 *
 * IDEMPOTENCE IS A REQUIREMENT, NOT A NICETY
 * ------------------------------------------
 * The caller is a multi-step cross-service teardown that can be retried after
 * a partial failure, so `standDownWallet` MUST be safe to run twice. It is
 * written as a conditional update - the `frozen: { $ne: true }` filter means a
 * second call matches nothing - and it reports success either way, so a retry
 * neither fails nor rewrites `frozenAt`. The first stand-down's timestamp is
 * the true one and stays the true one; that matters because it is the only
 * record of WHEN the account was closed.
 *
 * `restoreWallet` is idempotent for the same reason and in the same way.
 *
 * A WALLET THAT DOES NOT EXIST IS ALREADY STOOD DOWN
 * --------------------------------------------------
 * `NO_WALLET` is a SUCCESS. The postcondition the caller needs is "no wallet of
 * this user can move value"; a user with no wallet document satisfies it
 * vacuously. Reporting failure would resurrect the original blocker - an
 * account that can never be deactivated - for exactly the users who have the
 * least to stand down. Genuine trouble (an unreachable database, a malformed
 * id) still fails loudly, because those are the cases where the postcondition
 * is UNKNOWN rather than satisfied.
 *
 * The model is injected rather than imported so this is unit-testable without
 * a mongoose connection, and so the one piece of logic that decides what
 * "stood down" means cannot drift between the gRPC handler and the HTTP guard.
 */

/** Why a wallet was stood down. The only reason this service ever writes. */
export const STAND_DOWN_REASON = "account_deactivation";

/** HTTP status for "this wallet exists, holds its balances, and may not move". */
export const STAND_DOWN_HTTP_STATUS = 423; // Locked

export const STAND_DOWN_STATUS = "WALLET_STOOD_DOWN";

export const STAND_DOWN_MESSAGE =
  "This wallet has been stood down because the account was deactivated. Your balances are unchanged. Contact support to restore the account.";

/** "We could not find out whether this wallet may move value." A refusal. */
export const STAND_DOWN_UNKNOWN_HTTP_STATUS = 503;
export const STAND_DOWN_UNKNOWN_STATUS = "WALLET_STATE_UNKNOWN";
export const STAND_DOWN_UNKNOWN_MESSAGE =
  "Could not verify the wallet state. Please try again shortly.";

/**
 * THE SECOND SOURCE: THE SHARED STAND-DOWN MARK
 * =============================================
 *
 * A MARK-ONLY STAND-DOWN DID NOT STOP WALLET MOVEMENT.
 *
 * A stand-down reaches an account through two different doors:
 *
 *   - walletapi's own `wallet.frozen`, set here by `standDownWallet` when
 *     userapi runs an account deactivation; and
 *   - the shared redis hash named by STAND_DOWN_HASH below, which spot reads
 *     and which any service-side deactivation writes.
 *
 * Until this, the guard below read only the FIRST of those. So an account stood
 * down through the mark alone - a row in redis, no `frozen: true` on the wallet
 * document, because nothing in that path calls back into walletapi to set one -
 * was refused by spot and was still free to walk into
 * `POST /api/wallet/transfer`, `/coinWithdraw`, `/fiatWithdraw` or
 * `/createAddress` and move its money. The freeze was real everywhere except in
 * the one service that actually holds the balances.
 *
 * THE WALLET DOCUMENT REMAINS THE AUTHORITY
 * -----------------------------------------
 * It is this service's own record, it is the thing `deactivateWallet` writes
 * and the thing every other service asks about through `mode: "check"`, and it
 * is read FIRST. The mark is a SECOND source, not a replacement: it is consulted
 * only when the document says the wallet is live, because that is the only
 * answer that can be wrong in the unsafe direction. The two can therefore only
 * ever disagree in the safe direction - the request is refused if EITHER says
 * frozen.
 *
 * WALLETAPI READS THAT MARK AND NEVER WRITES IT
 * ---------------------------------------------
 * Deliberate, and the same rule spot follows. This service already has its own
 * authoritative record and its own writer for it (`standDownWallet` /
 * `restoreWallet`), so a second writer here could only ever produce two records
 * of the same fact that can disagree. This module exports no writer for the
 * mark: there is none to call by mistake.
 */

/**
 * The one hash, shared with spotapi.
 *
 * THIS LITERAL IS AGREED ACROSS SERVICES. It must be byte-identical to
 * `STAND_DOWN_HASH` in cryptodex-spotapi/lib/accountStandDown.js; changing it
 * in one service and not the other silently stops the freeze working, which is
 * indistinguishable from it working until an account that should be frozen
 * moves value.
 */
export const STAND_DOWN_HASH = "account_standdown";

/**
 * Turn whatever redis handed back into a record, or null.
 *
 * A writer JSON.stringifies, so a well-formed row parses to an object.
 * Anything else - a truncated write, a hand-edited field, a bare string - is
 * NOT evidence that the account is live,
 * and it is not evidence that it is frozen either. It is CORRUPT, and this
 * returns the marker record for it so the guard can fail closed rather than
 * silently treat a damaged freeze as an absent one.
 */
export const parseStandDownRecord = (raw) => {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return { corrupt: true };
  } catch (err) {
    return { corrupt: true };
  }
};

/** A record another service wrote that this one can no longer understand. */
export const isCorruptRecord = (record) =>
  !!record && record.corrupt === true && record.frozen !== true;

/**
 * READ THE SHARED MARK.
 *
 * Answers { known, frozen }. `known: false` means redis could not be read at
 * all (or answered with something unparseable), which on a money-moving route
 * is a refusal - see the guard. `hget` is injected so this is testable without
 * a redis connection.
 *
 * An id that is not a mongo id is `known: true, frozen: false`: no such field
 * can exist in the hash, so there is nothing unknown about it.
 */
export const readStandDownMark = async ({ hget }, userId) => {
  const id = normaliseUserId(userId);
  if (!id) return { known: true, frozen: false, record: null, invalidId: true };
  try {
    const record = parseStandDownRecord(await hget(STAND_DOWN_HASH, id));
    if (isCorruptRecord(record)) {
      console.log("readStandDownMark: unreadable record for", id);
      return { known: false, frozen: false, record };
    }
    return { known: true, frozen: isStoodDown(record), record };
  } catch (err) {
    console.log("readStandDownMark: failed", id, err && err.message);
    return { known: false, frozen: false, record: null };
  }
};

/**
 * The ONE definition of "stood down", read by both the gRPC path and the HTTP
 * guard. Strictly `=== true`: a missing field, a null, the string "false" and
 * an absent document are all live, so nothing is locked out by accident.
 */
export const isStoodDown = (walletDoc) =>
  !!walletDoc && walletDoc.frozen === true;

/** A 24-hex mongo id, checked without dragging mongoose in. */
const isObjectIdLike = (value) =>
  typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value);

const normaliseUserId = (userId) => {
  if (isObjectIdLike(userId)) return userId;
  if (userId && typeof userId.toString === "function") {
    const asString = userId.toString();
    if (isObjectIdLike(asString)) return asString;
  }
  return null;
};

/**
 * Can this wallet be stood down? Reads only - used as the preflight in
 * userapi's deactivation sequence so the fallible cross-service call happens
 * BEFORE anything irreversible does.
 */
export const checkStandDown = async (Wallet, userId) => {
  const id = normaliseUserId(userId);
  if (!id) return { status: false, message: "INVALID_USER_ID" };
  try {
    const wallet = await Wallet.findById(id).select("frozen").lean();
    if (!wallet) return { status: true, message: "NO_WALLET" };
    if (isStoodDown(wallet)) return { status: true, message: "ALREADY_FROZEN" };
    return { status: true, message: "READY" };
  } catch (err) {
    console.log("checkStandDown: failed", id, err && err.message);
    return { status: false, message: "WALLET_LOOKUP_FAILED" };
  }
};

/**
 * Close the wallet to movement. Idempotent; the balances are not touched.
 */
export const standDownWallet = async (Wallet, userId, reason = STAND_DOWN_REASON) => {
  const id = normaliseUserId(userId);
  if (!id) return { status: false, message: "INVALID_USER_ID" };
  try {
    const wallet = await Wallet.findById(id).select("frozen").lean();
    if (!wallet) {
      // Vacuously stood down. See the header.
      console.log("standDownWallet: no wallet document for", id);
      return { status: true, message: "NO_WALLET" };
    }
    if (isStoodDown(wallet)) {
      return { status: true, message: "ALREADY_FROZEN" };
    }
    // Conditional on still being live, so a concurrent second call cannot
    // overwrite the first stand-down's timestamp.
    await Wallet.updateOne(
      { _id: id, frozen: { $ne: true } },
      {
        $set: {
          frozen: true,
          frozenAt: new Date(),
          frozenReason: reason || STAND_DOWN_REASON,
        },
      }
    );
    // CONFIRM RATHER THAN ASSUME. `updateOne` reporting modifiedCount 0 is the
    // expected answer for the racing-retry case as well as for a write that
    // silently did nothing, so the two are told apart by re-reading the state
    // the caller is being promised.
    const after = await Wallet.findById(id).select("frozen").lean();
    if (!isStoodDown(after)) {
      console.log("standDownWallet: wallet did not take the freeze", id);
      return { status: false, message: "FREEZE_NOT_APPLIED" };
    }
    return { status: true, message: "FROZEN" };
  } catch (err) {
    console.log("standDownWallet: failed", id, err && err.message);
    return { status: false, message: "FREEZE_FAILED" };
  }
};

/**
 * Reopen the wallet. The operator's restore step, and also the compensating
 * action userapi runs if a later step of the deactivation sequence fails - so
 * a wallet is never left closed on an account that is still live.
 */
export const restoreWallet = async (Wallet, userId) => {
  const id = normaliseUserId(userId);
  if (!id) return { status: false, message: "INVALID_USER_ID" };
  try {
    const wallet = await Wallet.findById(id).select("frozen").lean();
    if (!wallet) return { status: true, message: "NO_WALLET" };
    if (!isStoodDown(wallet)) return { status: true, message: "ALREADY_LIVE" };
    await Wallet.updateOne(
      { _id: id },
      { $set: { frozen: false, frozenAt: null, frozenReason: "" } }
    );
    const after = await Wallet.findById(id).select("frozen").lean();
    if (isStoodDown(after)) {
      console.log("restoreWallet: wallet did not take the unfreeze", id);
      return { status: false, message: "UNFREEZE_NOT_APPLIED" };
    }
    return { status: true, message: "RESTORED" };
  } catch (err) {
    console.log("restoreWallet: failed", id, err && err.message);
    return { status: false, message: "UNFREEZE_FAILED" };
  }
};

/**
 * The gRPC surface, one call with an explicit mode. Unknown modes are REFUSED
 * rather than defaulted: a caller that asks for something this service does not
 * understand must not be told "done".
 */
export const STAND_DOWN_MODES = ["freeze", "unfreeze", "check"];

/**
 * "No second source was wired in." It contributes NOTHING, so a guard built
 * without a `readMark` behaves exactly as this guard behaved before the mark
 * existed - the wallet document alone decides. It is never LESS strict than the
 * old behaviour, which is what makes it a safe default for the many unit tests
 * that build the guard with a wallet lookup and nothing else. The real guard in
 * controllers/wallet.controller.js DOES pass one, and a test in
 * tests/unit/wallet-stand-down.test.js asserts that it still does, so this
 * default cannot quietly become the production wiring.
 */
const NO_MARK_SOURCE = async () => ({ known: true, frozen: false });

/**
 * THE GUARD THAT MAKES "STOOD DOWN" MEAN SOMETHING.
 *
 * A factory rather than a middleware so the decision - and every one of its
 * refusals - is testable without mongoose, without redis, without express and
 * without dragging controllers/wallet.controller.js (which loads every coin
 * gateway at module scope) into a unit test.
 *
 * TWO SOURCES, AND THE DOCUMENT IS THE AUTHORITY
 * ----------------------------------------------
 * `findWallet` reads this service's own `wallet.frozen`, which is the authority
 * and is asked FIRST. `readMark` reads the shared stand-down hash, and is asked
 * only when the document says the wallet is live - the one answer that can be
 * wrong in the unsafe direction, because a mark-only stand-down leaves a mark
 * and no document flag at all.
 * The request is refused if EITHER says frozen, so the two can only ever
 * disagree in the safe direction.
 *
 * IT FAILS CLOSED, ON BOTH SOURCES. If the wallet cannot be read, or the mark
 * cannot be read, whether this wallet may move value is UNKNOWN, and "unknown"
 * on a money-moving route is a refusal, not a pass. Letting the request through
 * on a database blip or a redis blip is precisely how a deactivated account
 * would move funds. (Every money-moving route in this service already needs
 * redis to touch a balance at all, so a redis outage does not turn a working
 * transfer into a refused one; it turns a transfer that would have failed
 * half-way into one that fails before it starts.)
 */
export const makeFrozenWalletGuard = ({ findWallet, readMark = NO_MARK_SOURCE }) => async (
  req,
  res,
  next
) => {
  const userId = req && req.user && req.user.id;
  if (!userId) {
    // Unreachable behind passportAuth, and a refusal if it ever is reached.
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const refuseUnknown = (why) => {
    console.log("blockFrozenWallet: wallet state unknown", userId, why, req && req.originalUrl);
    return res.status(STAND_DOWN_UNKNOWN_HTTP_STATUS).json({
      success: false,
      status: STAND_DOWN_UNKNOWN_STATUS,
      message: STAND_DOWN_UNKNOWN_MESSAGE,
    });
  };

  const refuseFrozen = (source) => {
    console.log(
      "blockFrozenWallet: refused stood-down wallet",
      userId,
      req && req.originalUrl,
      source
    );
    return res.status(STAND_DOWN_HTTP_STATUS).json({
      success: false,
      status: STAND_DOWN_STATUS,
      message: STAND_DOWN_MESSAGE,
    });
  };

  // 1. THE AUTHORITY: this service's own wallet document.
  let wallet;
  try {
    wallet = await findWallet(userId);
  } catch (err) {
    console.log(
      "blockFrozenWallet: could not read wallet",
      userId,
      err && err.message
    );
    return refuseUnknown("wallet");
  }
  if (isStoodDown(wallet)) {
    return refuseFrozen("wallet");
  }

  // 2. THE SHARED MARK: what an engine-side stand-down leaves behind, and the
  //    case the document alone cannot see.
  let mark;
  try {
    mark = await readMark(userId);
  } catch (err) {
    // `readStandDownMark` is written not to throw; this is the belt to its
    // braces, and an unreadable second source is UNKNOWN, never a pass.
    console.log("blockFrozenWallet: mark read threw", userId, err && err.message);
    mark = { known: false, frozen: false };
  }
  if (mark && mark.frozen === true) {
    return refuseFrozen("mark");
  }
  if (!mark || mark.known !== true) {
    return refuseUnknown("mark");
  }

  return next();
};

export const applyStandDownMode = async (Wallet, userId, mode) => {
  const wanted = mode === undefined || mode === null || mode === "" ? "freeze" : mode;
  if (wanted === "freeze") return standDownWallet(Wallet, userId);
  if (wanted === "unfreeze") return restoreWallet(Wallet, userId);
  if (wanted === "check") return checkStandDown(Wallet, userId);
  console.log("applyStandDownMode: unknown mode", wanted);
  return { status: false, message: "UNKNOWN_MODE" };
};
