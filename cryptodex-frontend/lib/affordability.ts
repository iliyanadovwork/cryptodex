/**
 * "YOU CANNOT PAY FOR THIS" — said by the ticket that is already showing the
 * balance.
 *
 * WHAT THIS IS NOT
 * It is NOT a client-side rewrite of a server verdict. The spot API owns the
 * refusal and already sends the right words for it
 * (spotapi controllers/spot.controller.js: "Due to insufficient balance order
 * cannot be placed", healthReason "insufficient_balance"), and every one of
 * those messages is surfaced verbatim. Nothing here ever turns a server message
 * into a different one.
 *
 * WHAT THIS IS
 * A pre-flight on the number the ticket is ALREADY PRINTING two rows above the
 * button. The form shows "Available: 8,575 USD"; submitting 999,999 USD from
 * that same form is the UI contradicting itself, and the round trip can only
 * come back saying what the form could already see. It also closes a real hole:
 * the server's affordability check deliberately FAILS OPEN when the account's
 * Redis balance row has never been written (a first-touch account or a coin the
 * user has never held), and in that case an unaffordable market order larger
 * than the resting ladder is refused with the LIQUIDITY message — "there is not
 * enough liquidity ... try a smaller size" — which sends the user hunting for a
 * problem at the venue that is really a problem with their balance.
 *
 * DELIBERATELY CONSERVATIVE
 * It fires only when a balance has actually been read AND the requirement
 * exceeds it beyond a rounding hair. An unknown balance, an unparseable
 * requirement, or a 100%-of-balance order all pass straight through to the
 * server, because a false "you are broke" is worse than a round trip.
 */

/**
 * Slack before we call an order unaffordable.
 *
 * TWO SEPARATE REASONS THE TWO NUMBERS CAN DISAGREE HARMLESSLY:
 *
 * 1. FLOATING POINT. The 100% slider writes the balance into the amount field,
 *    and both sides have been through toFixedDown/parseFloat, so they can
 *    differ in the last binary place. Hence the relative epsilon.
 *
 * 2. THE DISPLAY ROUNDS. The ticket prints "Available 0.03062327 BTC" using
 *    Intl, which ROUNDS to the pair's precision — so the figure on screen can
 *    be very slightly LARGER than the balance behind it. A user who types
 *    exactly what the ticket shows them must not be told they cannot afford it.
 *    (Observed live: entering the displayed 0.03062327 BTC against a real
 *    0.030623265 balance was refused before this allowance existed.)
 *
 * So the tolerance is half a unit of the last displayed digit, which is exactly
 * the most the display can be hiding — plus the float epsilon. It is orders of
 * magnitude smaller than any refusal worth making: this exists to catch
 * 999,999,999 against 8,575, not to arbitrate the eighth decimal.
 */
const RELATIVE_EPSILON = 1e-9;

export interface AffordabilityInput {
  /** What the order will debit, in `symbol`. */
  required: any;
  /** What the ticket is showing as available, in `symbol`. */
  available: any;
  /** Currency the two figures are in, for the message. */
  symbol?: string;
  /**
   * Decimal places the balance is DISPLAYED to (the pair's float digit).
   * Omitted means "unknown", and a conservative 8 is assumed.
   */
  precision?: any;
}

/**
 * The message to show, or null when the order should be sent.
 *
 * Null covers three cases on purpose: it IS affordable, the balance is unknown,
 * or the requirement is not a number we can judge.
 */
export function affordabilityError({
  required,
  available,
  symbol,
  precision,
}: AffordabilityInput): string | null {
  const need = parseFloat(required);
  if (!Number.isFinite(need) || need <= 0) return null;

  // An absent balance is "not known", never "zero" — undefined, null, "" and
  // anything unparseable all land on NaN here and all pass the order through.
  // Only a figure we actually read can refuse one. (A balance read as a real 0
  // parses fine and DOES refuse.)
  const have = parseFloat(available);
  if (!Number.isFinite(have)) return null;

  const digits = Number.isFinite(parseInt(precision, 10))
    ? parseInt(precision, 10)
    : 8;
  const displaySlack = 0.5 * Math.pow(10, -digits);
  const allowance = Math.abs(have) * RELATIVE_EPSILON + displaySlack;

  if (need <= have + allowance) return null;

  const coin = symbol ? ` ${symbol}` : "";
  return `Insufficient balance: this order needs ${trim(need)}${coin} and you have ${trim(
    have
  )}${coin}.`;
}

/**
 * Numbers for humans in an error string: no exponent notation, no fifteen
 * decimal places, no trailing zeros.
 */
function trim(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  const decimals = abs >= 1 ? 2 : 8;
  const fixed = value.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}
