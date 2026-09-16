// import model
import { User } from "../models/index.js";
import { mailTemplateLang } from "./emailTemplate.controller.js";

export const sendMail = async (reqBody) => {
  try {
    let { id, identifier, toEmail, content } = reqBody;
    if (content) {
      content = JSON.parse(content);
    }
    if (!id) {
      mailTemplateLang({
        identifier: identifier,
        toEmail: toEmail,
        content,
        antiphishingcode: ""
      });
      return { status: true };
    }
    let checkUser = await User.findById(id).lean();
    if (checkUser) {
      if (checkUser.emailStatus == "verified") {
        mailTemplateLang({
          userId: id,
          identifier: identifier,
          toEmail: checkUser.email,
          content,
          antiphishingcode: checkUser.antiphishingcode !== "" ? checkUser.antiphishingcode : ''
        });
      } else {
        return { status: false };
      }
    } else {
      return { status: false };
    }

    return { status: true };
  } catch (error) {
    return { status: false };
  }
};
