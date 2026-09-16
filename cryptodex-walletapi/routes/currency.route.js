//  import packages
import express from "express";

// import controllers
import * as currencyCtrl from "../controllers/currency.controller.js";

// import validations

const router = express();

//Currency
router.route("/getCurrency").get(currencyCtrl.getCurrencyList);

export default router;
