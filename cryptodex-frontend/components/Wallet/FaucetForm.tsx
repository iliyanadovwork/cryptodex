import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import styles from "@/styles/common.module.css";
import {
  Container,
  Row,
  Col,
} from "react-bootstrap";
import { useSelector } from "../../store";
import { useDispatch } from "react-redux";
import { toastAlert } from "@/lib/toastAlert";
import { faucetClaim, faucetStatus } from "../../services/Wallet/WalletService";
import { getAssetData, refreshWalletBalances } from "../../store/Wallet/dataSlice";
import DepositHistory from "./DepositHistory";
import {
  FAUCET_SPOT_GRANT,
  creditPhrase,
  formatCreditAmount,
  groupCreditsByWallet,
  loadReceipts,
  readCredits,
  saveReceipt,
  walletLabel,
  FaucetReceipt,
} from "@/lib/faucetReceipt";

// What the page may promise BEFORE a claim. The claim itself is described by
// the API's own receipt, never by these. See lib/faucetReceipt.
const SPOT_GRANT_PHRASE = creditPhrase(FAUCET_SPOT_GRANT);

/**
 * The wait as a clock. `formatRetryAfter` rounds to whole minutes, which reads
 * as "1m" for the last sixty seconds and never reaches zero; a countdown the
 * user is watching has to show seconds at the end of it.
 */
export const formatCountdown = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}h ${pad(m)}m` : m > 0 ? `${m}m ${pad(sec)}s` : `${sec}s`;
};

export default function FaucetForm() {
  const router = useRouter();
  const dispatch = useDispatch();
  const { user } = useSelector((state: any) => state.auth);
  const { assets } = useSelector((state: any) => state.wallet);

  const userId = user?._id || user?.userId || "";

  const [claiming, setClaiming] = useState<boolean>(false);
  const [balance, setBalance] = useState<number>(0);
  const [usdBalance, setUsdBalance] = useState<number>(0);
  const [cooldown, setCooldown] = useState<string>("");
  // Seconds until this account may claim again, as the server reports it.
  // `null` means "not asked yet"; 0 means "claimable now".
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  // The claim's outcome has to outlive its toast, so the last receipt is kept
  // on the page (and across reloads).
  const [receipts, setReceipts] = useState<FaucetReceipt[]>([]);
  const [claimCount, setClaimCount] = useState<number>(0);
  // The newest CLAIM receipt, not the newest receipt of any kind. loadReceipts
  // returns claims and resets together, newest-first; taking receipts[0] blindly
  // let a reset performed after the last claim render under the "Last claim
  // credited" panel, asserting the user had CLAIMED funds they had actually
  // reset. The guard below hides the panel when there is no claim yet.
  const latestReceipt = receipts.find((r) => r.kind === "claim");

  useEffect(() => {
    setReceipts(loadReceipts(userId));
  }, [userId]);

  // Fetch fresh assets on mount
  useEffect(() => {
    dispatch(getAssetData());
    refreshCooldown();
  }, []);

  // Count the wait down in place, so a user watching the page sees it shrink
  // rather than a figure that silently goes stale. One interval, cleared when
  // it reaches zero or the component goes away.
  useEffect(() => {
    if (retryAfter === null || retryAfter <= 0) return;
    const id = setInterval(() => {
      setRetryAfter((s) => (s === null ? null : Math.max(0, s - 1)));
    }, 1000);
    return () => clearInterval(id);
  }, [retryAfter === null || retryAfter <= 0]);

  // Update the local balance when assets change. The faucet credits USD alone
  // (spotapi controllers/faucet.controller.js FAUCET_COINS) - it is the quote
  // currency of the venue's only market, and so the only balance an order can
  // be placed against.
  useEffect(() => {
    const readSpot = (coin: string) => {
      const asset = assets?.find?.((a: any) => a.coin === coin);
      return asset ? parseFloat(asset.spotBal || 0) : 0;
    };
    setUsdBalance(readSpot("USD"));
  }, [assets]);

  // Turn the faucet's `retryAfter` (seconds) into something a user can act on.
  const formatRetryAfter = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.ceil((seconds % 3600) / 60);
    if (hours > 0) {
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    return `${Math.max(minutes, 1)}m`;
  };

  /**
   * THE COOLDOWN IS A PRODUCT RULE, SO THE PAGE STATES IT.
   * =====================================================
   *
   * The 24h cooldown is not protection the user asked us to drop - it is how
   * the demo faucet works. But the page had no way to ask about it, so the
   * button stayed live for the whole day and the user learned the rule by
   * pressing it and being handed a red error toast for behaving exactly as
   * designed. spotapi now answers GET /api/spot/faucet/status with the TTL it
   * would have put in the 429, so the wait can be shown BEFORE the click.
   *
   * A failure to read it deliberately leaves the button ENABLED: not knowing
   * the cooldown must not become a reason to refuse a claim the server would
   * have allowed.
   */
  const refreshCooldown = async () => {
    try {
      const result: any = await faucetStatus();
      const seconds = Number(result?.data?.retryAfter);
      if (result?.data?.success && Number.isFinite(seconds) && seconds > 0) {
        setRetryAfter(seconds);
      } else {
        setRetryAfter(0);
        setCooldown("");
      }
    } catch (err) {
      setRetryAfter(null);
    }
  };

  const handleClaim = async () => {
    try {
      setClaiming(true);
      const result: any = await faucetClaim();
      setClaiming(false);

      if (result.data?.success) {
        setCooldown("");
        // A successful claim starts a fresh cooldown; ask the server what it is
        // rather than assuming the full 24h.
        refreshCooldown();
        // EVERY credit the API reported, whatever wallets it names, kept on
        // the page. Read from the response rather than from the constants
        // above, so a credit this build does not know about is still shown.
        const credited = readCredits(result.data);
        if (credited.length > 0) {
          setReceipts(
            saveReceipt(userId, {
              at: Date.now(),
              kind: "claim",
              signature: result.data.signature,
              headline: result.data.headline || result.data.message,
              credited,
            })
          );
        }
        setClaimCount((n) => n + 1);
        toastAlert(
          "success",
          result.data.message ||
            `${SPOT_GRANT_PHRASE} credited to your spot wallet`,
          "faucet"
        );
        // A claim moves a balance without going through the matching engine,
        // so it re-reads the asset rows and raises the "balances moved" signal.
        // Keeps the rule "every wallet mutation this app performs refreshes
        // what is on screen" true, rather than relying on this page happening
        // not to be the trade page.
        dispatch(refreshWalletBalances());
      } else {
        toastAlert("error", result.data?.message || "Claim failed", "faucet");
      }
    } catch (err: any) {
      setClaiming(false);
      const data = err?.response?.data;
      const wait = formatRetryAfter(Number(data?.retryAfter));
      const baseMsg =
        data?.error ||
        data?.message ||
        "Claim failed. You can claim demo funds once every 24 hours.";
      const errorMsg = wait ? `${baseMsg} (try again in ${wait})` : baseMsg;
      // Keep the cooldown on the page: a toast disappears after a few seconds.
      setCooldown(errorMsg);
      const seconds = Number(data?.retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        setRetryAfter(seconds);
      } else {
        refreshCooldown();
      }
      toastAlert("error", errorMsg, "faucet");
    }
  };

  // `waiting` is only ever true on a POSITIVE server-reported wait: `null`
  // (never asked, or the ask failed) leaves the button live.
  const waiting = retryAfter !== null && retryAfter > 0;
  const countdown = formatCountdown(retryAfter || 0);

  return (
    <>
      {/* Page Header */}
      <div className={`mb-5 ${styles.inner_head_box} ${styles.inner_head_box_small}`}>
        <Container>
          <Row>
            <Col lg={4} className="text-center mx-auto">
              <h5 className={`mb-0 ${styles.inner_head_title}`}>Claim Demo Funds</h5>
            </Col>
          </Row>
          <button className={`${styles.primary_btn}`}>
            <label className="mt-1" onClick={() => router.push("/reset")}>
              Reset Account
            </label>
          </button>
        </Container>
      </div>

      <Container>
        <Row className="pb-4">
          <Col lg={12} xxl={8}>
            {/* Demo Funds Card */}
            <div className={`mb-4 ${styles.box}`}>
              <div className={styles.step_flx}>
                <div className={styles.num}>
                  <i className="fa fa-coins" style={{ fontSize: '24px' }}></i>
                </div>
                <div className={`w-100 ${styles.right_box}`}>
                  <p className={"mb-3"}>
                    <strong>Claim Demo Funds — spot wallet</strong>
                    <span className="badge bg-success ms-2">Paper Trading</span>
                  </p>
                  {/* Balance Display */}
                  <div className={`mb-3 p-3 rounded bg-dark bg-opacity-25 d-flex justify-content-between align-items-center`}>
                    <div>
                      <span className={styles.sm}>Your Spot Balance:</span>
                      <h3 className="mb-0 text-success">
                        {usdBalance.toFixed(4)} <span className="fs-6">USD</span>
                      </h3>
                    </div>
                    <button
                      className={`btn btn-sm btn-outline-success ${styles.primary_btn}`}
                      onClick={() => dispatch(getAssetData())}
                    >
                      <i className="fa fa-refresh"></i>
                    </button>
                  </div>
                  <span className={`mb-3 d-block ${styles.sm}`}>
                    This is a paper trading platform. Demo funds are virtual and
                    have no real-world value. Each claim credits{" "}
                    <strong>{SPOT_GRANT_PHRASE}</strong> to your spot wallet.
                    The faucet may be claimed once every 24 hours.
                  </span>

                  {/* The receipt: what the LAST claim actually credited, as the
                      API reported it. A toast is gone in three seconds; this
                      survives the toast and a page reload. */}
                  {latestReceipt && latestReceipt.credited.length > 0 && (
                    <div
                      className="mb-3 p-3 rounded"
                      data-testid="claim-receipt"
                      style={{
                        background: "rgba(25, 135, 84, 0.1)",
                        border: "1px solid rgba(25, 135, 84, 0.35)",
                      }}
                    >
                      <p className="mb-2" style={{ color: "#4ade80" }}>
                        <i className="fa fa-check-circle me-2"></i>
                        Last claim credited
                      </p>
                      {groupCreditsByWallet(latestReceipt.credited).map(
                        (group) => (
                          <div key={group.wallet} className="mb-1">
                            <span className={styles.sm}>{group.label}: </span>
                            <span style={{ color: "#c8c8c8" }}>
                              {group.credits
                                .map(
                                  (c) =>
                                    `${formatCreditAmount(c.amount)} ${c.coin}`
                                )
                                .join(" + ")}
                            </span>
                          </div>
                        )
                      )}
                    </div>
                  )}

                  {cooldown && (
                    <div
                      className="mb-3 p-3 rounded"
                      role="status"
                      style={{
                        background: "rgba(255, 193, 7, 0.1)",
                        border: "1px solid rgba(255, 193, 7, 0.3)",
                        color: "#ffc107",
                      }}
                    >
                      <i className="fa fa-clock-o me-2"></i>
                      {cooldown}
                    </div>
                  )}

                  {!user?._id && !user?.userId ? (
                    <div className="text-center py-5">
                      <i className="fa fa-user-lock mb-3" style={{ fontSize: "48px", color: "#6c757d" }}></i>
                      <h5>Please Log In</h5>
                      <p className="text-muted mb-4">
                        You need to be logged in to claim demo funds.
                      </p>
                      <button
                        className={`${styles.primary_btn} px-4`}
                        onClick={() => router.push("/login")}
                      >
                        Go to Login
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        className={`w-100 ${styles.primary_btn}`}
                        onClick={handleClaim}
                        data-testid="faucet-claim-button"
                        disabled={claiming || waiting}
                      >
                        <label>
                          {claiming ? (
                            <i className="fa fa-spinner fa-spin"></i>
                          ) : waiting ? (
                            `Next claim in ${countdown}`
                          ) : (
                            `Claim ${SPOT_GRANT_PHRASE}`
                          )}
                        </label>
                      </button>
                      {waiting && (
                        <p className="mt-3 mb-0" data-testid="faucet-cooldown">
                          Demo funds can be claimed once every 24 hours. You can
                          claim again in {countdown}.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </Col>

          {/* Right Sidebar - About Demo Funds */}
          <Col lg={12} xxl={4}>
            <div className={`p-4 ${styles.box}`}>
              <p className="mb-4">About Demo Funds</p>
              <ul>
                <li className="mb-3">
                  <span>
                    {SPOT_GRANT_PHRASE} are credited instantly to your{" "}
                    <strong>spot wallet</strong>. BTCUSD settles in USD, so both
                    coins are needed to trade it.
                  </span>
                </li>
                <li className="mb-3">
                  <span>
                    Spot is the only product this venue lists, so the spot
                    wallet is the only wallet you need to fund. Anything the
                    server credits beyond the two coins above is listed in the
                    receipt after the claim, and in the demo credit history
                    below - one row per coin, kept on the server, so it is the
                    same list on every device you sign in from.
                  </span>
                </li>
                <li className="mb-3">
                  <span>
                    You can claim once every 24 hours.
                  </span>
                </li>
                <li>
                  <span>
                    All balances, orders and trades on this platform are virtual —
                    no real money is involved.
                  </span>
                </li>
              </ul>
            </div>
          </Col>
        </Row>

        {/* Demo Credit History */}
        <div className={`mb-4 ${styles.deposit_table_flx}`}>
          <h5 className={`mb-0 ${styles.h5tag}`}>Demo credit history</h5>
        </div>

        <div className={styles.asset}>
          <div className={styles.asset_table}>
            {/* Every leg of a claim is a server-side deposit row, so this
                reads the whole claim straight from the API. It used to be
                handed the local receipts to reconstruct legs the server did not
                record, which made them visible only in the browser that
                claimed them. */}
            <DepositHistory refreshKey={claimCount} />
            {/* A "View More" link pointed at /history?type=deposit. That
                tab rendered this same table, paginated the same way, so it
                showed nothing more - and the tab is gone. This table pages
                through the whole history where it stands. */}
          </div>
        </div>
      </Container>
    </>
  );
}
