/**
 * THE ONE PLACE A SPOT BALANCE LIVES
 * ==================================
 *
 * A spot balance has exactly one home while the engines run:
 *
 *     redis  walletbalance_spot[<userId>_<currencyId>]        the ENGINE field
 *
 * It used to have two mirrors as well, both addressed by a FLAT `assets`
 * collection's own document id rather than by the currency:
 *
 *     mongo  assets[{userId, coin}].spotBal                   smallest units,
 *                                                             string, USDC only
 *     redis  walletbalance_spot[<userId>_<flatAssetDocId>]    same number,
 *                                                             regular units
 *
 * That flat ledger only ever held USDC. It existed for a Solana deposit path
 * this venue does not have - it takes no deposits and holds no custody - and
 * USDC itself had no market to be traded in once the venue settled on a single
 * BTC/USD pair. Currency, balances and collection are all deleted, so there is
 * no second or third copy of a spot balance left to drift out of step, and the
 * derivation that kept them in step goes with them.
 *
 * WHAT THIS FILE IS STILL FOR. `applySpotDelta` remains the single call every
 * spot balance movement in this service goes through. That is not about the
 * mirror: it is so that "moved a balance" is one named operation with one
 * implementation, rather than a raw HINCRBYFLOAT that each new call site
 * open-codes slightly differently. tests/unit/spot-write-call-sites.test.js
 * enforces that every spot write comes through here.
 *
 * HINCRBYFLOAT is the atomic authority on where a balance ended up, and this
 * returns exactly what it returned, so a caller reads as it always did.
 */

/**
 * Move the engine field and return where it landed.
 *
 * @param {object}   args
 * @param {string}   args.userId      the wallet id
 * @param {string}   args.currencyId  the currency the balance is denominated in
 * @param {number}   args.delta       the signed amount to apply
 * @param {object}   deps
 * @param {function} deps.hincbyfloat redis hincrbyfloat(hash, field, delta)
 * @returns {Promise<string>} the engine field's value AFTER the write
 */
export const applySpotDelta = async (
  { userId, currencyId, delta },
  { hincbyfloat } = {}
) =>
  hincbyfloat("walletbalance_spot", `${userId}_${currencyId}`, delta);

export default {
  applySpotDelta,
};
