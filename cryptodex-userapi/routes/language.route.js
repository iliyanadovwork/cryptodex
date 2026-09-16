//  import packages
import express from "express";

// import controllers
import * as languageCtrl from "../controllers/language.controller.js";

const router = express();

router.route("/").get(languageCtrl.getLanguage);

export default router;
