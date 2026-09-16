import "dotenv/config";
let key = {};
let envKey = {
  PORT: process.env.PORT,
  REDIS_URL: process.env.REDIS_URL,
  REDIS_PREFIX:process.env.REDIS_PREFIX,
  SITE_NAME: process.env.SITE_NAME,
  SECRET_KEY: process.env.SECRET_KEY,
  CRYPTO_SECRET_KEY: process.env.CRYPTO_SECRET_KEY,
  GRPC: {
    URL: process.env.GRPC_URL,
    USER_URL: process.env.GRPC_USER_URL,
    WALLET_URL: process.env.GRPC_WALLET_URL,
    SPOT_URL: process.env.GRPC_SPOT_URL,
    P2P_URL: process.env.GRPC_P2P_URL,
  },
  DATABASE_URI: process.env.DATABASE_URI,
  SERVER_URL: process.env.BASE_URL,
  FRONT_URL: process.env.FRONT_URL,
  ADMIN_URL: process.env.ADMIN_URL,
  IMAGE_URL: process.env.BASE_URL,
  RECAPTCHA_SECRET_KEY: process.env.RECAPTCHA_SECRET_KEY,
  WALLET_URL: process.env.WALLET_URL,
  // `smsGateway` (SMS_TYPE, TELNYX_*, TWILIO_*) removed with lib/smsGateway.js,
  // matching the same removal in userapi. Nothing sends SMS on this venue any
  // more: phone verification, the phone OTP and phone registration/login are
  // all gone, and this service never had a phone surface to begin with - the
  // block and the module sat here unread. The variables are left in the env
  // files - unread - rather than edited out of a file that also holds live
  // secrets.
  BINANCE_GATE_WAY: {
    API_KEY: process.env.BINANCE_API_KEY,
    API_SECRET: process.env.BINANCE_SECRET_KEY,
    // API_URL: "https://testnet.binance.vision",
  },
  RESEND: {
    API_KEY: process.env.RESEND_API_KEY || "",
    FROM_EMAIL: process.env.RESEND_FROM_EMAIL || "noreply@cryptodex.com",
  },
};

if (process.env.NODE_ENV === "production") {
  console.log("\x1b[35m%s\x1b[0m", `Set ${process.env.NODE_ENV} Config`);

  // (A commented-out `API_URL` naming an unrelated external deployment host
  // stood here. `API_URL` is read nowhere in this file; it was dead text, not
  // configuration.)
  key = {
    SITE_NAME: "Cryptodex Exchange",
    secretOrKey: envKey.SECRET_KEY,
    cryptoSecretKey: envKey.CRYPTO_SECRET_KEY,
    RUN_CRON: true,

    IMAGE: {
      DEFAULT_SIZE: 1 * 1024 * 1024, // 1 MB,
      URL_PATH: "/images/profile/",
      PROFILE_SIZE: 1 * 1024 * 1024, // 1 MB
      PROFILE_PATH: "public/profile",
      PROFILE_URL_PATH: "/profile/",

      ID_DOC_SIZE: 12 * 1024 * 1024, // 12 MB,
      KYC_PATH: "public/kyc",
      KYC_URL_PATH: "/kyc/",

      CURRENCY_SIZE: 0.02 * 1024 * 1024, // 20 KB
      CURRENCY_PATH: "public/currency/",
      CURRENCY_URL_PATH: "/currency/",
      DEPOSIT_PATH: "public/deposit",
      DEPOSIT_URL_PATH: "/deposit/",
      SETTINGS_URL_PATH: "public/settings",
      LAUNCHPAD_SIZE: 20 * 1024 * 1024, // 500 KB
      LAUNCHPAD_PATH: "public/launchpad",
      LAUNCHPAD_URL_PATH: "/launchpad/",
      SUPPORT_PATH: "public/support",
      SUPPORT_URL_PATH: "/support/",

      P2P_SIZE: 2 * 1024 * 1024, // 2 MB
      P2P_PATH: "public/p2p",
      P2P_URL_PATH: "/p2p/",
    },

    NODE_TWOFA: {
      NAME: "Cryptodex",
      QR_IMAGE:
        "https://chart.googleapis.com/chart?chs=166x166&chld=L|0&cht=qr&chl=",
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

    coinpaymentGateway: {
      PUBLIC_KEY: "",
      PRIVATE_KEY: "",
      IPN_SECRET: "testing",
      MERCHANT_ID: "",
    },
    CLOUDINARY_GATE_WAY: {
      CLOUD_NAME: "",
      API_KEY: "",
      API_SECRET: "",
    },
    COINMARKETCAP: {
      API_KEY: "",
      PRICE_CONVERSION: "",
    },
  };
} else if (process.env.NODE_ENV === "development") {
  console.log("\x1b[35m%s\x1b[0m", `Set ${process.env.NODE_ENV} Config`);

  const API_URL = "";
  key = {
    SITE_NAME: "Cryptodex Exchange",
    secretOrKey: envKey.SECRET_KEY,
    cryptoSecretKey: envKey.CRYPTO_SECRET_KEY,
    RUN_CRON: true,

    IMAGE: {
      DEFAULT_SIZE: 1 * 1024 * 1024, // 1 MB,
      URL_PATH: "/images/profile/",
      PROFILE_SIZE: 1 * 1024 * 1024, // 1 MB
      PROFILE_PATH: "public/profile",
      PROFILE_URL_PATH: "/profile/",

      ID_DOC_SIZE: 12 * 1024 * 1024, // 12 MB,
      KYC_PATH: "public/kyc",
      KYC_URL_PATH: "/kyc/",

      CURRENCY_SIZE: 0.02 * 1024 * 1024, // 20 KB
      CURRENCY_PATH: "public/currency/",
      CURRENCY_URL_PATH: "/currency/",
      DEPOSIT_PATH: "public/deposit",
      DEPOSIT_URL_PATH: "/deposit/",
      SETTINGS_URL_PATH: "public/settings",
      LAUNCHPAD_SIZE: 20 * 1024 * 1024, // 500 KB
      LAUNCHPAD_PATH: "public/launchpad",
      LAUNCHPAD_URL_PATH: "/launchpad/",
      SUPPORT_PATH: "public/support",
      SUPPORT_URL_PATH: "/support/",

      P2P_SIZE: 2 * 1024 * 1024, // 2 MB
      P2P_PATH: "public/p2p",
      P2P_URL_PATH: "/p2p/",
    },
    NODE_TWOFA: {
      NAME: "Cryptodex",
      QR_IMAGE:
        "https://chart.googleapis.com/chart?chs=166x166&chld=L|0&cht=qr&chl=",
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
        etherscanUrl: "", // https://api-ropsten.etherscan.io/api?
        ethDepositUrl:
          "https://api-ropsten.etherscan.io/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-etherscan-ropsten-key>",
        ethTokenDepositUrl:
          "https://api-ropsten.etherscan.io/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-etherscan-ropsten-key>",
      },
      btc: {
        url: "http://localhost/no-coin-gateway-on-this-venue",
      },
    },

    coinpaymentGateway: {
      PUBLIC_KEY: "",
      PRIVATE_KEY: "",
      IPN_SECRET: "testing",
      MERCHANT_ID: "",
    },
    CLOUDINARY_GATE_WAY: {
      CLOUD_NAME: "",
      API_KEY: "",
      API_SECRET: "",
    },
    COINMARKETCAP: {
      API_KEY: "",
      PRICE_CONVERSION: "",
    },
  };
} else {
  console.log("\x1b[35m%s\x1b[0m", `Set Development Config`);
  const API_URL = "http://localhost";
  key = {
    SITE_NAME: "Cryptodex Exchange",
    secretOrKey: envKey.SECRET_KEY,
    cryptoSecretKey: envKey.CRYPTO_SECRET_KEY,
    RUN_CRON: "true",

    IMAGE: {
      DEFAULT_SIZE: 1 * 1024 * 1024, // 1 MB,
      URL_PATH: "/images/profile/",
      PROFILE_SIZE: 1 * 1024 * 1024, // 1 MB
      PROFILE_PATH: "public/profile",
      PROFILE_URL_PATH: "/profile/",

      ID_DOC_SIZE: 5 * 1024 * 1024, // 12 MB,
      KYC_PATH: "public/kyc",
      KYC_URL_PATH: "/kyc/",

      CURRENCY_SIZE: 0.02 * 1024 * 1024, // 20 KB
      CURRENCY_PATH: "public/currency/",
      CURRENCY_URL_PATH: "/currency/",
      DEPOSIT_PATH: "public/deposit",
      DEPOSIT_URL_PATH: "/deposit/",
      SETTINGS_URL_PATH: "public/settings",
      LAUNCHPAD_SIZE: 20 * 1024 * 1024, // 500 KB
      LAUNCHPAD_PATH: "public/launchpad",
      LAUNCHPAD_URL_PATH: "/launchpad/",
      SUPPORT_PATH: "public/support",
      SUPPORT_URL_PATH: "/support/",

      P2P_SIZE: 2 * 1024 * 1024, // 2 MB
      P2P_PATH: "public/p2p",
      P2P_URL_PATH: "/p2p/",
    },

    NODE_TWOFA: {
      NAME: "Cryptodex",
      QR_IMAGE:
        "https://chart.googleapis.com/chart?chs=166x166&chld=L|0&cht=qr&chl=",
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

    coinpaymentGateway: {
      PUBLIC_KEY: "",
      PRIVATE_KEY: "",
      IPN_SECRET: "testing",
      MERCHANT_ID: "",
    },
    CLOUDINARY_GATE_WAY: {
      CLOUD_NAME: "",
      API_KEY: "",
      API_SECRET: "",
    },
    COINMARKETCAP: {
      API_KEY: "",
      PRICE_CONVERSION: "",
    },
  };
}

export default {
  ...envKey,
  ...key,
};
