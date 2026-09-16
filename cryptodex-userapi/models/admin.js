// import package
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

// import lib
import config from "../config/index.js";

const Schema = mongoose.Schema;

const RestrictionSchema = new Schema({
  // _id: 0,
  // name: {
  //     type: String,
  //     default: ""
  // },
  path: {
    type: String,
    default: "",
  },
  isWriteAccess: {
    type: Boolean,
    default: false,
  },
});

const AdminSchema = new Schema({
  name: {
    type: String,
    default: "",
  },
  email: {
    type: String,
    required: true,
  },
  password: {
    type: String,
    required: true,
  },
  phoneNumber: {
    type: Number,
    //required: true,
  },
  conFirmMailToken: {
    type: String,
    default: "" //
  },
  mailToken: {
    type: String,
    default: "" //
  },
  otptime: {
    type: Date,
    default: ''
  },
  role: {
    type: String,
    enum: ["superadmin", "admin", "subadmin"], // super admin access all, admin - restricted
  },
  restriction: {
    type: Array,
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
    // Server-held enrolment secret. See models/User.js and the comment on
    // generateTwoFa in controllers/user.controller.js - the operator 2FA flow
    // had the identical problem (new secret minted on every page load, and the
    // secret shipped to quickchart.io in a GET URL to be drawn as a QR).
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
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

AdminSchema.methods.generateJWT = function (payload) {
  var token = jwt.sign(payload, config.secretOrKey);
  return `Bearer ${token}`;
};

const Admin = mongoose.model("admin", AdminSchema, "admin");

export default Admin;