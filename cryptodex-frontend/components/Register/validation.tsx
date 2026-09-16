import isEmpty from '../../lib/isEmpty'
import { MyFormValuesError, MyFormValuesMobileError } from './types'

/**
 * `recaptchaRequired` is NOT optional on purpose.
 *
 * This rule used to read `if (isEmpty(value.reCaptcha))` unconditionally, and
 * that one line is what killed registration outright: once `_app` stopped
 * mounting GoogleReCaptchaProvider on hosts where the site key cannot work
 * (see lib/recaptcha), the form can no longer obtain a token, so EVERY
 * submission failed this check and returned before reaching apiSignUp. The
 * Register button did nothing at all — no request, no error, no toast — because
 * `errors.reCaptcha` has no input to sit beside.
 *
 * A token may only be demanded on a build that actually issues one. Making the
 * flag a required parameter means a future call site has to answer the question
 * rather than inherit a default that silently bricks the form again.
 */
const registerValid = (value: any, recaptchaRequired: boolean): object => {
    let emailRegex = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,6}))$/;
    let passwordRegex = /^(?=.*\d)(?=.*[A-Z])(?=.*[a-z])(?=.*\W).{6,18}/g;
    let emailRegQuotes = /^([A-Za-z0-9_\-\.])+\@([A-Za-z0-9_\-\.])+\.([A-Za-z]{2,4})$/;
    if (value.roleType == 1) {
        let errors = {} as MyFormValuesError;

        if (isEmpty(value.email)) {
            errors.email = "Email field is required";
        } else if (!emailRegex.test(value.email)) {
            errors.email = "Email is invalid";
        } else if (!emailRegQuotes.test(value.email)) {
            errors.email = "Email is invalid";
        }
        if (isEmpty(value.password)) {
            errors.password = "Password field is required";
        } else if (!passwordRegex.test(value.password)) {
            errors.password = 'Password should contain at least one uppercase, at least one lowercase, at least one number, at least one special character, and minimum 6 and maximum 18 characters';
        }
        if (isEmpty(value.confirmPassword)) {
            errors.confirmPassword = "Confirm password field is required";
        }
        if (!isEmpty(value.password) && !isEmpty(value.confirmPassword) && value.password != value.confirmPassword) {
            errors.confirmPassword = "Passwords must match";
        }
        if (recaptchaRequired && isEmpty(value.reCaptcha)) {
            errors.reCaptcha = "ReCAPTCHA field is required";
        }
        return errors;

    } else {
        let errors = {} as MyFormValuesMobileError;

        if (value.roleType == 2) {
            if (isEmpty(value.newPhoneNo)) {
                errors.newPhoneNo = "Please enter your Mobile number";
            }
        }
        if (isEmpty(value.newPhoneCode)) {
            errors.newPhoneCode = "Please select your country";
        }
        if (isEmpty(value.password)) {
            errors.password = "Password field is required";
        } else if (!passwordRegex.test(value.password)) {
            errors.password = 'Password should contain at least one uppercase, at least one lowercase, at least one number, at least one special character, and minimum 6 and maximum 18 characters';
        }
        if (isEmpty(value.confirmPassword)) {
            errors.confirmPassword = "Confirm password field is required";
        }
        if (!isEmpty(value.password) && !isEmpty(value.confirmPassword) && value.password != value.confirmPassword) {
            errors.confirmPassword = "Passwords must match";
        }
        if (recaptchaRequired && isEmpty(value.reCaptcha)) {
            errors.reCaptcha = "ReCAPTCHA field is required";
        }
        return errors;

    }
}
export default registerValid