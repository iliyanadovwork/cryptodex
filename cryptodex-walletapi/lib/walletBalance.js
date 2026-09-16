/**
 * THE FREE/LOCKED SPLIT OF A WALLET
 * =================================
 *
 * A wallet ledger is stored as TWO Redis hashes, and the pair only means
 * anything read together:
 *
 *   walletbalance_spot[<userId>_<currencyId>]         the whole pot
 *   walletbalance_spot_locked[<userId>_<currencyId>]  the slice of that pot
 *                                                     held against open
 *                                                     obligations
 *
 * The contract is: the total ALREADY INCLUDES anything currently reserved, the
 * locked hash is a reservation counter and NOT a second pot of money, and the
 * only figure a user can actually act on is the derived
 *
 *     free = total - locked
 *
 * WHAT WENT WRONG
 * ---------------
 * getWallet reported the TOTAL and called it the balance. An account with a
 * balance wholly reserved behind an open obligation was shown that gross figure
 * as its spendable balance - a number it could not move a satoshi of. The UI
 * then sized its "max" from that number, the request was refused by a guard
 * that compared against the same gross total, and the refusal said
 * "Insufficient Balance" about a balance the API had just finished reporting as
 * present.
 *
 * The locked half was worse than absent. getWallet did
 *
 *     let lock = await hget(...);
 *     if (isEmpty(lock)) { await hset(...); }      // <- lock never reassigned
 *
 * so on the first read of a fresh account the locked figure went out as null.
 * A client that computes `parseFloat(total) - parseFloat(locked)` gets NaN from
 * that, and `parseFloat(null)` is NaN: the one consumer that DID ask for the
 * right number was handed NaN by the fresh accounts it mattered most for.
 * Several balance fields were also assigned from the RETURN of `hset`, which is
 * `undefined`, so a first-touch account reported no balance at all.
 *
 * WHY THIS IS A LIBRARY AND NOT AN INLINE SUBTRACTION
 * ---------------------------------------------------
 * controllers/wallet.controller.js imports every coin gateway at module load
 * and cannot be pulled into a unit test. Anything that has to be PROVEN -
 * the clamping, the NaN handling, the fact that a missing locked row means
 * "nothing reserved" rather than "no balance" - therefore has to live in lib/,
 * the same reason lib/spotMirror.js exists.
 *
 * NOTHING HERE RENAMES AN EXISTING FIELD. `spotBal` stays the gross total it
 * has always been; the free figure is ADDED alongside as `spotBalAvailable`.
 */

/** Trim float noise to the 8 decimals the rest of the stack settles at. */
const round8 = (value) => parseFloat(value.toFixed(8));

/**
 * Redis hands back strings, and a missing field as null. A field that has never
 * been written means "nothing here yet", which for a balance is 0 - never NaN,
 * which propagates into a rendered wallet and into arithmetic that then decides
 * what a user may transfer.
 */
export const toLedgerNumber = (value, fallback = 0) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * The spendable balance: total minus what is reserved as margin.
 *
 * The reservation is clamped into [0, max(total, 0)] before subtracting. Both
 * ends matter and neither is theoretical:
 *
 *   - a NEGATIVE locked row (an unfloored `locked - orderCost` on a double
 *     release) would otherwise make `free` LARGER than the pot, which is money
 *     invented at the point of display and then handed to a transfer guard;
 *   - a locked row LARGER than the total (drift, or a settlement that debited
 *     the pot without resizing the reservation) would otherwise make `free`
 *     negative, which reads as a debt the user does not owe.
 *
 * An account genuinely in deficit has a negative TOTAL; that is reported
 * as-is, because a negative free balance is the truth there and nothing can be
 * spent from it either way.
 */
export const freeBalance = (total, locked) => {
  const totalNum = toLedgerNumber(total);
  const lockedNum = Math.min(
    Math.max(toLedgerNumber(locked), 0),
    Math.max(totalNum, 0)
  );
  return round8(totalNum - lockedNum);
};

/**
 * The full reported shape for one wallet ledger.
 *
 * `total` and `locked` come back as NUMBERS rather than the raw Redis strings
 * so a consumer cannot accidentally concatenate them, and `free` is always
 * present - a wallet that reports a balance without saying how much of it is
 * spendable is the defect this module exists to close.
 */
export const balanceBreakdown = (total, locked) => {
  const totalNum = toLedgerNumber(total);
  const lockedNum = Math.min(
    Math.max(toLedgerNumber(locked), 0),
    Math.max(totalNum, 0)
  );
  return {
    total: round8(totalNum),
    locked: round8(lockedNum),
    free: round8(totalNum - lockedNum),
  };
};

/**
 * Why a transfer was refused, in the terms the user can act on.
 *
 * "Insufficient Balance" is the truth when the wallet really is empty and a lie
 * when it is full of margin: the API had just reported the gross total as
 * present, so the same word for both left a user staring at a balance the
 * exchange said they had and refused to move. When something IS reserved, say
 * how much is free and how much is locked; when nothing is reserved, keep the
 * original wording exactly, so nothing that already keys off that string
 * changes behaviour.
 */
export const lockedShortfallMessage = (free, locked) => {
  const lockedNum = Math.max(toLedgerNumber(locked), 0);
  if (lockedNum <= 0) return "Insufficient Balance";
  const freeNum = round8(Math.max(toLedgerNumber(free), 0));
  return (
    `Insufficient available balance. ${freeNum} is free to transfer; ` +
    `${round8(lockedNum)} is reserved as margin for open positions or orders.`
  );
};

export default {
  toLedgerNumber,
  freeBalance,
  balanceBreakdown,
  lockedShortfallMessage,
};
