import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import styles from "@/styles/common.module.css";
import { Container, Row, Col, Alert } from "react-bootstrap";
import { useSelector } from "../../store";
import { toastAlert } from "@/lib/toastAlert";
import { faucetReset } from "../../services/Wallet/WalletService";
import { getAssetData, refreshWalletBalances } from "../../store/Wallet/dataSlice";
import { useDispatch } from "react-redux";
import {
  FAUCET_SPOT_GRANT,
  creditPhrase,
  formatCreditAmount,
  groupCreditsByWallet,
  loadReceipts,
  readCredits,
  saveReceipt,
  FaucetCredit,
  FaucetReceipt,
} from "@/lib/faucetReceipt";
import { describeResetRefusal, ResetRefusalView } from "@/lib/resetBlockers";

/**
 * WHAT A RESET ACTUALLY DOES
 * ==========================
 *
 * THE RULE, learned twice: this page describes the reset it can PROVE, and what
 * it says afterwards is read from the server's own receipt rather than from
 * anything written here.
 *
 * It was wrong in both directions before. It said three separate times that
 * wallets would be "zeroed" when the reset was in fact re-seeding one of them,
 * and it documented a reset that would clear the balances under an open
 * position without closing it — behaviour spotapi had already replaced with a
 * refusal.
 *
 * AND THE SAME CORRECTION, FOR SPOT. This page promised twice that "all of your
 * open spot orders are cancelled". spotapi did try to cancel them, by asking
 * mongo which ones were open - a store the order path writes LAST - so an order
 * placed while the reset ran survived it and was refunded on top of the
 * restored total. Measured through the ordinary API: 10,000 -> 48,039.52 in
 * four wins. The reset now REFUSES while any spot order is resting, and this
 * copy says so instead.
 *
 * The refusal machinery is deliberately NOT narrowed to the blockers this build
 * knows about: lib/resetBlockers reads whatever blocker arrays the server sends,
 * so if the server declines for something this build has no name for, the user
 * is told rather than left pressing a button that silently does nothing.
 */

// What the page may promise BEFORE the reset runs; the outcome afterwards is
// read from the API's own receipt. See lib/faucetReceipt.
const SPOT_GRANT_PHRASE = creditPhrase(FAUCET_SPOT_GRANT);

/**
 * The refusal as the page presents it: an instruction that names which kind of
 * thing is in the way, derived from the server's structured arrays rather than
 * from its prose. See lib/resetBlockers.ts.
 */
type ResetRefusal = ResetRefusalView;

export default function ResetForm() {
  const router = useRouter();
  const dispatch = useDispatch();
  const { assets } = useSelector((state: any) => state.wallet);
  const { user } = useSelector((state: any) => state.auth);

  const userId = user?._id || user?.userId || "";

  const [usdBalance, setUsdBalance] = useState<number>(0);
  const [confirming, setConfirming] = useState<boolean>(false);
  const [loader, setLoader] = useState<boolean>(false);
  // A toast is gone in three seconds. The outcome of a reset - and, just as
  // importantly, a refusal that tells the user to go and close a position -
  // has to stay on the page.
  const [receipt, setReceipt] = useState<FaucetReceipt | null>(null);
  const [cleared, setCleared] = useState<any>(null);
  const [refusal, setRefusal] = useState<ResetRefusal | null>(null);

  // Fetch balances from Wallet API assets
  useEffect(() => {
    dispatch(getAssetData());
  }, []);

  // Show the last reset receipt again after a reload.
  useEffect(() => {
    const stored = loadReceipts(userId).find((r) => r.kind === "reset");
    setReceipt(stored || null);
  }, [userId]);

  // Update the local balance when assets change. The reset restores the single
  // faucet coin (spotapi controllers/faucet.controller.js FAUCET_COINS).
  useEffect(() => {
    const readSpot = (coin: string) => {
      const asset = assets?.find?.((a: any) => a.coin === coin);
      return asset ? parseFloat(asset.spotBal || 0) : 0;
    };
    setUsdBalance(readSpot("USD"));
  }, [assets]);

  const handleReset = async () => {
    try {
      setLoader(true);
      const result: any = await faucetReset();
      setLoader(false);
      setConfirming(false);

      if (result.data?.success) {
        setRefusal(null);
        const credited: FaucetCredit[] = readCredits(result.data);
        setCleared(result.data.cleared || null);
        if (credited.length > 0) {
          const stored: FaucetReceipt = {
            at: Date.now(),
            kind: "reset",
            headline: result.data.headline || result.data.message,
            credited,
          };
          saveReceipt(userId, stored);
          setReceipt(stored);
        }
        toastAlert(
          "success",
          result.data.message ||
            `Demo account reset — spot wallet set to ${SPOT_GRANT_PHRASE}`,
          "reset"
        );
        // A reset rewrites balances outside any matching engine, so every
        // reading of them is stale the instant it succeeds. Same signal as a
        // claim - see store/Wallet/dataSlice.
        dispatch(refreshWalletBalances());
      } else {
        const message = result.data?.message || "Reset failed";
        const view = describeResetRefusal(result.data, message);
        setRefusal(view);
        toastAlert("error", view.headline, "reset");
      }
    } catch (err: any) {
      setLoader(false);
      setConfirming(false);
      const data = err?.response?.data;
      const errorMsg = data?.error || data?.message || "Reset failed";
      // The 409 refusal is the one message on this page a user has to act on,
      // so it outlives its toast — and it names the blocker by KIND, because
      // the server's own sentence says "close" even when the thing in the way
      // is a resting order that has to be cancelled instead.
      const view = describeResetRefusal(data, errorMsg);
      setRefusal(view);
      toastAlert("error", view.headline, "reset");
    }
  };

  return (
    <>
      {/* Page Header */}
      <div className={`mb-5 ${styles.inner_head_box} ${styles.inner_head_box_small}`}>
        <Container>
          <Row>
            <Col lg={4} className="text-center mx-auto">
              <h5 className={`mb-0 ${styles.inner_head_title}`}>Reset Demo Account</h5>
            </Col>
          </Row>
          <button className={`${styles.primary_btn}`}>
            <label className="mt-1" onClick={() => router.push("/faucet")}>
              Claim Funds
            </label>
          </button>
        </Container>
      </div>

      <Container>
        <Row className="pb-4">
          <Col lg={12} xxl={8}>
            <div className={`p-4 ${styles.box}`}>
              {/* Balance Display */}
              <div className="mb-4">
                <p style={{ color: '#c8c8c8', fontSize: '14px' }}>Current Spot Balance</p>
                <h3 style={{ color: '#1d94ff', fontSize: '32px', fontWeight: '600' }}>
                  {usdBalance.toFixed(2)} USD
                </h3>
              </div>

              <div className={`mb-4 ${styles.step_flx}`}>
                <div className={styles.num}>
                  <i className="fa fa-rotate-left"></i>
                </div>
                <div className={styles.right_box}>
                  <p style={{ color: '#1d94ff' }}>
                    <strong>Reset your demo account</strong>
                  </p>
                  <span className={styles.sm}>
                    Resetting restores a fresh demo account: your spot wallet is
                    set to {SPOT_GRANT_PHRASE} and any BTC sitting in your spot
                    wallet is set to 0. Cancel your resting spot orders first: reset is
                    refused while any of them is still in the book. This cannot
                    be undone.
                  </span>
                </div>
              </div>

              {/* The refusal, kept on the page: it is the one message here a
                  user has to act on, and it used to vanish with its toast. */}
              {refusal && (
                <Alert
                  variant="warning"
                  className="mb-4"
                  data-testid="reset-refusal"
                  role="status"
                  style={{
                    background: 'rgba(255, 193, 7, 0.1)',
                    border: '1px solid rgba(255, 193, 7, 0.3)',
                    color: '#ffc107'
                  }}
                >
                  <i className="fa fa-exclamation-triangle me-2"></i>
                  <span data-testid="reset-refusal-headline">
                    {refusal.headline}
                  </span>
                  {refusal.groups.map((group) => (
                    <div
                      className="mt-2"
                      key={group.kind}
                      data-testid={`reset-blocker-${group.kind}`}
                    >
                      <strong>{group.instruction}:</strong>
                      <ul className="mb-0">
                        {group.items.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </Alert>
              )}

              {/* The receipt, kept on the page for the same reason. */}
              {receipt && receipt.credited.length > 0 && (
                <div
                  className="mb-4 p-3 rounded"
                  data-testid="reset-receipt"
                  style={{
                    background: 'rgba(25, 135, 84, 0.1)',
                    border: '1px solid rgba(25, 135, 84, 0.35)'
                  }}
                >
                  <p className="mb-2" style={{ color: '#4ade80' }}>
                    <i className="fa fa-check-circle me-2"></i>
                    Last reset restored
                  </p>
                  {groupCreditsByWallet(receipt.credited).map((group) => (
                    <div key={group.wallet} className="mb-1">
                      <span className={styles.sm}>{group.label}: </span>
                      <span style={{ color: '#c8c8c8' }}>
                        {group.credits
                          .map((c) => `${formatCreditAmount(c.amount)} ${c.coin}`)
                          .join(" + ")}
                      </span>
                    </div>
                  ))}
                  {cleared && (
                    <div className="mt-2" style={{ color: '#c8c8c8' }}>
                      <span className={styles.sm}>Cleared: </span>
                      {/* A reset can only run on an account with nothing
                          resting, so this is always "none" - the server sends
                          cancelledSpotOrders: 0 and the branch above it is now
                          unreachable. Both are kept because an older server
                          would still send a non-zero count. */}
                      {Number(cleared.cancelledSpotOrders) > 0
                        ? `${cleared.cancelledSpotOrders} open spot order${
                            Number(cleared.cancelledSpotOrders) === 1 ? "" : "s"
                          } cancelled`
                        : "no spot orders were resting"}
                      {Array.isArray(cleared.zeroedCoins) &&
                        cleared.zeroedCoins.length > 0 &&
                        `, ${cleared.zeroedCoins.join(", ")} set to 0`}
                      .
                    </div>
                  )}
                </div>
              )}

              {confirming ? (
                <>
                  <Alert variant="warning" className="mb-4" style={{
                    background: 'rgba(255, 193, 7, 0.1)',
                    border: '1px solid rgba(255, 193, 7, 0.3)',
                    color: '#ffc107'
                  }}>
                    <i className="fa fa-exclamation-triangle me-2"></i>
                    {/* THE CONFIRM STEP DESCRIBES WHAT THE RESET NOW DOES.
                        It said the reset would "cancel every open spot order".
                        The reset no longer cancels anything: cancelling a
                        resting order refunds its reservation, and a refund
                        landing on top of the fixed balances the reset writes is
                        how an account went 10,000 -> 48,039.52. spotapi now
                        REFUSES the reset while anything is resting, and the
                        page's own refusal panel names what is in the way. So
                        the last thing the user reads before pressing Confirm
                        promised a behaviour that had been deleted - and one
                        that would have quietly disposed of their orders. */}
                    <span data-testid="reset-confirm-warning">
                      This will set your spot wallet to {SPOT_GRANT_PHRASE} and
                      set every other coin balance to 0. Nothing is cancelled or
                      closed for you: if any spot order is still resting, the
                      reset is refused and nothing changes.
                      This cannot be undone. Continue?
                    </span>
                  </Alert>
                  <Row>
                    <Col xs={6}>
                      <button
                        className={`w-100 ${styles.primary_btn}`}
                        onClick={handleReset}
                        disabled={loader}
                      >
                        <label>
                          {loader ? (
                            <i className="fa fa-spinner fa-spin"></i>
                          ) : (
                            "Confirm Reset"
                          )}
                        </label>
                      </button>
                    </Col>
                    <Col xs={6}>
                      <button
                        className={`w-100 ${styles.primary_btn}`}
                        onClick={() => setConfirming(false)}
                        disabled={loader}
                      >
                        <label>Cancel</label>
                      </button>
                    </Col>
                  </Row>
                </>
              ) : (
                <button
                  className={`w-100 ${styles.primary_btn}`}
                  onClick={() => {
                    setRefusal(null);
                    setConfirming(true);
                  }}
                >
                  <label>Reset Demo Account</label>
                </button>
              )}
            </div>
          </Col>

          {/* Right Sidebar - Instructions */}
          <Col lg={12} xxl={4}>
            <div className={`p-4 ${styles.box}`}>
              <p className="mb-4" style={{ color: '#1d94ff' }}>About Reset</p>
              <ul>
                <li className="mb-3">
                  <span style={{ color: '#c8c8c8' }}>
                    Your spot wallet is set back to {SPOT_GRANT_PHRASE}.
                  </span>
                </li>
                <li className="mb-3">
                  <span style={{ color: '#c8c8c8' }}>
                    Any BTC you bought on the spot market is set to 0.
                  </span>
                </li>
                {/* Names the blocker as the ACTION it needs: a resting order is
                    cancelled from the Open Orders panel. The old wording
                    justified the refusal in terms of "a live position", which
                    sent a user whose only blocker was a resting order looking
                    for a position they did not have. */}
                <li className="mb-3">
                  <span style={{ color: '#c8c8c8' }}>
                    Reset is refused while any spot order is still resting.
                    Cancel it from Open Orders first. A reset writes fixed
                    balances, and a cancelled order's reservation would be paid
                    back on top of them, so the reset declines instead of
                    running.
                  </span>
                </li>
                <li>
                  <span style={{ color: '#c8c8c8' }}>
                    This is a paper trading platform — no real money is withdrawn
                    or moved.
                  </span>
                </li>
              </ul>
            </div>
          </Col>
        </Row>
      </Container>
    </>
  );
}
