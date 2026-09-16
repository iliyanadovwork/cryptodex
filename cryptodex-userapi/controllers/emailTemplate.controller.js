// import modal
import { EmailTemplate, UserSetting, SiteSetting } from "../models/index.js";

// import config
import config from "../config/index.js";

// import lib
import { sendEmail } from "../lib/emailGateway.js";

/**
 * Mail Template with language
 */
export const mailTemplateLang = async ({
  userId,
  identifier,
  toEmail,
  content,
  antiphishingcode,
}) => {
  try {
    mailTemplate(identifier, toEmail, content, antiphishingcode);

    // let settingData = await UserSetting.findOne({ userId: userId }).populate(
    //   "languageId"
    // );
    // console.log(settingData, 'settingData')
    // if (settingData && settingData.languageId) {
    //   mailTemplate(
    //     identifier,
    //     toEmail,
    //     content,
    //     settingData.languageId.code,
    //     antiphishingcode
    //   );
    // } else {
    //   // let getLang = await Language.findOne({ "isPrimary": true })
    //   mailTemplate(identifier, toEmail, content, antiphishingcode);
    //   console.log("mailTemplatemailTemplatemailTemplatemailTemplate");
    // }
  } catch (err) {
    console.log("errerrerrerrerr", err);
  }
};

/**
 * Sent Email
 * URL: /api/mailTemplate
 * METHOD : POST
 * BODY : identifier, email, contentData (object)
 */
export const mailTemplate = async (
  identifier,
  toEmail,
  content,
  antiphishingcode = "",
  langCode = ""
) => {
  console.log("toEmail", antiphishingcode);
  try {
    console.log("paramsss", identifier, content);
    let siteSettingsData = await SiteSetting.findOne({});
    let emailTemplateData = await EmailTemplate.findOne({
      identifier: identifier,
    });
    if (!emailTemplateData) {
      console.log("No Email Template");
      return false;
    }

    let logo = config.SERVER_URL + "Logo-small.png";
    let mailContent = {};
    mailContent["subject"] = emailTemplateData.subject;
    mailContent["template"] = emailTemplateData.content
      .replace("##SITE_URL##", config.FRONT_URL)
      .replace(
        "##EMAIL_LOGO##",
        config.SERVER_URL + "/settings/" + siteSettingsData.emailLogo
      )

      .replace(/##SUPPORT_MAIL##/g, siteSettingsData.supportMail)
      .replace("##TWITER_LINK##", siteSettingsData.twitterUrl)
      .replace("##LINKEDIN_LINK##", siteSettingsData.telegramLink)
      .replace("##FB_LINK##", siteSettingsData.facebookLink)
      .replace("##INSTA_LINK##", siteSettingsData.instaLink)
      .replace(/##SITE_NAME##/g, siteSettingsData.siteName)
      .replace("##CONTACT_NO##", siteSettingsData.contactNo)
      .replace("##ADDRESS##", siteSettingsData.address)
      .replace("##EMAIL##", 'support@cryptodex.com')
      .replace("##LINK##", 'www.cryptodex.com')
      .replace("##TWITER_LOGO##", config.SERVER_URL + "/emailimages/twiter.png")
      .replace("##FB_LOGO##", config.SERVER_URL + "/emailimages/facbook.png")
      .replace("##INSTA_LOGO##", config.SERVER_URL + "/emailimages/instagram.png")
      .replace(
        "##LINKED_IN_LOGO##",
        config.SERVER_URL + "/emailimages/telegaram.png"
      );
    if (antiphishingcode !== "") {
      mailContent["template"] = mailContent["template"].replace(
        "##ANTIPHISHINGCODE##",
        `Anti-Phishing Code : ${antiphishingcode}`
      );
    } else {
      mailContent["template"] = mailContent["template"].replace(
        "##ANTIPHISHINGCODE##",
        ""
      );
    }

    switch (identifier) {
      case "activate_register_user":
        /**
         * ##templateInfo_name## --> email
         * ##templateInfo_url## --> confirmMailUrl
         * ##templateInfo_appName##  --> siteName
         * ##DATE## --> date
         */
        mailContent["template"] = mailContent["template"]
          .replace("##templateInfo_name##", content.email)
          .replace("##templateInfo_url##", content.confirmMailUrl)
          .replace("##templateInfo_appName##", config.SITE_NAME)
          .replace("##templateInfo_logo##", logo)
          .replace("##DATE##", content.date);

        break;

      case "User_forgot":
        /**
         * ##templateInfo_name## --> name
         * ##templateInfo_url## --> confirmMailUrl
         */
        mailContent["template"] = mailContent["template"]
          .replace("##templateInfo_name##", "Valid User")
          .replace("##templateInfo_url##", content.confirmMailUrl);

        break;

      case "change_register_email":
        /**
         * ##templateInfo_name## --> name
         * ##templateInfo_url## --> confirmMailUrl
         */
        mailContent["template"] = mailContent["template"]
          .replace("##DATE##", content.date)
          .replace("##templateInfo_url##", content.confirmMailUrl);

        break;
      case "alert_notification":
        /**
         * ##templateInfo_name## --> name
         * ##templateInfo_url## --> confirmMailUrl
         */
        mailContent["template"] = mailContent["template"]
          .replace("##message##", content.message)
          .replace("##templateInfo_name##", content.email)
          .replace("##DATE##", new Date());

        break;

      case "verify_new_email":
        /**
         * ##templateInfo_name## --> name
         * ##templateInfo_url## --> confirmMailUrl
         */
        mailContent["template"] = mailContent["template"]
          .replace("##DATE##", content.date)
          .replace("##templateInfo_url##", content.confirmMailUrl);

        break;

      case "Login_confirmation":
        /**
         * ##BROWSER## --> broswername
         * ##IP## --> ipaddress
         * ##COUNTRY## --> countryName
         * ##DATE## --> date
         * ##CODE## --> code
         */
        mailContent["template"] = mailContent["template"]
          .replace("##templateInfo_name##", "Valid User")
          .replace("##BROWSER##", content.broswername)
          .replace("##IP##", content.ipaddress)
          .replace("##COUNTRY##", content.countryName)
          .replace("##DATE##", content.date)
          .replace("##CODE##", content.code);

        break;

      case "withdraw_request":
        /**
         * ##templateInfo_name## --> name
         * ##templateInfo_url## --> confirmMailUrl
         */
        mailContent["template"] = mailContent["template"]
          .replace("##templateInfo_name##", "Valid User")
          .replace("##templateInfo_url##", content.confirmMailUrl)
          .replace("##AMOUNT##", content.amount)
          .replace("##CURRENCY##", content.currency);
        break;

      case "Login_notification":
        /**
         * ##BROWSER## --> broswername
         * ##IP## --> ipaddress
         * ##COUNTRY## --> countryName
         * ##DATE## --> date
         * ##CODE## --> code
         */
        mailContent["template"] = mailContent["template"]
          .replace("##templateInfo_name##", "Valid User")
          .replace("##BROWSER##", content.broswername)
          .replace("##IP##", content.ipaddress)
          .replace("##COUNTRY##", content.countryName)
          .replace("##DATE##", content.date);

        break;

      case "User_deposit":
        /**
         * ##AMOUNT## --> amount
         * ##CURRENCY## --> currency
         * ##TXID## --> tranactionId
         * ##DATE## --> date
         */
        mailContent["template"] = mailContent["template"]
          .replace("##templateInfo_name##", "Valid User")
          .replace("##AMOUNT##", content.amount)
          .replace("##CURRENCY##", content.currency)
          .replace("##TXID##", content.transactionId)
          .replace("##DATE##", content.date);
        break;

      case "Withdraw_notification":
        /**
         * ##AMOUNT## --> amount
         * ##CURRENCY## --> currency
         * ##TXID## --> tranactionId
         * ##DATE## --> date
         */
        mailContent["template"] = mailContent["template"]
          .replace("##templateInfo_name##", "Valid User")
          .replace("##AMOUNT##", content.amount)
          .replace("##CURRENCY##", content.currency)
          .replace("##TXID##", content.tranactionId)
          .replace("##DATE##", content.date);
        break;

      case "new_support_ticket_user":
        /**
         * ##templateInfo_name## --> name
         * ##templateInfo_url## --> confirmMailUrl
         */
        mailContent["template"] = mailContent["template"].replace(
          "##ID##",
          content.Id
        );

        break;
      case "support_ticket_reply":
        /**
         * ##templateInfo_name## --> name
         * ##templateInfo_url## --> confirmMailUrl
         */
        mailContent["template"] = mailContent["template"].replace(
          "##DATE##",
          content.date
        );

        break;
      case "Send_NewsLetter":
        /**
         * ##templateInfo_name## --> name
         * ##templateInfo_url## --> confirmMailUrl
         */

        mailContent["template"] = mailContent["template"].replace(
          "##MESSAGE##",
          content.message
        );

        break;
      case "Reject_KYC":
        /**
         * ##templateInfo_name## --> name
         * ##templateInfo_url## --> confirmMailUrl
         */

        mailContent["template"] = mailContent["template"]
          .replace("##REASON##", content.reason)
          .replace("##DOCUMENT##", content.document);

        break;
      case "Approve_KYC":
        /**
         * ##templateInfo_name## --> name
         * ##templateInfo_url## --> confirmMailUrl
         */

        mailContent["template"] = mailContent["template"]
          // .replace("##REASON##", content.reason)
          .replace("##DOCUMENT##", content.document);

        break;
      case "CONTACT_US":
        /**
         * ##templateInfo_name## --> name
         * ##templateInfo_url## --> confirmMailUrl
         */

        mailContent["template"] = mailContent["template"]
          .replace("##rly##", content.replyMessage)
          .replace("##DATE##", new Date());

        break;
      case "newsletter_send":
        /**
         * ##message##
         */
        mailContent["template"] = mailContent["template"]
          .replace("##templateInfo_name##", "Valid User")
          .replace("#AdminReplay#", content.message);
        break;
      case "Change_Password":
        /**
         * ##message##
         */
        mailContent["template"] = mailContent["template"].replace(
          "##DATE##",
          new Date()
        );
        break;
      case "wallet_reject_notification":
        /**
         * ##AMOUNT## --> amount
         * ##CURRENCY## --> currency
         * ##REASON## --> reason
         * ##DATE## --> date
         * ##WITHDRAW_TYPE##-->withdrwaType
         */
        mailContent["template"] = mailContent["template"]
          .replace("##templateInfo_name##", "Valid User")
          .replace("##AMOUNT##", content.amount)
          .replace("##WITHDRAW_TYPE##", content.withdrwaType)
          .replace("##STATUS##", content.status)
          .replace("##CURRENCY##", content.currency)
          .replace("##REASON##", content.reason)
          .replace("##DATE##", content.date);
        break;
      case "USER_FIAT_NOTIFICATION":
        /**
         * ##AMOUNT## --> amount
         * ##CURRENCY## --> currency
         * ##REASON## --> reason
         * ##DATE## --> date
         * ##WITHDRAW_TYPE##-->withdrwaType
         */
        mailContent["template"] = mailContent["template"]
          .replace("##templateInfo_name##", "Valid User")
          .replace("##AMOUNT##", content.amount)
          .replace("##DEPOSIT_TYPE##", content.depositType)
          .replace("##STATUS##", content.status)
          .replace("##CURRENCY##", content.currency)
          .replace("##REASON##", content.reason)
          .replace("##DATE##", content.date);
        break;

      case "EMAIL_VERIFICATION_OTP":
        /**
         * ##BROWSER## --> broswername
         * ##IP## --> ipaddress
         * ##COUNTRY## --> countryName
         * ##DATE## --> date
         * ##CODE## --> code
         */
        mailContent["template"] = mailContent["template"]
          .replace("##templateInfo_name##", "Valid User")
          .replace("##OTP##", content.emailOtp);

        break;
    }

    sendEmail(toEmail, mailContent);
    return true;
  } catch (err) {
    console.log("Error on mail template", err.toString());
  }
};

// THE EMAIL-TEMPLATE CRUD USED TO END THIS FILE.
//
// `addEmailTemplate`, `editEmailTemplate`, `emailTemplateList` and
// `getSingleTemplate` were an operator template editor, mounted on
// /api/admin/emailTemplate and /api/admin/getTemplate/:id. Those are gone, so
// they were four live HTTP handlers - three of them writes - that nothing
// could reach on purpose.
//
// What is above them stays and is load-bearing: `mailTemplateLang` /
// `mailTemplate` render EVERY transactional mail this service sends
// (registration activation, login OTP, password reset, change-password alert),
// off the real EmailTemplate rows and the real SiteSetting branding. The rows
// themselves are untouched - there is simply no longer a screen that edits
// them.
