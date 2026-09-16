/**
 * THE ONE WAY walletapi MAY MOVE A WALLET BALANCE.
 * ================================================
 *
 * ONE wallet, a TOTAL plus a RESERVATION counter:
 *
 *   spot        walletbalance_spot          walletbalance_spot_locked
 *
 * Spot is the only pot this venue has.
 *
 * WITH ONE WALLET THERE IS NO TRANSFER. A wallet-to-wallet move needs two
 * distinct pots, and the validator rejects a same-wallet move as "Wallet
 * MisMatch" - correctly, because moving a balance to itself is a passbook row
 * for money that never went anywhere. The route is kept and refuses with 410 -
 * see WALLET_TRANSFER_CLOSED in controllers/wallet.controller.js for that
 * argument. `debitFree`/`credit` below stay because they are still the only
 * audited way to move the spot pot, and because the day a second pot exists
 * again the gate must already be correct rather than newly rewritten.
 *
 * WHAT WENT WRONG, AND WHY THE ANSWER IS A MODULE AND NOT A SET OF PATCHES
 * ---------------------------------------------------------------------
 * The balance-moving handlers reached into the ledger hashes with bare
 * `hincbyfloat` calls, and decided affordability from plain HGETs taken near
 * the top of the handler - up to a gRPC round trip's worth of awaits earlier.
 * Two money defects came out of that one shape, both measured live on this
 * stack and both reproduced from an ordinary browser flow (see
 * controllers/redis.controller.js#hdecrbyfloatIfFree for the raw numbers):
 *
 *   1. a payout raced against an order placement, 9 rounds in 10: the whole
 *      balance paid out while a 340 USDC order rested on the book with
 *      `locked` 340 and `available` 0 - i.e. free -340, a live resting order
 *      with nothing behind it.
 *   2. three concurrent 20000 debits of one 20000 balance, 5 rounds in 5,
 *      leaving the source at -40000. 40000 USDC minted outright.
 *
 * (1) is the RIGHT half of the bound `0 <= locked <= available` - the half
 * every previous round left unmeasured while proving the left half exact. (2)
 * is the same defect with the reservation counter at zero, so it shows up as
 * an outright double spend.
 *
 * WHAT WAS CONSIDERED AND REJECTED
 * --------------------------------
 * "Let each caller do its own HGET, compare, then HINCRBYFLOAT" is what was
 * there, and the measurement above is what it is worth: a gate computed in
 * node from a snapshot is not a gate. Nor is "use a plain settlement helper" -
 * a settlement (a realised loss, a fee) is ALLOWED to push `available` below
 * `locked`; a user-initiated debit is not, and the difference is a property of
 * the CALLER, not of the key. Uniform spelling would have left both defects
 * exactly where they were.
 *
 * So the split is by INTENT, and it is the only rule this module has:
 *
 *   a DEBIT of a wallet the user is moving money OUT of is conditional on the
 *   free balance, decided inside redis, in the same command that applies it;
 *
 *   a CREDIT is unconditional, because adding money can never break
 *   `locked <= available`.
 *
 * `debitFree` is the only debit, `credit` is the only credit, and neither can be
 * called without naming a wallet type from WALLET_LEDGERS. A raw write would
 * have to import `hincbyfloat` and spell one of these hash names itself, which
 * `tests/unit/spot-write-call-sites.test.js` fails the build for - the same
 * guard, and the same idiom, that already stops a spot write bypassing
 * lib/spotMirror.js.
 *
 * DEPENDENCIES ARE INJECTED, not imported, for the reason lib/spotMirror.js
 * gives: controllers/wallet.controller.js loads every coin gateway at module
 * scope and cannot be pulled into a test, so the logic has to live somewhere a
 * test can reach.
 */

import { applySpotDelta } from "./spotMirror.js";

/**
 * The redis pair behind each wallet a transfer can name, and the settlement
 * mirror (if any) that has to move with the total.
 *
 * `spot` names `walletbalance_spot_locked` even though nothing in the stack
 * currently increments it: a resting spot order's funds are DEBITED out of
 * `walletbalance_spot` into `walletbalance_spot_inOrder` rather than reserved in
 * place, so spot's free balance IS its total and the guard below reduces to
 * `total >= amount`. Naming the counter anyway costs one HGET inside a Lua step
 * and means the day something does start writing it, the transfer gate is
 * already correct instead of newly wrong.
 */
export const WALLET_LEDGERS = {
  spot: {
    total: "walletbalance_spot",
    locked: "walletbalance_spot_locked",
    mirror: null,
  },
};

export const WALLET_TYPES = Object.keys(WALLET_LEDGERS);

/** Redis field for one user + coin. Every one of these hashes uses this shape. */
export const ledgerField = (userId, currencyId) =>
  `${userId?.toString()}_${currencyId?.toString()}`;

/** Redis answers strings, and null for an absent field. Never propagate NaN. */
export const toNumber = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Read one wallet's { total, locked, free } straight from redis. */
export const readWallet = async (
  { userId, currencyId, walletType },
  { hget } = {}
) => {
  const ledger = WALLET_LEDGERS[walletType];
  if (!ledger || !hget) return null;
  const field = ledgerField(userId, currencyId);
  const total = toNumber(await hget(ledger.total, field));
  const locked = toNumber(await hget(ledger.locked, field));
  return { total, locked, free: total - locked };
};

/**
 * Bring the wallet's settlement mirror to the total the write just produced.
 *
 * NO WALLET ON THIS VENUE HAS A MIRROR. A settlement mirror existed so an
 * external reader could take an absolute figure without going through this
 * service; there is no such reader now. `spot` declares `mirror: null`, so this
 * function returns false on the first line for every call the service can make,
 * and no mirror hash is written by anything.
 *
 * IT IS KEPT, AND KEPT ABSOLUTE, rather than deleted with its callers. The
 * contract it encodes is the one that was expensive to learn: a mirror follows
 * the pot to wherever the pot ended up, and is never moved by its own delta.
 * The delta form carried any pre-existing gap forward for ever - 10.32 USDC of
 * permanent drift measured on one live account before it was changed. If a
 * second pot with an external reader is ever added, the rule it has to obey is
 * already written down and already implemented, instead of being rediscovered.
 *
 * Never throws: the pot has already moved and a mirror write that fails must
 * not turn a completed movement into a 500.
 */
const syncMirror = async (walletType, userId, currencyId, total, { hset } = {}) => {
  const ledger = WALLET_LEDGERS[walletType];
  if (!ledger || !ledger.mirror) return false;
  const value = parseFloat(total);
  // A balance that is not a number cannot be mirrored ONTO anything. Leaving
  // the mirror alone keeps the last true value; writing NaN destroys it, and
  // controllers/redisWalletBackUp.js would then persist the NaN into mongo.
  if (!Number.isFinite(value)) return false;
  try {
    await hset(ledger.mirror, ledgerField(userId, currencyId), value);
    return true;
  } catch (err) {
    console.log("[walletLedger] mirror write failed", walletType, err?.message);
    return false;
  }
};

/**
 * TAKE `amount` OUT of a wallet, but only if that wallet's FREE balance covers
 * it - tested and applied in ONE redis command.
 *
 * The refusal is the important return value. `status:false` means NOTHING
 * MOVED: the guard and the decrement were the same command, so there is no
 * half-applied state for the caller to unwind, and the caller must answer the
 * request rather than continuing on to credit the destination. A credit written
 * after a refused debit is money created.
 *
 * `reason` distinguishes the two refusals a caller may want to word
 * differently: `insufficient_free` (the account genuinely cannot afford it,
 * including because the shortfall is reserved margin) and `ledger_unavailable`
 * (redis could not answer). Both refuse.
 */
export const debitFree = async (
  { userId, currencyId, coin, walletType, amount },
  deps = {}
) => {
  const ledger = WALLET_LEDGERS[walletType];
  const amt = parseFloat(amount);
  if (!ledger) {
    return { status: false, reason: "unknown_wallet", applied: 0 };
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    return { status: false, reason: "invalid_amount", applied: 0 };
  }

  const field = ledgerField(userId, currencyId);
  const after = await deps.hdecrbyfloatIfFree(
    ledger.total,
    ledger.locked,
    field,
    amt
  );

  if (after === null || after === undefined) {
    // Report what the row HOLDS, so the caller can tell the user how much of
    // the shortfall is reserved margin rather than simply absent. Read after
    // the refusal, never before it: the refusal is the authority on whether
    // anything moved, and this read is only for the message.
    const row = (await readWallet({ userId, currencyId, walletType }, deps)) || {
      total: 0,
      locked: 0,
      free: 0,
    };
    return {
      status: false,
      reason: "insufficient_free",
      walletType,
      field,
      applied: 0,
      ...row,
    };
  }

  const total = toNumber(after);
  // A spot balance has no mirror to bring into step: the flat `assets` ledger
  // and its second redis field went with USDC, the only coin they ever held.
  // The engine field the write just moved is now the whole of the truth.
  if (walletType !== "spot") {
    await syncMirror(walletType, userId, currencyId, total, deps);
  }

  const locked = toNumber(await deps.hget(ledger.locked, field));
  return {
    status: true,
    walletType,
    field,
    applied: amt,
    total,
    locked,
    free: total - locked,
  };
};

/**
 * PUT `amount` INTO a wallet. Unconditional, and deliberately so: a credit
 * cannot break `locked <= available`, and refusing one would strand money that
 * has already left the source wallet.
 */
export const credit = async (
  { userId, currencyId, coin, walletType, amount },
  deps = {}
) => {
  const ledger = WALLET_LEDGERS[walletType];
  const amt = parseFloat(amount);
  if (!ledger) return { status: false, reason: "unknown_wallet", applied: 0 };
  if (!Number.isFinite(amt) || amt <= 0) {
    return { status: false, reason: "invalid_amount", applied: 0 };
  }

  const field = ledgerField(userId, currencyId);
  let total;
  if (walletType === "spot") {
    total = toNumber(
      await applySpotDelta({ userId, currencyId, delta: amt }, deps)
    );
  } else {
    total = toNumber(await deps.hincbyfloat(ledger.total, field, amt));
    await syncMirror(walletType, userId, currencyId, total, deps);
  }

  const locked = toNumber(await deps.hget(ledger.locked, field));
  return {
    status: true,
    walletType,
    field,
    applied: amt,
    total,
    locked,
    free: total - locked,
  };
};

export default {
  WALLET_LEDGERS,
  WALLET_TYPES,
  ledgerField,
  toNumber,
  readWallet,
  debitFree,
  credit,
};
