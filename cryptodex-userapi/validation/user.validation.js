// import package
import mongoose from "mongoose";

// import lib
import isEmpty, { isBoolean } from "../lib/isEmpty.js";
import { recaptchaVerificationRequired } from "../lib/recaptcha.js";

/**
 * Whether a reCAPTCHA token must be present on the request.
 *
 * The client can only supply one when GoogleReCaptchaProvider actually mounts,
 * which it does not on a host whose site key cannot serve it (a plain localhost
 * dev box). Demanding a token there rejects every registration and password
 * reset with "ReCAPTCHA field is required" and leaves the product unreachable.
 *
 * This gates only the PRESENCE check. The real defence is checkToken() in
 * lib/recaptcha.js, which verifies the token with Google in the controllers;
 * turning that back on is a separate, deliberate decision. Production always
 * requires the token: the opt-out needs an explicit non-production signal, so a
 * deploy that merely forgot to set NODE_ENV still enforces it.
 *
 * The environment decision itself now lives in lib/recaptcha.js so that the
 * presence check here and the verification check in the controllers can never
 * disagree about which deployments enforce reCAPTCHA.
 */
const recaptchaRequired = () => recaptchaVerificationRequired();

/**
 * Create New User Validataion
 * URL: /api/register
 * METHOD : POST
 * BODY : email, password, confirmPassword, reCaptcha, isTerms
 */
export const registerValidate = (req, res, next) => {
  let errors = {},
    reqBody = req.body;
  let passwordRegex = /^(?=.*\d)(?=.*[A-Z])(?=.*[a-z])(?=.*\W).{6,18}/g;
  let emailRegex =
    /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,6}))$/;

  if (reqBody.roleType == 1) {
    if (isEmpty(reqBody.email)) {
      errors.email = "Email field is required";
    } else if (!emailRegex.test(reqBody.email)) {
      errors.email = "Email is invalid";
    }
    if (reqBody.roleType == 2) {
      if (isEmpty(reqBody.newPhoneNo)) {
        errors.newPhoneNo = "Please enter your mobile number";
      }
    }
    if (isEmpty(reqBody.password)) {
      errors.password = "Password field is required";
    } else if (!passwordRegex.test(reqBody.password)) {
      errors.password =
        "Password should contain at least one uppercase, at least one lowercase, at least one number, at least one special character, and minimum 6 and maximum 18 characters";
    } else if (reqBody.password.length < 8 || reqBody.password.length > 18) {
      errors.password =
        "Password should contain atleast one uppercase, atleast one lowercase, atleast one number, atleast one special character and minimum 8 and maximum 18";
    }
    if (isEmpty(reqBody.confirmPassword)) {
      errors.confirmPassword = "Confirm password field is required";
    }
    if (
      !isEmpty(reqBody.password) &&
      !isEmpty(reqBody.confirmPassword) &&
      reqBody.password != reqBody.confirmPassword
    ) {
      errors.confirmPassword = "Passwords must match";
    }

    if (recaptchaRequired() && isEmpty(reqBody.reCaptcha)) {
      errors.reCaptcha = "ReCAPTCHA field is required";
    }
  } else {
    if (reqBody.roleType == 2) {
      if (isEmpty(reqBody.newPhoneNo)) {
        errors.newPhoneNo = "Please enter your mobile number";
      }
      if (isEmpty(reqBody.newPhoneCode)) {
        errors.newPhoneCode = "Please select your country";
      }
      if (isEmpty(reqBody.password)) {
        errors.password = "Password field is required";
      }
      if (isEmpty(reqBody.confirmPassword)) {
        errors.confirmPassword = "Confirm password field is required";
      }
      if (
        !isEmpty(reqBody.password) &&
        !isEmpty(reqBody.confirmPassword) &&
        reqBody.password != reqBody.confirmPassword
      ) {
        errors.confirmPassword = "Passwords must match";
      }
      if (recaptchaRequired() && isEmpty(reqBody.reCaptcha)) {
        errors.reCaptcha = "ReCAPTCHA field is required";
      }
    }
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }
  return next();
};

export const loginValidate = (req, res, next) => {
  let errors = {},
    reqBody = req.body;
  let emailRegex =
    /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,6}))$/;

  if (reqBody.roleType == 1) {
    if (isEmpty(reqBody.email)) {
      errors.email = "Email field is required";
    } else if (!emailRegex.test(reqBody.email)) {
      errors.email = "Invalid email";
    }
  }
  if (reqBody.roleType == 2) {
    if (isEmpty(reqBody.newPhoneCode)) {
      errors.newPhoneNo = "Please enter your country code";
    }
    if (isEmpty(reqBody.newPhoneNo)) {
      errors.newPhoneNo = "Please enter your mobile number";
    }
  }
  if (isEmpty(reqBody.password)) {
    errors.password = "Password field is required";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

/**
 * Email Verification
 * METHOD : POST
 * URL : /api/confirm-mail
 * BODY : userId
 */
export const confirmMailValidate = (req, res, next) => {
  let errors = {},
    reqBody = req.body;

  if (isEmpty(reqBody.authToken)) {
    errors.authToken = "AuthToken field is required";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};
export const activateRegsiterUser = (req, res, next) => {
  let errors = {},
    reqBody = req.body;

  if (isEmpty(reqBody.userId)) {
    errors.userId = "AuthToken field is required";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

/**
 * Edit User Profile
 * METHOD : PUT
 * URL : /api/userProfile
 * BODY : firstName,lastName,blockNo,address,country,state,city,postalCode
 */
export const editProfileValidate = (req, res, next) => {
  let errors = {},
    reqBody = req.body;

  if (isEmpty(reqBody.firstName)) {
    errors.firstName = "Enter your first name";
  }

  if (isEmpty(reqBody.lastName)) {
    errors.lastName = "Enter your last name";
  }

  if (isEmpty(reqBody.address)) {
    errors.address = "Enter your address";
  }

  if (isEmpty(reqBody.country)) {
    errors.country = "Please select one country";
  }

  if (isEmpty(reqBody.city)) {
    errors.city = "Please select one city";
  }

  if (isEmpty(reqBody.postalCode)) {
    errors.postalCode = "Enter your postal code";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

/**
 * Change New Password
 * METHOD : POST
 * URL : /api/changePassword
 * BODY : password, confirmPassword, oldPassword
 */
export const changePwdValidate = (req, res, next) => {
  let errors = {};
  let reqBody = req.body;
  let passwordRegex = /^(?=.*\d)(?=.*[A-Z])(?=.*[a-z])(?=.*\W).{6,18}/g;

  if (isEmpty(reqBody.oldPassword)) {
    errors.oldPassword = "Old password field is required";
  }

  if (isEmpty(reqBody.password)) {
    errors.password = "New password field is required";
  } else if (!passwordRegex.test(reqBody.password)) {
    errors.password =
      "Password should contain atleast one uppercase, atleast one lowercase, atleast one number, atleast one special character and minimum 6 and maximum 18";
  } else if (reqBody.password.length < 6 || reqBody.password.length > 18) {
    errors.password =
      "Password should contain atleast one uppercase, atleast one lowercase, atleast one number, atleast one special character and minimum 6 and maximum 18";
  }
  if (isEmpty(reqBody.otp)) {
    errors.otp = "OTP is required";
  } else if (isNaN(reqBody.otp)) {
    errors.otp = "Invalid OTP";
  }
  if (isEmpty(reqBody.confirmPassword)) {
    errors.confirmPassword = "Confirm password field is required";
  } else if (
    !isEmpty(reqBody.password) &&
    !isEmpty(reqBody.confirmPassword) &&
    reqBody.password != reqBody.confirmPassword
  ) {
    errors.confirmPassword = "Confirm Passwords must match";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

export const editSettingValid = (req, res, next) => {
  let errors = {};
  let reqBody = req.body;

  if (isEmpty(reqBody.theme)) {
    errors.theme = "Required";
  }

  if (isEmpty(reqBody.currencySymbol)) {
    errors.currencySymbol = "Required";
  }

  if (
    reqBody.afterLogin &&
    (isEmpty(reqBody.afterLogin.page) || isEmpty(reqBody.afterLogin.url))
  ) {
    errors.afterLogin = "Required";
  } else if (!reqBody.afterLogin) {
    errors.afterLogin = "Required";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

/**
 * Edit User Notification
 * METHOD : PUT
 * URL : /api/editNotif
 * BODY : name, checked
 */
export const editNotifValid = (req, res, next) => {
  let errors = {};
  let reqBody = req.body;

  if (isEmpty(reqBody.name)) {
    errors.name = "Required";
  }

  if (isEmpty(reqBody.checked)) {
    errors.checked = "Required";
  } else if (!isBoolean(reqBody.checked)) {
    errors.checked = "Invalid value";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

/**
 * Check Forgot Password
 * METHOD : POST
 * URL : /api/forgotPassword
 * BODY : email
 */
export const checkForgotPwdValidate = (req, res, next) => {
  let errors = {},
    reqBody = req.body,
    emailRegex =
      /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,6}))$/;

  if (reqBody.roleType == 1) {
    if (isEmpty(reqBody.email)) {
      errors.email = "Please enter your email";
    } else if (!emailRegex.test(reqBody.email)) {
      errors.email = "Please enter valid email address";
    }
  }
  if (reqBody.roleType == 2) {
    if (isEmpty(reqBody.newPhoneCode)) {
      errors.newPhoneNo = "Please enter your country code";
    }
    if (isEmpty(reqBody.newPhoneNo)) {
      errors.newPhoneNo = "Please enter your mobile number";
    }
  }
  if (recaptchaRequired() && isEmpty(reqBody.reCaptcha)) {
    errors.reCaptcha = "ReCAPTCHA field is required";
  }
  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }
  return next();
};

/**
 * Reset Password Without Login
 * METHOD : POST
 * URL : /api/resetPassword
 * BODY : password, confirmPassword, authToken
 */
export const resetPwdValidate = (req, res, next) => {
  let errors = {},
    reqBody = req.body,
    passwordRegex = /^(?=.*\d)(?=.*[A-Z])(?=.*[a-z])(?=.*\W).{6,18}/g;

  if (isEmpty(reqBody.authToken)) {
    errors.authToken = "AuthToken field is required";
  }

  if (isEmpty(reqBody.password)) {
    errors.password = "Password field is required";
  } else if (!passwordRegex.test(reqBody.password)) {
    errors.password =
      "Password should contain atleast one uppercase, atleast one lowercase, atleast one number, atleast one special character and minimum 6 and maximum 18";
  } else if (reqBody.password.length > 18) {
    errors.password =
      "Password should contain atleast one uppercase, atleast one lowercase, atleast one number, atleast one special character and minimum 6 and maximum 18";
  }

  if (isEmpty(reqBody.confirmPassword)) {
    errors.confirmPassword = "Confirm password field is required";
  } else if (
    !isEmpty(reqBody.password) &&
    !isEmpty(reqBody.confirmPassword) &&
    reqBody.password != reqBody.confirmPassword
  ) {
    errors.confirmPassword = "Passwords must match";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

export const editEmailValidate = (req, res, next) => {
  let errors = {},
    reqBody = req.body;
  let emailRegex =
    /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,6}))$/;

  if (isEmpty(reqBody.newEmail)) {
    errors.newEmail = "Email field is required";
  } else if (!emailRegex.test(reqBody.newEmail)) {
    errors.newEmail = "Email is invalid";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

/**
 * Verify the old email(Edit Email)
 * METHOD : PUT
 * URL : /api/emailChange
 * BODY : token
 */
export const tokenValidate = (req, res, next) => {
  let errors = {},
    reqBody = req.body;

  if (isEmpty(reqBody.token)) {
    errors.token = "Token field is required";
  }

  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

export const emailChangeValidation = (req, res, next) => {
  let errors = {},
    reqBody = req.body;
  let emailRegex =
    /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,6}))$/;
  if (isEmpty(reqBody.otp)) {
    errors.otp = "Required";
  }
  if (isEmpty(reqBody.email)) {
    errors.email = "Email field is required";
  } else if (!emailRegex.test(reqBody.email)) {
    errors.email = "Email is invalid";
  }
  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};

export const assetPasswordValid = (req, res, next) => {
  let errors = {},
    reqBody = req.body;
  let passwordRegex = /^(?=.*\d)(?=.*[A-Z])(?=.*[a-z])(?=.*\W).{6,18}/g;
  if (isEmpty(reqBody.password)) {
    errors.password = "Password field is required";
  } else if (!passwordRegex.test(reqBody.password)) {
    errors.password =
      "Password should contain atleast one uppercase, atleast one lowercase, atleast one number, atleast one special character and minimum 8 and maximum 18";
  } else if (reqBody.password.length < 8 || reqBody.password.length > 18) {
    errors.password =
      "Password should contain atleast one uppercase, atleast one lowercase, atleast one number, atleast one special character and minimum 8 and maximum 18";
  }
  if (isEmpty(reqBody.confirmPassword)) {
    errors.confirmPassword = "Confirm password field is required";
  } else if (reqBody.password != reqBody.confirmPassword) {
    errors.confirmPassword = "Passwords must match";
  }
  if (isEmpty(reqBody.otp)) {
    errors.otp = "OTP field is required";
  }
  if (!isEmpty(errors)) {
    return res.status(400).json({ errors: errors });
  }

  return next();
};
