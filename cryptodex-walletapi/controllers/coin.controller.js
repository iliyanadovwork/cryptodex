// import coin controller
import * as btcGateway from "./coin/btcGateway.js";
import * as ltcGateway from "./coin/ltcGateway.js";
import * as bnbGateway from "./coin/bnbGateway.js";
import * as ethGateway from "./coin/ethGateway.js";
import * as bdyxGateway from "./coin/bdyxGateway.js";
import * as polyGateway from "./coin/polyGateway.js";

// import lib
import isEmpty from "../lib/isEmpty.js";
import { encryptString } from "../lib/cryptoJS.js";

/**
 * Check Crypto Address
 * coin, tokenType, address
 */
import WAValidator from "multicoin-address-validator";
export const isCryptoAddr = async (coin, address, tokenType) => {
  try {
    if (isEmpty(coin)) {
      return false;
    }

    if (isEmpty(address)) {
      return false;
    }

    let currencySymbol = coin;
    if (currencySymbol == "BNB" || currencySymbol == "BDYX" || currencySymbol == "POLYGON") {
      currencySymbol = "ETH";
    }

    if (["erc20", "bep20", "trc20", "poly20"].includes(tokenType)) {
      currencySymbol =
        tokenType == "erc20" || tokenType == "bep20" || tokenType == "poly20" ? "ETH" : "TRX";
    }

    var valid = WAValidator.validate(address, currencySymbol);

    if (valid) {
      return true;
    } else {
      return false;
    }
  } catch (err) {
    console.log("Err on isCryptoAddr(): ", err);
    return false;
  }
};

export const generateCryptoAddr = async ({ currencyList = [], userId, botUser }) => {
  try {
    if (!Array.isArray(currencyList)) {
      return [];
    }

    let assetList = [];

    const evmCoins = ["BNB", "POLYGON", "ETH"];

    // PAPER TRADING: custody is stubbed, so a coin no longer needs a deposit
    // gateway to be holdable — every crypto currency gets a zero-balance asset
    // row. Without a row the coin can never be displayed, credited by a fill or
    // resolved by gRPC getUserAsset (which matches on currencyId).
    const isCryptoCurrency = (currency) => currency && currency.type === "crypto";

    if (botUser) {
      for (let currency of currencyList) {
        if (isCryptoCurrency(currency)) {
          assetList.push({
            _id: currency._id,
            currencyId: currency._id,
            coin: currency.coin,
            address: "",
            privateKey: "",
          });
        }
      }
      return assetList;
    }

    let evmWallet = {
      address: null,
      privateKey: null,
    };

    const hasEvmCoin = currencyList.some(
      currency => isCryptoCurrency(currency) && evmCoins.includes(currency.coin)
    );

    if (hasEvmCoin) {
      let evmResp = null;
      try {
        evmResp = await bnbGateway.createAddress();
      } catch (err) {
        console.warn("BNB gateway failed, trying Polygon...");
      }

      if (!evmResp) {
        try {
          evmResp = await polyGateway.createAddress();
        } catch (err) {
          console.warn("Polygon gateway failed, trying Ethereum...");
        }
      }

      if (!evmResp) {
        try {
          evmResp = await ethGateway.createAddress();
        } catch (err) {
          console.error("All EVM gateways failed.");
        }
      }

      if (evmResp) {
        evmWallet.address = evmResp.address;
        evmWallet.privateKey = !isEmpty(evmResp.privateKey)
          ? encryptString(evmResp.privateKey)
          : "";
      }
    }

    for (let currency of currencyList) {
      if (!isCryptoCurrency(currency)) {
        continue;
      }

      let address = "";
      let privateKey = "";

      if (evmCoins.includes(currency.coin)) {
        if (!isEmpty(evmWallet.address)) {
          address = evmWallet.address;
          privateKey = evmWallet.privateKey || "";
        }
      } else if (currency.coin === "BTC") {
        const btcResp = await btcGateway.createAddress({ userId });
        if (btcResp) {
          address = btcResp.address;
          privateKey = !isEmpty(btcResp.privateKey)
            ? encryptString(btcResp.privateKey)
            : "";
        }
      } else if (currency.coin === "LTC") {
        const ltcResp = await ltcGateway.createAddress({ userId });
        if (ltcResp) {
          address = ltcResp.address;
          privateKey = !isEmpty(ltcResp.privateKey)
            ? encryptString(ltcResp.privateKey)
            : "";
        }
      }

      // Coins with no gateway (e.g. SOL, USDC) still get a row — a paper wallet
      // holds the balance, the address is meaningless.
      assetList.push({
        _id: currency._id,
        currencyId: currency._id,
        coin: currency.coin,
        address,
        privateKey,
      });
    }

    return assetList;
  } catch (err) {
    console.log(err, "err");
    return [];
  }
};


export const generateTokenAddr = async ({ currencyList = [], walletList = [], botUser = false }) => {
  try {
    console.log("Generate Token Asset call");

    if (!Array.isArray(currencyList)) return [];

    const assetList = [];

    if (botUser) {
      for (const currency of currencyList) {
        const { depositType, tokenType, _id, status, coin } = currency;

        if (depositType !== "local" || !["bep20", "poly20", "erc20"].includes(tokenType)) {
          continue;
        }

        const tokenObj = {
          address: "",
          privateKey: "",
          currencyId: _id,
          tokenType,
          status,
        };

        const existingAsset = assetList.find(asset => asset.coin === coin);

        if (existingAsset) {
          existingAsset.tokenAddressArray.push(tokenObj);
        } else {
          assetList.push({
            _id,
            coin,
            address: "",
            privateKey: "",
            tokenAddressArray: [tokenObj],
          });
        }
      }

      return assetList;
    }

    const evmData = Array.isArray(walletList) && walletList.length > 0
      ? walletList.find(asset => ["BNB", "POLYGON", "ETH"].includes(asset.coin))
      : null;

    const createNewAddress = async (tokenType) => {
      switch (tokenType) {
        case "bep20":
          return await bnbGateway.createAddress();
        case "poly20":
          return await polyGateway.createAddress();
        case "erc20":
          return await ethGateway.createAddress();
        default:
          return null;
      }
    };

    for (const currency of currencyList) {
      const { depositType, tokenType, _id, status, coin } = currency;

      if (depositType !== "local" || !["bep20", "poly20", "erc20"].includes(tokenType)) {
        continue;
      }

      let addressData = null;

      if (evmData?.address) {
        addressData = {
          address: evmData.address,
          privateKey: evmData.privateKey,
        };
      } else {
        const newAddress = await createNewAddress(tokenType);
        if (newAddress) {
          addressData = {
            address: newAddress.address,
            privateKey: newAddress.privateKey,
          };
        }
      }

      if (!addressData) continue;

      const tokenObj = {
        ...addressData,
        currencyId: _id,
        tokenType,
        status,
      };

      const existingAsset = assetList.find(asset => asset.coin === coin);

      if (existingAsset) {
        existingAsset.tokenAddressArray.push(tokenObj);
      } else {
        assetList.push({
          _id,
          coin,
          address: "",
          privateKey: "",
          tokenAddressArray: [tokenObj],
        });
      }
    }

    return assetList;
  } catch (err) {
    console.error("Error in generateTokenAddr():", err);
    return [];
  }
};


export const generateFiatAddr = async ({ currencyList = [] }) => {
  try {
    if (!Array.isArray(currencyList)) {
      return [];
    }

    let assetList = [];
    for (let currency of currencyList) {
      if (currency && currency.type == "fiat") {
        let assetObj = {
          _id: currency._id,
          currencyId: currency._id,
          coin: currency.coin,
          address: currency._id,
          privateKey: "",
        };
        assetList.push(assetObj);
      }
    }
    return assetList;
  } catch (err) {
    return [];
  }
};

export const generateTokenAddcreateForOldUser = async (currency) => {
  try {
    if (currency && currency.depositType == "local" && currency.tokenType == "bep20") {
      let bep20Resp = await bnbGateway.createAddress();
      if (bep20Resp.address) {
        let tokenarrayObj = {};
        if (bep20Resp) {
          tokenarrayObj = {
            address: bep20Resp.address,
            privateKey: encryptString(bep20Resp.privateKey),
            currencyId: currency._id,
            tokenType: "bep20",
            status: currency.status,
            blockNo: 0,
          };
        }
        return tokenarrayObj;
      }
    }
  } catch (err) {
    console.log("err on generateTokenAddcreateForOldUser(): ", err);
    return [];
  }
};