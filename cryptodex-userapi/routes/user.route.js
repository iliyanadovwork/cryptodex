//  import packages
import express from "express";
import passport from "passport";
// import controllers
import * as userCtrl from "../controllers/user.controller.js";
import * as siteSettingCtrl from "../controllers/siteSetting.controller.js";

// import validation
import * as userValid from "../validation/user.validation.js";
import * as notifiCtrl from "../controllers/notification.controller.js";
const router = express();

// SPOT-ONLY PAPER VENUE: the identity/security surface below is gone.
//
//   /2fa               enrolment + disable for the TOTP second factor
//   /loginHistory      the per-user login journal
//   /antiphishingcode  the code stamped into outbound mail
//   /kyc, /kyc/idproof, /kyc/addressproof, /kycdetail, /accessToken,
//   /kyc-webhook       manual and Sumsub identity verification
//
// None of it protected anything on a venue whose money is imaginary, and the
// KYC half was collecting passport and address scans - real, sensitive
// documents - for a university project that cannot use them. What is KEPT is
// the product working: registration, e-mail activation, login, logout,
// forgot/reset password, change password and session handling.
//
// AND NOW THE SUPPORT DESK, THE CMS AND THE MARKETING SURFACE GO TOO.
//
//   /support, /getSupportCategory   the ticket desk (with file uploads)
//   /faq                            FAQ content
//   /cms/:identifier, /home-cms/:identifier, /cmcContent/:identifier
//   /announcement                   operator announcements
//   /addContactus                   the public contact form
//   /newsLetter/subscribe           newsletter opt-in
//   /slider                         home-page marketing sliders
//   /getbranddetails                a second, unused read of the SiteSetting row
//
// Every one of them was content for a marketing site this project no longer
// has, and each was a live public endpoint - two of them (contact form,
// newsletter) unauthenticated WRITES that anyone could fill a collection with.
//
// /siteSetting IS KEPT, deliberately: it is the branding read the running
// frontend makes on every page (components/HelperRoute.tsx dispatches
// getsiteSetting unconditionally), and the same SiteSetting row supplies the
// site name, logo and support address stamped into every outbound e-mail
// (controllers/emailTemplate.controller.js) and handed to spotapi/walletapi
// over gRPC. It now lives in siteSetting.controller.js next to that gRPC read
// instead of in a "common" controller that was otherwise all contact-form and
// newsletter code.
//
// /setting IS KEPT and is NOT the same thing: it is the per-user UserSetting
// document (theme, notification preferences, showSpot, fee preference) that the
// trade screen reads. Nothing about it is site-wide.
//
// PHONE AND SMS ARE GONE. /phoneChange (request + verify) and the Telnyx
// gateway behind them are removed; there is no mobile number to verify on a
// paper venue and the gateway was never configured here. /sendOTP SURVIVES as
// an EMAIL-ONLY code, because change-password, bind-email and asset-password
// all genuinely require it - see the note on requestOTP in
// controllers/user.controller.js. /verifyOtp (the standalone "is this code
// right" probe) is gone: no client ever called it, and every flow that needs a
// code verifies it inline on the request that uses it.
const passportAuth = passport.authenticate("usersAuth", { session: false });

router
  .route("/setting")
  .get(passportAuth, userCtrl.getUserSetting)
  .put(passportAuth, userValid.editSettingValid, userCtrl.editUserSetting);
router
// /setting/updateCryptodexFee is REMOVED. It toggled `enableCryptodexFee`, the
// pay-your-fees-in-CRYPTODEX discount, which was deleted as permanently inert:
// it debited a reward pot nothing has been able to credit for some time, so
// enabling it could only ever no-op. Plain maker/taker fees are unaffected.
// Bank / UPI / QR payment-method routes removed: this is a paper-trading
// exchange with no fiat settlement, so there is nothing to collect real bank
// account numbers, IFSC/SWIFT codes or UPI handles for. Existing Mongo
// documents are left untouched; the gRPC bankDetail method in grpc/server.js
// stays because walletapi still reads it.

router
  .route("/profile")
  .get(passportAuth, userCtrl.getUserProfile)
  .put(passportAuth, userValid.editProfileValidate, userCtrl.editUserProfile);
router
  .route("/updateProfileImage")
  .put(passportAuth, userCtrl.updateProfileImage);
router
  .route("/changePassword")
  .post(passportAuth, userValid.changePwdValidate, userCtrl.changePassword);
router
  .route("/notificationHistory")
  .get(passportAuth, notifiCtrl.getNotificationHistory);
router
  .route("/getUnreadNotification")
  .get(passportAuth, notifiCtrl.getUnreadNotification);

router
  .route("/readNotification")
  .get(passportAuth, notifiCtrl.getNotificationHistory_read);
router
  .route("/editNotif")
  .put(passportAuth, userValid.editNotifValid, userCtrl.editNotif);
router
  .route("/emailChange")
  .post(passportAuth, userValid.editEmailValidate, userCtrl.editEmail)
  // .put(userValid.tokenValidate, userCtrl.sentVerifLink)
  .patch(userValid.tokenValidate, userCtrl.verifyNewEmail);


router
  .route("/emailChange")
  .put(passportAuth, userValid.emailChangeValidation, userCtrl.emailUpdate);

// The one-time code, by e-mail. See the block comment above.
router.route("/sendOTP").post(passportAuth, userCtrl.requestOTP);

//siteSetting
router.route("/siteSetting").get(siteSettingCtrl.getsiteSetting);

//Asset password
router
// /asset-password is REMOVED. It set a second, separate password that existed
// only to authorise withdrawals. There are no withdrawals on this venue - the
// whole custody surface is deleted - so it guarded nothing and was one more
// credential for a user to lose.
// Deactivate account.
// SECURITY: both of these were unauthenticated and resolved their target from
// an `email` / `newPhoneNo` in the request body. That made /deactive-req an
// unauthenticated destructive trigger - anyone could mail a live deactivation
// code to any registered address, repeatedly - and made /deactive-confirm able
// to shred an account the caller had never proved they owned. They now require
// a session and act only on req.user.id.
router.route("/deactive-req").post(passportAuth, userCtrl.deactiveRequest);
router
  .route("/deactive-confirm")
  .post(passportAuth, userCtrl.confirmDeActive);

router
  .route("/change-pair")
  .post(passportAuth, userCtrl.showPair);

export default router;
