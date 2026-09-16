// import package
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import crypto from "crypto";

// import config
import config from "../config/index.js";

const Schema = mongoose.Schema;
const ObjectId = Schema.ObjectId;

const BankDetailsSchema = new Schema({
  bankName: {
    type: String,
    default: "",
  },
  accountNo: {
    type: String,
    default: "",
  },
  holderName: {
    type: String,
    default: "",
  },
  bankcode: {
    type: String,
    default: "",
  },
  country: {
    type: String,
    default: "",
  },
  city: {
    type: String,
    default: "",
  },
  bankAddress: {
    type: String,
    default: "",
  },
  currencyId: {
    type: ObjectId,
  },
  currencySymbol: {
    type: String,
    default: "",
  },
  isPrimary: {
    type: Boolean,
    default: false,
  },
});

const UPIDetailsSchema = new Schema({
  upiId: {
    type: String,
    default: "",
  },
  isPrimary: {
    type: Boolean,
    default: false,
  },
});

const QRDetailsSchema = new Schema({
  frontImage: {
    type: String,
    default: "",
  },
  isPrimary: {
    type: Boolean,
    default: false,
  },
});

const UserSchema = new Schema({
  userId: {
    type: String,
    unique: true,
    required: true,
  },
  profileImage: {
    type: String,
    default: "",
  },
  firstName: {
    type: String,
    default: "",
  },
  lastName: {
    type: String,
    default: "",
  },
  email: {
    type: String,
    unique: true,
    // required: true
  },
  phoneCode: {
    type: String,
    default: "",
  },
  phoneNo: {
    type: String,
    default: "",
  },
  walletaddress: {
    type: String,
    default: "",
  },
  otp: {
    type: String,
    default: "",
  },
  otptime: {
    type: Date,
    default: "",
  },
  phoneOTP: {
    type: String,
    default: "",
  },
  phoneOTPtime: {
    type: Date,
    default: "",
  },
  emailOTP: {
    type: String,
    default: "",
  },
  emailOTPtime: {
    type: Date,
    default: "",
  },
  newEmail: {
    type: String,
    default: "",
  },
  requestType: {
    type: String,
    default: "",
  },
  // Which channel the pending DEACTIVATION OTP was sent on ("email" | "mobile").
  // Recorded by deactiveRequest and consumed by confirmDeActive, so the confirm
  // step never has to trust a client-supplied `roleType` to decide which stored
  // code to check. The two endpoints used opposite roleType conventions
  // (deactive-req: 1=email, deactive-confirm: 1=mobile), which meant a request
  // issued over SMS could be confirmed with an email code and vice versa.
  deactiveOtpChannel: {
    type: String,
    default: "",
  },
  // Set when an account enters the deactivated state; cleared on reactivation.
  // Deactivation is a reversible lock on this product, not a shredder - see
  // confirmDeActive for the reasoning.
  deactivatedAt: {
    type: Date,
    default: null,
  },
  newEmailToken: {
    type: String,
    default: "",
  },
  newPhone: {
    phoneCode: {
      type: String,
      default: "",
    },
    phoneNo: {
      type: String,
      default: "",
    },
  },
  hash: {
    type: String,
  },
  salt: {
    type: String,
  },
  blockNo: {
    type: String,
    default: "",
  },
  address: {
    type: String,
    default: "",
  },
  city: {
    type: String,
    default: "",
  },
  state: {
    type: String,
    default: "",
  },
  country: {
    type: String,
    default: "",
  },
  postalCode: {
    type: String,
    default: "",
  },
  google2Fa: {
    secret: {
      type: String,
      default: "",
    },
    uri: {
      type: String,
      default: "",
    },
    // SECURITY: the enrolment secret lives here, server-side, from the moment
    // GET /api/user/2fa mints it until the user proves possession with a valid
    // code. It is NOT the second factor yet - `secret` above is. Holding it
    // here is what makes enrolment idempotent: reloading the 2FA page returns
    // the SAME secret instead of minting a new one, so a user who scanned the
    // QR and then refreshed is not left with an authenticator the server no
    // longer recognises.
    pendingSecret: {
      type: String,
      default: "",
    },
    pendingUri: {
      type: String,
      default: "",
    },
    pendingCreatedAt: {
      type: Date,
      default: null,
    },
  },
  emailStatus: {
    type: String,
    default: "unverified", //    default: 'unverified' //unverified, verified
  },
  phoneStatus: {
    type: String,
    default: "unverified", //    default: 'unverified' //unverified, verified
  },
  type: {
    type: String,
    enum: [
      "not_activate",
      "basic_pending",
      "basic_submitted",
      "basic_verified",
      "advanced_pending",
      "advanced_verified",
      "pro_pending",
      "pro_verified",
    ],
    default: "basic_pending", //not_activate, basic, advanced, pro
  },
  mailToken: {
    type: String,
    default: "", //
  },
  conFirmMailToken: {
    type: String,
    default: "", //
  },
  refferalCode: {
    type: String,
    default: "",
  },
  refferedBy: {
    type: String,
    default: "",
  },
  parentId: {
    type: ObjectId
  },
  bankDetails: [BankDetailsSchema],
  upiDetails: [UPIDetailsSchema],
  qrDetails: [QRDetailsSchema],
  status: {
    type: String,
    default: "unverified", //unverified, verified
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: "",
  },
  userLocked: {
    type: String,
    default: "false",
  },
  userIp: {
    type: String,
    default: "",
  },
  antiphishingcode: {
    type: String,
    default: "",
  },
  antiphishingStatus: {
    type: Boolean,
    default: false,
  },
  role: {
    type: String,
    default: "user", // "user" is the only role a session ever carries
  },
  assetPassword: {
    type: String,
    default: "",
  },
  assetPasswordStatus: {
    type: Boolean,
    default: false,
  },
  referaluserid: {
    type: Schema.Types.ObjectId,
    ref: "users",
  },
  isBlock: {
    type: Boolean,
    default: false,
  },
  login_attempt: {
    type: Number,
    default: 0,
  },
  lock_session: {
    type: Date,
  },
  changepassword: {
    type: Boolean,
    default: false,
  },
  percentage: {
    type: Number,
    default: 0,
  },
  feeManagement: {
    type: Array,
    default: [],
  },
  isAff: {
    type: Boolean,
    default: false,
  },
});

/**
 * Pre-save hook
 */
// Every account on this venue is created through email registration, which
// always sets a password. The exemption that used to stand here waived the
// password requirement for the "app-user" role, whose only writers were the
// unmounted mobile-app controllers; with those gone nothing needs the waiver,
// so the hash is unconditionally required here.
//
// This hook is not a complete guarantee, and should not be read as one: a
// mongoose upsert does not run pre("save") at all, so user.controller.js's
// findOneAndUpdate(..., { upsert: true }) would still insert a hash-less
// document. That handler is routed nowhere today; if it is ever mounted, the
// requirement needs enforcing there too rather than being assumed from here.
UserSchema.pre("save", function (next) {
  if (!this.isNew) return next();
  if (!validatePresenceOf(this.hash)) next(new Error("Invalid password"));
  else next();
});

var validatePresenceOf = function (value) {
  return value && value.length;
};

// Validate empty password
UserSchema.path("hash").validate(function (hashedPassword) {
  return hashedPassword.length;
}, "Password cannot be blank");

/**
 * Virtuals
 */
UserSchema.virtual("password")
  .set(function (password) {
    this._password = password;
    this.salt = this.makeSalt();
    this.hash = this.encryptPassword(password);
  })
  .get(function () {
    return this._password;
  });

/**
 * Methods
 */
UserSchema.methods = {
  /**
   * Authenticate - check if the passwords are the same
   *
   * @param {String} plainText
   * @return {Boolean}
   * @api public
   */
  authenticate: function (plainText) {
    return this.encryptPassword(plainText) === this.hash;
  },

  /**
   * Make salt
   *
   * @return {String}
   * @api public
   */
  makeSalt: function () {
    return crypto.randomBytes(16).toString("base64");
  },

  /**
   * Encrypt password
   *
   * @param {String} password
   * @return {String}
   * @api public
   */
  encryptPassword: function (password) {
    if (!password || !this.salt) return "";
    var salt = new Buffer(this.salt, "base64");
    return crypto
      .pbkdf2Sync(password, salt, 100000, 128, "sha512")
      .toString("base64");
  },
};

UserSchema.methods.generateJWT = function (payload) {
  // "24h", not a number: jsonwebtoken treats a NUMERIC expiresIn as SECONDS, so
  // `1 * 1000 * 60 * 60 * 24` (meant as 24h in ms) minted a ~1000-day token.
  var token = jwt.sign(payload, config.secretOrKey, { expiresIn: "24h" });
  return `Bearer ${token}`;
};

UserSchema.set("toObject", { virtuals: true });
UserSchema.set("toJSON", { virtuals: true });

const User = mongoose.model("user", UserSchema, "user");
export default User;
