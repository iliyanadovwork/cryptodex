// import package
import Web3 from "web3";
import config from "../config/index.js";
// import TronWeb from "tronweb";
// import lib
import isEmpty, { isBoolean } from "../lib/isEmpty.js";
// const HttpProvider = TronWeb.providers.HttpProvider,
//   fullNode = new HttpProvider(config.COIN_GATE_WAY.TRX.fullNode),
//   solidityNode = new HttpProvider(config.COIN_GATE_WAY.TRX.solidityNode),
//   eventServer = new HttpProvider(config.COIN_GATE_WAY.TRX.eventServer);
// let tronWeb = new TronWeb(fullNode, solidityNode, eventServer);

const web3 = new Web3(config.COIN_GATE_WAY.BNB.URL);
export const cryptoValidation = (req, res, next) => {
  let errors = {}, reqBody = req.body, reqFile = req.files;
  let onlylett = /^[a-zA-Z0-9_]+$/;
  let AlphaWithSpace = /^[a-zA-Z0-9_\s]*$/;
  // if (isEmpty(reqBody.name)) {
  //   errors.name = "Name Field Is Required";
  // }

  // if (isEmpty(reqBody.coin)) {
  //   errors.coin = "Coin Field Is Required";
  // }

  // if (isEmpty(reqBody.symbol)) {
  //   errors.symbol = "Symbol Field Is Required";
  // }
  if (isEmpty(reqBody.name)) {
    errors.name = "Name Field Is Required";
  }
  else if (!AlphaWithSpace.test(reqBody.name)) {
    errors.name = "Name Field must contain only Alphabets";
  }

  if (isEmpty(reqBody.coin)) {
    errors.coin = "Coin Field Is Required";
  }
  else if (!onlylett.test(reqBody.coin)) {
    errors.coin = "Coin Field must contain only Alphabets";
  }


  if (isEmpty(reqBody.symbol)) {
    errors.symbol = "Symbol Field Is Required";
  }
  else if (!onlylett.test(reqBody.symbol)) {
    errors.symbol = "Symbol Field must contain only Alphabets";
  }
  if (isEmpty(reqFile.image)) {
    errors.image = "Image Field is Required";
  }

  if (isEmpty(reqBody.contractDecimal)/*  || reqBody.contractDecimal == 0 */) {
    errors.contractDecimal = "Enter Valid Contract Decimal";
  } else if (
    !isEmpty(reqBody.contractDecimal) &&
    isNaN(reqBody.contractDecimal)
  ) {
    errors.contractDecimal = "Only Allow Numeric";
  } else if (parseInt(reqBody.contractDecimal) < 0) {
    errors.contractDecimal = "Enter Valid Contract Decimal";
  }

  if (isEmpty(reqBody.withdrawFee)/*  || reqBody.withdrawFee == 0 */) {
    errors.withdrawFee = "Enter Valid Withdraw Fee";
  } else if (!isEmpty(reqBody.withdrawFee) && isNaN(reqBody.withdrawFee)) {
    errors.withdrawFee = "Only Allow Numeric";
  } else if (parseFloat(reqBody.withdrawFee) < 0) {
    errors.withdrawFee = "Enter Valid Contract Decimal";
  }

  if (isEmpty(reqBody.minimumWithdraw) || reqBody.minimumWithdraw == 0) {
    errors.minimumWithdraw = "Enter Valid Minimum Withdraw";
  } else if (
    !isEmpty(reqBody.minimumWithdraw) &&
    isNaN(reqBody.minimumWithdraw)
  ) {
    errors.minimumWithdraw = "Only Allow Numeric";
  } else if (parseFloat(reqBody.minimumWithdraw) < 0) {
    errors.minimumWithdraw = "Invalid Value";
  }
  if (isEmpty(reqBody.maximumWithdraw) || reqBody.maximumWithdraw == 0) {
    errors.maximumWithdraw = "Enter Valid Maximum Withdraw";
  } else if (!isEmpty(reqBody.maximumWithdraw) && isNaN(reqBody.maximumWithdraw)) {
    errors.maximumWithdraw = "Only Allow Numeric";
  } else if (parseFloat(reqBody.maximumWithdraw) < 0) {
    errors.maximumWithdraw = "Invalid Value";
  } else if (parseFloat(reqBody.minimumWithdraw) >= parseFloat(reqBody.maximumWithdraw)) {
    errors.minimumWithdraw = "Minimum withdraw not more than Maximum withdraw";
  }

  if (isEmpty(reqBody.minimumDeposit) || reqBody.minimumDeposit == 0) {
    errors.minimumDeposit = "Enter Valid Minimum Deposit";
  } else if (!isEmpty(reqBody.minimumDeposit) && isNaN(reqBody.minimumDeposit)) {
    errors.minimumDeposit = "Only Allow Numeric";
  } else if (parseFloat(reqBody.minimumDeposit) < 0) {
    errors.minimumDeposit = "Invalid Value";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};
export const tokenValidation = async (req, res, next) => {
  let errors = {}, reqBody = req.body, reqFile = req.files;
  let onlylett = /^[a-zA-Z0-9_]+$/;
  let AlphaWithSpace = /^[a-zA-Z_\s]*$/;
  // if (isEmpty(reqBody.name)) {
  //   errors.name = "Name Field Is Required";
  // }

  // if (isEmpty(reqBody.coin)) {
  //   errors.coin = "Coin Field Is Required";
  // }

  // if (isEmpty(reqBody.symbol)) {
  //   errors.symbol = "Symbol Field Is Required";
  // }
  if (isEmpty(reqBody.name)) {
    errors.name = "Name Field Is Required";
  } else if (!AlphaWithSpace.test(reqBody.name)) {
    errors.name = "Name Field must contain only Alphabets";
  }

  if (isEmpty(reqBody.coin)) {
    errors.coin = "Coin Field Is Required";
  } else if (!onlylett.test(reqBody.coin)) {
    errors.coin = "Coin Field must contain only Alphabets";
  }


  if (isEmpty(reqBody.symbol)) {
    errors.symbol = "Symbol Field Is Required";
  } else if (!onlylett.test(reqBody.symbol)) {
    errors.symbol = "Symbol Field must contain only Alphabets";
  }
  if (isEmpty(reqFile.image)) {
    errors.image = "Image Field Is Required";
  }

  if (isEmpty(reqBody.contractAddress)) {
    errors.contractAddress = "Contract Address Field Required";
  }
  // if (reqBody.tokenType === "bep20" || reqBody.tokenType === "erc20" || reqBody.tokenType === "poly20") {
  //   let isToken = await web3.utils.isAddress(reqBody.contractAddress)
  //   if (!isToken) {
  //     errors.contractAddress = `Invalid ${reqBody.tokenType === "bep20" ? "BEP20" : reqBody.tokenType === "poly20" ? "POLY20" : "ERC20"} Contract Address`;
  //   }
  // }
  // if (reqBody.tokenType === "trc20") {
  //   let isToken = await tronWeb.isAddress(reqBody.contractAddress)
  //   if (!isToken) {
  //     errors.contractAddress = "Invalid TRC20 Contract Address";
  //   }
  // }
  // if (isEmpty(reqBody.minABI)) {
  //   errors.minABI = "Min ABI Field Is Required";
  // }
  if (isEmpty(reqBody.decimals)) {
    errors.decimals = "Decimals Field Is Required";
  } else if (isNaN(reqBody.decimals)) {
    errors.decimals = "Only Allow Numeric";
  } else if (parseInt(reqBody.decimals) <= 0) {
    errors.decimals = "Invalid Value";
  }
  if (isEmpty(reqBody.tokenType)) {
    errors.tokenType = "Token Type Field Required";
  } else if (!["erc20", "trc20", "bep20", "poly20"].includes(reqBody.tokenType)) {
    errors.tokenType = "Invalid Type";
  }
  if (isEmpty(reqBody.contractDecimal)/*  || reqBody.contractDecimal == 0 */) {
    errors.contractDecimal = "Enter Valid Contract Decimal";
  } else if (!isEmpty(reqBody.contractDecimal) && isNaN(reqBody.contractDecimal)) {
    errors.contractDecimal = "Only Allow Numeric";
  } else if (parseInt(reqBody.contractDecimal) < 0) {
    errors.contractDecimal = "Invalid Value";
  }

  if (isEmpty(reqBody.withdrawFee)/*  || reqBody.withdrawFee == 0 */) {
    errors.withdrawFee = "Enter Valid Withdraw Fee";
  } else if (!isEmpty(reqBody.withdrawFee) && isNaN(reqBody.withdrawFee)) {
    errors.withdrawFee = "Only Allow Numeric";
  } else if (parseFloat(reqBody.withdrawFee) < 0) {
    errors.withdrawFee = "Invalid Value";
  }

  if (isEmpty(reqBody.minimumWithdraw) || reqBody.minimumWithdraw == 0) {
    errors.minimumWithdraw = "Enter valid Minimum Withdraw";
  } else if (!isEmpty(reqBody.minimumWithdraw) && isNaN(reqBody.minimumWithdraw)) {
    errors.minimumWithdraw = "Only Allow Numeric";
  } else if (parseFloat(reqBody.minimumWithdraw) < 0) {
    errors.minimumWithdraw = "Invalid Value";
  }
  if (isEmpty(reqBody.maximumWithdraw) || reqBody.maximumWithdraw == 0) {
    errors.maximumWithdraw = "Enter valid Maximum Withdraw";
  } else if (!isEmpty(reqBody.maximumWithdraw) && isNaN(reqBody.maximumWithdraw)) {
    errors.maximumWithdraw = "Only Allow Numeric";
  } else if (parseFloat(reqBody.maximumWithdraw) < 0) {
    errors.maximumWithdraw = "Invalid Value";
  } else if (parseFloat(reqBody.minimumWithdraw) >= parseFloat(reqBody.maximumWithdraw)) {
    errors.minimumWithdraw = "Minimum withdraw not more than Maximum withdraw";
  }


  if (isEmpty(reqBody.minimumDeposit) || reqBody.minimumDeposit == 0) {
    errors.minimumDeposit = "Enter Valid Minimum Deposit";
  } else if (!isEmpty(reqBody.minimumDeposit) && isNaN(reqBody.minimumDeposit)) {
    errors.minimumDeposit = "Only Allow Numeric";
  } else if (parseFloat(reqBody.minimumDeposit) < 0) {
    errors.minimumDeposit = "Invalid Value";
  }
  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

export const fiatValidation = (req, res, next) => {
  let errors = {}, reqBody = req.body, reqFile = req.files;
  let onlylett = /^[A-Za-z]+$/, AlphaWithSpace = /^[a-zA-Z\s]*$/;
  if (isEmpty(reqBody.name)) {
    errors.name = "Name Field Is Required";
  } else if (!AlphaWithSpace.test(reqBody.name)) {
    errors.name = "Name Field must contain only Alphabets";
  }

  if (isEmpty(reqBody.coin)) {
    errors.coin = "Coin Field Is Required";
  } else if (!onlylett.test(reqBody.coin)) {
    errors.coin = "Coin Field must contain only Alphabets";
  }


  if (isEmpty(reqBody.symbol)) {
    errors.symbol = "Symbol Field Is Required";
  } else if (!onlylett.test(reqBody.symbol)) {
    errors.symbol = "Symbol Field must contain only Alphabets";
  }

  if (isEmpty(reqFile.image)) {
    errors.image = "REQUIRED";
  }

  // if (isEmpty(reqBody.contractDecimal)/*  || reqBody.contractDecimal == 0 */) {
  //   errors.contractDecimal = "Enter Valid Contract Decimal";
  // } else if (!isEmpty(reqBody.contractDecimal) && isNaN(reqBody.contractDecimal)) {
  //   errors.contractDecimal = "Only Allow Numeric";
  // } else if (parseInt(reqBody.contractDecimal) < 0) {
  //   errors.contractDecimal = "Enter Valid Contract Decimal";
  // }

  // if (isEmpty(reqBody.withdrawFee) /* || reqBody.withdrawFee == 0 */) {
  //   errors.withdrawFee = "Enter Valid Withdraw Fee";
  // } else if (!isEmpty(reqBody.withdrawFee) && isNaN(reqBody.withdrawFee)) {
  //   errors.withdrawFee = "Only Allow Numeric";
  // } else if (parseInt(reqBody.withdrawFee) < 0) {
  //   errors.withdrawFee = "Invalid Value";
  // }

  // if (isEmpty(reqBody.minimumWithdraw) || reqBody.minimumWithdraw == 0) {
  //   errors.minimumWithdraw = "Enter Valid Minimum Withdraw";
  // } else if (!isEmpty(reqBody.minimumWithdraw) && isNaN(reqBody.minimumWithdraw)) {
  //   errors.minimumWithdraw = "Only Allow Numeric";
  // } else if (parseInt(reqBody.minimumWithdraw) < 0) {
  //   errors.minimumWithdraw = "Invalid Value";
  // }
  // if (isEmpty(reqBody.maximumWithdraw) || reqBody.maximumWithdraw == 0) {
  //   errors.maximumWithdraw = "Enter Valid Minimum Withdraw";
  // } else if (!isEmpty(reqBody.maximumWithdraw) && isNaN(reqBody.maximumWithdraw)) {
  //   errors.maximumWithdraw = "Only Allow Numeric";
  // } else if (parseInt(reqBody.maximumWithdraw) < 0) {
  //   errors.maximumWithdraw = "Invalid Value";
  // } else if (parseInt(reqBody.minimumWithdraw) >= parseInt(reqBody.maximumWithdraw)) {
  //   errors.minimumWithdraw = "Minimum withdraw not more than Maximum withdraw";
  // }

  // if (isEmpty(reqBody.minimumDeposit) || reqBody.minimumDeposit == 0) {
  //   errors.minimumDeposit = "Enter Valid Minimum Deposit";
  // } else if (!isEmpty(reqBody.minimumDeposit) && isNaN(reqBody.minimumDeposit)) {
  //   errors.minimumDeposit = "Only Allow Numeric";
  // } else if (parseInt(reqBody.minimumDeposit) < 0) {
  //   errors.minimumDeposit = "Invalid Value";
  // }

  // if (isEmpty(reqBody.bankName)) {
  //   errors.bankName = "Bank Name Field Is Required";
  // } else if (!onlylett.test(reqBody.bankName)) {
  //   errors.bankName = "Bank Name Field must not be in numerics";
  // }

  // if (isEmpty(reqBody.accountNo)) {
  //   errors.accountNo = "Account Number Field Is Required";
  // }

  // if (isEmpty(reqBody.holderName)) {
  //   errors.holderName = "Holder Name Field Is Required";
  // } else if (!AlphaWithSpace.test(reqBody.holderName)) {
  //   errors.holderName = "Holder Name Field must not be in numerics";
  // }

  // if (isEmpty(reqBody.bankcode)) {
  //   errors.bankcode = "IBN Code Field Is Required";
  // }
  // if (isEmpty(reqBody.country)) {
  //   errors.country = "Country Field Is Required";
  // }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

export const editCryptoValidation = (req, res, next) => {
  let errors = {},
    reqBody = req.body,
    reqFile = req.files;
  let onlylett = /^[a-zA-Z0-9_]+$/;
  let AlphaWithSpace = /^[a-zA-Z0-9_\s]*$/;
  // if (isEmpty(reqBody.name)) {
  //   errors.name = "Name Field Is Required";
  // }

  // if (isEmpty(reqBody.coin)) {
  //   errors.coin = "Coin Field Is Required";
  // }

  // if (isEmpty(reqBody.symbol)) {
  //   errors.symbol = "Symbol Field Is Required";
  // }
  if (isEmpty(reqBody.name)) {
    errors.name = "Name Field Is Required";
  }
  else if (!onlylett.test(reqBody.name)) {
    errors.name = "Name Field must contain only Alphabets";
  }

  if (isEmpty(reqBody.coin)) {
    errors.coin = "Coin Field Is Required";
  }
  else if (!onlylett.test(reqBody.coin)) {
    errors.coin = "Coin Field must contain only Alphabets";
  }

  if (isEmpty(reqBody.symbol)) {
    errors.symbol = "Symbol Field Is Required";
  }
  else if (!onlylett.test(reqBody.symbol)) {
    errors.symbol = "Symbol Field must contain only Alphabets";
  }
  if (reqFile && isEmpty(reqFile.image) && reqBody && isEmpty(reqBody.image)) {
    errors.image = "Image Field Is Required";
  }

  if (isEmpty(reqBody.contractDecimal) || reqBody.contractDecimal == 0) {
    errors.contractDecimal = "Enter Valid Contract Decimal";
  } else if (
    !isEmpty(reqBody.contractDecimal) &&
    isNaN(reqBody.contractDecimal)
  ) {
    errors.contractDecimal = "Only Allow Numeric";
  } else if (parseInt(reqBody.contractDecimal) < 0) {
    errors.contractDecimal = "Invalid Value";
  }

  if (isEmpty(reqBody.withdrawFee) || reqBody.withdrawFee == 0) {
    errors.withdrawFee = "Enter Valid Withdraw Fee";
  } else if (!isEmpty(reqBody.withdrawFee) && isNaN(reqBody.withdrawFee)) {
    errors.withdrawFee = "Only Allow Numeric";
  } else if (parseInt(reqBody.withdrawFee) < 0) {
    errors.withdrawFee = "Invalid Value";
  }

  if (isEmpty(reqBody.minimumWithdraw) || reqBody.minimumWithdraw == 0) {
    errors.minimumWithdraw = "Enter Valid Minimum Withdraw";
  } else if (
    !isEmpty(reqBody.minimumWithdraw) &&
    isNaN(reqBody.minimumWithdraw)
  ) {
    errors.minimumWithdraw = "Only Allow Numeric";
  } else if (parseInt(reqBody.minimumWithdraw) < 0) {
    errors.minimumWithdraw = "Invalid Value";
  }
  if (isEmpty(reqBody.maximumWithdraw) || reqBody.maximumWithdraw == 0) {
    errors.maximumWithdraw = "Enter Valid Minimum Withdraw";
  } else if (
    !isEmpty(reqBody.maximumWithdraw) &&
    isNaN(reqBody.maximumWithdraw)
  ) {
    errors.maximumWithdraw = "Only Allow Numeric";
  } else if (parseInt(reqBody.maximumWithdraw) < 0) {
    errors.maximumWithdraw = "Invalid Value";
  } else if (parseInt(reqBody.minimumWithdraw) >= parseInt(reqBody.maximumWithdraw)) {
    errors.minimumWithdraw = "Minimum withdraw not more than Maximum withdraw";
  }

  if (isEmpty(reqBody.minimumDeposit) || reqBody.minimumDeposit == 0) {
    errors.minimumDeposit = "Enter Valid Minimum Deposit";
  } else if (
    !isEmpty(reqBody.minimumDeposit) &&
    isNaN(reqBody.minimumDeposit)
  ) {
    errors.minimumDeposit = "Only Allow Numeric";
  } else if (parseInt(reqBody.minimumDeposit) < 0) {
    errors.minimumDeposit = "Invalid Value";
  }
  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};
export const editTokenValidation = async (req, res, next) => {
  let errors = {},
    reqBody = req.body,
    reqFile = req.files;
  let onlylett = /^[a-zA-Z0-9_]+$/;
  let AlphaWithSpace = /^[a-zA-Z0-9_\s]*$/;
  // if (isEmpty(reqBody.name)) {
  //   errors.name = "Name Field Is Required";
  // }

  // if (isEmpty(reqBody.coin)) {
  //   errors.coin = "Coin Field Is Required";
  // }

  // if (isEmpty(reqBody.symbol)) {
  //   errors.symbol = "Symbol Field Is Required";
  // }
  if (isEmpty(reqBody.name)) {
    errors.name = "Name Field Is Required";
  }
  else if (!onlylett.test(reqBody.name)) {
    errors.name = "Name Field must contain only Alphabets";
  }

  if (isEmpty(reqBody.coin)) {
    errors.coin = "Coin Field Is Required";
  }
  else if (!onlylett.test(reqBody.coin)) {
    errors.coin = "Coin Field must contain only Alphabets";
  }

  if (isEmpty(reqBody.symbol)) {
    errors.symbol = "Symbol Field Is Required";
  }
  else if (!onlylett.test(reqBody.symbol)) {
    errors.symbol = "Symbol Field must contain only Alphabets";
  }
  if (reqFile && isEmpty(reqFile.image) && reqBody && isEmpty(reqBody.image)) {
    errors.image = "Image Field Is Required";
  }

  if (isEmpty(reqBody.contractAddress)) {
    errors.contractAddress = "Contract Address Field Required";
  }
  if (isEmpty(reqBody.contractAddress)) {
    errors.contractAddress = "Contract Address Field Required";
  }
  if (reqBody.tokenType === "bep20") {
    const isToken = await web3.utils.isAddress(reqBody.contractAddress)
    console.log("IS_TOKEN", isToken)
    if (!isToken) {
      errors.contractAddress = "Invalid BEP20 Contract Address";
    }
  }
  if (reqBody.tokenType === "trc20") {
    const isToken = await tronWeb.isAddress(reqBody.contractAddress)
    console.log("IS_TRC_20", isToken)
    if (!isToken) {
      errors.contractAddress = "Invalid TRC20 Contract Address";
    }
  }
  // if (isEmpty(reqBody.minABI)) {
  //   errors.minABI = "Min ABI Field Is Required";
  // }
  if (isEmpty(reqBody.decimals)) {
    errors.decimals = "Decimals Field Is Required";
  } else if (isNaN(reqBody.decimals)) {
    errors.decimals = "Only Allow Numeric";
  } else if (parseInt(reqBody.decimals) <= 0) {
    errors.decimals = "Invalid Value";
  }
  if (isEmpty(reqBody.tokenType)) {
    errors.tokenType = "Token Type Field Required";
  } else if (!["erc20", "trc20", "bep20", "poly20"].includes(reqBody.tokenType)) {
    errors.tokenType = "Invalid Type";
  }
  if (isEmpty(reqBody.contractDecimal) || reqBody.contractDecimal == 0) {
    errors.contractDecimal = "Enter Valid Contract Decimal";
  } else if (
    !isEmpty(reqBody.contractDecimal) &&
    isNaN(reqBody.contractDecimal)
  ) {
    errors.contractDecimal = "Only Allow Numeric";
  } else if (parseInt(reqBody.contractDecimal) < 0) {
    errors.contractDecimal = "Invalid Value";
  }

  if (isEmpty(reqBody.withdrawFee) || reqBody.withdrawFee == 0) {
    errors.withdrawFee = "Enter Valid Withdraw Fee";
  } else if (!isEmpty(reqBody.withdrawFee) && isNaN(reqBody.withdrawFee)) {
    errors.withdrawFee = "Only Allow Numeric";
  } else if (parseInt(reqBody.withdrawFee) < 0) {
    errors.withdrawFee = "Invalid Value";
  }

  if (isEmpty(reqBody.minimumWithdraw) || reqBody.minimumWithdraw == 0) {
    errors.minimumWithdraw = "Enter valid Minimum Withdraw";
  } else if (
    !isEmpty(reqBody.minimumWithdraw) &&
    isNaN(reqBody.minimumWithdraw)
  ) {
    errors.minimumWithdraw = "Only Allow Numeric";
  } else if (parseInt(reqBody.minimumWithdraw) < 0) {
    errors.minimumWithdraw = "Invalid Value";
  }
  if (isEmpty(reqBody.maximumWithdraw) || reqBody.maximumWithdraw == 0) {
    errors.maximumWithdraw = "Enter valid Maximum Withdraw";
  } else if (
    !isEmpty(reqBody.maximumWithdraw) &&
    isNaN(reqBody.maximumWithdraw)
  ) {
    errors.maximumWithdraw = "Only Allow Numeric";
  } else if (parseInt(reqBody.maximumWithdraw) < 0) {
    errors.maximumWithdraw = "Invalid Value";
  } else if (parseInt(reqBody.minimumWithdraw) >= parseInt(reqBody.maximumWithdraw)) {
    errors.minimumWithdraw = "Minimum withdraw not more than Maximum withdraw";
  }


  if (isEmpty(reqBody.minimumDeposit) || reqBody.minimumDeposit == 0) {
    errors.minimumDeposit = "Enter Valid Minimum Deposit";
  } else if (
    !isEmpty(reqBody.minimumDeposit) &&
    isNaN(reqBody.minimumDeposit)
  ) {
    errors.minimumDeposit = "Only Allow Numeric";
  } else if (parseInt(reqBody.minimumDeposit) < 0) {
    errors.minimumDeposit = "Invalid Value";
  }
  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};
export const editFiatValidation = (req, res, next) => {
  let errors = {},
    reqBody = req.body,
    reqFile = req.files;
  let onlylett = /^[A-Za-z]+$/
  let onlylettAndSpace = /^[a-zA-Z-][a-zA-Z -]*$/
  const AlphaWithSpace = /[a-zA-Z\s]+/g;

  // if (isEmpty(reqBody.name)) {
  //   errors.name = "Name Field Is Required";
  // }

  // if (isEmpty(reqBody.coin)) {
  //   errors.coin = "Coin Field Is Required";
  // }

  // if (isEmpty(reqBody.symbol)) {
  //   errors.symbol = "Symbol Field Is Required";
  // }

  if (isEmpty(reqBody.name)) {
    errors.name = "Name Field Is Required";
  } else if (!onlylettAndSpace.test(reqBody.name)) {
    errors.name = "Name Field must contain only Alphabets";
  }

  if (isEmpty(reqBody.coin)) {
    errors.coin = "Coin Field Is Required";
  } else if (!onlylett.test(reqBody.coin)) {
    errors.coin = "Coin Field must contain only Alphabets";
  }

  if (isEmpty(reqBody.symbol)) {
    errors.symbol = "Symbol Field Is Required";
  } else if (!onlylett.test(reqBody.symbol)) {
    errors.symbol = "Symbol Field must contain only Alphabets";
  }

  if (reqFile && isEmpty(reqFile.image) && reqBody && isEmpty(reqBody.image)) {
    errors.image = "Image Field Is Required";
  }

  if (isEmpty(reqBody.contractDecimal) || reqBody.contractDecimal == 0) {
    errors.contractDecimal = "Enter Valid Contract Decimal";
  } else if (!isEmpty(reqBody.contractDecimal) && isNaN(reqBody.contractDecimal)) {
    errors.contractDecimal = "Only Allow Numeric";
  } else if (parseInt(reqBody.contractDecimal) < 0) {
    errors.contractDecimal = "Invalid Value";
  }

  if (isEmpty(reqBody.withdrawFee) || reqBody.withdrawFee == 0) {
    errors.withdrawFee = "Enter Valid Withdraw Fee";
  } else if (!isEmpty(reqBody.withdrawFee) && isNaN(reqBody.withdrawFee)) {
    errors.withdrawFee = "Only Allow Numeric";
  } else if (parseFloat(reqBody.withdrawFee) < 0) {
    errors.withdrawFee = "Invalid Value";
  }

  if (isEmpty(reqBody.minimumWithdraw) || reqBody.minimumWithdraw == 0) {
    errors.minimumWithdraw = "Enter Valid Minimum Withdraw";
  } else if (!isEmpty(reqBody.minimumWithdraw) && isNaN(reqBody.minimumWithdraw)) {
    errors.minimumWithdraw = "Only Allow Numeric";
  } else if (parseFloat(reqBody.minimumWithdraw) < 0) {
    errors.minimumWithdraw = "Invalid Value";
  }

  if (isEmpty(reqBody.maximumWithdraw) || reqBody.maximumWithdraw == 0) {
    errors.maximumWithdraw = "Enter Valid Minimum Withdraw";
  } else if (!isEmpty(reqBody.maximumWithdraw) && isNaN(reqBody.maximumWithdraw)) {
    errors.maximumWithdraw = "Only Allow Numeric";
  } else if (parseFloat(reqBody.maximumWithdraw) < 0) {
    errors.maximumWithdraw = "Invalid Value";
  } else if (parseFloat(reqBody.minimumWithdraw) >= parseFloat(reqBody.maximumWithdraw)) {
    errors.minimumWithdraw = "Minimum withdraw not more than Maximum withdraw";
  }


  if (isEmpty(reqBody.minimumDeposit) || reqBody.minimumDeposit == 0) {
    errors.minimumDeposit = "Enter Valid Minimum Deposit";
  } else if (!isEmpty(reqBody.minimumDeposit) && isNaN(reqBody.minimumDeposit)) {
    errors.minimumDeposit = "Only Allow Numeric";
  } else if (parseInt(reqBody.minimumDeposit) < 0) {
    errors.minimumDeposit = "Invalid Value";
  }

  if (isEmpty(reqBody.bankName)) {
    errors.bankName = "Bank Name Field Is Required";
  } else if (!onlylett.test(reqBody.bankName)) {
    errors.bankName = "Bank Name Field must not be in numerics";
  }

  if (isEmpty(reqBody.accountNo)) {
    errors.accountNo = "Account Number Field Is Required";
  }

  if (isEmpty(reqBody.holderName)) {
    errors.holderName = "Holder Name Field Is Required";
  } else if (!AlphaWithSpace.test(reqBody.holderName)) {
    errors.holderName = "Holder Name Field must not be in numerics";
  }

  if (isEmpty(reqBody.bankcode)) {
    errors.bankcode = "IBN Code Field Is Required";
  }

  if (isEmpty(reqBody.country)) {
    errors.country = "Country Field Is Required";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

/**
 * Add Currency
 * URL : /adminapi/currency
 * METHOD : POST
 * BODY : name, symbol, coin, image, contractAddress, minABI, decimals, tokenType, bankName, accountNo, holderName, bankcode, country, withdrawFee, minimumWithdraw, depositType
 */
export const addValid = (req, res, next) => {
  if (req.body.currencyType == "crypto") {
    cryptoValidation(req, res, next);
  }
  if (req.body.currencyType == "token") {
    tokenValidation(req, res, next);
  }
  if (req.body.currencyType == "fiat") {
    fiatValidation(req, res, next);
  }
};

/**
 * Update Currency
 * URL : /adminapi/currency
 * METHOD : PUT
 * BODY : currencyId, name, symbol, coin, image, contractAddress, minABI, decimals, tokenType, bankName, accountNo, holderName, bankcode, country, withdrawFee, minimumWithdraw, depositType, status
 */
export const editValid = (req, res, next) => {
  if (req.body.currencyType == "crypto") {
    editCryptoValidation(req, res, next);
  }
  if (req.body.currencyType == "token") {
    editTokenValidation(req, res, next);
  }
  if (req.body.currencyType == "fiat") {
    editFiatValidation(req, res, next);
  }
};

/**
 * Crypto Currency
 * METHOD : POST
 * BODY : currencyName, currencySymbol, currencyImage, withdrawFee, minimumWithdraw, status
 */
export const cryptoValidate = (req, res, next) => { };

/**
 * Token Currency
 * METHOD : POST
 * BODY : currencyName, currencySymbol, currencyImage, contractAddress, minABI, decimals, withdrawFee, minimumWithdraw,
 */
export const tokenValidate = (req, res, next) => { };

/**
 * Fiat Currency
 * METHOD : POST
 * BODY : currencyName, currencySymbol, currencyImage, bankName, accountNo, holderName, bankcode, country, withdrawFee, minimumWithdraw,
 */
export const fiatValidate = (req, res, next) => {
  let errors = {},
    reqBody = req.body,
    reqFile = req.files;
};
