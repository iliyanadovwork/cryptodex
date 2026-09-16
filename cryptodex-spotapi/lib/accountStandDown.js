/**
 * STANDING A SPOT ACCOUNT DOWN
 * ============================
 *
 * THE HOLE THIS FILLS
 * -------------------
 * A wallet freeze on Cryptodex had three enforcers and, until this file, spot
 * was not one of them:
 *
 *   - walletapi sets and honours `wallet.frozen` (lib/walletStandDown.js);
 *   - two further trading services honoured it, and both were removed with the
 *     products they served;
 *   - SPOT HONOURED NOTHING AT ALL.
 *
 * walletapi and this file are the two enforcers left, which makes this one MORE
 * load bearing than when it was written, not less: spot is now the only trading
 * surface on the venue.
 *
 * There was no freeze check anywhere in this service - not in the router, not
 * in orderPlace, not in the faucet, not in the paper withdrawal path. A frozen
 * wallet whose owner still held a live session could therefore walk straight
 * into POST /api/spot/orderPlace and:
 *
 *   - have its spot balance DEBITED and moved into `walletbalance_spot_inOrder`
 *     by the limit path, or debited outright by the market path;
 *   - rest an order the 2s matcher would go on filling, so the account keeps
 *     TRADING after it was closed;
 *   - top itself back up from `/faucet/claim`, or reset its whole ledger from
 *     `/faucet/reset`;
 *   - drain the balance out through `/requestWithdrawal`.
 *
 * Deactivation only ever reached spot as a one-shot sweep
 * (`cancelOrderForDeactiveAcc`, the gRPC userapi calls once at closure time).
 * A sweep is not a gate: it cancels what is resting AT THAT INSTANT and says
 * nothing about the next request. Spot is also the product most users reach
 * first, which makes it the widest of the three holes and the last to be shut.
 *
 * WHAT IS ENFORCED, AND WHAT DELIBERATELY IS NOT
 * ---------------------------------------------
 * The line is deliberate, and it is stated here in full rather than left to be
 * reinvented per route:
 *
 *     NOTHING MAY CREATE OR SETTLE EXPOSURE.
 *     RELEASING AN UNFILLED RESERVATION IS ALWAYS ALLOWED.
 *
 * So on this service the gate is on:
 *
 *   POST /orderPlace          both order types - limit and market - because they
 *                             dispatch through the one handler
 *                             (spot.controller.orderPlace). One gate, all forms.
 *   POST /faucet/claim        credits FAUCET_AMOUNT to every faucet coin.
 *                             It moves value.
 *   POST /faucet/reset        SETS every faucet balance and ZEROES every other
 *                             one. It moves value, in both directions at once.
 *   POST /requestWithdrawal   debits `walletbalance_spot` and issues a paper
 *                             withdrawal. It moves value OUT of the account,
 *                             which is the plainest thing a frozen wallet must
 *                             not be able to do.
 *
 * And it is deliberately NOT on:
 *
 *   POST /cancelOrder         A cancel moves nothing out of the account. It
 *                             turns `walletbalance_spot_inOrder` back into
 *                             spendable `walletbalance_spot` INSIDE THE SAME
 *                             WALLET. Gating it would make a stand-down the one
 *                             thing that TRAPS a user's funds behind an
 *                             unfilled order, which is precisely the failure
 *                             this design is written to avoid, and
 *                             it would strand the reservation of every order
 *                             that happened to be resting when the freeze
 *                             landed. It stays open, always.
 *   the gRPC `cancelOrderForDeactiveAcc`
 *                             Same reason, and it is the deactivation's OWN
 *                             sweep: gating it would mean a stand-down could
 *                             block its own cleanup.
 *   every read route          Order books, open orders, trade history, deposit
 *                             history, withdrawal status/history, charts,
 *                             market price, depth. A stood-down user must still
 *                             be able to SEE their account; hiding it neither
 *                             protects the ledger nor helps anyone, and a read
 *                             cannot move a balance. Refusing them would also
 *                             break the UI a user needs in order to find and
 *                             cancel the orders they are still allowed to
 *                             cancel.
 *
 * WHY THE FAUCET IS ON THE LIST
 * -----------------------------
 * "Every number is virtual" is an argument about consequence, not about
 * correctness. A faucet claim writes to `walletbalance_spot` and to a
 * DepositEvent row; a reset writes to those and zeroes every other coin. If a frozen account can re-fund itself the
 * freeze means nothing the moment the user presses the button - the balance the
 * closure froze is simply replaced. It is a value-moving route and it is gated
 * like one.
 *
 * WHO IS THE AUTHORITY
 * --------------------
 * walletapi's `wallet.frozen` is, and it is read through its existing
 * read-only `deactivateWallet(mode: "check")`.
 *
 * `account_standdown` (redis) is consulted FIRST. It is a local redis read
 * against a service that is already unusable without redis, so asking it first
 * costs nothing and cannot be defeated by a walletapi outage.
 *
 * NOTHING WRITES THAT MARK ANY MORE. Its only writers were removed with the
 * products they served. The hash is still READ here and by walletapi, and it
 * still holds whatever was last written to it - so the read is kept rather
 * than removed, and an old mark is still honoured.
 *
 * The consequence, stated plainly because it is a real change: the fast local
 * path no longer fires for a NEW deactivation, so the authority below -
 * walletapi's `wallet.frozen`, which userapi still sets on every deactivation -
 * is what actually freezes an account today. If walletapi cannot be reached the
 * answer is UNKNOWN rather than "not frozen", and unknown REFUSES (503). The
 * freeze therefore still holds; it is availability that got worse, not safety.
 *
 * SPOT READS THAT MARK AND NEVER WRITES IT
 * ----------------------------------------
 * Deliberate, and unchanged. The mark was set by the account-wide deactivation
 * flow; this service has no business minting or clearing an account-level
 * freeze from a trading route - it has no deactivation flow, no operator
 * surface and no compensating action to undo a bad write with. Adding
 * `hset`/`hdel` here would widen the surface that can lock a user out of the
 * venue for no gain, so this module exports no writer at all: there is nothing
 * to call by mistake. THE HASH NAME IS NOT UP FOR RENAMING EITHER: walletapi
 * still reads `account_standdown`, so changing it would be a migration, not a
 * rename, and it would orphan every mark already stored under it.
 *
 * IT FAILS CLOSED
 * ---------------
 * If neither source can be read, whether this account may move value is
 * UNKNOWN, and unknown on a value-moving route is a refusal (503), not a pass.
 * Letting the request through on a redis blip or a walletapi restart is exactly
 * how a frozen account keeps trading.
 *
 * Everything here takes its dependencies as arguments so the one module that
 * decides what "stood down" means cannot drift between the HTTP guard and any
 * future caller, and so all of it is testable without redis, without express
 * and without importing spot.controller.js (7k lines that start a matcher and a
 * pair cache at module scope).
 */

/** The one hash, shared with walletapi. Field = userId. */
export const STAND_DOWN_HASH = "account_standdown";

/** "This account exists, keeps its orders and balances, and may not act." */
export const STAND_DOWN_HTTP_STATUS = 423; // Locked
export const STAND_DOWN_STATUS = "ACCOUNT_STOOD_DOWN";
export const STAND_DOWN_MESSAGE =
  "This account has been stood down, so it cannot place spot orders, claim or reset demo funds, or withdraw. Your existing orders and balances are unchanged, and you can still cancel open orders. Contact support to restore the account.";

/** "We could not find out whether this account may act." A refusal. */
export const STAND_DOWN_UNKNOWN_HTTP_STATUS = 503;
export const STAND_DOWN_UNKNOWN_STATUS = "ACCOUNT_STATE_UNKNOWN";
export const STAND_DOWN_UNKNOWN_MESSAGE =
  "Could not verify the account state, so nothing was changed. Please try again shortly.";

/**
 * The ONE definition of "stood down". Strictly `=== true`: a missing field, a
 * null, the string "false" and an absent record are all LIVE, so nobody is
 * locked out of the exchange by an accident of shape.
 */
export const isStoodDown = (record) => !!record && record.frozen === true;

/** A 24-hex mongo id, checked without dragging mongoose in. */
const isObjectIdLike = (value) =>
  typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value);

export const normaliseUserId = (userId) => {
  if (isObjectIdLike(userId)) return userId;
  if (
    userId !== null &&
    userId !== undefined &&
    typeof userId.toString === "function"
  ) {
    const asString = userId.toString();
    if (isObjectIdLike(asString)) return asString;
  }
  return null;
};

/**
 * Turn whatever redis handed back into a record, or null.
 *
 * The writers JSON.stringify their record, so a well-formed row parses to an
 * object. Anything else - a truncated write, a
 * hand-edited field, a bare string - is NOT evidence that the account is live,
 * and it is not evidence that it is frozen either. It is CORRUPT, and this
 * returns the marker record for it so `resolveStandDown` can fail closed rather
 * than silently treat a damaged freeze as an absent one.
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
 * all (or answered with something unparseable), which is the one case where
 * this module has no opinion and the caller has to fall back to the authority -
 * or, if that is unreadable too, refuse.
 *
 * An id that is not a mongo id is `known: true, frozen: false`: no such field
 * can exist in the hash, so there is nothing unknown about it. It is reported
 * with `invalidId` so a caller that cares can tell the two apart.
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
 * THE VERDICT THAT EVERY GUARD USES.
 *
 * `readMark`   - () => { known, frozen }, the shared `account_standdown` mark.
 * `readWallet` - () => { known, frozen }, walletapi's `wallet.frozen`.
 *
 * Returns { frozen, known, source }:
 *   frozen: true            refuse, this account is stood down
 *   frozen: false, known    let it through
 *   known: false            UNKNOWN - refuse
 *
 * The two sources can only ever disagree in the SAFE direction: the account is
 * refused if EITHER says frozen. The mark short-circuits, so walletapi is asked
 * only when the mark says "live" - the only answer that can be wrong in the
 * unsafe direction, because an operator freeze applied through walletapi alone
 * leaves no mark at all and that is exactly the case this exists to catch.
 */
export const resolveStandDown = async ({ readMark, readWallet }) => {
  let mark = { known: false, frozen: false };
  try {
    mark = (await readMark()) || { known: false, frozen: false };
  } catch (err) {
    console.log("resolveStandDown: local mark threw", err && err.message);
    mark = { known: false, frozen: false };
  }
  if (mark.frozen === true) {
    return { frozen: true, known: true, source: "local" };
  }

  let wallet = { known: false, frozen: false };
  try {
    wallet = (await readWallet()) || { known: false, frozen: false };
  } catch (err) {
    console.log("resolveStandDown: wallet check threw", err && err.message);
    wallet = { known: false, frozen: false };
  }
  if (wallet.frozen === true) {
    return { frozen: true, known: true, source: "wallet" };
  }
  if (mark.known === true && wallet.known === true) {
    return { frozen: false, known: true, source: "none" };
  }
  // At least one of the two could not be read, and neither said "frozen".
  return { frozen: false, known: false, source: "unknown" };
};

/**
 * THE GUARD THAT MAKES "STOOD DOWN" MEAN SOMETHING ON SPOT.
 *
 * A factory rather than a middleware so the decision - and each of its three
 * refusals - is testable without express, without redis and without importing
 * a controller that loads the whole matching engine at module scope.
 *
 * It is mounted AFTER passportAuth and BEFORE the decrypt/validate chain, so a
 * refused order is refused before its body is even decrypted and long before
 * anything reads or writes a balance.
 */
export const makeStandDownGuard = ({ resolve }) => async (req, res, next) => {
  const userId = req && req.user && req.user.id;
  if (!userId) {
    // Unreachable behind passportAuth, and a refusal if it ever is reached.
    return res.status(401).json({ status: false, success: false, message: "Unauthorized" });
  }
  let verdict;
  try {
    verdict = await resolve(userId);
  } catch (err) {
    // `resolve` is written not to throw, so this is the belt to its braces: a
    // guard that throws would hand express an unhandled rejection and, with no
    // error middleware mounted on this app, hang the request. UNKNOWN is the
    // only honest verdict, and UNKNOWN is a refusal.
    console.log("blockStoodDownAccount: resolve threw", String(userId), err && err.message);
    verdict = { frozen: false, known: false, source: "threw" };
  }
  if (verdict && verdict.frozen === true) {
    console.log(
      "blockStoodDownAccount: refused stood-down account",
      String(userId),
      req && req.originalUrl,
      verdict.source
    );
    return res.status(STAND_DOWN_HTTP_STATUS).json({
      status: false,
      success: false,
      reason: STAND_DOWN_STATUS,
      message: STAND_DOWN_MESSAGE,
    });
  }
  if (!verdict || verdict.known !== true) {
    console.log(
      "blockStoodDownAccount: account state unknown",
      String(userId),
      req && req.originalUrl
    );
    return res.status(STAND_DOWN_UNKNOWN_HTTP_STATUS).json({
      status: false,
      success: false,
      reason: STAND_DOWN_UNKNOWN_STATUS,
      message: STAND_DOWN_UNKNOWN_MESSAGE,
    });
  }
  return next();
};
