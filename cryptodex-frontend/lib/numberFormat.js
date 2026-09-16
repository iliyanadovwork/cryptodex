// Number Formatting Utilities
// Handles clean number display with trimmed trailing zeros and proper precision
// Uses Intl.NumberFormat for performance (cached instances) and avoids toFixed padding

import isEmpty from "./isEmpty";

// Cache for Intl.NumberFormat instances to avoid recreating on every render
const formatCache = new Map();

// Separate cache for USD formatter (always 2 decimals with commas)
let usdFormatter = null;

/**
 * Get or create a cached Intl.NumberFormat instance
 * @param {number} precision - Maximum fraction digits
 * @param {boolean} withCommas - Whether to use thousand separators
 * @returns {Intl.NumberFormat}
 */
function getCachedFormatter(precision, withCommas = false) {
  const key = `${precision}-${withCommas}`;
  if (!formatCache.has(key)) {
    formatCache.set(
      key,
      new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: precision,
        useGrouping: withCommas,
      })
    );
  }
  return formatCache.get(key);
}

/**
 * Get or create the cached USD formatter
 * USD always shows exactly 2 decimals with commas
 * @returns {Intl.NumberFormat}
 */
function getUsdFormatter() {
  if (!usdFormatter) {
    usdFormatter = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: true,
    });
  }
  return usdFormatter;
}

/**
 * Format a number using Intl.NumberFormat
 * Handles edge cases like -0, NaN, empty values
 * @param {number|string} value - The value to format
 * @param {number} precision - Maximum decimal places
 * @param {boolean} withCommas - Whether to add thousand separators
 * @returns {string} Formatted number with trimmed zeros
 */
function formatWithIntl(value, precision, withCommas = false) {
  if (isEmpty(value) || isNaN(value)) return "";

  let num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "";

  // Guard against -0 display (Intl can format as "-0")
  if (Object.is(num, -0)) num = 0;

  const formatter = getCachedFormatter(precision, withCommas);
  return formatter.format(num);
}

/**
 * Format price with given precision, trim trailing zeros
 * @param {number|string} value - The price value
 * @param {number} precision - Number of decimal places (from tradePair.secondFloatDigit)
 * @param {string} fallback - Value to show if missing/invalid (default: "—")
 * @returns {string} Formatted price
 */
export const formatPrice = (value, precision = 2, fallback = "—") => {
  try {
    if (isEmpty(value) || isNaN(value)) return fallback;

    let num = parseFloat(value);
    if (isNaN(num)) return fallback;

    // Guard against -0
    if (Object.is(num, -0)) num = 0;
    if (num === 0) return "0";

    return formatWithIntl(num, precision, false);
  } catch (err) {
    return fallback;
  }
};

/**
 * Format quantity with given precision, trim trailing zeros
 * @param {number|string} value - The quantity value
 * @param {number} precision - Number of decimal places (from tradePair.firstFloatDigit)
 * @param {string} fallback - Value to show if missing/invalid (default: "—")
 * @returns {string} Formatted quantity
 */
export const formatQty = (value, precision = 4, fallback = "—") => {
  try {
    if (isEmpty(value) || isNaN(value)) return fallback;

    let num = parseFloat(value);
    if (isNaN(num)) return fallback;

    // Guard against -0
    if (Object.is(num, -0)) num = 0;
    if (num === 0) return "0";

    return formatWithIntl(num, precision, false);
  } catch (err) {
    return fallback;
  }
};

/**
 * Format USD value with thousands separator and exactly 2 decimals
 * Uses cached formatter for performance
 * @param {number|string} value - The USD value
 * @param {string} fallback - Value to show if missing/invalid (default: "—")
 * @returns {string} Formatted USD like "$1,234.56"
 */
export const formatUsd = (value, fallback = "—") => {
  try {
    if (isEmpty(value) || isNaN(value)) return fallback;

    let num = parseFloat(value);
    if (isNaN(num)) return fallback;

    // Guard against -0
    if (Object.is(num, -0)) num = 0;
    if (num === 0) return "$0.00";

    const formatter = getUsdFormatter();
    return "$" + formatter.format(num);
  } catch (err) {
    return fallback;
  }
};

/**
 * Format percentage value with + sign for positive
 * @param {number|string} value - The percentage value (already as percentage, not decimal)
 * @param {number} precision - Decimal places (default: 2)
 * @param {string} fallback - Value to show if missing/invalid (default: "—")
 * @returns {string} Formatted percentage like "+2.5%" or "-1.23%"
 */
export const formatPct = (value, precision = 2, fallback = "—") => {
  try {
    if (isEmpty(value) || isNaN(value)) return fallback;

    let num = parseFloat(value);
    if (isNaN(num)) return fallback;

    // Guard against -0 for percentage (don't show "-0%")
    if (Object.is(num, -0)) num = 0;

    const formatted = formatWithIntl(num, precision, false);

    const sign = num >= 0 ? "+" : "";
    return sign + formatted + "%";
  } catch (err) {
    return fallback;
  }
};

/**
 * Format with thousands separator and trimmed trailing zeros
 * @param {number|string} value - The value to format
 * @param {number} precision - Decimal places
 * @param {string} fallback - Value to show if missing/invalid (default: "—")
 * @returns {string} Formatted number like "1,234.56"
 */
export const formatWithCommas = (value, precision = 2, fallback = "—") => {
  try {
    if (isEmpty(value) || isNaN(value)) return fallback;

    let num = parseFloat(value);
    if (isNaN(num)) return fallback;

    // Guard against -0
    if (Object.is(num, -0)) num = 0;
    if (num === 0) return "0";

    return formatWithIntl(num, precision, true);
  } catch (err) {
    return fallback;
  }
};

/**
 * Format any number with trimmed trailing zeros
 * Note: trim parameter removed - Intl with minFractionDigits=0 always trims
 * @param {number|string} value - The value to format
 * @param {number} precision - Decimal places
 * @param {string} fallback - Value to show if missing/invalid (default: "—")
 * @returns {string} Formatted number
 */
export const formatNumber = (value, precision = 2, fallback = "—") => {
  try {
    if (isEmpty(value) || isNaN(value)) return fallback;

    let num = parseFloat(value);
    if (isNaN(num)) return fallback;

    // Guard against -0
    if (Object.is(num, -0)) num = 0;
    if (num === 0) return "0";

    return formatWithIntl(num, precision, false);
  } catch (err) {
    return fallback;
  }
};

/**
 * Format with fixed decimals (no trimming) - for when you need exact precision display
 * Unlike other formatters, this keeps trailing zeros
 * @param {number|string} value - The value to format
 * @param {number} precision - Exact decimal places
 * @param {string} fallback - Value to show if missing/invalid (default: "—")
 * @returns {string} Formatted number with exact precision
 */
export const formatFixed = (value, precision = 2, fallback = "—") => {
  try {
    if (isEmpty(value) || isNaN(value)) return fallback;

    let num = parseFloat(value);
    if (isNaN(num)) return fallback;

    // Guard against -0
    if (Object.is(num, -0)) num = 0;

    return num.toFixed(precision);
  } catch (err) {
    return fallback;
  }
};

/**
 * Dynamic price precision based on value magnitude
 * Similar to priceFixed but with trailing zero trimming
 * @param {number|string} value - The price value
 * @param {string} fallback - Value to show if missing/invalid (default: "—")
 * @returns {string} Formatted price
 */
export const formatPriceDynamic = (value, fallback = "—") => {
  try {
    if (isEmpty(value) || isNaN(value)) return fallback;

    let num = parseFloat(value);
    if (isNaN(num)) return fallback;

    // Guard against -0
    if (Object.is(num, -0)) num = 0;
    if (num === 0) return "0";

    let precision;
    if (num >= 50) precision = 2;
    else if (num > 1) precision = 3;
    else if (num >= 0.1) precision = 4;
    else if (num >= 0.01) precision = 5;
    else if (num >= 0.001) precision = 6;
    else precision = 7;

    return formatPrice(value, precision, fallback);
  } catch (err) {
    return fallback;
  }
};

/**
 * A SPENDABLE balance: never rounded UP.
 *
 * THE BUG THIS EXISTS TO KILL
 * The order ticket's "Available" figure went through `formatQty`, which uses
 * Intl and therefore ROUNDS. A real balance of 0.030623265 BTC printed as
 * "Available 0.03062327 BTC" — five nano-bitcoin more than the account holds.
 * Typing that number back into the amount field (the obvious way to sell
 * everything) produced "Due to insufficient balance order cannot be placed",
 * because the ticket had quoted a balance that did not exist.
 *
 * A balance is a promise about what can be spent, so it truncates. The figure
 * shown is always attainable; at worst it understates by less than one unit of
 * the last digit displayed.
 *
 * @param {number|string} value
 * @param {number} precision - decimal places (the pair's float digit)
 * @param {string} [fallback="—"]
 * @returns {string}
 */
export const formatBalance = (value, precision = 8, fallback = "—") => {
  try {
    if (isEmpty(value) || isNaN(value)) return fallback;

    let num = typeof value === "string" ? parseFloat(value) : value;
    if (isNaN(num)) return fallback;
    if (Object.is(num, -0)) num = 0;
    if (num === 0) return "0";

    const digits = Number.isFinite(parseInt(precision, 10))
      ? Math.max(0, parseInt(precision, 10))
      : 8;
    // Truncate toward zero WITHOUT the float-multiply error that used to drop a
    // whole unit. `Math.floor(num * 10**digits) / 10**digits` looked exact but
    // `num * factor` carries IEEE-754 noise - 0.29 * 100 is 28.999999999999996,
    // not 2900 - so the floor rounded 0.29 DOWN to 0.28, 4.1 to 4.09999999, 2.01
    // to 2. Formatting `.toFixed` at a few guard digits past `digits` snaps that
    // noise away (0.29 -> "0.29000000"); cutting the STRING at `digits` then
    // truncates only the genuine sub-precision remainder, in decimal, with no
    // multiply. Guard digits (+6) sit far below any real remainder and above the
    // ~1e-16 relative noise, and a run of 9s long enough to cascade across them
    // is exactly the noise we mean to drop.
    const sign = num < 0 ? -1 : 1;
    const padded = Math.abs(num).toFixed(digits + 6);
    const dot = padded.indexOf(".");
    const cut = digits > 0 ? padded.slice(0, dot + 1 + digits) : padded.slice(0, dot);
    const truncated = parseFloat(cut) * sign;
    if (!truncated) return "0";

    return formatWithIntl(truncated, digits, false);
  } catch (err) {
    return fallback;
  }
};

/**
 * Format a coin amount so the DIGITS THAT MATTER are actually on screen.
 *
 * THE BUG THIS EXISTS TO KILL
 * A coin-margined position's unrealized P&L is denominated in the base coin, and a
 * $100 paper position moves by tens of MICRO-bitcoin. It was rendered with
 * `toFixed(value, 4)`, so for the entire life of a normal position it read
 * "-0.0000 BTC" — a number that never changes, never shows profit or loss, and
 * cannot even be told apart from flat. Four decimal places of BTC is $6.40 a
 * step; the position itself is worth $100.
 *
 * Fixed precision is the wrong tool for a quantity whose magnitude is unknown.
 * This keeps widening the decimals until `sigFigs` significant digits are
 * visible, up to `maxPrecision`, then trims the padding back off. Big values
 * stay short (12.3456), small ones stay legible (-0.00001563), and a true zero
 * is still "0" rather than a smear of noise.
 *
 * @param {number|string} value
 * @param {object} [opts]
 * @param {number} [opts.sigFigs=4]     significant digits to guarantee
 * @param {number} [opts.minPrecision=2] never show fewer decimals than this
 * @param {number} [opts.maxPrecision=8] never show more (satoshi is the floor)
 * @param {string} [opts.fallback="—"]
 * @returns {string}
 */
export const formatCoinAmount = (value, opts = {}) => {
  const {
    sigFigs = 4,
    minPrecision = 2,
    maxPrecision = 8,
    fallback = "—",
  } = opts;
  try {
    if (isEmpty(value) || isNaN(value)) return fallback;

    let num = typeof value === "string" ? parseFloat(value) : value;
    if (isNaN(num)) return fallback;
    if (Object.is(num, -0)) num = 0;
    if (num === 0) return "0";

    const abs = Math.abs(num);
    // Decimals needed for `sigFigs` significant digits.
    //   below 1: a value of 1.2e-5 needs 5 leading zeros' worth of room before
    //            its first digit appears, plus the digits themselves;
    //   above 1: the integer part already supplies some of them, so 12.3456 to
    //            4 significant figures wants 2 decimals, not 4.
    const needed =
      abs >= 1
        ? sigFigs - (Math.floor(Math.log10(abs)) + 1)
        : Math.floor(-Math.log10(abs)) + sigFigs;
    const precision = Math.min(
      maxPrecision,
      Math.max(minPrecision, needed)
    );

    // formatWithIntl trims trailing zeros, so "0.00001563" does not become
    // "0.000015630000" just because the cap allowed eight places.
    return formatWithIntl(num, precision, false);
  } catch (err) {
    return fallback;
  }
};

/**
 * Format very small numbers (like interest rates or fees)
 * Shows scientific notation for very small values
 * @param {number|string} value - The value
 * @param {number} precision - Decimal places (default: 6)
 * @param {string} fallback - Value to show if missing/invalid (default: "—")
 * @returns {string} Formatted small number
 */
export const formatSmall = (value, precision = 6, fallback = "—") => {
  try {
    if (isEmpty(value) || isNaN(value)) return fallback;

    let num = parseFloat(value);
    if (isNaN(num)) return fallback;

    // Guard against -0
    if (Object.is(num, -0)) num = 0;
    if (num === 0) return "0";

    if (Math.abs(num) < 0.000001) {
      return num.toExponential(2);
    }

    return formatNumber(value, precision, fallback);
  } catch (err) {
    return fallback;
  }
};

/**
 * Check if a value should be displayed as empty/missing
 * @param {*} value - Value to check
 * @returns {boolean}
 */
export const isDisplayable = (value) => {
  return !isEmpty(value) && value !== null && value !== undefined && !isNaN(value);
};

/**
 * Safe number conversion that handles edge cases
 * IMPORTANT: This is for display formatting only.
 * Business logic (validation, rounding for submissions) should use
 * the existing roundOf.js functions like toFixedDown.
 * @param {number|string} value - Value to convert
 * @param {number} defaultValue - Default if conversion fails (default: 0)
 * @returns {number}
 */
export const toSafeNumber = (value, defaultValue = 0) => {
  try {
    if (isEmpty(value) || isNaN(value)) return defaultValue;
    const num = parseFloat(value);
    return isNaN(num) ? defaultValue : num;
  } catch (err) {
    return defaultValue;
  }
};

/**
 * Clear the format cache (useful for testing or memory management)
 * Normally not needed as the cache stays small
 */
export const clearFormatCache = () => {
  formatCache.clear();
  usdFormatter = null;
};

// JSDoc Types for TypeScript integration
/**
 * @typedef {Object} FormatOptions
 * @property {number} [precision] - Number of decimal places
 * @property {string} [fallback] - Fallback value for invalid input
 * @property {boolean} [withCommas] - Whether to add thousand separators
 */

/**
 * @typedef {function(number|string, number=, string=): string} FormatFn
 */
