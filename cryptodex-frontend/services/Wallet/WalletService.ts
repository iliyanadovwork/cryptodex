import ApiService from "./ApiService";
import SpotApiService from "./SpotApiService";

/**
 * WHAT THIS CLIENT IS ALLOWED TO ASK FOR.
 * =======================================
 *
 * Every function below was checked against the route tables of the services it
 * talks to (walletapi routes/, spotapi routes/spot.route.js) and against a live
 * request to the running stack. A wrapper for an endpoint that answers 404 is
 * not neutral: it is one `import` away from a screen that renders a spinner
 * over a request that can never succeed, and that is exactly how
 * /verification/coinwithdraw stayed live for four rounds of deletion.
 *
 * REMOVED IN THIS PASS, all verified 404 on the running stack and all with no
 * caller anywhere in the app:
 *
 *   apiWithdrawRequestCoin   wallet/coinWithdraw   POST
 *   apiWithdrawRequestFiat   wallet/fiatWithdraw   POST
 *   apiCoinRequestVerify     wallet/coinWithdraw   PATCH  (the e-mailed link)
 *   fiatRequestVerify        wallet/fiatWithdraw   PATCH  (the e-mailed link)
 *   apiGetWithdrawLimit      wallet/getWithdrawLimit
 *   getWithdrawalStatus      spot/getWithdrawalStatus
 *   getSolanaWithdrawalHistory spot/getWithdrawalHistory
 *   apiWalletTransfer        wallet/transfer       (one wallet left to move to)
 *   apiGetUserDeposit        wallet/userDeposit
 *   apiFiatDepositRequest    wallet/fiatDeposit
 *   createAdderss            wallet/createAddress
 *   getSolanaDepositInfo     spot/getDepositInfo
 *   getSolanaDepositWallet   spot/getDepositWallet
 *   getOnrampCurr / checkOnrampNetwork / createOnrampTrans   onramp/*
 *
 * The last three were the card-purchase rail. There is no rail: balances come
 * from the faucet and change only by trading.
 */

export async function apiGetAssetData() {
  return ApiService.fetchData({
    url: "wallet/getAssetsDetails",
    method: "get",
  });
}

export async function getAssetByCurrency(currencyId: string) {
  try {
    let respData: any = await ApiService.fetchData({
      url: "wallet/getAsset/" + currencyId,
      method: "get",
    });
    return {
      status: true,
      result: respData.data.result,
      message: respData.data.message
    }
  } catch (err: any) {
    return {
      status: false,
      message: err.response.data.message,
    }
  }
}

export async function apiGetTrnxHistory(params: string, query: any) {
  return ApiService.fetchData({
    url: "wallet/history/transaction/" + params,
    method: "get",
    params: query
  });
}

// Demo faucet (paper trading, use SpotApiService)
export async function faucetClaim() {
  return SpotApiService.post('/spot/faucet/claim', {});
}

export async function faucetReset() {
  return SpotApiService.post('/spot/faucet/reset', {});
}

/**
 * How long until this account may claim again.
 * `{ success, canClaim, retryAfter (seconds), cooldownSeconds }`.
 * Read-only on the server: asking cannot start or extend a cooldown.
 */
export async function faucetStatus() {
  return SpotApiService.get('/spot/faucet/status');
}

/**
 * EVERY DEMO CREDIT THIS ACCOUNT HAS BEEN GIVEN.
 *
 * One row per credited leg of a faucet claim, written by spotapi's
 * `recordCreditedLegs` at the moment the balance moves, so the list is the
 * server's own record rather than a receipt kept in this browser.
 *
 * It used to be `getSolanaDepositHistory` against `spot/getDepositHistory` - a
 * route that was deleted with the real deposit rails, which left the claim page
 * and /history rendering "No Records Found" under a heading promising a
 * history, for accounts that had just claimed. The rows never stopped being
 * written; only the way to read them was removed. It now reads
 * `spot/faucet/history`, which sits with the rest of the faucet and is named
 * for what this venue actually does.
 */
export async function getDemoCreditHistory(page = 1, limit = 5) {
  return SpotApiService.get(`/spot/faucet/history?page=${page}&limit=${limit}`);
}

// WITHDRAWAL IS CLOSED, AND THERE IS NO CLIENT FOR IT - not for requesting one,
// not for confirming one from an e-mailed link, and not for listing past ones.
//
// `requestUsdcWithdrawal` used to live here, described as "the actual USDC
// withdrawal implementation with hot wallet + Solana transactions". It had no
// importer - the withdraw page became Reset Demo Account during the paper
// conversion - but it stayed as a loaded gun: one `import` away from a
// component that debits a user's demo balance and shows them a Solana txid.
//
// The two READERS that used to survive here (`getWithdrawalStatus`,
// `getSolanaWithdrawalHistory`) have now gone too. Their endpoints were deleted
// from spotapi, so both answered 404, and the /history tab that rendered the
// second one showed an empty archive of a facility no account on this venue has
// ever used. To start over, a user resets the demo account (/reset).
