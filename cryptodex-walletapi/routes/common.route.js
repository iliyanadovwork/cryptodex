//  import packages
import express from "express";
import passport from 'passport';

// import controllers
import * as commonCtrl from "../controllers/common.controller.js";
import * as currencyCtrl from "../controllers/currency.controller.js";

const router = express();
const passportAuth = passport.authenticate("usersAuth", { session: false });

router.route("/priceConversion").get(commonCtrl.getPriceCNV);
router.route("/getCurrency").get(currencyCtrl.getCurrency);

export default router;
