// SPOT-ONLY PAPER VENUE: the 2FA, KYC, anti-phishing and login-history calls
// were removed here together with the endpoints behind them (userapi
// routes/user.route.js). Leaving a client for a route that no longer exists
// only produces 404s at the point a user clicks something.
//
// A SECOND ROUND removed more of userapi with the same rule applied:
//
//   support tickets   user/support (GET/POST/PUT/PATCH), user/getSupportCategory
//   announcements     user/announcement
//   contact form      user/addContactus
//   phone and SMS     user/sendOTP with roleType 2, user/phoneChange
//   CRYPTODEX fee       user/setting/updateCryptodexFee
//   referrals         user/getReferral* (already pointing at routes that no
//                     longer existed)
//
// TWO THAT WENT FOR A DIFFERENT REASON — their only caller could never
// succeed, so keeping the client would keep a dead control on screen:
//
//   apiEmailUpdate    user/emailChange verifies an SMS one-time code
//                     (`optVerification(1, ...)` reads `user.otp`, which only
//                     the roleType-2 SMS branch of requestOTP ever writes).
//                     With SMS gone nothing can produce that code, so the
//                     "Secure Email -> Modify" flow could not complete. The
//                     ROUTE still exists in userapi; the client does not,
//                     because the screen behind it does not.
//   assetPassUpdate   user/asset-password wrote a credential nothing on this
//                     venue ever challenged. Its modal was already unmounted.
//
// WHAT SURVIVES AND MUST KEEP SURVIVING: `apiEmailOTPRequest` posts to
// user/sendOTP with **roleType 1** — the E-MAIL one-time code. That is not the
// phone OTP. Change password cannot complete without it: userapi's
// `changePassword` verifies the submitted code with `optVerification(2, ...)`,
// and only the roleType-1 arm of requestOTP ever writes the field it reads.
// Change password is explicitly a kept feature, so user/sendOTP must stay.
import ApiService from "./ApiService";

export async function apiGetUserProfile() {
  return ApiService.fetchData({
    url: "user/profile",
    method: "get",
  });
}

export async function apiPasswordChange(data) {
  return ApiService.fetchData({
    url: "user/changePassword",
    method: "post",
    data,
  });
}

export async function apiGetUserSetting(data) {
  return ApiService.fetchData({
    url: "user/userSetting",
    method: "get",
    data,
  });
}

export async function apiUpdateUserSetting(data) {
  return ApiService.fetchData({
    url: "user/userSetting",
    method: "put",
    data,
  });
}

export async function apiSiteSettingUpdate(data) {
  return ApiService.fetchData({
    url: "user/setting",
    method: "put",
    data,
  });
}

export async function apiSiteSettings(data) {
  return ApiService.fetchData({
    url: "user/setting",
    method: "get",
    params: data,
  });
}

// NOT a second factor. This posts to user/sendOTP with roleType 1 - the e-mail
// one-time code that change-password uses - and was named `apiTwoFAOTPRequest`
// while 2FA existed elsewhere in the file. With 2FA removed the old name was
// the only thing left in the client implying an authenticator. The SMS arm
// (roleType 2) went with the phone surface, and userapi's requestOTP no longer
// has that branch at all.
//
// Its twin `apiEmailOTPVerify` (user/verifyOtp) went too: that ROUTE has been
// removed from userapi, and nothing here called it. Change password does not
// need it - it posts the code straight to user/changePassword, which verifies
// it itself with `optVerification(2, ...)`.
export async function apiEmailOTPRequest(data) {
  return ApiService.fetchData({
    url: "user/sendOTP",
    method: "post",
    data,
  });
}

export async function apigetSiteSetting(data) {
  return ApiService.fetchData({
    url: "user/siteSetting",
    method: "get",
    data,
  });
}

export async function deactiveReq(data) {
  return ApiService.fetchData({
    url: "user/deactive-req",
    method: "post",
    data,
  });
}

export async function deactiveConfirm(data) {
  return ApiService.fetchData({
    url: "user/deactive-confirm",
    method: "post",
    data,
  });
}

export async function changePair(data) {
  return ApiService.fetchData({
    url: "user/change-pair",
    method: "post",
    data,
  });
}
