import "dotenv/config";
let key = {};
let envKey = {
  PORT: process.env.PORT,
  REDIS_URL: process.env.REDIS_URL,
  REDIS_PREFIX: process.env.REDIS_PREFIX,
  SITE_NAME: process.env.SITE_NAME,
  SECRET_KEY: process.env.SECRET_KEY,
  CRYPTO_SECRET_KEY: process.env.CRYPTO_SECRET_KEY,
  // No hardcoded fallback. The literal that used to sit here was a real Infura
  // project id committed to the repository; treat it as leaked. Nothing on a
  // paper venue dials Infura anyway - the only consumers are the two testnet
  // URLs below, and every EVM gateway that would use them is a paper stub.
  INFURA_API_KEY: process.env.INFURA_API_KEY || "",
  // Read from the environment, never from source. The previous value was a live
  // CryptoCompare key spelled directly into the request URL in
  // controllers/priceCNV.controller.js, on a cron that fires every 5 minutes.
  // Unset is safe: priceCNV omits the api_key parameter and CryptoCompare
  // serves the price endpoint anonymously at a lower rate limit.
  CRYPTOCOMPARE_API_KEY: process.env.CRYPTOCOMPARE_API_KEY || "",
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
  // `ADMIN_URL` was removed with the admin panel. It was the base URL of the
  // operator UI, and no code in this service ever read `config.ADMIN_URL` -
  // a repo-wide grep of cryptodex-walletapi finds only the line that used to
  // be here. A config key for a surface that does not exist is an invitation
  // to build something that points at it.
  IMAGE_URL: process.env.BASE_URL,
  SERVICE_WALLET_TRX_ID: process.env.TRX_WALLET_ID,
  RECAPTCHA_SECRET_KEY: process.env.RECAPTCHA_SECRET_KEY,
  SERVICE_WALLET_BNB_ID: process.env.BNB_WALLET_ID,
  SERVICE_WALLET_ETH_ID: process.env.BNB_WALLET_ID,
  // `smsGateway` (SMS_TYPE, TELNYX_*, TWILIO_*) removed with lib/smsGateway.js,
  // matching the same removal in userapi. Nothing sends SMS on this venue any
  // more: phone verification, the phone OTP and phone registration/login are
  // all gone, and this service never had a phone surface to begin with - the
  // block and the module were copied here with the rest of the service
  // skeleton and never read. The variables are left in the env files - unread -
  // rather than edited out of a file that also holds live secrets.
  FIREBLOCK: {
    BASE_URL: process.env.FIREBLOCK_BASE_URL,
    API_KEY: process.env.FIREBLOCK_API_KEY,
    // GAS_STATION_ADDRESS_BNB: process.env.FIREBLOCK_GAS_STATION_ADDRESS_BNB,
  },
  RESEND: {
    API_KEY: process.env.RESEND_API_KEY || "",
    FROM_EMAIL: process.env.RESEND_FROM_EMAIL || "noreply@cryptodex.com",
  },
};

if (process.env.NODE_ENV === "production") {
  console.log("\x1b[35m%s\x1b[0m", `Set Production Config`);
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

    COIN_GATE_WAY: {
      BTC: {
        URL: "http://localhost/no-coin-gateway-on-this-venue",
      },
      BNB: {
        URL: "https://bsc-dataseed1.binance.org",
        START_BLOCK: 24715931,
        CHAIN_URL: "https://api.bscscan.com/api",
        DEPOSIT_URL:
          "https://api.bscscan.com/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        DEPOSIT_TOKEN_URL:
          "https://api.bscscan.com/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        NETWORK_ID: 56,
        CHAIN_ID: 56,
        ADDRESS: "0x01e897329916c919c16a73BB8f25C6D48FE4c4cb",
        PRIVATE_KEY:
          "",
      },
      BDYX: {
        URL: "https://mainnet-rpc.buddyscan.io",
        START_BLOCK: 1333985,
        CHAIN_URL: "https://buddyscan.io/api",
        DEPOSIT_URL:
          "https://buddyscan.io/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        DEPOSIT_TOKEN_URL:
          "https://buddyscan.io/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        NETWORK_ID: 62455,
        CHAIN_ID: 62455,
        ADDRESS: "0xDcdAc55d2BB81d38D4a4A8F7dc6F1c3f0C8270AB",
        PRIVATE_KEY:
          "",
      },
      // ETH: {
      //   URL: <a removed remote ETH gateway host>,
      //   START_BLOCK: 7915547,
      //   DEPOSIT_URL: "https://api-goerli.etherscan.io/api",
      //   ADDRESS: "0xa938C1d4A16dFbA5ae83436f73828210BE139AE2",
      //   PRIVATE_KEY: "",
      //   API_KEY: "<REMOVED-etherscan-key>"
      // },
      TRX: {
        fullNode: "https://api.shasta.trongrid.io",
        solidityNode: "https://api.shasta.trongrid.io",
        eventServer: "https://api.shasta.trongrid.io",
        contractAddress: "",
        transactionUrl:
          "https://api.shasta.trongrid.io/v1/accounts/##USER_ADDRESS##/transactions?only_to=true&limit=50",
        transactionContractUrl:
          "https://api.shasta.trongrid.io/v1/accounts/##USER_ADDRESS##/transactions/trc20?limit=100&contract_address=##CONTRACT_ADDRESS##",
        decimal: 100000000, //8
        tronDecimal: 1000000, //6
        adminAmtSentToUser: 20,

        URL: "http://localhost/no-coin-gateway-on-this-venue",
        privateKey:
          "",
        address: "TXCMujsUvvG5GqYkSvZq1fCqJfEADTZeTT",
        resourceFeeOnNewAccount: 0.1,
        estBand: 268,
        estEnergyForNewAccount: 66667,
        estBandForToken: 346,
        estEnergyForOldAccount: 33334,
        transactionNewAccounts:
          "https://api.trongrid.io/v1/accounts/##USER_ADDRESS##/transactions?only_to=true",
      },
      ETH: {
        URL: "http://localhost/no-coin-gateway-on-this-venue",
        START_BLOCK: 16389207,
        DEPOSIT_URL: "https://api.etherscan.io/api",
        ADDRESS: "0x01e897329916c919c16a73BB8f25C6D48FE4c4cb",
        PRIVATE_KEY:
          "",
        API_KEY: process.env.GATEWAY_API_KEY,
      },
      POLYGON: {
        URL: "https://polygon.llamarpc.com",
        START_BLOCK: 38589042,
        CHAIN_URL: "https://api.polygonscan.com/api",
        DEPOSIT_URL:
          "https://api.polygonscan.com/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-polygonscan-key>",
        DEPOSIT_TOKEN_URL:
          "https://api.polygonscan.com/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-polygonscan-key>",
        NETWORK_ID: 137,
        CHAIN_ID: 137,
        ADDRESS: "0x7bd2EF5D14D0aEFCD7cd448a2E97ad3d444837B1",
        PRIVATE_KEY:
          "",
      },
    },
    BINANCE_GATE_WAY: {
      API_KEY: "",
      API_SECRET: "",
    },
    coinpaymentGateway: {
      PUBLIC_KEY: "",
      PRIVATE_KEY: "",
      IPN_SECRET: "",
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
    MAILGUN_GATE_WAY: {
      API_KEY: process.env.GATEWAY_API_KEY,
      DOMAIN: ".com",
      URL: "https://api..net",
    },
  };
} else if (process.env.NODE_ENV === "development") {
  console.log("\x1b[35m%s\x1b[0m", `Set development Config`);

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
    SERVICE_WALLET_ETH_ID: process.env.ETH_WALLET_ID,
    SERVICE_WALLET_BNB_ID: process.env.BNB_WALLET_ID,
    COIN_GATE_WAY: {
      BTC: {
        URL: "http://localhost:3010",
        ENCRYPT_KEY: process.env.GATEWAY_ENCRYPT_KEY,
        IVVAR: process.env.GATEWAY_IV,
        AUTH_TOKEN: process.env.GATEWAY_AUTH_TOKEN,
      },
      LTC: {
        URL: "http://localhost:3010",
        ENCRYPT_KEY: process.env.GATEWAY_ENCRYPT_KEY,
        IVVAR: process.env.GATEWAY_IV,
        AUTH_TOKEN: process.env.GATEWAY_AUTH_TOKEN,
      },

      BNB: {
        // URL: <a removed remote BNB gateway host>,
        URL: "https://data-seed-prebsc-1-s1.binance.org:8545",
        START_BLOCK: 52375920,
        CHAIN_URL: "https://api-testnet.bscscan.com/api",
        DEPOSIT_URL:
          "https://api-testnet.bscscan.com/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        DEPOSIT_TOKEN_URL:
          "https://api-testnet.bscscan.com/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        NETWORK_ID: 97,
        CHAIN_ID: 97,
        ADDRESS: "0xCCc5e897eFe78718E0Bb616080391ccE72364dE0",
        PRIVATE_KEY:
          "",
      },
      BDYX: {
        URL: "https://mainnet-rpc.buddyscan.io",
        START_BLOCK: 1333985,
        CHAIN_URL: "https://buddyscan.io/api",
        DEPOSIT_URL:
          "https://buddyscan.io/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        DEPOSIT_TOKEN_URL:
          "https://buddyscan.io/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        NETWORK_ID: 62455,
        CHAIN_ID: 62455,
        ADDRESS: "0xDcdAc55d2BB81d38D4a4A8F7dc6F1c3f0C8270AB",
        PRIVATE_KEY:
          "",
      },
      TRX: {
        fullNode: "https://api.shasta.trongrid.io",
        solidityNode: "https://api.shasta.trongrid.io",
        eventServer: "https://api.shasta.trongrid.io",
        contractAddress: "",
        transactionUrl:
          "https://api.shasta.trongrid.io/v1/accounts/##USER_ADDRESS##/transactions?only_to=true&limit=50",
        transactionContractUrl:
          "https://api.shasta.trongrid.io/v1/accounts/##USER_ADDRESS##/transactions/trc20?limit=100&contract_address=##CONTRACT_ADDRESS##",
        decimal: 100000000, //8
        tronDecimal: 1000000, //6
        adminAmtSentToUser: 20,

        URL: "http://localhost/no-coin-gateway-on-this-venue",
        privateKey:
          "",
        address: "TXCMujsUvvG5GqYkSvZq1fCqJfEADTZeTT",
        resourceFeeOnNewAccount: 0.1,
        estBand: 268,
        estEnergyForNewAccount: 66667,
        estBandForToken: 346,
        estEnergyForOldAccount: 33334,
        transactionNewAccounts:
          "https://api.shasta.trongrid.io/v1/accounts/##USER_ADDRESS##/transactions?only_to=true",
      },
      // BNB: {
      //   URL: "https://data-seed-prebsc-1-s1.binance.org:8545",
      //   START_BLOCK: 26254689,
      //   CHAIN_URL: "https://api-testnet.bscscan.com/api",
      //   DEPOSIT_URL:
      //     "https://api-testnet.bscscan.com/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
      //   DEPOSIT_TOKEN_URL:
      //     "https://api-testnet.bscscan.com/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
      //   NETWORK_ID: 97,
      //   CHAIN_ID: 97,
      //   ADDRESS: "0x6E88d5b3C377E1534966F987d39A83856F30A8d6",
      //   PRIVATE_KEY:
      //     "",
      // },
      ETH: {
        URL: `https://sepolia.infura.io/v3/${envKey.INFURA_API_KEY}`,
        START_BLOCK: 8382463,
        DEPOSIT_URL: "https://api-sepolia.etherscan.io/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-etherscan-key>",
        DEPOSIT_TOKEN_URL: "https://api-sepolia.etherscan.io/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-etherscan-key>",
        ADDRESS: "0xC18C5b51E29FbF1Df1D8E2A07B3C435d6228587f",
        PRIVATE_KEY:
          "",
        API_KEY: process.env.GATEWAY_API_KEY,
        NETWORK_ID: 11155111,
        CHAIN_ID: 11155111,
      },
      POLYGON: {
        URL: `https://polygon-amoy.infura.io/v3/${envKey.INFURA_API_KEY}`,
        START_BLOCK: 22017406,
        CHAIN_URL: "https://api-amoy.polygonscan.com/api",
        DEPOSIT_URL:
          "https://api-amoy.polygonscan.com/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-polygonscan-key>",
        DEPOSIT_TOKEN_URL:
          "https://api-amoy.polygonscan.com/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-polygonscan-key>",
        NETWORK_ID: 80002,
        CHAIN_ID: 80002,
        ADDRESS: "0x7bd2EF5D14D0aEFCD7cd448a2E97ad3d444837B1",
        PRIVATE_KEY:
          "",
      },
    },
    BINANCE_GATE_WAY: {
      API_KEY: "",
      API_SECRET: "",
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
    MAILGUN_GATE_WAY: {
      API_KEY: process.env.GATEWAY_API_KEY,
      DOMAIN: "mg..com",
      URL: "https://api..net",
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
    SERVICE_WALLET_ETH_ID: process.env.ETH_WALLET_ID,
    SERVICE_WALLET_BNB_ID: process.env.BNB_WALLET_ID,
    COIN_GATE_WAY: {
      BTC: {
        URL: "http://localhost/no-coin-gateway-on-this-venue",
      },
      BNB: {
        URL: "https://data-seed-prebsc-1-s1.binance.org:8545",
        START_BLOCK: 52338388,
        CHAIN_URL: "https://api-testnet.bscscan.com/api",
        DEPOSIT_URL: "https://api-testnet.bscscan.com/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        DEPOSIT_TOKEN_URL: "https://api-testnet.bscscan.com/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        NETWORK_ID: 97,
        CHAIN_ID: 97,
        ADDRESS: "0x6E88d5b3C377E1534966F987d39A83856F30A8d6",
        PRIVATE_KEY: "",
      },
      BDYX: {
        URL: "https://mainnet-rpc.buddyscan.io",
        START_BLOCK: 1333985,
        CHAIN_URL: "https://buddyscan.io/api",
        DEPOSIT_URL:
          "https://buddyscan.io/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        DEPOSIT_TOKEN_URL:
          "https://buddyscan.io/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        NETWORK_ID: 62455,
        CHAIN_ID: 62455,
        // URL: "https://data-seed-prebsc-1-s1.binance.org:8545",
        // START_BLOCK: 1333985,
        // CHAIN_URL: "https://testnet-rpc.buddyscan.io",
        // DEPOSIT_URL:
        //   "https://testnet-rpc.buddyscan.io/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        // DEPOSIT_TOKEN_URL:
        //   "https://testnet-rpc.buddyscan.io/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-bscscan-key>",
        // NETWORK_ID: 61767,
        // CHAIN_ID: 61767,
        ADDRESS: "0xDcdAc55d2BB81d38D4a4A8F7dc6F1c3f0C8270AB",
        PRIVATE_KEY:
          "",
      },
      ETH: {
        URL: "https://1rpc.io/sepolia",
        START_BLOCK: 8382463,
        DEPOSIT_URL: "https://api-sepolia.etherscan.io/api",
        ADDRESS: "0xa938C1d4A16dFbA5ae83436f73828210BE139AE2",
        PRIVATE_KEY: "",
        API_KEY: process.env.GATEWAY_API_KEY,
        CHAIN_ID: 11155111,
        NETWORK_ID: 11155111,
      },
      TRX: {
        fullNode: "https://api.shasta.trongrid.io",
        solidityNode: "https://api.shasta.trongrid.io",
        eventServer: "https://api.shasta.trongrid.io",
        contractAddress: "",
        address: "",
        transactionUrl: "https://api.shasta.trongrid.io/v1/accounts/##USER_ADDRESS##/transactions?only_to=true&limit=50",
        transactionContractUrl: "https://api.shasta.trongrid.io/v1/accounts/##USER_ADDRESS##/transactions/trc20?limit=100&contract_address=##CONTRACT_ADDRESS##",
        decimal: 100000000, // 8
        tronDecimal: 1000000, // 6
        adminAmtSentToUser: 20,
        URL: "http://localhost/no-coin-gateway-on-this-venue",
        privateKey:
          "",
        address: "TXCMujsUvvG5GqYkSvZq1fCqJfEADTZeTT",
        resourceFeeOnNewAccount: 0.1,
        estBand: 268,
        estEnergyForNewAccount: 66667,
        estBandForToken: 346,
        estEnergyForOldAccount: 33334,
        transactionNewAccounts:
          "https://api.shasta.trongrid.io/v1/accounts/##USER_ADDRESS##/transactions?only_to=true",
      },
      POLYGON: {
        URL: "https://endpoints.omniatech.io/v1/matic/mumbai/public",
        START_BLOCK: 31349257,
        CHAIN_URL: "https://api-testnet.polygonscan.com/api",
        DEPOSIT_URL: "https://api-testnet.polygonscan.com/api?module=account&action=txlist&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-polygonscan-key>",
        DEPOSIT_TOKEN_URL: "https://api-testnet.polygonscan.com/api?module=account&action=tokentx&address=##USER_ADDRESS##&startblock=##START_BLOCK##&endblock=##END_BLOCK##&sort=asc&apikey=<REMOVED-polygonscan-key>",
        NETWORK_ID: 80001,
        CHAIN_ID: 80001,
        ADDRESS: "0xa938C1d4A16dFbA5ae83436f73828210BE139AE2",
        PRIVATE_KEY: "",
      },
    },
    BINANCE_GATE_WAY: {
      API_KEY: "",
      API_SECRET: "",
    },
    coinpaymentGateway: {
      PUBLIC_KEY: "",
      PRIVATE_KEY: "",
      IPN_SECRET: "",
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
    MAILGUN_GATE_WAY: {
      API_KEY: process.env.GATEWAY_API_KEY,
      DOMAIN: "mg..com",
      URL: "https://api.eu.mailgun.net",
    },
  };
}

export default {
  ...envKey,
  ...key,
};
