// import package
import mongoose from "mongoose";
import moment from "moment";
// import GRPC
import { deactivateWallet } from "../grpc/walletService.js";
import { cancelOrderForDeactiveAcc } from "../grpc/spotService.js";
// import modal
//
// SPOT-ONLY PAPER VENUE: `UserKyc`, `ipAddress` (the login blocklist) and
// `LoginHistory` are no longer imported here, and `node-2fa` is gone with the
// enrolment handlers that used it. `Contact` and `Anouncement` have now gone
// the same way with the contact form and the announcements board, and
// `SiteSetting` with the phone-change handler that was the last thing in this
// file to read it. The collections themselves are NOT dropped - existing
// documents are left exactly where they are, because deleting a user's data is
// the owner's call and not a side effect of removing a screen.
import {
  User,
  UserSetting,
  Notification,
} from "../models/index.js";

// // import config
import config from "../config/index.js";

// import lib
import isEmpty, { isBoolean } from "../lib/isEmpty.js";
// `momentFormat`, `capitalize`, `filterSearchQuery` and `columnFillter` went
// with the admin user-list CSV/PDF exports; `sentSms` went with the phone
// surface and lib/smsGateway.js with it.
import { paginationQuery } from "../lib/adminHelpers.js";

import { newNotification } from "./notification.controller.js";
import { decryptString, encryptString } from "../lib/cryptoJS.js";
import { mailTemplateLang } from "./emailTemplate.controller.js";
// Whether this process actually hands mail to a provider. See lib/mailDelivery.js.
import {
  mailDeliveryFacts,
  discloseWhenLogOnly,
} from "../lib/mailDelivery.js";
import { hget, hset, hdel, hmset } from "../controllers/redis.controller.js";

const ObjectId = mongoose.Types.ObjectId;

/**
 * Parse a value read out of redis. Returns `fallback` for null/undefined/garbage
 * instead of throwing, so a cache miss can never abort a request that has
 * already committed a database write.
 */
const safeJsonParse = (value, fallback = null) => {
  if (isEmpty(value)) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (err) {
    return fallback;
  }
};

/**
 * Get User Profile
 * METHOD : GET
 * URL : /api/userProfile
 */
export const getUserProfile = async (req, res) => {
  try {
    let userDoc = await User.findById(req.user.id).lean();
    if (userDoc) {
      let result = await userProfileDetail(userDoc);
      return res.status(200).json({ success: true, result: result });
    } else {
      return res.status(400).json({ success: false, message: "Not found" });
    }
  } catch (error) {
    console.log("errrr_getUserProfile", error);
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * Edit User Profile
 * METHOD : PUT
 * URL : /api/userProfile
 * BODY : firstName,lastName,blockNo,address,country,state,city,postalCode
 */
export const editUserProfile = async (req, res) => {
  try {
    let reqBody = req.body;
    let userData = await User.findById(req.user.id);

    userData.firstName = reqBody.firstName;
    userData.lastName = reqBody.lastName;
    userData.blockNo = reqBody.blockNo;
    userData.address = reqBody.address;
    userData.country = reqBody.country;
    userData.state = reqBody.state;
    userData.city = reqBody.city;
    userData.postalCode = reqBody.postalCode;

    let updateUserData = await userData.save();
    let result = userProfileDetail(updateUserData);

    return res.status(200).json({
      success: false,
      message: "PROFILE_EDIT_SUCCESS",
      result: result,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Something Wrong" });
  }
};

/**
 * Edit User Profile profile
 * METHOD : PUT
 * URL : /api/userProfile
 * BODY : firstName,lastName,blockNo,address,country,state,city,postalCode
 */
export const updateProfileImage = async (req, res) => {
  try {
    let userData = await User.findByIdAndUpdate(req.user.id, {
      profileImage: req.body.profileImage,
    });

    // This returned `success: false` alongside a 200 and a SUCCESS message, so
    // every caller that branches on `result.data.success` — which is how the
    // rest of this API is consumed — reported a completed update as a failure.
    return res.status(200).json({
      success: true,
      message: "PROFILE_EDIT_SUCCESS",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Something Wrong" });
  }
};

export const userProfileDetail = async (userData) => {
  if (isEmpty(userData)) {
    return;
  }
  // KYC, the login journal, the second factor and the anti-phishing code are
  // gone from this venue, so this payload no longer reports any of them. Every
  // field removed below was READ BY THE UI to render a claim about the account
  // (`twoFAStatus` drove the Security page's "Completed" badge, `idProof` drove
  // the KYC one, `loginHistory` drove the "IP Address" line); leaving them in
  // would leave the client able to assert something the product no longer does.
  //
  // `country` was declared TWICE in this object literal - once from the User
  // document and again, later, from `userKYCData.idProof.country`, so the KYC
  // copy silently won and an account that never submitted KYC reported no
  // country at all. Removing the KYC line restores the User document's value.
  let data = {
    _id: userData._id,
    userId: userData.userId,
    profileImage: userData.profileImage,
    firstName: userData.firstName,
    lastName: userData.lastName,
    email: userData.email,
    blockNo: userData.blockNo,
    walletaddress: userData.walletaddress,
    city: userData.city,
    state: userData.state,
    country: userData.country,
    postalCode: userData.postalCode,
    emailStatus: userData.emailStatus,
    phoneStatus: userData.phoneStatus,
    phoneCode: userData.phoneCode,
    phoneNo: userData.phoneNo,
    type: userData.type,
    refferalCode: userData.refferalCode,
    refferedBy: userData.refferedBy,
    createAt: moment(userData.createAt).format("DD MMM YYYY"),
    bankDetail: {},
    changepassword: userData.changepassword,
    percentage: userData.percentage,
    assetPasswordStatus: userData.assetPasswordStatus,
  };

  if (userData.bankDetails && userData.bankDetails.length > 0) {
    let bankDetail = userData.bankDetails.find((el) => el.isPrimary == true);
    if (bankDetail) {
      data.bankDetail["bankName"] = bankDetail.bankName;
      data.bankDetail["accountNo"] = bankDetail.accountNo;
      data.bankDetail["holderName"] = bankDetail.holderName;
      data.bankDetail["bankcode"] = bankDetail.bankcode;
      data.bankDetail["country"] = bankDetail.country;
      data.bankDetail["city"] = bankDetail.city;
    }
  }

  return data;
};

/**
 * Change New Password
 * METHOD : POST
 * URL : /api/changePassword
 * BODY : password, confirmPassword, oldPassword
 */
export const changePassword = async (req, res) => {
  try {
    let reqBody = req.body;
    // Was: console.log("reqBody: ", reqBody) - which wrote the user's CURRENT
    // password, their new password and their OTP into the service log in
    // plaintext, on every password change.
    let userData = await User.findOne({ _id: req.user.id });
    let notify = await UserSetting.findOne({ userId: userData._id });
    if (!userData) {
      return res
        .status(500)
        .json({ success: false, message: "User not found" });
    }

    if (!userData.authenticate(reqBody.oldPassword)) {
      return res.status(400).json({
        success: false,
        errors: { oldPassword: "Incorrect Password" },
      });
    }
    if (userData.authenticate(reqBody.password)) {
      return res.status(400).json({
        success: false,
        errors: {
          password:
            "Current password & new password are same, please set new password",
        },
      });
    }
    userData.password = reqBody.password;
    if (userData && userData.changepassword == false) {
      userData.percentage += 0;
    }
    userData.changepassword = true;
    // ONE CHANNEL, AND `type` NO LONGER DECIDES ANYTHING.
    //
    // This used to branch on a client-supplied `type`: 2 checked the e-mailed
    // code, 1 checked an SMS code, and ANY OTHER VALUE - including a request
    // that simply omitted the field - was refused with "Invalid type" AFTER the
    // new password had already been assigned to the in-memory document. SMS is
    // gone from this service (see requestOTP), so there is exactly one code a
    // user can be holding: the one /sendOTP mailed them. It is verified here,
    // whatever `type` says, which also means an older client that still sends
    // `type: 1` from a phone-less account can change its password instead of
    // being told its own request is invalid.
    //
    // THE CODE IS STILL REQUIRED. This is not "password change without an OTP":
    // a wrong, expired or absent code refuses the change and nothing is
    // written.
    const otpResp = await optVerification(2, userData, reqBody.otp);
    if (!otpResp.status) {
      return res.status(400).json({
        success: false,
        message: otpResp.message,
        error: {
          otp: otpResp.message,
        },
      });
    }
    userData.emailOTP = "";
    userData.emailOTPtime = "";
    userData.requestType = "";
    userData.updatedAt = new Date();
    await userData.save();

    if (notify.passwordChange == true) {
      let content = {
        message: "Your Password Changed Successfully",
        email: userData.email,
      };
      mailTemplateLang({
        userId: userData._id,
        identifier: "alert_notification",
        toEmail: userData.email,
        content: content,
      });
    }

    let doc = {
      userId: req.user.id,
      title: "Change password ",
      description: "Your password has been updated",
    };
    newNotification(doc);
    return res
      .status(200)
      .json({ success: true, message: "Your password has been updated" });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ success: false, message: "Something Wrong" });
  }
};

/**
 * Get User Setting
 * METHOD : GET
 * URL : /api/user/setting
 */
export const getUserSetting = async (req, res) => {
  // Was: UserSetting.findById(id, projection, async (err, data) => {...}).
  // Everything after the `err` check ran inside an async callback that express
  // does not observe, so any throw in there - starting with `data.leverage`
  // when the user has no UserSetting document - became an unhandled rejection
  // and the request was never answered. Rewritten as await + one try/catch so
  // every path terminates the response.
  try {
    const data = await UserSetting.findById(req.user.id, {
      _id: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    if (!data) {
      return res
        .status(404)
        .json({ success: false, message: "SETTING_NOT_FOUND" });
    }
    // THE PER-PAIR OVERRIDES ARE GONE. Both branches read an open position out
    // of redis to report a per-position value in preference to the user's
    // stored default. There are no positions on a spot-only venue, so both
    // reads could only ever miss and fall back to the stored value - which is
    // what this now returns directly.
    return res
      .status(200)
      .json({ success: true, message: "FETCH_SUCCESS", result: data });
  } catch (err) {
    console.log("getUserSetting error:", err && err.message);
    return res
      .status(500)
      .json({ success: false, message: "Something Wrong" });
  }
};

/**
 * Edit User Setting
 * METHOD : PUT
 * URL : /api/userSetting
 * BODY : languageId, theme, currencySymbol, timeZone(name,GMT), afterLogin(page,url)
 */
export const editUserSetting = (req, res) => {
  let reqBody = req.body;
  UserSetting.findByIdAndUpdate(
    req.user.id,
    {
      LatestEvent: reqBody.LatestEvent,
      announcement: reqBody.announcement,
      tradingviewAlert: reqBody.tradingviewAlert,
      tradeOrderPlaceAlertMobile: reqBody.tradeOrderPlaceAlertMobile,
      tradeOrderPlaceAlertWeb: reqBody.tradeOrderPlaceAlertWeb,
      defaultWallet: reqBody.defaultWallet,
      theme: reqBody.theme,
      currencySymbol: reqBody.currencySymbol,
      languageId: reqBody.languageId,
      twoFA: reqBody.twoFA,
      passwordChange: reqBody.passwordChange,
      loginNotification: reqBody.loginNotification,
    },
    {
      fields: { _id: 0, createdAt: 0, updatedAt: 0 },
      new: true,
    },
    (err, data) => {
      if (err) {
        console.log("errerrerr", err);
        return res
          .status(500)
          .json({ success: false, message: "Something Wrong" });
      }
      return res
        .status(200)
        .json({ success: true, message: "EDIT_SETTING_SUCCESS", result: data });
    }
  );
};

/**
 * Edit User Notification
 * METHOD : PUT
 * URL : /api/editNotif
 * BODY : name, checked
 */
export const editNotif = async (req, res) => {
  try {
    let reqBody = req.body;
    let usrSetting = await UserSetting.findOne(
      { userId: req.user.id },
      { createdAt: 0, updatedAt: 0 }
    );

    if (!usrSetting) {
      return res.status(400).json({ success: false, message: "NO_DATA" });
    }

    if (reqBody.name in usrSetting) {
      usrSetting[reqBody.name] = reqBody.checked;
    }
    let updateData = await usrSetting.save();
    return res.status(200).json({
      success: true,
      message: "EDIT_SETTING_SUCCESS",
      result: {
        currencySymbol: updateData.currencySymbol,
        theme: updateData.theme,
        afterLogin: updateData.afterLogin,
        languageId: updateData.languageId,
        timeZone: updateData.timeZone,
        loginNotification: updateData.loginNotification,
        twoFA: updateData.twoFA,
        passwordChange: updateData.passwordChange,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Something Wrong" });
  }
};

export const editEmail = async (req, res) => {
  // try {
  //   let reqBody = req.body;
  //   let checkUser = await User.findOne({
  //     email: reqBody.newEmail,
  //     _id: { $ne: req.user.id },
  //   });
  //   if (checkUser) {
  //     return res
  //       .status(400)
  //       .json({ success: false, errors: { newEmail: "Email already exists" } });
  //   }

  //   let encryptToken = encryptString(req.user.id, true);
  //   let userData = await User.findOneAndUpdate(
  //     {
  //       _id: req.user.id,
  //     },
  //     {
  //       newEmail: reqBody.newEmail,
  //       newEmailToken: encryptToken,
  //     },
  //     {
  //       new: true,
  //     }
  //   );
  //   let content = {
  //     confirmMailUrl: `${config.FRONT_URL}/verify-old-email/${encryptToken}`,
  //     date: new Date(),
  //   };
  //   mailTemplateLang({
  //     userId: userData._id,
  //     identifier: "change_register_email",
  //     toEmail: userData.email,
  //     content,
  //   });

  //   return res.status(200).json({
  //     success: true,
  //     message: "Verification link sent to your old email address.",
  //   });
  // } catch (err) {
  //   return res.status(500).json({ success: false, message: "Error on server" });
  // }
  try {
    let reqBody = req.body;
    let checkUser = await User.findOne({
      email: reqBody.newEmail,
      // _id: { $ne: req.user.id },
    });
    if (!isEmpty(checkUser)) {
      if (checkUser.email == reqBody.newEmail) {
        return res.status(400).json({
          success: false,
          errors: { newEmail: "You have entered  already exist email address" },
        });
      }
    }

    // if (checkUser) {
    //   return res
    //     .status(400)
    //     .json({ success: false, errors: { newEmail: "Email already exists" } });
    // }

    let encryptToken = encryptString(req.user.id, true);
    let userData = await User.findOneAndUpdate(
      {
        _id: req.user.id,
      },
      {
        newEmail: reqBody.newEmail,
        newEmailToken: encryptToken,
      },
      {
        new: true,
      }
    );
    if (reqBody.oldEmail == "") {
      let content = {
        confirmMailUrl: `${config.FRONT_URL}/verify-new-email/${encryptToken}`,
        date: new Date(),
      };

      mailTemplateLang({
        userId: userData._id,
        identifier: "verify_new_email",
        toEmail: reqBody.newEmail,
        content,
      });
      return res.status(200).json({
        success: true,
        message: "Verification link sent to your new email address.",
      });
    }
    let content = {
      confirmMailUrl: `${config.FRONT_URL}/verify-old-email/${encryptToken}`,
      date: new Date(),
    };
    mailTemplateLang({
      userId: userData._id,
      identifier: "change_register_email",
      toEmail: userData.email,
      content,
    });
    return res.status(200).json({
      success: true,
      message: "Verification link sent to your old email address.",
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * Sent Verification Link to New Email
 * METHOD : PUT
 * URL : /api/emailChange
 * BODY : token
 */
export const sentVerifLink = async (req, res) => {
  try {
    let reqBody = req.body;
    let userId = decryptString(reqBody.token, true);

    let userData = await User.findOne({ _id: userId });

    if (userData.newEmailToken != reqBody.token) {
      return res.status(400).json({ success: false, message: "Invalid Link" });
    }

    let encryptToken = encryptString(userData._id, true);
    userData.newEmailToken = encryptToken;
    await userData.save();

    let content = {
      confirmMailUrl: `${config.FRONT_URL}/verify-new-email/${encryptToken}`,
      date: new Date(),
    };

    mailTemplateLang({
      userId: userData._id,
      identifier: "verify_new_email",
      toEmail: userData.newEmail,
      content,
    });
    return res.status(200).json({
      success: true,
      message: "Verification link sent to your new email address.",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * Verify New Email
 * METHOD : PATCH
 * URL : /api/emailChange
 * BODY : token
 */
export const verifyNewEmail = async (req, res) => {
  try {
    let reqBody = req.body;
    let userId = decryptString(reqBody.token, true);
    let checkUser = await User.findOne({ _id: userId });

    if (!(checkUser.newEmailToken == reqBody.token)) {
      return res.status(500).json({ success: false, message: "Invalid link" });
    }
    if (!checkUser) {
      return res.status(500).json({ success: false, message: "Invalid link" });
    }

    let checkEmail = await User.findOne({
      email: checkUser.newEmail,
      _id: { $ne: checkUser._id },
    });
    if (checkEmail) {
      return res
        .status(400)
        .json({ success: false, message: "Email already exists" });
    }

    await User.updateOne(
      {
        _id: checkUser._id,
      },
      {
        $set: {
          email: checkUser.newEmail,
          emailStatus: "verified",
          newEmail: "",
          newEmailToken: "",
        },
      }
    );

    return res
      .status(200)
      .json({ success: true, message: "Change email address successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

export const getNotificationHistory = async (req, res) => {
  try {
    let pagination = paginationQuery(req.query);
    let count = await Notification.countDocuments({ userId: req.user.id });

    Notification.find({
      userId: req.user.id,
    })
      .sort({ createdAt: -1 })
      .limit(pagination.limit)
      .skip(pagination.skip)
      .exec((err, data) => {
        if (err) {
          return res
            .status(500)
            .json({ success: false, message: "Something Wrong" });
        }
        return res.status(200).json({ success: true, result: data, count });
      });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Something Wrong" });
  }
};

/**
 * SEND A ONE-TIME CODE, BY E-MAIL.
 * ================================
 * PHONE AND SMS ARE GONE FROM THIS SERVICE, BUT THIS ROUTE IS NOT.
 *
 * The `roleType == 2` branch that used to sit here sent the code over Telnyx to
 * the user's mobile number. There is no mobile number to send to on a paper
 * venue - /phoneChange and the whole verify-your-phone flow have been removed -
 * and lib/smsGateway.js has gone with it.
 *
 * The E-MAIL code STAYS, because three flows the product still has genuinely
 * require it and would break without it:
 *
 *   change password   controllers/user.controller.changePassword verifies this
 *                     code before it will rotate a password. That flow is on
 *                     the regression baseline.
 *   bind e-mail       emailUpdate verifies it before changing the address.
 *   asset password    assetPassword verifies it.
 *
 * `roleType` is now IGNORED rather than rejected. Clients written against the
 * old contract send `roleType: 2` from the bind-email and (phone-less)
 * change-password screens; refusing those would have broken working screens to
 * make a point about a field. Every caller gets the e-mail code.
 */
export const requestOTP = async (req, res) => {
  try {
    let reqBody = req.body;
    let userData = await User.findOne({ _id: req.user.id });

    if (!userData) {
      return res.status(400).json({ success: false, message: "Invalid user" });
    }
    // Was: console.log(reqBody, ...) - reqBody on this route carries the OTP
    // on a resend, so the live code went to the log.
    let emailOtp = Math.floor(100000 + Math.random() * 900000);

    if (!isEmpty(userData.emailOTP)) {
      if (userData.requestType == reqBody.requestType) {
        const diffInMilliseconds = Math.abs(
          new Date() - new Date(userData.emailOTPtime)
        );
        const minutesDifference = diffInMilliseconds / (1000 * 60);
        if (minutesDifference <= 3) {
          return res.status(400).json({
            success: false,
            message: "Next Verification code after 3 minutes",
          });
        }
      }
    }

    let content = {
      emailOtp,
    };
    userData.emailOTP = emailOtp;
    userData.requestType = reqBody.requestType;
    userData.emailOTPtime = new Date();
    await userData.save();

    mailTemplateLang({
      userId: userData._id,
      identifier: "EMAIL_VERIFICATION_OTP",
      toEmail: userData.email,
      content,
      antiphishingcode:
        userData.antiphishingcode !== "" ? userData.antiphishingcode : "",
    });
    // THE CODE HAS TO REACH THE USER SOMEHOW.
    //
    // `changePassword` genuinely requires this code (see the note there - that
    // is deliberate and stays), and this is the only thing that issues it. Under
    // `log-only` delivery the mail is rendered to the process log and never
    // sent, so the old unconditional "Verification code sent to your email ID"
    // both lied and dead-ended: the Change Password dialog could not be
    // completed by anyone without shell access to the server.
    //
    // The requirement is untouched. What changes is that when we did NOT send
    // anything, we say so and return the code we stored, so the dialog can show
    // it. `discloseWhenLogOnly` (lib/mailDelivery.js) is inert in production.
    // Note this route is authenticated and the code is the caller's own: the
    // session that receives it already controls the account.
    const delivery = mailDeliveryFacts(process.env, "verification code");
    return res.status(200).json({
      success: true,
      status: "RESEND_OTP",
      message: delivery.delivered
        ? "Verification code sent to your email ID, Verification code is valid only for 3 minutes"
        : "No email was sent: mail delivery is switched off on this environment. Your verification code is shown below and is valid for 3 minutes.",
      ...delivery,
      ...discloseWhenLogOnly({ verificationCode: String(emailOtp) }),
    });
  } catch (err) {
    console.log("requestOTP", err);
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * OTP VERIFICATION
 * METHOD : POST
 * URL : /api/antiphishingcode/getcode/:type
 * BODY : otp, antiphisingcode
 * PARAMS : phone, email, google_auth
 */
export const optVerification = async (type, userData, enteredOTP) => {
  try {
    let reqBody = type;
    if (reqBody === 1) {
      if (userData.otp != enteredOTP) {
        return { status: false, message: "Invalid verification code" };
      } else {
        const diffInMilliseconds = Math.abs(new Date() - userData.otptime);
        const minutesDifference = diffInMilliseconds / (1000 * 60);
        if (minutesDifference >= 10.4) {
          return { status: false, message: "Verification code expired" };
        } else {
          return { status: true, message: "Code Verified" };
        }
      }
    } else if (reqBody === 2) {
      if (userData && userData.emailOTP !== enteredOTP) {
        return { status: false, message: "Invalid verification code" };
      } else {
        const diffInMilliseconds = Math.abs(new Date() - userData.emailOTPtime);
        console.log(diffInMilliseconds, '-------2268', userData, diffInMilliseconds / (1000 * 60))
        const minutesDifference = diffInMilliseconds / (1000 * 60);
        if (minutesDifference >= 3.4) {
          return { status: false, message: "Verification code expired" };
        } else {
          return { status: true, message: "Code Verified" };
        }
      }
    }
  } catch (err) {
    return {
      status: false,
      message: "Some thing went wrong try again later...",
    };
  }
};

/**
 * Change the account's e-mail address, confirmed with the mailed code.
 * METHOD : PUT
 * URL : /api/user/emailChange
 * BODY : email, otp
 */
export const emailUpdate = async (req, res) => {
  try {
    let reqBody = req.body;
    let userData = await User.findOne({
      email: reqBody.email,
    });
    if (userData) {
      if (userData._id.toString() != req.user.id) {
        return res.status(400).json({
          success: false,
          errors: { email: "Email ID already exists" },
          message: "Email ID already exists",
        });
      }
      if (userData._id.toString() == req.user.id) {
        return res.status(400).json({
          success: false,
          errors: { email: "Email ID  matches your previous one" },
          message: "Email ID  matches your previous one",
        });
      }
    }

    let checkUser = await User.findOne({
      _id: req.user.id,
    });
    // Was optVerification(1, ...), i.e. the SMS code. The bind-email screen
    // asks /sendOTP for a code and /sendOTP now only ever mails one, so
    // checking `otp`/`otptime` here could never match again - changing your
    // e-mail address would have become impossible. Checks the mailed code.
    const { status, message } = await optVerification(
      2,
      checkUser,
      reqBody.otp
    );
    if (!status) {
      return res.status(400).json({ success: false, message });
    }
    let doc = {
      userId: req.user.id,
      title: "Email verified",
      description: "Email ID has been updated",
    };
    newNotification(doc);
    checkUser.email = reqBody.email;
    checkUser.emailOTP = "";
    checkUser.emailOTPtime = "";
    checkUser.emailStatus = "verified";
    checkUser.requestType = "";
    let updateUserData = await checkUser.save();

    let responseData = {
      email: updateUserData.email,
      phoneNo: updateUserData.phoneNo,
      emailStatus: updateUserData.emailStatus,
    };
    return res.status(200).json({
      success: true,
      message: "Email ID updated successfully",
      result: responseData,
    });
  } catch (err) {
    console.log("validateErrorvalidateError", err);
    return res.status(500).json({ success: false, message: "Something Wrong" });
  }
};

export const assetPassword = async (req, res) => {
  try {
    let reqBody = req.body;
    let userData = await User.findOne({ _id: req.user.id });

    if (reqBody.type == 2) {
      const EmailOTPResp = await optVerification(2, userData, reqBody.otp);
      if (!EmailOTPResp.status) {
        return res.status(400).json({
          success: false,
          message: EmailOTPResp.message,
          errors: {
            otp: EmailOTPResp.message,
          },
        });
      }
    }
    let data = {
      assetPassword: encryptString(reqBody.confirmPassword, true),
      assetPasswordStatus: true,
      emailOTP: "",
      requestType: "",
    };
    await User.findOneAndUpdate(
      { _id: req.user.id },
      { $set: data },
      { upsert: true }
    );
    return res
      .status(200)
      .json({ success: true, message: "Asset password updated successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};
export const deactiveRequest = async (req, res) => {
  try {
    let reqBody = req.body;
    let smsOtp = Math.floor(100000 + Math.random() * 900000);
    // THE SMS CHANNEL IS GONE. `roleType == 2` used to send the deactivation
    // code over Telnyx to a verified mobile number; there is no phone
    // verification on this venue any more and lib/smsGateway.js has been
    // deleted. The e-mail channel below is the only one, and confirmDeActive
    // still decides which stored code to check from `deactiveOtpChannel` -
    // which this endpoint sets - rather than from anything the client sends.
    //
    // `roleType` is not rejected, only ignored: a client still sending 2 gets
    // the e-mailed code instead of an error.
    {
      let userData = await User.findOne({
        _id: req.user.id,
        emailStatus: "verified",
      });
      if (!userData) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid user" });
      }
      if (!isEmpty(userData.emailOTP)) {
        if (userData.requestType == req.body.requestType) {
          const diffInMilliseconds = Math.abs(
            new Date() - userData.emailOTPtime
          );
          const minutesDifference = diffInMilliseconds / (1000 * 60);
          if (minutesDifference <= 3) {
            return res.status(400).json({
              success: false,
              message: "Next Verification code after 3 minutes",
            });
          }
        }
      }
      let content = {
        emailOtp: smsOtp,
      };
      // STORED AS A STRING, EXPLICITLY. `optVerification(2, ...)` compares
      // with `!==`, and what arrives from the client is always a string; this
      // assignment used to hand it a Number and rely on mongoose casting to
      // `emailOTP: { type: String }` on save to make the two comparable. That
      // works, but it means the field's type depends on a schema two files
      // away, and any caller that verifies against an unsaved document - a
      // test double, a future in-memory path - silently gets "Invalid
      // verification code" for the correct code. Say it here instead.
      userData.emailOTP = String(smsOtp);
      userData.requestType = req.body.requestType;
      userData.emailOTPtime = new Date();
      userData.deactiveOtpChannel = "email";
      await userData.save();

      mailTemplateLang({
        userId: userData._id,
        identifier: "EMAIL_VERIFICATION_OTP",
        toEmail: userData.email,
        content,
        antiphishingcode:
          userData.antiphishingcode !== "" ? userData.antiphishingcode : "",
      });
      // THE THIRD DEAD END, CLOSED THE SAME WAY AS THE OTHER TWO.
      //
      // `/sendOTP` (change password) and `/forgotPassword` were both fixed to
      // stop claiming a delivery that did not happen and to hand the caller the
      // value they cannot otherwise get. This route was missed, so the
      // deactivation flow still ended where password reset used to: under
      // `log-only` delivery the code is written to `user.emailOTP`, rendered
      // into a mail, printed to the process log and never sent, and
      // `confirmDeActive` refuses without it. A user with a browser and no
      // terminal could start closing their account and never finish.
      //
      // Nothing about the code changes: same six digits, same three-minute
      // window, same `optVerification` check on the confirm step. Only WHERE
      // the user can read it. `discloseWhenLogOnly` (lib/mailDelivery.js)
      // returns `{}` on `NODE_ENV === "production"` before any opt-in flag is
      // consulted, so this is unreachable on a real deployment - and this route
      // is authenticated and acts only on `req.user.id`, so the code it
      // discloses belongs to the session already holding the account.
      const delivery = mailDeliveryFacts(process.env, "verification code");
      return res.status(200).json({
        success: true,
        status: "RESEND_OTP",
        message: delivery.delivered
          ? "Verification code sent to your email ID, Verification code is valid only for 3 minutes"
          : "No email was sent: mail delivery is switched off on this environment. Your verification code is shown below and is valid for 3 minutes.",
        ...delivery,
        ...discloseWhenLogOnly({ verificationCode: String(smsOtp) }),
      });
    }

    // Unreachable: the block above always answers. Kept as the belt-and-braces
    // terminator this handler needed when it had two conditional channels and
    // could fall off the end, leaving the request hanging until the client
    // timed out.
    // eslint-disable-next-line no-unreachable
    return res.status(400).json({ success: false, message: "Invalid type" });
  } catch (err) {
    console.log("errrrrrrrrrrrrrrrr", err);
    return res.status(500).json({ success: false, message: "Error on server" });
  }
};

/**
 * THE ONE ANSWER THAT MEANS "THIS CALL IS WHAT FROZE IT".
 *
 * walletapi's `standDownWallet` and both engines' `markStandDown` are written
 * as conditional, idempotent marks, and they report WHICH of the two things
 * happened:
 *
 *   "FROZEN"          the account was live, and THIS call closed it
 *   "ALREADY_FROZEN"  it was already closed before this call arrived, and the
 *                     call deliberately changed nothing - not even `frozenAt`
 *   "NO_WALLET"       there was nothing to freeze (walletapi only)
 *
 * Only the first is something a compensation may undo. See `undoFreezes`.
 */
export const FREEZE_APPLIED_MESSAGE = "FROZEN";

/**
 * Did THIS call apply the freeze, or did it merely find one already there?
 *
 * A WHITELIST, and deliberately so. Anything that is not a plain "yes, I froze
 * it" - a refusal, an empty message from a peer that predates the field, a
 * message this build has never heard of - is treated as "not mine to undo".
 * The two ways to be wrong here are not symmetric:
 *
 *   undoing a freeze that was NOT ours   silently hands an account an operator
 *                                        froze back to its owner. Nothing
 *                                        reports it; the operator finds out
 *                                        when the account acts again.
 *   failing to undo a freeze that WAS    leaves a live account locked out. The
 *                                        user notices within one click, the
 *                                        refusal is a 423 that names itself,
 *                                        and the restore is one gRPC call.
 *
 * The first is a silent security regression and the second is a loud support
 * ticket, so an unrecognised answer resolves to "leave it frozen" and is
 * LOGGED by the caller so the loud case stays findable.
 */
export const freezeAppliedByThisCall = (resp) =>
  !!resp && resp.status === true && resp.message === FREEZE_APPLIED_MESSAGE;

/**
 * PUT BACK THE FREEZES *THIS CALL* APPLIED.
 *
 * The compensating action for every refusal that happens after one or more of
 * the three reversible marks have been applied. Called with exactly the set
 * that was applied, and it undoes them in REVERSE order of application, so a
 * partial compensation never leaves a strictly worse arrangement than the
 * partial application it is undoing.
 *
 * "APPLIED" MEANS APPLIED BY THIS CALL, NOT "FROZEN RIGHT NOW"
 * ------------------------------------------------------------
 * These flags used to be passed as literal `true` at every call site, on the
 * reasoning that the freeze step had returned `status: true` and therefore the
 * account was frozen. It is - but an idempotent freeze answers `status: true`
 * for an account SOMEBODY ELSE froze just as readily as for one it froze
 * itself, so the compensation unfroze accounts it had never touched.
 *
 * Measured on this stack against a throwaway an operator had frozen through
 * walletapi directly (`deactivateWallet({ mode: "freeze" })` - an abuse hold,
 * nothing to do with account closure), with the shared `account_standdown`
 * mark made unreadable so the perpetual freeze refused:
 *
 *   before  wallet check -> { status: true, message: "ALREADY_FROZEN" }
 *   POST /api/user/deactive-confirm -> 503 DERIVATIVES_NOT_DEACTIVATED,
 *           "Nothing has changed - your positions, open orders and balances
 *            are untouched."
 *   after   wallet check -> { status: true, message: "READY" }
 *
 * The response was right that the ACCOUNT had not been deactivated and wrong
 * that nothing had changed: the operator's hold was gone, the user could move
 * value again, and the only trace was a log line about a perpetual freeze that
 * failed. Anyone who could reach `/deactive-confirm` with their own OTP could
 * clear their own operator freeze by making a later step fail.
 *
 * A compensation exists to restore the state its transaction found. The state
 * this one found was "already frozen", so leaving it frozen IS the correct
 * compensation, and `freezeAppliedByThisCall` above is how the caller tells the
 * two apart.
 *
 * Every undo is ATTEMPTED even if an earlier one fails: an unfreeze that cannot
 * be delivered is a support ticket, and skipping the other two would turn one
 * support ticket into three. Failures are logged with a distinct tag each,
 * because "the account is live but its inverse engine is still frozen" is a
 * state somebody has to be able to find.
 *
 * It deliberately reports nothing. The caller has already decided to answer
 * "nothing has been deactivated"; that answer is about the user's ACCOUNT,
 * which is true either way, and making it conditional on the compensation would
 * mean a failed unfreeze reported a deactivation that did not happen.
 */
export const undoFreezes = async (userId, applied = {}) => {
  if (applied.wallet) {
    const undo = await deactivateWallet({ userId, mode: "unfreeze" });
    if (!(undo && undo.status === true)) {
      console.log("DEACTIVATE_WALLET_UNFREEZE_FAILED", userId, undo);
    }
  }
};

/**
 * Confirm account deactivation
 * METHOD : POST
 * URL : /api/user/deactive-confirm   (passportAuth)
 * BODY : otp
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS A BLOCKER
 * ----------------------------------------------
 * The old body ran in exactly the wrong order:
 *
 *     checkUser.email = "anonymous@gmail.com";   // shred the identity
 *     ... 25 more fields wiped ...
 *     await checkUser.save();                    // COMMIT the shred
 *     removeKyc(...);   // (KYC has since been removed from this venue)
 *     await deactivateWallet(...);               // <-- throws, always
 *     await cancelOrderForDeactiveAcc(...);      // never runs
 *     await hdel("userToken", ...);              // never runs
 *
 * walletapi did not implement the `deactivateWallet` RPC at all - it was
 * declared in userapi's grpc/wallet.proto and absent from walletapi's - so
 * every call came back `12 UNIMPLEMENTED`. grpc/walletService.js was the one
 * client in that file with no `.catch()`, so the rejection propagated, and it
 * propagated AFTER the destructive save had already committed. The catch below
 * then answered "SOMETHING WRONG".
 *
 * Net effect, on every single deactivation, 100% of the time: the account was
 * irreversibly shredded, the caller was told the server had broken, the user's
 * open orders were left resting on the book, their wallet balances were left
 * stranded behind an identity nothing could reach, and - because the hdel never
 * ran and this service's sessions live entirely in the redis `userToken` hash -
 * their JWT stayed valid. A "deactivated" account you could still call
 * /api/user/profile with.
 *
 * THE SECOND BUG, WHICH THE FIRST FIX MOVED RATHER THAN REMOVED
 * ------------------------------------------------------------
 * The repair for the above put the dependent work first and refused to touch
 * the account if any of it failed - correct in itself, but it made
 * `cancelOrderForDeactiveAcc` the FIRST thing that ran, and that call is the
 * only irreversible step in the whole sequence. Since the wallet gate two
 * lines later failed 100% of the time, every deactivation attempt on a LIVE
 * account cancelled every resting order the user had and then told them
 * nothing had changed.
 *
 * It was worse than losing the orders. Measured on this stack, on a throwaway
 * account with two resting BTCUSD buys (0.01 and 0.02 at 7000):
 *
 *   before:  walletbalance_spot        9790     walletbalance_spot_inOrder  210
 *   attempt: HTTP 503 WALLET_NOT_DEACTIVATED, "nothing has changed"
 *   after:   walletbalance_spot       10000     walletbalance_spot_inOrder  210
 *
 * The 210 USD reservation was refunded to the spendable balance and NEVER
 * released from the in-order counter, because spotapi's cancel-for-deactivation
 * path goes through `createTradeHistory`, which credits `walletbalance_spot`
 * and - unlike the user-facing cancelOrder - never calls `releaseInOrder`. Free
 * balance is shown everywhere as total minus in-order, so the user silently and
 * permanently lost the use of 210 USD by pressing a button that reported
 * failure. Repeat the attempt, lose more.
 *
 * THE THIRD BUG, AND WHY IT CANNOT RECUR
 * --------------------------------------
 * The repaired sequence stood down the wallet, purged the session and swept the
 * SPOT book - and said nothing at all to the two derivative engines this venue
 * used to run, so a "closed" account kept its open leveraged positions, its
 * resting derivative orders and the margin locked behind them. That was fixed
 * by calling both engines, and both engines have since been REMOVED: this is a
 * spot-only venue with no perpetual and no inverse product, no positions, no
 * margin and no liquidation. The two freeze calls and the two teardown calls
 * are gone from the body below (see STEP 2 and STEP 5 there), which is a
 * correctness fix in its own right - a gRPC client pointed at a port with no
 * listener answers `{ status: false }`, and each of those calls refused the
 * whole deactivation on anything but `true`, so leaving them in would have made
 * every deactivation fail forever.
 *
 * WHAT IT DOES NOW
 * ----------------
 * 1. It only ever acts on req.user.id. See deactiveRequest for why.
 * 2. THE IRREVERSIBLE STEP GOES LAST. The order below is the whole point:
 *
 *      stand down the wallet     fallible, idempotent, and exactly undoable
 *      mark the account          local, and undone by the compensation
 *      purge the session         after this nothing can place a new order
 *      cancel resting orders     IRREVERSIBLE, and reached only once every
 *                                reversible step has already succeeded
 *
 *    So no failure can leave a still-live account with its orders cancelled
 *    and its in-order ledger inflated. A refusal at either of the two
 *    reversible steps returns with the book and every ledger bit-for-bit as
 *    they were, and that refusal UNDOES the wallet freeze if THIS call is what
 *    applied it, so nobody is left holding a frozen wallet on a live login.
 * 3. The session is purged BEFORE the orders are cancelled, deliberately.
 *    spotapi authenticates from the same redis `userToken` hash, so once the
 *    hdel has run the user cannot place an order that races the cancel.
 * 4. Every exit answers honestly, and says which of the two states it is in:
 *    "nothing changed" or "deactivated". There is no exit that claims the
 *    first while having done part of the second. A deactivation whose spot
 *    sweep did not succeed says so rather than reporting a clean closure.
 *
 * THE SPOT IN-ORDER DRIFT IS GONE (was: "REMAINING DRIFT, NOT FIXED HERE")
 * -----------------------------------------------------------------------
 * A successful deactivation used to leave `walletbalance_spot_inOrder` inflated
 * by the sum of the user's unfilled reservations, because spotapi's
 * cancel-for-deactivation path goes through `createTradeHistory`, which
 * credited `walletbalance_spot` and never called `releaseInOrder`. spotapi has
 * since closed that (controllers/spot.controller.js#createTradeHistory now
 * calls `releaseInOrder(checkOrder, currencyId, retriveValue, { final: true })`
 * the way cancelOrder does), and a live run on this stack confirms it:
 *
 *   a throwaway with one resting BTC/USD buy, 0.001 @ 30000
 *     before  walletbalance_spot[USD] 19970   _inOrder 30
 *     after   walletbalance_spot[USD] 20000   _inOrder  0
 *
 * 20000 either way - the reservation was refunded AND released, exactly once.
 * The reconciliation step the restore procedure used to carry is therefore no
 * longer needed; it is kept below only as a "verify", not as a "repair".
 *
 * IS DEACTIVATION REVERSIBLE? YES - DELIBERATELY.
 * ----------------------------------------------
 * It no longer shreds. It sets status/userLocked/deactivatedAt and stops.
 * Cryptodex is a paper-trading exchange: every balance is virtual, there is no
 * custody, no fiat rail and no KYC retention obligation, so nothing here
 * creates a legal or financial reason to destroy a record irrecoverably. The
 * old shred did not even achieve erasure - the row, the unique userId, the
 * wallets, the order history and the login history all
 * survived it. It bought no privacy and cost a recovery path, and it collapsed
 * every deactivated user onto the single shared address "anonymous@gmail.com"
 * (there are already two such rows in the local database), so nothing could
 * tell them apart afterwards. A reversible lock is strictly better here: it
 * keeps the paper ledger auditable, it keeps the user's own identity theirs,
 * and it makes an accidental deactivation a support ticket rather than a
 * bereavement. Genuine data erasure, if it is ever wanted, belongs in a
 * separate, explicitly-named, admin-mediated action - not behind a button
 * labelled "deactivate".
 *
 * HOW AN OPERATOR RESTORES ONE
 * ----------------------------
 * ONE mongo write and ONE gRPC call, plus one conditional redis field. Nothing
 * is reconstructed, because nothing was destroyed. (This procedure used to have
 * two more gRPC calls, one per derivative engine; both engines have been
 * removed and step 2b below replaces them.)
 *
 *   1. the user record (mongo `cryptodex_user`.`user`):
 *        db.user.updateOne(
 *          { email: "<addr>" },
 *          { $set: { status: "verified", userLocked: "false" },
 *            $unset: { deactivatedAt: "" } })
 *      All three fields matter: `userLocked: "true"` alone is enough to make
 *      userLogin answer "Your account is still locked".
 *   2. the wallet (walletapi): `deactivateWallet({ userId, mode: "unfreeze" })`
 *      - grpc/walletService.js from any node REPL that loads this service's
 *      config, or walletapi's own lib/walletStandDown.js#restoreWallet.
 *      Answers "RESTORED", or "ALREADY_LIVE" if it was never stood down.
 *   2b. THE SHARED REDIS MARK - not optional when it applies.
 *
 *      The mark lives in the redis hash `account_standdown`, field
 *      `<userId>` (with this stack's key prefix: `cryptodex_account_standdown`).
 *      It was written by the two engines' `deactivateDerivative` RPC, and it is
 *      still READ by spotapi and walletapi - both consult it BEFORE they ask
 *      walletapi, precisely so that a walletapi outage cannot un-freeze
 *      anybody. Nothing writes it any more, so an old
 *      mark now has no RPC that can clear it and WILL outlive a wallet-only
 *      restore: the user would be restored everywhere except that this hash
 *      still says they are stood down, and every value-moving route would keep
 *      refusing them.
 *
 *      Check it, and clear it only if it is set:
 *        redis-cli HGET cryptodex_account_standdown <userId>
 *        redis-cli HDEL cryptodex_account_standdown <userId>
 *
 *      An account deactivated after the engines were removed never gets a mark
 *      in the first place, and this step is a no-op for it.
 *   3. VERIFY, do not repair. `walletbalance_spot_inOrder[<userId>_<currencyId>]`
 *      used to be left over-stated by the reservations of the orders the
 *      closure cancelled; spotapi has fixed that (see "THE SPOT IN-ORDER DRIFT
 *      IS GONE" above) and the live run confirms it now nets to zero. If it is
 *      ever non-zero against no open orders, that is a spotapi regression to
 *      report - it is not a user balance ledger this service may write.
 *
 * The user then logs in with their original credentials and finds their
 * balances, order history and trade history exactly as they were. (This line
 * used to say "and 2FA"; two-factor authentication has been removed from this
 * venue, so there is no second factor left to find.) No session survives the
 * closure, so there is nothing to revoke on restore.
 *
 * THE LIVE RE-VERIFICATION (the four services this venue has)
 * ----------------------------------------------------------
 * The run this section used to describe was made against SEVEN services and
 * three products. There are four - frontend :3000, userapi :2567, spotapi
 * :2568, walletapi :3002 - and one product, so that run cannot be repeated and
 * quoting it was quoting a stack that no longer exists. Re-run end to end
 * through the real UI in Chromium, driving /security -> /deactive with a
 * throwaway account holding one resting spot BTC/USD buy, 0.001 @ 30000:
 *
 *   before   walletbalance_spot[USD] 970    _inOrder 30
 *            spot orderHistory        [{ buy, 30000, 0.001, "open" }]
 *
 *   POST /api/user/deactive-req     -> 200, delivered:false, the six-digit code
 *                                      returned in the body and shown on screen
 *   POST /api/user/deactive-confirm -> 200 {"status":"DEACTIVATED","positionsOpen":0}
 *
 *   after    walletbalance_spot[USD] 1000   _inOrder  0
 *            spot orderHistory        [{ buy, 30000, 0.001, "cancel" }]
 *            user doc                 status "deactivated", userLocked "true",
 *                                     deactivatedAt set, e-mail INTACT
 *            redis cryptodex_userToken  field absent - the session is gone
 *   POST /api/auth/login            -> "Your account is still locked"
 *
 * 1000 either way: the 30 USD reservation was refunded AND released, exactly
 * once, which is the drift described two sections up staying fixed.
 *
 * NOT re-measured in that run, and said rather than implied: the restore
 * procedure above. Putting an account back is three writes an operator makes
 * deliberately, and this pass had no reason to make them.
 */
export const confirmDeActive = async (req, res) => {
  try {
    const reqBody = req.body;
    if (isEmpty(reqBody.otp)) {
      return res
        .status(400)
        .json({ success: false, message: "Please enter the otp" });
    }

    const userId = req.user.id;
    const checkUser = await User.findById(userId);
    if (!checkUser) {
      return res.status(400).json({ success: false, message: "Invalid user" });
    }

    if (checkUser.status === "deactivated") {
      return res.status(400).json({
        success: false,
        status: "ALREADY_DEACTIVATED",
        message: "Your account is already deactivated",
      });
    }

    // Which stored code to check is decided by the channel deactiveRequest
    // actually sent on, not by a client-supplied roleType. The two endpoints
    // used opposite roleType conventions, so trusting the body here let a
    // request issued over SMS be confirmed with an email code.
    const channel = checkUser.deactiveOtpChannel;
    if (channel !== "email" && channel !== "mobile") {
      return res.status(400).json({
        success: false,
        status: "NO_PENDING_REQUEST",
        message: "Please request a deactivation code first",
      });
    }

    const otpResp = await optVerification(
      channel === "email" ? 2 : 1,
      checkUser,
      reqBody.otp
    );
    if (!otpResp.status) {
      return res.status(400).json({
        success: false,
        message: otpResp.message,
        error: { otp: otpResp.message },
      });
    }

    // THE COMPENSATION LEDGER. Each flag is set only once the corresponding
    // service has told us that THIS call is what closed it, so every refusal
    // below can hand `undoFreezes` the exact set it applied and nothing else.
    // A mark that was already there when we arrived belongs to whoever put it
    // there, and is never in this object. See `freezeAppliedByThisCall`.
    const applied = { wallet: false };
    const recordFreeze = (which, resp) => {
      applied[which] = freezeAppliedByThisCall(resp);
      if (!applied[which]) {
        // Not an error - the usual cause is a pre-existing operator freeze, or
        // a retry of a deactivation that already got this far - but it IS the
        // reason a later refusal will leave this mark in place, so it is said
        // out loud rather than inferred from silence.
        console.log(
          "DEACTIVATE_FREEZE_NOT_APPLIED_BY_THIS_CALL",
          which,
          userId,
          resp && resp.message
        );
      }
    };

    // ---- STEP 1: stand the wallet down ------------------------------------
    // The one cross-service call that has to succeed before anything is
    // committed, and the only one that is exactly undoable if a later step
    // fails. It is idempotent on walletapi's side, so a retried deactivation
    // does not double-apply it or move the recorded closure time.
    //
    // Nothing has been written when this refuses: no orders cancelled, no
    // ledger touched, no field on the user changed. That is the whole reason
    // it is first.
    const walletStatus = await deactivateWallet({ userId });
    if (!(walletStatus && walletStatus.status === true)) {
      console.log("DEACTIVATE_ABORTED_WALLET", userId, walletStatus);
      return res.status(503).json({
        success: false,
        status: "WALLET_NOT_DEACTIVATED",
        message:
          "Could not stand down your wallets, so your account has NOT been deactivated. Nothing has changed - your open orders and balances are untouched. Please try again shortly.",
      });
    }
    recordFreeze("wallet", walletStatus);

    // ---- STEP 2: (gone) freeze the derivative engines ----------------------
    // There were two more freezes here, one per derivative engine, and both
    // engines have been removed - this venue is spot only. The step is deleted
    // rather than left calling into nothing, and that is a CORRECTNESS fix, not
    // tidying: each call refused the whole deactivation on `status !== true`,
    // and a gRPC client pointed at a port with no listener answers
    // `{ status: false, error: "Error on Connection" }`. Left in place, every
    // single `/deactive-confirm` would have answered
    // 503 DERIVATIVES_NOT_DEACTIVATED and no account could ever be closed
    // again.
    //
    // The stand-down MECHANISM is untouched: STEP 1 above stands the wallet
    // down through walletapi, which is the authority every surviving service
    // reads, and STEP 5 below still sweeps the spot book.

    // ---- STEP 3: mark the account -----------------------------------------
    // The KYC shred that used to run here is gone with KYC itself. Nothing
    // else in this sequence depended on it.

    try {
      checkUser.status = "deactivated";
      checkUser.userLocked = "true";
      checkUser.deactivatedAt = new Date();
      checkUser.emailOTP = "";
      checkUser.emailOTPtime = null;
      checkUser.otp = "";
      checkUser.otptime = null;
      checkUser.phoneOTP = "";
      checkUser.requestType = "";
      checkUser.deactiveOtpChannel = "";
      checkUser.login_attempt = 0;
      checkUser.isBlock = false;
      checkUser.updatedAt = new Date();
      await checkUser.save();
    } catch (saveErr) {
      // COMPENSATE. The wallet is stood down and the account is not: left
      // alone that is a live user who cannot move their own funds and has no
      // idea why.
      // Put back the freeze if THIS call applied it, and report that nothing
      // changed -
      // which, once those unfreezes land, is true. A mark that was already
      // there when we arrived is not ours, and "nothing changed" is true of it
      // precisely BECAUSE it is left alone.
      console.log("DEACTIVATE_ACCOUNT_WRITE_FAILED", userId, saveErr);
      await undoFreezes(userId, applied);
      return res.status(503).json({
        success: false,
        status: "ACCOUNT_NOT_DEACTIVATED",
        message:
          "Your account has NOT been deactivated. Nothing has changed. Please try again shortly.",
      });
    }

    // ---- STEP 4: the account is closed; finish the closure -----------------
    // Past this line the deactivation has happened and no failure can undo it,
    // so both remaining actions are ATTEMPTED and then reported - never
    // short-circuited past one another.

    // Session dies with the account. userLogin already refuses a userLocked /
    // non-verified account, so nothing can mint a replacement in this window.
    // This runs before the order cancel on purpose: spotapi authenticates from
    // the same redis `userToken` hash, so once it has run the user cannot place
    // an order that races the cancel below.
    let sessionPurged = true;
    try {
      await hdel("userToken", userId.toString());
    } catch (sessionErr) {
      sessionPurged = false;
      console.log("DEACTIVATE_SESSION_PURGE_FAILED", userId, sessionErr);
    }

    // ---- STEP 5: cancel the resting orders, LAST --------------------------
    // The only irreversible step, and therefore the last one. Reaching this
    // line means the wallet is down, the account is marked and the session is
    // gone: there is no longer any way for a failure here to leave a LIVE
    // account with its orders cancelled and its in-order ledger inflated,
    // which is exactly what used to happen on every single attempt.
    //
    // It is ATTEMPTED and then reported, never used as a gate. There is one
    // book now, so "which sweep must not block which" is no longer a question
    // this code has to answer.
    const orderStatus = await cancelOrderForDeactiveAcc({ userId });
    const spotCancelled = !!(orderStatus && orderStatus.status === true);
    if (!spotCancelled) {
      console.log("DEACTIVATE_ORDERS_NOT_CANCELLED", userId, orderStatus);
    }

    // The two derivative teardowns that used to follow the spot sweep are gone
    // with their engines. They cancelled resting derivative orders, which was
    // the dangerous half of the sweep - a resting derivative order that filled
    // after closure opened NEW leveraged exposure on an account its owner could
    // no longer see. There is no such order on a spot-only venue, and the spot
    // sweep above is now the whole of it.

    const ordersCancelled = spotCancelled;

    // No exposure can be left standing: there is no product on this venue that
    // creates a position.
    const positionsOpen = 0;

    if (!sessionPurged) {
      return res.status(500).json({
        success: false,
        status: "SESSION_NOT_PURGED",
        message:
          "Your account was deactivated but an existing session could not be ended. Please contact support.",
      });
    }

    // The sentence that used to be appended here - "N open derivative
    // positions remain open with margin reserved, and can still be liquidated"
    // - is gone with the engines that could produce one. `positionsOpen` is a
    // literal 0 above, so the branch was unreachable; what it left behind was
    // margin/liquidation vocabulary sitting in a spot-only service's most
    // important user-facing message, one edit away from being shown again. The
    // FIELD stays in the response (userapi
    // tests/integration/user-api.integration.test.js asserts it, and a client
    // reading "how much exposure survived this closure" should keep getting an
    // explicit 0 rather than `undefined`).

    if (!ordersCancelled) {
      // The account IS deactivated - saying otherwise would be the same lie in
      // the other direction - but somebody has to go and clear the book.
      return res.status(200).json({
        success: true,
        status: "DEACTIVATED_ORDERS_PENDING",
        positionsOpen,
        message:
          "Your account has been deactivated, but some of your open orders could not be cancelled. Please contact support so they can be removed.",
      });
    }

    return res.status(200).json({
      success: true,
      status: "DEACTIVATED",
      positionsOpen,
      message: "Your account deactivated successfully.",
    });
  } catch (err) {
    console.log("-----err", err);
    return res.status(500).json({
      success: false,
      status: "DEACTIVATION_FAILED",
      message:
        "Your account has NOT been deactivated. Nothing has changed. Please try again shortly.",
    });
  }
};
// THREE MODE WRITERS USED TO LIVE HERE, exported only so grpc/server.js could
// bind them. Every caller was deleted in 1f0dc62; the writers survived, still
// writing settings nothing read and mirroring them into the redis session,
// reachable by anyone who could reach the gRPC port.
//
// Two went in the earlier pass. `changeLeverage` was the third and is now gone
// with them, along with its `rpc changeLeverage` in grpc/user.proto and its
// binding in grpc/server.js. Nothing in any of the four services called it -
// grepped across frontend, spotapi, walletapi and userapi.
//
// It had to go in the SAME change that dropped `leverage` from
// models/userSetting.js, not after it. Mongoose strict mode silently strips an
// undeclared path out of an update: with `leverage` removed from the schema,
// `$set: { leverage }` casts to `{}`, findByIdAndUpdate still returns a
// document, and this function would have gone on answering `{ status: true }`
// having written nothing at all. A working-looking RPC that writes nothing is
// worse than one that is deleted.

(async function () {
  try {
    console.log("adminLiqadminLiq");
    let adminLiq = await User.findOne({ role: "admin_bot" }).lean();
    console.log("adminLiqadminLiq", adminLiq);
    if (adminLiq) {
      await hset("admin_liquidity", "liquidation", adminLiq);
    }
  } catch (err) {
    console.log(err, "----------2911");
  }
}); // this one for only on admin liquidity


/**
 * POST /api/user/showPair - "show this market on my dashboard".
 *
 * THIS ROUTE HAD FIVE BRANCHES AND FOUR OF THEM WROTE DEAD PREFERENCES, WITH
 * THE DEAD ONE AS THE DEFAULT.
 *
 * The chain was `perpetual-showfuture` -> `inverse-showfuture` -> `spot-show`
 * -> `perpetual-showopen` -> ELSE `{ showOInverse }`. Four of those name the two
 * derivative products deleted in 1f0dc62, and because the last was the
 * fall-through, ANY unrecognised `type` - a typo, a stale client, an empty body
 * - silently wrote `showOInverse: undefined` onto the settings document and
 * answered 200 "Done". The only caller left in the product sends
 * `type: "spot-show"` (frontend components/spot/HomePage.tsx), so the other
 * four were unreachable except by hand.
 *
 * It also mirrored all four dead flags into the redis session on every call,
 * which would have put back exactly what login now refuses to publish (see
 * `withoutDerivativePreferences` in auth.controller.js).
 *
 * So: one branch, named explicitly, and an unknown type is a 400 rather than a
 * silent write. The four dead flags are no longer schema paths either -
 * models/userSetting.js has dropped them - so a reinstated branch would now
 * write nothing at all.
 */
export const showPair = async (req, res) => {
  try {
    let reqBody = req.body;
    if (reqBody.type !== "spot-show") {
      return res.status(400).json({
        status: false,
        message:
          "Unknown preference. This venue trades spot only, so `spot-show` is " +
          "the one setting this endpoint changes. Nothing has been changed.",
      });
    }
    let updateMode = await UserSetting.findByIdAndUpdate(
      ObjectId(req.user.id),
      { $set: { showSpot: reqBody.showSpot } },
      { new: true }
    );
    if (updateMode) {
      let usertoken = await hget("userToken", req.user.id.toString());
      usertoken = JSON.parse(usertoken);
      usertoken = {
        ...usertoken,
        ...{ showSpot: updateMode.showSpot },
      };
      let update = await hset("userToken", req.user.id.toString(), usertoken);
      return res.status(200).json({ status: true, message: "Done" })
    }
    // Was `else return { status: false };` - a plain object handed back to
    // express, which does nothing with a handler's return value. No status, no
    // body, no `next()`: the request hung. Reached whenever the user has no
    // UserSetting document for findByIdAndUpdate to hit.
    return res
      .status(400)
      .json({ status: false, message: "No settings found for this account" });
  } catch (err) {
    console.log("-----err", err);
    return res.status(500).json({ status: false, message: "Something Wrong" })
  }
};

/**
 * Edit Cryptodex Fee
 * METHOD : PUT
 * URL : /api/updateCryptodexFee
 * BODY : enableCryptodexFee
 */
export const updateCryptodexFee = async (req, res) => {
  try {
    let reqBody = req.body;

    if (isEmpty(reqBody.enableCryptodexFee) || !isBoolean(reqBody.enableCryptodexFee)) {
      return res.status(400).json({ success: false, message: "Something went wrong" });
    }

    let usrSetting = await UserSetting.findOneAndUpdate(
      {
        userId: req.user.id,
      },
      {
        $set: {
          enableCryptodexFee: reqBody.enableCryptodexFee
        }
      },
      {
        new: true,
        projection: {
          enableCryptodexFee: 1,
        }
      }
    );

    if (!usrSetting) {
      return res.status(400).json({ success: false, message: "Something went wrong" });
    }

    await hmset("userSetting_" + req.user.id.toString(), {
      'enableCryptodexFee': reqBody.enableCryptodexFee,
    });

    let updateData = await usrSetting.save();
    return res.status(200).json({
      success: true,
      message: "Settings updated successfully!",
      result: {
        enableCryptodexFee: updateData.enableCryptodexFee,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};