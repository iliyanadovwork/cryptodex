// import lib
import isEmpty from './isEmpty.js';

export const toFixed = (item, type = 2) => {
    try {
        if (!isEmpty(item) && !isNaN(item)) {
            item = parseFloat(item)
            item = item.toFixed(type)
            return parseFloat(item)
        }
        return ''
    } catch (err) {
        return ''
    }
}
/**
 * TRUNCATE TOWARD ZERO - AND KEEP THE SIGN.
 * =========================================
 *
 * Two defects, both caused by running a regex over `Number.prototype.toString()`
 * and assuming the result is always plain `ddd.ddd` decimal notation.
 *
 * 1. THE SIGN. The regex is `(\d+\.\d{type})(\d)` and `\d` does not match "-",
 *    so for any NEGATIVE value carrying more decimals than `type` the match
 *    started AFTER the minus and `parseFloat(m[1])` handed back the MAGNITUDE:
 *
 *        toFixedDown(-1.234567891, 8)  ->  1.23456789      (sign flipped)
 *        toFixedDown(-0.5, 1)          -> -0.5             (no match, correct)
 *
 *    i.e. it was right for every negative it did not have to truncate and wrong
 *    for every negative it did, which is why it survived: most of what this
 *    service rounds (an order value, a fee, a refund) is positive. The same
 *    defect, in an earlier copy of this function, turned a stored -4923.36
 *    into +4923.36 and acted on the flipped sign as if it were real money.
 *
 * 2. EXPONENT NOTATION. JavaScript stringifies any magnitude below 1e-6 in
 *    exponential form - `(0.00000005).toString()` is "5e-8" - and the decimal
 *    regex cannot match it either, so the value was returned WHOLE, carrying
 *    more precision than the caller asked for:
 *
 *        toFixedDown(0.000000109, 8)   ->  0.000000109     (9 decimals, not 8)
 *
 *    Truncation silently not happening is the opposite of what every call site
 *    wants: these are money figures being cut to the ledger's precision so a
 *    credit is never rounded UP into money the venue does not hold. The value
 *    is normalised to plain decimal notation before the match, so sub-satoshi
 *    dust now truncates to 0 as it always should have.
 *
 * The magnitude is truncated exactly as before for every value that already
 * stringified in plain notation; only the sign and the exponent case change.
 */

/**
 * Plain (non-exponential) decimal spelling of a finite number.
 * Magnitudes >= 1e21 also stringify exponentially but have no fractional part
 * left to truncate, so they are handed back untouched.
 */
const plainDecimal = (n) => {
    const s = n.toString();
    if (!/e/i.test(s)) return s;
    if (!Number.isFinite(n) || Math.abs(n) >= 1e21) return s;
    // Only reached for |n| < 1e-6, where 20 fractional digits is far more than
    // any caller's `type` and the trailing-zero strip restores the exact value.
    return n.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
};

export const toFixedDown = (item, type = 2) => {
    try {
        if (!isEmpty(item) && !isNaN(item)) {
            item = parseFloat(item);
            // A TRUNCATION HELPER THAT DECLINES TO TRUNCATE IS A TRAP.
            // -------------------------------------------------------
            // `isEmpty(Infinity)` is false and `isNaN(Infinity)` is false, so
            // before this line an infinity walked all the way to the regex,
            // matched no decimal pattern ("Infinity" contains no digits at
            // all), and was handed back AS Infinity - the one input this
            // function is asked to cut that it returned whole. Inconsistent
            // with its own NaN handling one line up.
            //
            // `""` and not `0`: it is the answer this function ALREADY gives
            // for every other input it cannot truncate (null, undefined, "",
            // NaN), so an infinity now lands on a path every caller has always
            // been exposed to rather than on a new one - and a fabricated `0`
            // in a money figure is the mistake this codebase has already paid
            // for elsewhere. A refusal to truncate must not be spellable as a
            // number.
            //
            // "" is not safe to coerce blind either, and the one spot call
            // site that does - `marketOrderDebitValue`, where `"" * markPrice`
            // is 0 and a 0 debit is a free order - is guarded in the same
            // change. It was already exposed to this via NaN.
            if (!Number.isFinite(item)) {
                return "";
            }
            // `\d` never matches "-", so the sign is taken off before the match
            // and put back afterwards rather than being left to the regex.
            const negative = item < 0;
            const magnitude = Math.abs(item);
            let decReg = new RegExp("(\\d+\\.\\d{" + type + "})(\\d)"),
                m = plainDecimal(magnitude).match(decReg);
            const truncated = m ? parseFloat(m[1]) : magnitude.valueOf();
            return negative ? -truncated : truncated;
        }
        return "";
    } catch (err) {
        return "";
    }
};
/**
 * `longNumbers` USED TO SIT HERE. IT IS DELETED, NOT FIXED.
 * ========================================================
 *
 *     export const longNumbers = (x, n) => {
 *       try {
 *         if (!isEmpty(x) && !isNaN(x)) {
 *           if (x < 0.000001) return 0.0;
 *           else if (x > 100) { ... x.toFixedNoRounding(2) ... }
 *           return x.toFixedNoRounding(n);
 *         }
 *         return "";
 *       } catch (err) { return ""; }
 *     };
 *
 * THREE THINGS WERE TRUE OF IT AT ONCE, and each one alone is a reason not to
 * keep it:
 *
 *   1. NOTHING CALLED IT. Verified across every backend service, excluding
 *      node_modules, this file and tests: the only occurrences outside the
 *      definitions were commented-out imports.
 *   2. IT THREW ON EVERY CALL. `Number.prototype.toFixedNoRounding` is defined
 *      only in the FRONTEND copy of roundOf.js, which patches the prototype at
 *      module load. No backend service loads it, so every branch that reached
 *      it raised a
 *      TypeError which the catch swallowed into `""`. A helper that has only
 *      ever returned "" is not a rounding helper.
 *   3. IT HAD A SIGN BUG WAITING FOR WHOEVER WIRED IT UP. `if (x < 0.000001)
 *      return 0.0` reads as a "dust is zero" test but is written on a SIGNED
 *      value, so it is true for EVERY NEGATIVE NUMBER. The moment the missing
 *      prototype appeared, -4923.36 would have rendered as 0 - the same class
 *      of mistake as the toFixedDown regex that could not see a minus sign, and
 *      on the same kind of number (a loss, a negative liquidation price).
 *
 * Kept as a comment rather than as code because the failure it invites is
 * silent: the next person who needs "truncate for display" would have found a
 * plausibly-named export, called it, got "" or 0, and had no reason to suspect
 * either. `toFixedDown` above is the truncation helper this service has.
 *
 * THE LIVE COPY IS THE FRONTEND ONE, and it still carries the sign bug in a
 * context where it EXECUTES (the prototype exists there). Reported, not
 * touched from here: cryptodex-frontend/lib/roundOf.js.
 */
// export const truncateDecimals = function (number, digits) {
//     var multiplier = Math.pow(10, digits),
//         adjustedNum = number * multiplier,
//         truncatedNum = Math[adjustedNum < 0 ? 'ceil' : 'floor'](adjustedNum);

//     return truncatedNum / multiplier;
// };
export const convert = (n) => {
    try {
        var sign = +n < 0 ? '-' : '',
            toStr = n.toString()
        if (!/e/i.test(toStr)) {
            return n
        }
        var [lead, decimal, pow] = n
            .toString()
            .replace(/^-/, '')
            .replace(/^([0-9]+)(e.*)/, '$1.$2')
            .split(/e|\./)
        return +pow < 0
            ? sign + '0.' + '0'.repeat(Math.max(Math.abs(pow) - 1 || 0, 0)) + lead + decimal
            : sign +
            lead +
            (+pow >= decimal.length
                ? decimal + '0'.repeat(Math.max(+pow - decimal.length || 0, 0))
                : decimal.slice(0, +pow) + '.' + decimal.slice(+pow))
    } catch (err) {
        return 0
    }
}

/**
 * TRUNCATE TO `decimals` PLACES, IN STRING SPACE, AND RETURN A STRING.
 * ===================================================================
 *
 * WHY IT STAYS A STRING (the divergence is deliberate, and it is recorded)
 * -----------------------------------------------------------------------
 * Earlier copies of this helper, in services that have since been removed,
 * returned a NUMBER (`Math.floor(x * 10**d) / 10**d`). Services disagreeing on
 * the return type of an identically-named money helper is a genuine trap, and
 * the obvious fix is to make this one return a number too. That fix is NOT made
 * here, because the STRING SPELLING is what callers display and log.
 *
 * This function pads to the requested scale - `truncateDecimals(1.5, 8)` is
 * "1.50000000" - where a number would render as "1.5". Callers that format a
 * balance or a quantity for the UI rely on that padding. This is the only
 * backend copy left, so there is nothing left to unify with in the first place.
 *
 * WHAT IS FIXED: the malformed spellings.
 * ---------------------------------------
 * Every one of these came from doing string surgery on `Number.toString()`
 * without asking whether the value is a number that HAS decimal places:
 *
 *     truncateDecimals(1.999, 0)     -> "1."                 (bare trailing dot)
 *     truncateDecimals(NaN, 8)       -> "NaN.00000000"
 *     truncateDecimals(Infinity, 8)  -> "Infinity.00000000"
 *     truncateDecimals('', 8)        -> ".00000000"
 *
 * The last three reach the passbook writers in spot.controller.js as
 * `beforeBalance`/`afterBalance`/`amount`. They are caught today by
 * the numeric guard in grpc/walletService.passbook (it parseFloats each field
 * and refuses to send a row that is not finite), so no corrupt row is stored -
 * but "Infinity.00000000" in a log line is a value nobody can act on.
 *
 * FOR THREE OF THE FOUR THE FIX IS NUMERICALLY INERT: the new return value has
 * the same `parseFloat` as the old one, so every arithmetic call site -
 * spot.controller.js:6744-6745 (RetruveBalance, which survives only because JS
 * coerces the string in the following subtraction) and the two
 * `total * quantity` order-value gates - is bit-identical, and only the
 * literal text changes:
 *
 *     parseFloat("NaN.00000000")      === parseFloat("NaN")       // NaN
 *     parseFloat("Infinity.00000000") === parseFloat("Infinity")  // Infinity
 *     parseFloat("1.")                === parseFloat("1")         // 1
 *
 * THE FOURTH IS A DELIBERATE BEHAVIOUR CHANGE, AND IT IS THE POINT.
 * `parseFloat(".00000000")` is 0, NOT NaN - so an EMPTY input used to come back
 * as a string that reads as ZERO. `undefined` took the other route to the same
 * place: `convert` throws on `undefined.toString()`, catches, returns 0, and
 * the result was the literal "0.00000000". Either way an ABSENT value was
 * silently rendered as a real balance of zero, in the helper that fills
 * `beforeBalance`/`afterBalance`/`amount` on passbook rows and that feeds
 * `RetruveBalance` into a `hincbyfloat` refund. A number nobody computed
 * standing in for a value that was never read is the exact failure this
 * codebase has now paid for three times (the fabricated liquidation `0`, the
 * fabricated `10` floor, the `parseFloat(hget(...))` NaN that satisfied
 * `NaN < orderValue`).
 *
 * An absent value is now unparseable instead, which is what the consumers are
 * built for: grpc/walletService.passbook parseFloats and finite-checks every
 * balance field and REFUSES the row loudly rather than storing it, and redis
 * HINCRBYFLOAT refuses a non-float outright rather than corrupting a balance.
 * A missing audit row that was shouted about beats a fabricated 0 nobody can
 * tell from a real one.
 */
export const truncateDecimals = (num, decimals) => {
    // NaN / +-Infinity / non-numeric: hand back the plain spelling of the value
    // rather than a decimal-looking string built around it. Same parseFloat,
    // no ".00000000" tail suggesting a scale that was never applied.
    if (!Number.isFinite(parseFloat(num))) {
        return String(parseFloat(num))
    }
    num = convert(num)
    let
        s = num.toString()
        , p = s.indexOf('.')
        ;
    // Zero (or fewer) decimal places asked for means NO decimal point at all.
    // The general path below returns `s.slice(0, p + 1)`, which keeps the dot
    // and nothing after it - "1." - and that is not a number anyone can render.
    if (decimals <= 0) {
        return p < 0 ? s : s.slice(0, p)
    }
    s += (p < 0 ? (p = 1 + s.length, '.') : '') + '0'.repeat(decimals)
    return s.slice(0, p + 1 + decimals)
}