/**
 * Deposit Controller
 * Paper-trading deposits: balances are virtual, funded via the faucet
 */

import { DepositEvent } from '../models/index.js';
import Currency from '../models/currency.js';
import { resolveAccount, readSpotBalance } from './paperLedger.js';
import { fromBaseUnits, LEGACY_DEPOSIT_DECIMALS } from '../lib/depositUnits.js';

/**
 * User's USDC balance, from the LIVE trading-engine ledger.
 *
 * This used to read the flat `assets` collection document directly and divide
 * by 1e6. That document is a mirror, not a ledger: every settlement in
 * spot.controller.js moves `walletbalance_spot[<userId>_<currencyId>]` and
 * nothing else, so the flat value is whatever the last faucet/deposit/withdrawal
 * left behind. On live data that made this endpoint report 10,000 USDC for a
 * user the engine had already settled down to 5,000, and 0 for a user holding
 * 10,000 - the same divergence the withdrawal controller's balance check was
 * moved off for exactly this reason.
 *
 * readSpotBalance() prefers the engine field and falls back to the flat value
 * only for an account the engine has never touched.
 */
async function getUserUsdcBalance(userId) {
  try {
    // Get USDC currency from spot database
    const currency = await Currency.findOne({ coin: 'USDC' });
    if (!currency) {
      return 0;
    }

    // Use walletDb connection from currency model
    const walletDb = Currency.db;
    if (!walletDb) {
      console.warn('[Deposit] Wallet database not connected');
      return 0;
    }

    const account = await resolveAccount(userId, currency);
    const balanceInUsdc = await readSpotBalance(account);

    console.log('[Deposit] USDC balance query result:', {
      userId,
      balanceInUsdc
    });
    return Number.isFinite(balanceInUsdc) ? balanceInUsdc : 0;
  } catch (error) {
    console.error('[Deposit] Error fetching USDC balance:', error.message);
    return 0;
  }
}

/**
 * Get deposit info for the authenticated user
 * GET /api/spot/getDepositInfo
 * Auth: User token (passport). The legacy ?userId= query param is ignored;
 * the balance returned is always the authenticated user's own.
 */
export const getDepositInfo = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // Get user's USDC balance
    const usdcBalance = await getUserUsdcBalance(userId);

    res.json({
      success: true,
      paperTrading: true,
      usdcBalance: usdcBalance
    });

  } catch (error) {
    console.error('[Deposit] Get deposit info error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get the demo-credit history for the authenticated user
 * GET /api/spot/faucet/history?page=1&limit=5
 * Returns formatted history matching frontend expectations
 *
 * THE URL, AND WHY IT MOVED. This was /getDepositHistory, and it was deleted
 * with the real deposit rails - but it is the one reader of that group whose
 * rows this venue still creates, because a faucet claim writes one DepositEvent
 * per credited leg. Deleting the route did not stop the writes; it only stopped
 * the user seeing them, which is what left the claim page's "Demo credit
 * history" table permanently empty. It is mounted again at /faucet/history: the
 * function is unchanged, the collection is unchanged, and only the name now
 * matches a platform on which nothing is deposited.
 *
 * EVERY LEG OF A CLAIM, WITH THE WALLET IT LANDED IN
 * --------------------------------------------------
 * A faucet claim can credit more than one wallet, and every leg is recorded
 * (see controllers/faucet.controller.js recordCreditedLegs). This endpoint
 * reports the row's `wallet` so the history page can name it; the page used to
 * have to reconstruct the non-spot rows from a browser-local receipt, which
 * meant they were invisible on every other device. Rows written before the column exists read as 'spot', which is what
 * all of them were.
 *
 * The amount is decoded at the row's OWN `decimals` rather than a hard-coded
 * 1e6. 0.05 BTC is not representable as a whole number of 1e6 units in any
 * honest way, and the old rows still say 6.
 */
export const getDepositHistory = async (req, res) => {
  try {
    // Get userId from authenticated user (passport)
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const skip = (page - 1) * limit;

    // Count total deposits for pagination
    const count = await DepositEvent.countDocuments({
      userId,
      status: 'credited'
    });

    // Get deposits with pagination.
    // The legs of one claim share a single creditedAt, so `_id: 1` is what
    // orders them within the claim - insertion order, i.e. spot half first.
    // Without the tiebreak the rows of a claim come back in whatever order the
    // index happens to yield, and a page boundary could split them arbitrarily.
    const deposits = await DepositEvent.find({
      userId,
      status: 'credited'
    })
    .sort({ creditedAt: -1, _id: 1 })
    .limit(limit)
    .skip(skip)
    .lean();

    // Format deposits to match frontend expectations (similar to Wallet API format)
    const formattedData = deposits.map(dep => ({
      createdAt: dep.creditedAt || dep.createdAt,
      paymentType: 'coin_deposit',
      coin: dep.asset,
      wallet: dep.wallet || 'spot',
      amount: fromBaseUnits(dep.amount, dep.decimals ?? LEGACY_DEPOSIT_DECIMALS),
      txid: dep.signature,
      tokenType: 'SOL',
      status: 'completed',
      toAddress: dep.toAddress
    }));

    res.json({
      success: true,
      result: {
        data: formattedData,
        count: count
      }
    });

  } catch (error) {
    console.error('[Deposit] Get history error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export default {
  getDepositInfo,
  getDepositHistory
};
