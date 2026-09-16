import isEmpty from '../../lib/isEmpty'
import { AssetFormValues, EmailFormValues, BankFormValues } from './types'

export const assetPassValid = (value: any): object => {
    let errors = {} as AssetFormValues;
    let passwordRegex = /^(?=.*\d)(?=.*[A-Z])(?=.*[a-z])(?=.*\W).{6,18}/g;

    if (isEmpty(value.password)) {
        errors.password = "Password field is required";
    } else if (!passwordRegex.test(value.password)) {
        errors.password = "Password should contain atleast one uppercase, atleast one lowercase, atleast one number, atleast one special character and minimum 8 and maximum 18";
    }
    if (isEmpty(value.confirmPassword)) {
        errors.confirmPassword = "Confirm password field is required";
    }
    if (!isEmpty(value.password) && !isEmpty(value.confirmPassword) && value.password != value.confirmPassword) {
        errors.confirmPassword = "Passwords must match";
    }
    if (isEmpty(value.otp)) {
        errors.otp = "OTP field is required";
    }
    return errors;
}
export const bindEmaiilValid = (value: any): object => {
    let errors = {} as EmailFormValues;
    let emailRegex = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,6}))$/;
    let emailRegQuotes = /^([A-Za-z0-9_\-\.])+\@([A-Za-z0-9_\-\.])+\.([A-Za-z]{2,4})$/;

    if (isEmpty(value.email)) {
        errors.email = "Email field is required";
    } else if (!emailRegex.test(value.email)) {
        errors.email = "Email is invalid";
    } else if (!emailRegQuotes.test(value.email)) {
        errors.email = "Email is invalid";
    }
    return errors;
}
export const bankAddValid = (value: any): object => {
    let errors = {} as BankFormValues;
    let strRegex = /^[a-zA-Z.\s]+$/;
    let alphaNumeric = /[a-zA-Z0-9]/g
    if (isEmpty(value.bankName)) {
        errors.bankName = "Bank name field is required";
    } else if (!strRegex.test(value.bankName)) {
        errors.bankName = "Only alphabets are allowed";
    } else if (value.bankName.length < 2) {
        errors.bankName = "Too Short!";
    } else if (value.bankName.length > 50) {
        errors.bankName = "Too Long!";
    }
    if (isEmpty(value.accountNo)) {
        errors.accountNo = "Account number field is required";
    } else if (isNaN(value.accountNo)) {
        errors.accountNo = "Only numbers are allowed";
    } else if (value.accountNo.length < 2) {
        errors.accountNo = "Too Short!";
    }
    if (isEmpty(value.holderName)) {
        errors.holderName = "Holder name field is required";
    } else if (!strRegex.test(value.holderName)) {
        errors.holderName = "Only alphabets are allowed";
    } else if (value.holderName.length < 2) {
        errors.holderName = "Too Short!";
    } else if (value.holderName.length > 50) {
        errors.holderName = "Too Long!";
    }
    if (isEmpty(value.bankcode)) {
        errors.bankcode = "Bank code field is required";
    } else if (!alphaNumeric.test(value.bankcode)) {
        errors.bankcode = "Only alpha numeric are allowed";
    } else if (value.bankcode.length < 2) {
        errors.bankcode = "Too Short!";
    }
    if (isEmpty(value.country)) {
        errors.country = "Country field is required";
    } else if (!strRegex.test(value.country)) {
        errors.country = "Only alphabets are allowed";
    } else if (value.country.length < 2) {
        errors.country = "Too Short!";
    } else if (value.country.length > 50) {
        errors.country = "Too Long!";
    }
    if (isEmpty(value.city)) {
        errors.city = "City field is required";
    } else if (!strRegex.test(value.city)) {
        errors.city = "Only alphabets are allowed";
    } else if (value.city.length < 2) {
        errors.city = "Too Short!";
    } else if (value.city.length > 50) {
        errors.city = "Too Long!";
    }
    if (isEmpty(value.bankAddress)) {
        errors.bankAddress = "Bank address field is required";
    } else if (value.bankAddress.length < 2) {
        errors.bankAddress = "Too Short!";
    } else if (value.bankAddress.length > 50) {
        errors.bankAddress = "Too Long!";
    }
    if (isEmpty(value.currencyId)) {
        errors.currencyId = "Currency field is required";
    }
    return errors;
}