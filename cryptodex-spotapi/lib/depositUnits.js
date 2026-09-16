/**
 * DEPOSIT AMOUNTS ARE STORED AS BASE-UNIT INTEGER STRINGS
 * ======================================================
 *
 * `DepositEvent.amount` is a STRING of smallest units and `DepositEvent.decimals`
 * says how many of its digits are fractional. Both halves matter: the writer
 * (controllers/faucet.controller.js) and the reader (controllers/deposit.controller.js)
 * used to hard-code 1e6 independently, which was survivable only while every row
 * was a whole number of USDC. It stopped being survivable the moment the faucet
 * had to record a fractional base-coin amount - 0.05 BTC - as well.
 *
 * These conversions are done with STRING arithmetic, not `* 1e8` / `/ 1e8`.
 * IEEE-754 does not scale decimals reliably: `0.07 * 1e8` is 7000000.000000001
 * and `1.005 * 1e8` is 100499999.99999999. A ledger row that says
 * "7000000.000000001 base units" is not an integer and nothing downstream can
 * decode it. The faucet's own constants (0.05, 1, 50) happen to scale cleanly
 * today, which is exactly the kind of accident that turns into a corrupt row
 * the first time a constant changes. Going the other way, `parseFloat` on a
 * long base-unit string loses its low digits.
 */

/** How many fractional digits new faucet rows are written with. */
export const DEPOSIT_DECIMALS = 8;

/**
 * Rows written before `decimals` was carried through were all 1e6 USDC rows, so
 * a row that does not state its own scale is read at the scale it was written.
 */
export const LEGACY_DEPOSIT_DECIMALS = 6;

const normaliseDecimals = (decimals, fallback) => {
  const n = Number(decimals);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
};

/** Drop leading zeros but never the last digit: "007" -> "7", "000" -> "0". */
const stripLeadingZeros = (digits) => digits.replace(/^0+(?=\d)/, '');

/**
 * Human amount -> base-unit integer string.
 * `toBaseUnits(0.05, 8)` is "5000000" exactly, not "5000000.000000001".
 * Returns null for anything that is not a finite number, so a caller can refuse
 * to write the row rather than write "NaN" into a ledger.
 */
export function toBaseUnits(amount, decimals = DEPOSIT_DECIMALS) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;

  const scale = normaliseDecimals(decimals, DEPOSIT_DECIMALS);
  // toFixed is exact decimal rounding at the scale we are storing at, which is
  // precisely the rounding a base-unit ledger performs.
  const fixed = Math.abs(n).toFixed(scale);
  const [whole, frac = ''] = fixed.split('.');
  const digits = stripLeadingZeros(`${whole}${frac}`);
  return `${n < 0 ? '-' : ''}${digits}`;
}

/**
 * Base-unit integer string -> human decimal string, trailing zeros dropped:
 * ("5000000", 8) -> "0.05", ("1000000000000", 8) -> "10000".
 *
 * A row whose amount is not an integer string (nothing writes one, but the
 * collection is shared with a webhook path) is passed through as a number
 * rather than mangled.
 */
export function fromBaseUnits(amount, decimals = LEGACY_DEPOSIT_DECIMALS) {
  const raw = String(amount ?? '').trim();
  const scale = normaliseDecimals(decimals, LEGACY_DEPOSIT_DECIMALS);

  if (!/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return '0';
    return String(n / Math.pow(10, scale));
  }

  const negative = raw.startsWith('-');
  const abs = stripLeadingZeros(negative ? raw.slice(1) : raw);
  if (scale === 0) return `${negative ? '-' : ''}${abs}`;

  const padded = abs.padStart(scale + 1, '0');
  const whole = padded.slice(0, padded.length - scale);
  const frac = padded.slice(padded.length - scale).replace(/0+$/, '');
  const body = frac ? `${whole}.${frac}` : whole;
  // "-0" is not an amount.
  return `${negative && /[1-9]/.test(abs) ? '-' : ''}${body}`;
}

export default { DEPOSIT_DECIMALS, LEGACY_DEPOSIT_DECIMALS, toBaseUnits, fromBaseUnits };
