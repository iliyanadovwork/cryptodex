//import packages
import express from "express";
import passport from "passport";
import { trackValueFlight } from "../controllers/valueFlightGuard.js";

//import controllers
import * as walletCtrl from "../controllers/wallet.controller.js";


const router = express();
const passportAuth = passport.authenticate("usersAuth", { session: false });

router.route("/getAssetsDetails").get(passportAuth, walletCtrl.getWallet);
// `blockFrozenWallet` is on every route below that MOVES value, and on none of
// the routes that only read it. A wallet stood down by an account deactivation
// keeps its balances (see lib/walletStandDown.js) - the freeze is only real if
// the movement routes enforce it, and a restored account has to be able to see
// its portfolio in the meantime.
// `trackValueFlight` is a DIFFERENT guard from `blockFrozenWallet` and answers
// a different question. The stand-down asks "may this account move value at
// all". The value-flight registry asks "is spotapi's `faucet/reset` allowed to
// write absolute balances over this request", and it is a fact about THIS
// INSTANT: the transfer registers itself while it runs and deregisters when the
// response is flushed, so the reset refuses rather than interleaving. A
// transfer interleaved with a reset leaves the account holding the restored
// grant AND the transferred amount - minted demo money. See lib/valueFlight.js.
// REFUSED - 410 Gone. There is one wallet on this venue, so there is nowhere
// to transfer to; see WALLET_TRANSFER_CLOSED in controllers/wallet.controller.js
// for why the route is kept and refused rather than deleted.
//
// `walletTransferValid` is NO LONGER IN THIS CHAIN, deliberately. It validated
// `fromType`/`toType` against a list of wallets and rejected a same-wallet move
// as "Wallet MisMatch" - so with only `spot` left it would answer 400 on every
// possible request and the 410 below would be unreachable.
// A request that is going to be refused whatever it says does not need its
// shape checked first, and checking it would replace a self-describing "this is
// gone" with a misleading "your wallet type is invalid".
//
// The three GUARDS stay. They cost one redis read on a request that is refused
// anyway, they keep this from becoming an unauthenticated probe, and they are
// what a value-moving route must carry if anyone ever re-opens it.
//
// RE-CONFIRMED, including the part that argues against itself. Two of the three
// guards can answer BEFORE the 410 and give a different answer:
//
//   blockFrozenWallet  423 WALLET_STOOD_DOWN when the account is stood down,
//                      503 when the stand-down state cannot be read (it fails
//                      closed, as it must on every other route it guards).
//   trackValueFlight   409 RESET_IN_PROGRESS while a faucet reset holds the
//                      freeze, 503 FLIGHT_UNAVAILABLE if redis will not take
//                      the registration - and, for the duration of the
//                      request, it REGISTERS A VALUE FLIGHT for a request that
//                      moves no value, which spotapi's `faucet/reset` will
//                      honour by refusing.
//
// So a caller can be told "a reset is running, try again in a moment" about an
// endpoint that will never work again, and a hammered /transfer can briefly
// hold off a reset for nothing. Both are cheap and bounded (the flight TTL is
// 30s and it deregisters on `finish`), and the alternative - answering 410
// ahead of the guards - trades a correct-but-noisy answer for a route that
// silently loses its guards the day someone re-opens it. THE ORDER IS LEFT AS
// IT IS DELIBERATELY; this note exists so the next reader knows it was weighed
// rather than missed. Pinned by tests/unit/value-flight.test.js (the guard is
// mounted after the stand-down and before the handler) and by
// tests/integration/wallet-api.integration.test.js (401 anonymous, 423 frozen,
// 410 authenticated, no Transaction row).
router
  .route("/transfer")
  .post(
    passportAuth,
    walletCtrl.blockFrozenWallet,
    trackValueFlight,
    walletCtrl.walletTransfer
  );

// /getDashBal, /recentTransaction and the whole /api/dashboard router
// (TotalBalance, TotalBalanceChart, AssetsAllocation, profitLoss) are REMOVED.
// They were portfolio analytics for a dashboard page this venue does not have:
// each had a service wrapper in the frontend and ZERO components or pages
// rendering it. TotalBalance also valued the entire USD balance at nothing,
// because it looks up a USD->USD conversion rate that does not exist - a defect
// that was only ever harmless because nothing displayed the number.
router
  .route("/getAsset/:currencyId")
  .get(passportAuth, walletCtrl.getAssetByCurrency);

// CUSTODY IS GONE, NOT STUBBED.
//
// This block held /fiatDeposit, /coinWithdraw, /coinWithdraw-app,
// /fiatWithdraw, /userDeposit, /getWithdrawLimit and /createAddress - bank
// transfers, on-chain withdrawals, blockchain address generation and withdrawal
// limits. routes/admin.route.js held the other half: the approve/reject
// workflow an operator drove from the admin panel, plus the gas station that
// swept deposits into a hot wallet. All of it moved REAL money.
//
// This venue has no custody. Balances come from the faucet and change only by
// trading. The withdrawal path already answered 410 and the approve/reject half
// was unreachable the moment the admin panel was deleted, so what stood here
// was an apparatus with no inputs, no operator and nothing to move.
//
// The spec's "stub in place, do not delete" rule does NOT apply: it exists
// because walletapi's gRPC boot chain imports the six coin gateways at module
// load, so deleting THOSE crashes the service. Nothing imports these routes
// except this file. Verified before deleting, the same way the withdrawal
// controller was.

// history
router
  .route("/history/transaction/:payment")
  .get(passportAuth, walletCtrl.getTrnxHistory);

// /fireblocksWebhook removed with the rest of custody: it was the callback
// Fireblocks POSTed to when a real deposit confirmed on chain. Unauthenticated
// by nature (it authenticates by signature), pointed at a custody provider
// this venue does not use, and reachable by anyone who can reach the port.

export default router;
