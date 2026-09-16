// import package
import mongoose from "mongoose";
import * as yup from "yup";

// import controller
import { isCryptoAddr } from "../controllers/coin.controller.js";

// import lib
import isEmpty from "../lib/isEmpty.js";

/**
 * User Withdraw
 * URL: /api/withdraw
 * METHOD : POST
 * BODY: currencyId, amount, bankId, twoFACode
 */
function yupToFormError(validationError) {
  if (isEmpty(validationError)) {
    return {};
  } else {
    let errors = validationError.inner.reduce((accessor, error) => {
      accessor[error.path] = error.message;
      return accessor;
    }, {});
    return errors;
  }
}
export const fiatWithdrawValidate = (req, res, next) => {
  let errors = {},
    reqBody = req.body;

  if (isEmpty(reqBody.currencyId)) {
    errors.currencyId = "REQUIRED";
  } else if (!mongoose.Types.ObjectId.isValid(reqBody.currencyId)) {
    errors.currencyId = "Invalid currency id";
  }

  if (isEmpty(reqBody.bankId)) {
    errors.bankId = "REQUIRED";
  } else if (!mongoose.Types.ObjectId.isValid(reqBody.bankId)) {
    errors.bankId = "INVALID_BANK_ACCOUNT";
  }

  if (isEmpty(reqBody.amount)) {
    errors.amount = "REQUIRED";
  } else if (isNaN(reqBody.amount)) {
    errors.amount = "ALLOW_NUMERIC";
  }

  // if (isEmpty(reqBody.twoFACode)) {
  //     errors.twoFACode = "REQUIRED";
  // } else if (isNaN(reqBody.twoFACode) || reqBody.twoFACode.length > 6) {
  //     errors.twoFACode = "INVALID_CODE";
  // }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

/**
 * Coin Withdraw
 * URL: /api/coinWithdraw
 * METHOD : POST
 * BODY: currencyId, destTag, amount, receiverAddress, twoFACode
 */
export const coinWithdrawValid = async (req, res, next) => {
  let errors = {},
    reqBody = req.body;

  if (isEmpty(reqBody.currencyId)) {
    errors.currencyId = "REQUIRED";
  } else if (!mongoose.Types.ObjectId.isValid(reqBody.currencyId)) {
    errors.currencyId = "Invalid currency id";
  }
  let isVal = await isCryptoAddr(
    reqBody.coin,
    reqBody.receiverAddress,
    reqBody.tokenType
  );
  console.log(isVal, "--------67");
  if (isEmpty(reqBody.receiverAddress)) {
    errors.receiverAddress = "REQUIRED";
  } else if (!isVal) {
    errors.receiverAddress = "Invalid Address";
  }

  if (reqBody.coin == "XRP") {
    if (isEmpty(reqBody.destTag)) {
      errors.destTag = "REQUIRED";
    }
  }

  if (isEmpty(reqBody.amount)) {
    errors.amount = "REQUIRED";
  } else if (isNaN(reqBody.amount)) {
    errors.amount = "ALLOW_NUMERIC";
  } else if (reqBody.amount < 0) {
    errors.amount = "INVALID_AMOUNT";
  }

  if (isEmpty(reqBody.twoFACode)) {
    errors.twoFACode = "REQUIRED";
  } else if (isNaN(reqBody.twoFACode) || reqBody.twoFACode.length > 6) {
    errors.twoFACode = "INVALID_CODE";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

/**
 * User Withdraw
 * URL: /api/fiatWithdraw
 * METHOD : PATCH
 * BODY: token
 */
export const tokenValid = (req, res, next) => {
  let errors = {},
    reqBody = req.body;
  console.log(reqBody, "reqBody");
  if (isEmpty(reqBody.token)) {
    errors.token = "REQUIRED";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ message: errors.token });
  }

  return next();
};

/**
 * Sent Deposit Request To Admin
 * URL: /api/fiatDeposit
 * METHOD : POST
 * BODY : userAssetId, amount, image
 */
export const depositReqtValid = (req, res, next) => {
  let errors = {},
    reqBody = req.body;

  if (isEmpty(reqBody.userAssetId)) {
    errors.userAssetId = "User Asset field is required";
  } else if (!mongoose.Types.ObjectId.isValid(reqBody.userAssetId)) {
    errors.userAssetId = "Invalid userAssetId";
  }

  if (isEmpty(reqBody.amount)) {
    errors.amount = "amount field is required";
  } else if (isNaN(reqBody.amount)) {
    errors.amount = "amount field is required";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }
  return next();
};

/**
 * Admin Approved Fiat Deposit Request
 * URL: /adminapi/fiatDeposit/approve
 * METHOD : POST
 * BODY : transactionId, amount
 */
export const fiatDepositApproveValid = (req, res, next) => {
  let errors = {},
    reqBody = req.body;

  if (isEmpty(reqBody.transactionId)) {
    errors.transactionId = "User Asset field is required";
  } else if (!mongoose.Types.ObjectId.isValid(reqBody.transactionId)) {
    errors.transactionId = "Invalid transactionId";
  }

  if (isEmpty(reqBody.amount)) {
    errors.amount = "amount field is required";
  } else if (isNaN(reqBody.amount)) {
    errors.amount = "amount field is required";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }
  return next();
};

/**
 * WALLET TRANSFER VALIDATION IS GONE, with the feature it validated.
 *
 * `TRANSFERABLE_WALLETS` and `walletTransferValid` checked a transfer's two
 * ends against the set of wallets this venue served. `spot` is the only pot,
 * and a spot -> spot move is not a transfer. POST /api/wallet/transfer now
 * refuses unconditionally with 410
 * (controllers/wallet.controller.js#walletTransfer), so there is no request
 * shape left to validate and nothing calls this.
 */

export const rejectcoinWithdraw = (req, res, next) => {
  let errors = {},
    reqBody = req.body;

  if (isEmpty(reqBody.reason)) {
    errors.reason = "Required";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }
  return next();
};

export const fiatDepositRejectValid = (req, res, next) => {
  let errors = {},
    reqBody = req.body;

  console.log(reqBody, "reqBodyreqBody");

  if (isEmpty(reqBody.decryptData)) {
    errors.decryptData = "User Asset field is required";
  } else if (!mongoose.Types.ObjectId.isValid(reqBody.decryptData)) {
    errors.decryptData = "Invalid transactionId";
  }
  if (isEmpty(reqBody.reason)) {
    errors.reason = "Reason required";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }
  return next();
};

export const rejectFiatWithdraw = (req, res, next) => {
  let errors = {},
    reqBody = req.body;

  if (isEmpty(reqBody.reason)) {
    errors.reason = "Required";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }
  return next();
};
export const updateGasStationConfig = async (req, res, next) => {
  try {
    const { body } = req;

    const schema = yup.object({
      gasThreshold: yup
        .number()
        .notOneOf([NaN, null, undefined], "Invalid value")
        .moreThan(0, "Should be higher than 0")
        .required("This field is required"),
      gasCap: yup
        .number()
        .notOneOf([NaN, null, undefined], "Invalid value")
        .moreThan(0, "Should be higher than 0")
        .required("This field is required"),
      maxGasPrice: yup
        .number()
        .notOneOf([NaN, null, undefined], "Invalid value")
        .moreThan(0, "Should be higher than 0")
        .required("This field is required"),
    });

    try {
      await schema.validate(body, { abortEarly: false });
      return next();
    } catch (error) {
      return res
        .status(400)
        .json({ success: false, errors: yupToFormError(error) });
    }
  } catch (error) {
    console.log(error);
    return res
      .status(500)
      .json({ success: false, message: "Something went wrong" });
  }
};
