/**
 * HOW MANY DECIMAL PLACES A BALANCE IS SHOWN TO
 * =============================================
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * The currency schema carries TWO precision fields with a split meaning:
 *
 *   decimals         the ON-CHAIN precision of a TOKEN (schema comment: "token")
 *   contractDecimal  the precision of everything else
 *
 * and the transfer modal reads them exactly that way:
 *
 *   type == "token" ? decimals : contractDecimal
 *
 * Every currency on this deployment is type "crypto" or "fiat" with `decimals`
 * populated (USDC 6, BTC 8, SOL 9, ETH 18, USD 2) and `contractDecimal` never
 * written at all - the seed scripts insert straight into the collection, so the
 * schema default does not apply and the field is simply absent from the
 * document. `contractDecimal: 1` in the aggregate projected a field that was
 * not there, so the API answered with no precision at all for every coin.
 *
 * WHAT THAT COST
 * --------------
 * `undefined` does not fail loudly downstream, it fails blank:
 * truncateDecimals(balance, undefined) evaluates '0'.repeat(undefined) -> ''
 * and s.slice(0, NaN) -> '', so the transfer modal's "Total:" line rendered
 * empty (the reported "cannot load a coin's balance"), and its Max button -
 * which sets the amount field to that same truncation - filled the amount with
 * "". Confirm then posted amount:"" and walletTransferValid answered
 * 400 {errors:{amount:"Amount Field is Required"}}. One absent field, two
 * symptoms, neither of them mentioning precision.
 *
 * THE CONTRACT
 * ------------
 * `displayDecimals` is always present, always a whole number in [0, 8], and is
 * the number of places a HUMAN-FACING balance of this coin should be shown to.
 * It is a DISPLAY precision, not a ledger precision: `decimals` keeps its
 * on-chain meaning untouched for anything doing token arithmetic.
 *
 * The 8-place cap is the same one every major venue applies to a balance
 * readout. ETH's 18 on-chain places are true and useless on screen - and worse
 * than useless in the Max button, which would otherwise post an 18-decimal
 * amount into a form whose own input handler refuses anything past 6.
 */

/** Nothing human-facing needs more than this, whatever the chain says. */
export const MAX_DISPLAY_DECIMALS = 8;

/** Used only when a currency document names no usable precision at all. */
export const DEFAULT_FIAT_DECIMALS = 2;
export const DEFAULT_CRYPTO_DECIMALS = 8;

const asPrecision = (value) => {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return Math.floor(n);
};

/**
 * The display precision for one currency document (or plain aggregate row).
 *
 * Reads the field the currency's own `type` says is authoritative first, then
 * falls back to the other one, then to a type-appropriate default - so a
 * document that populated only one of the two is still answered correctly
 * instead of being answered `undefined`.
 */
export const resolveDisplayDecimals = (currency) => {
  if (!currency) return DEFAULT_CRYPTO_DECIMALS;

  const isFiat = currency.type === 'fiat';
  const isToken = currency.type === 'token';

  const primary = asPrecision(isToken ? currency.decimals : currency.contractDecimal);
  const secondary = asPrecision(isToken ? currency.contractDecimal : currency.decimals);
  const fallback = isFiat ? DEFAULT_FIAT_DECIMALS : DEFAULT_CRYPTO_DECIMALS;

  // 0 is a legitimate precision for a whole-unit currency, so "populated" has
  // to mean "present and parseable", not "truthy". The seeded documents are
  // missing the field entirely, which is what `null` distinguishes.
  let resolved = primary;
  if (resolved === null) resolved = secondary;
  if (resolved === null) resolved = fallback;

  return Math.min(resolved, MAX_DISPLAY_DECIMALS);
};

/**
 * Add `displayDecimals` to a currency row, and backfill `contractDecimal` with
 * it when the document never carried one.
 *
 * The backfill is what makes today's clients work without a coordinated
 * release: the existing `type == "token" ? decimals : contractDecimal` branch
 * now lands on a real number for every non-token currency. New code should
 * read `displayDecimals` and not branch at all.
 */
export const withDisplayDecimals = (currency) => {
  if (!currency || typeof currency !== 'object') return currency;
  const displayDecimals = resolveDisplayDecimals(currency);
  const plain = typeof currency.toObject === 'function' ? currency.toObject() : currency;
  return {
    ...plain,
    displayDecimals,
    contractDecimal: asPrecision(plain.contractDecimal) === null
      ? displayDecimals
      : plain.contractDecimal
  };
};

export const withDisplayDecimalsList = (list) =>
  Array.isArray(list) ? list.map(withDisplayDecimals) : list;

export default {
  MAX_DISPLAY_DECIMALS,
  DEFAULT_FIAT_DECIMALS,
  DEFAULT_CRYPTO_DECIMALS,
  resolveDisplayDecimals,
  withDisplayDecimals,
  withDisplayDecimalsList
};
