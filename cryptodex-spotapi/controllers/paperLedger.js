/**
 * Paper-trading balance ledger
 *
 * A single spot balance is recorded in up to four places and every writer has
 * to keep them together, otherwise money is created or destroyed:
 *
 *  1. Redis "walletbalance_spot", field `<userId>_<currencyId>`
 *     -> the TRADING ENGINE ledger. controllers/spot.controller.js reads and
 *        HINCRBYFLOATs this one when an order is placed / matched. This is the
 *        authoritative live balance.
 *  2. Redis "walletbalance_spot", field `<userId>_<assetDocId>`
 *     -> the WALLET API ledger (walletapi getWallet reads the balance under the
 *        asset document id). For coins seeded through walletapi's createAsset
 *        the wallet.assets subdocument _id IS the currency _id, so in practice
 *        the two field styles collapse into one.
 *  3. wallet.assets[].spotBal in the wallet database (regular units), written
 *     through the gRPC wallet service.
 *
 *  (This list used to carry a fourth entry - the flat `assets` collection, in
 *  smallest units - and described USDC as having a third Redis field because of
 *  it. Both are gone; see "THE FLAT `assets` LEDGER IS GONE" below, which this
 *  header had drifted out of step with. SYSTEM_GUIDE.md copied the stale version
 *  and has been corrected too.)
 *
 * Redis is authoritative for paper trading, so a gRPC ledger sync failure is
 * logged loudly but never fails the operation.
 *
 *
 * ============================================================================
 * THE SPOT MONEY-SUPPLY INVARIANT — READ THIS BEFORE AUDITING SPOT BALANCES
 * ============================================================================
 *
 * "TOTAL VALUE IS CONSERVED" IS FALSE FOR SPOT ON THIS VENUE, BY DESIGN.
 * Sum `walletbalance_spot` over every account before and after an ordinary
 * spot trade and the two numbers differ. Nothing is broken. Anyone who reaches
 * for conservation as the audit invariant will find a "leak" on every fill,
 * chase it, and find this comment at the end - so it is written down at the
 * start instead, together with the invariant that IS true.
 *
 * WHY IT IS FALSE. The book a user trades against is not made of other users.
 * It is a synthetic ladder re-derived wholesale from live Binance depth every
 * two seconds (controllers/paperBook.controller.js), resting under an admin
 * account and marked `isPaper: true`. That account is exempt from settlement
 * in both directions - see `settlementCredit` in controllers/spot.controller.js
 * for the argument and the measurement (before the exemption the admin account
 * had drifted to 234,978 USD / 0.0777 BTC / 104 SOL / 242 ETH out of one-legged
 * credits alone). So on a fill against the ladder EXACTLY ONE side moves: the
 * user's. The ladder holds no inventory, takes no reservation, pays no fee and
 * keeps no position, because it is a fiction standing in for the real market's
 * depth - not a participant with a balance sheet.
 *
 * That is the right design for a venue whose whole point is to mirror live
 * Binance depth, and it is the reason the venue-wide sum is not the invariant.
 *
 * WHAT IS TRUE INSTEAD — three statements, all checkable.
 *
 * I1. PER-FILL, THE USER'S OWN TWO LEGS BALANCE.
 *     A fill of `q` at price `p` moves the taker's quote ledger by -/+ p*q and
 *     their base ledger by +/- q, less the fee, and moves NOTHING ELSE. The
 *     conserved quantity is the user's own portfolio across the two coins of
 *     the pair, valued at the fill price - not any venue-wide total. A fill
 *     that moves one of the user's two legs and not the other is a defect; a
 *     fill that moves the user's legs and not the ladder's is correct.
 *
 * I2. THE RESERVATION BOUND.
 *     `0 <= walletbalance_spot_inOrder[u_c] <= sum of u's own open orders in c`,
 *     and `walletbalance_spot[u_c] >= 0` for every non-ladder account. See THE
 *     IN-ORDER LEDGER INVARIANT in controllers/spot.controller.js. This one IS
 *     an equality and IS worth alerting on.
 *
 * I3. THE MINT/BURN LIST — THE INVARIANT THAT REPLACES CONSERVATION.
 *     Outside a fill, a user's spot balance may only change through an endpoint
 *     on this list, and every such change must be recorded as a credit or debit
 *     the user can see:
 *
 *       MINT   walletapi `emptyAsset`            registration seed, 10,000 USDC
 *              spotapi  POST /api/spot/faucet/claim      +10,000, 24h cooldown
 *              spotapi  POST /api/spot/faucet/reset      absolute restore
 *              walletapi PUT /adminapi/updateUserAsset {type:'deposit'}
 *              walletapi POST /adminapi/fiatDeposit/approve
 *       BURN   spotapi  POST /api/spot/faucet/reset      zeroes non-faucet coins
 *              walletapi PUT /adminapi/updateUserAsset {type:'withdraw'}
 *       MOVE   nothing. /api/wallet/transfer answers 410 - every wallet it
 *              could reach has been withdrawn.
 *
 *     ANY OTHER ENDPOINT THAT REDUCES A SPOT BALANCE IS A DEFECT, whatever it
 *     says in its response. That sentence is the whole reason this block exists:
 *     `POST /api/spot/requestWithdrawal` reduced a balance by up to 10,000 per
 *     call, was on nobody's list, and survived several audits because the audits
 *     were looking for conservation - and a withdrawal that debits one account
 *     and credits nobody does not break conservation any more visibly than a
 *     fill against the ladder does. It is now refused
 *     (controllers/withdrawal.controller.js), along with walletapi's three
 *     withdrawal handlers.
 *
 *     tests/unit/money-supply-invariant.test.js pins the list by scanning the
 *     source for spot-balance writers, so a NEW one cannot be added silently.
 * ============================================================================
 */

import mongoose from 'mongoose';

import Currency from '../models/currency.js';
import {
  hset,
  hget,
  hincbyfloat,
  moveBalanceLogged,
  setBalanceLogged,
} from './redis.controller.js';
import { updateUserAsset } from '../grpc/walletService.js';

export const SPOT_BALANCE_KEY = 'walletbalance_spot';

// THE FLAT `assets` LEDGER IS GONE.
//
// A second ledger mirrored one coin's balance in smallest units: USDC, and
// only USDC - every other coin lived in wallet.assets, and walletapi's
// getWallet would mis-scale a smallest-unit value for anything else. USDC had
// no market on a venue that lists BTC/USD alone, so it is deleted along with
// that collection, and a spot balance now lives in exactly one place: the
// trading-engine Redis field.

export const toObjectId = (id) =>
  typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id;

/**
 * Resolve every ledger location for one user + currency.
 * `fields[0]` is always the trading-engine field (`<userId>_<currencyId>`); the
 * remaining fields are the other Redis key styles that must be kept in step.
 */
export const resolveAccount = async (userId, currency, { create = false } = {}) => {
  const userIdObj = toObjectId(userId);
  const userIdStr = userIdObj.toString();

  const ids = [currency._id.toString()];

  return {
    userIdObj,
    userIdStr,
    currency,
    coin: currency.coin,
    fields: ids.map((id) => `${userIdStr}_${id}`)
  };
};

/**
 * Live spot balance in regular units, from the trading-engine Redis field.
 *
 * There used to be a fallback here to the flat ledger's seed value, for an
 * account that had never traded and so had no Redis field yet. That ledger is
 * gone with USDC, the only coin it held, and an absent field now means exactly
 * what it says: no balance.
 */
export const readSpotBalance = async (account) => {
  const live = await hget(SPOT_BALANCE_KEY, account.fields[0]);
  return live != null ? parseFloat(live) : 0;
};

/**
 * Mirror an authoritative balance into the flat `assets` collection and the
 * gRPC wallet ledger. Never throws: Redis stays authoritative.
 */
const syncSlowLedgers = async (account, newBalance, context = {}) => {
  try {
    await updateUserAsset({
      id: account.userIdStr,
      currencyId: account.currency._id.toString(),
      spotBal: newBalance.toString()
    });
  } catch (grpcErr) {
    console.error(
      '[PaperLedger] LEDGER SYNC FAILURE: gRPC updateUserAsset failed; wallet.assets is now diverged from Redis (Redis remains authoritative)',
      {
        userId: account.userIdStr,
        coin: account.coin,
        targetSpotBal: newBalance.toString(),
        ...context
      },
      grpcErr
    );
  }
};

/**
 * Move a spot balance by `amount` (negative debits) across EVERY ledger.
 *
 * The trading-engine field is mutated with HINCRBYFLOAT so concurrent order
 * placement / fills are never clobbered. A field that does not exist yet is
 * created at the delta: it used to be seeded from the flat ledger's value plus
 * the delta, but that ledger held USDC alone and is deleted with it, so an
 * absent field means no prior balance rather than one recorded elsewhere.
 */
export const adjustSpotBalance = async (
  account,
  amount,
  { label = 'credit', ref = '' } = {}
) => {
  const [engineField, ...mirrorFields] = account.fields;

  // EVERY MOVEMENT OF THE ENGINE FIELD GOES THROUGH THE LEDGER. This function
  // is the faucet's and the seeder's way into a balance, so a movement that
  // skipped the ledger here would be a movement no replay could reconstruct -
  // and rebuildBalance would then quietly restore an account to the wrong
  // number. moveBalanceLogged writes the entry inside the same atomic step as
  // the increment; see lib/ledger.js.
  //
  // A negative `amount` is a debit. It is routed as one rather than as a
  // negative credit so the refusal-on-overdraw path is the same one every other
  // debit takes, instead of a second way to reach a negative balance.
  let newBalance;
  const delta = Number(amount);
  const moved = await moveBalanceLogged(
    SPOT_BALANCE_KEY,
    engineField,
    Math.abs(delta),
    {
      direction: delta < 0 ? 'debit' : 'credit',
      reason: label,
      ref: String(ref || ''),
    }
  );
  if (!moved || moved === 'FROZEN') {
    throw new Error(`Failed to ${label} spot balance`);
  }
  newBalance = parseFloat(moved.balance);

  // The mirror fields are SET to the post-increment engine balance, never
  // incremented by the same delta. Incrementing preserved whatever the mirror
  // had already drifted by: the matcher settles the engine field alone, so a
  // mirror that fell behind on a fill stayed exactly that far behind through
  // every later faucet claim and withdrawal. Setting re-derives it, which is
  // the only definition a mirror is allowed to have.
  for (const field of mirrorFields) {
    // Logged too. A mirror has its OWN stream, so recording it double-counts
    // nothing - and leaving it unlogged would make reconcile permanently wrong
    // for every mirror field, which is the same blind spot in a smaller place.
    await setBalanceLogged(SPOT_BALANCE_KEY, field, newBalance, {
      reason: 'mirror_resync',
      ref: account.userIdStr || '',
    });
  }

  await syncSlowLedgers(account, newBalance, { amount });

  console.log('[PaperLedger] Balance adjusted:', {
    userId: account.userIdStr,
    coin: account.coin,
    amount,
    newBalance
  });
  return newBalance;
};

/** Set an absolute spot balance across every ledger (used by the reset). */
export const setSpotBalance = async (account, newBalance) => {
  for (const field of account.fields) {
    // An absolute write, recorded as the delta it implies, so a replay still
    // lands on `newBalance`. Unlogged, this was one of the two remaining ways
    // to move money without a record.
    await setBalanceLogged(SPOT_BALANCE_KEY, field, newBalance, {
      reason: 'faucet_reset',
      ref: account.userIdStr || '',
    });
  }

  await syncSlowLedgers(account, newBalance);

  console.log('[PaperLedger] Balance set:', {
    userId: account.userIdStr,
    coin: account.coin,
    newBalance
  });
  return newBalance;
};

export default {
  SPOT_BALANCE_KEY,
  toObjectId,
  resolveAccount,
  readSpotBalance,
  adjustSpotBalance,
  setSpotBalance
};
