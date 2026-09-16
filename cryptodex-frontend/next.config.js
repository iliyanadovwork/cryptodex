/** @type {import('next').NextConfig} */

const nextConfig = {
  // react-toastify ships an ESM entry ("import": dist/react-toastify.esm.mjs).
  // Next 13's `esmExternals` default leaves such packages OUT of the server
  // bundle and lets Node import them natively as `file://` ESM at request time.
  // That import path never sees webpack's `react` alias, so it resolves plain
  // `node_modules/react` while react-dom-server is running on
  // `next/dist/compiled/react` - two React copies, one dispatcher, and
  // `ReactCurrentDispatcher.current` is null in the copy toastify calls into.
  // Every SSR of <ToastContainer /> (it is mounted in _app, so: every page, and
  // the /_error render that follows) threw
  //   "Cannot read properties of null (reading 'useReducer')"
  // preceded by React's own "Invalid hook call ... more than one copy of React".
  //
  // transpilePackages pulls the package back INTO the webpack build for both
  // the client and the server, where the react alias applies and there is
  // exactly one React. Narrower than flipping esmExternals off globally, which
  // would change module resolution for every dependency.
  transpilePackages: ["react-toastify"],
  optimizeFonts: true,
  reactStrictMode: false,
  swcMinify: false,
  compress: true,
  images: {
    domains: [
      "localhost",
      "localhost:3001",
      "localhost:3002",
      // Two unrelated remote hosts used to be whitelisted here. They were not
      // defaults and nothing pointed an <Image> at them; a whitelist entry is a
      // standing permission to load remote content from a server this venue
      // does not run, which is exactly what should not be left standing.
      // Removed. Everything this venue renders is served from localhost (dev)
      // or a *.cryptodex.com host (below).
      "userapi.cryptodex.com",
      "walletapi.cryptodex.com",
      "spotapi.cryptodex.com",
      // Only the three services this venue runs are whitelisted: a host listed
      // here is an invitation to point an <Image> at it, so the list stays minimal.
    ], // Domain name,
    unoptimized: false,
  },
  typescript: {
    ignoreBuildErrors: true,
  },

  /**
   * ROUTES THAT NO LONGER EXIST.
   *
   * /innerhome was a marketing landing page. Every section of its body had
   * already been commented out, so it rendered the literal empty string — no
   * navbar, no footer, no content, no error — and the file has been deleted.
   * Anything that still reaches the URL (a stale bookmark, a crawler, a
   * hand-typed address) is answered by /spot, which is the page's old job —
   * "here is what this exchange offers" — done by a screen that works.
   *
   * Not permanent: a 308 is cached by browsers indefinitely, and these paths
   * may be wanted for something else.
   */
  async redirects() {
    return [
      {
        // Was "/market", which this venue no longer has - so the redirect that
        // existed to rescue a stale bookmark had started delivering it to a 404
        // instead. /spot IS the market now.
        source: "/innerhome",
        destination: "/spot",
        permanent: false,
      },
      {
        // Same reason: /market was a real page until the venue went
        // single-market. Anyone holding that URL gets the one market.
        source: "/market",
        destination: "/spot",
        permanent: false,
      },
      /**
       * /deposit AND /withdraw WERE LYING BY THEIR NAMES.
       *
       * Neither has moved money since the paper conversion: /deposit rendered
       * the faucet and /withdraw rendered the demo reset, and their buttons
       * said so ("Claim Demo Funds", "Reset Demo Account"). The URLs did not,
       * so a visitor clicking "Withdraw" in a nav or a bookmark arrived
       * expecting to take money out and was offered a wipe of their account
       * instead - the most damaging thing the wrong label can be attached to.
       *
       * The pages are now /faucet and /reset. Both old paths redirect rather
       * than 404 because they were in the nav for the life of the product.
       */
      {
        source: "/deposit",
        destination: "/faucet",
        permanent: false,
      },
      {
        source: "/withdraw",
        destination: "/reset",
        permanent: false,
      },
      /**
       * THE IDENTITY / SECURITY SCREENS THIS VENUE NO LONGER HAS.
       *
       * /2fa (authenticator enrolment), /kyc (identity verification) and
       * /log-session (the login journal) are gone. All three were reachable
       * from the product for its whole life — /2fa and /log-session from the
       * account menu, /kyc from the wallet — so they are in bookmarks and
       * histories.
       *
       * They land on /security, which is where an account holder who typed any
       * of them was trying to get: it is the one screen that still manages
       * anything about their account (password, e-mail address). A 404 answers
       * "does this page exist" correctly and answers the visitor's actual
       * question not at all.
       *
       * Same reasoning and same non-permanence as the two blocks above: a 308
       * is cached by the browser forever, and these paths may be wanted again.
       */
      {
        source: "/2fa",
        destination: "/security",
        permanent: false,
      },
      {
        source: "/kyc",
        destination: "/security",
        permanent: false,
      },
      {
        source: "/log-session",
        destination: "/security",
        permanent: false,
      },
      /**
       * THE HELP SURFACE THIS VENUE NO LONGER HAS.
       *
       * /faq read user/faq, /contactus posted to user/addContactus, and
       * /support-ticket drove the four user/support verbs plus
       * user/getSupportCategory. All of those endpoints have been withdrawn,
       * so all three pages are deleted rather than left to render a spinner
       * over a 404.
       *
       * They were reachable for the life of the product — /faq and /contactus
       * from the footer of EVERY page, /support-ticket from the account menu —
       * so they are in bookmarks, histories and any link a user has shared.
       *
       * They land on "/" because the home page is what a visitor typing any of
       * them was after: what this thing is and how to start. It is also now
       * the only page that says so — the footer that used to carry the legal
       * documents and the support address is gone, along with /terms and
       * /privacy-policy themselves (below).
       *
       * Not permanent, for the same reason as every block above: a 308 is
       * cached by the browser indefinitely and these paths may be wanted again
       * if the product ever grows a help desk.
       */
      {
        source: "/faq",
        destination: "/",
        permanent: false,
      },
      {
        source: "/contactus",
        destination: "/",
        permanent: false,
      },
      {
        source: "/support-ticket",
        destination: "/",
        permanent: false,
      },
      /**
       * THE LEGAL PAGES.
       *
       * A Terms of Service and a Privacy Policy describe obligations between
       * an operator and a user. This venue has neither to describe: it issues
       * virtual balances from a faucet, fills them against a simulated book,
       * and can pay nothing out. The two documents were boilerplate for a
       * business that does not exist, so they are deleted rather than left
       * saying things that are not true of this software.
       *
       * They were linked from the footer of every page for the life of the
       * product, so they get the same treatment as the three above: a
       * temporary redirect to "/", which carries the paper-trading disclosure
       * that was the only part of them that actually applied here.
       */
      {
        source: "/terms",
        destination: "/",
        permanent: false,
      },
      {
        source: "/privacy-policy",
        destination: "/",
        permanent: false,
      },
      /**
       * ACCOUNT ACTIVITY.
       *
       * /notification listed sign-ins and account changes - "Login success",
       * over and over. It was reachable from the account menu for the life of
       * the product, so it is in histories, and it gets the same temporary
       * redirect to "/" as every other page removed from this venue.
       *
       * The rows behind it are still WRITTEN: userapi's auth controller and
       * walletapi both call newNotification over gRPC. Nothing reads them any
       * more - this page was the only reader - so what remains is a table that
       * grows and is never opened. Removing the writers is a separate change
       * across two services and a gRPC contract, deliberately not folded in
       * here.
       */
      {
        source: "/notification",
        destination: "/",
        permanent: false,
      },
    ];
  },
};

module.exports = nextConfig;
