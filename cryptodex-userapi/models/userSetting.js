// import package
import mongoose from "mongoose";
const Schema = mongoose.Schema;

const UserSettingSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "user",
    },
    currencySymbol: {
      type: String,
      default: "USD",
    },
    theme: {
      type: String, //light, dark
      default: "dark",
    },
    afterLogin: {
      page: {
        type: String,
        default: "dashboard",
      },
      url: {
        type: String,
        default: "/dashboard",
      },
    },
    languageId: {
      type: Schema.Types.ObjectId,
      ref: "language",
    },
    timeZone: {
      name: {
        type: String,
        default: "",
      },
      GMT: {
        type: String,
        default: "",
      },
    },
    twoFA: {
      type: Boolean,
      default: false,
    },
    passwordChange: {
      type: Boolean,
      default: false,
    },

    loginNotification: {
      type: Boolean,
      default: false,
    },
    siteNotification: {
      type: Boolean,
      default: false,
    },
    // ---------------------------------------------------------------------
    // The four derivative notification toggles that stood here - showFuture,
    // showInverse, showOFuture, showOInverse - are gone, together with
    // leverage / inverseLeverage and derivativeMode / inverseMode below. They
    // were preferences for two products this venue no longer offers, and
    // nothing in userapi, spotapi or walletapi read any of them to reach a
    // decision.
    //
    // REMOVING A PATH DOES NOT DESTROY STORED DATA, which is why this is safe
    // and why it is NOT the same decision as the enum below. Measured against
    // this repo's own mongoose (6.13.8): hydrating a document that still holds
    // these keys leaves them unreadable through the model, but `save()` on a
    // hydrated document emits a delta `$set` of the MODIFIED paths only, so
    // the stored values sit untouched in mongo rather than being silently
    // unset. Nothing in this service replaces a UserSetting document wholesale
    // (no replaceOne, no create-from-toObject), so there is no path by which a
    // stored value is dropped. Purging them for real is still a `$unset`
    // migration an operator runs.
    //
    // The one thing that DOES change behaviour: `editNotif` gates its write on
    // `reqBody.name in usrSetting`, and that is false for an undeclared path.
    // So PUT /api/editNotif {name:"showFuture"} now writes nothing instead of
    // writing a dead field. Same 200, same response body - `editNotif` never
    // echoed these keys back.
    // ---------------------------------------------------------------------
    showSpot: {
      type: Boolean,
      default: false,
    },
    LatestEvent: {
      type: Boolean,
      default: false,
    },
    announcement: {
      type: Boolean,
      default: false,
    },
    tradingviewAlert: {
      type: Boolean,
      default: false,
    },
    tradeOrderPlaceAlertMobile: {
      type: Boolean,
      default: false,
    },
    tradeOrderPlaceAlertWeb: {
      type: Boolean,
      default: false,
    },
    // "derivativeBal" IS KEPT DELIBERATELY, and it is the one thing in this
    // file that must not be tidied away with the rest.
    //
    // Removing an enum member does not merely stop new writes of the value -
    // it makes every document that ALREADY stores it fail validation.
    // Measured against this repo's own mongoose (6.13.8): hydrate a document
    // holding `defaultWallet: "derivativeBal"`, drop the member, modify an
    // UNRELATED field and call save(), and validate() rejects the untouched
    // `defaultWallet` path - modifiedPaths() was ['announcement'] and it still
    // failed. That is PUT /api/editNotif - a user ticking an announcement
    // checkbox - becoming a permanent 500 for exactly the users who once chose
    // that wallet, with no way for them to get out of it themselves.
    //
    // So this is a data migration (normalise the stored value to "spotBal",
    // THEN drop the member), never a schema edit, and it is not done here.
    // Note the asymmetry with the paths removed above: dropping a path costs
    // nothing because the stored value survives; dropping this member costs
    // availability on a live route.
    defaultWallet: {
      type: String,
      enum: ["spotBal", "p2pBal", "derivativeBal"],
      default: "spotBal",
    },
    enableCryptodexFee: {
      type: Boolean,
      default: false,
    }
  },
  {
    timestamps: true,
  }
);

const UserSetting = mongoose.model(
  "usersetting",
  UserSettingSchema,
  "usersetting"
);
export default UserSetting;
