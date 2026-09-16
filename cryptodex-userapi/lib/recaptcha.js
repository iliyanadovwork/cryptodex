// import package
import axios from 'axios'

// import config
import config from '../config/index.js';

/**
 * Whether this deployment must hold a caller to a reCAPTCHA token at all.
 *
 * A localhost dev box cannot serve the site key, so GoogleReCaptchaProvider
 * never mounts and the client has no token to send. Any handler that demands
 * one there is simply dead — which is what had happened to the contact form:
 * every submission came back 500 "Invalid reCaptcha".
 *
 * Production always enforces it. The waiver needs an EXPLICIT non-production
 * signal, so a deploy that merely forgot to set NODE_ENV still enforces.
 * This is the single source of truth for that decision; the presence check in
 * validation/user.validation.js delegates to it.
 */
export const recaptchaVerificationRequired = () => {
    if (process.env.NODE_ENV === "production") return true;
    return !(
        process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test" ||
        process.env.TEST_MODE === "true" ||
        process.env.DEV_RECAPTCHA_BYPASS === "true"
    );
};

export const checkToken = async (token) => {
    try {
        let respData = await axios({
            'url': `https://www.google.com/recaptcha/api/siteverify`,
            'method': 'post',
            'params': {
                'secret': config.RECAPTCHA_SECRET_KEY,
                'response': token
            }
        })
        if (respData && respData.status == 200 && respData.data.success == true) {
            return {
                status: true,
            }
        }
        return {
            status: false,
            message: "Invalid ReCaptcha"
        }
    } catch (err) {
        return {
            status: false,
            message: "Invalid ReCaptcha"
        }
    }
}