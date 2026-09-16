const config = {
  // `secretOrKey` REMOVED. It was `process.env.NEXT_PUBLIC_SECRET_KEY` -- the
  // BACKENDS' JWT SIGNING KEY, published into the browser bundle. Anything
  // prefixed NEXT_PUBLIC_ is inlined at build time and served to every visitor,
  // so the key that signs every session was readable by anyone who opened the
  // site and could be used to forge a token for any user.
  //
  // Nothing read it. A repo-wide grep for `secretOrKey` outside .next/ finds
  // exactly one hit: the line that used to be here. It was dead scaffolding
  // whose only effect was the disclosure. The frontend never verifies a JWT --
  // it holds an opaque token and the backends verify it.
  //
  // `CRYPTO_SECRET_KEY` below is a DIFFERENT thing and is correctly public: it
  // AES-wraps order payloads, spotapi decrypts with the same constant, and that
  // constant ships in the backend source. It is obfuscation of a request body,
  // not a secret, and the venue does not rely on it for authorisation.
  RECAPTCHA_SITE_KEY: process.env.NEXT_PUBLIC_RECAPTCHA_KEY,
  API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:2567",
  FRONT_URL: process.env.NEXT_PUBLIC_FRONT_URL || "http://localhost:3000",
  SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:2568",
  getGeoInfo: process.env.NEXT_PUBLIC_GEO_INFO,
  CRYPTO_SECRET_KEY: process.env.NEXT_PUBLIC_CRYPTO_SECRET_KEY,
  USER_API: process.env.NEXT_PUBLIC_USER_API || "http://localhost:2567",
  WALLET_API: process.env.NEXT_PUBLIC_WALLET_API || "http://localhost:3002",
  SPOT_API: process.env.NEXT_PUBLIC_SPOT_API || "http://localhost:2568",
  // NOTE ON THESE FALLBACKS
  // The checked-in local.env / prod.env spell every key with a DOUBLE
  // underscore (NEXT_PUBLIC__USER_API) while this file reads a single one, so
  // nothing in those files ever reaches this object. What supplies the real
  // values on a working machine is `.env.local`, which uses the single
  // underscore - and `.env.local` is gitignored. On any checkout that lacks it
  // the fallbacks above ARE the configuration, so each one must name a port a
  // service on this venue actually binds: a fallback pointing at a port nothing
  // listens on renders the pages that read it permanently empty, with no error
  // to explain it. Only the three services this venue runs are listed.
  SITE_NAME: "Cryptodex Exchange",
  SITE_KEYWORDS: "Cryptodex Exchange, cryptocurrency trading, Bitcoin, Ethereum, DeFi",
  SITE_DISCRIPTION: "Cryptodex Exchange - Practice crypto trading with confidence. Spot trading on live market data with virtual funds.",
  ONRAMP_APP_ID: process.env.NEXT_PUBLIC_ONRAMP_APP_ID,
  MODE: process.env.NEXT_PUBLIC_MODE,
};

export default config;
