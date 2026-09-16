import ApiService from "./ApiService";

export async function apiSignIn(data) {
  return ApiService.fetchData({
    url: "auth/login",
    method: "post",
    data,
  });
}
// `verifyOtp` (auth/verifyOtp) is gone with its route. It never had a caller:
// the login screen's OTP box submits the code back through `apiSignIn`
// (auth/login) together with the credentials, not to a separate verify step.
export async function apiSignUp(data) {
  return ApiService.fetchData({
    url: "auth/register",
    method: "post",
    data,
  });
}
export async function apiMailResend(data) {
  return ApiService.fetchData({
    url: "auth/resend-mail",
    method: "post",
    data,
  });
}

export async function apiSignOut(data) {
  return ApiService.fetchData({
    url: "auth/sign-out",
    method: "post",
    data,
  });
}

export async function apiForgotPassword(data) {
  return ApiService.fetchData({
    url: "auth/forgotPassword",
    method: "post",
    data,
  });
}

export async function apiResetPassword(data) {
  return ApiService.fetchData({
    url: "auth/resetPassword",
    method: "post",
    data,
  });
}

export async function userEmailActivation(data) {
  return ApiService.fetchData({
    url: "auth/confirm-mail",
    method: "post",
    data,
  });
}

export async function resetPasswordVerification(data) {

  return ApiService.fetchData({
    url: "auth/resetconfirmMail",
    method: "post",
    data,
  });
}

// `fiatRequestVerify` (auth/fiatWithdraw) and `coinRequestVerify`
// (auth/coinWithdraw) went with withdrawal itself. Both PATCHed a route userapi
// no longer mounts, to confirm a withdrawal from an e-mailed link; this venue
// holds no custody, so there is nothing to confirm. Nothing called these two
// anyway - pages/verification/[id].js reached for the identically named pair in
// services/Wallet/WalletService, which have gone the same way.

export async function resendOtp(data) {
  return ApiService.fetchData({
    url: "auth/resend-otp",
    method: "post",
    data,
  });
}

// `getCMS` (auth/cms) went with the CMS. Nothing called it: /privacy-policy and
// /terms defined their copy in this repository rather than fetching it, so a CMS
// outage could not serve a blank legal page - and those two pages are now deleted
// as well, leaving no legal surface at all. `apiCheckUserName` went with it too:
// auth/checkUserName
// has no route in userapi and had no caller here.

