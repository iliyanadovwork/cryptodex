export type MyFormValues = {
    email: string;
    password: string;
    roleType: number;
    confirmPassword: string;
    refferalCode: string;
}

export type MyFormValuesError = {
    email: string;
    password: string;
    refferalCode: string;
    roleType: string;
    confirmPassword: string;
    newPhoneNo: string;
    reCaptcha: string;
}
export type MyFormValuesMobile = {
    newPhoneNo: string;
    password: string;
    refferalCode: string;
    roleType: number;
    confirmPassword: string;
    newPhoneCode: string;
    otp: number | string;
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
}
