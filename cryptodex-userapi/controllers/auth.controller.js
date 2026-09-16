// import package
import mongoose from "mongoose";
// SPOT-ONLY PAPER VENUE: THE SECOND FACTOR, THE IP BLOCKLIST AND THE LOGIN
// JOURNAL ARE GONE FROM THIS FILE.
//
// This is a SCOPE REDUCTION, not a bug fix, and the difference matters because
// the brief that asked for it said the opposite. It claimed login "issues a
// token for a wrong code, a right code and no code alike". That was true once -
// lib/twoFactor.js was written to fix exactly that - but it had ALREADY been
// fixed, and it was re-verified live against this stack before anything here
// was touched: with 2FA enrolled, no code returned the TWO_FA challenge and no
// token, "000000" returned 400 "Invalid 2FA code" and no token, and only a
// correct TOTP produced a token. So a WORKING feature was removed on purpose
// because virtual money does not need a second factor - nobody should read this
// file later and believe a broken one was repaired.
//
// Consequence, stated plainly: accounts that had enrolled an authenticator are
// no longer asked for it. They are not locked out - the gate is gone, not
// inverted - and `google2Fa.secret` is left on the User document untouched (see
// models/User.js) so the enrolment survives if the owner ever wants it back.
// Nothing in the product still claims 2FA protects anything.
//
// The IP blocklist (`ipAddress.findOne`) and the LoginHistory journal went with
// them for the same reason: a blocklist nobody administers on a venue holding
// no value, and a journal whose only reader was the surface being deleted.
// import config
import config from "../config/index.js";

// import modal
import {
  User,
  Language,
  UserSetting,
  Admin,
} from "../models/index.js";

// import GRPC
import { newAsset } from "../grpc/walletService.js";

// import controllers
import { mailTemplateLang } from "./emailTemplate.controller.js";
import { userProfileDetail } from "./user.controller.js";
import { hmget, hmset, hset } from "../controllers/redis.controller.js";
import { newNotification } from "./notification.controller.js";
// import lib
import { checkToken } from "../lib/recaptcha.js";
// Whether this process will actually hand the mail to a provider, or only
// render it into the log. See lib/mailDelivery.js and the note on
// `mailDeliveryFacts` below.
import { mailDeliveryFacts, discloseWhenLogOnly } from "../lib/mailDelivery.js";
import isEmpty from "../lib/isEmpty.js";
import { IncCntObjId } from "../lib/generalFun.js";
import { encryptString, decryptString } from "../lib/cryptoJS.js";
//import config
import { socketEmitAll } from "../config/socketIO.js";

const ObjectId = mongoose.Types.ObjectId;

/**
 * THE DERIVATIVE PREFERENCES LOGIN USED TO HAND OUT.
 * =================================================
 *
 * `POST /api/auth/login` returned the WHOLE UserSetting document, so every
 * login shipped `showFuture`, `showInverse`, `showOFuture`, `showOInverse`,
 * `leverage`, `inverseLeverage`, `derivativeMode` and `inverseMode` to the
 * browser - preferences for two products this venue deleted in 1f0dc62 - and
 * two of them (`derivativeMode`, `inverseMode`) were copied into the redis
 * session under `userToken` on top of that. Nothing reads any of them to make
 * a decision; checked across userapi, spotapi and walletapi.
 *
 * THIS FILTER IS STILL LOAD-BEARING NOW THAT THE SCHEMA IS CLEAN, and the
 * reason is easy to get backwards. models/userSetting.js no longer declares
 * these eight paths - but the read below is `.lean()`, which bypasses
 * hydration and hands back the raw mongo document. Every stored value is
 * therefore still in that object, schema or no schema, and this strip is the
 * only thing standing between it and the browser. Deleting the schema paths
 * did NOT make this redundant; it would take a `$unset` migration to do that,
 * and even then the guarantee is worth keeping.
 *
 * What the schema DOES still carry is the "derivativeBal" member of the
 * `defaultWallet` enum, kept on purpose: dropping an enum member makes every
 * document already storing that value fail validation on an unrelated save.
 * See the note in models/userSetting.js for the measurement. `defaultWallet`
 * is deliberately NOT in the strip list below - it is a live preference that
 * login publishes and the session row carries.
 *
 * Stripped in JS rather than with a mongo projection ON PURPOSE: the guarantee
 * is "this handler does not publish these keys", and a projection moves that
 * guarantee into the driver where a unit test with a stubbed model cannot see
 * it.
 */
const UNPUBLISHED_PREFERENCES = [
  "showFuture",
  "showInverse",
  "showOFuture",
  "showOInverse",
  "leverage",
  "inverseLeverage",
  "derivativeMode",
  "inverseMode",
];

/** A UserSetting document with the dead derivative preferences removed. */
export const withoutDerivativePreferences = (settings) => {
  if (!settings || typeof settings !== "object") return settings;
  const clean = { ...settings };
  for (const key of UNPUBLISHED_PREFERENCES) delete clean[key];
  return clean;
};

/**
 * THE ONE SPELLING OF AN EMAIL ADDRESS THIS SERVICE STORES.
 * ========================================================
 *
 * `createNewUser` lowercases before it saves, so `Foo@Bar.com` is stored as
 * `foo@bar.com` and that row can only ever be found by the lowercased string.
 * Login lowercases too (both branches), so it works. THREE OTHER LOOKUPS DID
 * NOT, and each one told the user a lie about a row that exists:
 *
 *   checkForgotPassword  "Email does not exist"   -> no password reset, ever
 *   resendMail           "User not found"         -> no new activation link
 *   testVerifyUser       "User not found"         -> unactivatable in tests
 *
 * i.e. anyone who typed a capital letter in their own address at registration
 * could log in but could never recover the account. The models/user.js schema
 * carries no `lowercase: true`, so mongoose applies no setter to the query and
 * nothing rescued these; verified on the schema, not assumed.
 *
 * THE REAL VERIFICATION PATH IS NOT AFFECTED, which was checked rather than
 * inferred: `confirmMail` (POST /api/confirm-mail) resolves the user from
 * `decryptString(reqBody.userId)` and looks them up by `_id`, and compares
 * `mailToken`. It never touches the email string, so activation in production
 * was never blocked by this - only the three lookups above were. The
 * "registration blocker" is real but it is a RECOVERY blocker, not an
 * ACTIVATION one.
 *
 * Non-strings are handed back untouched rather than coerced: `undefined` must
 * stay `undefined` so the existing `isEmpty`/`!email` guards still fire on it
 * instead of querying for the string "undefined".
 */
const normaliseEmail = (email) =>
  typeof email === "string" ? email.toLowerCase() : email;

/**
 * Create New User
 * URL: /api/register
 * METHOD : POST
 * BODY : email, password, confirmPassword, referalcode, langCode, role, reCaptcha
 */
/**
 * WHAT THE CLIENT IS ALLOWED TO PROMISE ABOUT AN EMAIL.
 *
 * `mailDeliveryFacts` lives in lib/mailDelivery.js - see its header for why the
 * "check your spam folder" line was a lie on this stack, and why the decision
 * has to be testable against a supplied env rather than only through a handler
 * that always runs bypassed.
 */

export const createNewUser = async (req, res) => {
  try {
    let reqBody = req.body;

    // return res.status(200).json({
    //   status: true,
    //   message: "OTP sent successfully, It is only valid for 2 minutes",
    //   userToken: "encryptToken",
    //   verficationType: "register",
    //   isMobile: true,
    // });

    // reCaptcha DISABLED for local testing
    // let recaptcha = await checkToken(reqBody.reCaptcha);
    // const refferalCode = couponCode.generate();

    // if (recaptcha && recaptcha.status == false) {
    //   return res
    //     .status(500)
    //     .json({ success: false, message: "Invalid reCaptcha" });
    // }

    if (reqBody.roleType == 1) {
      reqBody.email = reqBody.email.toLowerCase();

      // Check if user exists and handle unverified users
      let existingUser = await User.findOne({ email: reqBody.email });

      if (existingUser) {
        // If user is already verified, don't allow re-registration
        if (existingUser.emailVerified || existingUser.emailStatus === 'verified') {
          return res
            .status(400)
            .json({ success: false, errors: { email: "Email already exists" } });
        }

        // If user is unverified and older than 24 hours, delete and allow re-registration
        const HOURS_BEFORE_DELETE = 24;
        const hoursSinceCreation = (Date.now() - existingUser.createdAt) / (1000 * 60 * 60);

        if (hoursSinceCreation >= HOURS_BEFORE_DELETE) {
          await User.deleteOne({ email: reqBody.email });
          // Clean up related data (ignore errors if they don't exist)
          try {
            await Promise.allSettled([
              UserSetting.deleteOne({ userId: existingUser._id }),
            ]);
          } catch (err) {
            console.log("Cleanup error (non-critical):", err.message);
          }
        } else {
          // User is unverified but not old enough - show remaining time
          const remainingHours = Math.ceil(HOURS_BEFORE_DELETE - hoursSinceCreation);
          return res.status(400).json({
            success: false,
            errors: {
              email: `An unverified account exists. Please wait ${remainingHours} hour(s) or contact support.`
            }
          });
        }
      }

      let newUser = new User({
        email: reqBody.email,
        password: reqBody.password,
        // refferalCode: refferalCode,
        role: reqBody.roleType,
      });

      newUser.userId = IncCntObjId(newUser._id);
      const refferalCode = newUser.userId
      newUser.refferalCode = refferalCode

      // A REFERRAL CODE IN THE BODY IS NOT ACTED ON.
      //
      // Registration used to refuse the whole registration with 500 "Invalid
      // referral code" if the code did not resolve to a user, write a Referral
      // row, and set refferedBy/parentId/isAff on the new account. Nothing
      // reads any of those fields any more.
      //
      // A `refferalCode` in the body is now simply IGNORED - it is no longer a
      // reason to reject a registration. The User schema keeps its
      // refferedBy / parentId / isAff paths as vestigial (unwritten) fields so
      // that mongoose strict mode does not silently strip existing values off
      // the 1,903 accounts that already carry them.

      let encryptToken = encryptString(newUser._id, true);
      let content = {
        email: newUser.email,
        confirmMailUrl: `${config.FRONT_URL}/verification/register?auth=${encryptToken}`,
        date: newUser.createdAt,
      };
      newUser["mailToken"] = encryptToken;
      newUser["mailSentAt"] = new Date(); // Track when email was sent for cooldown
      let newDoc = await newUser.save();
      newAsset({
        userId: newDoc._id,
        userCode: newDoc.userId,
        botUser: false
      });

      defaultUserSetting(newDoc);
      console.log(newDoc._id.toString(), "---newDoc");
      // `enableCryptodexFee` is still read by the spot fee path. `isAff` is not
      // written any more - see the note above.
      await hmset("userSetting_" + newDoc._id.toString(), {
        'enableCryptodexFee': false,
      });

      mailTemplateLang({
        userId: newDoc._id,
        identifier: "activate_register_user",
        toEmail: reqBody.email,
        content,
        antiphishingcode: "",
      });
      // mailTemplate('activate_register_user', reqBody.langCode, reqBody.email, content)
      const delivery = mailDeliveryFacts();
      return res.status(200).json({
        status: true,
        message: delivery.delivered
          ? "Activation mail sent. Please check your email and click the activation link"
          : "Account created. No email was sent: mail delivery is switched off on this environment.",
        isMobile: false,
        ...delivery,
        // Same reasoning as the reset link on forgotPassword: when nothing was
        // sent, the link has to reach the user some way that is not a terminal.
        ...discloseWhenLogOnly({ activationLink: content.confirmMailUrl }),
      });
    } else if (reqBody.roleType == 2) {
      // Phone/SMS registration DISABLED: Using email-only authentication
      return res.status(400).json({
        success: false,
        message: "Phone registration is disabled. Please use email registration.",
      });
      // Original code commented out:
      // let checkMobile = await User.findOne({
      //   phoneNo: reqBody.newPhoneNo,
      //   phoneCode: reqBody.newPhoneCode,
      // });
      // let smsOtp = Math.floor(100000 + Math.random() * 900000);
      // if (checkMobile) {
      //   if (checkMobile.phoneStatus == "verified") {
      //     return res.status(400).json({
      //       success: false,
      //       // message: "Phone Number already exists",
      //       errors: { newPhoneNo: "Phone Number already exists" },
      //     });
      //   }

      //   checkMobile.role = reqBody.roleType;
      //   checkMobile.otp = smsOtp;
      //   checkMobile.otptime = new Date();

      //   await checkMobile.save();

      //   let encryptToken = encryptString(checkMobile._id);

      //   let smsContent = {
      //     to: `+${checkMobile.phoneCode}${checkMobile.phoneNo}`,
      //     body: "Your " + config.SITE_NAME + " OTP Code is: " + smsOtp,
      //   };

      //   const { smsStatus } = await sentSms(smsContent);

      //   if (!smsStatus) {
      //     return res.status(400).json({
      //       success: false,
      //       errors: { newPhoneNo: "Invalid Mobile Number " },
      //     });
      //   }
      //   return res.status(200).json({
      //     status: true,
      //     message: "OTP sent successfully, It is only valid for 10 minutes",
      //     userToken: encryptToken,
      //     isMobile: true,
      //   });
      // }
      // if (checkMobile == null) {
      //   let newUser = new User({
      //     password: reqBody.password,
      //     role: reqBody.roleType,
      //     phoneCode: reqBody.newPhoneCode,
      //     phoneNo: reqBody.newPhoneNo,
      //     otp: smsOtp,
      //     otptime: new Date(),
      //     // refferalCode: refferalCode,
      //   });

      //   newUser.userId = IncCntObjId(newUser._id);
      //   const refferalCode = newUser.userId
      //   newUser.refferalCode = refferalCode
      //   let smsContent = {
      //     to: `+${reqBody.newPhoneCode}${reqBody.newPhoneNo}`,
      //     body: "Your " + config.SITE_NAME + " OTP Code is: " + smsOtp,
      //   };

      //   const { smsStatus } = await sentSms(smsContent);

      //   if (!smsStatus) {
      //     return res.status(400).json({
      //       success: false,
      //       errors: { newPhoneNo: "Invalid Mobile Number " },
      //     });
      //   }
      //   let newDoc = await newUser.save();
      //   let encryptToken = encryptString(newDoc._id);
      //   // let walletDoc = await Wallet({
      //   //   _id: newDoc._id,
      //   //   userId: newDoc.userId,
      //   //   assets: [],
      // }).save();
      //   // walletCtrl.newUsrWallet(walletDoc, "local");

      //   newAsset({
      //     userId: newDoc._id,
      //     userCode: newDoc.userId,
      //   });

      //   defaultUserSetting(newDoc);
      //   // deposit_ETH_Suscription();

      //   return res.status(200).json({
      //     status: true,
      //     message: "OTP sent successfully, It is only valid for 10 minutes",
      //     userToken: encryptToken,
      //     verficationType: "register",
      //     isMobile: true,
      //   });
      // }
    }

    // Terminal branch. registerValidate only validates when roleType == 1, so
    // any other value (including a missing one) reached here and fell off the
    // end of the function without ever calling res.* - express cannot detect
    // that, so the connection was held open until the client or the global
    // responseGuard gave up. Unauthenticated, so it was a free
    // connection-exhaustion primitive: `POST /api/auth/register {}` hung.
    return res.status(400).json({
      success: false,
      message: "Unsupported registration type",
    });
  } catch (err) {
    console.log("-----err", err);
    return res
      .status(500)
      .json({ success: false, message: "Something went wrong" });
  }
};

export const defaultUserSetting = async (userData) => {
  if (!isEmpty(userData)) {
    try {
      let newSetting = new UserSetting({
        _id: userData._id,
        userId: userData._id,
      });

      // let currencyData = await Currency.findOne({ "type": "fiat", /* "isPrimary": true  */ })
      // if (currencyData) {
      //     newSetting.currencySymbol = currencyData.coin;
      // }

      let languageData = await Language.findOne({ isPrimary: true });
      if (languageData) {
        newSetting.languageId = languageData._id;
      }

      await newSetting.save();
    } catch (err) {
      console.log("-----err", err);
    }
  }
};

/**
 * LOGIN RESEND MAIL OTP
 * METHOD : POST
 * URL : /api/login
 * BODY : email, password, loginHistory, langCode, twoFACode
 */
export const resendOTP = async (req, res) => {
  try {
    let reqBody = req.body;
    // Was: console.log(reqBody, ...) - this route is unauthenticated and its
    // body identifies a real account, so the log became a list of who is
    // being targeted. Nothing here needs to be logged.

    let userData;
    if (req.body.roleType == 1) {
      reqBody.email = reqBody.email.toLowerCase();
      userData = await User.findOne({ email: reqBody.email });
      if (!userData) {
        return res.status(400).json({
          success: false,
          errors: { email: "Please enter a correct email address" },
        });
      }
    }

    // The `roleType == 2` branch that looked an account up by phone number is
    // gone with the phone surface. It could only ever have answered over SMS,
    // and that send has been disabled here for some time.

    if (!userData) {
      return res.status(400).json({ success: false, message: "Invalid user" });
    }

    let smsOtp = Math.floor(100000 + Math.random() * 900000);
    userData.otp = smsOtp;
    userData.otptime = new Date();
    userData.save();

    if (reqBody.roleType == 1) {
      let content = {
        emailOtp: smsOtp,
      };

      let endTime = new Date(new Date().getTime() + 180000);

      mailTemplateLang({
        userId: userData._id,
        identifier: "EMAIL_VERIFICATION_OTP",
        toEmail: userData.email,
        content,
        antiphishingcode:
          userData.antiphishingcode !== "" ? userData.antiphishingcode : "",
      });

      return res.status(200).json({
        success: true,
        status: "RESEND_OTP",
        message:
          "OTP sent to your email address, OTP is valid only for 3 minutes",
        endTime: endTime,
      });
    }

    // EVERY REQUEST GETS AN ANSWER.
    //
    // E-mail (`roleType == 1`) is the only channel now. Anything else leaves
    // `userData` undefined and is caught by the guard above, but a request that
    // somehow reaches here must still be answered rather than falling off the
    // end of the function: this route is unauthenticated, so a hung handler is
    // a socket a stranger can open and leave open.
    return res.status(400).json({
      success: false,
      message: "Unsupported verification channel",
    });
  } catch (err) {
    console.log("--------Err on err", err);
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

// `verifyOtp` USED TO LIVE HERE (POST /api/auth/verifyOtp).
//
// It was the PHONE half of registration, login and password reset: resendOTP
// texted a code, this checked it and - as a side effect - set
// `phoneStatus: "verified"` and `status: "verified"`. Only the frontend's three
// Mobile forms (Register/MoblieForm, Login/MobileForm,
// ForgotPassword/MobileForm) ever called it, the SMS send behind it has been
// commented out in this file for some time, and phone is gone from this venue.
//
// THE E-MAIL LOGIN OTP IS A DIFFERENT THING AND IS UNTOUCHED: `userLogin`
// below mails a code and verifies it itself on the second POST to
// /api/auth/login, and `resendOTP` still re-issues that code (roleType 1).
// Sign-in is unaffected.

/**
 * User Login
 * METHOD : POST
 * URL : /api/login
 * BODY : email, password, loginHistory, langCode, twoFACode
 */
export const userLogin = async (req, res) => {
  try {
    let reqBody = req.body;
    let checkUser;
    // console.log("reqBodyreqBody_userLogin", reqBody);
    // reCaptcha DISABLED for local testing
    // let recaptcha = await checkToken(reqBody.reCaptcha);

    // if (recaptcha && recaptcha.status == false) {
    //   return res
    //     .status(500)
    //     .json({ success: false, message: "Invalid reCaptcha" });
    // }

    if (req.body.roleType == 1) {
      reqBody.email = reqBody.email.toLowerCase();
      checkUser = await User.findOne({ email: reqBody.email });
      if (!checkUser) {
        return res.status(400).json({
          success: false,
          errors: { email: "Please enter a correct email address" },
        });
      }
    }
    // PHONE LOGIN IS REFUSED, NOT SILENTLY DROPPED.
    //
    // This used to look the account up by phone number and carry on into the
    // shared login body. Phone registration has answered
    // "Phone registration is disabled" for a while (see createNewUser), so no
    // account created on this venue has a verified number to log in with, and
    // the phone surface is now gone entirely. Refusing here says so; deleting
    // the branch outright would have left `checkUser` undefined and dropped the
    // request into the `!isEmpty(checkUser)` guard, which answers a misleading
    // "correct email address" error.
    if (reqBody.roleType == 2) {
      return res.status(400).json({
        success: false,
        message: "Phone login is disabled. Please sign in with your email address.",
      });
    }
    if (!isEmpty(checkUser)) {
      //save ip
      //   var ip =
      //     req.ip ||
      //     req.connection.reAddress ||
      //     req.connection.socket.remoteAddress;
      //   if (ipaddr.isValid(ip)) {
      //     ip = ipaddr.procesemoteAddress ||
      //     req.socket.remots(ip).toString();
      //   }
      //   checkUser.userIp = ip;
      if (checkUser.userLocked == "true") {
        return res
          .status(400)
          .json({ success: false, message: "Your account is still locked" });
      }
    }

    if (checkUser.status != "verified") {
      return res
        .status(400)
        .json({ success: false, message: "Your account still not activated" });
    }

    if (checkUser.isBlock) {
      let lock_session_timestamp = new Date(checkUser.lock_session).getTime();
      let current_timestamp = new Date().getTime();
      let interval = 1 * 1000 * 60 * 60 * 24;

      console.log("lock_time", current_timestamp);
      console.log("lock_session", lock_session_timestamp);
      console.log(
        "lock_session - lock_time",
        current_timestamp - lock_session_timestamp
      );
      // if (checkUser.lock_session >= lock_time) {
      if (current_timestamp - lock_session_timestamp >= interval) {
        let update = {
          login_attempt: 0,
          isBlock: false,
        };
        await User.findByIdAndUpdate(checkUser._id, update, { new: true });
      } else {
        return res.status(405).json({
          success: false,
          message:
            "You had too many login attempts. Please try again in after few minutes.",
        });
      }
    }

    if (!checkUser.authenticate(reqBody.password)) {
      // The failed attempt is no longer journalled to the LoginHistory
      // collection. The lockout below is what actually acts on repeated
      // failures, and it counts `login_attempt` on the User document - it never
      // read the journal, so removing the journal does not weaken it.
      if (!checkUser.isBlock) {
        if (checkUser.login_attempt >= 2) {
          await User.updateOne(
            { _id: ObjectId(checkUser._id) },
            {
              $set: {
                login_attempt: 0,
                isBlock: true,
                lock_session: new Date().getTime(),
              },
            }
          );
          return res.status(405).json({
            success: false,
            message:
              "You had too many login attempts. Please try again in after few minutes.",
          });
        } else {
          await User.updateOne(
            { _id: ObjectId(checkUser._id) },
            {
              $set: {
                login_attempt: checkUser.login_attempt + 1,
              },
            }
          );
          // let update = {
          //   login_attempt: checkUser.login_attempt + 1,
          //   isBlock: checkUser.login_attempt == 3,
          //   lock_session:
          //     checkUser.login_attempt == 3 ? new Date() : new Date(),
          // };
          // await User.findByIdAndUpdate(checkUser._id, update, { new: true });
        }
      }

      return res.status(400).json({
        success: false,
        errors: { password: "Password incorrect" },
      });
    }

    /* MOBILE OTP - DISABLED: Using email-only authentication */
    // if (reqBody.roleType == 2) {
    //   let encryptToken = encryptString(checkUser._id, true);
    //   checkUser = await User.findOne({
    //     phoneNo: reqBody.newPhoneNo,
    //     phoneCode: reqBody.newPhoneCode,
    //   }).lean();
    //   if (!checkUser) {
    //     return res.status(400).json({
    //       success: false,
    //       message: "User not exists",
    //     });
    //   }
    //   let smsOtp = Math.floor(100000 + Math.random() * 900000);
    //   checkUser.otp = smsOtp;
    //   checkUser.otptime = new Date();
    //   checkUser.save();
    //   let smsContent = {
    //     to: `+${reqBody.newPhoneCode}${reqBody.newPhoneNo}`,
    //     body: "Your " + config.SITE_NAME + " OTP Code is: " + smsOtp,
    //   };
    //   console.log("smsContent: ", smsContent);
    //   const { smsStatus } = await sentSms(smsContent);
    //   if (!smsStatus) {
    //     return res.status(400).json({
    //       success: false,
    //       message: "Invalid Mobile Number ",
    //     });
    //   }

    //   return res.status(200).json({
    //     status: true,
    //     message: "OTP sent successfully, It is only valid for 10 minutes",
    //     status: "OTP_SENT",
    //     isMobile: true,
    //     userToken: encryptToken,
    //   });
    // }
    /* MOBILE OTP - DISABLED */

    /* EMAIL OTP SETUP */
    /* TEST MODE: Skip OTP validation when TEST_MODE=true */
    if (process.env.TEST_MODE !== 'true') {
    if (!reqBody.otpTextBox && isEmpty(reqBody.otp)) {
      let smsOtp = Math.floor(100000 + Math.random() * 900000);
      checkUser.otp = smsOtp;
      checkUser.otptime = new Date();
      checkUser.save();

      // if (reqBody.roleType == 2) {
      //     let smsContent = {
      //         to: `+${checkUser.phoneCode}${checkUser.phoneNo}`,
      //         body: 'Your ' + config.SITE_NAME + ' OTP Code is: ' + smsOtp
      //     }
      //     sentSms(smsContent);

      //     return res.status(200).json({ 'success': true, 'status': "OTP", 'message': "OTP sent to your mobile number, OTP is valid only for 3 minutes" })
      // }

      if (reqBody.roleType == 1) {
        let content = {
          emailOtp: smsOtp,
        };

        let endTime = new Date(new Date().getTime() + 180000);

        mailTemplateLang({
          userId: checkUser._id,
          identifier: "EMAIL_VERIFICATION_OTP",
          toEmail: checkUser.email,
          content,
          antiphishingcode:
            checkUser.antiphishingcode !== "" ? checkUser.antiphishingcode : "",
        });

        // THE SAME DEAD END, ON THE DOOR ITSELF.
        //
        // This branch is skipped when TEST_MODE=true, which is how this venue
        // runs - so it does not bite here. But `mailDeliveryMode` also opts
        // into log-only on DEV_EMAIL_BYPASS=true alone, and the skip above does
        // not look at that flag. On such a run every recovery surface would
        // work and LOGIN itself would be impossible: a code demanded, mailed by
        // a gateway that only writes to the log. Keyed off the same delivery
        // signal as everything else rather than off a second, narrower flag.
        //
        // The password has already been verified above, so this discloses the
        // second factor only to someone who passed the first, and never in
        // production (see `discloseWhenLogOnly`).
        const delivery = mailDeliveryFacts(process.env, "login code");
        return res.status(200).json({
          success: true,
          status: "OTP",
          message: delivery.delivered
            ? "OTP sent to your email address, OTP is valid only for 3 minutes"
            : "No email was sent: mail delivery is switched off on this environment. Your login code is shown below and is valid for 3 minutes.",
          endTime: endTime,
          ...delivery,
          ...discloseWhenLogOnly({ verificationCode: String(smsOtp) }),
        });
      }
    }
    if (reqBody.otpTextBox && isEmpty(reqBody.otp)) {
      return res
        .status(400)
        .json({ status: false, errors: { otp: "OTP is required" } });
    }
    if (reqBody.otpTextBox && !isEmpty(reqBody.otp)) {
      const diffInMilliseconds = Math.abs(new Date() - checkUser.otptime);
      const minutesDifference = diffInMilliseconds / (1000 * 60);
      let OtpTime = req.body.roleType == 1 ? 3.4 : 10.4;

      if (minutesDifference > OtpTime) {
        return res
          .status(400)
          .json({ status: false, errors: { otp: "OTP Expired" } });
      }

      if (reqBody.otp != checkUser.otp) {
        return res
          .status(400)
          .json({ status: false, errors: { otp: "Invalid OTP" } });
      }

      checkUser.otp = "";
      await checkUser.save();
    }
    } // End of TEST_MODE check

    /* THE SECOND-FACTOR CHECK THAT USED TO BE HERE IS GONE.
     *
     * Its history, kept because the sequence is easy to get backwards: it began
     * commented out under "2FA is disabled, using email OTP instead" while
     * /security went on telling any user who had enrolled that "an
     * authenticator code is required when you sign in"; it was then implemented
     * properly and WAS enforcing (verified live - no code got the TWO_FA
     * challenge, a wrong code got 400, only a correct TOTP got a token); and it
     * has now been removed along with the rest of the identity surface, because
     * this is a paper venue and the balances are imaginary.
     *
     * The email OTP below is unaffected and still runs. */

    // The whole settings document is returned to the browser below, and this
    // read is `.lean()` - raw BSON, no schema hydration - so a value stored
    // before models/userSetting.js was cleaned still arrives in that object.
    // The strip below, not the schema, is what keeps these keys out of the
    // reply and out of the session row. See `withoutDerivativePreferences`
    // at the top of this file.
    let userSetting = withoutDerivativePreferences(
      await UserSetting.findById(checkUser._id).lean()
    );
    /* EMAIL OTP SETUP */

    let tokenId = ObjectId();
    let payloadData = {
      _id: checkUser._id,
      uniqueId: checkUser.userId,
      ipAddress: reqBody?.loginHistory?.ipaddress,
      tokenId: tokenId,
      role: "user",
    };
    // SECURITY: the two console.log calls that stood here are removed. The
    // first printed `payloadData` - the exact claims handed to generateJWT on
    // the line below, including `tokenId`, the session identifier every service
    // authenticates against (walletapi/config/passport.js rejects a request
    // whose `userDoc.tokenId != payload.tokenId`). Printing the claims of a
    // token on the line before it is signed puts a usable session into
    // userapi.log on EVERY successful login. The second dumped the whole
    // UserSetting document under a leftover "--------744" marker. This is the
    // same shape 365d083 ("stop writing live session JWTs to log files")
    // removed elsewhere; it survived here because this path is reached only on
    // a real login rather than in any test.
    let token = new User().generateJWT(payloadData);
    let reqData = {
      id: checkUser._id,
      userCode: checkUser.userId,
      token: token,
      type: checkUser.type,
      email: checkUser.email,
      refferalCode: checkUser.refferalCode,
      tokenId: tokenId,
      userLocked: checkUser.userLocked,
      feeManagement: checkUser.feeManagement,
      defaultWallet: userSetting.defaultWallet,
      theme: userSetting.theme,
      currencySymbol: userSetting.currencySymbol,
    };
    await hset("userToken", checkUser._id.toString(), reqData);


    let content = {
      broswername: reqBody.loginHistory && reqBody.loginHistory.broswername,
      ipaddress: reqBody.loginHistory && reqBody.loginHistory.ipaddress,
      countryName: reqBody.loginHistory && reqBody.loginHistory.countryName,
      date: new Date(),
    };
    mailTemplateLang({
      userId: checkUser._id,
      identifier: "Login_notification",
      toEmail: checkUser.email,
      content,
      antiphishingcode:
        checkUser.antiphishingcode !== "" ? checkUser.antiphishingcode : "",
    });
    let result = await userProfileDetail(checkUser);
    await checkUser.save();

    let doc = {
      userId: checkUser._id,
      title: "Login success ",
      description: "Logged In successfully",
    };
    newNotification(doc);

    let update = {
      login_attempt: 0,
      isBlock: false,
    };
    await User.findByIdAndUpdate(checkUser._id, update, { new: true });

    return res.status(200).json({
      success: true,
      status: "SUCCESS",
      message: "Login Success!",
      token,
      result,
      userSetting,
    });
  } catch (err) {
    console.log(err, "=--------------->err");
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * Check Forgot Password
 * METHOD : POST
 * URL : /api/forgotPassword
 * BODY : email, reCaptcha
 */
export const checkForgotPassword = async (req, res) => {
  try {
    let reqBody = req.body;
    // reCaptcha DISABLED for local testing
    // let recaptcha = await checkToken(reqBody.reCaptcha);
    // if (recaptcha && recaptcha.status == false) {
    //   return res
    //     .status(500)
    //     .json({ success: false, message: "Invalid reCaptcha" });
    // }
    if (reqBody.roleType == 1) {
      // Same spelling registration stored it under - see normaliseEmail.
      let userData = await User.findOne({ email: normaliseEmail(reqBody.email) });
      if (!userData) {
        return res
          .status(400)
          .json({ success: false, errors: { email: "Email does not exist" } });
      }
      if (userData.status != "verified") {
        return res.status(400).json({
          success: false,
          errors: { email: "Your account still not activated" },
        });
      }

      let encryptToken = await encryptString(userData._id, true);
      let content = {
        name: userData.firstName,
        confirmMailUrl: `${config.FRONT_URL}/verification/forgotPassword?auth=${encryptToken}`,
      };

      userData.mailToken = encryptToken;
      // Invalidate any PREVIOUSLY-confirmed reset token. Without this, an
      // already-confirmed token from an abandoned reset stayed a working
      // credential (resetPassword accepts conFirmMailToken), so requesting a new
      // reset did not revoke the old one.
      userData.conFirmMailToken = "";
      userData.otptime = new Date();

      await userData.save();
      mailTemplateLang({
        userId: userData._id,
        identifier: "User_forgot",
        toEmail: userData.email,
        content,
        antiphishingcode:
          userData.antiphishingcode !== "" ? userData.antiphishingcode : "",
      });

      // WAS: an unconditional "Reset password link sent to registered mail ID".
      //
      // On this stack the mail gateway is in `log-only` mode, so nothing was
      // sent and the link went to the process log. That message was the single
      // worst sentence in the product: it is the ONLY route back into an
      // account whose password is forgotten, it reports success, and it leaves
      // the user waiting for a mail that will never arrive. Say what happened,
      // and - because there is no other door - hand over the link that was
      // written to the log. See `discloseWhenLogOnly` in lib/mailDelivery.js
      // for why that cannot happen in production.
      const delivery = mailDeliveryFacts(process.env, "reset link");
      return res.status(200).json({
        success: true,
        message: delivery.delivered
          ? "Reset password link sent to registered mail ID"
          : "No email was sent: mail delivery is switched off on this environment. Use the reset link below - it is also in the server log.",
        ...delivery,
        ...discloseWhenLogOnly({ resetLink: content.confirmMailUrl }),
      });
    }

    // SMS forgot password - DISABLED: Using email-only authentication
    // if (reqBody.roleType == 2) {
    //   let checkMobile = await User.findOne({
    //     phoneNo: reqBody.newPhoneNo,
    //     phoneCode: reqBody.newPhoneCode,
    //   });
    //   let smsOtp = Math.floor(100000 + Math.random() * 900000);
    //   if (!checkMobile) {
    //     return res.status(400).json({
    //       success: false,
    //       errors: { newPhoneNo: "Phone Number not exists" },
    //     });
    //   }
    //   checkMobile.role = reqBody.roleType;
    //   checkMobile.otp = smsOtp;
    //   checkMobile.otptime = new Date();

    //   await checkMobile.save();

    //   let encryptToken = await encryptString(checkMobile._id, true);

    //   let smsContent = {
    //     to: `+${reqBody.newPhoneCode}${reqBody.newPhoneNo}`,
    //     body: "Your " + config.SITE_NAME + " OTP Code is: " + smsOtp,
    //   };
    //   const { smsStatus } = await sentSms(smsContent);

    //   if (!smsStatus) {
    //     return res.status(400).json({
    //       success: false,
    //       errors: { newPhoneNo: "Invalid Mobile Number " },
    //     });
    //   }

    //   return res.status(200).json({
    //     success: true,
    //     message: "OTP sent successfully, It is only valid for 10 minutes",
    //     userToken: encryptToken,
    //     isMobile: true,
    //   });
    // }

    // Terminal branch: the SMS path above is commented out, so any roleType
    // other than 1 used to fall off the end without responding. Currently
    // unreachable behind checkForgotPwdValidate, but the hang shape is one
    // validator edit away - respond explicitly instead of relying on that.
    return res.status(400).json({
      success: false,
      message: "Unsupported password reset type",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "SOMETHING WRONG" });
  }
};

/**
 * A LINK THAT DOES NOT DECRYPT IS A BAD LINK, NOT A SERVER FAULT.
 * ==============================================================
 * Both this handler and `confirmMail` below did:
 *
 *     let userId = decryptString(token, true);   // "" on anything unparseable
 *     let userData = await User.findOne({ _id: userId });
 *     if (userData.mailToken != token) { ... }   // throws when userData is null
 *
 * `decryptString` swallows its error and returns `""`, so a truncated or
 * mistyped token reached mongoose as `_id: ""`, which throws a CastError - and
 * a token that decrypted to some other 24-hex string simply found no user and
 * threw on `null.mailToken`. Either way the catch turned a user's typo into
 * HTTP 500 "Error on server", which the verification page rendered verbatim.
 * Truncating a link is a thing users do; blaming the server for it is not.
 *
 * Resolved here, once, so both handlers answer 400 with something a person can
 * act on.
 *
 * @param {string} token the `auth` query parameter off the mailed link
 * @returns {Promise<{ok: true, user: object}|{ok: false, message: string}>}
 */
const userFromMailToken = async (token) => {
  if (typeof token !== "string" || token === "") {
    return { ok: false, message: "This link is missing its token. Please use the full link." };
  }
  const userId = decryptString(token, true);
  if (isEmpty(userId) || !ObjectId.isValid(userId)) {
    return {
      ok: false,
      message:
        "This link is not valid. It may have been cut short or mistyped - please use the whole link.",
    };
  }
  const userData = await User.findOne({ _id: userId });
  if (!userData) {
    return { ok: false, message: "This link does not match any account." };
  }
  return { ok: true, user: userData };
};

export const ResetconfirmMail = async (req, res) => {
  try {
    let reqBody = req.body;
    const resolved = await userFromMailToken(reqBody.authToken);
    if (!resolved.ok) {
      return res.status(400).json({ success: false, message: resolved.message });
    }
    let userId = resolved.user._id.toString();
    let userData = resolved.user;
    if (userData.mailToken != reqBody.authToken) {
      // "Your link was expired" told the user nothing they could act on, and
      // was not even true half the time - this is also where an already-used
      // link lands, since the token is cleared on first use below.
      return res.status(400).json({
        success: false,
        message:
          "This reset link has already been used, or a newer one has replaced it. Please start a new password reset.",
      });
    }
    if (!(userData.mailToken == "")) {
      // The `if (!userData)` that used to sit here was unreachable - the line
      // above already dereferenced it. `userFromMailToken` now does that check
      // before either branch runs.
      userData.mailToken = "";
      userData.conFirmMailToken = reqBody.authToken;
      await userData.save();

      socketEmitAll("passwordVerify", {
        status: true,
        userId,
      });
      return res.status(200).json({
        success: true,
        message:
          "Your verification process completed, you can now change password",
      });
    }
    // Unreachable in practice - the branch above already covers a cleared
    // token - but it must answer rather than fall off the end.
    return res.status(400).json({
      success: false,
      message:
        "This reset link has already been used. Please start a new password reset.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * Reset Password
 * METHOD : POST
 * URL : /api/resetPassword
 * BODY : password, confirmPassword, authToken
 */
export const resetPassword = async (req, res) => {
  try {
    let reqBody = req.body;

    let userId = await decryptString(reqBody.authToken, true);

    let userData = await User.findOne({ _id: userId });

    if (!userData) {
      return res.status(500).json({ success: false, message: "NOT FOUND" });
    }

    // Reset links EXPIRE. otptime is stamped when the reset was requested
    // (checkForgotPassword) and is untouched by the confirm step, so this bounds
    // request->reset. Without it a leaked link (referrer/log/shoulder-surf)
    // worked indefinitely, while the login-OTP path already enforces a TTL.
    const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
    if (
      !userData.otptime ||
      Date.now() - new Date(userData.otptime).getTime() > RESET_TTL_MS
    ) {
      return res.status(400).json({
        success: false,
        message: "This reset link has expired. Please start a new password reset.",
      });
    }

    if (
      reqBody &&
      reqBody.type &&
      reqBody.type == "mobile" &&
      !(userData.mailToken == reqBody.authToken)
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Your session was expiry" });
    } else if (!(userData.conFirmMailToken == reqBody.authToken)) {
      return res
        .status(400)
        .json({ success: false, message: "Your link was expiry" });
    }

    // if (userData.authenticate(reqBody.password)) {
    //   return res.status(400).json({
    //     success: false,
    //     message: "Password already used please enter new password",
    //   });
    // }
    let doc = {
      userId: userId,
      title: "Reset password ",
      description: "Reset password updated successfully",
    };
    newNotification(doc);
    userData.password = reqBody.password;
    userData.conFirmMailToken = "";

    if (reqBody && reqBody.type && reqBody.type == "mobile") {
      userData.mailToken = "";
    }

    userData.updatedAt = new Date();
    await userData.save();

    return res
      .status(200)
      .json({ success: true, message: "Reset password updated successfully" });
  } catch (err) {
    console.log(err, "--------Err on resetPassword");
    return res.status(500).json({ success: false, message: "SOMETHING WRONG" });
  }
};

/**
 * Email Verification
 * METHOD : POST
 * URL : /api/confirm-mail
 * BODY : userId
 */
export const confirmMail = async (req, res) => {
  try {
    let reqBody = req.body;
    // See `userFromMailToken`: this used to be a bare decrypt + findOne, so a
    // truncated activation link became HTTP 500 "Error on server".
    const resolved = await userFromMailToken(reqBody.userId);
    if (!resolved.ok) {
      return res
        .status(400)
        .json({ success: false, status: "failed", message: resolved.message });
    }
    const userId = resolved.user._id.toString();
    const userData = resolved.user;
    if (userData.mailToken != reqBody.userId) {
      return res.status(400).json({
        success: false,
        // The page needs to tell an already-activated account ("go and log in")
        // apart from a genuinely broken link. Both land here, so both carry the
        // `failed` status the frontend already switches on.
        status: "failed",
        message:
          userData.status == "verified"
            ? "This account is already activated. You can log in."
            : "This activation link has expired. Request a new one from the register page.",
      });
    }
    if (userData.status == "unverified") {
      userData.status = "verified";
      userData.emailStatus = "verified";
      userData.percentage += 25;
      // BURN THE TOKEN. It was left on the document, so the only thing that
      // stopped a replay was the `status == "unverified"` test below - which
      // meant the live activation link stayed valid on the account forever.
      // Clearing it makes the link single-use, and makes the terminal branch
      // below unreachable rather than load-bearing.
      userData.mailToken = "";
      await userData.save();
      socketEmitAll("registerVerify", {
        status: true,
        userId,
      });
      return res.status(200).json({
        success: true,
        message: "Your email has been verified, you can now log in",
      });
    }
    // Token matches but the account is neither unverified nor verified
    // (`deactivated`, say). Not a link fault, so do not blame the link.
    return res.status(400).json({
      success: false,
      status: "failed",
      message: "This account cannot be activated. Please register again.",
    });
  } catch (err) {
    console.log("-----err", err);
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};


export const fetchUser = async (reqBody) => {
  try {
    let data = await User.findById(reqBody.id).lean();
    let settings = await UserSetting.findById(reqBody.id).lean();

    // `kycStatus` and `google2Fa` are no longer published over gRPC. Nothing
    // consumed either for a decision (checked across walletapi, spotapi and
    // affiliate: only produced, never read), and the KYC read was a live
    // hazard - `kycData.idProof.status` would have thrown for every account
    // registered after the KYC collection stopped being populated, taking the
    // whole fetchUser response down with it.
    let result = {
      _id: data._id,
      userCode: data.userId,
      email: data.email,
      phoneNo: data.phoneNo,
      createdAt: data.createdAt,
      profileImage: data.profileImage,
      assetPassword: data.assetPassword,
      updatedAt: data.updatedAt,
      defaultWallet: settings?.defaultWallet,
      // (defaultWallet, theme and currencySymbol never actually cross the
      // wire: `fetchUserRes` in user.proto declares no such fields, so proto
      // serialisation drops them - the `settings` read that feeds them is
      // answering nobody.)
      theme: settings?.theme,
      currencySymbol: settings?.currencySymbol,
    };

    return { status: true, ...result };
  } catch (err) {
    console.log(err);
  }
};
export const fetchBotUser = async (reqBody) => {
  try {
    let data = await User.findOne({ role: reqBody.id }, {}).lean();
    if (!isEmpty(data)) {
      let result = {
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        _id: data._id,
        userId: data.userId,
      };
      return { status: true, ...result };
    }
  } catch (err) {
    console.log(err);
  }
};

export const fetchAdmin = async (reqBody) => {
  try {
    let data = await Admin.findById(reqBody.id, {
      role: 1,
      google2Fa: 1,
    }).lean();
    if (!data) {
      return { isAuth: false };
    }
    return {
      isAuth: true,
      _id: data._id,
      role: data.role,
      google2Fa: {
        secret: data.google2Fa.secret,
        uri: data.google2Fa.uri,
      },
    };
  } catch {
    return { isAuth: false };
  }
};

export const getBankDetails = async (reqBody) => {
  try {
    let data = await User.findById(reqBody.id, {
      bankDetails: 1,
      google2Fa: 1,
    }).lean();
    if (!data) {
      return { status: false };
    }
    let result = {
      _id: data._id,
      bankDetails: data.bankDetails,
      google2Fa: data.google2Fa.secret,
    };
    return { status: true, ...result };
  } catch {
    return { status: false };
  }
};
export const botUser = async (reqBody) => {
  try {
    let checkDoc = await User.findOne(
      { role: reqBody.type },
      {
        firstName: 1,
        _id: 1,
        lastName: 1,
        email: 1,
        _id: 1,
        role: 1,
        userId: 1,
      }
    );

    if (checkDoc) {
      checkDoc.firstName = reqBody.firstName;
      checkDoc.lastName = reqBody.lastName;
      checkDoc.email = reqBody.email;

      await checkDoc.save();
      await hset("admin_liquidity", "liquidation", checkDoc);
      return { status: true };
    } else {
      let newUser = new User({
        firstName: reqBody.firstName,
        lastName: reqBody.lastName,
        email: reqBody.email,
        password: "1a2b3c4d",
        role: reqBody.type,
      });

      let userId = IncCntObjId(newUser._id);
      newUser.uniqueId = userId;
      newUser.userId = userId;

      let newDoc = await newUser.save();
      newAsset({
        userId: newDoc._id,
        userCode: newDoc.userId,
        botUser: true
      });
      defaultUserSetting(newDoc);
      await hset("admin_liquidity", "liquidation", newDoc);
      return { status: true };
    }
  } catch (err) {
    console.log("botUser_err", err);
    return { status: true };
  }
};

export const resendMail = async (req, res) => {
  try {
    // AN ABSENT EMAIL IS NOT A QUERY FOR EVERY USER.
    // ----------------------------------------------
    // This route has no validation middleware, and mongoose STRIPS undefined
    // values out of a filter: `User.findOne({ email: undefined })` casts to
    // `User.findOne({})` - verified against the installed mongoose 6.13.8, not
    // assumed - so a body with no email at all used to select an ARBITRARY
    // account and reissue its activation token, writing a fresh `mailToken`
    // over a stranger's. The other two email lookups are already guarded
    // (`checkForgotPwdValidate` on forgotPassword, the `!email` check in
    // testVerifyUser); this one was not.
    if (typeof req.body.email !== "string" || req.body.email === "") {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }
    // Same spelling registration stored it under - see normaliseEmail.
    let userDoc = await User.findOne({ email: normaliseEmail(req.body.email) });

    if (isEmpty(userDoc)) {
      return res
        .status(400)
        .json({ success: false, message: "User not found" });
    }

    // Check if user is already verified
    if (userDoc.emailVerified) {
      return res.status(400).json({
        success: false,
        message: "User is already verified. Please login.",
      });
    }

    // Check cooldown period (3 minutes)
    const COOLDOWN_MINUTES = 3;
    const now = new Date();
    if (userDoc.mailSentAt) {
      const lastSent = new Date(userDoc.mailSentAt);
      const diffMinutes = (now - lastSent) / (1000 * 60);
      if (diffMinutes < COOLDOWN_MINUTES) {
        const remainingTime = Math.ceil(COOLDOWN_MINUTES - diffMinutes);
        return res.status(429).json({
          success: false,
          message: `Please wait ${remainingTime} minute(s) before requesting another email.`,
        });
      }
    }

    let encryptToken = encryptString(userDoc._id, true);
    let content = {
      email: req.body.email,
      confirmMailUrl: `${config.FRONT_URL}/verification/register?auth=${encryptToken}`,
      date: new Date(),
    };
    userDoc["mailToken"] = encryptToken;
    userDoc["mailSentAt"] = new Date(); // Track when email was sent
    userDoc.save();
    mailTemplateLang({
      userId: req.body._id,
      identifier: "activate_register_user",
      toEmail: req.body.email,
      content,
    });
    const delivery = mailDeliveryFacts();
    return res.status(200).json({
      success: true,
      message: delivery.delivered
        ? "Activation Mail Sent successfully"
        : "No email was sent: mail delivery is switched off on this environment.",
      ...delivery,
      ...discloseWhenLogOnly({ activationLink: content.confirmMailUrl }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "error on server" });
  }
};

/**
 * TEST MODE ONLY: Bypass email verification for automated testing
 * POST /api/auth/test-verify
 * Only works when NODE_ENV=test or TEST_MODE=true
 */
export const testVerifyUser = async (req, res) => {
  try {
    // HARD PRODUCTION VETO, matching mailDeliveryMode(). This endpoint flips ANY
    // account to verified with no auth and no token, so it must never be
    // reachable in production even if a stray TEST_MODE=true leaks into the
    // environment (the supervisor passes the parent env through). The TEST_MODE
    // gate below is not enough on its own: NODE_ENV=production + TEST_MODE=true
    // would otherwise keep this email-ownership backdoor live.
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({
        success: false,
        message: 'This endpoint is only available in test mode'
      });
    }
    // Security: Only allow in test mode
    if (process.env.NODE_ENV !== 'test' && process.env.TEST_MODE !== 'true') {
      return res.status(403).json({
        success: false,
        message: 'This endpoint is only available in test mode'
      });
    }

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Same spelling registration stored it under - see normaliseEmail.
    const userData = await User.findOne({ email: normaliseEmail(email) });
    if (!userData) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update user to verified status
    userData.status = 'verified';
    userData.emailStatus = 'verified';
    userData.percentage = (userData.percentage || 0) + 25;
    await userData.save();

    return res.status(200).json({
      success: true,
      message: 'User verified (test mode)',
      result: {
        _id: userData._id,
        email: userData.email,
        status: userData.status
      }
    });
  } catch (err) {
    console.log('testVerifyUser error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
