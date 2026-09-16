// Import Swiper styles
// import "bootstrap/dist/css/bootstrap.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import "slick-carousel/slick/slick.css";
import "slick-carousel/slick/slick-theme.css";
import "../styles/globals.css";
import { Provider } from "react-redux";
import { PersistGate } from "redux-persist/integration/react";
import store, { persistor, useDispatch } from "../store";
import { useEffect, useState } from "react";
import { ToastContainer } from "react-toastify";
import { NextPage } from "next";
import { AppProps } from "next/app";
import Router, { useRouter } from "next/router";
import SocketContext from "../components/Context/SocketContext";
import { IdleTimerProvider } from 'react-idle-timer';

import { spotSocket } from "../config/socketConnectivity";
import config from "../config";
import { createSocketUser } from "../config/socketConnectivity";
import Head from "next/head";
//import component
import HelperRoute from "../components/HelperRoute";
import { initialState, setUser } from "@/store/auth/userSlice";
import { clearClientSession } from "@/utils/clearSession";
import { onSignOutSuccess } from "@/store/auth/sessionSlice";
import { setUserSetting } from "@/store/UserSetting/dataSlice";
import { toastAlert } from "@/lib/toastAlert";

import { removeAuthToken } from '@/lib/localStorage'
import { removeAuthorization } from '@/config/axios'
import { GoogleReCaptchaProvider } from 'react-google-recaptcha-v3'
import PaperTradingBanner from "../components/PaperTradingBanner";
import { recaptchaEnabledHere } from "@/lib/recaptcha";



const App: NextPage<AppProps> = ({ Component, pageProps }) => {
  // No idleTimer ref here: IdleTimerProvider is a plain function component and
  // does not forward refs, so `ref={idleTimer}` produced React's "Function
  // components cannot be given refs" warning on EVERY page load, and the ref
  // itself was never read anywhere. The timer is configured entirely by the
  // props below (timeout / onIdle / debounce).
  // const dispatch = useDispatch()
  const history = useRouter();
  const [Loader, setLoader] = useState<boolean>(false);
  const [isMounted, setIsMounted] = useState<boolean>(false);

  const isMaintenanceMode = true;

  /**
   * MOUNT reCAPTCHA ONLY WHERE IT CAN WORK.
   *
   * The provider injects Google's v3 script, which renders a badge in the
   * bottom-right of every page. A site key registered for the production domain
   * refuses a `localhost` origin, so on this stack that badge was not a badge:
   * it was a red error card reading "Localhost is not supported by this site
   * key.", burned into the corner of the login screen, the wallet and every
   * trade screen. Permanently. Looking exactly like a broken app.
   *
   * The backend already stopped checking here (userapi auth.controller.js:
   * "reCaptcha DISABLED for local testing"), so nothing was reading the token
   * the widget produced either.
   *
   * Resolved after mount, never during render: the first client render has to
   * match the server's HTML or React tears the tree down and rebuilds it, and
   * the server has no hostname to check. Starting `false` means the very first
   * paint carries no badge, which is also the state a local run stays in.
   */
  const [recaptchaEnabled, setRecaptchaEnabled] = useState<boolean>(false);

  // Prevent hydration mismatch
  useEffect(() => {
    setIsMounted(true);
    setRecaptchaEnabled(recaptchaEnabledHere());
  }, []);

  Router.events.on("routeChangeStart", () => {
    setLoader(true);
  });

  Router.events.on("routeChangeComplete", () => {
    setLoader(false);
  });
  Router.events.on("routeChangeError", () => setLoader(false));

  useEffect(() => {
    typeof document !== undefined
      ? require("bootstrap/dist/js/bootstrap.bundle.min")
      : null;
    // Always set dark theme
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", "dark_theme");
    }
  }, []);
  const { user } = store.getState().auth;
  // useEffect(() => {
  //   const { user } = store.getState().auth;
  //   if (user && user._id) createSocketUser(user._id);
  // }, []);

  const handleOnIdle = () => {
    console.log('User is idle');
    if (config.MODE !== "local") {
      handleLogout()
    }
    // Call the logout function when the user becomes idle
  };
  const handleLogout = () => {
    if (!localStorage.getItem("user")) {
      return
    }
    // Same single teardown as the navbar button. The idle path used to clear the
    // user + userToken cookie but leave authToken localStorage, which the Wallet
    // API client reads first ("most reliable") - so a wallet request after an
    // idle logout still went out with a valid JWT. The full reload below re-inits
    // the store from the now-cleared persisted storage.
    clearClientSession();
    window.location.href = '/login'
    return true
  };
  useEffect(() => {
    if (user && user._id) {
      createSocketUser(user._id);
      // A `spotSocket.on("reconnect", ...)` re-join used to sit here. It was
      // dead twice over: `reconnect` is a MANAGER event in socket.io-client v4,
      // so a Socket listener never fires; and re-joining on reconnect is already
      // done centrally by the "connect" handler in config/socketConnectivity.js,
      // which covers the first connection and every reconnect. Its cleanup also
      // called `spotSocket.off("reconnect")` with no handler argument, which
      // removes EVERY listener for that event - so had it ever been wired to the
      // manager, this would have torn down the socket module's own listener too.
    }
  }, [user]);
  useEffect(() => {
    const { user } = store.getState().auth;
    const start = () => setLoader(true);
    const end = () => setLoader(false);
    if (user && user._id) createSocketUser(user._id);
    Router.events.on("routeChangeStart", start);
    Router.events.on("routeChangeComplete", end);
    Router.events.on("routeChangeError", end);
    if (Router.isReady) {
      setLoader(false);
    }
    return () => {
      Router.events.off("routeChangeStart", start);
      Router.events.off("routeChangeComplete", end);
      Router.events.off("routeChangeError", end);
    };
  }, []);

  // if (isMaintenanceMode) {
  //   return (
  //     <div>
  //       <h1>Site Under Maintenance</h1>
  //       <p>We're sorry, but the site is currently undergoing maintenance. Please check back later.</p>
  //     </div>
  //   );
  // }

  const appTree = (
          <Provider store={store}>
            {/* Offset below the fixed navbar and the disclosure strip - see
                .Toastify__toast-container in globals.css. Left at the library's
                default, a toast overlapped the "virtual funds only" line. */}
            <ToastContainer className="toast-below-banner" />
            <HelperRoute />
            <SocketContext.Provider
              value={{ spotSocket } as any}
            >
            {/* THE jQUERY TAG THAT USED TO BE HERE IS GONE.
                =============================================
                It was `<Script strategy="beforeInteractive"
                src="https://code.jquery.com/jquery-1.11.2.min.js">` - an
                unpinned, un-SRI'd third-party script from a fourth origin,
                executed BEFORE hydration, on every page of the app. That
                includes /2fa, which renders the TOTP secret and its otpauth URI
                into the DOM: whoever served that file could read the second
                factor out of the page as it was being enrolled. jQuery 1.11.2
                was published in 2014 and has known XSS issues of its own
                (CVE-2015-9251, CVE-2020-11022/11023).

                Nothing loaded it deliberately. There is not one `$(` or
                `jQuery` reference in pages/, components/, lib/, services/,
                store/ or config/, and the vendored TradingView bundles do not
                use it either (`grep -c jQuery` over the UDF datafeed bundle is
                0). It was a dependency of nothing, costing a blocking
                cross-origin request on every page load, and it is deleted
                rather than pinned: the safest version of a script you do not
                use is no script. */}

            {/* The UDF datafeed bundle is already loaded by pages/_document.tsx
                from its real location, /static/datafeeds/udf/dist/bundle.js.
                The copy that used to sit here pointed at /datafeeds/... which
                does not exist and 404'd on every page load. */}
            <PersistGate persistor={persistor} loading={null}>
              {() => (
                <>
                  <PaperTradingBanner />
                  {!isMounted ? null : Loader ? (
                    <div className="loading-screen middle">
                      <img src="/assets/images/cryptodex-mark.svg" alt="Loading..." className="loading-logo" />
                    </div>
                  ) : (
                    <Component {...pageProps} />
                  )}
                </>
              )}
            </PersistGate>
          </SocketContext.Provider>
        </Provider>
  );

  return (
    <>
      <Head>
        <title>CryptoDex - Crypto Paper Trading Simulator</title>
        <meta
          name="description"
          content="CryptoDex - A crypto paper trading simulator. Practice spot trading on live market data with virtual funds. No deposits, no withdrawals, no custody of real assets."
        />
        <meta
          name="keywords"
          content="CryptoDex, paper trading, crypto paper trading, demo trading account, virtual trading, practice crypto trading, trading simulator, spot trading simulator, learn crypto trading"
        />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"
        />
        <link rel="icon" type="image/svg+xml" href="/assets/images/cryptodex-mark.svg" />
        <link rel="apple-touch-icon" href="/assets/images/cryptodex-mark-180.png" />
        <meta property="og:title" content="CryptoDex - Crypto Paper Trading Simulator" />
        <meta property="og:description" content="Practice crypto trading on live market data with virtual funds only. No deposits, no withdrawals, no real assets." />
        <meta property="og:image" content="/assets/images/cryptodex-og.png" />
        <meta property="og:url" content="https://cryptodex.com" />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="CryptoDex - Crypto Paper Trading Simulator" />
        <meta name="twitter:description" content="Practice crypto trading on live market data with virtual funds only. No deposits, no withdrawals, no real assets." />
        <meta name="twitter:image" content="/assets/images/cryptodex-og.png" />
        {/* SELF-HOSTED, NOT CDN-HOSTED.
            ============================
            These two were `https://cdnjs.cloudflare.com/.../font-awesome/6.4.2/
            css/all.min.css` and `https://cdn.jsdelivr.net/npm/bootstrap@5.3.1/
            .../bootstrap.min.css`, with no `integrity`/`crossOrigin`. A
            stylesheet is not inert: CSS can exfiltrate DOM content through
            attribute selectors and background-image requests, the CDN chooses
            what bytes answer that URL on every load, and one of the pages
            wearing them is /2fa, which puts the TOTP secret and the otpauth URI
            (secret + account email) in the DOM. `@import` inside a CDN
            stylesheet also pulls in further origins that no policy here sees.

            SRI would have pinned the bytes, but not the origin's availability
            or its privacy: every visitor's IP, Referer and page-visit timing
            still goes to a third party on every load, and this is a LOCAL paper
            exchange with no CDN to gain from. Serving the exact same files from
            /vendor removes the origin instead of auditing it.

            The files are copied verbatim from the npm packages that are now
            declared in package.json - @fortawesome/fontawesome-free@6.4.2 (the
            same version the cdnjs URL asked for) and bootstrap@5.3.3 (already a
            dependency; the CDN pinned 5.3.1, a patch behind) - so their
            provenance is a lockfile rather than a URL. See public/vendor/README.

            They stay <link>s in this exact position rather than becoming
            `import` statements at the top of this file: a CDN <link> in
            next/head lands LAST in the cascade, after the app's own stylesheets,
            and an import would land first. Moving them would silently re-order
            every rule the app and bootstrap both define. */}
        {/* Inter + Space Grotesk. These were reached through an
            `@import url("https://fonts.googleapis.com/css2?…")` on line 1 of
            styles/globals.css - two more third-party origins on every page,
            invisible to any inspection of this shell, and only visible when a
            real browser parses the CSS. A <link> here is also faster than the
            @import was: an @import cannot even be discovered until globals.css
            has been downloaded and parsed, and then blocks rendering on its own
            round trip. */}
        <link rel="stylesheet" href="/vendor/fonts/fonts.css" />
        <link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css" />
        <link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css" />
      </Head>
      <IdleTimerProvider
        timeout={1000 * 60 * 30}
        onIdle={handleOnIdle}
        debounce={500}
      >
        {/* The whole app, rendered with the reCAPTCHA provider only where
            that provider can actually work — see recaptchaEnabled above. */}
        {recaptchaEnabled ? (
          <GoogleReCaptchaProvider reCaptchaKey={config.RECAPTCHA_SITE_KEY}>
            {appTree}
          </GoogleReCaptchaProvider>
        ) : (
          appTree
        )}
    </IdleTimerProvider>
    </>
  );
};

export default App;
