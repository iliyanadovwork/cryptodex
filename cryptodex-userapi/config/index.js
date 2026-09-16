import "dotenv/config";
let key = {};
let envKey = {
  PORT: process.env.PORT,
  REDIS_URL: process.env.REDIS_URL,
  REDIS_PREFIX: process.env.REDIS_PREFIX,
  SITE_NAME: process.env.SITE_NAME,
  SECRET_KEY: process.env.SECRET_KEY,
  CRYPTO_SECRET_KEY: process.env.CRYPTO_SECRET_KEY,
  GRPC: {
    URL: process.env.GRPC_URL,
    USER_URL: process.env.GRPC_USER_URL,
    WALLET_URL: process.env.GRPC_WALLET_URL,
    SPOT_URL: process.env.GRPC_SPOT_URL,
    // P2P_URL removed: the last two p2p reads (fetchUserPayment,
    // fetchP2BuyerSellerDetails) are gone from grpc/server.js and user.proto,
    // and no p2p service exists to dial.
  },
  DATABASE_URI: process.env.DATABASE_URI,
  SERVER_URL: process.env.BASE_URL,
  FRONT_URL: process.env.FRONT_URL,
  ADMIN_URL: process.env.ADMIN_URL,
  IMAGE_URL: process.env.BASE_URL,
  RECAPTCHA_SECRET_KEY: process.env.RECAPTCHA_SECRET_KEY,

  // `smsGateway` (SMS_TYPE, TELNYX_*, TWILIO_*) removed with lib/smsGateway.js.
  // Nothing sends SMS on this venue any more: phone verification, the phone
  // OTP and phone registration/login are all gone. The variables are left in
  // the env files - unread - rather than edited out of a file that also holds
  // live secrets.
  RESEND: {
    API_KEY: process.env.RESEND_API_KEY || "",
    FROM_EMAIL: process.env.RESEND_FROM_EMAIL || "noreply@cryptodex.com",
  },
  SUMSUB: {
    TOKEN: process.env.SUMSUB_TOKEN,
    SECRET: process.env.SUMSUB_KEY,
    WEBHOOK_KEY: process.env.SUMSUB_WEBHOOK_KEY,
  },
};

if (process.env.NODE_ENV === "production") {
  console.log("\x1b[35m%s\x1b[0m", `Set ${process.env.NODE_ENV} Config`);

  key = {
    secretOrKey: envKey.SECRET_KEY,
    cryptoSecretKey: envKey.CRYPTO_SECRET_KEY,
    RUN_CRON: true,

    IMAGE: {
      DEFAULT_SIZE: 1 * 1024 * 1024, // 1 MB,
      URL_PATH: "/images/profile/",
      PROFILE_SIZE: 1 * 1024 * 1024, // 1 MB
      PROFILE_PATH: "public/profile",
      PROFILE_URL_PATH: "/profile/",

      ID_DOC_SIZE: 1 * 1024 * 1024, // 12 MB,
      KYC_PATH: "public/kyc",
      KYC_URL_PATH: "/kyc/",

      CURRENCY_SIZE: 0.02 * 1024 * 1024, // 20 KB
      CURRENCY_PATH: "public/currency/",
      CURRENCY_URL_PATH: "/currency/",
      DEPOSIT_PATH: "public/deposit",
      DEPOSIT_URL_PATH: "/deposit/",
      SETTINGS_PATH: "public/settings",
      SETTINGS_URL_PATH: "settings",
      LAUNCHPAD_SIZE: 20 * 1024 * 1024, // 500 KB
      LAUNCHPAD_PATH: "public/launchpad",
      LAUNCHPAD_URL_PATH: "/launchpad/",

    },

    NODE_TWOFA: {
      NAME: "Cryptodex Exchange",
      // SECURITY: QR_IMAGE is gone. It was
      //   "https://quickchart.io/chart?cht=qr&chs=150x150&chl="
      // and the 2FA controllers appended the otpauth:// URI to it. That URI
      // carries the user's TOTP shared secret AND their email address, so
      // every 2FA page load sent the second factor to a third-party host in a
      // plaintext GET. Clients render the QR locally from `result.uri`; there
      // is nothing to configure here and nothing to point at an external
      // renderer. Do not add it back.
    },
  };
} else if (process.env.NODE_ENV === "development") {
  console.log("\x1b[35m%s\x1b[0m", `Set ${process.env.NODE_ENV} Config`);

  // An `API_URL` constant pointing at an unrelated external deployment host
  // used to be declared here. Nothing in this file or anywhere else ever read
  // `API_URL` - grep it - so it was not a default; it was a live (uncommented)
  // statement in the branch this venue actually runs under, pointing at a host
  // that has nothing to do with this stack. Removed rather than pointed at
  // localhost, because an unused constant that needs a correct value is a
  // constant that should not exist.
  key = {
    secretOrKey: envKey.SECRET_KEY,
    cryptoSecretKey: envKey.CRYPTO_SECRET_KEY,
    RUN_CRON: true,

    IMAGE: {
      DEFAULT_SIZE: 1 * 1024 * 1024, // 1 MB,
      URL_PATH: "/images/profile/",
      PROFILE_SIZE: 1 * 1024 * 1024, // 1 MB
      PROFILE_PATH: "public/profile",
      PROFILE_URL_PATH: "/profile/",

      ID_DOC_SIZE: 1 * 1024 * 1024, // 12 MB,
      KYC_PATH: "public/kyc",
      KYC_URL_PATH: "/kyc/",

      CURRENCY_SIZE: 0.02 * 1024 * 1024, // 20 KB
      CURRENCY_PATH: "public/currency/",
      CURRENCY_URL_PATH: "/currency/",
      DEPOSIT_PATH: "public/deposit",
      DEPOSIT_URL_PATH: "/deposit/",
      SETTINGS_PATH: "public/settings",
      SETTINGS_URL_PATH: "settings",
      LAUNCHPAD_SIZE: 20 * 1024 * 1024, // 500 KB
      LAUNCHPAD_PATH: "public/launchpad",
      LAUNCHPAD_URL_PATH: "/launchpad/",

    },

    NODE_TWOFA: {
      NAME: "Cryptodex Exchange",
      // SECURITY: QR_IMAGE is gone. It was
      //   "https://quickchart.io/chart?cht=qr&chs=150x150&chl="
      // and the 2FA controllers appended the otpauth:// URI to it. That URI
      // carries the user's TOTP shared secret AND their email address, so
      // every 2FA page load sent the second factor to a third-party host in a
      // plaintext GET. Clients render the QR locally from `result.uri`; there
      // is nothing to configure here and nothing to point at an external
      // renderer. Do not add it back.
    },
    COIN_GATE_WAY: {
      BTC: {
        URL: "",
      },
      LTC: {
        URL: "",
      },
      DOGE: {
        URL: "",
      },
      ETH: {
        URL: "",
      },
    },

    coinGateway: {
      eth: {
        url: "",
        startBlock: 11504800,
        address: "",
        privateKey: "",
        etherscanUrl: "https://api.etherscan.io/api?", // https://api-ropsten.etherscan.io/api?
        ethDepositUrl:
          "https://api-ropsten.etherscan.io/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-etherscan-ropsten-key>",
        ethTokenDepositUrl:
          "https://api-ropsten.etherscan.io/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-etherscan-ropsten-key>",
      },
      btc: {
        url: "",
      },
    },

    BINANCE_GATE_WAY: {
      API_KEY: "",
      API_SECRET: "",
    },
  };
} else {
  console.log("\x1b[35m%s\x1b[0m", `Set Development Config`);
  const API_URL = "http://localhost";
  key = {
    secretOrKey: envKey.SECRET_KEY,
    cryptoSecretKey: envKey.CRYPTO_SECRET_KEY,
    RUN_CRON: false,


    IMAGE: {
      DEFAULT_SIZE: 1 * 1024 * 1024, // 1 MB,
      URL_PATH: "/images/profile/",
      PROFILE_SIZE: 1 * 1024 * 1024, // 1 MB
      PROFILE_PATH: "public/profile",
      PROFILE_URL_PATH: "/profile/",

      ID_DOC_SIZE: 1 * 1024 * 1024, // 12 MB,
      KYC_PATH: "public/kyc",
      KYC_URL_PATH: "/kyc/",

      CURRENCY_SIZE: 0.02 * 1024 * 1024, // 20 KB
      CURRENCY_PATH: "public/currency/",
      CURRENCY_URL_PATH: "/currency/",
      DEPOSIT_PATH: "public/deposit",
      DEPOSIT_URL_PATH: "/deposit/",
      SETTINGS_PATH: "public/settings",
      SETTINGS_URL_PATH: "settings",
      LAUNCHPAD_SIZE: 20 * 1024 * 1024, // 500 KB
      LAUNCHPAD_PATH: "public/launchpad",
      LAUNCHPAD_URL_PATH: "/launchpad/",

    },

    NODE_TWOFA: {
      NAME: "Cryptodex Exchange",
      // SECURITY: QR_IMAGE is gone. It was
      //   "https://quickchart.io/chart?cht=qr&chs=150x150&chl="
      // and the 2FA controllers appended the otpauth:// URI to it. That URI
      // carries the user's TOTP shared secret AND their email address, so
      // every 2FA page load sent the second factor to a third-party host in a
      // plaintext GET. Clients render the QR locally from `result.uri`; there
      // is nothing to configure here and nothing to point at an external
      // renderer. Do not add it back.
    },
  };
}

export default {
  ...envKey,
  ...key,
};
