/**
 * Withdrawal Controller — WITHDRAWAL IS CLOSED ON THIS VENUE
 * =========================================================
 *
 * This file used to complete a withdrawal: it debited every spot ledger by the
 * requested amount and answered
 *
 *     { success: true, amount: 10000, destination: "<a Solana address>",
 *       txid: "paper-1786181755609", message: "Withdrawal processed successfully" }
 *
 * MEASURED on this stack (own throwaway, ordinary user token, ONE request, no
 * race, no admin): spot USDC 19,500 -> 9,500 on all four ledger locations -
 * `walletbalance_spot[<uid>_<currencyId>]`, the wallet-API mirror field, the
 * flat `assets` row and `wallet.assets[].spotBal` - with no cooldown between
 * calls and no cap other than 10,000 per call.
 *
 * WHY THAT IS THE ONE THING IT MUST NOT DO
 * ---------------------------------------
 * A withdrawal moves value from the venue's custody to the user's. This venue
 * has no custody: the whole premise of the paper conversion is that nothing
 * is held, and the product's own banner says "no real money is deposited,
 * traded, or withdrawn". So there is no counterparty to receive the funds and
 * nowhere for them to go. What the endpoint actually did was DELETE the user's
 * scoreboard and hand back a receipt naming a Solana address that received
 * nothing. Every field of that receipt - `destination`, `txid`, "processed
 * successfully" - was false.
 *
 * WAS IT MEANT TO BE STUBBED, OR IS IT A DELIBERATE SURFACE?  MEANT TO BE
 * STUBBED, AND THE STUB STOPPED HALF A STEP SHORT.
 *
 *   - The conversion spec's decision 2 ("Withdrawals stubbed, not deleted
 *     (backend)") names precisely what it was replacing: "the on-chain send and
 *     the hot-wallet liquidity gate ... replaced by instant completion with txid
 *     `paper-<ts>`". It is a statement about the CHAIN leg. It never argued
 *     that a paper venue should be able to burn a balance; it kept
 *     `debitUserBalance` because the conversion's own analysis
 *     labelled it "virtual-only - salvage", i.e. "this code needs no custody
 *     work", not "this behaviour is wanted".
 *   - Decision 3 - the "stub in place, do not delete" rule - exists for ONE
 *     reason: `grpc/server.js -> createAsset.js -> coin.controller.js` imports
 *     the six gateways and walletapi constructs FireblocksSDK at module load,
 *     so deleting those files crashes the gRPC boot chain. That reason does not
 *     reach this file. Nothing imports `withdrawal.controller.js` except
 *     `routes/spot.route.js`; there is no boot chain to protect.
 *   - The same decision 2 says the frontend withdraw page becomes "Reset demo
 *     account", and it did (components/Wallet/ResetForm.tsx). The intended
 *     end state therefore has NO user-facing flow that reaches this endpoint -
 *     and none does: `requestUsdcWithdrawal` in services/Wallet/WalletService.ts
 *     has no importer. What was left behind is a debit reachable only by
 *     hand-rolling the request, which is the definition of a vestige.
 *
 * SO: REFUSE, DO NOT NO-OP. The two honest outcomes are a refusal or a no-op
 * that says so. A no-op has to answer 200 with a body shaped like the old
 * success (there is no other shape a caller would recognise), and any such body
 * is one careless client away from telling a user their withdrawal went
 * through. A refusal cannot be misread: 410 Gone, a machine-readable
 * `code: "WITHDRAWALS_CLOSED"`, and a sentence naming the reset as the thing
 * the user probably wanted. Nothing is debited, and no `WithdrawalEvent` row is
 * written - the history below stays exactly as long as it is today.
 *
 * WHAT IS KEPT. `getWithdrawalHistory` / `getWithdrawalStatus` still serve the
 * rows that already exist (13 in `withdrawalevents` at the time of writing,
 * including pre-conversion ones). Deleting the readers would hide a user's own
 * record; keeping them is what lets the UI say "this facility is closed and
 * here is what you did before it was", which is the true story.
 *
 * SIBLINGS. walletapi's `withdrawCoinRequest` / `withdrawCoinRequestApp` /
 * `withdrawFiatRequest` are the same endpoint in a different service and are
 * refused there for the same reason - see that file's WITHDRAWAL IS CLOSED
 * block.
 */

import { WithdrawalEvent } from '../models/index.js';

const WITHDRAWAL_COIN = 'USDC';

// Every withdrawal this exchange has issued since the paper conversion carries
// a `paper-<ms>` signature and network "paper".
const PAPER_SIGNATURE_PREFIX = 'paper-';
const PAPER_NETWORK = 'paper';

/**
 * The single refusal, so the two spot entry points and any future one cannot
 * drift into saying different things about the same fact.
 */
export const WITHDRAWALS_CLOSED = {
  code: 'WITHDRAWALS_CLOSED',
  message:
    'Withdrawals are closed. Cryptodex is a paper-trading venue: your balance is a ' +
    'scoreboard, not custody, so there is nothing to send and nowhere to send it. ' +
    'No funds have been moved and your balance is unchanged. To start over, reset ' +
    'your demo account.',
  resetEndpoint: 'POST /api/spot/faucet/reset',
  resetPath: '/withdraw'
};

/**
 * PRE-CONVERSION WITHDRAWAL ROWS
 * ------------------------------
 * `withdrawalevents` still holds rows written before Cryptodex became a paper
 * exchange, whose `signature` is a real 88-character base58 Solana txid. Those
 * rows are a user's own history and are NOT deleted or rewritten - but on a
 * paper exchange a real-looking chain signature is a lie the moment it reaches
 * a screen (it looks resolvable on an explorer, and it is not a transaction
 * this exchange performed).
 *
 * So the guard is display-side and lives at the only place these rows can be
 * surfaced: the history/status responses below never emit a chain signature as
 * a txid. The stored document is untouched; a row that is not paper-issued is
 * reported as legacy, with no txid.
 *
 * scripts/migrate-legacy-withdrawal-signatures.js can move those signatures out
 * of the `signature` field permanently. It is deliberately NOT run.
 */
export const isPaperIssued = (withdrawal) =>
  withdrawal?.network === PAPER_NETWORK ||
  String(withdrawal?.signature || '').startsWith(PAPER_SIGNATURE_PREFIX);

/**
 * Request a withdrawal — REFUSED
 * POST /api/spot/requestWithdrawal
 *
 * Answers 410 Gone before reading or writing anything. There is no auth branch,
 * no validation branch and no balance branch, deliberately: every one of them
 * would be a place where a future edit could reintroduce the debit, and none of
 * them can change the answer. The route still carries `passportAuth`, so an
 * anonymous caller is turned away by the router as before.
 */
export const requestWithdrawal = async (req, res) => {
  return res.status(410).json({
    success: false,
    error: WITHDRAWALS_CLOSED.message,
    ...WITHDRAWALS_CLOSED
  });
};

/**
 * Get withdrawal status by signature
 * GET /api/spot/getWithdrawalStatus?signature=xxx
 * Auth: User token (passport). Paper txids are sequential/enumerable, so the
 * lookup is scoped to the authenticated user's own withdrawals only.
 */
export const getWithdrawalStatus = async (req, res) => {
  try {
    const { signature } = req.query;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    if (!signature) {
      return res.status(400).json({ error: 'Missing signature' });
    }

    const withdrawal = await WithdrawalEvent.findOne({ signature, userId }).lean();

    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    const paperIssued = isPaperIssued(withdrawal);

    res.json({
      success: true,
      signature: signature,
      status: withdrawal.status,
      amount: withdrawal.amountFormatted,
      destination: withdrawal.destinationAddress,
      createdAt: withdrawal.createdAt,
      network: paperIssued ? PAPER_NETWORK : 'legacy',
      isPaper: paperIssued,
      legacy: !paperIssued,
      ...(paperIssued ? {} : { note: 'Pre-paper-conversion record' })
    });

  } catch (error) {
    console.error('[Withdrawal] Status error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get withdrawal history for authenticated user
 * GET /api/spot/getWithdrawalHistory?page=1&limit=5
 */
export const getWithdrawalHistory = async (req, res) => {
  try {
    // Get userId from authenticated user (passport)
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const skip = (page - 1) * limit;

    // Count total withdrawals for pagination
    const count = await WithdrawalEvent.countDocuments({ userId });

    // Get withdrawals with pagination
    const withdrawals = await WithdrawalEvent.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    // Format withdrawals to match frontend expectations.
    // A pre-conversion row's chain signature is never emitted as a txid - see
    // the PRE-CONVERSION WITHDRAWAL ROWS note above.
    const formattedData = withdrawals.map(withdrawal => {
      const paperIssued = isPaperIssued(withdrawal);
      return {
        createdAt: withdrawal.createdAt,
        paymentType: 'coin_withdraw',
        coin: WITHDRAWAL_COIN,
        amount: withdrawal.amountFormatted, // Already in regular units
        txid: paperIssued ? (withdrawal.signature || 'N/A') : 'N/A',
        tokenType: 'SOL',
        status: withdrawal.status,
        toAddress: withdrawal.destinationAddress,
        network: paperIssued ? PAPER_NETWORK : 'legacy',
        isPaper: paperIssued,
        legacy: !paperIssued,
        ...(paperIssued ? {} : { note: 'Pre-paper-conversion record' })
      };
    });

    res.json({
      success: true,
      // The reader is the only place left that says the word "withdrawal" to a
      // user, so it has to carry the fact that the facility behind it is shut.
      // Sent by the SERVER rather than hard-coded in the page, so that the page
      // and the endpoint cannot come to disagree about whether withdrawal
      // exists: `closed` is the same fact `requestWithdrawal`'s 410 states.
      closed: true,
      notice: WITHDRAWALS_CLOSED.message,
      result: {
        data: formattedData,
        count: count
      }
    });

  } catch (error) {
    console.error('[Withdrawal] Get history error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export default {
  requestWithdrawal,
  getWithdrawalStatus,
  getWithdrawalHistory,
  isPaperIssued,
  WITHDRAWALS_CLOSED
};
