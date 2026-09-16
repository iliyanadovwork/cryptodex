//import packages
import express from "express";
import passport from "passport";

//import controllers
import * as dashboardCtrl from "../controllers/dashboard.controller.js";

const router = express();
const passportAuth = passport.authenticate("usersAuth", { session: false });

router.route("/gainerLooser").get(passportAuth, dashboardCtrl.getGainerLooser);

//SPOT Fav Pair
router
  .route("/spotFavPair")
  .get(passportAuth, dashboardCtrl.getfavpair)
  .post(passportAuth, dashboardCtrl.updateFairPair);

export default router;
