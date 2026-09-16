//  import packages
import express from "express";
import passport from 'passport';

// import controllers
import * as spotTradeCtrl from "../controllers/spot.controller.js";
import * as chartCtrl from "../controllers/chart/chart.controller.js";
import * as faucetCtrl from "../controllers/faucet.controller.js";
import * as fillCanaryCtrl from "../controllers/fillCanary.js";
import * as depositCtrl from "../controllers/deposit.controller.js";

// import validation
import * as spotTradeValid from "../validation/spotTrade.validation.js";

// import guards
import { blockStoodDownAccount } from "../controllers/standDownState.js";
import { trackValueFlight } from "../controllers/valueFlightGuard.js";

const router = express();
const passportAuth = passport.authenticate("usersAuth", { session: false });

// `blockStoodDownAccount` is on every route below that CREATES OR SETTLES
// EXPOSURE OR MOVES VALUE, and on none of the routes that only read state or
// RELEASE an unfilled reservation. Until it existed, spot honoured no freeze at
// all: a frozen wallet with a live session could place orders, lock spot
// balance, re-fund itself from the faucet and withdraw, because nothing outside
// walletapi could see the flag.
//
// GATED:   /orderPlace (limit and market both dispatch through the one
//          handler, so one gate covers every form), /faucet/claim,
//          /faucet/reset, /requestWithdrawal.
// UNGATED: /cancelOrder, and every read. A cancel moves nothing out of the
//          account - it turns `walletbalance_spot_inOrder` back into spendable
//          `walletbalance_spot` in the same wallet - and a stand-down must
//          never be the thing that traps funds behind an unfilled order. Reads
//          cannot move a balance, and a stood-down user still needs to see the
//          orders they are still allowed to cancel.
//
// lib/accountStandDown.js has the full argument, route by route. The freeze
// this enforces is set by account deactivation AND by walletapi alone; both are
// visible here. See controllers/standDownState.js.
//
// `trackValueFlight` is a DIFFERENT guard with a superficially similar shape,
// and the two are deliberately separate. The stand-down asks "may this account
// move value at all", which is a fact about the account that outlives the
// request. The value-flight registry asks "is a `faucet/reset` allowed to write
// absolute balances over this request", which is a fact about THIS INSTANT: it
// registers the request while it runs and deregisters it when the response is
// flushed, so the reset can refuse rather than interleave. It is on every route
// that MOVES a balance, including /cancelOrder - a cancel is a refund, and a
// refund landing after the reset's absolute write is minted demo money just as
// surely as an order placement is. lib/valueFlight.js has the measurement and
// the argument.
//
// NOTE this router is mounted TWICE in server.js - at /api/spot and at
// /app/spot - so the gate has to live on the routes, not on a mount.

// Fill canary / system health. Unauthenticated on purpose: it is what a human
// or an uptime monitor reaches for when the platform feels wrong, and it
// returns system state only (see controllers/fillCanary.js).
router.route("/health").get(fillCanaryCtrl.healthCheck);

//spot trade
router.route("/tradePair").get(spotTradeCtrl.getPairList);
// The guard sits immediately after auth and BEFORE the decrypt/validate chain,
// so a stood-down account's order is refused before its payload is decrypted
// and long before anything reads or writes a balance.
router.route("/orderPlace").post(passportAuth, blockStoodDownAccount, trackValueFlight, spotTradeValid.decryptValidate, spotTradeCtrl.decryptTradeOrder, spotTradeValid.orderPlaceValidate, spotTradeCtrl.orderPlace);
router.route("/ordeBook/:pairId").get(spotTradeCtrl.getOrderBook);
router.route("/openOrder/:pairId").get(passportAuth, spotTradeCtrl.getOpenOrder);
router.route("/filledOrder/:pairId").get(passportAuth, spotTradeCtrl.getFilledOrder);
router.route("/orderHistory/:pairId").get(passportAuth, spotTradeCtrl.getOrderHistory);
router.route("/tradeHistory/:pairId").get(passportAuth, spotTradeCtrl.getTradeHistory);
router.route("/marketPrice/:pairId").get(spotTradeCtrl.getMarketPrice);
router.route("/recentTrade/:pairId").get(spotTradeCtrl.getRecentTrade);
// DELIBERATELY UNGATED BY THE STAND-DOWN. Releasing an unfilled reservation is
// always allowed; see the header of this file and lib/accountStandDown.js.
//
// It IS registered as a value flight, which is not the same thing and does not
// trap anything: that only excludes it from the few milliseconds a reset of
// this same account is running, and the reset refuses outright while any order
// is resting, so the two can only ever collide on a cancel that arrived first.
router.route("/cancelOrder").post(passportAuth, trackValueFlight, spotTradeCtrl.cancelOrder);
router.route("/depth-chart").post(spotTradeCtrl.getDepthData);

// /app-chart was the mobile-app variant of the chart feed. There is no mobile
// app; the route was already commented out and is now gone with the rest of the
// `-app` surface.

// order History
router.route("/getMySpotHistory").get(passportAuth, spotTradeCtrl.getMySpotHistory);
router.route("/getFilledOrderHistory").get(passportAuth, spotTradeCtrl.getFilledOrderHistory);

// chart
router.route("/chart/:config").get(chartCtrl.getChartData);
// /chartUpdateToDB and /chartUpdateToRedis are NOT mounted. Both were
// unauthenticated POSTs that rewrote every pair's candle history - anyone able
// to reach the port could rewrite the charts. They were also broken as HTTP
// handlers: `AllPairUpdate` and `AllPairDbToRedis` take no (req, res) at all,
// so express would run the rewrite and then hold the connection open until the
// client gave up.
//
// They are one-shot maintenance utilities, still exported from
// controllers/chart/chart.controller.js and callable from a script. Nothing in
// the service calls them on a schedule, and the live candle path does not need
// them: the Binance websocket feeds redis directly.
router.route("/get-trends").get(spotTradeCtrl.getTrends);

// DEPOSIT AND WITHDRAWAL ARE GONE from this service, matching walletapi.
// /getDepositInfo, /requestWithdrawal, /getWithdrawalStatus and
// /getWithdrawalHistory described money arriving from and leaving to somewhere
// off-venue. There is nowhere off-venue: balances come from the faucet and
// change only by trading. requestWithdrawal already answered 410, and its
// history siblings only ever listed rows nothing could create.
//
// /getDepositHistory WAS DELETED WITH THEM, AND THAT WAS A MISTAKE. It is the
// only one of the five that reads rows this venue still writes: every leg of
// every faucet claim becomes a `DepositEvent` (controllers/faucet.controller.js
// `recordCreditedLegs`), written in the same call that moves the balance. With
// the route gone the frontend's claim page and /history both asked for it, got
// 404, swallowed the error and printed "No Records Found" - under a heading
// offering a history, immediately after a claim that had just been recorded.
// The rows were there the whole time.
//
// It comes back below as /faucet/history, with the rest of the faucet and named
// for what this venue does. Nothing is renamed in the collection or the
// controller; only the URL, so that the surviving reader is not called
// "deposit" on a platform where nothing is ever deposited.

// ==================== Faucet Endpoints ====================

// Claim demo funds (24h cooldown). GATED: it credits FAUCET_AMOUNT to every
// faucet coin. A frozen account that can re-fund itself is not frozen.
router.route("/faucet/claim").post(passportAuth, blockStoodDownAccount, trackValueFlight, faucetCtrl.claimFaucet);

// How long until this account may claim again. NOT gated and NOT a value
// flight: it only reads the TTL of the key the claim route sets, so asking can
// neither start nor extend a cooldown, and a stood-down account asking when it
// may claim is a question rather than a claim. The claim page needs this to be
// able to say "in 7h 12m" instead of leaving the button live and answering the
// press with a 429.
router.route("/faucet/status").get(passportAuth, faucetCtrl.faucetStatus);

// Every demo credit this account has been given, newest first, paginated.
//
// NOT gated by `blockStoodDownAccount` and NOT a value flight: it is a read of
// rows the claim already wrote. A stood-down account may not claim, and may
// still see what it was given - refusing to show a user their own history
// protects nothing, and the stand-down exists to stop value MOVING.
router.route("/faucet/history").get(passportAuth, depositCtrl.getDepositHistory);

// Reset demo account balance. GATED: it SETS every faucet balance and ZEROES
// every other one - value moving in both directions in a single request.
//
// NOT registered as a value flight, because it is the WRITER the registry
// excludes readers from, not one of the readers. It takes the margin freeze
// itself and then reads the registry; registering itself would make it refuse
// itself. Two concurrent resets are serialised by the freeze (`claimOnce`), so
// nothing is lost by leaving this one off the list.
router.route("/faucet/reset").post(passportAuth, blockStoodDownAccount, faucetCtrl.resetFaucet);

// ==================== Withdrawal Endpoints ====================

// Request a withdrawal. REFUSED - 410 Gone, nothing read and nothing written.
// See controllers/withdrawal.controller.js: this venue holds no custody, so a
// "withdrawal" could only ever delete the user's balance and hand back a
// receipt naming an address that received nothing.
//
// NOTE, corrected: this block used to claim "The route is KEPT, with its
// guards". It is NOT. There is no `router.route("/requestWithdrawal")` anywhere
// in this file - the router ends at the export below - so the endpoint answers
// 404, not the 410 the argument below describes. The handler
// (controllers/withdrawal.controller.js:requestWithdrawal) is still exported and
// still returns 410, but nothing routes to it.
//
// Left unregistered deliberately rather than wired up: no client calls it. Every
// withdrawal wrapper was deleted from the frontend
// (services/Wallet/WalletService.ts), so the 404-vs-410 distinction has no
// audience, and registering it would add a public endpoint nothing uses.
//
// If it is ever re-opened, the original reasoning still applies and is worth
// keeping:
//   - a deleted route answers 404, which reads to a client like a deploy fault
//     rather than a decision; 410 says "this existed and is gone".
//   - `passportAuth` keeps the refusal behind a login, so the endpoint does not
//     become an unauthenticated probe for whether the venue is paper.
//   - `blockStoodDownAccount` and `trackValueFlight` are the guards a
//     value-moving route must carry, so they should go back on with it.
export default router;
