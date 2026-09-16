import Image from "next/image";
import React, { useState, useEffect } from "react";
import styles from "@/styles/common.module.css";
import { Container, Dropdown, Navbar, Nav, Offcanvas } from "react-bootstrap";
import { useRouter } from "next/router";
//improt store
import { useDispatch, useSelector } from "../store";
import { setUserSetting } from "../store/UserSetting/dataSlice";
import { onSignOutSuccess } from "../store/auth/sessionSlice";
import { setUser, initialState } from "../store/auth/userSlice";
//improt lib
import { toastAlert } from "@/lib/toastAlert";
import isEmpty from "@/lib/isEmpty";
import { truncateDecimals } from "@/lib/roundOf";
import { createSocketUser } from "@/config/socketConnectivity";
import { clearClientSession } from "@/utils/clearSession";
import Link from "next/link";
import {
  walletTotals,
  roundedTotals,
  TOTAL_ASSETS_LABEL,
} from "@/lib/walletTotals";
//import component

/**
 * TWO "TOTAL ASSETS VALUE" FIGURES MUST NOT DISAGREE.
 *
 * On /wallet the headline and this dropdown were on screen at the same moment,
 * both captioned "Total Assets Value", and they differed — 57701.32 vs 57385.36
 * against the running stack. Two causes, both here:
 *
 *   1. USDC took a private branch that read `spotBal` ALONE and then `return`ed
 *      before the shared summing path, so an entire wallet's USDC balance was
 *      missing from the navbar total. That is the "differs by exactly one
 *      wallet balance" the report describes.
 *   2. The same branch counted USDC at 1.00 rather than at its published
 *      USD rate (1.00082), so 19699.79 USDC was 16.16 USD light as well.
 *
 * Both figures now come from lib/walletTotals — the same module, the same
 * buckets, the same quote coin and the same round-then-sum rule the /wallet
 * headline uses — so they cannot drift apart again by editing one of them.
 */
// Paper trading quotes everything in USD; priceConversion publishes no USDT
// rows. Must match components/Wallet/WalletList.tsx.
const QUOTE_COIN = "USD";
// The caption itself lives in lib/walletTotals beside the computation, so this
// and the /wallet headline cannot be re-worded independently.

export default function Mainnavbar() {
  const history = useRouter();
  const [scrollClassName, setScrollClassName] = useState("");
  const [isClient, setIsClient] = useState(false);
  const { session, user } = useSelector((state: any) => state.auth);
  const { assets, currency, priceConversion } = useSelector(
    (state: any) => state.wallet
  );
  const [showOnramp, setShowOnramp] = useState(false);
  const [totalBTC, setTotalBTC] = useState<number>(0);
  const [totalUSD, setTotalUSD] = useState<number>(0);
  const dispatch = useDispatch();
  const handleShowOnramp = () => setShowOnramp(true);
  const closeOnramp = () => setShowOnramp(false);

  useEffect(() => {
    const handleScroll = () => {
      if (window.scrollY > 40) {
        setScrollClassName("scrolled");
      } else {
        setScrollClassName("");
      }
    };
    setIsClient(true);

    window.addEventListener("scroll", handleScroll);

    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);
  useEffect(() => {
    window.addEventListener("online", () => {
      if (user && user._id) {
        // Re-join when the browser reports it is back online. The nested
        // `spotSocket.on("reconnect", ...)` that used to follow was dead - it is
        // a MANAGER event in socket.io-client v4, not a Socket event - and
        // redundant, since config/socketConnectivity.js re-joins on every
        // "connect". Its cleanup was also unreachable: a `return` inside an
        // addEventListener callback is not a React effect teardown.
        createSocketUser(user._id);
      }
    });
    window.addEventListener("offline", () => { });
  }, []);
  const handleLogout = () => {
    // Clears user + authToken localStorage AND the userToken/loggedin cookies -
    // the button used to leave the userToken cookie and authToken behind, so the
    // Wallet/Spot/User API clients kept re-attaching the still-valid JWT after
    // "logout" (session never terminated; token lingered on disk for a year).
    clearClientSession();
    dispatch(setUser(initialState));
    dispatch(onSignOutSuccess());
    dispatch(setUserSetting({}));
    toastAlert("success", "Logout successfully", "logout");
    history.push("/login");
  };
  const handleAsset = () => {
    // ONE COMPUTATION, SHARED WITH /wallet. No per-coin special cases: USDC used
    // to get its own branch that read spotBal alone at a 1:1 rate, which hid a
    // whole wallet from this figure and undercounted USDC besides.
    const priceOf = (coin: string) =>
      priceConversion?.find(
        (el: any) => el.baseSymbol == coin && el.convertSymbol == QUOTE_COIN
      )?.convertPrice;
    const totals = walletTotals(assets, priceOf);
    // Rounded per wallet then summed, exactly as the /wallet headline does, so
    // the two figures are equal to the cent and not merely close.
    const shown = roundedTotals(totals.byBucket, 2);
    setTotalUSD(shown.total);

    // Convert the USD total to BTC. convertPrice is BTC-per-USD, so multiply.
    let btcPrice = priceConversion?.find(
      (el: any) => el.baseSymbol == QUOTE_COIN && el.convertSymbol == "BTC"
    );
    if (!isEmpty(btcPrice) && !isEmpty(btcPrice.convertPrice)) {
      // From the PRINTED total, as /wallet does, so the BTC figure and the USD
      // figure beside it are the same quantity expressed twice.
      setTotalBTC(shown.total * parseFloat(btcPrice.convertPrice));
    } else {
      setTotalBTC(0);
    }
  };
  const copyToClipboard = (text: string) => {
    const tempInput = document.createElement("input");
    tempInput.value = text;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand("copy");
    document.body.removeChild(tempInput);
    toastAlert("success", "Copied", "copy");
  };

  useEffect(() => {
    if (session?.signedIn) {
      handleAsset();
    }
  }, [assets, currency, priceConversion]);

  return (
    <>
      <Navbar expand="lg" className={`main_navbar fixed ${scrollClassName}`}>
        {/* Desktop Layout - Three Sections */}
        <div className="navbar-content d-none d-lg-flex">
          {/* Left: Nav Links */}
          <div className="navbar-left">
            <Link href="/spot" className="navbar-link">Spot</Link>
          </div>

          {/* Center: Logo - Perfectly Centered */}
          <div className="navbar-center">
            <Navbar.Brand>
              <Link href={session?.signedIn ? "/wallet" : "/"}>
                <img
                  src="/assets/images/cryptodex-logo.svg"
                  alt="Cryptodex"
                  width={140}
                  height={22}
                />
              </Link>
            </Navbar.Brand>
          </div>

          {/* Right: Auth/Profile */}
          <div className="navbar-right">
            {session?.signedIn && isClient && (
              <div className="navbar-icons">
                {/* Profile Dropdown */}
                <Dropdown autoClose="outside" align="end">
                  <Dropdown.Toggle variant="" id="dropdown-basic" className="navbar-profile-toggle">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                      <circle cx="12" cy="7" r="4"></circle>
                    </svg>
                  </Dropdown.Toggle>
                  <Dropdown.Menu>
                    <Dropdown.ItemText className="grey border-bottom px-0">
                      <span className="d-flex gap-1 align-items-center">
                        UID:
                        <span className="copy px-0">
                          {user?.userId}{" "}
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            onClick={() => copyToClipboard(user?.userId)}
                            style={{ cursor: "pointer", marginLeft: "4px", opacity: 0.6 }}
                          >
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                          </svg>
                        </span>
                      </span>
                    </Dropdown.ItemText>
                    <Dropdown.ItemText className="grey border-bottom px-0 drop-balance">
                      <span
                        className="d-block balanceTitle"
                        data-testid="navbar-total-assets-label"
                      >
                        {TOTAL_ASSETS_LABEL}
                      </span>
                      {/* An eye toggled this figure to "*****". Hiding a
                          balance is for shoulder-surfers on an exchange holding
                          real money; this one holds virtual funds a faucet
                          hands out on request, so the control protected
                          nothing and cost a row of chrome. */}
                      <div className="balance-card">
                        <span data-testid="navbar-total-assets-value">
                          {`${truncateDecimals(totalUSD, 2)} ${QUOTE_COIN}`}
                        </span>
                      </div>
                    </Dropdown.ItemText>
                    <div className="dropdownmenu_scroll">
                      <Dropdown.Item href="#" onClick={() => history.push("/spot")}>Spot Trade</Dropdown.Item>
                      <Dropdown.Item href="#" onClick={() => history.push("/security")}>Account & Security</Dropdown.Item>
                      <Dropdown.Item href="#" onClick={() => history.push("/history")}>My History</Dropdown.Item>
                      {/* "Support Ticket" pointed at /support-ticket, whose
                          four user/support calls and user/getSupportCategory
                          are gone. A menu entry that lands on a 404 is the one
                          thing worse than having no support desk. */}
                      <Dropdown.Item href="#" onClick={() => handleLogout()}>Log out</Dropdown.Item>
                    </div>
                  </Dropdown.Menu>
                </Dropdown>
              </div>
            )}
            {!session?.signedIn && isClient && (
              <div className="navbar_btns">
                <Link href="/login" className="navbar-link">Login</Link>
                <Link href="/register" className="navbar-link navbar-link-register">Register</Link>
              </div>
            )}
          </div>
        </div>

        {/* Mobile Layout - Original Bootstrap Navbar */}
        <Container>
          <Navbar.Brand>
            <Link href={session?.signedIn ? "/wallet" : "/"}>
              <img
                src="/assets/images/cryptodex-logo.svg"
                alt="image"
                className="img-fluid"
                width={140}
                height={32}
              />
            </Link>
          </Navbar.Brand>
          {history.asPath !== "/login" && history.asPath !== "/register" && (
            <div className="navbar_switch_mobile">
              <Navbar.Toggle aria-controls={`offcanvasNavbar-expand-lg`} />
            </div>
          )}
          <Navbar.Offcanvas
            id={`offcanvasNavbar-expand-lg`}
            placement="end"
            className="offcan_custom"
          >
            <Offcanvas.Header closeButton className="justify-content-end"></Offcanvas.Header>
            <Offcanvas.Body>
              <Nav className="justify-content-center flex-grow-1">
                {session?.signedIn && isClient && (
                  <>
                    {/* The unverified branch used to print `user.phoneNo`.
                        There is no phone on this venue and never a value in
                        that field, so it rendered an empty row; an account is
                        identified by the address it registered with either
                        way. */}
                    <Nav.Link href="#" className="grey d-lg-none">{user?.email}</Nav.Link>
                    <Nav.Item className="grey d-lg-none border-bottom w-100 py-2 my-2">
                      <span className="d-flex gap-1 align-items-center">
                        UID:
                        <span className="copy px-0">
                          {user?.userId}{" "}
                          <Image
                            src="/assets/images/copy.png"
                            alt="copy"
                            width={16}
                            height={20}
                            onClick={() => copyToClipboard(user?.userId)}
                          />
                        </span>
                      </span>
                    </Nav.Item>
                    <Nav.Item className="grey d-lg-none border-bottom w-100 block-span py-2 mb-2">
                      <span className="d-block">{TOTAL_ASSETS_LABEL}</span>
                      {/* One figure, one unit. The same number was printed
                          twice, once as "57385.36 USD" and once as "$57385.36",
                          which reads as two quantities that happen to match. */}
                      <span>
                        {`${truncateDecimals(totalUSD, 2)} ${QUOTE_COIN}`}
                      </span>
                    </Nav.Item>
                  </>
                )}
                <Nav.Link href="/spot">Spot</Nav.Link>
                {session?.signedIn && isClient && (
                  <Nav.Link href="/wallet">Wallet</Nav.Link>
                )}
                {session?.signedIn && isClient && (
                  <>
                    <Nav.Link href="/security" className="nav-link d-lg-none">Account & Security</Nav.Link>
                    <Nav.Link href="/history" className="nav-link d-lg-none">My History</Nav.Link>
                    <Nav.Link href="#" onClick={() => handleLogout()} className="nav-link d-lg-none">Log Out</Nav.Link>
                  </>
                )}
              </Nav>
              {!session?.signedIn && isClient && (
                <Nav className="justify-content-center flex-grow-1">
                  <Nav.Link href="/login" className="nav-link d-lg-none">Login</Nav.Link>
                  <Nav.Link href="/register" className="nav-link d-lg-none">Register</Nav.Link>
                </Nav>
              )}
            </Offcanvas.Body>
          </Navbar.Offcanvas>
        </Container>
      </Navbar>
    </>
  );
}
