export type MyFormValues = {
    email: string;
    password: string;
    roleType: number;
    otp: string;
    isTerms: boolean;
    newPhoneCode: string;
    newPhoneNo: string;
}

export type MyFormValuesError = {
    email: string;
    password: string;
    referralcode: string;
    roleType: string;
    confirmPassword: string;
    newPhoneNo: string;
    reCaptcha: string;
    checkbox: string
}

export type MyFormValuesMobileError = {
    newPhoneNo: string;
    password: string;
    referralcode: string;
    roleType: number;
    confirmPassword: string;
    newPhoneCode: string;
    otp: number | string;
    reCaptcha: string;
    checkbox: string
}
