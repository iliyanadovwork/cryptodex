// import package
import multer from "multer";
import path from "path";
import axios from "axios";
// import model
import { Currency } from "../models/index.js";

// import config
import config from "../config/index.js";

// import controller
import { addPriceCNV } from "./priceCNV.controller.js";

// import lib
import imageFilter from "../lib/imageFilter.js";
import { paginationQuery, columnFillter } from "../lib/adminHelpers.js";
import isEmpty from "../lib/isEmpty.js";
// Every currency answer carries the precision its balances are shown to.
import { withDisplayDecimalsList } from "../lib/currencyDecimals.js";

// `import { trxServSign } from "../config/jwt.js"` stood here. `trxServSign`
// was never called anywhere in this file - the import alone was enough to drag
// config/jwt.js onto this service's boot chain, and that module read three RSA
// PRIVATE KEYS (config/{eth,bnb,trx}_private_key.pem) into memory at module
// scope. They signed service-to-service tokens for on-chain gateway services,
// which this venue does not have and never calls. The import, the module and
// the six .pem files are all deleted.
import { getAssets } from "../controllers/coin/firebase.js";
import { hset } from "../controllers/redis.controller.js";

/**
 * Multer Image Uploade
 */
const currencyStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, config.IMAGE.CURRENCY_PATH);
  },

  // By default, multer removes file extensions so let's add them back
  filename: function (req, file, cb) {
    cb(null, "currency-" + Date.now() + path.extname(file.originalname));
  },
});

let currencyUpload = multer({
  storage: currencyStorage,
  onError: function (err, next) {
    next(err);
  },
  fileFilter: imageFilter,
  limits: { fileSize: config.IMAGE.CURRENCY_SIZE },
}).fields([{ name: "image", maxCount: 1 }]);


export const getCurrency = (req, res) => {
  Currency.aggregate(
    [
      { $match: { status: "active" } },
      {
        $project: {
          name: 1,
          coin: 1,
          symbol: 1,
          tokenType: 1,
          type: 1,
          withdrawFee: 1,
          minimumWithdraw: 1,
          minimumDeposit: 1,
          maximumDeposit: 1,
          bankDetails: 1,
          decimals: 1,
          // Projected so resolveDisplayDecimals can read the field the
          // currency's own `type` says is authoritative. It was absent here
          // entirely, so a token's precision could not even be resolved.
          contractDecimal: 1,
          image: {
            $cond: [
              { $eq: ["$image", ""] },
              "",
              {
                $concat: [
                  config.SERVER_URL,
                  config.IMAGE.CURRENCY_URL_PATH,
                  "$image",
                ],
              },
            ],
          },
        },
      },
    ],
    (err, data) => {
      if (err) {
        console.log(err, "errerr");
        return res
          .status(500)
          .json({ success: false, message: "Something Wrong" });
      }
      return res.status(200).json({
        success: true,
        message: "FETCH_SUCCESS",
        result: withDisplayDecimalsList(data),
      });
    }
  );
};


/**
 * Get All Currency List
 * URL : /adminapi/currency
 * METHOD : GET
 */

/**
 * /adminapi/getCurrencyList
 *
 */
export const getCurrencyList = (req, res) => {
  Currency.aggregate(
    [
      {
        $project: {
          name: 1,
          coin: 1,
          symbol: 1,
          tokenType: 1,
          type: 1,
          withdrawFee: 1,
          minimumWithdraw: 1,
          minimumDeposit: 1,
          maximumDeposit: 1,
          maximumWithdraw: 1,
          bankDetails: 1,
          status: 1,
          depositStatus: 1,
          withdrawStatus: 1,
          image: {
            $cond: [
              { $eq: ["$image", ""] },
              "",
              {
                $concat: [
                  config.SERVER_URL,
                  config.IMAGE.CURRENCY_URL_PATH,
                  "$image",
                ],
              },
            ],
          },
          decimals: 1,
          contractDecimal: 1,
        },
      },
    ],
    (err, data) => {
      if (err) {
        return res
          .status(500)
          .json({ success: false, message: "Something Wrong" });
      }
      // `contractDecimal` was projected but absent from every seeded document,
      // so this list answered `undefined` precision for every coin. See
      // lib/currencyDecimals.js for what that blanked downstream.
      return res.status(200).json({
        success: true,
        message: "FETCH_SUCCESS",
        result: withDisplayDecimalsList(data),
      });
    }
  );
};

/**
 * Add Currency
 * URL : /adminapi/currency
 * METHOD : POST
 * BODY : name, symbol, coin, image, contractAddress, minABI, decimals, tokenType, bankName, accountNo, holderName, bankcode, country, withdrawFee, minimumWithdraw, depositType
 */

/**
 * Update Currency
 * URL : /adminapi/currency
 * METHOD : PUT
 * BODY : currencyId, name, coin, symbol, image, contractAddress, minABI, decimals, tokenType, bankName, accountNo, holderName, bankcode, country, withdrawFee, minimumWithdraw, depositType
 */

/**
 * Get Language Dropdown
 * URL : /adminapi/getLanguage
 * METHOD : GET
 */
export const getLanguage = async (req, res) => {
  Language.find(
    { status: "active" },
    { _id: 1, code: 1, name: 1, isPrimary: 1, status: 1 },
    (err, data) => {
      if (err) {
        return res
          .status(500)
          .json({ success: false, message: "Something went wrong" });
      }
      return res
        .status(200)
        .json({ success: true, message: "Fetch successfully", result: data });
    }
  );
};

export const getCurrencyId = async (reqBody) => {
  try {
    let curData = await Currency.findOne(
      { _id: reqBody.id },
      { coin: 1, image: 1 }
    ).lean();
    if (!curData) {
      return { success: false };
    }
    return { status: true, ...curData };
  } catch (err) {
    return { success: false };
  }
};

export const getCurrencySymbol = async (reqBody) => {
  try {
    let curData = await Currency.findOne(
      { symbol: new RegExp(reqBody.currencySymbol, "i") },
      { coin: 1, image: 1, _id: 1 }
    ).lean();
    if (!curData) {
      return { success: false };
    }
    let result = {
      currencyName: curData.coin,
      currencyImage:
        config.SERVER_URL + config.IMAGE.CURRENCY_URL_PATH + curData.image,
      id: String(curData._id),
    };
    return { status: true, ...result };
  } catch (err) {
    return { success: false };
  }
};

export const currencyUpdateRedis = async () => {
  try {
    let curData = await Currency.find({});

    if (!curData) {
      return { success: false };
    }
    for (const coin of curData) {
      await hset("currecny", coin._id.toString(), coin);
    }

    return { status: true };
  } catch (err) {
    console.log("currencyUpdateRedis_err", err);
    return { success: false };
  }
};

currencyUpdateRedis();
