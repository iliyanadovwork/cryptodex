/**
 * "IS THIS FIELD A NUMBER?" - ONE ANSWER, FOR EVERY ORDER FIELD.
 *
 * WHY `isNaN` IS NOT THAT ANSWER
 * ------------------------------
 * Every numeric field on the spot order path was checked with the same three
 * lines:
 *
 *     if (isEmpty(v))            -> REQUIRED
 *     else if (isNaN(v))         -> "only numeric value"
 *     else if (parseFloat(v)<=0) -> "should be greater than zero"
 *
 * `isNaN` coerces with `Number()` and `parseFloat` parses a PREFIX, and the two
 * disagree about almost everything that is not already a number:
 *
 *     v = true      Number(true)   = 1     -> isNaN false, ACCEPTED
 *                   parseFloat(true) = NaN -> the handler then works with NaN
 *     v = [50]      Number([50])   = 50    -> isNaN false, ACCEPTED
 *                   parseFloat([50]) = 50  -> an ARRAY silently became a price
 *     v = "1e309"   Number(...)= Infinity  -> isNaN false, ACCEPTED
 *                   parseFloat(...)=Infinity -> an infinite order
 *     v = "12abc"   Number(...)= NaN       -> isNaN true, refused (by luck)
 *                   parseFloat(...) = 12   -> would have been a real order
 *
 * The `true` case is the one that reaches money. A NaN price or quantity
 * satisfies EVERY range check in the handler - `NaN < min` and `NaN > max` are
 * both false, which is the one value that passes a bounds test by failing both
 * halves of it - so it walks the whole of limitOrderPlace: the pair lookup, the
 * fill gate, the price band, the quantity bounds, the balance read, and only
 * stops at `hincrbyfloatIfEnough`, which refuses a non-finite size and returns
 * null. The user is then told "Due to insufficient balance order cannot be
 * placed", which is a lie about their account for what was a malformed request.
 * That refusal is also the ONLY thing standing between a NaN
 * and the ledger; it is a good last line, and it should not be the first one.
 *
 * WHAT THIS ACCEPTS
 * -----------------
 * A finite JS number, or a string that is ENTIRELY a finite number (leading and
 * trailing whitespace tolerated, because a form field carries it and it changes
 * no value). Nothing else. Booleans, arrays, objects, null and "12abc" are
 * refused BY TYPE or BY PATTERN before any coercion can happen, so `[50]` is
 * not a 50 and `true` is not a 1.
 *
 * Written for the class of bug where a non-numeric order field (`quantity:
 * "abc"`) walks past every range check and only stops at the ledger. One
 * definition of "is a number" across this service is the point.
 */

/**
 * A string that is a number and nothing else. Anchored, so "12abc" and "1 2"
 * are refused rather than truncated.
 */
const FULL_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Returns the number, or null. `null` means "not a number", and every caller
 * must treat it as a refusal rather than as a zero: `Number(null)` is 0, and a
 * value that silently becomes 0 is how a malformed order becomes a free one.
 */
export const numericField = (value) => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || !FULL_NUMBER.test(trimmed)) return null;
    const parsed = Number(trimmed);
    // "1e309" passes the pattern and becomes Infinity. An infinite order value
    // is not a large order, it is a broken one.
    return Number.isFinite(parsed) ? parsed : null;
  }
  // null, undefined, boolean, array, object, function - none of these is a
  // number, and none of them may be coerced into one here.
  return null;
};

/** Present at all? `0` IS present - only absence is absence. */
export const isAbsentField = (value) =>
  value === undefined || value === null || value === "";

/**
 * The verdict every spot order validator needs, in the vocabulary those
 * validators already speak.
 *
 * Returns one of the three existing error codes - the caller supplies the exact
 * message strings it has always used, so no client contract changes - or null
 * when the value is a usable positive number.
 *
 *   "REQUIRED"     absent
 *   "NOT_A_NUMBER" present and not a number at all
 *   "NOT_POSITIVE" a number, but zero or negative
 */
export const positiveFieldFault = (value) => {
  if (isAbsentField(value)) return "REQUIRED";
  const parsed = numericField(value);
  if (parsed === null) return "NOT_A_NUMBER";
  if (!(parsed > 0)) return "NOT_POSITIVE";
  return null;
};

/**
 * HOW MANY DECIMAL PLACES DOES THIS VALUE ACTUALLY CARRY?
 * ======================================================
 *
 * The third question about an order's numbers, after "is it a number" and "is
 * it positive". Nothing asked it, and the consequences were not cosmetic:
 *
 *   MEASURED LIVE on BTCUSD (firstFloatDigit 8, secondFloatDigit 2). A limit
 *   sell priced 63510.631 - three decimals on a pair whose quote currency has
 *   two - and sized 0.0012345678912345 BTC - sixteen decimals on a base
 *   currency with eight - was accepted, escrowed, rested, and PUBLISHED at the
 *   top of the public order book.
 *
 * Two separate harms, which is why the two fields get two different answers
 * (see the PRICE / SIZE note in controllers/spot.controller.js#limitOrderPlace):
 *
 *   THE QUEUE. A price finer than the pair's tick lets one order sit in front
 *   of the entire book for a fraction of a cent that the venue cannot even
 *   quote. Every real exchange refuses this, and it is the reason price
 *   precision is a matching rule rather than a display preference.
 *
 *   THE ADVERTISEMENT. The published book then carries a level that the pair
 *   cannot express, so the number the venue shows and the number it can trade
 *   at are different numbers.
 *
 * COUNTED ON THE PARSED VALUE, NOT ON THE STRING THE CLIENT SENT, so "63510.60"
 * is two decimals rather than a trailing-zero argument, and a value that
 * stringifies exponentially ("5e-8" is how JavaScript spells 0.00000005) is
 * counted as the 8 decimals it is rather than as none - which is exactly the
 * hole that let sub-satoshi quantities through the truncation helper before
 * lib/roundOf.js#plainDecimal was written.
 *
 * Returns null for anything that is not a number at all; that is a different
 * fault, already named by positiveFieldFault, and this must not shadow it.
 */
export const decimalPlaces = (value) => {
  const parsed = numericField(value);
  if (parsed === null) return null;
  const text = String(Math.abs(parsed));
  const exponentAt = text.search(/e/i);
  if (exponentAt === -1) {
    const dot = text.indexOf(".");
    return dot === -1 ? 0 : text.length - dot - 1;
  }
  const mantissa = text.slice(0, exponentAt);
  const exponent = parseInt(text.slice(exponentAt + 1), 10);
  const dot = mantissa.indexOf(".");
  const mantissaPlaces = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(mantissaPlaces - exponent, 0);
};

/**
 * The pair's stated precision as a usable count, or null.
 *
 * `firstFloatDigit` / `secondFloatDigit` come off a pair document that an
 * operator edits, so they can be absent, a string, or nonsense. A missing
 * precision must NOT become a precision of zero (that would refuse every
 * fractional order on the pair) and must not become `toFixedDown`'s default of
 * 2 (that would silently truncate a BTC quantity to two decimal places, which
 * is a far larger money defect than the one being fixed). Null means "this pair
 * does not state a precision", and every caller below treats that as "the rule
 * does not apply" rather than as a number.
 */
export const precisionDigits = (digits) => {
  const parsed = numericField(digits);
  if (parsed === null) return null;
  if (parsed < 0 || !Number.isInteger(parsed)) return null;
  return parsed;
};

/**
 * Does this value name more decimal places than the pair can express?
 *
 * False for a value that is not a number, and false for a pair with no stated
 * precision - see above. Only ever true when both are known and the value is
 * genuinely finer than the venue can quote.
 */
export const exceedsPrecision = (value, digits) => {
  const allowed = precisionDigits(digits);
  if (allowed === null) return false;
  const places = decimalPlaces(value);
  if (places === null) return false;
  return places > allowed;
};

export default {
  numericField,
  isAbsentField,
  positiveFieldFault,
  decimalPlaces,
  precisionDigits,
  exceedsPrecision,
};
