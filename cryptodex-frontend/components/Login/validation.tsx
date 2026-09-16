import isEmpty from '../../lib/isEmpty'
import { MyFormValuesError, MyFormValuesMobileError } from './types'

const loginValid = (value: any): object => {
    let emailRegex = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,6}))$/;
    if (value.roleType == 1) {
        let errors = {} as MyFormValuesError;

        if (isEmpty(value.email)) {
            errors.email = "Email field is required";
        } else if (!emailRegex.test(value.email)) {
            errors.email = "Email is invalid";
        }
        if (isEmpty(value.password)) {
            errors.password = "Password field is required";
        }
        // if (!value.checkbox) {
        //     errors.checkbox = "You need to accept the terms and conditions"
        // }
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
        }
        // if (!value.checkbox) {
        //     errors.checkbox = "You need to accept the terms and conditions"
        // }
        return errors;

    }
}
export default loginValid