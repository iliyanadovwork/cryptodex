// import model
//
// SPOT-ONLY PAPER VENUE. The models below are the ones the product still uses.
// Removed with the screens that owned them: `Anouncement`, `Cms`, `Contact`,
// `Faq`, `FaqCategory`, `NewsLetter`, `SliderManage`, `Smslog`, `Support`,
// `SupportCategory`, `SupportTicket` (support desk / CMS / marketing) and
// `Modules`, `Submodules` (operator role-permission tables).
//
// DELETING A MODEL FILE DOES NOT DELETE DATA. Every one of those collections is
// still sitting in mongo exactly as it was; nothing here drops or rewrites
// them. That is the same rule this service applies to unused schema PATHS - see
// models/User.js - and for the same reason: destroying data is the owner's
// call, never a side effect of removing a screen.
import User from "./User.js";
import UserKyc from "./userKyc.js";
import UserSetting from "./userSetting.js";
import Language from "./language.js";
import SiteSetting from "./sitesetting.js";
import EmailTemplate from "./emailtemplate.js";
import ipAddress from "./RestrictIpAddress.js";
import LoginHistory from "./LoginHistory.js";
import Notification from "./notification.js";
import Admin from "./admin.js";
import AdminProfit from './adminProfitHistory.js'
import KycHistory from './kycHistory.js'

export {
  User,
  UserKyc,
  UserSetting,
  Language,
  SiteSetting,
  EmailTemplate,
  ipAddress,
  LoginHistory,
  Notification,
  Admin,
  AdminProfit,
  KycHistory,
};
