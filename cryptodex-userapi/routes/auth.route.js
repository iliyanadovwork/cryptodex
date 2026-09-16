//  import packages
import express from "express";

// import controllers
import * as authCtrl from "../controllers/auth.controller.js";

// import validation
import * as userValid from "../validation/user.validation.js";

const router = express();

// POST /verifyOtp IS GONE. It was the phone half of registration, login and
// password reset - a code texted by `resend-otp` and checked here, which also
// marked the number verified. Phone is gone from this venue.
//
// The EMAIL login code is not affected: POST /login mails it and verifies it
// itself on the second call, and POST /resend-otp still re-issues it.

router
  .route("/register")
  .post(userValid.registerValidate, authCtrl.createNewUser);
router.route("/login").post(userValid.loginValidate, authCtrl.userLogin);
// /login-app is REMOVED. It was the mobile-app login; there is no mobile app,
// and the `-app` variants across this monorepo (/app-chart, /coinWithdraw-app)
// went with it.
router
  .route("/forgotPassword")
  .post(userValid.checkForgotPwdValidate, authCtrl.checkForgotPassword);
router
  .route("/resetconfirmMail")
  .post(userValid.confirmMailValidate, authCtrl.ResetconfirmMail);
router
  .route("/resetPassword")
  .post(userValid.resetPwdValidate, authCtrl.resetPassword);
router
  .route("/confirm-mail")
  .post(userValid.activateRegsiterUser, authCtrl.confirmMail);
router.route("/resend-otp").post(authCtrl.resendOTP);
router.route("/resend-mail").post(authCtrl.resendMail);

// TEST MODE ONLY: Bypass email verification for automated testing
router.route("/test-verify").post(authCtrl.testVerifyUser);

export default router;
